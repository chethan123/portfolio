// Settings → Accounts list. Domain rules (listAccounts, createAccount) are accounts.server.ts's, tested in tests/accounts.test.ts;
// this covers only the row itself: number tail beside the name (CONTEXT.md), hidden from readers in favor of words.
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

      // Free-form column: tail is the last four characters, not digits.
      await seedAccount({
        name: "Fidelity Taxable",
        owner,
        externalAccountNumber: "X47-283910",
      });
      await seedAccount({ name: "Checking", owner, kind: "bank" });

      const data = await loader();

      // Loader masks, not the component — loader data is serialized into the page.
      expect(data.accounts.map((account) => account.accountNumberTail)).toEqual([
        null,
        "····3910",
      ]);
      expect(JSON.stringify(data)).not.toContain("X47-283910");

      const markup = renderRoute(Accounts, "/settings/accounts", data);

      expect(markup).toContain('<span class="number-tail" aria-hidden="true">····3910</span>');
      expect(markup).toContain('<span class="visually-hidden">ending in 3910</span>');

      expect(markup).toContain("Checking");
      expect(markup).not.toContain("Checking ·");
    }),
  );
});
