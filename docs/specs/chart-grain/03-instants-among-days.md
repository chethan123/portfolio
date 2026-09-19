# 03 — The chart names days and times only an instant

_Part of [0022-chart-grain.md](../0022-chart-grain.md)._

**What to build:** Three changes to `app/components/net-worth-chart.tsx` so a line that mixes
instants and finished-day points reads right: ticks name days on a grained axis, a readout carries a
time only for an instant, and the empty note falls through for a grained window. No new prop; the
chart reads `session.grained` and `point.dated`, which ticket 01 adds to the types.

**Blocked by:** [01](01-grain-by-span.md), for `SessionAxis.grained` and `ChartPoint.dated`.

**Status:** ready-for-agent

**Read first:** `app/components/net-worth-chart.tsx` in full; `tests/net-worth-chart.test.tsx`,
especially "an intra-session line (ADR-0006)" for how a session axis is asserted;
`app/lib/market-hours.ts` for `marketDateOf`/`marketTimeOf`; spec 0022 "The chart names days and
times a point only when it is an instant"; ADR-0004 for why every readout is pre-rendered.

**Ticks**

- [ ] `tickLabel` names the time of day only when `session !== null && !session.grained`
- [ ] On a grained axis the day comes from `marketDateOf(new Date(ms), session.timeZone)`, not
      `isoDate(ms)`, with a comment: a tick late in a New York evening must not be dated tomorrow.
      The `withDay` rule (day under 180 days of span, month beyond) is unchanged

**Readouts**

- [ ] `readoutDate` takes the point (or the point's `dated` flag) beside the session; with a
      session it dates the point with `marketDateOf` as now and appends the time unless the point is
      dated; without a session it is unchanged
- [ ] The `aria-label`'s "ending on …" clause uses the same function, so a line ending on a dated
      point names the date alone
- [ ] Masking is untouched: the time still joins the date, never the amount

**The empty note**

- [ ] `ChartEmptyNote` renders the "two observed moments" sentence only when
      `session !== null && !session.grained && moments > 0`; a grained window with fewer than two
      points renders `children`

**What must not change**

- [ ] `buildScale`, `hitTargets`, `toPolyline`, `toArea`, the marker and the gradient are untouched:
      every point on a grained line is a full instant and `Date.parse` places it
- [ ] The file stays one of the two allowed to call a money formatter
      (`tests/masking-boundary.test.ts`), with no new call site

**Tests (`tests/net-worth-chart.test.tsx`, `renderToStaticMarkup` and `toContain`, as the file does)**

A grained fixture: `session: { timeZone: "America/New_York", grained: true }`, four points across
two days, two of them dated at `T20:00:00.000Z` (16:00 New York in summer), two instants at
`T13:30:00Z` and `T14:30:00Z`.

- [ ] Names its ticks by day, not by time of day, on a grained axis
- [ ] Puts the time beside the date in an instant's readout and no time in a dated point's
- [ ] Dates a dated point on the market clock: a point at `2026-06-05T20:00:00.000Z` reads
      `5 Jun 2026`, and one at `2026-06-05T23:30:00.000Z` (an evening NAV) still reads `5 Jun 2026`
- [ ] Places a dated point by its instant, so its guide sits between the instants around it and not
      at the day's midnight
- [ ] Describes a line ending on a dated point without a time in its `aria-label`
- [ ] Masks a grained line's amounts exactly as every other range's
- [ ] `<ChartEmptyNote>` renders the caller's fallback for a grained session with one moment
- [ ] Every existing test still passes unchanged

**Done when** `npm run typecheck`, `npx vitest run tests/net-worth-chart.test.tsx` and
`npx vitest run tests/masking-boundary.test.ts tests/routes/masked-screens.test.tsx` are green.
