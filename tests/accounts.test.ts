/**
 * Recording the accounts the household holds.
 *
 * Driven through `accounts.server.ts`, with the two rules that reach beyond it
 * — a closed account's effect on a figure, and the refusal to remove a person
 * who owns one — checked through the modules that actually own them, the
 * valuation module and `people.server.ts`. Asserting closure by reading
 * `closed_at` back would prove the column was written and nothing about the
 * number on the screen.
 */
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
      // DESIGN.md §4.2: there are no joint accounts and no per-account split, so
      // the modelling answer is two accounts at one institution.
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
      await closeAccount(retired.id, db);

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
      // Would reach Postgres as a malformed bigint and fail as a 500 rather than
      // as a message on the form.
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
  /**
   * What the Kind select submits: every field as it stands, with one changed.
   * The institution and tax treatment match `seedAccount`'s defaults, so the
   * only thing any of these edits asks for is the kind.
   */
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

      // Under `kind`, beside the select that caused it: the settings route
      // hands `fieldErrors` to the form as they are and never splits out the
      // form-level key, so a form-level refusal here would render nowhere.
      expect(errors.kind).toMatch(/Vanguard Total Stock Market/);
      expect(errors.form).toBeUndefined();

      // And it names a way out, the way its sibling in `setBalance` does
      // (`balances.server.ts:184-191`). The guard condition read back — "change
      // the kind on an account whose statement is a single cash balance" — is
      // the refusal restated, not something the reader can go and do.
      expect(errors.kind).toMatch(/on Holdings/);

      expect((await getAccount(account.id, db)).kind).toBe("brokerage");
    }),
  );

  it(
    "refuses it for a closed account too, whose securities no current-holdings view lists",
    withDatabase(async ({ db, seedPerson, seedAccount, seedInstrument, seedPositionSet }) => {
      // The case that decides which reader answers "what does this hold".
      // `holding_valued` drops closed accounts (`0002_holding_valued.sql:140`),
      // so a guard built on the view would answer "holds nothing" here and let
      // the relabel through — on the one account where nothing in the app can
      // put the securities back, since every write path refuses a closed one.
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
      await closeAccount(account.id, db);

      const errors = await refusalOf(updateAccount(account.id, kindChange(account, "bank"), db));

      expect(errors.kind).toMatch(/Vanguard Total Stock Market/);

      // Named, and then told the truth about what to do with them: the two
      // doors the open refusal names — zero them on Holdings, upload a
      // statement without them — are both shut on a closed account, so this
      // one says the label is stuck instead (§5.3).
      expect(errors.kind).toMatch(/does not change/);
      expect(errors.kind).not.toMatch(/on Holdings/);

      expect((await getAccount(account.id, db)).kind).toBe("brokerage");
    }),
  );

  it(
    "refuses savings relabelled as a debt, in one hop and with no securities anywhere",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet, usdInstrument }) => {
      // The other half of report `SET-1`: no write at all, and $42,000 of
      // savings counted as debt on every screen and every historical date,
      // because both views apply `kind` retroactively.
      //
      // This case and the one below are the pair that tells the shipped
      // condition — `input.kind !== existing.kind && acceptsSetBalance(input.kind)`,
      // asked of the new kind and the rows and never of the old kind — from one
      // carrying an `existing.kind` term. Swap in
      // `acceptsSetBalance(input.kind) && !acceptsSetBalance(existing.kind)` and
      // only these two fail: every other refusal in this file arrives from a
      // securities kind, which that condition catches too. They are not a
      // longer way of writing the two-hop case below, and folding them into it
      // puts the hole back.
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
      // The direction above, mirrored: the stored quantity is negative, so the
      // relabel would turn $14,500 owed into $14,500 held. Both directions,
      // because a condition can be wrong in one of them alone — and see the
      // note above for what these two discriminate.
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
      // Pins the decision, not the wording. §5.3 accepts that a mislabel on a
      // closed account is permanent — every escape refuses a closed account and
      // nothing in the app reopens one — so the refusal an open account gets,
      // which sends it to its own page or to Holdings, would be sending this
      // reader to two doors that are not there: `/accounts/:id` 404s for a
      // closed account (`account.tsx:137-144`) and `holding_valued` drops it,
      // so Holdings lists nothing of its to correct.
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
      await closeAccount(savings.id, db);

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
      // The refusal is asked of the new kind and the rows, never of the old
      // kind, which is what makes routing around it pointless: the first hop is
      // a legitimate edit and stays allowed, and the second is asked exactly
      // the question the direct edit would have been asked.
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

      // The sign lives in the quantity (DESIGN.md §2), so relabelling alone
      // would turn $14,500 of debt into $14,500 of savings with no write.
      expect(errors.kind).toMatch(/money owed/);
      expect((await getAccount(loan.id, db)).kind).toBe("brokerage");
    }),
  );

  // One case over the transitions the guard must leave alone, rather than a
  // copy per transition: over-refusing is the failure mode on this side, and
  // both guides promise every field stays editable.
  //
  // The case values are threaded in by calling `withDatabase` per case rather
  // than handing `it.each` the wrapper directly — see the note at
  // `set-balance.test.ts`'s kind cases for what that silently discards.
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

      const closed = await closeAccount(account.id, db);

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

      expect(await netWorth(db)).toEqual({
        amount: "12500.0000",
        coverage: { known: 1, total: 1 },
      });

      await closeAccount(checking.id, db);

      // Gone from today's figure — and reported as zero holdings rather than as
      // a total computed from one, so nothing reads as an empty account.
      expect(await netWorth(db)).toEqual({ amount: "0.0000", coverage: { known: 0, total: 0 } });

      // And unchanged for a date it was open on.
      expect(await netWorthAt("2026-02-14", db)).toEqual({
        amount: "12500.0000",
        coverage: { known: 1, total: 1 },
      });
    }),
  );

  it(
    "keeps the original closing date when closed twice",
    withDatabase(async ({ db, seedPerson, seedAccount }) => {
      const account = await seedAccount({ owner: await seedPerson() });

      const first = await closeAccount(account.id, db);
      const second = await closeAccount(account.id, db);

      // A second click must not move a boundary historical figures are computed
      // against.
      expect(second.closedAt).toEqual(first.closedAt);
    }),
  );

  it(
    "refuses to close an account that does not exist",
    withDatabase(async ({ db }) => {
      await expect(closeAccount("999999", db)).rejects.toBeInstanceOf(NotFoundError);
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
      await closeAccount(account.id, db);

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
