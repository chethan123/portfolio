// Settings → one account, close acknowledgement, and the account number the save form was drawn with. The rules
// (no ack, no close; a number that moved is refused) are accounts.server.ts's; this covers only the route's
// wiring: a ticked close redirects to the list, a refused close reports closeError with values left undefined
// (see below), and the save form carries the recorded number back so the domain can tell a stale box from an edit.
// The number's own normalisation is input.server.ts's; it is asserted here because this POST is the only door a
// line break no single-line box could have sent can reach the column through.
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
  /** Every field the save form posts, so a test can vary only what it is about. */
  const saveForm = (ownerId: string, over: Record<string, string>) => ({
    name: "Fidelity Taxable",
    institution: "Test Institution",
    kind: "brokerage",
    ownerId,
    taxTreatment: "taxable",
    ...over,
  });

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

  it(
    "keeps saying what the box was drawn with when a refusal on another field re-renders the form",
    withDatabase(async ({ db, seedPerson, seedAccount }) => {
      const owner = await seedPerson({ name: "Alice" });
      const account = await seedAccount({ name: "Fidelity Taxable", owner });
      const path = `/settings/accounts/${account.id}`;
      const blankBox = { externalAccountNumber: "", fromExternalAccountNumber: "" };

      // The form drawn before any number was recorded, sent back with an unrelated mistake.
      const refused = await action(
        args(post(path, saveForm(owner.id, { ...blankBox, name: "" })), {
          accountId: account.id,
        }),
      );
      expect(refused).toMatchObject({ errors: { name: "An account name is required." } });

      // A commit captures one while that page sits there (uploads.server.ts); this stands in for
      // it, and the loader revalidation under the refusal then sees it.
      const capture = { externalAccountNumber: "Z-999", fromExternalAccountNumber: "" };
      await action(args(post(path, saveForm(owner.id, capture)), { accountId: account.id }));

      const revalidated = await loader(args(get(path), { accountId: account.id }));
      expect(renderRoute(AccountDetail, path, revalidated, { actionData: refused })).toContain(
        '<input type="hidden" name="fromExternalAccountNumber" value=""/>',
      );

      // The same page, its name corrected and sent again with what it draws: the box is still
      // the blank it was drawn with, not a clear typed over "Z-999".
      const saved = await action(
        args(post(path, saveForm(owner.id, { ...blankBox, name: "Renamed" })), {
          accountId: account.id,
        }),
      );

      expect(saved).toMatchObject({ saved: true });
      const now = await getAccount(account.id, db);
      expect(now.externalAccountNumber).toBe("Z-999");
      expect(now.name).toBe("Renamed");
    }),
  );

  it(
    "reads a line break in either number box as the number without it",
    withDatabase(async ({ db, seedPerson, seedAccount }) => {
      const owner = await seedPerson({ name: "Alice" });

      // Only a forged post carries one: a single-line box strips newlines on the way out, and
      // statement.ts strips them on the way in. A break that reached the column would be a
      // spelling the upload's mismatch check reads as another account (#312), and 0015 cleans
      // the rows written before the parser stripped them — this is the door they came through.
      const blank = await seedAccount({ name: "Fidelity Taxable", owner });
      await action(
        args(
          post(
            `/settings/accounts/${blank.id}`,
            saveForm(owner.id, { externalAccountNumber: "Z-9\n99", fromExternalAccountNumber: "" }),
          ),
          { accountId: blank.id },
        ),
      );
      expect((await getAccount(blank.id, db)).externalAccountNumber).toBe("Z-999");

      // The same break in the copy the form was drawn with: still what is recorded, so the
      // compare-and-set matches and the edit lands rather than reading as a conflict.
      const recorded = await seedAccount({ name: "Schwab", owner, externalAccountNumber: "Z-999" });
      const saved = await action(
        args(
          post(
            `/settings/accounts/${recorded.id}`,
            saveForm(owner.id, {
              name: "Schwab",
              externalAccountNumber: "A-111",
              fromExternalAccountNumber: "Z-9\n99",
            }),
          ),
          { accountId: recorded.id },
        ),
      );

      expect(saved).toMatchObject({ saved: true });
      expect((await getAccount(recorded.id, db)).externalAccountNumber).toBe("A-111");
    }),
  );

  it(
    "draws no copy at all for a submission that carried none, rather than inventing a blank one",
    withDatabase(async ({ db, seedPerson, seedAccount }) => {
      const owner = await seedPerson({ name: "Alice" });
      const account = await seedAccount({
        name: "Fidelity Taxable",
        owner,
        externalAccountNumber: "Z-999",
      });
      const path = `/settings/accounts/${account.id}`;

      // A page from before the form carried its copy: the box emptied on purpose, the name not
      // filled in. Only the name is reported, so the emptied box comes back for another try.
      const refused = await action(
        args(post(path, saveForm(owner.id, { externalAccountNumber: "", name: "" })), {
          accountId: account.id,
        }),
      );
      expect(refused).toMatchObject({ errors: { name: "An account name is required." } });

      const revalidated = await loader(args(get(path), { accountId: account.id }));
      expect(renderRoute(AccountDetail, path, revalidated, { actionData: refused })).not.toContain(
        'name="fromExternalAccountNumber"',
      );

      // Sent again as that page sends it: still a blank box nothing explains, so still refused.
      const again = await action(
        args(post(path, saveForm(owner.id, { externalAccountNumber: "", name: "Renamed" })), {
          accountId: account.id,
        }),
      );

      expect(again).toMatchObject({
        saved: false,
        errors: { externalAccountNumber: expect.stringContaining('recorded as "Z-999"') },
      });
      const now = await getAccount(account.id, db);
      expect(now.externalAccountNumber).toBe("Z-999");
      expect(now.name).toBe("Fidelity Taxable");
    }),
  );
});
