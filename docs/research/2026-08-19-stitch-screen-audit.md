# Stitch screen audit — `Portfolio Net Worth Tracker`

*Audited 2026-08-19 against project `projects/6282864270794825736`, twelve screens.*

Two passes were made. The first read each screen's **HTML**; the second viewed the **rendered
screenshots**. They disagree, and the disagreements are the most valuable part of this document —
DESIGN.md §13 was extracted from the HTML pass alone, and four of its claims do not survive looking
at the images.

> **Why the passes disagree.** HTML is fetched as markdown, and the conversion strips `<svg>`,
> `<canvas>` and CSS-drawn geometry. Every chart mark and every donut was invisible to the first
> pass. Any future extraction from Stitch must look at the images.

---

## 1. Corrections to DESIGN.md §13

### 1.1 The dark screens are a different design generation, not dark variants

This is the load-bearing correction.

| | Light screens | Dark screens |
|---|---|---|
| Brand | **Portfolio** / "Wealth Management" | **WealthArch** / "Portfolio Manager" |
| Rail CTA | Add Funds | **Invest Now** |
| Net worth | $1,245,678.90 | **$245,892.50** |
| Range chips | `1M 3M 1Y All` | **`1D 1W 1M 3M YTD 1Y Custom All`** (eight) |
| Chart annotation | none | **"Time-Weighted Return +8.2% YTD"** |
| Allocation panel | US 45% / Intl 30% | **"Target Risk 8.0 / 10"** ring gauge + four bars |
| Rendered size | 2560×2048 | 1280×1024 |

§13 states that "every screen exists in light and dark, and both palettes are transcribed from the
mock". That is wrong. **The dark palette in §13.2 was transcribed from screens belonging to the
older generation.**

§13.7 already refuses WealthArch, Invest Now, the risk gauge and the time-weighted return — without
noticing that all four come from the same generation, and that the generation they come from is the
source of the dark column.

**Action:** either re-derive the dark palette from the light screens, or regenerate the dark screens
from the current brief, before trusting §13.2's dark values.

### 1.2 §13.6's chart rule merges two different charts

| Screen | Line | Area fill | Grid |
|---|---|---|---|
| Portfolio Dashboard | 3px solid blue, clearly visible | **none** | **none at all** |
| Account Details | pale, nearly invisible on white | **yes**, pale grey | **yes**, dashed horizontal |

§13.6 describes the Account Details treatment and applies it to both charts. The Dashboard treatment
is the better one, is what `net-worth-chart.tsx` already draws, and the Account Details line is a
genuine contrast failure — a black endpoint dot is the only clearly visible mark on it.

### 1.3 Views Analysis is donut + table, not list rows

Three split panels, each a **donut with a "Total $1.2M" centre label on a tinted left half** and a
table on the right. This is what `--surface-bright` ("the tinted half of a split panel", §13.2) is
for. The HTML pass reported "no donut, styled list rows" — an artefact of SVG stripping.

### 1.4 The Dashboard allocation panel is genuinely incomplete

Two horizontal bar cards — US Equities 45%, Intl Equities 30% — **summing to 75%**. Not a conversion
artefact; the mock is incomplete.

### 1.5 The finding that changes the plan

**Mobile Views already has a "Target" column.** Asset Class / **Target** / Value, reading US Equities
55%, Intl Equities 20%, Bonds 15%, Cash & Other 10% — with **"100% Target"** as the donut's centre
label.

The mock already anticipates allocation targets, and that centre label is literally the
sum-to-100% invariant a rebalance calculation depends on. It shows target % against actual *dollars*,
which is an incomplete comparison — but the Rebalance screen is **completing something the mock
started**, not inventing a feature.

---

## 2. Screen inventory

### 2.1 Portfolio Dashboard (desktop)

- **Rail:** brand "Portfolio / Wealth Management"; nav `home` Home · `analytics` Views · `settings`
  Settings; footer CTA **Add Funds** (filled blue). No avatar on this screen.
- **Hero:** "Total Net Worth" · `$1,245,678.90` · delta `↑ +$12,450 (1.02%)` in a **light-green
  pill**, not bare text.
- **Performance panel:** range chips `1M 3M 1Y All` (1Y active); y-axis `$1.3M / $1.2M / $1.1M`;
  bare blue line, no fill, no grid, **no x-axis labels**.
- **Accounts:** three cards, each with a **coloured left edge stripe** and an `arrow_forward`:
  Automated Investing / Taxable Account · $850,234.45 · +$8,500 today; Individual IRA / Retirement ·
  $345,120.00 · +$3,200 today; Cash Account / High-Yield Savings · $50,324.45 · 5.00% APY.
- **Asset Allocation:** two bar cards (see §1.4), each with a coloured dot, label, %, a progress
  bar, and ticker sub-rows (VTI $350K, SCHD $210K; VEA $373K).
- No table, no empty state, no loading state, no error state.

### 2.2 Views Analysis (desktop)

- Page title **"Portfolio Analysis"**. Avatar **present** in the rail, plus `notifications` and
  `help_outline` top-right — neither appears on the Dashboard.
- Three split panels, donut + table, all totalling `$1.2M`, column headers in uppercase label type:
  - **Net Worth by Person** — Alex Johnson $850,000 / 70.8%; Sam Taylor $350,000 / 29.2%
  - **Value by Account Type** — Taxable Brokerage $600,000 / 50.0%; Retirement (IRA/401k) $450,000 /
    37.5%; Cash Reserve $150,000 / 12.5%
  - **Value by Asset Type** — US Equities $540,000 / 45.0%; Foreign Equities $300,000 / 25.0%;
    Fixed Income $240,000 / 20.0%; Cash & Equivalents $120,000 / 10.0%
- No group-by control, no filter, no export, no date range.

**These three breakdowns are a 1:1 match for what `app/lib/allocation.ts` exports** —
`allocationByPerson`, `allocationByAccountKind`, `allocationByAssetClass`.

### 2.3 Account Details (desktop)

- **Breadcrumb:** "Views › Brokerage Details".
- **Header card** on a subtly blue-tinted ground: icon tile · "ACC-8492-Brokerage" · chip
  "Individual Taxable" · "Opened Oct 2021" · `$142,854.00` · delta pill `↑ +$1,240.50 (0.87%)
  Today` · **Edit Account Name** button.
- **Performance:** chips `1D 1W 1M YTD 1Y` (1M active); y-axis `$145k / $140k / $135k`; pale area
  fill, dashed grid, black endpoint dot.
- **Holdings:** heading + **Search…** input. Columns `SYMBOL / NAME · SHARES · PRICE · VALUE ·
  TOTAL RETURN`. Each row has a **coloured ticker badge tile** (blue VOO, grey BND) and a
  **classification sub-line** — "Equity • Large Blend", "Fixed Income • Aggregate".
- Rows: VOO 145.234 · $482.10 · $70,017.31 · ↑ +$8,420.50 (13.6%); BND 412.050 · $72.45 ·
  $29,853.02 · ↓ −$420.15 (−1.3%); VEA 385.110 · $48.90 · $18,831.88 · ↑ +$1,120.40 (6.3%).
- Footer: **"View All 12 Positions"**.
- **No cost basis, no unrealized gain, no dividend, no cash balance panel.**

### 2.4 Mobile screens

| | Dashboard | Views | Account Details |
|---|---|---|---|
| Top bar | brand + avatar + inline Add Funds | title, `search`, `more_vert` | `arrow_back`, title, `help`, `more_vert` |
| Range chips | `1D 1W 1M 3M YTD 1Y` | `1M YTD ALL` | `1D 1W 1M YTD` |
| Dropped vs desktop | **entire Asset Allocation section**, chart body, drill-in arrows | **all three breakdowns** | Price column, $ total return, account number, opened date, 1Y range, Edit |
| Added vs desktop | "User Profile" block, "Open a new account" | Total Value card, **Target column**, TWR bar chart | **Deposit** / **Transfer** buttons |
| Bottom nav | Home · Views · Settings | same, **Views active** (blue pill) | same |

**Mobile Views is not a reflow of desktop Views.** Desktop is three attribution breakdowns; mobile
is allocation-vs-target plus a monthly **bar** chart labelled "Time-Weighted Return" that displays
no return figure. They are two competing proposals for what "Views" means.

**Mobile Views is also the only screen in all twelve carrying an as-of timestamp** — "As of Today,
4:00 PM EST". DESIGN.md §11 calls that timestamp "non-negotiable".

---

## 3. Cross-screen findings

**Consistent across all twelve:** the nav triad Home / Views / Settings — left rail on desktop,
bottom bar on mobile. It is the only fully consistent element, and **Settings is a destination with
no screen anywhere in the set.**

**Inconsistent:**

- **Five different range-chip sets** across six screens: `1M 3M 1Y All` · `1D 1W 1M 3M YTD 1Y` ·
  `1D 1W 1M YTD 1Y` · `1D 1W 1M YTD` · `1M YTD ALL`, plus the dark generation's eight-chip strip.
  Normalising this is the single clearest consolidation task.
- **Avatar, notification bell and help icon** appear on Views and Account Details but not the
  Dashboard.
- **Every fabricated figure drifts** between desktop and mobile except the net-worth headline.
  Account names, balances, tickers and allocation percentages are mutually inconsistent — mobile
  Dashboard has a Roth IRA at $150,448.45 where desktop has an Individual IRA at $345,120.00; mobile
  Account Details holds VTI/VXUS/BND where desktop holds VOO/BND/VEA, sharing only BND and giving it
  a different value. **Do not lift these as fixtures.**

**Absent from all twelve:** empty state, loading skeleton, error state, stale-data indicator,
`<select>` or dropdown, real user name or email, and any Upload or Settings screen.

**Navigation model.** The Account Details breadcrumb reads "Views › Brokerage Details", but the
Dashboard's account cards carry `arrow_forward` and can only lead to the same place. The set implies
a diamond — Dashboard and Views as siblings, both funnelling into Account Details — and whatever is
built needs the breadcrumb to be origin-aware.

## 4. What the mock supplies that this app must refuse

Extending §13.7 with what the visual pass added:

| From the mock | Why refused |
|---|---|
| "WealthArch", "Invest Now", "Add Funds", "Deposit", "Transfer" | A brokerage's brand and CTAs. Nothing to sell, no cash to move |
| "Time-Weighted Return +8.2% YTD" | Not computable without cash flows (§3, §14.2) |
| "Target Risk 8.0 / 10" gauge | No risk model in the schema |
| Notification bell, avatar menu | Single-tenant, self-hosted, no user accounts (§10) |
| Search over accounts | A filter over a dozen rows costs more than it saves |
| "ACC-8492-Brokerage" | Invented. Bind to `external_account_number` or drop |
| Crypto account (dark generation) | Out of scope (§1) |
| Material Symbols via CDN | Offline and privacy (§11) — inline SVG instead |
| Every figure on every screen | Fabricated, and mutually inconsistent across screens |

## 5. What the mock supplies that is worth keeping

- The **donut + table split panel**, and `--surface-bright` as its tinted half.
- The **coloured left-edge stripe** on account cards — a free channel for account kind.
- The **ticker badge tile** and the **classification sub-line** in the holdings table.
- The **delta pill** (tinted ground) rather than bare coloured text.
- The **"100% Target"** donut centre label — see §1.5.
- The **as-of timestamp**, currently on one screen, belonging on all of them.

---

## Reproducing this audit

Screens were listed with the Stitch MCP `list_screens` against project `6282864270794825736`.
Screenshot URLs returned by that call are `lh3.googleusercontent.com` links that **serve 512px
thumbnails by default**; append `=s2560` to the URL for full resolution. The HTML `downloadUrl`
fields return the Tailwind source, but reading them through a summarising fetcher loses all SVG.
