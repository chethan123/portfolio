// Four Analysis breakdowns + two Income ones (DESIGN.md §8.1), via holdings-view.ts's groupingBy.
// Pure unit tests, no database; money assertions are exact decimal strings.
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

/** Sum of positive shares. BigInt over exact strings — Number() let 0.999999 read as 1 once floats rounded the sum. */
function wholePie(slices: ReadonlyArray<{ share: string }>): bigint {
  return slices
    .filter((slice) => !slice.share.startsWith("-"))
    .reduce((sum, slice) => sum + toUnits(slice.share, SHARE_SCALE), 0n);
}

/** 1.0 at share scale. */
const WHOLE = toUnits("1.000000", SHARE_SCALE);

let sequence = 0;

/** Row shaped like holding_valued's output. isPriced is derived — the view never emits null value + true is_priced. */
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
    // Zero, not null — view coalesces a rateless instrument's dividend in SQL.
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
    // Code-unit sort puts capitals first; Holdings ranks by localeCompare — wrong order also flips which tied slice gets the rounding remainder.
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

    // Sign survives (no abs anywhere); sorts last by construction, not a branch (§2).
    expect(slices.map((slice) => [slice.key, slice.amount, slice.share])).toEqual([
      ["brokerage", "28000.0000", "0.691358"],
      ["bank", "12500.0000", "0.308642"],
      // −8,000 of 40,500 owned, not of the 32,500 net — stable as net moves.
      ["liability", "-8000.0000", "-0.197531"],
    ]);

    // These two round to a whole pie on their own; the equal-slices case below doesn't.
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

    // Three thirds round to 0.999999 alone; spare unit goes to the first tied remainder in sort order, staying stable across renders.
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

    // Liability is the same magnitude as each asset group but gets no rounding remainder — it's a negative fraction of the 30,000 owned, not a piece of the pie being shared.
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

    // Number() here is the test's own math, not the module's — cheapest way to check three groupings partition one array (module's own sums are asserted as exact strings elsewhere).
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
        // Never-quoted 401k trust: dropping it understates silently; zeroing it understates and claims complete.
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

    // "$0.00 based on 0 of 2 holdings" — unknown, not an empty slice.
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

    // 0.1 + 0.2 = 0.30000000000000004 as a float — the regression decimal strings prevent.
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
    // numeric(20,4) can't produce this — pins the rounding rule for a finer caller instead of a silent truncation.
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

    // Net 10,000 denominator would read 5,000% / −4,900%; against 500,000 owned, both stay readable.
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

    // Signed net denominator (−50,000) would read savings as −200% — same fix as netWorthChange's abs(previous).
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

    // No base to be a fraction of — zero share isn't a claim the loan is nothing.
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

// Unrealized gains by asset type and the tax attracted (DESIGN.md §4.5, §8.1); rate is a percentage string throughout, matching the column/screen.
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
    // Seeded USD instrument (every bank/loan holding) plus an unquoted workplace-plan trust.
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
    // Not 23.8% of the netted $60,000 — a total smaller than the row above would read as a fault.
    expect(total?.tax).toBe("23800.0000");
  });

  it("rounds each row's tax to the cent, so the printed column adds up", () => {
    // 22,652.22×23.8%=5,391.22836, 48,151.16×23.8%=11,459.97608 — unrounded these mismatch on screen; rounded per-row, they add up.
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
    // Total row's tax/base don't describe each other — dividing gives a rate nobody set, so the screen states the rule in words instead of printing the base.
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
    // Taxable holdings exist (not tax-exempt) but none has a computable gain — two absences, neither a zero.
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
    // holding_valued nulls unrealized when either side is missing — unquoted trust lands in coverage same as missing cost basis.
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
      // 1,234,567.89 × 23.8% = 293,827.15782 exactly; half-cent rounds away from zero.
      ["1234567.8900", "23.8", "293827.1600"],
      // Rate allows six places, all count: 238.12345 rounds down (below the half).
      ["1000.0000", "23.812345", "238.1200"],
      // Half a cent up, a hair under it down.
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
    // formatPercent would round these to 3.8%/23.8%/15.3%, contradicting what was typed — and re-saving would persist the rounded value.
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

// A household whose taxable side nets negative: brokerage + car loan (a liability has a tax
// treatment too, so interest lands in the dividend group), plus a tax-deferred group holding only an unquoted, valueless trust.
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
      // Unquoted trust — quantity, no price, dividend coalesced to zero.
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
    // groupingBy comes from holdings-view.ts, not a local copy — a local one could pass while the two screens' labels drifted apart.
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
        // Whole slice below zero — −$1,422.20 interest against $900.00 dividend, both taxable.
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
    // Why Income tables show no coverage caption: isPriced is false for the unquoted trust but its dividend is still known — reusing the value predicate would misreport "3 of 4".
    const slices = annualDividendBy(aHouseholdWithALoan(), groupingBy("tax"));

    expect(slices.every((slice) => slice.coverage.known === slice.coverage.total)).toBe(true);
  });

  it("cuts the same array by account, off the same accessor", () => {
    const slices = annualDividendBy(aHouseholdWithALoan(), groupingBy("account"));

    // Keyed on account id, labelled by name — answers "which statement does this land in".
    expect(slices.map((slice) => [slice.key, slice.label, slice.amount])).toEqual([
      ["1", "Fidelity", "900.0000"],
      ["4", "Roth IRA", "800.0000"],
      ["3", "Rollover IRA", "0.0000"],
      ["2", "Car loan", "-1422.2000"],
    ]);
  });

  it("groups a dividend, not a value, off the same rows", () => {
    // allocationBy defaults to value — without this adapter, Income would render net-worth rings under dividend headings.
    const holdings = aHouseholdWithALoan();

    expect(annualDividendBy(holdings, groupingBy("tax")).map((slice) => slice.amount)).not.toEqual(
      allocationBy(holdings, groupingBy("kind")).map((slice) => slice.amount),
    );
  });
});

describe("the sheltered subtotal", () => {
  it("states the two amounts separately rather than as a fraction", () => {
    const { sheltered, taxable } = shelteredSubtotal(aHouseholdWithALoan());

    // Tax-deferred + tax-free, taxable kept separate — refuses to make "$800 of $277.80 sheltered" possible when the parts exceed the total.
    expect({ sheltered, taxable }).toEqual({ sheltered: "800.0000", taxable: "-522.2000" });
  });

  it("keeps the taxable amount negative rather than flooring it at zero", () => {
    // Screen reads the sign to say "a figure going out" — flooring at zero removes that signal.
    expect(shelteredSubtotal(aHouseholdWithALoan()).taxable.startsWith("-")).toBe(true);
  });

  it("is $0 rather than an absence when nothing pays", () => {
    // Zero rule: a pays-nothing household is $0, not "unknown".
    expect(shelteredSubtotal([holding({ taxTreatment: "tax_free" })])).toEqual({
      sheltered: "0.0000",
      taxable: "0.0000",
    });
  });
});

describe("the weighted yield", () => {
  it("divides what a group pays by what the group is worth", () => {
    // $277.80 over $60,000 gross positive value — not the $36,000 net worth, not with the loan's value included.
    expect(weightedYield(aHouseholdWithALoan())).toBe("0.004630");
  });

  it("stays positive for a household in net debt", () => {
    const holdings = [
      holding({ accountKind: "bank", value: "100000.0000", annualDividend: "500.0000" }),
      holding({ accountKind: "liability", value: "-150000.0000", annualDividend: "0.0000" }),
    ];

    // Net denominator (−50,000) would report −1.0% on a $500/yr payer — same fix as netWorthChange's abs(previous).
    expect(weightedYield(holdings)).toBe("0.005000");
  });

  it("is absent, not zero, for a group with a dividend and no value", () => {
    // Unquoted trust: quantity, no price — nothing for the dividend to be a fraction of. Zero rule applies to the dividend, never to its denominator.
    expect(weightedYield([holding({ value: null, annualDividend: "120.0000" })])).toBeNull();
  });

  it("is absent, rather than throwing, when the value is exactly zero", () => {
    // money.ts's divide raises RangeError on a zero denominator — a sold-out position must not 500 the page.
    expect(weightedYield([holding({ value: "0.0000", annualDividend: "0.0000" })])).toBeNull();
  });

  it("has no yield for no holdings at all", () => {
    expect(weightedYield([])).toBeNull();
  });
});
