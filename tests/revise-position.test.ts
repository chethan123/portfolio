/**
 * Correcting one position on the Holdings table (DESIGN.md §5.4).
 *
 * Against a real Postgres, because every rule at risk here lives in one
 * statement the database executes: which rows get carried forward, which set
 * ends up speaking for the account, and whether anything is written at all when
 * the guard inside the CTE finds nothing.
 *
 * The tests are grouped around the ways this write could be silently wrong
 * rather than around the function's arguments, because none of these failures
 * announces itself on any screen:
 *
 *   * it edits in place, and every past figure quietly moves with it;
 *   * it writes a set holding only the corrected row, and the rest of the
 *     account reads as sold;
 *   * it lands behind the statement it corrects, and changes nothing;
 *   * it turns an asset into a debt, moving net worth by twice the figure;
 *   * it finds nothing to correct and writes a position set anyway.
 *
 * Every money and quantity assertion is an exact decimal string. `toBeCloseTo`
 * would hide precisely the driver-coercion regression the whole design is
 * arranged around.
 */
import { afterAll, describe, expect, it } from "vitest";

import { NotFoundError, ValidationError } from "~/lib/input.server";
import { currentPosition, effectiveDate, revisePosition } from "~/lib/positions.server";
import { accountTotal, currentHoldings, netWorth, netWorthAt } from "~/lib/valuation.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";

afterAll(closeTestDatabase);

/** Today, the way the module under test reads it. */
const today = (): string => new Date().toISOString().slice(0, 10);

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

      const [holding] = await currentHoldings(db);
      // 120 × 250 = 30,000, against 120 × 210 = 25,200 of basis.
      expect(holding?.quantity).toBe("120.00000000");
      expect(holding?.value).toBe("30000.0000");
      expect(holding?.costBasisPerShare).toBe("210.0000");
      expect(holding?.unrealized).toBe("4800.0000");
    }),
  );

  it(
    "appends a statement rather than editing one, so no past figure moves",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose }) => {
      // The failure this guards is the one an `update holding` invites: the
      // chart reads position sets for every date it plots, so restating a row
      // in place restates the whole history back to that statement's date.
      const account = await seedAccount({ kind: "brokerage" });
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
      await seedDailyClose({ instrument: vti, date: "2026-06-30", close: "250.0000" });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });

      const before = await netWorthAt("2026-06-30", db);
      expect(before.amount).toBe("25000.0000");

      await revisePosition(account.id, vti.id, { quantity: "120", costBasisPerShare: "" }, db);

      // June is still June. The correction speaks from today onward.
      expect((await netWorthAt("2026-06-30", db)).amount).toBe("25000.0000");

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
      // §5.2's "a missing row means sold" is what makes this the whole feature's
      // sharpest edge: a set holding only the corrected row is a valid write that
      // wipes the rest of the account with no error anywhere.
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

      const holdings = await currentHoldings(db);
      expect(holdings).toHaveLength(3);

      const byName = new Map(holdings.map((holding) => [holding.instrumentName, holding]));
      expect(byName.get("Vanguard Total Stock Market")?.quantity).toBe("120.00000000");
      // Untouched to the last digit, including the null the statement carried
      // and the eight decimal places of a fractional trust unit.
      expect(byName.get("Vanguard Total Bond")?.quantity).toBe("50.00000000");
      expect(byName.get("Vanguard Total Bond")?.costBasisPerShare).toBeNull();
      expect(byName.get("Target Retirement 2045 Trust II")?.quantity).toBe("12.34567800");
      expect(byName.get("Target Retirement 2045 Trust II")?.costBasisPerShare).toBe("31.4159");

      // 120 × 250 + 50 × 70 = 33,500, with the unpriced trust left out rather
      // than counted as zero.
      expect((await accountTotal(account.id, db))?.amount).toBe("33500.0000");
    }),
  );

  it(
    "does not land behind a statement dated ahead of today",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      // `recordedDate` allows a statement to be dated tomorrow, for a household
      // east of UTC. A correction dated today would then be outranked by the
      // very sheet it corrects — a write that succeeds and changes no figure
      // anywhere, which is the one outcome a form must never produce.
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
      expect((await currentHoldings(db))[0]?.quantity).toBe("120.00000000");
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

      // Undo is a second correction, not a delete: the tie-break on a shared
      // as-of date is `created_at` then `id`, the same one a re-uploaded
      // statement resolves through.
      expect((await currentHoldings(db))[0]?.quantity).toBe("130.00000000");
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

      // Still a row, so the table still prints it and the editor can still
      // reach it. Omitting it would mean "sold" — true, and unreachable.
      const holdings = await currentHoldings(db);
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

      // Typed the way the table prints it, U+2212 and thousands separator and
      // all, because that is what the box opens containing.
      await revisePosition(loan.id, usd.id, { quantity: "−13,900.50", costBasisPerShare: "" }, db);

      expect((await accountTotal(loan.id, db))?.amount).toBe("-13900.5000");
      expect((await netWorth(db)).amount).toBe("-13900.5000");
    }),
  );

  it(
    "refuses to turn something owed into something held",
    withDatabase(async ({ db, seedAccount, seedPositionSet, usdInstrument }) => {
      // The failure a signed box invites, and the reason `setBalance` refuses a
      // sign outright: a debt restated as an asset moves household net worth by
      // twice the loan, and reads on every screen as an ordinary correction.
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

      // The refusal is the point: the debt is untouched and no set was written.
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

      // Which is also the only way this application can record an overdraft
      // today — §14.8's limitation, unchanged: the set-balance form still
      // cannot, and this one asks for it twice.
      expect((await accountTotal(account.id, db))?.amount).toBe("-200.0000");
    }),
  );

  it(
    "writes nothing at all for an instrument the account's current statement no longer carries",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      // A form left open while a statement was uploaded elsewhere. Carrying the
      // new set forward and applying no edit would be a position set recording
      // a correction nobody can find.
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
      // The nastiest failure this module can produce, and it is not a bad
      // write — it is a *successful* one that no screen can then render.
      // `holding_valued` casts `quantity * cost_basis_per_share` to
      // numeric(20, 4), so a product that will not round to under 10^16 makes
      // the view raise on every request. Both operands are individually well
      // inside their columns; only the product is not. And since Holdings is
      // the only screen the editor is reachable from, the row that broke it
      // could not then be corrected from the application at all.
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
          // Sixteen digits: inside numeric(20, 4) on its own, and 10^18 once
          // multiplied by a hundred shares.
          { quantity: "100", costBasisPerShare: "1234567890123456" },
          db,
        ),
      );
      expect(refusal.fieldErrors.costBasisPerShare).toMatch(/larger figure than this application/);

      // The proof that the refusal was the point: the view still renders.
      const holdings = await currentHoldings(db);
      expect(holdings).toHaveLength(1);
      expect(holdings[0]?.costBasisPerShare).toBeNull();
    }),
  );

  it(
    "refuses a quantity whose product with the current price the view could not value",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      // The same overflow on the other axis. Twelve integer digits is a legal
      // quantity and $700,000 is a real share price; the product is not.
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

      expect((await currentHoldings(db))[0]?.quantity).toBe("1.00000000");
    }),
  );

  it(
    "still accepts a large position that does fit, right up to the edge",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      // The guard must bound the product and nothing more: a household with a
      // genuinely large holding is not a household with a bug.
      const account = await seedAccount({ kind: "brokerage" });
      const vti = await seedInstrument({ symbol: "VTI" });
      await seedQuote({ instrument: vti, price: "250.0000" });
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });

      // 100 × 99,999,999,999,999 = 9.9999…×10^15, just under the ceiling.
      const written = await revisePosition(
        account.id,
        vti.id,
        { quantity: "100", costBasisPerShare: "99999999999999" },
        db,
      );
      expect(written.costBasisPerShare).toBe("99999999999999");
      expect((await currentHoldings(db))[0]?.costBasis).toBe("9999999999999900.0000");
    }),
  );

  it(
    "refuses a balance typed past the cent, because a cash row's quantity is money",
    withDatabase(async ({ db, seedAccount, seedPositionSet, usdInstrument }) => {
      // The second door onto a bank balance. `setBalance` refuses this figure,
      // and a row editor that took it would store $100.1235 — a balance no
      // statement can produce, reached by editing the same account elsewhere.
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

      // A fault in a box, so nothing lands: the balance and the account's one
      // statement are exactly as they were.
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
      expect((await currentHoldings(db))[0]?.quantity).toBe("100.12000000");
      expect((await accountTotal(account.id, db))?.amount).toBe("100.1200");
    }),
  );

  it(
    "leaves a share quantity at its eight places, which is not money and is reported that way",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      // The rule the cent check must not spread to. A brokerage really does
      // report a fractional share to eight places, and narrowing every quantity
      // to two would refuse a figure copied straight off a statement.
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
      expect((await currentHoldings(db))[0]?.quantity).toBe("1.23456789");
      // 1.23456789 × 250 = 308.6419725, as the view rounds it to the column.
      expect((await currentHoldings(db))[0]?.value).toBe("308.6420");
    }),
  );

  it(
    "raises a not-found for an account id that names nothing",
    withDatabase(async ({ db }) => {
      // Separate from a refusal because the two become different responses: a
      // bad figure re-renders the form, a missing row is a 404.
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
    // `recordedDate` allows exactly one day of slack, for a household east of
    // UTC. A correction dated today would be outranked by the very sheet it
    // corrects — a write that succeeds and changes no figure anywhere.
    expect(effectiveDate(tomorrow)).toBe(tomorrow);
  });

  it("is the date the editor's note promises, which is why it is exported", () => {
    // The note under an open row names this before the click. A screen that
    // said "dated today" while the write carried tomorrow would be misreporting
    // its own effect.
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
        // Null rather than absent: a collective trust nobody quotes is still
        // held, so the quote is joined left exactly as the view joins it.
        price: null,
        // Read alongside the price because the write needs it: anything but
        // `fixed` is a count of something rather than a sum of money.
        priceSource: "feed",
      });
    }),
  );

  it(
    "answers null rather than raising for ids that are not ids",
    withDatabase(async ({ db }) => {
      // Both halves arrive from a URL, so `'x'::bigint` is a driver error a
      // reader would meet as a 500 rather than as a closed editor.
      expect(await currentPosition("x", "1", db)).toBeNull();
      expect(await currentPosition("1", "'; drop table holding; --", db)).toBeNull();
    }),
  );
});
