# Upload UX review — the statement workflow, walked as a household

A task-centred usability review of the statement upload workflow, done by standing up an empty
instance and using it: two people, four accounts, a statement in each, then the quarter after. It is
deliberately **not** a second defect hunt — [the exploratory test
pass](./2026-08-24-exploratory-test-report.md) already attacked this flow and filed eleven ingest
findings. Where an observation here lands on one of those, it cites the id rather than re-filing it.

Followed by [broker header aliases](./2026-08-25-broker-header-aliases.md), which answers the
*matched how?* that `UX-4` raises and turns out to settle part of `UX-5`, `UX-6` and `UX-10` as well.
Where that document changes what a finding recommends, the finding says so in place.

Reviewed against `410a61f`. Thirteen findings, all open. Eleven are new; two — `UX-3` and `UX-6` —
disagree with a behaviour the earlier pass investigated and cleared, and say so in place rather than
filing it as a discovery.

## Start here — the four that matter

1. **[UX-1] Adding a second account silently copies the first one's owner, kind, tax treatment and
   account number.** The add form keeps every value after a *successful* add — the action returns
   `null` precisely so the fields reset, and uncontrolled inputs do not reset on a re-render. A
   household adding four accounts in one sitting can file three of them under the wrong person and
   the wrong tax treatment without touching a control. This is the one that loses money quietly:
   tax treatment is the taxable/sheltered split every other screen reads.

2. **[UX-11] A first run done at a weekend ends at a net worth of `$0.00`.** The poller has no
   immediate first tick — deliberately — and returns early whenever the market is shut, so a
   household that sits down on a Sunday evening, which is when this gets done, finishes a correct
   onboarding and is shown a headline of `$0.00` over four accounts of `$0.00` until Monday morning.
   Roughly sixty-five hours, on a screen whose own design rule is that a zero is a claim.

3. **[UX-4] There is no column auto-detection of any kind.** Every control in `COLUMN_CONTROLS`
   (`app/routes/upload/columns.tsx:43-50`) opens on the placeholder for each new institution, against
   a header that says `Symbol`, `Quantity` and `Description`. The design record forbids *skipping* the columns screen; it does not forbid
   arriving with a proposal on it. This is the largest single saving available on day one and the
   only finding here that would change what the reader does most often.

4. **[UX-5] Getting one radio button wrong records a cost basis fifty times too large, and nothing
   on the way past remarks on it.**
   The repo's own `schwab.csv` states a cost basis as a position total; the control defaults to per
   share; nothing on either screen says which this file is, and the resulting `$8,533.0000` per
   share sits under a heading reading *cost basis / share* against a share that costs `$229.35`.

## What this cost, measured

Counted on the walk, from a migrated and unseeded instance to four recorded statements. An
*interaction* is one control decided: a click, a select, a field typed, a file chosen, a box ticked.

| Stage | Screens | Interactions |
|---|---|---|
| Two people, four accounts | 6 | 32 |
| `fidelity.csv` → brokerage | 8 | 39 |
| `401k.csv` → workplace plan | 8 | 29 |
| `schwab.csv` → brokerage | 6 | 13 |
| `liability.csv` → loan | 8 | 17 |
| **Day one, total** | **36** | **130** |
| The same account, the quarter after | 6 | 11 |

Two things that table does not include, and both are real: the two mappings that were refused and
redone before one was accepted (UX-6, and `401k.csv` mapped the obvious way — `ING-4`), and the
eight abandoned drafts the walk left behind, which no screen lists (UX-12).

The last row is the good news and deserves saying plainly: **a repeat upload asks almost nothing.**
Every column choice and the header row come back filled from the previous statement, the
instruments step dims to *· none* when the file raises no new name, and the whole flow is one
confirming click per screen ([`07-columns-mapping-remembered.png`](./upload-ux-2026-08/07-columns-mapping-remembered.png)). The design intent — map once per institution, resolve a name once
forever — holds, and the never-skipped columns screen costs one glance rather than one decision.

## Method, and what would change a conclusion

An empty database, migrations applied, nothing seeded — so exactly one classification (`Cash`) and
one instrument (`USD`) exist, which is what a real first run faces. The corpus is
`tests/fixtures/statements/`, the repo's own six files, rather than anything hand-authored; only the
next-quarter statement in pass B was written, because no fixture provides a second statement to diff
against. Driven with Playwright against the real application.

Two environment caveats, stated because they bound two findings:

- **Postgres 16, not the 17 `compose.yaml` pins.** The container registry is unreachable from this
  sandbox. Nothing in `migrations/` uses a post-16 construct — the only version-sensitive one is
  `bigint generated always as identity` — so this changes nothing. The exploratory pass reached the
  same conclusion.
- **The price feed is unreachable from this sandbox.** That alone would produce unpriced holdings,
  so UX-9 and UX-11 are argued from the poller's code rather than from the empty columns on screen:
  `startPricePoller` installs a `setInterval` and no immediate tick
  (`app/lib/price-poller.server.ts:154-170`), and `tick` returns early when the market is shut
  (`:84`), which `isMarketOpen` reports for Saturday and Sunday (`app/lib/market-hours.ts:142`).
  Those two lines are what make the finding, not the sandbox.

## The design record already refuses much of what a UX review would propose

Read before proposing anything: [`../design/ingest-ui-brief.md`](../design/ingest-ui-brief.md) §9 is
a numbered list of prohibitions, and this review takes every one of them as binding. Never auto-select the account
from the file; never skip the columns screen even when prefilled; no client state and no
unsaved-changes warning; no progress bar or spinner; no toast or modal; no editing figures on the
review screen; the step count never changes; no drag-and-drop dependency. DESIGN.md §11 refuses
mobile layout investment for this flow specifically.

No finding below asks for any of those; each recommendation was checked against the list clause by
clause. Two are worth naming because the check is not obvious. UX-4 keeps the columns screen, its
provenance sentence and its manual submit — §9.5 forbids *skipping* the screen and expressly sanctions
a mapping that "fills the controls" without passing the step. UX-12's discard control is a
server-side POST, so it is none of the things §9.10 forbids; it is a write before the commit, which
§9.6 speaks to, and the answer there is that `upload_draft` is the flow's own scratch table rather
than a domain one — worth confirming with the owner rather than assuming.

Three frictions were confirmed as **deliberate, and are not findings**: a refusal on the drop screen
always costs the file pick, because a browser will not refill a file input; changing the header row
discards unsaved column choices, which is why that control sits above the ones it resets; and a
reordered export costs one full re-map, which was chosen over a mapping that silently follows a
column that moved.

## Every finding, most severe first

| Severity | Id | Finding |
|---|---|---|
| High | `UX-1` | The add-account form keeps every value after a successful add, so the next account silently inherits owner, kind, tax treatment and account number |
| High | `UX-5` | The cost-basis per-share/total default records a fifty-fold wrong basis, printed but unremarked, with no guard that catches it |
| High | `UX-11` | A correct first run ends at `$0.00` net worth, and stays there for up to a weekend |
| Medium | `UX-4` | No column auto-detection at all — every control opens on a placeholder against a header that names its own columns |
| Medium | `UX-6` | When the instrument column *is* the fund name, the obvious mapping is refused and the workaround is unobvious |
| Medium | `UX-8` | A first run has one classification, so every equity forces an invent-a-category decision mid-upload |
| Medium | `UX-9` | The review screen — the flow's safety valve — carries no money on a first upload |
| Medium | `UX-10` | The statement date defaults to today while the file's own date is displayed two controls away |
| Medium | `UX-12` | Abandoned drafts are invisible, uncancellable, and swept only by someone else's next upload |
| Low | `UX-2` | Nothing says the account number is a commit-time guard; the field's own note says the opposite |
| Low | `UX-3` | A text file that is not a statement is accepted into a draft and only fails a screen later |
| Low | `UX-7` | The owed-as-positive sentence is phrased for a liability and shown on every account kind |
| Low | `UX-13` | Pressing Back after recording gives the expired page with no way to the statement just recorded |

## Overlaps with the 2026-08-24 pass — cite, do not re-file

| Seen on this walk | Already filed as | Note |
|---|---|---|
| `401k.csv` mapped to `Ticker` records 1 of 3 holdings; the two blank-`Ticker` rows, 96% of the file's value, vanish with no mention on any screen | `ING-4` | Reproduced exactly, still unfixed at `app/lib/statement.ts`. Approved for remediation as [`0005-report-remediation`](../specs/0005-report-remediation.md) item 4 |
| The Overview prints `$0.00` for accounts holding only unpriced instruments | `DASH-3` | `UX-11` is the journey consequence, not a second report of the mechanism |
| The account-number field's note claims it pre-selects the account | `SET-11` | `UX-2` is about what the *upload* screens do not say; the wrong note is `SET-11`'s |

---

# Findings in full

## First run, people and accounts

Two of the brief's empty states were checked here and both behave as specified. Reaching
`/upload` before any person or account exists draws the page title and the step strip and then
nothing at all, deferring to the shell's first-run prompt rather than drawing a form that could
not be submitted ([`01-upload-before-any-account.png`](./upload-ux-2026-08/01-upload-before-any-account.png));
and `/settings/accounts` refuses its own add form until a person exists, saying why. The ordering
— people, then accounts, then a statement — is stated on every screen that depends on it.

#### [UX-1] The add-account form keeps every value after a successful add, so the next account silently inherits the last one's owner, kind, tax treatment and account number

- **Severity:** High
- **Where:** `app/routes/settings/accounts.tsx:32` (the action returns `null` on success),
  `app/components/account-fields.tsx:60`, `:74`, `:89`, `:109`, `:129`, `:153` (all six fields are
  `defaultValue`, therefore uncontrolled). URL: `/settings/accounts`
- **What happens:** after an account is created the form re-renders with every control still
  carrying the previous account's answers. The intent is visibly the opposite — the action returns
  `null` so `actionData?.values` is undefined and each `defaultValue` falls back to the empty string
  — but React does not reset an uncontrolled input on a re-render, and the client-side navigation
  never remounts the form. A hard reload clears it, which is what confirms the retention is
  client-side rather than a server echo.
- **What should happen:** a successful create leaves an empty form. The repo's own reasoning is
  already in the action: returning `null` rather than the submitted values is a deliberate choice
  and it is the choice being defeated.
- **Repro:** on `/settings/accounts`, create an account filling all six fields — kind *IRA*, owner
  the second person, treatment *tax-free*, number `SECRET-0001`. The form comes back holding all
  six. Now type only a **Name** for the next account and submit.
- **Evidence:** the second account is created as kind `ira`, owner `2`, `tax_free`, institution
  `Probe Bank` and account number `SECRET-0001` — none of which was typed for it. Institution is
  worth calling out separately: it is the key a saved column mapping is stored under
  (`app/lib/column-mapping.server.ts:5`, keyed and looked up at `:62-70`, called from
  `app/routes/upload/columns.tsx:102`), so an inherited one silently makes two accounts share one
  mapping. Two accounts now share one external account
  number, which is the value the upload flow uses as a commit-time guard.
  On the first pass of this walk it produced a wrong account number on two of four accounts before
  it was noticed, which is how it was found —
  [`02-accounts-after-four-adds.png`](./upload-ux-2026-08/02-accounts-after-four-adds.png) is the
  screen those four adds leave behind.
  The fix below was applied temporarily and tested rather than assumed: with
  `key={accounts.length}` on the form, the same repro leaves every control empty and the second
  submission is refused for its missing required fields instead of silently inheriting them. The
  change was reverted — this review proposes, it does not implement.
- **Notes:** tax treatment is the finding's weight. `CONTEXT.md` fixes it as three values that are
  never a boolean, and it is the taxable/sheltered split every breakdown reads; an account filed
  under the wrong one is wrong on Analysis, on the Overview grouping and in every per-person total,
  with nothing anywhere to suggest it. Owner is the same shape of problem one level down. Two fixes:
  the remount tested above, or making the fields controlled and clearing them on success — the first
  is a line, the second says what it means without relying on a remount to mean it. If the remount is
  taken, the key has to be the **account count from the loader**, not `useActionData()`: that returns
  `undefined` before the first submit and `null` after every success, so it never changes between two
  consecutive creates and keying off it ships a no-op. The count also stays put on a validation
  refusal, which is what keeps the error echo at `app/routes/settings/accounts.tsx:34` working.

#### [UX-2] Nothing in the upload flow says the account number is a commit-time guard, and the field's own note says the opposite

- **Severity:** Low
- **Where:** `app/components/account-fields.tsx:158-161` (the note),
  `app/lib/uploads.server.ts:1001-1012` (what the column actually does). URL: `/settings/accounts`,
  then `/upload/:draftId/review`
- **What happens:** the account number is optional and reads as bookkeeping. It is in fact the only
  thing that will refuse a commit outright when a file's own account number disagrees with the
  account's — a refusal that arrives at the fourth screen, after the mapping and any new instruments
  have already been written.
- **What should happen:** the screen that collects the number should say what it is for, in the
  terms the guard uses: a statement carrying a different number will be refused.
- **Repro:** create an account with a number; upload a statement whose mapped account-number column
  holds a different one; the refusal arrives at review.
- **Evidence:** the guard's own comment calls the column "a guard, never a selector".
- **Notes:** the *wrong* note is already `SET-11` and is not re-filed here. What is added is that the
  upload screens are silent too, so a household that hits the refusal has been told the opposite once
  and nothing at all twice. Fixing `SET-11` fixes half of this.

## The file drop

The refusals on this screen are the best-judged copy in the flow and are working: a missing file, a
missing account, a zero-byte export and a binary file each draw their own sentence, and each says
what to do next rather than what went wrong. Nothing to change.

#### [UX-3] A text file that is not a statement is accepted into a draft, and only fails a screen later

- **Severity:** Low
- **Where:** `app/lib/uploads.server.ts:177-186` (the only content check is a fatal UTF-8 decode),
  `app/routes/upload.tsx:161` (`accept=".csv,text/csv"` is a picker hint the server does not read).
  URL: `/upload`
- **What happens:** a two-line note saved as `.csv` passes the gate, becomes a draft, and reaches the
  columns screen, where it presents a header of nonsense and can only produce a mapping refusal. The
  binary case is caught and worded well; the decodable case is not caught at all.
- **What should happen:** open question rather than a demand — see Notes.
- **Repro:** upload a file containing `not,a,statement` and a second such line. It is staged and the
  flow advances to `/upload/:draftId/columns`.
- **Evidence:** the walk's C5 probe lands on `/upload/14/columns` with the file's own words as the
  header row.
- **Notes:** **this disagrees with a cleared non-issue rather than reporting new ground.** The
  earlier pass walked the same path and recorded it as working — a PDF, an HTML file named `.csv` and
  a file with no extension "are accepted as text and then dead-end **harmlessly** at the columns
  step" (`2026-08-24-exploratory-test-report.md:1003-1009`). Harmless is right about the data and, on
  a walk rather than a probe, wrong about the reader: the dead end arrives a screen later, wearing a
  mapping refusal that describes a column problem rather than a file problem, and it leaves a draft
  behind. Filed Low and as a question because the counter-argument is strong: the parser's whole
  design is tolerance, and a sniff strict enough to reject this could reject a real export from an
  institution nobody has tried yet.

## Mapping the columns

#### [UX-4] There is no column auto-detection at all — six placeholders against a header that names its own columns

- **Severity:** Medium
- **Where:** `app/routes/upload/columns.tsx:112-121` (with no remembered mapping every control
  defaults to the empty placeholder; only `costBasisIs` and the liability checkbox get a default),
  `app/lib/column-mapping.server.ts` (no name heuristic exists). URL: `/upload/:draftId/columns`
- **What happens:** on the first statement from each institution the reader sets every control in
  `COLUMN_CONTROLS` by hand against a header row that already reads `Symbol`, `Description`,
  `Quantity`, `Average Cost Basis`, `Account Number`. The header row itself *is* detected, and well — the
  Fidelity file's two-line preamble is handled with no intervention — so the screen demonstrates the
  capability on the one field it applies it to and then withholds it from the six beside it.
- **What should happen:** the screen should open with a proposed mapping wherever the header names a
  column unambiguously, exactly as it already opens with a remembered one, and the reader should
  confirm it the same way.
- **Repro:** with no prior statement from an institution, upload `tests/fixtures/statements/fidelity.csv`
  to a brokerage account. All six controls read the placeholder.
- **Evidence:** [`03-columns-first-sighting.png`](./upload-ux-2026-08/03-columns-first-sighting.png).
- **Notes:** the brief's §9.5 refuses *skipping* this screen — "a changed export must be visible, not
  silently reapplied" — and that is right and should stay. This proposes the opposite of skipping:
  the screen still renders, still says where the choices came from, and is still submitted by hand.
  The mechanism already exists, because a remembered mapping arrives prefilled and is confirmed
  rather than re-entered; the notice at `:352-358` is the pattern to copy, with a different sentence
  saying the choices were proposed from the header rather than recalled from a previous upload.
  Sized against the cheapest alternative: the cheapest is copy alone, and copy cannot fix this.
  **How to match was investigated separately** and the answer is narrower than it looks:
  [broker header aliases](./2026-08-25-broker-header-aliases.md) argues for a curated alias table with
  normalised exact matching and **no fuzzy tier at any stage**. The reason is narrower than "the
  strings are similar": the abbreviations a fuzzy matcher exists to catch sit *further away* than the
  collisions it must avoid. Normalised by length, `qty` → `quantity` is 0.625 while
  `units` → `unit price` is 0.600 and `shares` → `share price` is 0.545 — so any threshold admitting
  the abbreviation admits both collisions beneath it, and this repository's own `401k.csv` carries the
  first pair. Two further things belong with this ticket rather than after it: a header row must be
  required to satisfy the mandatory roles before it is offered, because a real Vanguard export's
  holdings and transactions sections share five column names; and the proposal should be cross-checked
  against the file's own arithmetic, as a signal that demotes a proposal rather than a gate that blocks
  one — measured against real exports it fails often enough that it cannot be trusted to be right, only
  to be suspicious.

#### [UX-5] The cost-basis per-share/total default records a fifty-fold wrong basis with nothing on screen to catch it

- **Severity:** High
- **Where:** `app/routes/upload/columns.tsx:119` (`costBasisIs` defaults to `per_share`), `:442-468`
  (the radio pair), `app/lib/statement.ts:472-486` (the total branch divides by quantity).
  URL: `/upload/:draftId/columns`, then `/upload/:draftId/review`
- **What happens:** the repo's own `schwab.csv` states cost basis as a position total — `$8,533.00`
  against fifty shares. The control defaults to *Per share*, and its note says only that it applies
  when a cost basis column is mapped, not how to tell which kind this file is. Left on the default,
  the review screen prints `$8,533.0000` in a column headed *cost basis / share*, and the commit
  records it. The one guard that could fire, the money-column product check, does not: fifty times
  `$8,533` fits.
- **What should happen:** the reader should be able to tell, from the screen, which kind of figure
  the file holds. The sample rows are already displayed and already contain the evidence.
- **Repro:** upload `tests/fixtures/statements/schwab.csv`, map **Cost basis** to `Cost Basis`, leave
  the radio on its default, continue. Review lists AAPL at `$8,533.0000` per share.
- **Evidence:** [`04-review-cost-basis-per-share-default.png`](./upload-ux-2026-08/04-review-cost-basis-per-share-default.png).
  The same file mapped with *Total for the position* records `$170.6600`, which is the right answer
  and matches the Fidelity statement for the same holding.
- **Notes:** this is worse on a first statement than a later one, because there is no previous figure
  to disagree with and, per UX-9, no value column to sanity-check against. Three candidate fixes, in
  ascending cost. Copy alone: reword the note to say how to tell — a basis larger than the price is a
  total. Better: the columns screen already re-renders on a round trip for the header row, so the
  same round trip could show what the first sample row becomes per share under the current choice.
  **The strongest option arrived with the alias research and is not on this screen at all.** A
  cost-basis column's header names its own semantics — `average`, `unit`, `per share`, `price` and
  `paid` mean per share, `total` and `money` mean whole position — so the same table that proposes the
  mapping under `UX-4` can pre-set this control rather than leaving it on a default. That is not a
  heuristic dressed up: a *price* is per-unit by definition, and Interactive Brokers' real export
  demonstrates the pair arithmetically. Fidelity ships both `Average Cost Basis` and `Cost Basis Total`
  in one file, which is what makes the pre-set worth having and a fuzzy match worth refusing.
  **The rule has a gap that lands squarely on this finding.** Unqualified headers — `Cost`,
  `Cost Basis`, `Cost (£)` — carry no magnitude token at all, and Schwab's is the bare form, so the
  very file this finding is built on is the case the rule cannot pre-set. There it should stay a
  visible decision rather than a silent default, which is itself a change: today's default is
  per-share. See [broker header aliases §4](./2026-08-25-broker-header-aliases.md).
  A third option was drafted and withdrawn, and is recorded because it is the obvious one to reach
  for: have the review screen observe a per-share basis larger than the position's own value. It does
  not work. On this file's own rows it never fires — AAPL's mistaken `$8,533` basis is below the
  position's `$11,467.50`, and MSFT's is below its `$12,815.00` — a basis above a price is a loss
  rather than an error, which the earlier pass already cleared in those words
  (`2026-08-24-exploratory-test-report.md:1593`), and per UX-9 a first upload has no price to compare
  against at all. The check has no operand at the moment it is needed.

#### [UX-6] When the instrument column is the fund name, the obvious mapping is refused and the workaround is unobvious

- **Severity:** Medium
- **Where:** `app/lib/column-mapping.server.ts:172-174` (one column cannot fill two roles),
  `app/routes/upload/instruments.tsx:276-283` (the name is prefilled from the raw string when no name
  column is mapped). URL: `/upload/:draftId/columns`
- **What happens:** a workplace-plan export routinely has no ticker — `401k.csv` has a blank `Ticker`
  on two of three rows and the fund's full name in `Investment`. Mapping **Instrument** and **Name**
  both to `Investment`, which is what the file actually means, is refused. The way through is to set
  **Name** to *Not in this file*, which reads like discarding information and is the opposite of what
  the reader wants to say.
- **What should happen:** a column serving as both the instrument and its name is a normal statement,
  not a contradiction, and the flow already handles it downstream — the instruments step prefills the
  name from the raw string precisely for this case.
- **Repro:** upload `tests/fixtures/statements/401k.csv`, map both **Instrument** and **Name** to
  `Investment`. The refusal names the collision.
- **Evidence:** the refusal is rendered against the Name control, and the mapping is not saved — so
  the institution-wide mapping from the previous, wrong attempt is still what stands.
- **Notes:** **this overturns a cleared non-issue and should be read as a disagreement.** The
  earlier pass recorded that the column-mapping refusals "all fire", the same column mapped twice
  among them, as working-as-intended (`2026-08-24-exploratory-test-report.md:1025-1027`). They do
  fire, correctly, for every pair but one. The duplicate-column rule is right in general: one column
  cannot be both Quantity and Cost basis. Name is the exception, because "the name is the instrument"
  is a statement a file can truthfully make — and it is one several real exports make. Vanguard's
  legacy mutual-fund platform has **no symbol column at all**; TIAA puts the ticker inside the name
  string; thinkorswim uses one combined `Instrument` column. Collective investment trusts have no
  ticker because they are not SEC-registered funds, so this is a domain fact rather than one
  provider's quirk.
  One design consequence is sharper than "allow it", and the research is what surfaced it: **the
  fallback has to be per row, not per file.** DEGIRO and Ameriprise both carry an identifier column
  that is populated for most rows and blank for some, so a file-level "this export has no ticker"
  decision is wrong for exactly the rows that need it. See
  [broker header aliases §7](./2026-08-25-broker-header-aliases.md). Either permit that one pair, or say in the refusal that *Not in this file* is the
  answer here and that the name will be taken from the instrument column — the second is copy only.

#### [UX-7] The owed-as-positive sentence is phrased for a liability and shown on every account kind

- **Severity:** Low
- **Where:** `app/routes/upload/columns.tsx:474-481`, defaulted from the account kind at `:120`.
  URL: `/upload/:draftId/columns`
- **What happens:** the checkbox is rendered on every account and names the account in its sentence,
  so a brokerage upload offers a tickbox about what is *owed on* a taxable brokerage account, and a
  workplace plan offers one about what is owed on a 401(k).
- **What should happen:** the control is right to be always-rendered rather than revealed — a reveal
  reacting to another control needs JavaScript, and the brief settles that. The wording is what does
  not survive being shown to a brokerage.
- **Repro:** upload any statement to a brokerage account and read the last control above the submit.
- **Evidence:** rendered on the Fidelity, Schwab and Acme walks; the copy lives at the line above.
- **Notes:** copy only. The sentence needs a form that is true of an asset account as well as a
  liability — it is really asking whether the file's signs are inverted.

#### The blank-instrument case, reproduced — `ING-4`

Mapping `401k.csv`'s **Instrument** to the column literally called `Ticker` is the obvious reading of
that file and still discards the two rows whose `Ticker` cell is blank — `$58,692.68` of a
`$61,200.68` file. Review reports `1 ADDED` and says nothing about the other two.
Evidence: [`05-review-401k-mapped-to-ticker.png`](./upload-ux-2026-08/05-review-401k-mapped-to-ticker.png).
Already filed as `ING-4` and approved for remediation as
[`0005-report-remediation`](../specs/0005-report-remediation.md) item 4, which correctly places the
fix in the parser rather than on the review screen. Recorded here only as confirmation that it still
reproduces, and that the three-row preview does show the blank cells — the evidence is on screen and
still does not read as *this will drop most of your money*.

## Resolving new instruments

The no-skip rule is right, the count sentence is clear, and the disclosure that resolving writes
vocabulary before the statement is recorded is exactly the sort of thing that usually goes unsaid.
One structural problem sits underneath it.

#### [UX-8] A first run has one classification, so every equity forces an invent-a-category decision mid-upload

- **Severity:** Medium
- **Where:** `migrations/0001_initial_schema.sql` seeds `Cash` and `USD` and nothing else;
  `app/routes/upload/instruments.tsx:319-358` (the classification control, plus *New classification…*
  and the asset class beside it). URL: `/upload/:draftId/instruments`
- **What happens:** on the first statement the classification list offers exactly one option, `Cash`,
  which is wrong for every security in the file. Each new instrument therefore costs up to six
  answers — symbol, name, price source, *New classification…*, the category's name, its asset class —
  and the reader is being asked to design a taxonomy while trying to record a statement. The Fidelity
  file alone asked about four instruments; the walk invented seven classifications before it had
  finished the day.
- **What should happen:** a first upload should be able to file a total-market ETF without the
  household first inventing the phrase for it.
- **Repro:** on a migrated, unseeded instance, upload any equity statement and reach the instruments
  step. The classification control offers `Cash` and *New classification…*.
- **Evidence:** counted in the database after the walk: seven classifications and eleven aliases
  created by the four uploads, against a starting instance holding one classification and one
  instrument. The instrument count reached twelve, which includes the seeded `USD` and a duplicate
  `VBTIX` the walk produced by mapping one file two different ways — that duplicate is `ING-8`, and
  is discussed with the empty states below rather than counted as vocabulary the household chose.
- **Notes:** the two obvious fixes are opposite and either would do. Seed a small starter set of
  classifications alongside `Cash` — the demo seed already names a plausible twelve, so the project
  has an opinion about what they are. Or make the classification optional on creation, since the
  asset class is the field that actually does work downstream and the classification is a refinement.
  The first is smaller and does not touch the schema. This is a genuine cost rather than polish: it
  is the single largest contributor to the first upload being 39 interactions and the third 13.

## The review screen

The safety valve was tested directly and it holds. A file removing three of an account's four
positions lists all three in full, states the ratio in its own sentence, and refuses the commit until
the box is ticked — pressing **Record** without it records nothing and says so. That is the screen
doing the job it exists for.
Evidence: [`08-review-majority-removal.png`](./upload-ux-2026-08/08-review-majority-removal.png).

#### [UX-9] The flow's safety valve carries no money on a first upload

- **Severity:** Medium
- **Where:** `app/lib/uploads.server.ts:833` (`value: valueAt(row.quantity, fact.price)`, the price
  read at `:754`) and `:620-626` (`valueAt` returns null with no quote), rendered at
  `app/routes/upload/review.tsx:235`, `:273`, `:294`;
  `app/lib/price-poller.server.ts:154-170` (a `setInterval` with no immediate tick, argued at
  `:146-150`), `:84` (a tick returns early when the market is shut), `app/lib/market-hours.ts:142`
  (shut all weekend). URL: `/upload/:draftId/review`
- **What happens:** every instrument in a first statement was created on the screen immediately
  before, so none has ever been quoted, so the whole **Value** column reads as an em dash. The screen the reader is
  asked to approve therefore shows quantities and cost bases and no money at all. The first
  opportunity for a price is one poll interval away — fifteen minutes by default — and if the upload
  happens on a Saturday or Sunday, which is when a household does this, the first tick that will do
  anything is on Monday.
- **What should happen:** either the screen carries a figure the reader can check, or it says why it
  cannot and when it will.
- **Repro:** on an unseeded instance, upload `tests/fixtures/statements/fidelity.csv`, resolve the
  four instruments, reach review.
- **Evidence:** [`06-review-first-statement-unpriced.png`](./upload-ux-2026-08/06-review-first-statement-unpriced.png)
  — four added rows, four em dashes.
- **Notes:** the em dash is right and must stay; the brief's first prohibition is that a missing
  figure is never rendered as a zero, and this obeys it. What is missing is the sentence. This is
  distinct from `PRC-1`, which is that no screen says how *old* a price is: this is about there being
  no price yet, and about the reader not being told what would change it. That sentence has to be
  written carefully, because "wait for the next poll" is only true of some rows: `refreshQuotes`
  selects feed instruments carrying a symbol (`app/lib/prices.server.ts:161`), so an instrument
  created **Manual**, or with no ticker — which is exactly what a workplace-plan file walks the
  reader into, per UX-6 and UX-8 — is never polled at all and no interval will ever price it. Those
  rows need a different sentence from the ones that are merely waiting. The cheapest honest fix is
  copy on this screen that distinguishes the two. The larger one is cheaper than it looks: creating a `feed`
  instrument **already makes a provider call** — the USD probe at
  `app/lib/instrument-resolution.server.ts:525-556` — and keeps only the currency and the quote type
  from the answer, discarding the price it was quoted. Keeping that price would give a first
  statement its figures without a single extra request, and would fix UX-11 in the same stroke.
  Whether that is right is a pricing decision rather than a UX one, because the probe is deliberately
  allowed to fail without blocking a statement and a stored price would inherit that path. Note the
  reach: the probe runs only for a created instrument that takes a feed and has a symbol
  (`app/lib/instrument-resolution.server.ts:533`), so it would price the Fidelity and Schwab rows and
  none of the workplace-plan funds or the loan.

#### [UX-10] The statement date defaults to today while the file's own date is on screen two controls away

- **Severity:** Medium
- **Where:** `app/routes/upload/review.tsx:352-380` (the date input, defaulting to today, shown when
  no as-of column is mapped); `app/lib/statement.ts:319` and `:379` (a file dates itself only through
  a mapped column), `:493-495` and `:592-619` (the date is resolved from that column's sightings and
  nowhere else).
  URL: `/upload/:draftId/review`
- **What happens:** `fidelity.csv` announces its own date in its preamble — the columns screen even
  offers that line as a candidate header row, so the reader has already seen it — but the date is not
  in a column, so the review screen says the file does not date itself and offers today instead. A
  July statement uploaded in August is one unchanged default away from being recorded as August.
- **What should happen:** where the file's bytes contain a date the reader has already been shown,
  today is a poor default.
- **Repro:** upload `tests/fixtures/statements/fidelity.csv` on any day other than 31 July 2026. The
  review screen's date input holds today.
- **Evidence:** the walk's review screen offered `2026-08-25` for a file whose first line reads
  *Account positions as of 07/31/2026*.
- **Notes:** the interesting consequence is filed rather than new — a statement dated before the
  account's latest set silently rewrites the net-worth chart between its own date and the next set,
  which is `ING-1` as [`0005-report-remediation`](../specs/0005-report-remediation.md) corrects it
  (`:214-217`: the earlier report was "wrong about the consequence in the mild direction" — history
  changes with no confirmation, rather than nothing happening), approved for remediation as
  [`0005-report-remediation`](../specs/0005-report-remediation.md) item 5. This finding is the step
  before it: the default is what steers a reader into a wrong date in the first place, in either
  direction. Parsing dates out of preamble prose is more than this is worth; saying on the date
  control that the file was not read for a date, and that the reader should check the statement,
  is copy.
  The alias research changes the weight of this finding rather than its content: **a position export
  carrying no as-of column is the normal case, not the exceptional one.** Fidelity, Schwab, TIAA and
  Ameriprise all put the statement date in a preamble line; Merrill has a column but calls it
  `COB Date`, which shares no substring with "as of". Fidelity is the sharpest case and not in the way
  the first draft of that document claimed: its **real** export has no preamble at all and puts a
  *download* timestamp in a trailer, so the file carries no statement date anywhere a mapping could
  reach. So the branch that defaults to today is the common path, and should be designed as one. See
  [broker header aliases §8](./2026-08-25-broker-header-aliases.md).

## The receipt, and after

The receipt is good and worth keeping exactly as it is: a sentence in the place the thing happened,
naming the file, the counts, the date and what the account now holds, every figure read back from the
database. No toast, and none wanted.

#### [UX-11] A correct first run ends at a net worth of `$0.00`

- **Severity:** High
- **Where:** `app/routes/overview.tsx:409` (the headline figure, printed unconditionally) and `:441-446`
  (the coverage note under it); `app/routes/account.tsx:311-315` (the rule the account page states,
  which names an account "whose every holding is unpriced" exactly) and `:407-423` (where it refuses);
  and the poller lines under UX-9. URL: `/`
- **What happens:** after four statements, eleven holdings and 130 interactions, the Overview reads
  `TOTAL NET WORTH $0.00`, with all four accounts listed at `$0.00` and a coverage note underneath
  saying the figure is 0 of 11 holdings. The note is honest. The headline above it is not: it states
  a number the application does not know, on the screen whose own rule is that a zero on a finance
  page is a claim.
- **What should happen:** where no holding in scope has ever been priced, the Overview should decline
  the figure the way the account page already declines it — the sentence for it exists and is already
  written.
- **Repro:** complete a first run against an unseeded instance at a weekend, and open `/`.
- **Evidence:** [`09-overview-after-four-statements.png`](./upload-ux-2026-08/09-overview-after-four-statements.png).
- **Notes:** `DASH-3` covers the **per-account rows** and says so — its own notes limit it to "the
  per-row case only". What is added here is the **headline**, `overview.tsx:409`, which no finding
  has named, and the observation that a correct first run is a reliable way to reach it rather than
  an unlucky one.
  The scope needs stating precisely, because the first draft of this finding overreached. The poller's
  interval starts at the **first page render** (`app/root.tsx:67`), not at instrument creation, and
  the default interval is fifteen minutes — and a 130-interaction onboarding takes longer than that.
  So on a **trading day** ticks fire mid-onboarding, `refreshQuotes` picks up instruments created
  minutes earlier, and the headline is not `$0.00`. Two populations are left: a household onboarding
  at a weekend or a holiday, and one whose statements resolve nothing to the seeded `USD` instrument
  — which `migrations/0001_initial_schema.sql:266-283` gives a quote of `1.00` and a 1970 close, so a
  cash row alone makes the headline non-zero. Both are ordinary; neither is universal. This walk saw
  the `$0.00` on a Tuesday only because the sandbox could not reach the feed at all, which is why the
  finding is argued from the weekend path and not from that screenshot.
  The two screens still disagree — one prints `$0.00`, the other refuses to — and the disagreement is
  most visible at the exact moment a new household is deciding whether this application works.
  Making the Overview defer to the account page's existing rule removes the wrong claim regardless of
  cadence, and is the smaller of the two fixes; keeping the price the creation-time probe is already
  quoted (see UX-9) narrows the window that produces it.

#### [UX-12] Abandoned drafts are invisible, uncancellable, and swept only by someone else's next upload

- **Severity:** Medium
- **Where:** `app/lib/uploads.server.ts:218-221` (the sweep runs at the start of an upload, not on a
  schedule), `:249-288` (a draft is only ever found by id). URL: any `/upload/:draftId/*`
- **What happens:** there is no cancel, no discard and no list. Walking away is the only exit, and a
  draft is only reachable by its URL, so closing the tab loses it. The 24-hour sweep is lazy: it runs
  when somebody starts another upload, so on a quiet instance a draft outlives its day indefinitely.
  This walk left eight, holding a copy of every file uploaded, and no screen in the application
  mentions them.
- **What should happen:** at minimum a reader who abandons a step should be able to say so; at
  minimum an operator should be able to see that drafts exist.
- **Repro:** start an upload, reach the columns screen, navigate away. Nothing lists it; nothing
  removes it until the next upload begins, a day later.
- **Evidence:** eight `upload_draft` rows remained after the walk, the oldest from the first upload.
- **Notes:** the design consequence is deliberate and correct — an abandoned draft leaves its
  resolved instruments behind, which makes the next upload quieter and records nothing as held. What
  is not obviously intended is that the reader has no way to abandon *deliberately*, and that the
  bytes of every statement they started to upload sit in the database until a future upload happens
  to sweep them. Note the interaction with §9.10's "no dirty-state warning": that rule says leaving a
  step must lose nothing, and it does not — but it does not follow that leaving should be
  unspeakable. A discard control on the draft steps is not client state and not a warning.

#### [UX-13] Pressing Back after recording a statement gives the expired page with no way to the statement

- **Severity:** Low
- **Where:** `app/lib/uploads.server.ts:307` (`requireDraft` throws the expired error with no account
  on it), `app/routes/upload/draft.tsx:91-94` (the link is rendered only when the error carries one).
  URL: any `/upload/:draftId/review` after its statement has landed
- **What happens:** a **GET** of a recorded draft's URL — the browser Back button, or a bookmarked
  step — renders the expired page offering only *start a new upload*. The reader has just recorded a
  statement, is one keystroke into looking at it, and is handed a dead end that does not mention it.
- **What should happen:** the same page after a re-**POST** already does the right thing: it carries
  the account id and offers a link to what the account now holds. The GET path should reach the same
  place.
- **Repro:** record a statement, then navigate back to the review URL, or open it in a new tab.
- **Evidence:** the walk's C9 probe on a recorded draft rendered the expired page with a single link,
  to a new upload.
- **Notes:** **this was nearly lost as a duplicate and is not one.** `ING-6` and `ING-7` both concern
  the expired page, and both show it *with* the "see what the account holds now" link
  (`2026-08-24-exploratory-test-report.md:818-820`, `:857-858`) — because both are POST paths, which
  carry the account id. The GET path is a different route to the same page and drops it. Small, and
  the fix is to give `requireDraft`'s error the same shape the re-POST path already produces.

## The eight empty and partial states, and which were exercised

[`../design/ingest-ui-brief.md`](../design/ingest-ui-brief.md) §7 enumerates the states this flow has
to have an answer for, so they are the natural checklist for a walk. Six of the eight were reached
and every one behaves as specified; two were not, and are recorded as untested rather than as passing.

| State | Reached | What happened |
|---|---|---|
| No accounts at all | yes | title and step strip, then nothing — the shell's first-run prompt carries it |
| Every account closed | **no** | closing is one-way and there is no reopen control, so this was not walked on the instance the rest of the review depends on |
| Empty or undecodable file | yes | zero bytes and a binary file each draw their own sentence naming what to do next |
| Expired or already-recorded draft | yes | one uniform page for a recorded draft, a swept one and an id that never existed |
| Nothing unresolved | yes | the instruments step is skipped by redirect and the strip dims it rather than renumbering |
| A saved mapping whose column vanished | **no** | not reached, and not for the reason first written here: the fingerprint governs only the institution lookup, while the draft's own saved mapping is reused whatever the header row, so review's *back to columns* link and a different header row would have provoked it in four clicks |
| A majority removed | yes | all removals listed, the ratio stated in its own sentence, the commit refused until it is ticked |
| Removes everything | yes | said in those words — every position listed, none summarised ([`11-review-removes-everything.png`](./upload-ux-2026-08/11-review-removes-everything.png)) |

One filed defect surfaced while walking these and is recorded as confirmation rather than as a new
finding: the *instrument already listed* picker offered **VBTIX twice**, two instruments carrying one
symbol, created by mapping the same file two different ways. That is `ING-8`, and the flat list of
every instrument it appears in is named in that entry too.

## The phone — one paragraph, as the design record intends

DESIGN.md §11 classes upload as a desktop-shaped workflow and refuses mobile layout investment for
it, and the brief predicts exactly what that produces. Measured at 390px, the prediction holds and
nothing is hidden: the page body never scrolls sideways on any of the four steps, the step strip
wraps rather than scrolling, and the two wide tables scroll inside their own panel — the column
sample rows at 1221px inside a 356px window, the review diff at 460px. Everything is reachable and
nothing is cut off.
Evidence: [`10-columns-at-390px.png`](./upload-ux-2026-08/10-columns-at-390px.png). No recommendation
follows; this is recorded so the next reviewer does not re-open a decision that was argued and is
being honoured.

---

## What to do first, if any of this is taken

Grouped by what the change actually is, because that is what decides who can do it and when.

**Copy only, no schema and no flow change.** UX-7's owed-as-positive sentence. UX-6's refusal
message naming the way through. UX-9's sentence saying a price has not arrived yet and what brings
one — distinguishing the rows a poll will reach from the ones it never will. UX-10's note on the date
control. UX-2, which mostly disappears when `SET-11` is fixed. These are hours, independent of each
other, and none of them touches a rule in §9.

**One-line defects.** UX-1 is a remount keyed on the loader's account count, and it is the highest
value per line in this document. UX-13 is the expired-draft error carrying the account id on the GET
path as it already does on the POST path.

**Flow changes worth a spec.** UX-4's proposed mapping is the one that changes the day-one experience
most and needs its own ticket: where a proposal is confident enough to make, what the screen says
about where the choices came from, and what happens when it is wrong.
[Broker header aliases](./2026-08-25-broker-header-aliases.md) is the input to that ticket and settles
the mechanism — a curated table, exact matching, no fuzzy tier, with an arithmetic cross-check before
anything is pre-applied. **UX-5 and UX-6 belong in the same spec**, not because they are similar but
because one table answers all three: it proposes the column, it names whether a cost basis is per
share or per position, and it is where the providers whose instrument and name are one column are
recorded. UX-8 is a seed-data decision and a short conversation about whether classification
should be required at creation at all.

**Questions rather than proposals.** UX-3 — whether the drop screen should refuse a file that
decodes but does not read as tabular, given that tolerance is the parser's whole design. UX-12 —
whether a discard control belongs on the draft steps, and whether the sweep should be less lazy than
"when someone else uploads". UX-11's pricing half — whether the price the creation-time probe is
already quoted should be kept rather than discarded, which costs no extra request but inherits the
probe's deliberate freedom to fail, and is a pricing decision this review is not the place to settle.
