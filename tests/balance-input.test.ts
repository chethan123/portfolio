/**
 * The two field shapes the set-balance form is built from (DESIGN.md §4.1, §5.2).
 *
 * Pure — no Postgres — because the rules being checked are about text. What
 * makes them worth their own file is that both exist to stop something silent:
 * a money value that reached a float and came back rounded, and an as-of date
 * that outranks every future statement because a digit was mistyped.
 *
 * Every assertion on an amount is an exact string. `toBe("14500.00")` is the
 * whole point — a test that accepted `14500` or `14500.000000001` would be
 * testing the thing this module exists to prevent.
 */
import { describe, expect, it } from "vitest";

import { ValidationError, moneyMagnitude, parseInput, recordedDate } from "~/lib/input.server";
import { z } from "zod";

const amount = z.object({ amount: moneyMagnitude("A balance") });
const date = z.object({ asOf: recordedDate("The date") });

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

describe("moneyMagnitude", () => {
  it("keeps the digits that were typed, exactly", () => {
    expect(parseInput(amount, { amount: "14500.00" }).amount).toBe("14500.00");
  });

  it.each([
    ["$14,500.00", "14500.00"],
    ["14,500.00", "14500.00"],
    ["  14500.00  ", "14500.00"],
    ["$ 14 500.00", "14500.00"],
    ["+14500.00", "14500.00"],
    // A copy out of a rendered statement brings a non-breaking space with it.
    ["$14 500.00", "14500.00"],
  ])("reads %o as the same amount", (typed, stored) => {
    expect(parseInput(amount, { amount: typed }).amount).toBe(stored);
  });

  it("does not round, pad or otherwise tidy the scale it was given", () => {
    // Neither "1250" nor "0.5" acquires cents on the way through: the column
    // decides the stored scale, and inventing one here would be arithmetic.
    expect(parseInput(amount, { amount: "1250" }).amount).toBe("1250");
    expect(parseInput(amount, { amount: "0.5" }).amount).toBe("0.5");
  });

  it("completes the two abbreviations that are unambiguous", () => {
    expect(parseInput(amount, { amount: ".50" }).amount).toBe("0.50");
    expect(parseInput(amount, { amount: "50." }).amount).toBe("50");
  });

  it("keeps a trailing zero a float round trip would destroy", () => {
    // `Number("14500.10").toString()` is "14500.1". The value is unchanged and
    // the *scale* is gone, which is how a balance recorded to the cent starts
    // reporting to the dime. Text has no such failure mode.
    expect(parseInput(amount, { amount: "14500.10" }).amount).toBe("14500.10");
    expect(String(Number("14500.10"))).not.toBe("14500.10");
  });

  it("carries the widest figure it admits through unaltered", () => {
    expect(parseInput(amount, { amount: "999999999999.99" }).amount).toBe("999999999999.99");
  });

  it("refuses a minus sign rather than honouring it", () => {
    // The sign is the account's kind, not the typist's (§2). Accepting one here
    // would give a liability two sources of truth about which way it points.
    expect(refusal(amount, { amount: "-14500" }, "amount")).toMatch(/without a minus sign/);
    expect(refusal(amount, { amount: "−14500" }, "amount")).toMatch(/without a minus sign/);
  });

  it("refuses what is not an amount", () => {
    expect(refusal(amount, { amount: "" }, "amount")).toMatch(/required/);
    expect(refusal(amount, { amount: "   " }, "amount")).toMatch(/required/);
    expect(refusal(amount, { amount: "fourteen thousand" }, "amount")).toMatch(/in dollars/);
    expect(refusal(amount, { amount: "1.2.3" }, "amount")).toMatch(/in dollars/);
    expect(refusal(amount, { amount: "1e5" }, "amount")).toMatch(/in dollars/);
  });

  it("refuses more precision than money has", () => {
    expect(refusal(amount, { amount: "14500.123" }, "amount")).toMatch(/two decimal places/);
  });

  it("refuses a figure wider than the column", () => {
    expect(refusal(amount, { amount: "1234567890123" }, "amount")).toMatch(/larger than/);
    // Leading zeros are not width.
    expect(parseInput(amount, { amount: "000000000000123" }).amount).toBe("000000000000123");
  });
});

describe("recordedDate", () => {
  const today = new Date().toISOString().slice(0, 10);

  it("accepts a date that has happened", () => {
    expect(parseInput(date, { asOf: "2026-08-16" }).asOf).toBe("2026-08-16");
    expect(parseInput(date, { asOf: today }).asOf).toBe(today);
  });

  it("refuses a date the calendar does not have", () => {
    // Left alone, Postgres refuses this too — as a driver error naming a type.
    expect(refusal(date, { asOf: "2026-02-30" }, "asOf")).toMatch(/not a date on the calendar/);
    expect(refusal(date, { asOf: "2026-13-01" }, "asOf")).toMatch(/not a date on the calendar/);
  });

  it("refuses a shape that is not a date", () => {
    expect(refusal(date, { asOf: "" }, "asOf")).toMatch(/required/);
    expect(refusal(date, { asOf: "16/08/2026" }, "asOf")).toMatch(/YYYY-MM-DD/);
  });

  it("refuses the future, which is the refusal that matters", () => {
    // `latest_position_set` orders on as_of_date, so a year typed as 2126 does
    // not record a wrong date — it pins the account to that row and no later
    // statement can outrank it for a century.
    expect(refusal(date, { asOf: "2126-08-16" }, "asOf")).toMatch(/in the future/);
  });

  it("allows exactly one day ahead, for the timezone the browser is in", () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const dayAfter = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

    expect(parseInput(date, { asOf: tomorrow }).asOf).toBe(tomorrow);
    expect(refusal(date, { asOf: dayAfter }, "asOf")).toMatch(/in the future/);
  });
});
