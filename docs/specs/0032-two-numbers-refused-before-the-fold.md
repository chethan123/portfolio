# 0032 — Two account numbers in a one-account file are refused before anything folds

_Closes [#399](https://github.com/chethan123/portfolio/issues/399). Line numbers were read at
`dd9d88f`._

**What to build:** A one-account upload whose rows name two different account numbers is refused
by the parser, at the columns step, over the rows as written — before the raw-symbol fold in
`app/lib/statement.ts` and the alias fold in `app/lib/uploads.server.ts` can merge those rows into
one holding and leave the commit-time guard one number to look at. Today the file in #399 (VTI
under `A-111` and VTI under `B-222`, account A chosen) records 30 VTI in A with no warning, beside
the 20 B already holds: 50 shares counted where 30 exist.

Three edits, one module each way:

1. **`parseStatement` refuses a single-account file naming two numbers** (`statement.ts`), as a
   `ParseProblem` beside the differing row — the same rule and the same place as the two-as-of-dates
   refusal (`resolveAsOf`, `:228-268`): a statement is a photograph of one account on one day.
2. **A fold's number is the one its lots state, not the first lot's** (`statement.ts:586, :595-596`): a
   blank cell on the first lot no longer hides the number on the second, so what the commit
   captures does not depend on row order.
3. **The commit-time guard's intra-file half is deleted** (`uploads.server.ts:1590-1604`): no
   file reaching it can carry two numbers any more. The recorded-number half and the capture stay.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**Out of scope:**
- The several-accounts path. It groups by `(number, instrument)` in the parser (`statement.ts:535-537`)
  and routes by number (`statement-routing.server.ts`), so one instrument under two numbers is two
  positions there by design. Nothing here runs when `mapping.multiAccount === true`.
- The recorded-number half of the guard (`uploads.server.ts:1606-1620`) and the capture
  (`:1622-1646`): wording, step and `RefusedUpload` class unchanged. Only its input becomes
  trustworthy.
- `combineDuplicateRows: false`. A duplicate symbol already refuses at `:569-578`; a file of two
  numbers now also refuses on the number, two problems listed. Neither message changes.
- Skipped rows (`statement.ts:419-423`). In single-account mode a row with no quantity reads no
  number, as today; the rule below is over rows that became positions.
- #361 (an alias-lock refusal message), as the issue says.

## 1. Where the evidence is lost

`chosenAccountNumber` (`uploads.server.ts:1584-1647`) is correct over its input: it refuses two
different non-null numbers (`:1590-1604`), refuses a number other than the account's recorded one
(`:1606-1620`), and captures the one number when the account records none (`:1622-1646`). Its input
is `AssembledSection.rows` — `FileRow[]`, one per resolved instrument — and two folds run before
those rows exist, each keeping one number for a group of rows that may state two:

- **The raw-symbol fold** (`statement.ts:581-591`). Single-account mode groups records by raw
  instrument string alone (`:535-537`); `foldLots` sums the group's quantities (`:581`) and the
  folded position keeps `first.accountNumber` (`:586`). `VTI,10,A-111` and `VTI,20,B-222` leave the
  parser as one position: 30 VTI, `A-111`. `B-222` is gone.
- **The alias fold** (`uploads.server.ts:1096-1128`). `compareAccount` groups positions by resolved
  instrument id (`:1082-1089`); the folded row's number is the first non-null one in the group
  (`:1104-1105`) while `foldLots` sums every quantity (`:1119`). Two spellings of one instrument,
  `VTI,10,A-111` and `VANGUARD TOTAL STOCK MARKET ETF,20,B-222`, pass the first fold as two
  positions and leave this one as 30 VTI, `A-111`.

The guard's own header (`:1581-1583`) says it reads "the folded rows … not the raw positions, which
would refuse more files", and spec 0024 §1 (`0024-one-commit-over-routed-sections.md:61-65`) made
the same argument. The files it would refuse more of are exactly the ones in #399. And reading the
positions would not have been enough either: the first fold has already run on them.

Both existing mismatch tests use two different instruments (`tests/commit-upload.test.ts:1282-1319`,
`:1372-1397`), so neither fold ever combined their rows.

## 2. The fix, and why this shape

**Run the intra-file rule where every row still exists.** `parseStatement` is the only code that
sees the rows before any fold, and it already owns the whole-file consistency rule of the same
shape: `resolveAsOf` refuses two as-of dates "naming both — never picking one" (`statement.ts:228-268`,
tested at `tests/statement-parse.test.ts:740`). The account-number rule is its twin and goes beside
it. The parser's refusals are already data the columns step shows beside the row (`ParseProblem`,
`:111-116`), the mapping is not saved while any stand (`rememberMapping`, `uploads.server.ts:395`), and a
saved mapping that stops parsing sends every later read back to columns (`savedParse`, `:494-506`;
`review.tsx:88-89`). Nothing new is needed to refuse, keep the draft, or show the reader why.

Once the parser refuses two numbers, every single-account file that reaches a fold states at most
one non-null number. Both folds' "first non-null" rules (`statement.ts:586` after edit 2,
`uploads.server.ts:1104-1105`) are then exact rather than lossy, `chosenAccountNumber`'s intra-file
half can never fire, and the recorded-number half and the capture read a true number. So the half is
deleted rather than kept as a second copy of the rule.

**Rejected: carrying the set of numbers through both folds** (a list beside `accountNumber` on
`ParsedPosition`, threaded through `StatementGroup` and `AssembledSection` to the guard). It adds a
second account-number field beside the router's key, touches four types to deliver to the commit
what the parser knew at the row, and still leaves the review drawing a "2 rows combined" holding
the commit is about to refuse.

**Rejected: refusing per group inside the fold** (`statement.ts:581`). It would catch the
same-symbol case only, leave the two-alias case to the commit-time guard, and so keep one rule in
two places.

## 3. Changes

### 3.1 `app/lib/statement.ts`

**The rule.** In `parseStatement`'s single-account tail, before `resolveAsOf` (`:618`), over
`records` (`:357`, the rows that became positions, each with `accountNumber` already trimmed and
unwrapped by `accountNumberCell`, `:377-378`):

- Take the first record whose `accountNumber !== null` as `first`. No such record: nothing to check.
- Find the first later record whose `accountNumber !== null` and `!== first.accountNumber`. None:
  nothing to check.
- Otherwise push one `ParseProblem`: `row` the differing record's `row`, `column`
  `columns.accountNumber ?? null` — the mapping's header name as the reader chose it, verbatim, not
  a normalised or trimmed form: `problemFieldsOf` (`columns.tsx:184-205`) finds the select to mark
  by comparing `problem.column` to `mapping.columns.accountNumber` with `.trim()` on both sides, the
  same string `indexOf` (`statement.ts:332-344`) matched against the header — message:

  > This file says it describes account "A-111" on line 2 and "B-222" on line 3, and a statement
  > describes one account. Check which account this export belongs to. A file holding several
  > accounts uploads as "Several accounts", which routes each row by its number.

  No `code`: `ParseProblem.code` (`:115`) is `"blank-instrument"` only, and `blockedDraftFor`
  (`uploads.server.ts:595-599`) treats a coded problem as one remapping cannot fix. This one is fixed
  by remapping or by choosing "Several accounts", so it stays uncoded and the review loader
  redirects to columns rather than rendering the blocked panel (§3.3).

  Lines are one-based (`row + 1`), as every parser message. The first two clauses are the
  commit-time guard's (`uploads.server.ts:1598-1601`) with line numbers in place of "on one row …
  on another" and without "nothing was recorded", which is not yet a question at the columns step;
  the last sentence is verbatim from `:1600-1601`, pinned by
  `tests/commit-upload.test.ts:1393-1394`.

Inline, six to eight lines, no helper: `resolveAsOf` cannot be reused (it normalises as a date and
validates with `recordedDate`), and a one-caller twin of it would be the near-copy AGENTS.md warns
of. Comparison is `!==` on the cell as `accountNumberCell` leaves it: exact, surrounding whitespace
and line breaks aside, no case or zero folding (spec 0023 decision 15; ADR-0015) — the rule both
halves of the guard and the router already apply.

The `records` loop and the grouping are unchanged. The fold still runs on the refused file's groups;
the problem refuses it (`rememberMapping`, `savedParse`), as the as-of problem does.

**The fold's number.** At `:581-600`, compute once per group

```ts
const accountNumber = group.find((record) => record.accountNumber !== null)?.accountNumber ?? null;
```

and use it at `:586` (the position) and `:595-596` (the `combined` entry's `!== null` test and its
value) in place of `first.accountNumber`. Multi-account mode is unaffected: its key holds the number (`:536`), so every
record in a group states the same one. Single-account mode, after the rule above, has at most one
non-null number per file, so this is that number whichever lot carries it. The comment at `:594`
("Single mode reads the number too (the one-account guard), and leaves it off") stays true.

The single-lot branch (`:555-567`) is unchanged.

### 3.2 `app/lib/uploads.server.ts`

- Delete `:1590-1604` (the intra-file comment, `numbers`, `firstNumber`, `differingNumber`, the
  `RefusedUpload`, and the `if`'s closing brace at `:1604`). In their place one line, the shape `compareAccount` already uses (`:1104-1105`):

  ```ts
  const firstNumber = rows.find((row) => row.accountNumber !== null)?.accountNumber ?? null;
  ```

  The capture (`:1623-1626`) is its only remaining reader; its test at `:1624` becomes
  `firstNumber !== null` (`boundedNumber`, `:650`, takes a `string`). Nothing else changes in the
  capture.
- Rewrite the header `:1581-1583`: the guard reads the folded rows because the parser has already
  refused a file naming two numbers (§3.1), so every row's number is the file's one; it runs after
  `assembleDiff` because the date it resolves decides the baseline (#181). The claim that reading
  raw positions "would refuse more files" goes.
- `compareAccount:1104-1105` is unchanged in code; its "first non-null" is now exact for the reason
  above.

The review revision (`reviewRevisionOf`, `:1378-1399`) binds each folded row's number via
`revisionRows` (`:1317-1328`). Edit 3.1's fold change moves that number only for a file whose first
lot of an instrument has a blank cell and a later lot a number — a review drawn before this deploys
over such a file is refused as stale and redrawn (`verifyBinding`), which is the existing rule for
every binding change. The set of bound facts is unchanged, so `REVIEW_REVISION` (`:1375`) is not
bumped (0028's precedent).

### 3.3 Behaviour, stated

- **Where it refuses.** The columns step. A fresh save: `rememberMapping` returns `{ problems }`
  (`uploads.server.ts:395`), the route renders each message as a `FieldError` in the problems panel
  (`columns.tsx:387-393`) with the account-number select marked `aria-invalid` (`problemFieldsOf`,
  `:184-205`, keyed on `problem.column`), and the mapping is not saved. A draft whose mapping was
  saved before this rule (the issue's "accept the remembered mapping"): every read re-parses it
  (`savedParse`, `:494-506`), so `readDraft` reports `step: "columns"` with the problem; the problem
  carries no `code` and no routing `kind`, so `blockedDraftFor` (`uploads.server.ts:595-599`) returns
  null, `readyParse` (`:1019-1031`) throws `DraftNotReadyError("columns", null)`, and the review
  loader (`review.tsx:71-89`) takes the redirect branch to `/upload/:id/columns` (`:88-89`) rather
  than rendering the blocked panel; the columns loader shows the problem as `savedProblems`
  (`columns.tsx:73, :265`). `recordUpload` on such a draft throws
  a `DraftNotReadyError` whose `step` is `"columns"` from `readyParse` (`uploads.server.ts:1019-1031`) inside the
  account lock, before any write: `recordUpload` takes `withAccountLock` first (`:1565-1567`),
  `commitUnderLocks` locks the draft (`:1663`), and after two read-only checks (closed account `:1669-1670`, posted account `:1673-1678`)
  `assembleDiff` is the first read of the file (`:1408`), so the throw unwinds both locks with nothing written.
- **The draft survives.** Nothing in this path deletes a draft; it is swept at 24h as every draft is.
- **Nothing is written.** No `position_set`, no `holding`, no `external_account_number`; the other
  account's current positions are untouched because the commit is never entered.
- **Blank cells, per the existing rules.** A blank account-number cell is `null`
  (`optionalCell`, `:363-366`) and is ignored by the rule, by both folds' "first non-null", and by
  both halves of the guard (`uploads.server.ts:1608-1610` compares non-null rows only; capture reads
  the first non-null). So a file naming `A-111` on some rows and nothing on others states `A-111`:
  compared against the recorded number, or captured when there is none, whichever row carries it.
  A file whose every cell is blank states no number: no comparison, no capture, as today.
- **The chosen account has no number yet.** Two numbers refuse at columns regardless of the account;
  nothing is captured. One number is captured as today (`:1622-1646`).
- **Row order.** The rule reads every record; the fold reads every lot. Neither result depends on
  which row comes first.
- **Two aliases, one instrument.** Refused at columns like any two-number file; the alias fold is
  never reached.
- **Same-account lots still combine.** `VTI,10,100.00,A-111` and `VTI,20,130.00,A-111` fold to
  quantity `30.00000000`, basis `120.0000`, number `A-111`, `combined` `[{ instrument: "VTI",
  rowCount: 2, quantity: "30.00000000" }]`; the review note reads "2 rows combined"
  (`uploads.server.ts:1198`).
- **Several accounts.** Unchanged: `if (multiAccount)` returns early (`statement.ts:604-616`), and
  the rule sits after that return and before `resolveAsOf` (`:618`), so it never runs; the fold
  change is a no-op there (§3.1).

## 4. Tests

Parser, `tests/statement-parse.test.ts`, a new `describe("one account's number")` after
`describe("the as-of date")` (`:722`), using the file's `mapping()` helper with
`columns: { instrument: "Symbol", quantity: "Qty", accountNumber: "Account" }` (plus
`costBasis: "Basis"` where a basis is stated). `mapping()` sets `headerRow: 0` (`:12-21`) and
`parseStatement` finds columns by name in that row (`statement.ts:346-354`), so every case's rows
begin with the header `["Symbol","Qty","Account"]` — `["Symbol","Qty","Basis","Account"]` for the
basis case — and the "rows" listed below are the data rows after it. Row numbers are zero-based
over the whole file: the first data row is `row: 1` ("line 2"), the second `row: 2` ("line 3").

- `it("refuses two lots of one instrument under two account numbers, naming both lines, rather than combining them")`
  — rows `["VTI","10","A-111"]`, `["VTI","20","B-222"]`: `problems` has length 1; `problems[0]`
  has `row: 2`, `column: "Account"`, message matching `/"A-111" on line 2/`, `/"B-222" on line 3/`,
  `/one account/` and `/"Several accounts"/`.
- `it("refuses the same two numbers with the rows reversed, naming them in the file's order")` —
  rows `["VTI","20","B-222"]`, `["VTI","10","A-111"]`: one problem, `/"B-222" on line 2/`,
  `/"A-111" on line 3/`.
- `it("refuses two different instruments under two account numbers, since the rule is the file's, not the instrument's")`
  — rows `["IN1","10","A-111"]`, `["IN2","5","B-222"]`: one problem naming both.
- `it("ignores blank cells, so the number a later lot states is the position's whichever lot comes first")`
  — rows `["VTI","10",""]`, `["VTI","20","A-111"]`: `problems` `[]`, `positions[0]` matches
  `{ quantity: "30.00000000", accountNumber: "A-111" }`; then the same rows reversed give the same
  two values.
- `it("combines two lots under one number as before, quantity summed and basis weighted")` — rows
  `["VTI","10","100.00","A-111"]`, `["VTI","20","130.00","A-111"]` with `costBasis: "Basis"`:
  `problems` `[]`; `positions[0]` matches `{ quantity: "30.00000000", costBasisPerShare:
  "120.0000", accountNumber: "A-111" }`; `combined` equals
  `[{ instrument: "VTI", rowCount: 2, quantity: "30.00000000" }]`.

The multi-account case is already pinned: `:873` ("keeps one instrument held in two accounts as two
positions, each with its own number") and `:1039` (combines within one account, never across). Both
must stay green unchanged.

Commit, `tests/commit-upload.test.ts`, inside `describe("recordUpload")` (`:425`), replacing the
two intra-file tests at `:1282` ("refuses a file whose own rows disagree about the account number,
naming both") and `:1372` ("points a one-account upload whose rows name two numbers at Several
accounts"), which call `stage` and so would now throw at `:77-81`. `seedUploadDraft` takes `bytes`
as a `Uint8Array` (`tests/support/fixtures.ts:83`): every CSV string below is passed through the
file's `encode` helper (`:38`), written once here rather than at each case. Both row orders are
pinned in the parser suite above; the commit cases surface that same parse problem, so they use one
order:

- `it("refuses at the columns step a file whose rows name two account numbers, keeping the draft and recording nothing")`
  — `seedAccount({ kind: "brokerage" })`; `seedUploadDraft({ account, filename: FILENAME, bytes })`
  over `"Symbol,Quantity,Basis,Acct\nIN1,10,,A-111\nIN2,5,,B-222\n"`; `rememberMapping(draft.id,
  { ...BASE_MAPPING, columns: { ...BASE_MAPPING.columns, accountNumber: "Acct" } }, db)` returns an
  object with `problems`, whose one message matches `/A-111/`, `/B-222/`, `/one account/` and
  contains `'A file holding several accounts uploads as "Several accounts", which routes each row by
  its number.'`; `requireDraft(draft.id, db)` resolves with `mapping` `null`; no `position_set` for
  the account; `account.external_account_number` is `null`.
- `it("sends a draft whose saved mapping predates the rule back to the columns step, capturing no number and touching neither account")`
  — the issue's reproduction. `seedAccount` A with no number, B with
  `externalAccountNumber: "B-222"`; `seedInstrument({ symbol: "VTI", … })` with
  `seedInstrumentAlias` for `"VTI"` (keep it: were the rule broken, review would then succeed and
  the case fail outright, rather than stopping at the instruments step); `seedPositionSet({ account: B, asOf: "2026-06-30", holdings:
  [{ instrument: vti, quantity: "20" }] })`; `seedUploadDraft({ account: A, bytes, mapping })` with
  the mapping planted (the fixture's `mapping` option, `fixtures.ts:86`) — the same object the
  first case passes to `rememberMapping`, `{ ...BASE_MAPPING, columns: { ...BASE_MAPPING.columns,
  accountNumber: "Acct" } }`, so the saved parse reads the `Acct` column; a mapping without it
  would pass the step and the case would prove nothing — and bytes
  `"Symbol,Quantity,Basis,Acct\nVTI,10,,A-111\nVTI,20,,B-222\n"`. Then
  `reviewForDraft(draftId, "2026-06-30", db)` rejects with a `DraftNotReadyError` whose `step` is
  `"columns"`; `recordUpload(draftId, { accountId: A.id, asOf: "2026-06-30" }, db)` rejects the same
  way; A has no `position_set`; A's `external_account_number` is `null`; `accountHoldings(B.id, db)`
  holds one row with `quantity` `"20.00000000"`; `requireDraft(draftId, db)` resolves.
- `it("refuses two spellings of one instrument under two account numbers before they can fold")`
  — one instrument with aliases `"VTI"` and `"VANGUARD TOTAL STOCK MARKET ETF"`; bytes
  `"Symbol,Quantity,Basis,Acct\nVTI,10,,A-111\nVANGUARD TOTAL STOCK MARKET ETF,20,,B-222\n"`;
  `rememberMapping` as above returns `problems` naming both; no `position_set`; number `null`.
  The raw strings differ, so only the account-number rule stops this file: it is the alias fold's
  regression.
- `it("combines two spellings of one instrument under one number, with exact quantity and weighted basis, and captures the number")`
  — same two aliases; `stage(ctx, account, "Symbol,Quantity,Basis,Acct\nVTI,10,100.00,A-111\nVANGUARD
  TOTAL STOCK MARKET ETF,20,130.00,A-111\n", { columns: { accountNumber: "Acct" } })`;
  `onlySection(await diffForDraft(draftId, db)).added` has one row matching
  `{ quantity: "30.00000000", costBasisPerShare: "120.0000" }` with `note` matching
  `/2 rows combined/`; `reviewAndRecord(draftId, db, { asOf: "2026-06-30", extra: { accountId:
  account.id } })` records one set; `external_account_number` is `"A-111"`.
- `it("captures the number a later lot states when the first lot's cell is blank")` — the fold
  change's own case. `seedAccount({ kind: "brokerage" })`; `seedInstrument({ symbol: "CAP", name:
  "Captured Fund" })` with `seedInstrumentAlias({ instrument, rawString: "CAP" })`, as `:1346-1358`
  does — without the alias `stepOf` (`uploads.server.ts:548-554`) reports `step: "instruments"` and
  `reviewForDraft` throws `DraftNotReadyError("instruments")` from `readyParse` (`:1025`) before the
  guard runs. Then `stage(ctx, account, "Symbol,Quantity,Basis,Acct\nCAP,10,,\nCAP,20,,Z-999\n",
  { columns: { accountNumber: "Acct" } })`; `onlySection(await diffForDraft(draftId, db)).added` has
  one row with `quantity` `"30.00000000"`; `reviewAndRecord` as above records; the account's
  `external_account_number` is `"Z-999"`.

The unchanged commit tests at `:1249` (disagrees with the account's, naming both), `:1321` (rows
agree, commits), `:1346` (captures when none recorded) and `:1399` (trims a captured number) pin the
half of the guard that stays, and stay green.

Route, `tests/routes/upload-columns.test.ts`, in a new `describe("a one-account draft naming two
account numbers")` at the end of the file, after `saveColumns` (`:270-277`) and `problemsOf`
(`:280-286`), which it reuses rather than posting through `action(args(post(...)))` by hand.
`saveColumns` posts `SPREADSHEET_FIELDS` (`:234-243`) with per-field overrides, an `undefined`
override dropping the field; `problemsOf` returns the action's refusal and fails naming the
redirect if it got one instead:

- `it("shows both numbers beside the account-number column, and saves nothing")` —
  `ctx.seedAccount()` and `ctx.seedUploadDraft({ account, bytes: encode("Symbol,Quantity,Account\nVTI,10,A-111\nVTI,20,B-222\n") })`
  (`encode`, `:26`); then

  ```ts
  const refused = await problemsOf(
    saveColumns(draft.id, {
      instrument: "Symbol",
      quantity: "Quantity",
      accountNumber: "Account",
      name: undefined,
      costBasis: undefined,
      asOf: undefined,
    }),
  );
  ```

  `refused.problems` (`string[]`, the messages — `columns.tsx:225`) has one entry matching
  `/"A-111" on line 2/` and `/"B-222" on line 3/`; `refused.problemFields` equals
  `["accountNumber"]` (`:226`); `requireDraft(draft.id, ctx.db)` has `mapping` `null`.

No fixture file is added: every case is a three-line inline CSV, as the file's own inline tests are.

## 5. Documentation this change moves

- `ARCHITECTURE.md` §6 commit diagram (`:1246-1248`): node `E` ("file names two different
  accounts?") and `R3` leave the commit flow, and the three edges at `:1246-1248` (`D2 -->|no| E`,
  `E -->|yes| R3`, `E -->|no| F`) become the one edge `D2 -->|no| F`; a sentence in the paragraph
  at `:1322-1325` says the two-numbers refusal is `parseStatement`'s, at the columns step, so the
  folded rows the guard reads state one number.
- `docs/specs/0024-one-commit-over-routed-sections.md:61-65`: a `Reversed` banner in the
  `docs/specs/README.md` form (the `0002` pattern) beside "Checking the raw positions instead would
  refuse more files": the files it would have refused are #399's; the rule moved into the parser
  (0032).
- `CONTEXT.md` "Account number" (`:293-301`): "a file naming a different number than the recorded
  one, or two numbers of its own, is refused rather than landed in the wrong place".
- `docs/guide/upload.md` §"The six columns" (`:72-75`): one sentence — a one-account file whose rows
  name two account numbers is refused at this step and belongs under **Several accounts**.
- `docs/guide/when-something-is-refused.md:112-114` ("Rows disagree about the account number", under
  "The file itself is refused") **stands as written**. It already describes a whole-file refusal in
  the same list as the as-of-date rule and names no step, and both halves of what it says — one
  account per file, or **Several accounts** — remain the reader's choices. Do not add a second
  bullet for the columns step and do not delete this one.
- `docs/specs/README.md`: the 0032 row.

## Acceptance

- [ ] A one-account file naming two account numbers is refused at the columns step, naming both
      numbers and their lines, in either row order, with the same or different instruments, and
      with two aliases of one instrument
- [ ] The refusal is a `ParseProblem` on the account-number column; the mapping is not saved; the
      draft survives
- [ ] A draft whose saved mapping predates the rule is sent back to columns on review and refused
      by `recordUpload` with a `DraftNotReadyError` whose `step` is `"columns"`, writing nothing and capturing nothing
- [ ] Same-account lots combine with exact quantity (`30.00000000`) and weighted basis
      (`120.0000`), and the review says "2 rows combined"
- [ ] A number on a later lot is the position's when the first lot's cell is blank
- [ ] `chosenAccountNumber`'s intra-file refusal is deleted; its recorded-number refusal and the
      capture are unchanged and their tests green
- [ ] Several-account parsing and routing tests unchanged and green
- [ ] `npm run typecheck`, `npm test`, `npm run build` green
