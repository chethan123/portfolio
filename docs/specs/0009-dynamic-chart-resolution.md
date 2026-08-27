# Dynamic chart sample density — the trend line stops losing recent history to a fixed sample count

Canonical here. Published as [issue #73](https://github.com/chethan123/portfolio/issues/73) so an
agent can pick it up from the tracker; when the two disagree, this file wins.

See [ADR-0003](../adr/0003-anchored-geometric-chart-sampling.md) for why a geometric decay anchored
at the window's own end was chosen over the alternatives considered.

## Problem Statement

A household or an account can have real, changing net worth from the very first day it has any
priced holdings — asset prices move daily, independent of when the next statement gets uploaded.
But someone who uploads holdings and comes back a day or two later, on the default view, sees no
trend line at all: just a note saying a second dated point is needed. The line isn't missing because
the data is missing — the underlying valuation can already reprice the same holdings at any past
date — it's missing because the chart only checks twenty-five, evenly spaced dates across the
selected range, and on a range as wide as the default (one year), those twenty-five checkpoints land
roughly two weeks apart. A household one or two days old has every checkpoint but the very last one
fall before its first upload, so only one of the twenty-five checkpoints actually has anything to
show, and one point can't draw a line. The same shape of problem exists for the five-year and "All"
ranges, just less noticeably, since anyone with more than a couple of weeks of history is unaffected.

## Solution

The chart now samples finely enough to catch whatever history actually exists, for every range.
When the selected span is short enough that checking every single calendar day within it stays
within a sane budget, it does exactly that — no gaps at all. When the span is longer than that
budget allows at daily resolution (a year, five years, "All"), the chart keeps daily resolution
right next to the present and lets the spacing between checkpoints widen the further back it looks,
so a household's most recent one or two days are never squeezed between two distant checkpoints the
way they are today. A custom range that ends in the past gets the same treatment relative to its own
end date, not relative to today.

Nothing about which presets exist, their boundaries, the disabled-preset rule, or how a person picks
a range changes. The only thing that changes is which dates get checked to draw the line.

## User Stories

1. As someone who just uploaded my first statement and comes back the next day, I want to see a
   trend line with two points, so that I can tell my net worth actually moved.
2. As someone who just uploaded my first statement, viewing the default one-year range, I want the
   chart to behave the same as if I'd picked a one-week range, so that the preset I happen to be on
   doesn't hide data that exists.
3. As someone with a young account, browsing the five-year or "All" range, I want my last couple of
   days of real history to still show up as distinct points, so that switching to a longer view
   doesn't erase what a shorter view already showed me.
4. As someone with years of history, viewing the five-year or "All" range, I want the chart to still
   load and render quickly, so that a wide preset doesn't become slow just because it now considers
   more dates.
5. As someone viewing a custom range that ends last month rather than today, I want the recent end
   of *that* range to be the one sampled finely, so that the chart is dense where I actually asked to
   look, not around today.
6. As someone viewing a short preset (1W, 1M) that already showed daily granularity, I want no
   visible change, so that a view I already rely on doesn't shift under me.
7. As someone viewing the household Overview and someone viewing a single account's page, I want
   both charts to gain this improvement identically, so that the two screens don't start disagreeing
   about how finely they sample.
8. As someone whose real history already spans the entire selected range (an old account on 1W), I
   want every calendar day still checked exactly once, so that nothing about dense, short-range
   behavior regresses.
9. As a developer reading this later, I want the reason recent history is sampled more finely than
   old history written down, so that a future pass doesn't "simplify" it back to a fixed count and
   reintroduce the original bug.
10. As a developer testing this, I want the sampling logic tested as a pure function against fixed
    dates, so that the many span-length and budget-boundary cases run fast without a database.
11. As a developer testing this, I want the boundary between "every calendar day" and "geometric
    decay" behavior exercised right at the budget's edge, so that an off-by-one there doesn't
    reintroduce a sparse-sampling gap silently.
12. As a developer maintaining the valuation queries, I want the shape of what gets passed to them —
    an ordered list of ISO dates — to stay exactly the same, so that this change requires touching no
    query and no route.
13. As a developer extending the chart later, I want the sample budget to be a single named constant,
    so that adjusting chart density for long ranges is a one-line change.
14. As someone who already relies on the account or household chart today, I want the exact set of
    dates returned for a short preset (1W, 1M, 3M, most YTD spans) to be unchanged, so that this is
    additive rather than a behavior change for the common case.

## Implementation Decisions

**One pure seam, unchanged in shape.** The redesign is confined to the shared range-resolution
module's date-selection logic (the function today called `sampleWindow`). Its inputs (`since`,
`until`) and its output (an ordered, deduplicated list of ISO dates plus the unchanged `since`) stay
exactly as they are; every caller — the household and account loaders, the valuation series query,
the chart component — needs no change, because none of them depend on how many dates were chosen or
how they're spaced, only on receiving a correct, ordered list.

**Two regimes, chosen by whether the whole span fits a fixed budget.** Let `D` be the number of
calendar days between `since` and `until`, and let the budget be a single named constant (180,
chosen as large enough that a chart is never visibly grainy at any preset, small enough to bound the
query and the render).

- If `D + 1` is within the budget, every calendar day from `since` to `until` is returned, inclusive
  of both ends — this is what already happens today for every preset up to roughly six months, and
  stays byte-for-byte identical.
- If `D + 1` exceeds the budget, exactly the budget's worth of dates is returned, spaced by a
  geometric decay described below, still inclusive of both `since` and `until`.

**The geometric decay, anchored at the window's own end.** The samples are generated walking
backward from `until`. The gap between the first two samples (the one right at the anchor) is fixed
at one calendar day. Each subsequent gap is the previous one multiplied by a constant ratio greater
than one, so the gaps widen monotonically the further back the walk goes. That ratio is solved
numerically — there is no closed form for an arbitrary sample count and span — such that the sum of
all the gaps lands exactly on `since`. This is a strictly increasing function of the ratio for a
fixed sample count and day-one gap, so a bisection search converges reliably.

The anchor is `until`, not the literal current date: every fixed preset's `until` already equals
today, so behavior for 1W through All is unaffected by this distinction, but a custom range with a
past end date decays away from that end date rather than from the real clock, which is the only way
the geometric decay stays meaningful for a span that doesn't end today.

**Nothing about coverage, disabled presets, the manual/computed merge, or the account-vs-household
earliest-date rule changes.** All of that logic operates on the returned list of dates exactly as it
does today; it has no dependency on how those dates were spaced.

**No new database access.** The resolution module remains a pure, non-`.server` module — read by the
browser as well as the server, per its existing docstring — because the decision needs nothing
beyond `since`, `until`, and the budget.

## Testing Decisions

A good test here exercises the pure date-selection function directly, the same seam spec 0008
already established for this module, and stops short of the database or the chart's SVG output —
nothing about how a point becomes a pixel is touched by this change.

**What's pinned, at the pure-function seam:**

- For a span whose day-count-plus-one is within the budget, every calendar day appears exactly once,
  in ascending order, with both `since` and `until` included — covering the existing
  1W/1M/3M/YTD-in-a-short-year cases and confirming they're unchanged.
- Right at the budget boundary (a span of exactly the budget's day-count, and one day more), the
  transition between "every day" and "geometric decay" behaves correctly with no gap or duplicate at
  the seam.
- For a span exceeding the budget, the returned count equals the budget, the gap between the two
  dates nearest `until` is exactly one day, gaps increase monotonically walking backward, and the
  earliest returned date equals `since` exactly.
- A window whose `until` is in the past (a custom range) decays from that `until`, not from a fixed
  "today" — asserted by giving the function a `since`/`until` pair with `until` set to an arbitrary
  past date and confirming the same day-one-gap and monotonic-growth properties hold relative to it.
- The regression this spec exists to fix: a span whose real recorded history is only one or two
  calendar days old, sampled at every budget-eligible span length (which today's default 1Y range,
  and 5Y/All, all are) yields at least two dates falling on or after that history's start —
  reproducing the original bug's setup and confirming it no longer reproduces.

**What changes about existing tests.** The current assertions of an exact count of twenty-five dates
(and of a short span deduping down to at most eight) test behavior this spec deliberately replaces;
those specific assertions are rewritten to assert the behavior above rather than kept alongside it,
since the fixed-count behavior they pinned no longer exists. Everything else in that test file —
preset boundary math, the disabled-state rule, the per-surface data-source rule — is untouched and
stays as-is.

**No change needed at the route or component seams.** `overview.test.ts`, `account.test.ts`, and the
chart component's own tests assert behavior that doesn't depend on sample count or spacing;
confirmed by reading all three against this change before writing this spec.

## Out of Scope

- **Any new persistence: a snapshot table, a scheduled job, or any other way of recording net worth
  over time.** This spec only changes which already-computable dates get sampled from the existing
  on-demand valuation; it adds no storage, and the underlying "reprice any past date's positions"
  capability that makes this possible already exists.
- **Any change to which presets exist, their boundaries, the disabled-state rule, custom-range
  picking, or the persistence cookie.** All from spec 0008, untouched here.
- **Any change to masking.** A chart range and its sample dates are never amounts.
- **Any change to `holding_valued_at`, `netWorthSeries`, or any other valuation query.** They receive
  a same-shaped list of dates and are otherwise untouched.
- **Retuning the sample budget for any consumer beyond Overview and the account page.** There are no
  other chart consumers of this module today.
- **A UI affordance for chart density or resolution.** This is entirely a backend sampling change;
  the control surface (the eight presets plus Custom) is unchanged.

## Further Notes

**This is the direct fix for the reported symptom:** a fresh instance with one or two days of
uploaded holdings, viewed on the default one-year range, showing no trend line at all despite
genuine day-to-day price movement — traced to the fixed twenty-five-sample spacing (roughly fifteen
days apart on a one-year span) discarding every checkpoint but the most recent as "before day zero."

**See ADR-0003** for why the geometric decay from the window's end was chosen over a tiered
fixed-bucket scheme and over a closed-form curve — both genuine alternatives, both rejected for
reasons recorded there rather than here.

**Broken into two implementation tickets** under
[`docs/specs/dynamic-chart-resolution/`](dynamic-chart-resolution/): the core algorithm change
([issue #74](https://github.com/chethan123/portfolio/issues/74)), and a small follow-up correcting
spec 0008's now-superseded sampling claims
([issue #75](https://github.com/chethan123/portfolio/issues/75)).
