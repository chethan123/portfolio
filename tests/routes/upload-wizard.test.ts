// Where a half-finished upload resumes, and a finished one refuses to land twice (ingest brief §2.1, §6.5, §7.4). Four URLs,
// no client state — "how far did this draft get" must read entirely off the row (parseDraft), which has no test of its
// own; the matrix below pins it. Breaking this strands a reader rather than writing a wrong number. The one write-shaped
// risk is the re-POST after commit: 404, never a second recording, never a forged account id in the link back.
import { afterAll, describe, expect, it } from "vitest";

import { z } from "zod";

import Columns, { loader as columnsLoader } from "../../app/routes/upload/columns.tsx";
import { loader as resumeDraft } from "../../app/routes/upload/index.tsx";
import Instruments, {
  loader as instrumentsLoader,
} from "../../app/routes/upload/instruments.tsx";
import Review, {
  action as reviewAction,
  loader as reviewLoader,
} from "../../app/routes/upload/review.tsx";
import { earliestRecordableDate, latestRecordableDate } from "~/lib/input.server";
import { lastRecorded } from "~/lib/balances.server";
import { STALE_REVIEW_MESSAGE, rememberMapping, requireDraft } from "~/lib/uploads.server";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { args, get, post, redirectTo } from "../support/routes.ts";

import type { TestContext } from "../support/database.ts";
import type { SeededAccount, SeededInstrument } from "../support/fixtures.ts";
import type { StatementMapping } from "~/lib/statement";

afterAll(closeTestDatabase);

const encode = (text: string) => new TextEncoder().encode(text);

/** One position, and no column that dates the file — so review asks for a date. */
const CSV = ["Symbol,Quantity,Basis", "VTI,100,40"].join("\n");

const MAPPING: StatementMapping = {
  headerRow: 0,
  delimiter: ",",
  columns: { instrument: "Symbol", quantity: "Quantity" },
  costBasisIs: "per_share",
  owedAsPositive: false,
  combineDuplicateRows: true,
};

/** A statement date in the past, which is the only kind `recordedDate` takes. */
const AS_OF = "2026-06-30";

type Staged = {
  draftId: string;
  accountId: string;
  account: SeededAccount;
  instrument: SeededInstrument | null;
};

// A draft that has passed the columns step. `resolved` picks the fork: aliased already → rememberMapping sends it straight
// to review; not aliased → instruments step is owed. Written once at this moment, unrecoverable after — must choose before saving the mapping.
async function stageDraft(
  ctx: Pick<
    TestContext,
    "db" | "seedAccount" | "seedInstrument" | "seedInstrumentAlias" | "seedUploadDraft"
  >,
  { resolved }: { resolved: boolean },
): Promise<Staged> {
  const account = await ctx.seedAccount({ kind: "brokerage" });
  const draft = await ctx.seedUploadDraft({
    account,
    filename: "Positions.csv",
    bytes: encode(CSV),
  });

  let instrument: SeededInstrument | null = null;
  if (resolved) {
    instrument = await ctx.seedInstrument({
      symbol: "VTI",
      name: "Vanguard Total Stock",
    });
    await ctx.seedInstrumentAlias({ instrument, rawString: "VTI" });
  }

  const outcome = await rememberMapping(draft.id, MAPPING, ctx.db);
  if ("problems" in outcome) {
    throw new Error("This fixture's mapping does not parse its own file.");
  }

  return { draftId: draft.id, accountId: account.id, account, instrument };
}

/** The review route's data, including the blocked legacy-draft state. */
async function reviewOutcome(draftId: string, search = "") {
  const outcome = await reviewLoader(args(get(`/upload/${draftId}/review${search}`), { draftId }));

  if (outcome instanceof Response) {
    throw new Error(
      `Expected the review screen, and the route sent the reader to ${outcome.headers.get(
        "Location",
      )}.`,
    );
  }
  return outcome;
}

/** A diffable review, or a failure naming why the fixture never reached one. */
async function reviewPage(draftId: string, search = "") {
  const outcome = await reviewOutcome(draftId, search);
  if (outcome.diff === null) throw new Error("Expected a diffable review, and the draft was blocked.");
  return outcome;
}

/** The shape of `data({ accountId }, { status: 404 })` once it has been thrown. */
const expiredPage = z.object({
  init: z.object({ status: z.number() }),
  data: z.object({ accountId: z.string().nullable() }),
});

// data() throws neither a Response nor an Error, so outcomeOf/responseOf can't unwrap it — this does it directly.
async function expiredPageOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (thrown) {
    return expiredPage.parse(thrown);
  }
  throw new Error("Expected the re-POST to be refused, and it was not.");
}

/** Record the staged statement the way the screen does, and hand back the draft. */
async function commitStaged(ctx: Parameters<typeof stageDraft>[0]): Promise<Staged> {
  const staged = await stageDraft(ctx, { resolved: true });
  const review = await reviewPage(staged.draftId, `?asOf=${AS_OF}`);

  const destination = await redirectTo(() =>
    reviewAction(
      args(
        post(`/upload/${staged.draftId}/review`, {
          asOf: AS_OF,
          accountId: staged.accountId,
          reviewRevision: review.diff.reviewRevision ?? "",
      }),
        { draftId: staged.draftId },
      ),
    ),
  );

  if (!destination.startsWith(`/accounts/${staged.accountId}?uploaded=`)) {
    throw new Error(`This fixture's commit did not land: it answered ${destination}.`);
  }
  return staged;
}

describe("a draft's bare address", () => {
  it(
    "sends a draft that has saved no mapping to the columns step",
    withDatabase(async ({ seedAccount, seedUploadDraft }) => {
      const account = await seedAccount({ kind: "brokerage" });
      const draft = await seedUploadDraft({ account, bytes: encode(CSV) });

      expect(
        await redirectTo(() =>
          resumeDraft(args(get(`/upload/${draft.id}`), { draftId: draft.id })),
        ),
      ).toBe(`/upload/${draft.id}/columns`);
    }),
  );

  it(
    "sends a mapped draft whose file still names an unknown instrument to the instruments step",
    withDatabase(async (ctx) => {
      const { draftId } = await stageDraft(ctx, { resolved: false });

      expect(
        await redirectTo(() => resumeDraft(args(get(`/upload/${draftId}`), { draftId }))),
      ).toBe(`/upload/${draftId}/instruments`);
    }),
  );

  it(
    "sends a file that raised no first sighting straight to review, with the strip saying so",
    withDatabase(async (ctx) => {
      const { draftId } = await stageDraft(ctx, { resolved: true });

      expect(
        await redirectTo(() => resumeDraft(args(get(`/upload/${draftId}`), { draftId }))),
      ).toBe(`/upload/${draftId}/review`);

      // Skipped, not merely passed — an alias doesn't say which draft wrote it, so instrumentsSkipped (columns step, brief §7.5) is the only record.
      const page = await reviewPage(draftId);
      expect(page.steps).toMatchObject({
        current: 4,
        instrumentsSkipped: true,
      });

      // Boundaries come from the validator so the picker can't offer a date the commit then refuses; the floor matters most (a mistyped millennium is unreachable history otherwise).
      expect(page.earliestAsOf).toBe(earliestRecordableDate());
      expect(page.latestAsOf).toBe(latestRecordableDate());
      expect(page.earliestAsOf).toBe("1970-01-01");

      const stalePage = await reviewPage(draftId, "?stale=true");
      expect(stalePage.staleReviewMessage).toBe(STALE_REVIEW_MESSAGE);
      expect(renderRoute(Review, `/upload/${draftId}/review?stale=true`, stalePage)).toContain(
        STALE_REVIEW_MESSAGE,
      );
    }),
  );
});

describe("a review over a draft that is not ready for one", () => {
  it(
    "sends an unready loader to columns and refuses an older review submit as stale",
    withDatabase(async (ctx) => {
      const { draftId, accountId } = await stageDraft(ctx, { resolved: true });
      const reviewed = await reviewPage(draftId, `?asOf=${AS_OF}`);

      // Written straight onto the row: rememberMapping refuses an unparseable mapping, so this row can only exist via a rule predating it, or a hand edit — parseDraft's own guard.
      await ctx.db
        .updateTable("upload_draft")
        .set({ mapping: JSON.stringify({ headerRow: 0, delimiter: "," }) })
        .where("id", "=", draftId)
        .execute();

      expect(
        await redirectTo(() => reviewLoader(args(get(`/upload/${draftId}/review`), { draftId }))),
      ).toBe(`/upload/${draftId}/columns`);
      expect(
        await redirectTo(() =>
          reviewLoader(args(get(`/upload/${draftId}/review?stale=true`), { draftId })),
        ),
      ).toBe(`/upload/${draftId}/columns?stale=true`);

      // Even when the account-id guard fires first, rebuilding its response finds the changed
      // mapping unready and carries the stale review to the step that can repair it.
      const staleReview = await redirectTo(() =>
        reviewAction(
          args(
            post(`/upload/${draftId}/review`, {
              asOf: AS_OF,
              accountId: "0",
              reviewRevision: reviewed.diff.reviewRevision ?? "",
            }),
            { draftId },
          ),
        ),
      );
      expect(staleReview).toBe(`/upload/${draftId}/columns?stale=true`);

      const finalDestination = staleReview;
      const page = await columnsLoader(args(get(finalDestination), { draftId }));
      if (page instanceof Response) throw new Error(`Expected Columns, got ${page.status}.`);
      const markup = renderRoute(Columns, finalDestination, page);
      expect(markup).toContain("The previous attempt was refused");
      expect(markup).toContain('role="alert"');

      expect(await lastRecorded(accountId, ctx.db)).toBeNull();
      await expect(requireDraft(draftId, ctx.db)).resolves.toMatchObject({ id: draftId });
    }),
  );

  it(
    "carries the stale notice through review to an unresolved instruments screen",
    withDatabase(async (ctx) => {
      const { draftId, accountId } = await stageDraft(ctx, { resolved: true });
      const reviewed = await reviewPage(draftId, `?asOf=${AS_OF}`);

      const changed = await rememberMapping(
        draftId,
        {
          ...MAPPING,
          columns: { instrument: "Basis", quantity: "Quantity", costBasis: null },
        },
        ctx.db,
      );
      expect(changed).toEqual({ nextStep: "instruments" });

      const staleReview = await redirectTo(() =>
        reviewAction(
          args(
            post(`/upload/${draftId}/review`, {
              asOf: AS_OF,
              accountId,
              reviewRevision: reviewed.diff.reviewRevision ?? "",
            }),
            { draftId },
          ),
        ),
      );
      const finalDestination = staleReview;
      expect(finalDestination).toBe(`/upload/${draftId}/instruments?stale=true`);

      const page = await instrumentsLoader(args(get(finalDestination), { draftId }));
      if (page instanceof Response) throw new Error(`Expected Instruments, got ${page.status}.`);
      const markup = renderRoute(Instruments, finalDestination, page);
      expect(markup).toContain("The previous attempt was refused");
      expect(markup).toContain('role="alert"');
      expect(await lastRecorded(accountId, ctx.db)).toBeNull();
      await expect(requireDraft(draftId, ctx.db)).resolves.toMatchObject({ id: draftId });
    }),
  );
});

describe("a review submitted after another tab changes the mapping", () => {
  it(
    "refuses the stale revision, keeps the draft and history, and renders an actionable alert",
    withDatabase(async (ctx) => {
      const { draftId, accountId } = await stageDraft(ctx, { resolved: true });
      const tabA = await reviewPage(draftId, `?asOf=${AS_OF}`);
      expect(tabA.diff.unchangedCount).toBe(0);
      expect(tabA.diff.added[0]?.quantity).toBe("100");

      const tabB = await rememberMapping(
        draftId,
        {
          ...MAPPING,
          columns: { instrument: "Symbol", quantity: "Basis" },
        },
        ctx.db,
      );
      expect(tabB).toEqual({ nextStep: "review" });

      const refusal = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            asOf: AS_OF,
            accountId,
            reviewRevision: tabA.diff.reviewRevision ?? "",
            reviewedAsOf: tabA.diff.asOfInput,
          }),
          { draftId },
        ),
      );
      if (refusal instanceof Response) throw new Error("Expected the current review, not a redirect.");
      expect(refusal.diff?.added[0]?.quantity).toBe("40");
      expect(refusal.formError).toContain("This statement or its account changed after this review");
      expect(refusal.formError).not.toContain("different statement date");
      const markup = renderRoute(
        Review,
        `/upload/${draftId}/review?asOf=${AS_OF}`,
        tabA,
        { actionData: refusal },
      );
      expect(markup).toContain("This statement or its account changed after this review");
      expect(markup).toContain("Nothing was recorded");
      expect(markup).toContain('role="alert"');
      expect(markup).toContain('name="reviewRevision"');

      expect(await lastRecorded(accountId, ctx.db)).toBeNull();
      await expect(requireDraft(draftId, ctx.db)).resolves.toMatchObject({
        id: draftId,
      });
    }),
  );
});

describe("the review revision carried by the form", () => {
  it(
    "reviews a changed date without recording and keeps an empty date invalid",
    withDatabase(async (ctx) => {
      const { draftId, accountId } = await stageDraft(ctx, { resolved: true });

      expect(
        await redirectTo(() =>
          reviewAction(
            args(
              post(`/upload/${draftId}/review`, {
                intent: "review-date",
                asOf: AS_OF,
                accountId,
              }),
              { draftId },
            ),
          ),
        ),
      ).toBe(`/upload/${draftId}/review?asOf=${AS_OF}`);
      expect(await lastRecorded(accountId, ctx.db)).toBeNull();

      const empty = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            intent: "review-date",
            asOf: "",
            accountId,
            confirmFiledBehind: "true",
            confirmRemovals: "true",
          }),
          { draftId },
        ),
      );
      if (empty instanceof Response) throw new Error("Expected a date error, not a redirect.");
      if (empty.diff === null) throw new Error("Expected the invalid dated review.");
      expect(empty.errors.asOf).toMatch(/required/);
      expect(empty.diff.reviewRevision).toBeNull();
      expect(empty.values.confirmFiledBehind).toBeUndefined();
      expect(empty.values.confirmRemovals).toBeUndefined();
      expect(empty.confirmationReset).toBeTypeOf("string");
    }),
  );

  it(
    "makes a changed typed date a new review before it can be recorded",
    withDatabase(async (ctx) => {
      const { draftId, accountId } = await stageDraft(ctx, { resolved: true });
      const firstReview = await reviewPage(draftId);
      expect(firstReview.diff.asOf.source).toBe("asked");
      expect(firstReview.diff.asOf.date).not.toBe(AS_OF);
      const firstMarkup = renderRoute(Review, `/upload/${draftId}/review`, firstReview);
      expect(firstMarkup).toContain('name="reviewedAsOf"');
      expect(firstMarkup).toContain(`name="reviewedAsOf" value="${firstReview.diff.asOfInput}"`);

      const changedDate = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            asOf: AS_OF,
            accountId,
            reviewRevision: firstReview.diff.reviewRevision ?? "",
            reviewedAsOf: firstReview.diff.asOfInput,
          }),
          { draftId },
        ),
      );
      if (changedDate instanceof Response)
        throw new Error("Expected the newly dated review, not a redirect.");
      expect(await lastRecorded(accountId, ctx.db)).toBeNull();

      expect(changedDate.diff?.asOf).toEqual({ source: "asked", date: AS_OF });
      expect(changedDate.diff?.reviewRevision).not.toBe(firstReview.diff.reviewRevision);
      expect(changedDate.formError).toBe(
        `This comparison was drawn for a different statement date. Here it is for ${AS_OF}. ` +
          "Nothing was recorded — check it and record again.",
      );
      expect(changedDate.formError).not.toContain("statement or its account changed");
      expect(changedDate.values.confirmFiledBehind).toBeUndefined();
      expect(changedDate.values.confirmRemovals).toBeUndefined();
      expect(await lastRecorded(accountId, ctx.db)).toBeNull();
      await expect(requireDraft(draftId, ctx.db)).resolves.toMatchObject({ id: draftId });

      const changedMarkup = renderRoute(Review, `/upload/${draftId}/review`, firstReview, {
        actionData: changedDate,
      });
      expect(changedMarkup).toContain(`name="reviewedAsOf" value="${AS_OF}"`);

      const recorded = await redirectTo(() =>
        reviewAction(
          args(
            post(`/upload/${draftId}/review`, {
              asOf: AS_OF,
              accountId,
              reviewRevision: changedDate.diff?.reviewRevision ?? "",
              reviewedAsOf: changedDate.diff?.asOfInput ?? "",
            }),
            { draftId },
          ),
        ),
      );
      expect(recorded).toMatch(new RegExp(`^/accounts/${accountId}\\?uploaded=\\d+$`));
    }),
  );

  it(
    "keeps a dated refusal's diff through a later validation and clears both acknowledgements",
    withDatabase(async (ctx) => {
      const { draftId, account, instrument: vti } = await stageDraft(ctx, { resolved: true });
      if (vti === null) throw new Error("The resolved fixture did not seed its instrument.");
      const b = await ctx.seedInstrument({ symbol: "BB", name: "Fund B" });
      const c = await ctx.seedInstrument({ symbol: "CC", name: "Fund C" });
      const holdings = [vti, b, c].map((instrument) => ({ instrument, quantity: "1" }));
      await ctx.seedPositionSet({ account, asOf: "2026-03-31", holdings });
      await ctx.seedPositionSet({ account, asOf: "2026-07-31", holdings });

      const bareReview = await reviewPage(draftId);
      const datedRefusal = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            asOf: AS_OF,
            accountId: account.id,
            baselineSetId: bareReview.diff.baselineSetId ?? "",
            confirmRemovals: "true",
            reviewRevision: bareReview.diff.reviewRevision ?? "",
          }),
          { draftId },
        ),
      );
      if (datedRefusal instanceof Response) throw new Error("Expected the dated refusal.");
      if (datedRefusal.diff === null) throw new Error("Expected its freshly dated diff.");
      expect(datedRefusal.diff.asOf).toEqual({ source: "asked", date: AS_OF });
      expect(datedRefusal.diff.filedBehind).not.toBeNull();
      expect(datedRefusal.diff.majorityRemoved).toBe(true);

      const validation = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            asOf: AS_OF,
            accountId: "0",
            baselineSetId: datedRefusal.diff.baselineSetId ?? "",
            confirmFiledBehind: "true",
            confirmRemovals: "true",
            reviewRevision: datedRefusal.diff.reviewRevision ?? "",
          }),
          { draftId },
        ),
      );
      if (validation instanceof Response) throw new Error("Expected validation data.");
      expect(validation.diff?.asOf).toEqual({ source: "asked", date: AS_OF });
      expect(validation.diff?.filedBehind).not.toBeNull();
      expect(validation.diff?.majorityRemoved).toBe(true);
      expect(validation.values.confirmFiledBehind).toBeUndefined();
      expect(validation.values.confirmRemovals).toBeUndefined();

      const markup = renderRoute(Review, `/upload/${draftId}/review`, bareReview, {
        actionData: validation,
      });
      expect(markup).toContain(`value="${AS_OF}"`);
      expect(markup).toContain('name="confirmFiledBehind"');
      expect(markup).not.toMatch(/name="confirmFiledBehind"[^>]*checked/);
      expect(markup).toContain('name="confirmRemovals"');
      expect(markup).not.toMatch(/name="confirmRemovals"[^>]*checked/);
      expect((await lastRecorded(account.id, ctx.db))?.asOf).toBe("2026-07-31");
    }),
  );

  it(
    "clears removal and filed-behind acknowledgements after validation or a stale revision",
    withDatabase(async (ctx) => {
      const { draftId, account, instrument: vti } = await stageDraft(ctx, { resolved: true });
      if (vti === null) throw new Error("The resolved fixture did not seed its instrument.");
      const b = await ctx.seedInstrument({ symbol: "BB", name: "Fund B" });
      const c = await ctx.seedInstrument({ symbol: "CC", name: "Fund C" });
      await ctx.seedPositionSet({
        account,
        asOf: "2026-03-31",
        holdings: [vti, b, c].map((instrument) => ({
          instrument,
          quantity: "1",
        })),
      });
      await ctx.seedPositionSet({
        account,
        asOf: "2026-07-31",
        holdings: [vti, b, c].map((instrument) => ({
          instrument,
          quantity: "1",
        })),
      });

      const reviewed = await reviewPage(draftId, `?asOf=${AS_OF}`);
      expect(reviewed.diff.majorityRemoved).toBe(true);
      expect(reviewed.diff.filedBehind).not.toBeNull();
      const validation = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            asOf: AS_OF,
            accountId: "999999",
            baselineSetId: reviewed.diff.baselineSetId ?? "",
            confirmFiledBehind: "true",
            confirmRemovals: "true",
            reviewRevision: reviewed.diff.reviewRevision ?? "",
          }),
          { draftId },
        ),
      );
      if (validation instanceof Response)
        throw new Error("Expected validation data, not a redirect.");
      expect(validation.values.confirmFiledBehind).toBeUndefined();
      expect(validation.values.confirmRemovals).toBeUndefined();
      const repeated = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            asOf: AS_OF,
            accountId: "999999",
            baselineSetId: reviewed.diff.baselineSetId ?? "",
            confirmFiledBehind: "true",
            confirmRemovals: "true",
            reviewRevision: reviewed.diff.reviewRevision ?? "",
          }),
          { draftId },
        ),
      );
      if (repeated instanceof Response)
        throw new Error("Expected validation data, not a redirect.");
      expect(repeated.confirmationReset).not.toBe(validation.confirmationReset);
      const validationMarkup = renderRoute(
        Review,
        `/upload/${draftId}/review?asOf=${AS_OF}`,
        reviewed,
        { actionData: validation },
      );
      expect(validationMarkup).toContain('name="confirmFiledBehind"');
      expect(validationMarkup).not.toMatch(/name="confirmFiledBehind"[^>]*checked/);
      expect(validationMarkup).toContain('name="confirmRemovals"');
      expect(validationMarkup).not.toMatch(/name="confirmRemovals"[^>]*checked/);

      await rememberMapping(
        draftId,
        {
          ...MAPPING,
          columns: { instrument: "Symbol", quantity: "Basis" },
        },
        ctx.db,
      );
      const staleRefusal = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            asOf: AS_OF,
            accountId: account.id,
            baselineSetId: reviewed.diff.baselineSetId ?? "",
            confirmFiledBehind: "true",
            confirmRemovals: "true",
            reviewRevision: reviewed.diff.reviewRevision ?? "",
          }),
          { draftId },
        ),
      );
      if (staleRefusal instanceof Response)
        throw new Error("Expected the current review, not a redirect.");
      expect(staleRefusal.values.confirmFiledBehind).toBeUndefined();
      expect(staleRefusal.values.confirmRemovals).toBeUndefined();
      const staleMarkup = renderRoute(
        Review,
        `/upload/${draftId}/review?asOf=${AS_OF}`,
        reviewed,
        { actionData: staleRefusal },
      );
      expect(staleMarkup).toContain('name="confirmFiledBehind"');
      expect(staleMarkup).not.toMatch(/name="confirmFiledBehind"[^>]*checked/);
      expect(staleMarkup).toContain('name="confirmRemovals"');
      expect(staleMarkup).not.toMatch(/name="confirmRemovals"[^>]*checked/);

      const refreshed = await reviewPage(draftId, `?asOf=${AS_OF}`);
      const staleValidation = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            asOf: AS_OF,
            accountId: "999999",
            baselineSetId: refreshed.diff.baselineSetId ?? "",
            confirmFiledBehind: "true",
            confirmRemovals: "true",
            reviewRevision: refreshed.diff.reviewRevision ?? "",
          }),
          { draftId },
        ),
      );
      if (staleValidation instanceof Response) {
        throw new Error("Expected validation data on the stale review, not a redirect.");
      }
      expect(staleValidation.confirmationReset).toBeTypeOf("string");
      const refusedStaleMarkup = renderRoute(
        Review,
        `/upload/${draftId}/review?asOf=${AS_OF}`,
        refreshed,
        { actionData: staleValidation },
      );
      expect(refusedStaleMarkup).not.toMatch(/name="confirmFiledBehind"[^>]*checked/);
      expect(refusedStaleMarkup).not.toMatch(/name="confirmRemovals"[^>]*checked/);
      expect(await lastRecorded(account.id, ctx.db)).not.toBeNull();
      expect((await lastRecorded(account.id, ctx.db))?.asOf).toBe("2026-07-31");
    }),
  );

  it(
    "rejects missing revisions and turns an invalid date query into an accessible field error",
    withDatabase(async (ctx) => {
      const { draftId, accountId } = await stageDraft(ctx, { resolved: true });
      const initial = await reviewPage(draftId);
      const missing = await reviewAction(
        args(post(`/upload/${draftId}/review`, { asOf: AS_OF, accountId }), { draftId }),
      );
      if (missing instanceof Response) throw new Error("Expected a stale-review refusal.");
      expect(missing.formError).toContain("This statement or its account changed");
      expect(missing.diff?.asOf).toEqual({ source: "asked", date: AS_OF });

      const invalidAfterGuard = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            asOf: "2026-02-30",
            accountId: "0",
            reviewRevision: initial.diff.reviewRevision ?? "",
          }),
          { draftId },
        ),
      );
      if (invalidAfterGuard instanceof Response) throw new Error("Expected validation data.");
      expect(invalidAfterGuard.diff?.asOfError).toMatch(/not a date on the calendar/);
      expect(invalidAfterGuard.diff?.reviewRevision).toBeNull();

      const missingDateAfterGuard = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            accountId: "0",
            reviewRevision: initial.diff.reviewRevision ?? "",
          }),
          { draftId },
        ),
      );
      if (missingDateAfterGuard instanceof Response) throw new Error("Expected validation data.");
      expect(missingDateAfterGuard.diff?.asOfError).toMatch(/required/);
      expect(missingDateAfterGuard.diff?.reviewRevision).toBeNull();

      const invalid = await reviewPage(draftId, "?asOf=2026-02-30");
      expect(invalid.diff.asOfError).toMatch(/not a date on the calendar/);
      const markup = renderRoute(Review, `/upload/${draftId}/review?asOf=2026-02-30`, invalid);
      expect(markup).toContain('aria-invalid="true"');
      expect(markup).toContain('role="alert"');
      expect(markup).toContain("not a date on the calendar");
      expect(await lastRecorded(accountId, ctx.db)).toBeNull();
      await expect(requireDraft(draftId, ctx.db)).resolves.toMatchObject({
        id: draftId,
      });
    }),
  );

  it(
    "renders a source-specific block for a legacy mapping that now exposes an invalid row",
    withDatabase(async (ctx) => {
      const account = await ctx.seedAccount({ kind: "brokerage" });
      const validCsv =
        "Instrument,Quantity,Cost Basis,As Of,Account\n" +
        "VTI,282.144455,165.4961,2026-09-13,Z12-345678\n" +
        "VTI,139.153103,108.2561,2026-09-13,Z12-345678\n";
      const invalidCsv = validCsv.replace("\nVTI,139.153103", "\n,139.153103");
      const draft = await ctx.seedUploadDraft({
        account,
        filename: "blank-instrument.csv",
        bytes: encode(validCsv),
      });
      const vti = await ctx.seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock" });
      await ctx.seedInstrumentAlias({ instrument: vti, rawString: "VTI" });

      const legacyMapping: StatementMapping = {
        ...MAPPING,
        columns: {
          instrument: "Instrument",
          quantity: "Quantity",
          costBasis: "Cost Basis",
          asOf: "As Of",
          accountNumber: "Account",
        },
      };
      await ctx.db
        .updateTable("upload_draft")
        .set({ mapping: JSON.stringify(legacyMapping), had_first_sightings: false })
        .where("id", "=", draft.id)
        .execute();

      const stalePage = await reviewPage(draft.id);
      if (stalePage.diff === null) throw new Error("The valid draft was blocked.");
      await ctx.db
        .updateTable("upload_draft")
        .set({ raw_file: Buffer.from(invalidCsv) })
        .where("id", "=", draft.id)
        .execute();

      const page = await reviewOutcome(draft.id);
      if (page.diff !== null) throw new Error("The invalid draft rendered a removal diff.");
      expect(page.blocked.accountId).toBe(account.id);
      expect(page.blocked.instrumentsSkipped).toBe(true);
      expect(page.blocked).not.toHaveProperty("bytes");
      expect(page.blocked).not.toHaveProperty("mapping");
      const markup = renderRoute(Review, `/upload/${draft.id}/review`, page, {
        masked: true,
        actionData: {
          errors: {},
          formError: "Obsolete refusal",
          values: {},
          diff: stalePage.diff,
          confirmationReset: "blocked-test",
        },
      });

      expect(markup).toContain("This statement cannot be reviewed yet");
      expect(markup).toContain("Line 3");
      expect(markup).toContain("Quantity");
      expect(markup).toContain("Cost Basis");
      expect(markup).not.toContain("As Of");
      expect(markup).not.toContain("139.153103");
      expect(markup).not.toContain("108.2561");
      expect(markup).not.toContain("REMOVED");
      expect(markup).not.toContain("Record this statement");
      expect(markup).not.toContain("Obsolete refusal");
      expect(markup).toContain("change the column mapping");
      expect(markup).toContain("instrument is missing from the source row");
      expect(markup).toContain("edit the CSV outside Portfolio and upload the corrected file");
      expect(markup).toContain(`href="/upload/${draft.id}/columns"`);
      expect(markup).toContain(`href="/upload?account=${account.id}"`);

      expect(
        await redirectTo(() =>
          reviewAction(
            args(
              post(`/upload/${draft.id}/review`, {
                asOf: AS_OF,
                accountId: account.id,
                confirmRemovals: "true",
              }),
              { draftId: draft.id },
            ),
          ),
        ),
      ).toBe(`/upload/${draft.id}/review`);

      // The account guard fires before parsing. Its validation recovery must still rediscover the
      // blocked source row instead of redirecting to Columns and hiding the specific explanation.
      expect(
        await redirectTo(() =>
          reviewAction(
            args(
              post(`/upload/${draft.id}/review`, {
                asOf: AS_OF,
                accountId: "0",
                reviewRevision: stalePage.diff.reviewRevision ?? "",
              }),
              { draftId: draft.id },
            ),
          ),
        ),
      ).toBe(`/upload/${draft.id}/review`);
    }),
  );
});

describe("a review re-posted after its statement landed", () => {
  it(
    "answers 404 without recording the same statement a second time",
    withDatabase(async (ctx) => {
      const { draftId, accountId } = await commitStaged(ctx);
      const recorded = await lastRecorded(accountId, ctx.db);

      // The commit already deleted this draft — nothing left to read a second set out of.
      const refusal = await expiredPageOf(() =>
        reviewAction(
          args(post(`/upload/${draftId}/review`, { asOf: AS_OF, accountId }), {
            draftId,
          }),
        ),
      );

      expect(refusal.init.status).toBe(404);
      // Same set still latest — a second commit would have outranked it into a duplicate statement.
      expect(await lastRecorded(accountId, ctx.db)).toEqual(recorded);
    }),
  );

  it(
    "carries the posted account id back to the expired page only when it is one",
    withDatabase(async (ctx) => {
      const { draftId, accountId } = await commitStaged(ctx);

      const honest = await expiredPageOf(() =>
        reviewAction(
          args(post(`/upload/${draftId}/review`, { asOf: AS_OF, accountId }), {
            draftId,
          }),
        ),
      );
      expect(honest.data.accountId).toBe(accountId);

      // Posted field read back into a link — validated here, not trusted for having been a hidden input a moment ago.
      const forged = await expiredPageOf(() =>
        reviewAction(
          args(
            post(`/upload/${draftId}/review`, {
              asOf: AS_OF,
              accountId: "<script>alert(1)</script>",
            }),
            { draftId },
          ),
        ),
      );
      expect(forged.data.accountId).toBeNull();
    }),
  );
});
