/**
 * Settings → Accounts, the list. The rules underneath — what `listAccounts`
 * returns, what `createAccount` refuses — belong to `accounts.server.ts` and
 * are tested in `tests/accounts.test.ts`. What is only true of this route is
 * the row itself: the number tail rides beside the name wherever accounts are
 * listed (CONTEXT.md), hidden from a screen reader in favour of words, and an
 * account with no recorded number keeps its bare name.
 */
import { afterAll, describe, expect, it } from "vitest";

import Accounts, { loader } from "../../app/routes/settings/accounts.tsx";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";

afterAll(closeTestDatabase);

describe("the account list's number tails", () => {
  it(
    "shows a recorded number's tail beside the name, hidden from a reader and said as words",
    withDatabase(async ({ seedPerson, seedAccount }) => {
      const owner = await seedPerson({ name: "Alice" });

      // Free-form, as the column is: the tail is the last four *characters*.
      await seedAccount({
        name: "Fidelity Taxable",
        owner,
        externalAccountNumber: "X47-283910",
      });
      await seedAccount({ name: "Checking", owner, kind: "bank" });

      const data = await loader();

      // The loader masks, not the component: loader data is serialized into
      // the page, so a raw number in it is a raw number in the browser.
      expect(data.accounts.map((account) => account.accountNumberTail)).toEqual([
        null,
        "····3910",
      ]);
      expect(JSON.stringify(data)).not.toContain("X47-283910");

      const markup = renderRoute(Accounts, "/settings/accounts", data);

      expect(markup).toContain('<span class="number-tail" aria-hidden="true">····3910</span>');
      expect(markup).toContain('<span class="visually-hidden">ending in 3910</span>');

      // No number, no dots: the bare name is the honest label.
      expect(markup).toContain("Checking");
      expect(markup).not.toContain("Checking ·");
    }),
  );
});
