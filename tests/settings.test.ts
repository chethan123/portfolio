/**
 * The household's capital gains rate — the one setting that is a row rather
 * than an environment variable (DESIGN.md §8.1, §8.4).
 *
 * Driven through `settings.server.ts` against a real Postgres, like every other
 * module that writes. The schema's own refusals are exercised here too rather
 * than only the zod ones: the range and the single-row rule are constraints, so
 * a test that only went through the validator would pass on a schema that had
 * lost them.
 */
import { afterAll, describe, expect, it } from "vitest";

import { ValidationError } from "~/lib/input.server";
import { readCapitalGainsRate, saveCapitalGainsRate } from "~/lib/settings.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";

afterAll(closeTestDatabase);

/** The field messages from a refusal, or a failure if it was not refused. */
async function refusalOf(action: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await action;
  } catch (error) {
    if (error instanceof ValidationError) return { ...error.fieldErrors };
    throw error;
  }
  throw new Error("expected the input to be refused");
}

describe("the capital gains rate", () => {
  it(
    "starts at the migration's default rather than at nothing",
    withDatabase(async ({ db }) => {
      // 23.8% — 20% long-term capital gains plus the 3.8% NIIT. Read as a
      // decimal string at the column's scale, never as a number.
      expect(await readCapitalGainsRate(db)).toBe("23.800000");
    }),
  );

  it(
    "records a rate a person typed and hands it back at the column's scale",
    withDatabase(async ({ db }) => {
      expect(await saveCapitalGainsRate({ capitalGainsRate: "15" }, db)).toBe("15.000000");
      expect(await readCapitalGainsRate(db)).toBe("15.000000");
    }),
  );

  it(
    "reads a rate the way a person writes one",
    withDatabase(async ({ db }) => {
      // The percent sign a paste out of a tax table brings with it, and the
      // spacing a person types.
      expect(await saveCapitalGainsRate({ capitalGainsRate: " 23.8% " }, db)).toBe("23.800000");
    }),
  );

  it(
    "keeps every place the column stores",
    withDatabase(async ({ db }) => {
      expect(await saveCapitalGainsRate({ capitalGainsRate: "23.812345" }, db)).toBe("23.812345");
    }),
  );

  it(
    "allows the ends of the range: nothing owed, and everything owed",
    withDatabase(async ({ db }) => {
      expect(await saveCapitalGainsRate({ capitalGainsRate: "0" }, db)).toBe("0.000000");
      expect(await saveCapitalGainsRate({ capitalGainsRate: "100" }, db)).toBe("100.000000");
    }),
  );

  it(
    "refuses a rate that is not a rate, naming the field",
    withDatabase(async ({ db }) => {
      expect(await refusalOf(saveCapitalGainsRate({ capitalGainsRate: "" }, db))).toHaveProperty(
        "capitalGainsRate",
      );
      expect(
        await refusalOf(saveCapitalGainsRate({ capitalGainsRate: "a quarter" }, db)),
      ).toHaveProperty("capitalGainsRate");
      expect(await refusalOf(saveCapitalGainsRate({ capitalGainsRate: "-5" }, db))).toHaveProperty(
        "capitalGainsRate",
      );
      expect(await refusalOf(saveCapitalGainsRate({ capitalGainsRate: "101" }, db))).toHaveProperty(
        "capitalGainsRate",
      );
      // Finer than the column stores, which would otherwise be rounded away
      // silently and read back as a rate nobody typed.
      expect(
        await refusalOf(saveCapitalGainsRate({ capitalGainsRate: "23.8123456" }, db)),
      ).toHaveProperty("capitalGainsRate");
    }),
  );

  it(
    "leaves the stored rate alone when it refuses",
    withDatabase(async ({ db }) => {
      await refusalOf(saveCapitalGainsRate({ capitalGainsRate: "500" }, db));

      expect(await readCapitalGainsRate(db)).toBe("23.800000");
    }),
  );
});
