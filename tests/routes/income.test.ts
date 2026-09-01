/**
 * Income read as an owner (spec 0013, ticket 05).
 *
 * Like Analysis, this loader had no route test of its own — only the aggregate
 * invariants, which ask whether the breakdowns reconstruct the headline and
 * nothing about whose headline it is.
 *
 * The rule most likely to be got wrong here is the **weighted yield**. It is a
 * ratio of the group in view (`CONTEXT.md`), so it has to be recomputed over
 * whatever the filter left: one owner's annual dividend over the household's
 * value is a figure of nothing, and it would look entirely plausible on screen.
 */
import { afterAll, describe, expect, it } from "vitest";

import Income, { loader } from "../../app/routes/income.tsx";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { args, get, redirectTo } from "../support/routes.ts";

import type { TestContext } from "../support/database.ts";

afterAll(closeTestDatabase);

/**
 * Two owners whose yields differ, so a narrowed weighted yield is a different
 * number rather than the household's seen twice.
 *
 * Alice: 100 VTI at 250.0000 paying 2.5000 a share — 25,000.0000 of value and
 * 250.0000 a year, a 1% yield. Bob: 40 BND at 70.0000 paying 3.5000 — 2,800.0000
 * of value and 140.0000 a year, a 5% yield. The household's is neither.
 */
async function seedTwoOwners(
  ctx: Pick<
    TestContext,
    "seedPerson" | "seedAccount" | "seedInstrument" | "seedPositionSet" | "seedQuote"
  >,
) {
  const alice = await ctx.seedPerson({ name: "Alice" });
  const bob = await ctx.seedPerson({ name: "Bob" });

  const vti = await ctx.seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
  const bnd = await ctx.seedInstrument({ symbol: "BND", name: "Vanguard Total Bond" });
  await ctx.seedQuote({ instrument: vti, price: "250.0000", annualDividendPerShare: "2.5000" });
  await ctx.seedQuote({ instrument: bnd, price: "70.0000", annualDividendPerShare: "3.5000" });

  const hers = await ctx.seedAccount({
    name: "Alice Brokerage",
    owner: alice,
    kind: "brokerage",
    taxTreatment: "taxable",
  });
  const his = await ctx.seedAccount({
    name: "Bob Roth",
    owner: bob,
    kind: "ira",
    taxTreatment: "tax_free",
  });

  await ctx.seedPositionSet({
    account: hers,
    asOf: "2026-01-31",
    holdings: [{ instrument: vti, quantity: "100.00000000" }],
  });
  await ctx.seedPositionSet({
    account: his,
    asOf: "2026-01-31",
    holdings: [{ instrument: bnd, quantity: "40.00000000" }],
  });

  return { alice, bob };
}

describe("every figure narrows", () => {
  it(
    "shows one owner's annual dividend, and two owners sum to the household's",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx);
      const at = (search: string) => loader(args(get(`/income${search}`)));

      expect((await at(`?owner=${alice.id}`)).total).toBe("250.0000");
      expect((await at(`?owner=${bob.id}`)).total).toBe("140.0000");
      expect((await at("")).total).toBe("390.0000");
    }),
  );

  it(
    "recomputes the weighted yield over the narrowed set, not the household's ratio",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx);
      const at = (search: string) => loader(args(get(`/income${search}`)));

      // 250 / 25,000 and 140 / 2,800. The household's is 390 / 27,800, which is
      // neither — so a yield carried over from it would be visibly wrong here
      // and invisibly wrong on a household with less convenient numbers.
      expect((await at(`?owner=${alice.id}`)).weightedYield).toBe("0.010000");
      expect((await at(`?owner=${bob.id}`)).weightedYield).toBe("0.050000");
      expect((await at("")).weightedYield).toBe("0.014029");
    }),
  );

  it(
    "narrows the sheltered subtotal and both breakdowns",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx);
      const at = (search: string) => loader(args(get(`/income${search}`)));

      // Alice's account is taxable and Bob's is tax-free, so narrowing moves
      // the whole subtotal from one side of the sentence to the other.
      expect((await at(`?owner=${alice.id}`)).sheltered).toEqual({
        sheltered: "0.0000",
        taxable: "250.0000",
      });
      expect((await at(`?owner=${bob.id}`)).sheltered).toEqual({
        sheltered: "140.0000",
        taxable: "0.0000",
      });

      const hers = await at(`?owner=${alice.id}`);
      expect(hers.byAccount.map((slice) => slice.label)).toEqual(["Alice Brokerage"]);
      expect(hers.byTaxTreatment.map((slice) => slice.label)).toEqual(["Taxable"]);
    }),
  );
});

describe("the filter's own plumbing", () => {
  it(
    "redirects an owner parameter that is not already canonically spelled",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx);
      const ids = [alice.id, bob.id].sort((a, b) => Number(a) - Number(b));

      expect(await redirectTo(() => loader(args(get(`/income?owner=${ids[1]},${ids[0]}`))))).toBe(
        `/income?owner=${ids.join(",")}`,
      );
      expect(await redirectTo(() => loader(args(get("/income?owner="))))).toBe("/income");

      // Alice and Bob are the whole seeded household, so ticking every box is
      // the household under another name — the collapse is the second bounce
      // this loader owes the address, not only the respelling above.
      expect(await redirectTo(() => loader(args(get(`/income?owner=${ids.join(",")}`))))).toBe(
        "/income",
      );
    }),
  );

  it(
    "draws the control and names the owners in words beside the figures",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx);
      const data = await loader(args(get(`/income?owner=${alice.id}`)));
      const markup = renderRoute(Income, "/income", data);

      expect(markup).toContain('aria-label="Filter by owner"');
      expect(markup).toContain("Showing <b>Alice</b> only.");
      // The ticked box survives a re-render, so Apply cannot widen the screen
      // back to the household behind the reader's back.
      expect(markup).toContain(`id="owner-${alice.id}" type="checkbox" name="owner" checked=""`);
    }),
  );
});

describe("the three empty states", () => {
  it(
    "says nothing has been uploaded only when nothing has",
    withDatabase(async (ctx) => {
      await ctx.seedPerson({ name: "Alice" });
      const data = await loader(args(get("/income")));

      expect(renderRoute(Income, "/income", data)).toContain(
        "Nothing has been uploaded to this instance yet",
      );
    }),
  );

  it(
    "still says it on an empty instance that is being read as somebody",
    withDatabase(async (ctx) => {
      // Two people, two accounts, nothing uploaded. The roster has two names so
      // the control draws, and ticking one used to answer "Alice holds nothing
      // — everything else is still there" on an instance where nothing is.
      const alice = await ctx.seedPerson({ name: "Alice" });
      const bob = await ctx.seedPerson({ name: "Bob" });
      await ctx.seedAccount({ name: "Alice Brokerage", owner: alice });
      await ctx.seedAccount({ name: "Bob Roth", owner: bob });

      const data = await loader(args(get(`/income?owner=${alice.id}`)));

      expect(renderRoute(Income, "/income", data)).toContain(
        "Nothing has been uploaded to this instance yet",
      );
    }),
  );

  it(
    "tells an unreadable owner apart from an owner holding nothing, and keeps the control",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx);

      const unknown = await loader(args(get("/income?owner=999999999")));
      expect(unknown.unknownOwner).toBe(true);
      const unknownMarkup = renderRoute(Income, "/income", unknown);
      expect(unknownMarkup).not.toContain("There is no data yet");
      expect(unknownMarkup).toContain("no longer be read as");
      expect(unknownMarkup).toContain('aria-label="Filter by owner"');

      const empty = await ctx.seedAccount({ name: "Alice Cash", owner: alice, kind: "bank" });
      await ctx.seedPositionSet({ account: empty, asOf: "2026-02-28", holdings: [] });
      await ctx.db
        .updateTable("account")
        .set({ closed_at: new Date() })
        .where("name", "=", "Alice Brokerage")
        .execute();

      const nothing = await loader(args(get(`/income?owner=${alice.id}`)));
      expect(nothing.unknownOwner).toBe(false);
      const nothingMarkup = renderRoute(Income, "/income", nothing);
      expect(nothingMarkup).not.toContain("There is no data yet");
      expect(nothingMarkup).toContain("Alice holds nothing that has been recorded here");
      expect(nothingMarkup).toContain('aria-label="Filter by owner"');
    }),
  );
});
