# 03 — Scheduler and fetch status on `/healthz`

_Part of [0021-price-health.md](../0021-price-health.md)._

**What to build:** Two facts on the existing poller slot, a typed reader for it, a **pure** module
that turns that snapshot into the published categories, and the remaining three keys of the `pricing`
object. This answers whether scheduled pricing is moving, without a database heartbeat, a provider
probe, or a second copy of the poller's rules.

Separate because worker reachability is a transport fact and this is scheduler state. It adds keys to
ticket 02's object without changing its non-gating rule.

**Blocked by:** [01](01-arm-the-poller-from-middleware.md) and
[02](02-worker-reachability.md). 01 because `not_started` is meaningless until the poller starts with
the process; 02 because `pricing` and the `worker` key are its contract.

**Status:** ready-for-agent

## What already exists, and what it gives you for free

`app/lib/price-poller.server.ts` keeps a typed `PollerState` on a `globalThis` slot keyed
`Symbol.for("portfolio.pricePoller")` (`:20-35`): `timer`, `minutes`, `running`, `provider`. No
timestamps, no results. `stopPricePoller` deletes the slot (`:161-168`); the HMR hook disposes
through it (`:171-173`).

The tick (`:52-89`) already produces everything the published categories need and throws all of it
away:

- the market-hours decision at `:61` — `quotesRegardless || isMarketOpen(...)`, where
  `quotesRegardless` is `false` from both interval wrappers (`:46`, `:125`) and `true` only from
  `requestRefresh` (`:157`);
- `runRefresh`'s answer at `:71`. `RefreshRun` is `{ status: "done", report }`, `{ status: "busy" }`
  or `{ status: "error" }` (`app/lib/refresh.server.ts:35-38`); `report.quotes` is `null` when quotes
  were not asked for (`app/lib/prices.server.ts:412`) and otherwise a `RefreshReport` with
  `requested`, `priced`, `stale`, `closes`, `observed`, `providerFailed`
  (`app/lib/prices.server.ts:68-77`). `requested` is `feed.length`, `priced` is `pricedIds.size`
  (`:543-550`), and `providerFailed` is set only in the `getQuotes` catch (`:490-492`). The provider
  is not called at all when the feed is empty (`:486`), so `requested === 0` implies
  `providerFailed === false`.
- `{ status: "error" }` is the database or the lock, never the provider — `runRefresh` says so at
  `refresh.server.ts:49-50`, and it never throws (`:46-52`).
- `{ status: "busy" }` is `withRefreshLock` returning `null` when `pg_try_advisory_lock` says no
  (query at `prices.server.ts:48-50`, the `return null` at `:52`): no body ran, so no provider
  outcome was observed.
- The tick's own outer catch (`price-poller.server.ts:84-85`) is in practice reachable only from
  `getConfig()` at `:58` — i.e. *before* the market-hours decision — because `runRefresh` never
  throws and the cadence read has its own catch at `:64-67`. Do not hunt for other cases.

**No change to the pricing path is required.** Everything below reads values that already exist.

## One state owner

- [ ] Extend `PollerState`. Do not add a second global, a singleton table, a second timer, or a query
      of `price_poll`.
- [ ] `lastTickStartedAt: Date` — stamped when a tick gets **past** the `if (state.running) return;`
      guard at `:53`, and when the timer is armed. This is what `overdue` is measured from. Stamp it
      for every tick, including `requestRefresh`'s: the field means *pricing work last began in this
      process*, and 0021 records why gating it to scheduled ticks would be worse.
- [ ] `lastObservation: TickObservation | undefined` — the last tick that saw something worth
      recording, or `undefined` before any has.
- [ ] **Two fields, and no third.** There is deliberately no "has a tick completed" flag: see
      0021's **Rejected**, which cut the `waiting` category that would have needed one.
- [ ] **Fold the two `setInterval` call sites into one `arm(state, minutes)`.** `retime` (`:42-49`)
      does four things — `clearInterval` `:45`, `setInterval` `:46`, `unref?.()` `:47`, `minutes`
      `:48` — and `startPricePoller` does two of them (`:125`, `:128`), setting `minutes` in the
      object literal at `:121` and never clearing. `arm` does all of it in one place and also stamps
      `lastTickStartedAt`: whatever arms the timer stamps the phase it armed, so a cadence change
      resets the clock the way replacing the interval resets its phase. Keep `retime`'s identity
      guard at `:43` ahead of the call.
- [ ] Record the observation with a `let pending: TickObservation | undefined` declared before the
      `try`, assigned at four points and committed once:
      `market_closed` at the moment the market-hours decision is made (`:61`), before any provider or
      database work, so a later backfill failure in the same tick cannot rewrite it;
      a `done` run with `report.quotes !== null` overwrites `pending` with the quoted observation;
      a `done` run with `report.quotes === null` leaves it — that is the market-closed case, already
      recorded; `error` and the outer catch write the error observation; and **`busy` assigns
      nothing of its own**.
- [ ] **Commit conditionally.** `if (pending !== undefined) state.lastObservation = pending;` in the
      `finally`, beside `state.running = false`. An unconditional assignment would wipe the previous
      observation on every `busy` tick and report `not_attempted`, which is the opposite of the rule.
- [ ] Note what this makes true of a market-closed tick that then finds the lock held: `pending` is
      `market_closed` and it *is* committed. That is correct and is not an exception to the `busy`
      rule — `busy` means the tick observed no provider outcome, and the market-hours decision is a
      thing this tick observed before it ever reached the lock.
- [ ] A state-bookkeeping failure must not reject a page render, and must not turn a completed price
      transaction into a reported failure.
- [ ] Export one reader that copies values out — including `new Date(state.lastTickStartedAt)`, so
      no caller holds a `Date` it could mutate back into the slot. No timer handle, no provider,
      no raw error, no symbol, no count.
- [ ] `stopPricePoller` needs no change: it deletes the whole slot (`:161-168`), so the new fields
      go with it and the next read is `not_started`. Do not "clear" fields instead — that would
      make `not_started` unreachable.

## The pure module

`app/lib/price-health.ts` — plain `.ts`, no `.server`, no database, no request. This is where the
whole state table lives, so that testing it needs no Postgres, no fake timers and no `globalThis`
(`CLAUDE.md`, "Pure domain … every awkward CSV is a fixture").

```ts
export type WorkerReachability = "available" | "unavailable";
export type SchedulerStatus = "not_started" | "running" | "on_schedule" | "overdue";
export type QuoteStatus =
  | "not_attempted" | "market_closed" | "ok" | "partial" | "failed" | "unknown";

/** What one tick saw. `busy` produces none: it observed no provider. */
export type TickObservation =
  | { outcome: "market_closed" }
  | { outcome: "quoted"; requested: number; priced: number; providerFailed: boolean }
  | { outcome: "error" };

/** The poller's live state, flattened. `undefined` is "no poller slot in this process". */
export type PollerSnapshot =
  | undefined
  | {
      running: boolean;
      lastTickStartedAt: Date;
      /** Cadence the current timer was armed with. */
      minutes: number;
      lastObservation: TickObservation | undefined;
    };

export type PricingHealth = {
  ok: boolean;
  worker: WorkerReachability;
  scheduler: SchedulerStatus;
  quotes: QuoteStatus;
};

/** Five minutes past a full cadence before a scheduler is called late. */
export const OVERDUE_GRACE_MINUTES = 5;

export function pricingHealth(
  snapshot: PollerSnapshot,
  worker: WorkerReachability,
  now: Date,
): PricingHealth;
```

- [ ] `scheduler`, in this order, and the order is the point:
      no snapshot → `not_started`;
      `now − lastTickStartedAt > (minutes + OVERDUE_GRACE_MINUTES) × 60_000` → `overdue`;
      `running` → `running`;
      otherwise `on_schedule`.
      The comparison is strict, so exactly `minutes + 5` is **not** overdue; a millisecond past it
      is. Pin both.
- [ ] **`overdue` is tested before `running`, deliberately.** `state.running` is cleared only in the
      tick's `finally` (`price-poller.server.ts:87`) and nothing else clears it, and the tick is not
      bounded: `ask` has 15/35-second budgets but the cadence read and the whole price transaction do
      not, and `server/db.ts:29` sets `connectionTimeoutMillis` only — no `statement_timeout`, no
      `query_timeout`. A tick that never returns would otherwise report `running` forever. Put that
      reason in the code as a comment; it is the one ordering a later reader would "simplify" away.
- [ ] `quotes`: no snapshot or no observation → `not_attempted`; `market_closed` → `market_closed`;
      `error` → `unknown`; and for `quoted`: `providerFailed` → `failed`; `priced === requested` →
      `ok`; `priced === 0` → `failed`; otherwise `partial`.
      The zero-instrument case needs no clause of its own — `requested === 0` implies
      `providerFailed === false` (the provider is not called on an empty feed,
      `prices.server.ts:486`, which guards the only assignment at `:492`) and then `0 === 0` takes
      the `ok` branch. It stays `ok` deliberately: a separate value would report household shape and
      answers no question about pipeline health.
- [ ] `ok` is one conjunction, not an ordered clause list:
      `worker === "available"`, and `scheduler` in `{ running, on_schedule }`, and `quotes` in
      `{ not_attempted, market_closed, ok }`. Exhaustive by construction.
- [ ] `now` is a parameter. Nothing in this module reads a clock, a config, or a global.
- [ ] `price-poller.server.ts` imports the types from here, not the reverse. This module is plain
      `.ts` and ships to the browser, so nothing browser-reachable may import the poller
      (`CLAUDE.md`, the `.server.ts` bundle boundary).

## The completed contract

- [ ] `pricing` becomes `{ ok, worker, scheduler, quotes }`, every key present on every response.
- [ ] A healthy, current database with any pricing state whatsoever stays HTTP `200` and top-level
      `status: "ok"`. HTTP status remains owned by database and migrations alone.
- [ ] The loader reads the snapshot and composes; it never starts, stops or retimes the poller, and
      never fetches a quote.
- [ ] No timestamps and no counts in the response. Detailed diagnosis stays in the logs, in
      `price_poll` / `price_backfill`, and on **Settings → Prices**.
- [ ] Do not claim whether a quote failure belongs to the proxy or to Yahoo — the worker protocol
      collapses both into `502`/`504` and the app cannot tell them apart.

## Tests

The point of the pure module is that most of this needs no database and no timers.

- [ ] **Table-driven over `pricingHealth`**, covering every value of all three closed sets and the
      `ok` conjunction: no snapshot; armed and not yet due; four minutes late; **exactly
      `minutes + 5` late, which is not overdue**; a millisecond later, which is; a tick running and
      not late; **a tick running and late, which must be `overdue`, not `running`**; a retimed
      cadence changing when `overdue` begins.
      And for quotes: no observation; market closed; zero instruments; all priced; some priced; none
      priced with a positive request; `providerFailed`; error.
- [ ] Against the real poller, the cases the pure module cannot see: a `busy` run leaves the previous
      observation intact; a tick dropped by the running guard changes neither `running` nor the
      previous observation; a market-closed tick whose backfill then fails still reports
      `market_closed`; a market-closed tick that then finds the lock held still reports
      `market_closed`; `requestRefresh` updates the snapshot — its one production caller is
      `app/routes/upload/review.tsx:65` — while a direct `POST /refresh` (`app/routes/refresh.ts:17`,
      which calls `runRefresh` itself) does not; `stopPricePoller` makes the next read
      `not_started`.
- [ ] Route tests pin the whole body with `toEqual` and cover `ok: true` and `ok: false` for at least
      one cause each of worker, scheduler and quotes — while asserting the HTTP status did not move.
- [ ] Route tests read a process-wide slot in a serial suite (`fileParallelism` off). A poller armed
      by an earlier file would make `scheduler` non-deterministic — stop it in the fixture, the way
      `tests/framework-wiring.test.ts:22-25` already does.
- [ ] `tests/price-poller.test.ts` fakes `Date` globally at `:122`, `:231`, `:303`, `:333` and `:365`.
      Decide once whether those stay as they are and the new tests use the injected `now`, and say so
      in a comment; do not leave two conventions in one file unexplained.

## Documents

- [ ] `ARCHITECTURE.md`: the poller slot is the status owner, the scope is one process, and the
      snapshot resets on restart or HMR disposal. Add the Appendix A row for
      `app/lib/price-health.ts` — Appendix A maps every module (`CLAUDE.md`).
- [ ] `docs/operating.md`: what each category means for an operator and what it does not prove.
      Say plainly that a fresh container reports `on_schedule` / `not_attempted` / `ok: true` for up
      to one cadence — `on_schedule` means armed and not late, and `quotes` beside it says whether
      anything has run — and that a weekend reports `market_closed` / `ok: true`. Neither should page
      anyone.
      Say that `partial` is usually one bad ticker and is answered on **Settings → Prices**, while
      `failed` with `worker: available` is a pipeline fault.
- [ ] `docs/runbook.md`: start each pricing symptom from the JSON categories, then use Compose state
      and the existing log stems to locate the fault. `overdue` on a live process now means either
      the timer stopped firing or a tick has not returned — both, and how to tell them apart from the
      log.
- [ ] A dated addendum to `docs/research/2026-09-07-price-fetch-coordination-audit.md` pointing at the
      shipped contract; preserve the original as a snapshot rather than rewriting it.
