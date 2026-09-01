/**
 * The display formatters (DESIGN.md §13.3). They exist because
 * `Intl.NumberFormat` needs a float and §4.1 keeps money out of floats, so
 * rounding and grouping are hand-rolled on the digits — exactly the code
 * that is correct on the cases you thought of. The carry cases are pinned:
 * nines rolling over, a carry that lengthens the number, a carry crossing a
 * thousands boundary. No database; pure string functions.
 */
import { describe, expect, it } from "vitest";

import {
  compactScale,
  formatCompact,
  formatMoney,
  formatPercent,
  formatSignedMoney,
  isNegative,
  toPlotValue,
} from "~/lib/format";

describe("formatMoney", () => {
  it("groups thousands and keeps two places", () => {
    expect(formatMoney("1248392.1400")).toBe("$1,248,392.14");
    expect(formatMoney("1000")).toBe("$1,000.00");
    expect(formatMoney("100")).toBe("$100.00");
    expect(formatMoney("0")).toBe("$0.00");
  });

  it("marks a liability with a true minus sign, not a hyphen", () => {
    // U+2212. At the 32px headline size a hyphen is visibly too short to read
    // as a minus, and this is the app's most important sign.
    expect(formatMoney("-8000")).toBe("−$8,000.00");
    expect(formatMoney("-1234567.891")).toBe("−$1,234,567.89");
  });

  it("rounds half away from zero", () => {
    expect(formatMoney("2.345")).toBe("$2.35");
    expect(formatMoney("2.344")).toBe("$2.34");
    expect(formatMoney("0.005")).toBe("$0.01");
  });

  it("carries through nines, lengthening the number when it has to", () => {
    expect(formatMoney("9.999")).toBe("$10.00");
    expect(formatMoney("999.995")).toBe("$1,000.00");
    expect(formatMoney("999999.999")).toBe("$1,000,000.00");
  });

  it("never renders a negative zero", () => {
    // −$0.00 is a rounding artefact, never a fact about money. On screen it
    // reads as a bug even when the arithmetic behind it was right.
    expect(formatMoney("-0.001")).toBe("$0.00");
    expect(formatMoney("-0")).toBe("$0.00");
  });

  it("accepts a decimal with no fractional part, as numeric(20,4) may not have one", () => {
    expect(formatMoney("1234567")).toBe("$1,234,567.00");
  });
});

describe("formatSignedMoney", () => {
  it("marks a positive movement explicitly", () => {
    // A balance needs no plus; a delta is ambiguous without one.
    expect(formatSignedMoney("14921")).toBe("+$14,921.00");
    expect(formatSignedMoney("-500.5")).toBe("−$500.50");
  });

  it("leaves an unchanged figure unsigned", () => {
    expect(formatSignedMoney("0")).toBe("$0.00");
    expect(formatSignedMoney("0.0000")).toBe("$0.00");
  });
});

describe("formatPercent", () => {
  it("always carries an explicit sign, which is half of the colour-blind guarantee", () => {
    expect(formatPercent("1.2043")).toBe("+1.2%");
    expect(formatPercent("-3.55")).toBe("−3.6%");
  });

  it("reports no movement without a sign", () => {
    expect(formatPercent("0")).toBe("0.0%");
  });
});

describe("formatCompact", () => {
  it("abbreviates at each scale", () => {
    expect(formatCompact("1248392.14")).toBe("1.2M");
    expect(formatCompact("1500")).toBe("1.5K");
    expect(formatCompact("2400000000")).toBe("2.4B");
    expect(formatCompact("500")).toBe("500");
    expect(formatCompact("0")).toBe("0");
  });

  it("promotes a value that rounding carries over its own boundary", () => {
    // The bug this pins: scaled against thousands, 999,999 rounds to 1000.0
    // and would render "1,000.0K" instead of "1.0M".
    expect(formatCompact("999999")).toBe("1.0M");
    expect(formatCompact("999999999")).toBe("1.0B");
  });

  it("keeps the sign on a negative axis tick", () => {
    expect(formatCompact("-8000")).toBe("−8.0K");
  });

  it("keeps the decimals the caller asks for", () => {
    expect(formatCompact("5903278.06", 2)).toBe("5.90M");
    expect(formatCompact("5903278.06", 3)).toBe("5.903M");
  });

  it("has nothing to resolve below the scaling threshold, so ignores the decimals", () => {
    expect(formatCompact("500", 3)).toBe("500");
    expect(formatCompact("0", 4)).toBe("0");
  });

  it("reports the scale a value carries itself over the boundary onto", () => {
    // The promotion inside the formatter, visible: 999,999 at one decimal
    // rounds to 1000.0 thousands, which is a million.
    expect(compactScale("999999", 1)).toBe(2);
    expect(compactScale("999999", 3)).toBe(1);
  });
});

describe("isNegative", () => {
  it("is true only below zero", () => {
    expect(isNegative("-8000.0000")).toBe(true);
    expect(isNegative("0.0000")).toBe(false);
    expect(isNegative("-0.0000")).toBe(false);
    expect(isNegative("12500.0000")).toBe(false);
  });
});

/**
 * The one sanctioned float in a codebase that keeps money out of floats end to
 * end (DESIGN.md §4.1, and the `numeric` type-parser override `numeric.test.ts`
 * guards). `toPlotValue` is allowed to call `Number()` because its result is
 * multiplied by a pixel height and rounded to a screen coordinate — so what is
 * pinned here is that argument holding, not that the conversion is exact.
 */
describe("toPlotValue", () => {
  it("is exact for the magnitudes a household portfolio actually reaches", () => {
    // Well inside 2**53, which is where a double stops counting by ones. Every
    // figure this application plots is a balance, and a balance that exceeded
    // this would have bigger problems than its chart.
    expect(toPlotValue("1248392.1400")).toBe(1248392.14);
    expect(toPlotValue("0.0000")).toBe(0);
  });

  it("carries the sign, so a household in net debt plots below the axis", () => {
    expect(toPlotValue("-8000.0000")).toBe(-8000);
  });

  it("loses precision only far below one screen pixel", () => {
    // The safety argument in the docstring, made concrete. Two balances that a
    // double cannot tell apart differ here by less than 1e-6 of the 300px box,
    // so the error cannot reach a rendered coordinate. This is also why the
    // function must never be used for a figure that is shown, compared or
    // summed — those have no pixel to hide the error in.
    const banked = toPlotValue("12345678901234567.89");
    const off = toPlotValue("12345678901234567.90");

    expect(Math.abs(banked - off) / banked).toBeLessThan(1e-9);
  });
});
