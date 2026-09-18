// Diff, commit, and receipt (docs/specs/ingest/05, DESIGN.md §5.1, §5.2). Real Postgres — the risk
// is transactional: whole-or-nothing commit, same-date re-upload tie-break, guards against a
// filtered export silently selling holdings. Every money assertion is an exact decimal string.
import { afterAll, describe, expect, it } from "vitest";

import { sql } from "kysely";

import { NotFoundError, ValidationError } from "~/lib/input.server";
import { closeAccount } from "~/lib/accounts.server";
import { lastRecorded, setBalance } from "~/lib/balances.server";
import {
  DraftNotReadyError,
  commitUpload,
  diffForDraft,
  rememberMapping,
  requireDraft,
  uploadReceipt,
} from "~/lib/uploads.server";
import { resolveAll, unresolvedStrings } from "~/lib/instrument-resolution.server";
import { accountHoldings, netWorth } from "~/lib/valuation.server";

import { closeTestDatabase, testDatabase, withDatabase } from "./support/database.ts";
import { makeFixtures, type SeededAccount } from "./support/fixtures.ts";

import type { StatementMapping } from "~/lib/statement";
import type { TestContext } from "./support/database.ts";
import { ALL_OWNERS } from "../app/lib/owner-filter.ts";

afterAll(closeTestDatabase);

const encode = (text: string) => new TextEncoder().encode(text);

/** The refusal a call produced, or a failure if it did not refuse. */
async function refusalOf(run: () => Promise<unknown>): Promise<ValidationError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("Expected the write to be refused, and it was not.");
}

const BASE_MAPPING: StatementMapping = {
  headerRow: 0,
  delimiter: ",",
  columns: { instrument: "Symbol", quantity: "Quantity", costBasis: "Basis" },
  costBasisIs: "per_share",
  owedAsPositive: false,
  combineDuplicateRows: true,
};

/** Overrides merged onto {@link BASE_MAPPING}, columns merged one level deep. */
type MappingOverrides = Omit<Partial<StatementMapping>, "columns"> & {
  columns?: Partial<StatementMapping["columns"]>;
};

const FILENAME = "Positions_2026-06-30.csv";

/** Stages a review-ready draft: bytes + saved mapping. A mapping that doesn't parse its own
 * CSV raises here (with the parse problems) rather than surfacing later as a puzzling
 * {@link DraftNotReadyError}. */
async function stage(
  { db, seedUploadDraft }: Pick<TestContext, "db" | "seedUploadDraft">,
  account: SeededAccount,
  csv: string,
  overrides: MappingOverrides = {},
): Promise<string> {
  const draft = await seedUploadDraft({ account, filename: FILENAME, bytes: encode(csv) });

  const outcome = await rememberMapping(
    draft.id,
    {
      ...BASE_MAPPING,
      ...overrides,
      columns: { ...BASE_MAPPING.columns, ...(overrides.columns ?? {}) },
    },
    db,
  );

  if ("problems" in outcome) {
    throw new Error(
      "This fixture's mapping does not parse its own file: " +
        outcome.problems.map((problem) => problem.message).join(" "),
    );
  }

  return draft.id;
}

describe("diffForDraft", () => {
  it(
    "classifies added, updated, unchanged and removed against the current statement",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet, seedQuote } =
        ctx;
      const account = await seedAccount({ kind: "brokerage" });

      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market ETF" });
      const bnd = await seedInstrument({ symbol: "BND", name: "Vanguard Total Bond Market ETF" });
      const fxnax = await seedInstrument({ symbol: "FXNAX", name: "Fidelity US Bond Index" });
      const aapl = await seedInstrument({ symbol: "AAPL", name: "Apple Inc." });
      const vxus = await seedInstrument({ symbol: "VXUS", name: "Vanguard Total International" });
      const cash = await seedInstrument({ symbol: null, name: "Cash Reserves" });

      for (const [instrument, raw] of [
        [vti, "VTI"],
        [bnd, "BND"],
        [fxnax, "FXNAX"],
        [aapl, "AAPL"],
        [vxus, "VXUS"],
        [cash, "CASH & CASH INVESTMENTS"],
      ] as const) {
        await seedInstrumentAlias({ instrument, rawString: raw });
      }

      await seedQuote({ instrument: vti, price: "482.10" });
      await seedQuote({ instrument: bnd, price: "72.61" });
      await seedQuote({ instrument: fxnax, price: "11.94" });
      await seedQuote({ instrument: aapl, price: "170.00" });
      await seedQuote({ instrument: cash, price: "1.00" });

      await seedPositionSet({
        account,
        asOf: "2026-03-31",
        holdings: [
          { instrument: vti, quantity: "145.234", costBasisPerShare: "424.12" },
          { instrument: bnd, quantity: "210" },
          { instrument: fxnax, quantity: "1050", costBasisPerShare: "11.82" },
          { instrument: aapl, quantity: "50", costBasisPerShare: "141.20" },
          { instrument: cash, quantity: "4210.55" },
        ],
      });

      const draftId = await stage(
        ctx,
        account,
        "Symbol,Quantity,Basis\n" +
          "VTI,156.234,$424.12\n" +
          "BND,210.000,71.05\n" +
          'FXNAX,"1,112.4",11.94\n' +
          'CASH & CASH INVESTMENTS,"4,210.55",n/a\n' +
          "VXUS,120,58.20\n",
      );

      const diff = await diffForDraft(draftId, db);

      expect(diff.firstStatement).toBe(false);
      expect(diff.currentCount).toBe(5);
      expect(diff.unchangedCount).toBe(1);
      expect(diff.majorityRemoved).toBe(false);
      expect(diff.removesEverything).toBe(false);
      expect(diff.asOf).toEqual({ source: "asked", date: null });

      expect(diff.added).toHaveLength(1);
      expect(diff.added[0]).toMatchObject({
        name: "Vanguard Total International",
        symbol: "VXUS",
        quantity: "120",
        costBasisPerShare: "58.20",
        value: null,
      });
      expect(diff.added[0]?.note).toMatch(/never priced/);

      const updated = new Map(diff.updated.map((row) => [row.symbol, row]));
      expect(diff.updated).toHaveLength(3);

      expect(updated.get("VTI")).toMatchObject({
        quantityBefore: "145.23400000",
        quantityAfter: "156.234",
        quantityChanged: true,
        basisChanged: false,
        value: "75320.4114",
      });

      expect(updated.get("BND")).toMatchObject({
        quantityChanged: false,
        basisChanged: true,
        basisDisappeared: false,
        costBasisBefore: null,
        costBasisAfter: "71.05",
      });

      expect(updated.get("FXNAX")).toMatchObject({
        quantityChanged: true,
        basisChanged: true,
        basisDisappeared: false,
        costBasisBefore: "11.8200",
        costBasisAfter: "11.94",
      });

      expect(diff.removed).toHaveLength(1);
      expect(diff.removed[0]).toMatchObject({
        name: "Apple Inc.",
        symbol: "AAPL",
        quantity: "50.00000000",
        costBasisPerShare: "141.2000",
        value: "8500.0000",
      });
    }),
  );

  it(
    "reads a disappearing cost basis as an update that says so in words",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "SWTSX", name: "Schwab Total Market" });
      await seedInstrumentAlias({ instrument: fund, rawString: "SWTSX" });
      await seedPositionSet({
        account,
        asOf: "2026-03-31",
        holdings: [{ instrument: fund, quantity: "10", costBasisPerShare: "52.41" }],
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nSWTSX,10,\n");
      const diff = await diffForDraft(draftId, db);

      expect(diff.updated).toHaveLength(1);
      expect(diff.updated[0]).toMatchObject({
        quantityChanged: false,
        basisChanged: true,
        basisDisappeared: true,
        costBasisBefore: "52.4100",
        costBasisAfter: null,
      });
      expect(diff.updated[0]?.note).toMatch(/cost basis no longer reported/);
    }),
  );

  it(
    "reads an account with no statement yet as all added, not a diff against nothing",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias } = ctx;
      const account = await seedAccount({ kind: "401k" });
      const a = await seedInstrument({ symbol: "A1", name: "First Fund" });
      const b = await seedInstrument({ symbol: "B2", name: "Second Fund" });
      await seedInstrumentAlias({ instrument: a, rawString: "A1" });
      await seedInstrumentAlias({ instrument: b, rawString: "B2" });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nA1,100,\nB2,50,\n");
      const diff = await diffForDraft(draftId, db);

      expect(diff.firstStatement).toBe(true);
      expect(diff.added).toHaveLength(2);
      expect(diff.updated).toHaveLength(0);
      expect(diff.removed).toHaveLength(0);
      expect(diff.unchangedCount).toBe(0);
      expect(diff.majorityRemoved).toBe(false);
    }),
  );

  it(
    "lists a never-priced removal with its quantity and holdingNote's words, never $0.00",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "401k" });
      const trust = await seedInstrument({ symbol: null, name: "Collective Trust" });
      const kept = await seedInstrument({ symbol: "KPT", name: "Kept Fund" });
      await seedInstrumentAlias({ instrument: kept, rawString: "KPT" });
      await seedPositionSet({
        account,
        asOf: "2026-03-31",
        holdings: [
          { instrument: trust, quantity: "12" },
          { instrument: kept, quantity: "5" },
        ],
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nKPT,5,\n");
      const diff = await diffForDraft(draftId, db);

      expect(diff.removed).toHaveLength(1);
      expect(diff.removed[0]).toMatchObject({
        name: "Collective Trust",
        quantity: "12.00000000",
        value: null,
      });
      expect(diff.removed[0]?.note).toMatch(/never priced/);
    }),
  );

  it(
    "flags a majority removal, and removing everything as its own case",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const a = await seedInstrument({ symbol: "AA", name: "Fund A" });
      const b = await seedInstrument({ symbol: "BB", name: "Fund B" });
      const c = await seedInstrument({ symbol: "CC", name: "Fund C" });
      const fresh = await seedInstrument({ symbol: "DD", name: "Fund D" });
      for (const [instrument, raw] of [
        [a, "AA"],
        [b, "BB"],
        [c, "CC"],
        [fresh, "DD"],
      ] as const) {
        await seedInstrumentAlias({ instrument, rawString: raw });
      }
      await seedPositionSet({
        account,
        asOf: "2026-03-31",
        holdings: [
          { instrument: a, quantity: "1" },
          { instrument: b, quantity: "2" },
          { instrument: c, quantity: "3" },
        ],
      });

      const majority = await stage(ctx, account, "Symbol,Quantity,Basis\nAA,1,\n");
      const majorityDiff = await diffForDraft(majority, db);
      expect(majorityDiff.removed).toHaveLength(2);
      expect(majorityDiff.majorityRemoved).toBe(true);
      expect(majorityDiff.removesEverything).toBe(false);

      const everything = await stage(ctx, account, "Symbol,Quantity,Basis\nDD,9,\n");
      const everythingDiff = await diffForDraft(everything, db);
      expect(everythingDiff.removed).toHaveLength(3);
      expect(everythingDiff.majorityRemoved).toBe(true);
      expect(everythingDiff.removesEverything).toBe(true);
    }),
  );

  it(
    "folds two spellings of one instrument, and reports every combining on its row",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const cash = await seedInstrument({ symbol: null, name: "Cash Reserves" });
      const vtsax = await seedInstrument({ symbol: "VTSAX", name: "Vanguard Total Market Index" });
      await seedInstrumentAlias({ instrument: cash, rawString: "FCASH" });
      await seedInstrumentAlias({ instrument: cash, rawString: "CASH HELD" });
      await seedInstrumentAlias({ instrument: vtsax, rawString: "VTSAX" });

      const draftId = await stage(
        ctx,
        account,
        "Symbol,Quantity,Basis\n" +
          "FCASH,100,1.00\n" +
          "CASH HELD,50,4.00\n" +
          "VTSAX,100,10.00\n" +
          "VTSAX,200,10.00\n" +
          "VTSAX,112.5,10.00\n",
      );

      const diff = await diffForDraft(draftId, db);
      expect(diff.added).toHaveLength(2);

      const byName = new Map(diff.added.map((row) => [row.name, row]));
      expect(byName.get("Cash Reserves")).toMatchObject({
        quantity: "150.00000000",
        costBasisPerShare: "2.0000",
      });
      expect(byName.get("Cash Reserves")?.note).toMatch(/2 rows combined/);

      expect(byName.get("Vanguard Total Market Index")).toMatchObject({ quantity: "412.50000000" });
      expect(byName.get("Vanguard Total Market Index")?.note).toMatch(/3 rows combined/);
    }),
  );

  it(
    "carries the file's own date when the mapping names an as-of column",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "DTD", name: "Dated Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "DTD" });

      const draftId = await stage(
        ctx,
        account,
        "Symbol,Quantity,Basis,As of\nDTD,10,,2026-06-30\n",
        { columns: { asOf: "As of" } },
      );

      const diff = await diffForDraft(draftId, db);
      expect(diff.asOf).toEqual({ source: "file", date: "2026-06-30" });
    }),
  );

  it(
    "dims the instruments step only when the columns step found no first sighting",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "SKP", name: "Skipped-step Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "SKP" });

      const skipped = await stage(ctx, account, "Symbol,Quantity,Basis\nSKP,10,\n");
      expect((await diffForDraft(skipped, db)).instrumentsSkipped).toBe(true);

      const fresh = await seedInstrument({ symbol: "FRS", name: "Fresh Fund" });
      const visited = await stage(ctx, account, "Symbol,Quantity,Basis\nFRS FIRST SEEN,5,\n");
      await seedInstrumentAlias({ instrument: fresh, rawString: "FRS FIRST SEEN" });
      expect((await diffForDraft(visited, db)).instrumentsSkipped).toBe(false);
    }),
  );

  it(
    "sends a broken mapping back to columns and an unresolved string back to instruments",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedUploadDraft } = ctx;
      const account = await seedAccount({ kind: "brokerage" });

      const unmapped = await seedUploadDraft({
        account,
        bytes: encode("Symbol,Quantity\nX,1\n"),
      });
      await expect(diffForDraft(unmapped.id, db)).rejects.toMatchObject({
        name: "DraftNotReadyError",
        step: "columns",
      });

      const unresolved = await stage(ctx, account, "Symbol,Quantity,Basis\nNEVER SEEN,1,\n");
      await expect(diffForDraft(unresolved, db)).rejects.toMatchObject({
        name: "DraftNotReadyError",
        step: "instruments",
      });
      await expect(diffForDraft(unresolved, db)).rejects.toThrow(DraftNotReadyError);
    }),
  );
});

describe("commitUpload", () => {
  it(
    "cannot commit a legacy blank-instrument row through majority confirmation, then accepts its repair",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock" });
      const aapl = await seedInstrument({ symbol: "AAPL", name: "Apple Inc." });
      const vxus = await seedInstrument({ symbol: "VXUS", name: "Vanguard Total International" });
      for (const instrument of [vti, aapl, vxus]) {
        await seedInstrumentAlias({ instrument, rawString: instrument.symbol ?? "" });
      }
      const before = await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [
          { instrument: vti, quantity: "282.144455", costBasisPerShare: "165.4961" },
          { instrument: aapl, quantity: "139.153103", costBasisPerShare: "108.2561" },
          { instrument: vxus, quantity: "10", costBasisPerShare: "50" },
        ],
      });

      const invalidCsv =
        "Instrument,Quantity,Basis,As Of,Account\n" +
        "VTI,282.144455,165.4961,2026-09-13,Z12-345678\n" +
        ",139.153103,108.2561,2026-09-13,Z12-345678\n";
      const draft = await ctx.seedUploadDraft({
        account,
        filename: "blank-instrument.csv",
        bytes: encode(invalidCsv),
      });
      const legacyMapping: StatementMapping = {
        ...BASE_MAPPING,
        columns: {
          instrument: "Instrument",
          quantity: "Quantity",
          costBasis: "Basis",
          asOf: "As Of",
          accountNumber: "Account",
        },
      };
      await db
        .updateTable("upload_draft")
        .set({ mapping: JSON.stringify(legacyMapping), had_first_sightings: false })
        .where("id", "=", draft.id)
        .execute();

      let refusal: DraftNotReadyError | undefined;
      try {
        await commitUpload(
          draft.id,
          { accountId: account.id, confirmRemovals: "true" },
          db,
        );
      } catch (error) {
        if (error instanceof DraftNotReadyError) refusal = error;
        else throw error;
      }
      expect(refusal?.step).toBe("columns");
      expect(refusal?.problems[0]).toMatchObject({ row: 2, column: "Instrument" });
      expect((await lastRecorded(account.id, db))?.id).toBe(before.id);
      expect(await requireDraft(draft.id, db)).toMatchObject({ id: draft.id });
      expect(
        await db
          .selectFrom("position_set")
          .select("id")
          .where("account_id", "=", account.id)
          .execute(),
      ).toHaveLength(1);

      await db
        .updateTable("upload_draft")
        .set({
          raw_file: Buffer.from(invalidCsv.replace("\n,139.153103", "\nAAPL,139.153103")),
        })
        .where("id", "=", draft.id)
        .execute();
      const remapped = await rememberMapping(draft.id, legacyMapping, db);
      expect(remapped).toEqual({ nextStep: "review" });
      const repaired = await diffForDraft(draft.id, db);

      const written = await commitUpload(
        draft.id,
        {
          accountId: account.id,
          baselineSetId: repaired.baselineSetId ?? "",
          confirmRemovals: "true",
        },
        db,
      );
      expect(written.counts).toEqual({ added: 0, updated: 0, unchanged: 2, removed: 1 });
      expect((await lastRecorded(account.id, db))?.id).toBe(written.setId);
    }),
  );

  it(
    "writes the set with its holdings, deletes the draft, and every reader moves at once",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet, seedQuote } =
        ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market ETF" });
      const vxus = await seedInstrument({ symbol: "VXUS", name: "Vanguard Total International" });
      await seedInstrumentAlias({ instrument: vti, rawString: "VTI" });
      await seedInstrumentAlias({ instrument: vxus, rawString: "VXUS" });
      await seedQuote({ instrument: vti, price: "400.00" });

      const prior = await seedPositionSet({
        account,
        asOf: "2026-03-31",
        holdings: [{ instrument: vti, quantity: "100", costBasisPerShare: "380.00" }],
      });

      const draftId = await stage(
        ctx,
        account,
        "Symbol,Quantity,Basis,As of\nVTI,110,380.00,2026-06-30\nVXUS,120,,2026-06-30\n",
        { columns: { asOf: "As of" } },
      );

      const written = await commitUpload(
        draftId,
        { accountId: account.id, baselineSetId: prior.id },
        db,
      );

      expect(written.accountId).toBe(account.id);
      expect(written.asOf).toBe("2026-06-30");
      expect(written.counts).toEqual({ added: 1, updated: 1, unchanged: 0, removed: 0 });

      const set = await db
        .selectFrom("position_set")
        .selectAll()
        .where("id", "=", written.setId)
        .executeTakeFirstOrThrow();
      expect(set.source).toBe("upload");
      expect(set.as_of_date).toBe("2026-06-30");
      expect(set.source_filename).toBe(FILENAME);
      expect(set.raw_file).not.toBeNull();
      expect(Buffer.from(set.raw_file ?? []).toString("utf-8")).toContain("VXUS,120");

      const holdings = await db
        .selectFrom("holding")
        .select(["instrument_id", "quantity", "cost_basis_per_share"])
        .where("position_set_id", "=", written.setId)
        .execute();
      expect(holdings).toHaveLength(2);
      const byInstrument = new Map(holdings.map((row) => [row.instrument_id, row]));
      expect(byInstrument.get(vti.id)).toMatchObject({
        quantity: "110.00000000",
        cost_basis_per_share: "380.0000",
      });
      expect(byInstrument.get(vxus.id)).toMatchObject({
        quantity: "120.00000000",
        cost_basis_per_share: null,
      });

      await expect(requireDraft(draftId, db)).rejects.toThrow(NotFoundError);

      expect((await lastRecorded(account.id, db))?.id).toBe(written.setId);
      const current = await accountHoldings(account.id, db);
      expect(current.map((holding) => holding.quantity).sort()).toEqual([
        "110.00000000",
        "120.00000000",
      ]);
      expect((await netWorth(ALL_OWNERS, db)).amount).toBe("44000.0000");
      expect((await netWorth(ALL_OWNERS, db)).coverage).toEqual({ known: 1, total: 2 });

      await expect(
        commitUpload(draftId, { accountId: account.id }, db),
      ).rejects.toThrow(NotFoundError);
    }),
  );

  it(
    "stores a zero quantity as zero rather than dropping the row",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "ZRO", name: "Zeroed Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "ZRO" });
      await seedPositionSet({
        account,
        asOf: "2026-03-31",
        holdings: [{ instrument: fund, quantity: "12" }],
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nZRO,0,\n");

      const diff = await diffForDraft(draftId, db);
      expect(diff.updated).toHaveLength(1);
      expect(diff.updated[0]).toMatchObject({
        quantityBefore: "12.00000000",
        quantityAfter: "0",
      });
      expect(diff.removed).toHaveLength(0);

      const written = await commitUpload(
        draftId,
        { accountId: account.id, asOf: "2026-06-30", baselineSetId: diff.baselineSetId ?? "" },
        db,
      );
      const holdings = await db
        .selectFrom("holding")
        .select("quantity")
        .where("position_set_id", "=", written.setId)
        .execute();
      expect(holdings).toEqual([{ quantity: "0.00000000" }]);
    }),
  );

  it("applies nothing at all when a write fails mid-transaction", async () => {
    // Outside withDatabase: a mid-transaction fault would abort the shared transaction. Cleans up
    // manually; safe since the suite runs serially (fileParallelism: false).
    const db = await testDatabase();
    const fixtures = makeFixtures(db);
    const marker = `commit-upload-atomicity-${Date.now()}`;

    const account = await fixtures.seedAccount({ kind: "brokerage", name: marker });
    const instrument = await fixtures.seedInstrument({ symbol: null, name: marker });
    await fixtures.seedInstrumentAlias({ instrument, rawString: marker });
    const answered = `${marker}-answered`;
    const draft = await fixtures.seedUploadDraft({
      account,
      filename: "atomicity.csv",
      bytes: encode(`Symbol,Quantity,Basis\n${marker},100,\n${answered},1,\n`),
    });

    try {
      await rememberMapping(draft.id, BASE_MAPPING, db);
      // A draft answer the commit promotes before the fault — it must come back out with the rest.
      await resolveAll(
        draft.id,
        [{ raw: answered, fields: { kind: "existing", instrumentId: instrument.id } }],
        { probe: async () => new Map() },
        db,
      );

      // Account id is our own insert's — inlining it into the trigger is safe.
      await sql
        .raw(
          `create or replace function commit_upload_boom() returns trigger language plpgsql as $t$
           begin
             if exists (
               select 1 from position_set ps
               where ps.id = new.position_set_id and ps.account_id = ${account.id}
             ) then
               raise exception 'commit-upload-boom';
             end if;
             return new;
           end $t$`,
        )
        .execute(db);
      await sql
        .raw(
          "create trigger commit_upload_boom before insert on holding " +
            "for each row execute function commit_upload_boom()",
        )
        .execute(db);

      await expect(
        commitUpload(draft.id, { accountId: account.id, asOf: "2026-06-30" }, db),
      ).rejects.toThrow(/commit-upload-boom/);

      const sets = await db
        .selectFrom("position_set")
        .select("id")
        .where("account_id", "=", account.id)
        .execute();
      expect(sets).toHaveLength(0);
      await expect(requireDraft(draft.id, db)).resolves.toMatchObject({ id: draft.id });
      expect(
        await db
          .selectFrom("instrument_alias")
          .select("raw_string")
          .where("raw_string", "=", answered)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom("upload_draft_answer")
          .select("raw_string")
          .where("draft_id", "=", draft.id)
          .execute(),
      ).toEqual([{ raw_string: answered }]);
    } finally {
      await sql.raw("drop trigger if exists commit_upload_boom on holding").execute(db);
      await sql.raw("drop function if exists commit_upload_boom()").execute(db);

      const classificationId = (
        await db
          .selectFrom("instrument")
          .select("classification_id")
          .where("id", "=", instrument.id)
          .executeTakeFirst()
      )?.classification_id;

      await db.deleteFrom("upload_draft").where("account_id", "=", account.id).execute();
      await db.deleteFrom("position_set").where("account_id", "=", account.id).execute();
      await db
        .deleteFrom("instrument_alias")
        .where("raw_string", "in", [marker, answered])
        .execute();
      await db.deleteFrom("instrument").where("id", "=", instrument.id).execute();
      if (classificationId !== undefined) {
        await db.deleteFrom("classification").where("id", "=", classificationId).execute();
      }
      await db.deleteFrom("account").where("id", "=", account.id).execute();
      await db.deleteFrom("person").where("id", "=", account.ownerId).execute();
    }
  });

  it(
    "refuses the whole commit when quantity × cost basis outgrows the money column",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "BIG", name: "Big Fund" });
      const fine = await seedInstrument({ symbol: "OK", name: "Fine Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "BIG" });
      await seedInstrumentAlias({ instrument: fine, rawString: "OK" });

      // 10^9 × 10^7 = 10^16 — overflows numeric(20,4); both operands fit their own columns alone.
      const draftId = await stage(
        ctx,
        account,
        "Symbol,Quantity,Basis\nOK,1,1.00\nBIG,1000000000,10000000.00\n",
      );

      const refusal = await refusalOf(() =>
        commitUpload(draftId, { accountId: account.id, asOf: "2026-06-30" }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/Big Fund/);
      expect(refusal.fieldErrors.form).toMatch(/larger figure than this application can hold/);

      const sets = await db
        .selectFrom("position_set")
        .select("id")
        .where("account_id", "=", account.id)
        .execute();
      expect(sets).toHaveLength(0);
      await expect(requireDraft(draftId, db)).resolves.toMatchObject({ id: draftId });
    }),
  );

  it(
    "runs the same product guard against the instrument's current price",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedQuote } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "PRC", name: "Priced Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "PRC" });
      await seedQuote({ instrument: fund, price: "10000000.0000" });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nPRC,1000000000,\n");

      const refusal = await refusalOf(() =>
        commitUpload(draftId, { accountId: account.id, asOf: "2026-06-30" }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/Priced Fund/);
      expect(refusal.fieldErrors.form).toMatch(/current price/);
    }),
  );

  it(
    "refuses a file naming a different account, and says whose account the draft is against",
    withDatabase(async (ctx) => {
      const { db, seedPerson, seedAccount, seedInstrument, seedInstrumentAlias } = ctx;
      const owner = await seedPerson({ name: "Alex Rivera" });
      const account = await seedAccount({
        name: "Schwab",
        owner,
        externalAccountNumber: "8391-2245",
      });
      const apple = await seedInstrument({ symbol: "AAPL", name: "Apple Inc." });
      await seedInstrumentAlias({ instrument: apple, rawString: "AAPL" });

      const draftId = await stage(
        ctx,
        account,
        "Symbol,Quantity,Basis,Account\nAAPL,5,100.00,4407-9913\n",
        { columns: { accountNumber: "Account" } },
      );

      const refusal = await refusalOf(() =>
        commitUpload(draftId, { accountId: account.id, asOf: "2026-06-30" }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/"4407-9913"/);
      expect(refusal.fieldErrors.form).toMatch(
        /Schwab — owned by Alex Rivera — is recorded as account "8391-2245"/,
      );
    }),
  );

  it(
    "runs the same product guard against the instrument's dividend rate",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedQuote } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "PNY", name: "Penny Income Trust" });
      await seedInstrumentAlias({ instrument: fund, rawString: "PNY" });
      // Small enough that quantity×price is legal; quantity×dividend rate is what overflows (migration 0006).
      await seedQuote({
        instrument: fund,
        price: "0.0001",
        annualDividendPerShare: "1000000.0000",
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nPNY,100000000000,\n");

      const refusal = await refusalOf(() =>
        commitUpload(draftId, { accountId: account.id, asOf: "2026-06-30" }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/Penny Income Trust/);
      expect(refusal.fieldErrors.form).toMatch(/dividend rate/);

      // Uncommitted — a landed row would make holding_valued raise numeric field overflow on every read.
      const sets = await db
        .selectFrom("position_set")
        .select("id")
        .where("account_id", "=", account.id)
        .execute();
      expect(sets).toHaveLength(0);
      await expect(
        sql`select count(*) from holding_valued`.execute(db),
      ).resolves.toBeDefined();
      await expect(requireDraft(draftId, db)).resolves.toMatchObject({ id: draftId });
    }),
  );

  it(
    "refuses a file whose account number disagrees with the account's, naming both",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias } = ctx;
      const account = await seedAccount({
        kind: "brokerage",
        externalAccountNumber: "X-111",
      });
      const fund = await seedInstrument({ symbol: "GRD", name: "Guarded Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "GRD" });

      const draftId = await stage(
        ctx,
        account,
        "Symbol,Quantity,Basis,Acct\nGRD,10,,Z-999\n",
        { columns: { accountNumber: "Acct" } },
      );

      const refusal = await refusalOf(() =>
        commitUpload(draftId, { accountId: account.id, asOf: "2026-06-30" }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/Z-999/);
      expect(refusal.fieldErrors.form).toMatch(/X-111/);

      const sets = await db
        .selectFrom("position_set")
        .select("id")
        .where("account_id", "=", account.id)
        .execute();
      expect(sets).toHaveLength(0);
    }),
  );

  it(
    "refuses a file whose own rows disagree about the account number, naming both",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const one = await seedInstrument({ symbol: "IN1", name: "Intra One" });
      const two = await seedInstrument({ symbol: "IN2", name: "Intra Two" });
      await seedInstrumentAlias({ instrument: one, rawString: "IN1" });
      await seedInstrumentAlias({ instrument: two, rawString: "IN2" });

      const draftId = await stage(
        ctx,
        account,
        "Symbol,Quantity,Basis,Acct\nIN1,10,,A-111\nIN2,5,,B-222\n",
        { columns: { accountNumber: "Acct" } },
      );

      const refusal = await refusalOf(() =>
        commitUpload(draftId, { accountId: account.id, asOf: "2026-06-30" }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/A-111/);
      expect(refusal.fieldErrors.form).toMatch(/B-222/);
      expect(refusal.fieldErrors.form).toMatch(/one account/);

      const sets = await db
        .selectFrom("position_set")
        .select("id")
        .where("account_id", "=", account.id)
        .execute();
      expect(sets).toHaveLength(0);
      const stored = await db
        .selectFrom("account")
        .select("external_account_number")
        .where("id", "=", account.id)
        .executeTakeFirstOrThrow();
      expect(stored.external_account_number).toBeNull();
    }),
  );

  it(
    "commits a file whose rows agree about the account number, as before",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const one = await seedInstrument({ symbol: "AG1", name: "Agreeing One" });
      const two = await seedInstrument({ symbol: "AG2", name: "Agreeing Two" });
      await seedInstrumentAlias({ instrument: one, rawString: "AG1" });
      await seedInstrumentAlias({ instrument: two, rawString: "AG2" });

      const draftId = await stage(
        ctx,
        account,
        "Symbol,Quantity,Basis,Acct\nAG1,10,,Z-999\nAG2,5,,Z-999\n",
        { columns: { accountNumber: "Acct" } },
      );

      const written = await commitUpload(
        draftId,
        { accountId: account.id, asOf: "2026-06-30" },
        db,
      );
      expect(written.counts.added).toBe(2);
    }),
  );

  it(
    "captures the file's account number when the account has none recorded",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "CAP", name: "Captured Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "CAP" });

      const draftId = await stage(
        ctx,
        account,
        "Symbol,Quantity,Basis,Acct\nCAP,10,,Z-999\n",
        { columns: { accountNumber: "Acct" } },
      );

      await commitUpload(draftId, { accountId: account.id, asOf: "2026-06-30" }, db);

      const stored = await db
        .selectFrom("account")
        .select("external_account_number")
        .where("id", "=", account.id)
        .executeTakeFirstOrThrow();
      expect(stored.external_account_number).toBe("Z-999");
    }),
  );

  it(
    "refuses a closed account in setBalance's words, before anything else",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "CLS", name: "Closed-off Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "CLS" });
      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nCLS,10,\n");

      await closeAccount(account.id, { confirmClose: "true" }, db);

      const refusal = await refusalOf(() =>
        commitUpload(draftId, { accountId: account.id, asOf: "2026-06-30" }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/closed account's history does not change/);

      const sets = await db
        .selectFrom("position_set")
        .select("id")
        .where("account_id", "=", account.id)
        .execute();
      expect(sets).toHaveLength(0);
    }),
  );

  it(
    "refuses an unticked majority removal in the ratio's words, writing nothing",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const a = await seedInstrument({ symbol: "MA", name: "Majority A" });
      const b = await seedInstrument({ symbol: "MB", name: "Majority B" });
      const c = await seedInstrument({ symbol: "MC", name: "Majority C" });
      for (const [instrument, raw] of [
        [a, "MA"],
        [b, "MB"],
        [c, "MC"],
      ] as const) {
        await seedInstrumentAlias({ instrument, rawString: raw });
      }
      await seedPositionSet({
        account,
        asOf: "2026-03-31",
        holdings: [
          { instrument: a, quantity: "1" },
          { instrument: b, quantity: "2" },
          { instrument: c, quantity: "3" },
        ],
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nMA,1,\n");
      const baselineSetId = (await diffForDraft(draftId, db)).baselineSetId ?? "";

      const refusal = await refusalOf(() =>
        commitUpload(draftId, { accountId: account.id, asOf: "2026-06-30", baselineSetId }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(
        /removes 2 of the 3 positions this account holds/,
      );

      const sets = await db
        .selectFrom("position_set")
        .select("id")
        .where("account_id", "=", account.id)
        .execute();
      expect(sets).toHaveLength(1);

      const written = await commitUpload(
        draftId,
        { accountId: account.id, asOf: "2026-06-30", baselineSetId, confirmRemovals: "true" },
        db,
      );
      expect(written.counts.removed).toBe(2);
      expect((await lastRecorded(account.id, db))?.id).toBe(written.setId);
    }),
  );

  it(
    "asks for the tick strictly past half — exactly half commits without one",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const funds = [];
      for (const symbol of ["HF1", "HF2", "HF3", "HF4"]) {
        const fund = await seedInstrument({ symbol, name: `Half ${symbol}` });
        await seedInstrumentAlias({ instrument: fund, rawString: symbol });
        funds.push(fund);
      }
      const prior = await seedPositionSet({
        account,
        asOf: "2026-03-31",
        holdings: funds.map((fund) => ({ instrument: fund, quantity: "1" })),
      });

      const majority = await stage(ctx, account, "Symbol,Quantity,Basis\nHF1,1,\n");
      const refusal = await refusalOf(() =>
        commitUpload(
          majority,
          { accountId: account.id, asOf: "2026-06-30", baselineSetId: prior.id },
          db,
        ),
      );
      expect(refusal.fieldErrors.form).toMatch(/removes 3 of the 4 positions/);

      const half = await stage(ctx, account, "Symbol,Quantity,Basis\nHF1,1,\nHF2,1,\n");
      expect((await diffForDraft(half, db)).majorityRemoved).toBe(false);
      const written = await commitUpload(
        half,
        { accountId: account.id, asOf: "2026-06-30", baselineSetId: prior.id },
        db,
      );
      expect(written.counts.removed).toBe(2);
    }),
  );

  it(
    "says a file that removes everything in those words",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const held = await seedInstrument({ symbol: "H1", name: "Held One" });
      const heldToo = await seedInstrument({ symbol: "H2", name: "Held Two" });
      const incoming = await seedInstrument({ symbol: "NW", name: "New One" });
      for (const [instrument, raw] of [
        [held, "H1"],
        [heldToo, "H2"],
        [incoming, "NW"],
      ] as const) {
        await seedInstrumentAlias({ instrument, rawString: raw });
      }
      const prior = await seedPositionSet({
        account,
        asOf: "2026-03-31",
        holdings: [
          { instrument: held, quantity: "1" },
          { instrument: heldToo, quantity: "2" },
        ],
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nNW,5,\n");

      const refusal = await refusalOf(() =>
        commitUpload(
          draftId,
          { accountId: account.id, asOf: "2026-06-30", baselineSetId: prior.id },
          db,
        ),
      );
      expect(refusal.fieldErrors.form).toMatch(
        /removes every position this account holds — all 2\./,
      );
    }),
  );

  it(
    "uses the file's own date and does not consult a posted one",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "DTF", name: "Dated Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "DTF" });

      const draftId = await stage(
        ctx,
        account,
        "Symbol,Quantity,Basis,As of\nDTF,10,,2026-06-30\n",
        { columns: { asOf: "As of" } },
      );

      const written = await commitUpload(
        draftId,
        { accountId: account.id, asOf: "2020-01-01" },
        db,
      );
      expect(written.asOf).toBe("2026-06-30");

      const set = await db
        .selectFrom("position_set")
        .select("as_of_date")
        .where("id", "=", written.setId)
        .executeTakeFirstOrThrow();
      expect(set.as_of_date).toBe("2026-06-30");
    }),
  );

  it(
    "requires a valid recorded date when the file does not date itself",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "UND", name: "Undated Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "UND" });
      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nUND,10,\n");

      const missing = await refusalOf(() =>
        commitUpload(draftId, { accountId: account.id }, db),
      );
      expect(missing.fieldErrors.asOf).toMatch(/required/);

      // recordedDate's rule: a far-future date would pin the account for a century.
      const future = await refusalOf(() =>
        commitUpload(draftId, { accountId: account.id, asOf: "2126-01-01" }, db),
      );
      expect(future.fieldErrors.asOf).toMatch(/future/);

      const written = await commitUpload(
        draftId,
        { accountId: account.id, asOf: "2026-06-30" },
        db,
      );
      expect(written.asOf).toBe("2026-06-30");
    }),
  );

  it(
    "lets a second upload for an already-recorded date win by the existing tie-break",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const fund = await seedInstrument({ symbol: "TIE", name: "Tie-broken Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "TIE" });

      const first = await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: fund, quantity: "10" }],
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nTIE,12,\n");
      const written = await commitUpload(
        draftId,
        { accountId: account.id, asOf: "2026-06-30", baselineSetId: first.id },
        db,
      );

      expect(written.setId).not.toBe(first.id);
      expect((await lastRecorded(account.id, db))?.id).toBe(written.setId);
      const holdings = await accountHoldings(account.id, db);
      expect(holdings.map((holding) => holding.quantity)).toEqual(["12.00000000"]);
    }),
  );
});

describe("uploadReceipt", () => {
  it(
    "recomputes the counts for the account's latest set, and only for it",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const other = await seedAccount({ kind: "brokerage" });
      const a = await seedInstrument({ symbol: "RA", name: "Receipt A" });
      const b = await seedInstrument({ symbol: "RB", name: "Receipt B" });
      const c = await seedInstrument({ symbol: "RC", name: "Receipt C" });
      for (const [instrument, raw] of [
        [a, "RA"],
        [b, "RB"],
        [c, "RC"],
      ] as const) {
        await seedInstrumentAlias({ instrument, rawString: raw });
      }

      const prior = await seedPositionSet({
        account,
        asOf: "2026-03-31",
        holdings: [
          { instrument: a, quantity: "10" },
          { instrument: c, quantity: "5" },
        ],
      });
      await seedPositionSet({
        account: other,
        asOf: "2026-03-31",
        holdings: [{ instrument: a, quantity: "1" }],
      });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nRA,12,\nRB,3,\n");
      const written = await commitUpload(
        draftId,
        { accountId: account.id, asOf: "2026-06-30", baselineSetId: prior.id },
        db,
      );

      // Holding count is the set's own rows, not a URL claim (brief §6.5).
      const receiptFor = (acct: string, setId: string) =>
        lastRecorded(acct, db).then((latest) => uploadReceipt(acct, setId, latest, db));
      const receipt = await receiptFor(account.id, written.setId);
      expect(receipt).toMatchObject({
        setId: written.setId,
        asOf: "2026-06-30",
        filename: FILENAME,
        firstStatement: false,
        counts: { added: 1, updated: 1, unchanged: 0, removed: 1 },
        holdingCount: 2,
        isCurrent: true,
        currentAsOf: "2026-06-30",
      });

      // The set the account owns but no longer reads gets a receipt of its own now (#181) —
      // not null, since the household still needs telling, just not the current one.
      expect(await receiptFor(account.id, prior.id)).toMatchObject({
        setId: prior.id,
        asOf: "2026-03-31",
        isCurrent: false,
        currentAsOf: "2026-06-30",
      });
      expect(await receiptFor(other.id, written.setId)).toBeNull();
      expect(await receiptFor(account.id, "abc")).toBeNull();
    }),
  );

  it(
    "reads a set with no predecessor as a first statement",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias } = ctx;
      const account = await seedAccount({ kind: "401k" });
      const fund = await seedInstrument({ symbol: "FS", name: "First Statement Fund" });
      await seedInstrumentAlias({ instrument: fund, rawString: "FS" });

      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nFS,14,\n");
      const written = await commitUpload(
        draftId,
        { accountId: account.id, asOf: "2026-06-30" },
        db,
      );

      const receiptFor = (acct: string, setId: string) =>
        lastRecorded(acct, db).then((latest) => uploadReceipt(acct, setId, latest, db));
      const receipt = await receiptFor(account.id, written.setId);
      expect(receipt).toMatchObject({
        firstStatement: true,
        counts: { added: 1, updated: 0, unchanged: 0, removed: 0 },
        holdingCount: 1,
      });
    }),
  );

  it(
    "yields no receipt for a manually-typed set reached by a hand-edited ?uploaded=",
    withDatabase(async (ctx) => {
      const { db, seedAccount } = ctx;
      const account = await seedAccount({ kind: "bank" });

      // The relaxed gate (#181) only widens what counts as "recorded"; it must not describe a
      // typed balance as a statement.
      const written = await setBalance(account.id, { amount: "500.00", asOf: "2026-06-30" }, db);
      const set = await db
        .selectFrom("position_set")
        .select("id")
        .where("account_id", "=", account.id)
        .executeTakeFirstOrThrow();

      const receipt = await uploadReceipt(
        account.id,
        set.id,
        await lastRecorded(account.id, db),
        db,
      );
      expect(receipt).toBeNull();
      expect(written.asOf).toBe("2026-06-30"); // sanity: the balance really did land
    }),
  );
});

// Issue #291: a draft's first-sighting answers become vocabulary with the commit, never before.
describe("commitUpload — the draft's answers", () => {
  const noProbe = { probe: async () => new Map() };

  it(
    "promotes the draft's answers to vocabulary, so the next draft asks nothing about them",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedUploadDraft } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nQAALIAS,1,10.00\n");

      await resolveAll(
        draftId,
        [{ raw: "QAALIAS", fields: { kind: "existing", instrumentId: vti.id } }],
        noProbe,
        db,
      );
      const written = await commitUpload(draftId, { accountId: account.id, asOf: "2026-06-30" }, db);

      expect(
        await db
          .selectFrom("instrument_alias")
          .selectAll()
          .where("raw_string", "=", "QAALIAS")
          .execute(),
      ).toEqual([{ raw_string: "QAALIAS", instrument_id: vti.id }]);
      // The draft went with its commit, and its answers with the draft.
      expect(await db.selectFrom("upload_draft_answer").select("draft_id").execute()).toEqual([]);

      const holdings = await db
        .selectFrom("holding")
        .select(["instrument_id", "quantity"])
        .where("position_set_id", "=", written.setId)
        .execute();
      expect(holdings).toEqual([{ instrument_id: vti.id, quantity: "1.00000000" }]);

      const next = await seedUploadDraft({ account });
      expect(await unresolvedStrings(["QAALIAS"], next.id, db)).toEqual([]);
    }),
  );

  it(
    "promotes only the strings the recorded statement names",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const vti = await seedInstrument({ symbol: "VTI" });
      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nQAALIAS,1,10.00\n");

      // An answer for a string the file no longer states — mapped away after it was given.
      await resolveAll(
        draftId,
        [
          { raw: "QAALIAS", fields: { kind: "existing", instrumentId: vti.id } },
          { raw: "MAPPED AWAY", fields: { kind: "existing", instrumentId: vti.id } },
        ],
        noProbe,
        db,
      );
      await commitUpload(draftId, { accountId: account.id, asOf: "2026-06-30" }, db);

      const vocabulary = await db
        .selectFrom("instrument_alias")
        .select("raw_string")
        .orderBy("raw_string")
        .execute();
      expect(vocabulary.map((row) => row.raw_string)).toEqual(["QAALIAS"]);
    }),
  );

  it(
    "keeps a vocabulary row over the draft's answer, recording the holding under it",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const vti = await seedInstrument({ symbol: "VTI" });
      const vxus = await seedInstrument({ symbol: "VXUS" });
      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nQAALIAS,1,10.00\n");

      await resolveAll(
        draftId,
        [{ raw: "QAALIAS", fields: { kind: "existing", instrumentId: vxus.id } }],
        noProbe,
        db,
      );
      // Another upload recorded the same string first.
      await seedInstrumentAlias({ instrument: vti, rawString: "QAALIAS" });

      const written = await commitUpload(draftId, { accountId: account.id, asOf: "2026-06-30" }, db);

      expect(
        await db
          .selectFrom("instrument_alias")
          .selectAll()
          .where("raw_string", "=", "QAALIAS")
          .execute(),
      ).toEqual([{ raw_string: "QAALIAS", instrument_id: vti.id }]);
      const holdings = await db
        .selectFrom("holding")
        .select("instrument_id")
        .where("position_set_id", "=", written.setId)
        .execute();
      expect(holdings).toEqual([{ instrument_id: vti.id }]);
    }),
  );

  it(
    "promotes nothing for a commit the guards refuse",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });
      const vti = await seedInstrument({ symbol: "VTI" });
      const bnd = await seedInstrument({ symbol: "BND" });
      const aapl = await seedInstrument({ symbol: "AAPL" });
      await seedInstrumentAlias({ instrument: bnd, rawString: "BND" });
      await seedInstrumentAlias({ instrument: aapl, rawString: "AAPL" });
      const prior = await seedPositionSet({
        account,
        asOf: "2026-03-31",
        holdings: [
          { instrument: bnd, quantity: "10" },
          { instrument: aapl, quantity: "10" },
        ],
      });
      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nQAALIAS,1,10.00\n");
      await resolveAll(
        draftId,
        [{ raw: "QAALIAS", fields: { kind: "existing", instrumentId: vti.id } }],
        noProbe,
        db,
      );

      // Removes both current positions: refused until the removals are confirmed.
      const refusal = await refusalOf(() =>
        commitUpload(
          draftId,
          { accountId: account.id, asOf: "2026-06-30", baselineSetId: prior.id },
          db,
        ),
      );
      expect(refusal.fieldErrors.form).toMatch(/removes every position/);

      expect(
        await db
          .selectFrom("instrument_alias")
          .select("raw_string")
          .where("raw_string", "=", "QAALIAS")
          .execute(),
      ).toEqual([]);
      expect(await db.selectFrom("upload_draft_answer").select("raw_string").execute()).toEqual([
        { raw_string: "QAALIAS" },
      ]);
    }),
  );
});

// Outside withDatabase, as the atomicity test above: a refusal thrown inside the commit's
// transaction has to roll the promotion back for real, and the shared transaction would keep it.
// `move` is the SQL another party runs in the gap between the review's diff and the write,
// played by a trigger on the draft's own delete; `VTI`, `BND` and `MARKER` are substituted.
async function commitWhileVocabularyMoves(move: string): Promise<ValidationError> {
  const db = await testDatabase();
  const fixtures = makeFixtures(db);
  const marker = `commit-upload-moved-${Date.now()}`;

  const account = await fixtures.seedAccount({ kind: "brokerage", name: marker });
  const vti = await fixtures.seedInstrument({ symbol: null, name: `${marker} VTI` });
  const bnd = await fixtures.seedInstrument({ symbol: null, name: `${marker} BND` });
  const draft = await fixtures.seedUploadDraft({
    account,
    filename: "moved.csv",
    bytes: encode(`Symbol,Quantity,Basis\n${marker},1,\n`),
  });

  try {
    await rememberMapping(draft.id, BASE_MAPPING, db);
    await resolveAll(
      draft.id,
      [{ raw: marker, fields: { kind: "existing", instrumentId: vti.id } }],
      { probe: async () => new Map() },
      db,
    );

    // Ids are our own inserts' — safe to inline.
    const body = move
      .replaceAll("VTI", vti.id)
      .replaceAll("BND", bnd.id)
      .replaceAll("MARKER", marker);
    await sql
      .raw(
        `create or replace function commit_upload_move() returns trigger language plpgsql as $t$
         begin
           ${body};
           return old;
         end $t$`,
      )
      .execute(db);
    await sql
      .raw(
        "create trigger commit_upload_move before delete on upload_draft " +
          "for each row execute function commit_upload_move()",
      )
      .execute(db);

    const refusal = await refusalOf(() =>
      commitUpload(draft.id, { accountId: account.id, asOf: "2026-06-30" }, db),
    );

    const sets = await db
      .selectFrom("position_set")
      .select("id")
      .where("account_id", "=", account.id)
      .execute();
    expect(sets).toHaveLength(0);
    await expect(requireDraft(draft.id, db)).resolves.toMatchObject({ id: draft.id });
    // The promotion came back out with everything else.
    expect(
      await db
        .selectFrom("instrument_alias")
        .select("instrument_id")
        .where("raw_string", "=", marker)
        .execute(),
    ).toEqual([]);

    return new ValidationError({
      form: (refusal.fieldErrors.form ?? "")
        .replaceAll(`${marker} BND`, "BND")
        .replaceAll(marker, "MARKER"),
    });
  } finally {
    await sql.raw("drop trigger if exists commit_upload_move on upload_draft").execute(db);
    await sql.raw("drop function if exists commit_upload_move()").execute(db);

    const classificationIds = (
      await db
        .selectFrom("instrument")
        .select("classification_id")
        .where("id", "in", [vti.id, bnd.id])
        .execute()
    ).map((row) => row.classification_id);

    await db.deleteFrom("upload_draft").where("account_id", "=", account.id).execute();
    await db.deleteFrom("position_set").where("account_id", "=", account.id).execute();
    await db.deleteFrom("instrument_alias").where("raw_string", "=", marker).execute();
    await db.deleteFrom("instrument").where("id", "in", [vti.id, bnd.id]).execute();
    if (classificationIds.length > 0) {
      await db.deleteFrom("classification").where("id", "in", classificationIds).execute();
    }
    await db.deleteFrom("account").where("id", "=", account.id).execute();
    await db.deleteFrom("person").where("id", "=", account.ownerId).execute();
  }
}

describe("commitUpload — vocabulary moving under the review", () => {
  it("refuses when another upload recorded the string as something else, promotion too", async () => {
    const refusal = await commitWhileVocabularyMoves(
      "update instrument_alias set instrument_id = BND where raw_string = 'MARKER'",
    );
    expect(refusal.fieldErrors.form).toBe(
      '"MARKER" now means BND — recorded by another upload or repointed under Settings while ' +
        "this review was open, so nothing was recorded. Reload the review and check what it is " +
        "about to record.",
    );
  });

  it("refuses when Settings forgot the string, so the reloaded review asks again", async () => {
    const refusal = await commitWhileVocabularyMoves(
      "delete from instrument_alias where raw_string = 'MARKER'",
    );
    expect(refusal.fieldErrors.form).toBe(
      '"MARKER" was forgotten under Settings while this review was open, so nothing was ' +
        "recorded. Reload the review — it will ask what the name means.",
    );
  });
});
