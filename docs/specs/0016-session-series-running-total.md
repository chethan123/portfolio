# The 1D line as a running total over the session's observations

Canonical here. Diagnosed in
[`../research/2026-09-01-overview-1d-latency.md`](../research/2026-09-01-overview-1d-latency.md),
which records the evidence and the harness that produced it; when the two disagree, this file wins.

See [ADR-0006](../adr/0006-intraday-quotes-are-an-observation-log.md) for what an observation is
and why 1D plots every one of them, [spec 0015](0015-chart-series-assembly.md) for the read seam
the 1D line comes through, and [ADR-0008](../adr/0008-the-owner-filter-is-a-household-wide-view.md)
for why the reader takes the owner filter where it does.

## Problem Statement

The Overview with 1D selected takes about eleven seconds to answer, cold load and client-side
navigation alike, on a household of 21 open accounts and 97 holdings. The whole of that time is one
statement: the session series in `readSessionSeries` (`app/lib/valuation.server.ts:679`), which
`chartSeries` (`app/lib/chart-series.server.ts`) reads for the household surface and the account
surface both. Every other query the Overview's loader runs answers in under fifty milliseconds, and
the same household's 1Y line — 180 dates through `holding_valued_at` — answers in about a hundred
and twenty.

The query values every holding at every distinct instant of the session. For each `as_of` in the
session (`valuation.server.ts:697`) it joins the positions held now (`:709`), and for each of those
runs two correlated lookups: the latest observation at or before the instant (`:714`) and the last
close strictly before the session (`:724`). That is a nested loop of instants × holdings, with two
index probes per pair and a `latest_position_set` call per account per instant. `EXPLAIN ANALYZE`
on the measured household at the seeded cadence shows 157,140 inner rows and 1.3 million buffer
hits for one render.

**The cost model in `ARCHITECTURE.md` assumed an instant is a poll.** Its trade-off table says a
session is "~27 instants at the seeded cadence" and that "~390 instants at 1 minute puts the query in
the hundreds of milliseconds"; the paragraph after it counts the lateral "about twenty-seven
instants a session". But `as_of` is the provider's instant for *each instrument* — the moment the
provider says that price was struck, never the poll time (ADR-0006; the header of
`migrations/0009_price_observation.sql`). A feed stamps each instrument's last trade separately,
so one poll of a hundred feed instruments yields up to a hundred distinct instants, and a session
holds roughly polls × instruments of them, not polls. The demo household never showed this because
`scripts/seed-demo.ts` gives every instrument the same instants (27 instants, 222 rows).

Measured on a local Postgres 16, the demo scaled to the reported shape — 21 open accounts, 97
holdings, 98 feed instruments — with each instrument carrying its own seconds on `as_of`:

| Refresh cadence | Distinct instants in the session | Session series query |
|---|---|---|
| 15 minutes (the default) | 1,620 | 3.5 s |
| 5 minutes | 4,740 | 10.1 s |
| 1 minute | 23,460 | 48 s |

Forty-two sessions of history instead of one left the 15-minute figure unchanged: the term that
grows is instants × holdings, not the table. The reported eleven seconds is the 15-minute row on a
slower host with genuinely distinct seconds on every instrument.

**Why every visit pays it.** The chosen range persists in the range cookie
(`RANGE_COOKIE`, `app/lib/chart-range.ts:406`), stamped by `chartRangeMiddleware` on both chart
routes (`app/routes/overview.tsx:78`, `app/routes/account.tsx:71`). Once 1D is picked, every
Overview render — a cold document and a `.data` navigation from Analysis both — runs the same
loader and the same statement. Analysis reads the `holding_valued` view at "now" and draws no
series, which is why it feels fine. The service worker is a passthrough that never sees loader
requests (ADR-0007) and is a bystander.

The regression dates to commit `4ee217a` ("Value a household and an account at each instant of a
session"), which introduced the reader.

## Solution

Compute the same series as a **running total over the session's observations of held
instruments**, instead of re-valuing every holding at every instant. One statement, still inline in
`readSessionSeries`, still a raw `sql` template with the narrowing passed in exactly as today; the
public readers `netWorthSessionSeries` and `accountSessionSeries` keep their signatures, and
`chartSeries` does not change.

The identity it rests on: the line at instant *T* is the sum over holdings of
`cast(quantity × price(T) as numeric(20, 4))`, and each holding's `price(T)` is a step function that
moves only when its instrument is observed. So the total at *T* is the total at the open plus, for
every observation at or before *T*, that holding's new rounded value minus its previous rounded
value. The differences telescope exactly in `numeric` — no float anywhere, and the rounding stays
per holding, which is what makes the sums identical to the character rather than merely close.

Work becomes O(holdings × observations of held instruments) + O(instants), rather than
O(instants × holdings) with two probes per pair. On the measured household at the seeded cadence
the prototype answered in 14 ms against 3.5 s, and returned the identical 1,620 rows.

## User Stories

1. As the household, the Overview with 1D selected renders in well under a second at any cadence
   the Settings dial allows, on any number of accounts a household plausibly has.
2. As the household, the line is the same line: the same instants, the same amounts to the last
   digit, the same coverage at every point, on both chart surfaces and under the owner filter.
3. As a contributor, `ARCHITECTURE.md`'s account of what the 1D read costs, and of what grows it,
   is true.

## Implementation Decisions

**The definitions the current query encodes are preserved verbatim, and the new query is written
against them, not against its own convenience.**

- The instants are the distinct `as_of` values in `price_observation` with `market_date` equal to
  the session — from the log as a whole, never narrowed by the surface, so a cash-only account still
  draws its flat line at the household's instants (the reader's own docstring).
- The holdings are the positions held *now*: `holding` rows at `latest_position_set(a.id)` for
  accounts with `closed_at is null`, narrowed by the `where` the two public readers pass
  (`a.owner_id in (…)` or `a.id = …`). The alias `a` stays, because the narrowing is written
  against it.
- A holding's price at *T* is its instrument's latest observation with `as_of <= T` — from any
  date, not only the session — else the last `price_daily` close **strictly before** the session,
  else null. The strictness stays load-bearing for the reason §6.3 gives: the session's own daily
  row is provisional.
- `amount` is the sum of per-holding `cast(quantity × price as numeric(20, 4))`, coalesced to
  `0` over nothing; `known` counts holdings with a non-null price at *T*; `total` counts holdings.
  A holding with no price at *T* is in `total` and out of `known`, as everywhere else.
- One row per instant, ascending; a session with no observations yields no rows.

**The shape.** Common table expressions, in this order, each doing one thing:

```sql
with instants as (
  select distinct as_of from price_observation where market_date = ${session}::date
),
bounds as (
  select min(as_of) as first_at, max(as_of) as last_at from instants
),
held as (
  -- Positions held now, one row per holding: the per-holding rounding below
  -- is what the current query does, and keeping the grain keeps the sums equal.
  select held.position_set_id, held.instrument_id, held.quantity
  from account a
  join holding held on held.position_set_id = latest_position_set(a.id)
  where a.closed_at is null
    and ${narrowing}
),
opening as (
  -- The price in force when the session opens: the latest observation before
  -- the first instant, else the last close strictly before the session, else
  -- null — the same three-way rule the current query applies at every instant.
  select
    h.position_set_id, h.instrument_id, h.quantity,
    coalesce(
      (select o.price from price_observation o
        where o.instrument_id = h.instrument_id and o.as_of < b.first_at
        order by o.as_of desc limit 1),
      (select pd.close from price_daily pd
        where pd.instrument_id = h.instrument_id and pd.date < ${session}::date
        order by pd.date desc limit 1)
    ) as price
  from held h
  cross join bounds b
),
changes as (
  -- Every observation of a held instrument inside the session's span, with the
  -- price it replaced: the holding's previous observation in the span, else its
  -- opening price. `previous` is null only for a holding priced for the first
  -- time ever, which is the one case `known` moves.
  select
    o.as_of,
    op.quantity,
    o.price,
    coalesce(
      lag(o.price) over (partition by op.position_set_id, op.instrument_id order by o.as_of),
      op.price
    ) as previous
  from opening op
  cross join bounds b
  join price_observation o
    on o.instrument_id = op.instrument_id
   and o.as_of >= b.first_at
   and o.as_of <= b.last_at
),
deltas as (
  -- What the observations at one instant add to the total and to the priced
  -- count, rounded per holding exactly as the total is.
  select
    as_of,
    sum(cast(quantity * price as numeric(20, 4))
        - coalesce(cast(quantity * previous as numeric(20, 4)), 0)) as value_delta,
    count(*) filter (where previous is null) as known_delta
  from changes
  group by as_of
),
opening_total as (
  select
    coalesce(sum(cast(quantity * price as numeric(20, 4))), 0) as amount,
    count(price) as known,
    count(*) as total
  from opening
),
timeline as (
  -- Instants and deltas on one timeline. A plotted instant's running sum must
  -- take every delta at or before it, ties included: `sum(...) over (order by
  -- as_of)` with the default RANGE frame includes the current row's peers,
  -- which is exactly `o.as_of <= instants.as_of` restated.
  select as_of, true as plotted, cast(0 as numeric) as value_delta, cast(0 as bigint) as known_delta
  from instants
  union all
  select as_of, false, value_delta, known_delta
  from deltas
),
running as (
  select
    as_of, plotted,
    sum(value_delta) over (order by as_of) as value_delta,
    sum(known_delta) over (order by as_of) as known_delta
  from timeline
)
select
  r.as_of                                                   as at,
  cast(ot.amount + r.value_delta as numeric(20, 4))         as amount,
  ot.known + r.known_delta                                  as known,
  ot.total                                                  as total
from running r
cross join opening_total ot
where r.plotted
order by r.as_of
```

**`changes` is bounded by the span's instants, not by `market_date`, and the running sum is taken
over a timeline of instants and deltas together.** This is the one place the shape is more than the
minimum, and it is deliberate. The current query picks, at each instant, the latest observation
with `as_of <= T` from *any* row in the table. Bounding `changes` by `market_date = session` would
be simpler and, for rows the application writes, identical — `market_date` is `as_of` run through
`marketDateOf` at write time (`prices.server.ts`), which is monotonic in the instant for a fixed
`MARKET_TIMEZONE` — but it would make "same answer" conditional on that invariant holding for every
row the table has ever held. A rewrite whose only claim is *identical output* should be identical
on any data the table can hold, so the equivalence is a statement and not a caveat. The cost is
one `union all` and one more CTE. The timeline also carries the tie rule for free: a delta at the
same instant as a plotted point lands in that point's sum because RANGE framing includes peers,
without an explicit ordering between the two kinds of row.

**Window filtering happens one CTE later than the window.** `where r.plotted` is in the final
select, over `running`, not in `running` itself: a `WHERE` is evaluated before window functions
and would drop the delta rows before they were summed. The two-step shape is the correctness
condition, not style.

**`opening` is read twice and is therefore materialised**, as Postgres does for any CTE referenced
more than once. It holds one row per holding — hundreds at most — so this is the cheap direction;
the alternative, inlining it into both readers, would run the two opening lookups twice per holding.

**No migration, no schema object, no index.** ADR-0001's row-type contract is the reason the
session read was written inline rather than as a migration-defined sibling of `holding_valued_at`
(§6.3), and nothing here changes that. Every lookup the new shape makes already rides an index that
exists: `price_observation_pkey` for the opening observation and for the per-holding range scan
over the span, `price_daily_pkey` for the opening close, `position_set_account_as_of_idx` inside
`latest_position_set`. `price_observation_market_date_idx` still resolves the instants.

**`at` still crosses as a `Date` and is stringified in the mapper**, `known` and `total` still
arrive as `int8` strings and become numbers there, `amount` is still a `numeric(20, 4)` string.
The mapper at the foot of `readSessionSeries` does not change.

**The number of points is unchanged, and so is the payload.** One point per distinct instant is
what 1D means (`CONTEXT.md`, ADR-0006). At the measured shape that is 1,620 points and about
97 KB of loader data at the seeded cadence, 23,460 points at one minute. This change removes the
cost of *computing* the points; whether a session should be drawn at polls × instruments points at
all is a design decision this spec does not take (Out of Scope).

## Documents this change makes false

Each of these states, today, something that stops being true, and each is part of the change
rather than a follow-up:

- `ARCHITECTURE.md`, the trade-off table row "The 1D line unsampled, one point per observation"
  (§7): "~27 instants a session at the seeded cadence" and "~390 instants at 1 minute puts the
  query in the hundreds of milliseconds" both rest on an instant being a poll. The row's "Right here
  because" needs the real count — polls × feed instruments — and its "Would break at" is now the
  observation count, with a much smaller constant.
- `ARCHITECTURE.md`, the "Three indexes carry the read path" paragraph and the paragraph after it,
  "The 1D line is one round trip too, and its cost is per instant rather than per date": the 1D
  reader no longer runs a lateral once per holding per plotted instant. Its cost is per observation
  of a held instrument, plus one pass over the instants.
- `ARCHITECTURE.md` §5, the index table's `price_observation_pkey` row: the key is no longer
  "matched exactly by the 1D reader's lateral, once per holding per plotted instant". It is matched
  by the opening lookup once per holding and by the range scan over the span once per holding.
- `ARCHITECTURE.md` §6.3, "The three intra-session reads are the module's second front": "They
  mirror `readSeries`'s lateral shape, narrowing and all" is no longer so. The narrowing now sits in
  the holdings CTE, for the same reason it sat inside the lateral — an instant with no held rows
  must still be a point.
- `ARCHITECTURE.md` §4.2's pointer to `valuation.server.ts:793` for `readSessionSeries`, and any
  other line-numbered pointer into that function, which moves.
- `app/lib/valuation.server.ts`, the docstring on `readSessionSeries`: the three decisions it
  states stay true and stay; the sentences that describe *how* — the per-instant lateral — go, and
  the identity above takes their place.
- `docs/specs/README.md` — a row for this spec.
- `docs/research/README.md` — a row for the report, if the index carries one per report.

Deliberately *not* on this list: `migrations/0009_price_observation.sql`'s header, which says the
per-instrument lookup "needs no index of its own" because the primary key matches it. That remains
true of both lookups the new shape makes, and a migration's text is not edited after it has been
applied. `docs/operating.md`'s "Growth and limits" is about disk, says nothing about latency, and
stays.

## Testing Decisions

**The existing suite is the equivalence test, and it is not edited.** Every case in
`tests/dashboard-queries.test.ts`'s "the 1D series", `tests/account-queries.test.ts`'s session
cases, `tests/chart-series.test.ts` and `tests/valuation-owner-filter.test.ts` states a rule of the
current query in exact decimal strings. A green run with zero diff in those files is the evidence
that the answer did not move. That is the acceptance criterion that makes this a rewrite.

**New cases pin the shapes the demo never produced and the seams the rewrite introduces**, in
`tests/dashboard-queries.test.ts` beside the existing 1D cases, house style — `withDatabase`, the
builders in `tests/support/fixtures.ts`, exact decimal strings at the stored scale, `it` sentences
that state the rule:

- **Instruments observed at different instants** — three held instruments, each with its own
  seconds on `as_of`, no two observed at the same instant. Every instant is a point, and each point
  prices every holding at what was known then: the ones not yet observed at yesterday's close, the
  observed ones at their latest observation. This is production's shape, and no test today has it.
- **A holding priced for the first time mid-session** — an instrument with no close before the
  session and no earlier observation, first observed at the second instant. `known` steps up by one
  at that instant and the amount includes it from then on; before it, the holding is in `total`
  and out of `known`.
- **An earlier session's observation is the opening price** — an instrument observed yesterday
  evening and not observed today, with a close before the session that differs from that
  observation. The line prices it at the observation at every instant, never at the close: the
  observation is the later of the two, and the rule is "latest observation at or before the
  instant, from any date".
- **Rounding is per holding** — two accounts each holding `0.00005000` of one instrument observed
  at `1.0000`. Rounded per holding each is `0.0001`, so the point is `0.0002`; rounded once over
  the summed quantity it would be `0.0001`. The current query rounds per holding; this pins that the
  rewrite still does.
- **A change at the same instant as another instrument's observation** — two instruments observed
  at exactly the same `as_of`, once. One point, priced with both, not two points and not one that
  misses a delta. This is the peers rule the timeline relies on.

The owner-filter narrowing and the account surface are already asserted at their seams and are not
restated. No test asserts timing: a wall-clock assertion is the flake the house style refuses, and
the research report is where the numbers live.

**`npm run typecheck`, `npm run build` and `npm test` are the gates**, as always. The change
touches no route and no client bundle, so `build` is expected to be silent; it runs because that
is the rule.

## Out of Scope

- **Fewer points.** Bucketing a session's instants to the poll, or sampling the 1D line, would
  divide the point count and the payload by the instrument count. It contradicts what 1D means
  today (one point per observation, ADR-0006) and is a design decision with its own consequences
  for the readout and the axis. This spec makes the line cheap to compute and leaves how many
  points it has exactly where it was.
- **The root loader's two serial reads** (`firstRunStep`, then `readMaskingPolicy`) on every
  navigation. Tens of milliseconds; a separate, trivial change if wanted.
- **Response compression.** The Caddyfile has no `encode` directive and documents go out
  uncompressed. Unrelated to the eleven seconds, which are all server time.
- **The dated series.** `readSeries` and `holding_valued_at` are untouched; 180 dates is a
  hundred-odd milliseconds and is not the problem.
- **`netWorthChange`'s documented disagreement with the 1D line** over what `since` means, exactly
  as spec 0015 left it.
- **A `CONTEXT.md` entry.** Nothing here resolves a dispute about a word. "Instant" is used
  throughout in ADR-0006's sense and stays undefined in the glossary until somebody needs it
  defined.

## Further Notes

**The prototype's equivalence check**, run against the scaled demo before this spec was written:
the current and the new statements each into a temporary table, then `except` both ways. Zero
rows either way, on three datasets — the scaled household at the seeded cadence; the same with
two earlier sessions of observations, so the opening comes from an observation rather than a
close; and that with one held instrument stripped of every close before the session, so `known`
steps mid-session (from 91 to 94, three holdings sharing the instrument). The harness that produced
the table above and this check lives beside the research report, written to run only against a
throwaway database.

**Why not a migration-defined function.** §6.3 already answers it for the current query, and the
answer does not change: a third valuation object would be bound by ADR-0001's row-type contract
for no gain, and an inline statement in the one module allowed to value from the observation log
is the single site the design asks for.

**What to expect on the account page.** `accountSessionSeries` shares the reader and gets the same
shape; its holdings CTE is one account's rows, so it was cheaper before and is cheaper still.

## Acceptance

**Blocked by:** Nothing. It touches one function, its tests and the documents above.

**Status:** ready-for-agent

- [ ] `readSessionSeries` computes the series in the shape above: one statement, the narrowing
      inside the holdings CTE via the existing `where` parameter, `at` a `Date` stringified in the
      mapper, `known` and `total` numbers from `int8` strings, `amount` a `numeric(20, 4)` string
- [ ] `netWorthSessionSeries` and `accountSessionSeries` keep their signatures; `chartSeries` and
      both routes are untouched
- [ ] Every existing test passes with zero diff to any existing test file
- [ ] The five new cases above exist, each an `it` sentence stating its rule, and pass
- [ ] The `ARCHITECTURE.md` passages listed are amended so that each sentence is true of the new
      shape, and the `valuation.server.ts` docstring describes the identity rather than the lateral
- [ ] `docs/specs/README.md` carries a row for this spec
- [ ] The research report and its harness are filed under `docs/research/` per
      `docs/README.md`'s layout, the harness refusing to run against a database whose name does
      not mark it throwaway
- [ ] `npm run typecheck`, `npm run build` and `npm test` are green
