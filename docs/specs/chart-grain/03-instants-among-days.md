# 03 — The chart gives each day its width, names days, and times only an instant

_Part of [0022-chart-grain.md](../0022-chart-grain.md)._

**What to build:** Five changes to `app/components/net-worth-chart.tsx` so a line that mixes
instants and finished-day points reads right: the chart flags its hand-typed points as dated, a
per-day scale when the axis is grained, ticks that name days, a readout that carries a time only
for an instant, and an empty note that falls through for a grained window. Plus two exports from
`app/lib/market-hours.ts`. No new prop; the chart reads `session.grained` and `point.dated`, and
calls `dayOf`, which ticket 01 adds.

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

**The hand-typed points**

- [ ] Where `NetWorthChart` joins `manual` and `computed` into `all` (`:222`), every hand-typed
      point is spread with `dated: true`, and that flagged array is what `buildScale` and
      `hitTargets` receive, so the scale, `dayOf` and `Readout` all see the flag. One comment: a
      hand-typed point is a calendar date, and a date through `marketDateOf` comes back a day
      early. The loader's `manual` array is not touched

**The scale**

- [ ] `buildScale(points, session: SessionAxis | null = null)` takes the axis, defaulting to
      `null` so the sixteen one-argument callers in the test file stand. Without a grain it is the
      wall-time scale it is today, unchanged; 1D and the daily line do not move
- [ ] With `session.grained`, a point's position is `dayIndex + fraction`: `dayIndex` is calendar
      days from the earliest `dayOf(point, session)` among the points to the point's own, computed
      as `Date.parse(`${day}T00:00:00Z`)` differences over `DAY_MS` (`parseIso` in `chart-range.ts`
      is private); `fraction` is `1` for a dated point and for an instant
      `(minutes − SESSION_OPENS) / (SESSION_CLOSES − SESSION_OPENS)` from `marketTimeOf`'s `HH:MM`,
      clamped to `[0, 1]`. Positions are computed once, with the flags in hand, into a
      `Map<string, number>` keyed by `point.date`, and `x(date)` is the lookup; every call site
      (`toPolyline`, `hitTargets`, `toArea`, the marker, the guide) passes a `date` from that same
      array, so the map is complete and `Scale.x` keeps its signature. Positions are normalised
      from their minimum to their maximum across `WIDTH`, as times are today; a flat position
      range is centred
- [ ] The scale exposes what `tickLabel` needs to name the day at a fraction of the axis: the
      earliest day and the position range are enough. The tick block (`:246-250`) reads those on
      a grained axis instead of interpolating `scale.time` in milliseconds

**Ticks**

- [ ] `tickLabel` names the time of day only when `session !== null && !session.grained`
- [ ] On a grained axis the three ticks name the day at the left edge, the middle and the right
      edge, read off the scale's day positions, with `MONTHS` as now; the `withDay` rule is moot
      there (a grained span is under 180 days) and unchanged elsewhere

**Readouts**

- [ ] `readoutDate` takes the point and the session, at both call sites (`:192` in `Readout` and
      `:242` in the `aria-label`'s "ending on …" clause); the day is `dayOf(point, session)`; the
      time is appended only with a session and only for a point that is not dated, so a line
      ending on a dated point names the date alone
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

- [ ] Gives every day after the first the same width: with positions `1`, `1.003`, `1.385`, `2`
      and `3` normalised across the box, the day-one point sits at the left edge, day two's `09:31`
      just right of it, day two's `12:00` at `0.19` of the width, day two's close at exactly the
      middle, and the day-three point at the right edge (the first day contributes only its close)
- [ ] Places an instant inside its day by its time in the session, so a `23:30Z` NAV (19:30 New
      York) sits at its day's right edge with the close, and a hand-typed point dated day one sits
      where the day-one dated point does
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
