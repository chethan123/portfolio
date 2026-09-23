// A multi-account upload's review and commit (spec 0023 decisions 6-10, "The commit"). One file
// restates several accounts at once, so the risk is a partial write: one account recorded and
// another refused, a row landing in the wrong account, a sign flipped on the wrong kind, or a
// confirmation read from another account's box. Real Postgres; exact decimal strings.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { closeAccount } from "~/lib/accounts.server";
import { NotFoundError, ValidationError } from "~/lib/input.server";
import { resolveAll } from "~/lib/instrument-resolution.server";
import {
  DraftNotReadyError,
  RefusedUpload,
  StaleReviewError,
  recordUpload,
  rememberMapping,
  requireDraft,
  reviewForDraft,
  type CommitInput,
  type UploadDiff,
} from "~/lib/uploads.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";

import type { StatementMapping } from "~/lib/statement";
import type { TestContext } from "./support/database.ts";

afterAll(closeTestDatabase);

const spreadsheet = (): Uint8Array =>
  readFileSync(fileURLToPath(new URL("./fixtures/statements/multi-account.csv", import.meta.url)));

const MULTI: StatementMapping = {
  headerRow: 0,
  delimiter: ",",
  columns: {
    instrument: "Holding",
    name: "Description",
    quantity: "Quantity",
    costBasis: "Cost Basis",
    asOf: "As Of",
    accountNumber: "Account Number",
  },
  costBasisIs: "per_share",
  owedAsPositive: false,
  combineDuplicateRows: true,
  multiAccount: true,
};

const INLINE: StatementMapping = {
  ...MULTI,
  columns: { instrument: "Symbol", quantity: "Qty", costBasis: "Basis", accountNumber: "Account" },
};

const FILENAME = "all-accounts.csv";

/** The three accounts multi-account.csv names, in ascending id, plus one it does not. */
async function seedHousehold(
  ctx: Pick<TestContext, "seedAccount" | "seedInstrument" | "seedInstrumentAlias">,
) {
  const individual = await ctx.seedAccount({
    name: "Individual brokerage",
    externalAccountNumber: "Z12-345678",
  });
  const roth = await ctx.seedAccount({
    name: "Roth IRA",
    kind: "ira",
    externalAccountNumber: "Z98-765432",
  });
  const mortgage = await ctx.seedAccount({
    name: "Home mortgage",
    kind: "liability",
    externalAccountNumber: "0045501234",
  });
  const bystander = await ctx.seedAccount({ name: "Bystander", externalAccountNumber: "Q-1" });

  const instrument = async (rawString: string) => {
    const seeded = await ctx.seedInstrument({ symbol: rawString, name: rawString });
    await ctx.seedInstrumentAlias({ instrument: seeded, rawString });
    return seeded;
  };
  const vti = await instrument("VTI");
  const aapl = await instrument("AAPL");
  const fxaix = await instrument("FXAIX");
  const loan = await instrument("Home mortgage");

  return { individual, roth, mortgage, bystander, vti, aapl, fxaix, loan };
}

/** A multi-account draft past its columns step. */
async function stage(
  { db, seedUploadDraft }: Pick<TestContext, "db" | "seedUploadDraft">,
  bytes: Uint8Array,
  mapping: StatementMapping = MULTI,
): Promise<string> {
  const draft = await seedUploadDraft({ account: null, filename: FILENAME, bytes });
  const outcome = await rememberMapping(draft.id, mapping, db);
  if ("problems" in outcome) {
    throw new Error(outcome.problems.map((problem) => problem.message).join(" "));
  }
  return draft.id;
}

/** Every account's binding exactly as the review form posts it, then `extra` on top. */
function posted(review: UploadDiff, extra: CommitInput = {}): CommitInput {
  const fields: CommitInput = {
    accountId: "",
    reviewedAsOf: review.asOfInput,
    ...(review.reviewRevision === null ? {} : { reviewRevision: review.reviewRevision }),
  };
  for (const section of review.accounts ?? []) {
    fields[`baselineSetId-${section.accountId}`] = section.baselineSetId ?? "";
  }
  return { ...fields, ...extra };
}

async function reviewAndRecord(
  draftId: string,
  db: TestContext["db"],
  { asOf = null, extra = {} }: { asOf?: string | null; extra?: CommitInput } = {},
) {
  const review = await reviewForDraft(draftId, asOf, db);
  return recordUpload(draftId, posted(review, asOf === null ? extra : { asOf, ...extra }), db);
}

async function refusalOf(run: () => Promise<unknown>): Promise<ValidationError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("Expected the upload to be refused, and it was not.");
}

async function setsOf(db: TestContext["db"], accountId: string) {
  return db
    .selectFrom("position_set")
    .select(["id", "as_of_date", "source", "source_filename", "raw_file"])
    .where("account_id", "=", accountId)
    .orderBy("id")
    .execute();
}

async function holdingsOf(db: TestContext["db"], setId: string) {
  return db
    .selectFrom("holding")
    .select(["instrument_id", "quantity", "cost_basis_per_share"])
    .where("position_set_id", "=", setId)
    .orderBy("instrument_id")
    .execute();
}

describe("a multi-account review", () => {
  it(
    "draws one section per routed account, ascending id, each against its own baseline at its own date",
    withDatabase(async (ctx) => {
      const { individual, roth, mortgage, vti } = await seedHousehold(ctx);
      const earlier = await ctx.seedPositionSet({
        account: roth,
        asOf: "2026-05-31",
        holdings: [{ instrument: vti, quantity: "30" }],
      });
      const draftId = await stage(ctx, spreadsheet());

      const review = await reviewForDraft(draftId, null, ctx.db);

      expect(review.accountId).toBeNull();
      expect(review.reviewRevision).toMatch(/^v4\./);
      expect(
        review.accounts?.map((section) => [
          section.accountId,
          section.asOf,
          section.baselineSetId,
          section.firstStatement,
        ]),
      ).toEqual([
        [individual.id, { source: "file", date: "2026-07-31" }, null, true],
        [roth.id, { source: "file", date: "2026-06-30" }, earlier.id, false],
        [mortgage.id, { source: "file", date: "2026-07-15" }, null, true],
      ]);
      const rothSection = review.accounts?.[1];
      expect(rothSection?.accountNumberTail).toBe("····5432");
      expect(
        rothSection?.updated.map((row) => [row.name, row.quantityBefore, row.quantityAfter]),
      ).toEqual([["VTI", "30.00000000", "40.500"]]);
      expect(rothSection?.added.map((row) => row.name)).toEqual(["FXAIX"]);
    }),
  );

  it(
    "lists a skipped line under the account whose number it states, and one naming none with the file",
    withDatabase(async (ctx) => {
      const account = await ctx.seedAccount({ externalAccountNumber: "A-1" });
      const vti = await ctx.seedInstrument({ symbol: "VTI" });
      await ctx.seedInstrumentAlias({ instrument: vti, rawString: "VTI" });
      const draftId = await stage(
        ctx,
        new TextEncoder().encode("Account,Symbol,Qty,Basis\nA-1,VTI,10,\nA-1,CASH,--,\n,Total,--,\n"),
        INLINE,
      );

      const review = await reviewForDraft(draftId, "2026-06-30", ctx.db);

      expect(review.accounts?.map((section) => [section.accountId, section.skipped])).toEqual([
        [account.id, [{ row: 2, instrument: "CASH" }]],
      ]);
      expect(review.skipped).toEqual([{ row: 3, instrument: "Total" }]);
    }),
  );
});

describe("recording a multi-account file", () => {
  it(
    "records one statement per account the file names, holding that account's own rows and the whole file's bytes",
    withDatabase(async (ctx) => {
      const { db } = ctx;
      const { individual, roth, mortgage, vti, aapl, fxaix, loan } = await seedHousehold(ctx);
      const bytes = spreadsheet();
      const draftId = await stage(ctx, bytes);

      const written = await reviewAndRecord(draftId, db);

      if (!written.multiAccount) throw new Error("A multi-account draft recorded as one account.");
      expect(written.recorded.map((set) => [set.accountId, set.asOf, set.counts.added])).toEqual([
        [individual.id, "2026-07-31", 2],
        [roth.id, "2026-06-30", 2],
        [mortgage.id, "2026-07-15", 1],
      ]);

      for (const [account, asOf] of [
        [individual, "2026-07-31"],
        [roth, "2026-06-30"],
        [mortgage, "2026-07-15"],
      ] as const) {
        const sets = await setsOf(db, account.id);
        expect(sets).toHaveLength(1);
        expect(sets[0]).toMatchObject({ as_of_date: asOf, source: "upload", source_filename: FILENAME });
        expect(Buffer.from(sets[0]?.raw_file ?? []).equals(Buffer.from(bytes))).toBe(true);
      }

      const [first, second, third] = written.recorded;
      expect(await holdingsOf(db, first?.setId ?? "")).toEqual([
        { instrument_id: vti.id, quantity: "120.00000000", cost_basis_per_share: "205.1200" },
        { instrument_id: aapl.id, quantity: "50.00000000", cost_basis_per_share: "170.6600" },
      ]);
      expect(await holdingsOf(db, second?.setId ?? "")).toEqual([
        { instrument_id: vti.id, quantity: "40.50000000", cost_basis_per_share: "231.4000" },
        { instrument_id: fxaix.id, quantity: "84.51200000", cost_basis_per_share: "151.3300" },
      ]);
      // Unticked, a liability's positive figure stays as the file states it.
      expect(await holdingsOf(db, third?.setId ?? "")).toEqual([
        { instrument_id: loan.id, quantity: "312450.00000000", cost_basis_per_share: null },
      ]);

      await expect(requireDraft(draftId, db)).rejects.toThrow(NotFoundError);
    }),
  );

  it(
    "leaves an open account the file does not name untouched",
    withDatabase(async (ctx) => {
      const { bystander, vti } = await seedHousehold(ctx);
      const own = await ctx.seedPositionSet({
        account: bystander,
        asOf: "2026-06-01",
        holdings: [{ instrument: vti, quantity: "7" }],
      });
      const draftId = await stage(ctx, spreadsheet());

      await reviewAndRecord(draftId, ctx.db);

      expect((await setsOf(ctx.db, bystander.id)).map((set) => set.id)).toEqual([own.id]);
    }),
  );

  it(
    "negates only the liability's rows when balances owed are listed as positive",
    withDatabase(async (ctx) => {
      const { individual, mortgage, vti, loan } = await seedHousehold(ctx);
      const draftId = await stage(ctx, spreadsheet(), { ...MULTI, owedAsPositive: true });

      await reviewAndRecord(draftId, ctx.db);

      const [mortgageSet] = await setsOf(ctx.db, mortgage.id);
      expect(await holdingsOf(ctx.db, mortgageSet?.id ?? "")).toEqual([
        { instrument_id: loan.id, quantity: "-312450.00000000", cost_basis_per_share: null },
      ]);
      const [individualSet] = await setsOf(ctx.db, individual.id);
      const individualHoldings = await holdingsOf(ctx.db, individualSet?.id ?? "");
      expect(individualHoldings.find((row) => row.instrument_id === vti.id)?.quantity).toBe(
        "120.00000000",
      );
    }),
  );

  it(
    "dates every account by the one typed date when the as-of column is unmapped, refusing without one",
    withDatabase(async (ctx) => {
      const { individual, roth, mortgage } = await seedHousehold(ctx);
      const draftId = await stage(ctx, spreadsheet(), {
        ...MULTI,
        columns: { ...MULTI.columns, asOf: null },
      });

      const review = await reviewForDraft(draftId, "2026-06-30", ctx.db);
      expect(review.asOf).toEqual({ source: "asked", date: "2026-06-30" });
      expect(review.accounts?.map((section) => section.asOf)).toEqual([
        { source: "asked", date: "2026-06-30" },
        { source: "asked", date: "2026-06-30" },
        { source: "asked", date: "2026-06-30" },
      ]);

      const undated = await refusalOf(() => recordUpload(draftId, posted(review), ctx.db));
      expect(undated.fieldErrors.asOf).toBeDefined();

      await recordUpload(draftId, posted(review, { asOf: "2026-06-30" }), ctx.db);
      for (const account of [individual, roth, mortgage]) {
        expect((await setsOf(ctx.db, account.id)).map((set) => set.as_of_date)).toEqual([
          "2026-06-30",
        ]);
      }
    }),
  );

  it(
    "gives the typed date only to an account whose rows leave the mapped as-of column blank",
    withDatabase(async (ctx) => {
      const dated = await ctx.seedAccount({ externalAccountNumber: "A-1" });
      const blank = await ctx.seedAccount({ externalAccountNumber: "B-2" });
      for (const raw of ["VTI", "BND"]) {
        const instrument = await ctx.seedInstrument({ symbol: raw, name: raw });
        await ctx.seedInstrumentAlias({ instrument, rawString: raw });
      }
      const draftId = await stage(
        ctx,
        new TextEncoder().encode(
          "Account,Symbol,Qty,Basis,As Of\nA-1,VTI,1,,2026-07-31\nB-2,BND,2,,\n",
        ),
        { ...INLINE, columns: { ...INLINE.columns, asOf: "As Of" } },
      );

      const review = await reviewForDraft(draftId, "2026-06-30", ctx.db);
      expect(review.asOf).toEqual({ source: "asked", date: "2026-06-30" });
      expect(review.accounts?.map((section) => section.asOf)).toEqual([
        { source: "file", date: "2026-07-31" },
        { source: "asked", date: "2026-06-30" },
      ]);

      await recordUpload(draftId, posted(review, { asOf: "2026-06-30" }), ctx.db);
      expect((await setsOf(ctx.db, dated.id)).map((set) => set.as_of_date)).toEqual(["2026-07-31"]);
      expect((await setsOf(ctx.db, blank.id)).map((set) => set.as_of_date)).toEqual(["2026-06-30"]);
    }),
  );

  it(
    "records nothing for any account when one closes after review",
    withDatabase(async (ctx) => {
      const { individual, roth, mortgage } = await seedHousehold(ctx);
      const draftId = await stage(ctx, spreadsheet());
      const review = await reviewForDraft(draftId, null, ctx.db);

      await closeAccount(mortgage.id, { confirmClose: "true" }, ctx.db);

      const refused = recordUpload(draftId, posted(review), ctx.db);
      await expect(refused).rejects.toBeInstanceOf(DraftNotReadyError);
      await expect(refused).rejects.toMatchObject({
        blocked: {
          problems: [expect.objectContaining({ message: expect.stringContaining("Home mortgage") })],
        },
      });
      for (const account of [individual, roth, mortgage]) {
        expect(await setsOf(ctx.db, account.id)).toEqual([]);
      }
    }),
  );

  it(
    "records nothing for any account when one account's row outgrows the money column, naming that account",
    withDatabase(async (ctx) => {
      const small = await ctx.seedAccount({ name: "Small", externalAccountNumber: "A-1" });
      const huge = await ctx.seedAccount({ name: "Huge", externalAccountNumber: "B-2" });
      for (const raw of ["VTI", "BIG"]) {
        const instrument = await ctx.seedInstrument({ symbol: raw, name: raw });
        await ctx.seedInstrumentAlias({ instrument, rawString: raw });
      }
      const draftId = await stage(
        ctx,
        new TextEncoder().encode("Account,Symbol,Qty,Basis\nA-1,VTI,10,1\nB-2,BIG,999999999999,99999\n"),
        INLINE,
      );

      const refusal = await refusalOf(() =>
        reviewAndRecord(draftId, ctx.db, { asOf: "2026-06-30" }),
      );

      expect(refusal).toBeInstanceOf(RefusedUpload);
      expect(refusal.fieldErrors.form).toMatch(
        /^Huge: BIG's quantity multiplied by its cost basis is a larger figure/,
      );
      expect(refusal instanceof RefusedUpload ? refusal.diff.accounts?.length : null).toBe(2);
      expect(await setsOf(ctx.db, small.id)).toEqual([]);
      expect(await setsOf(ctx.db, huge.id)).toEqual([]);
    }),
  );

  it(
    "refuses a baseline that moved under the second account, naming it, reading each binding from its own field only",
    withDatabase(async (ctx) => {
      const { individual, roth, mortgage, vti } = await seedHousehold(ctx);
      const earlier = await ctx.seedPositionSet({
        account: roth,
        asOf: "2026-05-31",
        holdings: [{ instrument: vti, quantity: "30" }],
      });
      const draftId = await stage(ctx, spreadsheet());
      const review = await reviewForDraft(draftId, null, ctx.db);

      // The single-account field carries the right id; Roth IRA's own says there was none.
      const refusal = await refusalOf(() =>
        recordUpload(
          draftId,
          posted(review, { [`baselineSetId-${roth.id}`]: "", baselineSetId: earlier.id }),
          ctx.db,
        ),
      );

      expect(refusal).toBeInstanceOf(RefusedUpload);
      expect(refusal.fieldErrors.form).toBe(
        "Roth IRA: This statement was measured against figures that are no longer current: it " +
          "is now measured against what Roth IRA held on 2026-05-31. Nothing was recorded — " +
          "check the figures now shown and confirm again.",
      );
      expect(await setsOf(ctx.db, individual.id)).toEqual([]);
      expect((await setsOf(ctx.db, roth.id)).map((set) => set.id)).toEqual([earlier.id]);
      expect(await setsOf(ctx.db, mortgage.id)).toEqual([]);
    }),
  );

  it(
    "names every missing confirmation across accounts in one refusal, and records once each is ticked in its own box",
    withDatabase(async (ctx) => {
      const { individual, roth, mortgage, vti } = await seedHousehold(ctx);
      const held = await Promise.all(
        ["X", "Y", "Z"].map((symbol) => ctx.seedInstrument({ symbol, name: symbol })),
      );
      // Three of the four positions the file does not list: a majority removal.
      await ctx.seedPositionSet({
        account: individual,
        asOf: "2026-07-01",
        holdings: [
          { instrument: vti, quantity: "100" },
          ...held.map((instrument) => ({ instrument, quantity: "1" })),
        ],
      });
      // Already reporting a later date than the file's 2026-06-30: filed behind.
      await ctx.seedPositionSet({
        account: roth,
        asOf: "2026-09-01",
        holdings: [{ instrument: vti, quantity: "41" }],
      });
      const draftId = await stage(ctx, spreadsheet());
      const review = await reviewForDraft(draftId, null, ctx.db);

      const bothMissing =
        "Individual brokerage: This file removes 3 of the 4 positions this account holds. " +
        "Nothing was recorded — confirm the removals to record this statement. Roth IRA: This " +
        "statement is dated 2026-06-30, behind the 2026-09-01 figures Roth IRA currently reports.";

      const unticked = await refusalOf(() => recordUpload(draftId, posted(review), ctx.db));
      expect(unticked.fieldErrors.form).toContain(bothMissing);

      // Ticked, but in the single-account boxes and in each other's.
      const misplaced = await refusalOf(() =>
        recordUpload(
          draftId,
          posted(review, {
            confirmRemovals: "true",
            confirmFiledBehind: "true",
            [`confirmRemovals-${roth.id}`]: "true",
            [`confirmFiledBehind-${individual.id}`]: "true",
          }),
          ctx.db,
        ),
      );
      expect(misplaced.fieldErrors.form).toContain(bothMissing);
      expect(await setsOf(ctx.db, mortgage.id)).toEqual([]);

      const written = await recordUpload(
        draftId,
        posted(review, {
          [`confirmRemovals-${individual.id}`]: "true",
          [`confirmFiledBehind-${roth.id}`]: "true",
        }),
        ctx.db,
      );
      expect(written.multiAccount ? written.recorded.length : 0).toBe(3);
    }),
  );

  it(
    "refuses a review drawn before another write landed on one account, recording nothing",
    withDatabase(async (ctx) => {
      const { individual, roth, mortgage, loan } = await seedHousehold(ctx);
      const draftId = await stage(ctx, spreadsheet());
      const review = await reviewForDraft(draftId, null, ctx.db);

      const typed = await ctx.seedPositionSet({
        account: mortgage,
        asOf: "2026-08-01",
        source: "manual",
        holdings: [{ instrument: loan, quantity: "300000" }],
      });

      const refusal = await refusalOf(() => recordUpload(draftId, posted(review), ctx.db));

      expect(refusal).toBeInstanceOf(StaleReviewError);
      expect(refusal.fieldErrors.form).toMatch(/statement or its account changed after this review/);
      expect(await setsOf(ctx.db, individual.id)).toEqual([]);
      expect(await setsOf(ctx.db, roth.id)).toEqual([]);
      expect((await setsOf(ctx.db, mortgage.id)).map((set) => set.id)).toEqual([typed.id]);
    }),
  );

  it(
    "promotes the draft's answers once, only for strings the recorded accounts state, and deletes the draft with them",
    withDatabase(async (ctx) => {
      const { db } = ctx;
      const first = await ctx.seedAccount({ externalAccountNumber: "A-1" });
      const second = await ctx.seedAccount({ externalAccountNumber: "B-2" });
      const vti = await ctx.seedInstrument({ symbol: "VTI" });
      const draftId = await stage(
        ctx,
        new TextEncoder().encode("Account,Symbol,Qty,Basis\nA-1,QAALIAS,1,\nB-2,QAALIAS,2,\n"),
        INLINE,
      );
      await resolveAll(
        draftId,
        [
          { raw: "QAALIAS", fields: { kind: "existing", instrumentId: vti.id } },
          { raw: "MAPPED AWAY", fields: { kind: "existing", instrumentId: vti.id } },
        ],
        { probe: async () => new Map() },
        db,
      );

      await reviewAndRecord(draftId, db, { asOf: "2026-06-30" });

      expect(
        await db
          .selectFrom("instrument_alias")
          .selectAll()
          .where("raw_string", "in", ["QAALIAS", "MAPPED AWAY"])
          .execute(),
      ).toEqual([{ raw_string: "QAALIAS", instrument_id: vti.id }]);
      expect(await db.selectFrom("upload_draft_answer").select("draft_id").execute()).toEqual([]);
      await expect(requireDraft(draftId, db)).rejects.toThrow(NotFoundError);

      for (const [account, quantity] of [
        [first, "1.00000000"],
        [second, "2.00000000"],
      ] as const) {
        const [set] = await setsOf(db, account.id);
        expect(await holdingsOf(db, set?.id ?? "")).toEqual([
          { instrument_id: vti.id, quantity, cost_basis_per_share: null },
        ]);
      }
    }),
  );
});
