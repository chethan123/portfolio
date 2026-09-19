# 03 — The chart gives each day its width, names days, and times only an instant

_Part of [0022-chart-grain.md](../0022-chart-grain.md)._

**What to build:** Four changes to `app/components/net-worth-chart.tsx` so a line that mixes
instants and finished-day points reads right: a per-day scale when the axis is grained, ticks that
name days, a readout that carries a time only for an instant, and an empty note that falls through
for a grained window. Plus two exports from `app/lib/market-hours.ts`. No new prop; the chart reads
`session.grained` and `point.dated`, and calls `dayOf`, which ticket 01 adds.

**Blocked by:** [01](01-grain-by-span.md), for `SessionAxis.grained`, `ChartPoint.dated` and
`dayOf`.

**Status:** ready-for-agent

**Read first:** `app/components/net-worth-chart.tsx` in full; `tests/net-worth-chart.test.tsx`,
especially "the time axis" and "an intra-session line (ADR-0006)" for how a scale and a session
axis are asserted; `app/lib/market-hours.ts` for `marketDateOf`/`marketTimeOf` and the two session
constants; spec 0022 "The chart gives each day its width"; ADR-0004 for why every readout is
pre-rendered.

**The session's edges**

- [ ] `market-hours.ts` exports `SESSION_OPENS` and `SESSION_CLOSES` (market-local minutes from
      midnight, as they are). One comment: the chart lays a day's session across its slot with
      them; they are the regular session, not the holiday calendar, so the header's trust rule is
      untouched

**The scale**

- [ ] `buildScale(points, session)` takes the axis. Without a grain it is the wall-time scale it is
      today, unchanged; 1D and the daily line do not move
- [ ] With `session.grained`, a point's position is `dayIndex + fraction`: `dayIndex` is calendar
      days from the earliest `dayOf(point, session)` among the points to the point's own (UTC
      arithmetic on `YYYY-MM-DD`, as `chart-range.ts` does it); `fraction` is `1` for a dated point
      and for a hand-typed point, and for an instant `(minutes − SESSION_OPENS) / (SESSION_CLOSES −
      SESSION_OPENS)` from `marketTimeOf`, clamped to `[0, 1]`. Positions are normalised from their
      minimum to their maximum across `WIDTH`, as times are today; a flat position range is centred
- [ ] `Scale` keeps `x: (date: string) => number` for the polyline, area, marker and hit targets,
      so none of them change; a hand-typed point on a grained axis is a date and `x` places it by
      that date, at its slot's right edge
- [ ] The scale exposes what `tickLabel` needs to name the day at a fraction of the axis (the
      earliest day and the position range are enough)

**Ticks**

- [ ] `tickLabel` names the time of day only when `session !== null && !session.grained`
- [ ] On a grained axis the three ticks name the day at the left edge, the middle and the right
      edge, read off the scale's day positions, with `MONTHS` as now; the `withDay` rule is moot
      there (a grained span is under 180 days) and unchanged elsewhere

**Readouts**

- [ ] `readoutDate` takes the point and the session; the day is `dayOf(point, session)`; the time
      is appended only with a session and only for a point that is not dated
- [ ] The `aria-label`'s "ending on …" clause uses the same function, so a line ending on a dated
      point names the date alone
- [ ] Masking is untouched: the time still joins the date, never the amount

**The empty note**

- [ ] `ChartEmptyNote` renders the "two observed moments" sentence only when
      `session !== null && !session.grained && moments > 0`; a grained window with fewer than two
      points renders `children`

**What must not change**

- [ ] `hitTargets`, `toPolyline`, `toArea`, the marker and the gradient are untouched
- [ ] The file stays one of the two allowed to call a money formatter
      (`tests/masking-boundary.test.ts`), with no new call site

**Tests (`tests/net-worth-chart.test.tsx`, `renderToStaticMarkup` and `toContain`, as the file does)**

A grained fixture: `session: { timeZone: "America/New_York", grained: true }`, three days: day one
a dated point (`date: "2026-06-04", dated: true`), day two instants at `2026-06-05T13:31:00Z`,
`2026-06-05T16:00:00Z` and `2026-06-05T20:00:03Z`, day three a dated point (`"2026-06-06"`).

- [ ] Gives two days the same width whatever their points: the dated day-one point sits at the
      left edge, the day-three point at the right edge, and day two's instants between one third
      and two thirds of the box
- [ ] Places an instant inside its day by its time in the session: `13:31Z` (09:31 New York) just
      right of day two's left edge, `20:00:03Z` (16:00:03) at its right edge, and a `23:30Z` NAV
      (19:30) also at its right edge
- [ ] Names its ticks by day, not by time of day, on a grained axis
- [ ] Puts the time beside the date in an instant's readout and no time in a dated point's
- [ ] Dates an evening NAV on the market clock: a point at `2026-06-05T23:30:00Z` reads `5 Jun 2026`
- [ ] Describes a line ending on a dated point without a time in its `aria-label`
- [ ] Masks a grained line's amounts exactly as every other range's
- [ ] `<ChartEmptyNote>` renders the caller's fallback for a grained session with one moment
- [ ] "places a point by its date, not by its position in the array" still holds with no grain
- [ ] Every existing test still passes unchanged

**Done when** `npm run typecheck`, `npx vitest run tests/net-worth-chart.test.tsx tests/market-hours.test.ts`
and `npx vitest run tests/masking-boundary.test.ts tests/routes/masked-screens.test.tsx` are green.
