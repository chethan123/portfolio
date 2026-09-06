// Where a figure is rounded on its way in, and what that costs. Two folds run on ingest — parseStatement folds rows
// sharing a raw spelling, assembleDiff folds spellings resolving to one instrument — the second over figures the first
// already rounded, so unless the exact numerator carries across, the flow computes an average of averages (200k random
// two-spelling files put the divergence at 16.6%, worst case $0.51 on one cost basis, flowing into unrealized/gains/tax).
// The other half is costBasisIs: "total" — the one lossy op on a figure read straight off a statement, never DB-tested before.
import { afterAll, describe, expect, it } from "vitest";

import { foldLots, parseStatement } from "~/lib/statement";
import { commitUpload, diffForDraft, rememberMapping } from "~/lib/uploads.server";
import { accountHoldings } from "~/lib/valuation.server";

import { closeTestDatabase, withDatabase } from "../support/database.ts";

import type { TestContext } from "../support/database.ts";
import type { StatementMapping } from "~/lib/statement";

afterAll(closeTestDatabase);

const encode = (text: string) => new TextEncoder().encode(text);

describe("folding a position twice", () => {
  // Two spellings, AAA (1@10.00, 1@20.00) and BBB (2@30.00, 5@40.00). True weighted average over all four lots:
  // (1×10+1×20+2×30+5×40)/9 = 290/9 = 32.2222…. Folding separately first (AAA→15.0000 exact, BBB→260/7=37.1429, rounded)
  // then folding those results multiplies the dropped 0.0000004 back up by 7 shares, landing on 32.2223 — wrong by a
  // hundredth of a cent, from an operation nobody asked to be approximate.
  const AAA = [
    { quantity: "1.00000000", costBasisPerShare: "10.00" },
    { quantity: "1.00000000", costBasisPerShare: "20.00" },
  ];
  const BBB = [
    { quantity: "2.00000000", costBasisPerShare: "30.00" },
    { quantity: "5.00000000", costBasisPerShare: "40.00" },
  ];

  it("gives the same answer as folding it once", () => {
    const staged = foldLots([foldLots(AAA), foldLots(BBB)]);
    const flat = foldLots([...AAA, ...BBB]);

    expect(staged.costBasisPerShare).toBe(flat.costBasisPerShare);
    expect(flat.costBasisPerShare).toBe("32.2222"); // the true weighted average, not either rounding of it
    expect(staged.quantity).toBe("9.00000000");
  });

  it("stays exact however many times a position is folded on its way through", () => {
    // Nothing folds three deep today; this guards a later step that does from reintroducing the average of averages.
    const CCC = [
      { quantity: "3.00000000", costBasisPerShare: "70.00" },
      { quantity: "11.00000000", costBasisPerShare: "13.00" },
    ];

    const staged = foldLots([foldLots([foldLots(AAA), foldLots(BBB)]), foldLots(CCC)]);
    const flat = foldLots([...AAA, ...BBB, ...CCC]);

    expect(staged.costBasisPerShare).toBe(flat.costBasisPerShare);
  });

  it("carries the sign when the mapping reads the file's quantities as owed", () => {
    // owedAsPositive negates after weighting; numerator (basis × quantity) must flip with it, or dividing by the
    // negated quantity reports a liability's cost as a credit.
    const rows = [
      ["Symbol", "Quantity", "Basis"],
      ["LOAN", "100", "1.00"],
      ["LOAN", "300", "3.00"],
    ];
    const mapping: StatementMapping = {
      headerRow: 0,
      delimiter: ",",
      columns: { instrument: "Symbol", quantity: "Quantity", costBasis: "Basis" },
      costBasisIs: "per_share",
      owedAsPositive: true,
      combineDuplicateRows: true,
    };

    const parsed = parseStatement(rows, mapping);
    const position = parsed.positions[0];

    expect(position?.quantity).toBe("-400.00000000");
    expect(position?.costBasisPerShare).toBe("2.5000"); // (100×1+300×3)/400, positive
  });
});

// A draft parked at review. `vocabulary` is planted as aliases first — review refuses a draft still carrying a first sighting.
async function stage(
  ctx: Pick<
    TestContext,
    "db" | "seedAccount" | "seedUploadDraft" | "seedInstrument" | "seedInstrumentAlias"
  >,
  csv: string,
  mapping: StatementMapping,
  vocabulary: ReadonlyArray<{ raw: string; symbol?: string; price?: string }> = [],
): Promise<{ draftId: string; accountId: string }> {
  const account = await ctx.seedAccount({ kind: "brokerage" });

  for (const { raw, symbol } of vocabulary) {
    const instrument = await ctx.seedInstrument({ symbol: symbol ?? raw });
    await ctx.seedInstrumentAlias({ instrument, rawString: raw });
  }

  const draft = await ctx.seedUploadDraft({
    account,
    filename: "Positions.csv",
    bytes: encode(csv),
  });

  const outcome = await rememberMapping(draft.id, mapping, ctx.db);
  if ("problems" in outcome) {
    throw new Error(
      `This fixture's mapping does not parse its own file: ${outcome.problems
        .map((problem) => problem.message)
        .join(" ")}`,
    );
  }

  return { draftId: draft.id, accountId: account.id };
}

const TOTAL_BASIS: StatementMapping = {
  headerRow: 0,
  delimiter: ",",
  columns: { instrument: "Symbol", quantity: "Quantity", costBasis: "Total Cost" },
  costBasisIs: "total",
  owedAsPositive: false,
  combineDuplicateRows: true,
};

describe("a statement that states the position's cost rather than the share's", () => {
  it(
    "divides once, and stores a per-share figure the money column can hold",
    withDatabase(async (ctx) => {
      // $100.00/3 shares = 33.333…, stored as 33.3333 (4 places) — cost reads back as 99.9999, a hundredth of a cent short.
      // Real cost of dividing into a fixed-scale column; the stated total is genuinely not recoverable.
      const { draftId, accountId } = await stage(
        ctx,
        ["Symbol,Quantity,Total Cost", "VTI,3,100.00"].join("\n"),
        TOTAL_BASIS,
        [{ raw: "VTI" }],
      );

      const diff = await diffForDraft(draftId, ctx.db);
      expect(diff.added[0]?.costBasisPerShare).toBe("33.3333");

      await commitUpload(draftId, { accountId, asOf: "2026-06-30" }, ctx.db);

      const [held] = await accountHoldings(accountId, ctx.db);
      expect(held?.costBasisPerShare).toBe("33.3333");
      expect(held?.costBasis).toBe("99.9999"); // SQL: quantity × stored per-share figure — where the hundredth of a cent shows up
    }),
  );

  it(
    "keeps a short lot's cost positive while its quantity is negative",
    withDatabase(async (ctx) => {
      // Borrowed position: quantity negative, stated total is what it cost, so per-share must come back positive —
      // dividing without minding the sign reports a credit instead, flipping unrealized. Uncovered before this test.
      const { draftId, accountId } = await stage(
        ctx,
        ["Symbol,Quantity,Total Cost", "TSLA,-10,-2500.00"].join("\n"),
        TOTAL_BASIS,
        [{ raw: "TSLA" }],
      );

      const diff = await diffForDraft(draftId, ctx.db);
      // Unfolded row keeps the file's own spelling; formatQuantity trims either representation to the same on-screen value.
      expect(diff.added[0]?.quantity).toBe("-10");
      expect(diff.added[0]?.costBasisPerShare).toBe("250.0000");

      await commitUpload(draftId, { accountId, asOf: "2026-06-30" }, ctx.db);

      const [held] = await accountHoldings(accountId, ctx.db);
      expect(held?.quantity).toBe("-10.00000000");
      expect(held?.costBasisPerShare).toBe("250.0000");
      expect(held?.costBasis).toBe("-2500.0000");
    }),
  );
});

describe("the value shown on the review screen", () => {
  it(
    "is the figure the account reports once the statement lands",
    withDatabase(async (ctx) => {
      // Review computes Value in JS (no holding_valued row yet to compute it in SQL) — the one place the view's
      // multiplication is written twice (valueAt, uploads.server.ts), previously only tested with a terminating product.
      // 1.23456789 × 81.1111 lands past 4 places, so both implementations must round the same way.
      const instrument = await ctx.seedInstrument({ symbol: "VTI" });
      await ctx.seedQuote({ instrument, price: "81.1111" });
      await ctx.seedInstrumentAlias({ instrument, rawString: "VTI" });

      const { draftId, accountId } = await stage(
        ctx,
        ["Symbol,Quantity", "VTI,1.23456789"].join("\n"),
        {
          headerRow: 0,
          delimiter: ",",
          columns: { instrument: "Symbol", quantity: "Quantity" },
          costBasisIs: "per_share",
          owedAsPositive: false,
          combineDuplicateRows: true,
        },
      );

      const shown = (await diffForDraft(draftId, ctx.db)).added[0]?.value;

      await commitUpload(draftId, { accountId, asOf: "2026-06-30" }, ctx.db);
      const [held] = await accountHoldings(accountId, ctx.db);

      expect(shown).toBe(held?.value);
      expect(shown).toBe("100.1372");
    }),
  );
});
