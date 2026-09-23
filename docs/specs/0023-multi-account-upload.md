# A multi-account upload, routed by account number

Canonical here. Decided in [ADR-0015](../adr/0015-an-account-number-selects-the-account-on-a-multi-account-upload.md),
which records the trade-offs; this file records what to build. When the two disagree on a fact
about the code, this file wins. Not yet broken into tickets.

Builds on [spec 0004](0004-ingest.md) (the four-screen upload over a durable draft) and reverses two
of its lines: "one file covering several accounts" leaves Out of Scope, and the account number is no
longer only a guard. [ADR-0013](../adr/0013-a-first-sighting-answer-is-the-drafts-until-recorded.md)
is the pattern the account-number answer copies. `CONTEXT.md` has the amended **Account number**
entry.

> **Built with these differences.** This spec is marked implemented (`docs/specs/README.md`), and on
> review of #383 six things below read differently from what landed. Corrected in place here, one
> block, rather than by rewriting the sections they touch (`docs/specs/README.md`'s banner
> convention):
>
> - **Decision 13** (below, and repeated under "The parser, in multi-account mode"): ~~"A row with a
>   blank account number refuses the file"~~ is too wide. `statement.ts` skips a row whose quantity
>   cell is an absence marker (a totals or footer line) before the blank-number check ever runs
>   (`statement.ts:407-413`, `:500-503`), so that row is silently dropped like any other absent-quantity
>   row, not refused. **A row that would be a position and names no account refuses the file.**
> - **Schema:** ~~"One migration"~~ — three, each its own transaction:
>   `0015_account_open_number_unique.sql`, `0016_multi_account_draft_and_mapping.sql`,
>   `0017_upload_draft_account_answer.sql`.
> - **Routing:** ~~"A pure function beside `statement.ts`"~~ — `app/lib/statement-routing.server.ts`.
>   A `.server.ts` module, not a sibling of `statement.ts` in the sense that matters here: it imports
>   `listSentence` from `input.server.ts` for its refusal messages, so it crosses the `.server`
>   bundle boundary `statement.ts` never does (ARCHITECTURE.md §4.3).
> - **Review binding:** the per-account field list leaves out `appendWatermark-<accountId>`, which
>   the commit relies on to detect a write since review (`review.tsx:719-723` emits it,
>   `uploads.server.ts` reads it back at commit). Add it to the list below.
> - **The commit:** "`commitUpload` branches on the draft's account" is backwards — `recordUpload`
>   does that branching; `commitUpload` itself refuses a multi-account draft outright
>   (`uploads.server.ts:1618-1622`).
> - **The done page:** a set superseded since review is not left out — `uploadReceipt` shows it, with
>   its filed-behind note, the same receipt contract spec 0005 §5 set. Only an id naming no upload
>   set at all is left out. And the cap: at most the first 50 ids in `?sets=` (`MAX_RECORDED_SETS`)
>   are read; the rest are ignored.

## Problem Statement

Every upload starts by picking one open account (`app/routes/upload.tsx`), and `upload_draft.account_id`
is `not null`. A file holding several accounts' positions, whether a spreadsheet the household
already keeps or a brokerage's all-accounts export, has to be split by hand into one CSV per
account, then taken through mapping, instruments and review once for each. It is the hand-editing
the tolerant reader (0004 §"The parser is ours") exists to spare the household, and the N commits
that result have no atomicity between them.

The file already says which account each row belongs to: 0004's mapping has an optional
`accountNumber` column. Today it is only a guard (`commitUploadUnderLock`, "never a selector"),
because a number was not trustworthy as a key: optional, free text, not unique.

## Solution

Picking the account becomes optional. `/upload` offers the open accounts, as now, plus **Several
accounts (the file has an account-number column)**. Choosing that makes a **multi-account draft**:
no `account_id`, the account-number column required in the mapping, and every row routed to the
open account whose recorded number matches its own. Mapping, instruments and review stay one pass
over the whole file. The commit records one `position_set` per account the file names, in one
transaction.

A single-account upload is unchanged, guards included.

## Decisions

Each one was settled in the design session that produced ADR-0015.

1. **The column is the institution's full Account number** (glossary term, not "account ID").
2. **An unknown number is asked about once per upload.** A new step, `/upload/:draftId/accounts`,
   comes after columns and before instruments, and is skipped when every number matches. Each
   unknown number is given to an account or skipped (its rows are not recorded). The answer is the
   draft's, in `upload_draft_account_answer`, and is written to `account.external_account_number`
   only at commit. A recorded number outranks an answer: if the number has since been recorded on
   an open account, rows route there and the answer is ignored. An answer whose account has since
   recorded any number refuses the commit as stale and sends the reader back to the accounts step.
   Skipping every number refuses at that step, since nothing would be recorded.
3. **Any mix of institutions** in one file.
4. **The mapping is saved by header fingerprint alone**, in a multi-account scope separate from the
   institution scope. The account-number column is required there, and stays optional in a
   single-account mapping.
5. **At most one open account records a given number.** A partial unique index. Settings refuses a
   duplicate, naming the account that holds it, and so does a commit that would record one.
6. **`owedAsPositive` negates only rows routed to an account whose kind `isOwed`** (today,
   `liability`). It is labelled "Balances owed are listed as positive" and defaults to unticked,
   since there is no single account type to default from.
7. **An open account the file does not name is untouched.** No statement is recorded for it.
8. **One as-of date per account.** The as-of column is mapped for the whole file or not at all.
   Mapped, its values may differ between accounts and must agree within each one; rows of one
   account disagreeing refuse the file, naming the account. Unmapped, one typed date applies to
   every account, and the review URL's `?asOf=` stays one value.
9. **All or nothing.** One transaction. Hard refusals (a closed account, the overflow guard, a
   stale answer, a moved baseline) stop at the first, naming the account and the reason. Missing
   confirmations are collected across every account and named together, as the single-account
   commit already collects its own (#181), so the reader is not walked back one account at a time.
10. **Review is grouped by account.** Each section has the account name and number tail, its date,
    its diff, and its own removal tick and filed-behind acknowledgement. Commit is refused until
    every required one is given.
11. **One entry point.** `/upload` with the account choice optional, as in the Solution above.
12. **The picker offers only open accounts with no number recorded**, plus skip. Giving one account
    to two numbers in one upload is refused.
13. **A row with a blank account number refuses the file**, listing its line numbers and
    instruments.
14. **A number recorded only on a closed account refuses the file**, naming the account and saying
    the number can be cleared on it in Settings.
15. **Matching is exact after trimming surrounding whitespace.** No case folding, no stripping of
    dashes or zeros. A spreadsheet's `123456` for `00123456` reaches the picker as unknown.
16. **After commit, `/upload/done?sets=<id>,<id>,…`** lists each account with its date and change
    counts and links to its account page, whose receipt is unchanged.

Implied by the above, and not separately decided:

- Duplicate rows are combined per (account, instrument), never across accounts.
- First-sighting answers are the draft's, as today, and shared by every account in it. The
  instruments step asks about every unresolved string in the file, including those only on rows
  later skipped, because `had_first_sightings` and the next step are decided at the columns step,
  before any number is answered. The commit still promotes only strings the recorded groups state
  (ADR-0013).
- A number not yet recorded is written at commit; any number already recorded stays as it is.

## Implementation Decisions

### Schema

One migration:

- `upload_draft.account_id` becomes nullable. A null account is the multi-account draft, which is a
  property of the row, following 0004's "how far did this draft get" reasoning, not a status column.
- `create table upload_draft_account_answer (draft_id … on delete cascade, account_number text
  collate "C" not null, account_id bigint references account (id) on delete cascade, primary key
  (draft_id, account_number))`. A null `account_id` is "skip these rows". A partial unique index on
  `(draft_id, account_id) where account_id is not null` enforces decision 12's one-account-one-number.
- `column_mapping.institution` becomes nullable, where null is the multi-account scope, and
  `column_mapping_one_per_fingerprint` is replaced by two partial unique indexes: `(institution,
  header_fingerprint) where institution is not null` and `(header_fingerprint) where institution is
  null`.
- `create unique index account_open_number_unique on account (external_account_number) where
  closed_at is null and external_account_number is not null`. The migration first checks for
  duplicates and raises naming them, rather than failing on the index with Postgres's own message.
  Its comment supersedes `0001`'s "never a selector" on the column.

`npm run db:types` is re-run and `database.generated.ts` committed: `UploadDraft.account_id` and
`ColumnMapping.institution` become nullable and `UploadDraftAccountAnswer` appears. CI's verify
step fails otherwise.

### Stored numbers are trimmed on every write

The router compares trimmed strings and the unique index compares stored bytes. They agree only if
every writer stores the trimmed form. Settings already does (`optionalText`), and so does the
parser's account cell (`optionalCell`); the commit's number write must too. The commit also applies
Settings' 64-character bound (`accountInput.externalAccountNumber`), refusing a longer file number
rather than bypassing it.

### The parser, in multi-account mode

`parseStatement` today does three things per file that decisions 6 and 8 and the per-account
combining rule need per account. It groups duplicate rows by instrument string alone and keeps the
first row's number, so VTI held in two accounts would fold into one position. It applies
`owedAsPositive` to every position. And it refuses two differing as-of sightings across the file.
`assembleDiff` then folds again, by resolved instrument, across the whole file.

In multi-account mode (a flag on the mapping, set by the multi-account scope):

- grouping is by `(accountNumber, instrument)`;
- `signed()` is not applied, and sign is left to the router;
- as-of sightings are collected per account number and returned unresolved;
- every row with a blank number is kept with its line number, for decision 13's refusal.

`assembleDiff` folds within each routed group, never across groups.

### Routing

A pure function beside `statement.ts` takes the multi-mode parse, the open accounts (number, kind,
id), the closed accounts' numbers and the draft's answers. It returns rows grouped by account, each
with its sign applied by `isOwed(kind)` and its own as-of date, plus the problems: blank numbers,
closed-only numbers, unanswered numbers, and disagreeing dates within an account. Precedence is
recorded number first, then answer. Every step after columns reads this, and nothing downstream
re-matches.

### Loading a draft with no account

`findDraft` inner-joins `account` and `person` on `upload_draft.account_id`, so a null account drops
the row and every step reports the draft expired. It becomes a left join. `UploadDraft.accountId`,
`BlockedDraft.accountId`, `UploadDiff.accountId` and `draftAccountId` become `string | null`, and so
do their readers: `columns.tsx`'s `getAccount`, `review.tsx`'s hidden `accountId`, and `draft.tsx`'s
`accountIdOf`. `requireDraft`'s "closed account means expired" applies only to a single-account
draft. For a multi-account draft, an account closing mid-draft surfaces as the router's closed-only
refusal on the next read. Step headers read "filename · several accounts" where they now name the
account and owner.

### Steps

`DraftParse` gains `{ step: "accounts"; unanswered: string[] }` between `columns` and
`instruments`, and `parseDraft` decides it, so resume and the step redirects follow from one rule
as today. `UploadSteps` becomes five entries. The accounts step is dimmed with "· none" when every
number matched, as the instruments step already is, and is absent from a single-account draft's
strip.

### Mapping scope

`findMapping` and `upsertMapping` take `institution: string | null`. The lookup uses `is null` for
the multi-account scope, since `= null` never matches. The upsert can't name a partial index with
`on conflict on constraint`, so it uses index inference with the predicate:
`on conflict (institution, header_fingerprint) where institution is not null`, or
`on conflict (header_fingerprint) where institution is null` (Kysely `columns([...]).where(...)`).

### Duplicate numbers under concurrency

A pre-check alone does not enforce decision 5. `createAccount` and `updateAccount` take no lock, and
a commit writing a number to A holds only the locks of the accounts it routes to. Both Settings
writers and the commit catch `23505` on `account_open_number_unique`, re-query to name the account
that holds the number, and refuse (the commit with a `RefusedUpload`). Add the Settings-vs-commit
and commit-vs-commit rows to ARCHITECTURE.md §7.2's race table.

### Review binding

There is one review revision per draft. It hashes every group's account id, rows, baseline, latest
set id, append watermark and as-of date, sorted by account id. The per-account form fields are flat,
because `review.tsx` passes `formFields(...)` straight through: `baselineSetId-<accountId>`
(with `""` as null's wire form, as today), `confirmRemovals-<accountId>` and
`confirmFiledBehind-<accountId>`, plus one `asOf`. `CommitInput` stays a flat record of optional
strings.

### The commit

`commitUpload` branches on the draft's account. The multi-account path nests `withAccountLock` once
per routed account, in ascending numeric id order. Compare the ids by length, then text: they are
bigint strings, so never `Number()` and never a plain `sort()`. `inTransaction` reuses the outer
transaction, so the nest is one transaction. Each writer locks one account row, and `withAccountLock`
already says "several accounts: lock ids in order", so the ordering is deadlock-free.

Under the locks, per group:
1. the account is still open;
2. any answer that routed rows here is still valid (decision 2);
3. the baseline compare-and-set against its own `baselineSetId-<id>`;
4. `fitsTheMoneyColumn` for every row;
5. the missing filed-behind and removal confirmations are collected across all groups and refused
   together (decision 9).

Then it:
1. inserts one `position_set` per group;
2. promotes instrument answers once;
3. writes the answered account numbers, trimmed. Both reads come before the draft delete, which
   cascades the answers away, as alias promotion already does;
4. deletes the draft.

The single-account path's checks move into a shared per-account function and are otherwise
unchanged.

The intra-file "two numbers" refusal on a single-account upload gains one sentence pointing at the
multi-account option.

### The done page

`route("upload/done", …)` is added to `app/routes.ts` by hand; a static segment outranks
`upload/:draftId`. Each id in `?sets=` is read through `uploadReceipt` with the account taken from
`position_set.account_id`. An id naming no upload set (hand-edited, manual, or since superseded as
latest) is left out rather than failing the page. `requestRefresh()` moves with the redirect, as
`review.tsx` does it today.

## Testing Decisions

The seam is 0004's: server modules take `db` last, tests run on real Postgres, and the parser and
router are pure.

- Parser, multi mode: one instrument in two accounts stays two positions; no sign applied; per
  account as-of sightings; blank-number rows keep their line numbers.
- Routing: exact match, whitespace trim, case not folded, blank number, closed-only number, a
  number on both a closed and an open account routing to the open one, answers and skips, a
  recorded number outranking an answer, sign by `isOwed`.
- Mapping: the multi-account scope saves and re-applies by fingerprint alone, and never collides
  with an institution mapping with the same header.
- The unique index: Settings refusal, commit refusal, a `23505` race naming the holder, the
  migration's duplicate check.
- The commit: two accounts land atomically; one account's refusal leaves both unrecorded; an
  unnamed open account is untouched; per-account dates, ticks and baseline staleness;
  `owedAsPositive` flips only the liability rows; account numbers written only for answered accounts;
  a stale answer refused; every row skipped refused; missing confirmations across two accounts
  named together; a draft with no account loads at every step.
- The single-account suite passes unchanged.

Fixtures: a two-institution spreadsheet with a liability row, a file with one blank account number,
and one with a number recorded on a closed account.

## Out of Scope

- Creating an account from an unknown number (ADR-0015, considered options).
- Emptying an account through a multi-account upload. Absence means untouched (decision 7).
- Normalising account numbers beyond trimming (decision 15).

## Documents this changes on landing

- `ARCHITECTURE.md` (the `external_account_number` line in the diagram, "The account number is a
  guard, never a selector", the `column_mapping_one_per_fingerprint` constraint row, and §7.2's
  race table) and `docs/data-model.md` (the column row and the constraint line): both roles per
  ADR-0015, and the two partial indexes.
- `README.md`'s upload description and the family guide's upload page, if either says "pick the
  account".
- `docs/specs/README.md` gets this spec marked implemented.
