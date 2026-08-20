# Screen recommendations — from the Stitch set to a FIRE instrument

*Written 2026-08-19. Recommendation, not an approved slice — nothing here has been built.*

Reads on top of [`2026-08-19-stitch-screen-audit.md`](./2026-08-19-stitch-screen-audit.md) (what the
mock actually contains) and [`2026-08-19-market-analysis.md`](./2026-08-19-market-analysis.md) (what
the audience needs). The data layer is designed separately in
[`2026-08-19-fire-data-layer-design.md`](./2026-08-19-fire-data-layer-design.md).

## Problem statement

The Stitch project supplies three screen templates — Portfolio Dashboard, Views Analysis, Account
Details — and DESIGN.md §13 has already mined them for a token system. What was never asked is
whether they are the right three screens.

They are not, and the reason is structural rather than a matter of taste. **The mock was generated
from a brokerage brief**: its rail CTA is "Add Funds", its account screen offers "Deposit" and
"Transfer", and it annotates a "Time-Weighted Return". This app has nothing to sell, no cash to
move, and — per §3 — no cash-flow data from which a time-weighted return could be computed. Adopted
wholesale, the set would ship a household balance-sheet instrument wearing a trading app's
navigation.

Meanwhile three capabilities are already paid for in the schema and rendered by nothing:

- **`holding_valued.cost_basis` and `.unrealized`** — computed by the view, on no screen.
- **The `coverage` every `AllocationSlice` carries** — rendered on Analysis, nowhere else.
- **`account.tax_treatment`** — the three-way enum §4.5 chose over a boolean *specifically* so
  sheltered-vs-taxable could be seen. No dashboard groups by it.

Market research puts asset location among the metrics FIRE practitioners track most and most tools
cannot support. This app can, today, and does not.

## The strategic case

> **No self-hosted web app combines Portfolio Performance's rebalancing rigor with Ghostfolio's UX.**

Ghostfolio has FIRE framing but **no rebalancing at all** — zero issues with "rebalanc" in the
title, one open request (#6840) — and its **FIRE page is Premium-gated even in the self-hosted
build**. Portfolio Performance has the reference rebalancing implementation and is a Java desktop
app reviewers compare to a Bloomberg terminal.

And positions-only is not the handicap §14.2 treats it as: the Mad Fientist's FI Laboratory and the
Bogleheads quarterly balance sheet are both balances-only, and Portfolio Performance's FIRE widget
simply asks the user for the FIRE number. **The one input every FIRE metric bottoms out in is annual
expenses** — one typed scalar.

## Assumptions

Two questions were put to the user and left unanswered. Both are resolved here; either being wrong
changes this materially.

1. **Typed scalars are acceptable.** Choosing Independence and Rebalance necessarily accepts
   user-entered annual expenses, target weights and a withdrawal-rate set — neither screen has a
   number on it otherwise. Every figure resting on an assumption must say so on screen.
2. **DESIGN.md §3 stands.** Contributions could be inferred by pricing the *old* position set at the
   *new* date and taking the residual — Portfolio Performance ships this as "performance-neutral
   transfers", and it would unlock a savings-rate proxy and a real time-weighted return. Recorded
   under Deferred; designed around nowhere. Nothing here reverses §3 or §14.2.

---

## Part 1 — Changes to the three existing screens

`analysis.tsx` and `account.tsx` are **built screens**, not mocks, so these are edits to working
code.

### Cross-cutting

| Change | Why |
|---|---|
| **One range set: 1M / 3M / 1Y / All** | Five different sets across six screens. `overview.tsx` already implements this one. Sub-daily ranges are meaningless — §6.2 polls every 15 min and mutual funds strike one NAV a day, so `1D` is a chart with two points |
| **"As of" timestamp wherever a figure appears** | §11 calls it "non-negotiable — the one genuinely dangerous failure mode in a finance app". Present on **one of twelve** screens |
| **Stale-price banner** | `quote.is_stale` → `holding_valued.is_stale` exists; `--warning` / `--warning-surface` exist in `app.css`; nothing renders it |
| **Coverage labelling on every total** | §8.2's rule. `analysis.tsx` does it; Overview only on the headline; `account.tsx` not at all |
| **Empty / first-run / error states** | Absent from all twelve screens. `EmptyState` and `FirstRunPrompt` exist in code with no drawn design. §13.7's "a zero and an empty instance must not look alike" needs a visual |
| **Delete the brokerage furniture** | Bell, avatar, help, Add Funds, Deposit, Transfer, account search |

### Overview (`app/routes/overview.tsx`)

- **Two figures in the hero, not one.** Net worth answers "what do I have"; the FIRE question is
  "how far am I". Pair it with **progress to FI** and **years of expenses covered**.
- **Fix the allocation panel** — replace the 75% pair of bars with `allocationByAssetClass`, which
  sums to `1.000000` by construction. Fold a tail beyond five groups into "Other" (§13.3).
- **Design the negative slice.** `allocation.ts` deliberately returns a *negative* share for a
  liability, and the mock's bar has no design for one. Guaranteed to occur; currently undrawn.
- **Keep the account cards' coloured left edge** — a free channel for account kind.

### Analysis (`app/routes/analysis.tsx`)

Already renders exactly the three breakdowns `allocation.ts` exports, with coverage notes.

- **Add the fourth cut: by tax treatment.** Taxable / tax-deferred / tax-free. Highest-value missing
  breakdown; the column is on every `ValuedHolding` row.
- **Do _not_ add after-tax net worth.** `tax_treatment` is a **category, not a rate** — no bracket,
  no state, no filing status, no age. A ×0.7 haircut on `tax_deferred` is exactly the fabricated
  figure §13.7 exists to prevent. §4.5 licenses *storing* the distinction, not *inventing* the rate.
  Show the split; let the reader apply their own judgement.
- **Keep the donut + table split panel** — the mock's strongest layout, and `--surface-bright`
  already exists for it.
- **Choose the desktop model over mobile.** Mobile Views is a different information model, not a
  reflow; its TWR bar chart is unbuildable and must go, and its target column is promoted below.

### Account Details (`app/routes/account.tsx`)

- **Add a cost basis / unrealized panel.** The view computes both; rendered nowhere. Carry §8.2's
  coverage sentence — `cost_basis_per_share` is nullable and 401k statements routinely omit it.
- **Extend the holdings table** to Symbol · Name, Quantity, Price, Value, Cost basis, Unrealized,
  % of account — all `tabular-nums` (§13.4). Keep the mock's ticker badge tile and classification
  sub-line.
- **Replace Deposit/Transfer with "Set balance"**, for `bank` and `liability` accounts only — §5.2's
  single-position path and §11's one permitted mobile write.
- **Fix the chart's contrast** — the account chart's line is nearly invisible on white.
- **Drop "ACC-8492"** or bind it to `external_account_number`.
- **Origin-aware breadcrumb** — the mock hardcodes "Views ›"; Overview reaches the same screen.

---

## Part 2 — Three new screens

### A. Independence — the FIRE page

- FI number, progress, surplus, safe annual withdrawal, years covered, and the **implied rate** the
  household is already at — the figure that says which rate is the live question.
- **A rate ladder, not a single 4%.** Bogleheads track 4/3/2% simultaneously; Early Retirement Now
  argues 3.25–3.5% survived the worst cohorts and that failure is CAPE-conditional. Shown against
  two bases = six cells, one table.
- **No expenses recorded → no figures and no zeros.** An `EmptyState` pointing at Settings.

### B. Allocation & Rebalance

The gap in the market, and — per the audit — the completion of something the mock already started
with its Target column and "100% Target" donut label.

- **Target vs actual** per asset class and per classification, with signed drift in points.
- **Swedroe 5/25 bands** — absolute ±5 points for targets ≥20%, relative ±25% below.
- **Rebalance (Amount) only** — Portfolio Performance's Shares column does not port; see Refusals.
- **Buy-only mode**, Passiv's default, for the reason it states: no taxable events.
- **Withhold trade amounts whenever coverage is partial.** Drift is a diagnosis you can
  sanity-check; a trade amount is an instruction you act on with money.

### C. Holdings — the workhorse

§8.1 calls it the workhorse and says it "absorbs what would otherwise be four more pages". It is a
55-line stub and **absent from the Stitch set entirely**.

- Full columns on desktop, cards with tap-to-expand on mobile. Filter by person / account / tax
  treatment / classification; group by any, with subtotals.
- **Three coverages, not one** — a 401k holding is routinely priced *and* has no cost basis, so
  `unrealized`'s coverage is a strictly different count from `value`'s.

---

## What must be refused

Extending §13.7:

1. **Years-to-FI, or any projection.** Needs a return assumption and a savings rate; §3 records no
   cash flows, so contributions and market movement are indistinguishable.
2. **Success probability / Monte Carlo.** Over a return distribution the app does not have.
3. **After-tax net worth or an after-tax FI number.** See Analysis above.
4. **Rebalance (Shares)**, and any lot- or tax-aware rebalancing. The trade is computed per
   **group**, and which instrument inside it to trade is a decision nothing in the schema supports —
   lots and wash sales are invisible (§14.1), and a 401k trades in dollars anyway.
5. **A "Rebalance now" button.** No brokerage connection. This is "Invest Now" in a new costume: the
   column is advice, and a button implying execution lies about what the product is.
6. **A single headline SWR, or an average of the three.** The screen exists to show the spread.
7. **Inflation adjustment.** No price index in the schema.
8. **Dividend-funded withdrawal framing.** A safe withdrawal rate is a total-return rule, not an
   income rule.
9. **Drift or trade direction carried by colour alone** (§12).

## Deferred

- **Contribution inference / savings rate / TWR.** See Assumption 2.
- **The Upload flow (4 screens).** The **diff preview** is the highest-stakes screen in the app —
  §5.2's "a missing row means sold" makes it the only guard against a filtered CSV silently deleting
  real holdings — and it has no design anywhere.
- **The Settings tabs.** Stitch carries a `settings` nav item on all twelve screens with no
  destination. Classifications, Instruments and History are unbuilt; §8.4 argues the Instruments tab
  is the only place stale manual prices surface.
- **Income.** Renders a hardcoded empty state because nothing populates `quote.yield_pct`.

## Sequencing

1. `migrations/0004_plan.sql` → regenerate `app/lib/database.generated.ts`.
2. `decimal.ts` extraction + tests. **Gate: `tests/allocation.test.ts` passes unchanged.**
3. `allocation.ts` additions — the three bases, two new breakdowns.
4. `plan.server.ts` + input field helpers + fixtures + DB tests.
5. `independence.ts` and `rebalance.ts` — independent, parallelisable.
6. `holdings-view.ts`.
7. `format.ts` additions.
8. Routes: new `independence.tsx`; rebuild `holdings.tsx`; extend `analysis.tsx` with the target
   panels rather than adding a fourth dashboard; new Settings tabs.
9. `app/routes.ts` nav — §8.4 orders by frequency, so Independence sits after Income.
10. **DESIGN.md is part of the work** — the §13 corrections from the audit, §8.2's
    second-denominator rule, §14's new limitations, §13.7's new refusals.

## Verification

- Every figure traced to a column in `migrations/*.sql` or to a named new setting — the §13.7 test.
- Existing helpers reused, not reinvented.
- No `Number()` on a money value anywhere in the new work.
- **One reconciliation test that belongs nowhere else:** `totalBase(await currentHoldings(db))`
  equals `(await netWorth(db)).amount` exactly — the §8.2 drift guard for the whole new surface.
- End to end: seed the demo database, run the dev server, and check each screen against a portfolio
  containing at least one liability, one unpriced holding and one null cost basis.
