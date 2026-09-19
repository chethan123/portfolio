# A short chart range at a grain from the observation log

Canonical here. Decided in [ADR-0014](../adr/0014-a-short-chart-range-draws-its-sessions-at-a-grain-from-the-observation-log.md),
which records the trade-offs; this file records what to build. When the two disagree on a fact
about the code, this file wins. Tickets are in [`chart-grain/`](chart-grain/).

See [ADR-0006](../adr/0006-intraday-quotes-are-an-observation-log.md) for what an observation is
and the invariant that a past date's valuation never reads one, [ADR-0003](../adr/0003-anchored-geometric-chart-sampling.md)
for the date sampler this leaves alone, [spec 0015](0015-chart-series-assembly.md) for the read
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
instant-parameterised reader, a second time vocabulary in `chart-range.ts`, and an axis that names a
day as well as an hour. This spec pays the first two and the third's chart half, for the ranges
short enough to show a session's shape.

## Solution

A chart range of at most 92 days is drawn at a **grain**: a step on the market clock inside each
session, set by the span. 15 minutes up to 7 days, an hour up to 31, three hours up to 92, and the
daily line as it is beyond that. 1D is untouched: every observation, no grain.

Each session inside the window that has observations contributes its grid instants, valued from
the log at the position set in force on that date. Each date with none, the weekends, holidays,
days the app was down and dates before the log began, contributes its finished-day close from the
spine, exactly the figure the daily line draws, placed at that date's session end on the market
clock. The window's first date contributes its close only, so the line starts where the change
figure beside the headline reads. A grid instant nothing was observed for is skipped, so an outage
is a straight bridge and never a flat run. Each session ends on its last observation, so a session's
last point is its close, the way 1D ends on the headline figure.

One reader, `readGrainedSeries` in `valuation.server.ts`, one query per window, beside the 1D
reader and shaped like it: totals per instant, never per-holding rows, so ADR-0001's row-type
contract stays at two objects. `chartSeries` (`app/lib/chart-series.server.ts:59`) picks it the way
it picks the session reader today, off the window alone. The chart learns two things: an axis that
names days while its readouts carry a time, and a point that is a date rather than an instant.

## User Stories

1. As the household, the 1W line on the Overview shows each of the week's sessions moving through
   the day, at the cadence the market clock allows: a point every 15 minutes, with the weekend a
   flat carry-forward between Friday's close and Monday's open, as it is today.
2. As the household, 1M and 3M show the same at an hour and at three hours. YTD in February and a
   custom fortnight get the grain their length earns, because the rule is the span, not the
   preset's name.
3. As the household, the line I get at 1Y, 5Y and All is the line I get today, to the character.
   Nothing about a range longer than 92 days changes.
4. As the household, the 1D line is the line I get today, to the character.
5. As the household, a statement dated inside the window steps the line at the open of that day,
   the way the daily line steps on that date, and a statement filed behind rewrites the same
   stretch it rewrites today.
6. As the household, a point's readout names its date and, for an instant, its time on the
   market's clock; a weekend's point names the date alone. The ticks under the line name days.
7. As the household, a window that starts before the log began is dense where the data begins and
   the daily line before that, with no seam I have to explain.
8. As the household, the account page's line follows the same rules as the Overview's.
9. As the household, a window narrowed by the owner filter shows only the chosen owners' money at
   every instant, on the same terms the daily line narrows.
10. As a contributor, `DESIGN.md` limitation 13, ADR-0006's deferral, `ARCHITECTURE.md`'s account
    of the read path, the data model's account of the series, and both guides describe what the
    chart does.

## Implementation Decisions

### The grain is a function of the span, in `chart-range.ts`

```ts
// Minutes between a grained window's grid instants on the market clock (spec 0022, ADR-0014).
export type GrainMinutes = 15 | 60 | 180;

// Whole days in a span -> grain. Thresholds are where the presets' own widths land: 1W is exactly
// 7 days back, 1M at most 31 (calendar-month arithmetic), 3M at most 92. Longer spans have no grain.
export function grainFor(spanDays: number): GrainMinutes | undefined;
```

- `spanDays` is what `sampleWindow` already computes: `Math.round((end - start) / DAY_MS)`. The
  three thresholds are `<= 7`, `<= 31`, `<= 92`. `FIXED_BOUNDARY` (`chart-range.ts:87`) makes 1W
  exactly 7 days, 1M 28 to 31 and 3M 89 to 92, so each preset lands in its tier on every date of
  the year; the tests pin the widest month and the widest quarter.
- `RangeWindow` (`chart-range.ts:46`) gains `grain?: GrainMinutes`, present only when the span has
  one, on the same pattern as `session?`: its presence, not a separate flag, tells the seam which
  reader answers. It is set inside `sampleWindow`, so `custom`, `all` and the fixed presets all
  carry it when their span is short enough, and 1D never does. `dates` still holds every calendar
  day of the window; the grained reader needs the days too.
- `SessionAxis` (`chart-range.ts:60`) gains `grained?: true`. `chartWindow` (`chart-range.ts:325`)
  sets `controls.session` to `{ timeZone }` under 1D as now, to `{ timeZone, grained: true }` on a
  grained window, and `null` otherwise. The 1D route tests that assert `session` `toEqual`
  `{ timeZone: "America/New_York" }` stay true because the key is added only on a grained window.
- `ChartPoint` (`chart-range.ts:53`) gains `dated?: true`: a grained line's finished-day point,
  placed at its date's session end and read out as a date alone. Its `date` is then a full ISO
  instant like every other point on a grained line; the flag, not the string's shape, says which
  kind it is, because the module's comment on `ChartPoint` already refuses inference there.
- `rangeDescription`, `isRangeDisabled`, the cookie, `rangeSearch` and `chartRangeMiddleware` do not
  change. Nothing in the control changes; a preset does not know its grain.

### The reader is one statement in `valuation.server.ts`, beside `readSessionSeries`

```ts
export type GrainedWindow = { dates: IsoDate[]; grainMinutes: number; timeZone: string };

export async function netWorthGrainedSeries(filter: OwnerFilter, window: GrainedWindow, db = getDb()): Promise<SessionPoint[]>;
export async function accountGrainedSeries(accountId: string, window: GrainedWindow, db = getDb()): Promise<SessionPoint[]>;
```

`SessionPoint` (`valuation.server.ts:398`) gains `dated?: true`, carried through `chartSeries`
onto `ChartPoint`. The definitions below are the contract; the shape after them is the way to meet
it and may be reshaped by the ticket if a measurement says so.

**The days.** `dates`, ascending, every calendar day of the window with the window's `since`
first, exactly what `resolveRange` hands the daily reader today. `dates` empty returns `[]` without
a query, as `readSeries` does (`valuation.server.ts:349`).

**The grid.** For every day but the first, the instants `09:30 + k × grain` on the market clock for
`k` from `0` while the instant is at or before `16:00`, built in SQL as
`(d + time '09:30') at time zone ${timeZone} + make_interval(mins => grain × k)`, so daylight-saving
is Postgres's problem and not this module's. `09:30` and `16:00` are the regular NYSE session
`app/lib/market-hours.ts` already states as `SESSION_OPENS` and `SESSION_CLOSES`; the reader
states them again as SQL literals with a comment naming that module, because the calendar there is
a cost optimisation nothing downstream trusts (`market-hours.ts:1-6`), and this is not a use of the
calendar: which days are sessions comes from the log, below.

**Which grid instants count.** A grid instant `t` on day `d` is plotted when an observation filed
under `market_date = d` has `as_of` in `(t − grain, t]`. Nothing else makes it a point: not the
calendar, not a poll row. At a refresh cadence coarser than the grain, this leaves one point per
poll with nothing further to design; at a finer cadence, one per step. An outage inside a session
leaves the instants inside it unplotted, so the line runs straight from the last observation to the
next (ADR-0014, "gaps").

**The session's end.** A day that has observations also plots its last one, `max(as_of)` over
`market_date = d`, when that instant is later than the day's last plotted grid instant. This is
what makes a session's last point its close: the closing print's `as_of` falls after `16:00:00`,
and a mutual fund's NAV after that. A day whose only observations fall after `16:00` is one point,
which is what a fund-only household should see.

**The dated points.** The window's first day always, and every other day with no observation under
its `market_date`, contributes one point valued exactly as the daily line values it: the aggregate
`readSeries` takes over `holding_valued_at(d)` (`valuation.server.ts:344-378`), narrowed inside the
lateral on `v.owner_id` or `v.account_id` for the same reason it is there today. Its instant is
`(d + time '16:00') at time zone ${timeZone}`. The first day is dated even when it has
observations, so the line starts at `since`'s close, the figure `netWorthChange(reading, since)`
reads (`app/routes/overview.tsx:101`), and the 1D shape holds across every range: change from the
previous close, line from the open.

**The instants' valuation.** At a plotted instant `t` on day `d`, the holdings are the `holding`
rows at `latest_position_set(a.id, d)` for accounts with `closed_at is null or closed_at > d`, the
rule `holding_valued_at` applies to the same date, narrowed on `a.owner_id` or `a.id` in the
holdings CTE as `readSessionSeries` narrows (`valuation.server.ts:438-444`). A holding's price is
its instrument's latest observation with `as_of <= t`, from any date, else the last `price_daily`
close **strictly before** `d`, else null; the same three-way rule as the 1D reader, for the same
reason: the day's own daily row is provisional and would price the open at the close. `amount` is
the sum of per-holding `cast(quantity × price as numeric(20, 4))`, coalesced to `0`; `known` counts
holdings with a price; `total` counts holdings, as `count(h.id)` over a `LEFT JOIN` so a day before
the first position set scores `0` and the seam drops it, never `1` for the manufactured null row
(the trap `tests/invariants/aggregates-agree.test.ts` names).

**The shape.** Common table expressions, each doing one thing:

```sql
with days as (
  select d, ord from unnest(${dates}::date[]) with ordinality as t(d, ord)
),
grid as (
  -- 09:30 + k × grain, at or before 16:00, on the market clock; never the window's first day.
  select dy.d, ((dy.d + time '09:30') at time zone ${timeZone}) + make_interval(mins => ${grain} * k) as at
  from days dy
  cross join generate_series(0, 390 / ${grain}) as k
  where dy.ord > 1
),
counted as (
  -- A grid instant is a point only when an observation of that day arrived in the step ending at it.
  select g.d, g.at
  from grid g
  where exists (
    select 1 from price_observation o
    where o.market_date = g.d
      and o.as_of > g.at - make_interval(mins => ${grain})
      and o.as_of <= g.at)
),
session_end as (
  -- The day's last observation, when later than its last counted instant: the close, or the NAV after it.
  select dy.d, max(o.as_of) as at
  from days dy
  join price_observation o on o.market_date = dy.d
  where dy.ord > 1
  group by dy.d
  having max(o.as_of) > coalesce((select max(c.at) from counted c where c.d = dy.d), '-infinity')
),
instants as (
  select d, at from counted
  union all
  select d, at from session_end
),
dated as (
  -- The window's first day, and any day nothing was observed on: the spine's close, at 16:00 on the market clock.
  select dy.d, (dy.d + time '16:00') at time zone ${timeZone} as at
  from days dy
  where dy.ord = 1
     or not exists (select 1 from price_observation o where o.market_date = dy.d)
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
  select i.at, false as dated,
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
  group by i.at
),
dated_points as (
  select dt.at, true as dated,
    cast(coalesce(sum(v.value), 0) as numeric(20, 4)) as amount,
    count(*) filter (where v.is_priced) as known,
    count(v.instrument_id) as total
  from dated dt
  left join lateral (
    select * from holding_valued_at(dt.d) v where ${datedNarrowing}
  ) v on true
  group by dt.at
)
select at, dated, amount, known, total from instant_points
union all
select at, dated, amount, known, total from dated_points
order by at
```

- **Two narrowings, one filter.** The public readers derive both from their one argument:
  `ownedBy("v.owner_id", filter)` and `ownedBy("a.owner_id", filter)` for the household,
  `isAccount("v.account_id", id)` and `isAccount("a.id", id)` for an account (`valuation.server.ts:238-247`).
  The dated branch narrows inside the `holding_valued_at` lateral because the daily reader does and
  for its reason; the instant branch narrows the holdings CTE because the 1D reader does and for
  its reason. When the filter is off, both are the `true` the 1D reader substitutes.
- **Cost is instants × holdings, bounded by the grain, not the cadence.** At the seeded cadence a
  15-minute grid plots at most 27 grid instants plus one end per session; 1W is about 140 points,
  1M about 170, 3M about 260. Against the measured household's 97 holdings that is at most about
  25,000 (instant, holding) pairs for 3M, each two primary-key probes, plus `latest_position_set`
  once per account per plotted day rather than per instant. The ticket measures it on the harness
  shape (`docs/research/2026-09-01-overview-1d-latency/harness/scale-shape.sql`), and records the
  figure in `ARCHITECTURE.md` §10. If 3M measures above half a second there, the instant branch is
  rewritten as the running total spec 0016 uses, partitioned by day with the span bounds passed as
  correlated lateral predicates rather than a joined CTE (spec 0016, "The span's bounds"), and
  the definitions above are what the rewrite is checked against. A finer refresh cadence does not
  move the cost of the primary shape, which is the reason the grain is a wall-clock step and not a
  poll (ADR-0014).
- **`at` crosses as a `Date`** and is stringified in the mapper with `toISOString()`, as the 1D
  reader's is; `amount` is a `numeric(20, 4)` string; `known` and `total` are `int8` strings turned
  into numbers in the mapper; `dated` is a boolean. The mapper sets `dated: true` on a dated row
  and leaves the key absent otherwise, so `toEqual` assertions on instant points do not carry it.
- **No migration, no schema object, no index.** `price_observation_market_date_idx` serves the
  per-day existence checks and `max(as_of)`; `price_observation_pkey` serves the per-holding
  lookup; `price_daily_pkey` the fallback close; `position_set_account_as_of_idx` the position set.
  `holding_valued_at` is reached unchanged.

### The seam picks the reader off the window, as it does for 1D

`readPoints` (`chart-series.server.ts:45`) gains one branch per surface: `resolved.grain !== undefined`
reaches `netWorthGrainedSeries` or `accountGrainedSeries` with
`{ dates: resolved.dates, grainMinutes: resolved.grain, timeZone: getConfig().MARKET_TIMEZONE }`.
The seam imports `getConfig` from `server/config.ts`, as both routes already do for the same value;
the zone is the one the poller stamps `market_date` with, and the reader must lay its grid on the
same clock. `chartSeries` maps `dated` through beside `date` and `amount`. The coverage rule does
not move.

### The chart names days and times a point only when it is an instant

`net-worth-chart.tsx`:

- `tickLabel` (`:160`) names the time of day only for a session that is not grained; a grained
  axis names days, taking the day from `marketDateOf(new Date(ms), session.timeZone)` rather than
  `isoDate(ms)`, so a tick that falls late in a New York evening is not dated tomorrow.
- `readoutDate` (`:171`) takes the point. With a session, the date is `marketDateOf` as now; the
  time is appended unless `point.dated`. Without a session, unchanged.
- `ChartEmptyNote` (`:365`) renders the "two observed moments" sentence only for a session that is
  not grained; a grained window with fewer than two points gets the caller's own sentence, the way a
  dated window does.
- `buildScale`, `hitTargets`, the polyline, the area and the marker do not change: every point on
  a grained line is a full instant and `Date.parse` places it.

### The routes do not change

`overview.tsx` and `account.tsx` spread `controls` and pass `computed` and `session` as they do.
The manual prefix rule (`overview.tsx:111-119`) keys on `resolved.session`, which a grained window
does not set, so a hand-typed point older than the first computed point is still drawn ahead of it;
the comparison `point.date < firstComputed` holds between a `YYYY-MM-DD` and an ISO instant because
the instant's first ten characters are its UTC date and the prefix orders first, and a grained
window short enough to reach a hand-typed point is a household under three months old.
`manualWithheld` is unchanged for the same reason.

### The demo seeds five sessions, not one

`scripts/seed-demo.ts`'s `findSession` builds observations for the latest session only, so a
grained 1W on the demo would be one dense day and four dated points. The seed gains the four
sessions before it, each walked from the prior close to its own close the way the latest is, with
its `price_poll` rows; the mutual fund keeps one NAV per session. Every existing seeded figure is
unchanged: the session walk has its own seed (`SESSION_SEED`) so the closes and quantities do not
reshuffle.

## Documents this change makes false

Each of these states something that stops being true, and each is part of the change (ticket 05):

- `DESIGN.md` §8.1, "The chart has a range control, and two ADRs govern the line": "1D is the
  exception" is no longer the whole story; a range of at most 92 days is drawn at a grain
  (ADR-0014), and the paragraph gains the sentence.
- `DESIGN.md` §14 limitation 13: "1D always shows the latest session; an older one cannot be
  chosen" stays as the limit, but the sentence naming the three deferred costs is now false for
  two of them. It is cut back to what still holds: an older session cannot be picked *as 1D*; the
  archive is not market data; the line is drawn once.
- `DESIGN.md` §14 limitation 2, "sharpest on 1D, where … the line holds today's positions
  constant": still true of 1D and now the one range it is true of; a grained range values each
  instant at the position set in force on its date. One clause.
- `ADR-0006`, the consequence "Past-navigable intraday is deferred, not obligated": a banner at the
  head, on the pattern ADR-0011 carries, pointing at ADR-0014. The body is not rewritten.
- `ARCHITECTURE.md` §6.3, "The three intra-session reads are the module's second front": a third
  front, the grained reader, with where its narrowing sits and why it re-values per instant where
  the 1D reader runs a total. §4.2's row "Valuing holdings outside the two SQL objects" names it.
- `ARCHITECTURE.md` §10, the trade-off table: a row for the grained line, with the measured figure
  from ticket 02 and what it would break at, and the "Four indexes carry the read path" paragraph
  naming what the grained reader rides.
- `ARCHITECTURE.md` Appendix A, `chart-range.ts` and `chart-series.server.ts` rows: the grain and
  the third reader.
- `docs/data-model.md` §5.3.1: a paragraph for the grained series beside the one for 1D.
- `docs/guide/overview.md` "The range control" and "1D: the latest trading session": a section for
  what a short range draws, and the 1D section's "Current quantities are used across the session"
  becomes the thing 1D alone does. `docs/guide/account-detail.md`, the one sentence about 1D.
- `README.md`'s bullet "1D: current holdings valued at observed instants in the latest recorded
  session" gains a sibling for short ranges.
- `docs/specs/README.md`: a row for this spec and the ticket directory.

Deliberately not on the list: `docs/design/pricing-ui-brief.md` §8, already struck through by
ADR-0006; `migrations/0009_price_observation.sql`'s comment that the log is "read by no screen
except the 1D chart", a migration's text after it has been applied; and `docs/specs/0008-chart-ranges.md`'s
stale sampling claims, which are [ticket 02 of spec 0009](dynamic-chart-resolution/02-correct-spec-0008-sampling-claims.md)'s
and not this slice's.

## Testing Decisions

Test what would hurt to break. Pure rules in `tests/chart-range.test.ts` and
`tests/net-worth-chart.test.tsx`; the reader against real Postgres in a new
`tests/grained-series.test.ts`; the dispatch in `tests/chart-series.test.ts`; the wiring in the
two route test files. Money assertions are exact strings at scale 4.

- **The grain by span.** 7 days is 15, 8 is 60, 31 is 60, 32 is 180, 92 is 180, 93 is none. The
  widest 1M (`2026-08-31` back to `2026-07-31`) is 60 and the widest 3M (`2026-10-29` back to
  `2026-07-29`) is 180, so no date of the year drops a preset a tier. 1D carries no grain and a
  session; 1Y, 5Y and All none. A custom fortnight is 60. `dates` on a grained window is still every
  calendar day.
- **The controls.** `chartWindow` reports `{ timeZone, grained: true }` on 1W and `{ timeZone }`
  on 1D, `null` on 1Y.
- **The reader, one rule per test:**
  - a grid instant is valued at each holding's latest observation at or before it, and an
    instrument unobserved that day at its close strictly before the day;
  - the window's first day is its close alone, at `16:00` on the market clock, even when it has
    observations, and equals `netWorthAt` for that date to the character;
  - a weekend day is its close, at `16:00` on the market clock, carrying Friday forward;
  - a grid instant with no observation in its step is not a point, so a gap inside a session leaves
    a straight bridge;
  - a session ends on its last observation when that falls after its last grid instant, and does
    not add a point when it does not;
  - a day whose only observation is an evening NAV is one point at the NAV's instant;
  - a statement dated inside the window changes the holdings from that day's instants on, and not
    before;
  - an account closed inside the window counts on the days it was open, on the daily line's terms;
  - an hourly grid plots `09:30`, `10:30` … `15:30`, a three-hourly one `09:30`, `12:30`, `15:30`,
    a 15-minute one 27 instants, given an observation in every step;
  - a grid instant in March and one in November, same wall-clock time, are seven and eight hours
    behind UTC respectively (daylight saving is Postgres's);
  - a day before the first position set scores `total: 0` on both branches, so the seam drops it;
  - the owner filter narrows both branches, and the account reader reaches only its account, at an
    instant and at a dated point alike;
  - an empty `dates` returns `[]` without a query.
- **Agreement.** In `tests/invariants/aggregates-agree.test.ts`, a grained line's dated point on a
  date and `netWorthAt` on that date agree on `amount` and coverage, as the daily series and the
  point query already must.
- **The seam.** The same seed the existing "window decides the reader" test uses, a third window:
  grained, and the answer is the observation's amount at its instant plus the first day's close
  flagged `dated`.
- **The chart.** A grained axis names days on its ticks and puts a time beside the date in an
  instant's readout and no time in a dated point's; a dated point is placed by its instant, not at
  midnight; the empty note falls through to the caller's sentence for a grained window.
- **The routes.** 1W on the Overview returns `session: { timeZone: "America/New_York", grained: true }`
  and instants among dated points; 1Y returns `null`; the hand-typed prefix is still drawn ahead of
  a grained line's first point when the window reaches it; the account page's 1W returns the same
  shape. The existing 1D tests do not change.

## Out of Scope

- **Choosing an older session as 1D.** Still deferred (ADR-0006, ADR-0014). A grained range draws
  older sessions inside a span; it does not offer one by itself.
- **Any change to 1D**: its sampling, its positions-now rule, its cost. ARCHITECTURE §10 prices it
  and spec 0016 owns it.
- **Any change to the date sampler** for spans over 92 days (ADR-0003).
- **Marking a gap** inside a session, or a partially priced date. The same silence as
  [issue #216](https://github.com/chethan123/portfolio/issues/216), one design for both, not here.
- **A grain the household can set.** The tiers are fixed; the refresh cadence stays the dial it is.
- **Compressing non-session time** on the axis. Weekends stay a flat stretch of real width, as they
  are on the daily line.
- **A migration-defined `holding_valued_at_instant`.** ADR-0001, and the chart reads totals.
- **Live updates.** The line is drawn once at page load (DESIGN §14).

## Alternatives considered and rejected

Recorded in ADR-0014: a point budget with thinning instead of fixed tiers; the poll as the grid; a
covered session's instants plus the spine's close; bridging a gap with flat points; today's
positions across the window; a migration-defined reader.

## Further Notes

- The grid is anchored at the open and the session's end is added as a point, rather than the grid
  being anchored at the close, because an hourly grid from `09:30` never lands on `16:00` and a
  close print's `as_of` is a few seconds past it anyway; the end point is what puts the close on
  the line, whichever grain.
- `holding_valued_at` compares `closed_at`, a `timestamptz`, with a `date`, so an account closed
  during a day counts on that day (`CONTEXT.md`, "Closed"). The instant branch applies the same
  comparison to the same date so the two branches cannot disagree about a closing account.
- The seam reads `MARKET_TIMEZONE` rather than the window carrying it, because `resolveRange` is
  pure and tested without an environment, and every caller of the seam already has the config in
  hand.

## Acceptance

- [ ] 1W, 1M and 3M on the Overview and on an account page draw instants inside each observed
      session at 15 minutes, an hour and three hours, dated closes on the other days, and the
      first day's close first
- [ ] 1Y, 5Y, All and 1D are unchanged, to the character, on the same data
- [ ] The dated points of a grained line equal the daily line's points for those dates
- [ ] A gap inside a session is a straight bridge; a weekend is a flat carry-forward
- [ ] Readouts name a time only for an instant; ticks name days
- [ ] The owner filter narrows both kinds of point
- [ ] The 3M line on the harness household is measured and the figure recorded in
      `ARCHITECTURE.md` §10
- [ ] Every document under "Documents this change makes false" is true again
- [ ] `npm run typecheck`, `npm test` and `npm run build` are green
