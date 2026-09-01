/**
 * The four breakdowns Analysis draws, and the two Income draws beside them
 * (DESIGN.md §8.1) — all six now one function over `holdings-view.ts`'s
 * dimension registry, so these read `groupingBy(id)` exactly as the screens
 * do; a local accessor here would let this file pass while the screens
 * disagree. No database: `allocation.ts` is pure by design, so these are
 * unit tests over a fixture function. Pinned: the grouping, and
 * the arithmetic — every money assertion an exact decimal string, including
 * the cases a float gets wrong, because this module adds money outside SQL
 * and exactness is its whole justification. The gross-positive-denominator
 * rule is pinned twice — a household that nearly cancels out, and one in
 * net debt — both where the obvious denominator produces nonsense.
 */
import { describe, expect, it } from "vitest";

import {
  allocationBy,
  annualDividendBy,
  formatRate,
  rateDigits,
  sharePercent,
  shelteredSubtotal,
  unrealizedByAssetType,
  weightedYield,
} from "~/lib/allocation";
import { formatPercent } from "~/lib/format";
import { groupingBy } from "~/lib/holdings-view";
import { SHARE_SCALE, toUnits } from "~/lib/money";

import type { ValuedHolding } from "~/lib/valuation.server";

/**
 * The positive shares totalled on their digits.
 *
 * `Number()` is what let the old version of this assertion pass while the
 * shares came to 0.999999: summed as floats, a millionth short of a whole is
 * still `1` once the addition has rounded. `BigInt` over the exact strings
 * cannot hide it.
 */
function wholePie(slices: ReadonlyArray<{ share: string }>): bigint {
  return slices
    .filter((slice) => !slice.share.startsWith("-"))
    .reduce((sum, slice) => sum + toUnits(slice.share, SHARE_SCALE), 0n);
}

/** One whole, at the scale a share is written to. */
const WHOLE = toUnits("1.000000", SHARE_SCALE);

let sequence = 0;

/**
 * One row shaped as `holding_valued` would have produced it.
 *
 * `isPriced` is derived rather than passed: the view cannot emit a row where a
 * null value and a true `is_priced` disagree, so deriving it keeps a test from
 * asserting on a row the database could never hand over.
 */
function holding(overrides: Partial<ValuedHolding> = {}): ValuedHolding {
  const merged: ValuedHolding = {
    accountId: "1",
    accountName: "Account",
    accountNumberTail: null,
    institution: "Institution",
    accountKind: "brokerage",
    taxTreatment: "taxable",
    ownerId: "1",
    ownerName: "Alice",
    instrumentId: String((sequence += 1)),
    symbol: "VTI",
    instrumentName: "Vanguard Total Stock Market ETF",
    quoteType: "ETF",
    classification: "US equity",
    assetClass: "equity",
    quantity: "1.00000000",
    price: "1.0000",
    value: "1.0000",
    costBasisPerShare: null,
    costBasis: null,
    unrealized: null,
    isPriced: true,
    isStale: false,
    // Zero rather than null, because that is what the view emits for a holding
    // whose instrument carries no rate: the coalesce is in the SQL.
    annualDividend: "0.0000",
    ...overrides,
  };

  return {
    ...merged,
    price: merged.value === null ? null : merged.price,
    isPriced: merged.value !== null,
  };
}

describe("the cut by owner", () => {
  it("sums each person's holdings exactly and puts the largest first", () => {
    const slices = allocationBy(
      [
        holding({ ownerId: "1", ownerName: "Alice", value: "25000.0000" }),
        holding({ ownerId: "1", ownerName: "Alice", value: "3000.0000" }),
        holding({ ownerId: "2", ownerName: "Bob", value: "12500.0000" }),
      ],
      groupingBy("owner"),
    );

    expect(slices).toEqual([
      {
        key: "1",
        label: "Alice",
        amount: "28000.0000",
        share: "0.691358",
        coverage: { known: 2, total: 2 },
      },
      {
        key: "2",
        label: "Bob",
        amount: "12500.0000",
        share: "0.308642",
        coverage: { known: 1, total: 1 },
      },
    ]);
  });

  it("keys on the owner's id, so two people with one name stay two people", () => {
    const slices = allocationBy(
      [
        holding({ ownerId: "1", ownerName: "Alex", value: "1000.0000" }),
        holding({ ownerId: "2", ownerName: "Alex", value: "2000.0000" }),
      ],
      groupingBy("owner"),
    );

    // Merging them would be wrong in a way nobody would ever notice on screen.
    expect(slices.map((slice) => [slice.key, slice.amount])).toEqual([
      ["2", "2000.0000"],
      ["1", "1000.0000"],
    ]);
  });

  it("breaks a tie on the label, so equal slices do not swap between renders", () => {
    const slices = allocationBy(
      [
        holding({ ownerId: "2", ownerName: "Bob", value: "1000.0000" }),
        holding({ ownerId: "1", ownerName: "Alice", value: "1000.0000" }),
      ],
      groupingBy("owner"),
    );

    expect(slices.map((slice) => slice.label)).toEqual(["Alice", "Bob"]);
  });

  it("breaks it the way a person reads the labels, not by code unit", () => {
    // `"apple" < "Banana"` is false — capitals sort first by code unit — and
    // the Holdings table has always ranked equal groups by `localeCompare`.
    // Two spellings would put the same two buckets in different orders on two
    // screens, and `allocateShares` hands the rounding remainder to whichever
    // came first, so the percentages would differ too.
    const slices = allocationBy(
      [
        holding({ classification: "Banana fund", value: "1000.0000" }),
        holding({ classification: "apple fund", value: "1000.0000" }),
      ],
      groupingBy("classification"),
    );

    expect(slices.map((slice) => [slice.label, slice.share])).toEqual([
      ["apple fund", "0.500000"],
      ["Banana fund", "0.500000"],
    ]);
  });
});

describe("the cut by account type", () => {
  it("keeps a liability negative and makes it a negative share of what is owned", () => {
    const slices = allocationBy(
      [
        holding({ accountKind: "brokerage", value: "28000.0000" }),
        holding({ accountKind: "bank", value: "12500.0000" }),
        holding({ accountKind: "liability", value: "-8000.0000" }),
      ],
      groupingBy("kind"),
    );

    // The sign survives — no absolute value anywhere — and it sorts last by
    // construction rather than by a branch (§2).
    expect(slices.map((slice) => [slice.key, slice.amount, slice.share])).toEqual([
      ["brokerage", "28000.0000", "0.691358"],
      ["bank", "12500.0000", "0.308642"],
      // −8,000 of 40,500 owned. Not of the 32,500 net, which is what makes the
      // figure stable as the net moves.
      ["liability", "-8000.0000", "-0.197531"],
    ]);

    // The positive slices still make a whole pie. These two round to it on
    // their own — 0.691358 + 0.308642 — which is why this case never caught
    // anything; the equal slices below are the ones that do not.
    expect(wholePie(slices)).toBe(WHOLE);
  });

  it("gives the unit lost to rounding back to a slice, so three equal ones make a whole pie", () => {
    const slices = allocationBy(
      [
        holding({ accountKind: "brokerage", value: "10000.0000" }),
        holding({ accountKind: "bank", value: "10000.0000" }),
        holding({ accountKind: "401k", value: "10000.0000" }),
      ],
      groupingBy("kind"),
    );

    // A third rounded on its own is 0.333333, and three of those come to
    // 0.999999 — the hairline gap the analysis ring drew, since it adds no
    // residual wedge. The spare unit goes to the first of the tied remainders
    // in sort order, so which slice carries it is the same on every render.
    expect(slices.map((slice) => [slice.label, slice.share])).toEqual([
      ["Bank", "0.333334"],
      ["Brokerage", "0.333333"],
      ["Workplace plan", "0.333333"],
    ]);
    expect(wholePie(slices)).toBe(WHOLE);
  });

  it("leaves a liability's share out of that correction, at the value it rounds to alone", () => {
    const slices = allocationBy(
      [
        holding({ accountKind: "brokerage", value: "10000.0000" }),
        holding({ accountKind: "bank", value: "10000.0000" }),
        holding({ accountKind: "401k", value: "10000.0000" }),
        holding({ accountKind: "liability", value: "-10000.0000" }),
      ],
      groupingBy("kind"),
    );

    // The liability is the same magnitude as each asset group, and the asset
    // group holding the spare unit reads 0.333334. The liability does not: it
    // is a negative fraction of the 30,000 owned, not a piece of the pie being
    // shared out, so nothing is ever handed to it.
    expect(slices.map((slice) => [slice.label, slice.share])).toEqual([
      ["Bank", "0.333334"],
      ["Brokerage", "0.333333"],
      ["Workplace plan", "0.333333"],
      ["Liability", "-0.333333"],
    ]);
    expect(wholePie(slices)).toBe(WHOLE);
  });
});

describe("the cut by asset class", () => {
  it("rolls the user's classification labels up into the four fixed classes", () => {
    const slices = allocationBy(
      [
        holding({ assetClass: "equity", classification: "US equity", value: "60000.0000" }),
        holding({ assetClass: "equity", classification: "International equity", value: "20000.0000" }),
        holding({ assetClass: "bond", classification: "Bond fund", value: "30000.0000" }),
        holding({ assetClass: "cash", classification: "Cash", value: "10000.0000" }),
        holding({ assetClass: "other", classification: "Crypto", value: "5000.0000" }),
      ],
      groupingBy("assetClass"),
    );

    expect(slices.map((slice) => [slice.label, slice.amount])).toEqual([
      ["Equity", "80000.0000"],
      ["Bonds", "30000.0000"],
      ["Cash", "10000.0000"],
      ["Other", "5000.0000"],
    ]);
  });

  it("cuts one portfolio three ways without the three disagreeing on the whole", () => {
    const holdings = [
      holding({ ownerId: "1", accountKind: "brokerage", assetClass: "equity", value: "25000.0000" }),
      holding({ ownerId: "1", accountKind: "bank", assetClass: "cash", value: "3000.0000" }),
      holding({ ownerId: "2", accountKind: "liability", assetClass: "cash", value: "-8000.0000" }),
    ];

    // `Number` is the test's own arithmetic, never the module's: three
    // groupings of one array must partition it, and this is the cheapest way to
    // say so. The module's own sums are asserted as exact strings everywhere
    // else in this file.
    const sum = (slices: { amount: string }[]): number =>
      slices.reduce((total, slice) => total + Number(slice.amount), 0);

    expect(sum(allocationBy(holdings, groupingBy("owner")))).toBe(20000);
    expect(sum(allocationBy(holdings, groupingBy("kind")))).toBe(20000);
    expect(sum(allocationBy(holdings, groupingBy("assetClass")))).toBe(20000);
  });
});

describe("coverage", () => {
  it("counts an unpriced holding without letting it into the amount", () => {
    const slices = allocationBy(
      [
        holding({ assetClass: "equity", value: "2500.0000" }),
        // A 401k trust that has never been quoted. Dropping it would understate
        // the slice silently; zeroing it would understate it and call the result
        // complete.
        holding({ assetClass: "equity", value: null }),
      ],
      groupingBy("assetClass"),
    );

    expect(slices).toEqual([
      {
        key: "equity",
        label: "Equity",
        amount: "2500.0000",
        share: "1.000000",
        coverage: { known: 1, total: 2 },
      },
    ]);
  });

  it("reports a slice with nothing priced as zero over no known rows", () => {
    const slices = allocationBy(
      [
        holding({ assetClass: "other", value: null }),
        holding({ assetClass: "other", value: null }),
      ],
      groupingBy("assetClass"),
    );

    // "$0.00, based on 0 of 2 holdings" — which a screen must render as unknown
    // rather than as an empty slice.
    expect(slices[0]?.amount).toBe("0.0000");
    expect(slices[0]?.coverage).toEqual({ known: 0, total: 2 });
  });
});

describe("the arithmetic", () => {
  it("adds the tenths a float cannot", () => {
    const slices = allocationBy(
      [
        holding({ value: "0.1000" }),
        holding({ value: "0.2000" }),
      ],
      groupingBy("owner"),
    );

    // 0.1 + 0.2 = 0.30000000000000004 in a float. This is the regression the
    // whole decimal-string rule exists to prevent, at the scale it is visible.
    expect(slices[0]?.amount).toBe("0.3000");
  });

  it("stays exact past the digit a float runs out at", () => {
    const slices = allocationBy(
      [
        holding({ value: "99999999999999.9999" }),
        holding({ value: "0.0001" }),
      ],
      groupingBy("owner"),
    );

    expect(slices[0]?.amount).toBe("100000000000000.0000");
  });

  it("rounds a value finer than the money scale half away from zero", () => {
    // The view stores numeric(20, 4) and cannot produce this; the rule is
    // written down so that a caller handing over something finer gets the same
    // rounding `format.ts` displays with, rather than a silent truncation.
    const [up] = allocationBy([holding({ value: "0.00005" })], groupingBy("owner"));
    const [down] = allocationBy([holding({ value: "-0.00005" })], groupingBy("owner"));

    expect(up?.amount).toBe("0.0001");
    expect(down?.amount).toBe("-0.0001");
  });

  it("renders a group that nets exactly flat as zero, never as a negative zero", () => {
    const slices = allocationBy(
      [
        holding({ value: "8000.0000" }),
        holding({ value: "-8000.0000" }),
      ],
      groupingBy("owner"),
    );

    expect(slices[0]?.amount).toBe("0.0000");
  });
});

describe("what a negative slice is a share of", () => {
  it("keeps the shares finite when the debts nearly cancel the assets", () => {
    const slices = allocationBy(
      [
        holding({ accountKind: "brokerage", value: "500000.0000" }),
        holding({ accountKind: "liability", value: "-490000.0000" }),
      ],
      groupingBy("kind"),
    );

    // Against the net 10,000 the house would be 5,000% of the portfolio and
    // the mortgage −4,900%. Against the 500,000 owned, both stay readable.
    expect(slices.map((slice) => slice.share)).toEqual(["1.000000", "-0.980000"]);
  });

  it("does not report an asset as a negative share when the household is in net debt", () => {
    const slices = allocationBy(
      [
        holding({ accountKind: "bank", value: "100000.0000" }),
        holding({ accountKind: "liability", value: "-150000.0000" }),
      ],
      groupingBy("kind"),
    );

    // A signed net denominator of −50,000 would make the savings −200%: the
    // same wrong sign on the fastest-read figure that `netWorthChange` avoids
    // by dividing by `abs(previous)`.
    expect(slices.map((slice) => [slice.key, slice.share])).toEqual([
      ["bank", "1.000000"],
      ["liability", "-1.500000"],
    ]);
  });

  it("declines to invent a share when nothing at all is positive", () => {
    const slices = allocationBy(
      [holding({ accountKind: "liability", value: "-8000.0000" })],
      groupingBy("kind"),
    );

    // There is no base to be a fraction of. The zero is not a claim that the
    // loan is nothing — the amount beside it says what it is.
    expect(slices).toEqual([
      {
        key: "liability",
        label: "Liability",
        amount: "-8000.0000",
        share: "0.000000",
        coverage: { known: 1, total: 1 },
      },
    ]);
  });

  it("returns nothing at all for no holdings", () => {
    expect(allocationBy([], groupingBy("owner"))).toEqual([]);
    expect(allocationBy([], groupingBy("kind"))).toEqual([]);
    expect(allocationBy([], groupingBy("assetClass"))).toEqual([]);
  });
});

describe("sharePercent", () => {
  it("moves the point two places without touching a float", () => {
    expect(sharePercent("0.691358")).toBe("69.1358");
    expect(sharePercent("-0.197531")).toBe("-19.7531");
    expect(sharePercent("1.000000")).toBe("100.0000");
    expect(sharePercent("0.000000")).toBe("0.0000");
  });

  it("hands `formatPercent` what it expects, which is the whole point of it", () => {
    const [equity] = allocationBy(
      [
        holding({ assetClass: "equity", value: "80000.0000" }),
        holding({ assetClass: "bond", value: "20000.0000" }),
      ],
      groupingBy("assetClass"),
    );

    expect(formatPercent(sharePercent(equity?.share ?? "0"))).toBe("+80.0%");
  });
});

/**
 * The fourth cut: unrealized gains by asset type, and the tax a taxable one
 * would attract (DESIGN.md §4.5, §8.1).
 *
 * The rate is passed as a percentage string throughout, the way the column
 * stores it and the way the screen prints it, so these tests would fail if
 * anything on the path quietly started treating it as a fraction.
 *
 * What is pinned beyond the grouping: that a gain in a tax-exempt account stays
 * in the table and out of the tax; that a bucket nobody recorded a cost basis
 * for is an em dash rather than $0.00; and that the tax arithmetic is exact on
 * the digits, including at the half where a float rounds the other way.
 */
const RATE = "23.800000";

describe("unrealized gains by asset type", () => {
  it("splits the provider's vocabulary into individual stocks and funds", () => {
    const { rows } = unrealizedByAssetType(
      [
        holding({ quoteType: "EQUITY", unrealized: "1000.0000" }),
        holding({ quoteType: "ETF", unrealized: "500.0000" }),
        holding({ quoteType: "MUTUALFUND", unrealized: "250.0000" }),
      ],
      RATE,
    );

    expect(rows.map((row) => [row.key, row.unrealized])).toEqual([
      ["stocks", "1000.0000"],
      ["funds", "750.0000"],
    ]);
  });

  it("matches a quote type however the provider cased or padded it", () => {
    const { rows } = unrealizedByAssetType(
      [
        holding({ quoteType: "equity", unrealized: "10.0000" }),
        holding({ quoteType: " ETF ", unrealized: "20.0000" }),
      ],
      RATE,
    );

    expect(rows.map((row) => [row.key, row.unrealized])).toEqual([
      ["stocks", "10.0000"],
      ["funds", "20.0000"],
    ]);
  });

  it("files cash, a liability and an unquoted trust under the last row rather than dropping them", () => {
    // The seeded USD instrument every bank balance and every loan is a holding
    // of, and a workplace-plan trust that no provider quotes.
    const { rows, total } = unrealizedByAssetType(
      [
        holding({ quoteType: "EQUITY", unrealized: "1000.0000" }),
        holding({ quoteType: "CURRENCY", unrealized: "0.0000" }),
        holding({ quoteType: null, unrealized: "40.0000" }),
        holding({ quoteType: "CRYPTOCURRENCY", unrealized: "60.0000" }),
      ],
      RATE,
    );

    expect(rows.map((row) => [row.key, row.unrealized])).toEqual([
      ["stocks", "1000.0000"],
      ["other", "100.0000"],
    ]);
    // The point of keeping them: the table still totals the whole portfolio.
    expect(total?.unrealized).toBe("1100.0000");
  });

  it("drops a row nothing is in, rather than showing an empty one", () => {
    const { rows } = unrealizedByAssetType([holding({ quoteType: "EQUITY" })], RATE);

    expect(rows.map((row) => row.key)).toEqual(["stocks"]);
  });

  it("has no total at all when there are no holdings", () => {
    expect(unrealizedByAssetType([], RATE)).toEqual({ rows: [], total: null });
  });

  it("taxes a gain in a taxable account and leaves a tax-exempt one alone", () => {
    const { rows, total } = unrealizedByAssetType(
      [
        holding({ quoteType: "EQUITY", taxTreatment: "taxable", unrealized: "1000.0000" }),
        holding({ quoteType: "EQUITY", taxTreatment: "tax_free", unrealized: "4000.0000" }),
        holding({ quoteType: "EQUITY", taxTreatment: "tax_deferred", unrealized: "5000.0000" }),
      ],
      RATE,
    );

    // The gain is the whole $10,000; only the taxable $1,000 is taxed.
    expect(rows[0]?.unrealized).toBe("10000.0000");
    expect(rows[0]?.taxable).toBe("1000.0000");
    expect(rows[0]?.tax).toBe("238.0000");
    expect(total?.tax).toBe("238.0000");
  });

  it("owes nothing on a taxable position at a loss, rather than owing a negative", () => {
    const { rows } = unrealizedByAssetType(
      [holding({ quoteType: "EQUITY", unrealized: "-1000.0000" })],
      RATE,
    );

    expect(rows[0]?.unrealized).toBe("-1000.0000");
    expect(rows[0]?.taxable).toBe("-1000.0000");
    expect(rows[0]?.tax).toBeNull();
  });

  it("reports a bucket with no cost basis as unknown, never as zero", () => {
    const { rows, total } = unrealizedByAssetType(
      [
        holding({ quoteType: "EQUITY", unrealized: "1000.0000" }),
        holding({ quoteType: "ETF", unrealized: null }),
        holding({ quoteType: "ETF", unrealized: null }),
      ],
      RATE,
    );

    expect(rows[1]?.unrealized).toBeNull();
    expect(rows[1]?.tax).toBeNull();
    expect(rows[1]?.coverage).toEqual({ known: 0, total: 2 });
    // A row nobody can compute does not drag the total to unknown.
    expect(total?.unrealized).toBe("1000.0000");
    expect(total?.coverage).toEqual({ known: 1, total: 3 });
  });

  it("counts an uncomputable holding in coverage while leaving it out of the sum", () => {
    const { rows } = unrealizedByAssetType(
      [
        holding({ quoteType: "EQUITY", unrealized: "1000.0000" }),
        holding({ quoteType: "EQUITY", unrealized: null }),
      ],
      RATE,
    );

    expect(rows[0]?.unrealized).toBe("1000.0000");
    expect(rows[0]?.coverage).toEqual({ known: 1, total: 2 });
  });

  it("totals the tax from the rows, so the column adds up on screen", () => {
    const { rows, total } = unrealizedByAssetType(
      [
        holding({ quoteType: "EQUITY", unrealized: "100000.0000" }),
        holding({ quoteType: "ETF", unrealized: "-40000.0000" }),
      ],
      RATE,
    );

    expect(rows.map((row) => row.tax)).toEqual(["23800.0000", null]);
    // Not 23.8% of the netted $60,000 — a total smaller than the row above it
    // reads as an arithmetic fault, and the screen names the limitation
    // instead.
    expect(total?.tax).toBe("23800.0000");
  });

  it("rounds each row's tax to the cent, so the printed column adds up", () => {
    // 22,652.22 × 23.8% is 5,391.228360 and 48,151.16 × 23.8% is
    // 11,459.976080. Carried to four places those print as $5,391.23 and
    // $11,459.98 over a total of $16,851.20 — two figures that do not sum to
    // the third in front of the reader. Rounded where they are made, they do.
    const { rows, total } = unrealizedByAssetType(
      [
        holding({ quoteType: "EQUITY", unrealized: "22652.2200" }),
        holding({ quoteType: "ETF", unrealized: "48151.1600" }),
      ],
      RATE,
    );

    expect(rows.map((row) => row.tax)).toEqual(["5391.2300", "11459.9800"]);
    expect(total?.tax).toBe("16851.2100");
  });

  it("nets the total's base while the total's tax stays the sum of the rows", () => {
    // The one place the two figures on the total row do not describe each
    // other: dividing the tax by the base gives a rate nobody set, which is
    // why the screen does not print the base on that row and says the rule in
    // words instead.
    const { total } = unrealizedByAssetType(
      [
        holding({ quoteType: "EQUITY", unrealized: "100000.0000" }),
        holding({ quoteType: "EQUITY", taxTreatment: "tax_free", unrealized: "5000.0000" }),
        holding({ quoteType: "ETF", unrealized: "-40000.0000" }),
      ],
      RATE,
    );

    expect(total?.unrealized).toBe("65000.0000");
    expect(total?.taxable).toBe("60000.0000");
    expect(total?.tax).toBe("23800.0000");
  });

  it("shows a gain with no tax where the taxable holdings cannot be computed", () => {
    // Taxable holdings exist, so the row is not tax-exempt; none of them has a
    // gain that could be computed, so there is nothing to tax. Two different
    // absences, and neither is a zero.
    const { rows } = unrealizedByAssetType(
      [
        holding({ quoteType: "EQUITY", taxTreatment: "tax_free", unrealized: "1000.0000" }),
        holding({ quoteType: "EQUITY", taxTreatment: "taxable", unrealized: null }),
      ],
      RATE,
    );

    expect(rows[0]?.unrealized).toBe("1000.0000");
    expect(rows[0]?.taxable).toBeNull();
    expect(rows[0]?.tax).toBeNull();
  });

  it("counts an unpriced holding the same way as an untracked cost basis", () => {
    // `holding_valued` nulls `unrealized` when either side is missing, so a
    // trust nobody quotes lands in coverage exactly as a missing basis does —
    // which is why the screen's note names both.
    const { rows } = unrealizedByAssetType(
      [
        holding({ quoteType: "EQUITY", unrealized: "500.0000" }),
        holding({ quoteType: "EQUITY", value: null, costBasis: "800.0000", unrealized: null }),
      ],
      RATE,
    );

    expect(rows[0]?.unrealized).toBe("500.0000");
    expect(rows[0]?.coverage).toEqual({ known: 1, total: 2 });
  });

  it("multiplies exactly, including where a float would not", () => {
    const cases: ReadonlyArray<[string, string, string]> = [
      // The classic float: 0.1 + 0.2 territory, done on digits instead.
      // 1,234,567.89 × 23.8% is 293,827.157820 exactly, and the half-cent
      // rounds away from zero.
      ["1234567.8900", "23.8", "293827.1600"],
      // A rate is allowed six places and all six count: 238.12345 to the
      // nearest cent, rounded down because the tenth of a cent is below the
      // half.
      ["1000.0000", "23.812345", "238.1200"],
      // Half a cent up, and a hair under it down.
      ["1000.0000", "23.805", "238.0500"],
      ["100.0000", "0", "0.0000"],
    ];

    for (const [gain, rate, tax] of cases) {
      const { rows } = unrealizedByAssetType(
        [holding({ quoteType: "EQUITY", unrealized: gain })],
        rate,
      );

      expect([gain, rate, rows[0]?.tax]).toEqual([gain, rate, tax]);
    }
  });
});

describe("formatRate", () => {
  it("prints a stored rate the way the panel heading says it", () => {
    expect(formatRate("23.800000")).toBe("23.8%");
    expect(formatRate("0.000000")).toBe("0%");
    expect(formatRate("100.000000")).toBe("100%");
  });

  it("rounds nothing, so the heading and the settings box cannot disagree", () => {
    // `formatPercent` would make all three of these read 3.8%, 23.8% and
    // 15.3% — a screen contradicting the figure a person typed, and a box that
    // writes the rounded version back on the next save.
    expect(formatRate("3.750000")).toBe("3.75%");
    expect(formatRate("23.812345")).toBe("23.812345%");
    expect(formatRate("15.250000")).toBe("15.25%");
  });

  it("takes off the column's padding and nothing else", () => {
    expect(rateDigits("23.800000")).toBe("23.8");
    expect(rateDigits("15.000000")).toBe("15");
    expect(rateDigits("0.000000")).toBe("0");
    expect(rateDigits("0.000100")).toBe("0.0001");
  });
});

/**
 * A household whose taxable side pays *out*.
 *
 * The shape both edges were found in, seeded against a real database and kept
 * here as an array: a taxable brokerage beside a car loan whose note carries a
 * rate, so the taxable slice nets to −522.20 — a liability account still has a
 * tax treatment, and the interest lands in the same group as the dividend. And
 * a tax-deferred group whose only holding is an unquoted trust, which has a
 * dividend and no value at all.
 */
function aHouseholdWithALoan(): ValuedHolding[] {
  return [
    holding({
      accountId: "1",
      accountName: "Fidelity",
      accountKind: "brokerage",
      taxTreatment: "taxable",
      value: "40000.0000",
      annualDividend: "900.0000",
    }),
    holding({
      accountId: "2",
      accountName: "Car loan",
      accountKind: "liability",
      taxTreatment: "taxable",
      value: "-24000.0000",
      annualDividend: "-1422.2000",
    }),
    holding({
      accountId: "3",
      accountName: "Rollover IRA",
      accountKind: "ira",
      taxTreatment: "tax_deferred",
      // An unquoted trust: a quantity, no price, and a dividend the view
      // coalesced to zero.
      value: null,
      annualDividend: "0.0000",
    }),
    holding({
      accountId: "4",
      accountName: "Roth IRA",
      accountKind: "ira",
      taxTreatment: "tax_free",
      value: "20000.0000",
      annualDividend: "800.0000",
    }),
  ];
}

describe("the annual dividend, grouped", () => {
  it("cuts three ways by tax treatment, with the labels Holdings shows", () => {
    // The accessor comes from `holdings-view.ts` rather than from a grouping
    // written here, because that is the arrangement under test: one label
    // table, read by both screens. A copy in this file would let the test pass
    // while the two screens labelled the same grouping differently.
    const slices = annualDividendBy(aHouseholdWithALoan(), groupingBy("tax"));

    expect(slices).toEqual([
      {
        key: "tax_free",
        label: "Tax-free",
        amount: "800.0000",
        share: "1.000000",
        coverage: { known: 1, total: 1 },
      },
      {
        key: "tax_deferred",
        label: "Tax-deferred",
        amount: "0.0000",
        share: "0.000000",
        coverage: { known: 1, total: 1 },
      },
      {
        // The edge the ring has to survive: a whole slice below zero, on the
        // group the household cares most about. −$1,422.20 of interest against
        // $900.00 of dividend, both taxable.
        key: "taxable",
        label: "Taxable",
        amount: "-522.2000",
        // A fraction of the gross positive dividend, never of the net total.
        share: "-0.652750",
        coverage: { known: 2, total: 2 },
      },
    ]);
  });

  it("counts every holding as known, because the zero rule leaves no unknowns", () => {
    // The reason the Income tables carry no coverage caption. `isPriced` is
    // false for the unquoted trust and its dividend is still a figure, so a
    // dividend breakdown that reused the value predicate would report
    // "3 of 4 holdings" on a column that is complete by construction.
    const slices = annualDividendBy(aHouseholdWithALoan(), groupingBy("tax"));

    expect(slices.every((slice) => slice.coverage.known === slice.coverage.total)).toBe(true);
  });

  it("cuts the same array by account, off the same accessor", () => {
    const slices = annualDividendBy(aHouseholdWithALoan(), groupingBy("account"));

    // Keyed on the account's id and labelled with its own name — the second
    // breakdown answers "which statement does this land in".
    expect(slices.map((slice) => [slice.key, slice.label, slice.amount])).toEqual([
      ["1", "Fidelity", "900.0000"],
      ["4", "Roth IRA", "800.0000"],
      ["3", "Rollover IRA", "0.0000"],
      ["2", "Car loan", "-1422.2000"],
    ]);
  });

  it("groups a dividend, not a value, off the same rows", () => {
    // The failure this adapter exists to prevent: `allocationBy` defaults to
    // value, so an Income panel built on the default would render two rings of
    // net worth under dividend headings.
    const holdings = aHouseholdWithALoan();

    expect(annualDividendBy(holdings, groupingBy("tax")).map((slice) => slice.amount)).not.toEqual(
      allocationBy(holdings, groupingBy("kind")).map((slice) => slice.amount),
    );
  });
});

describe("the sheltered subtotal", () => {
  it("states the two amounts separately rather than as a fraction", () => {
    const { sheltered, taxable } = shelteredSubtotal(aHouseholdWithALoan());

    // Tax-deferred and tax-free added together, and the taxable side left
    // alone. "$800 of $277.80 is sheltered" is the sentence this shape refuses
    // to make possible: the parts are larger than the total they came from,
    // and neither figure is wrong.
    expect({ sheltered, taxable }).toEqual({ sheltered: "800.0000", taxable: "-522.2000" });
  });

  it("keeps the taxable amount negative rather than flooring it at zero", () => {
    // The screen reads the sign and says "a figure going out"; coercing it here
    // would leave that sentence with nothing to switch on.
    expect(shelteredSubtotal(aHouseholdWithALoan()).taxable.startsWith("-")).toBe(true);
  });

  it("is $0 rather than an absence when nothing pays", () => {
    // The zero rule, in the subtotal: a household whose holdings all pay
    // nothing is a household paid $0, not one nobody could work the figure out
    // for.
    expect(shelteredSubtotal([holding({ taxTreatment: "tax_free" })])).toEqual({
      sheltered: "0.0000",
      taxable: "0.0000",
    });
  });
});

describe("the weighted yield", () => {
  it("divides what a group pays by what the group is worth", () => {
    // $277.80 of dividend over $60,000 of gross positive value. Not over the
    // $36,000 the household is actually worth, and not over the four holdings'
    // values summed with the loan's included.
    expect(weightedYield(aHouseholdWithALoan())).toBe("0.004630");
  });

  it("stays positive for a household in net debt", () => {
    const holdings = [
      holding({ accountKind: "bank", value: "100000.0000", annualDividend: "500.0000" }),
      holding({ accountKind: "liability", value: "-150000.0000", annualDividend: "0.0000" }),
    ];

    // A net denominator of −50,000 would report −1.0% on a portfolio that pays
    // $500 a year: the same wrong sign on the fastest-read figure that
    // `netWorthChange` avoids by dividing by `abs(previous)`.
    expect(weightedYield(holdings)).toBe("0.005000");
  });

  it("is absent, not zero, for a group with a dividend and no value", () => {
    // The tax-deferred group in the fixture above, on its own: an unquoted
    // trust has a quantity and no price, so there is nothing for the dividend
    // to be a fraction of. `0.0%` here would be a claim about a holding nobody
    // can price — the zero rule applies to the dividend, never to the value it
    // is divided by.
    expect(weightedYield([holding({ value: null, annualDividend: "120.0000" })])).toBeNull();
  });

  it("is absent, rather than throwing, when the value is exactly zero", () => {
    // Nothing in the schema stops a quantity or a price being zero, and
    // `money.ts`'s `divide` raises `RangeError` on a zero denominator. One
    // sold-out position would otherwise take the whole page down.
    expect(weightedYield([holding({ value: "0.0000", annualDividend: "0.0000" })])).toBeNull();
  });

  it("has no yield for no holdings at all", () => {
    expect(weightedYield([])).toBeNull();
  });
});
