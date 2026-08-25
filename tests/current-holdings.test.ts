/**
 * The rules `holding_valued` exists to keep every consumer agreeing on.
 *
 * Everything here is driven through the query module's public functions against
 * a real Postgres, seeded through the fixture builder. Nothing asserts on
 * generated SQL, on which joins the view uses, or on an index existing — those
 * are implementation and would fail on a harmless refactor.
 *
 * Every money assertion is an exact decimal string at the stored scale.
 * `toBeCloseTo` would hide precisely the driver-coercion regression this slice
 * was built to prevent.
 */
import { afterAll, describe, expect, it } from "vitest";

import { currentHoldings, netWorth } from "~/lib/valuation.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";

afterAll(closeTestDatabase);

describe("the valuation rule", () => {
  it(
    "sums a share position, a cash balance and a liability into one total with no branch",
    withDatabase(async ({ db, seedPerson, seedAccount, seedInstrument, seedPositionSet, seedQuote, usdInstrument }) => {
      const owner = await seedPerson({ name: "Alice" });
      const usd = await usdInstrument();
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market ETF" });
      await seedQuote({ instrument: vti, price: "250.0000" });

      const brokerage = await seedAccount({ name: "Fidelity Taxable", owner, kind: "brokerage" });
      const checking = await seedAccount({ name: "Checking", owner, kind: "bank" });
      const loan = await seedAccount({ name: "Car loan", owner, kind: "liability" });

      await seedPositionSet({
        account: brokerage,
        asOf: "2026-01-31",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });
      await seedPositionSet({
        account: checking,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "12500.00000000" }],
      });
      // The sign lives in quantity, against a positive price. There is no
      // liability branch anywhere for this to travel down.
      await seedPositionSet({
        account: loan,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "-8000.00000000" }],
      });

      // 25,000 + 12,500 − 8,000
      expect(await netWorth(db)).toEqual({
        amount: "29500.0000",
        coverage: { known: 3, total: 3 },
      });
    }),
  );

  it(
    "carries the account, owner and classification every dashboard grouping needs",
    withDatabase(async ({ db, seedPerson, seedAccount, seedClassification, seedInstrument, seedPositionSet, seedQuote }) => {
      const owner = await seedPerson({ name: "Alice" });
      const equities = await seedClassification({ name: "Total stock market", assetClass: "equity" });
      const account = await seedAccount({
        name: "Empower 401k — Roth",
        institution: "Empower",
        kind: "401k",
        owner,
        taxTreatment: "tax_free",
      });
      const vti = await seedInstrument({
        symbol: "VTI",
        name: "Vanguard Total Stock Market ETF",
        quoteType: "ETF",
        priceSource: "feed",
        classification: equities,
      });
      await seedQuote({ instrument: vti, price: "250.0000" });
      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: vti, quantity: "100.00000000", costBasisPerShare: "200.0000" }],
      });

      expect(await currentHoldings(db)).toEqual([
        {
          accountId: account.id,
          accountName: "Empower 401k — Roth",
          institution: "Empower",
          accountKind: "401k",
          taxTreatment: "tax_free",
          ownerId: owner.id,
          ownerName: "Alice",
          instrumentId: vti.id,
          symbol: "VTI",
          instrumentName: "Vanguard Total Stock Market ETF",
          quoteType: "ETF",
          classification: "Total stock market",
          assetClass: "equity",
          quantity: "100.00000000",
          price: "250.0000",
          value: "25000.0000",
          costBasisPerShare: "200.0000",
          costBasis: "20000.0000",
          unrealized: "5000.0000",
          isPriced: true,
          isStale: false,
          // No rate on the quote, so the figure is a zero and not a null: the
          // view's coalesce is the whole definition of it.
          annualDividend: "0.0000",
        },
      ]);
    }),
  );

  it(
    "reports zero from nothing when no account holds anything",
    withDatabase(async ({ db }) => {
      expect(await netWorth(db)).toEqual({ amount: "0.0000", coverage: { known: 0, total: 0 } });
      expect(await currentHoldings(db)).toEqual([]);
    }),
  );
});

describe("which position set counts as current", () => {
  it(
    "takes the newest as-of date for an account",
    withDatabase(async ({ db, seedAccount, seedPositionSet, usdInstrument }) => {
      const account = await seedAccount();
      const usd = await usdInstrument();

      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "100.00000000" }],
      });
      await seedPositionSet({
        account,
        asOf: "2026-02-28",
        holdings: [{ instrument: usd, quantity: "250.00000000" }],
      });

      expect((await currentHoldings(db)).map((holding) => holding.quantity)).toEqual([
        "250.00000000",
      ]);
    }),
  );

  it(
    "does not let an older position set uploaded late displace a newer one",
    withDatabase(async ({ db, seedAccount, seedPositionSet, usdInstrument }) => {
      const account = await seedAccount();
      const usd = await usdInstrument();

      await seedPositionSet({
        account,
        asOf: "2026-02-28",
        holdings: [{ instrument: usd, quantity: "250.00000000" }],
      });
      // January's statement, found in a drawer and uploaded after February's.
      // It is a later insert with a higher id, and it must lose.
      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "100.00000000" }],
      });

      expect((await currentHoldings(db)).map((holding) => holding.quantity)).toEqual([
        "250.00000000",
      ]);
    }),
  );

  it(
    "resolves a re-upload for an as-of date that already has a set to the correction",
    withDatabase(async ({ db, seedAccount, seedPositionSet, usdInstrument }) => {
      const account = await seedAccount();
      const usd = await usdInstrument();

      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "100.00000000" }],
      });
      // The same statement re-uploaded after a mis-mapped column was fixed.
      // Without a tie-break this is a coin flip; with one it is the correction.
      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "175.00000000" }],
      });

      expect((await currentHoldings(db)).map((holding) => holding.quantity)).toEqual([
        "175.00000000",
      ]);
    }),
  );

  it(
    "breaks a shared as-of date on creation time before insertion order",
    withDatabase(async ({ db, seedAccount, seedPositionSet, usdInstrument }) => {
      const account = await seedAccount();
      const usd = await usdInstrument();

      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        createdAt: "2026-02-02T09:00:00Z",
        holdings: [{ instrument: usd, quantity: "175.00000000" }],
      });
      // Inserted second — so it has the higher id — but created first.
      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        createdAt: "2026-02-01T09:00:00Z",
        holdings: [{ instrument: usd, quantity: "100.00000000" }],
      });

      expect((await currentHoldings(db)).map((holding) => holding.quantity)).toEqual([
        "175.00000000",
      ]);
    }),
  );

  it(
    "excludes a closed account from what is held today",
    withDatabase(async ({ db, seedAccount, seedPositionSet, usdInstrument }) => {
      const usd = await usdInstrument();
      const open = await seedAccount({ name: "Checking" });
      const closed = await seedAccount({ name: "Old savings", closedAt: "2026-02-01T00:00:00Z" });

      await seedPositionSet({
        account: open,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "100.00000000" }],
      });
      await seedPositionSet({
        account: closed,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "999999.00000000" }],
      });

      expect((await currentHoldings(db)).map((holding) => holding.accountName)).toEqual([
        "Checking",
      ]);
      expect(await netWorth(db)).toEqual({
        amount: "100.0000",
        coverage: { known: 1, total: 1 },
      });
    }),
  );
});

describe("partial data, told honestly", () => {
  it(
    "still shows a holding whose instrument has never been quoted, flagged unpriced",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();
      // A collective investment trust in a workplace plan: no public symbol, no
      // quote on any retail API.
      const trust = await seedInstrument({
        symbol: null,
        name: "Vanguard Target Retirement 2045 Trust II",
        priceSource: "manual",
      });

      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: trust, quantity: "42.00000000", costBasisPerShare: "10.0000" }],
      });

      const [holding] = await currentHoldings(db);

      // The row is here rather than dropped: an inner join to `quote` would
      // make it vanish and understate every total with no error anywhere.
      expect(holding).toMatchObject({
        instrumentName: "Vanguard Target Retirement 2045 Trust II",
        symbol: null,
        quantity: "42.00000000",
        price: null,
        value: null,
        costBasis: "420.0000",
        unrealized: null,
        isPriced: false,
      });
    }),
  );

  it(
    "leaves an unpriced holding out of the total and counts it in coverage",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote, usdInstrument }) => {
      const account = await seedAccount();
      const usd = await usdInstrument();
      const priced = await seedInstrument({ symbol: "VTI" });
      const unpriced = await seedInstrument({ symbol: null, priceSource: "manual" });
      await seedQuote({ instrument: priced, price: "250.0000" });

      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [
          { instrument: priced, quantity: "10.00000000" },
          { instrument: usd, quantity: "500.00000000" },
          { instrument: unpriced, quantity: "42.00000000" },
        ],
      });

      // 2,500 + 500, and the unpriced holding contributes nothing — but the
      // count says so, so a screen can label "based on 2 of 3 holdings" rather
      // than implying the total is complete.
      expect(await netWorth(db)).toEqual({
        amount: "3000.0000",
        coverage: { known: 2, total: 3 },
      });
    }),
  );

  it(
    "leaves unrealized null when cost basis is unknown, rather than reporting a fake gain",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      const account = await seedAccount({ kind: "401k", taxTreatment: "tax_deferred" });
      const fund = await seedInstrument({ symbol: "VTI" });
      await seedQuote({ instrument: fund, price: "250.0000" });

      // A 401k statement that omits cost basis, which is the common case.
      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: fund, quantity: "100.00000000" }],
      });

      const [holding] = await currentHoldings(db);

      // Zero here would report a $25,000 gain on a position whose basis is
      // simply not known.
      expect(holding).toMatchObject({
        value: "25000.0000",
        costBasisPerShare: null,
        costBasis: null,
        unrealized: null,
      });
      // The price is known, so the holding is still fully counted in net worth.
      expect(await netWorth(db)).toEqual({
        amount: "25000.0000",
        coverage: { known: 1, total: 1 },
      });
    }),
  );

  it(
    "uses a stale price rather than discarding it, and flags the row",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      const account = await seedAccount();
      const fund = await seedInstrument({ symbol: "VTI" });
      // A failed refresh keeps the last known price and marks it stale.
      await seedQuote({ instrument: fund, price: "250.0000", isStale: true });

      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: fund, quantity: "100.00000000" }],
      });

      const [holding] = await currentHoldings(db);

      expect(holding).toMatchObject({
        price: "250.0000",
        value: "25000.0000",
        isPriced: true,
        isStale: true,
      });
      // Last known value, not a zero and not a null.
      expect(await netWorth(db)).toEqual({
        amount: "25000.0000",
        coverage: { known: 1, total: 1 },
      });
    }),
  );
});

describe("what a holding is projected to pay", () => {
  it(
    "multiplies a fractional share count by the per-share rate at the money scale",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      const account = await seedAccount();
      const fund = await seedInstrument({ symbol: "SCHD", name: "Schwab US Dividend Equity ETF" });
      await seedQuote({ instrument: fund, price: "27.5000", annualDividendPerShare: "3.6000" });

      // A dividend-reinvested holding against a rate carrying four decimals:
      // scale 8 by scale 4, so the product is at scale 12 before the view's one
      // cast brings it back to money.
      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: fund, quantity: "10.50000000" }],
      });

      const [holding] = await currentHoldings(db);

      // 10.5 × 3.6000, exact and at the stored scale. `toBeCloseTo` would pass
      // just as happily on a figure that had been through a double, which is
      // the coercion this whole seam exists to keep out.
      expect(holding).toMatchObject({ quantity: "10.50000000", annualDividend: "37.8000" });
    }),
  );

  it(
    "counts a holding with no rate as paying nothing, whichever of the three nulls it is",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote, usdInstrument }) => {
      const account = await seedAccount();
      const usd = await usdInstrument();
      // The provider answered, and its answer carried no dividend fields.
      const growth = await seedInstrument({ symbol: "VUG", name: "A growth ETF" });
      await seedQuote({ instrument: growth, price: "400.0000" });
      // Nobody ever asked: no symbol, so no `quote` row at all.
      const trust = await seedInstrument({
        symbol: null,
        name: "A workplace-plan trust",
        priceSource: "manual",
      });

      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [
          { instrument: growth, quantity: "3.00000000" },
          { instrument: trust, quantity: "42.00000000" },
          { instrument: usd, quantity: "500.00000000" },
        ],
      });

      const dividends = Object.fromEntries(
        (await currentHoldings(db)).map((holding) => [
          holding.instrumentName,
          holding.annualDividend,
        ]),
      );

      // Three unlike things arriving as one null, and deliberately flattened to
      // one figure. Only the growth ETF genuinely pays nothing; the rule that
      // says so about all three is why the total is a lower bound and why both
      // screens have to label it one (DESIGN.md §14, limitation 9).
      expect(dividends).toEqual({
        "A growth ETF": "0.0000",
        "A workplace-plan trust": "0.0000",
        [usd.name]: "0.0000",
      });
    }),
  );

  it(
    "reports a negative dividend for a negative quantity, so interest owed is not income",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      const loan = await seedAccount({ name: "Margin loan", kind: "liability" });
      // Nothing carries a rate against a negative position today. The rule has
      // to hold before something does: the sign lives in quantity and there is
      // no branch anywhere between it and this figure.
      const note = await seedInstrument({ symbol: "NOTE", name: "A note carrying a rate" });
      await seedQuote({ instrument: note, price: "100.0000", annualDividendPerShare: "5.0000" });

      await seedPositionSet({
        account: loan,
        asOf: "2026-01-31",
        holdings: [{ instrument: note, quantity: "-2.00000000" }],
      });

      const [holding] = await currentHoldings(db);

      expect(holding).toMatchObject({ quantity: "-2.00000000", annualDividend: "-10.0000" });
    }),
  );

  it(
    "leaves the number of holdings unchanged, however many of them share an instrument",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote, usdInstrument }) => {
      const usd = await usdInstrument();
      const fund = await seedInstrument({ symbol: "SCHD" });
      await seedQuote({ instrument: fund, price: "27.5000", annualDividendPerShare: "3.6000" });

      const first = await seedAccount({ name: "A brokerage" });
      const second = await seedAccount({ name: "B brokerage" });

      await seedPositionSet({
        account: first,
        asOf: "2026-01-31",
        holdings: [
          { instrument: fund, quantity: "10.00000000" },
          { instrument: usd, quantity: "500.00000000" },
        ],
      });
      await seedPositionSet({
        account: second,
        asOf: "2026-01-31",
        holdings: [{ instrument: fund, quantity: "4.00000000" }],
      });

      // Three holdings in, three rows out. `quote.instrument_id` is the primary
      // key, so the left join the dividend is computed over stays one row per
      // holding — a second quote row for one instrument would double the
      // dividend-paying rows and silently double every total taken over them.
      expect(await currentHoldings(db)).toHaveLength(3);
    }),
  );
});

describe("money crossing the database boundary", () => {
  it(
    "carries a fractional-share quantity and its value at full scale",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      const account = await seedAccount();
      const fund = await seedInstrument({ symbol: "VTI" });
      await seedQuote({ instrument: fund, price: "250.0000" });

      // A dividend-reinvested holding: eight decimal places, exact.
      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: fund, quantity: "0.12345678", costBasisPerShare: "199.9900" }],
      });

      const [holding] = await currentHoldings(db);

      expect(holding).toMatchObject({
        quantity: "0.12345678",
        value: "30.8642",
        costBasis: "24.6901",
        unrealized: "6.1741",
      });
    }),
  );

  it(
    "carries a total large enough that float coercion would round it",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      const account = await seedAccount();
      const fund = await seedInstrument({ symbol: "VTI" });
      await seedQuote({ instrument: fund, price: "1000.0000" });

      // Deliberately far past any real household balance: the figure needs more
      // significant digits than a double carries for the guard to be visible.
      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: fund, quantity: "1234567890.12345670" }],
      });

      const { amount } = await netWorth(db);

      expect(amount).toBe("1234567890123.4567");
      // Proof the guarantee is load-bearing rather than decorative: the same
      // figure through a JavaScript number is a different number.
      expect(String(Number(amount))).not.toBe(amount);
    }),
  );
});
