/**
 * Analysis read as an owner (spec 0013, ticket 05).
 *
 * This screen had no route test at all until now — its loader was exercised
 * only through `tests/invariants/aggregates-agree.test.ts`, which asks whether
 * the slices reconstruct the total and nothing about who the total is for. The
 * filter makes that a question with a wrong answer available, so the file
 * exists.
 *
 * The rule worth stating: every panel narrows, including the one grouped by
 * owner. One owner selected leaves that panel with a single slice at 100%,
 * which is honest and useless — and is deliberately not special-cased, because
 * two owners selected is exactly the split a reader wants beside a combined
 * total (ADR-0008). The capital-gains rate is the household's and does not
 * narrow; the potential-tax figures move only because the gains they apply to
 * do.
 */
import { afterAll, describe, expect, it } from "vitest";

import Analysis, { loader } from "../../app/routes/analysis.tsx";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { args, get, outcomeOf, redirectTo } from "../support/routes.ts";

import type { TestContext } from "../support/database.ts";

afterAll(closeTestDatabase);

/**
 * Two owners with different gains, so a narrowed unrealized figure is a
 * different number rather than the same one twice.
 *
 * Alice: 100 VTI at 250.0000, bought at 180.0000 — 25,000.0000 worth, 7,000
 * unrealized. Bob: 40 BND at 70.0000, bought at 65.0000 — 2,800.0000 worth,
 * 200 unrealized.
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
  await ctx.seedQuote({ instrument: vti, price: "250.0000" });
  await ctx.seedQuote({ instrument: bnd, price: "70.0000" });

  const hers = await ctx.seedAccount({ name: "Alice Brokerage", owner: alice, kind: "brokerage" });
  const his = await ctx.seedAccount({ name: "Bob Roth", owner: bob, kind: "ira" });

  await ctx.seedPositionSet({
    account: hers,
    asOf: "2026-01-31",
    holdings: [{ instrument: vti, quantity: "100.00000000", costBasisPerShare: "180.0000" }],
  });
  await ctx.seedPositionSet({
    account: his,
    asOf: "2026-01-31",
    holdings: [{ instrument: bnd, quantity: "40.00000000", costBasisPerShare: "65.0000" }],
  });

  return { alice, bob };
}

describe("every panel narrows", () => {
  it(
    "shows one owner's figures, and two owners sum to the household's",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx);
      const at = (search: string) => loader(args(get(`/analysis${search}`)));

      expect((await at(`?owner=${alice.id}`)).total).toBe("25000.0000");
      expect((await at(`?owner=${bob.id}`)).total).toBe("2800.0000");
      expect((await at("")).total).toBe("27800.0000");
    }),
  );

  it(
    "narrows the by-owner panel too, leaving one slice at 100% rather than hiding it",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx);
      const data = await loader(args(get(`/analysis?owner=${alice.id}`)));

      // Honest and useless with one owner selected, and deliberately not
      // special-cased: two owners selected is the split a reader wants beside
      // a combined total.
      expect(data.byPerson.map((slice) => [slice.label, slice.amount])).toEqual([
        ["Alice", "25000.0000"],
      ]);
      expect(data.byAccountKind.map((slice) => slice.label)).toEqual(["Brokerage"]);
      expect(data.byAssetClass).toHaveLength(1);
      expect(data.gains.total?.unrealized).toBe("7000.0000");
    }),
  );

  it(
    "leaves the capital-gains rate alone, because it is the household's and not an owner's",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx);

      const household = await loader(args(get("/analysis")));
      const hers = await loader(args(get(`/analysis?owner=${alice.id}`)));

      expect(hers.capitalGainsRate).toBe(household.capitalGainsRate);
      // The tax figure moves only because the gains it applies to do.
      expect(hers.gains.total?.unrealized).not.toBe(household.gains.total?.unrealized);
      expect(hers.gains.total?.unrealized).toBe("7000.0000");
    }),
  );

  it(
    "renames the panel to the word the glossary uses for the role",
    withDatabase(async (ctx) => {
      await seedTwoOwners(ctx);
      const data = await loader(args(get("/analysis")));
      const markup = renderRoute(Analysis, "/analysis", data);

      // An owner is the role; a person is the record. This was the one place
      // the pre-glossary wording survived in the UI.
      expect(markup).toContain("Net worth by owner");
      expect(markup).not.toContain("Net worth by person");
      // The column heading and the count say it too, and both were mutations
      // the title assertion alone let through.
      expect(markup).toContain(">Owner</th>");
      expect(markup).toContain("2 owners");
      expect(markup).not.toContain("2 people");
    }),
  );
});

describe("the filter's own plumbing", () => {
  it(
    "redirects an owner parameter that is not already canonically spelled",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx);
      const ids = [alice.id, bob.id].sort((a, b) => Number(a) - Number(b));

      expect(await redirectTo(() => loader(args(get(`/analysis?owner=${ids[1]},${ids[0]}`))))).toBe(
        `/analysis?owner=${ids.join(",")}`,
      );
      expect(await redirectTo(() => loader(args(get("/analysis?owner="))))).toBe("/analysis");
    }),
  );

  it(
    "draws the control, and no control at all for a household with one owner",
    withDatabase(async (ctx) => {
      const alice = await ctx.seedPerson({ name: "Alice" });
      const account = await ctx.seedAccount({ name: "Only", owner: alice, kind: "bank" });
      const usd = await ctx.usdInstrument();
      await ctx.seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "100.00000000" }],
      });

      const one = await loader(args(get("/analysis")));
      expect(renderRoute(Analysis, "/analysis", one)).not.toContain('aria-label="Filter by owner"');

      await seedTwoOwners(ctx);
      const three = await loader(args(get("/analysis")));
      expect(renderRoute(Analysis, "/analysis", three)).toContain('aria-label="Filter by owner"');
    }),
  );

  it(
    "names the owners in words beside the figures, never as a chip alone",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx);
      const data = await loader(args(get(`/analysis?owner=${alice.id}`)));

      // ADR-0008 attaches this to the filter surviving navigation: a reader who
      // set it two screens ago would otherwise read a household figure that
      // quietly means something else.
      expect(renderRoute(Analysis, "/analysis", data)).toContain("Showing <b>Alice</b> only.");
    }),
  );

  it(
    "keeps the filter across its own controls",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx);
      const data = await loader(args(get(`/analysis?owner=${alice.id}`)));
      const markup = renderRoute(Analysis, "/analysis", data);

      // The box the reader ticked stays ticked, so Apply cannot silently widen
      // the screen back to the household — a GET form submits what its boxes
      // say, and an unticked one contributes nothing at all.
      expect(markup).toContain(`id="owner-${alice.id}" type="checkbox" name="owner" checked=""`);
      // And Show everyone is the one control that drops it.
      expect(markup).toContain('href="/analysis"');
    }),
  );
});

describe("the three empty states", () => {
  it(
    "says nothing has been uploaded only when nothing has",
    withDatabase(async (ctx) => {
      await ctx.seedPerson({ name: "Alice" });
      const data = await loader(args(get("/analysis")));

      expect(renderRoute(Analysis, "/analysis", data)).toContain(
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

      const data = await loader(args(get(`/analysis?owner=${alice.id}`)));

      expect(data.hasHoldings).toBe(false);
      expect(renderRoute(Analysis, "/analysis", data)).toContain(
        "Nothing has been uploaded to this instance yet",
      );
    }),
  );

  it(
    "tells an unreadable owner apart from an owner holding nothing, and keeps the control",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx);

      const unknown = await loader(args(get("/analysis?owner=999999999")));
      expect(unknown.unknownOwner).toBe(true);
      const unknownMarkup = renderRoute(Analysis, "/analysis", unknown);
      expect(unknownMarkup).not.toContain("There is no data yet");
      expect(unknownMarkup).toContain("no longer be read as");
      expect(unknownMarkup).toContain('aria-label="Filter by owner"');

      // Alice keeps an open account and holds nothing in it: still in the
      // roster, so this is not an error and must not read as one.
      const empty = await ctx.seedAccount({ name: "Alice Cash", owner: alice, kind: "bank" });
      await ctx.seedPositionSet({ account: empty, asOf: "2026-02-28", holdings: [] });
      await ctx.db
        .updateTable("account")
        .set({ closed_at: new Date() })
        .where("name", "=", "Alice Brokerage")
        .execute();

      const nothing = await loader(args(get(`/analysis?owner=${alice.id}`)));
      expect(nothing.unknownOwner).toBe(false);
      const nothingMarkup = renderRoute(Analysis, "/analysis", nothing);
      expect(nothingMarkup).not.toContain("There is no data yet");
      expect(nothingMarkup).toContain("Alice holds nothing that has been recorded here");
      expect(nothingMarkup).toContain('aria-label="Filter by owner"');
    }),
  );
});

/**
 * The invariant the loader depends on, asserted the way the loader meets it:
 * through `new Request`, so every re-encoding the URL parsing does on the way in
 * is in the picture. `tests/routes/holdings.test.ts` carries the same one and
 * the reasoning behind it — two serialisers spell `'` and `,` differently, so an
 * address can differ from its own canonical spelling forever and the screen
 * answers every request with another redirect until the browser gives up.
 */
describe("the canonical redirect settles", () => {
  // Terminates, rather than bounces exactly once: an address can legitimately
  // take two hops — spelling first, then the all-owners collapse — and what
  // must never happen is a third that is the second again. Four is generous
  // enough to prove the loop rather than to allow one.
  const settles = async (search: string): Promise<void> => {
    let where = `/analysis${search}`;
    const seen: string[] = [];

    for (let hop = 0; hop < 4; hop += 1) {
      const outcome = await outcomeOf(() => loader(args(get(where))));
      if (!(outcome instanceof Response)) return;

      seen.push(where);
      where = outcome.headers.get("Location") ?? "";
      expect({ search, revisited: seen.includes(where) }).toEqual({ search, revisited: false });
    }

    expect({ search, settled: false }).toEqual({ search, settled: true });
  };

  it(
    "in at most one hop, whatever spelled the address",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx);
      const both = [alice.id, bob.id].sort((a, b) => Number(a) - Number(b)).join(",");

      for (const search of [
        "",
        `?owner=${alice.id}`,
        `?owner=${both}`,
        // Every multi-owner URL, on any transport that has already round-tripped
        // the query through `URLSearchParams`.
        `?owner=${both.replace(",", "%2C")}`,
        // An id naming nobody, which this application keeps on purpose.
        "?owner=o%27brien",
        "?owner=o'brien",
        `?owner=${bob.id},${alice.id}`,
        `?owner=${alice.id}&owner=${bob.id}`,
        "?owner=",
      ]) {
        await settles(search);
      }
    }),
  );
});
