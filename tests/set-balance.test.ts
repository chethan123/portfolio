// setBalance for a single-position account (DESIGN.md §5.2), against real Postgres — sign, numeric exactness, tie-break all live there
import { afterAll, describe, expect, it } from "vitest";

import { ValidationError, NotFoundError } from "~/lib/input.server";
import { lastRecorded, setBalance } from "~/lib/balances.server";
import { accountTotal, netWorth } from "~/lib/valuation.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";
import { ALL_OWNERS } from "../app/lib/owner-filter.ts";

afterAll(closeTestDatabase);

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
      // USD prices at 1.00 every date (0001_initial_schema.sql seeds the quote + 1970 close)
      expect(total?.amount).toBe("42000.0000");
      expect(total?.coverage).toEqual({ known: 1, total: 1 });
    }),
  );

  it(
    "records a loan as a negative quantity, from the kind and not from the typing",
    withDatabase(async ({ db, seedAccount }) => {
      const loan = await seedAccount({ kind: "liability", name: "Chase Auto Loan" });

      // typed the way a person reads it off a statement: what is owed, unsigned
      const recorded = await setBalance(loan.id, { amount: "14,500.00", asOf: "2026-08-16" }, db);

      expect(recorded.amount).toBe("-14500.00");
      expect((await accountTotal(loan.id, db))?.amount).toBe("-14500.0000");
    }),
  );

  it(
    "moves household net worth down by the loan, not up by it",
    withDatabase(async ({ db, seedAccount, seedPerson }) => {
      // a debt landing as an asset swings net worth by twice the loan, silently
      const owner = await seedPerson({ name: "Alex" });
      const bank = await seedAccount({ kind: "bank", owner });
      const loan = await seedAccount({ kind: "liability", owner });

      await setBalance(bank.id, { amount: "42000", asOf: "2026-08-16" }, db);
      expect((await netWorth(ALL_OWNERS, db)).amount).toBe("42000.0000");

      await setBalance(loan.id, { amount: "14500", asOf: "2026-08-16" }, db);
      expect((await netWorth(ALL_OWNERS, db)).amount).toBe("27500.0000");
    }),
  );

  it(
    "records a zero without giving it a sign",
    withDatabase(async ({ db, seedAccount }) => {
      const loan = await seedAccount({ kind: "liability" });

      // a paid-off loan — "-0.00" would read as a debt of nothing written as though it were something
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

      // an empty position set is legal and reads "sold everything" — must never happen by accident
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

      // id moves even though the date didn't — distinguishes a submission from a refusal
      expect(afterSecond?.id).not.toBe(afterFirst?.id);

      // two sets, not one edited in place: undo is free because nothing was overwritten (§5.2)
      const sets = await db
        .selectFrom("position_set")
        .select("id")
        .where("account_id", "=", bank.id)
        .execute();
      expect(sets).toHaveLength(2);

      // tie-break on a shared as-of date is the same one a re-uploaded statement resolves through
      expect((await accountTotal(bank.id, db))?.amount).toBe("1100.0000");
    }),
  );

  it(
    "does not let a balance recorded for an earlier date outrank a later one",
    withDatabase(async ({ db, seedAccount }) => {
      const bank = await seedAccount({ kind: "bank" });

      await setBalance(bank.id, { amount: "1100.00", asOf: "2026-08-16" }, db);
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

      expect((await accountTotal(brokerage.id, db))?.amount).toBe("25000.0000");
    }),
  );

  // regression: it.each handed the case value directly once, silently discarding it and leaving `ira` untested
  it.each(["401k", "ira"] as const)("refuses a %s account for the same reason", (kind) =>
    withDatabase(async ({ db, seedAccount }) => {
      const account = await seedAccount({ kind });
      const refusal = await refusalOf(() =>
        setBalance(account.id, { amount: "1000.00", asOf: "2026-08-16" }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/holds securities/);
    })(),
  );

  it(
    "refuses an account holding securities under a bank label, which the kind alone cannot catch",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      // regression (SET-1): a kind change can't reach this state anymore, but an upload still can — commitUpload never reads kind
      const bank = await seedAccount({ kind: "bank", name: "Fidelity Individual" });
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
      const schd = await seedInstrument({ symbol: "SCHD", name: "Schwab US Dividend Equity" });
      await seedQuote({ instrument: vti, price: "250.0000" });
      await seedQuote({ instrument: schd, price: "75.0000" });
      await seedPositionSet({
        account: bank,
        asOf: "2026-08-16",
        holdings: [
          { instrument: vti, quantity: "100.00000000" },
          { instrument: schd, quantity: "40.00000000" },
        ],
      });

      const refusal = await refusalOf(() =>
        setBalance(bank.id, { amount: "5000.00", asOf: "2026-08-16" }, db),
      );

      expect(refusal.fieldErrors.form).toMatch(/Vanguard Total Stock Market/);
      expect(refusal.fieldErrors.form).toMatch(/Schwab US Dividend Equity/);

      const sets = await db
        .selectFrom("position_set")
        .select("id")
        .where("account_id", "=", bank.id)
        .execute();
      expect(sets).toHaveLength(1);
      expect((await accountTotal(bank.id, db))?.amount).toBe("28000.0000");
    }),
  );

  it(
    "records a balance over a position that was sold out, which is stored as zero rather than dropped",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, usdInstrument }) => {
      // a sold-out position is a zero row, not dropped — a guard counting rows, not non-zero quantities, would lock this out for good
      const bank = await seedAccount({ kind: "bank" });
      const usd = await usdInstrument();
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
      await seedPositionSet({
        account: bank,
        asOf: "2026-08-16",
        holdings: [
          { instrument: usd, quantity: "500.00000000" },
          { instrument: vti, quantity: "0.00000000" },
        ],
      });

      const recorded = await setBalance(bank.id, { amount: "600.00", asOf: "2026-08-17" }, db);

      expect(recorded.amount).toBe("600.00");
      expect((await accountTotal(bank.id, db))?.amount).toBe("600.0000");
    }),
  );

  it(
    "refuses a money-market fund, which is priced as fixed without being cash",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      // "cash" resolves by symbol AND price_source together — price_source='fixed' alone is tempting and wrong (seed-demo.ts files SPAXX as fixed too)
      const bank = await seedAccount({ kind: "bank", name: "Fidelity Cash Management" });
      const spaxx = await seedInstrument({
        symbol: "SPAXX",
        name: "Fidelity Government Money Market Fund",
        priceSource: "fixed",
      });
      await seedPositionSet({
        account: bank,
        asOf: "2026-08-16",
        holdings: [{ instrument: spaxx, quantity: "16000.00000000" }],
      });

      const refusal = await refusalOf(() =>
        setBalance(bank.id, { amount: "16000.00", asOf: "2026-08-16" }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/Fidelity Government Money Market Fund/);
    }),
  );

  it(
    "writes to the seeded USD row when a second instrument carries the same symbol",
    withDatabase(async ({ db, seedAccount, seedInstrument, usdInstrument }) => {
      // an upload's instrument step can create a second USD row with no warning (ING-8)
      const bank = await seedAccount({ kind: "bank" });
      const seeded = await usdInstrument();
      const second = await seedInstrument({
        symbol: "USD",
        name: "US Dollar",
        priceSource: "manual",
      });

      const recorded = await setBalance(bank.id, { amount: "1000.00", asOf: "2026-08-16" }, db);
      expect(recorded.amount).toBe("1000.00");

      const written = await db
        .selectFrom("holding")
        .innerJoin("position_set", "position_set.id", "holding.position_set_id")
        .select("holding.instrument_id")
        .where("position_set.account_id", "=", bank.id)
        .execute();

      // the other row has no price — writing to it would read as an uncovered holding, not money
      expect(written.map((holding) => holding.instrument_id)).toEqual([seeded.id]);
      expect(seeded.id).not.toBe(second.id);
    }),
  );

  it(
    "refuses a cash line the seed did not create, rather than dropping it silently",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      // accepted limitation: no instrument_alias seeded, so "CASH" becomes its own instrument — escape is zeroing on Holdings, not re-uploading
      const bank = await seedAccount({ kind: "bank", name: "Schwab Checking" });
      const cash = await seedInstrument({
        symbol: "CASH",
        name: "Cash and Cash Investments",
        priceSource: "manual",
      });
      await seedPositionSet({
        account: bank,
        asOf: "2026-08-16",
        holdings: [{ instrument: cash, quantity: "3200.00000000" }],
      });

      const refusal = await refusalOf(() =>
        setBalance(bank.id, { amount: "3200.00", asOf: "2026-08-16" }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/Cash and Cash Investments/);
      expect(refusal.fieldErrors.form).toMatch(/Holdings/);
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
      // "not a number" would bury the real problem: a brokerage shouldn't have reached this form
      const brokerage = await seedAccount({ kind: "brokerage" });
      const refusal = await refusalOf(() =>
        setBalance(brokerage.id, { amount: "not a number", asOf: "nonsense" }, db),
      );

      expect(refusal.fieldErrors.form).toMatch(/holds securities/);
      expect(refusal.fieldErrors.amount).toBeUndefined();
    }),
  );

  it(
    "reports the statement refusal before the field refusals, for the same reason",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      // the statement pre-check sits ahead of parseInput deliberately — else "not a number" hides what a fix would then sell
      const bank = await seedAccount({ kind: "bank", name: "Fidelity Individual" });
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
      await seedPositionSet({
        account: bank,
        asOf: "2026-08-16",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });

      const refusal = await refusalOf(() =>
        setBalance(bank.id, { amount: "not a number", asOf: "nonsense" }, db),
      );

      expect(refusal.fieldErrors.form).toMatch(/Vanguard Total Stock Market/);
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

      // id moves — what the form keys its boxes on: a landed write empties them, a refusal doesn't
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

      // panel wording differs by source, so typing over it reads as correction or contradiction
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
