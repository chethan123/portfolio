# 02 — The grained series reader in `valuation.server.ts`

_Part of [0022-chart-grain.md](../0022-chart-grain.md)._

**What to build:** One new reader beside `readSessionSeries` in `app/lib/valuation.server.ts`:
`readGrainedSeries(db, window, narrowing)`, wrapped by `netWorthGrainedSeries(filter, window)` and
`accountGrainedSeries(accountId, window)`, taking
`window: { dates: IsoDate[]; grainMinutes: number; timeZone: string }` and returning
`SessionPoint[]` with a new optional `dated: true` on the finished-day points, whose `at` is then
the calendar date. One SQL statement per window, measured on the harness before it is wired. Its
definitions are spec 0022's "The reader is one statement", and they are the contract; the CTE
shape there is the way to meet it.

This is the instant-parameterised reader ADR-0006 deferred, built as a series reader of totals
rather than a migration-defined sibling of `holding_valued_at`, so ADR-0001's row-type contract
stays at two objects (ADR-0014).

**Blocked by:** Nothing. It takes plain arguments and imports no type from `chart-range.ts`.
Ticket 04 wires it in.

**Status:** ready-for-agent

**Read first:** `app/lib/valuation.server.ts` lines 340–555 (`readSeries`, `SessionPoint`,
`latestObservedSession`, `readSessionSeries` and its two wrappers, and the `ownedBy`/`isAccount`
helpers at 238–247); `migrations/0006_annual_dividend.sql` lines 68–127 for `holding_valued_at`;
`migrations/0009_price_observation.sql`; spec 0022 in full; spec 0016 "The span's bounds" for the
planner trap; `docs/research/2026-09-01-overview-1d-latency.md` and the `harness/README.md`
beside it; `tests/dashboard-queries.test.ts` "the 1D series" for how the 1D reader is tested and
`tests/support/fixtures.ts` for `seedObservation` (pass `marketDate` every time), `seedDailyClose`,
`seedPositionSet`, `seedAccount` (`closedAt`).

**Measure first**

- [ ] On the throwaway Postgres, build the harness shape: `scale-shape.sql`, then
      `scale-observations.sql -v days=92` (it already seeds that many weekday sessions; read its
      header for the cadence variable). Write the spec's statement as `harness/grained.sql` on the
      pattern of `session-rewrite.sql` (its `\if :{?prefix}` for `explain (analyze, buffers)`),
      parameterised by a date array, a grain and a zone, and run it for the last 92 days at 180 and
      the last 7 days at 15
- [ ] Record both wall times and confirm the plan: index scans on `price_observation_market_date_idx`
      inside the `instants` lateral, `price_observation_pkey` and `price_daily_pkey` inside the
      per-holding lateral, no sequential scan of `price_observation`. Put the figures and the plan
      shape in the pull request description and in `docs/research/README.md`'s entry for the
      latency note, for ticket 05 to carry into `ARCHITECTURE.md` §10
- [ ] If the 92-day figure is above 500 ms, stop here and report it with the plan; the rewrite
      (spec 0016's running total partitioned by day) is a decision for the person driving the
      slice, not a step of this ticket

**The contract, restated as checks**

- [ ] `dates` empty returns `[]` without a query
- [ ] The window's first day (`dates[0]`) contributes exactly one point, dated, valued as
      `holding_valued_at(d)` aggregated the way `readSeries` aggregates it, even when that day has
      observations
- [ ] Every other day with no observation under its `market_date` contributes one dated point on
      the same terms
- [ ] Every other day with observations contributes one point per step of the grain from that
      day's midnight on the market clock, at the last observation with that `market_date` whose
      `as_of` lies in `[start, start + grain)`, from the whole log; a step with none contributes
      nothing
- [ ] An instant's holdings are `holding` rows at `latest_position_set(a.id, d)` for accounts with
      `closed_at is null or closed_at > d`; a holding's price is its instrument's latest observation
      with `as_of <= t` from any date, else the last `price_daily` close with `date < d`, else null
- [ ] `amount` sums per-holding `cast(quantity * price as numeric(20, 4))`, coalesced to `0`;
      `known` counts priced holdings; `total` counts holdings via `count(h.id)` over a LEFT JOIN so
      an instant with no held rows scores `0`
- [ ] The household reader narrows the dated branch on `v.owner_id` inside the `holding_valued_at`
      lateral and the instant branch on `a.owner_id` in the holdings CTE, both from `ownedBy`; the
      account reader on `v.account_id` and `a.id` from `isAccount`; an off filter is `true` on both.
      Never a `where` on `instant_points` or `dated_points` themselves
- [ ] Rows come back ordered by day then instant; an instant's `at` is stringified with
      `toISOString()`, a dated row's `at` is its `day` text; `known`/`total` through `Number`,
      `amount` untouched; `dated: true` is set on dated rows and the key is absent on instants
- [ ] `grainMinutes` is passed with an explicit `::int` cast everywhere it appears (`1440 / g - 1`,
      `make_interval(mins => g * k)`, `make_interval(mins => g)`) and `timeZone` as text; nothing is
      computed in JavaScript from a money or date value
- [ ] No session-clock literal (`09:30`, `16:00`) appears in the reader; steps run from midnight
- [ ] The reader's header says it is the instants × holdings shape spec 0016 retired for 1D,
      bounded here by the grain rather than the cadence, and names the running total as the
      fallback with its cost (every observation of a held instrument in the window)
- [ ] The module header's claim, "the only thing that values from `price_observation`", stays true:
      this reader is in this module

**Tests (new `tests/grained-series.test.ts`, `withDatabase`, `afterAll(closeTestDatabase)`)**

Fixed zone `America/New_York` in every window; instants asserted as the exact ISO strings that
were seeded; every `seedObservation` passes `marketDate`. Seed with the builders only.

- [ ] Values a step's point at each holding's latest observation at or before it, and an instrument
      unobserved that day at its close strictly before the day (two instruments, one observed)
- [ ] Reports the window's first day as its close alone, `dated: true` with `at` the date, even
      with observations that day, and the amount equals `netWorthAt(ALL_OWNERS, d)` to the character
- [ ] Reports a Saturday and a Sunday as dated points carrying Friday's close
- [ ] Contributes nothing for a step with no observation, so an outage inside a session leaves no
      point between the observation before and the one after
- [ ] Plots one point, at the NAV's instant, for a day whose only observation is an evening NAV
      (`marketDate` passed explicitly)
- [ ] The mixed day: two equities observed through the day and a fund's NAV at 18:00; the last
      point before 18:00 carries yesterday's NAV, the 18:00 point today's, and no holding is
      counted twice
- [ ] A full-array `toEqual` across Friday's instants, Saturday, Sunday and Monday's instants, in
      that order, dated days as dates among instants
- [ ] A day observed only for an instrument nobody holds still yields points, valued at the held
      instruments' closes strictly before the day
- [ ] Uses the position set in force on the point's day: a statement dated mid-window changes the
      quantities from that day's points on and not before
- [ ] Counts an account closed inside the window (`seedAccount({ closedAt })`) on the days it was
      open, the way `holding_valued_at` does
- [ ] Groups `10:59` and `11:01` into two points and `10:59` and `10:58` into one at grain 60;
      `09:31` and `11:59` into one at grain 180; 27 observations at 15-minute spacing into 27
      points at grain 15
- [ ] Lays step boundaries on the market clock: the same wall-clock pair groups the same way in
      July (`04:00Z` midnight) and January (`05:00Z` midnight)
- [ ] Scores `total: 0` for a day before the first position set on both branches
- [ ] Narrows by owner on both branches (`netWorthGrainedSeries` with a one-owner filter) and by
      account (`accountGrainedSeries`), at an instant and at a dated point
- [ ] Returns `[]` for `dates: []`
- [ ] `tests/invariants/aggregates-agree.test.ts` gains the pair: a grained line's dated point on a
      date equals `netWorthAt` on that date, `amount` and coverage alike

**Done when** the measurement is recorded, `npm run typecheck` and
`npx vitest run tests/grained-series.test.ts tests/invariants/aggregates-agree.test.ts` are green,
and `npx vitest run tests/dashboard-queries.test.ts tests/holdings-at.test.ts` still pass.
