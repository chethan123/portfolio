# Pricing health on `/healthz` — feasibility of spec 0021

**Date:** 2026-09-08. **Against:** `c633e3a`.
**Read:** [`docs/specs/0021-price-health.md`](../specs/0021-price-health.md) and both delivery
tickets, `app/routes/healthz.ts`, `app/lib/price-poller.server.ts`, `app/lib/refresh.server.ts`,
`app/lib/prices.server.ts`, `app/lib/provider-socket.server.ts`, `server/price-worker.ts`,
`app/root.tsx`, `compose.yaml`, `Caddyfile`, `scripts/smoke-test.sh`, `docs/operating.md`,
`docs/runbook.md`.

## Verdict

Buildable, and its central technical claim holds: `runRefresh` already returns everything the quote
vocabulary needs, so no change to the pricing path is required. Ticket 01 is sound and proves a fact
nothing else proves continuously.

Ticket 02 is where the slice goes wrong, in three ways that are worth fixing before it is built:

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
  (`app/lib/prices.server.ts:69-77`) and distinguishes `busy` from `error`
  (`app/lib/refresh.server.ts:35-38`). Every category in the `quotes` vocabulary is derivable from
  what already crosses that boundary.
- `report.quotes === null` is the market-hours skip, decided in the tick
  (`app/lib/price-poller.server.ts:61`) and collapsed to `null` at `app/lib/prices.server.ts:412`.
  The poller knows the reason even though `runRefresh` does not.
- `price_poll` really is not a heartbeat — written only inside `refreshQuotes`
  (`app/lib/prices.server.ts:552`), and no application code reads it today.
- `/healthz` is a resource route and does not run the root loader (`docs/operating.md:1163`), so
  the endpoint genuinely can observe `not_started` — the spec is right about that mechanism.
- Adding keys breaks `tests/routes/healthz.test.ts:21-27` by design (`toEqual`, with a comment
  saying so). That is the contract working.

## Findings

### F1 — A hung tick reports healthy, forever

`overdue` requires "no tick is running" (0021:118). `state.running` is set at
`app/lib/price-poller.server.ts:55` and cleared only in the `finally` at `:86`. A tick that does not
return therefore pins `scheduler: running`, preserves the previous `quotes`, and — by clause 5 —
yields `pricing.status: ok` indefinitely.

That is the shape of the failure this endpoint exists to catch: the app blocked on the worker. It is
bounded today only because `ask` carries 15/35-second budgets
(`app/lib/provider-socket.server.ts:32-35`); the health contract should not depend on another
module's timeouts for its liveness claim.

**Fix:** make `overdue` a function of when the last tick *started*, evaluated regardless of
`running`. See F6.

### F2 — `not_started` will be the normal state of every fresh container

`docs/operating.md:1158-1163` already states the defect: the poller starts from the first page
render, `/healthz` does not count, and "a booted instance nobody has visited does zero refreshes,
forever."

So under this spec every fresh container reports `pricing.status: degraded` from boot until a family
member opens a page — on this deployment, potentially hours. An alert that is red by default is
muted by default, and then it is not an alert.

0021:150-153 argues this is deliberate visibility. That trade is wrong when the fix is one line.

**Fix:** move `startPricePoller()` out of the root loader (`app/root.tsx:179`) and into a root
middleware. Middleware runs for resource routes — that is precisely why `lockMiddleware` has to
exempt `/healthz` by hand (`app/root.tsx:45`, `:130`) and why `crossOriginMutationMiddleware` exists
at all (`ARCHITECTURE.md:389`). The app's own healthcheck hits `/healthz` every ten seconds
(`compose.yaml:151-160`) and Caddy's does too (`:329-334`), so the poller would arm within ten
seconds of boot in every deployment, with no page view and no new framework surface.

`startPricePoller` is already idempotent (`price-poller.server.ts:116`) and arms a timer rather than
fetching (`:110-111`), so a public un-gated path cannot amplify anything through it.

Two caveats worth carrying into the ticket. First, this inherits the `future.v8_middleware`
dependency (`react-router.config.ts:11`) — the same one the lock already rests on, and already
pinned by `tests/framework-wiring.test.ts:84`. Second, **no test in this suite proves the framework
dispatches root middleware for a resource route**: every middleware test calls the exported chain
directly through `servedThrough` (`tests/support/routes.ts:140`), never through
`createRequestHandler`. The evidence is the repository's own design — `app/root.tsx:130` exempting
`/healthz` inside `lockMiddleware` would be dead code otherwise, and `crossOriginMutationMiddleware`
exists precisely to cover resource routes (`ARCHITECTURE.md:389`) — which is strong but is not a
test. Prove it with one request through the real handler before building on it.

Then `not_started` means what the spec wants it to mean — a real fault — the paragraph justifying it
as `degraded` becomes unnecessary, and `docs/operating.md`'s cause 1 gets deleted rather than
restated as a health category.

### F3 — Ticket 01 ships a public vocabulary that ticket 02 redefines

`price-health/01` has `pricing.status` be `unknown` when the worker is available, "because this
ticket has no scheduler claim". In the finished contract `unknown` is clause 3 or clause 6 — a
database error during a tick, or the defensive fallback.

So a monitor wired against the first pull request either alerts on the healthy state or learns to
ignore the value that later means trouble. Both pull requests are green on their own; the public
contract is not.

**Fix:** ship `pricing.worker` alone in ticket 01. Introduce the aggregate, if it survives F4, in
ticket 02 where it can mean something.

### F4 — Drop `pricing.status`

Six ordered clauses over a 2×5×6 product space, derived and never stored, and by the spec's own rule
it never changes the HTTP status. Nothing automated acts on it. A monitor that wants one boolean can
write the predicate over the three attributes it is already given.

What keeping it costs:

- a fourth closed vocabulary to pin (acceptance line 8 of 0021);
- clause 4's special case — "its first tick is `running` with `not_attempted`" — which needs a
  "has any tick completed" fact that no other rule needs;
- three documents to keep in step with an ordering that no test can prove is the intended one,
  only that it is the implemented one.

If a rollup is genuinely wanted, `pricing.ok: true | false` says the same thing to a monitor and
cannot be got subtly wrong.

### F5 — Put the derivation in a pure module

Ticket 02's own test list is eight scheduler states crossed with eight quote outcomes. As specified
those are integration tests driving a process-wide `globalThis` slot inside a serial suite.

Make the derivation a pure function instead — `app/lib/price-health.ts` (plain `.ts`),
`pricingHealth(snapshot, now)` — with the poller module exposing a typed read of the slot and the
route composing the two. Then the whole matrix is a table-driven unit test: no Postgres, no fake
timers, no shared global. That is the repo's own layering rule (`CLAUDE.md`, "Pure domain … every
awkward CSV is a fixture") and it is the single biggest cost reduction available in this slice.

### F6 — One timestamp instead of a next-due instant

Ticket 02 asks that the interval callback advance next-due "before the running guard". The guard is
the first line of `tick` (`price-poller.server.ts:53`) and `tick` is shared with `requestRefresh`
(`:157`), which the same bullet says must not move the phase. So the advance has to live in the two
`setInterval` arrow wrappers — `:46` in `retime` and `:125` in `startPricePoller` — a duplication the
ticket does not name.

Store `lastTickStartedAt` instead. Then `overdue` is
`now − lastTickStartedAt > (minutes + 5) × 60s`, which:

- needs no phase bookkeeping and cannot drift from the timer;
- is already correct across `retime`, because `minutes` is on the slot (`:48`);
- fires on a hung tick, closing F1;
- is seeded at arm time, matching "no immediate poll" (`:110-111`).

### F7 — The probe will re-copy about sixty lines of `ask`

Ticket 01 forbids routing through or duplicating `ask`, rightly: its POST body, caps and 15/35-second
budgets are provider-operation semantics. But the probe still needs `ask`'s settle-once guard
(`provider-socket.server.ts:76-82`), byte-accumulating cap with `req.destroy()` (`:97-105`), the
`err.syscall === "connect"` branch (`:153-157`), the abort branch (`:160-168`), and the
`close`-before-`end` hang guard (`:175-177`).

That last one is the subtle one — a hand-rolled second copy that omits it hangs, which is the exact
bug the probe is supposed to detect. The ticket should say which of those mechanics is extracted and
shared, rather than leaving "do not duplicate `ask`" as the only instruction.

### F8 — The cached probe does not belong in `provider-socket.server.ts`

That module's header promises the opposite: "Nothing is remembered between calls, so a recovery is
never delayed" (`app/lib/provider-socket.server.ts:5`). A five-second memo of both outcomes
contradicts it in the same file. `socketProbe` (`:261`) also already means something else — per-symbol
`available | unavailable`. Give the reachability check its own module.

### F9 — Four probes, two deadlines, no reconciliation

The same `GET /healthz` over the socket already exists at `compose.yaml:196` (5000 ms),
`docs/operating.md:306` (5000 ms) and `scripts/smoke-test.sh:441-454` (5000 ms). Ticket 01 adds a
fourth at 500 ms with stricter acceptance. Either say why the app's own probe is ten times stricter
than the three the operator is told to trust, or have the smoke test call the app's route instead of
re-implementing it.

## Corrections and notes

- **Citations.** `runRefresh` is `app/lib/refresh.server.ts:54`, not `prices.server.ts` (0021:36).
  `isMarketOpen` is `app/lib/market-hours.ts:87`, not `prices.server.ts` (0021:31).
- **"Block a dependent cold start"** (0021:22) is hypothetical: `worker` has no `depends_on` and
  nothing depends on it; `app` depends only on `db` (`compose.yaml:123-125`). The other two reasons
  for staying `200` stand on their own.
- **`not_started` is two facts.** `startPricePoller` assigns the slot after arming and swallows a
  throw (`price-poller.server.ts:118-134`), so an absent slot is "never called" or "start failed" —
  and the second already logs at error level.
- **Lower-bound leak.** `quotes: partial` implies at least two instruments; `failed` implies at least
  one, since the provider is never called on an empty feed (`prices.server.ts:486`). "No holding
  count" is true; "no household shape" is not quite.
- **Last writer wins.** An upload-triggered `requestRefresh` forces quotes regardless of hours
  (`price-poller.server.ts:157`), so one manual off-hours upload's outcome is what the endpoint
  reports for the *scheduled* pipeline until the next tick — up to one cadence.
- **Connection cost.** `maxRequestsPerSocket = 1` (`server/price-worker.ts:351`), so every probe
  burns one of the worker's eight connections for its lifetime with no keep-alive to reuse. With
  Caddy and the app both polling every ten seconds, a five-second cache coalesces roughly half of
  that; its real justification is that `/healthz` is the one un-gated path through Caddy
  (`Caddyfile:18-22`), so it is an unauthenticated amplifier onto an eight-connection socket.
  Single-flight alone would not bound a sequential flood. Keep the cache — state that reason.
- **Two absolute claims ticket 01 falsifies and does not list:** `ARCHITECTURE.md:1613` ("Never
  crosses the socket — silent on whether `worker` or `egress-proxy` are even running") and
  `docs/operating.md:298` ("never crosses the socket"). `app/routes/healthz.ts:4-6`'s own docstring
  needs care too: the probe still is not a price-provider check.
- **Test seams.** `tests/routes/healthz.test.ts` reaches only the healthy branch today (its comment
  at `:5-6`). Driving `worker: unavailable` needs `PRICE_WORKER_SOCKET` pointed at a temporary path
  before `getConfig()` caches (`server/config.ts:209`); `tests/provider-socket.test.ts:333-421`
  already builds real Unix listeners to copy. Ticket 02's "inject `now`, no fake global clock" cuts
  against `tests/price-poller.test.ts`, which fakes `Date` globally at `:122`, `:231`, `:303`,
  `:333` — the ticket should say what becomes of those.

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

## The shorter fork

If the appetite is smaller than two tickets: fix the bootstrap (F2), ship ticket 01 without
`pricing.status`, stop. Scheduler liveness becomes a can't-happen rather than a routine state, and
`price_poll` plus the log stems already in `runbook.md:288-345` cover the diagnosis. Add ticket 02
when a stall turns up that those could not explain.
