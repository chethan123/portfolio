// Coverage beyond the three rewritten repro tests (#181): the four chronological orderings a
// statement's date can take against an account's history, the confirmation's binding to the
// baseline it was drawn against, and the one case that must never loop — a first statement.
import { afterAll, describe, expect, it } from "vitest";

import Review, {
  action as reviewAction,
  loader as reviewLoader,
} from "../../app/routes/upload/review.tsx";
import { lastRecorded } from "~/lib/balances.server";
import { sectionKey } from "~/lib/review-form";
import {
  RefusedUpload,
  StaleReviewError,
  diffForDraft,
  recordUpload,
  rememberMapping,
  reviewForDraft,
} from "~/lib/uploads.server";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { args, get, post } from "../support/routes.ts";
import { renderRoute } from "../support/render.tsx";
import { onlyRecorded, onlySection } from "../support/review.ts";

import type { StatementMapping } from "~/lib/statement";
import type { SeededAccount } from "../support/fixtures.ts";
import type { TestContext } from "../support/database.ts";

afterAll(closeTestDatabase);

const encode = (text: string) => new TextEncoder().encode(text);

const MAPPING: StatementMapping = {
  headerRow: 0,
  delimiter: ",",
  columns: { instrument: "Symbol", quantity: "Quantity", costBasis: "Basis" },
  costBasisIs: "per_share",
  owedAsPositive: false,
  combineDuplicateRows: true,
};

async function stage(
  { db, seedUploadDraft }: Pick<TestContext, "db" | "seedUploadDraft">,
  account: SeededAccount,
  csv: string,
): Promise<string> {
  const draft = await seedUploadDraft({ account, filename: "Statement.csv", bytes: encode(csv) });

  const outcome = await rememberMapping(draft.id, MAPPING, db);
  if ("problems" in outcome) {
    throw new Error(
      "This fixture's mapping does not parse its own file: " +
        outcome.problems.map((problem) => problem.message).join(" "),
    );
  }

  return draft.id;
}

async function revisionFor(draftId: string, asOf: string, db: TestContext["db"]): Promise<string> {
  return (await reviewForDraft(draftId, asOf, db)).reviewRevision ?? "";
}

describe("baseline resolution against an account's history", () => {
  it(
    "reads no baseline for a date before every existing set, and says so as filed behind",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "ORD", name: "Ordering Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "ORD" });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: fund, quantity: "100" }],
      });

      // The explicit unknown-mode domain read keeps the current-set view for callers that have no
      // review date. Review itself binds today or the chosen date before issuing a revision.
      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nORD,10,\n");
      const reviewRevision = await revisionFor(draftId, "2026-01-01", db);
      const undatedDiff = await diffForDraft(draftId, db);
      expect(onlySection(undatedDiff).firstStatement).toBe(false);
      expect(onlySection(undatedDiff).filedBehind).toBeNull();

      // Dated ahead of every set the account holds — the diff the commit actually acts on.
      const refusal = await refusalOf(() =>
        recordUpload(
          draftId,
          { accountId: account.id, asOf: "2026-01-01", reviewRevision },
          db,
        ),
      );
      const refusedSection = onlySection(refusal.diff);
      expect(refusedSection.baselineSetId).toBeNull();
      expect(refusedSection.firstStatement).toBe(true);
      expect(refusedSection.filedBehind).toEqual({ asOf: "2026-01-01", currentAsOf: "2026-06-30" });
    }),
  );

  it(
    "reads the set immediately before the upload's date when it sits between two statements",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "ORD", name: "Ordering Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "ORD" });
      const early = await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: fund, quantity: "100" }],
      });
      await seedPositionSet({
        account,
        asOf: "2026-09-09",
        holdings: [{ instrument: fund, quantity: "150" }],
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nORD,120,\n");
      const reviewRevision = await revisionFor(draftId, "2026-07-31", db);
      const refusal = await refusalOf(() =>
        recordUpload(
          draftId,
          { accountId: account.id, asOf: "2026-07-31", reviewRevision },
          db,
        ),
      );
      const refusedSection = onlySection(refusal.diff);
      expect(refusedSection.baselineSetId).toBe(early.id);
      expect(refusedSection.firstStatement).toBe(false);
      expect(refusedSection.filedBehind).toEqual({ asOf: "2026-07-31", currentAsOf: "2026-09-09" });
    }),
  );

  it(
    "resolves a same-date upload to the set already recorded for it, and lets the new one win the tie once committed",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "ORD", name: "Ordering Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "ORD" });
      // A past, explicit createdAt — never a future one: created_at must stay monotonic, or the
      // tie-break this test pins would not hold.
      const existing = await seedPositionSet({
        account,
        asOf: "2026-06-30",
        createdAt: new Date("2026-06-30T12:00:00Z"),
        holdings: [{ instrument: fund, quantity: "100" }],
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nORD,120,\n");
      const reviewRevision = await revisionFor(draftId, "2026-06-30", db);
      // The commit resolves the same date the file's own history already carries.
      const written = onlyRecorded(await recordUpload(
        draftId,
        {
          accountId: account.id,
          asOf: "2026-06-30",
          [sectionKey("baselineSetId", account.id)]: existing.id,
          reviewRevision,
        },
        db,
      ));
      expect(written.setId).not.toBe(existing.id);

      // The tie is broken in the new set's favour — it is what the account now reads.
      expect((await lastRecorded(account.id, db))?.id).toBe(written.setId);
    }),
  );

  it(
    "reads the account's own current set as the baseline for a date after every one recorded",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "ORD", name: "Ordering Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "ORD" });
      const existing = await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: fund, quantity: "100" }],
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nORD,130,\n");
      const reviewRevision = await revisionFor(draftId, "2026-09-15", db);
      // The 99% case: forward-dated (but not into the future recordedDate itself refuses), so no
      // filed-behind confirmation is asked for at all.
      const written = onlyRecorded(await recordUpload(
        draftId,
        {
          accountId: account.id,
          asOf: "2026-09-15",
          [sectionKey("baselineSetId", account.id)]: existing.id,
          reviewRevision,
        },
        db,
      ));
      expect(written.asOf).toBe("2026-09-15");
    }),
  );
});

describe("the confirmation binds to the baseline it was drawn against", () => {
  it(
    "redraws a changed date before accepting confirmation when it selects another baseline",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "ORD", name: "Ordering Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "ORD" });
      const early = await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: fund, quantity: "100" }],
      });
      await seedPositionSet({
        account,
        asOf: "2026-09-09",
        holdings: [{ instrument: fund, quantity: "150" }],
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nORD,120,\n");
      const reviewed = await reviewForDraft(draftId, "2026-07-31", db);
      const first = await refusalOf(() =>
        recordUpload(
          draftId,
          {
            accountId: account.id,
            asOf: "2026-07-31",
            reviewRevision: reviewed.reviewRevision ?? "",
          },
          db,
        ),
      );
      const firstSection = onlySection(first.diff);
      expect(firstSection.baselineSetId).toBe(early.id);

      // The reader edits the date to one after every statement recorded, but the browser still
      // carries the earlier refusal's hidden baselineSetId — nobody re-rendered in between.
      const second = await refusalOf(() =>
        recordUpload(
          draftId,
          {
            accountId: account.id,
            asOf: "2026-09-14",
            [sectionKey("baselineSetId", account.id)]: firstSection.baselineSetId ?? "",
            [sectionKey("confirmFiledBehind", account.id)]: "true",
            reviewRevision: first.diff.reviewRevision ?? "",
            reviewedAsOf: first.diff.asOfInput,
          },
          db,
        ),
      );
      // 2026-09-14 is after every statement recorded, so there is nothing to be filed behind. The
      // revision proof still identifies the date as the only change before baseline confirmations.
      const secondSection = onlySection(second.diff);
      expect(secondSection.filedBehind).toBeNull();
      expect(secondSection.baselineSetId).not.toBe(early.id);
      expect(second.fieldErrors.form).toMatch(/different statement date/);
      expect(second.fieldErrors.form).not.toMatch(/statement or its account changed/);

      const sets = await db
        .selectFrom("position_set")
        .select("id")
        .where("account_id", "=", account.id)
        .execute();
      expect(sets).toHaveLength(2); // exactly what was seeded — nothing landed either time
    }),
  );

  it(
    "keeps the stale warning when another writer moves the baseline after review",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "ORD", name: "Ordering Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "ORD" });
      const early = await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: fund, quantity: "100" }],
      });
      await seedPositionSet({
        account,
        asOf: "2026-09-09",
        holdings: [{ instrument: fund, quantity: "150" }],
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nORD,120,\n");
      const reviewed = await reviewForDraft(draftId, "2026-07-31", db);
      const first = await refusalOf(() =>
        recordUpload(
          draftId,
          {
            accountId: account.id,
            asOf: "2026-07-31",
            reviewRevision: reviewed.reviewRevision ?? "",
          },
          db,
        ),
      );
      const firstSection = onlySection(first.diff);
      expect(firstSection.baselineSetId).toBe(early.id);

      // A second tab lands a statement in the gap, between the refused baseline and the date this
      // draft is dated for — the true baseline for 2026-07-31 has moved without this form knowing.
      await seedPositionSet({
        account,
        asOf: "2026-07-15",
        holdings: [{ instrument: fund, quantity: "110" }],
      });

      const second = await refusalOf(() =>
        recordUpload(
          draftId,
          {
            accountId: account.id,
            asOf: "2026-07-31",
            [sectionKey("baselineSetId", account.id)]: firstSection.baselineSetId ?? "",
            [sectionKey("confirmFiledBehind", account.id)]: "true",
            reviewRevision: first.diff.reviewRevision ?? "",
          },
          db,
        ),
      );
      const secondSection = onlySection(second.diff);
      expect(secondSection.baselineSetId).not.toBe(early.id);
      // The revision mismatch takes precedence over the confirmation wording: the concurrent
      // write must not be presented as only another filed-behind acknowledgement.
      expect(secondSection.filedBehind).not.toBeNull();
      expect(second.fieldErrors.form).toMatch(/statement or its account changed/);
      expect(second.fieldErrors.form).not.toMatch(/confirm to file it behind/);

      const holdings = await db
        .selectFrom("holding")
        .innerJoin("position_set", "position_set.id", "holding.position_set_id")
        .select("holding.quantity")
        .where("position_set.account_id", "=", account.id)
        .where("position_set.as_of_date", "=", "2026-07-31")
        .execute();
      expect(holdings).toHaveLength(0); // the draft's own statement never landed
    }),
  );

  it(
    "names the true removal once a majority-removal tick given against the undated baseline is superseded by a typed date",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const alpha = await seedInstrument({ symbol: "ALPHA", name: "Alpha Fund" });
      const beta = await seedInstrument({ symbol: "BETA", name: "Beta Fund" });
      const gamma = await seedInstrument({ symbol: "GAMMA", name: "Gamma Fund" });
      const delta = await seedInstrument({ symbol: "DELTA", name: "Delta Fund" });
      const epsilon = await seedInstrument({ symbol: "EPSILON", name: "Epsilon Fund" });
      const zeta = await seedInstrument({ symbol: "ZETA", name: "Zeta Fund" });
      const eta = await seedInstrument({ symbol: "ETA", name: "Eta Fund" });
      await seedInstrumentAlias({ instrument: alpha, rawString: "ALPHA" });

      // The true baseline for a statement dated between these: 5 positions, of which the file
      // below keeps only one.
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [
          { instrument: alpha, quantity: "100" },
          { instrument: beta, quantity: "50" },
          { instrument: gamma, quantity: "20" },
          { instrument: delta, quantity: "10" },
          { instrument: epsilon, quantity: "5" },
        ],
      });
      // The account's current set: 3 positions, 2 of which the same file would also drop.
      await seedPositionSet({
        account,
        asOf: "2026-09-09",
        holdings: [
          { instrument: alpha, quantity: "150" },
          { instrument: zeta, quantity: "30" },
          { instrument: eta, quantity: "15" },
        ],
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nALPHA,120,\n");

      // Keep an explicitly unknown/current diff as the stale baseline fixture, while the reviewed
      // revision below is correctly bound to the typed date.
      const undated = await diffForDraft(draftId, db);
      const undatedSection = onlySection(undated);
      const reviewed = await reviewForDraft(draftId, "2026-07-31", db);
      expect(undatedSection.baselineSetId).not.toBeNull();
      expect(undatedSection.currentCount).toBe(3);
      expect(undatedSection.majorityRemoved).toBe(true);

      // Post that stale current baseline with the date-bound revision to isolate the baseline
      // confirmation guard from the broader revision check.
      const response = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            accountId: account.id,
            asOf: "2026-07-31",
            [sectionKey("baselineSetId", account.id)]: undatedSection.baselineSetId ?? "",
            [sectionKey("confirmRemovals", account.id)]: "true",
            reviewRevision: reviewed.reviewRevision ?? "",
          }),
          { draftId },
        ),
      );
      if (response instanceof Response) throw new Error("Expected data back, got a redirect.");
      if (response.diff === null) throw new Error("Expected data back, got a redirect.");

      // The dated diff is against 2026-06-30 (5 positions), not the undated one the tick answered
      // for — a tick given against the wrong baseline must not silence the real removal it never
      // actually confirmed.
      const responseSection = onlySection(response.diff);
      expect(responseSection.baselineSetId).not.toBe(undatedSection.baselineSetId);
      expect(responseSection.currentCount).toBe(5);
      expect(responseSection.removed).toHaveLength(4);
      expect(response.formError).toMatch(/removes 4 of the 5 positions recorded on 2026-06-30/);

      // The screen's own checkbox label computes this same "recorded on" scoping independently
      // (review.tsx's `removalScope`) — rendered, not merely echoed from the domain's formError
      // string, so a regression there would not be caught by the assertion above alone.
      const loaderData = await reviewLoader(args(get(`/upload/${draftId}/review`), { draftId }));
      if (loaderData instanceof Response) throw new Error("Expected the review screen, not a redirect.");
      const markup = renderRoute(Review, `/upload/${draftId}/review`, loaderData, {
        actionData: response,
      });
      // Scoped to the checkbox's own `<label>`, not the `.form-error` paragraph beside it — the
      // latter merely echoes the domain's message and would pass even if `removalScope` regressed
      // to the unconditional "this account holds".
      const checkboxStart = markup.indexOf(`name="${sectionKey("confirmRemovals", account.id)}"`);
      const label = markup.slice(checkboxStart, markup.indexOf("</label>", checkboxStart));
      expect(label).toContain("removes");
      expect(label).toContain("recorded on");
      expect(label).toContain("2026-06-30");
      expect(label).not.toContain("this account holds");
    }),
  );

  it(
    "renders neither confirmation ticked once the baseline it was given against has moved",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const alpha = await seedInstrument({ symbol: "ALPHA", name: "Alpha Fund" });
      const beta = await seedInstrument({ symbol: "BETA", name: "Beta Fund" });
      const gamma = await seedInstrument({ symbol: "GAMMA", name: "Gamma Fund" });
      await seedInstrumentAlias({ instrument: alpha, rawString: "ALPHA" });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [
          { instrument: alpha, quantity: "100" },
          { instrument: beta, quantity: "50" },
          { instrument: gamma, quantity: "20" },
        ],
      });
      await seedPositionSet({
        account,
        asOf: "2026-09-09",
        holdings: [{ instrument: alpha, quantity: "150" }],
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nALPHA,120,\n");
      const reviewed = await reviewForDraft(draftId, "2026-07-31", db);

      // First submit: both the filed-behind and majority-removal confirmations are demanded.
      const firstResponse = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            accountId: account.id,
            asOf: "2026-07-31",
            reviewRevision: reviewed.reviewRevision ?? "",
          }),
          { draftId },
        ),
      );
      if (firstResponse instanceof Response) throw new Error("Expected data back, got a redirect.");
      if (firstResponse.diff === null) throw new Error("Expected data back, got a redirect.");
      const firstSection = onlySection(firstResponse.diff);
      expect(firstSection.filedBehind).not.toBeNull();
      expect(firstSection.majorityRemoved).toBe(true);

      // Another tab lands a statement in the gap before the reader ticks and resubmits.
      await seedPositionSet({
        account,
        asOf: "2026-07-15",
        holdings: [{ instrument: alpha, quantity: "110" }],
      });

      // The reader ticks both boxes and resubmits — but against the baseline now superseded.
      const secondResponse = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            accountId: account.id,
            asOf: "2026-07-31",
            [sectionKey("baselineSetId", account.id)]: firstSection.baselineSetId ?? "",
            [sectionKey("confirmFiledBehind", account.id)]: "true",
            [sectionKey("confirmRemovals", account.id)]: "true",
            reviewRevision: firstResponse.diff?.reviewRevision ?? "",
          }),
          { draftId },
        ),
      );
      if (secondResponse instanceof Response) throw new Error("Expected data back, got a redirect.");

      const loaderData = await reviewLoader(args(get(`/upload/${draftId}/review`), { draftId }));
      if (loaderData instanceof Response) throw new Error("Expected the review screen, not a redirect.");

      const markup = renderRoute(Review, `/upload/${draftId}/review`, loaderData, {
        actionData: secondResponse,
      });
      // Both boxes still render — proving the checkbox is unticked, not gone.
      expect(markup).toContain(`name="${sectionKey("confirmFiledBehind", account.id)}"`);
      expect(markup).not.toContain("checked");

      // The screen half of the copy #181 also rewrote (uploads.server.ts's matching sentences are
      // pinned above; only the render was dark): the frame names the baseline's own date, not
      // "holds now".
      expect(markup).toContain("Compared against what");
      expect(markup).toContain("held on");
      expect(markup).toContain(secondResponse.diff?.asOf.date);
      expect(markup).not.toMatch(/Compared against what [^.]+ holds now/);
    }),
  );

  it(
    "renders 'nothing was recorded on or before' rather than 'the first statement' for a date before all history",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "ORD", name: "Ordering Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "ORD" });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: fund, quantity: "100" }],
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nORD,10,\n");
      const reviewed = await reviewForDraft(draftId, "2026-01-01", db);

      const response = await reviewAction(
        args(
          post(`/upload/${draftId}/review`, {
            accountId: account.id,
            asOf: "2026-01-01",
            reviewRevision: reviewed.reviewRevision ?? "",
          }),
          { draftId },
        ),
      );
      if (response instanceof Response) throw new Error("Expected data back, got a redirect.");
      if (response.diff === null) throw new Error("Expected data back, got a redirect.");
      const responseSection = onlySection(response.diff);
      expect(responseSection.firstStatement).toBe(true);
      expect(responseSection.filedBehind).not.toBeNull();

      const loaderData = await reviewLoader(args(get(`/upload/${draftId}/review`), { draftId }));
      if (loaderData instanceof Response) throw new Error("Expected the review screen, not a redirect.");

      const markup = renderRoute(Review, `/upload/${draftId}/review`, loaderData, {
        actionData: response,
      });
      // Wrong prose for a date before all history: it is not the account's first statement, only
      // the first on or before this one. The conditional sentence must have won, not the
      // unconditional one it replaces on a genuine baseline-less account.
      expect(markup).toContain("Nothing was recorded for");
      expect(markup).toContain("on or before");
      expect(markup).not.toContain("This is the first statement recorded for");
    }),
  );
});

describe("a refusal always carries a sentence", () => {
  it(
    "names a stale review for a forward-dated resubmit after a concurrent writer landed",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "ORD", name: "Ordering Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "ORD" });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: fund, quantity: "100" }],
      });

      // The explicit unknown-mode view supplies the old current baseline for this guard test.
      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nORD,100,\n");
      const undated = await diffForDraft(draftId, db);
      const undatedSection = onlySection(undated);
      const reviewed = await reviewForDraft(draftId, "2026-09-14", db);
      expect(undatedSection.majorityRemoved).toBe(false);

      // Another tab lands a set after the dated review was assembled.
      await seedPositionSet({
        account,
        asOf: "2026-09-10",
        holdings: [{ instrument: fund, quantity: "100" }],
      });

      // A forward date, later than the concurrent set — neither filed behind nor a majority
      // removal. The current revision now includes the concurrent set, so that mismatch takes
      // precedence over the stale-baseline confirmation evidence.
      const refusal = await refusalOf(() =>
        recordUpload(
          draftId,
          {
            accountId: account.id,
            asOf: "2026-09-14",
            [sectionKey("baselineSetId", account.id)]: undatedSection.baselineSetId ?? "",
            reviewRevision: reviewed.reviewRevision ?? "",
          },
          db,
        ),
      );
      const refusedSection = onlySection(refusal.diff);
      expect(refusedSection.filedBehind).toBeNull();
      expect(refusedSection.majorityRemoved).toBe(false);
      expect(refusal.fieldErrors.form).not.toBe("");
      expect(refusal.fieldErrors.form).toMatch(/statement or its account changed/);

      // A current revision paired with the old baseline is forged or mixed form evidence rather
      // than a stale review. The revision guard passes, leaving the baseline confirmation guard to
      // name exactly what moved instead of allowing the mismatched hidden field through.
      const currentReview = await reviewForDraft(draftId, "2026-09-14", db);
      const baselineOnly = await refusalOf(() =>
        recordUpload(
          draftId,
          {
            accountId: account.id,
            asOf: "2026-09-14",
            [sectionKey("baselineSetId", account.id)]: undatedSection.baselineSetId ?? "",
            reviewRevision: currentReview.reviewRevision ?? "",
            reviewedAsOf: currentReview.asOfInput,
          },
          db,
        ),
      );
      expect(baselineOnly).toBeInstanceOf(RefusedUpload);
      expect(baselineOnly.fieldErrors.form).toMatch(/2026-09-10/);
      expect(baselineOnly.fieldErrors.form).not.toMatch(/statement or its account changed/);

      const sets = await db
        .selectFrom("position_set")
        .select("id")
        .where("account_id", "=", account.id)
        .execute();
      expect(sets).toHaveLength(2); // exactly what was seeded — the resubmit never landed
    }),
  );
});

describe("a first statement", () => {
  it(
    "commits once, with baselineSetId posted as the empty string, and no refusal loop",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "NEW", name: "New Account Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "NEW" });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nNEW,10,\n");
      const reviewRevision = await revisionFor(draftId, "2026-06-30", db);
      const written = onlyRecorded(await recordUpload(
        draftId,
        {
          accountId: account.id,
          asOf: "2026-06-30",
          [sectionKey("baselineSetId", account.id)]: "",
          reviewRevision,
        },
        db,
      ));
      expect(written.counts).toEqual({ added: 1, updated: 0, unchanged: 0, removed: 0 });

      const sets = await db
        .selectFrom("position_set")
        .select("id")
        .where("account_id", "=", account.id)
        .execute();
      expect(sets).toHaveLength(1); // one submit, one set — no round trip was needed
    }),
  );
});

describe("a removed row against a dated baseline", () => {
  it(
    "is priced from the current quote, never the dated read's own historical close, and null with no quote at all",
    withDatabase(async (ctx) => {
      const {
        db,
        seedAccount,
        seedInstrument,
        seedInstrumentAlias,
        seedPositionSet,
        seedQuote,
        seedDailyClose,
      } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const kept = await seedInstrument({ symbol: "KPT", name: "Kept Fund" });
      const priced = await seedInstrument({ symbol: "HST", name: "Historically Priced Fund" });
      const unpriced = await seedInstrument({ symbol: "NVR", name: "Never Priced Fund" });
      await seedInstrumentAlias({ instrument: kept, rawString: "KPT" });

      // The historical close on the baseline's own date disagrees with today's quote — the
      // removed row must use the quote, exactly as an added or updated row would (#181).
      await seedQuote({ instrument: priced, price: "50.00" });
      await seedDailyClose({ instrument: priced, date: "2026-06-30", close: "40.00" });

      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [
          { instrument: kept, quantity: "5" },
          { instrument: priced, quantity: "10" },
          { instrument: unpriced, quantity: "3" },
        ],
      });
      await seedPositionSet({
        account,
        asOf: "2026-09-09",
        holdings: [{ instrument: kept, quantity: "5" }],
      });

      // Dated between the two, so the baseline is the 2026-06-30 set — priced and unpriced are
      // both removed against it.
      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nKPT,5,\n");
      const reviewRevision = await revisionFor(draftId, "2026-07-31", db);
      const refusal = await refusalOf(() =>
        recordUpload(
          draftId,
          { accountId: account.id, asOf: "2026-07-31", reviewRevision },
          db,
        ),
      );

      const removed = new Map(
        onlySection(refusal.diff).removed.map((row) => [row.instrumentId, row]),
      );
      // 50.00 x 10, the current quote — never 40.00 x 10, the close on the statement's own date.
      expect(removed.get(priced.id)?.value).toBe("500.0000");
      // No quote at all does not throw; it renders the same "never priced" null every other
      // unpriced row does.
      expect(removed.get(unpriced.id)?.value).toBeNull();
    }),
  );
});

/** The upload refusal a call produced, or a failure if it did not carry a current diff. */
async function refusalOf(
  run: () => Promise<unknown>,
): Promise<RefusedUpload | StaleReviewError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof RefusedUpload || error instanceof StaleReviewError) return error;
    throw error;
  }
  throw new Error("Expected the write to be refused with a diff attached, and it was not.");
}
