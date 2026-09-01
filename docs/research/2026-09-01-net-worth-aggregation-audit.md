# Net worth aggregation audit — 1 September 2026

An independent correctness audit of every displayed total: the Overview headline, per-account
values, the Holdings grand total and subtotals, the four Analysis breakdowns, and the Income
figures. Written as a test report to be picked up as work
([`docs/README.md`](../README.md) puts those here). **Diagnosis only — nothing was fixed.**

Figures are in [`2026-09-01-net-worth-aggregation-audit/figures/`](2026-09-01-net-worth-aggregation-audit/figures);
the scripts every number below came from are in
[`.../harness/`](2026-09-01-net-worth-aggregation-audit/harness).

---

## Verdict

**The aggregation arithmetic is correct.** Across five cycles of use — 41 accounts, 229
instruments, 383 live positions, 60 position sets, 16 price refreshes — the household total, every
per-account value, every group subtotal, every filter partition, the annual dividend and the cost
basis reconciled **to the exact stored decimal, with zero deviation**, against an independent
ground-truth ledger the application never touched. No undercounting, no drift, no rounding leak, no
lost row, no pagination cut.

The suspicion of undercounting is **not confirmed for the arithmetic**. Three real defects were
found around it, none of which is a summation error — but two of them make a screen state a figure
that is not what the household recorded:

| # | Defect | Severity | Confidence |
|---|---|---|---|
| 1 | Selecting **two or more owners** in the household filter makes every figure screen unreachable — an infinite redirect without JavaScript, an unbounded ~80 req/s client loop with it, while the screen silently keeps showing the *unfiltered* household total | **High** | Reproduced in isolation; root cause confirmed in code; reproduced in the production build |
| 2 | A statement can be **committed and have no effect on any figure**, after a review screen has promised the change, with no message anywhere | **Medium-high** | Reproduced in a 4-step minimal case; root cause confirmed in code |
| 3 | On the day an account is **closed**, the net-worth chart's last point overstates net worth by that account's entire value and contradicts the headline directly above it | **Medium** | Reproduced; root cause confirmed in code; self-heals the next day |

Deviation, where it exists, is not in the sums: it is $0.00 on every total measured. Defect 2 made
one account read **$344,483.81 instead of $27,711.15** (12×) after a statement the user recorded;
defect 3 made the chart read **$16,190,084.15 against a headline of $15,107,874.47** on one screen
at one moment ($1,082,209.68 apart).

---

## How the audit was run

A normal development checkout, driven exactly as `docs/developing.md` describes: Node 24.12,
PostgreSQL, `npm run migrate`, `npm run dev`. Every write in this report went through the
application's own forms in a real Chromium via Playwright — Settings → People, Settings → Accounts,
the four-step upload flow, the Set balance form, the Holdings row editor, the close-account form.
Nothing was inserted into the database by hand. The database was read directly, freely, for
verification.

**One substitution.** Yahoo is unreachable from the sandbox this ran in, so prices came from a
deterministic fake `PriceProvider` handed to the application's **own** writer,
`refreshQuotes(provider, marketTimeZone)`
([`harness/fake-refresh.mjs`](2026-09-01-net-worth-aggregation-audit/harness/fake-refresh.mjs)). Every
`quote`, `price_daily` and `price_observation` row was written by `app/lib/prices.server.ts` exactly
as a live refresh writes them — the seam `DESIGN.md` §6.1 exists for. No money column was written by
hand anywhere in this audit.

The findings were also reproduced against `npm run build` + `react-router-serve`, so none of them is
a dev-server artefact.

---

## Test plan, as executed

Written before any data was generated, from a read of the schema, `valuation.server.ts`,
`allocation.ts`, `holdings-view.ts`, `money.ts`, `owner-filter.ts` and every route, plus a
click-through of the running app. Full text:
[`harness/TEST-PLAN.md`](2026-09-01-net-worth-aggregation-audit/harness/TEST-PLAN.md).

### What the reading established

* **Account kinds**: `brokerage`, `401k`, `ira`, `bank`, `liability`. Accounts are *closed*
  (`closed_at`), never deleted; closing is one-way.
* **Valuation is SQL, not JavaScript.** `holding_valued` and `holding_valued_at(d)` are the only
  definitions of a holding's worth: `round(quantity × price, 4)`, `quantity numeric(20,8)`,
  `price numeric(20,4)`. Current price is `quote` (overwritten in place); historical price is
  carried forward from `price_daily`.
* **History is append-only.** Uploads, balances and corrections each write a new `position_set`;
  `latest_position_set(account_id[, date])` decides which one counts, ordered
  `as_of_date desc, created_at desc, id desc`.
* **Single currency.** USD only; a non-USD quote is refused at the boundary.
* **Nothing paginates.** No `LIMIT`/`OFFSET` in `valuation.server.ts`; every table renders every
  row. The Overview allocation panel shows the 5 largest accounts *and says so*; the breakdown rings
  fold rank ≥ 5 into one wedge while the table beside them still lists every slice.
* **Amounts are masked by default** — every figure renders `$••••••` until the `masked` cookie is
  `0`. The audit browser sets it.

### Test data

| Kind | Accounts | Seeded through |
|---|---|---|
| brokerage | 11 | the four-step CSV upload flow |
| 401k | 6 | the four-step CSV upload flow |
| ira | 6 | the four-step CSV upload flow |
| bank | 8 | the Set balance form |
| liability | 4 | the Set balance form |

3 people; **220 distinct instruments** dealt so that every one is used at least once and 111 recur
across several accounts; **361 securities positions** plus 12 balances at the baseline. Account
values span **$11k to $1.9M**, two of them in the $1–2M band. Deliberate shapes: one account with
exactly **1** position, one with **40**, one left **empty**, quantities carried to the full 8 decimal
places so every product needs rounding, and liabilities summing negative.
[`harness/gen_data.py`](2026-09-01-net-worth-aggregation-audit/harness/gen_data.py) generates it and
emits `ledger.json` — the ground truth, which the application never reads or writes.

### How a discrepancy is called

* **Confirmed** — reproduced in the smallest case that still shows it, localized to a layer by
  direct SQL, and traced to the responsible expression in the source.
* **Inconclusive** — observed but not reproduced in isolation, or root cause not identified.

Layers: **write** (ledger vs stored rows), **storage/computation** (stored rows vs SQL aggregate),
**rendering** (SQL aggregate vs what the screen prints). Anything over **$0.01** on a subtotal or the
grand total is a finding.

---

## The workflows that were walked

### Recording the household

3 people, then 35 accounts, through Settings.

![Settings → People](2026-09-01-net-worth-aggregation-audit/figures/01-settings-people.png)

![Settings → Accounts](2026-09-01-net-worth-aggregation-audit/figures/02-settings-accounts.png)

### The four-step upload flow, run 32 times

Step 1 picks the account and the file.

![Upload step 1](2026-09-01-net-worth-aggregation-audit/figures/03-upload-step1.png)

Step 2 maps the columns against a verbatim preview.

![Upload step 2 — columns](2026-09-01-net-worth-aggregation-audit/figures/04-upload-columns.png)

Step 3 resolves every string the instance has never seen — 220 of them across the seed.

![Upload step 3 — first sightings](2026-09-01-net-worth-aggregation-audit/figures/05-upload-instruments.png)

Step 4 shows the diff and commits.

![Upload step 4 — review](2026-09-01-net-worth-aggregation-audit/figures/06-upload-review.png)

The account page then carries the receipt, recomputed from the database rather than the URL.

![Upload receipt](2026-09-01-net-worth-aggregation-audit/figures/07-upload-receipt.png)

### Recording a balance

Bank and liability accounts take a typed figure; the minus sign for a liability is added server-side.

![Set balance](2026-09-01-net-worth-aggregation-audit/figures/08-set-balance.png)

### The figure screens

Overview — headline, chart, every account, allocation.

![Overview](2026-09-01-net-worth-aggregation-audit/figures/10-overview.png)

Holdings — every position, no pagination.

![Holdings](2026-09-01-net-worth-aggregation-audit/figures/11-holdings.png)

Holdings grouped, here by account type; subtotals and shares.

![Holdings grouped by account type](2026-09-01-net-worth-aggregation-audit/figures/12-holdings-grouped.png)

The grand total row, where the household figure is restated.

![Holdings total row](2026-09-01-net-worth-aggregation-audit/figures/17-holdings-total.png)

Holdings filtered — here to liabilities, the negative case.

![Holdings filtered to liabilities](2026-09-01-net-worth-aggregation-audit/figures/13-holdings-filtered.png)

Analysis — four breakdowns and the unrealized-gains table.

![Analysis](2026-09-01-net-worth-aggregation-audit/figures/14-analysis.png)

Income — annual dividend, weighted yield, sheltered vs taxable.

![Income](2026-09-01-net-worth-aggregation-audit/figures/15-income.png)

An account's own page.

![Account page](2026-09-01-net-worth-aggregation-audit/figures/16-account-page.png)

---

## The reconciliation, cycle by cycle

Each cycle re-ran the full three-way comparison
([`harness/verify.py`](2026-09-01-net-worth-aggregation-audit/harness/verify.py)): ledger →
database → UI.

| Cycle | What was done through the UI | Household total | Ledger vs database | Database vs UI |
|---|---|---|---|---|
| 1 · baseline | 3 people, 35 accounts, 22 statements (361 positions), 12 balances | $6,643,463.6692 | **exact** | **exact** |
| 2 · incremental | +3 accounts; a **lot-level** statement — 28 lines, 10 tickers, lots shuffled apart — plus 2 balances | $14,003,314.0066 | **exact** | **exact** |
| 3 · corrections | 14 quantity corrections through the Holdings row editor, one per account | $15,397,058.7582 | **exact** | **exact** |
| 4 · re-uploads | 4 statements re-uploaded over accounts that already held one: same date, later date, **back**-dated, and a majority-removal | $15,868,566.2301 | **exact** (after the ledger was corrected for the app's own date rule — see finding 2) | **exact** |
| 5 · closing & refreshes | an account closed; 5 identical price refreshes; a +$1.00 price bump; 5 failed "Refresh now" presses | $15,017,484.9456 | **exact** | **exact** |

Every figure at every cycle: **difference $0.0000**.

Cycle 1 in full, for shape:

```
LAYER 1 — write: ledger quantities vs stored rows
  ledger rows 361  stored securities rows 361
  missing 0  quantity mismatches 0  unexpected 0

LAYER 2 — storage/computation: expected (ledger × captured price) vs SQL aggregate
  accounts compared: 34   deviating: 0
  EXPECTED GRAND TOTAL :     6,643,463.6692
  DATABASE GRAND TOTAL :     6,643,463.6692
  difference           :            +0.0000

LAYER 3 — rendering: SQL aggregate vs UI
  UI overview headline :       6,643,463.67   (db rounds to 6,643,463.67)
  UI account rows: 35   deviating from db: 0
  Holdings footer Value: $6,643,463.67
  Analysis 'Net worth by owner' ring total: $6,643,463.67
  Analysis 'Value by account type' ring total: $6,643,463.67
  Analysis 'Value by asset class' ring total: $6,643,463.67
  Analysis 'Value by classification' ring total: $6,643,463.67

DIVIDENDS   expected 52,505.4331   db 52,505.4331   diff +0.0000
COST BASIS  expected 7,238,956.5432  db 7,238,956.5432  diff +0.0000
```

### A closing check that does not trust the ledger either

[`harness/recompute.py`](2026-09-01-net-worth-aggregation-audit/harness/recompute.py) is a second,
independent implementation of the valuation rule — Python `Decimal`, `ROUND_HALF_UP`, straight over
the raw `holding` and `quote` rows, with no reference to the app's SQL:

```
rows read        :    383   view rows      : 383
priced by hand   :    381   view is_priced : 381
value   by hand  :     15,129,763.6656   view:     15,129,763.6656   diff +0.0000
dividend by hand :         61,588.4680   view:         61,588.4680   diff +0.0000
basis    by hand :     15,709,995.2365   view:     15,709,995.2365   diff +0.0000
per-account rows compared: 40   mismatches: 0
```

The UI at that moment: `$15,129,763.67` on the Overview, `$15,129,763.67` in the Holdings footer,
`383 HOLDINGS · 40 ACCOUNTS`.

---

## Finding 1 — a multi-owner filter is unreachable, and silently ignored

**Severity: high. Confidence: confirmed — reproduced in isolation, root cause in code, present in the
production build.**

### What happens

Open the household owner filter, tick two of the three people, press **Apply**.

![Owner filter, two people ticked](2026-09-01-net-worth-aggregation-audit/figures/20-owner-two-ticked.png)

With JavaScript on (the normal case) the URL never changes, no error appears, and the screen keeps
showing the **unfiltered household total** — while the page issues `/_root.data?owner=1%2C2`
**forever**. Measured: **794 requests in 10 seconds** and still going, ~80 req/s, indefinitely, from
one idle tab.

With JavaScript off — or by typing the address, or following a bookmark — the same selection is a
redirect loop the browser gives up on:

![ERR_TOO_MANY_REDIRECTS](2026-09-01-net-worth-aggregation-audit/figures/21-owner-redirect-loop.png)

```
$ curl -sD- 'http://127.0.0.1:5173/?owner=1,2' | grep -iE '^HTTP|^location'
HTTP/1.1 302
location: /?owner=1,2          <-- the same address it was asked for

$ for u in /?owner=1,2 /holdings?owner=1,2 /analysis?owner=1,2 /income?owner=1,2; do ...
/holdings?owner=1,2  302 -> /holdings?owner=1,2
/analysis?owner=1,2  302 -> /analysis?owner=1,2
/income?owner=1,2    302 -> /income?owner=1,2
```

All four figure screens. A **single** owner works (`/?owner=1` → 200); it is the comma that never
converges. Reproduced identically under `npm run build` + `react-router-serve` on port 3100.

### Layer

Request handling / routing. **Not arithmetic** — the narrowing itself is correct: read directly from
the database, the three single-owner totals sum to the household total exactly, and each pair's
expected total is simply unreachable through the UI.

### Root cause

React Router 7's server runtime rewrites the request before any loader sees it. In
`node_modules/react-router/dist/production/index.js:608`:

```js
request: future.v8_passThroughRequests ? args.request : stripRoutesParam(stripIndexParam(args.request)),
```

and `stripRoutesParam` (:643) rebuilds the `Request` from `url.href` after
`url.searchParams.delete("_routes")`. Mutating `searchParams` re-serialises the query with the
`application/x-www-form-urlencoded` serializer, which percent-encodes a comma:

```js
const u = new URL("http://x/?owner=1,2");
u.searchParams.delete("_routes");
u.search;  // "?owner=1%2C2"   <-- the comma is gone before the loader runs
```

The application's canonical spelling uses a **literal** comma — `toOwnerParam`,
[`app/lib/owner-filter.ts:78-81`](../../app/lib/owner-filter.ts) — and each figure loader bounces
whenever the address is not canonical:

* [`app/routes/overview.tsx:113`](../../app/routes/overview.tsx)
* [`app/routes/holdings.tsx:120`](../../app/routes/holdings.tsx)
* [`app/routes/analysis.tsx:179`](../../app/routes/analysis.tsx)
* [`app/routes/income.tsx:78`](../../app/routes/income.tsx)

```ts
const canonical = canonicalOwnerSearch(url.searchParams);
if (url.search !== canonical) throw redirect(`${url.pathname}${canonical}`);
```

`url.search` can now only ever be `?owner=1%2C2`; `canonical` can only ever be `?owner=1,2`. The
comparison is permanently unequal and the bounce target equals the address that produced it.

The module already anticipated exactly this class of failure — `spellId`'s docstring
([`owner-filter.ts:85-96`](../../app/lib/owner-filter.ts)) warns that "a generator disagreeing with
this one about commas is a redirect firing on every click", and the invariant is tested against real
`URL` round trips. What it could not see is that the *framework* re-serialises the query between the
socket and the loader. The pure function is still a fixed point:

```
?owner=1,2   search "?owner=1,2"   canonical "?owner=1,2"   equal: true
?owner=2,1   search "?owner=2,1"   canonical "?owner=1,2"   equal: false   (correct: one bounce)
```

**Note for whoever fixes it**: `future.v8_passThroughRequests` — the flag the dev server already
warns about at startup — skips the rewrite. Whether that is the right fix, or whether the canonical
spelling should stop using a bare comma, is a design call this report does not make.

### Why it is worse than a broken filter

The failure is silent. A household of three that wants "Ana and Ben" gets the **whole household's**
figure with no indication that the filter was not applied, and a tab that hammers the instance until
it is closed.

---

## Finding 2 — a statement can be recorded and change nothing, with no message

**Severity: medium-high. Confidence: confirmed — reproduced in a four-step minimal case, root cause in
code.**

### Minimal reproduction

Four steps, one account, two positions
([`harness/repro-silent-noop.mjs`](2026-09-01-net-worth-aggregation-audit/harness/repro-silent-noop.mjs)):

1. Create a brokerage account.
2. Upload a statement dated **2026-08-31**: `RPXA 100`, `RPXB 200`.
3. Correct RPXA's quantity to `150` in the Holdings row editor.
4. Upload a second statement, also dated **2026-08-31**, carrying only `RPXA 100`.

The review screen states plainly what will happen — `0 ADDED · 1 UPDATED · 1 REMOVED`, RPXA
`150 → 100`, RPXB removed, "The statement dates itself: 2026-08-31":

![The review screen promises a change](2026-09-01-net-worth-aggregation-audit/figures/30-noop-review.png)

"Record this statement" is accepted and redirects to `/accounts/39?uploaded=58`. The account still
holds **two** positions at the old quantities, and **no message is rendered at all**:

![The account after committing](2026-09-01-net-worth-aggregation-audit/figures/31-noop-after-commit.png)

```
review promised : 0 ADDED · 1 UPDATED · 1 REMOVED
landed on       : /accounts/39?uploaded=58
message shown   : null
after statement 2 : 2 rows, $225,978.00   (unchanged)
```

### Layer

Write / contract, **not** arithmetic. The row is stored correctly; it simply never becomes the set
anything reads. Confirmed by SQL:

```
 name                  | id | as_of_date | source | source_filename | rows | is_current
-----------------------+----+------------+--------+-----------------+------+-----------
 BROKERAGE 9 · Growth  |  9 | 2026-08-31 | upload | acct09.csv      |   21 | f
 BROKERAGE 9 · Growth  | 55 | 2026-08-31 | upload | acct09b.csv     |    2 | f   <-- just committed
 BROKERAGE 9 · Growth  | 42 | 2026-09-01 | manual |                 |   21 | t   <-- still current
```

### Root cause

Three correct-in-isolation rules compose into a silent no-op:

1. `latest_position_set` orders by **`as_of_date` first**
   ([`migrations/0002_holding_valued.sql:46-57`](../../migrations/0002_holding_valued.sql)).
2. A correction is dated **today**, not the date of the statement it corrects — `effectiveDate`, used
   at [`app/lib/positions.server.ts:320`](../../app/lib/positions.server.ts), documented as "the date
   a correction against a statement of `asOf` will carry: today".
3. `commitUpload` ([`app/lib/uploads.server.ts:1005-1060`](../../app/lib/uploads.server.ts)) neither
   refuses nor warns when the set it is about to write cannot become the latest, and the diff it
   showed was computed against the *current* holdings — so the review describes a change the commit
   cannot deliver.

`uploadReceipt` then completes the silence, deliberately: "A set the account is no longer reading
gets no sentence — the receipt describes the holdings on screen or nothing"
([`uploads.server.ts:1105-1108`](../../app/lib/uploads.server.ts)). That rule is right on its own; here it
removes the only place the user could have learned anything.

### Measured effect in the seeded household

Cycle 4 recorded a statement declaring that **BROKERAGE 9 · Growth** held 2 positions worth
**$27,711.15**. The account went on reporting **21 positions worth $344,483.81** — a 12×
overstatement of that account, and $316,772.66 in the household total, from a statement the user
watched being accepted.

The same shape hit **BROKERAGE 2 · Legacy**: a re-upload with every quantity ×1.1 landed and changed
nothing.

The database is internally consistent throughout — this is a divergence between what the household
recorded and what the application reports, not a summation error.

---

## Finding 3 — on the day an account is closed, the chart overstates net worth

**Severity: medium. Confidence: confirmed — reproduced, root cause in code, self-heals next day.**

### What happens

Close an account, then look at the Overview on any range other than 1D. The headline and the chart's
own final point, on the same screen, at the same moment:

![Headline and chart disagree](2026-09-01-net-worth-aggregation-audit/figures/40-chart-vs-headline.png)

```
headline : $15,107,874.47
chart    : "Total value over the last 1Y, ending on 1 Sep 2026 at $16,190,084.15."
difference: $1,082,209.68
```

$1,082,209.6845 is exactly the value of `BROKERAGE 4 · Rollover`, closed at `2026-09-01 00:53:05Z`.
Every range except 1D shows it; **1D agrees with the headline**, so the screen carries two different
answers depending on which chip is selected.

### Layer

Computation — two readers of the same portfolio disagree for one calendar day.

```
 src                                   |     total     | rows
---------------------------------------+---------------+------
 holding_valued (headline)             | 15107874.4656 |  381
 holding_valued_at(2026-09-01) (chart) | 16190084.1501 |  391
```

### Root cause

* `holding_valued` ends `where a.closed_at is null` — a closed account is gone from every current
  figure the moment it is closed
  ([`migrations/0006_annual_dividend.sql:158`](../../migrations/0006_annual_dividend.sql)).
* `holding_valued_at(d)` ends `where a.closed_at is null or a.closed_at > d`, with `d` promoted to
  midnight, so "an account closed at any time during `d` is still counted on `d`"
  ([`migrations/0006_annual_dividend.sql:255-259`](../../migrations/0006_annual_dividend.sql)).
* `readSessionSeries` — the 1D path — applies `a.closed_at is null` itself
  ([`app/lib/valuation.server.ts:648-722`](../../app/lib/valuation.server.ts)), siding with the headline.

Each rule is defensible alone. Together they mean the chart's *last* point is computed by a different
rule from the headline it sits under, and only on the day of a close does the difference become
visible — at full account size.

Verified to self-heal: `holding_valued_at('2026-09-02')` returns `15107874.4656`, matching the
headline exactly.

This is `DESIGN.md` §14 limitation 3 ("hand-rolled dashboard queries can disagree") materialising —
except that these are the shared readers, not hand-rolled ones.

---

## What was tested and did **not** show a problem

### Aggregation, every way it is sliced

Measured on the final state; identical results at every cycle
([`harness/sweep.mjs`](2026-09-01-net-worth-aggregation-audit/harness/sweep.mjs)).

* **Every filter dimension partitions the whole exactly.** Each dimension's options were applied one
  at a time and the parts summed:

  | Dimension | Options | Σ parts | Whole | Rows covered |
  |---|---|---|---|---|
  | account | 38 | 15,017,484.95 | 15,017,484.95 | 380/380 |
  | institution | 11 | 15,017,484.96 | 15,017,484.95 | 380/380 |
  | kind | 5 | 15,017,484.96 | 15,017,484.95 | 380/380 |
  | tax treatment | 3 | 15,017,484.95 | 15,017,484.95 | 380/380 |
  | classification | 9 | 15,017,484.96 | 15,017,484.95 | 380/380 |
  | asset class | 4 | 15,017,484.94 | 15,017,484.95 | 380/380 |

  The ±1¢ is display rounding only — see "Two things that look wrong and are not" below. At the
  stored scale of 4 every partition sums to `15017484.9456` **exactly**, verified in SQL.

* **Every grouping** (`owner`, `account`, `institution`, `kind`, `tax`, `classification`,
  `assetClass`, and ungrouped): subtotals sum to the grand total, and the grand total is identical to
  the ungrouped one.
* **Every sort column × both directions** (9 × 2 = 18): total and row count unchanged.
* **Single-owner filters**: the three owners' totals sum to the household total exactly
  (12,259,765.99 + 1,441,855.58 + 1,315,863.37 = 15,017,484.94 at cent precision; exact at scale 4).
* **The four Analysis panels**: each ring total equals the Overview headline, and each panel's rows
  sum to its ring total.
* **Income**: total annual dividend $61,588.4680 matches the database to the last decimal; the
  sheltered/taxable split ($14,585.19 + $47,003.28) sums to it; weighted yield 0.377565% renders as
  0.4%.
* **Unrealized gains and potential tax**: stocks +$288,483.44 (taxable $246,145.25), funds
  −$69,538.55 (taxable −$80,285.44), total +$218,944.89, tax $58,582.57 at 23.8% — every figure
  matches a direct SQL recomputation.
* **Per-account values**: all 40 rows on the Overview match the database exactly; each account's own
  page matches its Overview row.

### Ingest

* **Lot-level statements.** 28 lines carrying 10 tickers, with each ticker's lots deliberately
  shuffled apart, folded to 10 positions: quantities summed exactly, cost basis quantity-weighted
  exactly.

  ![Lot fold](2026-09-01-net-worth-aggregation-audit/figures/53-lot-fold-review.png)

* **One instrument named three ways in one file** — `RPXA`, `RPXA.US`, `RPXA (LOT 3)`, all resolved
  to the same instrument — folded to a single position of `175.5` (100 + 50 + 25.5) worth
  $90,389.52. No lot dropped.
* **Re-uploads.** Same-date, later-date, back-dated and majority-removal statements over accounts that
  already held one. The back-dated statement correctly did **not** become the account's current
  statement; the later-dated one correctly did.
* **The numeric overflow guard** refuses a quantity × basis that will not fit `numeric(20,4)`,
  records nothing, and leaves every screen rendering.

  ![Overflow refusal](2026-09-01-net-worth-aggregation-audit/figures/54-overflow-refusal.png)

* **No write-time loss at any point.** Generated record counts and stored rows matched at every
  cycle: 361 → 361, 371 → 371, 372 → 372.

### Edge cases

* **A single-holding account** and a **40-holding account**: both exact.
* **An empty account** (created, never uploaded to): its own page withholds the figure and explains
  why; it appears in the Overview list at $0.00 and is excluded from the "accounts that hold value"
  count.

  ![Empty account](2026-09-01-net-worth-aggregation-audit/figures/51-empty-account.png)

* **An unpriced instrument** (a workplace plan trust with no ticker, manual price source): excluded
  from the total and **reported as excluded** on every screen — "Value is 379 of 380 holdings; 1 has
  never been priced and is left out rather than counted as zero." This is the classic silent
  undercount and the app does not commit it.

  ![Unpriced holding](2026-09-01-net-worth-aggregation-audit/figures/50-unpriced-account.png)

* **A closed account**: dropped from the household total by exactly its own value
  ($16,094,544.23 → $15,012,334.55, difference $1,082,209.68), removed from Holdings
  (388 → 378 rows), 404 on its own page, still listed in Settings as closed. (See finding 3 for the
  one place it is *not* dropped.)

  ![Closed account](2026-09-01-net-worth-aggregation-audit/figures/52-closed-account-row.png)

* **Unknown, malformed and zero-padded owner ids**: `?owner=999`, `?owner=0` and `?owner=abc` narrow
  to nothing rather than widening to the household; `?owner=00001` canonicalises to `?owner=1`;
  `?owner=` (empty) redirects to the bare address.
* **Negative positions**: four liabilities summing −$982,117.73 net correctly against assets in every
  breakdown, and the asset-class panel nets them against cash to −$585,573.33.
* **Pagination**: none exists, and none was needed — 383 rows render in one table. The two bounded
  displays (Overview's 5 allocation bars, the rings' 5 colours) each state their bound and neither
  affects a total.

### Repeated use and drift

* **5 identical price refreshes** through the app's own writer, holdings unchanged: net worth
  `16094544.2301` five times, byte-identical. `quote` and `price_daily` stayed at one row per
  instrument.
* **A +$1.00 bump on every price**: the total moved by $53,992.7479 against a summed quantity of
  53,992.74673169 — a $0.0012 difference over 372 independently-rounded products, which is
  arithmetic, not drift.
* **5 presses of "Refresh now" with the provider unreachable**: the total did not move, prices were
  kept rather than zeroed, and the screen said so ("Refresh failed — the price provider did not
  respond. Showing last known prices from 31 Aug").
* **42 screen reads** across 7 screens in 6 rounds, alternating between filtered and unfiltered:
  **0 unstable screens**. Every figure identical on every read.
* **16 price polls, 60 position sets, 730 stored holding rows** accumulated over the audit with no
  divergence appearing at any point. No discrepancy grew with cycles; none appeared and disappeared.

---

## Two things that look wrong and are not

**Displayed subtotals can miss the displayed total by one cent.** Each part is rounded to cents for
display; adding up 4 printed parts is not the same as printing the rounded whole. Nothing is computed
from a rounded figure — at the stored scale of 4 every partition sums exactly:

```
 whole         | owners        | kinds         | asset_classes | classifications | institutions
---------------+---------------+---------------+---------------+-----------------+---------------
 15017484.9456 | 15017484.9456 | 15017484.9456 | 15017484.9456 |   15017484.9456 | 15017484.9456
```

**Analysis shares sum to less than 100%.** With liabilities present, "Value by account type" reads
59.7 + 21.4 + 13.7 + 5.2 − 12.9. The positives sum to exactly 100% and the liability carries a
negative share, because a share is a share of *gross assets* — `allocateShares` in
[`app/lib/allocation.ts:143`](../../app/lib/allocation.ts) uses the gross positive total as its
denominator, and the Overview says so in words beside the bars.

---

## Why the suite is green anyway

`npm test` passes — 68 files, 1144 tests — with all three defects present, and `npm run typecheck`
and `npm run build` are clean. That is not a gap in rigour so much as a gap in reach:

* **Finding 1** lives between the socket and the loader. `tests/owner-filter.test.ts` holds the
  invariant that matters — the canonical spelling is a fixed point of `URL` round trips — and it
  still holds. What no test does is drive `?owner=1,2` through the *framework's* request handling,
  which is where the comma is lost. A single request-level assertion on any figure route would catch
  it.
* **Finding 2** needs three writes in sequence (upload → correct → upload) before it appears; the
  commit tests exercise one write against a known predecessor.
* **Finding 3** needs a closed account and a chart read *on the day of the close*. The as-of tests
  cover the rule each reader implements; nothing compares the two readers against each other on that
  one date.

All three are journey-shaped, and `tests/journeys/` is where a reproducing case for each would go.

---

## Reproducing this

```sh
docker compose -f compose.test.yaml up -d --wait     # or any Postgres
DATABASE_URL=… npm run migrate
npm run dev

python3 harness/gen_data.py                          # dataset + ground-truth ledger
node      harness/seed.mjs                           # seeds it through the real UI
node --env-file=.env harness/fake-refresh.mjs         # prices, through the app's own writer
node      harness/scrape.mjs ui.json                 # every figure the UI shows
python3   harness/verify.py ui.json                  # ledger -> database -> UI
node      harness/sweep.mjs                          # every filter, grouping, sort, owner slice
node      harness/drift.mjs                          # repeated reads and refreshes
python3   harness/recompute.py                       # independent valuation, no ledger
```

The three findings each have a standalone minimal reproduction:
[`repro-owner-loop.mjs`](2026-09-01-net-worth-aggregation-audit/harness/repro-owner-loop.mjs),
[`repro-silent-noop.mjs`](2026-09-01-net-worth-aggregation-audit/harness/repro-silent-noop.mjs), and
the closing sequence in
[`cycle5-close.mjs`](2026-09-01-net-worth-aggregation-audit/harness/cycle5-close.mjs).
