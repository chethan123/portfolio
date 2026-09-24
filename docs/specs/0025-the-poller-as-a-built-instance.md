# 0025 — The poller as a built instance, not module functions over a `globalThis` bag

_Candidate 2.3 of [the second architecture review](../research/2026-09-24-architecture-review.md)
(card 3 of its [visual companion](../research/2026-09-24-architecture-review/report.html)).
Line numbers below were read at `91216ad`._

**What to build:** `app/lib/price-poller.server.ts` keeps its state in a plain object on a
`globalThis` slot (`Symbol.for("portfolio.pricePoller")`), and every export begins by reading that
slot. The slot is deliberate — a module-scope binding does not survive Vite's HMR invalidation
(ARCHITECTURE.md §6.2's hazards table) — the shape around it is not. `tick` (`:73`) reads five
things ambiently (`new Date()` three times across `tick` and `arm`, `getConfig()`,
`readRefreshCadence()`, `runRefresh`, `console`) and its caller discards its promise
(`void tick(...)`, `:56`, `:212`), so `tests/price-poller.test.ts` learns that a tick ended by
faking timers, patching `pool.connect`/`client.release` (`watchedPool`, `:94`), poking the symbol
(`:828`) and spying on the `provider-socket.server.ts` module (`:799`, `:822`).

Replace it with a factory, `createPricePoller(dependencies)`, returning an instance whose `tick()`
promise is the completion signal, and have `startPricePoller` build one instance and pin *that* on
the same slot. The four exports keep their signatures and contracts. This is the shape the same
slice already uses one module over: `createWorkerHealthProbe()` builds an instance whose `check(now)`
takes the clock as a parameter, and `workerHealthProbe` is the one the app calls
(`app/lib/worker-reachability.server.ts:85`, `:110`).

Worth doing on its own because it changes no behaviour anyone can observe — the `/healthz` body,
the log lines, the cadence, **Refresh now**, and the post-commit refresh are all fixed — while every
tick test stops reaching past the interface. It touches one module, its test file and two
ARCHITECTURE.md rows.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**Out of scope:** `refreshPrices`' overloads and taking `now` inside the writer (candidate 2.4 —
`prices.server.ts` and `refresh.server.ts` do not change; the poller keeps passing what it passes
today); the provider seam, `matchKey` and the probe (2.12); the health-chain trims (`WorkerReachability`
declared twice, `health-response.ts`); any change to the `/healthz` contract, a log stem, the
cadence semantics, `arm`'s timing or `isScheduledQuoteWindow`; the tracked `.orig` files;
ARCHITECTURE.md references this change does not move; the symbol reads in
`tests/framework-wiring.test.ts:180` and `tests/routes/root.test.ts:626-654`, which test the
middleware's placement, not the poller; any drive-by.

## 1. The instance

```ts
export type PricePoller = {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  requestRefresh(): Promise<void>;
  snapshot(): NonNullable<PollerSnapshot>;
};

export function createPricePoller(dependencies: {
  provider: PriceProvider;
  clock: () => Date;
  readCadence: () => Promise<number>;
  refresh: (options: { quotes: boolean }, provider: PriceProvider) => Promise<RefreshRun>;
  log?: Pick<Console, "info" | "warn" | "error">;
}): PricePoller;
```

| Member | Contract | Replaces |
|---|---|---|
| `start()` | Arms the interval at `SEEDED_CADENCE_MINUTES`, `unref`'d, and stamps `lastTickStartedAt` from `clock`. Runs no tick. | The arming half of `startPricePoller` (`:170-182`) |
| `stop()` | Clears the timer and marks the instance stopped. Final: `arm` does nothing on a stopped instance, so a tick in flight when `stop` ran cannot re-arm. | `stopPricePoller`'s `clearInterval` (`:240`) and `retime`'s identity check (`:67-70`) |
| `tick()` | One scheduled tick: quotes only inside the scheduled quote window at `clock()`. Resolves when the tick has finished, or at once when dropped because one is running. Never rejects. | `tick(state, false)` (`:56`) |
| `requestRefresh()` | The same body with quotes forced regardless of the window. Same drop, same never-rejects. | `tick(state, true)` (`:212`) |
| `snapshot()` | A defensive copy of `running`, `lastTickStartedAt` (a fresh `Date`), `minutes` and `lastObservation` (a shallow copy). | `readPollerSnapshot`'s body (`:226-231`) |

`NonNullable<PollerSnapshot>` because an instance always exists by the time one is asked; the
`undefined` arm of `PollerSnapshot` stays what `readPollerSnapshot()` returns for "no slot".
`price-health.ts` does not change.

State lives in the factory's closure: `timer`, `minutes`, `running`, `stopped`, `lastTickStartedAt`,
`lastObservation`. `provider` is no longer state — it is a dependency, passed through to `refresh`.

| Dependency | Production value (in `startPricePoller`) | Why it is a seam |
|---|---|---|
| `provider` | `provider ?? socketProvider()` | Tests that run the real `runRefresh` hand a fake one |
| `clock` | `() => new Date()` | A test fixes the instant the quote window and the stamps read |
| `readCadence` | `readRefreshCadence` | A test scripts the cadence and its failure |
| `refresh` | `runRefresh` | A test scripts `done`/`busy`/`error`/a throw, and blocks it to hold a tick open |
| `log` | `console` (the default) | A test reads the poller's own lines |

Two adapters each, no more. `getConfig().MARKET_TIMEZONE` stays read inside the tick's `try`, as
today: no test varies it, and resolving it at start would turn a configuration throw from a logged
failed tick into a poller that never started — a different line. The timer (`setInterval`) is not
a dependency: nothing in the tests needs it to fire once `tick()` can be awaited.

The tick reads the clock once at its start, as the first statement inside its `try` (where today's
stamp, `:77`, precedes `getConfig()`, `:85` — so a configuration throw still leaves the tick
stamped). That one instant is both `lastTickStartedAt` and what the quote window is checked at
(today a second `new Date()` microseconds later, `:88`). `arm(minutes)` keeps reading `clock()`
itself (today `:59`): it runs after the cadence read's database round trip, and whatever arms the
timer stamps the phase it armed (`:49-53`), so that read stays its own.

## 2. The pinning

```ts
export function startPricePoller(provider?: PriceProvider): void {
  pinPricePoller(() =>
    createPricePoller({
      provider: provider ?? socketProvider(),
      clock: () => new Date(),
      readCadence: readRefreshCadence,
      refresh: runRefresh,
    }),
  );
}

/** Exported for the test that hands it a failing build. */
export function pinPricePoller(build: () => PricePoller): void;
```

`pinPricePoller` returns if the slot is taken; otherwise, inside one `try`, in this order: calls
`build()`, calls `start()` on the result, then stores it in the slot — last, so a throw from either
leaves the slot empty, as today (`:182-184`); its `catch` logs
`Price poller did not start; prices will not refresh:` and swallows. It is exported so a test can
hand it a build that throws — today's test reaches the same failure by spying on the
`provider-socket.server.ts` module (`:822`).

Each property, one by one:

1. **Idempotent** — `pinPricePoller`'s first statement is the slot lookup; a second call never calls
   `build`, so never builds a provider (ARCHITECTURE.md §7.3's row stays true). Tests: pinning twice
   calls the second build zero times; and, under `withDatabase` with one feed instrument seeded (the
   provider is only asked when the feed is non-empty, `prices.server.ts:478`),
   `startPricePoller(first)` then `startPricePoller(second)` followed by `requestRefresh()` asks
   `first` for quotes and `second` for nothing. Spec
   price-health/01's "called twice builds one provider" (`:95`) was pinned by counting
   `socketProvider` calls through a module spy; it is now structural — the `??` runs only inside a
   build that only an empty slot calls — and the line is the evidence.
2. **Lazy provider inside the `try`** — `provider ?? socketProvider()` is inside the thunk, and the
   thunk is only called inside `pinPricePoller`'s `try`. A line to point at, plus property 3's test.
3. **Swallowed and logged** — test: `pinPricePoller(() => { throw failure })` does not throw, leaves
   `readPollerSnapshot()` `undefined`, and `console.error` received exactly
   `("Price poller did not start; prices will not refresh:", failure)`.
4. **No immediate poll** — `start()` only arms. Test: after `start()`, `refresh` was called zero
   times; and at module level, a `requestRefresh()` before `startPricePoller` is not replayed —
   `readPollerSnapshot()?.running` is `false` straight after the start (a replayed tick sets
   `running` synchronously).
5. **`unref`** — `arm` calls `unref?.()` as today. Test: `start()` leaves the count of `"Timeout"`
   entries in `process.getActiveResourcesInfo()` unchanged (Node counts only referenced timers;
   checked on Node 24.21: a referenced interval adds one, `unref()` removes it).
6. **A stopped instance cannot re-arm** — replaces `retime`'s identity check. `stopPricePoller` is the
   only thing that empties the slot, and it calls `stop()` first, so "no longer in the slot" and
   "stopped" are the same set of instances in production — including after HMR, whose `dispose`
   hook still calls `stopPricePoller` (`:245-247`). The check has to move onto the instance: a slot
   comparison would stop every instance a test builds from re-arming at all. Test: a tick whose
   cadence read resolves after `stop()` leaves `snapshot().minutes` at 15.
7. **Seeded cadence corrected by the first tick** — `SEEDED_CADENCE_MINUTES = 15`, in step with
   `migrations/0008_refresh_cadence.sql`'s `default 15`; the tick compares `readCadence()` with the
   armed minutes and re-arms when they differ, as today. Test: `readCadence` answering 60 makes
   `snapshot().minutes` 60 after one `await tick()`, and `lastTickStartedAt` the tick's instant.

## 3. The three concurrency guards

| Guard | Where after | Test |
|---|---|---|
| The serialising flag: a tick that arrives while one runs is dropped, never queued (§7.2 "Two poller ticks in one process") | `running` in the factory's closure; the tick body's first statement | A `refresh` blocked on a deferred: a second `tick()` and a `requestRefresh()` each resolve while the first is still pending, `refresh` was called once, and the snapshot shows `running: true` with the previous observation untouched |
| The advisory lock (§7.2 "Two refreshes anywhere") | `withRefreshLock` in `prices.server.ts`, reached through `runRefresh`, untouched | `tests/refresh.test.ts`'s "answers busy while a second session holds the advisory lock" (untouched); the poller's handling of `busy` by a scripted `refresh` |
| A stopped instance cannot arm | `stopped` in the closure, checked in `arm` | §2 property 6 |

## 4. The two module-level contracts, unchanged

- **`requestRefresh(): void`** — reads the slot; if empty, logs the "never started" line (§6) and
  returns; otherwise `void poller.requestRefresh()`. Never rejects because the instance method never
  does. Dropped silently while a tick runs (the instance's flag). Quotes forced. The one production
  caller, `app/routes/upload/review.tsx:141`, calls it after the commit and discards nothing it used.
- **`readPollerSnapshot(): PollerSnapshot`** — `slot?.snapshot()`: `undefined` with no slot, never
  starts the poller, a copy otherwise. The one production caller, `app/routes/healthz.ts:17`, passes
  it to `healthzResponse` unchanged; `pricing.scheduler` and `pricing.quotes` derive from the same
  four fields.
- **`stopPricePoller(): void`** — `slot?.stop()`, then delete the slot. The HMR `dispose` hook is
  unchanged.

## 5. What `tick()` resolves and rejects with

Resolves `undefined`; never rejects. The body is one `try`/`catch`/`finally`; the only statements
before the `try` are the `running` check, setting it, and declaring `pending`. Every dependency call
— `clock`,
`getConfig`, `readCadence` (with its own `.catch`), `refresh`, `log` — is inside the `try`, whose
`catch` logs `Price refresh failed; last known prices are kept:` and records an `error` observation,
and whose `finally` clears `running` and commits the observation. The only way out as a rejection
would be the `catch`'s own `log.error` throwing, which `console.error` does not. So the timer calls
`void tick()`, `requestRefresh()` at module level calls `void poller.requestRefresh()`, and a test
calls `await poller.tick()`: the same promise, awaited or not.

## 6. The log lines, byte for byte

Unchanged in text and level; the poller's own go through `log`, the two module-level ones through
`console`, because no instance exists to carry a `log` when they are written:

| Line | Level | From |
|---|---|---|
| `` `Price refresh: ${priced} of ${requested} priced, ${stale} stale, ${closes} closes written, ${observed} new.` `` | `warn` if `stale > 0`, else `info` | the tick, when quotes were asked and the run was `done` |
| `` `Price backfill: ${attempted} attempted, ${written} closes written, ${failed} failed.` `` plus `" The batch itself failed; see the line above."` when `batchFailed` | `warn` if `failed > 0` or `batchFailed`, else `info`; silent when `attempted === 0` and not `batchFailed` | the tick, on a `done` run |
| `Price refresh failed; last known prices are kept:` + error | `error` | the tick's `catch` (and, untouched, `runRefresh`'s own) |
| `Refresh cadence could not be read; keeping the current one:` + error | `error` | the tick's cadence read |
| `Price poller did not start; prices will not refresh:` + error | `error` | `pinPricePoller`'s `catch` |
| `A refresh was requested before the price poller started in this process; it was dropped, and a later tick will do the work.` | `info` | `requestRefresh()` with no slot |

New pins: `Price refresh: 1 of 1 priced, 0 stale, 1 closes written, 1 new.` at `info` and a stale
variant at `warn` (nothing pins the stem today), and the "never started" line at `info`. The
`Price backfill` pin (`tests/price-poller.test.ts:486`) moves to a scripted report with the same
expected string.

## 7. The test plan for `tests/price-poller.test.ts`

Through the factory, with a fixed or advanced `clock`, a scripted `refresh`, a scripted `readCadence`
and a capturing `log`, awaiting `tick()`/`requestRefresh()`. Helpers: `pollerWith(overrides)` (the
defaults: a `fakeProvider()`, a clock at `TRADING_HOUR`, `readCadence` answering 15, a `refresh`
answering an empty `done`, a capturing `log`), `deferred()`, and a `done(...)` report builder.
`deferred()` is a local copy of the helper `tests/masking-browser.test.ts:146` also keeps locally;
lifting both into `tests/support/` would touch a file this change has no business in. Likewise
`done(...)` restates `BackfillReport`'s six-key `outcomes` map, which `prices.server.ts:274-285`
builds in the unexported `emptyBackfillReport`; exporting it would change a file this spec keeps
fixed.

**Rewritten onto `await poller.tick()`, no database** (the tick's own rules; `refresh` scripted):

- the running guard (§3), for a scheduled tick and for `requestRefresh()`
- quotes asked inside the window, not at `WEEKEND`, and forced by `requestRefresh()` at `WEEKEND`
  (replaces "runs quotes regardless of the calendar", `:314`)
- properties 4, 5, 6, 7 of §2, and a failed cadence read keeping the armed minutes with its line
- the snapshot: stamped synchronously by every tick (`:567`); `quoted` from a `done` run;
  `market_closed` kept at `WEEKEND` when the backfill batch then fails (`:717`, now a scripted
  `batchFailed` report) and when `refresh` answers `busy` (`:760`); a `busy` tick leaves the previous
  observation (`:673`); `error` from an `error` run and from a thrown `refresh`, with its line and
  `running` back to `false`; a returned snapshot mutated by its reader leaves the next one unchanged
- the log lines of §6 (`:426`, `:455` rewritten; the `Price refresh` pins added)

**Kept on a real database, through the factory with the real `runRefresh`** — the connection-poisoning
rule in `withRefreshLock` is a genuine pool property and stays tested here (`:150`, `:176`, `:201`).
`watchedPool` goes: the pool is a plain `createPool(TEST_DATABASE_URL)` passed to `withDb`, observed
through pg-pool's own `release` event (public API; `pg-pool` 3.14 `index.js:389` emits it
synchronously inside `client.release(err)`, with the `true` that `withRefreshLock` passes when it
destroys, `prices.server.ts:64`) and its `totalCount`/`idleCount`, read after `await poller.tick()` —
no patched `connect` or `release`, no handback waiting. Not `remove`: it fires from `client.end`'s
callback, an I/O turn after the tick has settled (`index.js:172-187`).

- destroyed when the refresh throws: one `release` with `err === true`, `totalCount` 0
- handed back intact when the provider failed: one `release` with a falsy `err`, `idleCount` 1
- spent at `WEEKEND` on the backfill, no quote asked, no `price_poll` row

**Kept at module level** (the pinning and the two contracts): pinning twice builds once; a throwing
build is swallowed and logged (property 3); a build whose `start()` throws leaves the slot empty,
because the slot is written last; stopped reads `not_started` (`:600`); `requestRefresh()`
before start logs its line and is not replayed (`:376`); `requestRefresh()` reaches the pinned poller
— the first one started, not a second — with quotes forced, while `POST /refresh` leaves the snapshot
alone (`:609`) — real database, and the one test that still waits by bounded polling (`waitFor`),
because the module-level `requestRefresh()` returns `void` by contract.

**Deleted:** `watchedPool`, `tickFinished`, `runTicks`, `controllableProvider`, `refusingInsertInto`,
`REFRESH_ADVISORY_LOCK_KEY`, the `providerSocketModule` import and both tests that spied on it
(`:793`, `:813` — replaced by properties 1 and 3), and the two tests that held a real advisory lock
(`:673`, `:760` — the lock itself is `tests/refresh.test.ts`'s).

None of `vi.useFakeTimers`, `vi.setSystemTime`, `vi.spyOn` on a module, a patched pool, or
`Symbol.for("portfolio.pricePoller")` remains in the file. `console` is captured only for the two
module-level lines.

**The other files' hooks stay.** The review (§2.3, "Tests") expected them and the `finally` calls to go;
the `finally` calls shrink to the module-level tests, the only ones left that pin; the hooks do not
go. `tests/framework-wiring.test.ts:24`, `tests/routes/root.test.ts:75`,
`tests/routes/healthz.test.ts:38` and `tests/routes/settings-passkeys.test.ts:78` call
`stopPricePoller` after each test because the root middleware (or the test) arms the process-wide
instance with a live, if `unref`'d, timer and the real provider; in a serial suite the next file
would otherwise read `pricing.scheduler` off a poller it did not start. This change leaves that
exactly as it is, so none can go.

## 8. Documentation this change moves

- `app/lib/price-poller.server.ts`'s header: the slot now holds one built instance; the rest stands.
- ARCHITECTURE.md Appendix A, the `price-poller.server.ts` row (`:2391`): the slot holds the one
  pinned instance built by `createPricePoller`; `lastTickStartedAt` and `lastObservation` are the
  instance's, read out by its `snapshot()` through `readPollerSnapshot`.
- ARCHITECTURE.md §7.3, the `startPricePoller()` row (`:1803`): still a property lookup on
  `globalThis`; name what it looks up (the pinned instance).

Nothing else: §6.2's hazards (`:1491-1493`), §7.2 (`:1762-1763`), §4.2 (`:392`), §7.4 (`:1825`) and
§11.2 (`:2316`) stay true as written, and the rows naming `startPricePoller` as the provider's
default site (`:2385`, `:2390`) stay true because the default stays there.

## 9. Differential validation

The poller writes only through `refreshPrices`: `quote`, `price_daily`, `price_observation`,
`price_poll` (and the backfill ledger `price_backfill`, compared too). Run one script on a checkout of
`origin/main` (a `git worktree`) and on this branch, then diff. The script is a vitest file in the
scratchpad, copied into `tests/` of each checkout for the run and deleted after; it uses only the
four module exports, which both sides share.

1. `withDatabase` seeds: two feed instruments (`VTI`, `BND`), one account holding both from
   `2024-03-29` (a backfill candidate), cadence left at the seeded 15.
2. `vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: new Date("2026-06-04T14:00:00Z") })`
   — both sides read `new Date()` in production, so faking `Date` is the one clock both obey. A
   scripted `PriceProvider`: `getQuotes` answers fixed quotes for both symbols (fixed `fetchedAt`),
   `getDailyCloses` answers two fixed closes; a switch makes `getQuotes` throw for one tick.
3. `startPricePoller(provider)`; snapshot. Then, each step followed by waiting (real `setTimeout`
   polling, bounded by iteration count, not `Date.now()`) until `readPollerSnapshot()?.running` is
   `false`, then recording the snapshot and the `/healthz` loader's body (`pricing` only):
   - advance 15 min (inside the window);
   - provider switched to throw; advance 15 min; switch back;
   - `vi.setSystemTime("2026-06-04T21:00:00Z")` (after the close), `requestRefresh()`;
   - advance 15 min (outside the window);
   - `vi.setSystemTime("2026-06-05T14:00:00Z")` (the next session), then advance 15 min with the
     tick scoped to a database that refuses an insert into `price_poll` (`withDb` over a
     plugin-wrapped `db`, the advance before the body's first `await` as
     `tests/price-poller.test.ts:739-747` does, so the timer's callback runs inside that frame) —
     inside the window, so `writePoll` runs and fails, and `runRefresh` logs
     `Price refresh failed; last known prices are kept:` (`refresh.server.ts:74`) and answers
     `error`. The tick's own `catch` with the same line is reached only by a throwing `refresh`,
     covered by §7's scripted test. Refusing
     `price_backfill` would not do: `refreshPrices` catches a backfill failure itself.
4. Record every `console.info`/`warn`/`error` line as `level: first argument` plus the error's
   `message`. Dump the five tables ordered by every column but `id`, dropping the two identity `id`s
   (`price_poll`, `price_backfill`). No other column needs dropping: none of the five has a
   `created_at` or a `now()` default; every timestamp is written from `new Date()` under the faked
   clock or from the scripted provider.
5. Write `{ snapshots, healthz, logs, tables }` as JSON; `diff` main's against the branch's. Any
   difference is a defect unless this section predicted it. It predicts none.

In the running app (`npm run dev` on `seed-demo` data, real `socketProvider()`, cadence set to one
minute in Settings): `/healthz` reads `not_started` before the first request and `running` or
`on_schedule` after it; one `Price refresh` or failure line per tick; **Refresh now** logs as before;
an upload commit adds one line and no timer; after an edit under `app/lib/` triggers HMR, the next
cadences still produce one line per tick, not two.

## Acceptance

**The instance**

- [ ] `createPricePoller` and `PricePoller` are exported from `app/lib/price-poller.server.ts` with
      the members and dependencies of §1, and no others
- [ ] `PollerState`, `PollerHost`'s bag of fields, `arm`/`retime`/`tick` as module functions taking a
      state, and `logBackfill` taking no `log` are gone; the slot holds a `PricePoller`
- [ ] `tick()` and `requestRefresh()` never reject: no dependency is called outside the body's `try`
- [ ] The tick reads the clock once, first inside its `try`; `arm` reads it once per arming
- [ ] `price-health.ts`, `prices.server.ts`, `refresh.server.ts`, `app/root.tsx`,
      `app/routes/healthz.ts` and `app/routes/upload/review.tsx` are unchanged

**The pinning and the contracts**

- [ ] `startPricePoller(provider?)`, `requestRefresh()`, `readPollerSnapshot()` and
      `stopPricePoller()` keep their signatures
- [ ] Each of §2's seven properties has the test or line §2 names
- [ ] Every log line of §6 is byte-identical to `main`, at the same level

**The tests**

- [ ] `tests/price-poller.test.ts` contains no `useFakeTimers`, `setSystemTime`, module `spyOn`,
      patched pool method, or `Symbol.for`
- [ ] The `Price refresh` and "never started" pins exist and pass
- [ ] The four other files' `stopPricePoller` hooks are unchanged
- [ ] `npm run typecheck`, `npm test` and `npm run build` pass

**The docs and the proof**

- [ ] The header and the two ARCHITECTURE.md rows of §8 are updated; nothing else in it moves
- [ ] §9's differential shows no difference; the running-app checks hold, HMR included

## Review findings rejected

Grounding review, round 1:

- **Drop `log`; capture `console` for every line, as `tests/worker-reachability.test.ts:208` does.**
  Rejected. `log?` is part of the shape this candidate was approved with, and it has two adapters:
  the factory tests — nearly all of them — read the poller's lines off their own instance without
  patching a process global, so a line from an unrelated module never lands in an assertion. The
  two module-level lines stay on `console` because no instance exists when they are written.
- **Drop the `pinPricePoller` export and the swallow test; leave the `try` as the line to point at.**
  Rejected. A throw escaping `startPricePoller` is a refused request on every path, `/healthz`
  included (`app/root.tsx:184`); that is the one property here whose failure is loud enough to earn
  a test, and today's test for it is a module spy. One exported function is the cost.
- **ARCHITECTURE.md `:2385` names `refreshPrices`' provider default, which is `runRefresh`'s.**
  True, pre-existing, and a reference this change does not move; left.

Grounding review, round 2: nothing material; its minor findings (line numbers, `now` typed as a
`Date`, which catch the §9 failure reaches, the `done(...)` copy) are folded in. Its finding that
passing the tick's start instant to `arm` would stamp a re-armed phase a cadence read early is taken
the conservative way: `arm` keeps its own clock read.

Code review (2026-09-24), findings not taken:

- **Move the tick's stamp below `getConfig()` survives every test** (a configuration throw would
  leave the tick unstamped). Accepted as a line to point at: `getConfig()` is ambient by §1's
  decision and cannot be made to throw through the seams.
- **The timer callback without `void` survives every test and the typecheck.** Harmless: `run`
  never rejects (§5), and nothing fires the timer in the tests by design.
- **`capturedLog()` has one caller.** Kept: its name says what `pollerWith`'s `log` is.
- **`fakeProvider`/`brokenProvider` near-copy `tests/refresh-quotes.test.ts`'s.** Pre-existing in
  this file; not this change's.

Pull request review (2026-09-24, Codex), taken — none changes what production does, where the pinned
instance is always started before any tick and its clock never throws:

- The pre-start `lastTickStartedAt` placeholder no longer reads the injected clock, so a scripted
  clock's first instant is `start()`'s.
- A tick re-arms only a running schedule: on a factory instance never started, a moved cadence arms
  nothing (§2 property 7 is about the started poller).
- `arm` reads the clock before installing the interval, so a throwing clock cannot leave an interval
  nothing holds.
- The module-level `/refresh` test seeds its feed instrument after the route call, so the route's
  default socket provider is never dialled.
