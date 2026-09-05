/**
 * The display formatters (DESIGN.md §13.3). They exist because
 * `Intl.NumberFormat` needs a float and §4.1 keeps money out of floats, so
 * rounding and grouping are hand-rolled on the digits — exactly the code
 * that is correct on the cases you thought of. The carry cases are pinned:
 * nines rolling over, a carry that lengthens the number, a carry crossing a
 * thousands boundary. No database; pure string functions.
 */
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

  it("reports the scale a value's size puts it at, and not the one rounding lifts it to", () => {
    // 999,999 prints as `1.0M` at one decimal and `999.999K` at three, but its
    // size is thousands either way. A chart axis sizes its precision off this,
    // and reading the promotion instead lets one endpoint a rounding away from
    // the next suffix buy the whole axis three decimals it cannot use.
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

/**
 * `formatDate` had no test at all (finding 9): nothing anywhere referenced
 * it, so the one thing its own header argues for — the UTC pin, without
 * which the server-rendered and hydrated markup could each print a
 * different calendar day for the same instant — was free to drift and every
 * existing test would still pass. Pinned here beside its siblings, matching
 * this file's own house style of asserting an exact string rather than
 * a shape.
 *
 * **The pin is for hydration safety, not the household's own rule (finding
 * 1).** A passkey's enrolled or last-used instant is browser-local per
 * DESIGN.md's Timezone row — `formatDate`'s UTC-pinned string is only ever
 * the first, hydration-stable paint `LocalDate` (`app/routes/settings/
 * passkeys.tsx`) starts from before correcting it client-side. The test
 * below used to read as though UTC were the whole story for a passkey's
 * date; it is now the narrower claim that is actually true of this function
 * alone.
 */
describe("formatDate", () => {
  it("renders a short calendar date, no leading zero on the day", () => {
    expect(formatDate(new Date("2026-09-05T12:00:00Z"))).toBe("5 Sep 2026");
  });

  it("is pinned to UTC, not the runtime's ambient timezone — the hydration-safe first paint, never the final word on a passkey's own date", () => {
    // Half past midnight UTC on New Year's Day: any zone behind UTC — every
    // zone this application's household could plausibly run in — reads this
    // same instant as the evening of 31 December. A mutation dropping the
    // `timeZone: "UTC"` option (or retargeting it to one of those zones)
    // prints "31 Dec 2025" here; only the pin prints "1 Jan 2026". Correcting
    // that string to the household's own zone is `formatDateLocal`'s job, not
    // this function's — see the block below.
    expect(formatDate(new Date("2026-01-01T00:30:00Z"))).toBe("1 Jan 2026");
  });
});

/**
 * `formatDate`'s browser-local twin (finding 1): deliberately *not* pinned,
 * so it can only be pinned here by forcing the ambient zone itself —
 * `process.env.TZ`, which this Node build re-reads on every
 * `Intl.DateTimeFormat` construction rather than caching at startup (checked
 * against the installed Node 24). Restored in `afterEach` so no later file
 * in the suite inherits a changed clock.
 */
describe("formatDateLocal", () => {
  const originalTZ = process.env.TZ;

  afterEach(() => {
    process.env.TZ = originalTZ;
  });

  it("reads whatever zone is actually running, not UTC", () => {
    process.env.TZ = "America/New_York";
    // The same half-past-midnight-UTC instant `formatDate`'s own pin reads as
    // "1 Jan 2026" — New York, being behind UTC, is still the evening before.
    expect(formatDateLocal(new Date("2026-01-01T00:30:00Z"))).toBe("31 Dec 2025");
  });

  it("agrees with formatDate whenever the ambient zone happens to already be UTC", () => {
    process.env.TZ = "UTC";
    const instant = new Date("2026-09-05T12:00:00Z");
    expect(formatDateLocal(instant)).toBe(formatDate(instant));
  });
});
