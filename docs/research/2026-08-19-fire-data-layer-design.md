# Data-layer design — Independence, Rebalance and Holdings

*Designed 2026-08-19. Proposal, not built. Companion to
[`2026-08-19-screen-recommendations.md`](./2026-08-19-screen-recommendations.md).*

## The finding that shapes everything else

`USD` is seeded with classification `Cash` → `asset_class = 'cash'`
(`migrations/0001_initial_schema.sql`), and a personal loan is a **negative `USD` quantity** (§2).

So today, `allocationByAssetClass()` files an $8,000 loan **into the cash slice**, netting it against
real cash.

On the Analysis page that is merely odd. On a rebalance page it is money-losing: a household with a
$300k mortgage recorded as a liability account, targeting 5% cash, would be told to **buy $315k of
cash**. Every denominator decision below follows from this.

## 1. Three bases, and no `is_liquid` column

There is no single liquidity question, so a boolean would be **silently wrong** on whichever screen
it was not set for — and nothing records which question it was set to answer.

| Base | Excludes | Question |
|---|---|---|
| `totalBase` | nothing | "what is the household worth" — must reconcile exactly with `netWorth()` |
| `accessibleBase` | `401k`, `ira` | "what can I reach before 59½" |
| `investableBase` | `liability` | "what pot does a rebalance move money inside" |

No two are the same exclusion.

Derived from `account.kind`, not stored, via an exhaustive map:

```ts
const IN_INVESTABLE = {
  brokerage: true, "401k": true, ira: true, bank: true, liability: false,
} satisfies Record<AccountKind, boolean>;
```

so adding a kind to the schema is a **compile error** at the exact place a decision is required. A
boolean column defaults, and defaults are how a house lands in a withdrawal base.

**Why `kind` and not `tax_treatment`:** a Roth IRA is `tax_free` and still age-restricted; a taxable
brokerage is `taxable` and spendable tomorrow. Accessibility is a `kind` question.

**Why home equity is not excludable:** §1 puts real estate out of scope, so there is no home in the
schema to exclude. Building the mechanism would advertise a capability the app lacks. If a user
records a house as a manual position anyway, the app cannot know — that is a new §14 limitation to
write down, not a column.

### The second denominator, resolved

`allocation.ts`'s **gross positive total** stays correct for display shares and is **wrong for
rebalancing**, for three reasons:

1. It sums *slices*, not holdings — so a liability nested inside the cash slice is invisible to it.
2. It drops negatives entirely — so a margin debit inside a brokerage account is ignored, though it
   genuinely reduces the pot it sits in.
3. With any negative slice present the weights do not sum to 1, and a rebalance whose weights do not
   sum to 1 produces trades that do not net to zero.

`rebalance.ts` therefore **re-derives** `actualWeight = sliceAmount ÷ investableBase` rather than
reading `AllocationSlice.share`. Where no negative investable slice exists the two agree exactly —
**assert that in a test**, so divergence is deliberate rather than accidental.

## 2. New schema — `migrations/0004_plan.sql`

### `annual_expense` — dated, not a scalar

```sql
create table annual_expense (
  effective_date date primary key,
  amount         numeric(20, 4) not null
    constraint annual_expense_amount_positive check (amount > 0)
);
```

Shaped like `manual_networth` and for the same reason: a hand-typed fact about a point in time, not
a setting. Argued against a singleton `plan` row:

- **"Not set" gets exactly one representation** — no rows. A nullable column in a row that exists
  gives two, and the Independence empty state hinges on the distinction.
- `check (amount > 0)` is expressible; on a nullable singleton it is not, so "$0 expenses" would
  reach the FI division.
- It makes "progress to FI over time" *possible later* (latest expense at or before `d`, the same
  resolution rule `latest_position_set` already writes) instead of a lie told with today's number.

Household-wide. Splitting spending per person needs a household-composition model that does not
exist, and §4.2's single-owner rule is about *custody*, not about who eats the groceries.

### `withdrawal_rate` — stored and seeded

```sql
create table withdrawal_rate (
  rate numeric(7, 6) primary key
    constraint withdrawal_rate_range check (rate > 0 and rate <= 1)
);
insert into withdrawal_rate (rate) values (0.030000), (0.035000), (0.040000)
on conflict do nothing;
```

Stored rather than a TypeScript constant because a compiled-in rate is written `0.04` — a float
literal — and the exact-decimal discipline leaks at the first arithmetic. Scale 6 deliberately
equals `SHARE_SCALE`, so rates, targets and computed shares share one scale and nothing rescales.
There is no `is_primary` column because a primary rate is exactly what this screen refuses to
nominate.

### `allocation_target` — both dimensions, one table

```sql
create table allocation_target (
  id bigint generated always as identity primary key,
  asset_class text
    constraint allocation_target_asset_class_valid
    check (asset_class is null or asset_class in ('equity','bond','cash','other')),
  classification_id bigint references classification (id) on delete restrict,
  constraint allocation_target_one_dimension
    check (num_nonnulls(asset_class, classification_id) = 1),
  weight numeric(7, 6) not null
    constraint allocation_target_weight_range check (weight >= 0 and weight <= 1)
);
create unique index allocation_target_asset_class_key
  on allocation_target (asset_class) where asset_class is not null;
create unique index allocation_target_classification_key
  on allocation_target (classification_id) where classification_id is not null;
```

- **Both dimensions**, because `instrument.classification_id` is `not null` and `classification.name`
  is unique — so each partitions the portfolio exactly. Refusing classification targets would refuse
  the only level at which "70% US / 30% international *within equity*" can be expressed, and §4.4 is
  explicit that the user's labels are the ones they think in.
- **The dimension is which key column is non-null**, never a discriminator string, so a row cannot
  name a dimension it carries no key for.
- **Flat weights** (share of the whole base), not hierarchical: Swedroe's bands are stated on
  portfolio-level weights, and flattening is where a rounding decision would creep in.
- **Two coexisting sets can disagree** (asset-class says 60% equity; the equity classifications sum
  to 70%). That is detectable and should be **labelled on screen**, not prevented — preventing it
  means one dimension silently owns the other.
- **Household-wide, no `person_id`.** Standard practice is one allocation across all accounts, with
  asset *location* as the deliberate consequence — and asset location is precisely what per-person
  targets would make incoherent. If ever wrong, it is a nullable column plus a partial index.
- **Sum-to-100% is cross-row and therefore not a DB constraint.** It is enforced in the domain module
  by making the only write a whole-set replace.

## 3. Modules

### `valuation.server.ts` needs no changes

All three screens are served by `currentHoldings()` plus pure grouping. Adding `GROUP BY` queries per
screen would walk back out of the §8.2 mitigation. Worth stating as a **result**, not an omission:
the query layer was built for exactly this.

### `app/lib/decimal.ts` — new, pure (extraction)

`allocation.ts` holds `toUnits` / `render` / `divide` privately, with a header claiming money
arithmetic "stays exactly one module wide". Three new pure modules need them, and copying them is the
§8.2 drift failure one level down. **Extract; `allocation.ts` imports them back** — the claim
survives, strengthened, because it becomes true of the whole app rather than true so far.

Adds `addDecimals`, `subtractDecimals`, `multiplyDecimals`, `divideDecimals` (**null** on a zero
denominator — never `Infinity`, never 0 standing in, following `NetWorthChange.percent`),
`compareDecimals`, `negateDecimal`, `absDecimal`, `toPercent` / `fromPercent`.

### `app/lib/allocation.ts` — additions

`totalOf`, `totalBase`, `investableBase`, `accessibleBase`, `allocationByClassification`,
`allocationByTaxTreatment`.

Classification slices are keyed on the **name**: the id-not-name argument `allocation.ts` makes for
people does not apply, because `classification.name` carries a unique constraint and person names
deliberately do not. This avoids altering `holding_valued` to expose `classification_id`, which would
mean dropping and recreating both the view **and** `holding_valued_at`, since the function is
declared `returns setof holding_valued`.

### `app/lib/independence.ts` — new, pure

Returns per-rate `{ fiNumber, safeAnnualWithdrawal, surplus, progress }` plus rate-independent
`yearsCovered` and `impliedRate`, with `isComplete` and `boundsHold` flags.

### `app/lib/rebalance.ts` — new, pure

Returns rows of `{ actualAmount, actualWeight, targetWeight, targetAmount, drift, relativeDrift,
band, isOutOfBand, tradeAmount, coverage }` plus `targetTotal`, `buyTotal`, `sellTotal`, `residual`
and a list of **refusals as reasons, not sentences** — wording lives in the route.

- **The union of slice keys and target keys is load-bearing.** Iterating slices alone silently omits
  the most important row on the page: *you hold no bonds and you want 40% bonds*. A target with no
  slice produces `actualAmount "0.0000"`, `coverage {0,0}` and a positive trade.
- **Absent target ≠ 0% target.** No target is no opinion, which is why trades appear only when
  targets sum to exactly `1.000000` — you cannot have an opinion about 80% of a portfolio and get a
  coherent trade list for it.

### `app/lib/holdings-view.ts` — new, pure

Filter, group, subtotal. **Three coverages, not one:** `value.coverage` counts holdings with a price;
`costBasis.coverage` counts those whose statement carried a basis; `unrealized.coverage` counts those
with **both**. A 401k holding is routinely priced *and* has no cost basis, so §8.2's "8 of 12"
sentence is quoting `unrealized.coverage`, and computing it from `value.coverage` overstates it.

Filter options are derived from the **unfiltered** rows, so a control never offers a dead option.

### `app/lib/plan.server.ts` — new, DB

Follows `people.server.ts`: Zod input, refusals as sentences, injectable `db`.
`setAllocationTargets(dimension, raw, db?)` is **the only write** and replaces a whole dimension in
one transaction — per-row upserts are rejected because the sum-to-100% invariant cannot be enforced
on a per-row write, and a target set that spent thirty seconds summing to 94% would produce a wrong
trade list for anyone who reloaded during it.

### `input.server.ts` and `format.ts`

`decimalField` and `percentField` parse `"$40,000.00"` and `"3.5"` to decimal strings by shifting the
point on the digits. **`z.coerce.number` is banned** for the reason `db.server.ts` gives.
`formatNumber` and `formatShare` are added; `formatShare` retires the `.replace(/^\+/, "")` workaround
in `analysis.tsx`. Neither adds arithmetic, so `format.ts`'s rule holds.

## 4. Rounding — every division, and which way

Half away from zero everywhere, matching `format.ts` and `allocation.ts`. Two figures are **exact and
never rounded**: `drift` and `tradeAmount`.

| Figure | Expression | Scale | Note |
|---|---|---|---|
| FI number | expenses ÷ rate | 4 | |
| Safe annual withdrawal | base × rate | 4 | exact product, rounded **once** |
| Progress to FI | base ÷ **rounded** fiNumber | 6 | see below |
| Years covered | base ÷ expenses | 4 (display 1) | |
| Implied rate | expenses ÷ base | 6 | **null when base ≤ 0** |
| Actual weight | slice ÷ investableBase | 6 | |
| Target amount | targetWeight × base | 4 | exact product, rounded once |
| Drift | actualWeight − targetWeight | 6 | **exact** |
| Relative drift | drift ÷ targetWeight | 6 | null when target = 0 |
| Trade amount | targetAmount − actualAmount | 4 | **exact** |
| Unrealized % | unrealized ÷ costBasis | 6 | null when basis ≤ 0 |

**Four decisions worth naming:**

1. **Progress divides by the *rounded* FI number**, not by `expenses ÷ rate` recomputed.
   Algebraically identical, numerically not — and the screen prints the FI number, so "progress is
   the base over the number above it" must be literally true. Same reasoning as `holding_valued`
   making `unrealized` literally `value − cost_basis`.
2. **The 5/25 band test never uses a rounded band.** `band = min(0.05, target × 0.25)`; the piecewise
   form (absolute ≥20%, relative <20%) is the same function and the two agree exactly at the seam
   (0.20 × 0.25 = 0.05), so there is no discontinuity to legislate. But `target × 0.25` at scale 6 is
   inexact whenever the units are not divisible by 4. So the **displayed** band rounds, and the
   **test cross-multiplies and never divides**:
   `outOfBand = |drift| > 0.050000 || |drift| × 100 > target × 25` — exact in BigInt, strict `>` so
   sitting exactly on the band is in band.
3. **Trade amounts will not sum to exactly zero.** Each target amount rounds independently, so the
   residual is bounded by group-count × 0.00005 — under a cent for any real portfolio. **Do not fudge
   it into the largest group.** Expose `residual`; the screen says nothing when it rounds away.
4. **A three-way equal split is not representable at scale 6** (0.333333 × 3 = 0.999999). The
   sum-to-100% rule therefore refuses it, and the form must show the running total and residual so
   the user enters 33.3334 / 33.3333 / 33.3333. A deliberate, visible refusal — a tolerance is how
   silent drift enters.

## 5. Coverage semantics

`Coverage.known < Coverage.total` means some holdings have never been quoted, so the sum omits them.

**An unpriced holding is never a liability**: cash and debt are `USD` positions, and `USD` carries
both a seeded quote and a 1970 `price_daily` row, so it prices at 1.00 on every date the system will
be asked about. An unpriced holding is always a security, and absent a short its true value is ≥ 0.
That single fact makes directional statements sound:

| Figure | Effect | Wording |
|---|---|---|
| Base amount | understated | "$X, based on 8 of 12 holdings" |
| Safe annual withdrawal | **lower bound** | "at least $X" |
| Years covered | **lower bound** | "at least X years" |
| Progress to FI | **lower bound** | "at least 62%" — bar to 62% with a hatched remainder |
| **Implied withdrawal rate** | **upper bound — direction flips** | "no more than 4.6%" |
| FI number | unaffected | but stamped with the expense's `effective_date` |
| Rebalance weights | numerator **and** denominator affected — **no bound either way** | drift shown, trades withheld |

`boundsHold` is false if any unpriced holding has negative quantity, in which case the screen drops
the direction word.

`fiNumber` has no coverage but has the analogous unknown — **staleness of the assumption**.
`annual_expense.effective_date` is its coverage: "based on spending recorded 2024-03-01".

### What each screen must refuse

- **No expenses recorded** → no FI number, no progress, no years covered, **no zeros**. An
  `EmptyState` pointing at Settings. §13.7: a zero and an unconfigured instance must not look alike.
- **Nothing priced at all** → refuse every portfolio-derived figure. "0% progress" is a claim; "we
  cannot price any of your 12 holdings" is the fact.
- **Rebalance with partial coverage** → **withhold the trade column entirely**. Drift is a diagnosis
  you can sanity-check; a trade amount is an instruction you act on with money, wrong by an unknown
  amount in an unknown direction.
- **Targets not summing to 1.000000** → withhold trades, show drift, name the residual.
- **Investable base ≤ 0** → withhold every weight and trade; show amounts only.
- **Holdings** → a subtotal with partial cost-basis coverage may never print without its sentence,
  and a group with zero coverage shows "—", not "$0".

## 6. Testability

**Pure, no Postgres** — `decimal.ts`, `allocation.ts` additions, `independence.ts`, `rebalance.ts`,
`holdings-view.ts`, `format.ts`. That is essentially all the new logic.

**Needs Postgres** — `plan.server.ts` only (constraints, the sum refusal, the last-rate refusal, the
same-date upsert, `on delete restrict`), plus **one reconciliation test that belongs nowhere else**:
`totalBase(await currentHoldings(db))` equals `(await netWorth(db)).amount` exactly.

`tests/allocation.test.ts` passing **unchanged** after the `decimal.ts` extraction is the safety net
for that step.

### Edge cases to pin

- **The mortgage-in-cash case** — a `liability` USD position must stay in `allocationByAssetClass`'s
  cash slice and must be absent from the rebalance base. Both assertions in **one test**, so the
  difference is deliberate.
- Zero expenses (impossible in the DB, still tested in the pure function) — every derived figure
  null, never `Infinity`.
- No expenses recorded; no targets set.
- Targets summing to 0.95 / 1.05 — assert `buyTotal + sellTotal ≈ (targetTotal − 1) × base`, so the
  reason for withholding is visible in the numbers.
- Three-way split refused with its residual named.
- **A target for an asset class with no holdings** — the regression this guards is the whole feature.
- A holding group with no target — still counts in the base.
- Household in net debt — `totalBase` negative, `progress` negative, `impliedRate` null,
  `investableBase` still positive so rebalance still works.
- Every holding unpriced.
- The 20% band seam (target 0.200000, drift exactly 0.050000 → in band) and the relative seam
  (target 0.100000, drift exactly 0.025000 → in band).
- Rounding: base 1,000,000 over three targets — assert the **exact residual string**, not
  "approximately zero".
- Filter matching nothing — "no holdings match" is a *different* message from the empty instance.
- Cost basis on a liability → `unrealizedPercent` null, not a percentage with a flipped sign.

## 7. Open questions

1. Whether the two-base × three-rate matrix on Independence is one table too many for a family app.
   Fallback is a `plan.retirement_in_base` boolean — a one-column migration. Resisted, because the
   default becomes the answer and nobody revisits a default.
2. Whether classification targets earn their place in v1, or asset-class targets alone would serve
   for six months. The table supports both from day one, so shipping the asset-class UI first costs
   nothing.
3. Whether `analysis.tsx` should absorb the rebalance panels or split into a dedicated route once it
   carries two dimensions of targets. Best decided against the real page.
