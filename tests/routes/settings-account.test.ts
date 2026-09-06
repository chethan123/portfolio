// Settings → one account, close acknowledgement. The rule (no ack, no close) is accounts.server.ts's; this covers only the route's
// wiring: a ticked close redirects to the list, a refused close reports closeError with values left undefined (see below).
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
      // Undefined, not the close POST's fields — save form falls back to the stored account.
      expect(outcome).toMatchObject({ values: undefined, errors: undefined });
      expect((await getAccount(account.id, db)).isClosed).toBe(false);
    }),
  );
});
