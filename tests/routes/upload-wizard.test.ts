// Where a half-finished upload resumes, and a finished one refuses to land twice (ingest brief §2.1, §6.5, §7.4). Four URLs,
// no client state — "how far did this draft get" must read entirely off the row (parseDraft), which has no test of its
// own; the matrix below pins it. Breaking this strands a reader rather than writing a wrong number. The one write-shaped
// risk is the re-POST after commit: 404, never a second recording, never a forged account id in the link back.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { z } from "zod";

import Columns, {
  action as columnsAction,
  loader as columnsLoader,
} from "../../app/routes/upload/columns.tsx";
import { loader as resumeDraft } from "../../app/routes/upload/index.tsx";
import Instruments, {
  loader as instrumentsLoader,
} from "../../app/routes/upload/instruments.tsx";
import Review, {
  action as reviewAction,
  loader as reviewLoader,
} from "../../app/routes/upload/review.tsx";
import Done, { loader as doneLoader } from "../../app/routes/upload/done.tsx";
import { closeAccount } from "~/lib/accounts.server";
import { changeAlias } from "~/lib/instrument-aliases.server";
import { earliestRecordableDate, latestRecordableDate } from "~/lib/input.server";
import { lastRecorded } from "~/lib/balances.server";
import { reviewedFields, sectionKey } from "~/lib/review-form";
import {
  SKIP_NUMBER,
  STALE_REVIEW_MESSAGE,
  answerAccountNumbers,
  parseDraft,
  rememberMapping,
  requireDraft,
} from "~/lib/uploads.server";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { onlySection } from "../support/review.ts";
import { args, get, post, redirectTo, responseOf } from "../support/routes.ts";

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

// The multi-account draft (spec 0023, "Loading a draft with no account").
describe("a draft with no account", () => {
  it(
    "sends a freshly created multi-account draft's bare address to columns, same as a single-account one",
    withDatabase(async ({ seedUploadDraft }) => {
      const draft = await seedUploadDraft({ account: null, bytes: encode(CSV) });

      expect(
        await redirectTo(() =>
          resumeDraft(args(get(`/upload/${draft.id}`), { draftId: draft.id })),
        ),
      ).toBe(`/upload/${draft.id}/columns`);
    }),
  );

  it(
    "renders the columns step with 'several accounts' in place of one account's name",
    withDatabase(async ({ seedUploadDraft }) => {
      const draft = await seedUploadDraft({ account: null, bytes: encode(CSV) });

      const page = await columnsLoader(
        args(get(`/upload/${draft.id}/columns`), { draftId: draft.id }),
      );
      if (page instanceof Response) throw new Error(`Expected Columns, got ${page.status}.`);
      expect(page.draft.accountName).toBeNull();

      const markup = renderRoute(Columns, `/upload/${draft.id}/columns`, page);
      expect(markup).toContain("several accounts");
    }),
  );

  it(
    "bounces a draft carrying a single-account mapping back to columns, as though it had none",
    withDatabase(async (ctx) => {
      const instrument = await ctx.seedInstrument({
        symbol: "VTI",
        name: "Vanguard Total Stock",
      });
      await ctx.seedInstrumentAlias({ instrument, rawString: "VTI" });
      // Planted: rememberMapping refuses a mapping of the other kind, so only a hand edit leaves
      // one. Fully resolved, so parseDraft would say `step: null` were the draft single-account.
      const draft = await ctx.seedUploadDraft({
        account: null,
        bytes: encode(CSV),
        mapping: MAPPING,
      });

      expect(
        await redirectTo(() =>
          reviewLoader(args(get(`/upload/${draft.id}/review`), { draftId: draft.id })),
        ),
      ).toBe(`/upload/${draft.id}/columns`);
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
      expect(onlySection(tabA.diff).unchangedCount).toBe(0);
      expect(onlySection(tabA.diff).added[0]?.quantity).toBe("100");

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
      expect(onlySection(refusal.diff).added[0]?.quantity).toBe("40");
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

  it(
    "keeps the stale warning when the user also changes the statement date",
    withDatabase(async (ctx) => {
      const { draftId, accountId } = await stageDraft(ctx, { resolved: true });
      const tabA = await reviewPage(draftId);
      expect(onlySection(tabA.diff).added[0]?.quantity).toBe("100");
      expect(tabA.diff.asOfInput).not.toBe(AS_OF);

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
      expect(refusal.diff?.asOf).toEqual({ source: "asked", date: AS_OF });
      expect(onlySection(refusal.diff).added[0]?.quantity).toBe("40");
      expect(refusal.formError).toContain("This statement or its account changed after this review");
      expect(refusal.formError).not.toContain("different statement date");

      const markup = renderRoute(Review, `/upload/${draftId}/review`, tabA, {
        actionData: refusal,
      });
      expect(markup).toContain("This statement or its account changed after this review");
      expect(markup).not.toContain("different statement date");
      expect(markup).toContain('role="alert"');
      expect(await lastRecorded(accountId, ctx.db)).toBeNull();
      await expect(requireDraft(draftId, ctx.db)).resolves.toMatchObject({ id: draftId });
    }),
  );
});

// A current-build stale revision stays in-page: "refuses the stale revision, keeps the draft and
// history, and renders an actionable alert" above.
describe("a review posted by a page from an earlier build", () => {
  /** The v4 page's form: unsuffixed keys, a v4 revision, a typed date for an undated file. */
  const earlierForm = (accountId: string) => ({
    asOf: AS_OF,
    accountId,
    baselineSetId: "",
    reviewRevision: "v4.x",
    reviewedAsOf: AS_OF,
  });

  it(
    "reloads the whole document onto a stale review at the typed date and records nothing",
    withDatabase(async (ctx) => {
      const { draftId, accountId } = await stageDraft(ctx, { resolved: true });

      const response = await responseOf(() =>
        reviewAction(args(post(`/upload/${draftId}/review`, earlierForm(accountId)), { draftId })),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(
        `/upload/${draftId}/review?stale=true&asOf=${AS_OF}`,
      );
      expect(response.headers.get("X-Remix-Reload-Document")).toBe("true");
      expect(await lastRecorded(accountId, ctx.db)).toBeNull();
      await expect(requireDraft(draftId, ctx.db)).resolves.toMatchObject({ id: draftId });
    }),
  );

  it(
    "reloads a date change onto the review at that date without calling it stale",
    withDatabase(async (ctx) => {
      const { draftId, accountId } = await stageDraft(ctx, { resolved: true });

      const response = await responseOf(() =>
        reviewAction(
          args(
            post(`/upload/${draftId}/review`, { ...earlierForm(accountId), intent: "review-date" }),
            { draftId },
          ),
        ),
      );

      expect(response.headers.get("Location")).toBe(`/upload/${draftId}/review?asOf=${AS_OF}`);
      expect(response.headers.get("X-Remix-Reload-Document")).toBe("true");
      expect(await lastRecorded(accountId, ctx.db)).toBeNull();
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
            [sectionKey("confirmFiledBehind", accountId)]: "true",
            [sectionKey("confirmRemovals", accountId)]: "true",
          }),
          { draftId },
        ),
      );
      if (empty instanceof Response) throw new Error("Expected a date error, not a redirect.");
      if (empty.diff === null) throw new Error("Expected the invalid dated review.");
      expect(empty.errors.asOf).toMatch(/required/);
      expect(empty.diff.reviewRevision).toBeNull();
      expect(empty.values[sectionKey("confirmFiledBehind", accountId)]).toBeUndefined();
      expect(empty.values[sectionKey("confirmRemovals", accountId)]).toBeUndefined();
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
      expect(changedDate.values[sectionKey("confirmFiledBehind", accountId)]).toBeUndefined();
      expect(changedDate.values[sectionKey("confirmRemovals", accountId)]).toBeUndefined();
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
    "redraws a date-only change that crosses a recorded baseline before accepting confirmations",
    withDatabase(async (ctx) => {
      const { draftId, accountId, account, instrument } = await stageDraft(ctx, {
        resolved: true,
      });
      if (instrument === null) throw new Error("The resolved fixture did not seed its instrument.");
      const earlier = await ctx.seedPositionSet({
        account,
        asOf: "2026-03-31",
        holdings: [{ instrument, quantity: "1" }],
      });
      const current = await ctx.seedPositionSet({
        account,
        asOf: "2026-07-31",
        holdings: [{ instrument, quantity: "2" }],
      });
      const reviewed = await reviewPage(draftId);
      expect(onlySection(reviewed.diff).baselineSetId).toBe(current.id);

      const refusal = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            asOf: AS_OF,
            accountId,
            [sectionKey("baselineSetId", accountId)]: onlySection(reviewed.diff).baselineSetId ?? "",
            reviewRevision: reviewed.diff.reviewRevision ?? "",
            reviewedAsOf: reviewed.diff.asOfInput,
            [sectionKey("confirmFiledBehind", accountId)]: "true",
            [sectionKey("confirmRemovals", accountId)]: "true",
          }),
          { draftId },
        ),
      );
      if (refusal instanceof Response) throw new Error("Expected the redrawn review.");
      expect(refusal.formError).toContain("different statement date");
      expect(refusal.formError).not.toContain("statement or its account changed");
      expect(onlySection(refusal.diff).baselineSetId).toBe(earlier.id);
      expect(onlySection(refusal.diff).filedBehind).toEqual({
        asOf: AS_OF,
        currentAsOf: "2026-07-31",
      });
      expect(refusal.values[sectionKey("confirmFiledBehind", accountId)]).toBeUndefined();
      expect(refusal.values[sectionKey("confirmRemovals", accountId)]).toBeUndefined();
      expect(refusal.confirmationReset).toBeTypeOf("string");
      expect((await lastRecorded(accountId, ctx.db))?.id).toBe(current.id);
      await expect(requireDraft(draftId, ctx.db)).resolves.toMatchObject({ id: draftId });
      expect(
        await ctx.db
          .selectFrom("position_set")
          .select("id")
          .where("account_id", "=", accountId)
          .where("as_of_date", "=", AS_OF)
          .execute(),
      ).toHaveLength(0);

      const destination = await redirectTo(() =>
        reviewAction(
          args(
            post(`/upload/${draftId}/review`, {
              asOf: AS_OF,
              accountId,
              [sectionKey("baselineSetId", accountId)]: onlySection(refusal.diff).baselineSetId ?? "",
              reviewRevision: refusal.diff?.reviewRevision ?? "",
              reviewedAsOf: refusal.diff?.asOfInput ?? "",
              [sectionKey("confirmFiledBehind", accountId)]: "true",
            }),
            { draftId },
          ),
        ),
      );
      expect(destination).toMatch(new RegExp(`^/accounts/${accountId}\\?uploaded=\\d+$`));
      expect((await lastRecorded(accountId, ctx.db))?.id).toBe(current.id);
      await expect(requireDraft(draftId, ctx.db)).rejects.toThrow();
    }),
  );

  it(
    "keeps the stale warning when a baseline-crossing date change also changes the mapping",
    withDatabase(async (ctx) => {
      const { draftId, accountId, account, instrument } = await stageDraft(ctx, {
        resolved: true,
      });
      if (instrument === null) throw new Error("The resolved fixture did not seed its instrument.");
      const earlier = await ctx.seedPositionSet({
        account,
        asOf: "2026-03-31",
        holdings: [{ instrument, quantity: "1" }],
      });
      const current = await ctx.seedPositionSet({
        account,
        asOf: "2026-07-31",
        holdings: [{ instrument, quantity: "2" }],
      });
      const reviewed = await reviewPage(draftId);
      expect(onlySection(reviewed.diff).baselineSetId).toBe(current.id);

      const changed = await rememberMapping(
        draftId,
        {
          ...MAPPING,
          columns: { instrument: "Symbol", quantity: "Basis" },
        },
        ctx.db,
      );
      expect(changed).toEqual({ nextStep: "review" });

      const refusal = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            asOf: AS_OF,
            accountId,
            [sectionKey("baselineSetId", accountId)]: onlySection(reviewed.diff).baselineSetId ?? "",
            reviewRevision: reviewed.diff.reviewRevision ?? "",
            reviewedAsOf: reviewed.diff.asOfInput,
            [sectionKey("confirmFiledBehind", accountId)]: "true",
            [sectionKey("confirmRemovals", accountId)]: "true",
          }),
          { draftId },
        ),
      );
      if (refusal instanceof Response) throw new Error("Expected the current stale review.");
      expect(refusal.formError).toContain("This statement or its account changed after this review");
      expect(refusal.formError).not.toContain("different statement date");
      expect(onlySection(refusal.diff).baselineSetId).toBe(earlier.id);
      expect(onlySection(refusal.diff).updated[0]?.quantityAfter).toBe("40");
      expect(refusal.values[sectionKey("confirmFiledBehind", accountId)]).toBeUndefined();
      expect(refusal.values[sectionKey("confirmRemovals", accountId)]).toBeUndefined();
      expect(refusal.confirmationReset).toBeTypeOf("string");
      expect((await lastRecorded(accountId, ctx.db))?.id).toBe(current.id);
      await expect(requireDraft(draftId, ctx.db)).resolves.toMatchObject({ id: draftId });
      expect(
        await ctx.db
          .selectFrom("position_set")
          .select("id")
          .where("account_id", "=", accountId)
          .where("as_of_date", "=", AS_OF)
          .execute(),
      ).toHaveLength(0);
    }),
  );

  it(
    "keeps the stale warning when an interval statement lands before the newly selected date",
    withDatabase(async (ctx) => {
      const { draftId, accountId, account, instrument } = await stageDraft(ctx, {
        resolved: true,
      });
      if (instrument === null) throw new Error("The resolved fixture did not seed its instrument.");
      const march = await ctx.seedPositionSet({
        account,
        asOf: "2026-03-31",
        holdings: [{ instrument, quantity: "3" }],
      });
      const september = await ctx.seedPositionSet({
        account,
        asOf: "2026-09-01",
        holdings: [{ instrument, quantity: "9" }],
      });
      const reviewed = await reviewPage(draftId, "?asOf=2026-06-30");
      expect(onlySection(reviewed.diff).baselineSetId).toBe(march.id);
      expect(onlySection(reviewed.diff).filedBehind?.currentAsOf).toBe("2026-09-01");

      const july = await ctx.seedPositionSet({
        account,
        asOf: "2026-07-31",
        holdings: [{ instrument, quantity: "7" }],
      });

      const refusal = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            asOf: "2026-08-31",
            accountId,
            [sectionKey("baselineSetId", accountId)]: onlySection(reviewed.diff).baselineSetId ?? "",
            reviewRevision: reviewed.diff.reviewRevision ?? "",
            reviewedAsOf: reviewed.diff.asOfInput,
            [sectionKey("confirmFiledBehind", accountId)]: "true",
            [sectionKey("confirmRemovals", accountId)]: "true",
          }),
          { draftId },
        ),
      );
      if (refusal instanceof Response) throw new Error("Expected the current stale review.");
      expect(refusal.formError).toContain("This statement or its account changed after this review");
      expect(refusal.formError).not.toContain("different statement date");
      expect(onlySection(refusal.diff).baselineSetId).toBe(july.id);
      expect(onlySection(refusal.diff).updated[0]).toMatchObject({
        quantityBefore: "7.00000000",
        quantityAfter: "100",
      });
      expect(onlySection(refusal.diff).filedBehind).toEqual({
        asOf: "2026-08-31",
        currentAsOf: "2026-09-01",
      });
      expect(refusal.values[sectionKey("confirmFiledBehind", accountId)]).toBeUndefined();
      expect(refusal.values[sectionKey("confirmRemovals", accountId)]).toBeUndefined();
      expect(refusal.confirmationReset).toBeTypeOf("string");
      expect((await lastRecorded(accountId, ctx.db))?.id).toBe(september.id);
      await expect(requireDraft(draftId, ctx.db)).resolves.toMatchObject({ id: draftId });
      expect(
        await ctx.db
          .selectFrom("position_set")
          .select("id")
          .where("account_id", "=", accountId)
          .where("as_of_date", "=", "2026-08-31")
          .execute(),
      ).toHaveLength(0);
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
            [sectionKey("baselineSetId", account.id)]: onlySection(bareReview.diff).baselineSetId ?? "",
            [sectionKey("confirmRemovals", account.id)]: "true",
            reviewRevision: bareReview.diff.reviewRevision ?? "",
          }),
          { draftId },
        ),
      );
      if (datedRefusal instanceof Response) throw new Error("Expected the dated refusal.");
      if (datedRefusal.diff === null) throw new Error("Expected its freshly dated diff.");
      expect(datedRefusal.diff.asOf).toEqual({ source: "asked", date: AS_OF });
      expect(onlySection(datedRefusal.diff).filedBehind).not.toBeNull();
      expect(onlySection(datedRefusal.diff).majorityRemoved).toBe(true);

      const validation = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            asOf: AS_OF,
            accountId: "0",
            [sectionKey("baselineSetId", account.id)]: onlySection(datedRefusal.diff).baselineSetId ?? "",
            [sectionKey("confirmFiledBehind", account.id)]: "true",
            [sectionKey("confirmRemovals", account.id)]: "true",
            reviewRevision: datedRefusal.diff.reviewRevision ?? "",
          }),
          { draftId },
        ),
      );
      if (validation instanceof Response) throw new Error("Expected validation data.");
      expect(validation.diff?.asOf).toEqual({ source: "asked", date: AS_OF });
      expect(onlySection(validation.diff).filedBehind).not.toBeNull();
      expect(onlySection(validation.diff).majorityRemoved).toBe(true);
      expect(validation.values[sectionKey("confirmFiledBehind", account.id)]).toBeUndefined();
      expect(validation.values[sectionKey("confirmRemovals", account.id)]).toBeUndefined();

      const markup = renderRoute(Review, `/upload/${draftId}/review`, bareReview, {
        actionData: validation,
      });
      expect(markup).toContain(`value="${AS_OF}"`);
      expect(markup).toContain(`name="${sectionKey("confirmFiledBehind", account.id)}"`);
      expect(markup).not.toMatch(
        new RegExp(`name="${sectionKey("confirmFiledBehind", account.id)}"[^>]*checked`),
      );
      expect(markup).toContain(`name="${sectionKey("confirmRemovals", account.id)}"`);
      expect(markup).not.toMatch(
        new RegExp(`name="${sectionKey("confirmRemovals", account.id)}"[^>]*checked`),
      );
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
      expect(onlySection(reviewed.diff).majorityRemoved).toBe(true);
      expect(onlySection(reviewed.diff).filedBehind).not.toBeNull();
      const validation = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            asOf: AS_OF,
            accountId: "999999",
            [sectionKey("baselineSetId", account.id)]: onlySection(reviewed.diff).baselineSetId ?? "",
            [sectionKey("confirmFiledBehind", account.id)]: "true",
            [sectionKey("confirmRemovals", account.id)]: "true",
            reviewRevision: reviewed.diff.reviewRevision ?? "",
          }),
          { draftId },
        ),
      );
      if (validation instanceof Response)
        throw new Error("Expected validation data, not a redirect.");
      expect(validation.values[sectionKey("confirmFiledBehind", account.id)]).toBeUndefined();
      expect(validation.values[sectionKey("confirmRemovals", account.id)]).toBeUndefined();
      const repeated = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            asOf: AS_OF,
            accountId: "999999",
            [sectionKey("baselineSetId", account.id)]: onlySection(reviewed.diff).baselineSetId ?? "",
            [sectionKey("confirmFiledBehind", account.id)]: "true",
            [sectionKey("confirmRemovals", account.id)]: "true",
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
      expect(validationMarkup).toContain(`name="${sectionKey("confirmFiledBehind", account.id)}"`);
      expect(validationMarkup).not.toMatch(
        new RegExp(`name="${sectionKey("confirmFiledBehind", account.id)}"[^>]*checked`),
      );
      expect(validationMarkup).toContain(`name="${sectionKey("confirmRemovals", account.id)}"`);
      expect(validationMarkup).not.toMatch(
        new RegExp(`name="${sectionKey("confirmRemovals", account.id)}"[^>]*checked`),
      );

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
            [sectionKey("baselineSetId", account.id)]: onlySection(reviewed.diff).baselineSetId ?? "",
            [sectionKey("confirmFiledBehind", account.id)]: "true",
            [sectionKey("confirmRemovals", account.id)]: "true",
            reviewRevision: reviewed.diff.reviewRevision ?? "",
          }),
          { draftId },
        ),
      );
      if (staleRefusal instanceof Response)
        throw new Error("Expected the current review, not a redirect.");
      expect(staleRefusal.values[sectionKey("confirmFiledBehind", account.id)]).toBeUndefined();
      expect(staleRefusal.values[sectionKey("confirmRemovals", account.id)]).toBeUndefined();
      const staleMarkup = renderRoute(
        Review,
        `/upload/${draftId}/review?asOf=${AS_OF}`,
        reviewed,
        { actionData: staleRefusal },
      );
      expect(staleMarkup).toContain(`name="${sectionKey("confirmFiledBehind", account.id)}"`);
      expect(staleMarkup).not.toMatch(
        new RegExp(`name="${sectionKey("confirmFiledBehind", account.id)}"[^>]*checked`),
      );
      expect(staleMarkup).toContain(`name="${sectionKey("confirmRemovals", account.id)}"`);
      expect(staleMarkup).not.toMatch(
        new RegExp(`name="${sectionKey("confirmRemovals", account.id)}"[^>]*checked`),
      );

      const refreshed = await reviewPage(draftId, `?asOf=${AS_OF}`);
      const staleValidation = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            asOf: AS_OF,
            accountId: "999999",
            [sectionKey("baselineSetId", account.id)]: onlySection(refreshed.diff).baselineSetId ?? "",
            [sectionKey("confirmFiledBehind", account.id)]: "true",
            [sectionKey("confirmRemovals", account.id)]: "true",
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
      expect(refusedStaleMarkup).not.toMatch(
        new RegExp(`name="${sectionKey("confirmFiledBehind", account.id)}"[^>]*checked`),
      );
      expect(refusedStaleMarkup).not.toMatch(
        new RegExp(`name="${sectionKey("confirmRemovals", account.id)}"[^>]*checked`),
      );
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
                [sectionKey("confirmRemovals", account.id)]: "true",
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

// Spec 0023 "Routing": every step after columns reads the router's groups, re-run on each read,
// so where a multi-account draft resumes, and what blocks it, follows from the accounts as they are.
describe("a multi-account draft routed by account number", () => {
  const spreadsheet = () =>
    readFileSync(
      fileURLToPath(new URL("../fixtures/statements/multi-account.csv", import.meta.url)),
    );

  /** Columns as the screen posts them for multi-account.csv. */
  function mapColumns(draftId: string) {
    return redirectTo(() =>
      columnsAction(
        args(
          post(`/upload/${draftId}/columns`, {
            headerRow: "0",
            instrument: "Holding",
            name: "Description",
            quantity: "Quantity",
            costBasis: "Cost Basis",
            asOf: "As Of",
            accountNumber: "Account Number",
            costBasisIs: "per_share",
          }),
          { draftId },
        ),
      ),
    );
  }

  /** The three open accounts the file names, each recording its number, in ascending id. */
  async function seedAccounts(ctx: Pick<TestContext, "seedAccount">) {
    return [
      await ctx.seedAccount({ name: "Individual brokerage", externalAccountNumber: "Z12-345678" }),
      await ctx.seedAccount({ name: "Roth IRA", kind: "ira", externalAccountNumber: "Z98-765432" }),
      await ctx.seedAccount({
        name: "Home mortgage",
        kind: "liability",
        externalAccountNumber: "0045501234",
      }),
    ] as const;
  }

  async function resolveEveryString(
    ctx: Pick<TestContext, "seedInstrument" | "seedInstrumentAlias">,
  ) {
    const resolve = async (rawString: string) => {
      const instrument = await ctx.seedInstrument({ name: rawString });
      await ctx.seedInstrumentAlias({ instrument, rawString });
      return instrument;
    };
    return {
      vti: await resolve("VTI"),
      aapl: await resolve("AAPL"),
      fxaix: await resolve("FXAIX"),
      loan: await resolve("Home mortgage"),
    };
  }

  it(
    "resumes at instruments while a string is new, asking once per string with its units summed across accounts, and carries each account's group",
    withDatabase(async (ctx) => {
      const [individual, roth, mortgage] = await seedAccounts(ctx);
      const draft = await ctx.seedUploadDraft({ account: null, bytes: spreadsheet() });

      expect(await mapColumns(draft.id)).toBe(`/upload/${draft.id}/instruments`);
      expect(
        await redirectTo(() =>
          resumeDraft(args(get(`/upload/${draft.id}`), { draftId: draft.id })),
        ),
      ).toBe(`/upload/${draft.id}/instruments`);

      const page = await instrumentsLoader(
        args(get(`/upload/${draft.id}/instruments`), { draftId: draft.id }),
      );
      if (page instanceof Response) throw new Error(`Expected Instruments, got ${page.status}.`);
      // VTI is 120 in one account and 40.5 in another: one question, all 160.5 units.
      expect(page.screen.unresolved.map((item) => [item.raw, item.quantity])).toEqual([
        ["VTI", "160.50000000"],
        ["AAPL", "50.000"],
        ["FXAIX", "84.512"],
        ["Home mortgage", "312450.00"],
      ]);
      expect(renderRoute(Instruments, `/upload/${draft.id}/instruments`, page)).toContain(
        "Home mortgage",
      );

      const parsed = await parseDraft(await requireDraft(draft.id, ctx.db), ctx.db);
      if (parsed.step !== "instruments") throw new Error(`Expected instruments, got ${parsed.step}.`);
      expect(
        parsed.routed?.map((group) => [
          group.accountId,
          group.asOfDate,
          group.positions.map((position) => position.instrument),
        ]),
      ).toEqual([
        [individual.id, "2026-07-31", ["VTI", "AAPL"]],
        [roth.id, "2026-06-30", ["VTI", "FXAIX"]],
        [mortgage.id, "2026-07-15", ["Home mortgage"]],
      ]);
    }),
  );

  it(
    "sends a fully resolved file on to review, which draws a section per account, while a single-account draft carries no groups",
    withDatabase(async (ctx) => {
      const [individual, roth, mortgage] = await seedAccounts(ctx);
      await resolveEveryString(ctx);
      const draft = await ctx.seedUploadDraft({ account: null, bytes: spreadsheet() });

      expect(await mapColumns(draft.id)).toBe(`/upload/${draft.id}/review`);
      expect(
        await redirectTo(() =>
          resumeDraft(args(get(`/upload/${draft.id}`), { draftId: draft.id })),
        ),
      ).toBe(`/upload/${draft.id}/review`);

      const page = await reviewPage(draft.id);
      expect(page.diff.accounts.map((section) => section.accountId)).toEqual([
        individual.id,
        roth.id,
        mortgage.id,
      ]);
      const markup = renderRoute(Review, `/upload/${draft.id}/review`, page);
      expect(markup).toContain("What this file changes");
      expect(markup).toContain("3 ACCOUNTS");
      for (const account of [individual, roth, mortgage]) {
        expect(markup).toContain(account.name);
        expect(markup).toContain(`name="baselineSetId-${account.id}"`);
      }
      expect(markup).toContain("The file dates this statement");
      expect(markup).toContain("Record these statements");

      const multi = await parseDraft(await requireDraft(draft.id, ctx.db), ctx.db);
      expect(multi.step).toBeNull();
      expect(multi.step === null ? multi.routed?.length : undefined).toBe(3);

      // VTI is aliased above, so this single-account draft resolves too.
      const { draftId } = await stageDraft(ctx, { resolved: false });
      const single = await parseDraft(await requireDraft(draftId, ctx.db), ctx.db);
      expect(single).toMatchObject({ step: null, routed: null });
    }),
  );

  it(
    "draws an account the file leaves unchanged as its unchanged count alone, with no empty table",
    withDatabase(async (ctx) => {
      const [, roth] = await seedAccounts(ctx);
      const { vti, fxaix } = await resolveEveryString(ctx);
      await ctx.seedPositionSet({
        account: roth,
        asOf: "2026-05-31",
        holdings: [
          { instrument: vti, quantity: "40.5", costBasisPerShare: "231.40" },
          { instrument: fxaix, quantity: "84.512", costBasisPerShare: "151.33" },
        ],
      });
      const draft = await ctx.seedUploadDraft({ account: null, bytes: spreadsheet() });
      await mapColumns(draft.id);

      const markup = renderRoute(Review, `/upload/${draft.id}/review`, await reviewPage(draft.id));
      const rothSection =
        markup.split(`aria-labelledby="account-${roth.id}"`)[1]?.split("</section>")[0] ?? "";

      // Named by its heading, owner and all: two accounts can share a name.
      expect(rothSection).toContain(`<h3 class="panel-title" id="account-${roth.id}">`);

      expect(rothSection).toContain("0 ADDED · 0 UPDATED · 0 REMOVED");
      expect(rothSection).toContain(
        '<span class="u-data">2</span> rows are unchanged and are not listed.',
      );
      expect(rothSection).not.toContain("<table");
      // The other two accounts' first statements still list what they add.
      expect(markup).toContain("<table");
    }),
  );

  it(
    "names a number skipped at the accounts step in review's intro, and nothing once it is given to an account",
    withDatabase(async (ctx) => {
      await ctx.seedAccount({ name: "Individual brokerage", externalAccountNumber: "Z12-345678" });
      await ctx.seedAccount({ name: "Roth IRA", kind: "ira", externalAccountNumber: "Z98-765432" });
      const mortgage = await ctx.seedAccount({ name: "Home mortgage", kind: "liability" });
      await resolveEveryString(ctx);
      const draft = await ctx.seedUploadDraft({ account: null, bytes: spreadsheet() });
      expect(await mapColumns(draft.id)).toBe(`/upload/${draft.id}/accounts`);
      const answer = (accountId: string) =>
        answerAccountNumbers(
          draft.id,
          { "number-0": "0045501234", "accountId-0": accountId },
          ctx.db,
        );

      await answer(SKIP_NUMBER);
      const skipped = await reviewPage(draft.id);
      expect(skipped.diff.skippedNumbers).toEqual(["0045501234"]);
      expect(renderRoute(Review, `/upload/${draft.id}/review`, skipped)).toContain(
        'The rows of account number <span class="u-data">0045501234</span> were skipped at the ' +
          "accounts step, so they are not recorded.",
      );

      await answer(mortgage.id);
      const given = await reviewPage(draft.id);
      expect(given.diff.skippedNumbers).toEqual([]);
      const markup = renderRoute(Review, `/upload/${draft.id}/review`, given);
      expect(markup).toContain("3 ACCOUNTS");
      expect(markup).not.toContain("were skipped at the accounts step");
    }),
  );

  it(
    "blocks review with the router's refusal once an account the file names closes after mapping, naming it on review and on columns",
    withDatabase(async (ctx) => {
      const [, , mortgage] = await seedAccounts(ctx);
      await resolveEveryString(ctx);
      const draft = await ctx.seedUploadDraft({ account: null, bytes: spreadsheet() });
      expect(await mapColumns(draft.id)).toBe(`/upload/${draft.id}/review`);

      await closeAccount(mortgage.id, { confirmClose: "true" }, ctx.db);
      const refusal = "is recorded on Home mortgage, which is closed";

      expect(
        await redirectTo(() =>
          resumeDraft(args(get(`/upload/${draft.id}`), { draftId: draft.id })),
        ),
      ).toBe(`/upload/${draft.id}/columns`);

      const page = await reviewOutcome(draft.id);
      if (page.diff !== null) throw new Error("A draft naming a closed account rendered a diff.");
      expect(page.blocked.accountId).toBeNull();
      const markup = renderRoute(Review, `/upload/${draft.id}/review`, page);
      expect(markup).toContain("This statement cannot be reviewed yet");
      expect(markup).toContain(refusal);
      expect(markup).toContain("several accounts");
      expect(markup).toContain("a column was chosen wrongly");
      expect(markup).not.toContain("instrument is missing from the source row");
      expect(markup).toContain('href="/upload"');

      const columns = await columnsLoader(
        args(get(`/upload/${draft.id}/columns`), { draftId: draft.id }),
      );
      expect(columns.savedProblems).toEqual([expect.stringContaining(refusal)]);
      expect(columns.savedProblemFields).toEqual(["accountNumber"]);
    }),
  );

  it(
    "records a reviewed file from the review form and lands on the done page, one line per account",
    withDatabase(async (ctx) => {
      const [individual, roth, mortgage] = await seedAccounts(ctx);
      await resolveEveryString(ctx);
      const draft = await ctx.seedUploadDraft({ account: null, bytes: spreadsheet() });
      await mapColumns(draft.id);
      const page = await reviewPage(draft.id);

      const landing = await redirectTo(() =>
        reviewAction(
          args(
            post(`/upload/${draft.id}/review`, reviewedFields(page.diff)),
            { draftId: draft.id },
          ),
        ),
      );

      const sets = await Promise.all(
        [individual, roth, mortgage].map(
          async (account) => (await lastRecorded(account.id, ctx.db))?.id,
        ),
      );
      expect(landing).toBe(`/upload/done?sets=${sets.join(",")}`);

      const done = await doneLoader(args(get(landing)));
      expect(done.statements.map((statement) => statement.accountId)).toEqual([
        individual.id,
        roth.id,
        mortgage.id,
      ]);
      const markup = renderRoute(Done, landing, done);
      expect(markup).toContain(`href="/accounts/${roth.id}?uploaded=${sets[1]}"`);
      expect(markup).toContain("Roth IRA");
    }),
  );

  it(
    "re-renders a refused commit with every account's section and the refusal naming its account",
    withDatabase(async (ctx) => {
      const [, roth] = await seedAccounts(ctx);
      await resolveEveryString(ctx);
      const draft = await ctx.seedUploadDraft({ account: null, bytes: spreadsheet() });
      await mapColumns(draft.id);
      const page = await reviewPage(draft.id);

      const refused = await reviewAction(
        args(
          post(`/upload/${draft.id}/review`, {
            ...reviewedFields(page.diff),
            [sectionKey("baselineSetId", roth.id)]: "999999",
          }),
          { draftId: draft.id },
        ),
      );
      if (refused instanceof Response) throw new Error(`Expected a refusal, got ${refused.status}.`);

      expect(refused.formError).toMatch(/^Roth IRA: This statement was measured against figures/);
      expect(refused.diff.accounts).toHaveLength(3);
      const markup = renderRoute(Review, `/upload/${draft.id}/review`, page, {
        actionData: refused,
      });
      expect(markup).toContain("Roth IRA: This statement was measured against figures");
      expect(markup).toContain("Home mortgage");
    }),
  );

  it(
    "re-renders a commit refused over figures recorded since review, naming the account they landed on",
    withDatabase(async (ctx) => {
      const [, , mortgage] = await seedAccounts(ctx);
      const { loan } = await resolveEveryString(ctx);
      const draft = await ctx.seedUploadDraft({ account: null, bytes: spreadsheet() });
      await mapColumns(draft.id);
      const page = await reviewPage(draft.id);
      expect(renderRoute(Review, `/upload/${draft.id}/review`, page)).toContain(
        `name="appendWatermark-${mortgage.id}"`,
      );

      // After the file's 2026-07-15, so no baseline moves: only the account's history does.
      await ctx.seedPositionSet({
        account: mortgage,
        asOf: "2026-08-01",
        source: "manual",
        holdings: [{ instrument: loan, quantity: "300000" }],
      });

      const refused = await reviewAction(
        args(post(`/upload/${draft.id}/review`, reviewedFields(page.diff)), { draftId: draft.id }),
      );
      if (refused instanceof Response) throw new Error(`Expected a refusal, got ${refused.status}.`);

      const markup = renderRoute(Review, `/upload/${draft.id}/review`, page, {
        actionData: refused,
      });
      expect(markup).toContain("Figures were recorded on Home mortgage after this review.");
    }),
  );

  it(
    "sends a commit whose file lost a string after review back to instruments, marked stale",
    withDatabase(async (ctx) => {
      await seedAccounts(ctx);
      await resolveEveryString(ctx);
      const draft = await ctx.seedUploadDraft({ account: null, bytes: spreadsheet() });
      await mapColumns(draft.id);
      const page = await reviewPage(draft.id);

      const fxaix = await ctx.db
        .selectFrom("instrument_alias")
        .select("instrument_id")
        .where("raw_string", "=", "FXAIX")
        .executeTakeFirstOrThrow();
      await changeAlias(
        {
          intent: "forget",
          rawString: "FXAIX",
          fromInstrumentId: fxaix.instrument_id,
          confirm: "true",
        },
        ctx.db,
      );

      expect(
        await redirectTo(() =>
          reviewAction(
            args(post(`/upload/${draft.id}/review`, reviewedFields(page.diff)), { draftId: draft.id }),
          ),
        ),
      ).toBe(`/upload/${draft.id}/instruments?stale=true`);
    }),
  );
});
