# 0024 — One commit over routed sections; a chosen account is a routing of one

_Candidate 2.1 of [the second architecture review](../research/2026-09-24-architecture-review.md)
(card 1 of its [visual companion](../research/2026-09-24-architecture-review/report.html)).
Line numbers below were read at `cf11d01`._

**What to build:** `app/lib/uploads.server.ts` carries two near-copies of the upload commit —
`commitUploadUnderLock` (an account chosen up front) and `commitMultiAccountUnderLocks` (rows routed
by account number; [0023](0023-multi-account-upload.md), ADR-0015) — and two near-copies of the
assembler, `assembleDiff` and `assembleMultiDiff`, with two review-revision recipes (`v3`, `v4`).
Replace them with one assembler and one commit over a list of **groups**, one per account. A draft
with a chosen account yields exactly one group; a draft of several yields the router's. The
single-account path keeps only what is genuinely its own: the number guard. `UploadDiff.accounts`
becomes always an array, the review form has one key scheme and one encoder, `recordUpload` returns
`CommittedUpload[]`.

Worth doing on its own because the two paths have already drifted three times (below), and every
future rule about a commit would otherwise be written twice. It changes shape only: what the
household sees — refusals, their wording and field keys, landing pages, the review's rows and
confirmations, the done page — is fixed. The one observable difference is intended: a review drawn
before this deploys carries a `v3.`/`v4.` revision and a differently keyed form, and is refused as
stale after it (the safe direction; the reader reloads and records).

**Blocked by:** Nothing.

**Status:** ready-for-agent

**Out of scope:** a review-binding module (candidate 2.2); router step ownership and a `resumeAt`
translator (2.8, 2.9); the tracked `.orig` files; ARCHITECTURE.md references this change does not
move; any drive-by.

## 1. The group

```ts
// uploads.server.ts — not exported
type StatementGroup = Pick<
  RoutedAccount,
  "accountId" | "answered" | "positions" | "combined" | "skipped" | "asOfDate"
> & {
  accountNumber: string | null; // the router's key; null for a chosen account (the guard reads the file's)
};
```

A `RoutedAccount` (`statement-routing.server.ts:32`) is assignable to it unchanged, so the router's
output is the multi-account draft's groups with no copy. `accountName` is dropped: the assembler
reads the account (`getAccount`) for name and owner in both cases, as `assembleMultiDiff` does today.

Produced by one function, `statementGroups(draft, parse)` over `readyParse`'s result, called by the
assembler:

- **Several accounts** (`draft.accountId === null`): `parse.routed` as is. `null` there stays the
  unreachable `DraftNotReadyError("columns", null)` it is today (`:1460`).
- **A chosen account**: one group, `{ accountId: draft.accountId, accountNumber: null,
  answered: false, positions: parse.parsed.positions, combined: parse.parsed.combined,
  skipped: parse.parsed.skipped, asOfDate: parse.parsed.asOfDate }`.

The chosen account's recorded number is deliberately **not** put in its group. It is not in `v3`
today; putting it in the hash would turn a Settings save of a number between Review and commit
from the guard's refusal into a stale-review one.

The single path's own behaviour — the two-numbers-in-one-file refusal (`:1755-1769`), the
recorded-number guard (`:1771-1785`), capture from the file with its `boundedNumber` refusal and
`numberHolder` pre-read (`:1787-1808`) — has to read the *folded* rows (`FileRow.accountNumber`,
first non-null per instrument) and refuse with the assembled diff. Checking the raw positions
instead would refuse more files. So it stays a commit-time step over the one assembled section:
`chosenAccountNumber(section, account, diff, db): Promise<string | null>`. It returns the number to
record, or null, and throws the same `RefusedUpload`s with the same wording. The review's card said
"the single-path guard produces the group". Here the group is trivial and the guard produces the
group's number. That is the same split, with the guard running where its inputs exist.

## 2. Function inventory (`app/lib/uploads.server.ts`)

| Before | After |
|---|---|
| `assembleDiff` (`:1371`), `assembleMultiDiff` (`:1453`) | **merged** into `assembleDiff(draft, asked, db): Promise<AssembledDiff>` over `statementGroups` |
| `AssembledDiff` (`:998`), `AssembledAccount` (`:1011`), `AssembledMultiDiff` (`:1019`) | **merged**: `AssembledDiff = { diff; sections: AssembledSection[]; resolved }`, `AssembledSection = { diff: AccountDiff; rows; accountNumber: string \| null; answered; asOf }` |
| `commitUploadUnderLock` (`:1704`), `commitMultiAccountUnderLocks` (`:1861`) | **merged** into `commitUnderLocks(draftId, locked: Account[], raw, db)` |
| `commitUpload` (`:1657`, exported, no non-test caller), `commitMultiAccountUpload` (`:1841`) | **deleted**; `recordUpload` is the one entry |
| `recordUpload` (`:1637`) → `RecordedUpload` | `recordUpload(draftId, raw, db): Promise<CommittedUpload[]>`. The chosen account is locked through `withAccountLock`, as `commitUpload` does now. Several are locked through `withAccountLocks` over the unlocked read's routed ids, as `commitMultiAccountUpload` does now |
| `RecordedUpload` (`:1632`) | **deleted** |
| `draftAccountId` (`:275`) | now **exported**, with `db: Kysely<Database> = getDb()` like every exported entry — the route's read of the draft's kind (§6) |
| `reasonsToRefuse` (`:2146`) | `posted` retyped `Partial<Record<Confirmation, string>>` (the object the multi path already builds, `:1908-1912`), since `CommitInput` loses the unsuffixed keys |
| — | **new** `statementGroups` (§1), `chosenAccountNumber` (§1), `reviewRevisionOf` (the one recipe, §3) |
| `reviewDiff` (`:1580`) | the kind branch goes; it calls `assembleDiff` |
| `compareAccount`, `appendWatermark`, `revisionRows`, `revisionResolved`, `statementDate`, `readyParse`, `lockDraft`, `findDraft`, `refuseStaleReview`, `promoteAnswers`, `deleteDraft`, `verifyVocabulary`, `insertStatement`, `recordAccountNumber`, `baselineMoved`, `baselineSentence`, `closedRefusal`, `boundedNumber` | unchanged |

`withAccountLock` and `withAccountLocks` (`accounts.server.ts:151`, `:175`) are untouched and still
the only doors. The locks are taken in ascending `compareIds` order. One transaction runs from the
read a writer decides on to its insert.

### Types

- `UploadDiff` stops extending `DiffSection`:
  `{ draftId; accountId: string | null /* the draft's chosen account; null: several */; filename;
  instrumentsSkipped; accountsSkipped; skippedNumbers; skipped /* rows no section claims */; asOf;
  reviewRevision; asOfInput; asOfError; accounts: AccountDiff[] }`. The eleven figure fields and
  `accountName`/`ownerName`/`accountNumberTail` leave the top level; they live on the sections.
- `DiffSection.accountName` narrows to `string` (every section has an account).
- `AccountDiff` is unchanged.

### The unified assembler, field by field

- Groups: `statementGroups`. Resolved aliases: `aliasesFor` over every group's strings. That is the
  multi path's rule, and for one group it is the single path's.
- Date: `asksDate = groups.some(g => g.asOfDate === null)`; typed =
  `asksDate ? statementDate(null, asked) : { asOfInput: "", asOf: null, asOfError: null }`; each
  section's `asOf` = `group.asOfDate ?? typed.asOf` (the multi path's rule, `:1462-1466`). For a
  file-dated chosen-account draft, the only change is `asOfInput`, which becomes `""` where it was
  the file's date. Its two readers:
  - the hidden `reviewedAsOf`, read by `refuseStaleReview` only when a posted `asOf` differs from it;
    no `asOf` input renders for a file-dated statement;
  - the `review-date` intent's redirect (`review.tsx:110-114`). Its button renders only for an asked
    date, and the loader ignores `?asOf=` for a file-dated draft.

  Nothing visible changes.
- `StaleReviewError`'s `asOf` argument is `typed.asOf`, as the multi path passes today. For a
  file-dated chosen draft that is null where it was the file's date; only `date_changed` renders
  it, which a file-dated draft cannot reach (its revision ignores the asked date), and
  `review.tsx` reads only `error.diff`.
- Section header: `accountName`/`ownerName` from `getAccount`; `accountNumberTail =
  numberTail(group.accountNumber ?? account.externalAccountNumber)`. That equals the draft's
  `accountNumberTail` for a chosen account and the router's key for a routed one.
- Top-level `skipped`: parsed rows no group claims (`:1537-1538`). A chosen-account group claims
  all of `parsed.skipped`, so the one section carries them.
- Top-level `asOf`: `asksDate || firstDate === null ? asked : file` (`:1557-1560`). For one group this
  is the single path's value.

## 3. The review revision, `v5`

One recipe, `reviewRevisionOf(draft, mapping, resolved, bound)`, issued exactly when
`typed.asOfError === null` and every section's `asOf` is non-null. For one section this is `v3`'s
condition (`:1396`), and for several it is `v4`'s (`:1515`). The input is
`"portfolio-upload-review-v5\0" + raw bytes + "\0" + JSON`:

| Field | Why it is there | Covered before by |
|---|---|---|
| raw bytes | the file itself; a different upload of the same name is different figures | v3, v4 |
| `draftId` | a revision cannot be replayed onto another draft | v3, v4 |
| `filename` | recorded on every set (`source_filename`) | v3, v4 |
| `mapping` | a Columns save between Review and commit | v3, v4 |
| `resolved` (`revisionResolved`) | an alias recorded, repointed or forgotten, or a draft answer changed | v3, v4 |
| `sections`, in routed order (ascending `compareIds`), each: | the order is the lock order and the insert order | v4 (order); v3 (one) |
| · `accountId` | which account the rows land in | v3 (top level), v4 |
| · `accountNumber`, `answered` | what the rows were routed by; a re-answer or a recorded number reroutes. `null`/`false` for a chosen account, whose number the guard reads at commit | v4 |
| · `rows` (`revisionRows`) | the folded rows, with each row's account number | v3, v4 |
| · `baseline: { setId, holdings }` | what the diff and confirmations were drawn against | v3, v4 |
| · `latestSetId` | the filed-behind context | v3, v4 |
| · `accountHistoryAppendWatermark` | a backdated append that moves neither selected set | v3, v4 |
| · `asOf` | the date that picked the baseline | v3 (top level), v4 |

Nothing is dropped: v3's top-level `accountId` and `asOf` move into its one section. The version
prefix is bumped, so no `v3.`/`v4.` revision can equal a `v5.` one. The comparison is still exact
string equality on the whole revision (`refuseStaleReview`, `:1681`), and it is not loosened.

## 4. The three drift items

**(a) `numberHolder` before the confirmations vs the unique index after promotion.** Both survive,
each where its input lives.
- The chosen-account guard still reads `numberHolder` for the number it captured before any
  confirmation is asked. A file that cannot land there is refused as "already recorded on X"
  without first asking the reader to tick boxes (`tests/commit-upload.test.ts:1514` pins this).
- A routed draft needs no pre-read. Its numbers are re-routed under the locks. A number recorded on
  another open account outranks the answer (`statement-routing.server.ts:117-166`) and refuses as
  `"rerouted"`, or as a stale revision when that account was locked (§7.2 rows at
  ARCHITECTURE.md:1776-1777).
- In both, the partial unique index still decides at the write (`recordAccountNumber` →
  `refusingDuplicateNumber`, §7.2 row :1774), because Settings takes no lock the commit holds.

**Order of the number write.** The paths disagree.
- Single writes after the inserts (ARCHITECTURE.md flowchart :1237-1240).
- Multi writes after promotion and before the draft delete (`:1936-1949`), as the header of
  `migrations/0017_upload_draft_account_answer.sql` documents.

The one commit uses the multi order for both: promote → write each number → delete draft → verify
vocabulary → insert each set. It is kept so the migration's comment stays true (a migration is not
edited), and the flowchart is updated instead. The comment stays true on the order but goes stale on
a name: the headers of `migrations/0017` and `migrations/0013` name `commitMultiAccountUnderLocks`
and `commitUpload`. Migrations are left as they are.
- Every step is in one transaction, and any refusal rolls all of them back.
- The order only decides which refusal is shown when two independent races coincide. On a
  chosen-account commit, a duplicate number at the write now shows ahead of the sweep's 404 or a
  vocabulary refusal, where today it shows after them. No test pins either order.
- The comment "Before the delete takes the answers with it" is not load-bearing: `recordAccountNumber`
  reads only `account`, and the answers are read in `routingInputs`, before routing.

**Per-section number refusals.** Each section's number write passes its own `refuse` closure to
`recordAccountNumber`, with the wording its path uses today:
- a routed section with `answered`: `"<name>: account number "<n>" is already recorded on <who>, so
  nothing was recorded. Choose again for it."` (`:1942-1947`);
- a chosen account: the guard's `recordedElsewhere` (`:1797-1804`).

An answered section's `boundedNumber` refusal (`"<name>: <refusal> Nothing was recorded."`) and the
blank-key `Error` (`:1917-1928`) stay in the per-section hard-refusal pass, after the moved-baseline
refusal, before the collected confirmations.

**(b) The posted `accountId` check.** The single path's check survives for both kinds:
`raw.accountId !== undefined && raw.accountId !== (draft.accountId ?? "")` refuses with the current
wording (`:1719-1724`), in the same place (after the closed refusal, before the assembler).
- A routed draft's form posts `""`, which passes.
- The only newly refused input is a forged routed-draft form naming an account id.
- The field still feeds the expired page's link (`review.tsx:166-172`, `:191-198`).
- The check is redundant with the revision only for a matching revision. It is kept because it
  refuses a forged form before the assembler runs, with its own sentence.

**(c) The separately posted `appendWatermark-<id>` vs the hash alone.** The watermark is posted and
compared for every section of both kinds: one encoder, one field. The chosen-account review
therefore carries it as a hidden field for the first time. It is an opaque `max(position_set.id)`
that exposes no holding or figure (`:1340-1342`). What survives is the naming,
**for drafts of several accounts only**.
- A moved watermark on a routed draft names its account: "Figures were recorded on X after this
  review." (0023 decision 9; `tests/multi-account-upload.test.ts:508`).
- On a chosen-account draft, `commitUnderLocks` passes no names. The refusal keeps its present
  wording, "This statement or its account changed after this review."
  (asserted at `tests/commit-upload.test.ts:817` and in four route tests). The single review is about that one
  account, and changing a refusal's wording is outside this spec.
- This is one explicit `draft.accountId === null` condition. That condition, the `named` prefixes in
  `reasonsToRefuse` and the early baseline refusal below are all the kind-keyed presentation this
  spec keeps.

**A fourth divergence, kept.**
- A routed draft refuses a moved baseline per section, first, in account order, prefixed with the
  account's name (`:1914-1916`; 0023 decision 9; `tests/multi-account-upload.test.ts:414`).
- A chosen-account draft collects it with the confirmations in `reasonsToRefuse`, where a
  filed-behind reason subsumes it.
- Unifying either way changes a pinned refusal, so both stay, keyed on the draft's kind.

All three decisions survive §7.2's upload rows (:1761, :1764-1766, :1768, :1774-1778). The order is
still lock accounts → lock and re-read the draft → closed → posted id → assemble → rerouted → revision
→ per section [chosen: `chosenAccountNumber`; routed: moved baseline, then answered-number bound] →
collected confirmations (`reasonsToRefuse`, whose overflow check throws per section) → promote →
number → delete → verify → insert, inside one transaction.

## 5. The posted form

One key scheme for both kinds:
- draft-wide: `accountId` (the chosen account, `""` for several), `reviewRevision` (omitted when
  null), `reviewedAsOf`, `asOf`;
- per section, suffixed with its account id: `baselineSetId-<id>` (`""` is null's wire form),
  `appendWatermark-<id>`, `confirmRemovals-<id>`, `confirmFiledBehind-<id>`.

The unsuffixed `baselineSetId`, `confirmRemovals` and `confirmFiledBehind` go. `CommitInput` loses
those three keys and stays a flat record of optional strings.

One encoder, in a new browser-safe module `app/lib/review-form.ts`. It does not bind and does not
verify (that is candidate 2.2), and it imports only `import type` from `uploads.server.ts`:
- `sectionKey(field: "baselineSetId" | "appendWatermark" | "confirmRemovals" | "confirmFiledBehind",
  accountId: string): string`
- `reviewedFields(diff: UploadDiff): Record<string, string>` — every hidden field the review
  posts. It does not include the ticks or `asOf`, which the reader sets.

`review.tsx` renders its hidden inputs from `reviewedFields` and names its ticks with `sectionKey`.
The tests' staging helper posts the same `reviewedFields`. `uploads.server.ts` reads the posted
keys through `sectionKey`.

## 6. Routes

- **`app/routes/upload/review.tsx`.** One render over `diff.accounts`:
  - The page's own header is chosen by the draft's kind (`diff.accountId !== null`):
    - "What this statement changes" with that section's summary and "file · account — owned by".
    - Otherwise, "What this file changes", *n* ACCOUNTS and "several accounts" with the skipped
      numbers note.
  - Each section renders through one `ReviewSection` component: `Comparison`, `SkippedLines`,
    `DiffTable`, the section's hidden fields and its two confirmations.
  - The per-section heading and "The file dates this statement …" line render only for several
    accounts, where they render today.
  - `RecordControls` keys its two strings on the kind rather than on `accounts !== null`.
  - Every visible string and its order is unchanged; the single review's table moves inside the
    `<Form>`, which changes no pixel.
- **Landing page.** Inside the action's `try`, before `recordUpload` (after it the draft is gone),
  the route reads the draft's kind with `draftAccountId(draftId)`:
  - A chosen account (`!== null`) lands on `/accounts/<id>?uploaded=<setId>` from the one returned
    set.
  - Several accounts land on `/upload/done?sets=<ids>`.
  - A gone draft (`undefined`) is left to `recordUpload`, which throws the existing `NotFoundError`
    and so reaches the existing 404 path. A draft's `account_id` never
    changes after `createDraft` (the only `upload_draft` update, `:452`, sets mapping and
    first-sighting bit), so the unlocked read cannot disagree with the commit's locked one.
- **`app/routes/upload/done.tsx`, `app/routes/upload.tsx`: no change.**

## 7. Tests

- **The staging helper**, `tests/support/review.ts`, replaces `reviewAndCommit`
  (`tests/commit-upload.test.ts:96-114`), `posted`/`reviewAndRecord`
  (`tests/multi-account-upload.test.ts:110-131`), `reviewedFields()`
  (`tests/account-lock.test.ts:596-608`), `reviewForm` (`tests/routes/upload-wizard.test.ts:1445`)
  and the inline form at `tests/routes/upload-accounts.test.ts:388-395`.
  - `reviewAndRecord(draftId, extra, db, asOf?)` draws the review and posts
    `{ ...reviewedFields(review), ...extra }` through `recordUpload`.
  - `onlySection(diff)` returns the one section of a chosen-account diff, and throws unless there is
    exactly one.
- **Changed shape, same assertions**:
  - every `commitUpload(…)` call becomes `recordUpload(…)` and reads `[0]`, or `onlySection` for
    diffs;
  - top-level figure reads (`diff.added`, `.baselineSetId`, …) on chosen-account diffs become
    section reads;
  - unsuffixed posted keys and `name="confirmRemovals"` markup checks become `sectionKey(…, id)`.
  - Files: `commit-upload`, `account-lock`, `upload-draft`, `invariants/ingest-rounding`,
    `set-balance`, `dated-upload-baseline-review`, `journeys/dated-upload-baseline`,
    `journeys/dated-upload-baseline-orderings`, `journeys/statement-to-portfolio`,
    `routes/upload-wizard`, `routes/upload-accounts`, `multi-account-upload`.
- **Deleted as redundant once the paths are one**:
  - `tests/upload-draft.test.ts:242`'s `commitUpload`-on-a-multi-draft 404 (no `commitUpload`);
  - the four `written.multiAccount ?` ternaries and the guard (`tests/multi-account-upload.test.ts:231,
    504, 707, 734`) become direct reads;
  - `:175`'s `review.accountId` null and `tests/upload-draft.test.ts:226`'s top-level `accountId:
    null … added: []` become `accountId: null` plus the sections;
  - `:176`'s `/^v4\./` becomes `/^v5\./`.
- **New**:
  1. *One assembler*: a chosen-account draft's review has `accounts` of length one, carrying the
     figures and header the single review showed. A draft of several has one section per routed
     account. Both have a `v5.` revision.
  2. *One test per hash field* that an ordinary write can move: mapping (a Columns save), resolved
     (an alias repointed), rows (a remap that changes a folded row), baseline (a set on or before
     the date), latest set (a set after it), watermark (a backdated append), date (the reviewed date
     changed), and routing (a number answered to a different account). Each is posted with the old
     revision and refused as stale, and nothing is recorded.
     - `draftId`, raw bytes and `filename` never change on a draft, so each is tested by
       seeding two drafts identical but for that one field and posting one's revision to the
       other.
     - Baseline holdings are a function of the immutable baseline set, and are covered by the
       baseline case.
  3. *Drift (a)*: the existing `numberHolder` test stays, through `recordUpload`.
  4. *Drift (b)*: a chosen-account form posting another account's id is refused with "This form was
     posted for a different account…". No test pins this today. A routed form posting `""` records.
  5. *Drift (c)*: after a history write on the chosen account, the refusal is the generic sentence,
     even though the form posted the section's watermark. The routed case already names the
     account.

## 8. Differential validation protocol (phase 6)

Two checkouts, one database each, the same scenarios, and the results diffed.

1. `git worktree add ../portfolio-main origin/main`. Chromium is preinstalled
   (`PLAYWRIGHT_BROWSERS_PATH`); never `playwright install`. The branch is `/home/user/portfolio`. `npm ci`
   in each.
2. Per side: `createdb` a fresh `portfolio_diff_main` / `portfolio_diff_branch` on :55432, migrate,
   `node --env-file=<side>.env ./scripts/seed-demo.ts`, and start `npm run dev` on port 5173 (main)
   / 5174 (branch). Each `.env` has its own `DATABASE_URL` and `PUBLIC_ORIGIN`. Unlock the app the
   way `seed-demo` leaves it: no passkey enrolled, so unlocked (`scripts/seed-demo.ts:5`).
3. One Playwright script, `scratchpad/differential.ts`, parameterised by base URL and database. It
   drives the wizard by visible labels and button text, never by form field names, because those
   are what differ. Scenarios, each on fresh fixture files written to the scratchpad:
   1. A single-account upload into a brokerage account with no prior statement.
   2. A single-account upload with first sightings answered on the instruments step.
   3. A single-account upload with removals and a filed-behind date, first refused unticked, then
      ticked and recorded.
   4. A single-account upload whose file names a number other than the recorded one (refused). Then
      one into an account recording no number, which the file's number is captured into.
   5. A multi-account upload across two open accounts, with one unknown number answered and one
      skipped.
   6. Stale review:
      - a Columns save in a second tab between Review and Record;
      - a number recorded in Settings, in a second tab, on the account a routed row's answer did not
        name, between Review and Record (the `"rerouted"` or stale refusal).
   7. The same review posted twice (the second shows the expired page, 404).
4. After each scenario, dump to JSON, sorted and with ids and `created_at` stripped, but the owning
   account's name kept:
   - `position_set` (account, as_of_date, source, source_filename, md5(raw_file)) and `holding`
     (account, as_of_date, instrument symbol/name, quantity, cost_basis_per_share);
   - `instrument_alias` (raw_string → instrument symbol);
   - `account` (name, external_account_number);
   - row counts of `upload_draft`, `upload_draft_answer` and `upload_draft_account_answer`.
   Also record for every submit: HTTP status, final URL path and query minus ids, and every
   `role="alert"` text on the page.
5. Append-only check: before and after each scenario, `count(*)` and
   `md5(string_agg(t::text, ',' order by id))` over `position_set` (excluding `raw_file`) and
   `holding`. The pre-existing rows' checksum must be unchanged, i.e. only appended rows differ.
6. `diff` the two sides' JSON. Every difference is a defect unless this spec predicts it. It
   predicts none for these scenarios. The stale refusal of a pre-deploy review is the one expected
   difference, and only if exercised.
7. Screenshots of the review and done/account pages for scenarios 1 and 5 on both sides, into
   `docs/specs/ingest/screenshots/` (`0024-<scenario>-<main|branch>.png`).

## Acceptance

**Shape**
- [ ] `assembleMultiDiff`, `commitMultiAccountUnderLocks`, `commitMultiAccountUpload`,
      `commitUploadUnderLock`, `commitUpload`, `RecordedUpload`, `AssembledAccount`,
      `AssembledMultiDiff` are gone. `grep -rw` finds none in `app/`, `tests/` or `server/`,
      comments included: `positions.server.ts:126` and `instrument-resolution.server.ts:4,223`
      name the survivor
- [ ] One `createHash` over the review in `uploads.server.ts`, prefixed `portfolio-upload-review-v5`
- [ ] `UploadDiff.accounts: AccountDiff[]`, never null; `UploadDiff` no longer extends `DiffSection`
- [ ] `recordUpload` returns `Promise<CommittedUpload[]>`
- [ ] `withAccountLock`/`withAccountLocks` diff-free; every `position_set` insert still inside one
- [ ] `review.tsx` has one section component and no `diff.accounts !== null` branch; its hidden
      inputs come from `reviewedFields`
- [ ] `app/lib/review-form.ts` imports nothing but types from `.server` modules; `npm run build` passes

**Behaviour**
- [ ] Every refusal sentence and field key in `uploads.server.ts` is textually unchanged
      (`git diff` shows no edited string literal among them). Exceptions:
      - `commitUpload`'s `NotFoundError("This upload holds several accounts…")` is deleted with
        its function; no route reached it.
      - Of the two unreachable dateless `Error`s, the multi one (`:1956`) survives.
- [ ] The landing pages: a chosen account → `/accounts/<id>?uploaded=<setId>`; several →
      `/upload/done?sets=…`
- [ ] The three drift decisions and the kept fourth divergence, each pinned by a test (§7)
- [ ] Every hash field in §3 has a test refusing a commit after it changes
- [ ] The differential run (§8) shows no unpredicted difference

**Gates**
- [ ] `npm run typecheck`, `npm test` (whole suite), `npm run build` clean
- [ ] ARCHITECTURE.md lines that name a deleted function or the old number-write order name the
      survivors: `grep -nw` for the deleted names over ARCHITECTURE.md is empty (today :565, :1019,
      :1035, :1103, :1114, :1193, :1204-1300, :1764-1768, :1775-1777, :2375, :2517, :2521), and the
      flowchart shows the number write before the draft delete. Specs, ADRs and research are
      records and are not edited

## Review record

**Round 1** (grounding review): ten findings. Eight folded in:
- the per-section number refusals and the answered-number bound;
- the line and test-count corrections;
- the full list of doc and comment lines naming deleted functions;
- `asOfInput`'s second reader;
- the chosen review now carrying the watermark;
- the `parse.parsed` naming;
- `StaleReviewError`'s `asOf`;
- the refusal-order consequence.

Finding 10 also moved the decision: the number write now takes the multi path's order, not the
flowchart's, so no migration comment has to change.

Rejected:
- *Return the draft's kind from `recordUpload` instead of the route re-reading it.* The task
  directs that `recordUpload` returns `CommittedUpload[]` and that the route picks the landing page
  from the draft's kind, not a union tag. The cost is one indexed primary-key read per commit.
- *Drop `app/lib/review-form.ts` for a test-only encoder, with the page keeping template literals.*
  The task asks for one encoder of the posted form for both kinds of draft. A test-only copy is a
  second encoder, and the drift this spec removes began as exactly that.

**Round 2** (grounding review): no material findings. All seven minor ones were folded in:
- `reasonsToRefuse`'s `posted` type;
- `draftAccountId`'s default `db`;
- the guard named in the order line;
- the deleted sentence and the surviving dateless `Error`;
- the migration headers going stale on a name;
- one line cite;
- the Playwright and unlock notes.

Review stopped here.

**Amendments during implementation (2026-09-24):**
- §2 `AssembledDiff` also carries `asOf: IsoDate | null`, the typed date. `commitUnderLocks` passes
  it to `StaleReviewError` rather than working it back out of `diff.asOf`.
- §7 The staging helper's signature is `reviewAndRecord(draftId, db, { asOf, extra })`, the shape
  the multi-account file's helper already had. `onlyRecorded(recorded)` joins `onlySection` for a
  chosen-account commit's one set.
- §7 item 2, after the PR's Codex review: two drafts that differ in bytes or filename also differ
  in `draftId`, so those two cases proved nothing alone. Each now restates one draft's bytes or
  filename through a new fixture builder, `restateDraft`, since no app path writes either. Only
  the `draftId` case keeps two drafts.
- Acceptance: the surviving dateless `Error` drops "multi-account" from its text ("A commit reached
  a dateless account."). Both kinds can reach it now, and it is an unreachable internal error, not a
  refusal.

**Code review** (two adversarial passes): nothing blocking. Folded in:
- one test helper for a chosen commit's single set, and `sectionOf` gone;
- `moved` computed only for several accounts;
- the typed date carried out of the assembler;
- comment placement and wording;
- an impossible landing arm that throws;
- `ReviewSection` rendering its own intro;
- `sectionKey` in the tests;
- "nothing recorded" asserted through `lastRecorded`;
- an ARCHITECTURE.md line cite replaced by the name.

Rejected: none.
