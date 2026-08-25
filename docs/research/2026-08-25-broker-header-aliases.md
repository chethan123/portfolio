# Broker header aliases, and why the matching must not be fuzzy

Companion to the [upload UX review](./2026-08-25-upload-ux-review.md). That document's `UX-4` says the
columns screen should arrive with a proposed mapping instead of six placeholders. This one answers
the question that follows — *matched how?* — and the answer is narrower than it first looks: a
curated alias table with normalised exact matching, and **no fuzzy tier at any stage**.

The evidence for that is §2, the collision list. It is the part worth reading.

## 1. How the evidence is graded

No brokerage publishes its CSV column names. Their help pages document *how to export*, not *what the
columns are called*, so a primary source barely exists here and the strongest available evidence is a
real export file someone committed.

| Tier | Meaning |
|---|---|
| **[EXPORT]** | The header appears in a real (anonymised) export committed to a public repository |
| **[IMPORTER×N]** | Hard-coded in N *independent* open-source importers |
| **[FIXTURE]** | This repository's own `tests/fixtures/statements/`, which are modelled on real exports rather than captured from them |
| **[UNVERIFIED]** | Could not confirm — **must not be encoded** |

Most [EXPORT] evidence comes from one collection:
[multifol-io/financial-variables](https://github.com/multifol-io/financial-variables/tree/main/data/custodians),
which holds real anonymised position exports from Fidelity, Schwab, Vanguard (two generations),
Merrill Edge, E\*TRADE, T. Rowe Price, TIAA, JPMorgan Chase and Ameriprise. Two of its files were
re-fetched and read directly while writing this document; those are marked *verified here*.

## 2. The collision list

Header strings that are textually close and semantically opposite. Every one of these is a way for a
matcher to be confidently wrong, and in each case the resulting figure looks entirely plausible.

### 2.1 Cost basis: per share versus whole position

| Pair | Where | What the wrong pick does |
|---|---|---|
| `Average Cost Basis` ↔ `Cost Basis Total` | **Fidelity, both in the same file** — *verified here* against the [real export](https://raw.githubusercontent.com/multifol-io/financial-variables/main/data/custodians/fidelity.csv) | The error is exactly the position size |
| `CostBasisPrice` ↔ `CostBasisMoney` | Interactive Brokers, both on every Open Positions row [IMPORTER×6] | Edit distance 5 in a 14-character string sharing a 9-character prefix |
| `Cost` ↔ `Unit Cost` ↔ `Local Unit Cost` ↔ `Orig Cost (Base)` ↔ `Local Cost` | JPMorgan, all in one file [EXPORT] | `cost` is a substring of all five; errors range from a quantity factor to an FX factor |
| `Cost Basis` ↔ `Cost Basis Per Share` | Schwab [EXPORT] versus this repo's `lot-level.csv` [FIXTURE] | **The shorter string is the total and the longer is per share** — the opposite of the intuition that a longer name is more derived. Prefix matching gets it backwards |

Schwab's bare `Cost Basis` is a whole-position figure, checked arithmetically rather than assumed:
its `schwab.csv` states `$8,533.00` against 50 AAPL shares, and Fidelity independently states the
same holding's average cost basis as `$170.6600` — exactly one fiftieth.

### 2.2 Price versus price change

| Pair | Where | What the wrong pick does |
|---|---|---|
| `Price` ↔ `Price Chng $ (Price Change $)` ↔ `Price Chng % (Price Change %)` | Schwab | `price` matches all three; a share price of `$229.35` becomes `$1.12`. Taken as a cost basis, reported gain becomes very nearly the whole market value |
| `Last Price` ↔ `Last Price Change` | Fidelity | The first is a strict prefix of the second |
| `Mark` ↔ `Trade Price` | thinkorswim | `Mark` is the current price and `Trade Price` the average entry. Choosing `Mark` as cost basis makes unrealised gain **exactly zero on every row**, which is invisible on a totals line |
| `Mkt. Price` ↔ `Mkt. Value` | Ameriprise | One token apart; the confusion scales by quantity |

### 2.3 Quantity versus a per-unit column

| Pair | Where | What the wrong pick does |
|---|---|---|
| `Units` ↔ `Unit Price` | **This repo's own `401k.csv`, both present** | Quantity `412.5123` becomes `54.12`. Both magnitudes are plausible, so nothing looks wrong |
| `Shares` ↔ `Share Price` | Vanguard, both generations [EXPORT] | Same prefix collision — and the legacy export orders them `Price, Shares`, so a positional fallback fails too |
| `Balance` ↔ `Principal Balance` | This repo's `401k.csv` versus `liability.csv` | An asset read as a debt, or the reverse |

### 2.4 Account number versus account name, including two inverted cases

| Case | Where | What the wrong pick does |
|---|---|---|
| `Account Name` holds the **institution**, `Account Description` holds the **masked number** | Ameriprise [EXPORT] | Inverted from the intuition. Mapping by name puts an identical institution string in every row's account field, collapsing all positions into one account |
| `Account Name` holds the **fund name** | T. Rowe Price [EXPORT] | Any matcher keying on the `account` token takes it, and the file's real instrument names are lost. Its `Account Number` *is* correct, so the file punishes both the naive and the over-clever |
| `Account #` ↔ `Account Nickname` ↔ `Account Registration` | Merrill Edge [EXPORT] | Three account-ish columns, one of which is the number. In the real export `Account Nickname` is literally `--`, so "first non-empty account-ish column" picks the registration string, identical across rows |

Across the corpus, `Account Name`, `Account Type`, `Acct Type`, `Account Nickname`,
`Account Registration`, `Account Description`, `AccountAlias`, `Percent Of Account` and `Plan` all
contain the word but are not the number.

### 2.5 Parenthetical suffixes — where fixing Schwab breaks other brokers

Schwab's newer export needs a parenthetical rule: `Qty (Quantity)`, `Mkt Val (Market Value)`,
`% of Acct (% of Account)`. Applying that rule generally is destructive.

| Collapse | Where | What it does |
|---|---|---|
| `Price (pence)` → `Price` | Hargreaves Lansdown [IMPORTER×2] | A silent **hundred-fold** error — the column is GBX while `Value (£)` in the same file is GBP |
| `Change since last close ($)` and `(%)` → one key | TIAA [EXPORT] | Two distinct columns in one file normalise to the same key; a currency delta and a percentage become interchangeable |
| `Orig Cost (Base)` and `Orig Cost (Local)` → one key | JPMorgan [EXPORT] | Base and local currency collapse |
| `Currency (Price / share)` → `Currency` | Trading 212 [IMPORTER×9] | Meaning inverts: it names the currency *of* a price rather than being one |

The distinguishing feature is that in Schwab's style the parenthetical is a **longer restatement** of
the text before it, whereas everywhere else it is a unit, a currency or a qualifier. A rule could
encode that. Simpler and with no failure mode: **do not strip anything — store both the abbreviated
and expanded strings as separate aliases.** It costs one line each.

### 2.6 As-of versus every other date

| Pair | Where | What the wrong pick does |
|---|---|---|
| `As Of` ↔ `Date Acquired` | This repo's `liability.csv` versus `lot-level.csv` | Back-dates the statement by years. Since a statement is keyed by its date, this corrupts history rather than just the import |
| `As of` ↔ `Pricing Date` ↔ `Acquisition Date` ↔ `Adj Date` ↔ `Maturity Date` | JPMorgan, **all five in one file** [EXPORT] | `Pricing Date` is the closest wrong answer; `Maturity Date` can be decades out |
| `COB Date` | Merrill Edge [EXPORT] | This is the *correct* as-of column, and it shares **no token and no substring** with "as of". No fuzzy or token matcher will ever reach it — only a curated alias can |

### 2.7 One file, several header rows

The most under-appreciated hazard, and it is not about matching at all.

Vanguard's `OfxDownload.csv` was re-fetched and read while writing this — *verified here* — and it
carries **four** header rows in one file: a holdings section, a transactions section, a plan-holdings
section and a plan-transactions section. The first two share `Account Number`, `Investment Name`,
`Symbol`, `Shares` and `Share Price`. Locking onto the transactions header yields per-trade share
counts presented as positions: a holding bought in five tranches appears as five rows each holding a
fraction of the true quantity.

E\*TRADE's `PortfolioDownload.csv` has the same shape for a different reason — an `Account Summary`
block precedes the positions block, and `Total Gain $` appears in both header rows.

The guard is cheap and belongs in the header-row detection rather than the alias table: **require a
candidate header row to satisfy the mandatory roles** — something instrument-like and something
quantity-like — before offering it. That one check rejects E\*TRADE's summary block and Ameriprise's
`Cash & Equivalents` sub-header alike.

## 3. Why not fuzzy, stated once

In every dangerous pair above, the nearest neighbour by edit distance is the semantically opposite
column, because the semantics live in short qualifier tokens — `Total`, `Average`, `Unit`, `Change`,
`Local`, `Per Share` — that are cheap to insert.

| Pair | Edit distance | Semantic gap |
|---|---|---|
| `CostBasisPrice` / `CostBasisMoney` | 5 of 14 | a factor of the position size |
| `Units` / `Unit Price` | 6 | a quantity versus a price |
| `Shares` / `Share Price` | 6 | a quantity versus a price |
| `Cost` / `Unit Cost` | 5 | a total versus a per-share figure |
| `Last Price` / `Last Price Change` | 7 | a price versus a daily delta |

Edit distance is **anti-correlated with meaning** in this domain. Any threshold loose enough to catch
`Qty` → `Quantity` is loose enough to catch `Unit Price` → `Units`. And it buys nothing at the other
end: no distance reaches `COB Date`, `Aantal`, `Slotkoers`, `Naam` or TIAA's `Your Investments`, which
are exactly the headers that need help.

Substring and token matching are worse on the same pairs, because the role words are the *least*
selective tokens in the corpus. `price` appears in headers meaning a current price, a per-share cost,
a daily delta in currency, a daily delta in percent, a price in a second currency, and a date
(`Pricing Date`). `cost` appears six times in a single JPMorgan header row alone — counted from §2.1,
where the six are listed. `account` appears in headers naming a number, a registration label, a
nickname, a tax status, an institution, a fund, and a percentage of the portfolio — and in the
Ameriprise and T. Rowe files the wrong one wins.

## 4. What the table can carry that a matcher cannot

A distance or token matcher returns a column. A table returns a record, and the record is the only
place the semantics can live:

```
"average cost basis" → { role: costBasis, perShare: true  }
"cost basis total"   → { role: costBasis, perShare: false }
"costbasismoney"     → { role: costBasis, perShare: false }
"price (pence)"      → { role: price, scale: 0.01 }
"last price change"  → { role: none }
"date acquired"      → { role: none }
```

Two consequences worth stating separately.

**The cost-basis header names the semantics, which settles `UX-5`.** `average`, `unit`, `per share`,
`price` and `paid` mean per share; `total`, `money`, `orig` and `book` mean whole position. That is a
real generalisation rather than a lookup — a *price* is per-unit by definition. So the same table that
proposes the mapping can also pre-set the per-share/total control, which is the control `UX-5` shows
silently recording a fifty-fold error when it is left on its default.

The rule was run against every cost-basis header listed in §2.1 and above, and it has one gap worth
naming rather than papering over: the **unqualified** headers — `Cost`, `Cost Basis`, `Cost (£)`,
`Local Cost` — carry no lexical signal at all. Every provider observed here means a whole position by
them, but that is a convention rather than something the string says. The right behaviour is the safe
one the gap already produces: no signal means no pre-set, default to total, and flag it low
confidence so the control is shown as a decision rather than made silently. This is also the clearest
argument for a table over a rule — a table can record what a bare `Cost Basis` was observed to mean
at Schwab, where the rule can only shrug.

**The negative entries matter as much as the positive ones.** Recording `last price change` and
`date acquired` as mapping to *nothing* documents the decision and keeps them out of reach of any
future looser matcher.

## 5. Normalisation

Safe: strip the UTF-8 BOM (Fidelity's real export and this repo's `semicolon.csv` both carry one, and
it corrupts the first header silently); NFKC, and straighten curly apostrophes — `Today's` appears
both ways; strip surrounding quotes, since Schwab quotes everything; trim and collapse internal
whitespace runs — JPMorgan's last header carries a trailing space; case-fold; strip a trailing
footnote marker, as in TIAA's `Change since last close ($)*`.

Not safe: stripping parentheticals wholesale (§2.5); removing punctuation, since `%` and `£` *are*
the meaning in `Gain/loss (%)` versus `Gain/loss (£)`; dropping qualifier words, which are the
semantics; stemming or singularising, which turns the two safe pairs `Shares`/`Share Price` and
`Units`/`Unit Price` into collisions; and translating at runtime — `Aantal`, `Naam`, `Koers`,
`Slotkoers` and `Symbool/ISIN` belong in the table as literals.

## 6. Two safeguards worth more than the matcher

**Cross-check the arithmetic before offering the proposal.** These files are redundant by design:
`quantity × price ≈ value`, and where both cost columns exist,
`quantity × costPerShare ≈ costTotal`. A mismatch should demote confidence and stop the proposal being
pre-applied. That single check catches §2.2, §2.3 and the per-share/total inversion — the costliest
families — for a few lines of arithmetic, and it catches them *without needing to recognise the
broker at all*.

It was checked rather than assumed: `quantity × price` reproduces the stated value on **every row of
every fixture in this repository that carries all three columns** — Fidelity's four rows including
the money-market sweep, Schwab's including the short position at `-10 × $27.15 = ($271.50)`, both
`401k.csv` funds, and the European `semicolon.csv` at `120.5 × 101.22 = 12197.01`. The cost-basis
form checks out too: Schwab's `$8,533.00` total over 50 shares is `$170.66`, which is what Fidelity
states per share for the same holding. Two fixtures carry no price column at all — `liability.csv`
and `lot-level.csv` — so the check is simply unavailable there, which is the right failure mode: no
opinion rather than a wrong one.

**Show the data, not only the header name.** The columns screen already renders sample rows verbatim,
and the design brief calls them the feature rather than decoration. Rendering the first values beside
each proposed choice lets a human tell `412.5123` from `$54.12` instantly, which no string algorithm
will.

## 7. Where instrument and name are one column

Directly relevant to `UX-6`, which argues the mapping screen should let one column fill both roles.

| Provider | Header | Situation |
|---|---|---|
| Vanguard legacy mutual-fund platform | `Fund Name` | **No symbol column exists in the file** [EXPORT] |
| TIAA | `Your Investments` | The ticker is inside the string — `… Institutional Plus (VIIIX)`. One more reason a blanket parenthetical strip is destructive [EXPORT] |
| thinkorswim | `Instrument` | One combined column for ticker and option description [IMPORTER] |
| DEGIRO | `Product` | The ISIN column is blank on cash and fund rows [IMPORTER + FIXTURE] |
| Ameriprise | `Description` | `Symbol` is empty for alternative investments [EXPORT] |

The design consequence is sharper than "allow it": **the fallback must be per row, not per file.**
DEGIRO and Ameriprise both have an identifier column populated for most rows and blank for some, so a
file-level "this export has no ticker" decision is wrong for exactly the rows that need it.

Collective investment trusts genuinely have no ticker — they are not SEC-registered funds — so the
blank-identifier row is a domain fact rather than an artefact of any one provider's export.

## 8. Most position exports carry no as-of column at all

Worth stating on its own, because it changes how `UX-10` should be read. Fidelity, Schwab, TIAA and
Ameriprise all put the statement date in a **preamble line** rather than a column; Fidelity also puts
it in the filename. Merrill has a column but calls it `COB Date`. Of the corpus, only Merrill,
JPMorgan, Ameriprise and IBKR expose a date a mapping could point at.

So "this file does not date itself" is the **normal** case, not the exceptional one, and a review
screen defaulting to today is defaulting wrongly most of the time. Whatever is done about it, it
should be designed for the common path.

## 9. Explicitly unverified — do not encode

- **Fidelity NetBenefits**, **Principal** and **Empower** workplace-plan headers. No export and no
  importer was found for any of them. This repository's `401k.csv` is a plausible *model* of that
  shape and must not be treated as an observed format.
- **Robinhood**, **Betterment** and **Wealthfront** have no native positions CSV at all. Robinhood's
  familiar `symbol` / `average_buy_price` names are REST API fields; adding them as CSV aliases would
  be inventing a format.
- **Merrill Edge cost basis** — the real export has none; its tax-lot report is a separate download
  whose headers were not verified.
- **Liability header aliases** beyond this repo's own `Principal Balance`.
- A reported **Fidelity re-casing** of headers to sentence case, and a `Symbol/CUSIP` variant — each
  single-source. Harmless either way, since case folding is safe normalisation.

## 10. The recommendation, in one line

Curated alias table → normalised exact match → per-role preference when one file offers two valid
candidates → arithmetic cross-check → propose with the sample values beside it → **leave unmatched
columns unmapped**. A missing proposal costs one dropdown click. A wrong proposal that survives review
costs a number that is wrong by the position size and looks entirely plausible.
