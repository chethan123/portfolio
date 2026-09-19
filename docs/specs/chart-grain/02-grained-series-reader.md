# 02 — The grained series reader in `valuation.server.ts`

_Part of [0022-chart-grain.md](../0022-chart-grain.md)._

**What to build:** One new reader beside `readSessionSeries` in `app/lib/valuation.server.ts`:
`readGrainedSeries(db, window, narrowing)`, wrapped by `netWorthGrainedSeries(filter, window)` and
`accountGrainedSeries(accountId, window)`, taking
`window: { dates: IsoDate[]; grainMinutes: number; timeZone: string }` and returning
`SessionPoint[]` with a new optional `dated: true` on the finished-day points. One SQL statement per
window. Its definitions are spec 0022's "The reader is one statement", and they are the contract;
the CTE shape there is the way to meet it.

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
planner trap; `tests/dashboard-queries.test.ts` "the 1D series" for how the 1D reader is tested and
`tests/support/fixtures.ts` for `seedObservation`, `seedDailyClose`, `seedPositionSet`.

**The contract, restated as checks**

- [ ] `dates` empty returns `[]` without a query
- [ ] The window's first day (`dates[0]`) contributes exactly one point, dated, valued as
      `holding_valued_at(d)` aggregated the way `readSeries` aggregates it, at
      `(d + time '16:00') at time zone ${timeZone}`, even when that day has observations
- [ ] Every other day with no observation under its `market_date` contributes one dated point on
      the same terms
- [ ] Every other day with observations contributes its grid instants
      `(d + time '09:30') at time zone ${timeZone} + k × grain` for `k` from `0` while at or before
      `16:00`, each only when an observation with that `market_date` has `as_of` in
      `(t − grain, t]`, plus the day's `max(as_of)` when it is later than the last such grid instant
- [ ] An instant's holdings are `holding` rows at `latest_position_set(a.id, d)` for accounts with
      `closed_at is null or closed_at > d`; a holding's price is its instrument's latest observation
      with `as_of <= t` from any date, else the last `price_daily` close with `date < d`, else null
- [ ] `amount` sums per-holding `cast(quantity * price as numeric(20, 4))`, coalesced to `0`;
      `known` counts priced holdings; `total` counts holdings via `count(h.id)` over a LEFT JOIN so
      an instant with no held rows scores `0`
- [ ] The household reader narrows the dated branch on `v.owner_id` inside the `holding_valued_at`
      lateral and the instant branch on `a.owner_id` in the holdings CTE, both from `ownedBy`; the
      account reader on `v.account_id` and `a.id` from `isAccount`; an off filter is `true` on both
- [ ] Rows come back ascending by `at`; `at` is stringified with `toISOString()`, `known`/`total`
      through `Number`, `amount` untouched; `dated: true` is set on dated rows and the key is absent
      on instants
- [ ] The two session-clock literals (`09:30`, `16:00`) carry a comment naming
      `app/lib/market-hours.ts`'s `SESSION_OPENS`/`SESSION_CLOSES` and saying why the calendar there
      is not consulted: which days are sessions comes from the log
- [ ] `grainMinutes` is passed as an `int` parameter and `timeZone` as text; `generate_series(0,
      390 / grain)` and `make_interval(mins => …)` do the arithmetic; nothing is computed in
      JavaScript from a money or date value
- [ ] The module header's claim, "the only thing that values from `price_observation`", stays true:
      this reader is in this module

**Measure it**

- [ ] Build the harness shape (`docs/research/2026-09-01-overview-1d-latency/harness/scale-shape.sql`
      and `scale-observations.sql`, read their headers) on the throwaway Postgres, extended to five
      sessions of observations if the harness seeds one, and time the statement for a 92-day
      window at grain 180 and a 7-day window at grain 15 with `EXPLAIN (ANALYZE, BUFFERS)`. Record
      both figures and the plan's shape (index scans on `price_observation_pkey` and
      `price_daily_pkey` inside the lateral; no seq scan of `price_observation`) in the ticket's
      pull request and hand them to ticket 05 for `ARCHITECTURE.md` §10
- [ ] If the 92-day figure is above 500 ms, rewrite the instant branch as spec 0016's running total
      partitioned by day, with the per-day span bounds as correlated predicates in a lateral (never
      a joined one-row CTE), and re-measure; the checks above are what the rewrite is verified
      against

**Tests (new `tests/grained-series.test.ts`, `withDatabase`, `afterAll(closeTestDatabase)`)**

Fixed zone `America/New_York` in every window; instants asserted as exact ISO strings. Seed with
the builders only.

- [ ] Values a grid instant at each holding's latest observation at or before it, and an instrument
      unobserved that day at its close strictly before the day (two instruments, one observed)
- [ ] Reports the window's first day as its close alone at 16:00 on the market clock, even with
      observations that day, and the amount equals `netWorthAt(ALL_OWNERS, d)` to the character
- [ ] Reports a Saturday and a Sunday as dated points carrying Friday's close
- [ ] Skips a grid instant with no observation in its step, so an outage inside a session leaves
      no point between the observation before and the one after
- [ ] Adds the session's last observation as a point when it falls after the last grid instant
      (a close print at `16:00:03`) and adds nothing when it does not
- [ ] Plots one point, at the NAV's instant, for a day whose only observation is an evening NAV
- [ ] Uses the position set in force on the instant's day: a statement dated mid-window changes the
      quantities from that day's instants on and not before
- [ ] Counts an account closed inside the window on the days it was open, the way
      `holding_valued_at` does
- [ ] Plots `09:30`, `10:30` … `15:30` at grain 60, `09:30`, `12:30`, `15:30` at grain 180, and
      27 instants at grain 15, given an observation inside every step
- [ ] Lays `09:30` on the market clock at `13:30Z` in July and `14:30Z` in January
- [ ] Scores `total: 0` for a day before the first position set on both branches
- [ ] Narrows by owner on both branches (`netWorthGrainedSeries` with a one-owner filter) and by
      account (`accountGrainedSeries`), at an instant and at a dated point
- [ ] Returns `[]` for `dates: []`
- [ ] Round-trips through `withDatabase` at every depth (`getDb()` inside the reader resolves to
      the transaction)

**Done when** `npm run typecheck` and `npx vitest run tests/grained-series.test.ts` are green,
`npx vitest run tests/dashboard-queries.test.ts tests/holdings-at.test.ts` still pass, and the
measurement is recorded.
