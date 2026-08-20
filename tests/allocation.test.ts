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
  sharePercent,
} from "~/lib/allocation";
import { formatPercent } from "~/lib/format";

import type { ValuedHolding } from "~/lib/valuation.server";

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

    // The positive slices still make a whole pie: 0.691358 + 0.308642 = 1.
    const positive = slices.filter((slice) => !slice.share.startsWith("-"));
    expect(positive.reduce((sum, slice) => sum + Number(slice.share), 0)).toBe(1);
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
