# 01 — The grain a span earns, in `chart-range.ts`

_Part of [0022-chart-grain.md](../0022-chart-grain.md)._

**What to build:** Three additions to the pure chart time vocabulary in `app/lib/chart-range.ts`,
and nothing outside it. A `GrainMinutes` type and `grainFor(spanDays)` that maps a window's span in
whole days to `15`, `60`, `180` or `undefined`. A `grain?: GrainMinutes` on `RangeWindow`, set by
`sampleWindow` from the span it already computes, so every path through `resolveRange` but 1D
carries it when the span is at most 92 days. A `grained?: true` on `SessionAxis` and a
`dated?: true` on `ChartPoint`, and `chartWindow` reporting `controls.session` as
`{ timeZone, grained: true }` on a grained window. The module stays pure and stays out of
`.server`: both routes re-read it after hydration.

The value of doing it first and alone is that the grain rule is then one function with a table of
three thresholds, tested against the presets' own widths on the worst dates of the year, before any
reader depends on it.

**Blocked by:** Nothing. It touches no database and no component.

**Status:** ready-for-agent

**Read first:** `app/lib/chart-range.ts` in full; `tests/chart-range.test.ts` for the style and the
helpers (`spanOf`, `daysBefore`); spec 0022 "The grain is a function of the span".

**The rule**

- [ ] `export type GrainMinutes = 15 | 60 | 180`
- [ ] `export function grainFor(spanDays: number): GrainMinutes | undefined` returns `15` for a
      span of at most 7 days, `60` for at most 31, `180` for at most 92, `undefined` beyond. The
      thresholds live in one table beside the function with a comment saying they are where the
      presets' widths land (`FIXED_BOUNDARY`: 1W exactly 7, 1M at most 31, 3M at most 92), never
      three literals inside three `if`s
- [ ] `spanDays` is the same `Math.round((end - start) / DAY_MS)` `sampleWindow` computes; a span
      of `0` (YTD on 1 January, a one-day custom span) is `15`

**The window**

- [ ] `interface Window` gains `grain?: GrainMinutes`; `sampleWindow` sets it from `grainFor` and
      leaves the key absent, not `undefined`, when there is none, so `toEqual` on an existing
      window shape does not change
- [ ] `RangeWindow` therefore carries it for the fixed presets, `custom` and `all` alike, off span
      alone; the 1D branch of `resolveRange` never sets it
- [ ] The comment on `RangeWindow.session` ("its presence, not a separate flag") is extended to
      `grain` in the same words, and the module header names spec 0022 beside 0015 and 0009
- [ ] `dates` is unchanged: every calendar day, ascending, both ends included, for any span that
      has a grain (every such span fits `SAMPLE_BUDGET`)

**The axis and the point**

- [ ] `SessionAxis` gains `grained?: true`, with a comment: present on a grained window, several
      sessions on one line, so ticks name days and a dated point reads out with no time
- [ ] `ChartPoint` gains `dated?: true`, with a comment: a grained line's finished-day point, placed
      at its date's session end and read out as a date alone; its `date` is then a full ISO instant
      like every other point on that line. The existing comment refusing to infer the kind from the
      string's shape stays and now has a reason to
- [ ] `chartWindow` sets `controls.session` to `{ timeZone }` when `resolved.session` is defined,
      to `{ timeZone, grained: true }` when `resolved.grain` is defined, and `null` otherwise, in
      that order

**Tests (`tests/chart-range.test.ts`)**

- [ ] `grainFor`: 7 → 15, 8 → 60, 31 → 60, 32 → 180, 92 → 180, 93 → undefined, 0 → 15
- [ ] Every preset lands in its tier on the worst date: 1W on any today is 15; 1M with today
      `2026-08-31` (31 days back to `2026-07-31`) is 60; 3M with today `2026-10-29` (92 days back to
      `2026-07-29`) is 180; 1Y, 5Y and All (with an earliest date years back) carry no grain
- [ ] 1D carries a session and no grain; 1D falling back to the default carries neither
- [ ] A custom span of 14 days is 60; a custom span of 100 days has none; YTD with today
      `2026-02-10` is 180 and with today `2026-01-01` is 15
- [ ] A grained window's `dates` are still every calendar day, both ends included
- [ ] `chartWindow` on `?range=1w` reports `session: { timeZone, grained: true }`; on `?range=1d`
      with a session, `{ timeZone }` with no `grained` key; on `?range=1y`, `null`
- [ ] Every existing test in the file still passes unchanged; if one has to change, say why in
      the commit message

**Done when** `npm run typecheck` and `npx vitest run tests/chart-range.test.ts` are green, and
nothing outside `app/lib/chart-range.ts` and its test file changed.
