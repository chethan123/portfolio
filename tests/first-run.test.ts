/**
 * What a fresh install still needs, and when it stops needing it.
 *
 * The order is the rule being protected: People before Accounts, because an
 * account has a `not null` owner and genuinely cannot be created first
 * (DESIGN.md §8.4).
 */
import { afterAll, describe, expect, it } from "vitest";

import { closeAccount } from "~/lib/accounts.server";
import { firstRunStep } from "~/lib/first-run.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";

afterAll(closeTestDatabase);

describe("the first-run step", () => {
  it(
    "asks for people on an instance with nothing in it",
    withDatabase(async ({ db }) => {
      expect(await firstRunStep(db)).toBe("people");
    }),
  );

  it(
    "asks for accounts once somebody exists to own one",
    withDatabase(async ({ db, seedPerson }) => {
      await seedPerson();

      expect(await firstRunStep(db)).toBe("accounts");
    }),
  );

  it(
    "stops asking once there is a person and an account",
    withDatabase(async ({ db, seedPerson, seedAccount }) => {
      await seedAccount({ owner: await seedPerson() });

      expect(await firstRunStep(db)).toBeNull();
    }),
  );

  it(
    "stays finished when the only account is closed",
    withDatabase(async ({ db, seedPerson, seedAccount }) => {
      // A closed account is still an account: the instance is set up, and its
      // historical figures are computed from exactly this row. Re-showing the
      // setup prompt here would call a configured instance unconfigured.
      const account = await seedAccount({ owner: await seedPerson() });
      await closeAccount(account.id, db);

      expect(await firstRunStep(db)).toBeNull();
    }),
  );

  it(
    "does not wait for an upload before considering the instance set up",
    withDatabase(async ({ db, seedPerson, seedAccount }) => {
      // Accounts with no statements yet is a correctly configured instance
      // waiting for Sunday, not an unfinished one.
      await seedAccount({ owner: await seedPerson() });

      expect(await firstRunStep(db)).toBeNull();
    }),
  );
});
