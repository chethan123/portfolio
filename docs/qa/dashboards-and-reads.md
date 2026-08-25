# QA findings — read/dashboard screens (Overview, Holdings, Analysis, Income, Account detail)

Instance: **port 5182 / database `qa2`** (demo seed, untouched — only `SELECT`s were run against it).
Constructed-data repros use a **separate** database `qa2_empty` served on port **5192** (created by me;
see "Repro harness" at the bottom for how to rebuild it from scratch).

Baseline ground truth for `qa2` (used throughout):

```
$ psql -h 127.0.0.1 -p 55432 -U portfolio -d qa2 \
    -c "select count(*) holdings, count(*) filter (where is_priced) priced,
               cast(sum(value) as numeric(20,4)) total from holding_valued"
 holdings | priced |    total
----------+--------+-------------
       18 |     17 | 690469.2082
```

---

## 1. `/accounts/<id larger than bigint>` returns **500** (leaked Postgres error + stack trace) instead of 404

**Severity: High**

### Repro
```bash
curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' http://localhost:5182/accounts/99999999999999999999
curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' http://localhost:5182/accounts/9223372036854775808
curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' http://localhost:5182/accounts/1000000000000000000000000
```

### Observed
```
500  /accounts/99999999999999999999
500  /accounts/9223372036854775808          <- 2^63, the first value that breaks
500  /accounts/1000000000000000000000000
404  /accounts/9223372036854775807          <- max bigint, correctly 404
404  /accounts/abc      404  /accounts/0      404  /accounts/-1
404  /accounts/1'--     404  /accounts/1%20or%201=1
404  /accounts/00000000-0000-0000-0000-000000000000
```

The 500 body leaks the database error and the server stack (dev server; a production build would
hide the body, but the 500 status and the unhandled exception remain):

```bash
$ curl -s --noproxy '*' http://localhost:5182/accounts/99999999999999999999 \
    | grep -o -E "out of range for type bigint|valuation.server" | sort | uniq -c
      3 out of range for type bigint
      2 valuation.server
```

`scratchpad/qa2.log`:
```
error: value "99999999999999999999" is out of range for type bigint
    at accountTotal (/home/user/portfolio/app/lib/valuation.server.ts:453:15)
    at loader (/home/user/portfolio/app/routes/account.tsx:143:17)
  code: '22003',  where: "unnamed portal parameter $1 = '...'",
  file: 'numutils.c', routine: 'pg_strtoint64_safe'
```

### Expected
A clean 404 ("Not found"), exactly as every other malformed id already produces. `accountTotal`'s own
doc-comment promises this: *"Ids cross this boundary as strings … so an id taken from a URL path that
is not digits would fail inside Postgres — a 500 where the honest answer is 'no such account'."*

### Cause
`app/lib/valuation.server.ts:359` — `isAccount()` guards only the *shape* of the id, not its magnitude:

```ts
return /^\d+$/.test(accountId) ? sql`${sql.ref(column)} = ${accountId}` : sql`false`;
```

Any run of digits passes and is handed to a `bigint` comparison. The sibling function
`parseRowKey` (`app/lib/holdings-view.ts`, `/^(0|[1-9]\d{0,17})\.(0|[1-9]\d{0,17})$/`) documents
this exact hazard and caps at 18 digits — `?edit=99999999999999999999.1` correctly bounces to
`/holdings` with a 302. `isAccount` never got the same cap.

---

## 2. Analysis breakdown tables never state per-slice coverage — a partial slice is presented as complete

**Severity: High** (this is the project's headline claim, "Every total says what it was computed from")

### Repro
1. `http://localhost:5182/analysis`
2. `http://localhost:5182/holdings?group=assetClass` (and `?group=owner`, `?group=kind`)

### Observed — the same grouping, on two screens, one labelled and one not

| Group | Analysis row | Holdings subtotal row | SQL truth |
|---|---|---|---|
| Asset class **Other** | `$14,176.79   2.1%` | `$14,176.79  **1 of 2**` | 2 holdings, 1 priced |
| Account type **Workplace plan** | `$355,415.12   50.4%` | `$355,415.12  **5 of 6**` | 6 holdings, 5 priced |
| Person **Jordan Rivera** | `$129,799.48   18.8%` | `$129,799.48  **3 of 4**` | 4 holdings, 3 priced |

Within the Analysis page's own gains table the same thing happens: the **Funds and ETFs** row prints
`+$87,550.15` with no coverage, when it is 9 of 13 holdings.

```sql
select asset_class, count(*) n, count(*) filter (where is_priced) priced,
       cast(sum(value) as numeric(20,4)) amt from holding_valued group by 1 order by 4 desc;
 asset_class |    amt      | n | priced
-------------+-------------+---+--------
 equity      | 512925.2679 | 9 |      9
 bond        | 119867.1553 | 4 |      4
 cash        |  43500.0000 | 3 |      3
 other       |  14176.7850 | 2 |      1     <-- partial, shown unqualified

select owner_name, count(*) n, count(*) filter (where is_priced) priced,
       cast(sum(value) as numeric(20,4)) amt from holding_valued group by 1;
  owner_name   | n  | priced |     amt
---------------+----+--------+-------------
 Alex Rivera   | 14 |     14 | 560669.7298
 Jordan Rivera |  4 |      3 | 129799.4784   <-- partial, shown unqualified

select account_kind, count(*) n, count(*) filter (where is_priced) priced,
       cast(sum(value) as numeric(20,4)) amt from holding_valued group by 1;
 account_kind | n | priced |     amt
--------------+---+--------+-------------
 401k         | 6 |      5 | 355415.1215   <-- partial, shown unqualified
 brokerage    | 7 |      7 | 211471.5674
 ...
```

The only coverage statement on the page is the portfolio-wide banner *"Based on 17 of 18 holdings"*
(`analysis.tsx:482`). It does not tell the reader **which** row is short, and every row still prints
its amount and its percentage as if complete. A reader comparing "Jordan Rivera $129,799.48" to
"Alex Rivera $560,669.73" has no way to know one of those two is a 3-of-4 figure.

### Expected
The same treatment the Holdings table gives the identical grouping: a `known of total` caption under
any slice whose `coverage.known < coverage.total`. The data is already computed and carried —
`AllocationSlice.coverage` (`allocation.ts:90`) is populated on every slice and simply never read.

### Cause
`app/routes/analysis.tsx:259-281` — the row renderer destructures `slice.key/label/amount/share` and
never touches `slice.coverage`; contrast `app/routes/holdings.tsx:673-690` (`Figures`, note at `:677-681`), which prints
`{coverage.known} of {coverage.total}` under any short column.

---

## 3. Overview `?range=all` reports the household's **entire net worth** as the period's gain, contradicting the chart drawn directly beneath it

**Severity: High**

### Repro
```
http://localhost:5182/?range=all
```

### Observed
```
TOTAL NET WORTH
$690,469.21
+$690,469.21            <- green, up arrow, no percentage
```
…above a chart whose dashed manual line **starts at $180,297.21 in Dec 2019** on the same screen.
Chart axis, read from the DOM: floor `139.5K`, mid `435.4K`, top `731.3K`; first dashed point at
y=279.31/300, which is exactly $180,297.21 in that domain.

### Why it is wrong
`netWorthChange(since)` measures against `netWorthAt('2019-12-30')`, which is **0.0000 over zero
rows** — "nothing was recorded yet", not "the household had nothing":

```sql
select cast(coalesce(sum(value),0) as numeric(20,4)) amount, count(*) rows
from holding_valued_at('2019-12-30'::date);
 amount | rows
--------+------
 0.0000 |    0
```

The chart's own loader refuses this baseline three lines earlier —
`overview.tsx:187` filters `point.coverage.total > 0` precisely so a fictional climb from zero is not
drawn — but `netWorthChange` returns no coverage, so the headline keeps it. The `?range=all` window is
measured from the *manual* series (`windowDays`, `overview.tsx:151`), so the app deliberately reaches
back to 2019 for the line and then compares the headline against a date it knows is uncovered.

The honest All-period movement is `690,469.2082 − 180,297.2074 = +$510,172.00`.

Verified against the other ranges, which are correct:
| range | `since` | `netWorthAt(since)` | rendered delta |
|---|---|---|---|
| 1M | 2026-07-26 | 665554.0538 (18 rows) | `+3.7% / +$24,915.15` ✓ |
| 3M | 2026-05-27 | 616816.5644 (18 rows) | ✓ |
| 1Y | 2025-08-25 | 489362.6991 (18 rows) | `+41.1% / +$201,106.51` ✓ |
| All | 2019-12-30 | **0.0000 (0 rows)** | `+$690,469.21` ✗ |

### Expected
Either suppress the delta for a window whose start has zero coverage (as the line does), or measure
"All" from the first covered point / the first manual point, and label what it was measured from.
`NetWorthChange` already has the vocabulary for "undefined" — it returns `percent: null` here — it
just still emits a `difference` that means nothing.

### Cause
`app/lib/valuation.server.ts:672-690` (`netWorthChange` carries no coverage) consumed at
`app/routes/overview.tsx:414-417`.

---

## 4. Analysis renders `$0.00` / `0.0%` for a group in which **nothing could be priced**

**Severity: Medium-High** (null coerced to zero — the one thing DESIGN §8.2 forbids by name)

### Repro (constructed; see "Repro harness" → scenario **S1**)
An account holding one instrument that has never been quoted — i.e. exactly the demo's own 401(k)
collective investment trust, isolated into its own account.

```
http://localhost:5192/analysis
```

### Observed
```
Value by account type
ACCOUNT TYPE                       VALUE      % OF TOTAL
Bank                          $12,000.00          100.0%
Workplace plan (401k, 403b)        $0.00            0.0%     <-- nothing priced

Value by asset class
Cash                          $12,000.00          100.0%
Other                              $0.00            0.0%     <-- nothing priced
```
SQL for the same rows:
```sql
select account_kind, count(*) n, count(*) filter (where is_priced) priced,
       cast(coalesce(sum(value),0) as numeric(20,4)) amt from holding_valued group by 1;
 account_kind | n | priced |    amt
--------------+---+--------+------------
 bank         | 1 |      1 | 12000.0000
 401k         | 1 |      0 |     0.0000   <-- known = 0
```

### Expected
An em dash, as **every other surface in the app** already does for the identical group:
* `holdings?group=kind` prints `—` for a group with `total.value === null`
  (`holdings-view.ts:530` `figure()` returns null when `known === 0`; `groupHoldings` → `share: null` at `:633`).
* The account-detail header refuses the figure outright: *"None of this account's 1 holdings has ever
  been priced, so there is nothing to value yet."*

`allocation.ts`'s own header states the rule it then breaks: *"An unpriced holding contributes nothing
and is still counted … an unknown coerced to zero reports a partial answer as a complete one."*
It counts it, and then prints the zero anyway.

### Cause
`app/lib/allocation.ts:218` — `amount: render(bucket.amount, MONEY_SCALE)` is unconditional; there is
no `known === 0 → null` branch equivalent to `holdings-view.ts`'s `figure()` helper
(`holdings-view.ts:530`). `analysis.tsx:278` then formats it.

---

## 5. Overview's accounts list prints `$0.00` for an account that cannot be valued; the account's own page refuses to

**Severity: Medium-High**

### Repro (constructed; scenario **S1**)
```
http://localhost:5192/            -> accounts list
http://localhost:5192/accounts/2  -> the same account
```

### Observed — two screens, same account, contradictory claims

Overview:
```
Workplace Plan
Principal · Workplace plan (401k, 403b)
$0.00
```
Account detail for id 2 (the Workplace Plan account):
```
TOTAL VALUE
None of this account's 1 holdings has ever been priced, so there is nothing to value yet.
```
The account holds 500 units of an unquotable trust with a **$10,000 recorded cost basis**:
```sql
select account_name, instrument_name, quantity, price, value, cost_basis, is_priced
from holding_valued where account_id = 2;
  account_name  | instrument_name  |  quantity  | price | value | cost_basis | is_priced
----------------+------------------+------------+-------+-------+------------+-----------
 Workplace Plan | Unquotable Trust | 500.000000 |       |       | 10000.0000 | f
```

The Overview row carries no coverage marker of any kind. The page-level note *"The figure and the line
are 1 of 2 holdings"* sits in the Net worth panel, well above the accounts list, and does not name the
account.

### Expected
The account row should not print a money figure it does not have — a dash, or the same withheld
treatment the drill-down uses. `AccountTotal` already carries `coverage` (`valuation.server.ts:314`);
the Overview row never reads it.

### Cause
`app/routes/overview.tsx:309` (`AccountsPanel`) and `:353` (`AllocationPanel` label) —
`formatMoney(account.amount)` with no `coverage.known === 0` branch, unlike
`app/routes/account.tsx:396` which gates on `const valued = known > 0`.

---

## 6. Account "Performance" chart draws a flat **$0.00** line — with `aria-label "…ending at $0.00"` — for an account the same page says cannot be valued

**Severity: Medium**

### Repro (constructed; scenario **S1**)
```
http://localhost:5192/accounts/2
http://localhost:5192/accounts/2?range=all
```

### Observed (read out of the DOM)
```json
{ "ariaLabel": "Workplace Plan over the last 1Y, ending at $0.00.",
  "axis": ["0", "0", "0"],
  "solid": "0,150 1000,150",
  "marker": "left:100%;top:50%" }
```
The header immediately above says *"None of this account's 1 holdings has ever been priced, so there
is nothing to value yet."* — and then a chart is drawn asserting a $0.00 valuation across the window,
and a screen-reader user is told the figure the sighted page deliberately withheld.

### Expected
The chart should be suppressed on the same condition the header uses (`valued === false`), or the
series should be filtered on `coverage.known > 0` rather than `coverage.total > 0`. §8.4's rule —
"a zero and an absence must not look alike" — is applied to the header and not to the panel below it.

### Cause
`app/routes/account.tsx:139-141` filters the series on `point.coverage.total > 0` only; `:458`
(`computed.length >= 2 && last`) does not consult `valued`.

---

## 7. Overview's coverage caption is computed from **today** and asserted for the whole line; selling a position makes the caption vanish while the line stays partial

**Severity: Medium** — *(This is the user-reachable variant of the figure-vs-line coverage problem.
It is a different mechanism from the price-tier one already logged by the coordinator: here both
figures come from `holding_valued_at`, and what changes across the window is **which position set is
current**, which a user changes just by uploading a statement that no longer lists a position.)*

### Repro (constructed; scenario **S2** = S1 plus one later statement that drops the trust)
```
http://localhost:5192/?range=1m
```

### Observed
The page renders **no coverage caption at all** — `pricedCount === holdingCount`, so
`overview.tsx:441` short-circuits:
```
TOTAL NET WORTH
$13,000.00
+30.0% / +$3,000.00
Net worth
13.2K / 11.5K / 9.8K        <- no "N of M holdings" line anywhere
26 Jul  10 Aug  25 Aug
```
But most of that drawn line is a partial total:
```sql
select 'today', count(*), count(*) filter (where is_priced) from holding_valued
union all select 'now-6',  count(*), count(*) filter (where is_priced) from holding_valued_at(current_date-6)
union all select 'now-10', count(*), count(*) filter (where is_priced) from holding_valued_at(current_date-10)
union all select 'now-20', count(*), count(*) filter (where is_priced) from holding_valued_at(current_date-20);
 today  | 2 | 2
 now-6  | 2 | 1     <-- every point before ~5 days ago is 1 of 2
 now-10 | 2 | 1
 now-20 | 2 | 1
```

### Expected
Either the caption is scoped to the figure only (*"The figure is 2 of 2 holdings"*), or the line's own
coverage is derived from the series (`netWorthSeries` already returns `coverage` per point and the
loader discards it at `overview.tsx:187-189`). As written, the caption's wording — *"The figure **and
the line** are N of M holdings"* — makes a claim about the line that is computed only from the figure.

Note: this does **not** reproduce on the `qa2` demo seed, because every account there has a constant
holding count across all 124 statements:
```sql
select account_id, count(distinct cnt) from (select ps.account_id,
  (select count(*) from holding h where h.position_set_id = ps.id) cnt from position_set ps) t
group by 1;   -- every account: 1 distinct count
```

### Cause
`app/routes/overview.tsx:208-209` (counts summed from `accountTotals()`, i.e. today only) consumed by
the caption at `:441-446`.

---

## 8. Holdings subtotal shares are labelled "of gross assets" but the denominator changes with the grouping

**Severity: Medium**

### Repro
```
http://localhost:5182/holdings?group=tax
http://localhost:5182/holdings?group=kind
```

### Observed
```
group=tax    Taxable subtotal        34.6% of gross assets      $238,971.57
group=kind   Brokerage subtotal      30.0% of gross assets      $211,471.57
             Bank subtotal            6.0% of gross assets       $42,000.00
             Liability subtotal      −2.1% of gross assets      −$14,500.00
```
Those three `kind` rows are exactly the holdings in the one `tax` row, so they should reconcile:
`30.0 + 6.0 − 2.1 = 33.9%`, but the tax view says **34.6%**.

### SQL
```sql
select cast(sum(value) filter (where value > 0) as numeric(20,4)) gross_assets,
       cast(sum(value) as numeric(20,4)) net_worth from holding_valued;
 gross_assets |  net_worth
--------------+-------------
  704969.2082 | 690469.2082

select cast(sum(value) as numeric(20,4)) from holding_valued where tax_treatment='taxable';
 238971.5674

select round(238971.5674/704969.2082*100,1) as pct_of_true_gross,
       round(238971.5674/690469.2082*100,1) as pct_the_screen_shows;
 33.9 | 34.6
```
The denominator is "the sum of the positive **groups**", not "gross assets". Under `group=kind` the
loan is its own (negative) group, so the base is 704,969.21. Under `group=tax` and `group=owner` the
loan is netted *inside* a positive group, so the base silently becomes 690,469.21 — the household's
**net worth**, which the caption then calls "gross assets".

### Expected
Either a fixed denominator (the true gross positive total, 704,969.2082, which is what the words say),
or wording that does not name a quantity the number is not a fraction of.

### Cause
`app/lib/allocation.ts:151-185` (`allocateShares` bases on positive *bucket* totals) plus the caption at
`app/routes/holdings.tsx:747` and `:1056`. The same mechanism makes the Analysis page's `% of total`
column mean two different denominators in two panels of one page: `Net worth by person` is a fraction
of the `$690,469.21` in the ring's centre, while `Value by account type` is a fraction of
`$704,969.21` and says so only in a footnote.

---

## 9. Holdings states "the shares above sum to 100%" — grouped by asset class they sum to 100.1%

**Severity: Low**

### Repro
```
http://localhost:5182/holdings?group=assetClass
```

### Observed
```
Equity subtotal   74.3% of gross assets
Bonds subtotal    17.4% of gross assets
Cash subtotal      6.3% of gross assets
Other subtotal     2.1% of gross assets
                 ------
                 100.1%
```
under the sentence: *"Each group's share is of gross assets — the positive groups added together — so
**the shares above sum to 100%** and a liability's is negative."*

`allocateShares` genuinely reaches `1.000000` at six places (verified: exact shares are
0.742865 + 0.173602 + 0.063001 + 0.020532 = 1.000000 (verified in SQL)), but `formatShare` rounds each to one decimal
place independently, so the *printed* column need not. `group=owner`, `group=account`,
`group=institution`, `group=kind`, `group=tax` and `group=classification` all happen to print 100.0%
on this data; `group=assetClass` does not.

### Expected
Either apportion at display precision too, or soften the claim ("the shares are of gross assets, and
round to 100%").

### Cause
`app/routes/holdings.tsx:1056` (the claim) vs `app/routes/holdings.tsx:747` → `formatShare`
(`app/lib/allocation.ts:291`) → `formatPercent(dp = 1)`.

---

## 10. Analysis "Value by asset class" rows sum to $690,469.22 against a stated total of $690,469.21

**Severity: Low** — a display-rounding artefact, **not** a float error; the underlying arithmetic is exact.

### Repro
```
http://localhost:5182/analysis
```

### Observed
```
TOTAL  $690,469.21          (ring centre)
Equity   $512,925.27
Bonds    $119,867.16
Cash      $43,500.00
Other     $14,176.79
         -----------
         $690,469.22        <- one cent more than the total it is a breakdown of
```

### SQL
```sql
select round(sum(r),2) sum_of_rounded_parts, cast(sum(v) as numeric(20,4)) exact_total,
       round(sum(v),2) displayed_total
from (select round(sum(value),2) r, sum(value) v from holding_valued group by asset_class) t;
 sum_of_rounded_parts | exact_total | displayed_total
----------------------+-------------+-----------------
            690469.22 | 690469.2082 |       690469.21
```
Three of the four rows round up by less than half a cent each (`512925.2679`, `119867.1553`,
`14176.7850`). The other two Analysis panels reconcile exactly on this data.

### Expected
This is the same class of problem `allocateShares` was written to solve for percentages
(largest-remainder apportionment) and `taxOn` was written to solve for the tax column
(`allocation.ts:449` — *"Rounded to the cent here, not at the point it is printed … a reader adding the
two figures in front of them gets a different answer than the one underneath"*). The money column in
`Breakdown` gets neither treatment.

### Cause
`app/routes/analysis.tsx:278` — `formatMoney(slice.amount)` rounds each row to 2dp at print time
against a total rounded independently at `:179`.

---

## 11. The Overview headline delta has no "flat" case: a zero change renders a green up-arrow

**Severity: Low** (violates DESIGN §12, "gain and loss are never carried by colour alone")

### Repro (constructed; scenario **S3** — assets exactly cancel debts)
```
http://localhost:5192/
```

### Observed (from the DOM)
```json
{ "fig": "$0.00", "deltaClass": "delta delta--gain", "deltaText": "$0.00" }
```
i.e. `TrendingUpIcon` + `--gain` (green) beside an unsigned `$0.00`. The arrow and the hue both claim
a rise the text does not make. The same code path serves `qa2`: any window whose `change.difference` is `0.0000` renders the same green up-arrow, since the branch is a two-way split on `isNegative`.

### Expected
The table-cell component already gets this right and says why:
`app/components/money-cell.tsx:48-52` computes `flat` and renders `TrendingFlatIcon` + `delta--flat`,
with the comment *"a position that has not moved painted green with an up arrow would say it had."*
The `.delta--flat` CSS class exists in `app/app.css` and the headline never uses it.

### Cause
`app/routes/overview.tsx:389-390` — `const down = isNegative(change.difference)` is a two-way split
with no flat branch.

---

## 12. "Nothing in this breakdown is owned outright" is shown when assets exactly cancel debts

**Severity: Low**

### Repro (scenario **S3**: one bank account +$250,000, one liability −$250,000, one owner)
```
http://localhost:5192/analysis
```

### Observed
```
Net worth by person
PERSON       VALUE     % OF TOTAL
Solo Test    $0.00              —
Nothing in this breakdown is owned outright, so there is no whole for a share to be part of
and no ring to draw. The amounts are the answer here.
```
The person owns $250,000 outright; the note is false, and "the amounts are the answer here" points at
a `$0.00` that is a net, not an absence. The `Value by account type` panel on the same page correctly
shows `Bank $250,000.00 100.0%` / `Liability −$250,000.00 −100.0%`.

### Expected
Distinguish "the positive slices sum to zero" (nothing owned) from "this group nets to zero" (assets
cancel debts). At minimum, do not assert nothing is owned.

### Cause
`app/routes/analysis.tsx:212-223` — `hasRing` is derived from the *slice-level* share, so a group whose
internals cancel is treated as a group with nothing in it.

---

## 13. Coverage sentences ungrammatical in the singular

**Severity: Low**

### Repro
```
http://localhost:5182/holdings?kind=liability
```

### Observed
```
Value is all 1 holdings. Unrealized is 0 of 1 — the rest have no cost basis recorded, …
```
"all 1 holdings" (should be "all 1 holding"); "the rest have" for a single row. The surrounding code
pluralises carefully everywhere else (`holdings.tsx:376`, `:723`, `analysis.tsx:446` `plural()`).

### Cause
`app/routes/holdings.tsx:1042` and `:1047` (`Coverage`) interpolate counts into fixed plural wording.

---

## 14. `formatCompact` has no suffix past `B`: a chart tick reads "1,000.0B"

**Severity: Low**

### Repro (scenario **S4**: one bank balance of 999,999,999,999 — the maximum the app's own input
validator accepts, `input.server.ts:179` "12 integer digits")
```
http://localhost:5192/
```

### Observed
Chart axis labels: `1,000.0B` (×3). Headline and table cells are exact and correct
(`$999,999,999,999.00`), so this is the axis only.

`format.ts:121` — `const suffixes = ["", "K", "M", "B"];`. The promotion guard at `:141` documents
*"one promotion always settles it"*, which is true except at the top of the list, where there is
nothing to promote to.

### Expected
`1.0T`, or the promotion guard acknowledging the ceiling.

---

## 15. Income page's on-screen reason is factually wrong (and contradicted by README)

**Severity: Low** — doc/UX observation. *The Income page being a placeholder is a **documented**
limitation (README.md:244-249, docs/guide/README.md:53) and is not reported as a bug.* What is wrong
is the sentence it gives for why.

### Repro
```
http://localhost:5182/income
```

### Observed
> "Dividend and interest income over time will appear here. **Nothing records income yet** — the
> pricing slice is what starts collecting it."

But the pricing slice already did:
```sql
select count(*) total, count(yield_pct) with_yield,
       count(annual_dividend_per_share) with_div from quote;
 total | with_yield | with_div
-------+------------+----------
    16 |         15 |       15
```
README.md:251 agrees with the data and not with the screen: *"Prices refresh on their own, so Income
has the yield figures it needs; what it still lacks is the screen."*

### Cause
`app/routes/income.tsx:29-31`, and the module doc-comment at `:6-10` ("no slice has filled them").

---

# Tried and did NOT break

**URL / parameter tampering — all clean (200 or a correct 302/404, no 500, nothing in the log):**
* `?range=` on `/` and `/accounts/:id`: absent, empty, `1m 3m 1y all`, wrong case (`1M`), unknown
  (`5y`, `9999`, `-1`), duplicated (`?range=1m&range=all` → first wins), prototype-pollution names
  (`toString`, `constructor`, `__proto__`, `valueOf` — `Object.hasOwn` guard at `overview.tsx:169`
  and `account.tsx:148` holds), unicode (`?range=☠`), SQL-ish (`?range=1' OR 1=1--`),
  path traversal (`?range=../../etc/passwd`), 8,000-character values.
  *Note:* the range control is a closed set of four keys, so "start after end", "year 1000/9999" and
  non-ISO dates are not expressible through it at all — there is no free-form date input on any
  dashboard.
* `/accounts/:id`: `0`, `-1`, `abc`, `1.5`, a UUID, `1'--`, `1 or 1=1`, `../../etc/passwd`, and the
  exact bigint boundary `9223372036854775807` — all a clean 404. (Only >2^63 fails; finding #1.)
* `/accounts/:id?uploaded=` and `?recorded=`: `abc`, `0`, `-1`, `99999999999999999999`, `9999-99-99`,
  `' OR 1=1--` — all 200 with the receipt correctly suppressed. `uploadReceipt` is bounded where
  `isAccount` is not.
* `/holdings`: every `sort` key × both directions; `sort=bogus`, `sort=VALUE`, `dir=up`, `dir=DESC`,
  `group=bogus`, duplicated `group`, `owner=999` (renders the correct "names something this portfolio
  does not hold" message rather than silently widening), `owner=<script>`, emoji filter values,
  NUL bytes, 8,000-character values, `?%00=1`. Canonicalisation redirects are single-hop and do not
  loop.
* `?edit=` / `?saved=`: `1.2`, `0001.0002` (correctly bounced — no leading zeros),
  `99999999999999999999.1` (correctly bounced — this is the guard `isAccount` is missing).

**Money correctness — cross-checked against `psql` in SQL `numeric`, all exact:**
* Overview headline, Holdings grand total, Analysis ring centre and every account row all agree at
  `$690,469.21` = `690469.2082`.
* Holdings totals: value `268781.7529` cost basis / `110571.8122` unrealized / coverages
  `17 of 18`, `11 of 18`, `11 of 18` — all match SQL exactly.
* Account detail totals for all six accounts match `sum(value)` per account exactly, including the
  liability at `−$14,500.00` and the partial `Principal 401(k)` at `$87,799.48` / "2 of 3".
* Analysis by-person and by-account-kind columns reconcile to the cent; positive shares apportion to
  exactly 100.0% in six of the seven groupings.
* Unrealized-gains tax: `23021.6574 × 23.8% = 5479.15` and `47465.2147 × 23.8% = 11296.72`, total
  `16775.87` — the printed column adds up exactly, as `taxOn`'s round-at-source rule intends.
* 1M / 3M / 1Y deltas and percentages all match `netWorthAt(since)` exactly.
* No `NaN`, `Infinity`, `undefined`, `−$0.00` or `$-0.00` was produced anywhere, including with a
  −$0.004 liability (renders `$0.00`, sign correctly suppressed), a sub-cent asset, and a
  999,999,999,999 balance (renders exactly, no float artefact).

**Sorting:** all eight columns in both directions produce the correct order, and nulls stay pinned to
the bottom in **both** directions on all four money columns (the behaviour `sortHoldings` documents).
Tie-breaks are stable across reloads.

**Empty states:** a freshly migrated database with no data renders the correct "There is no data yet"
copy on `/`, `/holdings`, `/analysis`, `/income` with **no figure, no zero and no axis** on any of
them, and `/accounts/1` correctly 404s. `?range=all` on the empty instance does not crash.

**Chart geometry:** the dashed manual run correctly extends to meet the first computed point
(`?range=all`: dashed `0 → x=582.96`, solid `x=582.96 → 1000`); the axis labels are read off the
padded domain and match the plotted values to the cent; deduplicated sample dates do not distort the
x-axis because x is time-based, not index-based; and a range holding a single covered point renders a
note rather than a dot or a divide-by-zero span — verified on the account page with a one-statement
account: *"A line needs two dated points and this range holds 1."*

**Caching / staleness:** updating a quantity directly in the database and immediately re-requesting
`/` and `/holdings` three times returned the new figure every time. No stale value survives a data
change; no caching layer exists to go wrong.

---

# Documented limitations, not bugs (checked before reporting)

1. **Income is a placeholder.** README.md:244-249 and docs/guide/README.md:53 both list it explicitly.
   Only the *wording* of its on-screen reason is reported (finding #15).
2. **No per-account change chip on the account header, and no "Today's Change" column.**
   `account.tsx:380-388` and `:495-503` argue both out explicitly; DESIGN §13.7 is the rule ("a figure
   the schema cannot produce is left out, not invented").
3. **A negative slice has no donut wedge and no fill dot.** DESIGN/`allocation.ts` header argues this
   at length; the screen says so in a note. Working as designed.
4. **The chart carries positions forward between statements**, so a line can run flat for a quarter.
   DESIGN §14 limitation 7.
5. **The "All" range is measured from day zero / the oldest manual point, not from a fixed window.**
   `overview.tsx:59-72` — deliberate. (The *delta* computed against that window is finding #3; the
   window itself is correct.)
6. **`toPlotValue` / the donut `fraction()` are floats.** Both are documented as the single sanctioned
   float, used only for pixel geometry, never for a displayed figure. Verified: every figure on screen
   comes from `formatMoney`/`formatShare` over decimal strings.
7. **Three coverage counts rather than one on Holdings** (value / basis / unrealized). Intentional and
   correct — collapsing them would misreport at least one.
8. **A filter dimension with fewer than two distinct values is not drawn.** `holdings-view.ts`
   `availableFilters` — deliberate (§13.7). Confirmed: the single-person scratch instance is not shown
   an Owner select.
9. **Analysis's tax figure is an un-netted upper bound.** Stated on the panel and in DESIGN §8.1.
10. **Two dashboards can disagree** is named as the design's weakest point (DESIGN §14 limitation 3);
    findings #2, #4, #5, #8 and #10 are instances of it actually happening, so they are reported
    rather than waved off by the limitation.

---

# Repro harness

The constructed-data findings (#4, #5, #6, #7, #11, #12, #14) use a **separate** database and server so
that `qa2` is never written to. `qa2` itself received only `SELECT`s; the repo working tree was not
modified.

**The scratch instance is left running and loaded with scenario S1**, so findings #4, #5 and #6 are
reproducible right now at `http://localhost:5192/`, `/analysis` and `/accounts/2`. Finding #7 needs
the two extra statements in scenario S2 below. To rebuild from scratch:

```bash
export PGPASSWORD=portfolio
psql -h 127.0.0.1 -p 55432 -U portfolio -d postgres \
  -c "DROP DATABASE IF EXISTS qa2_empty;" -c "CREATE DATABASE qa2_empty;"
source /opt/nvm/nvm.sh && nvm use 24.19.0 >/dev/null
DATABASE_URL="postgres://portfolio:portfolio@127.0.0.1:55432/qa2_empty" node ./server/migrate.ts
DATABASE_URL="postgres://portfolio:portfolio@127.0.0.1:55432/qa2_empty" \
  nohup npx react-router dev --port 5192 > /tmp/.../scratchpad/qa2_empty.log 2>&1 &
sleep 18
```

Playwright note: the repo pins playwright 1.62.1 but only chromium build 1194 is installed, so scripts
must launch with an explicit path and resolve the package from the repo:

```js
import { createRequire } from 'node:module';
const require = createRequire('/home/user/portfolio/');
const { chromium } = require('playwright');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
```

### Scenario S1 — an account whose every holding is unpriceable (findings #4, #5, #6)
The migration already seeds `person`-less `classification 'Cash'`, `instrument 1 = USD` and a
`quote` row for USD, so USD is priced and the new trust is not.

```sql
INSERT INTO person (name) VALUES ('Alex Test');
INSERT INTO classification (name, asset_class) VALUES ('Target date fund','other');
INSERT INTO instrument (symbol, name, quote_type, price_source, classification_id)
  VALUES (NULL,'Unquotable Trust',NULL,'manual',
          (select id from classification where name='Target date fund'));
INSERT INTO account (name, institution, kind, owner_id, tax_treatment)
  VALUES ('Ally Savings','Ally','bank',(select id from person),'taxable');
INSERT INTO account (name, institution, kind, owner_id, tax_treatment)
  VALUES ('Workplace Plan','Principal','401k',(select id from person),'tax_deferred');
INSERT INTO price_daily (instrument_id, date, close)
  SELECT 1, d::date, 1.0000
  FROM generate_series(current_date - 400, current_date, interval '1 day') d
  ON CONFLICT DO NOTHING;
INSERT INTO position_set (account_id, as_of_date, source)
  VALUES ((select id from account where name='Ally Savings'), current_date - 300, 'manual');
INSERT INTO holding (position_set_id, instrument_id, quantity)
  VALUES ((select id from position_set order by id desc limit 1), 1, 10000);
INSERT INTO position_set (account_id, as_of_date, source)
  VALUES ((select id from account where name='Ally Savings'), current_date - 10, 'manual');
INSERT INTO holding (position_set_id, instrument_id, quantity)
  VALUES ((select id from position_set order by id desc limit 1), 1, 12000);
INSERT INTO position_set (account_id, as_of_date, source)
  VALUES ((select id from account where name='Workplace Plan'), current_date - 30, 'upload');
INSERT INTO holding (position_set_id, instrument_id, quantity, cost_basis_per_share)
  VALUES ((select id from position_set order by id desc limit 1),
          (select id from instrument where name='Unquotable Trust'), 500, 20.0000);
```

### Scenario S2 — S1 plus "the trust was rolled over" (finding #7)
```sql
INSERT INTO position_set (account_id, as_of_date, source)
  VALUES ((select id from account where name='Workplace Plan'), current_date - 5, 'upload');
INSERT INTO holding (position_set_id, instrument_id, quantity)
  VALUES ((select id from position_set order by id desc limit 1), 1, 1000);
```

### Scenario S3 — assets exactly cancel debts (findings #11, #12)
```sql
DELETE FROM holding; DELETE FROM position_set; DELETE FROM account; DELETE FROM person;
INSERT INTO person (name) VALUES ('Solo Test');
INSERT INTO account (name, institution, kind, owner_id, tax_treatment)
  VALUES ('Big Bank','Mega','bank',(select id from person),'taxable');
INSERT INTO account (name, institution, kind, owner_id, tax_treatment)
  VALUES ('Big Loan','Mega','liability',(select id from person),'taxable');
-- two dated statements per account so the chart has points
INSERT INTO position_set (account_id, as_of_date, source) VALUES ((select id from account where name='Big Bank'), current_date-200,'manual');
INSERT INTO holding (position_set_id, instrument_id, quantity) VALUES ((select id from position_set order by id desc limit 1), 1,  250000);
INSERT INTO position_set (account_id, as_of_date, source) VALUES ((select id from account where name='Big Loan'), current_date-200,'manual');
INSERT INTO holding (position_set_id, instrument_id, quantity) VALUES ((select id from position_set order by id desc limit 1), 1, -250000);
INSERT INTO position_set (account_id, as_of_date, source) VALUES ((select id from account where name='Big Bank'), current_date-3,'manual');
INSERT INTO holding (position_set_id, instrument_id, quantity) VALUES ((select id from position_set order by id desc limit 1), 1,  250000);
INSERT INTO position_set (account_id, as_of_date, source) VALUES ((select id from account where name='Big Loan'), current_date-3,'manual');
INSERT INTO holding (position_set_id, instrument_id, quantity) VALUES ((select id from position_set order by id desc limit 1), 1, -250000);
```

### Scenario S4 — extreme magnitudes (finding #14)
```sql
DELETE FROM holding; DELETE FROM position_set; DELETE FROM account; DELETE FROM person;
INSERT INTO person (name) VALUES ('Whale');
INSERT INTO account (name, institution, kind, owner_id, tax_treatment) VALUES ('Huge Bank','Mega','bank',(select id from person),'taxable');
INSERT INTO account (name, institution, kind, owner_id, tax_treatment) VALUES ('Dust Bank','Mega','bank',(select id from person),'taxable');
INSERT INTO account (name, institution, kind, owner_id, tax_treatment) VALUES ('Tiny Debt','Mega','liability',(select id from person),'taxable');
INSERT INTO position_set (account_id, as_of_date, source) VALUES ((select id from account where name='Huge Bank'), current_date-100,'manual');
INSERT INTO holding (position_set_id, instrument_id, quantity) VALUES ((select id from position_set order by id desc limit 1), 1, 999999999999);
INSERT INTO position_set (account_id, as_of_date, source) VALUES ((select id from account where name='Huge Bank'), current_date-2,'manual');
INSERT INTO holding (position_set_id, instrument_id, quantity) VALUES ((select id from position_set order by id desc limit 1), 1, 999999999999);
INSERT INTO position_set (account_id, as_of_date, source) VALUES ((select id from account where name='Dust Bank'), current_date-2,'manual');
INSERT INTO holding (position_set_id, instrument_id, quantity) VALUES ((select id from position_set order by id desc limit 1), 1,  0.004);
INSERT INTO position_set (account_id, as_of_date, source) VALUES ((select id from account where name='Tiny Debt'), current_date-2,'manual');
INSERT INTO holding (position_set_id, instrument_id, quantity) VALUES ((select id from position_set order by id desc limit 1), 1, -0.004);
```
