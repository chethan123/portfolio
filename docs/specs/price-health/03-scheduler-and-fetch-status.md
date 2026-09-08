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
- `{ status: "busy" }` is `pg_try_advisory_lock` returning false (`prices.server.ts:48-50`): no body
  ran, so no provider outcome was observed.

**No change to the pricing path is required.** Everything below reads values that already exist.

## One state owner

- [ ] Extend `PollerState`. Do not add a second global, a singleton table, a second timer, or a query
      of `price_poll`.
- [ ] `lastTickStartedAt: Date` — stamped when a tick gets **past** the `if (state.running) return;`
      guard at `:53`, and when the timer is armed. This is what `overdue` is measured from. Stamp it
      for every tick, including `requestRefresh`'s: the field means *pricing work last began in this
      process*, and 0021 records why gating it to scheduled ticks would be worse.
- [ ] `lastObservation: TickObservation | undefined` — the last tick that saw a provider outcome, or
      `undefined` before any has.
- [ ] `completedATick: boolean` — set in the tick's `finally`. It is the only thing separating
      `waiting` from `on_schedule`, and a `busy` tick did complete even though it wrote no
      observation.
- [ ] **Fold the two `setInterval` call sites into one `arm(state, minutes)`.** `retime` (`:42-49`)
      and `startPricePoller` (`:125`) currently duplicate the same four lines. `arm` sets the handle,
      calls `unref?.()`, sets `minutes`, and stamps `lastTickStartedAt` — whatever arms the timer
      stamps the phase it armed, so a cadence change resets the clock the way replacing the interval
      resets its phase. Keep `retime`'s identity guard at `:43` ahead of the call.
- [ ] Record the observation inside the tick like this, and no other way:
      `market_closed` is written **at the moment the market-hours decision is made** (`:61`), before
      any provider or database work, so a later backfill failure in the same tick cannot rewrite it;
      a `done` run with `report.quotes !== null` overwrites it with the quoted observation; a `done`
      run with `report.quotes === null` leaves it (that is the market-closed case, already recorded);
      `error` writes the error observation; **`busy` writes nothing**; and the tick's own outer catch
      (`:84-85`) writes the error observation. Commit the pending observation, `completedATick` and
      `running = false` together in the `finally`.
- [ ] A state-bookkeeping failure must not reject a page render, and must not turn a completed price
      transaction into a reported failure.
- [ ] Export one reader that copies values out. No timer handle, no provider, no `Date` the caller
      could mutate into the slot, no raw error, no symbol, no count.

## The pure module

`app/lib/price-health.ts` — plain `.ts`, no `.server`, no database, no request. This is where the
whole state table lives, so that testing it needs no Postgres, no fake timers and no `globalThis`
(`CLAUDE.md`, "Pure domain … every awkward CSV is a fixture").

```ts
export type WorkerReachability = "available" | "unavailable";
export type SchedulerStatus = "not_started" | "waiting" | "running" | "on_schedule" | "overdue";
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
      completedATick: boolean;
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
      `!completedATick` → `waiting`;
      otherwise `on_schedule`.
- [ ] **`overdue` is tested before `running`, deliberately.** `state.running` is cleared only in the
      tick's `finally` (`price-poller.server.ts:87`) and nothing else clears it, and the tick is not
      bounded: `ask` has 15/35-second budgets but the cadence read and the whole price transaction do
      not, and `server/db.ts:29` sets `connectionTimeoutMillis` only — no `statement_timeout`, no
      `query_timeout`. A tick that never returns would otherwise report `running` forever. Put that
      reason in the code as a comment; it is the one ordering a later reader would "simplify" away.
- [ ] `quotes`: no snapshot or no observation → `not_attempted`; `market_closed` → `market_closed`;
      `error` → `unknown`; and for `quoted`: `providerFailed` → `failed`; `requested === 0` → `ok`;
      `priced === requested` → `ok`; `priced === 0` → `failed`; otherwise `partial`.
      The zero-instrument case is `ok`, not a category of its own — a separate value would report
      household shape and answers no question about pipeline health.
- [ ] `ok` is one conjunction, not an ordered clause list:
      `worker === "available"`, and `scheduler` in `{ waiting, running, on_schedule }`, and `quotes`
      in `{ not_attempted, market_closed, ok }`. Exhaustive by construction.
- [ ] `now` is a parameter. Nothing in this module reads a clock, a config, or a global.

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
      `ok` conjunction: no snapshot; armed and not yet due; exactly at the due instant; four minutes
      late; five minutes late; a tick running and not late; **a tick running and late, which must be
      `overdue`, not `running`**; a completed tick; a retimed cadence changing when `overdue` begins.
      And for quotes: no observation; market closed; zero instruments; all priced; some priced; none
      priced with a positive request; `providerFailed`; error.
- [ ] Against the real poller, the cases the pure module cannot see: a `busy` run leaves the previous
      observation intact; a tick dropped by the running guard changes neither `running` nor the
      previous observation; a market-closed tick whose backfill then fails still reports
      `market_closed`; `requestRefresh` updates the snapshot; a direct `POST /refresh` does not;
      `stopPricePoller` makes the next read `not_started`.
- [ ] Route tests pin the whole body with `toEqual` and cover `ok: true` and `ok: false` for at least
      one cause each of worker, scheduler and quotes — while asserting the HTTP status did not move.
- [ ] `tests/price-poller.test.ts` fakes `Date` globally at `:122`, `:231`, `:303`, `:333` and `:365`.
      Decide once whether those stay as they are and the new tests use the injected `now`, and say so
      in a comment; do not leave two conventions in one file unexplained.

## Documents

- [ ] `ARCHITECTURE.md`: the poller slot is the status owner, the scope is one process, and the
      snapshot resets on restart or HMR disposal.
- [ ] `docs/operating.md`: what each category means for an operator and what it does not prove.
      Say plainly that a fresh container reports `waiting` / `not_attempted` / `ok: true` for up to
      one cadence, and a weekend reports `market_closed` / `ok: true` — neither should page anyone.
      Say that `partial` is usually one bad ticker and is answered on **Settings → Prices**, while
      `failed` with `worker: available` is a pipeline fault.
- [ ] `docs/runbook.md`: start each pricing symptom from the JSON categories, then use Compose state
      and the existing log stems to locate the fault. `overdue` on a live process now means either
      the timer stopped firing or a tick has not returned — both, and how to tell them apart from the
      log.
- [ ] A dated addendum to `docs/research/2026-09-07-price-fetch-coordination-audit.md` pointing at the
      shipped contract; preserve the original as a snapshot rather than rewriting it.
