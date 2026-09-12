# Analysis visualizations — feasibility of the 2026-09-11 opportunities, and a proposal

**Date:** 2026-09-12. **Against:** `25245de`.
**Read:** [`2026-09-11-analysis-visualization-opportunities.md`](2026-09-11-analysis-visualization-opportunities.md);
`DESIGN.md` §3, §4.4–4.5, §7, §8.1–8.4, §13.3, §14; `ARCHITECTURE.md` §4, §5.6, §6.3, Appendix A;
`CONTEXT.md`; ADR-0001, -0003, -0004, -0006, -0008, -0010, -0011; every file in `migrations/`;
`app/lib/allocation.ts`, `holdings-view.ts`, `valuation.server.ts`, `chart-series.server.ts`,
`chart-range.ts`, `settings.server.ts`, `price-provider.server.ts`, `prices.server.ts`;
`app/routes/analysis.tsx`, `overview.tsx`, `holdings.tsx`, `income.tsx`, `settings/**`;
`app/components/breakdown.tsx`, `net-worth-chart.tsx`; `server/price-worker.ts`, `yahoo-client.ts`,
`egress-proxy.ts`; [`2026-08-19-screen-recommendations.md`](2026-08-19-screen-recommendations.md),
[`2026-08-19-fire-data-layer-design.md`](2026-08-19-fire-data-layer-design.md) and the
[2026-09-01 aggregation audit](2026-09-01-net-worth-aggregation-audit.md); open issues #161, #174,
#180, #182, #216; and `yahoo-finance2@4.0.2`'s own source (`node_modules` is absent in this
checkout, so the pinned tarball was read directly; Yahoo, iShares and SEC hosts are blocked from
here, so nothing was verified live against a fund symbol).

Every citation below was checked by a second pass whose corrections are folded in; where that pass
overturned a finding, the finding is rewritten rather than quietly dropped, and §"What the second
pass overturned" says how.

The research document was already grounded twice before it landed. This pass asked a different
question — not "is each sentence true" but "what would it cost to build, what data is missing, and
where does the design record already have an opinion" — and found the document accurate about the
schema and the code, and silent about the three things that decide the shape of the work:
DESIGN.md §8.3's slot warning, the five-hue colour rule, and the price worker's role in any fetched
metadata.

## Verdict

**Three of the five ranked views are buildable today on stored data with no migration:** asset class
by tax treatment, largest positions across accounts, and asset class through time. The first two
are one grouping call over the read Analysis already makes; the third is one new dated reader
through the chart seam. All three share one bar component, which already exists on Overview.
**Target versus actual needs one table, one Settings tab and two glossary entries** — the prior
FIRE data-layer research already sketched the table. **Fund look-through is a separate data
project**, as the document says, and the cheapest fetchable source (Yahoo's top ten) cannot answer
the overlap question it exists for.

Two of the lower-priority items change rank once the repository is read:

- **Fee exposure may be closer than the document thinks.** The library's ETF quote type declares a
  `netExpenseRatio` field, the worker requests every field, and the per-symbol entry is archived in
  `price_observation.payload`. If a live instance's archive carries it, promoting it is a migration
  in the `annual_dividend` shape; only mutual funds need a new worker call. Whether Yahoo populates
  the field is the one fact this checkout cannot settle, and ticket 05 starts by settling it.
- **The donut-to-bars presentation change is not "presentation only".** It touches the one
  component that enforces the colour rule and the argued grey-tail fold.

The proposal below orders the work as four tickets on stored data, one on data the app may already
receive, and defers look-through with a stated route in. Two decisions belong to the owner before
the first spec is written: whether fixed panels or the saved-view builder answer §8.3, and which
denominator the new panels state.

## What the repository confirms

Verified rather than assumed, per opportunity. "Present" means on the `holding_valued` row every
Analysis read already returns (`app/lib/valuation.server.ts:20-48`).

| Opportunity | Data present | Data missing | Code reused | Code added |
|---|---|---|---|---|
| 1. Asset class × tax treatment | `asset_class`, `tax_treatment`, `value`, `is_priced` on every row (`migrations/0006_annual_dividend.sql:12-33`) | nothing | `currentHoldings(reading)`; `allocationBy` with a composite key (`allocation.ts:94-124` takes any `Grouping`); the two marginals Analysis already computes; Holdings drill-down (filters already AND: `holdings-view.ts:353-360`) | a stacked variant of Overview's bar rows; a per-category colour map |
| 2. Target vs actual | actual weights (`allocationBy(holdings, groupingBy("assetClass"))`, `analysis.tsx:163`) | **any stored target** — no table, no column; `app_setting` is a single row of typed columns (`migrations/0005_app_setting.sql:2-15`) | `settings/tax.tsx` end to end as the form pattern; `formatPercent`'s explicit sign (`format.ts:122`); `SHARE_SCALE` maths | migration; a target reader/writer; Settings tab; drift maths in `allocation.ts`; a marker on the bar |
| 3. Largest positions | `instrument_id`, `symbol`, `instrument_name`, `value`, `account_name` per row; one row per instrument per account (`migrations/0001_initial_schema.sql:129`) | nothing | `allocationBy` with an instrument `Grouping`; the bar rows | nothing structural — but the instrument grouping sits outside the registry every other panel reads (`holdings-view.ts:2` leaves `instrument` out on purpose; `analysis.tsx:160`) |
| 4. Look-through | `quote_type` (ETF/MUTUALFUND/EQUITY, refreshed: `prices.server.ts:591-604`) | constituents, weights, as-of, canonical issuer key, sector, region, coverage — none anywhere (`database.generated.ts:207-228`) | instrument identity only | tables, a reader, an ingest or fetch path, a coverage type |
| 5. Asset class through time | `holding_valued_at(d)` returns `asset_class` (`migrations/0006:68-127`); the batched lateral in `readSeries` (`valuation.server.ts:339-373`) | dated classification (single mutable FK, `0001:66-68`); trades between statements (§3) | `readSeries`' shape; `chartReach`/`chartWindow`; the range control; `gridRules`, `tickLabel` (to be exported), masking from `net-worth-chart.tsx` | a grouped series reader; a categorised point type; a stacked-area component |
| Fee exposure | `QuoteEtf.netExpenseRatio` is declared (`yahoo-finance2` `quote.d.ts:355-363`); the worker requests every field (`server/yahoo-client.ts:64-67`); the response is archived (`prices.server.ts:677-699`) | a typed column; mutual-fund ratios; **proof the field is populated** | `writeQuote`, `yahooQuote` Zod, the `annual_dividend` view-column precedent | one promotion migration; later a `quoteSummary` worker route |
| Unrealized-gain bars | `cost_basis`, `unrealized` per row | nothing, but basis is nullable by design (`0001:125-126`) and the view refuses to coalesce it (`0002:46`) | the gains table's coverage count; the bar rows | nothing structural |

Facts the document states that hold, and are load-bearing: every instrument has a classification
(`classification_id` NOT NULL, `0001:66-68`); filters do not exclude negative positions
(`holdings-view.ts:353-360`, no sign predicate); the four panels are four calls over one read
(`analysis.tsx:161-164`); shares are of the gross positive total and buckets net signed holdings
(`allocation.ts:8-15`, `:56-58`); a reclassification redraws the whole past
(`0006:109` joins the live `classification`); the app records positions, not transactions
(`DESIGN.md:53-70`).

## Findings

### F1 — §8.3 already ruled on "a fifth panel", and the document does not engage it

`DESIGN.md:685-694`, on the fourth Analysis panel: "it does spend one of the slots this warning
counts, and the next cut that cannot be had that cheaply is the builder's cue, not a fifth panel's."
Opportunities 1, 3 and 5 are each an instance of the `View` shape that section sketches
(`dimensions`, `chart: 'bar' | 'area'`, `timeAxis`; `:704-716`). The document proposes three fixed
panels without naming the warning.

The builder is not the cheaper answer here. Its stated remaining work is persisting the Holdings
table's state, a measure picker and revisiting no-materialisation (`:718-722`;
`ARCHITECTURE.md:2134` adds absorbing the five array calls). The record does not say so, but the
shape's `chart: 'area'` with a `timeAxis` implies a generic grouped time-series renderer that
nothing today provides. And none of the three views is a plain instance: view 1 wants a crossed
table with a stated denominator, view 3 wants the one dimension `holdings-view.ts` declines by
design, view 5 wants per-date-per-class coverage. A builder would render each and label none.

The honest slot count for the whole proposal: ticket 01 *replaces* the asset-class donut (its
marginal is the donut's table), so it adds none; tickets 02, 03, 04 and 05 each add one panel. Four
new panels against a warning written for "a fifth". Either the owner accepts that Analysis becomes
a page of eight panels and §8.3 is amended to say why fixed panels won, or the cue is taken and
tickets 02 and 04 wait for the builder (03 and 05 are not `View` instances — a target marker and a
fee measure are outside its shape).

**Recommendation:** fixed panels, and amend §8.3 in the first PR so the decision is recorded rather
than eroded. This is the first owner decision (§"Two decisions").

### F2 — Stable colours are possible for asset class and tax treatment, and impossible for classification

The document asks for "stable category colours" as a presentation preference (l. 168). The record
makes it structural: §13.3 fixes **five hues and no more**, validated mechanically under two forms
of colour-blindness (`DESIGN.md:1312-1322`), and `breakdown.tsx` is one component *because* the
same-rank-same-colour rule "is enforced by nothing except there being one implementation"
(`ARCHITECTURE.md:2275`; `breakdown.tsx:18-23`). Overview's bars obey the same rule
(`overview.tsx:209-210`, `categoryColor(index)`).

Asset class is a closed four-value rollup (`0001:45-47`; `CONTEXT.md:54-59`). Four fits inside
five. A fixed map — equity → hue 1, bond → 2, cash → 3, other → 4 — stays inside the validated
sequence and is stable across every panel and every date. `other` is a real category ("cannot be
split further", `CONTEXT.md:57-58`), not a merged tail, so it earns a hue rather than §13.3's grey,
which is reserved for "a merged remainder" (`DESIGN.md:1326-1332`). Tax treatment (three values)
fits the same way. **Classification cannot be stable**: the demo alone has thirteen
(`scripts/seed-demo.ts:91-104` plus the seeded `Cash`), and thirteen distinguishable hues do not
exist under the §13.3 method.

So: one new rule beside the existing one. *Category colour for the closed rollups wherever they
appear; rank colour for open sets.* That is an `assetClassColor()` sibling to `categoryColor()`, an
amendment to §13.3, and no change to the owner, account-type and classification donuts.

### F3 — Asset class through time needs no migration; the reuse target is `readSeries`; "monthly" is a new grid; 1D is out

Corrections to l. 116-124:

- `holdingsAt` (`valuation.server.ts:170-176`) is a single-date row reader **no chart calls** (only
  tests do). Building on it is the one-query-per-date anti-pattern the same sentence warns against.
  The batched pattern is `readSeries` (`:339-373`): `unnest(dates)` + `LEFT JOIN LATERAL
  holding_valued_at(d.date)` + `GROUP BY d.date`, with the owner narrowing **inside** the lateral
  (`:355`) so an uncovered date keeps its row. `holding_valued_at` already returns `asset_class`,
  so the grouped series is that query with `v.asset_class` added to the select and the group-by —
  plus two things the addition changes: the LEFT JOIN's manufactured all-null row for an uncovered
  date becomes a NULL-class group that must be dropped, and coverage becomes per date *across*
  classes, not per group. **No SQL function, no migration.**
- Since spec 0015, a chart's series is read only through `app/lib/chart-series.server.ts`
  (`ARCHITECTURE.md:2183`), which owns the `coverage.total > 0` rule (`chart-series.server.ts:57-64`).
  The new reader sits beside `netWorthSeries` and is called from there, not from a loader; the rule
  is restated for a stack — a date is kept when its total across classes is covered.
- There is no monthly grid. §8.3's `View` sketches `timeAxis: 'monthly'` (`DESIGN.md:710`); nothing
  implements it. `sampleWindow` (`chart-range.ts:135-162`) emits every day inside a 180-sample
  budget, else 180 dates decaying geometrically from the window's end (ADR-0003). A stacked area
  over that grid is fine; a "monthly" chart is a second sampler and a second decision. Drop the word.
- **1D has no grouped reader.** `chartSeries` routes a session window to `netWorthSessionSeries`
  (`chart-series.server.ts:44-55`), which values from the observation log (ADR-0006; the §4.2
  exception at `ARCHITECTURE.md:428-435`). A grouped session reader is a second query over that
  log. The range control already renders an unreachable preset disabled (`ARCHITECTURE.md:2273`);
  this panel disables 1D and says why.

Two shipped rules also bind it: a grouped view does not draw the hand-typed prefix (`DESIGN.md:540-546`,
rule 3 — "the manual series has no structure to slice"), and interaction is pre-rendered per point
(ADR-0004). Four classes × 180 points is ~720 readout rows; fine, but a dollars/percent toggle is
URL state and meets F6.

### F4 — Targets need a table; the prior sketch is the shape, minus one column; bank cash is in

`app_setting` is one row of typed columns (`0005:2-15`, singleton via `check (id)`), not key/value,
so a per-category target set cannot sit there.
[`2026-08-19-fire-data-layer-design.md:107-145`](2026-08-19-fire-data-layer-design.md) sketches
`allocation_target` — `asset_class` or `classification_id` (exactly one non-null), `weight
numeric(7,6)` at `SHARE_SCALE`, partial unique indexes per dimension, household-wide, sum-to-100 %
enforced by making the only write a whole-set replace. Nothing of it was accepted into a spec
(`docs/specs/README.md`'s table runs 0001–0021 without it).

The research document says "support one target dimension first" (l. 72-73); the sketch argues both,
because classification is "the only level at which 70 % US / 30 % international *within equity* can
be expressed" (`:126-129`). Both are right about different things. **Recommendation:** asset class
only, and the table says so — `asset_class text primary key` under the same CHECK as
`classification.asset_class`, and `weight`. The sketch's second key column, its `num_nonnulls`
CHECK and its partial indexes would ship as a FK nothing writes or reads; migrations are
forward-only, and widening is a later migration if classification targets are ever wanted. Asset
class is closed and CHECK-constrained, so a target set over it cannot drift; classification is an
open label set the household grows at upload time, so a target set over it needs a "new
classification has no target" rule the first slice should not carry.

The denominator is the sketch's `investableBase` — holdings in non-`liability` accounts, derived
from `account.kind` by an exhaustive map (`:31-42`), never a stored flag. **That map has `bank:
true`**, so bank cash is inside the base and counts toward the `cash` weight. The research document
wanted emergency cash kept out of the denominator (l. 70-72); this proposal does not do that,
because the only mechanism is the per-account boolean the sketch argues against (`:19-24`), and the
panel says in words what the base contains. Weights are `class net amount ÷ investable base`, which
is not `AllocationSlice.share` (`:47-62` gives the three reasons).

Placement: the drift maths belong in `allocation.ts` beside `weightedYield` and
`unrealizedByAssetType`; the table's reader and whole-set writer are a `targets.server.ts` of their
own, since `settings.server.ts`'s header describes one seeded row (`settings.server.ts:1-3`).

### F5 — Analysis already runs two denominators; a third must be named, not assumed

The `% of total` column divides by the gross positive bucket total (`allocation.ts:56-58`); the
figure in the donut's centre is `netWorth().amount`, net of liabilities (`analysis.tsx:152` →
`breakdown.tsx:100-107`); a conditional note reconciles them when a bucket is negative
(`breakdown.tsx:116-121`). The 2026-09-01 audit confirmed the arithmetic and named the reading:
"a share is a share of *gross assets*" (`2026-09-01-net-worth-aggregation-audit.md:611-615`).

The document then asks view 1 to "show liabilities separately from positive asset composition" and
view 3 to use "positive priced assets within the selected scope" — a third and a fourth rule on one
screen. `tests/invariants/aggregates-agree.test.ts:366-393` compares Analysis and Holdings
bucket-for-bucket on amount, share and coverage, `byAssetClass` included; a panel with its own rule
either leaves that invariant or forks it.

**Recommendation:** views 1 and 3 keep the shipped rule — buckets net, shares are of the gross
positive total, a negative bucket is a row with a hollow dot and the existing caveat — and say so.
The odd case the prior research found (a loan recorded as negative `USD` nets inside `cash`,
`fire-data-layer-design.md:7-17`) is the asset-class donut's behaviour today, documented to the
household (`docs/guide/analysis.md:28-39`); view 1 inherits it rather than inventing a second
answer, and keeps `byAssetClass` in loader data as the crossed table's marginal so the invariant
test passes untouched. View 2 is the one place a different base is *required* (F4), and it is
labelled as such. This is the second owner decision.

### F6 — The Analysis owner control drops any new query state

`analysis.tsx:196` renders `<OwnerFilterControl … hidden={{}} />`. The control is a GET form that
submits only its own field plus `hidden` (`owner-filter-control.tsx:49-50`, `:78-80`). Holdings
threads its filters through `hiddenFields` (`holdings.tsx:459-472`). Any view that adds URL state —
a range for view 5, an expanded bar for view 3, a dollars/percent toggle — is silently reset on owner
switch unless Analysis does the same. One line per ticket; worth a checklist item.

### F7 — Two open bugs surface first in a grouped history

- **#216**: `readSeries` computes per-point coverage and the chart discards it, drawing a 2-of-18 date
  as a solid line. A stacked area makes this *visible* — the stack is shorter — which is the honest
  outcome, but a 100 % view would draw a confident full bar over the same date. Another reason to
  ship dollars first (F3).
- **#182**: `holding_valued_at` counts an account on its closing date; `holding_valued` does not
  (`0006:125-126` against `:57`). The last point of view 5 disagrees with the panels above it on
  that one day, exactly as Overview's chart does today. View 5 inherits the bug; it does not need to
  fix it, and its spec should cite it.

### F8 — Fee data for ETFs is declared, requested and archived; whether it is populated is unproven

`yahoo-finance2@4.0.2`'s `QuoteEtf` declares `netExpenseRatio?: number` — **"Net expense ratio
percentage"** (`quote.d.ts:361-362`) — and the worker requests no `fields` filter
(`server/yahoo-client.ts:64-67`), so if Yahoo sends it, it lands in the archived payload
(`prices.server.ts:677-699`, 32 KB cap, parse-succeeded rows only). The field is optional in the
type and this checkout cannot reach Yahoo, so "arrives on every refresh" is a hypothesis, not a
finding. It is a cheap one to test on a live instance:

```sql
select i.symbol, o.payload ->> 'netExpenseRatio'
from price_observation o join instrument i on i.id = o.instrument_id
where i.quote_type = 'ETF' order by o.as_of desc limit 20;
```

If populated, ADR-0006 names the way out: "a figure needed for arithmetic is promoted to a typed
`numeric` column in its own migration" (`0006-…md:41`). The `yahooQuote` schema
(`price-provider.server.ts:105-117`) and `writeQuote` (`prices.server.ts:559-585`) are the two
sites to extend, and `annual_dividend` (`migrations/0006`) is the precedent for the view column —
with two deliberate differences. **The unit:** it is a percentage (0.03 = 0.03 %), the same trap
the schema already flags for `dividendYield` (`price-provider.server.ts:111`, "silent 100x error"),
so the column is `net_expense_ratio_pct` and the ÷100 happens in the view's SQL, never in JS (§5.6).
**The null:** `annual_dividend` coalesces a missing rate to zero, which migration 0006 itself calls
"the exception to that honesty" (`0006:63-64`; `DESIGN.md` §14.9); a fee column stays null and is
counted in coverage.

**Mutual funds** (`quoteType: MUTUALFUND`, `quote.d.ts:424-432`) carry no fee on the quote.
`quoteSummary(symbol, { modules: ["fundProfile"] })` returns
`feesExpensesInvestment.annualReportExpenseRatio` / `netExpRatio` / `grossExpRatio`
(`quoteSummary-iface.d.ts:471-479`), unit undeclared. It hits the same host and crumb path as
`quote()` and passes the egress allowlist unchanged (`egress-proxy.ts:28-37`). What it costs is
everything ADR-0010 puts between the app and the network: a worker route with its own Zod body,
symbol check and rate cap (`price-worker.ts:51-58`, `:193-232`), a `YahooClient` method, an
`AskKind` with a budget (`provider-socket.server.ts:28-43`), a provider-seam method plus fakes, and
one writer under a §4.2 row. One symbol per call, unlike quotes' hundred. CITs and manual-price
instruments have no source at all and stay "unknown".

The document's "if maintained expense-ratio metadata is added" (l. 136) is therefore imprecise
twice: the ETF data may be unpromoted rather than absent, and "maintained" (hand-kept) is the
*harder* path — there is no per-instrument edit screen to keep it on (F11).

### F9 — Yahoo's top ten cannot answer overlap; full constituent lists arrive as uploads

`topHoldings` returns `holdings[]` (symbol, name, percent), `sectorWeightings` (eleven keys),
`bondRatings`, the stock/bond/cash split — with **no as-of date** (only a cache `maxAge`) and
**no region weights** (`quoteSummary-iface.d.ts:835-896`). The type bounds nothing about ten;
Yahoo's page section is titled "Top 10 Holdings" and ten is what it is generally reported to
return (unverified here). Ten names cover roughly a third of a total-market fund's weight
(unsourced; the argument does not depend on the figure); the overlap question ("am I buying the
same companies through several funds") is unanswerable on the remainder, and the coverage rule
(`ARCHITECTURE.md:1475-1478`) counts an unknown in `coverage.total` rather than letting it be
spread over what is known.

Full lists exist in two places, neither fetched, both from general knowledge rather than this
checkout: issuer holdings CSVs (iShares daily; Vanguard daily for ETFs and month-end for mutual
funds; per-issuer formats with preamble lines and nested funds for target-date products) and SEC
Form N-PORT (filed monthly; only the fiscal quarter's third month is made public, about 60 days
after quarter end, so the public series is quarterly; XML; public domain). The issuer CSV lands
the way a statement does — an upload the household downloaded itself, a tolerant parser per issuer
with fixtures, no network — which is the pattern `docs/security.md` §1 already argues for. That is
the route in if look-through is ever built.

A cheaper intermediate with full coverage is the fund's **sector weights** from `sectorWeightings`:
eleven sector keys (what they sum to is unverified here), one `quoteSummary` call per fund, the same
worker route F8 needs. It answers "how much technology am I holding through funds" without naming
a company. It is not what the document asked for; it is what the fetchable data can honestly
support. If built, "sector" needs a glossary entry — `CONTEXT.md:59` avoids it only as a synonym
for asset class.

### F10 — Vocabulary

`CONTEXT.md:8`: terms are added when resolved, not pre-emptively. The document uses several
non-glossary words where a glossary word exists, and several new words the proposal must either
name or avoid:

| Document says | Record says | Where |
|---|---|---|
| account kind | **account type** | `CONTEXT.md:32-37` (the column is `kind`; the screens say Account type) |
| tax category, tax categories | **tax treatment** | `CONTEXT.md:26-30` |
| projected annual dividends | **annual dividend** ("projected income" is on the avoid list) | `CONTEXT.md:14-17` |
| positions-only contract | positions, not transactions (§3); "contract" is ADR-0001's row-type contract | `DESIGN.md:53`, ADR-0001 |
| manual aggregate history | the hand-typed net worth series (`manual_networth`); a *manual balance set* is a real photograph and does decompose | `docs/importing-history.md:13-27`, `:164-172` |

New terms the proposal needs: **target** (a household-wide intended weight per asset class) and
**drift** (actual weight minus target, in percentage points, signed). "Asset location",
"concentration", "exposure" and "look-through" are avoided by titling the panels for what they show:
*Asset class by tax treatment*, *Largest positions*, *Asset class over time*.

### F11 — No per-instrument edit screen exists

Settings → Classifications, Instruments and History are named as unbuilt (`settings/index.tsx:67-71`;
`DESIGN.md:755-756`). Classification is chosen once, in the upload wizard's instrument step
(`app/routes/upload/instruments.tsx`), and no shipped path changes it afterwards
(`instrument-resolution.server.ts:503` is the one write; `docs/data-model.md:713-715`). So:

- the document's "editing [a classification] can redraw the entire past" (l. 128) describes a
  `psql` update today, not a screen;
- any hand-maintained per-instrument fact — a typed expense ratio, a fund's constituents — has
  nowhere to be typed until that tab is built. The account-metadata precedent applies when it is:
  "Metadata is not versioned: changing it also changes historical labels and groupings"
  (`docs/guide/settings.md:47-48`).

This is why F8 prefers the fetched path for fees.

### F12 — The bar renderer already exists, on Overview

Overview's "Allocation by account" panel is ranked horizontal bars: `allocationBars`
(`overview.tsx:201-213`) and `AllocationPanel` (`:273-320`) render `.alloc-row` / `.alloc-track` /
`.alloc-fill` rows with `categoryColor(index)` and an `Amount` beside each. That is the component
tickets 02 and 05 ask for, with 01 a stacked variant and 03 a marker variant. Issue #161 names
three defects in that panel. One is already fixed at HEAD: the rank→colour mapping goes through
`categoryColor` (`:210`). Two are live: the width is computed in floats over `toPlotValue` (`:211`)
where `allocateShares` exists to do it exactly, and the panel's notes are hand-rolled (`:282-287`)
beside `breakdown.tsx`'s own (`:36-64`, `:116-121`). The notes are not the same rule — a bar list
*truncates* to the largest `BARS` (`:63`) and says how many it left out; a donut *folds* the tail
into one grey wedge — so the lifted component keeps a truncation note of its own and the fold stays
the donut's. Ticket 01 says so, which answers #161's second item rather than dropping it.

So the proposal does not add a `StackedBars` sibling in `breakdown.tsx`, as the first draft did.
Ticket 01 lifts the rows out of `overview.tsx` into one bar component, makes Overview adopt it, and
takes the #161 fold-onto-`allocateShares` with it. Two bar renderers on two screens would be the
drift `breakdown.tsx`'s one-implementation argument exists to prevent.

## Proposal

### Order, and why

Four tickets on data the app already stores, one on data it may already receive, one deferred with
a route in. Ordered by dependency and by how much each teaches the next; once 01 lands, 02, 03
and 04 are mutually independent and can run at once.

1. **Asset class by tax treatment** — replaces the asset-class donut (F1); lifts the bar component
   from Overview (F12), adds the stacked variant and the asset-class colour map (F2). Smallest
   distinctive addition; everything after it reuses one of the three.
2. **Largest positions** — an instrument `Grouping` through `allocationBy` and the ranked-bar list.
   Expand-to-accounts is a native `<details>` per row: finite, server-rendered, no client state,
   already used by `owner-filter-control.tsx:43`.
3. **Targets and drift** — the `allocation_target` migration (asset class only), a Settings →
   Targets tab in `settings/tax.tsx`'s pattern, drift in `allocation.ts`, a marker on ticket 1's
   bars. The strongest community signal in the document's sample; the most plumbing.
4. **Asset class over time** — the grouped reader through `chart-series.server.ts`, a stacked-area
   component, the existing range control with 1D disabled, dollars only. Cites #216 and #182; draws
   no prefix.
5. **Fund fees** — first the live check in F8; then promote `netExpenseRatio` to `quote` and an
   `annual_fee` view column (ADR-0001 two-object migration, ÷100 in SQL), a ranked "estimated annual
   fund cost" list on ticket 1's bars, a value-weighted rate with its coverage. Mutual funds show
   "unknown" until a second ticket adds the `quoteSummary` worker route.
6. **Deferred: look-through.** If wanted, the issuer-CSV upload path (F9); sector weights from
   `sectorWeightings` are the fetchable intermediate and share ticket 5's worker route.

Not proposed: FI scenarios and user-defined shocks (the document's own ground — no demand evidence
in its sample — and both need typed assumptions before they need code); unrealized-gain bars
(incremental beside the gains table, and basis coverage is partial by design); the donut-to-bars
change for classification (see rejections).

### Data each feature needs, and how to get it

| Feature | Needs | Present? | How to get what is missing | Cost |
|---|---|---|---|---|
| Asset class by tax treatment | class, treatment, value, coverage per holding | yes | — | none |
| Largest positions | instrument identity and value per account | yes | — | none |
| Targets and drift | a target weight per asset class | **no** | household types it: new `allocation_target` table, Settings → Targets form (whole-set replace, sums to 100 %) | migration + `db:types`, a reader/writer module, one route, two glossary entries |
| Asset class over time | class and value per holding per date | yes (`holding_valued_at`) | — | new reader, no SQL |
| Fund fees (ETF) | net expense ratio per ETF | **declared and requested; populated is unproven** | confirm on a live archive, then promote from the quote response: `yahooQuote` field, `quote` column, `holding_valued` column null on the dated path | one migration, two edits, a test |
| Fund fees (mutual fund) | net expense ratio per mutual fund | no | `quoteSummary` `fundProfile` via a new worker route; one call per fund; same allowlist | worker route, client method, seam method, `AskKind`, rate cap, fakes |
| Sector weights | sector weights per fund | no | `quoteSummary` `topHoldings.sectorWeightings`, same route as above | as above, plus a dated table and a glossary entry |
| Look-through | full constituents with weights, dated, per fund | no | issuer CSV upload with a parser per issuer; or quarterly N-PORT XML; Yahoo's top ten is insufficient | a second ingest slice; the largest item here |
| Classification history | a dated classification per instrument | no | a dated classification-set table in `position_set`'s append-only shape; not needed by any ticket above, only by an honest "as classified then" toggle | deferred |

Everything fetched goes through the worker and its allowlist (ADR-0010). Nothing in this table
adds a host: `quoteSummary` is on `query2.finance.yahoo.com`, already allowed. Issuer CSVs and
N-PORT need no network at all if they arrive as uploads.

### Tickets, in the house shape

Each is one pull request that typechecks, builds and carries its own tests. Specs go under
`docs/specs/<slice>/` once approved; this is the sketch.

**01 — Asset class by tax treatment.** Blocked by: nothing. `allocationBy(holdings, crossed)` where
`crossed` keys on `${taxTreatment}|${assetClass}` — the shipped netting, share and coverage rules for
free; the existing `groupingBy("assetClass")` and `groupingBy("tax")` calls as the marginals;
`assetClassColor()` beside `categoryColor()`; the bar rows lifted from `overview.tsx` into
`app/components/allocation-bars.tsx` with a stacked variant and its own truncation note, Overview
adopting it and #161's float width folded onto `allocateShares`; the asset-class donut removed, `byAssetClass` kept in loader
data as the totals row so `aggregates-agree` passes untouched; drill-down links into Holdings with
both filters; §8.3 and §13.3 amended; `docs/guide/analysis.md` updated. Fixtures: a liability
inside a taxable account, an unpriced holding, an owner-narrowed reading.

**02 — Largest positions.** Blocked by: 01 (bars, colour). An instrument `Grouping`
(`key: instrumentId, label: instrumentName`) through `allocationBy`, noted as the one grouping
outside the registry (#174); ranked bars; top-1 and top-5 as sums of `share` strings in `money.ts`
units, stated as shares of the gross positive total; `<details>` per row listing accounts; cash
visible as its own row; no risk score. Fixtures: the same instrument in three accounts, a fund
larger than any stock.

**03 — Targets and drift.** Blocked by: 01 (bars). Migration `allocation_target(asset_class pk,
weight numeric(7,6))`; `targets.server.ts` with `readTargets`/`saveTargets` (whole-set replace,
Zod, sums to 100 % at `SHARE_SCALE`); Settings → Targets tab; `driftBy(holdings, targets)` in
`allocation.ts` computing `class net ÷ investable base − target` in `money.ts` units, the base
derived from `account.kind` with bank cash in; a marker per bar and signed points beside it;
coverage line above it; CONTEXT.md entries for target and drift. Fixtures: a liability account
excluded from the base, a class with no target, partial coverage.

**04 — Asset class over time.** Blocked by: 01 (colour). `netWorthSeriesByAssetClass(reading,
dates)` beside `netWorthSeries`, one query, narrowing inside the lateral, the NULL-class row
dropped, coverage per date across classes; `chartSeries` gaining a grouped path in
`chart-series.server.ts` with the coverage rule restated for a stack; a `StackedAreaChart` with
pre-rendered readouts; the range control with 1D disabled and the owner control's hidden fields
(F6); no hand-typed prefix; labelled "mix reconstructed from recorded holdings". Cites #216, #182.
Fixtures: a date before the first upload, a partially priced date, a closed account.

**05 — Fund fees.** Blocked by: 01 (bars), and the live check in F8 answering yes.
`netExpenseRatio` in `yahooQuote` (percentage); `quote.net_expense_ratio_pct numeric(9,6)`;
`holding_valued.annual_fee = value × ratio / 100` in SQL, null when unknown, null on the dated
path; a ranked panel and a weighted rate with coverage; labelled "fund expenses, not all investment
costs". Second ticket, blocked by 05: the `quoteSummary` worker route for mutual funds.

### Two decisions the owner makes before the first spec

1. **Fixed panels or the builder** (F1). This proposal says fixed panels — four new ones — recorded
   in §8.3. If the answer is the builder, tickets 02 and 04 collapse into its persistence and
   renderer work; 01, 03 and 05 stand either way.
2. **One rule or two for denominators** (F5). This proposal says the shipped rule for 01 and 02 and
   the investable base for 03 only, with bank cash inside it (F4). If the owner wants view 1 to
   show liabilities apart from positive composition, or emergency cash out of the target base, the
   invariant test forks and a per-account flag appears.

## What I rejected from the research document, and why

- **"Monthly" for the time chart.** No such grid exists; §8.3 sketches the word and nothing
  implements it; the chart uses ADR-0003's sampler like the other two (F3).
- **`holdingsAt` as the reuse target.** It is the per-date reader; `readSeries` through
  `chart-series.server.ts` is the pattern (F3).
- **Stable colours for classification.** Not possible under §13.3; possible for the two closed
  rollups, which is what views 1, 2 and 5 need (F2).
- **Liabilities shown separately in view 1.** A third denominator on one screen; the shipped rule
  is kept and stated (F5). Reversible by the owner.
- **Emergency cash out of the target denominator.** The only mechanism is a per-account flag the
  prior research argues against; bank cash is in, and the panel says so (F4). Reversible by the
  owner.
- **"Presentation only" for donut-to-bars on classification.** It forks `breakdown.tsx` or changes
  all four panels, and the grey-tail fold is an argued decision (`DESIGN.md:1326-1332`). Not
  proposed; if wanted, it is its own ticket after 01 exists.
- **"Maintained expense-ratio metadata."** The ETF figure may already be fetched; the hand-kept
  path has no screen (F8, F11).
- **Dated constituents from Yahoo.** `topHoldings` carries no date and ten names (F9).
- **A percentage view of the time chart in the first ticket.** It hides partial coverage that the
  dollar view shows (F7).

And one thing rejected from the prior data-layer sketch: **both key columns on `allocation_target`**
when only asset class is formed (F4).

Accepted as written: the ranking of 1–3 over 4–5; descriptive-only framing for tax treatment; no
invented allocation; one target dimension first; drift before contribution suggestions;
direct-holding versus company exposure; deferral of performance, benchmark and drawdown charts
under §3; the owner filter on every view; the denominator stated beside every percentage.

## What the second pass overturned

The first draft of this document was handed to a grounding reviewer with the mandate AGENTS.md
sets. Five findings changed its shape rather than its wording:

- **The fee unit.** The draft proposed `annual_fee = value × ratio` over a column it never gave a
  unit; the library declares the field a percentage, and the schema already documents the identical
  100× trap on `dividendYield`. F8 and ticket 05 now name the unit and put the division in SQL.
- **"Already arrives"** was asserted from an optional type. F8 now says what is declared, what is
  requested, what is archived, and that "populated" is a query on a live instance nobody has run.
  The Verdict's rank change for fees is conditional on it.
- **A second bar renderer.** The draft proposed a `StackedBars` sibling to the donut while Overview
  already renders ranked bars with the same colour assigner. F12 is new; ticket 01 lifts rather
  than adds.
- **Two "new groupers"** were `allocationBy` with a composite or an instrument key. The table and
  tickets 01–02 now say so, and note that the instrument grouping is the one outside the registry.
- **The slot count.** The draft counted one new panel; the proposal adds four. F1 now says so and
  the first owner decision is framed against that number.

Smaller corrections taken: 1D has no grouped reader (F3); the LEFT JOIN's null row becomes a
NULL-class group (F3); the classification column dropped from the target table (F4); bank cash
named as inside the base (F4); N-PORT's public cadence is quarterly (F9); the `<details>` element
is already in use (proposal); the invariant test can pass untouched (F5); `tickLabel` is not
exported (table); a "sheltered as a bar" row attributed to the research document that it never
said (F10, deleted); §13.7 does not refuse a typed sensitivity (proposal, reworded); `drift.ts` and
`settings.server.ts` placements (F4). Nothing the reviewer raised was rejected.

A second round over the rewrite found one material item — F12 said #161 names one defect in
Overview's bar panel; it names three, one already fixed and two live, and the lifted component
now answers both — plus five wording corrections (the archive holds the per-symbol entry, not the
whole response; the sector keys' sum is unverified; `tickLabel` is *to be* exported; view
numbering in the rejections; "period" is a chart-range word). All taken; the review stopped there.

## Related open issues

- #174 — the dimension registry should name the dimension; tickets 01–02 add sites that would
  retype a heading, and 02 adds the one grouping outside the registry; land #174 first or with 01.
- #161 — Overview's `allocationBars` restates the share rule in floats; ticket 01 lifts that
  component and folds the width onto `allocateShares` (F12).
- #216 — per-point coverage the chart discards; ticket 04 makes it visible and should cite it.
- #182 — close-day disagreement between `holding_valued` and `holding_valued_at`; ticket 04
  inherits it.
- #180 — two-owner filter redirect loop; every new panel narrows through the same reading and is
  affected the same way.
