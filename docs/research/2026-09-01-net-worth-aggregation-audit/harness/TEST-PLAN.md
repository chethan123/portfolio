# Net-worth aggregation audit — test plan

Written before any data was generated, from the Step-1 reading of the code and a
click-through of the running app.

## What the app does (Step 1 findings that shape the plan)

* One process, server-rendered React Router 7, PostgreSQL. No API tier.
* **Account kinds:** `brokerage`, `401k`, `ira`, `bank`, `liability`. Accounts are
  *closed* (`closed_at`), never deleted. Closing is one-way in this version.
* **Holdings are not edited in place.** Every upload / balance / correction writes a
  new `position_set`; `latest_position_set(account_id[, date])` picks the one that
  counts. History is append-only.
* **Valuation is SQL.** `holding_valued` (current) and `holding_valued_at(d)`
  (historical) are the only definitions of a holding's worth:
  `value = round(quantity × price, 4)`, quantity `numeric(20,8)`, price
  `numeric(20,4)`. Current price comes from `quote` (live feed, overwritten in
  place); historical price is carried forward from `price_daily`.
* **Prices are live-fetched** from Yahoo by a background poller. Yahoo is
  unreachable from this sandbox, so the audit drives the application's own writer
  (`refreshQuotes`) with a deterministic fake `PriceProvider`
  (`audit/fake-refresh.ts`). No money column is written by hand: `quote`,
  `price_daily` and `price_observation` are all written by
  `app/lib/prices.server.ts` exactly as a live refresh would.
* **Single currency.** USD only; a non-USD quote is refused at the boundary.
* **Nothing paginates.** No LIMIT/OFFSET in `valuation.server.ts`; every table
  renders every row. The Overview allocation panel shows the 5 largest accounts and
  says so, and the breakdown rings fold rank ≥5 into one wedge while the table
  beside them still lists every slice.
* **Masking is on by default** — every amount renders `$••••••` until the `masked`
  cookie is `0`. The audit browser sets that cookie.

## Test data design

| Kind | Accounts | How seeded (real UI) |
|---|---|---|
| brokerage | 11 | CSV statement upload (4-step flow) |
| 401k | 6 | CSV statement upload |
| ira | 6 | CSV statement upload |
| bank | 8 | Set balance form on the account page |
| liability | 4 | Set balance form on the account page |
| **total** | **35** | (one brokerage deliberately left empty) |

* 3 people, accounts spread across all three.
* **220 distinct instruments**, drawn into the 22 securities accounts so most
  tickers appear in several accounts (aggregation across accounts is the thing
  under test). ~430 holding rows in total.
* Account values span **$11k to $1.9M**; two accounts are in the $1–2M band.
* Deliberate shapes: one account with exactly **1** holding; one with **40**;
  one **empty** account; fractional quantities carried to the full 8 decimal
  places, so every product needs rounding; liabilities that sum negative.

## Seeding (Step 3)

1. `audit/gen_data.py` writes `accounts.csv`, `holdings.csv`, one statement CSV per
   securities account, and `ledger.json` — the independent ground truth the app
   never touches.
2. `audit/seed.mjs` drives Playwright against the real UI: Settings → People,
   Settings → Accounts, then the four-step upload flow per securities account, then
   the Set balance form per bank/liability account.
3. Counts are reconciled after seeding: accounts visible in Settings → Accounts and
   holdings counted on `/holdings` must match the generated record counts. A
   mismatch is itself a finding.

## Ground truth and cross-reference (Step 4)

Three-way, at one moment:

1. **Ledger** — `ledger.json`: account → symbol → quantity, cost basis.
2. **Database** — direct SQL against `holding`, `position_set`, `quote`,
   `holding_valued`.
3. **UI** — figures scraped from `/`, `/holdings`, `/analysis`, `/income`,
   `/accounts/:id`.

Prices are captured in one synchronized pass (`quote.price` per instrument, plus
the price the UI shows per holding) and joined against the ledger to compute
expected per-account subtotals and the expected grand total. Expected value is
computed the way the storage layer computes it — `round(qty × price, 4)` per
holding, half-up, then summed — so a mismatch is a real disagreement, not a
rounding-model artefact.

Discrepancy thresholds: anything over **$0.01** on a per-account subtotal or the
grand total is a finding. Exact string equality is expected at scale 4 for
single-holding sums.

## Workflows, filters and views to validate (Step 5)

* Overview: headline net worth, per-account rows, allocation bars, chart.
* Holdings: grand total, every group-by (`owner`, `account`, `institution`,
  `kind`, `tax`, `classification`, `assetClass`), every filter dimension, every
  sort column and direction.
* Analysis: the four breakdown panels — by owner, account type, asset class,
  classification — each ring total against the Overview headline, and each panel's
  rows against the ledger.
* Income: annual dividend total and its two breakdowns.
* Account page: per-account total against the ledger and against the Overview row.
* Owner filter: each single owner, each pair, all three (which must redirect to the
  unfiltered URL); the three single-owner totals must sum to the household total.
* Edge cases: single-holding account, 40-holding account, empty account, closed
  account (excluded from current figures, included in history before its close
  date), an unpriced instrument.

## Repeated-usage / drift (Step 6)

Five cycles, re-verifying the full three-way reconciliation after each:

1. Baseline seed → verify.
2. Add accounts and holdings incrementally → verify.
3. Edit holding quantities through the row editor → verify.
4. Re-upload statements over existing accounts (new position sets on the same
   accounts) → verify that only the latest counts and nothing double-counts.
5. Close an account → verify exclusion; re-run the price refresh several times
   with prices unchanged, and again with prices bumped, checking the total does not
   drift when the underlying holdings have not changed.

Between cycles: reload each screen repeatedly and switch filters back and forth,
re-reading the headline each time, to catch caching or per-request drift.

## Calling a bug

* **Confirmed** — reproduced in a minimal case (fewest accounts/holdings/cycles
  that still shows it), localized to a layer by direct SQL, and traced to the
  responsible expression in the source.
* **Inconclusive** — a discrepancy observed but not reproduced in isolation, or
  whose root cause is not identified in code.

Layers a discrepancy is localized to: **write** (ledger vs stored rows),
**storage/computation** (stored rows vs SQL aggregate), **rendering** (SQL
aggregate vs what the screen prints).
