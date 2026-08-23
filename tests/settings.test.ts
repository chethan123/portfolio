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
    "files a refusal under the name this form's field actually has",
    withDatabase(async ({ db }) => {
      // The rules themselves are `percentRate`'s and are pinned exactly, and
      // without a database, in `rate-input.test.ts` — which parses the field
      // under the name `rate`. What only this call site can show is that the
      // message arrives under `capitalGainsRate`, the name the Tax form's box
      // carries: filed under the wrong key it would render nowhere, and the
      // screen would refuse the write in silence.
      //
      // Asserted on the message, not merely on the key being present: a bare
      // `toHaveProperty` here would pass if every refusal said "banana".
      const refusal = await refusalOf(saveCapitalGainsRate({ capitalGainsRate: "101" }, db));

      expect(refusal.capitalGainsRate).toMatch(/more than 100/);
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
