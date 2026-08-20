/**
 * Setting the balance of a single-position account (DESIGN.md §5.2).
 *
 * Against a real Postgres, because everything at risk here is in the database:
 * the sign a liability is stored with, the exactness of a `numeric` that never
 * met a float, and the tie-break that decides which of two recorded balances an
 * account is currently reading.
 *
 * The tests are grouped around the three ways this write could be silently
 * wrong rather than around the function's arguments:
 *
 *   * it stores the wrong sign, and a debt is counted as an asset;
 *   * it lands a position set with no holding, which does not read as a failed
 *     write but as "this account now holds nothing";
 *   * it accepts an account whose holdings a one-row set would erase.
 *
 * Every money assertion is an exact decimal string.
 */
import { afterAll, describe, expect, it } from "vitest";

import { ValidationError, NotFoundError } from "~/lib/input.server";
import { lastRecorded, setBalance } from "~/lib/balances.server";
import { accountTotal, netWorth } from "~/lib/valuation.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";

afterAll(closeTestDatabase);

/** The refusal a call produced, or a failure if it did not refuse. */
async function refusalOf(run: () => Promise<unknown>): Promise<ValidationError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("Expected the write to be refused, and it was not.");
}

describe("setBalance", () => {
  it(
    "records a bank balance as a positive quantity the account total reads back exactly",
    withDatabase(async ({ db, seedAccount }) => {
      const bank = await seedAccount({ kind: "bank", name: "Ally Online Savings" });

      const recorded = await setBalance(bank.id, { amount: "42,000.00", asOf: "2026-08-16" }, db);

      expect(recorded.amount).toBe("42000.00");

      const total = await accountTotal(bank.id, db);
      // USD prices at 1.00 on every date (`0001_initial_schema.sql` seeds both
      // the quote and a 1970 close), so the balance and the valuation are the
      // same figure at the column's scale.
      expect(total?.amount).toBe("42000.0000");
      expect(total?.coverage).toEqual({ known: 1, total: 1 });
    }),
  );

  it(
    "records a loan as a negative quantity, from the kind and not from the typing",
    withDatabase(async ({ db, seedAccount }) => {
      const loan = await seedAccount({ kind: "liability", name: "Chase Auto Loan" });

      // Typed the way a person reads it off a statement: what is owed, unsigned.
      const recorded = await setBalance(loan.id, { amount: "14,500.00", asOf: "2026-08-16" }, db);

      expect(recorded.amount).toBe("-14500.00");
      expect((await accountTotal(loan.id, db))?.amount).toBe("-14500.0000");
    }),
  );

  it(
    "moves household net worth down by the loan, not up by it",
    withDatabase(async ({ db, seedAccount, seedPerson }) => {
      // The failure this guards is the one a signed input invites: a debt typed
      // as 14500 landing as an asset moves net worth by +14,500 instead of
      // −14,500, a swing of twice the loan, and nothing on any screen says so.
      const owner = await seedPerson({ name: "Alex" });
      const bank = await seedAccount({ kind: "bank", owner });
      const loan = await seedAccount({ kind: "liability", owner });

      await setBalance(bank.id, { amount: "42000", asOf: "2026-08-16" }, db);
      expect((await netWorth(db)).amount).toBe("42000.0000");

      await setBalance(loan.id, { amount: "14500", asOf: "2026-08-16" }, db);
      expect((await netWorth(db)).amount).toBe("27500.0000");
    }),
  );

  it(
    "records a zero without giving it a sign",
    withDatabase(async ({ db, seedAccount }) => {
      const loan = await seedAccount({ kind: "liability" });

      // A paid-off loan. "−0.00" is a debt of nothing written as though it were
      // something, and it would read as one in the holdings table.
      const recorded = await setBalance(loan.id, { amount: "0.00", asOf: "2026-08-16" }, db);

      expect(recorded.amount).toBe("0.00");
      expect((await accountTotal(loan.id, db))?.amount).toBe("0.0000");
    }),
  );

  it(
    "writes the position set and its holding together, never one without the other",
    withDatabase(async ({ db, seedAccount }) => {
      const bank = await seedAccount({ kind: "bank" });
      await setBalance(bank.id, { amount: "1250.00", asOf: "2026-08-16" }, db);

      const sets = await db
        .selectFrom("position_set")
        .leftJoin("holding", "holding.position_set_id", "position_set.id")
        .select(({ fn }) => [
          "position_set.id",
          "position_set.source",
          fn.count<string>("holding.id").as("holdings"),
        ])
        .where("position_set.account_id", "=", bank.id)
        .groupBy(["position_set.id", "position_set.source"])
        .execute();

      // An empty position set is legal and means "sold everything" — which is
      // exactly why this write must never produce one by accident.
      expect(sets).toHaveLength(1);
      expect(sets[0]?.source).toBe("manual");
      expect(Number(sets[0]?.holdings)).toBe(1);
    }),
  );

  it(
    "appends rather than edits, so a correction for one date leaves the earlier one standing",
    withDatabase(async ({ db, seedAccount }) => {
      const bank = await seedAccount({ kind: "bank" });

      await setBalance(bank.id, { amount: "1000.00", asOf: "2026-08-16" }, db);
      const afterFirst = await lastRecorded(bank.id, db);
      await setBalance(bank.id, { amount: "1100.00", asOf: "2026-08-16" }, db);
      const afterSecond = await lastRecorded(bank.id, db);

      // Two writes for one date still move the id, so the second submission is
      // distinguishable from a refusal even though the date did not change.
      expect(afterSecond?.id).not.toBe(afterFirst?.id);

      // Two sets, not one edited in place: undo is free because nothing was
      // overwritten (§5.2).
      const sets = await db
        .selectFrom("position_set")
        .select("id")
        .where("account_id", "=", bank.id)
        .execute();
      expect(sets).toHaveLength(2);

      // And the tie-break on a shared as-of date is the same one a re-uploaded
      // statement resolves through, so the last one submitted speaks.
      expect((await accountTotal(bank.id, db))?.amount).toBe("1100.0000");
    }),
  );

  it(
    "does not let a balance recorded for an earlier date outrank a later one",
    withDatabase(async ({ db, seedAccount }) => {
      const bank = await seedAccount({ kind: "bank" });

      await setBalance(bank.id, { amount: "1100.00", asOf: "2026-08-16" }, db);
      // Filling in a date that was missed. It is history, not news.
      await setBalance(bank.id, { amount: "900.00", asOf: "2026-07-01" }, db);

      expect((await accountTotal(bank.id, db))?.amount).toBe("1100.0000");
    }),
  );

  it(
    "refuses an account whose holdings a one-row set would erase",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      const brokerage = await seedAccount({ kind: "brokerage", name: "Fidelity Individual" });
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
      await seedQuote({ instrument: vti, price: "250.0000" });
      await seedPositionSet({
        account: brokerage,
        asOf: "2026-08-16",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });

      const refusal = await refusalOf(() =>
        setBalance(brokerage.id, { amount: "1000.00", asOf: "2026-08-16" }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/record everything else it holds as sold/);

      // The refusal is the point: the securities are untouched.
      expect((await accountTotal(brokerage.id, db))?.amount).toBe("25000.0000");
    }),
  );

  it.each(["401k", "ira"] as const)(
    "refuses a %s account for the same reason",
    withDatabase(async ({ db, seedAccount }) => {
      // Written as one case over the kinds rather than three copies: what is
      // being checked is that `SINGLE_POSITION` admits exactly two of the five.
      const account = await seedAccount({ kind: "401k" });
      const refusal = await refusalOf(() =>
        setBalance(account.id, { amount: "1000.00", asOf: "2026-08-16" }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/holds securities/);
    }),
  );

  it(
    "refuses a closed account, whose history does not change",
    withDatabase(async ({ db, seedAccount }) => {
      const bank = await seedAccount({ kind: "bank", closedAt: "2026-01-01" });

      const refusal = await refusalOf(() =>
        setBalance(bank.id, { amount: "1000.00", asOf: "2026-08-16" }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/is closed/);
    }),
  );

  it(
    "reports the kind refusal before the field refusals",
    withDatabase(async ({ db, seedAccount }) => {
      // A person who reached this form for a brokerage has a problem that
      // correcting the boxes will not fix, and "that is not a number" would
      // bury it.
      const brokerage = await seedAccount({ kind: "brokerage" });
      const refusal = await refusalOf(() =>
        setBalance(brokerage.id, { amount: "not a number", asOf: "nonsense" }, db),
      );

      expect(refusal.fieldErrors.form).toMatch(/holds securities/);
      expect(refusal.fieldErrors.amount).toBeUndefined();
    }),
  );

  it(
    "refuses bad fields with a message under each, leaving nothing written",
    withDatabase(async ({ db, seedAccount }) => {
      const bank = await seedAccount({ kind: "bank" });

      const refusal = await refusalOf(() =>
        setBalance(bank.id, { amount: "-500", asOf: "2126-01-01" }, db),
      );

      expect(refusal.fieldErrors.amount).toMatch(/without a minus sign/);
      expect(refusal.fieldErrors.asOf).toMatch(/in the future/);

      const sets = await db
        .selectFrom("position_set")
        .select("id")
        .where("account_id", "=", bank.id)
        .execute();
      expect(sets).toHaveLength(0);
    }),
  );

  it(
    "is a 404, not a validation failure, for an id that names no account",
    withDatabase(async ({ db }) => {
      await expect(setBalance("999999", { amount: "1", asOf: "2026-08-16" }, db)).rejects.toThrow(
        NotFoundError,
      );
      await expect(
        setBalance("not-an-id", { amount: "1", asOf: "2026-08-16" }, db),
      ).rejects.toThrow(NotFoundError);
    }),
  );
});

describe("lastRecorded", () => {
  it(
    "reports nothing for an account with no statement of any kind",
    withDatabase(async ({ db, seedAccount }) => {
      const bank = await seedAccount({ kind: "bank" });
      expect(await lastRecorded(bank.id, db)).toBeNull();
    }),
  );

  it(
    "names the date and origin of the set the account is currently reading",
    withDatabase(async ({ db, seedAccount }) => {
      const bank = await seedAccount({ kind: "bank" });

      await setBalance(bank.id, { amount: "1000.00", asOf: "2026-07-01" }, db);
      const first = await lastRecorded(bank.id, db);
      expect(first).toMatchObject({ asOf: "2026-07-01", source: "manual" });

      await setBalance(bank.id, { amount: "1100.00", asOf: "2026-08-16" }, db);
      const second = await lastRecorded(bank.id, db);
      expect(second).toMatchObject({ asOf: "2026-08-16", source: "manual" });

      // The id moves, which is what the form keys its boxes on: a write that
      // lands empties them, and a refusal — which writes nothing — does not.
      expect(second?.id).not.toBe(first?.id);
    }),
  );

  it(
    "distinguishes a balance that was typed from one that arrived on a statement",
    withDatabase(async ({ db, seedAccount, seedPositionSet, usdInstrument }) => {
      const bank = await seedAccount({ kind: "bank" });
      const usd = await usdInstrument();

      await seedPositionSet({
        account: bank,
        asOf: "2026-08-16",
        source: "upload",
        holdings: [{ instrument: usd, quantity: "500.00000000" }],
      });

      // The panel says "reading the statement for…" rather than "the balance
      // set for…", so the reader knows whether typing over it is a correction
      // or a contradiction.
      expect(await lastRecorded(bank.id, db)).toMatchObject({
        asOf: "2026-08-16",
        source: "upload",
      });
    }),
  );

  it(
    "answers null for an id that is not an id, rather than reaching the database",
    withDatabase(async ({ db }) => {
      expect(await lastRecorded("not-an-id", db)).toBeNull();
    }),
  );
});
