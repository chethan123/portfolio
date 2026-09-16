# Product QA audit — 2026-09-13

An end-user and adversarial review of Portfolio Tracker, with special attention to financial
correctness, actions whose effect is hard to reverse, mobile use, accessibility, and latency.
Nothing was fixed as part of this audit.

## Executive result

The application is polished and coherent in its ordinary read paths, but it is not ready to treat
the upload review as a financial safety boundary. Eight high-severity defects can make a recorded
statement differ from what the user believes they reviewed, silently omit a source row, attach a
security to the wrong instrument permanently, or leave an explicitly supported manual-price asset
impossible to value. A mutation-heavy follow-up also found that overlapping position corrections
can silently lose an accepted edit and that correction mode defeats amount masking.

- **0 critical, 8 high, 12 medium, 6 low findings.**
- Three of the upload defects were reproduced end to end in Chromium against the production build.
- Several are still-open versions of findings from the
  [2026-08-24 exploratory report](2026-08-24-exploratory-test-report.md): `ING-1`, `ING-4`,
  `ING-5`, `LEAD-4`, and `SET-15`.
- Main read screens were correct and responsive with the 18-holding demo household. No page-level
  horizontal overflow, uncaught browser error, or broken navigation was found.
- Empty-instance setup, ordinary masking, owner filtering, sequential position correction, balance entry, account
  management, passkey enrollment/lock/unlock, dark mode, and offline fallback all worked on their
  normal paths.

Severity here means: **Critical** — unrecoverable data loss/corruption or security compromise;
**High** — wrong financial state, a misleading safety-critical review, or a broken core workflow;
**Medium** — a material edge case, accessibility barrier, or failure needing a workaround;
**Low** — discoverability, terminology, or bounded robustness debt.

## Priority order

1. `QA-22` — serialize full-snapshot corrections so two accepted writes cannot lose one another.
2. `QA-01` — bind commit to the exact mapping/version the user reviewed.
3. `QA-02` — compare a backdated upload with its chronological predecessor, not today's holdings.
4. `QA-03` — never silently discard a row whose instrument cell is blank.
5. `QA-04` — make instrument aliases reviewable and repairable.
6. `QA-05` — either complete manual pricing or stop offering it.
7. `QA-23` — keep exact quantities and basis hidden while correction mode is masked.
8. `QA-06` — acknowledge successful historical writes and say whether current figures changed.

---

## High-severity findings

### QA-01 — A second tab can change the statement after Review

**Impact:** The commit can record quantities and cost bases that the user never saw on the review
screen. The commit-time removal guard is rebuilt from the changed mapping too, so it cannot detect
the mismatch. This breaks the upload flow's core promise that the last step shows exactly what will
be recorded.

**Steps to reproduce**

1. Upload a CSV to an account and map its columns.
2. Leave tab A on Review. In the reproduced case it showed one unchanged VTI row and `0 added · 0
   updated · 0 removed`.
3. Open the same draft's Columns URL in tab B.
4. Change Quantity from `Quantity` to `Cost Basis`, set Cost basis to `Not in this file`, and save.
5. Return to tab A without reloading and select **Record this statement**.
6. Open the account.

**Actual:** Tab A still showed no changes, but the account recorded VTI quantity `165.4961` instead
of `282.144455` and dropped its cost basis. The value fell from `$86,860.29` to `$50,949.22`.

**Expected:** Commit must be refused if the draft changed after the rendered review. The user must
review the new diff.

**Evidence:** [review shown in tab A](2026-09-13-product-qa-audit/figures/toctou-review-a.png) and
[different data recorded](2026-09-13-product-qa-audit/figures/toctou-committed-different-data.png).
The loader builds a diff at `app/routes/upload/review.tsx:29-44`; the form carries no revision or
digest at `app/routes/upload/review.tsx:267-345`; Columns overwrites the draft mapping without a
revision at `app/lib/uploads.server.ts:245-252`; commit rereads that mutable draft at
`app/lib/uploads.server.ts:644-668`.

**Recommendation:** Add an immutable draft revision or content hash covering raw file, mapping,
resolved aliases, and review date. Send it with the form and atomically compare it at commit. A
mismatch should render “This upload changed in another tab; review it again.”

### QA-02 — Backdated upload Review compares with the wrong statement

**Impact:** When inserting historical data, “before,” “updated,” “removed,” and the majority-removal
confirmation are computed against the newest statement rather than the statement in force
immediately before the chosen historical date. A user cannot audit what the backfill actually
changes in history.

**Steps to reproduce**

1. On the seeded demo, upload `tests/fixtures/statements/fidelity.csv` to **Fidelity Individual**.
2. Map Symbol → Instrument, Quantity → Quantity, Description → Name, Average Cost Basis → Cost
   basis, Account Number → Account number, and no as-of column.
3. Resolve FXAIX and continue to Review.
4. Enter `2026-07-31`, a date between the demo's June and September statements.
5. Inspect AAPL's “before” values and the removal count.

**Actual:** Review compared AAPL with the later 2026-09-09 statement (`139.153103` shares at
`$108.2561`) rather than the chronological predecessor from 2026-06-30 (`138.573298` shares at
`$107.9874`).

**Expected:** A historical statement should be compared with the latest position set whose date is
on or before the new statement's date, with same-date tie rules stated explicitly.

**Evidence:** The [backdated review](2026-09-13-product-qa-audit/figures/backdated-upload-review-mobile.png)
shows the reproduced workflow; the exact before-values above were verified against the rendered
row and seeded database records. `assembleDiff` explicitly reads what the account holds *now* at
`app/lib/uploads.server.ts:411-416,501-503`; the date is not parsed until later in commit at
`app/lib/uploads.server.ts:699-703`.

**Recommendation:** Resolve the proposed statement date before building the diff, query the
chronological predecessor, and use the same baseline for both Review and commit.

### QA-03 — Blank instrument cells silently become removals

**Impact:** A valid source row with quantity and cost basis but a blank mapped instrument is silently
discarded. If that holding existed previously, Review presents it only as a normal removal. The user
is never told that a source row vanished, which can turn an export quirk or mapping mistake into a
recorded sale.

**Steps to reproduce**

1. Use the seeded Fidelity Individual account, which currently has seven positions.
2. Upload a CSV with one valid VTI row and a second row containing AAPL's quantity and basis but a
   blank Instrument cell; leave the other five current positions absent.
3. Map the four columns and continue.
4. Observe that Columns visibly contains the second data row.
5. Observe Review.

**Actual:** The blank-instrument row disappears without a row-level warning. Review reports AAPL
and the other absent positions as Removed and allows commit after the ordinary majority-removal
checkbox.

**Expected:** Every non-empty data row excluded from the statement must be named on Review. A blank
instrument paired with financial data should be a blocking validation error, not an assumed footer.

**Evidence:** [source row on Columns](2026-09-13-product-qa-audit/figures/blank-instrument-columns.png)
and [silent removal on Review](2026-09-13-product-qa-audit/figures/blank-instrument-review.png).
The unconditional discard is `app/lib/statement.ts:263-267`; Review only reports the different
`skipped` collection at `app/routes/upload/review.tsx:168-174`.

**Recommendation:** Classify a blank instrument row as harmless only when every mapped financial
cell is empty. Otherwise block the draft and name the source line and populated cells.

### QA-04 — A wrong instrument match is permanent and has no UI repair path

**Impact:** Resolving an unfamiliar statement string to the wrong existing instrument immediately
creates a global alias. This happens before statement commit and survives abandoning the upload.
Every future occurrence skips New instruments and is valued as the wrong security. There is no
instrument or alias management screen to correct it.

**Steps to reproduce**

1. Upload a statement containing a previously unseen raw instrument string, for example `QAALIAS`.
2. On New instruments, choose **This is an instrument already listed** and select VTI.
3. Continue to Review, then abandon the upload without recording it.
4. Start a new upload containing `QAALIAS`.

**Actual:** The second upload says **New instruments · none** and treats `QAALIAS` as VTI. In the
reproduced review it proposed changing VTI to one share at a `$10.0000` basis.

**Expected:** An abandoned draft should not make an unreviewable permanent classification, or the
application must provide a safe way to inspect and repair aliases.

**Evidence:** [second upload silently uses the wrong alias](2026-09-13-product-qa-audit/figures/persistent-wrong-alias-review.png).
Resolution is committed at `app/routes/upload/instruments.tsx:64-92` and
`app/lib/instrument-resolution.server.ts:511-535`; future drafts skip resolution at
`app/lib/uploads.server.ts:276-297`; `app/routes.ts` exposes no instrument/alias maintenance route.

**Recommendation:** Prefer draft-scoped pending aliases promoted atomically with statement commit.
Independently add an Instruments screen that lists raw aliases, their target, usage impact, and a
guarded reassignment workflow that previews affected holdings.

### QA-05 — Manual-price instruments can be created but cannot be priced

**Impact:** The supported path for collective investment trusts and similar assets is a dead end.
The instrument can be created and held, but remains excluded from net worth, allocation, analysis,
and income indefinitely.

**Steps to reproduce**

1. Upload an unfamiliar workplace-plan holding with no public symbol.
2. Select **This is new** and **Manual price**.
3. Commit the statement.
4. Visit Settings → Prices and use Refresh now.

**Actual:** New instruments says “A manual price is typed from the statement and carries forward,”
but the mapping has no price column and the form has no price input. Settings lists the holding as
“priced by hand” but offers only refresh cadence. Feed refresh intentionally excludes it.

**Expected:** The user must be able to enter a dated manual price, see the resulting valuation, and
later update it while retaining history.

**Evidence:** [Settings has no manual-price control](2026-09-13-product-qa-audit/figures/manual-price-no-control.png).
The false affordance is at `app/routes/upload/instruments.tsx:247-270`; the mapping shape has no
price field at `app/lib/statement.ts:24-42`; creation stores only `price_source` at
`app/lib/instrument-resolution.server.ts:494-506`; refresh selects feed instruments only at
`app/lib/prices.server.ts:81-88`.

**Recommendation:** Either ship dated manual quote entry/edit history before exposing this option,
or label the workflow unavailable and block manual instrument creation.

### QA-06 — Successful backdated writes look unsuccessful

**Impact:** A historical statement or balance is stored but the landing page continues to show the
newer current state and omits the success receipt. Users can reasonably retry, creating more
same-date position sets, or conclude that history was not imported.

**Steps to reproduce — balance**

1. Record a balance dated today.
2. Record a different balance dated yesterday.
3. Observe the redirect URL contains `?recorded=<yesterday>`.

**Actual:** The account still shows today's balance, which is correct, but there is no “Recorded”
status and no statement that the historical value was saved.

**Steps to reproduce — upload**

1. Commit a statement older than the account's current statement.
2. Observe the redirect contains the new position-set ID.

**Actual:** The account shows the current statement and no upload receipt even though the historical
position set exists in the database.

**Expected:** Confirm the write, name its date, and state that current holdings are unchanged because
a newer record exists. Link to the relevant date/range if possible.

**Evidence:** [backdated balance with no receipt](2026-09-13-product-qa-audit/figures/backdated-balance-no-confirmation-mobile.png)
and [backdated upload landing](2026-09-13-product-qa-audit/figures/backdated-upload-no-confirmation-mobile.png).
Balance success is coupled to `lastRecorded` at `app/routes/account.tsx:90-98,134-135`; its status is
rendered only when the submitted date is still newest at `app/routes/account.tsx:511-524`. Upload
receipt lookup is also requested at `app/routes/account.tsx:92-98`, while
`app/lib/uploads.server.ts:810-823` explicitly returns no receipt unless that uploaded set is the
latest.

**Recommendation:** Look up receipts by the written row ID, not by whether the row became current.
Use distinct copy for “recorded as current” and “recorded in history; current value remains …”.

---

## Medium-severity findings

### QA-07 — Ambiguous punctuation is silently deleted from numbers

**Impact:** `1,5` becomes `$15.00`, and the same text becomes a 15% tax rate. This is a plausible
locale-style decimal or mistyped thousands separator, so silently changing it produces wrong money.

**Reproduction:** Enter `1,5` in a bank balance and submit. The account is recorded as `$15.00`.

**Evidence:** [stored as $15.00](2026-09-13-product-qa-audit/figures/ambiguous-number-parsed-as-15-mobile.png).
`bareDecimal` deletes all commas/spaces at `app/lib/input.server.ts:84-94`; balance and percentage
schemas then accept the result at `app/lib/input.server.ts:96-121,245-264`.

**Recommendation:** Accept only valid grouping (`1,234`, `12,345.67`) or an ungrouped decimal.
Reject ambiguous forms and show the interpreted value before any financial write.

### QA-08 — Historical charts discard valuation coverage

**Impact:** A partially priced day is drawn as an ordinary exact net-worth point. Changes in price
coverage can look like gains or losses, especially for manually priced or newly backfilled assets.

**Reproduction:** View a range that spans dates before an instrument has a usable price. Hover the
line. The point has no coverage annotation or gap, although the query knows how many holdings were
priced that day.

**Evidence:** `app/lib/valuation.server.ts:338-372` computes coverage for each point, then
`app/lib/chart-series.server.ts:57-64` maps it away before rendering.

**Recommendation:** Preserve coverage in `ChartPoint`; mark partial points/segments and expose
“priced X of Y holdings” in the readout. Consider gaps when coverage changes materially.

### QA-09 — Refresh now can block one request for several minutes

**Impact:** The button can remain disabled with “Refreshing…” while one HTTP request waits for a
quote request and up to five sequential history backfills. A slow provider or proxy makes the app
feel hung and risks proxy/browser timeouts.

**Reproduction:** Use a provider that times out for quotes and for five history candidates without
classifying the failures as `ProviderUnreachable`, then select Refresh now.

**Evidence:** `app/routes/refresh.ts:13-25` awaits the entire refresh; backfills are sequential at
`app/lib/prices.server.ts:287-315`; the batch size is five at
`app/lib/prices.server.ts:27-31,122-158`; provider timeouts are 15 seconds for quotes and 35 seconds
for history in `app/lib/provider-socket.server.ts:30-37`. The upper path is roughly 190 seconds
before database overhead. A `ProviderUnreachable` aborts earlier; the long path requires timeout or
other provider errors that are recorded and continued.

**Recommendation:** Enqueue refresh and return immediately with durable status, or cap the user
request and continue work in the poller. If the provider permits it, use a small bounded concurrency
for history.

### QA-10 — Mobile Review hides cost basis and value without a cue

**Impact:** At 390 px, Instrument and part of Quantity are visible; Cost basis and Value sit off the
right edge inside the table scroller. There is no persistent scrollbar, fade, “swipe for values”
hint, or sticky summary. A user can approve a safety-critical diff without noticing those columns.

**Reproduction:** Reach Upload → Review at 390×844 and inspect the table before swiping sideways.

**Evidence:** [mobile upload review](2026-09-13-product-qa-audit/figures/backdated-upload-review-mobile.png).

**Recommendation:** Reflow diff rows to cards on phones, as Holdings already does. At minimum keep
quantity/value visible and add a persistent horizontal-overflow affordance.

### QA-11 — Successful Add person/account leaves the completed form populated

**Impact:** After creation, the new record appears but the add form still contains every submitted
value. A second tap creates a duplicate. Duplicate people are legal by design, so the app cannot
distinguish an intentional namesake from an accidental double submission.

**Steps to reproduce**

1. On Settings → People, enter `Morgan QA` and select Add person.
2. Observe both the new row and `Morgan QA` still in the Add a person input.
3. Repeat with a complete Add account form; all fields remain selected.

**Evidence:** [person form retained](2026-09-13-product-qa-audit/figures/add-person-form-not-cleared-mobile.png)
and [account form retained](2026-09-13-product-qa-audit/figures/add-account-form-not-cleared-mobile.png).
Both actions return `null` without a redirect at `app/routes/settings/people.tsx:17-37` and
`app/routes/settings/accounts.tsx:29-35`; their uncontrolled inputs remain mounted.

**Recommendation:** Use post/redirect/get after successful creation or reset/key the form from the
created record. Disable repeat submission until the navigation completes.

### QA-12 — Chart history is unavailable to keyboard and screen-reader users

**Impact:** Pointer/touch users can inspect every historical point. Keyboard and screen-reader users
only receive the chart label and final point, so they cannot inspect past values.

**Reproduction:** Focus the chart using only Tab or read it with accessibility output. Earlier point
hit targets are never reachable.

**Evidence:** The SVG's accessible label contains only the ending point at
`app/components/net-worth-chart.tsx:238-274`; all point targets are `aria-hidden` and `tabIndex=-1`
at `app/components/net-worth-chart.tsx:332-350`.

**Recommendation:** Add a visually hidden data table/download-like textual history, or implement a
keyboard roving point with date/value/coverage announcements.

### QA-13 — Oversized numeric route IDs return 500

**Impact:** A malformed bookmark such as `/settings/accounts/99999999999999999999` reaches a
PostgreSQL bigint cast and renders the generic error page instead of 404. This is a robustness and
log-noise issue across several ID-bearing routes and mutation forms.

**Reproduction:** Request `/settings/accounts/99999999999999999999`; response status is 500 with
Postgres `value is out of range for type bigint` in development logs.

**Evidence:** `app/lib/accounts.server.ts:121-130` checks digits only; drafts do the same at
`app/lib/uploads.server.ts:153-179`. A bounded helper already exists in
`app/lib/valuation.server.ts:228-245`.

**Recommendation:** Centralize a positive-bigint ID schema and use it before every database query.

### QA-14 — Mobile account metadata is hidden in a wide table

**Impact:** Settings → Accounts initially shows Account, Institution, Kind, and a clipped Owner.
Tax treatment and status require an undisclosed horizontal swipe, yet they are the attributes most
important to verify before editing financial data.

**Evidence:** [mobile accounts table](2026-09-13-product-qa-audit/figures/accounts-table-mobile.png).

**Recommendation:** Reflow accounts into cards at the mobile breakpoint, or keep Owner, tax
treatment, and status in the first visible columns with an overflow cue.

### QA-15 — Holdings has an unbounded payload/DOM growth path

**Impact:** Current demo performance is good, but the route fetches and renders the entire household
and can do a second full read for owner filtering. Households with many current positions degrade
linearly.

**Evidence:** The route reads all holdings and applies filters/sort/groups in process at
`app/routes/holdings.tsx:86-131`, then renders every row at `app/routes/holdings.tsx:328-377`.
The prior audit measured 1,038 holdings as a 2.2 MB response with 26,995 DOM nodes and about 2.6
seconds to browser load.

**Recommendation:** Establish a supported ceiling. Beyond it, paginate/virtualize and push filtering
and sorting into the query while preserving totals separately.

---

## Low-severity findings and UX improvements

### QA-16 — Liability-sign control appears on every account type

The Fidelity brokerage mapping screen says “This file lists what is owed on Fidelity Individual as
a positive number.” It is confusing on brokerages, retirement accounts, and banks, and an accidental
tick negates every quantity. The control is always rendered at
`app/routes/upload/columns.tsx:393-431`. Show it only for liability accounts; give bank overdrafts a
separate advanced sign policy if needed.

### QA-17 — New-instrument symbol is not prefilled

When the mapped instrument cell is a ticker such as `FXAIX`, selecting **This is new** leaves Symbol
blank even though Name is prefilled. Retyping increases friction and typo risk. The Symbol input
defaults to an empty string at `app/routes/upload/instruments.tsx:214-220`, while Name falls back to
the parsed item at `app/routes/upload/instruments.tsx:228-239`. Prefill symbol when the source value
passes the existing symbol pattern, but keep it editable and never silently assume.

### QA-18 — “Brokerage” is used for institution

Holdings has both a **Brokerage** filter whose options include Ally Bank and Chase, and an **Account
type** filter whose options include Brokerage. The terminology is documented but remains easy to
misread. `app/lib/holdings-view.ts:90-96` names the institution dimension “Brokerage.” Rename the
facet **Institution** to match Settings and account detail.

### QA-19 — Horizontal control strips lack overflow affordance on phones

The Overview range strip initially ends around 1Y and the Holdings group-by strip around Brokerage;
more options require a horizontal swipe with no persistent cue. Add edge fade/partial next chip,
scroll buttons for keyboard use, or wrap the small set.

### QA-20 — Visually blank Unicode names are accepted

Person, account, instrument, and classification names containing only zero-width format characters
pass trim-only blank checks, creating invisible labels. Person and account names use
`app/lib/input.server.ts:38-44` via `app/lib/people.server.ts:31-33` and
`app/lib/accounts.server.ts:46-48`; instrument and classification names have equivalent checks at
`app/lib/instrument-resolution.server.ts:233-243,269-282`. Reject control/format-only values after
Unicode normalization.

### QA-21 — Closed-account errors prescribe an impossible recovery

If an account is closed in another tab while an upload, position correction, or balance form is
open, submission is correctly refused—but the error says to “Reopen it from Settings.” Settings
explicitly says closure cannot be undone and exposes no reopen control. The refusal text appears at
`app/lib/balances.server.ts:87-92`, `app/lib/positions.server.ts:151-156`, and
`app/lib/uploads.server.ts:126-130,652-657`; the account screen's irreversible behavior is at
`app/routes/settings/account.tsx:109-140`. Replace the advice with an achievable recovery path, or
add a guarded reopen capability if closure is intended to be reversible.

---

## Mutation-heavy position follow-up

This follow-up was requested after the initial audit. Finding IDs were appended so the original
references remain stable.

### QA-22 — Concurrent corrections can both succeed while one edit is lost — High

**Impact:** Each correction writes a complete replacement snapshot for its account. When two
different holdings in one account are corrected at nearly the same time, both requests can report
success while the later winning snapshot carries the earlier value for the other holding. This is
silent loss of accepted financial data.

**Steps to reproduce**

1. Open two different Fidelity Individual holdings for correction in separate tabs.
2. Enter a new quantity in each tab.
3. Submit both forms at nearly the same time.
4. Follow both success redirects, then reload Holdings or the account.

**Actual:** Both production HTTP requests returned success redirects in every one of 25 rounds, but
one submitted correction was absent from the current snapshot in 22 rounds. The first loss submitted
`NATX=1002` and `NATY=2002`; current state was `NATX=1001`, `NATY=2002`.

**Expected:** Either both changes survive, or one request is refused as stale and asks the user to
review the newer account state.

**Evidence:** The [25-round ledger](2026-09-13-product-qa-audit/harness/concurrent-position-corrections-ledger.json)
records all 50 success redirects and every winning state; the reusable
[race harness](2026-09-13-product-qa-audit/harness/concurrent-position-corrections.mjs) uses no
delay, trigger, application import, or server instrumentation. `revisePosition` pre-reads current
state at `app/lib/positions.server.ts:149-165`, then
each write independently selects `latest_position_set` at `app/lib/positions.server.ts:220-230` and
copies that entire snapshot at `app/lib/positions.server.ts:238-249`. There is no expected-source
comparison or account lock. Same-date winners are selected by creation time and ID at
`migrations/0002_holding_valued.sql:5-16`; the route redirects after either fulfilled write at
`app/routes/holdings.tsx:153-169`. This also disproves the concurrency guarantee at
`ARCHITECTURE.md:1515-1522,1578-1579`.

**Recommendation:** Serialize all position-set writers per account inside a transaction, or submit
the reviewed source-set ID and atomically reject/retry/merge if it is no longer current. The same
coordination must cover uploads, balance writes, corrections, and closure.

### QA-23 — Masked correction mode exposes exact quantities and basis — High

**Impact:** A user can deliberately mask every amount for shoulder-surfing, then expose exact share
quantity and per-share basis merely by opening the normal correction workflow. The control still
says **Show amounts**, so there is no indication that the privacy posture changed.

**Steps to reproduce**

1. Select **Hide amounts**.
2. Open Holdings and verify rows use fixed dot runs.
3. Select Correct on a holding.

**Actual:** The edited VTI row exposed `1.00000001` and `100.0001` in plain text while all surrounding
figures remained masked.

**Expected:** Exact financial inputs should remain hidden until the user explicitly unmasks, or
correction should require a deliberate reveal with clear copy.

**Evidence:** [masked correction inputs](2026-09-13-product-qa-audit/figures/position-masked-editor-leak.png).
The ordinary cells use the masking-aware `Amount`, while the raw defaults are placed directly into
inputs at `app/routes/holdings.tsx:727-731,761-806`.

**Regression harness:**
[`masked-correction-toggle-race.mjs`](2026-09-13-product-qa-audit/harness/masked-correction-toggle-race.mjs)
holds overlapping Show/Hide loader responses in the unsafe order and separately fails a Hide request;
correction inputs must remain absent in both cases.
[`masked-correction-cross-tab.mjs`](2026-09-13-product-qa-audit/harness/masked-correction-cross-tab.mjs)
checks that Hide reaches another open editor, sibling Show stays behind its local reveal gate, and
older Show or Display Settings responses cannot replace the newer shared cookie.

**Recommendation:** Gate editor values behind the same masking state. A focused reveal can be scoped
to that row, but it must be intentional, announced, and automatically re-hidden when correction
ends.

### QA-24 — An accepted large position makes Overview return 500 — Medium

**Impact:** A quantity that passes every correction guard and renders correctly in Holdings can make
the household's main page unavailable. A paste or extra digits can leave Overview broken until the
user knows to navigate directly to Holdings and correct it.

**Steps to reproduce**

1. Correct VTI in Fidelity Individual to quantity `25000000` with basis `165.4961`.
2. Save successfully.
3. Open Overview, then compare Holdings, Analysis, Income, and the account page.

**Actual:** Household Overview and Alex-filtered Overview return 500. Jordan's unaffected Overview,
Holdings, Analysis, Income, and Fidelity account detail remain 200; account detail shows
`$7,696,563,705.81`.

**Expected:** Every accepted position must remain readable on every money screen. An extreme change
percentage can be displayed with a wider type, capped for presentation, or omitted with an explicit
message; it must not fail the route.

**Evidence:** [Overview error page](2026-09-13-product-qa-audit/figures/position-large-value-overview-500.png),
[route sweep](2026-09-13-product-qa-audit/harness/large-position-route-sweep.json), and its
[reusable harness](2026-09-13-product-qa-audit/harness/large-position-route-sweep.mjs).
The write guards products against `numeric(20,4)` overflow at
`app/lib/positions.server.ts:168-214`, but Overview narrows percentage change to
`numeric(10,4)` at `app/lib/valuation.server.ts:570-606`. PostgreSQL reported that the percentage
must be below `10^6`.

**Recommendation:** Do not narrow a derived percentage below the range permitted by accepted
inputs. Add a route-level regression using a large but valid current value and a much smaller prior
value.

### QA-25 — A correction can race account closure — Medium

**Impact:** Code inspection confirms that a correction started just before account closure can be
committed after the account is closed. Both actions can report success. Current holdings then hide
the closed account while historical data contains the post-close mutation, contradicting the rule
that closed history does not change.

**Reproduction:** Begin a position correction, then close the same account from another tab while
the correction is in flight. In the deterministic reproduction, a test-only 750 ms insert delay
widened the real race and closure was submitted 150 ms after correction began.

**Observed with widened timing:** Both actions returned success; the account ended closed and a new
manual snapshot with the corrected quantity existed. This establishes the race window, not its
natural frequency in ordinary use.

**Expected:** The actions must have a defined order. If closure wins, the correction must refuse; if
correction wins, closure may proceed only after it is part of the account's final history.

**Evidence:** The [captured schedules](2026-09-13-product-qa-audit/harness/close-vs-correction-race-ledger.json)
include both a simultaneous refusal and the widened race above. The reusable
[harness](2026-09-13-product-qa-audit/harness/close-vs-correction-race.mjs) requires an explicit
isolated-database acknowledgement, discloses its temporary trigger, and removes it afterward.
Closed state is checked only before writing at `app/lib/positions.server.ts:149-157`.
The SQL at `app/lib/positions.server.ts:220-250` neither locks the account nor rechecks
`closed_at`; closure independently reads and updates at `app/lib/accounts.server.ts:238-259`.
`ARCHITECTURE.md:1581` overstates the current guarantee.

**Recommendation:** Solve this under the same per-account serialization/version boundary as
`QA-22`, and keep a `closed_at is null` predicate inside the guarded write.

### QA-26 — The 1D change chip can report a large loss beside a rising chart — Medium

**Impact:** After same-day corrections, two colocated performance signals can point in opposite
directions. A user sees a sharply rising intraday line beside a red loss chip and cannot tell which
describes investment performance.

**Actual reproduction:** The headline was `$62,948.45`; the chip reported `−90.9% / −$629,629.62`.
The plotted line rose from `$62,503.95` to `$62,948.45`, a gain of `$444.50` or about 0.71%.

**Evidence:** [contradictory 1D screen](2026-09-13-product-qa-audit/figures/position-1d-contradiction.png).
This is an explicitly accepted limitation in `DESIGN.md` §14.2 rather than an accidental mismatch:
the chip compares current holdings with the previous session close, while the 1D line holds current
quantities constant across the session.

**Recommendation:** Label the chip as change since previous close including position changes, and
the chart as market movement at current quantities; preferably calculate both from a shared
performance definition.

### Follow-up method and reconciliation result

- **93 successful position corrections through the production UI** across three isolated databases:
  32 in the primary exact-decimal campaign, 31 in a separate mechanical pass, and 30 in an
  independent financial-invariant pass.
- **25 concurrent two-write rounds** exercised the lost-update boundary in `QA-22`.
- Inputs covered positive, zero, and negative quantities; the explicit zero bridge for sign changes;
  eight-decimal fractions; very small and very large values; set/zero/cleared basis; fixed-price
  cash; stale prices; an unpriced trust; both owners; and all six accounts.
- After every primary state, raw latest holdings and quotes were recomputed with an independent
  BigInt fixed-point oracle—not `holding_valued` or application arithmetic—and compared with
  Holdings value/basis/gain/dividend, Overview, and account detail. Owner-scoped Holdings,
  Overview, and Income were checked every fifth state.
- Apart from `QA-22`'s overlapping writes and `QA-24`'s Overview percentage, **no sequential value,
  basis, gain/loss, dividend/income, owner, account-detail, or tested rounding discrepancy was
  found on the arithmetic surfaces recorded in the linked ledgers**.
- Evidence: [primary ledger](2026-09-13-product-qa-audit/harness/position-mutation-ledger.json),
  [independent ledger](2026-09-13-product-qa-audit/harness/independent-position-mutation-ledger.jsonl),
  and [mechanical ledger](2026-09-13-product-qa-audit/harness/mechanical-position-mutation-ledger.json).
  The reusable primary harness is
  [position-mutation-campaign.mjs](2026-09-13-product-qa-audit/harness/position-mutation-campaign.mjs).

Final reconciled views: [Analysis](2026-09-13-product-qa-audit/figures/position-campaign-final-analysis.png),
[owner-filtered Holdings](2026-09-13-product-qa-audit/figures/position-campaign-final-filtered.png),
and [restored primary Holdings](2026-09-13-product-qa-audit/figures/position-campaign-final-holdings.png).

---

## Performance observations

Measurements used the production build on Node 24.21.0 and Postgres 17, local loopback, with a fresh
browser context per page. They are directional, not WAN benchmarks.

- Server TTFB after warm-up: Overview 176 ms in Chromium; Holdings 32 ms; Analysis 29 ms; Income
  24 ms; Settings → Prices 21 ms; Upload 18 ms.
- Browser `load`: Overview 357 ms; Holdings 192 ms; Analysis 200 ms; Income 136 ms; Settings →
  Prices 125 ms; Upload 128 ms.
- Network-idle wall time ranged from 699 to 957 ms, dominated by the wait heuristic rather than
  visible work.
- Downloaded HTML via curl: Overview 107 KB; Holdings 80 KB; Analysis 40 KB; Income 25 KB.
- No document-level horizontal overflow was found across 24 light-mode desktop/mobile route checks.
- The demo Holdings page rendered 810 elements and 63 SVGs on mobile. It was responsive at 18
  holdings; `QA-15` is a growth risk, not a current demo regression.
- A Vite-only optimized-dependency 504 occurred during initial development-server warm-up. It did
  not reproduce in the production build and is not counted as a product finding.

## Workflow coverage

**Completed in Chromium**

- First run: empty Overview, no-people Accounts refusal, add person, add account, setup prompt exit.
- Overview: mask/unmask, owner selection, representative chart presets, custom form, and account navigation.
- Holdings: all filters, grouping/sort URLs, desktop and mobile layout, edit/cancel, and invalid input.
- Analysis and Income: household and owner-scoped totals, missing-price/basis messaging, desktop and
  phone layouts.
- Account detail: all five account kinds, missing-price state, balance validation, current and
  backdated balance writes, 404 handling.
- Upload: empty/invalid entry, mapping, saved mapping, new and existing instrument resolution,
  review, removal confirmation, commit, abandoned draft, backdated commit, and two-tab mutation.
- Settings: People, Accounts, Tax, Prices, Display, Passkeys; create/edit/refusal/close paths where
  applicable.
- Security display controls: masking persistence; WebAuthn passkey enrollment; another browser
  becoming locked; Lock now; successful unlock with the enrolled credential.
- PWA/theme: light and dark rendering; service-worker control; offline reload and retry page.

Normal lock flow evidence: [passkey enrolled](2026-09-13-product-qa-audit/figures/passkey-enrolled-mobile.png),
[new browser locked](2026-09-13-product-qa-audit/figures/locked-mobile.png), and
[offline fallback](2026-09-13-product-qa-audit/figures/offline-mobile.png).

**Not completed**

- Google's external OAuth gate and allowlist, because the local audit intentionally used
  `AUTH_GATE=none`.
- A live Yahoo quote refresh through the production worker/proxy. Provider-down rendering and the
  server path were inspected; the real external dependency was not exercised.
- Screen-reader testing with VoiceOver/NVDA. Accessibility conclusions are based on keyboard and
  accessibility-tree/markup inspection.
- Real iOS/Android hardware and install banners; phone behavior used Chromium emulation.

## Verification gates

- `npm run typecheck` — passed.
- `npm run build` — passed.
- `npm test` — **96 files passed, 1,931 tests passed**, 94.14 seconds, isolated database.
- Production route sweep — all tested routes returned 200; intentional unknown account returned
  404; oversized bigint route reproduced the 500 in `QA-13`.
- Console/page errors — none on the final production route sweep. The offline service worker's
  intentional 503 response logs a failed-resource message, as expected.

## Test environment

- Source checkout: `/home/ubuntu/wspace/cld/portfolio` as present on 2026-09-13.
- Runtime: production React Router build, Node 24.21.0, Playwright/Chromium 1.62.1, Postgres 17.
- Data: pristine and seeded demo databases created solely for this audit; all destructive writes
  were isolated from the checkout's existing development/test databases.
- Viewports: 1440×900/1000 desktop and 390×844/900 phone; light and dark color schemes.
