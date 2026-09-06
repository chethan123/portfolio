// Display formatters (DESIGN.md §13.3). Intl.NumberFormat needs a float and §4.1 keeps money out of
// floats, so rounding and grouping are hand-rolled on digits — pinned: nines rolling over, a carry
// that lengthens the number, a carry crossing a thousands boundary.
import { afterEach, describe, expect, it } from "vitest";

import {
  compactScale,
  formatCompact,
  formatDate,
  formatDateLocal,
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
    // U+2212 — at 32px headline size a hyphen reads too short as a minus, and this is the
    // app's most important sign.
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
    // −$0.00 is a rounding artefact, never a fact about money — reads as a bug even when correct.
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
    // Bug this pins: 999,999 scaled to thousands rounds to 1000.0, would render "1,000.0K" not "1.0M".
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

  it("reports the scale a value's size puts it at, and not the one rounding lifts it to", () => {
    // 999,999 prints as 1.0M at one decimal, 999.999K at three, but its size is thousands either way.
    // Chart axis sizes precision off this — reading the promotion instead would misprice the axis.
    expect(compactScale("999999")).toBe(1);
    expect(formatCompact("999999", 1)).toBe("1.0M");
    expect(formatCompact("999999", 3)).toBe("999.999K");
    expect(compactScale("1000001")).toBe(2);
    expect(compactScale("500")).toBe(0);
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

/** The one sanctioned float (DESIGN.md §4.1). Number() is allowed here because the result is
 * multiplied by a pixel height and rounded to a screen coordinate — pinned: that argument holds. */
describe("toPlotValue", () => {
  it("is exact for the magnitudes a household portfolio actually reaches", () => {
    // Well inside 2**53 — a balance exceeding this would have bigger problems than its chart.
    expect(toPlotValue("1248392.1400")).toBe(1248392.14);
    expect(toPlotValue("0.0000")).toBe(0);
  });

  it("carries the sign, so a household in net debt plots below the axis", () => {
    expect(toPlotValue("-8000.0000")).toBe(-8000);
  });

  it("loses precision only far below one screen pixel", () => {
    // Two balances a double can't distinguish here differ by less than 1e-6 of a 300px box — error
    // can't reach a rendered coordinate. Never use this for a shown, compared, or summed figure.
    const banked = toPlotValue("12345678901234567.89");
    const off = toPlotValue("12345678901234567.90");

    expect(Math.abs(banked - off) / banked).toBeLessThan(1e-9);
  });
});

/** formatDate had no test at all (finding 9) — the UTC pin (without which server-rendered and
 * hydrated markup could print different calendar days for one instant) was free to drift. Pin is
 * for hydration safety, not the household's own rule (finding 1): a passkey's date is browser-local
 * per DESIGN.md's Timezone row; formatDateLocal corrects client-side. */
describe("formatDate", () => {
  it("renders a short calendar date, no leading zero on the day", () => {
    expect(formatDate(new Date("2026-09-05T12:00:00Z"))).toBe("5 Sep 2026");
  });

  it("is pinned to UTC, not the runtime's ambient timezone — the hydration-safe first paint, never the final word on a passkey's own date", () => {
    // 00:30 UTC New Year's Day reads as 31 Dec in any zone behind UTC. Dropping timeZone: "UTC"
    // (or retargeting it) would print "31 Dec 2025" here; only the pin prints "1 Jan 2026".
    expect(formatDate(new Date("2026-01-01T00:30:00Z"))).toBe("1 Jan 2026");
  });
});

/** formatDate's browser-local twin (finding 1): testable only by forcing the ambient zone via
 * process.env.TZ, which Node re-reads on every Intl.DateTimeFormat construction (Node 24).
 * Restored in afterEach so no later file inherits a changed clock. */
describe("formatDateLocal", () => {
  const originalTZ = process.env.TZ;

  afterEach(() => {
    process.env.TZ = originalTZ;
  });

  it("reads whatever zone is actually running, not UTC", () => {
    process.env.TZ = "America/New_York";
    // Same 00:30 UTC instant formatDate's pin reads as "1 Jan 2026" — New York is still the evening before.
    expect(formatDateLocal(new Date("2026-01-01T00:30:00Z"))).toBe("31 Dec 2025");
  });

  it("agrees with formatDate whenever the ambient zone happens to already be UTC", () => {
    process.env.TZ = "UTC";
    const instant = new Date("2026-09-05T12:00:00Z");
    expect(formatDateLocal(instant)).toBe(formatDate(instant));
  });
});
