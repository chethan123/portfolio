// Settings → one account, close acknowledgement, and the account number the save form was drawn with. The rules
// (no ack, no close; a number that moved is refused) are accounts.server.ts's; this covers only the route's
// wiring: a ticked close redirects to the list, a refused close reports closeError with values left undefined
// (see below), and the save form carries the recorded number back so the domain can tell a stale box from an edit.
import { afterAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { args, get, post, redirectTo } from "../support/routes.ts";

process.env.DATABASE_URL = TEST_DATABASE_URL;

const {
  action,
  loader,
  default: AccountDetail,
} = await import("../../app/routes/settings/account.tsx");
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

describe("the account number the save form was drawn with", () => {
  it(
    "renders the recorded number as the value the box was drawn with",
    withDatabase(async ({ seedPerson, seedAccount }) => {
      const account = await seedAccount({
        name: "Fidelity Taxable",
        owner: await seedPerson({ name: "Alice" }),
        externalAccountNumber: "Z-999",
      });

      const path = `/settings/accounts/${account.id}`;
      const data = await loader(args(get(path), { accountId: account.id }));

      expect(renderRoute(AccountDetail, path, data)).toContain(
        '<input type="hidden" name="fromExternalAccountNumber" value="Z-999"/>',
      );
    }),
  );

  it(
    "reports a number that moved under the form beside its own box, saving nothing",
    withDatabase(async ({ db, seedPerson, seedAccount }) => {
      const owner = await seedPerson({ name: "Alice" });
      // Recorded after this form was drawn, so its hidden field still says the box was blank.
      const account = await seedAccount({
        name: "Fidelity Taxable",
        owner,
        externalAccountNumber: "Z-999",
      });

      const outcome = await action(
        args(
          post(`/settings/accounts/${account.id}`, {
            name: "Renamed",
            institution: "Test Institution",
            kind: "brokerage",
            ownerId: owner.id,
            taxTreatment: "taxable",
            externalAccountNumber: "A-111",
            fromExternalAccountNumber: "",
          }),
          { accountId: account.id },
        ),
      );

      expect(outcome).toMatchObject({
        saved: false,
        errors: { externalAccountNumber: expect.stringContaining('"Z-999"') },
      });
      const now = await getAccount(account.id, db);
      expect(now.externalAccountNumber).toBe("Z-999");
      expect(now.name).toBe("Fidelity Taxable");
    }),
  );
});
