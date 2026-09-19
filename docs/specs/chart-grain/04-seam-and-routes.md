# 04 — The seam picks the grained reader, and the routes prove it

_Part of [0022-chart-grain.md](../0022-chart-grain.md)._

**What to build:** The one branch in `app/lib/chart-series.server.ts` that reaches the grained
reader off `resolved.grain`, `dated` carried through onto `ChartPoint`, one comparison in
`app/routes/overview.tsx`, and the route tests that pin the wiring on both surfaces, including the
two existing tests this slice makes false.

**Blocked by:** [01](01-grain-by-span.md), [02](02-grained-series-reader.md),
[03](03-instants-among-days.md).

**Status:** ready-for-agent

**Read first:** `app/lib/chart-series.server.ts` in full; `app/routes/overview.tsx` lines 66–142
and `app/routes/account.tsx` lines 73–152; `tests/chart-series.test.ts`;
`tests/routes/overview.test.ts` "the 1D range on the Overview" (`:793` on) and the two tests at
`:864-875` and `:928-951`; `tests/routes/account.test.ts` "the 1D range on an account";
spec 0022 "The seam picks the reader", "One comparison in the Overview changes", "Tests this
change makes false".

**The seam**

- [ ] `readPoints` reaches `netWorthGrainedSeries` / `accountGrainedSeries` when
      `resolved.session === undefined && resolved.grain !== undefined`, with
      `{ dates: resolved.dates, grainMinutes: resolved.grain, timeZone: getConfig().MARKET_TIMEZONE }`;
      the session branch stays first, the dated branch last
- [ ] `getConfig` is imported from `../../server/config.ts` as the routes import it, with a comment:
      the steps must be cut on the clock the poller stamps `market_date` with
- [ ] `chartSeries` maps `dated` through: `{ date: point.at, amount: point.amount, dated: true }`
      when set, no key otherwise, so existing `toEqual` assertions on dated windows and sessions
      do not change
- [ ] The module header's list of readers this file is the only caller of gains the two new names
- [ ] `tests/chart-series.test.ts` "the window decides the reader" gains a third window on the same
      seed: `{ range: "1w", since: "2026-06-04", dates: ["2026-06-04", "2026-06-05"], grain: 15 }`
      answers `[{ date: "2026-06-04", amount: "1000.0000", dated: true }, { date: "2026-06-05T13:30:00.000Z", amount: "1500.0000" }]`;
      assert with `toEqual` on the whole array

**The Overview**

- [ ] The manual-prefix rule becomes `first === undefined || point.date < dayOf(first, controls.session)`
      with `first` the first computed point, keeping today's `undefined` guard that leaves the
      whole reachable prefix when nothing is computed, with a comment: on a grained window the
      first computed point may be an instant, and §7 rule 2 (computed wins on an overlapping date)
      is a rule about days. Nothing else in the loader changes; `account.tsx` does not change

**The routes' tests**

- [ ] `overview.test.ts:864-875`: asserts `session` `toBeNull()` on `?range=1y` and
      `toEqual({ timeZone: "America/New_York", grained: true })` on `?range=1m`; the 1D assertion
      is unchanged
- [ ] `overview.test.ts:928-951`: rewritten against `?range=1y`, where seeding observations on
      `daysAgo(1)` still leaves the line unchanged, with its comment saying that a range of at most
      92 days now reads the log by design (spec 0022)
- [ ] `overview.test.ts:493-512` on `?range=3m` seeds no observation, so every computed point is
      still a dated `YYYY-MM-DD`; it is left alone
- [ ] Overview `?range=1w` with the existing `seedSession(ctx, daysAgo(1), daysAgo(2))` helper
      (every observation already passes `marketDate`): `session` is the grained shape; `computed`
      is exactly, in order, `daysAgo(2)` dated at `10000.0000` (days before it score `total: 0` on
      the dated branch and are dropped, since the helper's only position set is dated
      `daysAgo(2)`), `daysAgo(1)`'s three observation instants at `10100.0000`, `10400.0000` and
      `11000.0000`, and `daysAgo(0)` dated at `11000.0000`; assert dated points by `dated` and
      `date`, instants by their seeded ISO strings, never a `Z` string derived from `daysAgo` for a
      dated point
- [ ] Overview `?range=1w` with a hand-typed point dated the first computed day and one dated
      before it: the first is dropped, the second is in `manual`; `manualWithheld` is unchanged
- [ ] Account page `?range=1w`: the same `session` shape, and `computed` narrowed to that account
- [ ] Every existing 1D and dated test in both files passes unchanged, other than the two named

**Done when** `npm run typecheck`, `npm test` and `npm run build` are green.
