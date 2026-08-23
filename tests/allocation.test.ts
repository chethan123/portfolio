/**
 * The three breakdowns the analysis screen draws (DESIGN.md §8.1).
 *
 * No database. `app/lib/allocation.ts` is pure by design — it groups the rows
 * the query layer already returned — so these are unit tests with a fixture
 * function instead of a fixture builder, and they run without Postgres.
 *
 * Two things are being pinned here rather than three. The grouping itself is
 * the obvious one. The other is the arithmetic: every money assertion is an
 * exact decimal string, including the cases a float gets wrong, because this
 * module is the one place in the application that adds money outside SQL and
 * the whole justification for that is that it is exact.
 *
 * And the rule the file's header spends most of its length on — that a negative
 * slice is a fraction of the gross positive total, never of the net — is
 * pinned twice: once for a household that nearly cancels out, and once for one
 * in net debt. Both are where the obvious denominator produces nonsense.
 */
import { describe, expect, it } from "vitest";

import {
  allocationByAccountKind,
  allocationByAssetClass,
  allocationByPerson,
  formatRate,
  rateDigits,
  sharePercent,
  unrealizedByAssetType,
} from "~/lib/allocation";
import { formatPercent } from "~/lib/format";
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
    ...overrides,
  };

  return {
    ...merged,
    price: merged.value === null ? null : merged.price,
    isPriced: merged.value !== null,
  };
}

describe("allocationByPerson", () => {
  it("sums each person's holdings exactly and puts the largest first", () => {
    const slices = allocationByPerson([
      holding({ ownerId: "1", ownerName: "Alice", value: "25000.0000" }),
      holding({ ownerId: "1", ownerName: "Alice", value: "3000.0000" }),
      holding({ ownerId: "2", ownerName: "Bob", value: "12500.0000" }),
    ]);

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
    const slices = allocationByPerson([
      holding({ ownerId: "1", ownerName: "Alex", value: "1000.0000" }),
      holding({ ownerId: "2", ownerName: "Alex", value: "2000.0000" }),
    ]);

    // Merging them would be wrong in a way nobody would ever notice on screen.
    expect(slices.map((slice) => [slice.key, slice.amount])).toEqual([
      ["2", "2000.0000"],
      ["1", "1000.0000"],
    ]);
  });

  it("breaks a tie on the label, so equal slices do not swap between renders", () => {
    const slices = allocationByPerson([
      holding({ ownerId: "2", ownerName: "Bob", value: "1000.0000" }),
      holding({ ownerId: "1", ownerName: "Alice", value: "1000.0000" }),
    ]);

    expect(slices.map((slice) => slice.label)).toEqual(["Alice", "Bob"]);
  });
});

describe("allocationByAccountKind", () => {
  it("labels each kind exactly as the account form does", () => {
    const slices = allocationByAccountKind([
      holding({ accountKind: "brokerage", value: "28000.0000" }),
      holding({ accountKind: "bank", value: "12500.0000" }),
      holding({ accountKind: "401k", value: "50000.0000" }),
    ]);

    // Reused from `account-options.ts` rather than written a second time: a
    // legend and a form select disagreeing about what a kind is called is the
    // same class of drift the query layer exists to prevent.
    expect(slices.map((slice) => slice.label)).toEqual([
      "Workplace plan (401k, 403b)",
      "Brokerage",
      "Bank",
    ]);
  });

  it("keeps a liability negative and makes it a negative share of what is owned", () => {
    const slices = allocationByAccountKind([
      holding({ accountKind: "brokerage", value: "28000.0000" }),
      holding({ accountKind: "bank", value: "12500.0000" }),
      holding({ accountKind: "liability", value: "-8000.0000" }),
    ]);

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
    const slices = allocationByAccountKind([
      holding({ accountKind: "brokerage", value: "10000.0000" }),
      holding({ accountKind: "bank", value: "10000.0000" }),
      holding({ accountKind: "401k", value: "10000.0000" }),
    ]);

    // A third rounded on its own is 0.333333, and three of those come to
    // 0.999999 — the hairline gap the analysis ring drew, since it adds no
    // residual wedge. The spare unit goes to the first of the tied remainders
    // in sort order, so which slice carries it is the same on every render.
    expect(slices.map((slice) => [slice.label, slice.share])).toEqual([
      ["Bank", "0.333334"],
      ["Brokerage", "0.333333"],
      ["Workplace plan (401k, 403b)", "0.333333"],
    ]);
    expect(wholePie(slices)).toBe(WHOLE);
  });

  it("leaves a liability's share out of that correction, at the value it rounds to alone", () => {
    const slices = allocationByAccountKind([
      holding({ accountKind: "brokerage", value: "10000.0000" }),
      holding({ accountKind: "bank", value: "10000.0000" }),
      holding({ accountKind: "401k", value: "10000.0000" }),
      holding({ accountKind: "liability", value: "-10000.0000" }),
    ]);

    // The liability is the same magnitude as each asset group, and the asset
    // group holding the spare unit reads 0.333334. The liability does not: it
    // is a negative fraction of the 30,000 owned, not a piece of the pie being
    // shared out, so nothing is ever handed to it.
    expect(slices.map((slice) => [slice.label, slice.share])).toEqual([
      ["Bank", "0.333334"],
      ["Brokerage", "0.333333"],
      ["Workplace plan (401k, 403b)", "0.333333"],
      ["Loan or other liability", "-0.333333"],
    ]);
    expect(wholePie(slices)).toBe(WHOLE);
  });
});

describe("allocationByAssetClass", () => {
  it("rolls the user's classification labels up into the four fixed classes", () => {
    const slices = allocationByAssetClass([
      holding({ assetClass: "equity", classification: "US equity", value: "60000.0000" }),
      holding({ assetClass: "equity", classification: "International equity", value: "20000.0000" }),
      holding({ assetClass: "bond", classification: "Bond fund", value: "30000.0000" }),
      holding({ assetClass: "cash", classification: "Cash", value: "10000.0000" }),
      holding({ assetClass: "other", classification: "Crypto", value: "5000.0000" }),
    ]);

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

    expect(sum(allocationByPerson(holdings))).toBe(20000);
    expect(sum(allocationByAccountKind(holdings))).toBe(20000);
    expect(sum(allocationByAssetClass(holdings))).toBe(20000);
  });
});

describe("coverage", () => {
  it("counts an unpriced holding without letting it into the amount", () => {
    const slices = allocationByAssetClass([
      holding({ assetClass: "equity", value: "2500.0000" }),
      // A 401k trust that has never been quoted. Dropping it would understate
      // the slice silently; zeroing it would understate it and call the result
      // complete.
      holding({ assetClass: "equity", value: null }),
    ]);

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
    const slices = allocationByAssetClass([
      holding({ assetClass: "other", value: null }),
      holding({ assetClass: "other", value: null }),
    ]);

    // "$0.00, based on 0 of 2 holdings" — which a screen must render as unknown
    // rather than as an empty slice.
    expect(slices[0]?.amount).toBe("0.0000");
    expect(slices[0]?.coverage).toEqual({ known: 0, total: 2 });
  });
});

describe("the arithmetic", () => {
  it("adds the tenths a float cannot", () => {
    const slices = allocationByPerson([
      holding({ value: "0.1000" }),
      holding({ value: "0.2000" }),
    ]);

    // 0.1 + 0.2 = 0.30000000000000004 in a float. This is the regression the
    // whole decimal-string rule exists to prevent, at the scale it is visible.
    expect(slices[0]?.amount).toBe("0.3000");
  });

  it("stays exact past the digit a float runs out at", () => {
    const slices = allocationByPerson([
      holding({ value: "99999999999999.9999" }),
      holding({ value: "0.0001" }),
    ]);

    expect(slices[0]?.amount).toBe("100000000000000.0000");
  });

  it("rounds a value finer than the money scale half away from zero", () => {
    // The view stores numeric(20, 4) and cannot produce this; the rule is
    // written down so that a caller handing over something finer gets the same
    // rounding `format.ts` displays with, rather than a silent truncation.
    expect(allocationByPerson([holding({ value: "0.00005" })])[0]?.amount).toBe("0.0001");
    expect(allocationByPerson([holding({ value: "-0.00005" })])[0]?.amount).toBe("-0.0001");
  });

  it("renders a group that nets exactly flat as zero, never as a negative zero", () => {
    const slices = allocationByPerson([
      holding({ value: "8000.0000" }),
      holding({ value: "-8000.0000" }),
    ]);

    expect(slices[0]?.amount).toBe("0.0000");
  });
});

describe("what a negative slice is a share of", () => {
  it("keeps the shares finite when the debts nearly cancel the assets", () => {
    const slices = allocationByAccountKind([
      holding({ accountKind: "brokerage", value: "500000.0000" }),
      holding({ accountKind: "liability", value: "-490000.0000" }),
    ]);

    // Against the net 10,000 the house would be 5,000% of the portfolio and
    // the mortgage −4,900%. Against the 500,000 owned, both stay readable.
    expect(slices.map((slice) => slice.share)).toEqual(["1.000000", "-0.980000"]);
  });

  it("does not report an asset as a negative share when the household is in net debt", () => {
    const slices = allocationByAccountKind([
      holding({ accountKind: "bank", value: "100000.0000" }),
      holding({ accountKind: "liability", value: "-150000.0000" }),
    ]);

    // A signed net denominator of −50,000 would make the savings −200%: the
    // same wrong sign on the fastest-read figure that `netWorthChange` avoids
    // by dividing by `abs(previous)`.
    expect(slices.map((slice) => [slice.key, slice.share])).toEqual([
      ["bank", "1.000000"],
      ["liability", "-1.500000"],
    ]);
  });

  it("declines to invent a share when nothing at all is positive", () => {
    const slices = allocationByAccountKind([holding({ accountKind: "liability", value: "-8000.0000" })]);

    // There is no base to be a fraction of. The zero is not a claim that the
    // loan is nothing — the amount beside it says what it is.
    expect(slices).toEqual([
      {
        key: "liability",
        label: "Loan or other liability",
        amount: "-8000.0000",
        share: "0.000000",
        coverage: { known: 1, total: 1 },
      },
    ]);
  });

  it("returns nothing at all for no holdings", () => {
    expect(allocationByPerson([])).toEqual([]);
    expect(allocationByAccountKind([])).toEqual([]);
    expect(allocationByAssetClass([])).toEqual([]);
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
    const [equity] = allocationByAssetClass([
      holding({ assetClass: "equity", value: "80000.0000" }),
      holding({ assetClass: "bond", value: "20000.0000" }),
    ]);

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
