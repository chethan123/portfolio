/**
 * Field shapes for the inline position editor (DESIGN.md §4.1, §5.4). Opposite of
 * `moneyMagnitude`: these boxes open containing the table's own figure, so they must take
 * it back — minus sign, U+2212, thousands separators and all — or the form refuses what it just displayed.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { formatQuantity } from "~/lib/holdings-view";
import { ValidationError, parseInput, perShareAmount, signedQuantity } from "~/lib/input.server";

const quantity = z.object({ quantity: signedQuantity("A quantity") });
const basis = z.object({ costBasisPerShare: perShareAmount("A cost basis") });

// message a refusal put under a named field, or undefined if it passed
function refusal(schema: z.ZodType, raw: unknown, field: string): string | undefined {
  try {
    parseInput(schema, raw);
    return undefined;
  } catch (error) {
    if (error instanceof ValidationError) return error.fieldErrors[field];
    throw error;
  }
}

describe("the box takes back what the table put in it", () => {
  it.each([
    ["100.00000000", "100"],
    ["120.50000000", "120.5"],
    ["12.34567800", "12.345678"],
    ["-14500.00000000", "-14500"],
    ["-8000.25000000", "-8000.25"],
    ["1234567.00000000", "1234567"],
    ["0.00000000", "0"],
  ])("%s prints, is retyped, and stores back as itself", (stored, expected) => {
    // full journey: column -> formatter that fills the box -> validator reading it back
    const printed = formatQuantity(stored);
    expect(parseInput(quantity, { quantity: printed }).quantity).toBe(expected);
  });

  it("takes the U+2212 minus the table actually prints, not just a hyphen", () => {
    // formatQuantity emits U+2212 so negatives read like money; a hyphen-only validator
    // would refuse every liability unchanged
    expect(formatQuantity("-14500.00000000")).toBe("−14,500");
    expect(parseInput(quantity, { quantity: "−14,500" }).quantity).toBe("-14500");
  });

  it("takes a cost basis back at the four places the column stores", () => {
    // `moneyMagnitude`'s two places would refuse this having just printed it.
    expect(parseInput(basis, { costBasisPerShare: "31.4159" }).costBasisPerShare).toBe("31.4159");
  });
});

describe("signedQuantity", () => {
  it("keeps the digits that were typed, exactly", () => {
    expect(parseInput(quantity, { quantity: "120.5" }).quantity).toBe("120.5");
  });

  it.each([
    ["  120.5  ", "120.5"],
    ["+120.5", "120.5"],
    ["1,234.5", "1234.5"],
    ["$1,234.5", "1234.5"],
    [".5", "0.5"],
    ["120.", "120"],
    ["-0", "0"],
    ["−0.00", "0.00"],
  ])("reads %j as %j", (typed, stored) => {
    expect(parseInput(quantity, { quantity: typed }).quantity).toBe(stored);
  });

  it("refuses a lone point rather than reading it as zero", () => {
    // completion rules used to compose: "." -> "0." -> "0" — a stray keystroke read as "sold everything"
    expect(refusal(quantity, { quantity: "." }, "quantity")).toMatch(/must be a number/);
    // the generosity it was hiding inside is still there on both sides
    expect(parseInput(quantity, { quantity: ".5" }).quantity).toBe("0.5");
    expect(parseInput(quantity, { quantity: "5." }).quantity).toBe("5");
  });

  it("keeps a negative quantity negative, because that is where the sign lives", () => {
    expect(parseInput(quantity, { quantity: "-8000" }).quantity).toBe("-8000");
  });

  it("refuses a negative zero, which is a debt of nothing written as though it were something", () => {
    expect(parseInput(quantity, { quantity: "-0.00" }).quantity).toBe("0.00");
  });

  it.each([
    ["", /is required/],
    ["   ", /is required/],
    ["-", /is required/],
    ["one hundred", /must be a number/],
    ["12.3.4", /must be a number/],
    ["1e6", /must be a number/],
    [".", /must be a number/],
    ["$.", /must be a number/],
    ["120.123456789", /8 decimal places/],
    ["1234567890123.5", /larger than this application can store/],
  ])("refuses %j", (typed, message) => {
    expect(refusal(quantity, { quantity: typed }, "quantity")).toMatch(message);
  });

  it("counts integer digits without counting the leading zeros or the sign", () => {
    // leading zeros are padding, not magnitude — refusing this would reject an amount well inside the column
    expect(parseInput(quantity, { quantity: "-0000000000000000120.5" }).quantity).toBe(
      "-0000000000000000120.5",
    );
  });
});

describe("perShareAmount", () => {
  it("keeps the digits that were typed, exactly", () => {
    expect(parseInput(basis, { costBasisPerShare: "92.4150" }).costBasisPerShare).toBe("92.4150");
  });

  it.each([["", null], ["   ", null], [undefined, null], [null, null]])(
    "reads %j as an absent cost basis rather than as zero",
    (typed, stored) => {
      // zero would claim free shares and a fake gain on the whole position; null matches "not stated" elsewhere
      expect(parseInput(basis, { costBasisPerShare: typed }).costBasisPerShare).toBe(stored);
    },
  );

  it.each([
    ["$92.41", "92.41"],
    ["1,092.4150", "1092.4150"],
    ["  92.41  ", "92.41"],
  ])("reads %j as %j", (typed, stored) => {
    expect(parseInput(basis, { costBasisPerShare: typed }).costBasisPerShare).toBe(stored);
  });

  it.each([
    ["-92.41", /never negative/],
    ["−92.41", /never negative/],
    [".", /must be an amount in dollars/],
    ["ninety", /must be an amount in dollars/],
    ["92.41599", /4 decimal places/],
  ])("refuses %j", (typed, message) => {
    expect(refusal(basis, { costBasisPerShare: typed }, "costBasisPerShare")).toMatch(message);
  });

  it("says the sign belongs to the quantity, since that is where a reader must put it", () => {
    expect(refusal(basis, { costBasisPerShare: "-92.41" }, "costBasisPerShare")).toMatch(
      /carries its sign in the quantity/,
    );
  });
});
