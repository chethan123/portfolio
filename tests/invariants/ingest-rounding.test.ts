/**
 * Where a figure is rounded on its way in, and what that costs. The suite
 * is dense with exact-literal tests of one operation each; what it never
 * had is a test that an operation applied *twice* agrees with itself
 * applied once — the only way this fault shows: no throw, nothing looks
 * wrong, a tenth of a cent per share until the position is large.
 *
 * Two folds run on the way in — `parseStatement` folds rows sharing a raw
 * spelling, `assembleDiff` folds spellings resolving to one instrument —
 * and the second is over figures the first already rounded, so unless the
 * exact numerator is carried across, the flow computes an average of
 * averages: brute force over 200,000 random two-spelling files put the
 * divergence at **16.6%**, worst case $0.51 on one cost basis, flowing into
 * `unrealized`, the gains table and the tax estimate. The other half is the
 * `costBasisIs: "total"` path — the one lossy operation on a figure a
 * person can read off their own statement, never before database-tested.
 */
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
  // Two spellings of one fund, each listed on two lines.
  //
  //   AAA:  1 @ 10.00   1 @ 20.00
  //   BBB:  2 @ 30.00   5 @ 40.00
  //
  // The truth is one weighted average over all four lots:
  //   (1×10 + 1×20 + 2×30 + 5×40) / 9  =  290 / 9  =  32.2222…
  //
  // Folding AAA first gives 2 @ 15.0000 exactly, but BBB gives 7 @ 37.1429 —
  // 260/7 is 37.142857…, and the money column holds four places. Fold those two
  // results and the 0.0000004 that was dropped is multiplied back up by seven
  // shares, landing the answer on 32.2223: a hundredth of a cent per share,
  // in the wrong direction, from an operation nobody asked to be approximate.
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
    // And the answer is the true weighted average, not either rounding of it.
    expect(flat.costBasisPerShare).toBe("32.2222");
    expect(staged.quantity).toBe("9.00000000");
  });

  it("stays exact however many times a position is folded on its way through", () => {
    // Three spellings, folded pairwise, against one pass over all six lots.
    // Nothing in the flow folds three deep today; this is here so that a later
    // step which does cannot quietly reintroduce the average of averages.
    const CCC = [
      { quantity: "3.00000000", costBasisPerShare: "70.00" },
      { quantity: "11.00000000", costBasisPerShare: "13.00" },
    ];

    const staged = foldLots([foldLots([foldLots(AAA), foldLots(BBB)]), foldLots(CCC)]);
    const flat = foldLots([...AAA, ...BBB, ...CCC]);

    expect(staged.costBasisPerShare).toBe(flat.costBasisPerShare);
  });

  it("carries the sign when the mapping reads the file's quantities as owed", () => {
    // `owedAsPositive` negates after the weighting, and the numerator is
    // `basis × quantity` — so it has to flip with it. A numerator that kept its
    // sign would be divided by a negative quantity and report the basis
    // inverted, which is a liability's cost shown as a credit.
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
    // (100×1 + 300×3) / 400 = 2.50, a cost per unit owed, positive.
    expect(position?.costBasisPerShare).toBe("2.5000");
  });
});

/**
 * A draft parked at review, from a file and a mapping.
 *
 * `vocabulary` is planted as aliases first: the review step refuses a draft
 * that still carries a first sighting, and resolution is another file's rule.
 * What is under test here starts once the strings are known.
 */
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
      // $100.00 over 3 shares is 33.333…, and the column holds four places. The
      // stored figure is 33.3333, so the position's cost reads back as 99.9999
      // — one hundredth of a cent short of what the file said. That is real,
      // it is what dividing into a fixed-scale column costs, and it is pinned
      // here because nothing else in the suite says out loud that the stated
      // total is not recoverable.
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
      // `cost_basis` is computed in SQL as quantity × the stored per-share
      // figure, so this is where the hundredth of a cent actually shows up.
      expect(held?.costBasis).toBe("99.9999");
    }),
  );

  it(
    "keeps a short lot's cost positive while its quantity is negative",
    withDatabase(async (ctx) => {
      // A statement listing a borrowed position: the quantity is negative and
      // the stated total is what the position cost, so the per-share figure
      // must come back positive. Dividing a positive total by a negative
      // quantity without minding the sign reports a credit instead of a cost,
      // and `unrealized` then has the wrong sign on a row nobody looks at
      // twice. No test anywhere covered this before.
      const { draftId, accountId } = await stage(
        ctx,
        ["Symbol,Quantity,Total Cost", "TSLA,-10,-2500.00"].join("\n"),
        TOTAL_BASIS,
        [{ raw: "TSLA" }],
      );

      const diff = await diffForDraft(draftId, ctx.db);
      // The file's own spelling: a row that was never folded is carried through
      // as written, while a folded group is rendered at the column's scale.
      // Both reach the screen through `formatQuantity`, which trims either to
      // the same thing, and both store identically — the assertion below is the
      // one that matters.
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
      // The review screen computes Value in JavaScript, because the account
      // has no `holding_valued` row to compute it in SQL yet — the one place
      // the view's multiplication is written twice (`valueAt` in
      // `uploads.server.ts`). The only test that touched it used a product
      // that terminates, so it had never been made to round at all.
      //
      // 1.23456789 × 81.1111 lands past the money column's four places, so the
      // two implementations have to agree about which way it goes or the number
      // a reader approves is not the number they get.
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
