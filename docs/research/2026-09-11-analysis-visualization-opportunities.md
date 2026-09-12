# Useful additions to Analysis

Research dated 2026-09-11, against repository revision `16c75c8`. Recommendations for discussion,
not approved implementation work. Inspected source and the checked-in demo screenshot; no private
portfolio data was examined. Priorities reflect the app's family portfolio model, not a diagnosis
of the household's actual investments.

## Recommendation

Start with **asset location**: show asset classes across taxable, tax-deferred and tax-free
accounts. Next add **target versus actual allocation**, once the household supplies its targets.
Add **direct-holding concentration** as a smaller companion view. These answer decisions that
the existing breakdowns leave to mental arithmetic.

Fund overlap and allocation history are worthwhile follow-ups with additional data work.
The strongest direction is to connect dimensions and compare actuals with intentions, rather
than add another single-dimension donut.

## What is already there

- Analysis has four donut/table pairs: owner, account kind, asset class and classification, plus
  an unrealized-gain/potential-tax table. See [analysis.tsx](../../app/routes/analysis.tsx).
- Holdings already supports grouping by tax treatment. A fifth donut would therefore mostly
  improve discoverability; crossing tax treatment with asset class adds a new question.
  See [holdings-view.ts](../../app/lib/holdings-view.ts).
- Income already breaks projected annual dividends down by tax treatment. That is income,
  not the amount of capital in each tax category. See [income.tsx](../../app/routes/income.tsx).
- Overview already shows total-value history. Repeating that line on Analysis adds little.

There is also a useful improvement to an existing chart: replace the long classification donut
with ranked horizontal bars. The checked-in demo has 13 classifications and merges the tail into
one grey wedge. Bars would make those smaller allocations directly comparable while retaining
the exact-value table. This changes presentation, not the set of data the app can analyze.

The [August screen recommendations](2026-08-19-screen-recommendations.md) already proposed
tax-treatment allocation, targets/rebalancing and financial-independence measures. Those ideas
are prior proposals, not evidence they shipped. Their descriptions of then-current screens
must not be used as today's implementation inventory.

## Ranked opportunities

### 1. Asset location: where each asset class is held

**Question:** “Where are my bonds, equities and cash across tax categories?”

Use three horizontal stacked bars, one per tax treatment, with consistent asset-class colours
and exact dollar values. A compact class-by-treatment table supplies the intersections. Show
the dollar scale by default; an explicitly labelled percentage view can compare each category's
composition. On a phone, the three bars remain readable without a wide heatmap.

This combines the app's existing asset-class and tax-treatment fields. It reveals differences
that two separate donuts cannot: the same overall equity/bond split can be distributed very
differently across accounts. A drill-down can reuse combined tax-treatment and asset-class
filters. Matching only the positive assets in a segment would require extending the current
filters, which do not exclude negative positions.

Keep this descriptive. Tax treatment alone does not establish tax efficiency, withdrawal
eligibility, or spendable after-tax value. For this proposed view, show liabilities separately
from positive asset composition. Existing Analysis nets signed holdings within each group
before assigning shares; that is not the same rule.

### 2. Target versus actual allocation

**Question:** “How far is my portfolio from the mix I intended?”

Use one horizontal actual-weight bar with a target marker per category; print signed drift in
percentage points beside it. For example, an illustrative 68% actual against a 60% target is
**+8 percentage points**. This is easier to act on than comparing rings by eye.

Requires saved, user-entered targets and a clearly defined set of included accounts/assets.
Account exclusions matter: emergency cash and liabilities should not silently change an
investment-allocation denominator. Support one target dimension first, rather than simultaneous
class, instrument and account target hierarchies. Do not invent a recommended allocation.

Start with drift only. A later contribution-allocation view can answer “How could new money
reduce these gaps?”, but transaction suggestions introduce account constraints and taxes beyond
this visualization. Incomplete pricing and the unresolved composition of mixed funds in
`other` must be visible before drift is interpreted. Every instrument already has a
classification; the missing detail is what some classified funds contain.

### 3. Concentration across accounts

**Question:** “What are my largest combined positions?”

Use ranked horizontal bars for the largest instruments, aggregated across accounts, with
top-one and top-five shares. Expand a bar to see where the position is held. Keep cash visible
as a separate category and label the percentage denominator as positive priced assets within
the selected scope.

The instrument identity and current values already exist. This is useful when the same stock
or fund appears in several family accounts. It is **direct-holding concentration**, not company
exposure: a large broad-market ETF position is not equivalent to a large single-stock position.
Do not assign a generic risk score or imply that a larger fund holding is necessarily riskier.

### 4. Fund overlap and underlying exposure

**Question:** “Am I buying the same companies through several funds?”

Show a ranked underlying-company bar chart split into direct holdings and exposure through each
fund. A pairwise overlap matrix can be an optional secondary view; the household-wide company
totals answer the more useful question first. Sector and geographic exposure can follow from
appropriate constituent metadata.

This needs dated fund constituents and weights, mapping to canonical companies, and explicit
coverage. Current classifications alone cannot produce it. Unknown holdings must remain
unknown rather than being redistributed among known constituents. Geographic listing venue is
not economic exposure; mixed and target-date funds need their own decomposition.

This has strong explanatory potential but is a materially larger data-maintenance feature than
aggregating identical instruments. Treat it as a separate project.

### 5. Allocation through time

**Question:** “How has the portfolio mix changed?”

Use a monthly 100% stacked chart for asset-class weights, plus a toggle to dollar amounts.
Keep colours tied to categories across dates, mark missing coverage, and let a selected date
show the exact breakdown. Percentages explain composition; dollar amounts explain scale.

Historical position sets and prices provide building blocks: `holdingsAt` already reads a dated
portfolio, and the history implementation has a batched query pattern. Reuse those valuation
semantics when adding a grouped historical series; do not issue one independent query per date.
See [valuation.server.ts](../../app/lib/valuation.server.ts). The current total-value series
does not directly provide the breakdown. Sparse statements can miss within-period trades, and manual aggregate history cannot
be decomposed into holdings. Label it as the mix reconstructed from recorded holdings.

Changes in these weights can reflect contributions, withdrawals, account additions, trades or
price changes. Historical reads use the instrument's current classification: editing it can
redraw the entire past rather than creating a dated reclassification event. State that limitation
unless classification history is added. The chart cannot attribute causes without additional
records. A newly imported account is not investment growth.

## Lower-priority additions and deferrals

- **Fee exposure:** annual fund-cost estimate and weighted expense ratio, with a ranked bar for
  each fund's estimated dollar cost. Useful if maintained expense-ratio metadata is added.
  Label it as fund expenses, not all investment costs; omit speculative decades-long losses
  unless the return, contribution and time assumptions are explicitly supplied.
- **Unrealized-gain bars:** feasible with existing values and reported basis, but incremental
  beside Holdings and the existing gain table. They describe remaining open positions, not
  performance over a selected period or tax lots available to sell.
- **Financial-independence scenarios:** potentially useful if this is a household goal, but
  require spending and asset-inclusion assumptions. The prior FI proposal is a starting point,
  not evidence of the user's present priority.
- **User-defined shocks:** before/after bars could show the effect of typed asset-class changes
  on today's holdings, keeping liabilities fixed unless separately specified. This requires
  scenario inputs rather than new historical data. It is a sensitivity exercise, not a forecast
  or an estimate of the probability of loss; community evidence gathered here does not establish
  demand for this particular feature.
- **Benchmark returns, contribution-versus-growth waterfalls, portfolio drawdown, Sharpe ratios
  and realized-income charts:** defer under the current positions-only contract. A total-value
  line can move because money entered or left. Treating that as investment performance would
  answer the wrong question. Hypothetical constant-holdings backtests would be a separate,
  explicitly labelled product.

The boundary is explicit in [DESIGN.md §3](../../DESIGN.md): the app does not record deposits,
withdrawals, realized trades or dividend payments. Additional charts cannot recover that history.

## Presentation and data rules

- Preserve the owner filter across every new view and drill-down.
- State the scope and denominator beside each percentage. Gross positive assets and net worth
  are different quantities; do not use net worth as the denominator for concentration.
- Preserve missing-price coverage and distinguish `other`/mixed funds from decomposed exposures.
  All instruments have classifications today; missing constituent data is a separate future
  coverage issue. An apparently precise 100% picture of an incomplete portfolio needs a visible
  qualification.
- Use stable category colours for cross-panel and time comparisons. Current donut colours encode
  rank, which is not suitable for tracking the same category across dates.
- Put the first additions on Analysis and keep detailed records in Holdings. There is no need
  to add a new navigation tab for every chart.

## Evidence and review

### What investors actually ask for

This was a bounded qualitative scan, not a representative survey. Repeated firsthand requests
are stronger evidence here than a vendor feature list; votes, search ranking and promotional
comments are not measures of investor demand. Older threads are included when they describe
durable analytical questions, not as evidence of an app's current capabilities.

**Targets and household aggregation have the clearest repeated support in this sample.**
In [“Rebalancing. How do YOU do it?”](https://www.reddit.com/r/Bogleheads/comments/1czt11d/rebalancing_how_do_you_do_it/)
(25 May 2024), participants describe spreadsheets with current allocation, model allocation and
the difference. [“Asset Tracking Spreadsheet/Template”](https://www.reddit.com/r/Bogleheads/comments/14euduv/asset_tracking_spreadsheettemplate/)
(21 June 2023) asks for combined holdings and allocation across spouses' accounts.
[“New investment allocation calculator?”](https://www.reddit.com/r/Bogleheads/comments/1h0fn92/new_investment_allocation_calculator/)
(26 November 2024) asks how to distribute new monthly money to approach an intended mix.
These support a target comparison, without establishing that users want an automated trading
system. This is why target drift ranks highly despite requiring new settings.

**People value seeing both composition and the reason their balance grew.**
In [“Which graph of your personal finances do you keep coming back to? And Why?”](https://www.reddit.com/r/financialindependence/comments/gqdm3y/which_graph_of_your_personal_finances_do_you_keep/)
(25 May 2020), participants name contributions-versus-total-value lines, allocation through
time and fee-impact views. Comments on
[“Tracking my FIRE progress over the past 6 years in a single graph”](https://www.reddit.com/r/financialindependence/comments/18s4yki/tracking_my_fire_progress_over_the_past_6_years/)
(27 December 2023) challenge growth extrapolations that mix investment results with money added.
That is evidence of real demand for growth attribution, but also a reason to defer it until
the app has the necessary records. Allocation history can serve a related, narrower question now.

**Fund overlap solves a specific household blind spot.**
In [“‘Best’ investment tracking tool”](https://www.reddit.com/r/PersonalFinanceCanada/comments/1lvx7xo/best_investment_tracking_tool/)
(9 July 2025), a user with several family accounts wants overall diversification and overlap
that brokerage tools do not show. In
[“Tools or spreadsheets for balancing portfolio across different accounts and funds?”](https://www.reddit.com/r/Bogleheads/comments/1j5ztsh/tools_or_spreadsheets_for_balancing_portfolio/)
(7 March 2025), a respondent values decomposing a target-date fund before aggregating the
portfolio. These are concrete examples, not evidence every household needs look-through.

**Fees have narrower but direct support.**
[“Is average expense ratio across multiple investments a useful metric?”](https://www.reddit.com/r/Bogleheads/comments/1ia28dp/is_average_expense_ratio_across_multiple/)
(26 January 2025) discusses why an unweighted average across funds fails to describe the
portfolio's cost. This supports showing estimated annual dollars and a value-weighted rate
once sourced fee metadata exists.

### What comparable apps demonstrate

- **Portfolio Performance:** its official
  [dashboard manual](https://help.portfolio-performance.info/en/reference/view/reports/performance/dashboard/)
  documents an actual-versus-target allocation bar chart with a delta in the tooltip. This is
  a direct precedent for recommendation 2; its return heatmaps are a different capability that
  this app's current records cannot reproduce.
- **Kubera:** [Recap](https://help.kubera.com/article/114-what-is-recap-in-kubera) offers historical
  comparisons in value or allocation terms. Its [Data API v3](https://help.kubera.com/article/171-kubera-data-api-v3)
  documents asset-class and taxable/tax-deferred/tax-free reporting. These support the usefulness
  of the dimensions and time comparison; the crossed asset-location chart is our inference,
  not a claim that Kubera renders that exact visualization.
- **Sharesight:** the [Exposure Report](https://help.sharesight.com/au/exposure-report/) combines
  directly held securities with underlying fund exposure and identifies overlaps, while accounting
  for unmatched holdings. This is a concrete precedent for recommendation 4. The report's
  testimonials are vendor-selected, so the independent discussions above carry more weight as
  evidence of user demand.
- **Empower:** the [Retirement Fee Analyzer calculation guide](https://support-personalwealth.empower.com/hc/en-us/articles/201169600-Retirement-Fee-Analyzer-Calculations-Overview)
  explains its fund expense ratios, adjustable fees and retirement projection assumptions.
  Borrowing the current annual-cost breakdown is a smaller feature than reproducing the whole
  projection model.
- **Sharesight's contribution bars:** its
  [Contribution Analysis Report](https://help.sharesight.com/nz/contribution-analysis-report/)
  includes realized and unrealized gains, received dividends and currency effects. Its chart
  form can inspire open-position gain bars, but calling those bars the same performance report
  would misrepresent what this repository knows.

Official pages were checked on 2026-09-11. They establish documented capabilities, not popularity.
No framework or chart-library choice is proposed, so no library API/version decision is needed.

### Why this ranking differs from a feature popularity list

Target drift has the strongest community signal. Asset location comes first as the smallest
distinctive addition using already-stored data; its exact chart is an analytical recommendation,
not a repeatedly requested design found in the sample. Direct concentration is similarly a
feasible intermediate step, while the stronger community question—hidden fund overlap—needs
additional data. Allocation history offers value without pretending to explain investment returns.

Research was split between Sol agents for community and official-app evidence, with Astra
auditing repository feasibility and reviewing this synthesis. The first grounding pass corrected
signed-value grouping semantics, removed a nonexistent missing-classification state, explained
retrospective classification, and qualified exact drill-down filtering. All material findings
from that pass were accepted.
The final grounding round found no material issues and independently checked the central
Portfolio Performance, Kubera, Sharesight and Bogleheads claims against their linked sources.

Suggestions not adopted in the shortlist: a concentration risk score/cumulative curve adds
interpretation and visual complexity before the basic ranked holdings are useful; another tax
donut mostly duplicates an existing grouping; an embedded-gain chart has less incremental value
than the shortlisted views because Holdings already sorts those figures. These are prioritization
choices, not claims that the charts are impossible.
