# 0006 — What the portfolio pays: a projected dividend on Holdings and an Income screen

The `quote` table has carried `yield_pct` and `annual_dividend_per_share` since the initial
migration, and the pricing slice has been filling them on every refresh. Nothing reads either one.
This spec turns those two columns into a figure a household can act on: a projected annual dividend
per holding, on the Holdings table, and aggregated on the Income screen — which has been reachable
from the navigation and unconditionally empty since day zero.

Grilled through `/grill-with-docs`; the numbered decisions below are the settled answers, and the
rejected alternatives are kept because most of them are the obvious thing to try next.

## Problem Statement

A household that has just uploaded a statement can see what it owns and what that is worth. It
cannot see what any of it **pays**. The data to answer that is already stored and already refreshed
— it simply has no consumer.

Four things make this harder than multiplying two columns.

**There are two dividend figures, and they disagree.** `annual_dividend_per_share` is money per
share, taken from the provider's `dividendRate` or its ETF spelling `trailingAnnualDividendRate`.
`yield_pct` is a ratio, taken from the provider's unambiguous `dividendYield` where it exists and
otherwise *derived* from the rate and the price. Where the provider supplies its own yield, it
struck that yield against its own price snapshot rather than the price we stored, so
`value × yield` and `quantity × per-share` produce different answers for the same holding. §8.2
names two figures for one thing as the weakest point in this design; here they would sit in one row.

**A null payout means three different things.** The provider answering "no dividend fields" for a
growth ETF, the refresh never asking about a workplace-plan trust that has no symbol, and the
seeded `USD` row that no provider will ever quote all arrive as the same null. Only the first is
genuinely zero.

**There is no historical dividend and there never will be.** `quote` is one row per instrument,
overwritten on every refresh. `price_daily` carries a close and nothing else. Any figure this
feature produces describes the portfolio *now* and cannot be asked about a past date.

**Income already has a promised shape.** §8.1 assigns it projected annual dividend and weighted
yield, grouped by account and tax treatment. Building this anywhere else would leave that promise
outstanding while shipping its content under another name.

## Solution

**One figure, computed once, in SQL.**

```
annual_dividend = quantity × annual_dividend_per_share
```

It enters through `valuedNow()`, which stops being the bare `holding_valued` table and becomes a
derived table over it, left-joined to `quote`:

```sql
select hv.*,
       q.annual_dividend_per_share,
       cast(hv.quantity * coalesce(q.annual_dividend_per_share, 0)
            as numeric(20, 4))                                    as annual_dividend
from holding_valued hv
left join quote q on q.instrument_id = hv.instrument_id
```

still aliased `holding_valued`. `readHoldings` and `readTotal` need no change to their **bodies** —
both are `selectAll()` or raw `sql` templates — but the source *type*, `toValuedHolding` and
`ValuedHolding` all do. See "The row type is widened locally" below; that is where the real cost of
"no migration" sits.

The `coalesce` is inside the SQL and not in JavaScript, because the zero rule is the figure's
definition rather than a rendering choice. `valuedAt(date)` is untouched, which is what makes the
historical answer carry nothing rather than something anachronistic.

**Precedent:** `prices.server.ts` already selects from `holding_valued` and joins `quote` on
`instrument_id` for the staleness summary, so this is the second use of the pattern, not the first.
It also means `valuation.server.ts`'s module comment claiming to be the only reader of the view is
already stale and should be corrected while we are here.

**No migration.** The view and the as-of function are both left exactly as they are.

**Holdings** gains a last column, `Annual dividend`: sortable, subtotalled, with the derived yield
as a `cell-sub` line beneath the amount.

**Income** becomes a real screen: a headline (total projected annual dividend, portfolio weighted
yield), then two breakdowns — by tax treatment and by account — each a ring beside its table, with a
sheltered subtotal line under the first.

**`Breakdown` moves to `app/components/`** so Income and Analysis draw from one implementation.

## User Stories

1. As a household member, I want to see what each holding is projected to pay over a year, so that I
   can tell an income position from a growth one without opening a provider's site.
2. As a household member, I want that figure beside the holding's value, so that a large position at
   a poor yield is visible as such.
3. As a household member, I want the row to show a percentage as well as an amount, so that I can
   compare holdings whose position sizes differ.
4. As a household member, I want to sort by projected dividend, so that I can see what actually pays
   me without reading every row.
5. As a household member, I want group subtotals to include the dividend, so that grouping by tax
   treatment answers the same question the Income screen answers.
6. As a household member, I want one headline figure for the whole portfolio, so that "roughly what
   does this pay" is answered before I read anything else.
7. As a household member, I want the payout split by tax treatment, so that I can see how much of it
   is taxed this year rather than deferred or never.
8. As a household member, I want a plain-language line telling me how much is sheltered, so that I
   do not have to add two rows together.
9. As a household member, I want the payout split by account, so that I know which statement the
   income actually lands in.
10. As a household member, I want to be told the total is a lower bound, so that I do not read a
    missing figure as a zero.
11. As a maintainer, I want one dividend figure in the codebase, so that two screens cannot report
    different totals for the same portfolio.
12. As a maintainer, I want the historical path to carry no dividend, so that a net worth query for
    a past date cannot report today's payout as though it were that date's.
13. As a maintainer, I want one ring implementation, so that §13.3's rank-keyed colour rule is
    enforced by construction rather than by discipline.

## Implementation Decisions

### The per-share figure is primary; the yield is a view of it

`quantity × annual_dividend_per_share`, never `value × yield_pct`. Three reasons, in order of how
much they cost to get wrong.

The provider's own `dividendYield` is struck against the provider's price snapshot, not the price in
our `quote` row, so the two paths disagree on the same holding. Choosing the per-share figure means
there is exactly one dividend number in the system and the yield is derived from it, the same
arrangement that makes `unrealized` literally `value − cost_basis` rather than a second expression
that can round differently.

The per-share figure survives where the yield does not. `inRange` in the price provider drops a
yield past the `numeric(10,6)` ceiling to null — a distressed listing carrying a stale rate against
a collapsed price derives an absurd percentage, and storing it would abort the whole refresh
transaction. The rate beside it is kept.

And the per-share figure needs no price. A workplace-plan trust priced by hand still has a quantity.

**Rejected:** yield-primary, which was the original request. It reads more naturally — "the yield on
that asset" — and it covers the one case per-share does not, an instrument where the provider sends
a yield but no rate field. That case loses to the three above.

**Consequence:** the displayed yield is `annual_dividend ÷ value`, computed with `money.ts`'s
`divide` at `SHARE_SCALE`, for display only. It is null wherever `value` is.

### A null payout is zero

Every holding with no `annual_dividend_per_share` contributes `$0`.

This is a deliberate departure from the rule the rest of this codebase follows, and it is the one
decision here that trades honesty for legibility. §8.2 says sum what is known and label the
coverage; applied literally, a portfolio where nineteen of twenty-three holdings correctly pay
nothing would report *"based on 4 of 23 holdings"*. The caption would be true and useless — it
cannot distinguish a growth ETF that pays nothing from a trust nobody asked about, because the
stored data does not distinguish them either.

**Rejected:** treating every null as unknown, per the rule as written. Rejected for the caption
noise above.

**Rejected:** deciding per row, from whether the instrument was ever quoted — a refreshed `quote`
row means the provider answered and "no dividend" is an answer, while `price_source` of `fixed` or
`manual` means it was never asked. This is the honest version and it was the recommendation. It was
declined in favour of the simpler rule, and it remains the shape to reach for if the lower bound
ever starts misleading someone.

**Consequence, and the mitigation:** the total understates by every unquoted holding, by all cash
interest, and by any loan interest. Both screens label the figure a **lower bound** in place, the
way §8.1's tax panel says on the page that its own figure is an upper bound. This is recorded as an
accepted limitation in DESIGN.md §14.

**Consequence on screen:** an unquoted trust renders a blank Value and a `$0` dividend in the same
row. That is the rule working as chosen, not a fault.

**Where the zero lives:** in the `coalesce` inside the derived table, and nowhere else. Two places
would otherwise quietly reintroduce a dash. `money-cell.tsx` renders a null as `—`, and `totalOf`'s
`figure()` helper returns null whenever a sum's `known` count is zero — correct for value, wrong
here, because a group where nothing pays is `$0` and not an unknown. The dividend total must not go
through that branch.

### The dividend enters through `valuedNow()`, not through the view

The obvious move is to add the columns to `holding_valued`. It was tried against a real Postgres 16
with all five migrations applied, and it fails in a way worth recording.

`create or replace view holding_valued` with two columns appended **succeeds**, reporting
`CREATE VIEW`, despite `holding_valued_at` declaring `returns setof holding_valued`. The function is
only checked when it is called:

```
ERROR:  return type mismatch in function declared to return holding_valued
DETAIL:  Final statement returns too few columns.
```

So the migration goes green and the net worth chart throws the first time anyone opens it. Replacing
both objects in one migration fixes it, and `tests/holdings-at.test.ts` would catch the omission —
but the failure mode is call-time, and the whole reason to pay it would be to add a permanently null
column to the historical row type to describe something with no historical meaning.

Joining `quote` outside the view avoids all of it. What §8.2 actually protects is the resolution of
*which position set is current*, and that stays wholly inside the view.

**Fan-out:** none. `quote.instrument_id` is the primary key, so the left join yields at most one row
per holding.

**Cost, named:** `quote` is joined twice for one row — once inside the view for the price, once
outside for the rate. At household scale that is free, and the alternative is the paired migration
above.

**Consequence:** `ValuedHolding.annualDividend` is `string | null`, null on every `valuedAt` path.
`toValuedHolding` must not narrow it with `required()`.

### The row type is widened locally, not in the generated types

`HoldingValuedRow` is `Selectable<Database["holding_valued"]>`, and `Database` is a straight alias
of the kysely-codegen output. Kysely derives `selectAll()`'s result type entirely from the generic on
the aliased raw builder, so the two new columns arrive at runtime and do not exist to the compiler.

There is no legal place to put them in the generated file. CI runs `npm run db:types -- --verify`,
so a hand-edit fails the build; and with no migration, regenerating from the live schema will never
produce them. Widening `Database` itself is worse than either: `accountTotals` and `accountTotal`
join the **real view**, and a widened `Database` would let someone select `annual_dividend` there —
clean typecheck, runtime failure.

So the widening is local to the query module:

```ts
type ValuedRow = HoldingValuedRow & {
  annual_dividend_per_share: string | null;
  annual_dividend: string | null;
};
type ValuedSource = AliasedRawBuilder<ValuedRow, "holding_valued">;
```

**This is a deliberate, narrowly-scoped exception to `AGENTS.md`'s rule that types are derived from
`database.generated.ts` rather than hand-written.** It is justified only because these columns exist
in a query and not in the schema — which is the whole point of taking the no-migration route — and it
is the honest price of that route. It should not spread: nothing outside `valuation.server.ts` names
`ValuedRow`.

**And the as-of path returns `undefined`, not `null`.** `holding_valued_at` emits the view's columns
and no others, so once `ValuedSource` is `ValuedRow`, `row.annual_dividend` on that path is a missing
key. `toValuedHolding` must therefore use `?? null`, never `required()`, and never a bare read. This
matters more than it looks: Vitest's `toEqual` treats an `undefined` property as equal to a missing
one, so the exhaustive row-shape assertions in `tests/current-holdings.test.ts` and
`tests/holdings-at.test.ts` would pass while the field was silently `undefined`. The as-of test must
assert `annualDividend: null` explicitly.

### Three slices, not two, and never a boolean

The Income breakdown groups by `tax_treatment` — Taxable, Tax-deferred, Tax-free — reusing the
labels the Holdings group-by control already shows.

§4.5 argues the general case: an enum costs what a boolean costs, and the boolean discards the
largest distinction on the balance sheet. For a *dividend* the argument is stronger than anywhere
else in the application. A dividend in a taxable account is taxed this year; in a Traditional
account it is untaxed now and the whole withdrawal is ordinary income later; in a Roth it is never
taxed. "Sheltered" merges a dated liability with the absence of one.

A binary panel would also have forked the vocabulary: Holdings already groups and filters by tax
treatment three ways.

**The binary question is still answered**, as a sentence beneath the table — *"$9,800 of $14,200 is
sheltered"*. Sheltered is a subtotal and appears nowhere in the data.

**Vocabulary note:** *account type* is `account_kind` — Brokerage, Workplace plan, IRA, Bank,
Liability. It is not tax treatment, and the two must not be used for each other in tickets or copy.

### `Breakdown` becomes a shared component

`Donut`, `ring()`, `categoryColor`, the geometry constants and `Breakdown` itself are module-private
to the Analysis route. Income needs the same panel, so they move to `app/components/breakdown.tsx`
and Analysis imports them.

`Breakdown` is generic over `AllocationSlice` and formats with `formatMoney`, which is most of the
way there. Its own doc comment is the argument for sharing it: written once for all three because a
second copy is how one breakdown comes to treat a liability or a sixth group differently. §13.3's
rule — the same rank is the same colour in every panel, no breakdown gets a palette of its own — is
enforced by there being one implementation and by nothing else.

**It needs three changes, not none.** The second column heading is the hard-coded string `Value`, so
it becomes a prop. `Donut` hard-codes the centre label `Total`, which reads correctly for a payout
total and can stay. And the panel needs an optional slot beneath the table for the sheltered line;
Analysis passes nothing.

**`allocation.ts` moves with it, because today it cannot produce a dividend slice at all.** `group()`
sums `holding.value`, hard-coded, and counts coverage from `holding.isPriced`. Built on that,
`allocationByAccount` would return a *value* breakdown, and Income would render two panels of net
worth under dividend headings. `group()` gains an amount selector and is exported as `allocationBy`;
the coverage predicate goes with it, since `isPriced` says nothing about a payout.

**The three existing adapters stay as they are.** `group()` is already the one parameterised
implementation and its doc comment says so; `allocationByPerson` and its two siblings are four-line
adapters over it, not near-copies. Adding to that shape is right and collapsing it would be churn.

**Negative slices are live, not dormant.** An earlier draft claimed the negative branch could never
fire here. That was wrong and contradicted this spec's own test for a liability carrying a rate, and
§8.1's "the one view where the loan's negative yield does something interesting". The branch stays
reachable; only its prose, which talks about what is *owned*, needs to read correctly for a payout.

**This is not a pure move**, and an earlier draft's claim that Analysis's screenshots are therefore
exempt does not stand — see the testing section, where the safety net it assumed turns out not to
exist.

### The Holdings column

Last, after `Unrealized`. `Cost basis` and `Unrealized` are a pair — what you paid, what you gained
— and a forward-looking projection should not be inserted between them.

Sortable: one member on `SortKey`, one entry in `SORT_KEYS`, one `case` in `compareBy` using
`compareDecimal` at `MONEY_SCALE`. No `isMissing` case is needed, because under the zero rule the
figure is never missing.

Subtotalled: `FIGURES` goes from three to four. That phrase was doing too much work in an earlier
draft; the whole list is below, and two entries are substantive rather than bookkeeping.

| File | Change |
|---|---|
| `app/lib/valuation.server.ts` | `ValuedRow`, the derived-table `valuedNow` |
| `app/lib/valuation.server.ts` | `ValuedHolding.annualDividend`, and `?? null` in `toValuedHolding` |
| `app/lib/holdings-view.ts` | `SortKey`, `SORT_KEYS`, the `compareBy` case |
| `app/lib/holdings-view.ts` | `HoldingsTotal` gains the field; **`totalOf`'s `figure()` must not dash it** |
| `app/lib/holdings-view.ts` | the derived-yield helper, beside `formatQuantity` and `holdingNote` |
| `app/routes/holdings.tsx` | the `COLUMNS` entry and `FIGURES` |
| `app/routes/holdings.tsx` | the `Figures` cell — subtotals and grand total |
| `app/routes/holdings.tsx` | **the `Row` cell** — the per-holding figure itself |

No coverage caption on this column: there are no unknowns to count.

The yield helper lives in `holdings-view.ts` rather than in the route, because Account detail renders
the same cells — which is why `formatQuantity` and `holdingNote` live there too.

**The yield derivation must guard its denominator.** `money.ts`'s `divide` takes bigints and divides
them, so a zero denominator throws — and `value` can legitimately be `0.0000`, since nothing
constrains a quantity or a price to be non-zero. A zeroed-out position would take the whole table
down with a `RangeError`. Both a null value and a zero one yield no percentage.

**Reuse `formatShare`; do not write a percent formatter.** `allocation.ts` already renders a fraction
at `SHARE_SCALE` as a percentage, with this project's sign and minus-glyph handling. `formatPercent`
alone would prefix `+` on every row, which `formatShare` exists to strip.

The derived yield renders as a `cell-sub` line beneath the amount, the pattern the Asset and Account
cells already use. The amount alone cannot be compared across rows, because it scales with position
size; the percentage is the comparable figure.

Mobile needs nothing. The table reflows to cards from `data-label` on each cell, so a new column is
one more labelled line on the card rather than a wider scroll.

### The Income screen

A loader — the route has none today, deliberately, because it had nothing to ask for.
`currentHoldings()` supplies every figure on the page from one read, so the two breakdowns and the
headline cannot disagree with each other or with Holdings.

**Headline:** total projected annual dividend, and the portfolio's weighted yield beside it. This is
where §8.1's "weighted yield" lands. It is one figure at the top rather than a column in each table,
which keeps the tables to amount and share.

**The weighted yield's denominator is gross positive assets** — the denominator `allocation.ts` and
`holdings-view.ts` both already argue for at length, and for the same reason. The standard test
household is in net debt, so dividing a positive payout by net worth would report a negative yield on
a portfolio that pays money, and a household whose debts nearly cancel its assets would divide by
something near zero. Guarded against a zero denominator like every other derived yield here.

The headline is summed in JavaScript with `sumMoney` over the one array, where Analysis calls
`netWorth()` and sums its headline in SQL. A deliberate departure: `sumMoney` is exact BigInt
arithmetic, and one read is what makes the headline and the breakdowns structurally unable to
disagree.

**Two breakdowns:** by tax treatment, then by account. §8.1 promised both, and **neither grouper
exists** — there is no `allocationByTaxTreatment` either, which an earlier draft of this spec missed.
Both are new adapters over `allocationBy`.

**The labels come from `DIMENSIONS`, passed in by the loader.** The short labels Holdings shows —
Taxable, Tax-deferred, Tax-free — are module-private to `holdings-view.ts`, and `TAX_TREATMENTS`
carries only the long form, which that file says in place is unusable in a table cell. `allocation.ts`
cannot import them: `holdings-view.ts` already imports from `allocation.ts`, so the reverse is a
cycle. The Income loader therefore passes the `tax` and `account` dimension accessors into
`allocationBy`, keeping the dependency one-way and the label table single.

That is not only cycle-avoidance. It is what makes "Holdings grouped by tax treatment agrees with the
Income breakdown" structural rather than coincidental, because both read one accessor. A third copy
of the labels would let the two group identically and label differently — exactly the failure that
test exists to catch.

**Empty state:** the existing `EmptyState` for a household with nothing uploaded. §8.4's rule holds
— an instance with no data and a portfolio that genuinely pays nothing must not render the same
zeroed chart frame.

**The nav entry and route already exist** and do not move.

## Testing Decisions

The seam is `tests/support/database.ts` — a real Postgres, migrations applied, rolled back per test.
No substitute: the risk here is `numeric` handling and SQL, and both vanish under a fake.

What is worth testing, in the order it would hurt to break:

- **The multiplication and its scale.** A fractional share count against a rate with four decimals,
  asserted as an exact decimal string at the money scale. `toBeCloseTo` would hide the driver
  coercion this codebase is built to keep out.
- **Null becomes zero**, for all three populations — an instrument the provider answered with no
  rate, one never quoted, and the seeded `USD` row.
- **A negative quantity yields a negative dividend**, so a liability carrying a rate reports interest
  owed rather than income. No such instrument exists today; the rule should hold before one does.
- **`valuedAt` carries no dividend.** A holding queried at a past date reports null, not today's
  figure. This is the anachronism the design refuses and nothing else asserts it.
- **The join does not multiply rows.** Holding count from `currentHoldings` is unchanged by the
  join — the regression that a `quote` table with a non-unique key would introduce.
- **Subtotals sum their rows, and the grand total sums the subtotals**, for the new column.
- **Holdings grouped by tax treatment agrees with the Income breakdown**, holding for holding. Both
  read one array, so this is structural; the test is what keeps it structural. It belongs beside
  `tests/invariants/aggregates-agree.test.ts`.
- **The `Breakdown` extraction did not change Analysis.** There is no safety net for this today:
  `tests/routes/` has no `analysis.test.ts`, and the only Analysis coverage,
  `tests/invariants/aggregates-agree.test.ts`, imports the *loader* and asserts arithmetic — it never
  renders `Breakdown`, `Donut` or `ring`. So the extraction either writes a render test for
  `Breakdown` against the existing `tests/support/render.tsx` seam, or Analysis's four screenshots get
  retaken like everything else. It cannot claim to be verified by tests that do not exist.

**Four existing tests break on the widened type, and each is a deliberate update:**

- `tests/holdings-view.test.ts` and `tests/allocation.test.ts` each hand-write a `ValuedHolding`
  factory, so both fail typecheck on the new field.
- `tests/current-holdings.test.ts` and `tests/holdings-at.test.ts` assert exhaustive row shapes with
  `toEqual`. These are the shape contracts that keep the current and as-of answers one row type, and
  the as-of one must be updated to `annualDividend: null` — the assertion that actually catches the
  `undefined` bug, since `toEqual` would otherwise pass on a missing key.

The seam needs nothing new: `tests/support/fixtures.ts`'s `seedQuote` already accepts and writes
`annualDividendPerShare`.

Not worth testing: that the ring renders arcs, that the column sorts (the comparator is tested; the
header is framework behaviour), that `formatMoney` formats.

## Out of Scope

- **A payout calendar** — what lands in March. `quote` carries no ex-date or pay-date, and §3's
  positions-only model means there is no payment history to draw one from. This is the thing people
  usually want from a dividend feature and it is permanently out of reach without a transaction
  ledger.
- **Cash and loan interest.** A savings balance and a personal loan both carry real annual figures
  and neither has anywhere to come from: no provider quotes `USD`, and no instrument backing a
  liability carries a rate. The natural fix is a typed rate per instrument, the way Settings already
  holds the capital gains rate — a separate feature with its own management surface.
- **After-tax dividend income.** Needs a dividend tax rate, which is neither the capital gains rate
  already in `app_setting` nor derivable from it, and needs the qualified/ordinary distinction the
  provider does not supply.
- **Historical or realised dividends.** Consequence of positions-only (§14.1) and of `quote` holding
  no history.
- **Making the zero rule row-aware.** Recorded above as the rejected alternative; the shape to reach
  for if the lower bound misleads.

## Further Notes

**Documentation is inside this work, not after it.** Income stops being a placeholder, which makes
three statements actively false: `README.md`'s "Not built yet" section, `docs/guide/README.md`, and
`docs/guide/first-run.md`. `docs/guide/` carries a page per screen and has no `income.md`. A fourth
file changes too: `docs/guide/holdings.md` lists the columns and explains the coverage captions, and
both passages move with the new column.

**Screenshots are part of it, and one of them is a code change.** `docs/README.md` is explicit that a
change to a screen is not finished until they are retaken. `capture-screenshots.ts` already visits
`/income` for the guide, so that shot retakes itself — but the `docs/screenshots/` theme loop never
visits `/income` at all, so the README's light and dark Income images need the script extended, not
just re-run, with the editorial reason recorded beside the others. Every Holdings shot changes.
Analysis's are only exempt if the extraction ships with the render test above; otherwise they are
retaken too.

**Lifting limitation 9 later is cheaper than it sounds.** The row-aware version of the zero rule
needs `price_source`, and that is already a column on `holding_valued` — `prices.server.ts` reads it
today. It is simply not surfaced on `ValuedHolding`. So the change is one field on the mapper and one
branch in the derivation, not a schema change.

**Two small near-copies to fix while passing through**, both named by the plan review rather than
invented here. `labelOf` is written three times with the same signature and body —
`account-options.ts` exports one, and `allocation.ts` and `holdings-view.ts` each keep a private
copy. And `isPositive`, currently private to the Analysis route, is the counterpart to `format.ts`'s
`isNegative` and belongs beside it rather than travelling into a component file during the
extraction.

**Build order.** Five tracer bullets: the query, `ValuedRow` and the widened `ValuedHolding` (the
figure exists, nothing renders it); the Holdings column; the `allocationBy` and `Breakdown`
extraction; the Income screen; the docs, the screenshot script and the captures. The extraction
blocks the Income screen; the query blocks the column and the screen; the docs close it out.
