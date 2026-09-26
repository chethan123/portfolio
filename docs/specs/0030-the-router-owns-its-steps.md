# 0030 — The router owns which step its problems belong to; one draft read per request

_Candidate 2.8 of [the second architecture review](../research/2026-09-24-architecture-review.md)
(card 8 of its [visual companion](../research/2026-09-24-architecture-review/report.html)). Line
numbers below were read at `80373fa`._

**What to build:** `statement-routing.server.ts`'s pure `routeStatement` (`:75`) emits seven
`RoutingProblem` kinds (`:45-59`), and `uploads.server.ts` decides which wizard step owns each, in
four places: `refusalsByStep` (`:367-383`, which kinds "ask again"), `stepOf` (`:549-557`,
rebuilding the unanswered numbers from the problems), `accountsScreen` (`:704-709`, a stale map by
hand) and `answerAccountNumbers` (`:798-809`, `as-of` and `nothing-to-record` re-filtered). The
taxonomy is the router's; its step ownership lives next door.

`routeStatement` returns a step-shaped result instead: the file's problems (the columns step's),
or the accounts step's refusals and questions, or the routed groups with the questions. Each
question (`NumberQuestion`) is built by the router from the rows and answers it already holds,
stale sentence included. `refusalsByStep` and the stale map are deleted, and `stepOf` maps the
router's arm onto `DraftParse` instead of re-deriving it.

The request that reads a draft reads it once. `readDraft` becomes the exported read a screen takes
its result from, carrying the file's rows beside the parse so the columns loader stops reading the
CSV twice. The accounts POST parses once and reuses its trial routing as the routing after its
write, instead of parsing and routing three times.

Worth doing on its own: the step a routing problem belongs to becomes a table test of the pure
router, and the next routing rule has one module to go in.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**Out of scope:**
- The step-to-redirect translation, the stale carry and the `steps` literal (candidate 2.9, spec
  after this one). `DraftParse`'s outward arms keep their shape here; 2.9 reshapes them.
- `problemFieldsOf` in `columns.tsx` (ARCHITECTURE.md §6.1 places it in the screen).
- `had_first_sightings` written at the columns step.
- ADR-0015's rules: nothing is guessed, a number is asked once. No routing rule changes.
- The commit path: `readyParse` (`:1057`), `recordUpload`'s unlocked read and `commitUnderLocks`'s
  locked re-read, which read twice on purpose (§7.2).
- `rememberMapping`'s signature and its own reads (§3 says why).
- Every refusal's wording and field key.
- The instruments loader's second `unresolvedStrings` (`resolutionScreen`, §3 says why).

## 1. The step-shaped result

```ts
// statement-routing.server.ts
export type NumberQuestion = {
  number: string;
  lines: number; // rows naming it, quantity-less ones included
  instruments: string[]; // distinct, trimmed, first-line order
  answer: string | null | undefined; // the draft's: an account id, null skips, undefined none
  stale: string | null; // the stale-answer sentence, when the answer no longer holds
};

// questions: every number no account records, answered or not, first-line order, on both arms
// that have them (the accounts screen shows the answers standing on a revisit).
export type RoutedStatement =
  | { step: "columns"; problems: RoutingProblem[] }
  | {
      step: "accounts";
      problems: RoutingProblem[]; // the ones asking again
      unanswered: string[]; // numbers still owed an answer, first-line order
      questions: NumberQuestion[];
    }
  | {
      step: "routed";
      accounts: RoutedAccount[]; // ascending id: the commit's lock order
      questions: NumberQuestion[];
      skippedNumbers: string[];
    };
```

`RoutingProblem`, `RoutedAccount`, `RoutingAccounts` and `recordedNumber` are unchanged. The old
top-level `problems` and `unknownNumbers` go; `unknownNumbers` is `questions.map(({ number }) =>
number)`, and every question is built by the router, from the same `positions`, `combined` and
`skipped` rows `accountsScreen` counts today (`:711-719`).

**The mapping, one row per kind.** The router sorts its problems into the arm by this table, the
same sort `refusalsByStep` makes today:

| Kind | Step | Why |
|---|---|---|
| `blank-number` | columns | The file's: a row names no account. |
| `shared-number` | columns | The accounts' state, fixed in Settings, not by an answer. |
| `closed-number` | columns | As shared. |
| `unanswered` | accounts | An answer is owed. |
| `stale-answer` | accounts | An answer no longer holds; asked again. |
| `as-of` | columns | **Decided: unchanged.** The file's dates disagree within one account. On a number the accounts POST is answering, `answerAccountNumbers` refuses it on that number's field before anything is saved (`:795-804`), because at columns it would leave no step to skip it from. A saved answer can only meet it later if the mapping changes, and then it is the file's again. |
| `nothing-to-record` | accounts when the file names numbers no account records (every one skipped), columns otherwise | **Decided: unchanged.** Every number skipped is undone by answering one; a file with no position row is undone only by remapping. |

A columns problem outranks an accounts one, as today (`stepOf` returns columns first, `:550`): the
arm is `columns` when any columns-step problem exists, else `accounts` when any accounts-step one
does, else `routed`. The accounts arm's `unanswered` is the file's unknown numbers, first-line
order, filtered to those an `unanswered` or `stale-answer` problem names: `stepOf`'s rebuild
(`:552-555`), moved. Not the problems in push order: `unanswered` problems are pushed in
first-line order and `stale-answer` ones after them (`:153-195`), so a stale number on an earlier
line would otherwise come second.

## 2. What moves, what stays

| Today | After |
|---|---|
| `refusalsByStep` (`uploads.server.ts:367-383`) and its "asks again" predicate | **Moves** into `routeStatement`, as §1's table. Deleted from `uploads.server.ts`. |
| `stepOf`'s owed-number rebuild (`:549-557`) | **Moves**: the accounts arm's `unanswered`. `stepOf` maps arms: `columns` to `{ step: "columns", problems }`, `accounts` to `{ step: "accounts", unanswered }`, `routed` to the instruments/null arms with `routed = accounts`, `accountsSkipped = questions.length === 0`, `skippedNumbers`. |
| `accountsScreen`'s stale map (`:704-709`) and question building (`:712-730`) | **Moves**: `NumberQuestion`. What stays in `accountsScreen` is the form's encoding of one field: `answer: stale !== null \|\| answer === undefined ? "" : answer ?? SKIP_NUMBER`. `AccountQuestion` stays the screen's type; `SKIP_NUMBER` stays in `uploads.server.ts`, the accounts screen's module. |
| `answerAccountNumbers`' re-filter (`:798-809`) | **Stays, reading arms**: it is the accounts step validating candidate answers, not a step decision. The trial routing's `columns` arm holds the `as-of` problems it places on fields; its `accounts` arm holds the `nothing-to-record` it refuses form-level. The comment at `:796-797` keeps its argument. |
| `routingInputs`, `routeDraft`, `rememberMapping`'s routing (`:429-433`) | **Stay**; `rememberMapping` reads the arm: `columns` returns its problems, `accounts` sets `asksAccounts`. |
| `numberQuestions` (`:678-690`) | **Deleted**: `answerAccountNumbers` takes the one read (§3). |

## 3. The one read

`uploads.server.ts` gains, moved from `columns.tsx:52-59` (`readDraftFile`):

```ts
export type DraftFile = CsvRead & { savedMapping: StatementMapping | null };
export function draftFile(draft: UploadDraft): DraftFile;
```

Exported: the columns action still reads the file to parse the posted form (below) and calls it
too, so `columns.tsx` keeps no copy.

and the exported read:

```ts
// The one read a request takes its result from: the file as the columns step shows it, and the step.
export async function readDraft(
  draft: UploadDraft,
  db: Kysely<Database> = getDb(),
): Promise<{ file: DraftFile; parse: DraftParse }>;

export async function parseDraft(draft, db) { return (await readDraft(draft, db)).parse; }
```

`savedParse` parses `file.rows` under `file.savedMapping` when that mapping validates and fits,
instead of reading the CSV again: it is the same `readCsv(draft.bytes, saved.delimiter)` either way
(`columns.tsx:56`, `uploads.server.ts:508`). Today's internal `readDraft` (`:525`) is renamed
`routedRead` and takes the file; `stepOf` is unchanged apart from reading arms.

- `accountsScreen(draft)` makes one `routedRead` and one `stepOf`, as today, and takes its questions
  from the router.
- `answerAccountNumbers(draftId, posted)` makes one `routedRead`. It asks when the routing is not
  `columns` and has questions. Its trial routing with the posted answers (`:797`) is the routing
  the write produces, so after the write its next step is
  `stepOf({ …read, routing: { inputs: { …inputs, answers }, statement: trial } })`, not a
  re-read. When it asks nothing, the next step is the one read's own.
- The instruments loader is unchanged: it reads, parses and routes the draft once, through
  `parseDraft`. Its `resolutionScreen` asks `unresolvedStrings` a second time on purpose. That
  fresh check redirects to review when a concurrent submit has resolved every string between
  the two statements (`instruments.tsx:53-54`). Taking the strings from the parse instead would
  show, in that race, a page listing strings already answered. That is a visible change this
  slice does not make.

**Every wizard request, before and after.** D: draft-row reads before deciding; C: `readCsv`
calls; P: `parseStatement` calls; R: `routeStatement` calls; I: `routingInputs` calls (each
`listAccounts` plus one answers select); U: `unresolvedStrings` calls. Multi-account draft, the
path each request usually takes:

| Request | Before D/C/P/R/I/U | After |
|---|---|---|
| index GET | 1/1/1/1/1/1 | 1/1/1/1/1/1 |
| columns GET (saved mapping) | 1/2/1/1/1/1 | 1/**1**/1/1/1/1 |
| columns GET (no saved mapping) | 1/1/0/0/0/0 | 1/1/0/0/0/0 |
| columns POST (success) | 2/2/1/1/1/1 | 2/2/1/1/1/1 (unchanged, below) |
| accounts GET (asking) | 1/1/1/1/1/0 | 1/1/1/1/1/0 |
| accounts POST (success) | 1/2/2/3/2/1 | **1/1/1/2/1/1** |
| accounts POST (refused) | 1/1/1/2/1/0 | 1/1/1/2/1/0 |
| instruments GET (render) | 1/1/1/1/1/2 | unchanged (above) |
| instruments POST | 1/1/1/1/1/1 (+ `resolveAll`'s lock) | unchanged |
| review GET, review POST, commit | `readyParse`: one parse each; the commit's two reads are §7.2's | unchanged |

The accounts POST reads the draft row once either way (`:744`). Its after-write `parseDraft`
(`:850`) re-parsed the already-loaded draft and re-read the accounts and answers, and that is what
goes. The draft-row lock inside the write (`:812`) is a lock, not a read, and stays.

**The columns POST keeps two reads.** The route reads the file to parse the posted form
(`columns.tsx:222-224`), and `rememberMapping(draftId, mapping)` reads the draft and the file
again (`:400`, `:408`). Removing the second means either a second entry point beside
`rememberMapping` or changing the signature of the suite's staging door at 43 call sites across 16
test files. The saving is one CSV parse on a POST; it is left, and said here.

**The race the accounts POST no longer re-reads for.** Today the next step comes from a re-read
after the write, so an account renumbered in Settings in the milliseconds between the trial and the
write sends the reader straight back to accounts. After, the POST sends the reader on (instruments
or review), and that step's loader redirects before rendering anything to the step the re-read
would have named: accounts for a stale answer, columns for a number left recorded only on a closed
account (`instruments.tsx:46-47`, `review.tsx:89`). The answers written are
identical, and the browser follows both redirects to the same accounts page. No page renders
anything different.

## 4. Proving "one read"

A test through the test transaction. Postgres counts the scans a transaction makes on each table in
`pg_stat_xact_user_tables`, and `withDatabase`'s transaction can read it
(`tests/support/database.ts:89-93`). At `80373fa`, two selects on `upload_draft_account_answer`
read back as 2. `routingInputs` is the only reader of that table (`uploads.server.ts:346`); the
accounts write deletes from it (`:821`) and inserts into it (`:827`).

`tests/support/database.ts` gains `scansOf(table, db)`, which returns `seq_scan + idx_scan` for
the table from that view, `idx_scan` coalesced to 0 (Postgres picked a sequential scan for this small table and an index scan
for others, so both count). `tests/routes/upload-accounts.test.ts` gains one case: after staging, it
takes `const before = await scansOf("upload_draft_account_answer", ctx.db)`, posts a successful
answer, and asserts `scansOf(…) - before` is **2**: one `routingInputs` and the write's delete.
Measured at `80373fa` by the grounding review, the same delta is **3**: the after-write re-read is
the third. The count is a delta, because staging has already scanned the table (`rememberMapping`
routes, `:430`).

CSV reads and parses are pure and not countable this way; for them the argument is §3's table,
read off the code.

## 5. Tests

- **`tests/statement-routing.test.ts`.** Its assertions on `problems` (19 sites), `accounts` (13
  and the `holdings` helper `:86-91`), `unknownNumbers` (`:198`) and `skippedNumbers` (`:119`,
  `:124`) move to the arms. Every `holdings` or `accounts` assertion on a result whose arm is now
  `columns` or `accounts` goes, since those arms carry no groups: `:143-173`, `:176-188`,
  `:201-222`, `:224-238` (accounts-step problems), `:320-350`, `:416-436`, `:486-513` (columns-step problems).
  `stepOf` discards those groups today, so nothing a reader sees is lost; the per-account date at
  `:346-349` is still pinned on a clean file by `:309-318`. It gains **the step mapping**: an `it.each`
  over §1's table, one row per kind (both `nothing-to-record` rows), asserting the arm; a columns
  problem outranking an accounts one in the same file; the accounts arm's `unanswered` in
  first-line order, with a stale number on an earlier line than an unanswered one; and `NumberQuestion`'s `lines`, `instruments`, `answer` and `stale` for an
  answered, a skipped, an unanswered and a stale number.
- **`tests/routes/upload-accounts.test.ts` `:134-373`** keeps placement: which field or form a
  refusal lands on, and where the POST sends the reader. None of its cases asserts a kind-to-step
  mapping the pure test now owns, so none is deleted. It gains §4's scan-count case.
- **`tests/multi-account-upload.test.ts`** is unchanged: its `parseDraft` assertions
  (`:578-677`) read `DraftParse`, whose arms keep their shape, and its ADR-0015 cases pass as they
  are.

## 6. Documentation this change moves

- ARCHITECTURE.md Appendix A: the `statement-routing.server.ts` row (`:2422`) says
  `routeStatement` returns the step each problem belongs to and the accounts step's questions; the
  `uploads.server.ts` row (`:2418`) names `readDraft` as the one read a wizard request takes.
- ARCHITECTURE.md §6.1's multi-account text (`:1329-1333`) names the router as the owner of which
  step a routing problem belongs to.
- `docs/specs/README.md`: the 0030 row (added with this spec).

## 7. Differential validation

The claim: every wizard URL answers a multi-account draft exactly as `main` does, and a clean
commit writes the same rows. A `sonnet` sub-agent can run it from this section alone.

**Setup** as spec 0028 §7: two worktrees, a private Postgres recreated and migrated before each
tree's run, one untracked harness `tests/differential/router.test.ts` copied unchanged into both,
run with `--no-cache`, twice on `main` first to prove it deterministic, then `diff -r`. It imports
only what both trees export: `rememberMapping`, `answerAccountNumbers`, `parseDraft`,
`reviewForDraft`, `recordUpload`, `mappingScope` from `~/lib/uploads.server`; `updateAccount`
from `~/lib/accounts.server`; the `loader` of `index` and the `loader` and `action` of `columns`,
`accounts`, `instruments` and `review`; `tests/support/{database,fixtures,routes,review}.ts`. It
copies `tests/routes/upload-accounts.test.ts`'s file-local `seedHousehold` (`:53-63`), `answer`
(`:102-106`) and `resolveEveryString` (`:65-72`), and `tests/routes/upload-columns.test.ts`'s `SPREADSHEET_FIELDS`
and `saveColumns` (`:234-243`, `:270-276`) for the columns form's field names (`multiAccount`
comes from `mappingScope`, not the form). It stages each draft with `seedUploadDraft` and the columns
**action** (not the file's `stage`, which throws on a columns refusal, `:89-90`), so a columns
refusal is recorded as that POST's outcome.

**Cases**, one multi-account draft each:

| # | Draft |
|---|---|
| 1 | two unknown numbers, one answered to an account and one skipped |
| 2 | a blank number on one row |
| 3 | a number two open accounts record once trimmed: seeded as `" A-1"` and `"A-1"` (`seedAccount` writes the raw value; the unique index compares bytes) |
| 4 | a number only a closed account records |
| 5 | one account's rows disagreeing on the as-of date, on a recorded number |
| 6 | every unknown number posted as skipped with no number recorded: the accounts POST's form-level refusal (not a storable state) |
| 7 | an answer gone stale after Settings records a number on its account (`renumber`, `tests/support/fixtures.ts:228`) |
| 8 | case 1 with every string aliased (`resolveEveryString`), reviewed and committed |

For each case, in order: the columns POST that stages it, then index GET, columns GET, accounts
GET, accounts POST (cases 1 and 7: the draft's answers; case 6: all skipped), then for case 7
only `renumber` the answered account onto a number of its own, then instruments GET, review GET. Record each as `outcomeOf` gives it (status and `Location`, or the data: step,
`problems`' messages, `questions`, `errors`, `formError`). For case 8, also `position_set`'s `id`,
`account_id`, `as_of_date` and `source`, `holding`'s `instrument_id`, `quantity` and
`cost_basis_per_share`, and each account's number. Never whole rows: `position_set.created_at`
is the insert's own timestamp. Each to `$DIFF_OUT/<nn>-<name>.json`.

**Expected result.** `diff -r` empty.

**In the running app.** On the dev server over `scripts/seed-demo.ts` data: a multi-account upload
walked columns, accounts (one number answered, one skipped), instruments, review, record, on both
trees, the same screens and the same landing. Captures go in the pull request.

## Acceptance

**The router**
- [ ] `routeStatement` returns §1's `RoutedStatement`; `NumberQuestion` is built there.
- [ ] `grep -rn "refusalsByStep\|numberQuestions" app` returns nothing.
- [ ] `grep -n "stale-answer" app/lib/uploads.server.ts` returns nothing.

**The one read**
- [ ] `readDraft` is exported from `uploads.server.ts` and returns `{ file, parse }`; `draftFile`
  is exported; `columns.tsx` imports no `readCsv` and defines no `readDraftFile`.
- [ ] `answerAccountNumbers` calls `routedRead` once and `parseDraft` never.
- [ ] §4's scan-count case passes with a delta of 2.

**Tests**
- [ ] §5's changes; `tests/multi-account-upload.test.ts` unchanged.

**Documentation**
- [ ] §6's edits and no others.

**Gates**
- [ ] `npm run typecheck`, `npm test`, `npm run build` clean.
- [ ] §7's differential: `diff -r` empty.

## Review findings rejected

Grounding review, three rounds. Round 1: eleven findings, two material, both in §3 and §7:
`draftFile` had to be exported for the columns action, and §7's cases 2-5 could not be staged
through a helper that throws on a columns refusal. Both are folded in, with the minor ones but one. The
round also proposed deriving `unanswered` and `skippedNumbers` in `stepOf`, the one rejection
below, and showed that taking the instruments loader's strings from the parse would change what a
race shows, so that part left the slice (§3). Round 2: ten findings, one material (case 8
compared whole `position_set` rows, whose `created_at` differs per run), all folded in. Both
rounds walked §1-§3 against the code and found no input where the planned code differs from today,
the accounts POST's stated race aside. Round 3 checked the round-2 folds: four minor line and
wording slips, folded in, nothing material.

Rejected:
- *Drop `unanswered` and `skippedNumbers` from the router's arms and derive them in `stepOf` from
  the questions.* Kept: each is one derivation, in the router beside the taxonomy that defines it,
  where today `stepOf` restates it. The pure test pins them against the questions.

Code review, two reviewers (correctness; standards and shape), none blocking. The correctness
reviewer walked every problem-kind mix, the questions' fields, both of the accounts POST's
guards, and the trial's arms against `80373fa`, and found no difference the household sees. It also
ran §4's case on `80373fa`, where it fails with 3. Folded in from the standards review:
`AccountQuestion` derived from `NumberQuestion`; the accounts POST's guard as one condition; a
stale `parseDraft` mention; the `it.each` asserting through `arm`. The differential's `diff -r` was
empty on both comparisons (main against main, main against the branch), and the dev walk showed the
same screens and landing on both trees.

- *Code review: `readDraft` now reads the CSV for a draft with no fitting saved mapping, where
  `savedParse` returned before reading.* Kept: the index and instruments loaders pay one pure
  `readCsv` on a draft that is about to be sent to columns anyway; making the read lazy would
  split `DraftFile` in two for no visible change.
