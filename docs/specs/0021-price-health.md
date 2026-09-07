# 0021 — Pricing health without making pricing readiness

**Status:** proposed

## The question

Can the public `GET /healthz` response tell a monitor that the price worker is unreachable or that
scheduled fetching is not happening, while the endpoint still returns `200` and the application
keeps serving last-known prices?

Yes, but “worker is reachable” and “prices are being fetched” are different facts. This slice adds
both as attributes and makes neither one app readiness.

## What exists

The app endpoint currently answers only database reachability and migration currency. Its HTTP
status is `200` exactly when those are healthy and `503` otherwise; the response is unauthenticated,
uncached, and pinned key-for-key by a test (`app/routes/healthz.ts`,
`tests/routes/healthz.test.ts`). Compose's app healthcheck looks only at `response.ok`. A pricing
`503` would mark an otherwise useful app unhealthy, block a dependent cold start, and invite an
external monitor or orchestrator to restart it without repairing the dependency
(`compose.yaml`, `app/lib/prices.server.ts`).

The worker already has `GET /healthz` over its Unix socket. It answers before Yahoo and before the
quote/history rate limiters. That proves only that the listener accepts a request. The worker's own
container healthcheck calls it from inside the worker container, so it cannot prove that the app's
separate read-only mount can connect (`server/price-worker.ts`, `compose.yaml`).

The poller's live state already sits in a `globalThis` slot so it survives module reloads. It stores
whether it started and whether a tick is running; its arm and tick paths observe the due phase,
market-hours decision, and `runRefresh` result without retaining them. The slot can be deepened at
those existing seams rather than adding a second state owner (`app/lib/price-poller.server.ts`).
`price_poll` is not a scheduler heartbeat: it is written only
when quotes are attempted, inside the price transaction, so an off-hours tick or rolled-back refresh
leaves no row (`app/lib/prices.server.ts`, `migrations/0009_price_observation.sql`).

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
    "status": "ok",
    "worker": "available",
    "scheduler": "on_schedule",
    "quotes": "ok"
  }
}
```

Every key is always present. The closed sets are:

- `pricing.status`: `ok`, `idle`, `degraded`, `unknown`;
- `worker`: `available`, `unavailable`;
- `scheduler`: `not_started`, `waiting`, `running`, `on_schedule`, `overdue`;
- `quotes`: `not_attempted`, `market_closed`, `ok`, `partial`, `failed`, `unknown`.

The public body carries coarse scheduler and pricing activity by design, but no symbol, holding
count, socket path, provider hostname, exception text, or timestamp. The latter would expose more
household shape or activity through the one unauthenticated route. Logs and the database keep
detailed diagnosis. With no timestamp in the payload, a monitor alerts on the category it sees; it
cannot infer how long that state lasted from one response.

### Worker status is a bounded live probe

The app calls the worker's existing socket `GET /healthz` with a 500 ms deadline. It accepts only
HTTP 200, an `application/json` response no larger than 1 KiB, and exactly the JSON object
`{"ok":true}`. Every refusal, timeout, early close, missing socket, permission failure, or other
body maps to `unavailable`. The check never throws out of the route and never exposes its error.

The probe is single-flight and caches both answers for five seconds per app process. `/healthz` is
public and Compose calls it every ten seconds; without coalescing, a monitor burst could occupy the
worker's eight-connection allowance. The cache bounds added load and means a transition may take up
to five seconds to appear.

This probe proves app → shared mount → worker listener. It does not prove the proxy, DNS, TLS, Yahoo,
or unused quote/history rate budget. It is not implemented through the existing `ask` helper, whose
POST body, response caps, and 15/35-second budgets are provider-operation semantics.

### Scheduler and quote status are passive

The existing poller slot gains timestamps and categorical results; `/healthz` reads a snapshot and
does not start the poller or fetch a quote.

- `not_started`: this app process has no poller slot. This preserves the visibility of the current
  lazy-start architecture instead of letting `/healthz` hide it by starting the timer.
- `waiting`: armed with no completed tick and not yet overdue, including the five-minute grace after
  its first due instant.
- `running`: a tick is in flight.
- `on_schedule`: the last tick completed and the next one is not overdue.
- `overdue`: wall time is at least five minutes past the stored next-due instant and no tick is
  running. Market hours do not suppress this: off-hours ticks still run backfill.

The timer records its next-due instant whenever it is armed or retimed. Its interval callback moves
that instant to the next real interval phase before the local-running guard, including when the
callback's work is dropped. An upload-requested refresh does not move the scheduled instant. A tick
updates live state before provider/database work and records its terminal result in `finally`; a
dropped local tick changes neither the in-flight state nor the previous quote result.

Quote state describes the last tick:

- `not_attempted`: no tick has yet decided whether to quote;
- `market_closed`: that tick deliberately skipped quotes;
- `ok`: quotes were requested and every selected instrument was priced, including the valid
  zero-instrument case;
- `partial`: at least one, but not every, selected instrument was priced;
- `failed`: a provider-wide failure, or instruments were requested and none was priced;
- `unknown`: an internal/database error prevented a trustworthy result.

Quote state is separate from the scheduler's terminal result. A tick gated by market hours records
`market_closed` when it makes that decision, even if its backfill later fails. Advisory-lock `busy`
preserves the preceding quote result because it observed no provider outcome. Upload-triggered
`requestRefresh()` calls use the poller's tick and therefore update the snapshot; the direct
`POST /refresh` route bypasses the poller and does not. This contract is about the scheduled pipeline
and its post-upload requests, not every interactive fetch.

The current worker protocol collapses proxy and Yahoo failures into worker `502`/`504` responses.
The health contract must not claim which of those failed. `worker: available` plus `quotes: failed`
means only that the listener answered the health probe while the latest real quote operation did
not succeed end to end.

### Aggregate status

`pricing.status` is derived, never stored, by this ordered and total rule:

1. `degraded` when the worker is unavailable or the scheduler is `not_started`/`overdue`;
2. otherwise `degraded` when quotes are `partial`/`failed`, regardless of the current wall clock;
3. otherwise `unknown` when quotes are `unknown`;
4. otherwise `idle` when the scheduler is `waiting`, when its first tick is `running` with
   `not_attempted`, or when quotes are `market_closed`;
5. otherwise `ok` for `quotes: ok` with a running/on-schedule scheduler;
6. otherwise `unknown` as the defensive exhaustive fallback.

A later off-hours tick may replace an old failure with `market_closed`; merely crossing the market
close boundary does not. A successful zero-instrument quote attempt is `ok`, not a special idle
state: distinguishing it would reveal household shape and is not needed to answer pipeline health.

`not_started` is degraded rather than idle because the shipped deployment promises scheduled work.
The known root-loader bootstrap problem therefore becomes visible without being silently repaired
by the diagnostic endpoint.

## What this does not do

- No Yahoo request from `/healthz`; monitor frequency never becomes market-data traffic.
- No proxy liveness claim. Compose service-state monitoring still watches `egress-proxy` separately.
- No restart or readiness dependency on pricing.
- No new database table or heartbeat writes. The requested fact is current process health, and the
  shipped topology has one app process. Durable attempt history remains `price_poll` and
  `price_backfill`.
- No promise that a plausible provider price is true.
- No fix for lazy scheduler startup, lossy requested refreshes, or never-priced instruments missing
  from the normal freshness caption; this slice exposes rather than hides those separate defects.

If the deployment later runs multiple app replicas, a request reports the instantaneous state of the
replica which answered it. The snapshot resets to `not_started` on process restart or HMR disposal.
Per-replica monitoring or a durable lease then becomes a separate design; one shared heartbeat
would prove only that *some* replica is alive.

## Delivery

1. [`price-health/01-worker-reachability.md`](price-health/01-worker-reachability.md) adds the live,
   cached socket probe and the first non-gating pricing attribute.
2. [`price-health/02-scheduler-and-fetch-status.md`](price-health/02-scheduler-and-fetch-status.md)
   deepens the existing poller slot and completes the nested contract.

Both pull requests remain independently green. The first answers “can the app reach the worker?”;
the second answers “is scheduled pricing actually moving?” without a schema migration or an
outbound provider probe.

## Acceptance

- [ ] Worker failure never changes a database-current `/healthz` from HTTP `200`
- [ ] Database or migration failure still returns `503`, whatever pricing reports
- [ ] Worker status proves the app-side socket path, not only the worker's own mount
- [ ] `/healthz` never reaches Yahoo or spends worker quote/history rate budget
- [ ] Scheduler absence, lateness and active work are distinguishable
- [ ] Expected market-closed quote silence is not reported as failure
- [ ] Partial and total quote failures are distinguishable without exposing counts
- [ ] Exact response keys and every closed vocabulary are pinned by tests
- [ ] `Cache-Control: no-store` remains
- [ ] The public body contains no portfolio detail or raw error
- [ ] `ARCHITECTURE.md`, `docs/operating.md`, and `docs/runbook.md` state what each attribute proves
      and what it cannot
