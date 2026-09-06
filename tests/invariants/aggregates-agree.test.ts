// Where two independent queries answer one question and must not disagree (§8.2's weakest point) — pairs whose
// *shapes* genuinely differ (two SQL statements, SQL vs JS reduction, two reductions over one array) and so can
// drift under an edit unnoticed.
//
// Deliberately not asserted: netWorth and netWorthAt(…, today) disagree by design — current prices from quote.price,
// as-of from price_daily.close (0002 vs 0003). Pairing them would only pass by seeding both prices equal.
import { afterAll, describe, expect, it } from "vitest";

import { loader as analysis } from "../../app/routes/analysis.tsx";
import { loader as income } from "../../app/routes/income.tsx";
import {
  DEFAULT_DIRECTION,
  DEFAULT_SORT,
  groupHoldings,
  summarise,
} from "~/lib/holdings-view";
import {
  currentHoldings,
  netWorth,
  netWorthAt,
  netWorthSeries,
} from "~/lib/valuation.server";
import { MONEY_SCALE, toUnits } from "~/lib/money";
import { ALL_OWNERS } from "~/lib/owner-filter";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { args, get } from "../support/routes.ts";

import type { TestContext } from "../support/database.ts";

// Both loaders read the owner filter off the request (spec 0013); invariants below are household-wide, so no filter in the address.
const analysisPage = () => analysis(args(get("/analysis")));
const incomePage = () => income(args(get("/income")));

afterAll(closeTestDatabase);

/** Sum decimal strings the way the application does — exactly, never as floats. */
const sumOf = (amounts: ReadonlyArray<string>): bigint =>
  amounts.reduce((total, amount) => total + toUnits(amount, MONEY_SCALE), 0n);

// Fractional quantities against prices that don't divide into the money scale, one liability, one never-quoted holding —
// every figure below is a rounding decision, not a tidy number chosen for the test.
async function anAwkwardPortfolio(ctx: TestContext) {
  const owner = await ctx.seedPerson({ name: "Alice" });
  const brokerage = await ctx.seedAccount({ owner, kind: "brokerage", name: "Fidelity" });
  const loan = await ctx.seedAccount({ owner, kind: "liability", name: "Mortgage" });

  const vti = await ctx.seedInstrument({ symbol: "VTI" });
  const vxus = await ctx.seedInstrument({ symbol: "VXUS" });
  const unquoted = await ctx.seedInstrument({ symbol: "PRIVATE" });
  const usd = await ctx.usdInstrument();

  await ctx.seedQuote({ instrument: vti, price: "3.3333" });
  await ctx.seedQuote({ instrument: vxus, price: "77.7777" });

  await ctx.seedPositionSet({
    account: brokerage,
    asOf: "2026-06-30",
    holdings: [
      { instrument: vti, quantity: "0.33333333" },
      { instrument: vxus, quantity: "7.77777777" },
      { instrument: unquoted, quantity: "125.00000000" },
    ],
  });
  await ctx.seedPositionSet({
    account: loan,
    asOf: "2026-06-30",
    holdings: [{ instrument: usd, quantity: "-412000.00000000" }],
  });

  return { brokerage, loan, vti, vxus };
}

describe("the total for a date, asked two different ways", () => {
  it(
    "reads the same from the series as from the point query",
    withDatabase(async (ctx) => {
      const { vti, vxus } = await anAwkwardPortfolio(ctx);
      // holding_valued_at reads price_daily — a date with no closes is a date with no value.
      await ctx.seedDailyClose({ instrument: vti, date: "2026-06-30", close: "3.1111" });
      await ctx.seedDailyClose({ instrument: vxus, date: "2026-06-30", close: "70.7070" });

      // Genuinely different statements: readTotal aggregates directly; readSeries left-join-laterals per date and counts the joined column, not the row.
      const [point, [series]] = await Promise.all([
        netWorthAt(ALL_OWNERS, "2026-06-30", ctx.db),
        netWorthSeries(ALL_OWNERS, ["2026-06-30"], ctx.db),
      ]);

      expect(series?.amount).toBe(point.amount);
      expect(series?.coverage).toEqual(point.coverage);
      expect(point.coverage).toEqual({ known: 3, total: 4 }); // one of three deliberately unpriced
    }),
  );

  it(
    "agrees on a date the portfolio has no prices for, rather than one answering null",
    withDatabase(async (ctx) => {
      await anAwkwardPortfolio(ctx);

      // The left join manufactures an all-null row per uncovered date — count(*) would score it as one holding; the point query has no such row to miscount.
      const [point, [series]] = await Promise.all([
        netWorthAt(ALL_OWNERS, "2026-06-29", ctx.db),
        netWorthSeries(ALL_OWNERS, ["2026-06-29"], ctx.db),
      ]);

      expect(series?.amount).toBe(point.amount);
      expect(series?.coverage).toEqual(point.coverage);
    }),
  );
});

describe("the Analysis screen's own arithmetic", () => {
  it(
    "slices a total it did not compute, and the slices add back up to it",
    withDatabase(async (ctx) => {
      // analysis.tsx issues two uncoupled queries (currentHoldings for slices, netWorth for the headline) — a filter or
      // dropped row on either side would contradict the other (§8.2). Can't see a never-priced row here (contributes
      // nothing to a sum) — the coverage test below is the complement.
      await anAwkwardPortfolio(ctx);

      const page = await analysisPage();
      const total = toUnits(page.total, MONEY_SCALE);

      for (const [grouping, slices] of [
        ["by person", page.byPerson],
        ["by account kind", page.byAccountKind],
        ["by asset class", page.byAssetClass],
        ["by classification", page.byClassification],
      ] as const) {
        expect({ grouping, sum: sumOf(slices.map((slice) => slice.amount)) }).toEqual({
          grouping,
          sum: total,
        });
      }

      expect(page.total.startsWith("-")).toBe(true); // net debt — liability outweighs securities
    }),
  );

  it(
    "counts the same holdings the headline's coverage counted",
    withDatabase(async (ctx) => {
      // Counts come off the rows already in hand; coverage comes out of SQL — two counts of one thing that can disagree.
      await anAwkwardPortfolio(ctx);

      const [page, headline] = await Promise.all([analysisPage(), netWorth(ALL_OWNERS, ctx.db)]);

      expect({ total: page.holdingCount, known: page.pricedCount }).toEqual(headline.coverage);
    }),
  );
});

// Pays across all three tax treatments. Taxable side nets negative: a car loan's rate sits in the same treatment as the
// brokerage, $360 dividend against $522 interest — the case Income's sheltered sentence and the ring's unfilled row exist
// for, only appearing when a liability account has a rate. Workplace plan holds an unquoted trust: dividend 0.0000 against a null value.
async function aPortfolioThatPays(ctx: TestContext) {
  const owner = await ctx.seedPerson({ name: "Alice" });

  const brokerage = await ctx.seedAccount({
    owner,
    kind: "brokerage",
    taxTreatment: "taxable",
    name: "Fidelity",
  });
  const workplace = await ctx.seedAccount({
    owner,
    kind: "401k",
    taxTreatment: "tax_deferred",
    name: "Workplace plan",
  });
  const roth = await ctx.seedAccount({
    owner,
    kind: "ira",
    taxTreatment: "tax_free",
    name: "Roth IRA",
  });
  const loan = await ctx.seedAccount({
    owner,
    kind: "liability",
    taxTreatment: "taxable",
    name: "Car loan",
  });

  const vti = await ctx.seedInstrument({ symbol: "VTI" });
  const schd = await ctx.seedInstrument({ symbol: "SCHD" });
  const trust = await ctx.seedInstrument({ symbol: "PRIVATE" });
  const usd = await ctx.usdInstrument();

  await ctx.seedQuote({ instrument: vti, price: "200.0000", annualDividendPerShare: "3.6000" });
  await ctx.seedQuote({ instrument: schd, price: "27.5000", annualDividendPerShare: "1.0400" });
  await ctx.seedQuote({ instrument: usd, price: "1.0000", annualDividendPerShare: "0.0360" }); // the note's rate, on the instrument the debt positions in

  await ctx.seedPositionSet({
    account: brokerage,
    asOf: "2026-06-30",
    holdings: [{ instrument: vti, quantity: "100.00000000" }],
  });
  await ctx.seedPositionSet({
    account: workplace,
    asOf: "2026-06-30",
    holdings: [{ instrument: trust, quantity: "125.00000000" }],
  });
  await ctx.seedPositionSet({
    account: roth,
    asOf: "2026-06-30",
    holdings: [{ instrument: schd, quantity: "300.00000000" }],
  });
  await ctx.seedPositionSet({
    account: loan,
    asOf: "2026-06-30",
    holdings: [{ instrument: usd, quantity: "-14500.00000000" }],
  });
}

/** Sorted on the grouping key, so two orderings of one set can be compared. */
const byKey = <Row extends { key: string }>(rows: ReadonlyArray<Row>): Row[] =>
  [...rows].sort((a, b) => (a.key === b.key ? 0 : a.key < b.key ? -1 : 1));

describe("the Income screen and the Holdings table", () => {
  it(
    "group by tax treatment identically, holding for holding",
    withDatabase(async (ctx) => {
      // Holdings groups through groupHoldings; Income groups through annualDividendBy in allocation.ts. They can't
      // disagree on labels because both read holdings-view.ts's one dimension accessor.
      await aPortfolioThatPays(ctx);

      const [page, holdings] = await Promise.all([incomePage(), currentHoldings(ALL_OWNERS, ctx.db)]);
      const groups = groupHoldings(holdings, "tax", DEFAULT_SORT, DEFAULT_DIRECTION);

      expect(
        byKey(page.byTaxTreatment).map((slice) => [
          slice.key,
          slice.label,
          slice.amount,
          slice.coverage.total,
        ]),
      ).toEqual(
        byKey(groups).map((group) => [
          group.key,
          group.label,
          group.total.annualDividend,
          group.holdings.length,
        ]),
      );

      // Real figures, one negative, differing arrival order — Holdings ranks groups by value, Income ranks slices by what they pay.
      expect(page.byTaxTreatment.map((slice) => [slice.label, slice.amount])).toEqual([
        ["Tax-free", "312.0000"],
        ["Tax-deferred", "0.0000"],
        ["Taxable", "-162.0000"],
      ]);
    }),
  );

  it(
    "put the same total at the head of the page as at the foot of the table",
    withDatabase(async (ctx) => {
      await aPortfolioThatPays(ctx);

      const [page, holdings] = await Promise.all([incomePage(), currentHoldings(ALL_OWNERS, ctx.db)]);

      // $360+$0+$312−$522. Headline, Holdings total row, and slices under the ring are three renderings of one sum.
      expect(page.total).toBe("150.0000");
      expect(page.total).toBe(summarise(holdings).annualDividend);
      expect(sumOf(page.byTaxTreatment.map((slice) => slice.amount))).toBe(
        toUnits(page.total, MONEY_SCALE),
      );
      expect(sumOf(page.byAccount.map((slice) => slice.amount))).toBe(
        toUnits(page.total, MONEY_SCALE),
      );
    }),
  );

  it(
    "state the sheltered subtotal and the taxable one separately, signs intact",
    withDatabase(async (ctx) => {
      await aPortfolioThatPays(ctx);

      const page = await incomePage();

      // Deliberately don't add up to the $150 centre — taxable is below zero, so dividing one by the other would read "$312 of $150 is sheltered".
      expect(page.sheltered).toEqual({ sheltered: "312.0000", taxable: "-162.0000" });
    }),
  );

  it(
    "state the weighted yield over gross positive value, not over net worth",
    withDatabase(async (ctx) => {
      await aPortfolioThatPays(ctx);

      const page = await incomePage();

      // $150 over the $28,250 that's worth something — not over the $13,750 household net worth (would report 1.1%).
      expect(page.weightedYield).toBe("0.005310");
    }),
  );
});

// aPortfolioThatPays above is shaped for the dividend, and on three of four cuts every bucket holds one row — a
// comparison against singletons proves little. Here two people hold five rows: two instruments share a classification
// (a bucket sums more than it counts), and the bond fund is never quoted, so every cut has one unpriced group — null vs "0.0000".
async function aPortfolioCutFourWays(ctx: TestContext) {
  const [alice, bob] = await Promise.all([
    ctx.seedPerson({ name: "Alice" }),
    ctx.seedPerson({ name: "Bob" }),
  ]);

  const [brokerage, loan, ira] = await Promise.all([
    ctx.seedAccount({ owner: alice, kind: "brokerage", name: "Fidelity" }),
    ctx.seedAccount({ owner: alice, kind: "liability", name: "Mortgage" }),
    ctx.seedAccount({ owner: bob, kind: "ira", name: "Roth IRA" }),
  ]);

  // One classification over two instruments — seedInstrument mints a fresh one per call otherwise, testing nothing but singletons.
  const usEquity = await ctx.seedClassification({ name: "US equity", assetClass: "equity" });
  const bonds = await ctx.seedClassification({ name: "Bond fund", assetClass: "bond" });

  const [vti, schd, bnd, usd] = await Promise.all([
    ctx.seedInstrument({ symbol: "VTI", classification: usEquity }),
    ctx.seedInstrument({ symbol: "SCHD", classification: usEquity }),
    ctx.seedInstrument({ symbol: "BND", classification: bonds }),
    ctx.usdInstrument(),
  ]);

  await Promise.all([
    ctx.seedQuote({ instrument: vti, price: "200.0000" }),
    ctx.seedQuote({ instrument: schd, price: "27.5000" }),
  ]);

  await Promise.all([
    ctx.seedPositionSet({
      account: brokerage,
      asOf: "2026-06-30",
      holdings: [
        { instrument: vti, quantity: "100.00000000" },
        { instrument: schd, quantity: "300.00000000" },
      ],
    }),
    ctx.seedPositionSet({
      account: ira,
      asOf: "2026-06-30",
      holdings: [{ instrument: bnd, quantity: "400.00000000" }],
    }),
    ctx.seedPositionSet({
      account: loan,
      asOf: "2026-06-30",
      holdings: [{ instrument: usd, quantity: "-14500.00000000" }],
    }),
  ]);
}

describe("the Analysis screen and the Holdings table", () => {
  it(
    "cut the household into the same buckets, by the same names, on every dimension",
    withDatabase(async (ctx) => {
      // Labels match structurally (both sides call the one groupingBy(id) accessor) — Analysis once kept a private
      // label table and printed "Workplace plan (401k, 403b)" vs "Workplace plan" for one bucket. Share is sharpest:
      // both rank buckets and hand the rounding remainder to the first, agreeing only if ties break the same way.
      await aPortfolioCutFourWays(ctx);

      const [page, holdings] = await Promise.all([
        analysisPage(),
        currentHoldings(ALL_OWNERS, ctx.db),
      ]);

      for (const [dimension, slices] of [
        ["owner", page.byPerson],
        ["kind", page.byAccountKind],
        ["assetClass", page.byAssetClass],
        ["classification", page.byClassification],
      ] as const) {
        const groups = groupHoldings(holdings, dimension, DEFAULT_SORT, DEFAULT_DIRECTION);

        // Sorted on the key, never compared positionally — the two rank buckets, and break ties, differently.
        expect({
          dimension,
          cut: byKey(slices).map((slice) => [
            slice.key,
            slice.label,
            slice.amount,
            slice.share,
            slice.coverage,
          ]),
        }).toEqual({
          dimension,
          cut: byKey(groups).map((group) => [
            group.key,
            group.label,
            group.total.value ?? "0.0000", // null in a table cell, zero in a sum — both right for their screen
            group.share ?? "0.000000",
            group.total.valueCoverage,
          ]),
        });
      }

      // Not singletons, and not all priced — the two ways this could hold while proving nothing.
      expect(page.byClassification.map((slice) => [slice.label, slice.coverage])).toEqual([
        ["US equity", { known: 2, total: 2 }],
        ["Bond fund", { known: 0, total: 1 }],
        ["Cash", { known: 1, total: 1 }],
      ]);
    }),
  );
});
