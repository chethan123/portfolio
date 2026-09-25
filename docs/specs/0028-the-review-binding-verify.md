# 0028 — The review binding's verify half: one pure `verifyBinding` the commit calls once

_Candidate 2.2 of [the second architecture review](../research/2026-09-24-architecture-review.md)
(card 2 of its [visual companion](../research/2026-09-24-architecture-review/report.html)), the
half [0024](0024-one-commit-over-routed-sections.md) left: 0024 §5 gave the review one encoder
(`app/lib/review-form.ts`) and the tests one staging helper (`tests/support/review.ts`); this gives
the commit one verify. Line numbers below were read at `6830d64`._

**What to build:** "Is this commit still authorised" is decided today in five places inside
`app/lib/uploads.server.ts`, in an order readable only by walking `commitUnderLocks` (`:1709`):
the rerouted check (`:1742-1751`), the per-section watermark comparison (`:1755-1762`),
`refuseStaleReview` (`:1611-1632`) with the closure that re-assembles at the reviewed date
(`:1763-1769`), the several-account baseline refusal (`:1791-1793`), and `baselineMoved`
(`:2002-2004`) called again from `reasonsToRefuse` (`:2032`) to void the ticks. The order is only
testable through Postgres.

Add to `app/lib/review-form.ts`, beside the encoder whose keys it reads, two pure functions:
`verifyBinding(posted, fresh)`, which returns `ok` (with the sections whose ticks a moved baseline
voids) or `stale { reason, moved }`, and `dateToReproduce(posted, fresh)`, which says whether the
verify will need the revision re-assembled at the reviewed date and at which date.
`commitUnderLocks` assembles under the locks as it does today, re-assembles at the date
`dateToReproduce` names when it names one, calls `verifyBinding` once, and throws the same
`StaleReviewError` from the result. `refuseStaleReview` and `baselineMoved` are deleted.

Worth doing on its own: the reason order becomes a table test with no database, and the next change
to what the form binds has one function to change beside the one encoder.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**Out of scope:**
- `REVIEW_REVISION` (`:1400`), `reviewRevisionOf` (`:1403`) and what the hash covers. Nothing about
  what the revision binds changes, so the version is not bumped.
- The encoder: `sectionKey`, `reviewedFields` (`review-form.ts:7`, `:12`) are unchanged.
- `reasonsToRefuse`'s confirmations (removals, filed-behind, the overflow guard) beyond reading one
  boolean instead of computing it.
- Every refusal's wording, class, field key, and which one a reader sees when several hold.
- `drawnByEarlierBuild` (`:1564`, called at `review.tsx:106`), `chosenAccountNumber`,
  `verifyVocabulary`, `closedRefusal`, the posted-`accountId` guard (see §2 for why each stays).
- Candidates 2.8, 2.9 and 2.13 (`valueAt` beside this code is left alone).

## 1. Where it lives, and the bundle line

In `app/lib/review-form.ts`. It stays browser-safe: both functions are pure, take plain objects, and
import only types from `.server` modules (`UploadDiff`, `AccountDiff`, `CommitInput`), which `import
type` erases. Together they are about eighty lines with their types and comments. The encoder draws
the keys; the verify reads the same keys; one file is the whole binding, which is what the card's
deletion test asked for. A `.server` module would be a second file importing `sectionKey` from the
first to compare what the first wrote, and nothing it would hide is secret: the comparison is
authoritative because the server runs it under the locks, not because the browser cannot read it.

`npm run build` is the gate that proves no `.server` value reaches the client through it.
`review.tsx`'s component imports `reviewedFields` and `sectionKey` only; whether the bundler keeps
the two new functions in the client chunk is immaterial to correctness and not asserted.

The module's header gains the verify: "The review form's one key scheme, drawn and verified: what
the review posts is what the commit reads (spec 0024 §5, spec 0028)."

## 2. Every stale check today, and where it goes

Read in `commitUnderLocks`' order (`uploads.server.ts` at `6830d64`).

| Check | Where today | Produces | After |
|---|---|---|---|
| Draft still there under the locks | `:1716-1718` | `NotFoundError` (404) | **Stays.** Not a binding: nothing was posted against it yet. |
| An account closed | `:1721-1723` | `closedRefusal` | **Stays.** A state refusal, no posted field involved. |
| Posted `accountId` ≠ the draft's | `:1726-1731` | `ValidationError.form` | **Stays.** It runs before `assembleDiff`, so no diff exists for a verify to read; its class is not `StaleReviewError`, and `review.tsx:163-186` treats it differently (rebuilds the diff through `reviewForDraft`). Moving it would change what the reader sees. |
| Bad or missing date; the router's problems under the locks | `assembleDiff`, `:1737-1741` | `ValidationError` / `DraftNotReadyError` | **Stays.** Refusals of the draft, not of the posted review. |
| Rerouted: a fresh section's account is not among the locked | `:1742-1751` | `StaleReviewError(…, "rerouted", unlocked names)` | **Moves** into `verifyBinding` (reason 1). |
| Append watermark per section, several accounts only | `:1752-1762` | the `moved` names of a `revision_changed` refusal; never refuses alone | **Moves** into `verifyBinding` (reason 3's names). |
| Revision equality | `refuseStaleReview`, `:1618-1624` | ok | **Moves** into `verifyBinding` (reason 2's gate). |
| Reproduction at the reviewed date | `:1626-1630`, closure `:1767-1768` | `date_changed` vs `revision_changed` | **The decision moves** into `verifyBinding`; **the re-assembly stays** in `commitUnderLocks`, gated by `dateToReproduce` (see §3). |
| Posted `baselineSetId` ≠ fresh, several accounts | `baselineMoved` via `:1791-1793` | `RefusedUpload` with `baselineSentence`, thrown first in that section's turn | **The comparison moves** (`voided`); **the throw stays** in the loop at the same point, so a section 1 number or overflow refusal still wins over a section 2 baseline. |
| Posted `baselineSetId` ≠ fresh, chosen account | `baselineMoved` via `reasonsToRefuse` `:2032` | both ticks void; reason 1 unless an unconfirmed filed-behind subsumes it | **The comparison moves** (`voided`); `reasonsToRefuse` takes the boolean. |
| Built by an earlier recipe | `drawnByEarlierBuild`, `:1564`, `review.tsx:106` | a redirect to Review with `?stale=true`, before the commit | **Stays.** A route decision taken before any lock, answering a deploy rather than a race, and it reads `REVIEW_REVISION`, which stays in `uploads.server.ts`. |
| Vocabulary re-read after promotion | `verifyVocabulary` | `RefusedUpload` | **Stays.** Not a posted-field comparison: a `for share` re-read inside the transaction (§7.2's second upload row). |

## 3. The shape

```ts
// app/lib/review-form.ts
import type { AccountDiff, CommitInput, UploadDiff } from "./uploads.server.ts";

export type StaleReason = "date_changed" | "revision_changed" | "rerouted";

export type FreshBinding = {
  diff: Pick<UploadDiff, "accountId" | "reviewRevision"> & {
    accounts: ReadonlyArray<
      Pick<AccountDiff, "accountId" | "accountName" | "baselineSetId" | "appendWatermark">
    >;
  };
  locked: ReadonlyArray<string>; // account ids withAccountLock(s) holds
  reproduced: string | null; // the revision re-assembled at dateToReproduce's date; null when it named none
};

export type BindingVerdict =
  | { ok: true; voided: ReadonlySet<string> }
  | { ok: false; reason: StaleReason; moved: string[] };

export function dateToReproduce(posted: CommitInput, fresh: Omit<FreshBinding, "reproduced">): string | null;
export function verifyBinding(posted: CommitInput, fresh: FreshBinding): BindingVerdict;
```

`fresh.diff` is typed as the fields the verify reads, so a table test builds a four-field literal
per section rather than a whole `UploadDiff`; `commitUnderLocks` passes its `UploadDiff`, which
satisfies it.

**`dateToReproduce`** returns `posted.reviewedAsOf` exactly when no section is rerouted, the
revision does not match (the gate below), and `posted.asOf` and `posted.reviewedAsOf` are both
present and differ; otherwise null. That is when today's code reaches the closure: past the
rerouted throw (`:1751`), inside `refuseStaleReview`'s condition (`:1618-1627`). So
`commitUnderLocks` re-assembles in exactly the cases it does today. The rerouted set is one private
`reroutedNames(fresh)` both exports call, so the rule is stated once.

**The revision gate**, unchanged, is one private `revisionMatches(posted, fresh.diff)` both exports
call: the revision matches when `posted.reviewRevision` is present, `fresh.diff.reviewRevision` is
not null, and the two are equal strings. Missing, null, or different fails it. Whole-string
equality, no tolerance; the `v5.` prefix matters only to `drawnByEarlierBuild`, which stays.

**`verifyBinding`, in this order:**

1. **Rerouted.** Any `fresh.diff.accounts` entry whose `accountId` is not in `fresh.locked` →
   `{ ok: false, reason: "rerouted", moved: those sections' accountName, section order }`.
2. **Revision matches** → go to 4.
3. **Revision differs.**
   - `dateToReproduce(posted, fresh)` is not null and `fresh.reproduced ===
     posted.reviewRevision` (strict, so a null `reproduced` never matches a missing posted revision)
     → `{ ok: false, reason: "date_changed", moved: [] }`.
   - Otherwise → `{ ok: false, reason: "revision_changed", moved }`, where `moved` is, when
     `fresh.diff.accountId === null` (several accounts), the `accountName` of every section whose
     posted `appendWatermark-<id>` is present and differs from `appendWatermark ?? ""`, in section
     order; for a chosen account, `[]` (spec 0023 decision 9).
4. **Ok.** `voided` is the set of `accountId`s whose posted `baselineSetId-<id>`, `?? ""`, differs
   from the section's `baselineSetId ?? ""` (#181: `""` is null's wire form).

Step 3 re-evaluates `dateToReproduce` rather than trusting that a non-null `reproduced` was asked
for. It costs one call and keeps the verify strict on its own: a caller passing a reproduction the
rule did not ask for cannot turn a stale review into a date change.

This is today's order, unchanged: rerouted, then the revision (date before stale), then per section
the baseline. `date_changed`'s `moved` was computed and ignored by its message before; it is `[]`
now, and no message changes.

**`commitUnderLocks` after:**

```ts
const binding = { diff, locked: locked.map(({ id }) => id) };
const at = dateToReproduce(raw, binding);
const verdict = verifyBinding(raw, {
  ...binding,
  reproduced:
    at === null ? null : (await assembleDiff(draft, { mode: "review", asOf: at }, db)).diff.reviewRevision,
});
if (!verdict.ok) throw new StaleReviewError(diff, asOf, verdict.reason, verdict.moved);
```

then `held` is `sections` paired with their locked `Account`, with a plain `Error` if one is
missing, under a comment saying `verifyBinding` refused every section outside the locks. The loop
reads `verdict.voided.has(section.accountId)` where it called `baselineMoved`: the several-account
refusal stays at `:1791`'s point, and `reasonsToRefuse` takes a `moved: boolean` in its first
argument instead of `posted.baselineSetId`, so its `posted` parameter becomes
`Partial<Record<Exclude<Confirmation, "baselineSetId">, string>>`; `Confirmation` itself, which keys
`CommitInput`, is unchanged.

The comment above `refuseStaleReview` (`:1606-1610`), which says why a posted date is only an
assertion, moves above `dateToReproduce`, trimmed. `baselineMoved`'s comment (`:2000-2001`) moves
to step 4. The comment at `:1831` ("which refuseStaleReview refused") names `verifyBinding`.

## 4. `StaleReviewError` after

Constructed only at the one site above, from `(diff, asOf, verdict.reason, verdict.moved)`: the same
fresh diff and typed date as today (`:1751`, `:1631`). Its constructor's reason parameter is typed
`StaleReason` (imported as a type from `review-form.ts`: a type-only cycle beside the existing
`sectionKey` value import at `:52`, erased by TypeScript, so leave it); its default and its three
sentences are unchanged, so `review.tsx:155` renders the same `formError` through `refused()`.

## 5. Tests

**New: `tests/review-form.test.ts`**, pure, no database, no `withDatabase`, no `afterAll`. A small
local `section(id, name, { baselineSetId, appendWatermark })` and `fresh({ accountId, revision,
sections, locked, reproduced })` build `FreshBinding` literals; the posted side is built with
`sectionKey` over plain objects, so the test posts exactly the keys the page posts. Every `it` a
full sentence. Tables (`it.each` where the rows share one assertion):

- **The revision gate.** Equal revisions → ok. Posted revision missing, fresh revision null, or the
  two different → `revision_changed`. `v5.abc` against `v6.abc` is not a match: whole-string
  equality, no prefix rule.
- **Rerouted.** Two sections outside `locked` and one inside → `rerouted`, naming the two in
  section order.
  Rerouted wins over a differing revision whose reviewed date would reproduce (today nothing pins
  rerouted against a failing revision; `account-lock.test.ts:727` pins it only with the revision
  passing).
- **The reviewed date.** Differing `asOf`/`reviewedAsOf` with `reproduced` equal to the posted
  revision → `date_changed`, `moved: []`. `reproduced` different, `reviewedAsOf` missing, or
  `asOf` missing → `revision_changed`. Equal dates with a `reproduced` that equals the posted
  revision → `revision_changed` (the verify ignores a reproduction `dateToReproduce` did not ask
  for). A missing posted revision with a null `reproduced` → `revision_changed` (strict equality).
- **The watermark names**, several accounts. One section's posted watermark differs → named; two →
  both, section order; a posted `""` against a null watermark → not named; an omitted watermark →
  not named (untested today at the commit, `uploads.server.ts:1758`). A chosen account whose
  watermark differs → `moved: []`. A differing watermark under a matching revision → ok (the
  watermark never refuses alone).
- **Voided ticks.** Under a matching revision: a posted baseline differing from the fresh one →
  `voided` holds that account; `""` against null, and omitted against null → not voided; omitted
  against a non-null baseline → voided; two sections, only the moved one voided. Under a differing
  revision the same moved baseline → `revision_changed`, no verdict carries `voided` (revision
  beats baseline, `review-revision.test.ts:297`, `multi-account-upload.test.ts:469`).
- **`dateToReproduce`.** Matching revision with differing dates → null. A rerouted section → null.
  Differing revision: differing dates → `reviewedAsOf`; equal dates, `asOf` missing, `reviewedAsOf`
  missing → null.

**`tests/review-revision.test.ts`.** Every HASH case stays: the recipe does not change, and each
pins one field the revision binds through a real commit. The two INTEGRATION cases of the assembler
(`:120`, `:174`) and the reproduction at the reviewed date (`:402`) stay: `:402` is one of three
proofs (with `commit-upload.test.ts:490` and `upload-wizard.test.ts:596`) that `commitUnderLocks`
re-assembles at `dateToReproduce`'s date and passes the result. The posted-`accountId` describe
(`:525-574`) stays, since that guard does not move. **Deleted:** the describe "the posted append
watermark (spec 0024 §4 c)" (`:576-633`, two cases). Its chosen-account case ("never names", `:577`)
becomes the table's chosen-account row, and the field it binds is already pinned by the
backdated-set HASH case (`:371`). Its several-account case (`:606`) is the table's naming row, with
the commit-level wiring proven three more times: `multi-account-upload.test.ts:469` (two accounts
named), `account-lock.test.ts:692` (under a real lock wait) and `upload-wizard.test.ts:1581`
(through the route). The file header's "(§4 b, c)" becomes "(§4 b)". `sectionKey` stays imported
only if another case still uses it.

**Unchanged, `git diff --stat origin/main --` empty on each:** `tests/multi-account-upload.test.ts`
(its baseline case `:381` and its named-watermark case `:469`),
`tests/journeys/dated-upload-baseline-orderings.test.ts`, `tests/account-lock.test.ts` (the only
rerouted case, `:727`), `tests/commit-upload.test.ts`, `tests/dated-upload-baseline-review.test.ts`,
`tests/routes/upload-wizard.test.ts`, `tests/support/review.ts`. Each passes as it is: they are the
integration proof that the verdict reaches the same refusal through the commit and the route.

## 6. Documentation this change moves

- ARCHITECTURE.md §6.1, "Commit: the flow's one write" (`:1202-1300`): the flowchart's nodes
  `D2`/`D3` and the baseline leg of `J` are unchanged in meaning; the prose bullet "The review
  revision binds the server-rendered interpretation" (`:1258-1272`) gains one sentence: the
  comparison and its order are `verifyBinding` in `review-form.ts`, pure, called once under the
  locks. The baseline bullet (`:1273-1284`) names `verifyBinding`'s `voided` as where "the posted
  `baselineSetId` the fresh diff no longer matches" is decided.
- ARCHITECTURE.md §7.2 race table: the rows at `:1770` (Columns save / alias / history after
  Review), `:1772` (a moved baseline), `:1782` (two commits over the same accounts, whose
  per-account watermark check moves) and `:1784` (rerouted) gain `review-form.ts`
  (`verifyBinding`) in their "Where" cell beside `commitUnderLocks`. No guard changes, so no guard
  text changes.
- ARCHITECTURE.md Appendix A: a new `review-form.ts` row under `statement-routing.server.ts`
  (`:2393`): "The review form's one key scheme, drawn and verified (specs 0024 §5, 0028):
  `sectionKey`, `reviewedFields` for the page and the tests, and `verifyBinding`, the pure
  comparison the commit makes once under its locks, with the reason order. Browser-safe: types only
  from `.server` modules." The `uploads.server.ts` row (`:2389`) is unchanged.
- `docs/specs/README.md`: the 0028 row.

## 7. Differential validation

The claim: for every stale or clean commit, the branch refuses or records exactly as `main` does.
A `sonnet` sub-agent can run it from this section alone. `S` is the scratchpad.

**Setup.**

1. `git worktree add "$S/wt-main" origin/main` and `git worktree add "$S/wt-branch" <branch head>`;
   symlink the checkout's `node_modules` into each (no dependency change).
2. The harness is one untracked file, `$S/differential/binding.test.ts`, copied into each worktree
   as `tests/differential/binding.test.ts` and never committed. It imports only what exists on both
   trees: `~/lib/uploads.server` (`recordUpload`, `reviewForDraft`, `rememberMapping`,
   `answerAccountNumbers`, `StaleReviewError`, `RefusedUpload`), `~/lib/review-form`
   (`reviewedFields`, `sectionKey`), `~/lib/accounts.server` (`updateAccount`),
   `tests/support/{database,fixtures,review,routes}.ts`, and `app/routes/upload/review.tsx`'s
   `action`. It copies `review-revision.test.ts`'s file-local `stage`, `seedAliased`, `CHOSEN` and
   `SEVERAL` (they are not in `tests/support`), and `upload-wizard.test.ts:127-141`'s
   `expiredPage`/`expiredPageOf`. It calls `afterAll(closeTestDatabase)`; `vitest.config.ts`
   already sets `DATABASE_URL`.
3. Each case seeds inside `withDatabase`, draws the review with `reviewForDraft`, applies the
   case's intervening write, then posts through the review route's `action(args(post(…)))` and
   records, to `$DIFF_OUT/<case>.json`: the outcome (`outcomeOf`: status and `Location` for a thrown
   `Response`, else the returned data's `formError`, `errors` and `values`; a committed draft's
   re-POST throws `data(…, { status: 404 })`, which `outcomeOf` rethrows, so that case goes through
   `expiredPageOf` and records its `init.status` and `data`), and the rows the case
   touched after the post: `position_set` (`account_id`, `as_of_date`, `source`) and `holding`
   (`instrument_id`, `quantity`, `cost_basis_per_share`) for each account, whether the draft row
   still exists, `instrument_alias` for the file's strings, and each account's
   `external_account_number`. Ids included: they must match too.
   It also calls `recordUpload` directly with the same form in a second, identical case, and
   records the thrown error's class name and `fieldErrors`, so the reason is captured below the
   route; when nothing is thrown it records the returned `CommittedUpload[]` (`setId`, `accountId`,
   `asOf`, `counts`). Case 3's direct variant calls `recordUpload` twice and records the second's
   `NotFoundError`.
4. Ids match across runs only on identical databases: before each tree's run, `docker compose -f
   compose.test.yaml down` then `up -d --wait`, then in the worktree
   `DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_test
   PUBLIC_ORIGIN=http://localhost:5173 npm run migrate`, then `DIFF_OUT=$S/out-main npx vitest run
   --no-cache tests/differential` in `wt-main`, and the same with `out-branch` in `wt-branch`, the
   same UTC day.
5. `diff -r "$S/out-main" "$S/out-branch"`. Run `wt-main` twice first and diff those, to prove the
   harness deterministic.
6. Case 2 needs a write landing between `recordUpload`'s unlocked read and its locked re-route,
   which only `tests/account-lock.test.ts:56`'s `behindTheLock` stages, on committed connections
   outside `withDatabase`. So case 2 is not in the harness: run `npx vitest run
   tests/account-lock.test.ts -t "refuses rows the locked re-read routes"` in each worktree and
   confirm the output shows `1 passed` on both. That test asserts the exact message and zero sets
   on both accounts.

**Cases.**

| # | Draft | Between review and record | Expected on both |
|---|---|---|---|
| 1 | chosen | a Columns save that changes the mapping (0024 §8 scenario 6, first bullet) | `revision_changed`, generic sentence; nothing recorded |
| 2 | several | a number moved to another account between the unlocked read and the locked re-route (0024 §8 scenario 6, second bullet); step 6, not the harness | `rerouted`, naming where the rows go; nothing recorded |
| 3 | chosen | the same form posted twice; the first records (0024 §8 scenario 7) | second: 404 through `expiredPageOf` |
| 4 | several, the second account holding a set dated before the statement (as `multi-account-upload.test.ts:381` seeds it) | none; posted `baselineSetId-<second>` forged to `""` | `RefusedUpload`, "second: This statement was measured against …"; nothing recorded |
| 5 | chosen, undated; sets dated 2026-03-31, 2026-05-31 and 2026-08-31, the statement typed 2026-06-30 (baseline the May set, filed behind the August one) | none; posted `baselineSetId` forged to the March set's `id`, filed-behind ticked | ticks void; the filed-behind sentence (subsuming the baseline sentence), plus the removals sentence if the file drops a majority |
| 6 | several (two accounts), the second holding a set dated 2026-03-31 | a set dated 2026-01-31 on the second account, moving its watermark and neither selected set (as `review-revision.test.ts:606` seeds it) | `revision_changed`, "Figures were recorded on <second> after this review." |
| 7 | chosen, undated | posted `asOf` changed from the reviewed date, nothing else | `date_changed`, the date sentence |
| 8 | chosen, undated | posted `asOf` changed and the mapping saved | `revision_changed`, generic |
| 9 | chosen | none (clean) | recorded; rows identical |
| 10 | several (two accounts) | none (clean) | recorded; rows identical |

**Expected result.** `diff -r` is empty. Any difference is a defect.

**Run, 2026-09-25.** The harness posted cases 1 and 3-10 through the review route's action and
through `recordUpload` directly, each re-seeded in its own transaction, on a private Postgres
recreated and migrated before each run. Two runs on `6830d64` were byte-identical, so the harness is
deterministic. The run on the branch head (`1a51360`) matched them: `diff -r` empty, ids included.
Case 2 passed on both trees (`1 passed | 15 skipped`). On the dev server, the single-account and
multi-account uploads recorded and the stale review refused with "This statement or its account
changed after this review. Nothing was recorded — check it and record again.", redrawn over the
fresh diff.

**In the running app.** On the dev server over `scripts/seed-demo.ts` data, with Playwright: a clean
single-account upload recorded; a review left open while the same draft's Columns are saved in a
second page, then **Record** on the first (the stale warning); a multi-account upload recorded.
Captures go in the pull request, not the tree.

## Acceptance

**The verify**
- [ ] `app/lib/review-form.ts` exports `StaleReason`, `FreshBinding`, `BindingVerdict`,
  `dateToReproduce` and `verifyBinding` with §3's signatures, and imports only types from `.server`
  modules (`grep -n "^import" app/lib/review-form.ts` shows `import type` only).
- [ ] `verifyBinding` applies §3's four steps in that order; `dateToReproduce` returns
  `reviewedAsOf` exactly in §3's case.

**The commit**
- [ ] `grep -rn "refuseStaleReview\|baselineMoved" app` returns nothing.
- [ ] `commitUnderLocks` calls `verifyBinding` once, and `new StaleReviewError(` appears once in
  `app/lib/uploads.server.ts`.
- [ ] The several-account baseline refusal is thrown at the same point of the loop, and
  `reasonsToRefuse` reads a passed boolean.
- [ ] `StaleReviewError`'s three sentences are byte-identical (`git diff origin/main --
  app/lib/uploads.server.ts` touches no string literal of them).

**Tests**
- [ ] `tests/review-form.test.ts` holds §5's tables and touches no database.
- [ ] `tests/review-revision.test.ts` loses exactly the watermark describe and its header's ", c".
- [ ] §5's unchanged list has an empty `git diff --stat origin/main --`.

**Documentation**
- [ ] §6's edits and no others.

**Gates**
- [ ] `npm run typecheck`, `npm test` (at least 2385 − 2 + the new tests passing), `npm run build`
  clean.
- [ ] §7's differential: `diff -r` empty.

## Review findings rejected

Grounding review, two rounds. Round 1: fourteen findings, two material, both in §7. Case 2 could
not stage a rerouted commit inside `withDatabase`; it now runs `account-lock.test.ts:727` in each
worktree. Case 3's 404 is a thrown `data()`, which `outcomeOf` rethrows; it now goes through
`expiredPageOf`. The minor ones (citations, a column name, seeds, the `:1831` comment, line
ranges) are folded in. Round 2: ten findings, none material, all folded in. Both rounds walked §3
against `commitUnderLocks` and found no input where the refusal, its message, the refusal that
wins, the rows or the strictness differ.

Rejected, in part:
- *Round 1, 11: drop step 3's re-check of `dateToReproduce` and trust the caller.* The shared
  `revisionMatches` is taken. The re-check stays: one call keeps `verifyBinding` strict on its own
  inputs, so a caller passing a reproduction nobody asked for cannot turn a stale review into a
  date change. §3 says so.

Code review, two reviewers (correctness and concurrency; standards and shape), none blocking.
Folded in: one doc line left unwrapped by a reflow, spec prose past 100 columns, a stale quote of
the unreachable `held` error, a rerouted row the two-section row subsumes, and a test pinning the
strict `reproduced` comparison (a mutant treating a null reproduction as matching a missing
revision survived all 30 rows). The correctness reviewer also found the one admitted divergence of
§3 as first drafted was observable: `dateToReproduce` ran for a rerouted commit, and an unlocked
alias change racing between the two assemblies could show the reader the Instruments step instead
of the rerouted refusal. `dateToReproduce` now skips a rerouted commit through a shared
`reroutedNames`, so the re-assembly runs exactly when `main`'s closure does (§3, amended
2026-09-25).

Rejected:
- *`it.each` rows carry their sentence as a discarded `_name` rather than formatting the data.* The
  names come out as full sentences either way, and the rows read as a table of rules.
- *Fold `dateToReproduce`'s rows into the verify's.* They pin the export `commitUnderLocks` calls
  on its own to decide whether to re-assemble; the verify's rows cannot see that decision.
