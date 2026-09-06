// Field shapes the set-balance form is built from (DESIGN.md §4.1, §5.2). Pure — text only.
// Amount assertions are exact strings: `toBe("14500.00")` is the point, not `14500`.
import { describe, expect, it } from "vitest";

import {
  ValidationError,
  earliestRecordableDate,
  moneyMagnitude,
  parseInput,
  recordedDate,
} from "~/lib/input.server";
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

  it("refuses a lone point rather than reading it as an empty account", () => {
    // Regression: "." completed via "."→"0."→"0" composition, recording a stray
    // keystroke as a real zero balance with no refusal.
    let message: string | undefined;
    try {
      parseInput(amount, { amount: "." });
    } catch (error) {
      if (error instanceof ValidationError) message = error.fieldErrors.amount;
      else throw error;
    }
    expect(message).toMatch(/must be an amount in dollars/);

    expect(parseInput(amount, { amount: ".50" }).amount).toBe("0.50");
    expect(parseInput(amount, { amount: "50." }).amount).toBe("50");
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
    // Column decides stored scale — inventing one here (padding cents) would be arithmetic.
    expect(parseInput(amount, { amount: "1250" }).amount).toBe("1250");
    expect(parseInput(amount, { amount: "0.5" }).amount).toBe("0.5");
  });

  it("keeps a trailing zero a float round trip would destroy", () => {
    // Number("14500.10").toString() is "14500.1" — scale lost though the value's unchanged.
    expect(parseInput(amount, { amount: "14500.10" }).amount).toBe("14500.10");
    expect(String(Number("14500.10"))).not.toBe("14500.10");
  });

  it("carries the widest figure it admits through unaltered", () => {
    expect(parseInput(amount, { amount: "999999999999.99" }).amount).toBe("999999999999.99");
  });

  it("refuses a minus sign rather than honouring it", () => {
    // Sign is the account's kind, not the typist's (§2) — else a liability gets two
    // sources of truth about which way it points.
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
    // latest_position_set orders on as_of_date — 2126 wouldn't just be wrong, it'd
    // outrank every statement for a century.
    expect(refusal(date, { asOf: "2126-08-16" }, "asOf")).toMatch(/in the future/);
  });

  it("allows exactly one day ahead, for the timezone the browser is in", () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const dayAfter = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

    expect(parseInput(date, { asOf: tomorrow }).asOf).toBe(tomorrow);
    expect(refusal(date, { asOf: dayAfter }, "asOf")).toMatch(/in the future/);
  });

  it("refuses a mistyped millennium, which the future check never saw", () => {
    // Reproducing case: "1026" (one keystroke from 2026) isn't in the future, so the
    // ceiling let it through and flattened the "All" chart to a spike at the far left.
    expect(refusal(date, { asOf: "1026-08-24" }, "asOf")).toMatch(/first day this application can price/);
  });

  it("refuses year zero, which the calendar check accepts and Postgres does not", () => {
    // JS has a year zero and round-trips it unchanged — reached the driver as a 500, not a sentence.
    expect(new Date("0000-01-01T00:00:00Z").toISOString().slice(0, 10)).toBe("0000-01-01");
    expect(refusal(date, { asOf: "0000-01-01" }, "asOf")).toMatch(/first day this application can price/);
  });

  it("accepts the floor itself, which is the day USD has a close", () => {
    // Not an off-by-one: 0001_initial_schema.sql seeds USD 1.00 on exactly this date.
    expect(parseInput(date, { asOf: earliestRecordableDate() }).asOf).toBe("1970-01-01");
    expect(earliestRecordableDate()).toBe("1970-01-01");
  });

  it("refuses the day before the floor", () => {
    expect(refusal(date, { asOf: "1969-12-31" }, "asOf")).toMatch(/first day this application can price/);
  });
});
