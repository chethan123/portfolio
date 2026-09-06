// Accounts (accounts.server.ts). Closure's effect on a figure and person-removal refusal
// are checked through valuation.server.ts and people.server.ts, not by reading closed_at back.
import { afterAll, describe, expect, it } from "vitest";

import {
  closeAccount,
  createAccount,
  getAccount,
  listAccounts,
  updateAccount,
} from "~/lib/accounts.server";
import { NotFoundError, ValidationError } from "~/lib/input.server";
import { createPerson, listPeople, removePerson } from "~/lib/people.server";
import { netWorth, netWorthAt } from "~/lib/valuation.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";

import type { AccountKind } from "~/lib/valuation.server";
import { ALL_OWNERS } from "../app/lib/owner-filter.ts";

afterAll(closeTestDatabase);

/** The fields a valid submission carries, so a test can vary just one. */
const validInput = (ownerId: string) => ({
  name: "Fidelity Taxable",
  institution: "Fidelity",
  kind: "brokerage",
  ownerId,
  taxTreatment: "taxable",
  externalAccountNumber: "Z12-345678",
});

async function refusalOf(action: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await action;
  } catch (error) {
    if (error instanceof ValidationError) return { ...error.fieldErrors };
    throw error;
  }
  throw new Error("expected the input to be refused");
}

describe("recording accounts", () => {
  it(
    "records an account with an owner and a tax treatment",
    withDatabase(async ({ db }) => {
      const alice = await createPerson({ name: "Alice" }, db);

      const account = await createAccount(validInput(alice.id), db);

      expect(account).toMatchObject({
        name: "Fidelity Taxable",
        institution: "Fidelity",
        kind: "brokerage",
        ownerId: alice.id,
        ownerName: "Alice",
        taxTreatment: "taxable",
        externalAccountNumber: "Z12-345678",
        closedAt: null,
        isClosed: false,
      });
    }),
  );

  it(
    "treats a blank account number as not recorded rather than as an empty one",
    withDatabase(async ({ db }) => {
      const alice = await createPerson({ name: "Alice" }, db);

      const account = await createAccount(
        { ...validInput(alice.id), externalAccountNumber: "  " },
        db,
      );

      expect(account.externalAccountNumber).toBeNull();
    }),
  );

  it(
    "represents a plan holding Traditional and Roth money as two accounts",
    withDatabase(async ({ db }) => {
      // DESIGN.md §4.2: no joint accounts, no per-account split — two accounts, one institution.
      const alice = await createPerson({ name: "Alice" }, db);

      await createAccount(
        {
          ...validInput(alice.id),
          name: "Acme 401k — Traditional",
          institution: "Acme Retirement",
          kind: "401k",
          taxTreatment: "tax_deferred",
        },
        db,
      );
      await createAccount(
        {
          ...validInput(alice.id),
          name: "Acme 401k — Roth",
          institution: "Acme Retirement",
          kind: "401k",
          taxTreatment: "tax_free",
        },
        db,
      );

      expect(
        (await listAccounts(db)).map((account) => [account.name, account.taxTreatment]),
      ).toEqual([
        ["Acme 401k — Roth", "tax_free"],
        ["Acme 401k — Traditional", "tax_deferred"],
      ]);
    }),
  );

  it(
    "lists open accounts before closed ones, and keeps closed ones listed",
    withDatabase(async ({ db, seedPerson, seedAccount }) => {
      const owner = await seedPerson();
      const retired = await seedAccount({ name: "Old Brokerage", owner });
      await seedAccount({ name: "Zebra Checking", owner });
      await closeAccount(retired.id, { confirmClose: "true" }, db);

      expect((await listAccounts(db)).map((account) => account.name)).toEqual([
        "Zebra Checking",
        "Old Brokerage",
      ]);
    }),
  );
});

describe("refusing bad input", () => {
  it(
    "requires a kind, a tax treatment and an owner",
    withDatabase(async ({ db }) => {
      const errors = await refusalOf(
        createAccount({ name: "Something", institution: "Somewhere" }, db),
      );

      expect(errors.kind).toMatch(/kind/i);
      expect(errors.taxTreatment).toMatch(/tax treatment/i);
      expect(errors.ownerId).toMatch(/owner/i);
    }),
  );

  it(
    "reports every bad field at once, rather than one per attempt",
    withDatabase(async ({ db }) => {
      const errors = await refusalOf(createAccount({}, db));

      expect(Object.keys(errors).sort()).toEqual(["kind", "name", "ownerId", "taxTreatment"]);
    }),
  );

  it(
    "refuses an owner who does not exist, as a message rather than a constraint violation",
    withDatabase(async ({ db }) => {
      const errors = await refusalOf(createAccount(validInput("999999"), db));

      expect(errors.ownerId).toMatch(/owner/i);
    }),
  );

  it(
    "refuses an owner id that is not an id at all",
    withDatabase(async ({ db }) => {
      // Malformed bigint would 500 in Postgres rather than fail as a form message.
      expect((await refusalOf(createAccount(validInput("not-an-id"), db))).ownerId).toMatch(
        /owner/i,
      );
    }),
  );

  it(
    "refuses a kind outside the ones the schema allows",
    withDatabase(async ({ db }) => {
      const alice = await createPerson({ name: "Alice" }, db);

      expect(
        (await refusalOf(createAccount({ ...validInput(alice.id), kind: "crypto" }, db))).kind,
      ).toMatch(/kind/i);
    }),
  );

  it(
    "accepts a blank institution, which is free text rather than a required choice",
    withDatabase(async ({ db }) => {
      const alice = await createPerson({ name: "Alice" }, db);

      const account = await createAccount({ ...validInput(alice.id), institution: "" }, db);

      expect(account.institution).toBe("");
    }),
  );

  it(
    "reports an unknown account as not found rather than as an error",
    withDatabase(async ({ db }) => {
      await expect(getAccount("999999", db)).rejects.toBeInstanceOf(NotFoundError);
      await expect(getAccount("not-an-id", db)).rejects.toBeInstanceOf(NotFoundError);
    }),
  );
});

describe("editing an account", () => {
  it(
    "corrects a wrong tax treatment",
    withDatabase(async ({ db }) => {
      const alice = await createPerson({ name: "Alice" }, db);
      const account = await createAccount(
        { ...validInput(alice.id), name: "Roth IRA", kind: "ira", taxTreatment: "taxable" },
        db,
      );

      const corrected = await updateAccount(
        account.id,
        { ...validInput(alice.id), name: "Roth IRA", kind: "ira", taxTreatment: "tax_free" },
        db,
      );

      expect(corrected.taxTreatment).toBe("tax_free");
      expect((await getAccount(account.id, db)).taxTreatment).toBe("tax_free");
    }),
  );

  it(
    "moves an account to a different owner",
    withDatabase(async ({ db }) => {
      const alice = await createPerson({ name: "Alice" }, db);
      const bea = await createPerson({ name: "Bea" }, db);
      const account = await createAccount(validInput(alice.id), db);

      const moved = await updateAccount(account.id, validInput(bea.id), db);

      expect(moved).toMatchObject({ ownerId: bea.id, ownerName: "Bea" });
    }),
  );

  it(
    "leaves the account untouched when the edit is refused",
    withDatabase(async ({ db }) => {
      const alice = await createPerson({ name: "Alice" }, db);
      const account = await createAccount(validInput(alice.id), db);

      await refusalOf(updateAccount(account.id, { ...validInput(alice.id), name: "" }, db));

      expect((await getAccount(account.id, db)).name).toBe("Fidelity Taxable");
    }),
  );

  it(
    "does not close an account as a side effect of editing it",
    withDatabase(async ({ db }) => {
      const alice = await createPerson({ name: "Alice" }, db);
      const account = await createAccount(validInput(alice.id), db);

      await updateAccount(account.id, { ...validInput(alice.id), name: "Renamed" }, db);

      expect((await getAccount(account.id, db)).isClosed).toBe(false);
    }),
  );
});

describe("changing an account's kind", () => {
  /** Kind select submits every field with one changed; institution/tax treatment match seedAccount's defaults. */
  const kindChange = (account: { name: string; ownerId: string }, kind: AccountKind) => ({
    name: account.name,
    institution: "Test Institution",
    kind,
    ownerId: account.ownerId,
    taxTreatment: "taxable",
  });

  it(
    "refuses a one-balance kind for an account whose statement lists securities",
    withDatabase(async ({ db, seedPerson, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount({
        name: "Fidelity Individual",
        kind: "brokerage",
        owner: await seedPerson({ name: "Alice" }),
      });
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
      await seedPositionSet({
        account,
        asOf: "2026-08-16",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });

      const errors = await refusalOf(updateAccount(account.id, kindChange(account, "bank"), db));

      // Must land under `kind`: settings route renders fieldErrors as-is, no form-level key.
      expect(errors.kind).toMatch(/Vanguard Total Stock Market/);
      expect(errors.form).toBeUndefined();

      // Names an actual way out (as setBalance's guard in balances.server.ts does).
      expect(errors.kind).toMatch(/on Holdings/);

      expect((await getAccount(account.id, db)).kind).toBe("brokerage");
    }),
  );

  it(
    "refuses it for a closed account too, whose securities no current-holdings view lists",
    withDatabase(async ({ db, seedPerson, seedAccount, seedInstrument, seedPositionSet }) => {
      // holding_valued drops closed accounts — a guard built on that view would wrongly allow this relabel.
      const account = await seedAccount({
        name: "Old Brokerage",
        kind: "brokerage",
        owner: await seedPerson({ name: "Alice" }),
      });
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
      await seedPositionSet({
        account,
        asOf: "2026-08-16",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });
      await closeAccount(account.id, { confirmClose: "true" }, db);

      const errors = await refusalOf(updateAccount(account.id, kindChange(account, "bank"), db));

      expect(errors.kind).toMatch(/Vanguard Total Stock Market/);

      // Closed account: both of the open refusal's escape doors are shut, so this says the label is stuck (§5.3).
      expect(errors.kind).toMatch(/does not change/);
      expect(errors.kind).not.toMatch(/on Holdings/);

      expect((await getAccount(account.id, db)).kind).toBe("brokerage");
    }),
  );

  it(
    "refuses savings relabelled as a debt, in one hop and with no securities anywhere",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet, usdInstrument }) => {
      // report SET-1: check must be against the new kind, not the old — else $42,000 savings retroactively counts as debt.
      const savings = await seedAccount({
        name: "Ally Online Savings",
        kind: "bank",
        owner: await seedPerson({ name: "Alice" }),
      });
      await seedPositionSet({
        account: savings,
        asOf: "2026-08-16",
        holdings: [{ instrument: await usdInstrument(), quantity: "42000.00000000" }],
      });

      const errors = await refusalOf(
        updateAccount(savings.id, kindChange(savings, "liability"), db),
      );

      expect(errors.kind).toMatch(/money held/);
      expect((await getAccount(savings.id, db)).kind).toBe("bank");
    }),
  );

  it(
    "refuses a debt relabelled as savings, the same flip read from the other side",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet, usdInstrument }) => {
      // Mirrored direction: stored quantity is negative, so relabel would turn $14,500 owed into $14,500 held.
      const loan = await seedAccount({
        name: "Chase Auto Loan",
        kind: "liability",
        owner: await seedPerson({ name: "Alice" }),
      });
      await seedPositionSet({
        account: loan,
        asOf: "2026-08-16",
        holdings: [{ instrument: await usdInstrument(), quantity: "-14500.00000000" }],
      });

      const errors = await refusalOf(updateAccount(loan.id, kindChange(loan, "bank"), db));

      expect(errors.kind).toMatch(/money owed/);
      expect((await getAccount(loan.id, db)).kind).toBe("liability");
    }),
  );

  it(
    "tells a closed account its label is stuck, rather than naming doors it does not have",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet, usdInstrument }) => {
      // Closed account's mislabel is permanent (§5.3): /accounts/:id 404s when closed, and holding_valued excludes it.
      const savings = await seedAccount({
        name: "Ally Online Savings",
        kind: "bank",
        owner: await seedPerson({ name: "Alice" }),
      });
      await seedPositionSet({
        account: savings,
        asOf: "2026-08-16",
        holdings: [{ instrument: await usdInstrument(), quantity: "42000.00000000" }],
      });
      await closeAccount(savings.id, { confirmClose: "true" }, db);

      const errors = await refusalOf(
        updateAccount(savings.id, kindChange(savings, "liability"), db),
      );

      expect(errors.kind).toMatch(/does not change/);
      expect(errors.kind).not.toMatch(/on Holdings/);
      expect((await getAccount(savings.id, db)).kind).toBe("bank");
    }),
  );

  it(
    "refuses a debt relabelled as a bank balance, even by way of a securities kind",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet, usdInstrument }) => {
      // Guard checks new kind + rows, not old kind — routing through an intermediate kind doesn't bypass it.
      const loan = await seedAccount({
        name: "Chase Auto Loan",
        kind: "liability",
        owner: await seedPerson({ name: "Alice" }),
      });
      const usd = await usdInstrument();
      await seedPositionSet({
        account: loan,
        asOf: "2026-08-16",
        holdings: [{ instrument: usd, quantity: "-14500.00000000" }],
      });

      const hopped = await updateAccount(loan.id, kindChange(loan, "brokerage"), db);
      expect(hopped.kind).toBe("brokerage");

      const errors = await refusalOf(updateAccount(loan.id, kindChange(loan, "bank"), db));

      // Sign lives in quantity (DESIGN.md §2) — relabel alone would turn debt into savings.
      expect(errors.kind).toMatch(/money owed/);
      expect((await getAccount(loan.id, db)).kind).toBe("brokerage");
    }),
  );

  // One case per allowed transition — over-refusal is the failure mode here.
  // withDatabase is called per case rather than passed to it.each directly (see set-balance.test.ts).
  it.each([
    ["bank", "liability", "no statement"],
    ["brokerage", "401k", "securities"],
    ["401k", "ira", "securities"],
    ["ira", "brokerage", "securities"],
    ["bank", "brokerage", "cash"],
    ["bank", "liability", "a zero balance"],
  ] as const)("allows %s → %s with %s", (from, to, statement) =>
    withDatabase(
      async ({ db, seedPerson, seedAccount, seedInstrument, seedPositionSet, usdInstrument }) => {
        const account = await seedAccount({ kind: from, owner: await seedPerson() });

        if (statement !== "no statement") {
          const holding =
            statement === "securities"
              ? {
                  instrument: await seedInstrument({
                    symbol: "VTI",
                    name: "Vanguard Total Stock Market",
                  }),
                  quantity: "100.00000000",
                }
              : {
                  instrument: await usdInstrument(),
                  quantity: statement === "cash" ? "42000.00000000" : "0.00000000",
                };
          await seedPositionSet({ account, asOf: "2026-08-16", holdings: [holding] });
        }

        const changed = await updateAccount(account.id, kindChange(account, to), db);

        expect(changed.kind).toBe(to);
        expect((await getAccount(account.id, db)).kind).toBe(to);
      },
    )(),
  );
});

describe("closing an account", () => {
  it(
    "records a closing date rather than removing anything",
    withDatabase(async ({ db, seedPerson, seedAccount }) => {
      const account = await seedAccount({ owner: await seedPerson() });

      const closed = await closeAccount(account.id, { confirmClose: "true" }, db);

      expect(closed.isClosed).toBe(true);
      expect(closed.closedAt).toBeInstanceOf(Date);
      // Still there: history is computed from it.
      expect(await getAccount(account.id, db)).toMatchObject({ id: account.id });
    }),
  );

  it(
    "stops counting toward current net worth, and still counts before it closed",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet, usdInstrument }) => {
      const usd = await usdInstrument();
      const owner = await seedPerson();
      const checking = await seedAccount({ name: "Checking", kind: "bank", owner });
      await seedPositionSet({
        account: checking,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "12500.00000000" }],
      });

      expect(await netWorth(ALL_OWNERS, db)).toEqual({
        amount: "12500.0000",
        coverage: { known: 1, total: 1 },
      });

      await closeAccount(checking.id, { confirmClose: "true" }, db);

      // Zero holdings, not a total computed from one — nothing reads as an "empty" account.
      expect(await netWorth(ALL_OWNERS, db)).toEqual({ amount: "0.0000", coverage: { known: 0, total: 0 } });

      expect(await netWorthAt(ALL_OWNERS, "2026-02-14", db)).toEqual({
        amount: "12500.0000",
        coverage: { known: 1, total: 1 },
      });
    }),
  );

  it(
    "keeps the original closing date when closed twice",
    withDatabase(async ({ db, seedPerson, seedAccount }) => {
      const account = await seedAccount({ owner: await seedPerson() });

      const first = await closeAccount(account.id, { confirmClose: "true" }, db);
      const second = await closeAccount(account.id, { confirmClose: "true" }, db);

      // A second click must not move a boundary historical figures are computed against.
      expect(second.closedAt).toEqual(first.closedAt);
    }),
  );

  it(
    "refuses to close without the acknowledgement, and the account stays open",
    withDatabase(async ({ db, seedPerson, seedAccount }) => {
      const account = await seedAccount({ name: "Old Brokerage", owner: await seedPerson() });

      const message = (await refusalOf(closeAccount(account.id, {}, db))).form ?? "";

      expect(message).toContain("Old Brokerage");
      expect(message).toContain("one-way");
      expect((await getAccount(account.id, db)).isClosed).toBe(false);
    }),
  );

  it(
    "keeps the original closing date on a re-close, ticked or not",
    withDatabase(async ({ db, seedPerson, seedAccount }) => {
      const account = await seedAccount({ owner: await seedPerson() });
      const first = await closeAccount(account.id, { confirmClose: "true" }, db);

      // Stale form on an already-closed account is a no-op, not a demand for a tick.
      const unticked = await closeAccount(account.id, {}, db);

      expect(unticked.isClosed).toBe(true);
      expect(unticked.closedAt).toEqual(first.closedAt);
    }),
  );

  it(
    "refuses to close an account that does not exist",
    withDatabase(async ({ db }) => {
      await expect(
        closeAccount("999999", { confirmClose: "true" }, db),
      ).rejects.toBeInstanceOf(NotFoundError);
    }),
  );
});

describe("removing a person who owns accounts", () => {
  it(
    "is refused, naming the accounts",
    withDatabase(async ({ db, seedPerson, seedAccount }) => {
      const alice = await seedPerson({ name: "Alice" });
      await seedAccount({ name: "Fidelity Taxable", owner: alice });
      await seedAccount({ name: "Checking", owner: alice });

      const errors = await refusalOf(removePerson(alice.id, db));
      const message = errors.form ?? "";

      expect(message).toContain("Alice");
      expect(message).toContain("Fidelity Taxable");
      expect(message).toContain("Checking");
      // Not a foreign-key violation leaking through.
      expect(message).not.toMatch(/constraint|violates|owner_id/i);

      expect((await listPeople(db)).map((person) => person.name)).toEqual(["Alice"]);
    }),
  );

  it(
    "is refused for a closed account too, since history still needs the owner",
    withDatabase(async ({ db, seedPerson, seedAccount }) => {
      const alice = await seedPerson({ name: "Alice" });
      const account = await seedAccount({ name: "Old Brokerage", owner: alice });
      await closeAccount(account.id, { confirmClose: "true" }, db);

      const message = (await refusalOf(removePerson(alice.id, db))).form ?? "";

      expect(message).toContain("Old Brokerage");
      expect(message).toContain("closed");
    }),
  );

  it(
    "succeeds once the accounts belong to somebody else",
    withDatabase(async ({ db, seedPerson, seedAccount }) => {
      const alice = await seedPerson({ name: "Alice" });
      const bea = await createPerson({ name: "Bea" }, db);
      const account = await seedAccount({ name: "Fidelity Taxable", owner: alice });

      await updateAccount(
        account.id,
        {
          name: "Fidelity Taxable",
          institution: "Fidelity",
          kind: "brokerage",
          ownerId: bea.id,
          taxTreatment: "taxable",
        },
        db,
      );
      await removePerson(alice.id, db);

      expect((await listPeople(db)).map((person) => person.name)).toEqual(["Bea"]);
    }),
  );
});
