/**
 * Where a half-finished upload resumes, and where a finished one refuses to
 * land a second time (ingest brief §2.1, §6.5, §7.4).
 *
 * The flow is four URLs and no client state, so "how far did this draft get"
 * has to be answerable from the row alone. `parseDraft` is that answer, and
 * these routes are its only readers: `/upload/:draftId` redirects to the step
 * it names, and review turns a step still owed into a bounce back to it —
 * from the loader for a bookmark, and from the action for a form that sat open
 * while the draft changed underneath it. `parseDraft` has no test of its own
 * anywhere; the matrix below is what pins it.
 *
 * Breaking any of this strands a reader rather than writing a wrong number: a
 * bookmarked review over a draft whose mapping no longer reads back would draw
 * a diff over nothing, and a resume that guessed "review" for a draft that
 * never passed columns would ask the household to confirm a statement no
 * mapping had parsed.
 *
 * The one write-shaped risk lives here too — the re-POST after a commit, which
 * must answer 404 rather than record the same statement twice, and must not
 * carry a forged account id back to the page that links to it. That page's own
 * `accountIdOf` is not exported, so it is pinned at the end that is: what the
 * action throws is what the boundary reads.
 */
import { afterAll, describe, expect, it } from "vitest";

import { z } from "zod";

import { loader as resumeDraft } from "../../app/routes/upload/index.tsx";
import { action as reviewAction, loader as reviewLoader } from "../../app/routes/upload/review.tsx";
import { lastRecorded } from "~/lib/balances.server";
import { rememberMapping } from "~/lib/uploads.server";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { args, get, post, redirectTo } from "../support/routes.ts";

import type { TestContext } from "../support/database.ts";
import type { StatementMapping } from "~/lib/statement";

afterAll(closeTestDatabase);

const encode = (text: string) => new TextEncoder().encode(text);

/** One position, and no column that dates the file — so review asks for a date. */
const CSV = ["Symbol,Quantity", "VTI,100"].join("\n");

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

type Staged = { draftId: string; accountId: string };

/**
 * A draft that has passed the columns step.
 *
 * `resolved` decides which side of the fork it lands on: with the file's one
 * string already aliased, `rememberMapping` records that this draft raised no
 * first sighting and sends it to review; without, the string is a first
 * sighting and the instruments step is owed. That bit is written once, at this
 * moment, and nothing afterwards can recover it — which is why the fixture has
 * to choose before the mapping is saved rather than after.
 */
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

  if (resolved) {
    const instrument = await ctx.seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock" });
    await ctx.seedInstrumentAlias({ instrument, rawString: "VTI" });
  }

  const outcome = await rememberMapping(draft.id, MAPPING, ctx.db);
  if ("problems" in outcome) {
    throw new Error("This fixture's mapping does not parse its own file.");
  }

  return { draftId: draft.id, accountId: account.id };
}

/** The review screen's own data, or a failure naming where it bounced instead. */
async function reviewPage(draftId: string) {
  const outcome = await reviewLoader(args(get(`/upload/${draftId}/review`), { draftId }));

  if (outcome instanceof Response) {
    throw new Error(
      `Expected the review screen, and the route sent the reader to ${outcome.headers.get(
        "Location",
      )}.`,
    );
  }
  return outcome;
}

/** The shape of `data({ accountId }, { status: 404 })` once it has been thrown. */
const expiredPage = z.object({
  init: z.object({ status: z.number() }),
  data: z.object({ accountId: z.string().nullable() }),
});

/**
 * The expired-page payload a review re-POST throws.
 *
 * `data()` produces neither a `Response` nor an `Error`, so `outcomeOf` would
 * rethrow it and `responseOf` would never see it. This is the one shape a test
 * has to unwrap for itself.
 */
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

  const destination = await redirectTo(() =>
    reviewAction(
      args(post(`/upload/${staged.draftId}/review`, { asOf: AS_OF, accountId: staged.accountId }), {
        draftId: staged.draftId,
      }),
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
      // The ordinary arrival: the drop screen has just staged the bytes and
      // redirected here, and nothing has been mapped yet.
      const account = await seedAccount({ kind: "brokerage" });
      const draft = await seedUploadDraft({ account, bytes: encode(CSV) });

      expect(
        await redirectTo(() => resumeDraft(args(get(`/upload/${draft.id}`), { draftId: draft.id }))),
      ).toBe(`/upload/${draft.id}/columns`);
    }),
  );

  it(
    "sends a mapped draft whose file still names an unknown instrument to the instruments step",
    withDatabase(async (ctx) => {
      // A laptop closed on the resolution screen and reopened from a bookmark
      // of the draft itself. The mapping is saved, so columns is behind it —
      // the unresolved string is what is still owed.
      const { draftId } = await stageDraft(ctx, { resolved: false });

      expect(
        await redirectTo(() => resumeDraft(args(get(`/upload/${draftId}`), { draftId }))),
      ).toBe(`/upload/${draftId}/instruments`);
    }),
  );

  it(
    "sends a file that raised no first sighting straight to review, with the strip saying so",
    withDatabase(async (ctx) => {
      // The second statement from a brokerage already mapped and already
      // resolved: the instruments step has nothing to ask, so it is not a
      // screen this reader ever stands on.
      const { draftId } = await stageDraft(ctx, { resolved: true });

      expect(
        await redirectTo(() => resumeDraft(args(get(`/upload/${draftId}`), { draftId }))),
      ).toBe(`/upload/${draftId}/review`);

      // Skipped, not merely passed. An alias does not say which draft wrote
      // it, so by the time review renders, the only record that this file
      // asked nothing is the bit the columns step wrote (brief §7.5).
      const page = await reviewPage(draftId);
      expect(page.steps).toMatchObject({ current: 4, instrumentsSkipped: true });
    }),
  );
});

describe("a review over a draft that is not ready for one", () => {
  it(
    "bounces to columns from the loader and the action alike when the stored mapping no longer reads back",
    withDatabase(async (ctx) => {
      const { draftId, accountId } = await stageDraft(ctx, { resolved: true });

      // Written straight onto the row on purpose: `rememberMapping` refuses to
      // store a mapping its own file cannot parse, so the only way a row like
      // this exists is a stored value that predates a rule or was edited by
      // hand — which is the case `parseDraft` guards and nothing else covers.
      await ctx.db
        .updateTable("upload_draft")
        .set({ mapping: JSON.stringify({ headerRow: 0, delimiter: "," }) })
        .where("id", "=", draftId)
        .execute();

      // The bookmark.
      expect(
        await redirectTo(() =>
          reviewLoader(args(get(`/upload/${draftId}/review`), { draftId })),
        ),
      ).toBe(`/upload/${draftId}/columns`);

      // And the form beneath it, which is the half that matters: a POST that
      // fell through to the commit would be recording a statement no mapping
      // had parsed.
      expect(
        await redirectTo(() =>
          reviewAction(
            args(post(`/upload/${draftId}/review`, { asOf: AS_OF, accountId }), { draftId }),
          ),
        ),
      ).toBe(`/upload/${draftId}/columns`);

      expect(await lastRecorded(accountId, ctx.db)).toBeNull();
    }),
  );
});

describe("a review re-posted after its statement landed", () => {
  it(
    "answers 404 without recording the same statement a second time",
    withDatabase(async (ctx) => {
      const { draftId, accountId } = await commitStaged(ctx);
      const recorded = await lastRecorded(accountId, ctx.db);

      // The back button after success, or a tab resubmitted from history. The
      // draft the commit deleted is the guard: there is nothing left to read a
      // second set out of.
      const refusal = await expiredPageOf(() =>
        reviewAction(
          args(post(`/upload/${draftId}/review`, { asOf: AS_OF, accountId }), { draftId }),
        ),
      );

      expect(refusal.init.status).toBe(404);
      // Same set still the account's latest — a second commit would have
      // outranked it and left the household reading a duplicate statement.
      expect(await lastRecorded(accountId, ctx.db)).toEqual(recorded);
    }),
  );

  it(
    "carries the posted account id back to the expired page only when it is one",
    withDatabase(async (ctx) => {
      const { draftId, accountId } = await commitStaged(ctx);

      const honest = await expiredPageOf(() =>
        reviewAction(
          args(post(`/upload/${draftId}/review`, { asOf: AS_OF, accountId }), { draftId }),
        ),
      );
      expect(honest.data.accountId).toBe(accountId);

      // The field arrives from a posted form and is read back into a link, so
      // the id is validated as one here rather than trusted for having been in
      // a hidden input a moment ago.
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
