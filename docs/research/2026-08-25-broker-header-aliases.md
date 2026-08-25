# Broker header aliases, and what matching them can and cannot do

Companion to the [upload UX review](./2026-08-25-upload-ux-review.md). That document's `UX-4` says the
columns screen should arrive with a proposed mapping instead of six placeholders. This one answers the
question that follows — *matched how?* — and the answer is a curated alias table with normalised exact
matching, with a fuzzy tier rejected on evidence rather than on taste.

**This document was reviewed adversarially before landing and the review changed its argument.** The
first draft proved the anti-fuzzy case with arithmetic that was wrong in the one direction that
mattered, and proved a cost-basis convention using two of this repository's own fixtures while calling
them independent. Both are corrected below and §10 records what was withdrawn, because the withdrawn
version is the intuitive one and someone will reach for it again.

## 1. How the evidence is graded

Brokerages generally document *how* to export rather than *what the columns are called*, so a
publisher's specification is rare — though not absent: Interactive Brokers publishes a full field
reference for Flex Query output, Open Positions included. Everywhere else the strongest available
evidence is a real export file someone committed.

| Tier | Meaning |
|---|---|
| **[EXPORT]** | The header appears in a real (anonymised) export committed to a public repository |
| **[IMPORTER×N]** | Hard-coded in N *independent* open-source importers |
| **[FIXTURE]** | This repository's `tests/fixtures/statements/`, which are modelled on real exports rather than captured from them |
| **[UNVERIFIED]** | Could not confirm — **must not be encoded** |

Most [EXPORT] evidence comes from
[multifol-io/financial-variables](https://github.com/multifol-io/financial-variables/tree/main/data/custodians),
holding real anonymised position exports from Fidelity, Schwab, Vanguard (two generations), Merrill
Edge, E\*TRADE, T. Rowe Price, TIAA, JPMorgan Chase and Ameriprise. **Those files are anonymised**,
which matters in §6: a figure that does not reconcile there is not necessarily a figure that would not
reconcile in the wild.

A tier is about the *header string*, never about a claim made around it. Where a conclusion rests on
arithmetic, the arithmetic's own source is named.

## 2. The collision list

Header strings that are textually close and semantically opposite. Each is a way for a matcher to be
confidently wrong, and in each case the resulting figure looks entirely plausible.

### 2.1 Cost basis: per share versus whole position

| Pair | Where | What the wrong pick does |
|---|---|---|
| `Average Cost Basis` ↔ `Cost Basis Total` | **Fidelity, adjacent fields in the same header** [EXPORT] | The error is exactly the position size |
| `CostBasisPrice` ↔ `CostBasisMoney` | Interactive Brokers, both on every Open Positions row [EXPORT] | Nine characters of shared prefix in a fourteen-character string |
| `Cost` ↔ `Unit Cost` ↔ `Local Unit Cost` ↔ `Orig Cost (Base)` ↔ `Orig Cost (Local)` ↔ `Local Cost` ↔ `Cost Source` ↔ `Disclaimers-Cost` | JPMorgan, all in one header row [EXPORT] | `cost` is a substring of every one; errors run from a quantity factor to an FX factor |
| `Cost Basis` ↔ `Cost Basis Per Share` | Schwab [EXPORT] versus this repo's `lot-level.csv` [FIXTURE] | **The shorter string is the total and the longer is per share** — the opposite of the intuition that a longer name is more derived |

Two of these are settled by arithmetic inside the real exports rather than by assertion.

**Schwab's bare `Cost Basis` is whole-position.** In the real export, `Cost Basis + Gain/Loss $ =
Market Value` on every position row — `$45.00 + $26.71 = $71.71`, `$44.99 + $3.30 = $48.29`,
`$48.11 + $20.01 = $68.12` — which only holds if the cost figure is the whole position's. The
`Account Total` footer row does *not* satisfy it, which is itself an argument for §2.7's row guard.

**IBKR's pair proves the lexical rule in §4 from a second, independent broker.** Its real Open
Positions export carries `Quantity = 2`, `CostBasisPrice = 189.34`, `CostBasisMoney = 378.68`, and
`2 × 189.34 = 378.68` exactly. `Price` means per share and `Money` means the aggregate, demonstrated
rather than argued.

### 2.2 Price versus price change

| Pair | Where | What the wrong pick does |
|---|---|---|
| `Price` ↔ `Price Chng $ (Price Change $)` ↔ `Price Chng % (Price Change %)` | Schwab, newer generation [IMPORTER×2] | A share price becomes a daily delta. Taken as a cost basis, reported gain becomes very nearly the whole market value |
| `Last Price` ↔ `Last Price Change` | Fidelity [EXPORT] | The first is a strict prefix of the second |
| `Mark` ↔ `Trade Price` | thinkorswim [IMPORTER×2] | `Mark` is the current price and `Trade Price` the average entry. Choosing `Mark` as cost basis makes unrealised gain **exactly zero on every row**, invisible on a totals line |
| `Mkt. Price` ↔ `Mkt. Value` | Ameriprise [EXPORT] | One token apart; the confusion scales by quantity |

### 2.3 Quantity versus a per-unit column, and quantity named like money

| Pair | Where | What the wrong pick does |
|---|---|---|
| `Units` ↔ `Unit Price` | **This repo's `401k.csv`, both present** [FIXTURE] | Quantity `412.5123` becomes `54.12`. Both magnitudes are plausible |
| `Shares` ↔ `Share Price` | Vanguard current generation, both present [EXPORT] | The same prefix collision |
| `Amount` as the **quantity** column | DEGIRO [IMPORTER] | `Amount` is a money word everywhere else in the corpus — `Principal Amount`, `Net Amount`, `Dollar Amount` (Vanguard), `Subscription Amount` (JPMorgan). A table keyed on meaning-by-name gets this exactly backwards |
| `Balance` ↔ `Principal Balance` | This repo's `401k.csv` versus `liability.csv` [FIXTURE] | An asset read as a debt, or the reverse |

The Vanguard **legacy** platform is not a second instance of the first row: its holdings header is
`Fund Account Number,Fund Name,Price,Shares,Total Value` — the price column is plain `Price`, and it
comes *before* `Shares`. `Share Price` appears in that file only in its transactions section. Two
consequences: a positional fallback fails, and `Fund Account Number` is an account-number header that
an exact-match table keyed on `Account Number` misses silently.

### 2.4 Account number versus account name, including two inverted cases

| Case | Where | What the wrong pick does |
|---|---|---|
| `Account Name` holds the **institution**, `Account Description` holds the **masked number** | Ameriprise [EXPORT] | Inverted from the intuition. Every row carries the same institution string, so all positions collapse into one account |
| `Account Name` holds the **fund name** | T. Rowe Price [EXPORT] | A matcher keying on the `account` token takes it, and the file's real instrument names are lost. Its `Account Number` *is* correct, so the file punishes both the naive and the over-clever |
| `Account #` ↔ `Account Nickname` ↔ `Account Registration` | Merrill Edge [EXPORT] | In the real export `Account Nickname` is literally `--` and `Account Registration` is the same string on every row, so "first non-empty account-ish column" picks the wrong one |
| bare `Account`, holding a name-and-mask hybrid | E\*TRADE [EXPORT] | Shortest possible header for the role, and not the number |

Headers containing the word `account` across the corpus name a number, a registration label, a
nickname, a tax status, an institution, a fund, and a percentage of the portfolio. Headers that fill an
account role *without* containing it include `Acct Type`, `Plan`, `Fund Account Number` and IBKR's
`ClientAccountID` — which is why this role in particular cannot be reasoned about from the word.

### 2.5 Parenthetical suffixes — where fixing Schwab breaks other brokers

Schwab's newer export needs a parenthetical rule: `Qty (Quantity)`, `Mkt Val (Market Value)`,
`% of Acct (% of Account)` [IMPORTER×2 — this generation is *not* in the corpus above, which holds the
older `Quantity,Price,Price Change %,…` form]. Applying that rule generally is destructive.

| Collapse | Where | What it does |
|---|---|---|
| `Price (pence)`, `Price (p)`, `Price (GBX)` → `Price` | Hargreaves Lansdown [IMPORTER×2] | A silent **hundred-fold** error — the column is GBX while `Value (£)` in the same file is GBP |
| `Change since last close ($)` and `(%)` → one key | TIAA [EXPORT] | Two distinct columns in one file normalise to the same key |
| `Orig Cost (Base)` and `Orig Cost (Local)` → one key | JPMorgan [EXPORT] | Base and local currency collapse |
| every `Currency (…)` header → `Currency` | Trading 212 [IMPORTER×9] | That file carries more than a dozen of them; they collapse to *one* key, and the meaning inverts — each names the currency *of* another column |

It is tempting to encode the difference as "strip only when the text outside the parentheses is an
abbreviation of the text inside", which accepts Schwab's whole family and rejects a unit or a currency.
**That heuristic fails on `Price (p)`**, which is a real HL spelling and is not a longer restatement of
anything. So the recommendation is the one with no failure mode: **do not strip. Store both the
abbreviated and expanded strings as separate aliases.** One line each.

### 2.6 As-of versus every other date

| Pair | Where | What the wrong pick does |
|---|---|---|
| `As Of` ↔ `Date Acquired` | This repo's `liability.csv` versus `lot-level.csv` [FIXTURE] | Back-dates the statement by years. Since a statement is keyed by its date, this corrupts history rather than just the import |
| `As of` ↔ `Pricing Date` ↔ `Acquisition Date` ↔ `Adj Date` ↔ `Maturity Date` | JPMorgan, **all five in one file** [EXPORT] | `Pricing Date` is the closest wrong answer; `Maturity Date` can be decades out |
| `COB Date` | Merrill Edge [EXPORT] | The *correct* as-of column, sharing no substring with "as of" |

### 2.7 One file, several header rows

The most under-appreciated hazard, and not about matching at all.

The real Vanguard export in the corpus carries **four** header rows: a holdings section, a
transactions section, and then a plan-holdings and plan-transactions pair. **That count is a property
of the household, not the format** — the extra two exist because this household also holds a
Vanguard-administered workplace plan, and an importer describing the same download says plainly that
it has two sections. What generalises is the overlap: the holdings and transactions headers share
`Account Number`, `Investment Name`, `Symbol`, `Shares` and `Share Price`, confirmed independently by
[hledger's Vanguard rules file](https://raw.githubusercontent.com/simonmichael/hledger/master/examples/csv/investment/vanguard.csv.rules).
Locking onto the transactions header yields per-trade share counts presented as positions: a holding
bought in five tranches appears as five rows each holding a fraction of the true quantity.

E\*TRADE's export has the same shape for a different reason — an `Account Summary` block precedes the
positions block, plus a third pseudo-header of report settings — and `Total Gain $` appears in two of
those header rows.

The guard belongs in header-row detection rather than the alias table: **require a candidate header row
to satisfy the mandatory roles** — something instrument-like and something quantity-like — before
offering it. That rejects E\*TRADE's summary and settings blocks and Ameriprise's `Cash & Equivalents`
sub-header alike.

It does not reject everything. thinkorswim mixes row *shapes* under one header, with strategy rows whose
quantity is empty; and Schwab ships the literal string `Incomplete` in a numeric cost column. Both are
row-level problems that a header-level guard cannot see.

## 3. Why not fuzzy — the argument, corrected

The first draft argued this with a claim that is arithmetically false, and the false version is the
intuitive one. Stated plainly so it is not reconstructed later:

> ~~"Any threshold loose enough to catch `Qty` → `Quantity` is loose enough to catch `Unit Price` →
> `Units`."~~

That is wrong under raw edit distance. `qty`→`quantity` is **5**; `units`→`unit price` is **6** and
`shares`→`share price` is **6**. A raw threshold of 5 admits the safe abbreviation and rejects both
dangerous pairs — the opposite of the claim.

It becomes true under a **length-normalised** threshold, which is what a real implementation uses,
because raw distance cannot compare a three-character header to a twenty-character one:

| Pair | Raw | Normalised by the longer string |
|---|---|---|
| `qty` → `quantity` (safe, wanted) | 5 | 0.625 |
| `units` → `unit price` (dangerous) | 6 | 0.600 |
| `shares` → `share price` (dangerous) | 6 | 0.545 |
| `cost` → `unit cost` (dangerous) | 5 | 0.556 |

Admitting the abbreviation at 0.625 admits all three collisions beneath it. **That** is the argument,
and it is narrower than the original: fuzzy matching fails not because distance is large but because
the abbreviations a matcher exists to catch sit *further away* than the collisions it must avoid.

The companion claim was also overstated. Distance does not fail to reach every awkward header:
`naam`→`name` is **2**, closer than the abbreviation, and `cob date`→`as of date` is **4**. A fuzzy
matcher would find both, correctly. What it cannot reach is a header sharing no lexical relationship
with its role at all — TIAA's `Your Investments` is **10** from `instrument`, DEGIRO's `Product` is
closer to *price* (**4**) than to any role it fills, and DEGIRO's `Amount` is **5** from `as of`. The
honest form: the headers fuzzy matching can reach are the ones it did not need to, and the ones it
cannot reach are where a table is the only option.

Substring and token matching are worse on the same pairs, because the role words are the *least*
selective tokens in the corpus. `price` appears in headers meaning a current price, a per-share cost,
a daily delta in currency, a daily delta in percent, a price in a second currency, and a date
(`Pricing Date`). `cost` appears eight times in a single JPMorgan header row, listed in §2.1.
`account` is cataloged in §2.4.

## 4. What the table can carry that a matcher cannot

A distance or token matcher returns a column. A table returns a record, and the record is the only
place the semantics can live:

```
"average cost basis" → { role: costBasis, perShare: true  }
"cost basis total"   → { role: costBasis, perShare: false }
"costbasismoney"     → { role: costBasis, perShare: false }
"price (pence)"      → { role: price, scale: 0.01 }
"price (p)"          → { role: price, scale: 0.01 }
"last price change"  → { role: none }
"date acquired"      → { role: none }
```

**The cost-basis header often names its semantics, which is most of `UX-5`.** `average`, `unit`,
`per share`, `price` and `paid` mean per share; `total` and `money` mean whole position. This is a real
generalisation rather than a lookup — a *price* is per-unit by definition — and §2.1's IBKR pair
demonstrates the `price`/`money` half arithmetically from a broker that does not share Fidelity's
vocabulary.

Two limits, both found by testing the rule against every cost-basis header in this document:

**Unqualified headers carry no signal.** `Cost`, `Cost Basis`, `Cost (£)` and `Local Cost` contain no
magnitude token. Every provider observed here means a whole position by them, but that is a convention,
not something the string says — and it is the case `UX-5`'s own example falls into, since Schwab's
header is the bare form. The right behaviour is what the gap already produces: no signal, no pre-set,
and the control stays a visible decision. Note that this is the **opposite of today's default**, which
is per-share (`app/routes/upload/columns.tsx:119`); moving it is a deliberate change, not a
clarification.

**`orig` is not a magnitude token and was withdrawn.** JPMorgan's `Orig Cost` contrasts with
*adjusted* cost — the same file carries wash-sale and disallowed-loss columns — so the axis is
original-versus-adjusted. That it happens to be whole-position follows from `Cost` being unqualified by
`Unit`, not from `orig`. A `book` token was also withdrawn: it was unsourced, and the common real form
*"average book cost"* would trigger both sides of the rule at once with no tie-break.

**The negative entries matter as much as the positive ones.** Recording `last price change` and
`date acquired` as mapping to nothing documents the decision and keeps them out of reach of any future
looser matcher.

## 5. Normalisation

Safe: strip the UTF-8 BOM — the real Fidelity export and this repo's `semicolon.csv` both carry one,
and it corrupts the first header silently; NFKC; trim and collapse internal whitespace runs, since
JPMorgan's last header carries a trailing space; case-fold; strip a trailing footnote marker, as in
TIAA's `Change since last close ($)*`.

Not safe: stripping parentheticals wholesale (§2.5); removing punctuation, since `%` and `£` *are* the
meaning in `Gain/loss (%)` versus `Gain/loss (£)`; dropping qualifier words, which are the semantics;
stemming or singularising, which turns the two safe pairs `Shares`/`Share Price` and `Units`/`Unit
Price` into collisions; and translating at runtime — `Aantal`, `Naam`, `Koers`, `Product`, `Amount` and
`Symbol/ISIN` belong in the table as literals.

Two normalisations the first draft listed and this one drops: straightening curly apostrophes, because
no header in the corpus contains one — every `Today's` is a straight quote; and stripping surrounding
quotes, which is the CSV parser's job and is a no-op by the time a header string exists.

One header in the corpus is the **empty string** — DEGIRO puts an unnamed currency column between
`Local value` and `Value in EUR`. Neither the normalisation list nor the header-row guard has anything
to say about that, and something should.

## 6. Cross-checking the arithmetic — useful, and weaker than it first looks

These files are redundant by design, so a proposed mapping can be tested against the file's own
numbers: `quantity × price ≈ value`, and where both cost columns exist,
`quantity × costPerShare ≈ costTotal`. The attraction is that it catches §2.2 and §2.3 *without
recognising the broker at all*.

**It was measured, and the result argues for a softer role than the first draft gave it.** Against this
repository's fixtures the identity holds on every row that carries all three columns as numbers —
including Schwab's short at `-10 × $27.15 = ($271.50)` and the European `semicolon.csv` at
`120.5 × 101.22 = 12197.01` — with two caveats the first draft missed: `401k.csv` has three funds, not
two, and two of them are off by fractions of a cent; and Fidelity's `FXAIX` row is off by `$0.09`, so
the relation is an approximation and needs a stated tolerance rather than equality.

Against the **real** corpus it fails much more often. Schwab fails on three of four priced rows,
Fidelity on two, Vanguard on one; Merrill, E\*TRADE and JPMorgan pass. Two causes are separable:

- **A genuine domain rule.** Fidelity's failures are fixed income quoted per $100 of face value:
  `5000 × 99.949 ÷ 100 = 4,997.45` matches the stated value exactly. Any implementation of this check
  needs that rule, or it will flag every bond.
- **Anonymisation.** The corpus is scrubbed. Vanguard's miss is off by exactly ten; T. Rowe's market
  values are literally `1`, `2`, `3`. These are not evidence about real files.

So the honest statement is narrower than "these files are redundant by design": the check is worth
having, and it must be a **confidence signal that demotes a proposal, never a gate that blocks one**.
It needs a tolerance, the per-$100-face rule, a minimum number of agreeing rows, and a non-numeric path
— Schwab ships `--` in its footer rows and the literal `Incomplete` in a cost column.

A third party already does this in production and on the harder version of the problem: an HL importer
declines to trust the pence-versus-pounds label at all, computes `units × price` against the stated
value under both scale hypotheses, and picks the one with lower error.

**Show the data as well.** The columns screen already renders sample rows verbatim, and the design
brief calls them the feature rather than decoration. Rendering the first values beside each proposed
choice lets a human tell `412.5123` from `$54.12` instantly, which no string algorithm will.

## 7. Where instrument and name are one column

Directly relevant to `UX-6`, which argues the mapping screen should let one column fill both roles.

| Provider | Header | Situation |
|---|---|---|
| Vanguard legacy mutual-fund platform | `Fund Name` | **No symbol column exists in the file** [EXPORT] |
| TIAA | `Your Investments` | The ticker is inside the cell — `… Institutional Plus (VIIIX)` [EXPORT] |
| thinkorswim | `Instrument` | One combined column for ticker and option description [IMPORTER×2] |
| Ameriprise | `Description` | `Symbol` is empty for alternative investments [EXPORT] |
| DEGIRO | `Product` | The identifier column is `Symbol/ISIN`, and cash rows carry no instrument identity [IMPORTER] |

The design consequence is sharper than "allow it": **the fallback must be per row, not per file.** The
cleanest example is in this repository — `401k.csv` has a `Ticker` column that is blank on two of three
rows, both Vanguard collective investment trusts, and populated with `VBTIX` on the third. Ameriprise's
real export shows the same shape with an empty `Symbol` on one row. A file-level "this export has no
ticker" decision is wrong for exactly the rows that need it.

Collective investment trusts genuinely have no ticker — they are not SEC-registered funds — so the
blank-identifier row is a domain fact rather than any one provider's quirk.

**A note on TIAA, because it cuts against §2.5 and the tension is real.** Recovering `VIIIX` from
`… (VIIIX)` means parsing a parenthetical, which §2.5 forbids. There is no contradiction: §2.5 is about
normalising **header** strings, where a parenthetical is a unit or a qualifier; this is a **data cell**,
where it is content. Two different rules for two different things, marked here so the next reader does
not reconcile them.

## 8. Most position exports carry no as-of column

Worth stating on its own, because it changes how `UX-10` should be read. Of the corpus, only Merrill
(`COB Date`), JPMorgan (`As of`), Ameriprise (`As Of`) and IBKR (`ReportDate`) expose a date a mapping
could point at. The rest put it outside the table:

- **Preamble line:** Schwab, TIAA (`Data As of …`), Ameriprise — which is the one file carrying both.
- **Trailer line:** Fidelity (`Date downloaded …`, a download timestamp rather than an as-of date) and
  E\*TRADE (`Generated at …`).

The real Fidelity export has **no preamble at all** — its first line is the header row. The preamble
this repository's `fidelity.csv` fixture carries is a modelled shape, and the first draft of this
document read the fixture and reported it as the export.

So "this file does not date itself" is the **normal** case, and a review screen defaulting to today is
defaulting wrongly most of the time. Whatever is done about it should be designed for the common path.

## 9. Explicitly unverified — do not encode

- **Fidelity NetBenefits**, **Principal** and **Empower** workplace headers. No export and no importer
  found. This repository's `401k.csv` is a plausible *model* of that shape and must not be treated as
  an observed format.
- **Robinhood**, **Betterment** and **Wealthfront** have no native positions CSV at all. Robinhood's
  familiar `symbol` / `average_buy_price` names are REST API fields; adding them as CSV aliases would
  invent a format.
- **Merrill Edge cost basis** — the real export has none; its tax-lot report is a separate download
  whose headers were not verified.
- **Liability header aliases** beyond this repo's own `Principal Balance`.
- **Trading 212** is a transactions export, not a positions export, and is out of scope for this
  application. Its headers appear above only as evidence about parentheticals.
- A reported **Fidelity re-casing** to sentence case and a `Symbol/CUSIP` variant — each single-source,
  and harmless either way since case folding is safe.

## 10. What the review withdrew, and why it is recorded

Three claims did not survive grounding. They are kept here because each is the intuitive answer and
will otherwise be rediscovered.

1. **The `Qty`→`Quantity` threshold argument** (§3). False under raw edit distance; true only under
   length normalisation. The conclusion stands, the proof did not.
2. **`Naam`, `COB Date` and friends as unreachable by fuzzy matching** (§3). Two of them are nearer
   than the abbreviation the matcher exists to catch.
3. **Schwab's `Cost Basis` proved from Fidelity's fixture** (§2.1). Both figures came from fixtures in
   this repository, authored together, so there was no independence. Replaced with an internal
   consistency check inside the real Schwab export, which needs no second source.

The `orig` and `book` tokens in §4 were withdrawn for the same reason: reasoning that looked lexical
turned out to be coincidence.

## 11. The recommendation, in one line

Curated alias table → normalised exact match → per-role preference when one file offers two valid
candidates → arithmetic cross-check as a demotion signal → propose with the sample values beside it →
**leave unmatched columns unmapped**. A missing proposal costs one dropdown click. A wrong proposal that
survives review costs a number that is wrong by the position size and looks entirely plausible.
