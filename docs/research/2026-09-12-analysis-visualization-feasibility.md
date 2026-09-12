# Analysis visualizations — feasibility of the 2026-09-11 opportunities, and a proposal

**Date:** 2026-09-12. **Against:** `25245de`.
**Read:** [`2026-09-11-analysis-visualization-opportunities.md`](2026-09-11-analysis-visualization-opportunities.md);
`DESIGN.md` §3, §4.4–4.5, §7, §8.1–8.4, §13.3, §14; `ARCHITECTURE.md` §4, §5.6, §6.3, Appendix A;
`CONTEXT.md`; ADR-0001, -0003, -0004, -0006, -0008, -0010, -0011; every file in `migrations/`;
`app/lib/allocation.ts`, `holdings-view.ts`, `valuation.server.ts`, `chart-series.server.ts`,
`chart-range.ts`, `settings.server.ts`, `price-provider.server.ts`, `prices.server.ts`;
`app/routes/analysis.tsx`, `holdings.tsx`, `income.tsx`, `settings/**`; `app/components/breakdown.tsx`,
`net-worth-chart.tsx`; `server/price-worker.ts`, `yahoo-client.ts`, `egress-proxy.ts`; the two
2026-08-19 research reports and the 2026-09-01 aggregation audit; open issues #161, #174, #182, #216;
and `yahoo-finance2@4.0.2`'s own source (`node_modules` is absent in this checkout, so the pinned
tarball was read directly; Yahoo, iShares and SEC hosts are blocked from here, so nothing was
verified live against a fund symbol).

The research document was already grounded twice before it landed. This pass asked a different
question — not "is each sentence true" but "what would it cost to build, what data is missing, and
where does the design record already have an opinion" — and found that the document is accurate
about the schema and the code and silent about the three things that decide the shape of the work:
DESIGN.md §8.3's slot warning, the five-hue colour rule, and the price worker's role in any fetched
metadata.

## Verdict

**Three of the five ranked views are buildable today on stored data with no migration:** asset class
by tax treatment, largest positions across accounts, and asset class through time. Each is one pure
grouper over the read Analysis already makes, plus one component. **Target versus actual needs one
table, one Settings tab and two glossary entries** — the prior FIRE data-layer research already
sketched the table. **Fund look-through is a separate data project**, as the document says, and the
cheapest fetchable source (Yahoo's top ten) cannot answer the overlap question it exists for.

Two of the lower-priority items change rank once the repository is read:

- **Fee exposure is closer than the document thinks.** An ETF's net expense ratio already arrives in
  every quote refresh and sits, unpromoted, in `price_observation.payload`. Promoting it is a
  migration in the `annual_dividend` shape; only mutual funds need a new worker call.
- **The donut-to-bars presentation change is not "presentation only".** It touches the one
  component that enforces the colour rule and the argued grey-tail fold.

The proposal below orders the work as four tickets on stored data, one on fetched data, and defers
look-through with a stated route in. Two decisions belong to the owner before the first spec is
written: whether fixed panels or the saved-view builder answer §8.3, and which denominator the new
panels state.

## What the repository confirms

Verified rather than assumed, per opportunity. "Present" means on the `holding_valued` row every
Analysis read already returns (`app/lib/valuation.server.ts:20-48`).

| Opportunity | Data present | Data missing | Code reused | Code added |
|---|---|---|---|---|
| 1. Asset class × tax treatment | `asset_class`, `tax_treatment`, `value`, `is_priced` on every row (`migrations/0006_annual_dividend.sql:12-33`) | nothing | `currentHoldings(reading)`, `allocateShares`, `groupingBy("assetClass"/"tax")`, Holdings drill-down (filters already AND: `holdings-view.ts:353-360`) | a two-key grouper beside `allocationBy`; a stacked-bar renderer; a per-category colour map |
| 2. Target vs actual | actual weights (`allocationBy(holdings, groupingBy("assetClass"))`, `analysis.tsx:163`) | **any stored target** — no table, no column; `app_setting` is a single row of typed columns (`migrations/0005_app_setting.sql:2-15`) | `settings/tax.tsx` end to end as the form pattern; `formatPercent`'s explicit sign; `SHARE_SCALE` maths | migration; settings reader/writer; Settings tab; drift module; bar-with-marker renderer |
| 3. Largest positions | `instrument_id`, `symbol`, `instrument_name`, `value`, `account_name` per row; one row per instrument per account (`migrations/0001_initial_schema.sql:129`) | nothing | `sortHoldings`' by-value order; `allocateShares` for top-1/top-5 shares; the bar renderer from 1 | an instrument grouper across accounts (`holdings-view.ts:2` leaves `instrument` out on purpose) |
| 4. Look-through | `quote_type` (ETF/MUTUALFUND/EQUITY, refreshed: `prices.server.ts:591-604`) | constituents, weights, as-of, canonical issuer key, sector, region, coverage — none anywhere (`database.generated.ts:207-228`) | instrument identity only | tables, a reader, an ingest or fetch path, a coverage type |
| 5. Asset class through time | `holding_valued_at(d)` returns `asset_class` (`migrations/0006:68-127`); the batched lateral in `readSeries` (`valuation.server.ts:339-373`) | dated classification (single mutable FK, `0001:66-68`); within-period trades (§3) | `readSeries`' shape; `chartReach`/`chartWindow`; the range control; `gridRules`/`tickLabel`/masking from `net-worth-chart.tsx` | a grouped series reader; a categorised point type; a stacked-area component |
| Fee exposure | `netExpenseRatio` on every ETF quote (`yahoo-finance2` `QuoteEtf`), archived in `price_observation.payload` (`prices.server.ts:677-699`) | a typed column; mutual-fund ratios | `writeQuote`, `yahooQuote` Zod, the `annual_dividend` view-column precedent | one promotion migration; later a `quoteSummary` worker route |
| Unrealized-gain bars | `cost_basis`, `unrealized` per row | nothing, but basis is nullable by design (`0001:125-126`) and the view refuses to coalesce it (`0002:46`) | the gains table's coverage count | a bar renderer |

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
table's state, a measure picker, a generic time-axis renderer and revisiting no-materialisation
(`:719-724`; `ARCHITECTURE.md` §11.4). None of the three views is a plain instance: view 1 wants a
crossed table with a stated denominator, view 3 wants the one dimension `holdings-view.ts` declines
by design, view 5 wants per-date-per-class coverage. A builder would render each and label none.

**Recommendation:** fixed panels, and amend §8.3 in the first PR so the decision is recorded rather
than eroded — view 1 *replaces* the asset-class donut (its marginal row is the donut's table), so the
slot count does not move; view 3 spends a slot and says so. This is the first owner decision (§"Two
decisions").

### F2 — Stable colours are possible for asset class and tax treatment, and impossible for classification

The document asks for "stable category colours" as a presentation preference (l. 168). The record
makes it structural: §13.3 fixes **five hues and no more**, validated mechanically under two forms
of colour-blindness (`DESIGN.md:1312-1322`), and `breakdown.tsx` is one component *because* the
same-rank-same-colour rule "is enforced by nothing except there being one implementation"
(`ARCHITECTURE.md:2275`; `breakdown.tsx:18-23`).

Asset class is a closed four-value rollup (`0001:45-47`; `CONTEXT.md:54-59`). Four fits inside
five. A fixed map — equity → hue 1, bond → 2, cash → 3, other → 4 — stays inside the validated
sequence and is stable across every panel and every date. `other` is a real category ("cannot be
split further"), not a merged tail, so it earns a hue rather than §13.3's grey. Tax treatment (three
values) fits the same way. **Classification cannot be stable**: the demo alone has thirteen
(`scripts/seed-demo.ts:91-103` plus the seeded `Cash`), and thirteen distinguishable hues do not
exist under the §13.3 method.

So: one new rule beside the existing one. *Category colour for the closed rollups wherever they
appear; rank colour for open sets.* That is an `assetClassColor()` sibling to `categoryColor()`, an
amendment to §13.3, and no change to the owner, account-type and classification donuts.

### F3 — Asset class through time needs no migration; the reuse target is `readSeries`, and "monthly" is a new grid

Three corrections to l. 116-124:

- `holdingsAt` (`valuation.server.ts:170-176`) is a single-date row reader **no chart calls**.
  Building on it is the one-query-per-date anti-pattern the same sentence warns against. The batched
  pattern is `readSeries` (`:339-373`): `unnest(dates)` + `LEFT JOIN LATERAL holding_valued_at(d.date)`
  + `GROUP BY d.date`, with the owner narrowing **inside** the lateral (`:355`) so an uncovered date
  keeps its row. `holding_valued_at` already returns `asset_class`, so the grouped series is that
  query plus `v.asset_class` in the select and group-by. **No SQL function, no migration.**
- Since spec 0015, a chart's series is read only through `app/lib/chart-series.server.ts`
  (`ARCHITECTURE.md:2183`), which owns the `coverage.total > 0` rule (`chart-series.server.ts:59-65`).
  The new reader sits beside `netWorthSeries` and is called from there, not from a loader.
- There is no monthly grid. `sampleWindow` (`chart-range.ts:135-162`) emits every day inside a
  180-sample budget, else 180 dates decaying geometrically from the window's end (ADR-0003). A
  stacked area over that grid is fine; a "monthly" chart is a second sampler and a second decision.
  Drop the word.

Two shipped rules also bind it: a grouped view does not draw the hand-typed prefix (`DESIGN.md:540-546`,
rule 3 — "the manual series has no structure to slice"), and interaction is pre-rendered per point
(ADR-0004). Four classes × 180 points is ~720 readout rows; fine, but a dollars/percent toggle is
URL state and meets F6.

### F4 — Targets need a table; the table is already sketched; one dimension or two is a live disagreement

`app_setting` is one row of typed columns (`0005:2-15`, singleton via `check (id)`), not key/value,
so a per-category target set cannot sit there.
[`2026-08-19-fire-data-layer-design.md:105-145`](2026-08-19-fire-data-layer-design.md) sketches
`allocation_target` — `asset_class` or `classification_id` (exactly one non-null), `weight
numeric(7,6)` at `SHARE_SCALE`, partial unique indexes per dimension, household-wide, sum-to-100 %
enforced by making the only write a whole-set replace. Nothing of it was accepted into a spec
(`docs/specs/README.md`'s table runs 0001–0021 without it).

The research document says "support one target dimension first" (l. 76); the sketch argues both,
because classification is "the only level at which 70 % US / 30 % international *within equity* can
be expressed" (`:126-129`). Both are right about different things. **Recommendation:** ship the
sketch's table shape (both key columns) and the asset-class form only. Asset class is closed and
CHECK-constrained, so a target set over it cannot drift; classification is an open label set the
household grows at upload time, so a target set over it needs a "new classification has no target"
rule the first slice should not carry. The second form is a later ticket on the same table.

The denominator is the sketch's `investableBase` — holdings in non-`liability` accounts, derived
from `account.kind` by an exhaustive map (`:31-42`), never a stored flag. Weights are
`class net amount ÷ investable base`, which is not `AllocationSlice.share` (`:47-62` gives the three
reasons). The panel states this in words, as the gains panel states its netting.

### F5 — Analysis already runs two denominators; a third must be named, not assumed

The `% of total` column divides by the gross positive bucket total (`allocation.ts:56-58`); the
figure in the donut's centre is `netWorth().amount`, net of liabilities (`analysis.tsx:152` →
`breakdown.tsx:100-107`); a conditional note reconciles them when a bucket is negative
(`breakdown.tsx:116-121`). The 2026-09-01 audit confirmed the arithmetic and named the reading:
"a share is a share of *gross assets*" (`2026-09-01-net-worth-aggregation-audit.md:610-616`).

The document then asks view 1 to "show liabilities separately from positive asset composition" and
view 3 to use "positive priced assets within the selected scope" — a third and a fourth rule on one
screen. `tests/invariants/aggregates-agree.test.ts` compares Analysis and Holdings bucket-for-bucket
on amount, share and coverage; a panel with its own rule either leaves that invariant or forks it.

**Recommendation:** views 1 and 3 keep the shipped rule — buckets net, shares are of the gross
positive total, a negative bucket is a row with a hollow dot and the existing caveat — and say so.
The odd case the prior research found (a loan recorded as negative `USD` nets inside `cash`,
`fire-data-layer-design.md:7-17`) is the asset-class donut's behaviour today, documented to the
household (`docs/guide/analysis.md:28-39`); view 1 inherits it rather than inventing a second
answer. View 2 is the one place a different base is *required* (F4), and it is labelled as such.
This is the second owner decision.

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
- **#182**: `holding_valued_at` counts an account on its closing date; `holding_valued` does not. The
  last point of view 5 disagrees with the panels above it on that one day, exactly as Overview's
  chart does today. View 5 inherits the bug; it does not need to fix it, and its spec should cite it.

### F8 — Fee data is already arriving for ETFs, unpromoted

`yahoo-finance2@4.0.2`'s `QuoteEtf` carries `netExpenseRatio` and the worker requests no `fields`
filter, so it arrives on every refresh (`server/yahoo-client.ts:64-67`) and is archived whole in
`price_observation.payload` (`prices.server.ts:677-699`, 32 KB cap). ADR-0006 forbids computing
from the payload and names the way out: "a figure needed for arithmetic is promoted to a typed
`numeric` column in its own migration" (`0006-…md:41`). The `yahooQuote` schema
(`price-provider.server.ts:105-117`) and `writeQuote` (`prices.server.ts:559-585`) are the two
sites to extend, and `annual_dividend` (`migrations/0006`) is the precedent for the view column —
with one deliberate difference: `annual_dividend` coalesces a missing rate to zero, which
`DESIGN.md:1493-1505` admits is the one dishonest column; a fee column must stay null and be counted
in coverage.

**Mutual funds** (`quoteType: MUTUALFUND`) carry no fee on the quote. `quoteSummary(symbol,
{ modules: ["fundProfile"] })` returns `feesExpensesInvestment.annualReportExpenseRatio` /
`netExpRatio` / `grossExpRatio` (`quoteSummary-iface.d.ts:471-479`). It hits the same host and crumb
path as `quote()` and passes the egress allowlist unchanged (`egress-proxy.ts:29-37`). What it costs
is everything ADR-0010 puts between the app and the network: a worker route with its own Zod body,
symbol check and rate cap (`price-worker.ts:51-58`, `:193-232`), a `YahooClient` method, an
`AskKind` with a budget (`provider-socket.server.ts:28-43`), a provider-seam method plus fakes, and
one writer under a §4.2 row. One symbol per call, unlike quotes' hundred. CITs and manual-price
instruments have no source at all and stay "unknown".

The document's "if maintained expense-ratio metadata is added" (l. 135) is therefore imprecise
twice: the ETF data is not absent but unpromoted, and "maintained" (hand-kept) is the *harder* path
— there is no per-instrument edit screen to keep it on (F11).

### F9 — Yahoo's top ten cannot answer overlap; full constituent lists arrive as uploads

`topHoldings` returns `holdings[]` (symbol, name, percent), `sectorWeightings`, `bondRatings`, the
stock/bond/cash split — with **no as-of date** (only a cache `maxAge`) and **no region weights**
(`quoteSummary-iface.d.ts:835-896`). Yahoo's page section is "Top 10 Holdings". Ten names cover
roughly a third of a total-market fund's weight; the overlap question ("am I buying the same
companies through several funds") is unanswerable on the remainder, and ARCHITECTURE §6.3's coverage
rule forbids redistributing it.

Full lists exist in two places, neither fetched: issuer holdings CSVs (iShares daily, Vanguard
daily for ETFs and month-end for mutual funds; per-issuer formats with preamble lines and nested
funds for target-date products) and SEC Form N-PORT (monthly, public domain, XML, published ~60 days
after quarter end). The issuer CSV lands the way a statement does — an upload the household
downloaded itself, a tolerant parser per issuer with fixtures, no network — which is the pattern
`docs/security.md` §1 already argues for. That is the route in if look-through is ever built.

A cheaper intermediate with full coverage is **sector exposure** from `sectorWeightings`: eleven
sectors summing to the fund's equity weight, one `quoteSummary` call per fund, the same worker
route F8 needs. It answers "how much technology am I holding through funds" without naming a
company. It is not what the document asked for; it is what the fetchable data can honestly support.

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
| sheltered as a bar | a subtotal in words, "never a slice of a chart" | `CONTEXT.md:39-43` |

New terms the proposal needs: **target** (a household-wide intended weight per asset class) and
**drift** (actual weight minus target, in percentage points, signed). "Asset location",
"concentration", "exposure" and "look-through" are avoided by titling the panels for what they show:
*Asset class by tax treatment*, *Largest positions*, *Asset class over time*.

### F11 — No per-instrument edit screen exists

Settings → Classifications, Instruments and History are named as unbuilt (`settings/index.tsx:67-71`;
`DESIGN.md:755-756`). Classification is chosen once, in the upload wizard's instrument step
(`app/routes/upload/instruments.tsx`), and no shipped path changes it afterwards
(`instrument-resolution.server.ts:503` is the one write; `docs/data-model.md:712-714`). So:

- the document's "editing [a classification] can redraw the entire past" (l. 128) describes a
  `psql` update today, not a screen;
- any hand-maintained per-instrument fact — a typed expense ratio, a fund's constituents — has
  nowhere to be typed until that tab is built. The account-metadata precedent applies when it is:
  "Metadata is not versioned: changing it also changes historical labels and groupings"
  (`docs/guide/settings.md:47-48`).

This is why F8 prefers the fetched path for fees.

## Proposal

### Order, and why

Four tickets on data the app already stores, one on data it already receives, one deferred with a
route in. Ordered by dependency and by how much each teaches the next; 3 and 4 are independent and
can run at once.

1. **Asset class by tax treatment** — replaces the asset-class donut (F1); introduces the crossed
   grouper, the stacked-bar component and the asset-class colour map (F2). Smallest distinctive
   addition; everything after it reuses one of the three.
2. **Largest positions** — the instrument grouper and the ranked-bar list. Expand-to-accounts is a
   native `<details>` per row: finite, server-rendered, no client state, in the ADR-0004 spirit.
3. **Targets and drift** — the `allocation_target` migration in the sketched shape, a Settings →
   Targets tab in `settings/tax.tsx`'s pattern, a pure drift module, a bar-with-marker panel that
   reuses ticket 1's bars. The strongest community signal in the document's sample; the most
   plumbing.
4. **Asset class over time** — the grouped reader through `chart-series.server.ts`, a stacked-area
   component, the existing range control, dollars only. Cites #216 and #182; draws no prefix.
5. **Fund fees** — promote `netExpenseRatio` to `quote` and a `annual_fee` view column (ADR-0001
   two-object migration), a ranked "estimated annual fund cost" bar reusing ticket 1's bars, a
   value-weighted rate with its coverage. Mutual funds show "unknown" until a second ticket adds
   the `quoteSummary` worker route.
6. **Deferred: look-through.** If wanted, the issuer-CSV upload path (F9); sector exposure from
   `sectorWeightings` is the fetchable intermediate and shares ticket 5's worker route.

Not proposed: FI scenarios and user-defined shocks (no stored data required, but no demand evidence
and §13.7's refusal of invented figures applies to both); unrealized-gain bars (incremental beside
the gains table, and basis coverage is partial by design); the donut-to-bars change for
classification (see rejections).

### Data each feature needs, and how to get it

| Feature | Needs | Present? | How to get what is missing | Cost |
|---|---|---|---|---|
| Asset class by tax treatment | class, treatment, value, coverage per holding | yes | — | none |
| Largest positions | instrument identity and value per account | yes | — | none |
| Targets and drift | a target weight per asset class | **no** | household types it: new `allocation_target` table, Settings → Targets form (whole-set replace, sums to 100 %) | migration + `db:types`, settings module, one route, two glossary entries |
| Asset class over time | class and value per holding per date | yes (`holding_valued_at`) | — | new reader, no SQL |
| Fund fees (ETF) | net expense ratio per ETF | **arrives, unstored** | promote from the quote response: `yahooQuote` field, `quote` column, `holding_valued` column null on the dated path | one migration, two edits, a test |
| Fund fees (mutual fund) | net expense ratio per mutual fund | no | `quoteSummary` `fundProfile` via a new worker route; one call per fund; same allowlist | worker route, client method, seam method, `AskKind`, rate cap, fakes |
| Sector exposure | sector weights per fund | no | `quoteSummary` `topHoldings.sectorWeightings`, same route as above | as above, plus a dated table |
| Look-through | full constituents with weights, dated, per fund | no | issuer CSV upload with a parser per issuer; or N-PORT XML; Yahoo's top ten is insufficient | a second ingest slice; the largest item here |
| Classification history | a dated classification per instrument | no | a dated classification-set table in `position_set`'s append-only shape; not needed by any ticket above, only by an honest "as classified then" toggle | deferred |

Everything fetched goes through the worker and its allowlist (ADR-0010). Nothing in this table
adds a host: `quoteSummary` is on `query2.finance.yahoo.com`, already allowed. Issuer CSVs and
N-PORT need no network at all if they arrive as uploads.

### Tickets, in the house shape

Each is one pull request that typechecks, builds and carries its own tests. Specs go under
`docs/specs/<slice>/` once approved; this is the sketch.

**01 — Asset class by tax treatment.** Blocked by: nothing. A `crossBy(holdings, rows, columns)`
in `allocation.ts` returning cells with the shipped netting and share rule; `assetClassColor()` in
`breakdown.tsx`; a `StackedBars` sibling component; the asset-class donut removed and its table kept
as the crossed table's totals row; drill-down links into Holdings with both filters; §8.3 and §13.3
amended; `docs/guide/analysis.md` and the invariant test updated. Fixtures: a liability inside a
taxable account, an unpriced holding, an owner-narrowed reading.

**02 — Largest positions.** Blocked by: 01 (bars, colour). A `byInstrument(holdings)` grouper
across accounts; ranked bars with top-1 and top-5 shares of the gross positive total, stated in
words; `<details>` per row listing accounts; cash visible as its own row; no risk score. Fixtures:
the same instrument in three accounts, a fund larger than any stock.

**03 — Targets and drift.** Blocked by: 01 (bars). Migration `allocation_target` in the sketched
shape; `readTargets`/`saveTargets` in `settings.server.ts` (whole-set replace, Zod, sums to 100 %
at `SHARE_SCALE`); Settings → Targets tab; `drift.ts` computing `class net ÷ investable base −
target` in `money.ts` units; a panel with a marker per bar and signed points beside it; coverage
line above it; CONTEXT.md entries for target and drift. Fixtures: a liability account excluded from
the base, a class with no target, partial coverage.

**04 — Asset class over time.** Blocked by: 01 (colour). `netWorthSeriesByAssetClass(reading,
dates)` beside `netWorthSeries`, one query, narrowing inside the lateral, coverage per date; a
`chartSeriesByClass` in `chart-series.server.ts`; a `StackedAreaChart` with pre-rendered readouts;
the range control with the owner control's hidden fields (F6); no hand-typed prefix; labelled
"mix reconstructed from recorded holdings". Cites #216, #182. Fixtures: a date before the first
upload, a partially priced date, a closed account.

**05 — Fund fees.** Blocked by: 01 (bars). `netExpenseRatio` in `yahooQuote`; `quote.net_expense_ratio
numeric(9,6)`; `holding_valued.annual_fee = value × ratio`, null when unknown, null on the dated
path; a ranked panel and a weighted rate with coverage; labelled "fund expenses, not all investment
costs". Second ticket, blocked by 05: the `quoteSummary` worker route for mutual funds.

### Two decisions the owner makes before the first spec

1. **Fixed panels or the builder** (F1). This proposal says fixed panels, recorded in §8.3. If the
   answer is the builder, tickets 01, 02 and 04 collapse into its persistence and renderer work and
   this document's estimates do not apply.
2. **One rule or two for denominators** (F5). This proposal says the shipped rule for 01 and 02 and
   the investable base for 03 only. If the owner wants view 1 to show liabilities apart from
   positive composition, the invariant test forks and the guide's "a debt is not a slice" paragraph
   grows a second case.

## What I rejected from the research document, and why

- **"Monthly" for the time chart.** No such grid exists; the chart uses ADR-0003's sampler like the
  other two (F3).
- **`holdingsAt` as the reuse target.** It is the per-date reader; `readSeries` through
  `chart-series.server.ts` is the pattern (F3).
- **Stable colours for classification.** Not possible under §13.3; possible for the two closed
  rollups, which is what views 1, 3-as-targets and 5 need (F2).
- **Liabilities shown separately in view 1.** A third denominator on one screen; the shipped rule
  is kept and stated (F5). Reversible by the owner.
- **"Presentation only" for donut-to-bars on classification.** It forks `breakdown.tsx` or changes
  all four panels, and the grey-tail fold is an argued decision (`DESIGN.md:1326-1332`). Not
  proposed; if wanted, it is its own ticket after 01 exists.
- **"Maintained expense-ratio metadata."** The ETF figure is fetched today; the hand-kept path has
  no screen (F8, F11).
- **Dated constituents from Yahoo.** `topHoldings` carries no date and ten names (F9).
- **A percentage view of the time chart in the first ticket.** It hides partial coverage that the
  dollar view shows (F7).

Accepted as written: the ranking of 1–3 over 4–5; descriptive-only framing for tax treatment; no
invented allocation; one target dimension first; drift before contribution suggestions;
direct-holding versus company exposure; deferral of performance, benchmark and drawdown charts
under §3; the owner filter on every view; the denominator stated beside every percentage.

## Related open issues

- #174 — the dimension registry should name the dimension; tickets 01–02 add two more sites that
  would retype a heading, so land #174 first or with 01.
- #161 — Overview's `allocationBars` restates the share rule in floats; ticket 01's bar component
  is the natural home for folding it onto `allocateShares`.
- #216 — per-point coverage the chart discards; ticket 04 makes it visible and should cite it.
- #182 — close-day disagreement between `holding_valued` and `holding_valued_at`; ticket 04
  inherits it.
- #180 — two-owner filter redirect loop; every new panel narrows through the same reading and is
  affected the same way.
