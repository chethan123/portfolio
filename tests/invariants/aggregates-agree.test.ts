/**
 * Where two independent queries answer one question, and must not disagree
 * (§8.2's weakest point). Most of the mitigation is structural and needs no
 * test — the readers all sum the same already-rounded `value` column, and
 * asserting that would assert `sum` is `sum`. What is left is the pairs
 * whose *shapes* genuinely differ — two SQL statements, SQL against a
 * JavaScript reduction, two reductions over one array — which can come
 * apart under an edit with nothing else noticing. The Income block at the
 * foot is the third of those: Holdings and Income group by tax treatment
 * through two reductions, agreeing only because both read
 * `holdings-view.ts`'s one dimension accessor, and this test keeps that
 * structural.
 *
 * **Deliberately not asserted:** `netWorth` and `netWorthAt(…, today)` do
 * not agree and must not be made to — the current view prices from
 * `quote.price`, the as-of from `price_daily.close`
 * (`0002_holding_valued.sql` against `0003_holding_valued_at.sql`), so
 * 482.10 against 480.00 answers 48210.0000 and 48000.0000, and no
 * `price_daily` row at all answers 0.0000 over zero coverage. Pairing them
 * would only pass by seeding both prices equal — a fixture, not a rule.
 */
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

/**
 * The two screens' loaders, unfiltered.
 *
 * Both read the owner filter off the request now (spec 0013), so they take
 * route arguments like every other loader this suite drives. The invariants
 * below are about the household, so the address carries no filter.
 */
const analysisPage = () => analysis(args(get("/analysis")));
const incomePage = () => income(args(get("/income")));

afterAll(closeTestDatabase);

/** Sum decimal strings the way the application does — exactly, never as floats. */
const sumOf = (amounts: ReadonlyArray<string>): bigint =>
  amounts.reduce((total, amount) => total + toUnits(amount, MONEY_SCALE), 0n);

/**
 * A portfolio whose arithmetic does not come out evenly.
 *
 * Fractional quantities against prices that do not divide into the money scale,
 * one liability, and one holding that has never been quoted — so every figure
 * below is the product of a rounding decision rather than of numbers chosen to
 * be tidy.
 */
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
      // Never quoted: present in the coverage count, absent from every sum.
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
      // The series carries its own prices: `holding_valued_at` reads
      // `price_daily`, so a date with no closes is a date with no value.
      await ctx.seedDailyClose({ instrument: vti, date: "2026-06-30", close: "3.1111" });
      await ctx.seedDailyClose({ instrument: vxus, date: "2026-06-30", close: "70.7070" });

      // Two genuinely different statements for one fact: `readTotal` aggregates
      // the function directly, while `readSeries` left-join-laterals it per date
      // and counts the joined column rather than the row. Nothing couples them.
      const [point, [series]] = await Promise.all([
        netWorthAt(ALL_OWNERS, "2026-06-30", ctx.db),
        netWorthSeries(ALL_OWNERS, ["2026-06-30"], ctx.db),
      ]);

      expect(series?.amount).toBe(point.amount);
      expect(series?.coverage).toEqual(point.coverage);
      // Not a tautology over an empty portfolio: there is a real figure here,
      // and one holding of the three is deliberately unpriced.
      expect(point.coverage).toEqual({ known: 3, total: 4 });
    }),
  );

  it(
    "agrees on a date the portfolio has no prices for, rather than one answering null",
    withDatabase(async (ctx) => {
      await anAwkwardPortfolio(ctx);

      // The left join manufactures an all-null row per uncovered date, which is
      // exactly where a `count(*)` would score it as one holding. The point
      // query has no such row to miscount, so this is the pair's sharpest case.
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
      // `analysis.tsx` issues two queries — `currentHoldings` for the slices,
      // `netWorth` for the headline — and nothing couples them: a filter on
      // either side, or a grouping dropping a row, puts a total on screen
      // that its own breakdown contradicts (§8.2's failure exactly). Summed
      // as `BigInt` over the stored strings — `Number` is how a test of
      // decimal arithmetic passes for the wrong reason. This half cannot see
      // a never-priced row (null contributes nothing to any sum); the
      // coverage test below is the complement, and neither suffices alone.
      await anAwkwardPortfolio(ctx);

      const page = await analysisPage();
      const total = toUnits(page.total, MONEY_SCALE);

      for (const [grouping, slices] of [
        ["by person", page.byPerson],
        ["by account kind", page.byAccountKind],
        ["by asset class", page.byAssetClass],
      ] as const) {
        expect({ grouping, sum: sumOf(slices.map((slice) => slice.amount)) }).toEqual({
          grouping,
          sum: total,
        });
      }

      // A household in net debt: the liability outweighs the securities, so the
      // total is negative and the slices still have to reconstruct it.
      expect(page.total.startsWith("-")).toBe(true);
    }),
  );

  it(
    "counts the same holdings the headline's coverage counted",
    withDatabase(async (ctx) => {
      // The counts come off the rows already in hand; the coverage comes out of
      // SQL. Two counts of one thing, and the loader's own comment says two
      // counts of one thing are two things that can disagree.
      await anAwkwardPortfolio(ctx);

      const [page, headline] = await Promise.all([analysisPage(), netWorth(ALL_OWNERS, ctx.db)]);

      expect({ total: page.holdingCount, known: page.pricedCount }).toEqual(headline.coverage);
    }),
  );
});

/**
 * A portfolio that pays, across all three tax treatments.
 *
 * The taxable side nets **negative**: a car loan whose note carries a rate sits
 * in the same tax treatment as the brokerage, so $360.00 of dividend arrives
 * against $522.00 of interest. That is the case the Income screen's sheltered
 * sentence and the ring's unfilled row both exist for, and it only appears when
 * a liability account is given a rate — which is why it is seeded here rather
 * than assumed.
 *
 * The workplace plan holds an unquoted trust: a dividend of `0.0000` against a
 * *null* value, which is the group that has a figure and nothing to state it as
 * a fraction of.
 */
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
  // The note's rate, on the instrument the debt is a position in.
  await ctx.seedQuote({ instrument: usd, price: "1.0000", annualDividendPerShare: "0.0360" });

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
      // The pair this test exists for. Holdings groups through
      // `groupHoldings`, which sums its own subtotals; Income groups through
      // `annualDividendBy`, which sums `BigInt` units in `allocation.ts`. Two
      // reductions, two label lookups, one array — and the *reason* they cannot
      // disagree is that both read `holdings-view.ts`'s one dimension accessor.
      // A third copy of the labels would let them group identically and label
      // differently, which is what this assertion catches and nothing else
      // would.
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

      // Not a tautology over an empty portfolio, and not two ways of writing
      // one expression: the figures are real, one slice is negative, and the
      // order the two arrive in genuinely differs — Holdings ranks its groups
      // by value and Income ranks its slices by what they pay.
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

      // $360.00 + $0.00 + $312.00 − $522.00. The headline, the Holdings total
      // row, and the slices under the ring are three renderings of one sum, so
      // any of them drifting is one of them being computed a second way.
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

      // The two do not add up to the $150.00 in the centre of the ring, and
      // they are not meant to: the taxable side is below zero, so a sentence
      // dividing one by the other would read "$312 of $150 is sheltered".
      expect(page.sheltered).toEqual({ sheltered: "312.0000", taxable: "-162.0000" });
    }),
  );

  it(
    "state the weighted yield over gross positive value, not over net worth",
    withDatabase(async (ctx) => {
      await aPortfolioThatPays(ctx);

      const page = await incomePage();

      // $150.00 over the $28,250.00 that is worth something — not over the
      // $13,750.00 the household is worth, which would report 1.1%, and not
      // over a denominator the unquoted trust could drag to nothing.
      expect(page.weightedYield).toBe("0.005310");
    }),
  );
});
