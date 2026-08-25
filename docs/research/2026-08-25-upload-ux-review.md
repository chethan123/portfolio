# Upload UX review — the statement workflow, walked as a household

A task-centred usability review of the statement upload workflow, done by standing up an empty
instance and using it: two people, four accounts, a statement in each, then the quarter after. It is
deliberately **not** a second defect hunt — [the exploratory test
pass](./2026-08-24-exploratory-test-report.md) already attacked this flow and filed eleven ingest
findings. Where an observation here lands on one of those, it cites the id rather than re-filing it.

Reviewed against `410a61f`. Twelve findings, all open, none previously reported.

## Start here — the four that matter

1. **[UX-1] Adding a second account silently copies the first one's owner, kind, tax treatment and
   account number.** The add form keeps every value after a *successful* add — the action returns
   `null` precisely so the fields reset, and uncontrolled inputs do not reset on a re-render. A
   household adding four accounts in one sitting can file three of them under the wrong person and
   the wrong tax treatment without touching a control. This is the one that loses money quietly:
   tax treatment is the taxable/sheltered split every other screen reads.

2. **[UX-11] A complete, correct first run ends at a net worth of `$0.00`.** Not an edge case — the
   guaranteed outcome. Every instrument is created during the upload, the poller has no immediate
   first tick and skips weekends, so the reward for a correct onboarding is a headline of `$0.00`
   over four accounts of `$0.00`, for up to a whole weekend, on a screen whose own design rule is
   that a zero is a claim.

3. **[UX-4] There is no column auto-detection of any kind.** All six controls open on the
   placeholder for every new institution, against a header that says `Symbol`, `Quantity` and
   `Description`. The design record forbids *skipping* the columns screen; it does not forbid
   arriving with a proposal on it. This is the largest single saving available on day one and the
   only finding here that would change what the reader does most often.

4. **[UX-5] Getting one radio button wrong records a cost basis fifty times too large, silently.**
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
All six column choices and the header row come back filled from the previous statement, the
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
eighteen numbered prohibitions, and this review takes them as binding. Never auto-select the account
from the file; never skip the columns screen even when prefilled; no client state and no
unsaved-changes warning; no progress bar or spinner; no toast or modal; no editing figures on the
review screen; the step count never changes; no drag-and-drop dependency. DESIGN.md §11 refuses
mobile layout investment for this flow specifically.

None of the twelve findings below asks for any of those. Where the obvious fix would be a refused
one, the finding says so and proposes the nearest thing that is allowed.

Three frictions were confirmed as **deliberate, and are not findings**: a refusal on the drop screen
always costs the file pick, because a browser will not refill a file input; changing the header row
discards unsaved column choices, which is why that control sits above the ones it resets; and a
reordered export costs one full re-map, which was chosen over a mapping that silently follows a
column that moved.

## Every finding, most severe first

| Severity | Id | Finding |
|---|---|---|
| High | `UX-1` | The add-account form keeps every value after a successful add, so the next account silently inherits owner, kind, tax treatment and account number |
| High | `UX-5` | The cost-basis per-share/total default records a fifty-fold wrong basis with nothing on screen to catch it |
| High | `UX-11` | A correct first run ends at `$0.00` net worth, and stays there for up to a weekend |
| Medium | `UX-4` | No column auto-detection at all — six placeholders against a header that names its own columns |
| Medium | `UX-6` | When the instrument column *is* the fund name, the obvious mapping is refused and the workaround is unobvious |
| Medium | `UX-8` | A first run has one classification, so every equity forces an invent-a-category decision mid-upload |
| Medium | `UX-9` | The review screen — the flow's safety valve — carries no money on a first upload |
| Medium | `UX-10` | The statement date defaults to today while the file's own date is displayed two controls away |
| Medium | `UX-12` | Abandoned drafts are invisible, uncancellable, and swept only by someone else's next upload |
| Low | `UX-2` | Nothing says the account number is a commit-time guard; the field's own note says the opposite |
| Low | `UX-3` | A text file that is not a statement is accepted into a draft and only fails a screen later |
| Low | `UX-7` | The owed-as-positive sentence is phrased for a liability and shown on every account kind |

## Overlaps with the 2026-08-24 pass — cite, do not re-file

| Seen on this walk | Already filed as | Note |
|---|---|---|
| `401k.csv` mapped to `Ticker` records 1 of 3 holdings; the two blank-`Ticker` rows, 96% of the file's value, vanish with no mention on any screen | `ING-4` | Reproduced exactly, still unfixed at `app/lib/statement.ts`. Approved for remediation as [`0005-report-remediation`](../specs/0005-report-remediation.md) item 4 |
| The Overview prints `$0.00` for accounts holding only unpriced instruments | `DASH-3` | `UX-11` is the journey consequence, not a second report of the mechanism |
| The account-number field's note claims it pre-selects the account | `SET-11` | `UX-2` is about what the *upload* screens do not say; the wrong note is `SET-11`'s |
| Revisiting a recorded draft's URL gives the expired page with no link to what was just recorded | `ING-6`, `ING-7` | Both already cover the missing link on adjacent paths |

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
- **Evidence:** the second account is created as kind `ira`, owner `2`, `tax_free`, account number
  `SECRET-0001` — none of which was typed for it. Two accounts now share one external account
  number, which is the value the upload flow uses as a commit-time guard.
  On the first pass of this walk it produced a wrong account number on two of four accounts before
  it was noticed, which is how it was found —
  [`02-accounts-after-four-adds.png`](./upload-ux-2026-08/02-accounts-after-four-adds.png) is the
  screen those four adds leave behind.
  The fix below was applied temporarily and tested rather than assumed: with a `key` on the form that
  changes when a create succeeds, the same repro leaves every control empty, and the second submission
  is refused for the missing required fields instead of silently inheriting them. The change was
  reverted — this review proposes, it does not implement.
- **Notes:** tax treatment is the finding's weight. `CONTEXT.md` fixes it as three values that are
  never a boolean, and it is the taxable/sheltered split every breakdown reads; an account filed
  under the wrong one is wrong on Analysis, on the Overview grouping and in every per-person total,
  with nothing anywhere to suggest it. Owner is the same shape of problem one level down. Two fixes:
  the remount tested above, or making the six fields controlled and clearing them on success — the
  first is a line, the second says what it means without relying on a remount to mean it.

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

The four refusals on this screen are the best-judged copy in the flow and are working: a missing
file, a missing account, a zero-byte export and a binary file each draw their own sentence, and each
says what to do next rather than what went wrong. Nothing to change.

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
- **Notes:** deliberately filed Low, and as a question. The parser's whole design is tolerance — a
  preamble, a footer and an unknown delimiter are all meant to survive — and a sniff strict enough to
  reject this could reject a real export from an institution nobody has tried yet. The cost today is
  one wasted screen and one abandoned draft, which is small. Worth raising only because the same
  screen already refuses four other things precisely.

## Mapping the columns

#### [UX-4] There is no column auto-detection at all — six placeholders against a header that names its own columns

- **Severity:** Medium
- **Where:** `app/routes/upload/columns.tsx:112-121` (with no remembered mapping every control
  defaults to the empty placeholder; only `costBasisIs` and the liability checkbox get a default),
  `app/lib/column-mapping.server.ts` (no name heuristic exists). URL: `/upload/:draftId/columns`
- **What happens:** on the first statement from each institution the reader sets six controls by
  hand against a header row that already reads `Symbol`, `Description`, `Quantity`,
  `Average Cost Basis`, `Account Number`. The header row itself *is* detected, and well — the
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
  Best and still cheap: the review screen may not *edit* figures per §9.13, but nothing forbids it
  observing that a per-share basis exceeds the position's own value, which is arithmetically
  impossible for a long position and is exactly what this mistake produces.

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
- **Notes:** the duplicate-column rule is right in general: one column cannot be both Quantity and
  Cost basis. Name is the exception, because "the name is the instrument" is a statement a file can
  truthfully make. Either permit that one pair, or say in the refusal that *Not in this file* is the
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
- **Evidence:** the walk's resulting vocabulary: seven classifications, twelve instruments, eleven
  aliases, all created during four uploads.
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
- **Where:** `app/routes/upload/review.tsx:219-221` (the value column is computed from the current
  quote), `app/lib/price-poller.server.ts:154-170` (a `setInterval` with no immediate tick), `:84`
  (a tick returns early when the market is shut), `app/lib/market-hours.ts:142` (shut all weekend).
  URL: `/upload/:draftId/review`
- **What happens:** every instrument in a first statement was created two screens earlier, so none
  has ever been quoted, so the whole **Value** column reads as an em dash. The screen the reader is
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
  no price yet, and about the reader not being told that a poll is what changes it. The cheapest
  honest fix is copy on this screen. The larger one is cheaper than it looks: creating a `feed`
  instrument **already makes a provider call** — the USD probe at
  `app/lib/instrument-resolution.server.ts:525-556` — and keeps only the currency and the quote type
  from the answer, discarding the price it was quoted. Keeping that price would give a first
  statement its figures without a single extra request, and would fix UX-11 in the same stroke.
  Whether that is right is a pricing decision rather than a UX one, because the probe is deliberately
  allowed to fail without blocking a statement and a stored price would inherit that path.

#### [UX-10] The statement date defaults to today while the file's own date is on screen two controls away

- **Severity:** Medium
- **Where:** `app/routes/upload/review.tsx:352-380` (the date input, defaulting to today, shown when
  no as-of column is mapped), `app/lib/statement.ts:272-276` (only a mapped *column* dates a file).
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
  account's latest set commits into a black hole, which is `ING-1`, approved for remediation as
  [`0005-report-remediation`](../specs/0005-report-remediation.md) item 5. This finding is the step
  before it: the default is what steers a reader into a wrong date in the first place, in either
  direction. Parsing dates out of preamble prose is more than this is worth; saying on the date
  control that the file was not read for a date, and that the reader should check the statement,
  is copy.

## The receipt, and after

The receipt is good and worth keeping exactly as it is: a sentence in the place the thing happened,
naming the file, the counts, the date and what the account now holds, every figure read back from the
database. No toast, and none wanted.

#### [UX-11] A correct first run ends at a net worth of `$0.00`

- **Severity:** High
- **Where:** `app/routes/overview.tsx:309` (accounts are listed with a figure regardless of coverage),
  `app/routes/account.tsx:421` (the account's own page refuses the figure instead), and the poller
  lines under UX-9. URL: `/`
- **What happens:** after four statements, eleven holdings and 130 interactions, the Overview reads
  `TOTAL NET WORTH $0.00`, with all four accounts listed at `$0.00` and a coverage note underneath
  saying the figure is 0 of 11 holdings. The note is honest. The headline above it is not: it states
  a number the application does not know, on the screen whose own rule is that a zero on a finance
  page is a claim.
- **What should happen:** where no holding in scope has ever been priced, the Overview should decline
  the figure the way the account page already declines it — the sentence for it exists and is already
  written.
- **Repro:** complete a first run against an unseeded instance and open `/` before the first
  successful poll.
- **Evidence:** [`09-overview-after-four-statements.png`](./upload-ux-2026-08/09-overview-after-four-statements.png).
- **Notes:** the mechanism is `DASH-3` and is not re-filed. What is new is that this is not an edge
  case reachable by an unlucky sequence: it is the *guaranteed* end state of a correct first run,
  because every instrument in it was created minutes earlier and the poller neither fires on start
  nor runs at a weekend. The two screens already disagree — one prints `$0.00`, the other refuses to
  — and the disagreement is most visible at the exact moment a new household is deciding whether this
  application works. Keeping the price the creation-time probe is already quoted (see UX-9) would
  close the window for most households at no extra request; making the Overview defer to the account
  page's existing rule removes the wrong claim regardless, and is the smaller of the two.

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
| A saved mapping whose column vanished | **no** | changing the header row changes the fingerprint, so this could not be provoked from the UI within the walk |
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
one. UX-10's note on the date control. UX-2, which mostly disappears when `SET-11` is fixed. These
are hours, independent of each other, and none of them touches a rule in §9.

**One-line defects.** UX-1 is a remount — a `key` that changes when a create succeeds — and it is the
highest value per line in this document.

**Flow changes worth a spec.** UX-4's proposed mapping is the one that changes the day-one experience
most and needs its own ticket: where a proposal is confident enough to make, what the screen says
about where the choices came from, and what happens when it is wrong. UX-5 deserves to be settled in
the same spec, because both are about the columns screen having information it does not put in front
of the reader. UX-8 is a seed-data decision and a short conversation about whether classification
should be required at creation at all.

**Questions rather than proposals.** UX-3 — whether the drop screen should refuse a file that
decodes but does not read as tabular, given that tolerance is the parser's whole design. UX-12 —
whether a discard control belongs on the draft steps, and whether the sweep should be less lazy than
"when someone else uploads". UX-11's pricing half — whether the price the creation-time probe is
already quoted should be kept rather than discarded, which costs no extra request but inherits the
probe's deliberate freedom to fail, and is a pricing decision this review is not the place to settle.
