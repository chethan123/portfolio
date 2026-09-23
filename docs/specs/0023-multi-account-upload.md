# A multi-account upload, routed by account number

Canonical here. Decided in [ADR-0015](../adr/0015-an-account-number-selects-the-account-on-a-multi-account-upload.md),
which records the trade-offs; this file records what to build. When the two disagree on a fact
about the code, this file wins. Not yet broken into tickets.

Builds on [spec 0004](0004-ingest.md) (the four-screen upload over a durable draft) and reverses two
of its lines: "one file covering several accounts" leaves Out of Scope, and the account number is no
longer only a guard. [ADR-0013](../adr/0013-a-first-sighting-answer-is-the-drafts-until-recorded.md)
is the pattern the account-number answer copies. `CONTEXT.md` has the amended **Account number**
entry.

## Problem Statement

Every upload starts by picking one open account (`app/routes/upload.tsx`), and `upload_draft.account_id`
is `not null`. A file holding several accounts' positions, whether a spreadsheet the household
already keeps or a brokerage's all-accounts export, has to be split by hand into one CSV per
account, then taken through mapping, instruments and review once for each. It is the hand-editing
the tolerant reader (0004 §"The parser is ours") exists to spare the household, and the N commits
that result have no atomicity between them.

The file already says which account each row belongs to: 0004's mapping has an optional
`accountNumber` column. Today it is only a guard (`uploads.server.ts:1059`, "never a selector"),
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
   only at commit.
3. **Any mix of institutions** in one file.
4. **The mapping is saved by header fingerprint alone**, in a multi-account scope separate from the
   institution scope. The account-number column is required there, and stays optional in a
   single-account mapping.
5. **At most one open account records a given number.** A partial unique index. Settings refuses a
   duplicate, naming the account that holds it, and so does a commit that would record one.
6. **`owedAsPositive` negates only rows routed to a `liability` account.** It is labelled "Balances
   owed are listed as positive" and defaults to unticked, since there is no single account type to
   default from.
7. **An open account the file does not name is untouched.** No statement is recorded for it.
8. **One as-of date per account.** A typed date applies to every account. A mapped as-of column
   may differ between accounts and must agree within each one. Rows of one account disagreeing
   refuse the file, naming the account.
9. **All or nothing.** One transaction, and the first refusal names the account and the reason.
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
- First-sighting answers are the draft's, as today, and shared by every account in it.
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

`npm run db:types` is re-run.

### Routing

A pure function beside `statement.ts` takes the parsed rows, the open accounts' numbers, the closed
accounts' numbers and the draft's answers, and returns rows grouped by account plus the problems
(blank number, closed-only number, unanswered number). Trimming happens here and nowhere else.
Every step that reads the parse reads this, and nothing downstream re-matches.

### The commit

`commitUpload` branches on the draft's account. The multi-account path takes `withAccountLock` on
every routed account in ascending id order, so two concurrent uploads cannot deadlock. It then runs
the existing per-account checks for each group (the baseline compare-and-set against that account's
own `baselineSetId`, the filed-behind acknowledgement, the removal tick, `fitsTheMoneyColumn`), then
inserts one `position_set` per group, promotes instrument answers once, writes the answered account
numbers, and deletes the draft. `CommitInput` carries the per-account fields keyed by account id.
The single-account path is not restructured beyond what extracting the per-account checks into a
shared function requires.

The intra-file "two numbers" refusal on a single-account upload (`uploads.server.ts:1044`) gains one
sentence pointing at the multi-account option.

## Testing Decisions

The seam is 0004's: server modules take `db` last, tests run on real Postgres, and the parser and
router are pure.

- Routing: exact match, whitespace trim, case not folded, blank number, closed-only number, a
  number on both a closed and an open account routing to the open one, answers and skips.
- Mapping: the multi-account scope saves and re-applies by fingerprint alone, and never collides
  with an institution mapping with the same header.
- The unique index: Settings refusal, commit refusal, the migration's duplicate check.
- The commit: two accounts land atomically; one account's refusal leaves both unrecorded; an
  unnamed open account is untouched; per-account dates, ticks and baseline staleness;
  `owedAsPositive` flips only the liability rows; account numbers written only for answered accounts.
- The single-account suite passes unchanged.

Fixtures: a two-institution spreadsheet with a liability row, a file with one blank account number,
and one with a number recorded on a closed account.

## Out of Scope

- Creating an account from an unknown number (ADR-0015, considered options).
- Emptying an account through a multi-account upload. Absence means untouched (decision 7).
- Normalising account numbers beyond trimming (decision 15).

## Documents this changes on landing

- `ARCHITECTURE.md` (the `external_account_number` line in the diagram, and "The account number is
  a guard, never a selector") and `docs/data-model.md`'s column row: both roles, per ADR-0015.
- `README.md`'s upload description and the family guide's upload page, if either says "pick the
  account".
- `docs/specs/README.md` gets this spec marked implemented.
