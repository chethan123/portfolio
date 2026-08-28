# Portfolio Tracker — Design

A self-hosted family portfolio and net worth tracker. Browser-first with an installable PWA for
mobile. Positions are imported from brokerage CSV statements, priced against live market data, and
surfaced through a small set of dashboards.

This document records the design decisions and the reasoning behind them. Where a decision was
close, the rejected alternative is noted so it can be revisited deliberately rather than rediscovered.

---

## 1. Scope

**In:** brokerage / 401k / IRA accounts holding securities, bank accounts, a personal loan,
CSV statement import, live pricing, net worth history, three dashboards, single-instance
self-hosting.

**Out (deliberately):** transaction ledgers, realized gains, dividend payment history, tax lots,
real estate, vehicles, crypto price feeds, mortgages, multi-currency, multi-user authentication.

---

## 2. The valuation rule

One rule, applied without exception:

```
value = quantity × price      summed over every holding in the system
```

Everything on the balance sheet is a position, including cash and debt:

| Thing | Instrument | Quantity | Price | Value |
|---|---|---|---|---|
| 100 shares of VTI | `VTI` | `100` | `250.00` | `25,000` |
| Brokerage sweep cash | `USD` | `3,000` | `1.00` | `3,000` |
| Checking account | `USD` | `12,500` | `1.00` | `12,500` |
| Personal loan | `USD` | `−8,000` | `1.00` | `−8,000` |

**The sign lives in quantity, never in price.** A price is a positive market fact. Negative
quantity is the standard encoding for a liability position (it is how short positions work), and it
keeps the price column meaningful for every consumer — the refresh job, price history, sorting,
per-share display.

Consequences: net worth is a single `SUM` with no branches, and a liability account is simply an
account whose positions sum negative. There is no `is_liability` special case in any calculation.

Brokerage CSVs already export cash as its own row (`SPAXX`, `Cash & Cash Investments`), so this
model ingests real statements without a special case.

---

## 3. Source of truth: positions, not transactions

Statements are photographs of what is held. The app stores those photographs.

**What this gives you:** current value, cost basis as reported, unrealized gain, allocation,
net worth over time, projected dividend income.

**What it can never give you:** realized gains, dividend payment history, tax lots, time- or
money-weighted return.

**No cash-flow tracking.** Deposits and withdrawals are not recorded. The history chart therefore
cannot separate market movement from contributions — a $10k deposit and a 40% rally look identical.
The chart is labelled **"Total value"**, never "return" or "performance", so it never implies
something it cannot support.

> **Accepted limitation.** "What did I collect in dividends last year" is a schema change, not a
> query. If that question becomes important, it means adding a transaction ledger, which is a
> substantially different ingest problem.

---

## 4. Domain model

### 4.1 Schema

```sql
person (
  id, name
)

account (
  id,
  name,                    -- "Fidelity Taxable", "Empower 401k — Roth"
  institution,
  kind,                    -- brokerage | 401k | ira | bank | liability
  owner_id      → person,  -- single owner; see 4.2
  tax_treatment,           -- taxable | tax_deferred | tax_free
  external_account_number, -- optional, captured from CSV; guards a commit against the wrong account
  closed_at                -- nullable; closing preserves history
)

classification (
  id,
  name,                    -- user-defined: "S&P500", "Total stock market", "International", …
  asset_class              -- equity | bond | cash | other
)

instrument (
  id,                      -- surrogate; see 4.3
  symbol,                  -- nullable, mutable
  name,
  quote_type,              -- from provider: EQUITY | ETF | MUTUALFUND | …
  price_source,            -- feed | fixed | manual
  classification_id → classification
)

instrument_alias (
  raw_string PRIMARY KEY,  -- every string ever seen in a CSV
  instrument_id → instrument
)

position_set (
  id,
  account_id → account,
  as_of_date,              -- from the statement, or chosen at upload
  source,                  -- upload | manual
  source_filename,
  raw_file bytea,          -- NULLABLE; the original CSV, retained for re-parsing (§5.2)
  created_at
)

holding (
  id,
  position_set_id → position_set,
  instrument_id   → instrument,
  quantity              numeric(20,8),
  cost_basis_per_share  numeric(20,4)   -- NULLABLE; 401k statements often omit it
)

price_daily (
  instrument_id → instrument,
  date,
  close numeric(20,4),
  PRIMARY KEY (instrument_id, date)
)

quote (
  instrument_id PRIMARY KEY → instrument,
  price                       numeric(20,4),
  yield_pct                   numeric(10,6),
  annual_dividend_per_share   numeric(20,4),
  as_of,
  is_stale boolean
)

manual_networth (
  date PRIMARY KEY,
  amount numeric(20,4)
)

column_mapping (
  id,
  institution,
  header_fingerprint,      -- hash of the CSV header row
  mapping jsonb
)
```

**Money and quantity are `numeric`, never floating point.** `numeric(20,8)` for quantity to handle
fractional shares, `numeric(20,4)` for prices and money. The Postgres driver must be configured to
return numerics **as strings**, not JS numbers — the default coercion silently rounds, and
cent-level drift on a six-figure balance shows up as two dashboards disagreeing about net worth.
Arithmetic belongs in SQL where possible; anything computed in JS uses a decimal library.

### 4.2 Ownership

Ownership attaches to the **account**, as a single `owner_id`. Every position inside Alice's Roth
IRA is Alice's; repeating the owner on each holding row would be the same fact denormalised many
times over, free to drift.

Joint accounts are **not supported**. A plan holding both Traditional and Roth money is modelled as
two accounts.

> **Accepted debt.** Adding joint ownership later means a `account_owner(account_id, person_id, pct)`
> join table with percentages summing to 100, plus reworking every person-grouped query to weight by
> `pct`. Contained, but not free.

### 4.3 Instrument identity

Instruments have a **surrogate ID**. The ticker is a mutable, nullable attribute — not the key.

Three reasons:

1. **Tickers change.** Facebook became Meta and `FB` became `META`. With symbol as the primary key,
   that day the app decides you sold your entire position and bought an unrelated new one — position
   history splits, price history splits, permanently. With a surrogate ID it is a one-column update.
2. **Some instruments have no ticker.** Employer 401k plans commonly hold collective investment
   trusts ("Vanguard Target Retirement 2045 Trust II") which have no public symbol and no quote on
   any retail API. These carry `symbol = NULL` and `price_source = manual`.
3. **The alias table is the CSV symbol resolver.** Brokerages disagree on naming — `VTI`,
   `VANGUARD TOTAL STOCK MARKET ETF`, or a bare CUSIP. Rather than normalisation heuristics, the
   importer looks up the raw string; a miss prompts you once and is remembered permanently.

Aliases are **global, not per-brokerage**. Fidelity's `CASH` and Schwab's `Cash & Cash Investments`
are two alias rows pointing at the same `USD` instrument. Genuine collisions across brokerages
essentially do not occur for securities; a scope column can be added if one ever does.

**Internal IDs never appear in any file a human or a brokerage touches.** Symbols and descriptions
are the interchange format. If the app ever emits a CSV template — for a PDF-only 401k — that
template uses symbols too.

### 4.4 Classification

A user-editable table, not a code enum, because the category list will grow. Attaches to the
**instrument** — VTI is "Total stock market" everywhere it is held.

Each classification rolls up to an `asset_class` (`equity | bond | cash | other`) so the app can
answer both "how much in S&P500 funds" and "what is my overall stock/bond split". The user's labels
mix axes — instrument kind, index tracked, geography, asset class — which is fine for labelling but
does not aggregate on its own; the rollup column supplies that.

A target-date fund maps to `other`, which honestly reports "cannot be split" rather than silently
landing in equity or bonds.

`quote_type` arrives free from the price provider on a separate axis and will overlap slightly with
user labels. Harmless; the user's label is what displays.

**One screen is the exception, and it is bounded.** The unrealized gains panel (§8.1) splits its
rows on `quote_type` rather than on a classification, because "individual stocks versus funds" is a fact
about the instrument and the user's labels mix axes — a label list that aggregates by index tracked
cannot answer it. So the provider's vocabulary does reach the screen, in exactly one place, matched
against an explicit list of three values. The column is written from the provider's answer at the
moment an instrument is created — the resolution step already probes the symbol, and that probe
now carries the type back rather than discarding it — and refreshed on every poll, which is what
makes it true of instruments created before it was written at all. The consequence is worth stating
plainly: an instrument nobody quotes — a workplace-plan trust priced by hand, with no `quote_type`
at all — lands in that panel's catch-all row rather than under stocks or funds. The mitigation is that the catch-all is a
row on the table with its own figures and not a discard, so the holding is visible, it is counted,
and the panel's total still reconciles with the portfolio behind it.

### 4.5 Tax treatment

Three-way, not boolean:

| Regime | Accounts | Tax on withdrawal |
|---|---|---|
| `taxable` | brokerage, bank | dividends annually, capital gains on sale |
| `tax_deferred` | Traditional 401k / IRA | ordinary income on the full amount |
| `tax_free` | Roth 401k / IRA, HSA | none |

An enum costs exactly what a boolean costs, and the boolean would throw away the largest distinction
on the balance sheet: $500k in a Traditional IRA is roughly $350k of spending power, while $500k in
a Roth is $500k. A "sheltered vs taxable" view built on a boolean hides precisely that.

**The unrealized gains panel (§8.1) is the first screen that acts on the distinction rather than
displaying it.** Only a `taxable` holding contributes to its tax column: a gain in a Roth is never
taxed, and a gain in a Traditional 401k is taxed as ordinary income on withdrawal, which is a
different rate on a different amount at a different time and not something a capital gains rate can
stand in for. Both still show their gain in the column beside it, because the gain is real wherever
it sits — what the treatment decides is only whether a tax figure is owed against it, and the panel
says so on the page rather than leaving a reader to infer it from a blank cell.

This is also the data that makes after-tax net worth modelling possible later.

---

## 5. Ingest

### 5.1 Flow

```
pick account from dropdown
  → drop CSV
  → column mapping        (saved per institution, matched by header fingerprint)
  → unresolved instruments prompt   (first sighting only)
  → diff preview          "3 updated · 1 added · 1 removed (AAPL, 50 sh, $8,500)"
  → commit → new position_set
```

Accounts are **first-class** and created once. The alternative — deriving account identity from
`(institution, owner, type)` tags supplied at upload — collides silently the moment you own a
Traditional *and* a Roth IRA at the same firm, merging two portfolios with no error. It is also more
typing on every upload, forever.

**An in-progress upload is a row, not client state.** The flow above runs over an `upload_draft`
table — the file's bytes, the chosen account and the half-finished mapping — so every step is a URL
that survives a reload, the back button and a closed laptop. It is one of two tables §4.1's list
does not carry (the other is `app_setting`, §10.1), deliberately: it stages what is *becoming* a
statement and holds nothing any other
screen reads, and the row is deleted the moment its statement lands (or swept after a day).

### 5.2 Uploads append, never mutate

Each upload creates an immutable, as-of-dated `position_set`. Current holdings are the latest set
for that account. Nothing is destroyed.

- **Free undo.** A wrong or partial file is fixed by deleting the version; the prior one is intact.
- **Quantity history for free.** "When did I first hold MSFT" is answerable with no extra machinery.
- **History is a query, not a job.** Because positions are constant between uploads by construction,
  net worth on any past date is `positions as-of that date × price on that date`.
- **Re-parseable.** The original CSV is retained in `position_set.raw_file`, so a mis-mapped column
  is fixed by correcting the mapping and re-parsing — not by re-downloading a statement the
  brokerage may no longer offer. Without this, a bad *upload* is recoverable but a bad *mapping* is
  not, which is an odd place to draw the line.

  Re-parsing follows the same immutability rule as everything else: it **creates a new position set**
  from the retained bytes, and the incorrect one is deleted. It never rewrites a set in place.
  `raw_file` is nullable — manual balance edits have no file — and files are kept indefinitely,
  since a decade of brokerage CSVs is single-digit megabytes.

**A missing row means sold.** A brokerage position export is complete for the account by definition;
if AAPL is not on the new statement, the position is gone. The diff preview is the safety valve
against the failure mode this creates — a filtered export showing 2 of 30 positions would otherwise
silently delete real holdings.

**As-of date** comes from the statement if the CSV carries one, otherwise chosen at upload with
today as default. Never the upload timestamp: a statement uploaded three days late describes the
statement date.

**Single-position accounts skip CSV entirely.** Checking and loan balances use a "set balance" form
writing one `USD` row — the same append-a-position-set mechanism, no separate code path.

### 5.3 Column mapping

A generic mapper with saved mappings, not hardcoded per-brokerage parsers. The first upload from an
institution maps its columns in a UI; the header row is fingerprinted and the mapping auto-applies
thereafter. A new institution costs zero code.

The parser must tolerate the reality of brokerage exports: preamble rows, footer disclaimers, `$`
prefixes, parenthesised negatives, `n/a` strings, thousands separators.

A PDF-only 401k needs no new subsystem — hand-author a CSV in the app's template, which is just
another saved mapping.

---

### 5.4 Correcting one position

A statement arrives quarterly and a position changes weekly. §5.1's flow is four screens, which is
right for a statement and far too much ceremony for "the 401k contribution added eleven units". So
the Holdings table carries one small write: **open one row, restate its quantity and its cost basis,
save.**

It is `setBalance` for accounts that hold more than one thing, and it obeys the same rules rather
than being an exception to them.

**It appends; it never edits.** `holding_valued_at` reads position sets for every date the net worth
chart plots, so an `UPDATE holding SET quantity` would not correct a number — it would silently
restate every figure back to the date of the statement the row landed in. March's net worth would
move because an August typo was fixed, with nothing on any screen saying so. A correction is
therefore a *new* position set dated today, and the one it corrects stays where it is, still
speaking for its own dates. Undo is a second correction, resolved by the same tie-break a
re-uploaded statement is (`created_at`, then `id`).

**It carries the whole account forward.** §5.2's "a missing row means sold" makes a position set a
photograph of everything an account holds, so a set containing only the corrected row would record
every other security in the account as sold. The new set is the old set with one row changed and the
rest copied across verbatim. That copy asserts nothing new: §14.7 already records that this
application reads holdings as frozen between statements, and carrying them forward *is* that
reading.

**It changes numbers, never membership.** Adding an instrument means resolving a name nobody has
seen before against the alias table (§4.3), which is the upload flow's job. A correction can say
"not 100 units but 120", and can say "zero", and cannot say "and also some Apple". A quantity of
zero is stored as zero rather than dropping the row: a dropped row is unreachable from a table that
no longer prints it, so the position would be uneditable by the very screen that removed it.

**The sign may not be flipped.** §2 puts the sign in the quantity, so a correction that turns
something held into something owed moves household net worth by twice the figure while reading as an
ordinary edit. `setBalance` avoids this by refusing to accept a sign at all; this box has to show
one, because it opens containing the figure the table prints — so it refuses the *change* instead.
Recording zero first and the other direction second is the deliberate two-step, and it is the only
way an overdrawn bank account can be entered today (§14.8 is unchanged: the set-balance form still
cannot).

**A figure the view could not value is refused.** `holding_valued` casts
`quantity × price` and `quantity × cost_basis_per_share` to `numeric(20, 4)`, and both operands can
sit well inside their own columns while their product does not — a twelve-digit quantity is legal,
and so is a share priced in the hundreds of thousands. A product that will not round to under 10^16
does not fail the write; it *succeeds*, and then makes the view raise on every subsequent request,
taking Holdings and Analysis down together. Since Holdings is the only screen the editor is reachable
from, the row that broke it could not then be corrected from the application at all. Bounding the
fields cannot prevent this, so the products are checked at the moment of the write, with both
operands in hand.

**There is no date field.** A correction is about now. A past date is a statement, and a statement is
the upload flow's job. The set is dated `greatest(today, the corrected set's date)`, because
`recordedDate` allows a statement to be dated tomorrow for a household east of UTC and a correction
filed behind the sheet it corrects is a write that appears to succeed and changes no figure
anywhere.

**No schema change, and no new identity.** A holding has no id worth putting in a URL — the `holding`
row carrying a position changes on every upload — so a row is addressed by `(account, instrument)`,
which `holding_one_row_per_instrument` makes unique inside the one position set `holding_valued`
returns per account. The server re-resolves that pair through `latest_position_set` at the moment of
the write, so it always names what the account holds *now* rather than what it held when the page
rendered. If the current statement no longer carries the instrument, the write is refused and
nothing at all is written.

**It is a URL, not client state.** The editor opens at `?edit=<account>.<instrument>` and confirms at
`?saved=<account>.<instrument>`; neither is part of the canonical Holdings query, so every filter,
grouping and sort control closes the editor for free. §8.1's screen has no React state and this does
not introduce any — it works with JavaScript off, survives a reload, and is the same grammar the
rest of the screen is built from.

> **Accepted limitation.** A correction cannot fix the *past*. Restating a figure on a date that
> already has a statement means deleting that position set and re-recording it, which is §5.2's undo
> and has no interface yet.

---

## 6. Pricing

### 6.1 Provider

**`yahoo-finance2`**, behind a `PriceProvider` interface:

```ts
interface PriceProvider {
  getQuotes(symbols: string[]): Promise<Quote[]>   // price, currency, yield, annual dividend
}
```

Chosen after comparing alternatives against the requirement that actually discriminates them —
**mutual fund NAV coverage**, since 401k and IRA accounts are overwhelmingly mutual funds:

| Provider | Mutual fund NAV | Batching | Cost at ~100 instruments |
|---|---|---|---|
| **yahoo-finance2** | Yes — `MUTUALFUND` quote type with dividend fields | Real: one HTTP call for all symbols | $0 |
| Twelve Data | **Pro tier only** | Bills per symbol, not per request | Free tier exhausted before noon |
| FMP | Yes | Partial; some batch endpoints gated | ~$20+/month |
| Alpha Vantage | Partial | No | 25 requests/day free; unusable |

`yahoo-finance2` is MIT-licensed and actively maintained but is an **unofficial** client for an
endpoint Yahoo never published. There is no SLA and it can break.

Three things make that risk tolerable: `price_daily` is our own table, so an outage costs a gap in a
chart rather than data; a manual price path already exists for CITs, so the app degrades gracefully
when a symbol cannot be quoted; and the interface makes swapping to FMP a day's work.

**Currency guard.** Every quote reports a currency. Anything other than USD is **refused at
instrument resolution** with a clear message. No currency column is stored — the guard exists so a
foreign-listed instrument cannot silently sum GBP into a USD total.

### 6.2 Freshness and storage

Background polling on the **household's refresh cadence during market hours** — a whole number of
minutes set at Settings → Prices, seeded to 15 (§8.4) — plus a manual "Refresh now" button, which
belongs to the pricing UI that is specified and not built yet.
Pages read the database and never fan out to the API on render.

Streaming was rejected on the grounds that mutual funds have no intraday price at all — they strike
one NAV after the close — so a live tick pipeline would leave a large share of the balance sheet
frozen anyway.

Three tiers, deliberately separate:

```
price_observation  (instrument_id, as_of, market_date, price, fetched_at, payload)  -- append-only log
quote              (instrument_id, price, yield, annual_dividend, as_of, is_stale)  -- overwritten
price_daily        (instrument_id, date, close)                                     -- immutable spine
```

An observation is not history and a quote is not a fact: history is finished days, an observation is
a moment we were told about, and the quote is today's best answer. A refresh writes all three in one
transaction, so no two of them can disagree about one fetch.

The observation log arrived with the 1D chart range ([ADR-0006](docs/adr/0006-intraday-quotes-are-an-observation-log.md)),
and it is the one tier kept for a reason other than a screen: every distinct price the feed reports
is retained forever, with the provider's raw entry archived beside it, because the owner values
keeping rich data whose future use is unknown over the disk it costs. `price` is the only column in
it anything may compute from. A sibling `price_poll` records each refresh attempt, so a silence in
the log can be told apart from a server that was not running. The storage that buys — roughly half a
gigabyte a year at a hundred instruments and the seeded fifteen-minute cadence — is stated at
Settings → Prices, where the dial is.

An intraday refresh can never corrupt history, and a missed day is a visible gap rather than a wrong
close. `holding_valued_at` reads `price_daily` alone, so an observation can never move a line that
has already been drawn.

**Failure handling:** a failed fetch keeps the last known price and marks the instrument stale,
surfaced in the UI. Never zero, never null into a sum.

**Non-trading days** get no `price_daily` row. History queries carry forward the last close, so
Saturday's net worth equals Friday's.

**Manual-priced instruments** are to be edited in a form which writes a `price_daily` row, the
value carrying forward until changed. The form belongs to the unbuilt Settings → Instruments tab
(§8.4), so today a `manual` instrument stays unpriced until that lands.

---

## 7. History

**History starts at day zero.** The first upload creates the first position set; there is no
position backfill.

**A manual net worth series prefixes the chart.** Hand-typed `(date, amount)` points cover the
period before the app existed. The series is read and drawn today; the Settings → History screen
that would type the points in is not built yet (§8.4).

Three rules govern how the two series coexist, so the chart never overstates what it knows:

1. Manual points render as a **visually distinct dashed/lighter series** — never blended into the
   computed line, which would imply a real daily curve where there is a hand-typed annual dot.
2. **Computed always wins** on overlapping dates. Manual points only fill gaps.
3. **Only the total chart reaches back.** Views grouped by person, account, or tax status start at
   day zero, since the manual series has no structure to slice. The UI says so rather than showing a
   suspiciously short line.

---

## 8. Screens and queries

### 8.1 Dashboards

The four daily-use pages — read-only but for the one inline write Holdings carries (§5.4). The
management screens that create the data they read are in §8.4.

| Page | Contents |
|---|---|
| **Overview** | Net worth headline · trend line (dashed manual prefix, solid computed) · the accounts rollup · allocation by account, drawn as bars (the asset-class cut lives on Analysis) |
| **Holdings** | The workhorse. Full column set on desktop, cards on mobile. Filter by person / account / tax treatment / classification; group by any of them, with subtotals |
| **Analysis** | Net worth cut three ways — by person, by account kind, by asset class — each a donut beside the table it is drawn from. Beneath them, unrealized gain by asset type with the tax a taxable one would attract (§4.5) |
| **Income** | Projected annual dividend and weighted yield, grouped by account and tax treatment. The one view where the loan's negative yield does something interesting |

A groupable, filterable Holdings table absorbs what would otherwise be four more pages — by person,
by account, tax view, unrealized. Those are the same table with the grouping changed, not separate
features.

**Deliberately not in v1:** per-account drill-down (the filtered Holdings table already is one) and a
dedicated tax page (a group-by plus a chart on Overview). The drill-down exclusion was later
reversed — §13.1 makes the argument, and `/accounts/:id` is built; the tax one is half reversed,
below.

**The tax exclusion is half reversed: there is still no tax page, but there is a tax-aware panel.**
The argument above was that a tax view is a grouping and a chart over columns the other screens
already carry. That holds for *sliced by tax treatment*, which Holdings does with a group-by, and it
does not hold for *what settling a gain would cost* — no grouping of the data on screen produces a
tax figure, because the rate is not in the data and had nowhere to be typed. So Analysis gained a
fourth panel over the array it already loads, and Settings gained the one number it needs (§8.4).
It stayed a panel rather than becoming a page for the reason the original sentence gives: one table
does not earn a tab, and nothing here is a filing. What it produces is an estimate and is labelled
one — the tax is computed per row and totalled from the rows, so a loss in one asset type is not
netted against a gain in another the way a real return would net it, which makes the figure an
upper bound. The panel says that on the page.

**Mobile shape matters.** The full column set is a desktop grid; nine columns on a phone is a
horizontal scroll nobody uses. Mobile gets a card list with a few fields visible and tap-to-expand.

**The four filter dimensions above are seven as built.** This section predates §8.3, whose `View`
type names eight — person, account, institution, kind, tax treatment, classification, asset class,
instrument — and `holding_valued` (§8.2) already exposes all eight, so filtering on the extra four
costs no join and no new query. Nothing here argued against them; they simply had not been written
down yet when this list was. What the screen does *not* offer is `instrument`: a filter over the
very thing each row is is a search box wearing a dropdown, and that is a different control with a
different case to make. §13.7's refusal of search over a dozen accounts stands, and is honoured as
a rule rather than a one-off — a dimension becomes a control only once the data holds two distinct
values for it, so a filter that could only mean "everything" is never drawn.

**Tap-to-expand is not built.** The mobile card list is, by restyling the one table rather than
rendering a second tree, and every field is visible on the card. Collapsing one needs either client
state, of which this application has none, or a `<details>`, which cannot wrap a `<tr>`. Recorded
as owed rather than quietly dropped.

### 8.2 Query layer

Each dashboard writes its **own SQL** against the normalised tables. There is **no materialised fact
table and no daily rollup job**.

The shared join is factored into a plain (non-materialised) SQL view so the screens that read it
cannot drift on how they resolve "current holdings":

```sql
CREATE VIEW holding_valued AS
  -- latest position_set per account
  --   → holding → instrument → classification
  --   → account → person
  --   → quote
  -- exposing: quantity, price, value, cost_basis, unrealized,
  --           annual_dividend,
  --           owner, account, institution, kind, tax_treatment,
  --           classification, asset_class
```

Time-series queries need positions as-of an arbitrary date, which a plain view cannot parameterise.
That is a set-returning function:

```sql
holding_valued_at(d date)
  -- per account: the position_set with max(as_of_date) <= d
  --   joined to price_daily on d, carrying forward the last close
  --   annual_dividend is null: there is no historical dividend to report
```

**The `setof holding_valued` return type is a two-way contract, and PostgreSQL does not enforce it
when you break it.** `create or replace view` accepts an appended column and reports success while
leaving the function returning too few columns, which fails only when something calls it. A column
added here is a column added to both, in one migration. See
[ADR-0001](docs/adr/0001-holding-valued-row-type-contract.md).

**Cost basis is nullable**, so any group's unrealized figure may be partial. The rule is **sum what
is known and label the coverage** — "unrealized $47k, based on 8 of 12 holdings". Never coerce null
to zero, which would report a fake gain equal to the entire untracked position.

> **Weakest point in the design.** Hand-rolled queries can disagree on edge cases — null cost
> basis, stale prices, an account whose first position set starts mid-chart. You will not get an
> error; you will get two pages showing different totals. `holding_valued` is the mitigation and the
> first place to look.

### 8.3 Future: saved view builder

Recorded because it was explicitly deferred rather than rejected. The five dashboards originally
described are not five features — they are one query shape with different arguments:

| Requirement | Group by | Measure | Time |
|---|---|---|---|
| holdings by user | person | value | now |
| unrealized gains | — | unrealized | now |
| taxable vs sheltered | tax treatment | value | now |
| net worth over time | — | value | daily |
| …by person over time | person | value | daily |

Config shape:

```ts
type View = {
  dimensions: Dimension[]   // person | account | institution | kind
                            // | tax_treatment | classification | asset_class | instrument
  measures:   Measure[]     // value | cost_basis | unrealized | unrealized_pct
                            // | annual_dividend | yield_pct | pct_of_total | count
  filters:    Filter[]
  timeAxis:   'none' | 'daily' | 'monthly'
  chart:      'table' | 'bar' | 'pie' | 'line' | 'area'
}
```

No time axis renders as table/bar/pie; a time axis renders as line/stacked-area. Same object, two
rendering modes.

**The Holdings table is ~70% of this already.** Persisting its filter and group state and adding a
measure picker is most of the remaining work. Revisiting the no-materialisation decision (§8.2) is
worth doing at the same time, since arbitrary user-composed groupings stress it far more than three
fixed queries do.

A read-only SQL console is a reasonable later escape hatch for anything the builder cannot express —
but not before it, since the builder handles every case above as a form.

### 8.4 Management surface

**Navigation is ordered by frequency of use**, not by entity count:

```
Overview   Holdings   Analysis   Income   Upload                   ⚙ Settings
└────────────── daily ─────────────┘   └─ weekly ─┘           └─ a few times ever ─┘
```

Upload is a primary workflow rather than configuration, so it stays top-level despite being a
mutation. Everything else that writes lives behind Settings.

**Settings tabs:**

| Tab | Purpose |
|---|---|
| Accounts | Create, edit, close. Owner, kind, institution, tax treatment. Closing preserves history (`closed_at`) |
| People | Create, edit |
| Classifications | Create, rename, assign `asset_class` |
| Instruments | Edit symbol, price source, classification. View aliases. **Set manual prices for CITs** |
| History | Hand-typed net worth points for the pre-day-zero series (§7) |
| Tax | The household's capital gains rate, which the Analysis panel (§8.1) estimates with |
| Prices | The refresh cadence — how often the poller (§6.2) asks the feed for quotes while the market is open |
| Display | How the screens look before anyone touches them: the masking policy (spec 0007), and the theme choice when §12's toggle lands |

Classifications, Instruments and History are not built yet: the strip today is People, Accounts,
Tax, Prices and Display, and the Settings index names the other three as what later slices build.

**Tax is the first tab that is a preference rather than a set of domain rows.** Every other tab
creates or edits something the portfolio is made of; this one holds a single number that describes
the household rather than its holdings. It is not an environment variable, which is where every
other non-domain setting lives (§10.1), because the environment configures the *deployment* — where
the database is, which timezone a close is stamped in — and a bracket is not a deployment fact. It
is the household's own figure, it moves when their income or their state does, and the person who
wants it changed is the one reading the number it produced rather than the one with a shell on the
container. Behind a redeploy it would be stale in exactly the case the panel was built for.

**Prices holds the refresh cadence, and it is the tab that moved a setting out of the
environment.** The cadence began life as `PRICE_POLL_INTERVAL_MINUTES`, filed on the deployment side
on the argument that request spend against an unofficial feed is the operator's business. In a
self-hosted household the operator and the person watching the prices are the same person minus a
shell, so the argument collapsed into Tax's: the person who wants the dial moved is the person
reading the screen it drives. The variable was removed outright rather than kept as a fallback —
two places to set a figure is two places to read a different answer from — and the poller reads the
row before each tick, so a save takes effect by the next refresh with no restart in any process
(`0008_refresh_cadence.sql`).

**Display is the second preference tab, and it holds a policy rather than a value.** The masking
policy is the household's standing answer to what a browser nobody has toggled yet opens in — masked,
unmasked, or as that browser last left it. It sits beside the capital gains rate for the same reason
that one is a row: it describes the household rather than the deployment. What it does *not* hold is
the masking control itself. Whether a given browser is masked right now is a fact about that browser
and lives in a cookie that browser owns, because a phone in a queue and a desktop in a locked room
want opposite answers; and the control that flips it sits in the chrome on every screen, not here.
That placement is load-bearing rather than convenient: the policy is seeded to *masked*, so a first
run is a page of dots, and dots whose only cure is three clicks into a configuration area is an app
that looks broken. `docs/adr/0002-masking-is-a-display-state.md` records the split and the
deliberately weak guarantee under it — masking defends against being read over the shoulder, and the
gate in front of the instance (§10) remains the only thing that keeps anyone out.

**The Instruments tab will carry real weight**, which is why it isn't planned as just inline
editing on a table row. It will be the only place that answers "which manual-priced instruments
have gone stale?" — a
question you must revisit on a schedule, since CIT prices don't update themselves. It's also where a
ticker change (§4.3) gets applied and where a bad alias gets repointed. Buried as row affordances,
those are undiscoverable exactly when needed.

**Manual balance editing is the exception and does not live in Settings.** It's the one write
allowed on mobile (§11), so it's reachable from the account row on Holdings — not three levels deep
behind a desktop-shaped configuration area.

**Correcting one position is the same exception, generalised** (§5.4). A row on Holdings opens in
place, restates its quantity and cost basis, and closes. It stays on Holdings for the reason the
balance form does: it is the write a household actually makes between statements, and a write made
weekly does not belong behind a tab visited a few times ever. It does not replace the upload flow and
cannot — it changes figures on positions that already exist, never which positions an account holds.

**The upload flow (§5.1) is four screens**, not one: file drop → column mapping → unresolved
instruments → diff preview. Only the first is trivial.

**First run** shows empty dashboards. A single prompt points at Settings → People, then Accounts,
since nothing else can be created until at least one of each exists.

---

## 9. Stack

| Layer | Choice | Reasoning |
|---|---|---|
| Runtime | **Node 24 LTS** | Bun is production-viable and faster, but Node is the fewer-surprises target for software other people deploy, and `Bun.SQL` would lock the data layer to the runtime. Throughput is not a constraint here — one family, ~100 symbols every 15 minutes. Native TypeScript type stripping is stable as of v24.12.0, which lets **standalone scripts** (migration runner, seeds, one-off CLI tasks) run as `.ts` directly. It does *not* remove the app's build step: React Router builds both client and server bundles through Vite. Types are stripped, never checked — `tsc --noEmit` stays in CI. |
| Framework | **React Router 7** | Full-stack, SSR + client routing, Vite-based, good self-host story. Single codebase, single container, shared types. Chosen over SvelteKit purely on existing familiarity, which outweighs any technical edge for a solo-maintained project. Next.js rejected as the fiddliest to self-host. |
| PWA | **`vite-plugin-pwa`** | Manifest, service worker, precaching. Not adopted yet — the PWA slice (§11) is unbuilt and the dependency is not installed |
| Database | **Postgres** | |
| Access | **Kysely** | Typed SQL builder, not an ORM. `kysely-codegen` derives types from the live database **including views**, so `holding_valued` is typed like a table. Drizzle was the runner-up — better migration ergonomics, but it wants the schema to live in TypeScript, and this design puts a SQL view at the centre, which is exactly where TS-schema-first tools force you to maintain a definition twice. |
| Migrations | **Plain `.sql` files** | The database is the source of truth. Run on container start, before serving. |

Note: `Express` is a library on top of Node, not an alternative to it — and the framework owns
routing here, so it is not needed.

---

## 10. Deployment and operations

| Area | Decision |
|---|---|
| **Packaging** | Docker Compose: Caddy + the sign-in gate + app + Postgres. All configuration via environment variables, with one exception — who may enter is a file (§10.1). |
| **Distribution** | The app image is built once by CI and **pulled**, not built on the host. A `v*` tag publishes a multi-architecture image to GitHub Container Registry; the Compose file pins the floating major and pulls on every `up` (§10.1). |
| **Ingress** | The bundled Caddy container is the only service that publishes a port. The app, the database and the gate are reachable only on the compose network, so neither the app's forwarded-header trust nor the gate's verdict is ever extended to whoever can reach the host. |
| **TLS** | **The operator's, in front of this stack.** Everything inside the stack speaks plain HTTP and the app never manages certificates; the public hostname and its certificate belong to the house-wide proxy this stack sits behind, and `PUBLIC_ORIGIN` (§10.1) is the `https://` origin it serves. |
| **PWA requirement** | Service workers require a **secure context** — HTTPS, with `localhost` the only exception. The house proxy's TLS supplies it at `PUBLIC_ORIGIN`, which removes the blocker the PWA slice (§11) faced; the slice itself is still unbuilt, so nothing is installable yet. Reaching the box by LAN IP over plain HTTP supplies no secure context, and the gate would refuse that request anyway. |
| **Auth** | **Outside the app.** Caddy asks a Google sign-in gate about every request before it reaches the app, and the app authenticates nobody (see below). It keeps one honest fact about its own deployment — whether a gate fronts it — and draws a persistent warning banner when nothing does. |
| **Job scheduler** | In-process, inside the app container. One process to deploy, one place to read logs. Trade-off: a restart mid-session misses a poll until the next tick — acceptable at 15-minute granularity. |
| **Market calendar** | Weekday + `America/New_York` session check plus a small hardcoded NYSE holiday table. A wrongly skipped poll costs nothing; a wrongly attempted one costs one request. |
| **Timezone** | UTC everywhere in the database. `America/New_York` only for market-hours logic. Browser-local for display. |
| **Backups** | Documented `pg_dump` procedure. Not built in — self-hosters have their own, and a half-built backup feature is worse than none. |
| **Tests** | Integration tests against a real Postgres, concentrated on CSV mapping, alias resolution, and the position-set diff. Those are where wrong answers are silent. |

### Authentication is not multi-user

**Authentication happens in front of the app, and the app does none of it.** The gate signs each
family member in with Google and admits only the addresses on the allowlist; a request that reaches
the app has already been admitted, so the app carries no sign-in page, no password and no session of
its own. `docs/adr/0005-auth-is-a-forward-auth-gate.md` records why enforcement sits in this
stack rather than in the operator's proxy, and `docs/operating.md` is where an operator runs it.

**That is per-person at the door and nowhere behind it.** The gate knows which family member is
acting and forwards the verified address on every request; the app reads it nowhere. It is
attribution, never permission (`CONTEXT.md`) — there is no user table, no per-person permissions
and no per-user view. Every family member sees and can do everything, which is the household this
was built for.

**So binding identity to `person` is still a separate design.** `person` is an ownership label
(§4.2), not an account anyone signs in as, and the two are deliberately unjoined: a screen that
filtered by who is looking would need the single-owner-per-account model revisited first, and that
revisit is the design work, not the plumbing. A later feature may record *who* did something. None
may decide *whether* they may.

### 10.1 Container specification

The deliverable is a **single application image plus a Compose file**. `docker compose up` on a
fresh machine with an empty data directory produces a working instance once the gate has its Google
credentials, and refuses to start until it does. That prerequisite replaced an older promise of no
manual steps at all, deliberately: the old promise was kept by booting an instance anyone on the
network could read, and a gate that can be skipped by forgetting to configure it is not a gate.
Compose names the first missing value and stops, so a half-configured instance never runs.

The image is **published, not built on the host**. Pushing a `v*` tag builds it once for
`linux/amd64` and `linux/arm64` and pushes it to GitHub Container Registry; the Compose file pulls
it. This is what removes the Node build — and the memory to run it — from the list of things a NAS
or a small VPS has to be able to do. Two consequences that are load-bearing:

- **The deployment file cannot build.** `compose.yaml` has no `build:` stanza, so an unreachable
  registry or a tag that does not exist fails immediately instead of quietly starting a
  multi-minute build on the deployment host. Building from source is `compose.dev.yaml`, used by
  the smoke test and when working on the container itself.
- **The tag floats.** `APP_VERSION` defaults to the major, so every `v1.x.y` release lands on `1`
  and `docker compose up -d` is the upgrade. Pinning a full version is how an instance is held
  still, and is the "old image" half of the rollback described in `docs/operating.md`.

**The services:**

```
db      postgres:17-alpine
        · named volume for PGDATA
        · healthcheck: pg_isready
        · not published to the host — the app reaches it on the compose network

app     ghcr.io/chethan123/portfolio-app:${APP_VERSION:-1}
        · pulled on every up; no build stanza in the deployment file
        · depends_on: db (condition: service_healthy)
        · not published to the host — caddy reaches it on the compose network
        · restart: unless-stopped
        · healthcheck: GET /healthz

gate    oauth2-proxy, pinned to an exact release
        · the forward-auth sidecar caddy asks about every request
        · stateless — the session is an encrypted cookie in the browser
        · reads the allowlist file, mounted read-only
        · not published to the host, which is what keeps its verdict honest

caddy   caddy:2-alpine
        · depends_on: app and gate (condition: service_healthy)
        · the only service that publishes a port, and therefore the one place
          the gate can be enforced
        · restart: unless-stopped
```

The in-process scheduler (§10) is why there is no separate worker service. A worker container would
mean two images, two deployments, and two places to read logs, to save a missed poll on restart.
`caddy` is a different kind of service — the ingress front door, not application logic — and is the
only container reachable from outside the compose network. `gate` is there because that front door
is where sign-in has to be decided: every path to the app runs through it, including a device on the
LAN dialling this box's published port directly, which is the threat the gate exists for.

**Dockerfile — multi-stage:**

| Stage | Contents |
|---|---|
| `deps` | `npm ci` against `package-lock.json` only, so dependency layers cache independently of source. Runs on `$BUILDPLATFORM` |
| `build` | `react-router build` → client and server bundles. Runs on `$BUILDPLATFORM` |
| `runtime` | `node:24-slim`, production dependencies only, build output, migration `.sql` files. Runs as a **non-root user**. No compiler, no dev dependencies, no source tree |

**Only `runtime` is architecture-specific.** `deps` and `build` are pinned to `$BUILDPLATFORM` and
run natively on the builder; the per-platform stage does nothing but copy and `chmod`. That makes
the `arm64` image nearly free instead of a slow, occasionally faulting emulated Node build. It is
sound only while no production dependency carries a native binary or a platform-specific install
script — which is true today and would break *silently* if it stopped being, so the Dockerfile
names the invariant in place.

**Startup sequence.** The entrypoint runs migrations to completion, then starts the server. Not
concurrently, and not in a separate one-shot service — a single instance means no coordination
problem, and serving requests against a half-migrated schema is the failure this ordering prevents.
Migrations must be idempotent so a restart is always safe.

**Environment surface** — the deployment's whole configuration API, documented in `.env.example`:

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Postgres connection string |
| `AUTH_GATE` | no | `none` | Whether something in front of the app authenticates: `external` or `none`. It guards nothing — it only decides whether the warning banner (§10) is drawn, so that the app neither cries wolf behind the gate nor stays quiet without one. Compose sets `external`, because in that file it is a fact |
| `PORT` | no | `3000` | HTTP listen port |
| `MAX_UPLOAD_MB` | no | `10` | Largest statement upload accepted, in whole MB |
| `MARKET_TIMEZONE` | no | `America/New_York` | Market-hours calculation, and the trading day a quote's close is filed under |
| `TZ` | no | `UTC` | Container clock; the database stores UTC regardless |

**The gate's own settings are not in that table, because the app never reads them.** Its Google
client, its cookie secret and `PUBLIC_ORIGIN` — the `https://` origin the house proxy serves, which
the gate builds its redirect from and which must match the URI registered with Google — are
Compose-level variables consumed by the `gate` service. They are the only settings anywhere with no
default, and a missing one stops `up`. Who may enter is not a variable at all: a file of addresses
beside the Compose file, one per line, because it is a list that grows rather than a value that
changes. `.env.example`'s gate section is the operator-facing recipe for all of it.

**The household's settings are deliberately not in that table.** Environment variables remain the
whole of what an *operator* configures — everything validated at startup, everything that needs a
restart to change. The capital gains rate, the masking policy and the refresh cadence are none of
those, so they live in `app_setting`, a single-row table seeded by its own migrations and edited
under Settings (§8.4). There is no `CAPITAL_GAINS_RATE` variable and there is no longer a
`PRICE_POLL_INTERVAL_MINUTES` one: two places to set a figure is two places to read a different
answer from. (An upgrade that still sets the old variable is ignored without error; the cadence is
re-entered once at Settings → Prices.)

**Volumes.** One named volume for Postgres data. The application container is otherwise
**stateless** — it writes nothing to its own filesystem, so it can be destroyed and recreated
freely, and backups have exactly one target (§10, `pg_dump`). Uploaded CSVs are retained in
Postgres rather than on disk (§5.2) specifically to preserve this property.

**Reverse proxy.** Ingress runs through the bundled `caddy` service, configured by a `Caddyfile` at
the repository root. It is the only container that publishes a port, which is what keeps the app and
the gate off the host's network — everything inside speaks plain HTTP and believes what Caddy puts on
a request, and that is only sound while the set of things that can connect to them is Caddy alone.
It is also what makes the gate airtight, by the same fact: there is no way to the app that does not
pass the front door.

**Two proxies, and the split is deliberate.** This stack's Caddy enforces sign-in and nothing else
touches it. The operator's house-wide proxy in front owns TLS and the public hostname — this is a
household that already runs one for every other self-hosted app, and duplicating certificate
lifecycle inside the stack would buy nothing. It is deliberately *not* trusted with enforcement: a
device on the LAN can dial this box's published port and land on this stack's Caddy directly, and
that device is exactly the threat. The consequence for the app is one hop more of forwarded headers
to survive, which `ARCHITECTURE.md` §2 and §7.6 are the place for. The consequence for the operator
is that `PUBLIC_ORIGIN` must be the `https://` origin their proxy serves — which is also what
supplies the secure context §10 says the unbuilt PWA slice will need.

---

## 11. Mobile and offline

**The phone is for reading, plus one-field writes.**

Every mutation except balance editing and position correction is a desktop-shaped workflow — upload
→ mapping → resolution → diff → commit is four screens with real state, and designing it for a 390px
viewport would compromise the desktop version that will actually be used.

- **Read:** every read page.
- **Write:** manual balance updates (checking, loan) and single-position corrections on Holdings
  (§5.4) — one or two number inputs, and no screen-to-screen state in either. A correction qualifies
  on exactly the test the balance form passes: it is a number typed into a box, and everything that
  makes ingest desktop-shaped — the column mapping, the unresolved instruments, the diff — is absent
  because a correction cannot change which instruments an account holds.
- **Everything else:** still renders on mobile and still works if you are determined; it simply gets
  no mobile-specific layout investment. Not hidden — hiding it means being stuck on a tablet.

**Caching:** stale-while-revalidate on the read pages — cached render first, background refresh,
last-known numbers rather than an error page when the server is unreachable. Owed with the rest of
the PWA slice; no service worker exists yet.

**The "as of" timestamp is non-negotiable.** Silently showing yesterday's net worth as though it were
live is the one genuinely dangerous failure mode in a finance app.

**No offline write queue.** Queuing a balance edit that syncs hours later, into a system that
timestamps position sets, is a correctness problem for a feature used twice a year.

---

## 12. Theming

**Three states, not two: `light`, `dark`, and `system` — with `system` as the default.** A two-state
toggle forces a choice the OS has usually already made, and gets it wrong twice a day for anyone
using scheduled dark mode.

**The preference is stored in a cookie, not `localStorage`.** This is the decision that matters, and
it is forced by SSR. With `localStorage`, the server has no idea which theme to render, so the page
paints light and then corrects itself — the flash-of-wrong-theme — and the usual fix is a blocking
inline script in `<head>`. A cookie is sent with the request, so the server renders `data-theme`
correctly the first time. No flash, no blocking script, nothing to work around.

In `system` mode the cookie holds `system`, the server emits no explicit theme attribute, and
`prefers-color-scheme` decides. A client-side listener follows OS changes live.

**Masking (spec 0007) reaches the same conclusion by the same argument, and the two are now a
pair.** Whether a browser's amounts are hidden is resolved on the server from a cookie for exactly
the reason the theme is: with the state in `localStorage` the page would paint the amounts and then
hide them, which is the one failure that feature cannot have. Two differences are worth naming.
Masking's cookie is not `HttpOnly`, because the toggle's own script writes it — the flip has to work
at the speed of a hand rather than of a network, and it carries a display preference rather than a
credential. And its default lives in a database row rather than in the cookie's absence, because a
household's answer to "what should a new browser open in?" is a household fact, while a theme's is
the OS's. When the theme toggle is built it joins the masking policy on Settings → Display (§8.4),
which is why that tab is named for the screens rather than for either preference.

**Tokens, defined once:**

```css
:root                                          { /* light palette */ }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"])              { /* dark overrides */ }
}
:root[data-theme="dark"]                       { /* dark overrides */ }
```

The `:not([data-theme="light"])` guard is what makes an explicit light choice win over a dark OS
setting. Without it the toggle only works in one direction.

### Consequences specific to this app

**Charts must read their colours from the same custom properties.** Every chart in §8.1 — the trend
line, the allocation donut, the assets-vs-liabilities bars — has to resolve fill and stroke from CSS
variables rather than hardcoded hex, and re-resolve on theme change. This is the piece that gets
forgotten, and the symptom is a light-themed donut sitting in a dark page.

**Gain/loss colours need separate values per theme.** A green that reads well on white is muddy and
low-contrast on near-black; the same is true of red. These are two palettes, not one palette with an
inverted background.

**Never encode gain or loss in colour alone.** Red/green is the most common axis of colour-vision
deficiency, and this app uses that pair for its single most important signal. Always pair it with
the sign, and preferably a direction arrow, so the number is readable without perceiving hue at all.
This is why a masked gain keeps its sign and its arrow and loses only its size (spec 0007): dropping
them along with the digits would leave the hue as the only channel saying which way the figure
points, which is precisely what this rule forbids.

**Mobile chrome follows the theme.** `<meta name="theme-color">` drives the browser chrome and the
installed PWA's status bar. Since the manifest's `theme_color` is static, supply media-scoped meta
tags so the installed app doesn't sit under a light status bar in dark mode.

The toggle will live in the header, persistent across every page; it has not landed yet (§13.8).

---

## 13. Design tokens

Extracted from the Stitch project **Portfolio Net Worth Tracker**
(`projects/6282864270794825736`) — the twelve screens it now holds: **Portfolio Dashboard**,
**Account Details** and **Views Analysis**, each in desktop and mobile, each in light and dark.

The brief the screens draw is an instrument panel rather than a terminal. Surfaces are a
blue-leaning near-black (or a blue-leaning near-white), every one of them unsaturated; depth is a
tonal step plus a hairline; and the only saturated colour on a page is carried by the data — the
trend line, a gain, a loss, a donut slice. The interface is quiet so that the numbers are not.

### 13.1 What changed since the previous extraction

Recorded because this section previously described a different design, and every line below is a
decision about the difference rather than a transcription of it.

**Stitch now supplies both themes.** The earlier screens were dark-only, so §12's light palette was
*derived* here — hue family preserved, luminance re-derived per theme. That derivation is now
discarded: every screen exists in light and dark, and both palettes are transcribed from the mock.

**The palette moved family, wholesale.** The old system was a green terminal — `#00ff41` on a
green-tinted obsidian `#0c160a`. The new one is navy and slate with a blue accent: `#0b1326`
canvas, `#0055ff` fill, `#b6c4ff` accent text in dark and `#0041c8` in light. No token survives by
value; the token *names* all survive, which is the whole reason the stylesheet is written against
custom properties.

**Sharp corners are gone.** §13.1 previously recorded that Stitch's `0.25 / 0.5 / 0.75rem` ramp was
"noise from the theme generator" and that the written brief's 0px won. That was true of that brief
and is false of this one: the new screens use the ramp everywhere — 12px on panels, 8px on rows and
buttons, 999px on avatars and chips — and there is no 0px corner anywhere in the set. The ramp is
now load-bearing.

**JetBrains Mono is retired.** The old system's load-bearing rule was a hard split between
interface type (Inter) and data type (JetBrains Mono). The new screens set every figure in Inter;
there is no monospace in any of the twelve. The *reason* for mono was column alignment, and that
requirement does not go away — it moves to `font-variant-numeric: tabular-nums`, which Inter
supports, and which fixes digit advance without a second family. The saving is real: the mono
subset was 31KB of a 79KB font payload, and it is no longer downloaded.

**The rail grew from 200px to 280px** and gained two things: a brand tile at its head and a filled
primary action at its foot.

**The mock's brand and its call to action are a brokerage's.** The screens are branded *WealthArch*
and the rail's footer button reads *Invest Now*. This app has nothing to sell and nobody to sell
it. What is taken is the *shape* — a mark, a name, a subtitle, and one filled button holding the
page's primary action — and what fills the button is this app's only write action, **Upload
statement**.

**The mock's nav is three items (Home / Views / Settings); §8.4's is six.** Unchanged from the
previous extraction: §8.4 wins, because its ordering is a decision about how often each page is
opened and the routes already exist.

**§8.1 ruled out a per-account drill-down; the mock supplies one.** The argument there was that a
filtered Holdings table already is one. The mock's Account Details screen is more than that filter
— it carries the account's own header, its own valuation series and its own holdings table — and
the query layer reaches it by adding one predicate to queries that already exist (§8.2). The
exclusion is reversed. What is *not* reversed is the dedicated tax page, which nothing in the new
screens asks for.

**The chart rule inverted.** The old brief said 1.5px stroke and no area fill. The new screens draw
a 3px stroke over a vertical gradient fill and dashed grid lines. Both are now in §13.6.

### 13.2 Colour

Both columns are Stitch verbatim except the two rows marked, which are departures for contrast and
are argued in §13.3.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--background` | `#f7f9fb` | `#0b1326` | The canvas |
| `--surface-container-lowest` | `#ffffff` | `#060e20` | Deepest well; the light panel |
| `--surface-container-low` | `#f2f4f6` | `#131b2e` | Row hover in light; the donut track |
| `--surface-container` | `#eceef0` | `#1E293B` | Panel body — the default card |
| `--surface-container-high` | `#e6e8ea` | `#222a3d` | Table headers, row hover in dark |
| `--surface-container-highest` | `#e0e3e5` | `#2d3449` | Pressed |
| `--surface-bright` | `#f7f9fb` | `#31394d` | The tinted half of a split panel |
| `--on-surface` | `#191c1e` | `#F8FAFC` | Primary text |
| `--on-surface-variant` | `#434656` | `#c3c5d9` | Labels, captions, secondary text |
| `--outline` | `#737688` | `#8d90a2` | Borders that must be *seen* (≥3:1) |
| `--outline-variant` | `#c3c5d9` | `#434656` | The 1px structural hairline |
| `--primary` | `#0041c8` | `#b6c4ff` | Accent text, icons, the active nav item |
| `--primary-container` | `#0055ff` | `#0055ff` | The one solid accent fill, both themes |
| `--on-primary-container` | `#ffffff` | `#e3e6ff` | Text on that fill |
| `--secondary-container` | `#d0e1fb` | `#39485a` | The active nav item's ground |
| `--gain` | `#005c3e` | `#10B981` | Positive movement |
| `--loss` | `#ba1a1a` | `#f87171` † | Negative movement |
| `--warning` | `#92500e` ‡ | `#FBBF24` ‡ | Stale price, partial coverage |
| `--warning-surface` | `#fef3c7` ‡ | `#33280a` ‡ | The ground under a warning |

† Departure. Stitch's dark loss is `#EF4444`, which carries **3.89:1** on the panel surface
`#1E293B` — under 4.5:1, and every loss figure in the app is small text sitting on exactly that
panel. `#f87171` is the same hue at 5.29:1. `#EF4444` is kept where it is a *fill* rather than text
(§13.3), because a graphical object needs 3:1, not 4.5:1.

‡ Derived, not supplied. Stitch's screens have no warning role at all, but §6.2 needs one for a
stale price and §8.2 needs one for partial coverage. These are the amber of the same Tailwind
family the mock's `--gain` and `--loss` come from, luminance-picked per theme.

Measured, on the surface each is actually used against:

| Pair | Light | Dark |
|---|---|---|
| `--on-surface` on `--background` | 16.2 | 17.7 |
| `--on-surface-variant` on `--surface-container` | 8.0 | 8.6 |
| `--primary` on `--background` | 7.7 | 10.9 |
| `--gain` on `--surface-container` | 6.9 | 5.8 |
| `--loss` on `--surface-container` | 5.6 | 5.3 |
| `--on-primary-container` on `--primary-container` | 5.6 | 4.6 |
| `--outline` on `--background` | 4.3 | 5.9 |
| `--outline-variant` on `--surface-container` | 1.5 | 1.6 |

Two borders, deliberately, and the reasoning is unchanged from the previous system:
`--outline-variant` is the structural hairline that frames a panel and divides rows — it is *felt*,
not read, which is what its 1.5:1 says. `--outline` clears 3:1 and is what an input, a control
boundary or a focus ring uses, where a border nobody can perceive is a defect rather than a style.

**Gain and loss are still the only saturated colour in the interface**, and per §12 the pair is
never load-bearing alone: every figure carries its sign and a direction arrow, so it reads without
perceiving hue at all. Note that the two themes' greens are not one colour at two luminances —
`#10B981` on white is 2.4:1 and `#005c3e` on the dark canvas is 2.3:1. Each is unusable in the
other theme. They are two palettes, exactly as §12 says.

### 13.3 The categorical sequence

The Views screen colours donut slices and their legend dots from one ordered sequence, reused from
position 1 in every panel — so the same rank means the same colour in all three breakdowns, and no
breakdown gets a chart palette of its own.

| # | Light | Dark |
|---|---|---|
| 1 | `#0041c8` | `#0055ff` |
| 2 | `#007751` | `#10B981` |
| 3 | `#505f76` | `#b6c4ff` |
| 4 | `#b6c4ff` | `#EF4444` |
| 5 | `#c3c5d9` | `#4edea3` |

These are fills, not text: 3:1 against the panel is the bar they have to clear, and the light
sequence's tail (`#b6c4ff`, `#c3c5d9`) does not clear it — 1.7:1 and 1.4:1 on white. The slices are
large enough to be identifiable anyway; the 12px legend dots are not, so **every legend dot carries
a 1px `--outline-variant` ring**. That is cheaper than re-deriving a palette Stitch chose for its
harmony, and it fixes the dot rather than the slice, which is where the problem actually is.

A breakdown with more than five groups folds its tail into one "Other" slice rather than extending
the sequence. Six flat colours in a donut is a legend nobody reads.

### 13.4 Typography

One family now — **Inter**, self-hosted (`public/fonts/`, latin subset, variable weight, 47KB).
Not the Google CDN the mocks use: this is an offline-capable PWA (§11) for a household's finances,
and a per-visit request to a third party is both a privacy leak and an offline failure.

| Token | Size / line | Weight | Tracking |
|---|---|---|---|
| `--type-display-lg` | 48px / 56px | 700 | −0.02em |
| `--type-headline-lg` | 32px / 40px | 600 | −0.01em |
| `--type-headline-sm` | 24px / 32px | 600 | — |
| `--type-title-md` | 20px / 28px | 600 | — |
| `--type-body-lg` | 16px / 24px | 400 | — |
| `--type-body-sm` | 14px / 20px | 400 | — |
| `--type-label-md` | 12px / 16px | 600 | 0.05em, uppercase |

These names are roles, not shipped custom properties: `app.css` defines only `--font-ui` for type
and applies the ramp as literal values per component.

`--type-headline-sm` is the mock's `headline-lg-mobile`, renamed: it is a size in the ramp, not a
device, and a card title on a wide screen wants it too.

**Every figure sets `font-variant-numeric: tabular-nums`.** This is the rule that replaced the mono
family and it is not optional — a column of proportional digits does not align, and a figure that
changes width as it updates makes the whole row twitch.

### 13.5 Spacing, shape, elevation

4px baseline grid, and a named scale the mock uses consistently enough to be worth transcribing.

| Token | Value | Where |
|---|---|---|
| `--space-xs` | 4px | Caption to figure |
| `--space-base` | 8px | Icon to label |
| `--space-sm` | 12px | Dot to label; chip padding |
| `--space-md` | 16px | Table cell padding; the mobile canvas margin |
| `--space-lg` | 24px | Panel padding; the gap between panels |
| `--space-xl` | 40px | Page header to first panel |
| `--canvas-margin` | 16px → 32px | Mobile → desktop |
| `--rail` | 280px | Fixed sidebar, ≥1024px |
| `--content-max` | 1280px | The canvas caps here and centres. Was 1152 until Holdings gained a ninth column |
| `--control-h` | 40px | Buttons, inputs, range chips |
| `--field-caption` | 24px | A caption line plus its gap — what an un-captioned member of a control row drops by to reach the control line |
| `--radius` | 4px | Chips |
| `--radius-lg` | 8px | Buttons, rows, inputs |
| `--radius-xl` | 12px | Panels |
| `--radius-full` | 999px | Avatars, dots, the brand mark |

**Shadow is `none` in dark and one hairline in light** — `0 1px 2px rgb(0 0 0 / 0.05)`, which is
the mock's only shadow and reads as a paper edge rather than a lift. Depth everywhere else is a
tonal step plus a 1px border: canvas → panel → panel header.

Hover lifts a row's ground by one tonal step rather than raising it. `--control-h` is uniform so
that controls in different columns line up across a dashboard, which is the actual reason it is a
token rather than a per-component value.

**Breakpoints:** 768px, where a panel's two halves stack and a table can begin to scroll; and
1024px, where the rail appears. Below 1024px the rail becomes a fixed bottom bar — the shape every one of the
mock's mobile screens uses, with no drawer or hamburger anywhere in the set.

### 13.6 The chart

Both the Overview trend and the Account Details performance chart draw the same way.

- **Line:** 3px, `--chart-line` — `#0041c8` in light and `#0055ff` in dark: the pale dark-theme
  primary would vanish as a line, so each theme names the colour that draws well on its canvas
  (`app.css` records the split).
- **Area:** a vertical gradient below the line, from the line colour at 0.25 alpha to fully
  transparent at the baseline. This reverses the old brief's "no area fills" rule.
- **Grid:** horizontal only, 1px, `--outline-variant`, `stroke-dasharray: 4 4`.
- **Axis labels:** `--type-label-md` in `--on-surface-variant`.
- **The dashed prefix stays.** §7's hand-typed pre-day-zero series is still drawn dashed against
  the computed line's solid, because that distinction is about provenance and no repaint changes it.
- **Colours resolve from custom properties**, per §12 — no hex in any chart component.

### 13.7 What the mock supplied that is not implemented

The screens are populated with fabricated data, and some of it describes a different product.

- **"WealthArch", "Invest Now", and a "Crypto" account.** A brokerage's brand, a brokerage's CTA,
  and an asset class §1 puts out of scope.
- **Every figure on every screen** — `$245,892.50`, `+6.2% YTD`, `$1.2M`, the eleven-point
  polyline, the four accounts. All of it is loader data now. The empty case in particular still
  renders **no figure at all** (§8.4): a zero and an empty instance must not look alike.
- **A notification bell and an avatar menu.** Single-tenant, self-hosted, and §10 has no user
  accounts to hang an avatar on. The rail carries the brand and the nav; on a phone a 64px top bar
  carries the wordmark and the Upload action.
- **A "Target Risk 8.0 / 10" gauge and a "Time-Weighted Return" annotation.** Both are numbers
  nothing in the schema can produce (§3 — positions only, no cash flows, so a time-weighted return
  is not computable). Rendering either would be inventing a figure on a finance page.
- **Search over accounts.** A household has a dozen accounts; a filter over twelve rows is a
  control that costs more than it saves.
- **Material Symbols icons via CDN.** Inline SVG instead, for the same offline and privacy reasons
  as the fonts.

### 13.8 Not in this change

The **cookie-backed three-state toggle** of §12. The token structure here is exactly what §12
prescribes —

```css
:root                             { /* light */ }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { /* dark  */ }
}
:root[data-theme="dark"]          { /* dark  */ }
```

— so both themes are live today via the OS setting, and the toggle slice adds the cookie, the
control and the client listener without touching a single token.
---

## 14. Accepted limitations

Recorded so they are revisited deliberately rather than discovered under deadline.

1. **No realized gains, dividend history, or tax lots.** Consequence of positions-only (§3). Adding
   them means a transaction ledger — a substantially different ingest problem.
2. **The net worth chart cannot separate market movement from contributions.** Consequence of no
   cash-flow tracking (§3). Labelling mitigates; it does not solve. It is sharpest on 1D, where a
   statement uploaded during the session moves the change figure beside the headline by the whole
   change in holdings while the line beside it moves only by the change in price — the line holds
   today's positions constant across the session, and the change reader compares today's positions
   against the previous session's. Every other range agrees with its own line because the line's
   first point *is* what the change reads; a session is simply short enough for the difference to be
   visible.
3. **Hand-rolled dashboard queries can disagree.** Consequence of no materialisation (§8.2).
   `holding_valued` mitigates.
4. **No joint accounts.** Consequence of single-owner (§4.2). Adding them is a join table plus
   reworking person-grouped queries.
5. **Unofficial price provider.** `yahoo-finance2` can break without notice (§6.1). Mitigated by
   owning the price history, the manual fallback, and the provider interface.
6. **USD only, with no currency column.** A guard refuses non-USD instruments at resolution (§6.1).
   True multi-currency later means adding the column and touching every money value.
7. **History accuracy scales with upload density.** With one statement per quarter, the chart assumes
   holdings were frozen between them — quarter-end values are exact and the shape between them is
   driven by real price movement. Uploading more statements sharpens past stretches retroactively,
   with nothing to migrate.
8. **The "set balance" form cannot record an overdrawn bank account.** Consequence of deriving the
   sign from `account.kind` rather than accepting a typed one (§5.2): the alternative accepts `14500`
   for a debt, which does not fail but moves net worth by twice the loan. An overdraft is recordable
   as a `liability` account or through an upload — in fact, not only in principle: the mapping
   step's owed-as-positive box keeps the file's own sign when unticked, so a bank export carrying a
   negative balance records one. Lifting the limitation for the form itself means a per-kind
   decision about whether a negative is meaningful, not a change to the storage rule — the schema
   already holds a negative quantity against any account.
9. **A holding with no dividend rate counts as paying nothing.** The projected annual dividend
   (§8.1, Income) is `quantity × annual_dividend_per_share`, and a null rate contributes `$0` rather
   than an unknown. Three unlike things produce that null — a provider answering "no dividend
   fields" for a growth ETF, which is genuinely zero; a workplace-plan trust the refresh never asks
   about, because it has no symbol; and the seeded `USD` row, which no provider will ever quote. The
   figure therefore understates by every unquoted holding, by all cash interest, and by any interest
   on a loan. This is the one place the codebase departs from §8.2's "sum what is known and label the
   coverage": applied literally here, a portfolio where most holdings correctly pay nothing would
   report "based on 4 of 23 holdings", and a caption that cries wolf on two-thirds of a table is one
   nobody reads. Both screens label the total a **lower bound** instead, the way the unrealized panel
   labels its tax figure an upper bound. Lifting this means deciding per row from whether the
   instrument was ever quoted — a refreshed `quote` row means the provider answered, and `fixed` or
   `manual` means it was never asked — which is a change to one derivation, not to the schema.
10. **There is no sign-out control, and the gate's sign-out URL is not one.** It clears the gate's
    own cookie and nothing else, so with sign-in going straight to Google the next visit re-admits
    silently — which looks, to the person who used it, exactly like it did not work. The levers that
    do revoke are the operator's: taking an address off the allowlist ends that one person's
    sessions everywhere, and rotating the gate's cookie secret ends everyone's at once. A real
    control is tracked as [issue #89](https://github.com/chethan123/portfolio/issues/89) rather than
    rejected; it inherits this as its motivation, and `docs/runbook.md` carries the URL with its
    limits stated in the meantime.
11. **Signing in depends on Google being reachable.** An outage there defers *new* sign-ins until it
    passes; sessions already established ride through it, because the gate validates its own cookie
    without asking Google again. There is deliberately no second login system to fall back to — one
    would be a password, which is the thing this replaced — so the break-glass path during an outage
    is the operator's shell on the box, not another way in through the front door.
12. **1D always shows the latest session; an older one cannot be chosen.** The observations are
    kept forever, so the data for last Tuesday's session exists — but drawing it is a separate
    decision with its own cost, and one deliberately deferred
    ([ADR-0006](docs/adr/0006-intraday-quotes-are-an-observation-log.md)): an instant-parameterised
    sibling of `holding_valued_at` (a third object bound by ADR-0001's row-type contract), a second
    time vocabulary in `chart-range.ts`, and a time axis that can name a day as well as an hour. The
    data existing is not a promise that it will be drawn. Two smaller limits ride along with it. The
    archive holds only what was observed at the household's own cadence, which is not market data —
    no OHLC bars, no volume, permanent unbackfillable gaps for every stretch the server was down,
    and no corporate-action adjustment — so it must not be mistaken for a backtest-grade series. And
    the 1D line is drawn once, when the page loads: nothing updates in place, because a live tick
    pipeline was rejected in §6 for a reason that has not changed.
