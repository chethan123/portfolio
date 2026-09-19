# A short chart range at a grain from the observation log

Canonical here. Decided in [ADR-0014](../adr/0014-a-short-chart-range-draws-its-sessions-at-a-grain-from-the-observation-log.md),
which records the trade-offs; this file records what to build. When the two disagree on a fact
about the code, this file wins. Tickets are in [`chart-grain/`](chart-grain/).

See [ADR-0006](../adr/0006-intraday-quotes-are-an-observation-log.md) for what an observation is
and the invariant that a past date's valuation never reads one, [ADR-0003](../adr/0003-anchored-geometric-chart-sampling.md)
for the date sampler this leaves alone, [ADR-0004](../adr/0004-pre-rendered-chart-interaction.md)
for the readout whose count this raises, [spec 0015](0015-chart-series-assembly.md) for the read
seam the line comes through, [spec 0016](0016-session-series-running-total.md) for the 1D reader
this sits beside, and `CONTEXT.md` for **grain**, the word this spec adds.

## Problem Statement

A 1W line is eight points. `sampleWindow` (`app/lib/chart-range.ts:135`) samples every calendar day
when a span fits `SAMPLE_BUDGET`, so a short range is already as dense as the date sampler can make
it; the coarseness is the tier. Every point on a range other than 1D is a finished-day close from
`price_daily`, read through `holding_valued_at(d)` as the greatest close at or before the date
(`migrations/0006_annual_dividend.sql:111-118`). Two of the eight are a weekend, carrying Friday's
close forward. The line between Monday's close and Tuesday's is a straight segment whatever the
day did.

The data to draw the day exists. Every distinct provider instant is kept forever in
`price_observation`, stamped with its `market_date` and indexed on `(market_date, as_of)`
(`migrations/0009_price_observation.sql`). Only 1D reads it, and only for the latest session:
`latestObservedSession` is `max(market_date)` (`app/lib/valuation.server.ts:406`), and
`resolveRange` turns 1D into that one session with no dates at all (`chart-range.ts:185-191`).
ADR-0006 recorded drawing an older session as "deferred, not obligated" and named three costs: an
instant-parameterised reader, a second time vocabulary in `chart-range.ts` to name an older
session, and a time axis on the chart. This spec pays the first and the third, for the ranges
short enough to show a session's shape. The second, the vocabulary and control to choose an older
session as 1D, stays deferred.

A second fact decides the chart's shape. `buildScale` places points by wall time
(`app/components/net-worth-chart.tsx:53-76`). A session is six and a half of a day's twenty-four
hours, so on a wall-time axis a 1W window gives each session 3.9% of the width, 39 px of the
1000 px box on a desktop and about 13 px on a phone; 1M gives it 0.9% and 3M 0.3%. Points inside a
9 px session are a vertical tick, not a shape. The grain is legible only if a day's session is
given the day's width.

## Solution

A chart range of at most 92 days is drawn at a **grain**: a step on the market clock inside each
day, set by the span. 15 minutes up to 7 days, an hour up to 31, three hours up to 92, and the
daily line as it is beyond that. 1D is untouched: every observation, no grain.

Each day inside the window that has observations contributes one point per step: the last
observation in the step, with every holding valued at its latest observation at or before that
instant against the position set in force on that date. A step nothing was observed in is no
point, so an outage is a straight bridge and never a flat run, and a refresh cadence coarser than
the grain leaves one point per poll on its own. A day with no observation, the weekends, holidays,
days the app was down and dates before the log began, contributes its finished-day close from the
spine, exactly the figure the daily line draws, as a calendar date. The window's first date
contributes its close only, so the line starts where the change figure beside the headline reads.

On a grained line the chart gives every calendar day the same width and lays a day's session
across its slot, from the open at the left edge to the close at the right; a finished-day point
sits at its slot's right edge, so the window's first day contributes only that edge and the days
after it share the width. Ticks name days. A readout names the date and, for an instant, the time
on the market clock.

One reader, `readGrainedSeries` in `valuation.server.ts`, one query per window, beside the 1D
reader and shaped like the one that reader replaced, bounded now by the grain rather than the
cadence: totals per point, never per-holding rows, so ADR-0001's row-type contract stays at two
objects. `chartSeries` (`app/lib/chart-series.server.ts:59`) picks it the way it picks the session
reader today, off the window alone.

## User Stories

1. As the household, the 1W line on the Overview shows each of the week's sessions moving through
   the day at a point every 15 minutes, each session as wide as a day, the weekend a flat stretch
   between Friday's close and Monday's open.
2. As the household, 1M and 3M show the same at an hour and at three hours. YTD in February and a
   custom fortnight get the grain their length earns, because the rule is the span, not the
   preset's name. YTD changes grain three times a year and goes daily in April; the guide says so.
3. As the household, the line I get at 1Y, 5Y and All is the line I get today, to the character.
   Nothing about a range longer than 92 days changes.
4. As the household, the 1D line is the line I get today, to the character.
5. As the household, a statement dated inside the window steps the line at that day's first point,
   the way the daily line steps on that date, and a statement filed behind rewrites the same
   stretch it rewrites today.
6. As the household, a point's readout names its date and, for an instant, the time the price was
   struck on the market's clock; a weekend's point names the date alone. The ticks under the line
   name days.
7. As the household, a window that starts before the log began is dense where the data begins and
   the daily line before that, with no seam I have to explain.
8. As the household, the account page's line follows the same rules as the Overview's.
9. As the household, a window narrowed by the owner filter shows only the chosen owners' money at
   every point, on the same terms the daily line narrows.
10. As a contributor, `DESIGN.md` limitation 13, ADR-0006's deferral, `ARCHITECTURE.md`'s account
    of the read path and the log's readers, the data model's account of the series, and both
    guides describe what the chart does.

## Implementation Decisions

### The grain is a function of the span, in `chart-range.ts`

```ts
// Minutes between a grained window's steps on the market clock (spec 0022, ADR-0014).
export type GrainMinutes = 15 | 60 | 180;

// Whole days in a span -> grain. Thresholds are where the presets' own widths land: 1W is exactly
// 7 days back, 1M at most 31 (calendar-month arithmetic), 3M at most 92. Longer spans have no grain.
export function grainFor(spanDays: number): GrainMinutes | undefined;
```

- `spanDays` is what `sampleWindow` already computes: `Math.round((end - start) / DAY_MS)`. The
  three thresholds are `<= 7`, `<= 31`, `<= 92`. `FIXED_BOUNDARY` (`chart-range.ts:87`) makes 1W
  exactly 7 days, 1M 28 to 31 and 3M 89 to 92 on every date of the year (`subtractMonths`'s
  rollover only shortens a span), so no preset ever changes tier from one day to the next. YTD
  does: 15 minutes through 8 January, an hour to 1 February, three hours to 3 April, daily after.
  The tests pin the widest month (`2026-08-31` back to `2026-07-31`, 31 days) and the widest
  quarter (`2026-10-29` back to `2026-07-29`, 92).
- `RangeWindow` (`chart-range.ts:46`) gains `grain?: GrainMinutes`, present only when the span has
  one, on the same pattern as `session?`: its presence, not a separate flag, tells the seam which
  reader answers. It is set inside `sampleWindow`, so `custom`, `all` and the fixed presets all
  carry it when their span is short enough, and 1D never does. `dates` still holds every calendar
  day of the window; the grained reader needs the days too.
- `SessionAxis` (`chart-range.ts:60`) gains `grained?: true`, and its comment, "or null when
  drawing days", becomes "or null when every point is a date": with it the chart is drawing
  instants, one session under 1D or several under a grain. `chartWindow` (`chart-range.ts:325`)
  sets `controls.session` to `{ timeZone }` under 1D as now, to `{ timeZone, grained: true }` on
  a grained window, and `null` otherwise; `ChartControls.session`'s comment at `:317`, "Null on
  every range but 1D", becomes "Null unless the line carries instants". The 1D route test that
  asserts `session` `toEqual` `{ timeZone: "America/New_York" }` stays true because the key is
  added only on a grained window; the one that asserts `null` on `?range=1m` changes, below.
- `ChartPoint` (`chart-range.ts:53`) gains `dated?: true`: a grained line's finished-day point,
  whose `date` is then the calendar date `YYYY-MM-DD` it values, among instants that are full ISO
  strings. The flag, not the string's shape, says which kind a computed point is; the module's
  comment on `ChartPoint` already refuses inference there, and now names the third form.
- `export function dayOf(point: ChartPoint, session: SessionAxis | null): IsoDate`: the calendar
  day a point belongs to. A point with no session and a dated point are their `date`; an instant
  is `marketDateOf(new Date(point.date), session.timeZone)`. A hand-typed point is a date too, and
  arrives at `dayOf` flagged `dated` by the chart, below; a bare `YYYY-MM-DD` run through
  `marketDateOf` parses as UTC midnight, the previous evening in New York, and comes back a day
  early. The chart's readout and axis, and the Overview's manual-prefix rule, all need this one
  answer, so it lives once, in the pure module both already import; `chart-range.ts` may import
  `market-hours.ts`, which is pure too.
- `rangeDescription`, `isRangeDisabled`, the cookie, `rangeSearch` and `chartRangeMiddleware` do not
  change. Nothing in the control changes; a preset does not know its grain.

### The reader is one statement in `valuation.server.ts`, beside `readSessionSeries`

```ts
export type GrainedWindow = { dates: IsoDate[]; grainMinutes: number; timeZone: string };

export async function netWorthGrainedSeries(filter: OwnerFilter, window: GrainedWindow, db = getDb()): Promise<SessionPoint[]>;
export async function accountGrainedSeries(accountId: string, window: GrainedWindow, db = getDb()): Promise<SessionPoint[]>;
```

`SessionPoint` (`valuation.server.ts:398`) gains `dated?: true`, carried through `chartSeries`
onto `ChartPoint`; on a dated point `at` is the calendar date, which `asSessionPoints`'s own
comment already calls a coarse instant. The definitions below are the contract; the shape after
them is the way to meet it.

**The days.** `dates`, ascending, every calendar day of the window with the window's `since`
first, exactly what `resolveRange` hands the daily reader today. `dates` empty returns `[]` without
a query, as `readSeries` does (`valuation.server.ts:349`).

**The steps.** Every day but the first is cut into steps of the grain on the market clock from
that day's midnight: `((d::timestamp) at time zone ${timeZone}) + make_interval(mins => grain × k)`
for `k` from `0` to `1440 / grain − 1`, built in SQL so daylight-saving is Postgres's problem and
not this module's. An hourly step therefore runs `10:00` to `11:00` and a three-hour one `09:00`
to `12:00`; the close print at `16:00:0x` lands in its own step, and a fund's evening NAV in a
later one. No session-clock constant appears in the reader: which days have sessions comes from
the log, and where a day's session sits is the chart's concern.

**A step's point.** A step's point is the last observation filed under `market_date = d` whose
`as_of` falls in `[start, start + grain)`, from the whole log, never narrowed by surface, so both
surfaces plot the same instants and a cash-only account draws a flat line at them, as under 1D.
A step with no observation is no point. Nothing else makes a point: not the calendar, not a poll
row. At a refresh cadence coarser than the grain this leaves one point per poll; at a finer one,
one per step; across an outage, none, so the line runs straight from the last observation to the
next (ADR-0014, "gaps"). A day's last point is its last observation, so a session ends on its
close or on the NAV after it.

**The dated points.** The window's first day always, and every other day no step found an
observation on, contributes one point valued exactly as the daily line values it: the aggregate
`readSeries` takes over `holding_valued_at(d)` (`valuation.server.ts:344-378`), narrowed inside the
lateral on `v.owner_id` or `v.account_id` for the same reason it is there today. Its `at` is the
calendar date. The first day is dated even when it has observations, so the line starts at
`since`'s close, the figure `netWorthChange(reading, since)` reads (`app/routes/overview.tsx:101`),
and the 1D shape holds across every range: change from the previous close, line from the open.
This is the one deliberate case of the spine answering for a day the log covers; ADR-0014 names it.

**An instant's valuation.** At a plotted instant `t` on day `d`, the holdings are the `holding`
rows at `latest_position_set(a.id, d)` for accounts with `closed_at is null or closed_at > d`, the
rule `holding_valued_at` applies to the same date, narrowed on `a.owner_id` or `a.id` in the
holdings CTE as `readSessionSeries` narrows (`valuation.server.ts:438-444`). A holding's price is
its instrument's latest observation with `as_of <= t`, from any date, else the last `price_daily`
close **strictly before** `d`, else null; the rule the 1D reader applies, for its reason: the
day's own daily row is provisional and would price the open at the close. `amount` is the sum of
per-holding `cast(quantity × price as numeric(20, 4))`, coalesced to `0`; `known` counts holdings
with a price; `total` counts holdings, as `count(h.id)` over a `LEFT JOIN` so a day before the
first position set scores `0` and the seam drops it, never `1` for the manufactured null row (the
trap `tests/invariants/aggregates-agree.test.ts` names).

**The shape.** Common table expressions, each doing one thing:

```sql
with days as (
  select d, ord from unnest(${dates}::date[]) with ordinality as t(d, ord)
),
steps as (
  -- The day cut into steps of the grain from its midnight on the market clock; never the window's first day.
  select dy.d,
         ((dy.d::timestamp) at time zone ${timeZone}) + make_interval(mins => ${grain}::int * k) as starts
  from days dy
  cross join generate_series(0, 1440 / ${grain}::int - 1) as k
  where dy.ord > 1
),
instants as (
  -- A step's point is its last observation of that day; a step with none is no point. One backward
  -- index step on price_observation_market_date_idx per (day, step), whatever the cadence.
  select s.d, m.at
  from steps s
  cross join lateral (
    select max(o.as_of) as at
    from price_observation o
    where o.market_date = s.d
      and o.as_of >= s.starts
      and o.as_of < s.starts + make_interval(mins => ${grain}::int)
  ) m
  where m.at is not null
),
dated as (
  -- The window's first day, and any day no step found an observation on: the spine's close for that
  -- date. Read off `instants`, never the log again: a probe of price_observation per day is planned
  -- as a sequential scan (review, 512 ms of a 640 ms 3M), and one definition of "observed" is enough.
  select dy.d
  from days dy
  where dy.ord = 1
     or not exists (select 1 from instants i where i.d = dy.d)
),
held as (
  -- Positions in force on each plotted day, one row per (day, holding); narrowed here, never in an outer WHERE.
  select p.d, h.id, h.instrument_id, h.quantity
  from (select distinct d from instants) p
  join account a on a.closed_at is null or a.closed_at > p.d
  join holding h on h.position_set_id = latest_position_set(a.id, p.d)
  where ${heldNarrowing}
),
instant_points as (
  select i.d, i.at, false as dated,
    cast(coalesce(sum(cast(h.quantity * px.price as numeric(20, 4))), 0) as numeric(20, 4)) as amount,
    count(px.price) as known,
    count(h.id) as total
  from instants i
  left join held h on h.d = i.d
  left join lateral (
    select coalesce(
      (select o.price from price_observation o
        where o.instrument_id = h.instrument_id and o.as_of <= i.at
        order by o.as_of desc limit 1),
      (select pd.close from price_daily pd
        where pd.instrument_id = h.instrument_id and pd.date < i.d
        order by pd.date desc limit 1)
    ) as price
  ) px on true
  group by i.d, i.at
),
dated_points as (
  select dt.d, null::timestamptz as at, true as dated,
    cast(coalesce(sum(v.value), 0) as numeric(20, 4)) as amount,
    count(*) filter (where v.is_priced) as known,
    count(v.instrument_id) as total
  from dated dt
  left join lateral (
    select * from holding_valued_at(dt.d) v where ${datedNarrowing}
  ) v on true
  group by dt.d
)
select cast(d as text) as day, at, dated, amount, known, total from instant_points
union all
select cast(d as text) as day, at, dated, amount, known, total from dated_points
order by day, at
```

- **Two narrowings, one filter.** The public readers derive both from their one argument:
  `ownedBy("v.owner_id", filter)` and `ownedBy("a.owner_id", filter)` for the household,
  `isAccount("v.account_id", id)` and `isAccount("a.id", id)` for an account (`valuation.server.ts:238-247`).
  The dated branch narrows inside the `holding_valued_at` lateral because the daily reader does and
  for its reason; the instant branch narrows the holdings CTE because the 1D reader does and for
  its reason. When the filter is off, both are the `true` the 1D reader substitutes. An implementer
  who writes `where ${narrowing}` on `instant_points` or `dated_points` instead has put it in the
  outer query, which drops the manufactured row and the day with it.
- **The dated aggregate restates `readSeries`'s four expressions in SQL rather than calling it.**
  Calling it would be a second round trip and a merge in JavaScript ordered on two kinds of key;
  the four expressions are the whole of what `readSeries` adds over `holding_valued_at`, and the
  lateral with its inside narrowing is `holding_valued_at`'s one sanctioned use. One statement,
  one round trip, one `order by`.
- **The instant branch is the instants × holdings shape spec 0016 retired for 1D**, bounded now
  by the grain rather than the cadence: at most 27 steps a session at 15 minutes, 8 at an hour, 3
  at three hours, one more with an evening NAV, so a 1W window is about 140 points, 1M about 185,
  3M about 225, and at 100 holdings 3M is of the order of 20,000 (instant, holding) pairs. The
  research note measured the 1D lateral at about 21 µs a pair with two probes and a
  `latest_position_set` call per instant per account (`docs/research/2026-09-01-overview-1d-latency.md`);
  here the second probe runs only when the first finds nothing (`coalesce` is lazy) and
  `latest_position_set` runs once per account per plotted day. The review ran the statement on a
  harness-sized log, 100 feed instruments at the seeded cadence over 92 days, 20 accounts and 100
  holdings: 3M at grain 180 in about 110 ms and 1W at grain 15 in about 65 ms, against about
  70 ms for `readSeries` over 180 dates on the same seed. The reader's header says this is that
  shape and why it is acceptable here, so the next reader of the research note does not take it
  for a regression. The 1D running total is named as the fallback and its cost stated honestly:
  it reads every observation of a held instrument inside the window, which a finer cadence
  multiplies, so it is not the default.
- **Measure before wiring.** Ticket 02 runs the statement as hand-written SQL on the harness shape
  (`docs/research/2026-09-01-overview-1d-latency/harness/README.md`'s recipe: a demo seed in a
  bench database, `scale-shape.sql`, then `scale-observations.sql -v cadence=15 -v days=92`, which
  seeds the weekday sessions inside that many calendar days) for a 92-day window at grain 180 and
  a 7-day window at grain 15, with `EXPLAIN (ANALYZE, BUFFERS)`, and records both figures and the
  plan's shape for `ARCHITECTURE.md` §10. A 3M figure above 500 ms stops the ticket and is
  reported, with the plan, before the reader is wired; the rewrite is a decision, not a step.
- **`at` crosses as a `Date`** and is stringified in the mapper with `toISOString()`, as the 1D
  reader's is, for an instant; `day` crosses as text and is the point's `at` when `dated`;
  `amount` is a `numeric(20, 4)` string; `known` and `total` are `int8` strings turned into numbers
  in the mapper. The mapper sets `dated: true` on a dated row and leaves the key absent otherwise,
  so `toEqual` assertions on instants do not carry it.
- **No migration, no schema object, no index.** `price_observation_market_date_idx` serves the
  per-step maximum, one backward index step per (day, step); `price_observation_pkey` serves the
  per-holding lookup; `price_daily_pkey` the fallback close; `position_set_account_as_of_idx` the
  position set. `holding_valued_at` is reached unchanged. The step bounds reach the lateral as
  outer references of a nested loop, which the planner turns into index conditions; the
  joined-CTE trap spec 0016 found is not present. The log is touched by those two index probes
  and nothing else, which the ticket's `EXPLAIN` confirms: a `not exists` probe of the log per
  day, the shape the first draft had, is planned as a sequential scan and cost half a second.

### The seam picks the reader off the window, as it does for 1D

`readPoints` (`chart-series.server.ts:45`) gains one branch per surface: `resolved.grain !== undefined`
reaches `netWorthGrainedSeries` or `accountGrainedSeries` with
`{ dates: resolved.dates, grainMinutes: resolved.grain, timeZone: getConfig().MARKET_TIMEZONE }`.
The seam imports `getConfig` from `server/config.ts`, as both routes and seven `app/lib/*.server.ts`
modules already do; the zone is the one the poller stamps `market_date` with, and the reader must
cut its steps on the same clock. `chartSeries` maps `dated` through beside `date` and `amount`. The
coverage rule does not move.

### The chart gives each day its width, names days, and times only an instant

`net-worth-chart.tsx`:

- **The chart flags its hand-typed points.** Where `NetWorthChart` joins `manual` and `computed`
  into one array (`:222`), every hand-typed point is marked `dated: true`: it is a calendar date,
  and the scale, `dayOf` and the readout must not run it through `marketDateOf`. The loader's
  `manual` array and the assertions on it do not change; the flag is the chart's.
- **`buildScale(points, session = null)` gains a grained branch.** With `session.grained`, a
  point's position is `dayIndex + fraction`: `dayIndex` counts calendar days, `Date.parse` on
  `YYYY-MM-DDT00:00:00Z`, from the earliest `dayOf` among the points to the point's own, and
  `fraction` is `1` for a dated point and otherwise where the instant sits in the regular session,
  `(minutes since SESSION_OPENS) / (SESSION_CLOSES − SESSION_OPENS)` from `marketTimeOf` on the
  market clock, clamped to `[0, 1]`. Positions are computed once, with the flags in hand, into a
  map keyed by the point's `date`, and `x(date)` is the lookup, so `Scale.x` keeps its signature
  and every call site, which all pass a `date` from that same array, is untouched. Positions are
  normalised from their minimum to their maximum across the box, as times are today, which is
  why the first day contributes only its right edge. `market-hours.ts` exports `SESSION_OPENS`
  and `SESSION_CLOSES` for it; they are the regular session's minutes and not the holiday calendar,
  so nothing about that module's trust rule changes. The default `null` keeps every existing
  one-argument caller. Without a grain the scale is the wall-time one it is today, so 1D and the
  daily line do not move. A close print at `16:00:03` and an evening NAV both sit at the slot's
  right edge; a segment of zero width is what a same-instant pair already draws.
- `tickLabel` (`:160`) names the time of day only for a session that is not grained. On a grained
  axis the three ticks name the day at the left edge, the middle and the right edge, read off the
  scale's day positions rather than the millisecond interpolation the tick block at `:246-250`
  does today, with `MONTHS` as now.
- `readoutDate` (`:171`) takes the point, at both call sites (`:192`, `:242`). The day is
  `dayOf(point, session)`; the time is appended only with a session and only for a point that is
  not dated. The `aria-label`'s "ending on …" clause is the second call site.
- `ChartEmptyNote` (`:365`) renders the "two observed moments" sentence only for a session that is
  not grained; a grained window with fewer than two points gets the caller's own sentence, the way a
  dated window does.
- `hitTargets`, the polyline, the area and the marker do not change: each reads `scale.x`.
- The pre-rendered readout count is now bounded by the grain tiers, about 225 at 3M, rather than
  by `SAMPLE_BUDGET`'s 180. Nothing in the component or `app/app.css` assumes the smaller number
  (`.chart-hit` widths are percentages), and the loader payload is under 20 KB; ADR-0004 gains a
  note saying which bound now holds.

### One comparison in the Overview changes

`overview.tsx`'s manual-prefix rule (`:111-119`) keeps a hand-typed point that is before the first
computed point, comparing `point.date < firstComputed`. On a grained window the first computed
point may be an instant, and DESIGN §7 rule 2, computed wins on an overlapping date, must still
hold, so the comparison becomes `first === undefined || point.date < dayOf(first, controls.session)`
with `first` the first computed point; the `undefined` guard is what keeps the whole reachable
prefix when nothing is computed, as today. Under 1D the prefix is `[]` before the comparison
runs, and without a session `dayOf` is the date, so the daily line's behaviour is unchanged. `manualWithheld` keys on `resolved.session` and does not
change. `account.tsx` does not change.

### The demo seeds five sessions, not one

`scripts/seed-demo.ts`'s `findSession` (`:399-427`) builds observations for the latest session
only, so a grained 1W on the demo would be one dense day and four dated points. The seed gains the
four sessions before it, each walked from the prior close to its own close the way the latest is
(`walkSession`, `:431`), with its `price_poll` rows; the mutual fund keeps one NAV per session and
the stale instrument observes nothing. `SESSION_SEED` still seeds the walk, so nothing the script
writes outside `price_observation` and `price_poll` changes; the latest session's walked prices
do, since the walk now consumes four sessions of noise first, and the committed 1D screenshots
would drift if recaptured. Its own ticket and its own commit.

## Documents this change makes false

Each of these states something that stops being true, and each is part of the change (ticket 05):

- `DESIGN.md` §8.1 (`:615-623`), "The chart has a range control, and two ADRs govern the line":
  "1D is the exception" is no longer the whole story; a range of at most 92 days is drawn at a
  grain on a per-day axis (ADR-0014), and the paragraph gains the sentence.
- `DESIGN.md` §14 limitation 13 (`:1576-1587`): "1D always shows the latest session; an older one
  cannot be chosen" stays as the limit, but the sentence naming the three deferred costs is now
  false for two of them. It is cut back to what still holds: an older session cannot be picked *as
  1D*; the archive is not market data; the line is drawn once.
- `DESIGN.md` §14 limitation 2 (`:1514-1521`), "sharpest on 1D, where … the line holds today's
  positions constant": still true of 1D and now the one range it is true of; a grained range values
  each instant at the position set in force on its date. One clause.
- `ADR-0006`, the consequence "Past-navigable intraday is deferred, not obligated": a bold-led note
  after the opening paragraph, the shape ADR-0011's "Superseded in part" note takes, pointing at
  ADR-0014 and saying which costs are paid. The body is not rewritten.
- `ADR-0004`, "bounded by the sampling budget ADR-0003 introduced": a bold-led note that on a
  grained range the bound is the grain tiers (ADR-0014), about 225 points at 3M.
- `ARCHITECTURE.md` §4.2, the "Valuing holdings" row (`:411`) and its bullet naming
  `readSessionSeries` as the one valuation outside the two SQL objects (`:432-437`, which also
  cites a stale line number): the grained reader is the second.
- `ARCHITECTURE.md` §5, the tiers table row for `price_observation` (`:1346`), "the 1D line, and
  nothing else"; §5.5, the index table's `price_observation_pkey` and `price_observation_market_date_idx`
  rows (`:896-897`), described only by the 1D reader's use; Appendix B (`:2487`), "Read by the 1D
  chart and by nothing else".
- `ARCHITECTURE.md` §6.3 (`:1531`), "The three intra-session reads are the module's second front":
  a third front, the grained reader, with where its two narrowings sit and why it re-values per
  plotted instant where the 1D reader runs a total.
- `ARCHITECTURE.md` §10, the trade-off table: a row for the grained line, with the measured figures
  from ticket 02 and what it would break at; the "Four indexes carry the read path" paragraph
  (`:2177`) naming what the grained reader rides; the opening sentence on what has been measured
  (`:2157-2164`).
- `ARCHITECTURE.md` Appendix A, `chart-range.ts` (`:2330`), `chart-series.server.ts` (`:2311`) and
  `net-worth-chart.tsx` (`:2406`) rows: the grain, the third reader, the per-day axis and the dated
  point.
- `docs/data-model.md` §4.4 (`:379-380`), "`price_observation` … is what the 1D chart draws", and
  §5.3.1 (`:644-656`): a paragraph for the grained series beside the one for 1D.
- `docs/guide/overview.md` "The range control" (`:17-40`) and "1D: the latest trading session"
  (`:61-75`): a section for what a short range draws, including that YTD changes grain through the
  year and that a day's session is given the day's width, and the 1D section's "Current quantities
  are used across the session" becomes the thing 1D alone does. `docs/guide/account-detail.md`
  (`:45`), the one sentence about 1D.
- `README.md`'s bullet (`:346`) "1D: current holdings valued at observed instants in the latest
  recorded session" gains a sibling for short ranges.
- `docs/specs/README.md`: a row for this spec and the ticket directory.

Deliberately not on the list: `docs/design/pricing-ui-brief.md` §8, already struck through by
ADR-0006; `migrations/0009_price_observation.sql`'s header comment that the market-date index
"finds and walks the latest observed session for 1D", a migration's text after it has been
applied; and `docs/specs/0008-chart-ranges.md`'s stale sampling claims, which are
[ticket 02 of spec 0009](dynamic-chart-resolution/02-correct-spec-0008-sampling-claims.md)'s and
not this slice's.

### Tests this change makes false

Two existing tests encode the daily line for a range that is now grained, and are rewritten
rather than left to fail (ticket 04):

- `tests/routes/overview.test.ts:864-875`, "tells the chart it is drawing a session, and tells it
  nothing of the sort otherwise", asserts `session` is `null` on `?range=1m`. It asserts `null` on
  `?range=1y` instead, and gains the grained shape on `?range=1m`.
- `tests/routes/overview.test.ts:928-951`, "leaves every other range drawing exactly what it drew
  before", loads `?range=1m`, seeds observations on `daysAgo(1)`, and asserts the line is
  unchanged. That is the claim this slice reverses for a range of at most 92 days; it is rewritten
  against `?range=1y`, where it still holds and is now the property worth pinning.

Every other test that loads a range of at most 92 days seeds no observation, so each of its
computed points is dated and its assertions hold; the overlap test at `overview.test.ts:493-512`
is one of them and is left alone.

## Testing Decisions

Test what would hurt to break. Pure rules in `tests/chart-range.test.ts` and
`tests/net-worth-chart.test.tsx`; the reader against real Postgres in a new
`tests/grained-series.test.ts`; the dispatch in `tests/chart-series.test.ts`; the wiring in the
two route test files. Money assertions are exact strings at scale 4. Every observation seeded in
these tests passes `marketDate` explicitly, because the fixture's default is the UTC day of the
instant and a winter evening NAV crosses it (`tests/support/fixtures.ts:405`).

- **The grain by span.** 7 days is 15, 8 is 60, 31 is 60, 32 is 180, 92 is 180, 93 is none, 0 is
  15. The widest 1M and the widest 3M land in their tiers. 1D carries no grain and a session; 1Y,
  5Y and All none. A custom fortnight is 60. `dates` on a grained window is still every calendar
  day. `dayOf` answers the date for a dated point and the market date for an instant.
- **The controls.** `chartWindow` reports `{ timeZone, grained: true }` on 1W and `{ timeZone }`
  on 1D, `null` on 1Y.
- **The reader, one rule per test:**
  - a step's point is its last observation, valued at each holding's latest observation at or
    before it, and an instrument unobserved that day at its close strictly before the day;
  - the window's first day is its close alone, as a calendar date, even when it has observations,
    and equals `netWorthAt` for that date to the character;
  - a Saturday and a Sunday are dated points carrying Friday's close;
  - a step with no observation is no point, so an outage inside a session leaves nothing between
    the observation before and the one after;
  - a day whose only observation is an evening NAV is one point at the NAV's instant;
  - the mixed day: two equities through the day and a fund's NAV at 18:00, where the 15:59 point
    carries yesterday's NAV, the 18:00 point today's, and nothing is counted twice;
  - a full-array `toEqual` across Friday's instants, Saturday, Sunday and Monday's instants, pinning
    the order a dated day takes among instants;
  - a day observed only for an instrument nobody holds still yields a point, as a cash-only
    account's flat line under 1D, each held instrument at its own latest observation on any
    earlier day, else its close strictly before the day;
  - a statement dated inside the window changes the holdings from that day's points on, and not
    before;
  - an account closed inside the window counts on the days it was open, on the daily line's terms;
  - an hourly grain groups `10:59` and `11:01` into two points and `10:59` and `10:58` into one; a
    three-hour grain groups `09:31` and `11:59` into one;
  - a step boundary lies on the market clock: midnight New York is `04:00Z` in July and `05:00Z`
    in January, so the same two wall-clock instants group the same way in both;
  - a day before the first position set scores `total: 0` on both branches, so the seam drops it;
  - the owner filter narrows both branches, and the account reader reaches only its account, at an
    instant and at a dated point alike;
  - an empty `dates` returns `[]` without a query.
- **Agreement.** In `tests/invariants/aggregates-agree.test.ts`, a grained line's dated point on a
  date and `netWorthAt` on that date agree on `amount` and coverage, as the daily series and the
  point query already must.
- **The seam.** The same seed the existing "window decides the reader" test uses, a third window:
  grained, and the answer is the first day's close flagged `dated` at its date plus the observation
  at its own instant.
- **The chart.** A grained axis gives two days the same width whatever their instants, places an
  instant inside its day by its time in the session and a dated point at its day's right edge,
  names days on its ticks, puts a time beside the date in an instant's readout and no time in a
  dated point's, dates an evening NAV on the market clock, describes a line ending on a dated point
  without a time, masks as every other range does, and falls through to the caller's empty
  sentence. A wall-time scale still places a point by its date when there is no grain.
- **The routes.** 1W on the Overview returns `session: { timeZone: "America/New_York", grained: true }`
  and a `computed` that is dated days from the first day the seed holds a position set for, the
  seeded session's instants at the seeded amounts, and today dated, asserted by kind, day and
  amount, never by a literal `Z` string derived from `daysAgo`, which the change of clocks would
  break; 1Y returns `null`; a hand-typed point dated the
  first computed day is dropped and one dated before it is drawn ahead; the account page's 1W
  returns the same shape narrowed to its account. The existing 1D tests do not change.

## Out of Scope

- **Choosing an older session as 1D.** Still deferred (ADR-0006, ADR-0014). A grained range draws
  older sessions inside a span; it does not offer one by itself.
- **Any change to 1D**: its sampling, its positions-now rule, its cost, its wall-time axis.
  ARCHITECTURE §10 prices it and spec 0016 owns it.
- **Any change to the date sampler** for spans over 92 days (ADR-0003), or to the daily line's
  wall-time axis.
- **Marking a gap** inside a session, or a partially priced date. The same silence as
  [issue #216](https://github.com/chethan123/portfolio/issues/216), one design for both, not here.
- **A grain the household can set.** The tiers are fixed; the refresh cadence stays the dial it is.
- **Dropping non-session days from the axis.** A weekend keeps its two slots, so a window that
  starts before the log began still draws its daily part at the daily line's spacing.
- **A migration-defined `holding_valued_at_instant`.** ADR-0001, and the chart reads totals.
- **Live updates.** The line is drawn once at page load (DESIGN §14).
- **The backfilled-outage edge.** A day the app was down whose equity closes a later head-gap
  backfill filled, while a fund's evening NAV made the day "observed": its one point prices the
  equities from their last observation, the daily line from the backfilled close. The 1D rule,
  recorded in ADR-0014, not changed here.

## Alternatives considered and rejected

Recorded in ADR-0014: a point budget with thinning instead of fixed tiers; the poll as the grid; a
grid of round-clock instants with a separate session-end point; a covered session's instants plus
the spine's close; bridging a gap with flat points; today's positions across the window; a
wall-time axis for the grained line; a migration-defined reader.

## Further Notes

- A step's point is an observation's own instant, so a readout's time is the time the price was
  struck, which a round-clock grid could not promise at a coarse cadence. The cost is that the
  points of a day are not evenly spaced in x; at a 15-minute cadence they are within a minute of
  it.
- `holding_valued_at` compares `closed_at`, a `timestamptz`, with a `date`, which Postgres casts
  at midnight in the session's time zone; `server/db.ts` pins the pool to UTC, so this is the
  "start of that UTC date" `CONTEXT.md`'s "Closed" states, and the instant branch applies the same
  comparison so the two branches cannot disagree about a closing account.
- The seam reads `MARKET_TIMEZONE` rather than the window carrying it, because `resolveRange` is
  pure and tested without an environment, and every caller of the seam already has the config in
  hand.
- The last day of a window that ends today, before the first observation of the day, is a dated
  point at today's date, carrying yesterday's close, at the right edge of today's slot; the
  readout names the date alone, as the daily line's today does.

## Acceptance

- [ ] 1W, 1M and 3M on the Overview and on an account page draw one point per step inside each
      observed day at 15 minutes, an hour and three hours, every day after the first as wide as
      any other, dated closes on the other days, and the first day's close first
- [ ] 1Y, 5Y, All and 1D are unchanged, to the character, on the same data
- [ ] The dated points of a grained line equal the daily line's points for those dates
- [ ] A gap inside a session is a straight bridge; a weekend is a flat stretch two days wide
- [ ] Readouts name a time only for an instant, and that time is the observation's; ticks name days
- [ ] The owner filter narrows both kinds of point
- [ ] The 1W and 3M statements on the harness household are measured and the figures recorded in
      `ARCHITECTURE.md` §10
- [ ] Every document under "Documents this change makes false" is true again
- [ ] `npm run typecheck`, `npm test` and `npm run build` are green
