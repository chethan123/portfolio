// The risk: a refusal naming no field (`form`) on the add or save account form rendering nowhere
// (ARCHITECTURE.md §11.3 before spec 0027). No real input reaches one, so the writers are replaced;
// `vi.mock` is file-wide, hence its own file. It rewires `fixtures.ts`'s `updateAccount` too: no `renumber` here.
import { afterAll, describe, expect, it, vi } from "vitest";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { args, get, post } from "../support/routes.ts";

vi.mock("~/lib/accounts.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/accounts.server")>();
  const { ValidationError } = await import("~/lib/input.server");
  const refuse = async () => {
    throw ValidationError.form("Nothing was saved: the test refused the whole form.");
  };
  return { ...actual, createAccount: refuse, updateAccount: refuse };
});

process.env.DATABASE_URL = TEST_DATABASE_URL;

const {
  default: Accounts,
  action: accountsAction,
  loader: accountsLoader,
} = await import("../../app/routes/settings/accounts.tsx");
const {
  default: AccountDetail,
  action: accountAction,
  loader: accountLoader,
} = await import("../../app/routes/settings/account.tsx");

afterAll(closeTestDatabase);

describe("a refusal that names no field on the account forms", () => {
  it(
    "renders above the add-account form, rather than saying nothing",
    withDatabase(async ({ seedPerson }) => {
      const person = await seedPerson();
      const path = "/settings/accounts";

      const outcome = await accountsAction(
        args(
          post(path, {
            name: "New Brokerage",
            institution: "Fidelity",
            kind: "brokerage",
            ownerId: person.id,
            taxTreatment: "taxable",
          }),
        ),
      );
      const markup = renderRoute(Accounts, path, await accountsLoader(), { actionData: outcome });

      // First child of the form, the place `tax.tsx` and `prices.tsx` give theirs.
      expect(markup).toMatch(
        /<form[^>]*class="panel-form"[^>]*><p class="form-error" role="alert">Nothing was saved: the test refused the whole form\.<\/p>/,
      );
    }),
  );

  it(
    "renders above the account's save form, not at its close checkbox",
    withDatabase(async ({ seedPerson, seedAccount }) => {
      const person = await seedPerson();
      const account = await seedAccount({ owner: person });
      const path = `/settings/accounts/${account.id}`;

      const outcome = await accountAction(
        args(
          post(path, {
            name: "New Brokerage",
            institution: "Fidelity",
            kind: "brokerage",
            ownerId: person.id,
            taxTreatment: "taxable",
          }),
          { accountId: account.id },
        ),
      );
      const markup = renderRoute(
        AccountDetail,
        path,
        await accountLoader(args(get(path), { accountId: account.id })),
        { actionData: outcome },
      );

      expect(markup).toMatch(
        /<form[^>]*class="panel-form"[^>]*><p class="form-error" role="alert">Nothing was saved: the test refused the whole form\.<\/p>/,
      );
      expect(outcome).toMatchObject({ closeError: undefined });
    }),
  );
});
