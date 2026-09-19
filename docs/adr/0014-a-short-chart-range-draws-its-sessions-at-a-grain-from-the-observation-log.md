# A short chart range draws its sessions at a grain from the observation log

A 1W line was eight finished-day closes, two of them a weekend. Every chart range but 1D reads the
daily spine through `holding_valued_at`, one close per date, and `sampleWindow` already samples
every calendar day for any span under its budget (ADR-0003), so there was no denser line to be had
from that tier. The observation log holds every distinct provider instant since it was introduced
(ADR-0006), read by 1D alone and for the latest session alone. ADR-0006 recorded drawing an older
session as deferred and named the costs. We are now paying two of them, for the ranges short enough
to show a session's shape, and leaving the third where it was.

A chart range whose span is at most 92 days is drawn at a **grain**: a step on the market clock
inside each session, set by the span. 15 minutes for a span of at most 7 days, an hour for at most
31, three hours for at most 92; the daily line, unchanged, beyond that. The rule is the span, so
YTD and a custom range earn the grain of their length and the presets fall out of it. 1D is
untouched: every observation, no grain.

Inside such a window, a session that has observations contributes its grid instants from the log
alone, valued at the position set in force on that date. A date with none, the weekends, holidays,
days the app was down and dates before the log began, contributes the spine's close, exactly what
the daily line draws, placed at that date's session end on the market clock. The window's first
date contributes its close only, so the line starts where the change figure beside the headline
reads. A grid instant nothing was observed for is not a point, so an outage is a straight bridge and
never a flat run. Each session ends on its last observation, so its last point is its close. The
reader is a series reader of totals per instant in `valuation.server.ts` beside the 1D reader, not a
migration-defined sibling of `holding_valued_at`. Spec 0022 has the definitions.

## Considered options

**A point budget with thinning**, in the spirit of ADR-0003: draw every poll and thin uniformly
when a window holds more than the budget. Rejected. At the seeded cadence a 3M window is about
1,900 polls; under the 180-date budget that is three points a session, barely the daily line, and
a larger budget only moves the threshold. A tiered grain is the "arbitrary thresholds" ADR-0003
turned down for dates, and it is the right call here for the reason it was wrong there: a reader
of a 3M line wants one consistent step through every day, not a step that widens toward the far
end, and the three steps are the ones every charting convention already uses.

**The poll as the grid.** One point per `price_poll` row, so the line's resolution is literally
the refresh cadence. Rejected: it ties the point count to a dial the household sets for a storage
reason (ADR-0006), so a one-minute cadence makes a 1W line 2,100 points, and it collapses to the
same thing as a wall-clock grain at the seeded cadence anyway. The grain is a step on the clock;
a poll coarser than it leaves one point per poll on its own, since an instant with no observation
in its step is not drawn.

**A covered session's instants plus the spine's close for the same date.** Rejected. Two tiers
answering one date on one line is the disagreement ADR-0006's invariant exists to prevent: the
spine's close for a day is rewritten by later polls and by no backfill, the log's last observation
is what was struck, and they need not agree to the cent. A covered session comes from the log
alone; a date's close is drawn only where the log has nothing to say, so no dated valuation is
ever computed from an observation and `holding_valued_at` keeps reading `price_daily` alone.

**Bridging a gap with flat points**, as 1D's running total would if fed a grid. Rejected: a flat
run inside a session reads as a quiet market, which is the wrong story for a server that was down.
The instants inside the gap are skipped and the line runs straight, which 1D already draws and
which reads as "no data here". Marking the gap is the same silence as a partially priced date
(issue #216) and belongs to one design for both.

**Today's positions across the window**, the 1D shortcut (DESIGN §14, limitation 2). Rejected:
1D holds them constant for one session, where the drift is visible only as a change figure that
disagrees with the line's start. Across a quarter it would make the line disagree with the daily
line it replaces wherever a statement landed inside the window. An instant is valued at the position
set in force on its market date, stepping at the open of that day, as the daily line steps on that
date.

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
- The grained reader's cost is plotted instants × holdings, two primary-key probes each. The grain
  bounds the instants, so the refresh cadence does not move the cost; a 3M window on the measured
  household is of the order of 25,000 pairs. The figure is measured and recorded in ARCHITECTURE
  §10, with the running-total rewrite spec 0016 uses named as the fallback if it measures slow.
- A chart point now has a kind. A grained line carries finished-day points among instants, and the
  readout must know which is which, so `ChartPoint` carries a `dated` flag and the axis a `grained`
  one. A consumer that infers the kind from the string's shape is wrong, as the type's comment
  already said.
- The invariant that a past date's valuation never reads an observation has a third reader to hold
  it against, and holds by construction: the grained reader values a date from the spine or a
  session from the log, never one day from both.
- The mutual-fund caveat ADR-0006 accepted applies to every grained range: a fund strikes one NAV
  after the close, so a fund-heavy line steps once a day at every grain. A household whose feed
  instruments are all funds gets a line that is, in effect, the daily one placed at the NAV's hour.
- The date sampler is untouched for spans over 92 days, and 1D is untouched. Nothing about the
  refresh, the poller, the tables or the indexes changes: the log already carries `market_date`
  and an index on it for exactly this read.
