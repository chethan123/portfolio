# A short chart range draws its sessions at a grain from the observation log

A 1W line was eight finished-day closes, two of them a weekend. Every chart range but 1D reads the
daily spine through `holding_valued_at`, one close per date, and `sampleWindow` already samples
every calendar day for any span under its budget (ADR-0003), so there was no denser line to be had
from that tier. The observation log holds every distinct provider instant since it was introduced
(ADR-0006), read by 1D alone and for the latest session alone. ADR-0006 recorded drawing an older
session as deferred and named three costs: an instant-parameterised reader, a second time
vocabulary in `chart-range.ts` to name an older session, and a time axis on the chart. We are now
paying the first and the third, for the ranges short enough to show a session's shape, and leaving
the second where it was.

A chart range whose span is at most 92 days is drawn at a **grain**: a step on the market clock
inside each day, set by the span. 15 minutes for a span of at most 7 days, an hour for at most 31,
three hours for at most 92; the daily line, unchanged, beyond that. The rule is the span, so YTD
and a custom range earn the grain of their length and the presets fall out of it. 1D is untouched:
every observation, no grain.

Inside such a window, a day that has observations contributes one point per step, the last
observation in the step, valued at the position set in force on that date and at each holding's
latest observation at or before that instant. A day with none, the weekends, holidays, days the app
was down and dates before the log began, contributes the spine's close, exactly what the daily line
draws, as a calendar date. The window's first date contributes its close only, whether or not the
log covers it, so the line starts where the change figure beside the headline reads; it is the one
day the spine answers for a logged day, on purpose. A step nothing was observed in is not a point,
so an outage is a straight bridge and never a flat run. The chart gives every calendar day after
the first the same width and lays a day's session across its slot; the first day contributes only
its close, at the left edge. The reader is a series reader of totals per point
in `valuation.server.ts` beside the 1D reader, not a migration-defined sibling of
`holding_valued_at`. Spec 0022 has the definitions.

## Considered options

**A point budget with thinning**, in the spirit of ADR-0003: draw every poll and thin uniformly
when a window holds more than the budget. Rejected. At the seeded cadence a 3M window is about
1,900 polls; under the 180-date budget that is three points a session, barely the daily line, and
a larger budget only moves the threshold. A tiered grain is the "arbitrary thresholds" ADR-0003
turned down for dates, and it is the right call here for the reason it was wrong there: a reader
of a 3M line wants one consistent step through every day, not a step that widens toward the far
end, and the three steps are the ones every charting convention already uses.

**The poll as the grid.** One point per `price_poll` row, so the line's point count is literally
the refresh cadence. Rejected: it ties the count to a dial the household sets for a storage reason
(ADR-0006), so a one-minute cadence makes a 1W line 2,100 points, and it collapses to the same
thing as a wall-clock step at the seeded cadence anyway. The grain is a step on the clock; a poll
coarser than it leaves one point per poll on its own, since a step with no observation is not
drawn.

**A grid of round-clock instants, each valued at the latest observation before it, with the
session's last observation added as a separate point.** Rejected in review. The poller runs on an
arbitrary phase, so the observation that makes a grid instant count is minutes before it, and at a
coarse cadence a readout would name a time up to an hour after the price was struck; the end point
existed only to put the close back on a line whose grid had stepped past it. A step's point is its
last observation, at that observation's own instant, so every readout time is true and the close
print and the evening NAV fall into steps of their own. The cost is that a day's points are not
evenly spaced in x, which at the seeded cadence is a minute's worth.

**A covered day's instants plus the spine's close for the same date.** Rejected. Two tiers
answering one date on one line is the disagreement ADR-0006's invariant exists to prevent: the
spine's close for a day is rewritten by later polls and by no backfill, the log's last observation
is what was struck, and they need not agree to the cent. A covered day comes from the log alone; a
date's close is drawn only where the log has nothing to say, so no dated valuation is ever
computed from an observation and `holding_valued_at` keeps reading `price_daily` alone. The
window's first day is the one exception, above, and it is the spine answering alone, not both.

**Bridging a gap with flat points**, as 1D's running total would if fed a grid. Rejected: a flat
run inside a session reads as a quiet market, which is the wrong story for a server that was down.
The steps inside the gap are skipped and the line runs straight, which 1D already draws and which
reads as "no data here". Marking the gap is the same silence as a partially priced date
(issue #216) and belongs to one design for both.

**Today's positions across the window**, the 1D shortcut (DESIGN §14, limitation 2). Rejected:
1D holds them constant for one session, where the drift is visible only as a change figure that
disagrees with the line's start. Across a quarter it would make the line disagree with the daily
line it replaces wherever a statement landed inside the window. An instant is valued at the position
set in force on its market date, stepping at that day's first point, as the daily line steps on
that date.

**A wall-time axis for the grained line**, the axis every range has today. Rejected in review, on
arithmetic. A session is six and a half of twenty-four hours, so at wall time a 1W window gives
each session 3.9% of the width, 39 px of the 1000 px box on a desktop and about 13 px on a phone;
1M gives it 0.9% and 3M 0.3%. Points inside a 9 px session are a vertical tick, not a shape, and
the two coarser tiers would be paid for and invisible. On a grained line every calendar day is a
slot of equal width and a day's session runs from the slot's left edge to its right; a finished-day
point sits at the right edge. A weekend keeps its two slots, so a window that reaches before the
log began draws its daily part at the daily line's spacing, and the overnight is the width of a
slot boundary rather than two thirds of a day. 1D and the daily line keep the wall-time axis.

**A migration-defined `holding_valued_at_instant(t)`**, the shape ADR-0006 named. Rejected for the
reason ARCHITECTURE §6.3 gives for the 1D reader: a third object returning the view's row type is
bound by ADR-0001's contract for no gain, since the chart reads totals per instant and never a
holding's row.

## Consequences

- ADR-0006's "past-navigable intraday is deferred, not obligated" is revised in part. The
  instant-parameterised reader and the day-and-hour chart exist. Choosing an older session *as
  1D* is still deferred, and still costs a second time vocabulary in `chart-range.ts` and a
  control to pick the day.
- DESIGN §14 limitation 13 shrinks to that, and limitation 2's "holds today's positions constant"
  becomes a statement about 1D alone.
- The grained reader is the instants × holdings shape spec 0016 retired for 1D, taken back on
  purpose: the grain bounds the instants, at most 27 a session at 15 minutes and 3 at three hours,
  one more with an evening NAV, so the refresh cadence does not move the cost, which the 1D running
  total's would (it reads every observation of a held instrument in the window). A 3M window on a
  harness-sized household is of the order of 20,000 (instant, holding) pairs, one primary-key
  probe each in the common case; the review measured the statement at about 110 ms for 3M and
  65 ms for 1W on that shape, and found that deciding which days are observed by probing the log
  per day rather than reading the steps already computed is planned as a sequential scan and
  costs half a second, so the reader defines "observed" once. The figure is measured again before
  the reader is wired and recorded in ARCHITECTURE §10; the running total partitioned by day is the
  named fallback if it measures slow.
- A chart point now has a kind. A grained line carries finished-day points, whose `date` is a
  calendar date, among instants, and the readout and the axis must know which is which, so
  `ChartPoint` carries a `dated` flag and the axis a `grained` one. A consumer that infers the kind
  from the string's shape is wrong, as the type's comment already said.
- The pre-rendered readout (ADR-0004) is bounded on a grained range by the grain tiers, about 140
  points at 1W, 185 at 1M and 225 at 3M, rather than by ADR-0003's 180-date budget. Nothing in the
  chart assumes the smaller number; ADR-0004 carries a note.
- A hand-typed point on a grained axis is a calendar date among instants, and the chart flags it
  as one before it places or reads it out; a bare date run through the market clock comes back a
  day early.
- The invariant that a past date's valuation never reads an observation has a third reader to hold
  it against, and holds by construction: the grained reader values a date from the spine or a day
  from the log, never one day from both.
- The mutual-fund caveat ADR-0006 accepted applies to every grained range: a fund strikes one NAV
  after the close, so a fund-heavy line steps once a day at every grain. A household whose feed
  instruments are all funds gets a line that is, in effect, the daily one placed at the NAV's hour.
  And because a fund's evening NAV is filed under the day it was struck when the next morning's
  poll fetches it, a day the app was down all session still counts as observed when a fund is
  held: its one point prices the equities from their last observation, which agrees with the daily
  line unless a later head-gap backfill filled that day's closes. That is the 1D rule over more
  days; accepted, not fixed.
- A step's point is its observation, so the points of a day are not evenly spaced and a readout's
  time is the time the price was struck.
- The date sampler is untouched for spans over 92 days, and 1D is untouched. Nothing about the
  refresh, the poller, the tables or the indexes changes: the log already carries `market_date`
  and an index on it for exactly this read.
