# Market analysis — self-hosted portfolio trackers and the FIRE audience

*Researched 2026-08-19. Sources listed at the foot; every substantive claim is attributed.*

Background research for the screen recommendations in
[`2026-08-19-screen-recommendations.md`](./2026-08-19-screen-recommendations.md). The question was
narrow: **what would make this app excellent for someone deep in the FIRE movement**, given that
DESIGN.md §3 commits it to positions-only data with no transaction ledger.

## Method and its limits

Recorded so the findings can be weighed rather than taken flat.

- **reddit.com is unreachable** from the fetcher, so r/financialindependence and r/Fire could not be
  read directly.
- **bogleheads.org is behind Cloudflare.** Bogleheads claims below come from search-result excerpts
  of specific threads and wiki pages, with URLs, and are marked where it matters.
- **Ghostfolio findings are primary evidence** — its source tree was read directly, which makes
  them the strongest material here.
- One cluster of retention statistics was traced to SEO/AI-generated marketing blogs and **must not
  be cited as fact**; see "Manual-entry fatigue" below.

---

## 1. The unclaimed position

The single most useful finding, and the one that shapes everything else:

> **No self-hosted web app combines Portfolio Performance's rebalancing rigor with Ghostfolio's UX.**

- **Ghostfolio** has FIRE framing — its README literally targets people "interested in financial
  independence" and "saying no to spreadsheets" — but has **no rebalancing feature at all**. A
  GitHub issue search returns **zero** issues with "rebalanc" in the title; there is one open
  request, [#6840](https://github.com/ghostfolio/ghostfolio/issues/6840), asking for an X-Ray rule
  for allocation drift. And its **FIRE page is Premium-gated even in the self-hosted build**: for
  `subscription.type === 'Basic'` the template sets `opacity: 0.67` and `pointer-events: none`.
- **Portfolio Performance** has the reference rebalancing implementation anywhere (see §5) and a
  FIRE widget, but is a **Java/Eclipse desktop app**. Reviewers describe an interface that "feels
  like a complex Excel spreadsheet" and "looks like a Bloomberg terminal", hours of setup, and a
  local data file that means no casual check from a phone.

That gap is the strategic case for the Independence and Rebalance screens.

## 2. Positions-only is not a handicap for this audience

DESIGN.md §3 and §14.2 treat the absence of a transaction ledger as a significant limitation. For
the FIRE use case specifically, the evidence says otherwise:

- The **Mad Fientist's FI Laboratory** is built around a monthly "New Record" prompt where you copy
  balances in by hand. Balances only.
- The **Bogleheads quarterly balance sheet** practice is balances only.
- **Portfolio Performance's FIRE widget** simply **asks the user to set the FIRE number manually**.

The only input every FIRE metric bottoms out in — and the only one the schema genuinely cannot
derive — is **annual expenses**. That is one typed scalar, and the two closest comparable products
both solve it by asking.

## 3. What FIRE practitioners track, and what each metric needs

Marked against this app's positions-only constraint.

| Metric | Inputs needed | Feasible here? |
|---|---|---|
| FI number / 25× | Annual expenses; SWR | **+1 setting** |
| Progress to FI | Above + portfolio value | **+1 setting** |
| Withdrawal rate | Annual spend; definition of "spendable" | **+1 setting + account taxonomy** |
| Years of expenses covered (runway) | Expenses + liquid/illiquid distinction | **+1 setting + taxonomy** |
| **Asset allocation drift vs target** | Positions, asset-class mapping, target weights | **Fully derivable — the highest-value thing a positions-only app can do** |
| **Rebalancing bands** | Targets + band policy | **Fully derivable** |
| **Tax location / asset placement** | A tax-type tag per account | **Fully derivable — the app already has `account.tax_treatment` (§4.5)** |
| Dividend income coverage | Forward yield per holding; expenses | **Numerator yes** (schema has the columns, nothing writes them); denominator +1 setting |
| Lean / Fat FI | Two more expense bands | **+2 settings** — just expense scenarios |
| Coast FI | Expenses, real return, target age | **+3 settings** (adds a *return* assumption) |
| Time-to-FI projection | Balance, contribution rate, return | **+3 settings**, and contribution rate is not derivable |
| Sequence-of-returns risk | Equity split, cash buffer, glidepath | **Partial** — can show current vs target glidepath, cannot simulate |
| **Savings rate** | Income, contributions | **No** — needs cash flows |
| **Realized gains, TWR, IRR** | Transaction ledger | **No** (§14.1) |

### Two live disagreements worth designing around

1. **Savings rate has no standard definition.** ChooseFI's own explainer concedes both gross and net
   are valid and that employer match, healthcare premiums, mortgage principal and taxes are all
   debatable — *"when someone tells you they have a 50% savings rate, you know almost nothing
   without knowing how that number is calculated."* If it is ever built, the definition must be an
   explicit, visible setting.
2. **The safe withdrawal rate is not 4%.** FIRECalc/Trinity give 4%. Early Retirement Now's SWR
   series argues **3.25–3.5%** survived the worst historical cohorts, and that failure rates are
   **conditional on the Shiller CAPE** — roughly 1.4% failure across all history but ~12% starting
   from CAPE > 20 with the S&P at an all-time high. Portfolio Charts adds a third concept, the
   **perpetual withdrawal rate** (preserves real principal), explicitly recommended for long early
   retirements. **A single hardcoded 4% is the wrong default**; the screen should show the spread.

### The savings-rate workaround (inference, not a cited product behaviour)

Portfolio Performance ships **"Performance-neutral transfers"** and **"Delta (since first
transaction)"** widgets, which exist to separate money added from money the market made. A
positions-only app with dated snapshots and per-security prices can do the same: price the *old*
holdings at the *new* date, and the residual against the actual change is implied net contribution.

This is recorded as a **deferred** direction. It would reverse DESIGN.md §3 and §14.2, and it
conflates reinvested dividends and in-kind transfers while being exact only at statement boundaries.

## 4. Competitive landscape

### The two closest analogues

**Ghostfolio** (AGPLv3, self-hosted, NestJS + Angular + Postgres). Navigation is two page groups:
*Home* — Overview, Holdings, Summary, Markets, Watchlist; *Portfolio* — Activities, Allocations,
Analysis, FIRE, X-Ray.

- **Allocations** slices by Currency, Asset Class, Holding, Sector, Continent, Market, Region,
  Country, Account, **ETF Provider** and **ETF Holding** (look-through). No targets, no drift.
- **X-Ray** is a static rule engine, not a score: account-cluster risk, asset-class cluster risk,
  currency cluster, economic/regional market cluster, emergency fund, fees, liquidity. Default
  thresholds read from source: equity band **min 0.78 / max 0.82**, account concentration max 0.5,
  fee ratio max 0.01 of total investment volume. User-tunable.
- **FIRE page** is two blocks: a calculator (interest rate, savings rate, retirement date), and a
  "sustainable retirement income" sentence — *"If you retire today, you would be able to withdraw
  $X per year or $Y per month, based on your total assets of $Z and a safe withdrawal rate of N%."*
  Behind an experimental flag the SWR becomes a `<select>`.
- Performance metric is **ROAI** (Return on Average Investment), not TWR/IRR.

**Portfolio Performance** (open source, Java desktop). Its dashboard is a user-composed widget grid,
and the catalogue is the most complete statement anywhere of what a portfolio dashboard can show —
including **FIRE Calculation**, **Taxonomies: TARGET Value**, **Actual vs Target Allocation**,
**Performance-neutral transfers**, monthly/yearly return heatmaps, TTWROR, IRR, Sharpe, maximum
drawdown and duration, semivariance, upcoming dividends, and portfolio turnover rate.

### Everything else

| Product | What it is | Praised for |
|---|---|---|
| **Empower** (ex-Personal Capital) | Free aggregator monetised by wealth-management upsell | Retirement Planner (Monte Carlo), **Recession Simulator**, **Investment Checkup** (current vs recommended allocation), Fee Analyzer |
| **Monarch Money** | Paid Mint successor. Core $99.99/yr, Plus $199/yr (2026) | Won the Mint migration; **shared household dashboards for couples** |
| **Kubera** | Premium all-asset balance sheet. $249/yr, no free tier | Crypto/DeFi, private equity, real estate, collectibles; **Fast Forward**; **Life Beat** beneficiary handoff |
| **Sharesight** | Investment record-keeping + tax | **True total return including dividends, DRP and FX**; Diversity and **Exposure** (ETF look-through) reports |
| **Firefly III** | Self-hosted double-entry budgeting | Data never leaves your box. Maintainer states it is **not** for investments and redirects to Portfolio Performance |
| **Maybe Finance** | Rails/Postgres OSS finance app | **Repo is archived** — the OSS-personal-finance abandonment risk in concrete form |
| **Actual Budget** | MIT, local-first envelope budgeting | YNAB-quality envelopes, self-hostable, offline-first |
| **Snowball Analytics** | Dividend-first tracker | **Forward dividend calendar**, income forecast, dividend growth |
| **ProjectionLab** | Privacy-first planner, $129/yr | Monte Carlo, **Sankey cash-flow diagrams**, Roth conversions, 72(t)/SEPP, ACA subsidies. **No bank linking** |
| **FIRECalc** | Historical-sequence simulator | Three inputs; tests every US period since **1871** |
| **cFIREsim** | Open-source simulator | Control — but "overwhelming" |
| **Rich, Broke or Dead** | Post-FIRE outcome visualiser | Overlays **mortality tables** — the only one that admits you might die first |
| **Boldin** (ex-NewRetirement) | Retirement planner | **Roth Conversion Explorer**, bracket-filling Tax Insights. Methodology publicly criticised by Kotlikoff |

Adjacent tools worth knowing: **Portfolio Charts' Withdrawal Rates chart** (safe, perpetual and
long-term rates from real sequence data) and **Passiv** (the rebalancing-execution layer, §5).

## 5. Rebalancing and allocation UX — the reference implementations

**Portfolio Performance — closest thing to a spec.**

- Rebalancing is a view on any taxonomy (Industries, Regions, or a custom classification).
- You enter a **target Allocation %** per category and a **Weight** per security within it.
- Allocations should sum to 100% but are not forced to — **colour coding flags the deviation**.
- Target value = allocation × total portfolio value; the delta against actual is distributed across
  securities by weight.
- Two output columns: **"Rebalance (Amount)"** and **"Rebalance (Shares)"**. **Negative = sell,
  positive = buy.**
- The manual explicitly caveats that fractional shares often are not purchasable, so the suggested
  quantity needs practical rounding.

**Passiv — drift monitoring and execution.** Tracks "accuracy" continuously; emails when the
portfolio falls outside targets **or when cash/dividends land**; given new cash, shows which assets
are underweight and by how many units. **Buy-Only is the default**, and the stated reason is tax and
commission avoidance.

**M1 Finance — rebalancing as a side effect of cash flow.** Auto-invest routes every deposit to
underweight slices first; withdrawals sell overweight positions first; a manual rebalance button
exists separately. Stated advantage: only buys, therefore no taxable events.

**Empower Investment Checkup.** Current allocation vs Empower's recommended target, plus a
side-by-side comparison across historical performance, projected savings, and risk/return. The
target is *Empower's*; whether users can set their own is unverified.

**Kubera.** A "Target" column in the asset-allocation view with rebalance tips (help article 99).
Depth is disputed — reviewers say it "deliberately avoids portfolio rebalancing suggestions", which
contradicts the help doc. Treat the doc as authoritative on existence, the reviews as commentary.

**Sharesight.** Diversity and Exposure reports; **no evidence of rebalancing suggestions** found
(absence of evidence, not confirmed absence).

### The band policy: Swedroe's 5/25 rule

For any asset class at **≥20%** of target, rebalance when it deviates by **5 absolute percentage
points**; for classes **<20%**, use a **25% relative** band. Worked example from the forum: a 60/40
target triggers at 65/35 or 55/45. Actively debated: whether hitting a band means rebalancing *that
class* or the *whole portfolio*.

## 6. Beating the spreadsheet

Popular FIRE templates run four tabs: **Instructions · FIRE Calculator · Net worth input · Net worth
summary**, with asset rows as Category / Item / Value laid out as monthly columns over a ten-year
horizon, and often an **Asset Rebalancing Calculator**.

**Bogleheads-style sheets** (from search excerpts) have a "Bottom Up" tab deriving allocation
percentages from the funds held, and a Holdings tab with a **collapsed column group that expands to
expose per-account target allocations**.

**The Retirement Manifesto's annual update** is the most concretely documented workflow found:
update all 12/31 balances → capture current allocation → compare actual vs target and plan
rebalancing → update **bucket** funding levels (~3 years of spending in the safest bucket) →
reconcile prior-year spending → set guardrails from the SWR.

From a Bogleheads "what do you track" thread: a quarterly balance sheet, **"FIRE ratios"** (how many
times annual expenses have been saved), and **current expenses evaluated against 4%, 3% and 2%
withdrawal rates side by side**.

**What an app must beat:** per-account target allocation, a monthly snapshot series, multiple
simultaneous SWR columns, asset-location visibility, arbitrary what-if editing, and a once-a-month
one-screen data-entry ritual.

## 7. Why people abandon trackers

- **Empower — the advisor upsell.** Outreach commonly begins once linked balances cross ~$100,000.
  A quoted user: *"The constant phone calls from Empower's advisory team were the last straw. I just
  wanted to track my investments, not get sold on wealth management."* Empower's own support has a
  section titled "Incorrect Data Issues" covering "Why is there a spike/drop in my Net Worth".
- **Mint's shutdown.** Announced Nov 2023, shut March 2024; ~25M users pushed to Credit Karma, which
  **dropped category budgets, custom alerts and historical net-worth tracking**. Net effect: the
  category went from free to roughly $95–110/yr.
- **Kubera** — $249/yr, no free tier, no budgeting.
- **Portfolio Performance** — steep learning curve, desktop-only, no casual phone check.
- **Ghostfolio** — manual entry or CSV only, no brokerage connectivity, no budgeting, no
  rebalancing, FIRE page gated.
- **Firefly III** — explicitly not for investments.
- **Maybe Finance** — archived.

**Manual-entry fatigue — treat the numbers sceptically.** Several 2026 blog posts assert that
manual-entry apps lose users at 3× the rate of auto-sync, that 34% of bank connections need
re-auth within 90 days, and that 68% abandon rather than reconnect. **These figures trace only to
low-credibility SEO/AI-generated marketing blogs and could not be traced to any primary source. Do
not cite them.** The *qualitative* pattern — friction per entry, and re-auth breakage as the
abandonment trigger — is corroborated independently and is safe.

**The non-obvious one.** Boldin's own blog argues net-worth tracking has downsides: a low number is
demoralising early on, frequent tracking can prompt impulsive selling, and net worth omits cash
flow, income stability and future liabilities. Practitioners land on **monthly** as the sweet spot.

## 8. What this implies for this app

1. **Two data-model additions unlock most of §3's table**: annual expenses, and target weights.
2. **`account.tax_treatment` is an unexploited advantage.** Asset location is a top-tier FIRE metric
   most tools cannot support; §4.5 already chose the three-way enum that makes it possible.
3. **Show the SWR spread, never a single rate.**
4. **Rebalancing is the differentiator.** It is fully derivable from positions, and the nearest
   self-hosted competitor has none of it.

---

## Sources

**Ghostfolio** — [README](https://github.com/ghostfolio/ghostfolio) ·
[X-Ray rules](https://github.com/ghostfolio/ghostfolio/tree/main/apps/api/src/models/rules) ·
[FIRE page template](https://github.com/ghostfolio/ghostfolio/blob/main/apps/client/src/app/pages/portfolio/fire/fire-page.html) ·
[Issue #6840](https://github.com/ghostfolio/ghostfolio/issues/6840)

**Portfolio Performance** — [Dashboard widgets](https://help.portfolio-performance.info/en/reference/view/reports/performance/dashboard/) ·
[Rebalancing](https://help.portfolio-performance.info/en/getting-started/rebalancing/) ·
[TTWROR](https://help.portfolio-performance.info/en/concepts/performance/time-weighted/) ·
[mobile app](https://github.com/portfolio-performance/mobile-app) ·
[review](https://awealthyblog.com/p/my-honest-review-of-portfolio-performance)

**Rebalancing & allocation** — [Passiv](https://passiv.com/portfolio-rebalancing-QT/) ·
[M1 rebalancing](https://help.m1.com/en/articles/9332105-how-to-rebalance-your-m1-investment-account) ·
[Kubera targets](https://help.kubera.com/article/99-set-a-target-allocation-for-my-portfolio-and-rebalance) ·
[Empower Investment Checkup](https://www.benzinga.com/money/empower-personal-dashboard-review-a-hands-on-look-at-the-investment-checkup-tool) ·
[Sharesight Diversity](https://help.sharesight.com/uk/diversity_report/)

**Bogleheads** *(Cloudflare-blocked; via search excerpts)* —
[Rebalancing](https://www.bogleheads.org/wiki/Rebalancing) ·
[Tax-efficient fund placement](https://www.bogleheads.org/wiki/Tax-efficient_fund_placement) ·
[Spreadsheet](https://www.bogleheads.org/wiki/Using_a_spreadsheet_to_maintain_a_portfolio) ·
[5/25 rule](https://www.bogleheads.org/forum/viewtopic.php?t=185596) ·
[What do you track](https://www.bogleheads.org/forum/viewtopic.php?t=355359)

**Withdrawal rates** — [ERN SWR series](https://earlyretirementnow.com/safe-withdrawal-rate-series/) ·
[ERN Part 54 — CAPE](https://earlyretirementnow.com/2022/10/12/dynamic-withdrawal-rates-based-on-the-shiller-cape-swr-series-part-54/) ·
[Portfolio Charts](https://portfoliocharts.com/charts/withdrawal-rates/) ·
[FIRECalc](https://www.firecalc.com/) ·
[Rich, Broke or Dead](https://engaging-data.com/will-money-last-retire-early/)

**Spreadsheets & workflow** — [Mad Fientist FI Laboratory](https://www.madfientist.com/fi-laboratory/) ·
[Retirement Manifesto annual update](https://www.theretirementmanifesto.com/a-step-by-step-guide-to-your-annual-financial-update/) ·
[Networthify](https://networthify.com/calculator/earlyretirement) ·
[ChooseFI on savings rate](https://choosefi.com/spending-smarter/how-to-calculate-your-savings-rate)

**Products & abandonment** — [Empower review](https://robberger.com/empower-review/) ·
[Empower "Incorrect Data Issues"](https://support-personalwealth.empower.com/hc/en-us/sections/200230660-Incorrect-Data-Issues) ·
[Mint shutdown](https://www.monarch.com/blog/mint-shutting-down) ·
[Kubera review](https://thecollegeinvestor.com/36895/kubera-review/) ·
[Firefly III on investments](https://github.com/orgs/firefly-iii/discussions/11922) ·
[Maybe Finance](https://github.com/maybe-finance/maybe) ·
[ProjectionLab](https://projectionlab.com/) ·
[Boldin on tracking net worth](https://www.boldin.com/retirement/the-pros-and-cons-of-tracking-net-worth-and-how-to-keep-this-metric-in-perspective/)

**Cited only to flag as unverified** — [strategia-x.com](https://www.strategia-x.com/blog/2026-04-12-why-budgeting-apps-fail-30-days-fintech-ux-data/) ·
[spendtrak.app](https://spendtrak.app/blog/why-people-quit-budgeting-apps)
