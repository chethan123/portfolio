/**
 * The one field the Tax settings form is built from (DESIGN.md §8.4).
 *
 * Pure — no Postgres — because the rules being checked are about text, and
 * because the alternative is what this file exists to fix: the rate's
 * validation was reachable only through `settings.server.ts`, so a CI run
 * without a database said nothing about it at all.
 *
 * Every assertion is an exact string. A rate multiplies money, so the digits
 * that come out have to be the digits that went in — `toBe("23.812345")` is
 * the point, and a test that accepted `23.8123` would be accepting the silent
 * rounding the screens were fixed for.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ValidationError, parseInput, percentRate } from "~/lib/input.server";

const rate = z.object({ rate: percentRate("A capital gains rate") });

/** What the field parsed to, or undefined if it was refused. */
function parsed(raw: string): string | undefined {
  try {
    return parseInput(rate, { rate: raw }).rate;
  } catch (error) {
    if (error instanceof ValidationError) return undefined;
    throw error;
  }
}

/** The message a refusal put under the field, or undefined if it passed. */
function refusal(raw: string): string | undefined {
  try {
    parseInput(rate, { rate: raw });
    return undefined;
  } catch (error) {
    if (error instanceof ValidationError) return error.fieldErrors.rate;
    throw error;
  }
}

describe("percentRate", () => {
  it("takes a percentage the way a person writes one", () => {
    expect(parsed("23.8")).toBe("23.8");
    expect(parsed(" 23.8 ")).toBe("23.8");
    // The percent sign a paste out of a tax table brings with it.
    expect(parsed("23.8%")).toBe("23.8");
    expect(parsed("+23.8")).toBe("23.8");
    // `bareDecimal`'s generosity, shared with the money fields: an unambiguous
    // shorthand is completed rather than refused.
    expect(parsed(".5")).toBe("0.5");
    expect(parsed("20.")).toBe("20");
  });

  it("keeps every place the column stores, and refuses the place after it", () => {
    expect(parsed("23.812345")).toBe("23.812345");
    expect(refusal("23.8123456")).toMatch(/decimal places/);
  });

  it("allows both ends of the range and nothing outside it", () => {
    expect(parsed("0")).toBe("0");
    expect(parsed("100")).toBe("100");
    expect(refusal("100.000001")).toMatch(/more than 100/);
    expect(refusal("101")).toMatch(/more than 100/);
  });

  it("refuses a negative rate, however it was typed", () => {
    // Both the hyphen a keyboard produces and the U+2212 a rendered document
    // does — the same pair the money fields refuse.
    expect(refusal("-5")).toMatch(/negative/);
    expect(refusal("−5")).toMatch(/negative/);
  });

  it("refuses an empty box and anything that is not a number", () => {
    expect(refusal("")).toMatch(/required/);
    expect(refusal("   ")).toMatch(/required/);
    expect(refusal("a quarter")).toMatch(/percentage/);
    // A lone point is a stray keystroke, not a zero — the bug `bareDecimal`'s
    // lookarounds exist for.
    expect(refusal(".")).toMatch(/percentage/);
  });
});
