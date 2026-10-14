# 0031 — The wizard resumes through one translator

_Candidate 2.9 of [the second architecture review](../research/2026-09-24-architecture-review.md)
(card 9 of its [visual companion](../research/2026-09-24-architecture-review/report.html)). Line
numbers below were read at `05d9746`._

**What to build:** the domain decides which step a draft is owed (`parseDraft`, `accountsScreen`,
`rememberMapping`, `answerAccountNumbers`, `DraftNotReadyError`), and the upload routes turn that
step into a redirect at fifteen sites in five files, each spelling `/upload/${id}/${step}` and
carrying `?stale=true` by hand. The flag is read from the URL at eight sites and written at
thirteen: the twelve flag-carrying rows of §2's table, plus `review.tsx:108`. Forgetting one carry
fails silently: the reader lands on the right step without the "review went stale" warning
(`STALE_REVIEW_MESSAGE`, `uploads.server.ts:83`). `review.tsx`'s carries are pinned by tests
(`upload-wizard.test.ts:298-300`, `:316`, `:359`, `:1642`; `upload-accounts.test.ts:407`). The
nine on columns, accounts and instruments are not.

One route-side translator replaces those spellings:

```ts
// app/lib/upload-resume.server.ts
export type ResumeStep = NonNullable<DraftParse["step"]> | "review" | null; // null: review
export function staleOf(request: Request): boolean; // ?stale=true, exactly
export function resumeAt(draftId: string, step: ResumeStep, stale: boolean): Response;
```

`resumeAt` returns `redirect(`/upload/${draftId}/${step ?? "review"}${stale ? "?stale=true" : ""}`)`,
the shape every site writes today. `stale` is a required argument, so a site cannot drop the flag by
omission: it either passes `staleOf(request)` or says why it passes something else. The module
lives in `app/lib`, as `owner-reading.server.ts` does: a route-shaped helper that returns a
`Response`, kept `.server` because it is reached only from loaders and actions.

`instrumentsStepSkipped` (`uploads.server.ts:590`) is exported and used by the two loaders that
restate it as `draft.hadFirstSightings === false` (`accounts.tsx:43`, `instruments.tsx:60`).

`parseDraft` gets a table test of its own. Today `tests/routes/upload-wizard.test.ts:1-4` says it
"has no test of its own; the matrix below pins it".

Worth doing on its own: the stale carry stops being something each route remembers, and the step
machine the wizard resumes through is pinned where it is decided.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**Out of scope:**
- `DraftNotReadyError` stays an exception, and "blocked" stays its payload (§5).
- The four draft header shapes (`UploadDraft`, `BlockedDraft`, `UploadDiff`'s header fields, the
  columns screen's `draft:` object) (§5).
- The step strip (`UploadStepsData`). Each screen keeps building its own, field for field (§5).
- Every 404: the plain-string `Response` at nine sites (eight under `app/routes/upload/` and
  `upload.tsx:62`), and the review action's `data({ accountId }, { status: 404 })` at two
  (`review.tsx:186`, `:210`) (ARCHITECTURE.md §6.1, "A dead draft is one page").
- Redirects that are not a resumption, all unchanged:
  - `upload.tsx:57`, a new draft to `/columns`;
  - `review.tsx:113`, `redirectDocument` for a page from an earlier build;
  - `review.tsx:128-130`, the review-date `?asOf=`;
  - the commit's landings, `review.tsx:149`, `:153`.
- The columns loader, which never redirects (a walk back to remap must render).
- The accounts loader's revisit rule (`accounts.tsx:35`, it renders while questions exist).
- The instruments loader's second check (`instruments.tsx:54`, the race guard spec 0030 §3 kept).
- Which id each site redirects with: `draft.id` or `params.draftId`, as today (§2).
- The instruments step drawing itself skipped when an alias is forgotten after the mapping is
  saved (`instruments.tsx:60` with `upload-steps.tsx:30-32`). Noticed while grounding; not this
  change.

## 1. The translator

```ts
// The one shape a wizard route resumes a draft at. `stale` is required on purpose: the warning
// that a review went stale rides only on this query parameter, and dropping it fails silently.
export function resumeAt(draftId: string, step: ResumeStep, stale: boolean): Response {
  return redirect(`/upload/${draftId}/${step ?? "review"}${stale ? "?stale=true" : ""}`);
}

export function staleOf(request: Request): boolean {
  return new URL(request.url).searchParams.get("stale") === "true";
}
```

`ResumeStep` is `NonNullable<DraftParse["step"]> | "review" | null`, derived rather than restated:
`rememberMapping` and `answerAccountNumbers` already return `"review"` (`uploads.server.ts:455`,
`:690`), and `parseDraft` returns `null` for the same place.

## 2. Every site, before and after

Each row keeps its id argument and its stale source exactly. "URL" means `staleOf(request)`.

| Site | Today | After |
|---|---|---|
| `index.tsx:14` loader | `${result.step ?? "review"}`, no stale | `resumeAt(draft.id, result.step, false)` |
| `columns.tsx:230` action | `${outcome.nextStep}${stale}`, URL (`:208`) | `resumeAt(draft.id, outcome.nextStep, staleOf(request))` |
| `accounts.tsx:36` loader | `${screen.step ?? "review"}${stale}`, URL (`:30-31`) | `resumeAt(draft.id, screen.step, staleReview)` |
| `accounts.tsx:64` action | `${nextStep}${stale}`, URL (`:60`), `params.draftId` | `resumeAt(params.draftId, nextStep, staleOf(request))` |
| `instruments.tsx:47` loader | `${result.step}${stale}`, URL (`:41-42`) | `resumeAt(draft.id, result.step, staleReview)` |
| `instruments.tsx:49` loader | `review${stale}` on `step === null` | `resumeAt(draft.id, null, staleReview)` |
| `instruments.tsx:54` loader | `review${stale}`, nothing unresolved | `resumeAt(draft.id, null, staleReview)` |
| `instruments.tsx:82` action | `${result.step}${stale}`, URL (`:76`) | `resumeAt(draft.id, result.step, stale)` |
| `instruments.tsx:86` action | `review${stale}` on `step === null` | `resumeAt(draft.id, null, stale)` |
| `instruments.tsx:106` action | `review${stale}` after `resolveAll` | `resumeAt(draft.id, null, stale)` |
| `review.tsx:89` loader | `${error.step}${stale}`, URL (`:88`), `params.draftId` | `resumeAt(params.draftId, error.step, staleOf(request))` |
| `review.tsx:176` action, blocked | `review`, no stale | `resumeAt(params.draftId, null, false)` |
| `review.tsx:179` action | `${reviewError.step}${stale}`, posted `reviewRevision` (`:178`) | `resumeAt(params.draftId, reviewError.step, values.reviewRevision !== undefined)` |
| `review.tsx:199` action, blocked | `review`, no stale | `resumeAt(params.draftId, null, false)` |
| `review.tsx:202` action | `${error.step}${stale}`, posted `reviewRevision` (`:201`) | `resumeAt(params.draftId, error.step, values.reviewRevision !== undefined)` |

The four `false` sites stay `false`:
- **`index.tsx`.** The bare address never carries the flag today. Nothing in the app writes
  `?stale=true` onto it, so passing the URL's flag would change only a hand-typed address.
- **The two blocked review redirects.** These go to a page that renders no stale warning
  (`review.tsx:82`). `upload-wizard.test.ts:1193`, `:1210` pin them without the flag.

Each sends no flag deliberately. A one-line comment at each `false` says so.

The URL reads that only feed a screen's message go through `staleOf` too:
- `columns.tsx:171`, `accounts.tsx:30`, `instruments.tsx:41`, `review.tsx:66`.
- Each loader binds `const staleReview = staleOf(request)` once and uses it for both the redirect
  and `staleReviewMessage`.

After: `grep -rn 'searchParams.get("stale")\|?stale=true' app/routes` finds nothing. The flag's
reads and writes are `upload-resume.server.ts`'s, apart from `review.tsx:108`. That site writes
`stale=true` into the earlier-build `redirectDocument` query beside `asOf`. It is not a
resumption and stays (out of scope above).

## 3. Tests

- **`tests/upload-resume.test.ts`** (new, pure, no database):
  - `resumeAt` redirects to `/upload/7/<step>` for each step;
  - `null` goes to `review`;
  - `?stale=true` is appended exactly when `stale` is true;
  - the status is a redirect (302).
  - `staleOf` is true for `?stale=true` only. It is false for an absent flag, `?stale=1`, and
    `?stale=TRUE`, matching `=== "true"` today.
- **`tests/parse-draft.test.ts`** (new, `withDatabase`): one `it.each` over the single-account step
  machine, through `seedUploadDraft` and the fixtures. Rows:
  - no saved mapping → `columns` with no problems;
  - a saved multi-account mapping on a single-account draft (`fitsDraft`) → `columns`, no problems;
  - a saved mapping the file now fails, a blank instrument → `columns` with that problem;
  - a string with no alias → `instruments` naming it;
  - every string aliased → `null`.

  Each row seeds with `seedUploadDraft({ account, bytes, mapping })` (`tests/support/fixtures.ts`
  plants its `mapping` and `hadFirstSightings` options directly), plus `seedInstrument`/`seedInstrumentAlias`
  for the aliased row. It then reads the row back with `requireDraft(draft.id, ctx.db)`, because
  `parseDraft` takes the `UploadDraft`. The file declares its own `StatementMapping` literal:
  `MAPPING` is file-local to `upload-wizard.test.ts:54`, and nothing in `tests/support` exports one.
  The mismatched row is that literal with `multiAccount: true` on a draft with an account
  (`fitsDraft`, `uploads.server.ts:370-372`). The blank-instrument row is bytes with an empty
  instrument cell (`statement.ts`'s `blank-instrument` code).

  The multi-account arms are pinned already in `tests/multi-account-upload.test.ts:552-628` (the
  describe "an account number no account records") and the router's table (spec 0030). This file
  says so in one line rather than repeating them.
- **`tests/routes/upload-wizard.test.ts`.** The header's "has no test of its own" clause is updated
  to point at `parse-draft.test.ts`. No case is deleted: the matrix is the regression net for a
  change that moves no redirect.
- No other test changes. `upload-accounts`, `upload-instruments`, `upload-columns` and the journeys
  assert the same `Location`s before and after.

## 4. Documentation

- **ARCHITECTURE.md Appendix A:**
  - a new row for `upload-resume.server.ts`: the one shape a wizard route resumes a draft at, and the
    one reader of `?stale=true`;
  - the `upload/index.tsx` row: "via `resumeAt`".
- **ARCHITECTURE.md §6.1**, "Where the draft got to is a property of the row": one clause saying
  `resumeAt` turns the step into the redirect.
- **ARCHITECTURE.md §7.1**, the `DraftNotReadyError` paragraph: "the routes translate it into a
  redirect" names `resumeAt`, as does the table row's "a redirect to that step" (`:1765`).
- **What stays true:** §7.1's "One deliberate inversion of this table" (`:1779`) and the
  `owner-reading.server.ts` row (`:2439`) still describe the one module that throws a redirect in
  place of a domain error. `resumeAt` inverts nothing: the domain still throws, and the route's
  `catch` still translates, now through one function. Neither passage changes.
- **`docs/specs/README.md`:** the 0031 row.

## 5. What the candidate proposed that this spec does not do, and why

- **`parseDraft` returning `{ header, step } | { header, blocked }`, blocked as an arm (spec 0030
  deferred the reshape here).**
  - "Blocked" is not reached through `parseDraft`. It comes from `readyParse` (`:1019-1031`), which
    throws through `assembleDiff` and `recordUpload`, the latter inside the account locks (§7.2).
  - Making it an arm means `reviewForDraft`, `diffForDraft` and `recordUpload` return unions. That
    widens the commit path for one consumer, the review loader and action, which already handle it
    in one `instanceof` each.
  - The redirect half of that handling moves to `resumeAt`; the render half stays.
- **One draft header.** The four shapes serve four screens with different fields (inventory:
  `UploadDiff` has no owner or tail, `BlockedDraft` carries problems). Merging them changes no page,
  and it touches the review component and `UploadDiff`. That is a separate refactor with its own
  diff, not this translator.
- **The steps literal built once from the header.** Today's strips differ per screen:
  - columns hard-codes `instrumentsSkipped: false` and takes `accountsSkipped` from `mappingScope`;
  - accounts hard-codes `accountsSkipped: false`;
  - a blocked review (`blockedDraftFor`, `uploads.server.ts:595-612`) takes `accountsSkipped` by
    the columns rule, but `instrumentsSkipped` from `instrumentsStepSkipped`.

  One builder would change the strip a household sees on at least columns (`columns.tsx:147-148`).
  Out, so that this spec changes no page.
- **`resumeAt(draft, step, url)` in `app/routes/upload/draft.tsx`.** The card's location and
  signature.
  - `owner-reading.server.ts` is the precedent for `redirect` from `app/lib`.
  - The stale source is not always the URL: the review action takes it from the posted
    `reviewRevision` (§2). So the third argument is the flag, not the URL.
- **A 404 helper.** Every site still needs its `instanceof NotFoundError` test, so a helper saves one
  expression per site. The review action's `data({ accountId })` differs on purpose.
- **Shrinking the 1 645-line route matrix to placement checks.** Kept whole. This change moves no
  redirect, and the matrix is what proves it.

## 6. Differential validation

The claim: every wizard request answers exactly as on `main`, with the stale flag carried or
dropped in the same places.

**Setup** as spec 0030 §7:
- two worktrees, `main` at `05d9746` and the branch;
- a private Postgres recreated and migrated before each tree's run;
- one untracked harness, `tests/differential/resume.test.ts`, copied unchanged into both;
- run with `--no-cache`, twice on `main` first to prove it deterministic, then `diff -r`.

The harness imports only what both trees export, and drives every request through the route
modules' `loader`/`action` and `tests/support/routes.ts`. It stages with the fixtures and the
columns action, posting the same form fields it later re-posts (`headerRow`, the column names,
`costBasisIs`, …, as `upload-wizard.test.ts:1277-1290`). No shared helper exists for that form;
`upload-columns.test.ts:270`'s `saveColumns` is file-local.

**Drafts:**
1. Single account, no mapping.
2. Single account, mapped, one unresolved string.
3. Single account, every string aliased.
4. The legacy blocked draft, as `upload-wizard.test.ts:1109-1145` stages it:
   - valid bytes and a planted mapping;
   - `VTI` aliased, so the pre-swap review renders;
   - a review GET for its `reviewRevision`;
   - then the file swapped by a raw `UPDATE`, which no fixture offers. The harness writes it as the
     test does.
5. Several accounts with a number owed.
6. Several accounts, every number matched, one unresolved string.

**The revision to post.** `REVIEW_REVISION` is not exported (`uploads.server.ts:1362`). A posted
value without its prefix goes to `redirectDocument` (`review.tsx:106-113`, out of scope). So:
- drafts 1, 2 and 5 post the `reviewRevision` of draft 3's review GET. Only its prefix is checked
  before the not-ready throw, and draft 3 runs before them;
- draft 4 posts its own, taken before the swap.

**Requests, in this order per draft** (later ones write state). Each is recorded with `outcomeOf`:
the status and `Location`, or the loader data's `staleReviewMessage`, `steps` and step-identifying
fields.
1. The index GET.
2. The columns, accounts, instruments and review GETs, each with and without `?stale=true`.
3. For drafts 2, 3, 5 and 6, the columns POST re-submitting the staged fields, with and without
   `?stale=true`. They go to instruments, review, accounts and instruments
   (`uploads.server.ts:455`).
   - Not draft 1, which has no mapping and would change state.
   - Not draft 4, whose mapping returns problems rather than a redirect.
4. For drafts 1, 2, 4 and 5, the review POST with and without `reviewRevision`, reaching
   `review.tsx:199`/`:202`.
5. For drafts 1, 2 and 4, the same pair again with `accountId: "0"`. Its `ValidationError`
   (`uploads.server.ts:1660-1661`, in `commitUnderLocks`) routes through the recovery at
   `:176`/`:179`, as `upload-wizard.test.ts:1197-1210` does. Not draft 5: a multi-account draft
   reaches `readyParse` (`:1558`) before that guard, so it records `:202` again.
6. For drafts 1 (`instruments.tsx:82`, to columns), 3 (`:86`, step null) and 5 (`:82`, to
   accounts), the instruments POST with and without `?stale=true`. No fields are needed:
   `parseDraft` decides at `:80-86` before any field is read.
7. Last for draft 5, the accounts POST with and without `?stale=true`:
   - `number-0` is the owed number;
   - `accountId-0` is an offered account id. Skipping the only owed number would leave nothing
     to record and refuse at `accounts.tsx:66` (`uploads.server.ts:763-767`);
   - the first write moves the step, and the second still redirects at `accounts.tsx:64`.
8. Last for draft 2, the instruments POST with and without `?stale=true`. Its fields:
   - `raw-0` is the unresolved string;
   - the rest of the full `create` field set that `tests/journeys/statement-to-portfolio.test.ts:77-91`
     posts: `kind-0: "create"`, `priceSource-0: "manual"` (so no probe runs), `name-0`, and
     `classificationId-0: "__new__"` with `newClassificationName-0` and
     `newClassificationAssetClass-0`. Anything less is refused at `instruments.tsx:108-109`
     (`instrument-resolution.server.ts:270-340`).

   The first reaches `:106` after `resolveAll`. The second then finds the step null and reaches
   `:86`.

Each goes to `$DIFF_OUT/<nn>-<name>.json`, never whole rows or timestamps.

**Expected result:** `diff -r` empty.

**In the running app:** on the dev server over `scripts/seed-demo.ts` data, on both trees:
- a single-account upload walked to review;
- the stale path: another tab remaps the columns, review's record is refused as stale, and the
  reader is sent to columns with the warning, then on through instruments to review with it.

The same screens and URLs on both trees. Captures go in the pull request.

## Acceptance

**The translator**
- [ ] `app/lib/upload-resume.server.ts` exports `resumeAt`, `staleOf`, `ResumeStep`, as §1.
- [ ] Every row of §2's table uses `resumeAt`, with the id and stale source shown.
- [ ] `grep -rn 'searchParams.get("stale")\|?stale=true' app/routes` returns nothing.
- [ ] `instrumentsStepSkipped` is exported; `grep -rn 'hadFirstSightings === false' app/routes`
      returns nothing.

**Tests**
- [ ] §3's two new files; `upload-wizard.test.ts` changes only its header.

**Documentation**
- [ ] §4's edits and no others.

**Gates**
- [ ] `npm run typecheck`, `npm test`, `npm run build` clean.
- [ ] §6's differential: `diff -r` empty.

## Review findings rejected

Grounding review, three rounds.
- **Round 1:** twelve findings, two material, both in §6:
  - the instruments POST rows `:82` and `:86` were never driven;
  - the review recovery at `:176`/`:179` needs an `accountId` mismatch first.

  The minor ones were citation and count fixes, plus three notes:
  - why the translator lives in `app/lib` rather than `draft.tsx`;
  - that §7.1's "one deliberate inversion" stays true;
  - `parseDraft` takes the `UploadDraft` row.

  All folded in.
- **Round 2:** three material findings, all in §6's harness, all folded in:
  - draft 5 cannot reach the recovery;
  - a posted revision needs its prefix or it goes to `redirectDocument`;
  - state-writing POSTs must come last.

  Four minor, all folded in, including dropping a false claim that no route module exports a
  helper.
- **Round 3:** one material finding, the instruments POST's full `create` field set. Four minor:
  draft 3 runs first, draft 4 aliases `VTI`, an offered account rather than a skip, one line range.
  All folded in.

All three rounds traced §2's fifteen rows and found the change moves no redirect, status, query
parameter, message or step strip.

Code review, two reviewers (correctness; standards and shape), neither blocking. The correctness
reviewer traced all fifteen rows of §2 against the diff and ran the route, journey and
multi-account suites. Folded in from the standards review:
- the review loader binds `staleReview` once;
- a comment that restated `step ?? "review"` is cut;
- `parse-draft.test.ts` asserts with data rows and `toMatchObject`, destructuring the fixtures as
  its neighbours do;
- the Appendix A row moves into the upload cluster;
- two lines are rewrapped.

The differential recorded 90 requests over six drafts (68 redirects, 27 carrying the flag), and
`diff -r` was empty against `main` twice. The dev walk was byte-identical on both trees, including
the stale path's warning on instruments and on review.

Rejected: none. §5 records what this spec declines from the candidate, and why.
