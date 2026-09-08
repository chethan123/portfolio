# 0021 — Pricing health without making pricing readiness

**Status:** proposed

## The question

Can the public `GET /healthz` response tell a monitor that the price worker is unreachable or that
scheduled fetching is not happening, while the endpoint still returns `200` and the application
keeps serving last-known prices?

Yes, but "worker is reachable" and "prices are being fetched" are different facts. This slice adds
both as attributes and makes neither one app readiness.

It also fixes the reason the second fact would otherwise be permanently false, because reporting a
bug the shipped deployment has in its ordinary happy path is not monitoring — it is an alarm nobody
will keep listening to.

## What exists

The app endpoint currently answers only database reachability and migration currency. Its HTTP
status is `200` exactly when those are healthy and `503` otherwise; the response is unauthenticated,
uncached, and pinned key-for-key by a test (`app/routes/healthz.ts`,
`tests/routes/healthz.test.ts`). Compose's app healthcheck looks only at `response.ok`. A pricing
`503` would mark an otherwise useful app unhealthy and invite an external monitor or orchestrator to
restart it without repairing the dependency (`compose.yaml`).

The worker already has `GET /healthz` over its Unix socket, answered above both rate limiters and
before any Yahoo call (`server/price-worker.ts:285-288`). That proves only that the listener accepts
a request. The worker's own container healthcheck calls it from inside the worker container, so it
cannot prove that the app's separate read-only mount can connect (`compose.yaml:189-200`, `:139`).
`scripts/smoke-test.sh:441-454` proves that hop once, at deploy, and nothing proves it after.

The poller's live state sits in a `globalThis` slot so it survives module reloads. It stores the
timer handle, the cadence it was armed with, whether a tick is running, and the provider
(`app/lib/price-poller.server.ts:26-33`). Its arm and tick paths observe the market-hours decision
and the `runRefresh` result without retaining either. `runRefresh` already returns `requested`,
`priced` and `providerFailed` on a completed run and already separates `busy` from `error`
(`app/lib/refresh.server.ts:35-38`, `app/lib/prices.server.ts:68-77`), so every category this slice
publishes is derivable from what already crosses that boundary. Nothing in the pricing path has to
change to produce them.

`price_poll` is not a scheduler heartbeat: it is written only when quotes are attempted, inside the
price transaction, so an off-hours tick or a rolled-back refresh leaves no row
(`app/lib/prices.server.ts:552`, `migrations/0009_price_observation.sql`).

**And the poller does not start until somebody looks at a page.** `app/root.tsx:179` calls
`startPricePoller()` from the root loader, and `/healthz` is a resource route, so React Router calls
only that route's own loader — parent loaders are handed `shouldCallHandler: () => false`
(`react-router@7.18.2`, `lib/server-runtime/server.ts:260-274`, `lib/router/router.ts:6435`).
`docs/operating.md:1160-1164` states the consequence plainly: a booted instance nobody has visited
does zero refreshes, forever.

## Decision

`GET /healthz` gains a nested `pricing` object. The established top-level fields and the HTTP status
keep their meanings. A degraded pricing object never changes `200` to `503`.

The finished contract is:

```json
{
  "status": "ok",
  "database": true,
  "migrations": "current",
  "pendingMigrations": [],
  "pricing": {
    "ok": true,
    "worker": "available",
    "scheduler": "on_schedule",
    "quotes": "ok"
  }
}
```

Every key is always present. The closed sets are:

- `worker`: `available`, `unavailable`;
- `scheduler`: `not_started`, `waiting`, `running`, `on_schedule`, `overdue`;
- `quotes`: `not_attempted`, `market_closed`, `ok`, `partial`, `failed`, `unknown`.

`pricing.ok` is a boolean, defined in "The rollup" below.

The public body carries coarse scheduler and pricing activity by design, but no symbol, holding
count, socket path, provider hostname, exception text, or timestamp. The latter would expose more
household shape or activity through the one unauthenticated application route. Logs, `price_poll`,
`price_backfill` and the authenticated **Settings → Prices** screen keep detailed diagnosis. With no
timestamp in the payload, a monitor alerts on the category it sees; it cannot infer how long that
state lasted from one response.

One leak is accepted rather than denied: `quotes: partial` implies the household holds at least two
priceable instruments and `failed` implies at least one, because the provider is never called on an
empty feed (`app/lib/prices.server.ts:486`). That is a lower bound, not a count, and the alternative
— collapsing the two — costs the distinction between "one ticker is bad" and "the pipeline is down",
which is the distinction an operator acts on.

### The scheduler must actually be running for any of this to mean anything

`startPricePoller()` moves from the root loader to a root middleware. React Router runs the root
middleware chain for resource routes even though it does not run their parent loaders:
`handleResourceRequest` passes `generateMiddlewareResponse` and `queryRoute` runs
`runServerMiddlewarePipeline` over every match (`lib/server-runtime/server.ts:670`,
`lib/router/router.ts:4439`). This repo already depends on exactly that, which is why the lock has to
exempt `/healthz` by hand (`app/root.tsx:45`, `:130`, and `ARCHITECTURE.md:1623-1625`).

The app's own healthcheck already dials `/healthz` every ten seconds (`compose.yaml:151-160`), and
Caddy's does too (`:329-334`), so the poller arms within ten seconds of boot in every shipped
deployment — with no page view, no new framework surface, and no immediate fetch, since
`startPricePoller` arms a timer and deliberately does not poll on start.

This is a behaviour fix, not a reporting choice, and it comes first for a reason. Without it
`scheduler: not_started` is the ordinary state of a healthy container that nobody has visited yet,
and `pricing.ok: false` is what the shipped deployment reports most of the time. With it,
`not_started` means what it should: `startPricePoller` was never reached, or it threw. Ticket 01
also has to make the second half true — the `try` opens at `app/lib/price-poller.server.ts:118`,
*after* the `socketProvider()` default parameter at `:114`, so a throw from building the provider
escapes the catch at `:131-134` today. From a middleware that would be a 500 on every request,
`/healthz` included.

### Worker status is a bounded live probe

The app calls the worker's existing socket `GET /healthz` with a 500 ms deadline. It accepts only
HTTP 200, an `application/json` response no larger than 1 KiB, and exactly the JSON object
`{"ok":true}`. Every refusal, timeout, early close, missing socket, permission failure, or other
body maps to `unavailable`. The check never throws out of the route and never exposes its error.

The 500 ms is a whole-exchange deadline, deliberately unlike the `5000` that
`compose.yaml:196`, `docs/operating.md:306` and `scripts/smoke-test.sh:451` pass — those are
socket-inactivity timers on a probe that is allowed to be slow because it runs once. A local socket
that has not completed an eleven-byte answer in half a second is not healthy, and `/healthz` is
answered on a request path.

The probe is single-flight and caches both answers for five seconds per app process. `/healthz` is
one of only two un-gated handles through Caddy (`Caddyfile:20-22`), so it is an unauthenticated
amplifier onto a worker that accepts eight connections at a time and closes each after one request
(`server/price-worker.ts:350-351`) — there is no keep-alive to reuse, so every probe costs one of the
eight for its lifetime. Single-flight alone bounds concurrency but not a sequential flood; the cache
bounds both, at the price of a transition taking up to five seconds to appear.

This probe proves app → shared mount → worker listener. It does not prove the proxy, DNS, TLS, Yahoo,
or unused quote/history rate budget. It is not implemented through the existing `ask` helper, whose
POST body, response caps, and 15/35-second budgets are provider-operation semantics — but neither is
it a second hand-written copy of that helper's transport, which is where the subtle bugs are.

### Scheduler and quote status are passive

The existing poller slot gains two facts and a typed reader; the health **loader** reads a snapshot
and does not start the poller, retime it, or fetch a quote. The root middleware still arms it on the
way past — that is ticket 01, and it is the whole reason these categories mean anything — but the
reporting path itself is passive, so what `/healthz` says is never a consequence of `/healthz`
having been asked.

- `not_started`: this app process has no poller slot.
- `running`: a tick is in flight and not overdue.
- `on_schedule`: armed, nothing in flight, and not late.
- `overdue`: no tick has *begun* for longer than the cadence plus five minutes.

`overdue` is measured from when a tick last started, not from a stored next-due instant, and it is
**not** suppressed by a tick being in flight. Both choices exist for the same failure: a tick that
never returns. `state.running` is cleared only in the tick's `finally`
(`app/lib/price-poller.server.ts:87`) and nothing else clears it, and the tick is not bounded —
`ask` has budgets but the cadence read and the whole price transaction do not, and `server/db.ts:29`
sets no `statement_timeout`. A next-due instant cannot catch this either, because `setInterval` keeps
firing during a hang and each firing would advance it while the running guard drops the work. A
stamp taken when a tick gets past that guard freezes in exactly the two cases worth reporting: the
timer stopped firing, and the tick stopped returning.

Market hours do not suppress `overdue`: off-hours ticks still run backfill.

One trade is accepted. An upload-triggered `requestRefresh()` also stamps the instant, so a manual
refresh masks a stopped timer for one cadence plus the grace. The field means *pricing work last
began in this process*, and work that began two minutes ago is work. Gating the stamp to scheduled
ticks only would trade that for the opposite fault: a scheduled firing dropped behind a long
requested refresh would leave the stamp two intervals old and report a false `overdue`.

Quote state describes the last tick that observed a provider outcome:

- `not_attempted`: no tick has yet decided whether to quote;
- `market_closed`: that tick deliberately skipped quotes;
- `ok`: quotes were requested and every selected instrument was priced, including the valid
  zero-instrument case;
- `partial`: at least one, but not every, selected instrument was priced;
- `failed`: a provider-wide failure, or instruments were requested and none was priced;
- `unknown`: an internal or database error prevented a trustworthy result.

Quote state is separate from the scheduler's terminal result. A tick gated by market hours records
`market_closed` at the moment it makes that decision, so a later backfill failure in the same tick
cannot rewrite it. Advisory-lock `busy` adds no observation of its own, because it saw no provider
outcome — so the preceding result stands, except where that same tick had already recorded its own
market-hours decision, which it did observe. Upload-triggered `requestRefresh()` calls use the poller's tick and therefore
update the snapshot; the direct `POST /refresh` route bypasses the poller and does not. This contract
is about the scheduled pipeline and its post-upload requests, not every interactive fetch.

The current worker protocol collapses proxy and Yahoo failures into worker `502`/`504` responses.
The health contract must not claim which of those failed. `worker: available` plus `quotes: failed`
means only that the listener answered the health probe while the latest real quote operation did
not succeed end to end.

### The rollup

`pricing.ok` is derived, never stored, by one conjunction over the three closed sets:

```
ok  ⟺  worker    === "available"
   and scheduler ∈ { "running", "on_schedule" }
   and quotes    ∈ { "not_attempted", "market_closed", "ok" }
```

Equivalently, `ok` is `false` exactly when the worker is unavailable, the scheduler is `not_started`
or `overdue`, or quotes are `partial`, `failed` or `unknown`.

A boolean rather than a four-value status. Nothing automated acts on the difference between "idle"
and "healthy" — the rollup exists so a keyword-matching monitor that cannot express a compound
predicate has one field to watch, and every richer question is answered by the three attributes
beside it. A conjunction over closed sets is exhaustive by construction; an ordered clause list over
the sixty-cell product is not, and would be a fourth vocabulary to pin, document and keep in step.

Note what this makes normal: a fresh container reports `scheduler: on_schedule`,
`quotes: not_attempted` and `ok: true` for up to one cadence, because there is no immediate poll on
start — `on_schedule` means armed and not late, which is exactly true of a poller that has not yet
had a turn, and `quotes` beside it already says nothing has run. A weekend reports
`quotes: market_closed` and `ok: true`. Neither is a fault and neither should page anyone.

## What this does not do

- No Yahoo request from `/healthz`; monitor frequency never becomes market-data traffic.
- No proxy liveness claim. Compose service-state monitoring still watches `egress-proxy` separately.
- No restart or readiness dependency on pricing.
- No new database table or heartbeat writes. The requested fact is current process health, and the
  shipped topology has one app process. Durable attempt history remains `price_poll` and
  `price_backfill`.
- No promise that a plausible provider price is true.
- No fix for lossy requested refreshes or never-priced instruments missing from the normal freshness
  caption; this slice exposes rather than hides those separate defects. It *does* fix the lazy
  scheduler start, because that one would otherwise make the contract dishonest from its first day.

If the deployment later runs multiple app replicas, a request reports the instantaneous state of the
replica which answered it. The snapshot resets to `not_started` on process restart or HMR disposal.
Per-replica monitoring or a durable lease then becomes a separate design; one shared heartbeat
would prove only that *some* replica is alive.

## Rejected

- **A four-value `pricing.status`.** Six ordered clauses over a 2×5×6 product that never changes the
  HTTP status, so nothing automated reads it; its `idle` case needed a "has any tick completed" fact
  no other rule needed, and a first-tick hang landed in exactly that case and reported `idle`
  forever. Replaced by `pricing.ok` above.
- **A next-due instant.** See "Scheduler and quote status are passive": it marches forward during
  the hang it would need to catch.
- **A `waiting` category, for a poller armed with no tick yet.** It needed a "has any tick
  completed" fact on the slot — the same fact that condemned the four-value status above — for a
  category nothing acts on: `waiting` and `on_schedule` are both `ok: true`, both HTTP 200, and
  `quotes: not_attempted` beside them already says a tick has not run. It was also wrong in a way
  the category hid: `requestRefresh` reaches the same `finally`, so an upload on a fresh container
  would report a schedule that had never run as `on_schedule`.
- **Leaving the lazy start alone and reporting it.** An alarm that is red on every fresh container
  until a human opens a page is one an operator learns to ignore, and the fix is a moved line.
- **Module scope in an ejected `app/entry.server.tsx`.** It would run at boot — `react-router-serve`
  imports the build before `app.listen` — but ejecting means owning the framework's default streaming
  `handleRequest` forever, and under `react-router dev` the module is re-evaluated on every
  invalidation. The middleware is one line and no new surface.
- **A durable heartbeat table.** One process, one snapshot; under replicas a shared heartbeat would
  prove only that some replica is alive.
- **Hand-copying `ask`'s transport for the probe.** Its `close`-before-`end` guard is the one whose
  omission hangs the check that exists to detect a hang.

## Delivery

1. [`price-health/01-arm-the-poller-from-middleware.md`](price-health/01-arm-the-poller-from-middleware.md)
   makes scheduled pricing start with the process rather than with the first page view. No health
   contract change; it is what makes the next two honest.
2. [`price-health/02-worker-reachability.md`](price-health/02-worker-reachability.md) extracts the
   Unix-socket transport, adds the cached probe, and ships `pricing: { worker }` — the only key it
   ships, so no value it publishes is redefined later.
3. [`price-health/03-scheduler-and-fetch-status.md`](price-health/03-scheduler-and-fetch-status.md)
   deepens the poller slot, adds the pure derivation module, and completes the contract with
   `scheduler`, `quotes` and `ok`.

Tickets 01 and 02 are independent and can run at once. Ticket 03 needs both. All three are green on
their own, and none needs a schema migration or an outbound provider probe.

## Acceptance

- [ ] The poller arms from the process's own healthcheck traffic, with no page view
- [ ] Worker failure never changes a database-current `/healthz` from HTTP `200`
- [ ] Database or migration failure still returns `503`, whatever pricing reports
- [ ] Worker status proves the app-side socket path, not only the worker's own mount
- [ ] `/healthz` never reaches Yahoo or spends worker quote/history rate budget
- [ ] The health loader never starts, stops or retimes the poller; arming it on the way past is the
      root middleware's job and nothing the loader reads depends on the request that armed it
- [ ] Scheduler absence, lateness and active work are distinguishable, and a tick that never returns
      reports `overdue` rather than `running`
- [ ] Expected market-closed quote silence is not reported as failure
- [ ] Partial and total quote failures are distinguishable without exposing counts
- [ ] Exact response keys and every closed vocabulary are pinned by tests
- [ ] `Cache-Control: no-store` remains
- [ ] The public body contains no portfolio detail, timestamp or raw error
- [ ] `ARCHITECTURE.md`, `docs/operating.md`, and `docs/runbook.md` state what each attribute proves
      and what it cannot, and no document still says the poller starts from the first page render
