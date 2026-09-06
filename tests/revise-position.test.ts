/**
 * Correcting one position on the Holdings table (DESIGN.md §5.4). Against real Postgres —
 * every rule at risk lives in one statement. Grouped around the silent failures: editing in
 * place (every past figure moves), a set holding only the corrected row (rest reads as sold),
 * landing behind the statement it corrects (changes nothing), turning an asset into a debt
 * (net worth moves by twice the figure). Every money/quantity assertion is an exact decimal string.
 */
import { afterAll, describe, expect, it } from "vitest";

import { NotFoundError, ValidationError } from "~/lib/input.server";
import { currentPosition, effectiveDate, revisePosition } from "~/lib/positions.server";
import { accountTotal, currentHoldings, netWorth, netWorthAt } from "~/lib/valuation.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";
import { ALL_OWNERS } from "../app/lib/owner-filter.ts";

afterAll(closeTestDatabase);

// today, the way the module under test reads it
const today = (): string => new Date().toISOString().slice(0, 10);

// the refusal a call produced, or a failure if it did not refuse
async function refusalOf(run: () => Promise<unknown>): Promise<ValidationError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("Expected the write to be refused, and it was not.");
}

describe("revisePosition", () => {
  it(
    "restates the quantity, and every figure derived from it moves with it",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      const account = await seedAccount({ kind: "brokerage" });
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
      await seedQuote({ instrument: vti, price: "250.0000" });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: vti, quantity: "100.00000000", costBasisPerShare: "200.0000" }],
      });

      const written = await revisePosition(
        account.id,
        vti.id,
        { quantity: "120", costBasisPerShare: "210" },
        db,
      );

      expect(written.quantity).toBe("120");
      expect(written.asOf).toBe(today());

      const [holding] = await currentHoldings(ALL_OWNERS, db);
      // 120 × 250 = 30,000, against 120 × 210 = 25,200 of basis
      expect(holding?.quantity).toBe("120.00000000");
      expect(holding?.value).toBe("30000.0000");
      expect(holding?.costBasisPerShare).toBe("210.0000");
      expect(holding?.unrealized).toBe("4800.0000");
    }),
  );

  it(
    "appends a statement rather than editing one, so no past figure moves",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose }) => {
      // guards against what an `update holding` invites: the chart reads position sets for
      // every date it plots, so restating a row in place restates the whole history
      const account = await seedAccount({ kind: "brokerage" });
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
      await seedDailyClose({ instrument: vti, date: "2026-06-30", close: "250.0000" });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });

      const before = await netWorthAt(ALL_OWNERS, "2026-06-30", db);
      expect(before.amount).toBe("25000.0000");

      await revisePosition(account.id, vti.id, { quantity: "120", costBasisPerShare: "" }, db);

      // June is still June — the correction speaks from today onward
      expect((await netWorthAt(ALL_OWNERS, "2026-06-30", db)).amount).toBe("25000.0000");

      const sets = await db
        .selectFrom("position_set")
        .select(["id", "source"])
        .where("account_id", "=", account.id)
        .orderBy("id")
        .execute();
      expect(sets).toHaveLength(2);
      expect(sets[1]?.source).toBe("manual");
    }),
  );

  it(
    "carries every other position in the account forward, rather than recording them as sold",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      // §5.2's "a missing row means sold" makes this the sharpest edge: a set holding only the
      // corrected row is a valid write that wipes the rest of the account with no error
      const account = await seedAccount({ kind: "brokerage" });
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
      const bnd = await seedInstrument({ symbol: "BND", name: "Vanguard Total Bond" });
      const cit = await seedInstrument({ symbol: null, name: "Target Retirement 2045 Trust II" });
      await seedQuote({ instrument: vti, price: "250.0000" });
      await seedQuote({ instrument: bnd, price: "70.0000" });

      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [
          { instrument: vti, quantity: "100.00000000", costBasisPerShare: "200.0000" },
          { instrument: bnd, quantity: "50.00000000" },
          { instrument: cit, quantity: "12.34567800", costBasisPerShare: "31.4159" },
        ],
      });

      await revisePosition(account.id, vti.id, { quantity: "120", costBasisPerShare: "200" }, db);

      const holdings = await currentHoldings(ALL_OWNERS, db);
      expect(holdings).toHaveLength(3);

      const byName = new Map(holdings.map((holding) => [holding.instrumentName, holding]));
      expect(byName.get("Vanguard Total Stock Market")?.quantity).toBe("120.00000000");
      // untouched to the last digit, including the null and the eight decimal places of a fractional trust unit
      expect(byName.get("Vanguard Total Bond")?.quantity).toBe("50.00000000");
      expect(byName.get("Vanguard Total Bond")?.costBasisPerShare).toBeNull();
      expect(byName.get("Target Retirement 2045 Trust II")?.quantity).toBe("12.34567800");
      expect(byName.get("Target Retirement 2045 Trust II")?.costBasisPerShare).toBe("31.4159");

      // 120×250 + 50×70 = 33,500, with the unpriced trust left out rather than counted as zero
      expect((await accountTotal(account.id, db))?.amount).toBe("33500.0000");
    }),
  );

  it(
    "does not land behind a statement dated ahead of today",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      // recordedDate allows a statement dated tomorrow (household east of UTC) — a correction
      // dated today would be outranked by the very sheet it corrects, changing no figure at all
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      const account = await seedAccount({ kind: "brokerage" });
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
      await seedQuote({ instrument: vti, price: "250.0000" });
      await seedPositionSet({
        account,
        asOf: tomorrow,
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });

      const written = await revisePosition(
        account.id,
        vti.id,
        { quantity: "120", costBasisPerShare: "" },
        db,
      );

      expect(written.asOf).toBe(tomorrow);
      expect((await currentHoldings(ALL_OWNERS, db))[0]?.quantity).toBe("120.00000000");
    }),
  );

  it(
    "lets the second correction of a day speak, and keeps the first",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      const account = await seedAccount({ kind: "brokerage" });
      const vti = await seedInstrument({ symbol: "VTI" });
      await seedQuote({ instrument: vti, price: "250.0000" });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });

      await revisePosition(account.id, vti.id, { quantity: "120", costBasisPerShare: "" }, db);
      await revisePosition(account.id, vti.id, { quantity: "130", costBasisPerShare: "" }, db);

      // undo is a second correction, not a delete — tie-break on a shared as-of date is
      // created_at then id, same as a re-uploaded statement resolves through
      expect((await currentHoldings(ALL_OWNERS, db))[0]?.quantity).toBe("130.00000000");
      const sets = await db
        .selectFrom("position_set")
        .select("id")
        .where("account_id", "=", account.id)
        .execute();
      expect(sets).toHaveLength(3);
    }),
  );

  it(
    "records a quantity of zero as zero, rather than dropping the row out of reach",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      const account = await seedAccount({ kind: "brokerage" });
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
      await seedQuote({ instrument: vti, price: "250.0000" });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });

      await revisePosition(account.id, vti.id, { quantity: "0", costBasisPerShare: "" }, db);

      // still a row, so the table still prints it and the editor can still reach it — omitting it would mean "sold"
      const holdings = await currentHoldings(ALL_OWNERS, db);
      expect(holdings).toHaveLength(1);
      expect(holdings[0]?.quantity).toBe("0.00000000");
      expect(holdings[0]?.value).toBe("0.0000");
    }),
  );

  it(
    "restates what is owed on a liability without changing its direction",
    withDatabase(async ({ db, seedAccount, seedPositionSet, usdInstrument, seedPerson }) => {
      const owner = await seedPerson({ name: "Alex" });
      const usd = await usdInstrument();
      const loan = await seedAccount({ kind: "liability", name: "Chase Auto Loan", owner });
      await seedPositionSet({
        account: loan,
        asOf: "2026-06-30",
        holdings: [{ instrument: usd, quantity: "-14500.00000000" }],
      });

      // typed the way the table prints it (U+2212, thousands separator) — that's what the box opens containing
      await revisePosition(loan.id, usd.id, { quantity: "−13,900.50", costBasisPerShare: "" }, db);

      expect((await accountTotal(loan.id, db))?.amount).toBe("-13900.5000");
      expect((await netWorth(ALL_OWNERS, db)).amount).toBe("-13900.5000");
    }),
  );

  it(
    "refuses to turn something owed into something held",
    withDatabase(async ({ db, seedAccount, seedPositionSet, usdInstrument }) => {
      // why setBalance refuses a sign outright: a debt restated as an asset moves net worth by
      // twice the loan, reading on every screen as an ordinary correction
      const usd = await usdInstrument();
      const loan = await seedAccount({ kind: "liability", name: "Chase Auto Loan" });
      await seedPositionSet({
        account: loan,
        asOf: "2026-06-30",
        holdings: [{ instrument: usd, quantity: "-14500.00000000" }],
      });

      const refusal = await refusalOf(() =>
        revisePosition(loan.id, usd.id, { quantity: "13900", costBasisPerShare: "" }, db),
      );
      expect(refusal.fieldErrors.quantity).toMatch(/how much rather than which way/);

      // the refusal is the point — debt untouched, no set written
      expect((await accountTotal(loan.id, db))?.amount).toBe("-14500.0000");
      expect(
        await db
          .selectFrom("position_set")
          .select("id")
          .where("account_id", "=", loan.id)
          .execute(),
      ).toHaveLength(1);
    }),
  );

  it(
    "allows a turnaround across two deliberate corrections, through zero",
    withDatabase(async ({ db, seedAccount, seedPositionSet, usdInstrument }) => {
      const usd = await usdInstrument();
      const account = await seedAccount({ kind: "bank" });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: usd, quantity: "500.00000000" }],
      });

      await revisePosition(account.id, usd.id, { quantity: "0", costBasisPerShare: "" }, db);
      await revisePosition(account.id, usd.id, { quantity: "-200", costBasisPerShare: "" }, db);

      // also the only way this application can record an overdraft today — §14.8's limitation
      expect((await accountTotal(account.id, db))?.amount).toBe("-200.0000");
    }),
  );

  it(
    "writes nothing at all for an instrument the account's current statement no longer carries",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      // a form left open while a statement was uploaded elsewhere — carrying the new set
      // forward with no edit would record a correction nobody can find
      const account = await seedAccount({ kind: "brokerage" });
      const vti = await seedInstrument({ symbol: "VTI" });
      const aapl = await seedInstrument({ symbol: "AAPL", name: "Apple" });
      await seedQuote({ instrument: vti, price: "250.0000" });

      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });

      const refusal = await refusalOf(() =>
        revisePosition(account.id, aapl.id, { quantity: "50", costBasisPerShare: "" }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/no longer carries this position/);

      expect(
        await db
          .selectFrom("position_set")
          .select("id")
          .where("account_id", "=", account.id)
          .execute(),
      ).toHaveLength(1);
    }),
  );

  it(
    "refuses a closed account, whose history does not change",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount({
        kind: "brokerage",
        name: "Old Fidelity",
        closedAt: "2026-07-01",
      });
      const vti = await seedInstrument({ symbol: "VTI" });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });

      const refusal = await refusalOf(() =>
        revisePosition(account.id, vti.id, { quantity: "120", costBasisPerShare: "" }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/is closed/);
    }),
  );

  it(
    "refuses a bad figure without touching the account",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      const account = await seedAccount({ kind: "brokerage" });
      const vti = await seedInstrument({ symbol: "VTI" });
      await seedQuote({ instrument: vti, price: "250.0000" });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });

      const refusal = await refusalOf(() =>
        revisePosition(account.id, vti.id, { quantity: "one hundred", costBasisPerShare: "" }, db),
      );
      expect(refusal.fieldErrors.quantity).toMatch(/must be a number/);

      expect((await accountTotal(account.id, db))?.amount).toBe("25000.0000");
    }),
  );

  it(
    "refuses a cost basis whose product with the quantity the view could not value",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      // not a bad write — a successful one no screen can then render. holding_valued casts
      // quantity*cost_basis to numeric(20,4); both operands fit their columns, only the
      // product doesn't, and Holdings is the only screen the editor is reachable from
      const account = await seedAccount({ kind: "brokerage", name: "Fidelity Individual" });
      const vti = await seedInstrument({ symbol: "VTI" });
      await seedQuote({ instrument: vti, price: "250.0000" });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });

      const refusal = await refusalOf(() =>
        revisePosition(
          account.id,
          vti.id,
          // 16 digits: inside numeric(20,4) alone, 10^18 once multiplied by a hundred shares
          { quantity: "100", costBasisPerShare: "1234567890123456" },
          db,
        ),
      );
      expect(refusal.fieldErrors.costBasisPerShare).toMatch(/larger figure than this application/);

      // proof the refusal was the point: the view still renders
      const holdings = await currentHoldings(ALL_OWNERS, db);
      expect(holdings).toHaveLength(1);
      expect(holdings[0]?.costBasisPerShare).toBeNull();
    }),
  );

  it(
    "refuses a quantity whose product with the current price the view could not value",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      // same overflow, other axis: 12 integer digits is a legal quantity, $700,000 a real
      // price — the product is not
      const account = await seedAccount({ kind: "brokerage" });
      const brk = await seedInstrument({ symbol: "BRK-A", name: "Berkshire Hathaway A" });
      await seedQuote({ instrument: brk, price: "700000.0000" });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: brk, quantity: "1.00000000" }],
      });

      const refusal = await refusalOf(() =>
        revisePosition(account.id, brk.id, { quantity: "999999999999", costBasisPerShare: "" }, db),
      );
      expect(refusal.fieldErrors.quantity).toMatch(/larger figure than this application/);

      expect((await currentHoldings(ALL_OWNERS, db))[0]?.quantity).toBe("1.00000000");
    }),
  );

  it(
    "refuses a quantity whose product with the dividend rate the view could not project",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      // third axis, unguarded until migration 0006 checked annual_dividend against the other
      // two — every operand is individually legal, so the older guards wave this through and
      // the view's third cast raises on every read, with nothing saying why
      const account = await seedAccount({ kind: "brokerage" });
      const penny = await seedInstrument({ symbol: "PENNY", name: "Penny Income Trust" });
      await seedQuote({
        instrument: penny,
        price: "0.0001",
        annualDividendPerShare: "1000000.0000",
      });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: penny, quantity: "1.00000000" }],
      });

      const refusal = await refusalOf(() =>
        // 10^11 × 0.0001 = 10^7, fits; 10^11 × 10^6 = 10^17, doesn't
        revisePosition(account.id, penny.id, { quantity: "100000000000" }, db),
      );
      expect(refusal.fieldErrors.quantity).toMatch(/larger annual dividend/);

      // the whole point: the view still answers — before the guard this raised numeric field
      // overflow, with no screen left to correct the row
      const holdings = await currentHoldings(ALL_OWNERS, db);
      expect(holdings).toHaveLength(1);
      expect(holdings[0]?.quantity).toBe("1.00000000");
    }),
  );

  it(
    "still records a position the dividend projection can express",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      // guard bounds the product only — a real income holding pays a real rate and must stay recordable
      const account = await seedAccount({ kind: "brokerage" });
      const schd = await seedInstrument({ symbol: "SCHD", name: "Schwab US Dividend Equity" });
      await seedQuote({ instrument: schd, price: "27.5000", annualDividendPerShare: "1.0300" });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: schd, quantity: "100.00000000" }],
      });

      await revisePosition(account.id, schd.id, { quantity: "5000" }, db);

      const [holding] = await currentHoldings(ALL_OWNERS, db);
      expect(holding?.quantity).toBe("5000.00000000");
      // 5,000 × $1.03, computed by the view rather than restated here
      expect(holding?.annualDividend).toBe("5150.0000");
    }),
  );

  it(
    "still accepts a large position that does fit, right up to the edge",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      // guard bounds the product only — a genuinely large holding isn't a household with a bug
      const account = await seedAccount({ kind: "brokerage" });
      const vti = await seedInstrument({ symbol: "VTI" });
      await seedQuote({ instrument: vti, price: "250.0000" });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });

      // 100 × 99,999,999,999,999 = 9.9999…×10^15, just under the ceiling
      const written = await revisePosition(
        account.id,
        vti.id,
        { quantity: "100", costBasisPerShare: "99999999999999" },
        db,
      );
      expect(written.costBasisPerShare).toBe("99999999999999");
      expect((await currentHoldings(ALL_OWNERS, db))[0]?.costBasis).toBe("9999999999999900.0000");
    }),
  );

  it(
    "refuses a balance typed past the cent, because a cash row's quantity is money",
    withDatabase(async ({ db, seedAccount, seedPositionSet, usdInstrument }) => {
      // second door onto a bank balance — setBalance refuses this figure too; a row editor
      // that took it would store $100.1235, a balance no statement can produce
      const usd = await usdInstrument();
      const account = await seedAccount({ kind: "bank", name: "Ally Savings" });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: usd, quantity: "500.00000000" }],
      });

      const refusal = await refusalOf(() =>
        revisePosition(account.id, usd.id, { quantity: "100.12345678", costBasisPerShare: "" }, db),
      );
      expect(refusal.fieldErrors.quantity).toMatch(/recorded to the cent/);

      // fault in a box, so nothing lands — balance and statement are exactly as they were
      expect((await accountTotal(account.id, db))?.amount).toBe("500.0000");
      expect(
        await db
          .selectFrom("position_set")
          .select("id")
          .where("account_id", "=", account.id)
          .execute(),
      ).toHaveLength(1);
    }),
  );

  it(
    "records a balance that is to the cent, which is the whole figure a statement prints",
    withDatabase(async ({ db, seedAccount, seedPositionSet, usdInstrument }) => {
      const usd = await usdInstrument();
      const account = await seedAccount({ kind: "bank", name: "Ally Savings" });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: usd, quantity: "500.00000000" }],
      });

      const written = await revisePosition(
        account.id,
        usd.id,
        { quantity: "100.12", costBasisPerShare: "" },
        db,
      );

      expect(written.quantity).toBe("100.12");
      expect((await currentHoldings(ALL_OWNERS, db))[0]?.quantity).toBe("100.12000000");
      expect((await accountTotal(account.id, db))?.amount).toBe("100.1200");
    }),
  );

  it(
    "leaves a share quantity at its eight places, which is not money and is reported that way",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      // the rule the cent check must not spread to — a brokerage really does report a
      // fractional share to eight places
      const account = await seedAccount({ kind: "brokerage" });
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
      await seedQuote({ instrument: vti, price: "250.0000" });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });

      const written = await revisePosition(
        account.id,
        vti.id,
        { quantity: "1.23456789", costBasisPerShare: "" },
        db,
      );

      expect(written.quantity).toBe("1.23456789");
      expect((await currentHoldings(ALL_OWNERS, db))[0]?.quantity).toBe("1.23456789");
      // 1.23456789 × 250 = 308.6419725, as the view rounds it to the column
      expect((await currentHoldings(ALL_OWNERS, db))[0]?.value).toBe("308.6420");
    }),
  );

  it(
    "raises a not-found for an account id that names nothing",
    withDatabase(async ({ db }) => {
      // separate from a refusal: a bad figure re-renders the form, a missing row is a 404
      await expect(
        revisePosition("999999999", "1", { quantity: "1", costBasisPerShare: "" }, db),
      ).rejects.toBeInstanceOf(NotFoundError);
    }),
  );
});

describe("effectiveDate", () => {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  it("is today for a statement already in the past", () => {
    expect(effectiveDate("2026-06-30")).toBe(today);
    expect(effectiveDate(yesterday)).toBe(today);
  });

  it("is the statement's own date when that is still ahead of today", () => {
    // recordedDate allows exactly one day of slack (household east of UTC) — a correction
    // dated today would be outranked by the very sheet it corrects
    expect(effectiveDate(tomorrow)).toBe(tomorrow);
  });

  it("is the date the editor's note promises, which is why it is exported", () => {
    // the note under an open row names this before the click — misreporting it would misreport the write's own effect
    expect(effectiveDate(today)).toBe(today);
  });
});

describe("currentPosition", () => {
  it(
    "reads the row out of the account's current statement, at the column's own scale",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount({ kind: "401k" });
      const cit = await seedInstrument({ symbol: null, name: "Target Retirement 2045 Trust II" });
      await seedPositionSet({
        account,
        asOf: "2026-03-31",
        holdings: [{ instrument: cit, quantity: "11.00000000" }],
      });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: cit, quantity: "12.34567800", costBasisPerShare: "31.4159" }],
      });

      expect(await currentPosition(account.id, cit.id, db)).toEqual({
        accountId: account.id,
        instrumentId: cit.id,
        instrumentName: "Target Retirement 2045 Trust II",
        quantity: "12.34567800",
        costBasisPerShare: "31.4159",
        asOf: "2026-06-30",
        // null rather than absent — a collective trust nobody quotes is still held, joined left exactly as the view joins it
        price: null,
        // the third operand holding_valued multiplies by, for the product guard alone — null for the same reason as price
        annualDividendPerShare: null,
        // read alongside price because the write needs it: anything but "fixed" is a count, not a sum of money
        priceSource: "feed",
      });
    }),
  );

  it(
    "answers null rather than raising for ids that are not ids",
    withDatabase(async ({ db }) => {
      // both halves arrive from a URL — 'x'::bigint is a driver error a reader would meet as a 500, not a closed editor
      expect(await currentPosition("x", "1", db)).toBeNull();
      expect(await currentPosition("1", "'; drop table holding; --", db)).toBeNull();
    }),
  );
});
