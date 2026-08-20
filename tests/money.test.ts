/**
 * The one module in the application that adds, divides or compares money
 * outside SQL (DESIGN.md §4.1).
 *
 * `toUnits`, `render` and `divide` came out of `allocation.ts` unchanged and
 * have been covered indirectly by `allocation.test.ts` since they were written;
 * they are pinned here directly because they are now shared, and a shared
 * function that only two callers' tests describe is a function whose contract
 * nobody has written down. `sumMoney` and `compareDecimal` are new, and were
 * covered by nothing.
 *
 * Every assertion is an exact decimal string. Not `toBeCloseTo` — the entire
 * reason this module exists rather than `a + b` is that a float is wrong in the
 * last place, and a test that tolerates the last place would not notice if this
 * module became a float tomorrow.
 */
import { describe, expect, it } from "vitest";

import {
  MONEY_SCALE,
  QUANTITY_SCALE,
  SHARE_SCALE,
  compareDecimal,
  divide,
  normaliseFigure,
  render,
  sumMoney,
  toUnits,
} from "~/lib/money";

describe("toUnits and render", () => {
  it("round-trips a value at the scale it is stored at", () => {
    for (const decimal of ["25000.0000", "-8000.5000", "0.0000", "0.0001"]) {
      expect(render(toUnits(decimal, MONEY_SCALE), MONEY_SCALE)).toBe(decimal);
    }
  });

  it("rounds half away from zero, the way `format.ts` rounds what it prints", () => {
    // A caller handing over something finer than the scale. The two must round
    // in the same direction or a total and its own label disagree.
    expect(render(toUnits("1.00005", MONEY_SCALE), MONEY_SCALE)).toBe("1.0001");
    expect(render(toUnits("-1.00005", MONEY_SCALE), MONEY_SCALE)).toBe("-1.0001");
    expect(render(toUnits("1.00004", MONEY_SCALE), MONEY_SCALE)).toBe("1.0000");
  });

  it("has no negative zero", () => {
    expect(render(toUnits("-0.0000", MONEY_SCALE), MONEY_SCALE)).toBe("0.0000");
  });

  it("reads a quantity at eight places without truncating it", () => {
    expect(toUnits("1.00000002", QUANTITY_SCALE) - toUnits("1.00000001", QUANTITY_SCALE)).toBe(1n);
    // The same two at the money scale are indistinguishable, which is why the
    // scale is a parameter rather than a constant baked into the comparison.
    expect(toUnits("1.00000002", MONEY_SCALE)).toBe(toUnits("1.00000001", MONEY_SCALE));
  });

  it("tolerates a sign and surrounding space, since a caller may pass either", () => {
    expect(render(toUnits(" +42.5000 ", MONEY_SCALE), MONEY_SCALE)).toBe("42.5000");
  });
});

describe("divide", () => {
  it("keeps the remainder rather than discarding it", () => {
    expect(render(divide(1n, 3n, SHARE_SCALE), SHARE_SCALE)).toBe("0.333333");
    expect(render(divide(2n, 3n, SHARE_SCALE), SHARE_SCALE)).toBe("0.666667");
  });

  it("keeps the sign of exactly one negative operand", () => {
    expect(render(divide(-1n, 4n, SHARE_SCALE), SHARE_SCALE)).toBe("-0.250000");
    expect(render(divide(-1n, -4n, SHARE_SCALE), SHARE_SCALE)).toBe("0.250000");
  });
});

describe("sumMoney", () => {
  it("stays exact at a magnitude a float does not", () => {
    // 0.1 + 0.2 is the canonical float failure, and a six-figure balance is
    // where the drift stops being academic.
    const sum = sumMoney(["0.1000", "0.2000", "1248392.1400"]);

    expect(render(sum.amount, MONEY_SCALE)).toBe("1248392.4400");
  });

  it("skips the nulls, as `sum(value)` does, and counts them anyway", () => {
    // Skipping is what SQL does. Counting is what stops the omission being
    // silent — a partial answer reported as a complete one is the failure the
    // whole coverage apparatus exists to prevent.
    const sum = sumMoney(["1000.0000", null, "500.0000", null]);

    expect(render(sum.amount, MONEY_SCALE)).toBe("1500.0000");
    expect(sum.known).toBe(2);
    expect(sum.total).toBe(4);
  });

  it("reports nothing known rather than zero for an all-null column", () => {
    const sum = sumMoney([null, null]);

    expect(sum.known).toBe(0);
    expect(sum.total).toBe(2);
  });

  it("sums an empty column to zero of nothing", () => {
    expect(sumMoney([])).toEqual({ amount: 0n, known: 0, total: 0 });
  });

  it("nets a liability against the assets rather than taking its size", () => {
    const sum = sumMoney(["25000.0000", "-14500.0000"]);

    expect(render(sum.amount, MONEY_SCALE)).toBe("10500.0000");
  });
});

describe("normaliseFigure", () => {
  /** The value a cell normalised to, asserting it was a figure at all. */
  const figure = (cell: string): string | null => {
    const result = normaliseFigure(cell);
    return result.kind === "figure" ? result.value : null;
  };

  it("removes thousands separators and keeps the decimal point", () => {
    expect(figure("1,234.56")).toBe("1234.56");
    // U+00A0 is what a copy out of a rendered statement carries; U+2009 is the
    // thin space some brokerages group thousands with.
    expect(figure("1 500")).toBe("1500");
    expect(figure("1 234.5")).toBe("1234.5");
  });

  it("removes a leading currency symbol and surrounding whitespace", () => {
    expect(figure(" $229.35 ")).toBe("229.35");
    expect(figure("$ 2,450.10")).toBe("2450.10");
  });

  it("reads a parenthesised value as negative", () => {
    expect(figure("(1,234.56)")).toBe("-1234.56");
    expect(figure("($56.00)")).toBe("-56.00");
  });

  it("removes a trailing percent sign and returns the value unscaled", () => {
    // What a percent means is the caller's question; scaling it here would be
    // arithmetic, and this function only ever removes dressing.
    expect(figure("12.5%")).toBe("12.5");
    expect(figure("4.90%")).toBe("4.90");
  });

  it("converts a true minus to a hyphen, as `signedQuantity` does", () => {
    expect(figure("−45.10")).toBe("-45.10");
  });

  it("keeps the digits exactly as written, trailing zeros included", () => {
    // The output is the file's digits, not a reading of them — "170.6600" at
    // the money scale is not the same statement as "170.66".
    expect(figure("170.6600")).toBe("170.6600");
    expect(figure("+3.25")).toBe("3.25");
    expect(figure(".50")).toBe("0.50");
    expect(figure("50.")).toBe("50");
  });

  it("has no negative zero", () => {
    expect(figure("(0.00)")).toBe("0.00");
    expect(figure("-0")).toBe("0");
  });

  it("reads every spelling of absence as absent — never as zero", () => {
    // A null cost basis is 0001's deliberate "no default at any layer"; a zero
    // would report a fake gain equal to the whole untracked position.
    for (const cell of ["", "   ", "-", "−", "--", "—", "n/a", "N/A"]) {
      expect(normaliseFigure(cell)).toEqual({ kind: "absent" });
    }
  });

  it("reports anything else non-numeric as unparseable, not as absent", () => {
    for (const cell of ["see disclosures", "1.2.3", ".", "12%5", "(-1)", "$-"]) {
      expect(normaliseFigure(cell)).toEqual({ kind: "unparseable" });
    }
  });
});

describe("compareDecimal", () => {
  it("orders by magnitude, not by the digits as text", () => {
    // As strings, "9.0000" sorts above "10.0000".
    expect(compareDecimal("9.0000", "10.0000", MONEY_SCALE)).toBe(-1);
    expect(compareDecimal("100.0000", "99.9999", MONEY_SCALE)).toBe(1);
    expect(compareDecimal("5.0000", "5.0000", MONEY_SCALE)).toBe(0);
  });

  it("puts a liability below zero, where it belongs", () => {
    expect(compareDecimal("-14500.0000", "0.0000", MONEY_SCALE)).toBe(-1);
    expect(compareDecimal("-1.0000", "-2.0000", MONEY_SCALE)).toBe(1);
  });

  it("separates two quantities that are equal at the money scale", () => {
    expect(compareDecimal("1.00000001", "1.00000002", QUANTITY_SCALE)).toBe(-1);
    expect(compareDecimal("1.00000001", "1.00000002", MONEY_SCALE)).toBe(0);
  });

  it("sorts a null last, whichever side it is on", () => {
    // Last rather than as zero, for the same reason it renders as an em dash
    // rather than as `$0.00`: an unpriced holding is not a worthless one, and
    // sorting it among the near-zero rows would say that it is.
    expect(compareDecimal(null, "1.0000", MONEY_SCALE)).toBe(1);
    expect(compareDecimal("1.0000", null, MONEY_SCALE)).toBe(-1);
    expect(compareDecimal(null, null, MONEY_SCALE)).toBe(0);
    expect(compareDecimal(null, "-99999.0000", MONEY_SCALE)).toBe(1);
  });
});
