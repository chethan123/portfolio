# 04 — The seam picks the grained reader, and the demo has five sessions to draw

_Part of [0022-chart-grain.md](../0022-chart-grain.md)._

**What to build:** The one branch in `app/lib/chart-series.server.ts` that reaches the grained
reader off `resolved.grain`, `dated` carried through onto `ChartPoint`, the route tests that pin the
wiring on both surfaces, and `scripts/seed-demo.ts` seeding observations for the five latest
sessions instead of one so a grained 1W on the demo household has something to draw. The routes
themselves do not change.

**Blocked by:** [01](01-grain-by-span.md), [02](02-grained-series-reader.md),
[03](03-instants-among-days.md).

**Status:** ready-for-agent

**Read first:** `app/lib/chart-series.server.ts` in full; `app/routes/overview.tsx` lines 66–142
and `app/routes/account.tsx` lines 73–152 (read only; nothing there changes);
`tests/chart-series.test.ts`; `tests/routes/overview.test.ts` "the 1D range on the Overview" and
`tests/routes/account.test.ts` "the 1D range on an account" for the seeding and assertion style;
`scripts/seed-demo.ts` lines 395–430 (`findSession`) and 895–960 (the observation and poll
writes); spec 0022 "The seam picks the reader", "The routes do not change", "The demo seeds five
sessions".

**The seam**

- [ ] `readPoints` reaches `netWorthGrainedSeries` / `accountGrainedSeries` when
      `resolved.session === undefined && resolved.grain !== undefined`, with
      `{ dates: resolved.dates, grainMinutes: resolved.grain, timeZone: getConfig().MARKET_TIMEZONE }`;
      the session branch stays first, the dated branch last
- [ ] `getConfig` is imported from `../../server/config.ts` as the routes import it, with a comment:
      the grid must lie on the clock the poller stamps `market_date` with
- [ ] `chartSeries` maps `dated` through: `{ date: point.at, amount: point.amount, dated: true }`
      when set, no key otherwise, so existing `toEqual` assertions on dated windows and sessions
      do not change
- [ ] The module header's list of readers this file is the only caller of gains the two new names
- [ ] `tests/chart-series.test.ts` "the window decides the reader" gains a third window on the same
      seed: `{ range: "1w", since: "2026-06-04", dates: ["2026-06-04", "2026-06-05"], grain: 15 }`
      answers the first day's close flagged `dated` at `2026-06-04T20:00:00.000Z` for `1000.0000`
      and the observation at `2026-06-05T13:30:00.000Z` for `1500.0000`; assert with `toEqual` on
      the whole array

**The routes' tests**

- [ ] Overview `?range=1w`: `session` is `{ timeZone: "America/New_York", grained: true }`;
      `computed` holds the first day's dated close, dated closes for unobserved days, and instants
      for a seeded session, in ascending order, at the exact amounts the seed implies
- [ ] Overview `?range=1y`: `session` is `null` and `computed` is unchanged from today's assertion
- [ ] Overview with a hand-typed point older than the window's first computed point and a grained
      window that reaches it: the point is still drawn ahead of the line (`manual` holds it) and
      `manualWithheld` is unchanged
- [ ] Account page `?range=1w`: same `session` shape, and `computed` narrowed to that account
- [ ] Every existing 1D and dated test in both files passes unchanged

**The demo**

- [ ] `findSession` becomes `findSessions(priceDates, timeZone, count)` returning the latest
      `count` sessions oldest-first, each with its instants; the seed asks for five
- [ ] Each session's observations walk from the close before it to its own close
      (`walkSession`), the mutual fund one NAV per session at the session's last instant, the stale
      instrument observing nothing; `price_poll` rows are written for every session's instants
- [ ] `SESSION_SEED` still seeds the walk, and every figure the seed writes outside
      `price_observation`/`price_poll` is byte-identical to before: run the seed on a fresh
      database before and after and diff `select … from quote`, `price_daily`, `holding` and
      `position_set`
- [ ] The `written` summary the script prints counts every session's rows
- [ ] `docs/developing.md`'s description of the demo, if it says one session, says five

**Done when** `npm run typecheck`, `npm test` and `npm run build` are green, and
`node --env-file=.env ./scripts/seed-demo.ts` on a fresh database followed by `npm run dev` shows
a 1W line with instants on five sessions on the Overview and on an account page.
