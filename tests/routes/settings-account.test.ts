/**
 * Settings → one account (the close acknowledgement).
 *
 * The rule itself — no acknowledgement, no close — belongs to
 * `accounts.server.ts` and is tested there. What is only true of *this route*
 * is the wiring around it: a ticked close redirects to the list, and a refused
 * close reports as `closeError` with `values` left undefined — the close POST
 * carries no account fields, so echoing it as `values` would blank every box
 * on the save form above the danger zone.
 */
import { afterAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import { args, post, redirectTo } from "../support/routes.ts";

process.env.DATABASE_URL = TEST_DATABASE_URL;

const { action } = await import("../../app/routes/settings/account.tsx");
const { getAccount } = await import("~/lib/accounts.server");

afterAll(closeTestDatabase);

describe("closing an account from its editor", () => {
  it(
    "closes and returns to the account list when the acknowledgement is ticked",
    withDatabase(async ({ db, seedPerson, seedAccount }) => {
      const account = await seedAccount({ owner: await seedPerson() });

      const location = await redirectTo(() =>
        action(
          args(post(`/settings/accounts/${account.id}`, { intent: "close", confirmClose: "true" }), {
            accountId: account.id,
          }),
        ),
      );

      expect(location).toBe("/settings/accounts");
      expect((await getAccount(account.id, db)).isClosed).toBe(true);
    }),
  );

  it(
    "reports a refused close beside its checkbox and leaves the save form alone",
    withDatabase(async ({ db, seedPerson, seedAccount }) => {
      const account = await seedAccount({ name: "Old Brokerage", owner: await seedPerson() });

      const outcome = await action(
        args(post(`/settings/accounts/${account.id}`, { intent: "close" }), {
          accountId: account.id,
        }),
      );

      expect(outcome).toMatchObject({
        saved: false,
        closeError: expect.stringContaining("Old Brokerage"),
      });
      // Undefined, not the close POST's fields: the save form falls back to
      // the stored account, keeping every box filled.
      expect(outcome).toMatchObject({ values: undefined, errors: undefined });
      expect((await getAccount(account.id, db)).isClosed).toBe(false);
    }),
  );
});
