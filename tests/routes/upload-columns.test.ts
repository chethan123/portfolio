/**
 * Step two's loader — which row the screen calls the header, and which
 * options come back chosen (ingest brief §4, §5.3). The form contract and
 * fingerprint are other files'; what lives only here is what the loader
 * decides before a reader touches anything: the header row's three-step
 * precedence, and the preselects resolved against that row's cells. Both
 * fail quietly: a precedence letting the saved mapping outrank "Re-read
 * with this header row" leaves a preambled file unmappable with no error;
 * and preselects resolve by column *name* — a column the file no longer
 * carries must come back unselected and named, because quietly taking
 * whatever sits at that position maps quantity onto a cost basis and reads
 * as a correct screen right up until the diff.
 */
import { afterAll, describe, expect, it } from "vitest";

import { loader } from "../../app/routes/upload/columns.tsx";
import { NOT_IN_FILE } from "~/lib/column-mapping.server";
import { rememberMapping } from "~/lib/uploads.server";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { args, get } from "../support/routes.ts";

import type { TestContext } from "../support/database.ts";
import type { StatementMapping } from "~/lib/statement";

afterAll(closeTestDatabase);

const encode = (text: string) => new TextEncoder().encode(text);

/**
 * An export whose first row is shaped exactly like a header and is not one —
 * a previous section's, in the same three columns. Detection picks it, because
 * its cells are unique and its width matches the rows below; the real header
 * is the row after it.
 */
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
};

/** A draft over {@link CSV}, with the columns step passed unless `mapped` is false. */
async function stageDraft(
  ctx: Pick<TestContext, "db" | "seedAccount" | "seedUploadDraft">,
  { mapped = true, institution = "Fidelity" }: StageOptions = {},
): Promise<string> {
  const account = await ctx.seedAccount({ kind: "brokerage", institution });
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

/** The screen as this request would draw it. */
function screen(draftId: string, query = "") {
  return loader(args(get(`/upload/${draftId}/columns${query}`), { draftId }));
}

describe("the header row the screen opens on", () => {
  it(
    "takes the search param first, then the draft's saved mapping, then detection",
    withDatabase(async (ctx) => {
      // Detection's own answer, with nothing saved to outrank it: the
      // header-shaped first row, which is the wrong one.
      const fresh = await stageDraft(ctx, { mapped: false, institution: "Schwab" });
      expect((await screen(fresh)).headerRow).toBe(0);

      // Returning from a later step shows what this draft saved, not what
      // detection would say all over again.
      const draftId = await stageDraft(ctx);
      expect((await screen(draftId)).headerRow).toBe(1);

      // And the reader's own instruction outranks the saved row — otherwise
      // "Re-read with this header row" is a control that does nothing on every
      // draft that has already been mapped once.
      const reread = await screen(draftId, "?header=0");
      expect(reread.headerRow).toBe(0);
      expect(reread.headerCells).toEqual(["Fund", "Units", "Basis"]);
    }),
  );

  it(
    "ignores a header param that names no row of this file, rather than mapping against nothing",
    withDatabase(async (ctx) => {
      // A hand-edited URL, or one bookmarked against a file with more rows in
      // it. Falling through to the saved row keeps the screen mappable; taking
      // the number would resolve every select against an undefined header and
      // draw six empty controls over a file that maps perfectly well.
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
      // Not the empty placeholder: "unset" and "not in this file" are
      // different answers, and only the deliberate one survives a save.
      expect(defaults.name).toBe(NOT_IN_FILE);
      expect(defaults.asOf).toBe(NOT_IN_FILE);
      expect(defaults.accountNumber).toBe(NOT_IN_FILE);

      expect(missingColumns).toEqual([]);
    }),
  );

  it(
    "leave a saved column the header on screen lacks unselected, and name it rather than take the column beside it",
    withDatabase(async (ctx) => {
      // The re-read that moves the header: the saved mapping's three columns
      // are all absent from row 0, and all three sit at the position their
      // replacement occupies — instrument was column 0 there and column 0 here
      // is "Fund". Anything resolving by position rather than by name lands on
      // it, and the screen then reads as a complete mapping of the wrong
      // columns.
      const draftId = await stageDraft(ctx);

      const { defaults, missingColumns } = await screen(draftId, "?header=0");

      expect(defaults.instrument).toBe("");
      expect(defaults.quantity).toBe("");
      expect(defaults.costBasis).toBe("");

      // Named, because the reader's next move — remap it, or mark it not in
      // this file — depends on knowing the column disappeared.
      expect(missingColumns).toEqual(["Symbol", "Quantity", "Cost Basis"]);
    }),
  );
});
