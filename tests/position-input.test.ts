/**
 * The two field shapes the inline position editor is built from
 * (DESIGN.md §4.1, §5.4).
 *
 * Pure — no Postgres — because the rules being checked are about text. What
 * makes them worth their own file, beside `balance-input.test.ts`, is that they
 * are the *opposite* decision on the one question that matters, and the reason
 * has to stay written down: `moneyMagnitude` refuses a sign because the form it
 * serves derives one from the kind of account; these boxes open containing the
 * figure the table already prints, so they have to take it back — minus sign,
 * U+2212, thousands separators and all.
 *
 * That round trip is the first `describe` below, and it is the load-bearing
 * one. `formatQuantity` is what fills the boxes; a change to either side that
 * breaks the pair would produce a form that refuses what it just displayed,
 * with the refusal blaming the reader for a string they never typed.
 *
 * Every assertion is an exact string, for `balance-input.test.ts`'s reason: a
 * test that accepted `120` or `120.000000001` for `120.5` would be testing the
 * thing these validators exist to prevent.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { formatQuantity } from "~/lib/holdings-view";
import { ValidationError, parseInput, perShareAmount, signedQuantity } from "~/lib/input.server";

const quantity = z.object({ quantity: signedQuantity("A quantity") });
const basis = z.object({ costBasisPerShare: perShareAmount("A cost basis") });

/** The message a refusal put under a named field, or undefined if it passed. */
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
    // The full journey: the column, through the formatter that fills the box,
    // through the validator that reads it back out.
    const printed = formatQuantity(stored);
    expect(parseInput(quantity, { quantity: printed }).quantity).toBe(expected);
  });

  it("takes the U+2212 minus the table actually prints, not just a hyphen", () => {
    // `formatQuantity` emits U+2212 so a negative quantity and a negative money
    // figure read alike. A validator that only knew about the hyphen would
    // refuse every liability the moment its box was opened and saved unchanged.
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
    // The two completion rules used to compose — "." became "0." became "0" —
    // so a stray keystroke was a well-formed quantity of nothing, and a
    // quantity of nothing is this application's spelling of "sold everything".
    expect(refusal(quantity, { quantity: "." }, "quantity")).toMatch(/must be a number/);
    // The generosity it was hiding inside is still there on both sides.
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
    // `-0000000000000000120.5` is 120.5 with padding, and refusing it as too
    // large would be refusing an amount well inside the column.
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
      // Zero would claim the shares were free and print an unrealized gain
      // equal to the whole position; null is what "the statement did not say"
      // already means everywhere else in the schema.
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
