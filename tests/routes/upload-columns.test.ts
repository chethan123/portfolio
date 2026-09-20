// Step two's loader (ingest brief §4, §5.3): the header row's three-step precedence, and preselects resolved against
// that row's cells. Both fail quietly if wrong — wrong precedence leaves a preambled file unmappable with no error;
// preselects resolving by position instead of column name would map quantity onto cost basis and read as correct.
import { afterAll, describe, expect, it } from "vitest";

import Columns, { action, loader } from "../../app/routes/upload/columns.tsx";
import { NOT_IN_FILE, findMapping, headerFingerprint } from "~/lib/column-mapping.server";
import { parseDraft, rememberMapping, requireDraft } from "~/lib/uploads.server";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { args, get, outcomeOf, post } from "../support/routes.ts";

import type { TestContext } from "../support/database.ts";
import type { StatementMapping } from "~/lib/statement";
import type { AccountKind } from "~/lib/valuation.server";

afterAll(closeTestDatabase);

const encode = (text: string) => new TextEncoder().encode(text);

// First row is shaped exactly like a header and isn't — detection picks it since its cells are unique and its width
// matches the rows below; the real header is the row after it.
const CSV = [
  "Fund,Units,Basis",
  "Symbol,Quantity,Cost Basis",
  "VTI,100,50.25",
  "VXUS,50,40.10",
].join("\n");

/** The mapping a reader saved after choosing the second row as the header. */
const MAPPING: StatementMapping = {
  headerRow: 1,
  delimiter: ",",
  columns: { instrument: "Symbol", quantity: "Quantity", costBasis: "Cost Basis" },
  costBasisIs: "per_share",
  owedAsPositive: false,
  combineDuplicateRows: true,
};

type StageOptions = {
  /** False leaves the draft where the drop screen leaves it: bytes and nothing else. */
  mapped?: boolean;
  /** Scopes the remembered mapping, so one test's draft cannot prefill another's. */
  institution?: string;
  kind?: AccountKind;
};

/** A draft over {@link CSV}, with the columns step passed unless `mapped` is false. */
async function stageDraft(
  ctx: Pick<TestContext, "db" | "seedAccount" | "seedUploadDraft">,
  { mapped = true, institution = "Fidelity", kind = "brokerage" }: StageOptions = {},
): Promise<string> {
  const account = await ctx.seedAccount({ kind, institution });
  const draft = await ctx.seedUploadDraft({
    account,
    filename: "Positions.csv",
    bytes: encode(CSV),
  });

  if (mapped) {
    const outcome = await rememberMapping(draft.id, MAPPING, ctx.db);
    if ("problems" in outcome) {
      throw new Error("This fixture's mapping does not parse its own file.");
    }
  }

  return draft.id;
}

const postedMapping = {
  headerRow: "1",
  instrument: "Symbol",
  quantity: "Quantity",
  costBasis: "Cost Basis",
  costBasisIs: "per_share",
  owedAsPositive: "true",
};

/** The screen as this request would draw it. */
function screen(draftId: string, query = "") {
  return loader(args(get(`/upload/${draftId}/columns${query}`), { draftId }));
}

describe("the header row the screen opens on", () => {
  it(
    "takes the search param first, then the draft's saved mapping, then detection",
    withDatabase(async (ctx) => {
      // Detection's own (wrong) answer, nothing saved to outrank it.
      const fresh = await stageDraft(ctx, { mapped: false, institution: "Schwab" });
      expect((await screen(fresh)).headerRow).toBe(0);

      // Returning from a later step shows what this draft saved, not detection all over again.
      const draftId = await stageDraft(ctx);
      expect((await screen(draftId)).headerRow).toBe(1);

      // Reader's instruction outranks the saved row, or "Re-read with this header row" does nothing on a mapped draft.
      const reread = await screen(draftId, "?header=0");
      expect(reread.headerRow).toBe(0);
      expect(reread.headerCells).toEqual(["Fund", "Units", "Basis"]);
    }),
  );

  it(
    "ignores a header param that names no row of this file, rather than mapping against nothing",
    withDatabase(async (ctx) => {
      // A hand-edited or bookmarked URL — falling through to the saved row keeps the screen mappable; taking the
      // number would resolve every select against an undefined header.
      const draftId = await stageDraft(ctx);

      const past = await screen(draftId, "?header=9");
      expect(past.headerRow).toBe(1);
      expect(past.defaults.instrument).toBe("Symbol");

      expect((await screen(draftId, "?header=abc")).headerRow).toBe(1);
    }),
  );
});

describe("the preselected columns", () => {
  it(
    "come back chosen, with the deliberate-absence option where the mapping stored no column",
    withDatabase(async (ctx) => {
      const draftId = await stageDraft(ctx);

      const { defaults, missingColumns } = await screen(draftId);

      expect(defaults).toMatchObject({
        instrument: "Symbol",
        quantity: "Quantity",
        costBasis: "Cost Basis",
        costBasisIs: "per_share",
      });
      // Not the empty placeholder — "unset" and "not in this file" are different answers, only the deliberate one survives a save.
      expect(defaults.name).toBe(NOT_IN_FILE);
      expect(defaults.asOf).toBe(NOT_IN_FILE);
      expect(defaults.accountNumber).toBe(NOT_IN_FILE);

      expect(missingColumns).toEqual([]);
    }),
  );

  it(
    "leave a saved column the header on screen lacks unselected, and name it rather than take the column beside it",
    withDatabase(async (ctx) => {
      // The saved mapping's three columns are all absent from row 0, and each sits at the position its replacement
      // occupies — resolving by position would silently map the wrong columns.
      const draftId = await stageDraft(ctx);

      const { defaults, missingColumns } = await screen(draftId, "?header=0");

      expect(defaults.instrument).toBe("");
      expect(defaults.quantity).toBe("");
      expect(defaults.costBasis).toBe("");

      // Named — the reader's next move (remap, or mark not-in-file) depends on knowing the column disappeared.
      expect(missingColumns).toEqual(["Symbol", "Quantity", "Cost Basis"]);
    }),
  );
});

describe("saving a mapping", () => {
  it(
    "stays on Columns and names a blank-instrument row's populated mapped cells",
    withDatabase(async (ctx) => {
      const account = await ctx.seedAccount({ kind: "brokerage" });
      const draft = await ctx.seedUploadDraft({
        account,
        filename: "blank-instrument.csv",
        bytes: encode(
          [
            "Instrument,Quantity,Cost Basis,As Of,Account",
            "VTI,282.144455,165.4961,2026-09-13,Z12-345678",
            ",139.153103,108.2561,2026-09-13,Z12-345678",
          ].join("\n"),
        ),
      });

      const result = await action(
        args(
          post(`/upload/${draft.id}/columns`, {
            headerRow: "0",
            instrument: "Instrument",
            quantity: "Quantity",
            costBasis: "Cost Basis",
            asOf: "As Of",
            accountNumber: "Account",
            costBasisIs: "per_share",
          }),
          { draftId: draft.id },
        ),
      );

      if (result instanceof Response) throw new Error("The invalid mapping left Columns.");
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]).toMatch(/Line 3/);
      expect(result.problems[0]).toMatch(/"Quantity" and "Cost Basis"/);
      expect(result.problems[0]).not.toMatch(/"As Of"|"Account"/);
      expect(result.problemFields).toEqual(["instrument"]);

      const stored = await ctx.db
        .selectFrom("upload_draft")
        .select(["mapping", "had_first_sightings"])
        .where("id", "=", draft.id)
        .executeTakeFirstOrThrow();
      expect(stored).toEqual({ mapping: null, had_first_sightings: null });
    }),
  );

  it(
    "hides the liability sign control for an asset account but shows it checked for a liability",
    withDatabase(async (ctx) => {
      const brokerage = await stageDraft(ctx, {
        mapped: false,
        institution: "Brokerage UI",
      });
      const brokerageMarkup = renderRoute(
        Columns,
        `/upload/${brokerage}/columns`,
        await screen(brokerage),
      );
      expect(brokerageMarkup).not.toContain('name="owedAsPositive"');
      expect(brokerageMarkup).not.toContain("This file lists what is owed");

      const liability = await stageDraft(ctx, {
        mapped: false,
        institution: "Liability UI",
        kind: "liability",
      });
      const liabilityMarkup = renderRoute(
        Columns,
        `/upload/${liability}/columns`,
        await screen(liability),
      );
      expect(liabilityMarkup).toContain('name="owedAsPositive"');
      expect(liabilityMarkup).toContain('name="owedAsPositive" checked="" value="true"');
      expect(liabilityMarkup).toContain("This file lists what is owed");
    }),
  );

  it(
    "ignores a forged positive-debt flag for a brokerage in parsing and both saved mappings",
    withDatabase(async (ctx) => {
      const institution = "Forged Broker";
      const draftId = await stageDraft(ctx, { mapped: false, institution });

      const response = await outcomeOf(() =>
        action(
          args(post(`/upload/${draftId}/columns`, postedMapping), { draftId }),
        ),
      );
      expect(response).toBeInstanceOf(Response);

      const draft = await requireDraft(draftId, ctx.db);
      expect(draft.mapping).toMatchObject({ owedAsPositive: false });
      const remembered = await findMapping(
        institution,
        headerFingerprint(["Symbol", "Quantity", "Cost Basis"]),
        ctx.db,
      );
      expect(remembered?.owedAsPositive).toBe(false);

      const result = await parseDraft(draft, ctx.db);
      expect(result.step).toBe("instruments");
      if (!("parsed" in result)) throw new Error("The saved mapping did not parse.");
      expect(result.mapping.owedAsPositive).toBe(false);
      expect(result.parsed.positions[0]?.quantity).toBe("100");
    }),
  );

  it(
    "keeps the positive-debt flag and negates quantities for a liability",
    withDatabase(async (ctx) => {
      const draftId = await stageDraft(ctx, {
        mapped: false,
        institution: "Liability Parser",
        kind: "liability",
      });

      const response = await outcomeOf(() =>
        action(
          args(post(`/upload/${draftId}/columns`, postedMapping), { draftId }),
        ),
      );
      expect(response).toBeInstanceOf(Response);

      const draft = await requireDraft(draftId, ctx.db);
      expect(draft.mapping).toMatchObject({ owedAsPositive: true });
      const result = await parseDraft(draft, ctx.db);
      if (!("parsed" in result)) throw new Error("The saved mapping did not parse.");
      expect(result.mapping.owedAsPositive).toBe(true);
      expect(result.parsed.positions[0]?.quantity).toBe("-100");
    }),
  );

  it(
    "re-scopes a saved liability mapping when the account later becomes an asset",
    withDatabase(async (ctx) => {
      const account = await ctx.seedAccount({
        kind: "liability",
        institution: "Changed Kind",
      });
      const draft = await ctx.seedUploadDraft({
        account,
        filename: "Positions.csv",
        bytes: encode(CSV),
      });
      const saved = await rememberMapping(
        draft.id,
        { ...MAPPING, owedAsPositive: true },
        ctx.db,
      );
      expect(saved).not.toHaveProperty("problems");

      await ctx.db
        .updateTable("account")
        .set({ kind: "brokerage" })
        .where("id", "=", account.id)
        .executeTakeFirstOrThrow();

      const result = await parseDraft(await requireDraft(draft.id, ctx.db), ctx.db);
      if (!("parsed" in result)) throw new Error("The saved mapping did not parse.");
      expect(result.mapping.owedAsPositive).toBe(false);
      expect(result.parsed.positions[0]?.quantity).toBe("100");
    }),
  );
});
