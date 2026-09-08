# Pricing health on `/healthz` — feasibility of spec 0021

**Date:** 2026-09-08. **Against:** `c633e3a`.
**Read:** [`docs/specs/0021-price-health.md`](../specs/0021-price-health.md) and both delivery
tickets, `app/routes/healthz.ts`, `app/lib/price-poller.server.ts`, `app/lib/refresh.server.ts`,
`app/lib/prices.server.ts`, `app/lib/provider-socket.server.ts`, `server/price-worker.ts`,
`server/db.ts`, `app/root.tsx`, `compose.yaml`, `Caddyfile`, `scripts/smoke-test.sh`,
`docs/operating.md`, `docs/runbook.md`, and `react-router@7.18.2`'s own source.

Every citation below was checked by a second pass whose corrections are folded in; where that pass
overturned a finding, the finding is rewritten rather than quietly dropped — F6 is the one that
changed shape, and §"What the second pass overturned" says how.

**Superseded in part.** Spec 0021 and its tickets were rewritten on the same day in response to
this review, so "ticket 01" and "ticket 02" below name the *pre-rewrite* tickets — the worker probe
and the scheduler snapshot. The slice is now three tickets, with the bootstrap fix first. The
findings and their evidence stand as the reasoning that produced that shape; where the spec now
disagrees with something described here as its decision, the spec is the one to believe.

## Verdict

Buildable, and its central technical claim holds: `runRefresh` already returns everything the quote
vocabulary needs, so no change to the pricing path is required. Ticket 01 is sound and proves a fact
nothing else proves continuously.

Ticket 02 is where the slice goes wrong, in three ways worth fixing before it is built:

1. it reports a known bug as a permanent alarm rather than fixing it, in one line;
2. its `overdue` rule cannot fire for the failure the endpoint most exists to catch;
3. its aggregate `pricing.status` is the largest thing in the spec and nothing consumes it.

## What the repository confirms

The spec's premises are accurate. Verified rather than assumed:

- The worker answers `GET /healthz` with exactly `{"ok":true}` and `content-type: application/json`
  (`server/price-worker.ts:285-288`, `:88-92`), and answers it **above** both rate limiters
  (`:291`, `:296`, admissions taken in `readAdmittedBody` at `:226-229`). A probe therefore spends
  no quote or history budget — structurally, not by convention.
- The socket is already mounted into `app` read-only (`compose.yaml:139`) and the app can already
  dial it: `scripts/smoke-test.sh:441-454` does exactly this probe today.
- `runRefresh` returns `requested`, `priced`, `providerFailed` on a `done` run
  (`app/lib/prices.server.ts:68-77`) and distinguishes `busy` from `error`
  (`app/lib/refresh.server.ts:35-38`). Every category in the `quotes` vocabulary is derivable from
  what already crosses that boundary.
- `report.quotes === null` is the market-hours skip, decided in the tick
  (`app/lib/price-poller.server.ts:61`) and collapsed to `null` at `app/lib/prices.server.ts:412`.
  The poller knows the reason even though `runRefresh` does not.
- `price_poll` really is not a heartbeat — written only inside `refreshQuotes`
  (`app/lib/prices.server.ts:552`), and no application code reads it today.
- `/healthz` is a resource route and does not run the root loader (`docs/operating.md:1164`). This
  is settled in the framework source, not only in this repo's docs:
  `packages/react-router/lib/server-runtime/server.ts:260-274` routes a leaf match with no `default`
  and no `ErrorBoundary` to `handleResourceRequest`, and `getTargetedDataStrategyMatches`
  (`packages/react-router/lib/router/router.ts:6435`) hands every non-target match
  `shouldCallHandler: () => false` (`:6454`).
- Adding keys breaks `tests/routes/healthz.test.ts:20-26` by design (`toEqual`, with a comment
  saying so). That is the contract working.

## Findings

### F1 — A hung tick never reports lost liveness

`overdue` requires that no tick is running (0021:99-100). `state.running` is written in exactly
three places: `:55` (true), `:87` (false, in the `finally`), and `:120` — a fresh object in
`startPricePoller`, unreachable for a live slot because `:116` returns early. `stopPricePoller`
deletes the slot rather than clearing the flag, and in production is reachable only from the
dev-only HMR hook (`:171-173`).

So a tick that does not return pins `scheduler: running` forever, and the aggregate freezes wherever
the previous tick left it: `ok` if that tick priced everything, `idle` if it was market-closed or if
the hang is on the very first tick (clause 4), `degraded` if it was partial or failed. In every
branch the endpoint keeps reporting the state before the hang and never reports the hang. That is
the shape of the failure this endpoint exists to catch.

Nothing bounds the tick. `ask` carries 15/35-second budgets
(`app/lib/provider-socket.server.ts:32-35`), but the tick also awaits `readRefreshCadence()`
(`price-poller.server.ts:64`) and the whole price transaction, and `server/db.ts:29` sets only
`connectionTimeoutMillis` — no `statement_timeout`, no `query_timeout`. A stalled query is
unbounded. (`withRefreshLock` uses `pg_try_advisory_lock`, `prices.server.ts:49`, so there is at
least no unbounded lock wait.)

**Fix:** make `overdue` a function of when a tick last *started*, evaluated regardless of `running`.
See F6.

### F2 — `not_started` will be the normal state of every fresh container

`docs/operating.md:1160-1164` already states the defect: the poller starts from the first page
render, `/healthz` does not count, and "a booted instance nobody has visited does zero refreshes,
forever."

So under this spec every fresh container reports `pricing.status: degraded` from boot until a family
member opens a page — on this deployment, potentially hours. An alert that is red by default is
muted by default, and then it is not an alert.

0021:146-148 argues this is deliberate visibility. That trade is wrong when the fix is one line.

**Fix:** move `startPricePoller()` out of the root loader (`app/root.tsx:179`) and into a root
middleware. The app's own healthcheck hits `/healthz` every ten seconds (`compose.yaml:151-160`) and
Caddy's does too (`:329-334`), so the poller would arm within ten seconds of boot in every
deployment, with no page view and no new framework surface.

**Verified against the framework, not inferred.** At tag `react-router@7.18.2`, the version this
repo pins: parent *loaders* do not run for a resource route (citations above), but
`handleResourceRequest` passes `generateMiddlewareResponse` (`server-runtime/server.ts:670`) and
`queryRoute` runs `runServerMiddlewarePipeline` over *all* matches (`router.ts:4439`). **Loaders no,
middleware yes.** `ARCHITECTURE.md:1623-1625` already says the same thing in this repo's own words:
the lock "checks its own `LOCK_EXEMPT_PATHS` in `app/root.tsx` before a request ever reaches a
loader, and `/healthz` is on that list".

Four things the ticket must settle:

- **Placement.** `app/root.tsx:165` exports `[crossOriginMutationMiddleware, lockMiddleware]`. Put
  the poller middleware **after** `lockMiddleware`: exempt paths reach it through `next()` at `:131`,
  so `/healthz` still arms it, while a locked grant-less request throws first (`:150`, `:157`,
  `:160`) and no side effect runs ahead of a refusal.
- **The default parameter.** `startPricePoller(provider = socketProvider())`
  (`price-poller.server.ts:114`) evaluates before the `:116` early return, so in middleware it
  builds a throwaway provider on *every* request rather than every page render. Cheap, but real —
  take the provider lazily.
- **The `ErrorBoundary` trap.** Resource-route dispatch turns on the leaf having **neither** a
  `default` **nor** an `ErrorBoundary` export. Adding an `ErrorBoundary` to `app/routes/healthz.ts`
  would silently make it a document route, run the root loader again, and mask whichever bootstrap
  is in place.
- **The `future.v8_middleware` dependency** (`react-router.config.ts:11`) — the same one the lock
  already rests on, already pinned by `tests/framework-wiring.test.ts:84`. That file also already
  hand-builds a `ServerBuild` and drives it through `createRequestHandler`, so proving middleware
  dispatch for a resource route in this suite is an extension of an existing harness, not new work.

Worth knowing for scale: `/healthz.data` *already* runs the root loader, and that is a recorded
decision (`docs/specs/0020-the-lock-hardened.md:38-44`). The app therefore already has a health path
that arms the poller; this change makes the plain one behave like it.

### F3 — Ticket 01 ships a public vocabulary that ticket 02 redefines

`price-health/01` has `pricing.status` be `unknown` when the worker is available, "because this
ticket has no scheduler claim". In the finished contract `unknown` is clause 3 or clause 6 — a
database error during a tick, or the defensive fallback.

So a monitor wired against the first pull request either alerts on the healthy state or learns to
ignore the value that later means trouble. Worse, acceptance line 8 (0021:187) asks that every closed
vocabulary be pinned by tests — so ticket 01 pins a vocabulary ticket 02 has to un-pin. Both pull
requests are green on their own; the public contract between them is not.

**Fix:** ship `pricing.worker` alone in ticket 01. Introduce a rollup, if it survives F4, in the
ticket that can give it a meaning.

### F4 — Replace `pricing.status` with a boolean

Six ordered clauses over a 2×5×6 product space, derived and never stored, and by the spec's own rule
it never changes the HTTP status. Nothing automated acts on the difference between `idle` and `ok`,
or between `unknown` and `degraded`.

What keeping it costs: a fourth closed vocabulary to pin; clause 4's special case — "its first tick
is `running` with `not_attempted`" — which needs a "has any tick completed" fact that no other rule
needs; and three documents to keep in step with an ordering no test can prove is the intended one,
only that it is the implemented one. F1 sharpens this: a first-tick hang lands in exactly that
clause and reports `idle` forever, so the one-off case is also the one that hides a fault.

But a rollup does earn its place — a keyword-matching monitor cannot express a compound predicate.
Make it `pricing.ok: true | false`, defined by one conjunction over the three closed sets rather
than by six ordered clauses. Exhaustive by construction, and it cannot be got subtly wrong.

### F5 — Put the derivation in a pure module

Ticket 02 lists eight scheduler cases and eight quote cases. As specified those are integration
tests driving a process-wide `globalThis` slot inside a serial suite, each needing a fake clock, a
fake provider, or both.

Make the derivation a pure function instead — `app/lib/price-health.ts` (plain `.ts`),
`pricingHealth(snapshot, worker, now)` — with the poller module exposing a typed read of the slot and
the route composing the two. Then those sixteen cases are table-driven unit tests: no Postgres, no
fake timers, no shared global, and the state table can be covered exhaustively rather than sampled.
That is the repo's own layering rule (`CLAUDE.md`, "Pure domain … every awkward CSV is a fixture").

### F6 — Store when a tick last started, not when the next one is due

*This finding was rewritten after review; the original argued the ticket's seam did not exist, which
was wrong. See §"What the second pass overturned".*

The ticket's mechanism is a `nextDueAt` instant that the scheduled interval callback advances before
the running guard. It is implementable in one place — `tick(state, quotesRegardless)` already carries
the flag that separates the two interval wrappers (`price-poller.server.ts:46`, `:125`) from
`requestRefresh` (`:157`), so `if (!quotesRegardless) state.nextDueAt = …` above the guard at `:53`
does exactly what ticket 02 asks, with no duplication.

The problem is not the seam, it is what the field measures. `setInterval` keeps firing while a tick
hangs, and each firing advances `nextDueAt` and is then dropped by the guard. **`nextDueAt` therefore
marches forward forever during a hang, and `overdue` can never fire** — F1 is not closed by dropping
the "no tick is running" condition, because the instant it is compared against keeps moving.

`lastTickStartedAt` — stamped when a tick gets *past* the guard and begins work — measures the fact
a monitor wants, and covers both faults with one field:

- the timer stops firing → no tick starts → the stamp freezes → `overdue`;
- a tick hangs → later firings are dropped → the stamp freezes → `overdue`.

`overdue` becomes `now − lastTickStartedAt > (minutes + 5) × 60s`, needs no phase bookkeeping, is
already correct across `retime` because `minutes` is on the slot (`:48`), and is seeded at arm time,
matching "no immediate poll" (`:110-111`, armed at `:125`).

One trade to state rather than hide: an upload-triggered `requestRefresh` also stamps it, so a
manual refresh masks a stopped timer for one cadence plus the grace. That is the honest reading —
the field means "pricing work last began", and work that began two minutes ago is work — and it
avoids the opposite hazard of gating the stamp, where a scheduled firing dropped behind a long
requested refresh leaves the stamp two intervals old and reports a false `overdue`.

While there, fold the two `setInterval` call sites (`:46`, `:125`) into one `arm(state, minutes)`
that sets the handle, `minutes` and the stamp together. Whatever arms the timer stamps the phase it
armed.

### F7 — The probe will re-copy about sixty lines of `ask`

Ticket 01 forbids routing through or duplicating `ask`, rightly: its POST body, caps and 15/35-second
budgets are provider-operation semantics. But the probe still needs `ask`'s settle-once guard
(`provider-socket.server.ts:76-82`), byte-accumulating cap with `req.destroy()` (`:97-105`), the
`err.syscall === "connect"` branch (`:153-157`), the abort branch (`:160-168`), and the
`close`-before-`end` hang guard (`:175-177`).

That last one is the subtle one — a hand-rolled second copy that omits it hangs, which is the exact
bug the probe is supposed to detect. Extract the transport rather than restating it, and require the
existing `tests/provider-socket.test.ts` to pass untouched as the proof the extraction preserved
behaviour.

### F8 — The cached probe does not belong in `provider-socket.server.ts`

That module's header promises the opposite: "Nothing is remembered between calls, so a recovery is
never delayed" (`app/lib/provider-socket.server.ts:5`). A five-second memo of both outcomes
contradicts it in the same file. `socketProbe` (`:261`) also already means something else — per-symbol
`available | unavailable`. Give the reachability check its own module.

### F9 — The same probe exists three times, and the fourth is a different kind of deadline

`compose.yaml:196`, `docs/operating.md:306` and `scripts/smoke-test.sh:441-454` all dial the worker's
`/healthz` over the socket with `5000`. Ticket 01 adds a fourth at 500 ms.

The numbers are not comparable: the three existing ones pass `timeout: 5000` to `http.request` or
call `req.setTimeout(5000)`, both of which are **socket-inactivity** timers, while ticket 01's 500 ms
is a **whole-exchange** deadline (`01:25`). That is a defensible difference — a local socket that
goes quiet for half a second is unhealthy — but it should be said, because an operator reading both
will otherwise assume one of them is wrong. The smoke test proves the hop once at deploy and is not
a competing continuous probe.

## Corrections and notes

- **"Block a dependent cold start"** (0021:20) is hypothetical: `worker` has no `depends_on` and
  nothing depends on it; `app` depends only on `db` (`compose.yaml:123-125`). The other two reasons
  for staying `200` stand on their own.
- **`not_started` is two facts.** `startPricePoller` assigns the slot after arming and swallows a
  throw (`price-poller.server.ts:118-134`), so an absent slot is "never called" or "start failed" —
  and the second already logs at error level.
- **Lower-bound leak.** `quotes: partial` implies at least two instruments; `failed` implies at least
  one, since the provider is never called on an empty feed (`prices.server.ts:486`). "No holding
  count" is true; "no household shape" is not quite.
- **Connection cost.** `maxRequestsPerSocket = 1` (`server/price-worker.ts:351`), so every probe
  burns one of the worker's eight connections for its lifetime with no keep-alive to reuse. With
  Caddy and the app both polling every ten seconds, a five-second cache coalesces roughly half of
  that; its real justification is that `/healthz` is one of only two un-gated handles through Caddy
  (`Caddyfile:20-22`; `/oauth2/*` is the other), so it is an unauthenticated amplifier onto an
  eight-connection socket. Single-flight alone would not bound a sequential flood. Keep the cache —
  state that reason.
- **Sentences ticket 01 falsifies.** Its Documents section names `ARCHITECTURE.md`,
  `docs/operating.md` and `docs/runbook.md`, but not the specific claims: `ARCHITECTURE.md:1613`
  ("Never crosses the socket — silent on whether `worker` or `egress-proxy` are even running") and
  `docs/operating.md:298` ("never crosses the socket"). `app/routes/healthz.ts:4-6`'s own docstring
  needs care too: the probe still is not a price-provider check.
- **Documents the F2 move falsifies**, none of which ticket 02 lists:
  `app/lib/price-poller.server.ts:108-113` (the module header's "there is no server entry file to
  hook"), `app/root.tsx:178`, `ARCHITECTURE.md:2215`, `docs/operating.md:1160-1164` and its
  "quiet period by design" paragraph, DESIGN.md §6.2 and §10, and finding 5 of
  `docs/research/2026-09-07-price-fetch-coordination-audit.md`.
- **Test seams.** `tests/routes/healthz.test.ts` reaches only the healthy branch today (its comment
  at `:5-6`). Driving `worker: unavailable` needs `PRICE_WORKER_SOCKET` pointed at a temporary path
  before `getConfig()` caches (`server/config.ts:209`); `tests/provider-socket.test.ts:333-421`
  already builds real Unix listeners to copy. Ticket 02's "inject `now`, no fake global clock" cuts
  against `tests/price-poller.test.ts`, which fakes `Date` globally at `:122`, `:231`, `:303`,
  `:333` and `:365` — the ticket should say what becomes of those.

## What I would leave exactly as it is

- **Non-gating, and pinned by acceptance.** Correct, and the two independent HTTP-status cases are
  the right tests to demand.
- **No new heartbeat table.** Correct for a single-process deployment, and the spec's reason for
  rejecting one under replicas is sound: a shared heartbeat proves only that *some* replica is alive.
- **No Yahoo call from `/healthz`.** Correct, and structurally guaranteed by where the worker answers.
- **Ticket 01's probe as a fact worth having.** Nothing else continuously proves the app's read-only
  mount works: the worker's healthcheck dials from inside its own container
  (`compose.yaml:189-197`), and the smoke test proves the hop once, at deploy.
- **The `quotes` vocabulary.** It maps onto what `runRefresh` already returns without touching the
  pricing path. That is the spec's strongest claim and it survives.

## One alternative, and why not

**Module-scope `startPricePoller()` in an ejected `app/entry.server.tsx`.** It would work:
`react-router-serve` does `await import(buildPath)` before `app.listen`
(`packages/react-router-serve/cli.ts:84`, `:154`), and the server virtual module statically imports
`entry.server` and every route (`packages/react-router-dev/vite/plugin.ts:824`), so module scope runs
once at boot.

Rejected on cost. React Router documents no startup hook — `entry.server.tsx`'s exports are
`default`, `streamTimeout`, `handleDataRequest`, `handleError` — and ejecting means owning the
default streaming `handleRequest` forever. Under `react-router dev` the build is loaded inside the
request middleware and re-evaluated on every invalidation, so module scope runs on first request and
again on every change. (`docs/api/other-api/serve.md:81` does caution against module side effects,
but that caution sits in a section scoped to development and says so at `:94` — it is not the general
prohibition it first reads as.) The middleware move costs one line and no new surface.

## What the second pass overturned

An adversarial grounding pass over every citation here changed three things, recorded so the same
ground is not re-argued:

1. **F6's argument was wrong.** It claimed the ticket's "advance next-due before the running guard"
   named a seam that did not exist and forced a duplication across two `setInterval` wrappers.
   `tick`'s existing `quotesRegardless` parameter already makes it one line in one place. F6 now
   rests on the right reason — `nextDueAt` marches forward during a hang, so it cannot close F1 —
   which is a stronger argument than the one it replaced, and it carries the trade the original
   missed.
2. **A "citations" correction corrected nothing.** The first draft claimed spec 0021 misfiled
   `runRefresh` and `isMarketOpen` in `prices.server.ts`. It does not; both parentheticals pointed at
   lines saying no such thing. Removed.
3. **Several line numbers were off by one to two**, and F9 compared an inactivity timeout against a
   whole-exchange deadline as though they were the same measurement. Both fixed above.

## The shorter fork

If the appetite is smaller than the tickets below: fix the bootstrap (F2), ship the worker probe
without any rollup, stop. Scheduler liveness becomes a can't-happen rather than a routine state, and
`price_poll` plus the log stems already in `runbook.md:288-345` cover the diagnosis. Add the
scheduler snapshot when a stall turns up that those could not explain.
