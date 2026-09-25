// The one review revision (spec 0024 §3): every field it binds, moved by an ordinary write between
// Review and commit, refuses the commit as stale and records nothing. Plus the one assembler both
// kinds of draft share, and the posted-form decision it kept (§4 b). Real Postgres.
import { afterAll, describe, expect, it } from "vitest";

import { getAccount, updateAccount } from "~/lib/accounts.server";
import { lastRecorded } from "~/lib/balances.server";
import { changeAlias } from "~/lib/instrument-aliases.server";
import { sectionKey } from "~/lib/review-form";
import {
  RefusedUpload,
  StaleReviewError,
  answerAccountNumbers,
  recordUpload,
  rememberMapping,
  requireDraft,
  reviewForDraft,
  type CommitInput,
} from "~/lib/uploads.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";
import { restateDraft } from "./support/fixtures.ts";
import { refusalOf } from "./support/refusal.ts";
import { onlySection, posted, reviewAndRecord } from "./support/review.ts";

import type { StatementMapping } from "~/lib/statement";
import type { TestContext } from "./support/database.ts";
import type { SeededAccount } from "./support/fixtures.ts";

afterAll(closeTestDatabase);

const encode = (text: string) => new TextEncoder().encode(text);

const DATE = "2026-06-30";
const FILENAME = "Positions.csv";

const CHOSEN: StatementMapping = {
  headerRow: 0,
  delimiter: ",",
  columns: { instrument: "Symbol", quantity: "Quantity", costBasis: "Basis" },
  costBasisIs: "per_share",
  owedAsPositive: false,
  combineDuplicateRows: true,
};

const SEVERAL: StatementMapping = {
  headerRow: 0,
  delimiter: ",",
  columns: { instrument: "Symbol", quantity: "Qty", costBasis: "Basis", accountNumber: "Account" },
  costBasisIs: "per_share",
  owedAsPositive: true,
  combineDuplicateRows: true,
  multiAccount: true,
};

/** A draft past its columns step, through the Columns save. */
async function stage(
  { db, seedUploadDraft }: Pick<TestContext, "db" | "seedUploadDraft">,
  account: SeededAccount | null,
  bytes: Uint8Array,
  mapping: StatementMapping,
  filename = FILENAME,
): Promise<string> {
  const draft = await seedUploadDraft({ account, filename, bytes });
  const outcome = await rememberMapping(draft.id, mapping, db);
  if ("problems" in outcome) {
    throw new Error(outcome.problems.map((problem) => problem.message).join(" "));
  }
  return draft.id;
}

async function seedAliased(
  ctx: Pick<TestContext, "seedInstrument" | "seedInstrumentAlias">,
  rawString: string,
) {
  const instrument = await ctx.seedInstrument({ symbol: rawString, name: rawString });
  await ctx.seedInstrumentAlias({ instrument, rawString });
  return instrument;
}

/** Commits `form`, expects a stale refusal, and that the draft's accounts recorded nothing. */
async function expectStale(
  db: TestContext["db"],
  draftId: string,
  form: CommitInput,
  accountIds: readonly string[],
): Promise<StaleReviewError> {
  const before = await Promise.all(accountIds.map((accountId) => lastRecorded(accountId, db)));
  const refusal = await refusalOf(() => recordUpload(draftId, form, db));
  expect(refusal).toBeInstanceOf(StaleReviewError);
  if (!(refusal instanceof StaleReviewError)) throw new Error("Expected a stale review.");
  const after = await Promise.all(accountIds.map((accountId) => lastRecorded(accountId, db)));
  expect(after).toEqual(before);
  await expect(requireDraft(draftId, db)).resolves.toMatchObject({ id: draftId });
  return refusal;
}

const GENERIC =
  "This statement or its account changed after this review. Nothing was recorded — check it " +
  "and record again.";

/** Settings' save of the account with only its kind changed. */
async function rekind(
  db: TestContext["db"],
  account: SeededAccount,
  kind: "brokerage" | "liability",
): Promise<void> {
  const { name, institution, ownerId, taxTreatment, externalAccountNumber } = await getAccount(
    account.id,
    db,
  );
  await updateAccount(
    account.id,
    { name, institution, kind, ownerId, taxTreatment, externalAccountNumber: externalAccountNumber ?? "" },
    db,
  );
}

describe("one assembler for both kinds of draft", () => {
  it(
    "reviews a chosen-account draft as exactly one section carrying that account's figures and header, and records it as one set",
    withDatabase(async (ctx) => {
      const { db } = ctx;
      const owner = await ctx.seedPerson({ name: "Asha" });
      const account = await ctx.seedAccount({
        name: "Joint brokerage",
        owner,
        externalAccountNumber: "X47-283910",
      });
      const vti = await seedAliased(ctx, "VTI");
      const draftId = await stage(ctx, account, encode("Symbol,Quantity,Basis\nVTI,3,200\n"), CHOSEN);

      const review = await reviewForDraft(draftId, DATE, db);

      expect(review.accountId).toBe(account.id);
      expect(review.reviewRevision).toMatch(/^v5\./);
      expect(review.skipped).toEqual([]);
      expect(onlySection(review)).toMatchObject({
        accountId: account.id,
        accountName: "Joint brokerage",
        ownerName: "Asha",
        accountNumberTail: "····3910",
        added: [{ instrumentId: vti.id, quantity: "3", costBasisPerShare: "200" }],
        updated: [],
        removed: [],
        unchangedCount: 0,
        currentCount: 0,
        firstStatement: true,
        baselineSetId: null,
        filedBehind: null,
        asOf: { source: "asked", date: DATE },
        appendWatermark: null,
      });

      const written = await reviewAndRecord(draftId, db, { asOf: DATE });

      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        accountId: account.id,
        accountName: "Joint brokerage",
        filename: FILENAME,
        asOf: DATE,
        counts: { added: 1, updated: 0, unchanged: 0, removed: 0 },
      });
      const sets = await db
        .selectFrom("position_set")
        .select("id")
        .where("account_id", "=", account.id)
        .execute();
      expect(sets.map((set) => set.id)).toEqual([written[0]?.setId]);
    }),
  );

  it(
    "reviews a draft of several accounts as one section per routed account in ascending id, and records one set per section",
    withDatabase(async (ctx) => {
      const { db } = ctx;
      const first = await ctx.seedAccount({ name: "First", externalAccountNumber: "A-0001" });
      const second = await ctx.seedAccount({ name: "Second", externalAccountNumber: "B-0002" });
      await seedAliased(ctx, "VTI");
      // The file names the later account first: order is the account's, not the file's.
      const draftId = await stage(
        ctx,
        null,
        encode("Account,Symbol,Qty,Basis\nB-0002,VTI,2,\nA-0001,VTI,1,\n"),
        SEVERAL,
      );

      const review = await reviewForDraft(draftId, DATE, db);

      expect(review.accountId).toBeNull();
      expect(review.reviewRevision).toMatch(/^v5\./);
      expect(
        review.accounts.map((section) => [
          section.accountId,
          section.accountName,
          section.accountNumberTail,
          section.added.map((row) => row.quantity),
        ]),
      ).toEqual([
        [first.id, "First", "····0001", ["1"]],
        [second.id, "Second", "····0002", ["2"]],
      ]);

      const written = await reviewAndRecord(draftId, db, { asOf: DATE });

      expect(written.map((set) => [set.accountId, set.asOf, set.counts.added])).toEqual([
        [first.id, DATE, 1],
        [second.id, DATE, 1],
      ]);
    }),
  );
});

describe("every field the review revision binds", () => {
  it(
    "refuses a commit as stale after a Columns save that changes the mapping and no row",
    withDatabase(async (ctx) => {
      const { db } = ctx;
      const account = await ctx.seedAccount();
      await seedAliased(ctx, "VTI");
      const draftId = await stage(
        ctx,
        account,
        encode("Symbol,Name,Quantity,Basis\nVTI,Vanguard Total,3,200\n"),
        CHOSEN,
      );
      const review = await reviewForDraft(draftId, DATE, db);

      // The name column is not part of a folded row.
      const saved = await rememberMapping(
        draftId,
        { ...CHOSEN, columns: { ...CHOSEN.columns, name: "Name" } },
        db,
      );
      expect(saved).toEqual({ nextStep: "review" });

      const refusal = await expectStale(db, draftId, posted(review, { asOf: DATE }), [account.id]);
      expect(refusal.fieldErrors.form).toBe(GENERIC);
      expect(onlySection(refusal.diff).added).toEqual(onlySection(review).added);
    }),
  );

  it(
    "refuses a commit as stale after two aliases swap instruments, though every folded row is unchanged",
    withDatabase(async (ctx) => {
      const { db } = ctx;
      const account = await ctx.seedAccount();
      const x = await seedAliased(ctx, "AAA");
      const y = await seedAliased(ctx, "BBB");
      const draftId = await stage(
        ctx,
        account,
        encode("Symbol,Quantity,Basis\nAAA,5,10\nBBB,5,10\n"),
        CHOSEN,
      );
      const review = await reviewForDraft(draftId, DATE, db);

      const repoint = (rawString: string, from: string, to: string) =>
        changeAlias(
          { intent: "repoint", rawString, fromInstrumentId: from, instrumentId: to, confirm: "true" },
          db,
        );
      await repoint("AAA", x.id, y.id);
      await repoint("BBB", y.id, x.id);

      const refusal = await expectStale(db, draftId, posted(review, { asOf: DATE }), [account.id]);
      expect(refusal.fieldErrors.form).toBe(GENERIC);
      const rows = (added: ReadonlyArray<{ instrumentId: string; quantity: string }>) =>
        added.map((row) => [row.instrumentId, row.quantity]).sort();
      expect(rows(onlySection(refusal.diff).added)).toEqual(rows(onlySection(review).added));
    }),
  );

  it(
    "refuses a commit as stale after the account's kind flips a routed row's sign, with mapping, aliases and routing unchanged",
    withDatabase(async (ctx) => {
      const { db } = ctx;
      const mortgage = await ctx.seedAccount({
        name: "Mortgage",
        kind: "liability",
        externalAccountNumber: "L-1",
      });
      await seedAliased(ctx, "LOAN");
      const draftId = await stage(ctx, null, encode("Account,Symbol,Qty,Basis\nL-1,LOAN,1000,\n"), SEVERAL);
      const review = await reviewForDraft(draftId, DATE, db);
      expect(review.accounts[0]?.added.map((row) => row.quantity)).toEqual(["-1000"]);

      await rekind(db, mortgage, "brokerage");

      const refusal = await expectStale(db, draftId, posted(review, { asOf: DATE }), [mortgage.id]);
      expect(refusal.fieldErrors.form).toBe(GENERIC);
      expect(refusal.diff.accounts[0]?.added.map((row) => row.quantity)).toEqual(["1000"]);
    }),
  );

  it(
    "refuses a commit as stale after a set lands between the baseline and the statement date, leaving the latest set where it was",
    withDatabase(async (ctx) => {
      const { db } = ctx;
      const account = await ctx.seedAccount();
      const fund = await seedAliased(ctx, "FUND");
      const march = await ctx.seedPositionSet({
        account,
        asOf: "2026-03-31",
        holdings: [{ instrument: fund, quantity: "1" }],
      });
      await ctx.seedPositionSet({
        account,
        asOf: "2026-09-01",
        holdings: [{ instrument: fund, quantity: "9" }],
      });
      const draftId = await stage(ctx, account, encode("Symbol,Quantity,Basis\nFUND,3,\n"), CHOSEN);
      const review = await reviewForDraft(draftId, DATE, db);
      expect(onlySection(review).baselineSetId).toBe(march.id);

      const may = await ctx.seedPositionSet({
        account,
        asOf: "2026-05-31",
        holdings: [{ instrument: fund, quantity: "2" }],
      });

      const refusal = await expectStale(
        db,
        draftId,
        posted(review, { asOf: DATE, [sectionKey("confirmFiledBehind", account.id)]: "true" }),
        [account.id],
      );
      expect(refusal.fieldErrors.form).toBe(GENERIC);
      expect(onlySection(refusal.diff).baselineSetId).toBe(may.id);
      expect(onlySection(refusal.diff).filedBehind?.currentAsOf).toBe("2026-09-01");
    }),
  );

  it(
    "refuses a commit as stale after a set lands after the statement date, leaving the baseline where it was",
    withDatabase(async (ctx) => {
      const { db } = ctx;
      const account = await ctx.seedAccount();
      const fund = await seedAliased(ctx, "FUND");
      const march = await ctx.seedPositionSet({
        account,
        asOf: "2026-03-31",
        holdings: [{ instrument: fund, quantity: "1" }],
      });
      const draftId = await stage(ctx, account, encode("Symbol,Quantity,Basis\nFUND,3,\n"), CHOSEN);
      const review = await reviewForDraft(draftId, DATE, db);
      expect(onlySection(review).filedBehind).toBeNull();

      await ctx.seedPositionSet({
        account,
        asOf: "2026-07-31",
        holdings: [{ instrument: fund, quantity: "7" }],
      });

      const refusal = await expectStale(
        db,
        draftId,
        posted(review, { asOf: DATE, [sectionKey("confirmFiledBehind", account.id)]: "true" }),
        [account.id],
      );
      expect(refusal.fieldErrors.form).toBe(GENERIC);
      expect(onlySection(refusal.diff).baselineSetId).toBe(march.id);
      expect(onlySection(refusal.diff).filedBehind).toEqual({
        asOf: DATE,
        currentAsOf: "2026-07-31",
      });
    }),
  );

  it(
    "refuses a commit as stale after a backdated set that moves neither the baseline nor the latest set",
    withDatabase(async (ctx) => {
      const { db } = ctx;
      const account = await ctx.seedAccount();
      const fund = await seedAliased(ctx, "FUND");
      const march = await ctx.seedPositionSet({
        account,
        asOf: "2026-03-31",
        holdings: [{ instrument: fund, quantity: "1" }],
      });
      const draftId = await stage(ctx, account, encode("Symbol,Quantity,Basis\nFUND,3,\n"), CHOSEN);
      const review = await reviewForDraft(draftId, DATE, db);

      const january = await ctx.seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: fund, quantity: "5" }],
      });

      const refusal = await expectStale(db, draftId, posted(review, { asOf: DATE }), [account.id]);
      expect(refusal.fieldErrors.form).toBe(GENERIC);
      expect(onlySection(refusal.diff)).toMatchObject({
        baselineSetId: march.id,
        filedBehind: null,
        appendWatermark: january.id,
      });
      expect(onlySection(review).appendWatermark).toBe(march.id);
    }),
  );

  it(
    "refuses a commit at another typed date as drawn for a different date, the reviewed revision matching neither date's commit",
    withDatabase(async (ctx) => {
      const { db } = ctx;
      const account = await ctx.seedAccount();
      await seedAliased(ctx, "FUND");
      const draftId = await stage(ctx, account, encode("Symbol,Quantity,Basis\nFUND,3,\n"), CHOSEN);
      const review = await reviewForDraft(draftId, DATE, db);
      expect(review.asOfInput).toBe(DATE);

      const refusal = await expectStale(db, draftId, posted(review, { asOf: "2026-05-31" }), [
        account.id,
      ]);
      expect(refusal.fieldErrors.form).toBe(
        "This comparison was drawn for a different statement date. Here it is for 2026-05-31. " +
          "Nothing was recorded — check it and record again.",
      );
      expect(refusal.diff.reviewRevision).toMatch(/^v5\./);
      expect(refusal.diff.reviewRevision).not.toBe(review.reviewRevision);
      expect(onlySection(refusal.diff).added).toEqual(onlySection(review).added);
    }),
  );

  it(
    "refuses a commit as stale after the file's unknown number is answered to a different account",
    withDatabase(async (ctx) => {
      const { db } = ctx;
      const first = await ctx.seedAccount({ name: "First", externalAccountNumber: "A-1" });
      const second = await ctx.seedAccount({ name: "Second" });
      const third = await ctx.seedAccount({ name: "Third" });
      await seedAliased(ctx, "VTI");
      const draftId = await stage(
        ctx,
        null,
        encode("Account,Symbol,Qty,Basis\nA-1,VTI,1,\nB-2,VTI,2,\n"),
        SEVERAL,
      );
      const answer = (accountId: string) =>
        answerAccountNumbers(draftId, { "number-0": "B-2", "accountId-0": accountId }, db);
      await answer(second.id);
      const review = await reviewForDraft(draftId, DATE, db);
      expect(review.accounts.map((section) => section.accountId)).toEqual([first.id, second.id]);

      expect(await answer(third.id)).toEqual({ nextStep: "review" });

      const refusal = await expectStale(db, draftId, posted(review, { asOf: DATE }), [
        first.id,
        second.id,
        third.id,
      ]);
      expect(refusal.fieldErrors.form).toBe(GENERIC);
      expect(refusal.diff.accounts.map((section) => section.accountId)).toEqual([
        first.id,
        third.id,
      ]);
    }),
  );

  describe("fields no write changes on a draft", () => {
    async function setsOf(db: TestContext["db"], account: SeededAccount) {
      return db.selectFrom("position_set").select("id").where("account_id", "=", account.id).execute();
    }

    const CSV = "Symbol,Quantity,Basis\nFUND,3,\n";

    it(
      "refuses one draft's review posted to another holding the same file, name and account",
      withDatabase(async (ctx) => {
        const account = await ctx.seedAccount();
        await seedAliased(ctx, "FUND");
        const draftA = await stage(ctx, account, encode(CSV), CHOSEN, FILENAME);
        const draftB = await stage(ctx, account, encode(CSV), CHOSEN, FILENAME);
        const reviewA = await reviewForDraft(draftA, DATE, ctx.db);
        const reviewB = await reviewForDraft(draftB, DATE, ctx.db);
        // The figures agree, so only the draft id separates the two revisions.
        expect(onlySection(reviewB).added).toEqual(onlySection(reviewA).added);

        const refusal = await expectStale(ctx.db, draftB, posted(reviewA, { asOf: DATE }), [
          account.id,
        ]);
        expect(refusal.fieldErrors.form).toBe(GENERIC);
        expect(await setsOf(ctx.db, account)).toEqual([]);
      }),
    );

    it(
      "refuses a commit as stale after the draft's bytes are restated, even to a CRLF variant that parses to the same rows",
      withDatabase(async (ctx) => {
        const account = await ctx.seedAccount();
        await seedAliased(ctx, "FUND");
        const draftId = await stage(ctx, account, encode(CSV), CHOSEN, FILENAME);
        const review = await reviewForDraft(draftId, DATE, ctx.db);

        await restateDraft(ctx.db, draftId, { bytes: encode(CSV.replaceAll("\n", "\r\n")) });

        const refusal = await expectStale(ctx.db, draftId, posted(review, { asOf: DATE }), [
          account.id,
        ]);
        expect(refusal.fieldErrors.form).toBe(GENERIC);
        expect(await setsOf(ctx.db, account)).toEqual([]);
      }),
    );

    it(
      "refuses a commit as stale after the draft's filename is restated",
      withDatabase(async (ctx) => {
        const account = await ctx.seedAccount();
        await seedAliased(ctx, "FUND");
        const draftId = await stage(ctx, account, encode(CSV), CHOSEN, FILENAME);
        const review = await reviewForDraft(draftId, DATE, ctx.db);

        await restateDraft(ctx.db, draftId, { filename: "Other.csv" });

        const refusal = await expectStale(ctx.db, draftId, posted(review, { asOf: DATE }), [
          account.id,
        ]);
        expect(refusal.fieldErrors.form).toBe(GENERIC);
        expect(await setsOf(ctx.db, account)).toEqual([]);
      }),
    );
  });
});

describe("the posted account id (spec 0024 §4 b)", () => {
  it(
    "refuses a chosen-account form posted for another account, recording nothing",
    withDatabase(async (ctx) => {
      const { db } = ctx;
      const account = await ctx.seedAccount();
      const other = await ctx.seedAccount();
      await seedAliased(ctx, "FUND");
      const draftId = await stage(ctx, account, encode("Symbol,Quantity,Basis\nFUND,3,\n"), CHOSEN);
      const review = await reviewForDraft(draftId, DATE, db);
      const before = await Promise.all(
        [account.id, other.id].map((accountId) => lastRecorded(accountId, db)),
      );

      const refusal = await refusalOf(() =>
        recordUpload(draftId, posted(review, { asOf: DATE, accountId: other.id }), db),
      );

      expect(refusal).not.toBeInstanceOf(StaleReviewError);
      expect(refusal).not.toBeInstanceOf(RefusedUpload);
      expect(refusal.fieldErrors).toEqual({
        form:
          "This form was posted for a different account than the one this upload is recording " +
          "a statement against. Reload the review and check what it is about to record.",
      });
      const after = await Promise.all(
        [account.id, other.id].map((accountId) => lastRecorded(accountId, db)),
      );
      expect(after).toEqual(before);
      await expect(requireDraft(draftId, db)).resolves.toMatchObject({ id: draftId });
    }),
  );

  it(
    "records a several-account form posting an empty account id",
    withDatabase(async (ctx) => {
      const { db } = ctx;
      const first = await ctx.seedAccount({ externalAccountNumber: "A-1" });
      await seedAliased(ctx, "VTI");
      const draftId = await stage(ctx, null, encode("Account,Symbol,Qty,Basis\nA-1,VTI,1,\n"), SEVERAL);
      const review = await reviewForDraft(draftId, DATE, db);
      const form = posted(review, { asOf: DATE });
      expect(form.accountId).toBe("");

      const written = await recordUpload(draftId, form, db);

      expect(written.map((set) => set.accountId)).toEqual([first.id]);
    }),
  );
});
