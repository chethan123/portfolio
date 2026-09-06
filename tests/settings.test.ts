/**
 * The household's settings rows — capital gains rate, masking policy, refresh cadence, each a
 * row rather than an environment variable (DESIGN.md §8.1, §8.4). Exercises the schema's own
 * refusals too, not only zod's — a test that only went through the validator would pass on a
 * schema that had lost the range/single-row constraints.
 */
import { afterAll, describe, expect, it } from "vitest";

import { ValidationError } from "~/lib/input.server";
import {
  readCapitalGainsRate,
  readMaskingPolicy,
  readRefreshCadence,
  saveCapitalGainsRate,
  saveMaskingPolicy,
  saveRefreshCadence,
} from "~/lib/settings.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";

afterAll(closeTestDatabase);

// field messages from a refusal, or a failure if it wasn't refused
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
      // 23.8% = 20% long-term capital gains + 3.8% NIIT
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
      // rules themselves are percentRate's, pinned without a database in rate-input.test.ts
      // (under the name `rate`) — only this call site shows the message arrives under
      // capitalGainsRate, the name the Tax form's box carries; filed wrong it renders nowhere.
      // asserted on the message, not just the key's presence — toHaveProperty alone would pass if every refusal said "banana"
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

describe("the masking policy", () => {
  it(
    "starts masked, because a browser nobody has answered for is not one to show balances on",
    withDatabase(async ({ db }) => {
      // migration seeds this — ADR-0002's decision that safety beats convenience here. A
      // default invented in application code could change without anyone noticing; a seeded column can't.
      expect(await readMaskingPolicy(db)).toBe("masked");
    }),
  );

  it(
    "records each of the three answers a household can give",
    withDatabase(async ({ db }) => {
      // all three, not a representative one — the third is the only value that defers to the
      // browser; a schema constraint that lost it would still pass a test storing only the first two
      expect(await saveMaskingPolicy({ maskingPolicy: "unmasked" }, db)).toBe("unmasked");
      expect(await readMaskingPolicy(db)).toBe("unmasked");

      expect(await saveMaskingPolicy({ maskingPolicy: "as_last_left" }, db)).toBe(
        "as_last_left",
      );
      expect(await readMaskingPolicy(db)).toBe("as_last_left");

      expect(await saveMaskingPolicy({ maskingPolicy: "masked" }, db)).toBe("masked");
      expect(await readMaskingPolicy(db)).toBe("masked");
    }),
  );

  it(
    "files a refusal under the name this form's field actually has",
    withDatabase(async ({ db }) => {
      // same rule saveCapitalGainsRate is held to above — filed wrong the Display tab refuses in silence
      const refusal = await refusalOf(saveMaskingPolicy({ maskingPolicy: "sometimes" }, db));

      expect(refusal.maskingPolicy).toMatch(/masking policy/i);
    }),
  );

  it(
    "leaves the stored policy alone when it refuses",
    withDatabase(async ({ db }) => {
      await saveMaskingPolicy({ maskingPolicy: "unmasked" }, db);
      await refusalOf(saveMaskingPolicy({ maskingPolicy: "" }, db));

      expect(await readMaskingPolicy(db)).toBe("unmasked");
    }),
  );

  it(
    "does not disturb the rate stored beside it",
    withDatabase(async ({ db }) => {
      // both columns are on the one settings row — a writer setting the whole row instead of
      // its own column would silently reset the other, with neither screen reporting it
      await saveCapitalGainsRate({ capitalGainsRate: "15" }, db);
      await saveMaskingPolicy({ maskingPolicy: "unmasked" }, db);

      expect(await readCapitalGainsRate(db)).toBe("15.000000");
    }),
  );
});

describe("the refresh cadence", () => {
  it(
    "starts at the migration's default rather than at nothing",
    withDatabase(async ({ db }) => {
      // 15 — the cadence every deployment ran at as an environment variable; moving it into the database moved nobody's dial
      expect(await readRefreshCadence(db)).toBe(15);
    }),
  );

  it(
    "records a cadence a person typed and hands it back as the whole number it is",
    withDatabase(async ({ db }) => {
      expect(await saveRefreshCadence({ refreshCadenceMinutes: "5" }, db)).toBe(5);
      expect(await readRefreshCadence(db)).toBe(5);
    }),
  );

  it(
    "refuses a cadence outside a minute and a day, under the name the form's field has",
    withDatabase(async ({ db }) => {
      // filed wrong, the Prices tab would refuse in silence — same rule the writers above are held to
      const refusal = await refusalOf(saveRefreshCadence({ refreshCadenceMinutes: "0" }, db));

      expect(refusal.refreshCadenceMinutes).toMatch(/between 1 and 1440/);
    }),
  );

  it(
    "refuses a cadence that is not a whole number of minutes",
    withDatabase(async ({ db }) => {
      const refusal = await refusalOf(
        saveRefreshCadence({ refreshCadenceMinutes: "7.5" }, db),
      );

      expect(refusal.refreshCadenceMinutes).toMatch(/whole number/);
    }),
  );

  it(
    "leaves the stored cadence alone when it refuses",
    withDatabase(async ({ db }) => {
      await refusalOf(saveRefreshCadence({ refreshCadenceMinutes: "1441" }, db));

      expect(await readRefreshCadence(db)).toBe(15);
    }),
  );

  it(
    "does not disturb the rate stored beside it",
    withDatabase(async ({ db }) => {
      await saveCapitalGainsRate({ capitalGainsRate: "15" }, db);
      await saveRefreshCadence({ refreshCadenceMinutes: "30" }, db);

      expect(await readCapitalGainsRate(db)).toBe("15.000000");
    }),
  );
});
