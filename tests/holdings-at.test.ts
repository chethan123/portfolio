/**
 * The rules `holding_valued_at` exists to keep true about the past.
 *
 * The current view's rules are covered in `current-holdings.test.ts` and are not
 * repeated here; what this file drives is the three things the as-of answer
 * varies — which position set, which accounts, which price — plus the two
 * consequences the design leans on hardest: that history starts at the first
 * upload rather than at a backfilled assumption, and that a dollar is a dollar
 * on any date the system is asked about.
 *
 * The calendar in these tests is real. 2026-02-13 is a Friday, the 14th and
 * 15th are the weekend, and the 16th is Presidents' Day — a market holiday. A
 * non-trading day is represented the way the design represents it: by the
 * absence of a `price_daily` row (DESIGN.md §6.2), never by a flag.
 *
 * Every money assertion is an exact decimal string at the stored scale.
 * `toBeCloseTo` would hide precisely the driver-coercion regression this slice
 * was built to prevent.
 */
import { afterAll, describe, expect, it } from "vitest";

import { ALL_OWNERS } from "~/lib/owner-filter";
import { holdingsAt, netWorthAt } from "~/lib/valuation.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";

afterAll(closeTestDatabase);

describe("the price on a date", () => {
  it(
    "values a Saturday at the preceding Friday's close",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose }) => {
      const account = await seedAccount();
      const fund = await seedInstrument({ symbol: "VTI" });
      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: fund, quantity: "10.00000000" }],
      });
      // Friday's close, and nothing for the weekend — because a market that is
      // shut prints no price.
      await seedDailyClose({ instrument: fund, date: "2026-02-13", close: "100.0000" });

      expect(await netWorthAt(ALL_OWNERS, "2026-02-14", db)).toEqual({
        amount: "1000.0000",
        coverage: { known: 1, total: 1 },
      });
    }),
  );

  it(
    "values a Sunday at the same preceding Friday's close",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose }) => {
      const account = await seedAccount();
      const fund = await seedInstrument({ symbol: "VTI" });
      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: fund, quantity: "10.00000000" }],
      });
      await seedDailyClose({ instrument: fund, date: "2026-02-13", close: "100.0000" });

      const [holding] = await holdingsAt(ALL_OWNERS, "2026-02-15", db);

      expect(holding).toMatchObject({ price: "100.0000", value: "1000.0000" });
    }),
  );

  it(
    "values a market holiday at the previous trading day's close",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose }) => {
      const account = await seedAccount();
      const fund = await seedInstrument({ symbol: "VTI" });
      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: fund, quantity: "10.00000000" }],
      });
      await seedDailyClose({ instrument: fund, date: "2026-02-13", close: "100.0000" });
      // The market reopens the day after Presidents' Day at a different price.
      await seedDailyClose({ instrument: fund, date: "2026-02-17", close: "111.0000" });

      // Monday 2026-02-16 is Presidents' Day: no close of its own, so Friday's
      // stands. No holiday calendar exists anywhere for this to consult.
      expect(await netWorthAt(ALL_OWNERS, "2026-02-16", db)).toEqual({
        amount: "1000.0000",
        coverage: { known: 1, total: 1 },
      });
      expect(await netWorthAt(ALL_OWNERS, "2026-02-17", db)).toEqual({
        amount: "1110.0000",
        coverage: { known: 1, total: 1 },
      });
    }),
  );

  it(
    "prices from the daily close rather than from the live quote",
    withDatabase(
      async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote, seedDailyClose }) => {
        const account = await seedAccount();
        const fund = await seedInstrument({ symbol: "VTI" });
        await seedPositionSet({
          account,
          asOf: "2026-01-31",
          holdings: [{ instrument: fund, quantity: "10.00000000" }],
        });
        await seedDailyClose({ instrument: fund, date: "2026-02-13", close: "100.0000" });
        // Today's price. A past date must not see it — an intraday tick leaking
        // into a historical point would move a line that has already been drawn.
        await seedQuote({ instrument: fund, price: "900.0000" });

        const [holding] = await holdingsAt(ALL_OWNERS, "2026-02-13", db);

        expect(holding).toMatchObject({ price: "100.0000", value: "1000.0000" });
      },
    ),
  );

  it(
    "reports a historical close as not stale even while the live quote is stale",
    withDatabase(
      async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote, seedDailyClose }) => {
        const account = await seedAccount();
        const fund = await seedInstrument({ symbol: "VTI" });
        await seedPositionSet({
          account,
          asOf: "2026-01-31",
          holdings: [{ instrument: fund, quantity: "10.00000000" }],
        });
        await seedDailyClose({ instrument: fund, date: "2026-02-13", close: "100.0000" });
        // A refresh that failed this morning. It says nothing about February.
        await seedQuote({ instrument: fund, price: "900.0000", isStale: true });

        const [holding] = await holdingsAt(ALL_OWNERS, "2026-02-13", db);

        // Staleness is a property of a live price that failed to refresh. The
        // close on a date that has already happened is simply the close.
        expect(holding).toMatchObject({ price: "100.0000", isPriced: true, isStale: false });
      },
    ),
  );
});

describe("history starting at the first upload", () => {
  it(
    "contributes no rows for an account whose first upload is after the date",
    withDatabase(async ({ db, seedAccount, seedPositionSet, usdInstrument }) => {
      const account = await seedAccount();
      const usd = await usdInstrument();
      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "5000.00000000" }],
      });

      // The day before the first statement. The money existed; the record of it
      // does not, and inventing a figure here would draw a chart line through a
      // period nothing is known about.
      expect(await holdingsAt(ALL_OWNERS, "2026-01-30", db)).toEqual([]);
      expect(await netWorthAt(ALL_OWNERS, "2026-01-30", db)).toEqual({
        amount: "0.0000",
        coverage: { known: 0, total: 0 },
      });
      // One day later there is a record, and it is the whole answer.
      expect(await netWorthAt(ALL_OWNERS, "2026-01-31", db)).toEqual({
        amount: "5000.0000",
        coverage: { known: 1, total: 1 },
      });
    }),
  );

  it(
    "holds positions constant between two uploads",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose }) => {
      const account = await seedAccount();
      const fund = await seedInstrument({ symbol: "VTI" });
      await seedDailyClose({ instrument: fund, date: "2026-01-31", close: "100.0000" });

      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: fund, quantity: "10.00000000" }],
      });
      await seedPositionSet({
        account,
        asOf: "2026-02-28",
        holdings: [{ instrument: fund, quantity: "25.00000000" }],
      });

      // Mid-February: February's statement has not happened yet, so January's
      // positions still stand. That is what makes a daily series possible from
      // monthly statements.
      expect((await holdingsAt(ALL_OWNERS, "2026-02-13", db)).map((holding) => holding.quantity)).toEqual([
        "10.00000000",
      ]);
      expect((await holdingsAt(ALL_OWNERS, "2026-02-28", db)).map((holding) => holding.quantity)).toEqual([
        "25.00000000",
      ]);
    }),
  );

  it(
    "treats an empty position set as having sold everything",
    withDatabase(async ({ db, seedAccount, seedPositionSet, usdInstrument }) => {
      const account = await seedAccount();
      const usd = await usdInstrument();

      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "5000.00000000" }],
      });
      // A statement listing nothing is a legal statement: the account was
      // emptied. It must not fall back to January's holdings.
      await seedPositionSet({ account, asOf: "2026-02-28", holdings: [] });

      expect(await netWorthAt(ALL_OWNERS, "2026-02-27", db)).toEqual({
        amount: "5000.0000",
        coverage: { known: 1, total: 1 },
      });
      expect(await holdingsAt(ALL_OWNERS, "2026-03-01", db)).toEqual([]);
      expect(await netWorthAt(ALL_OWNERS, "2026-03-01", db)).toEqual({
        amount: "0.0000",
        coverage: { known: 0, total: 0 },
      });
    }),
  );
});

describe("an account that has since been closed", () => {
  it(
    "counts it on the dates it was open and not after it closed",
    withDatabase(async ({ db, seedAccount, seedPositionSet, usdInstrument }) => {
      const usd = await usdInstrument();
      const open = await seedAccount({ name: "Checking" });
      const closed = await seedAccount({
        name: "Old savings",
        closedAt: "2026-02-01T00:00:00Z",
      });

      await seedPositionSet({
        account: open,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "100.00000000" }],
      });
      await seedPositionSet({
        account: closed,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "4000.00000000" }],
      });

      // January's net worth genuinely included the savings account. Dropping it
      // from history because of something that happened in February would make
      // the chart lie about a month that has already been lived.
      expect((await holdingsAt(ALL_OWNERS, "2026-01-31", db)).map((holding) => holding.accountName)).toEqual([
        "Checking",
        "Old savings",
      ]);
      expect(await netWorthAt(ALL_OWNERS, "2026-01-31", db)).toEqual({
        amount: "4100.0000",
        coverage: { known: 2, total: 2 },
      });

      // From the closure onward it is gone, so today's figures are not polluted.
      expect((await holdingsAt(ALL_OWNERS, "2026-02-01", db)).map((holding) => holding.accountName)).toEqual([
        "Checking",
      ]);
    }),
  );
});

// `latest_position_set(account, date)` is one function with one `order by`,
// and `holding_valued` calls it with the date left null — so the created_at
// then id tie-break is pinned once, in `current-holdings.test.ts`, rather than
// twice. What is only reachable through this path is the date bound itself.
describe("which position set speaks for a date", () => {
  it(
    "ignores a position set dated after the requested date",
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

      expect((await holdingsAt(ALL_OWNERS, "2026-01-31", db)).map((holding) => holding.quantity)).toEqual([
        "100.00000000",
      ]);
    }),
  );
});

describe("cash and debt on a past date, with no branch", () => {
  it(
    "prices a dollar at a dollar on a date before the app was installed",
    withDatabase(async ({ db, seedAccount, seedPositionSet, usdInstrument }) => {
      const usd = await usdInstrument();
      const savings = await seedAccount({ name: "Savings", kind: "bank" });
      const loan = await seedAccount({ name: "Student loan", kind: "liability" });

      // Statements from the last century, typed in from paper.
      await seedPositionSet({
        account: savings,
        asOf: "1998-12-31",
        holdings: [{ instrument: usd, quantity: "1200.00000000" }],
      });
      await seedPositionSet({
        account: loan,
        asOf: "1998-12-31",
        holdings: [{ instrument: usd, quantity: "-500.00000000" }],
      });

      // Nothing seeded a 1999 price for USD and nothing ever will. The 1970 row
      // the initial migration writes carries forward through the same lateral
      // that turns Friday into Saturday — there is no cash branch to take.
      const holdings = await holdingsAt(ALL_OWNERS, "1999-01-01", db);

      expect(holdings.map((holding) => holding.price)).toEqual(["1.0000", "1.0000"]);
      expect(holdings.map((holding) => holding.value)).toEqual(["1200.0000", "-500.0000"]);
      expect(await netWorthAt(ALL_OWNERS, "1999-01-01", db)).toEqual({
        amount: "700.0000",
        coverage: { known: 2, total: 2 },
      });
    }),
  );

  it(
    "sums a share position, a cash balance and a liability on a past date into one total",
    withDatabase(
      async ({
        db,
        seedPerson,
        seedAccount,
        seedInstrument,
        seedPositionSet,
        seedDailyClose,
        usdInstrument,
      }) => {
        const owner = await seedPerson({ name: "Alice" });
        const usd = await usdInstrument();
        const vti = await seedInstrument({ symbol: "VTI" });
        await seedDailyClose({ instrument: vti, date: "2026-02-13", close: "250.0000" });

        const brokerage = await seedAccount({ name: "Fidelity Taxable", owner });
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
        await seedPositionSet({
          account: loan,
          asOf: "2026-01-31",
          holdings: [{ instrument: usd, quantity: "-8000.00000000" }],
        });

        // 25,000 + 12,500 − 8,000, on a Saturday, from one SUM.
        expect(await netWorthAt(ALL_OWNERS, "2026-02-14", db)).toEqual({
          amount: "29500.0000",
          coverage: { known: 3, total: 3 },
        });
      },
    ),
  );
});

describe("partial data on a past date, told honestly", () => {
  it(
    "still shows a holding with no close on or before the date, flagged unpriced",
    withDatabase(
      async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose, usdInstrument }) => {
        const account = await seedAccount();
        const usd = await usdInstrument();
        // A collective investment trust priced by hand, first priced in March.
        const trust = await seedInstrument({
          symbol: null,
          name: "Vanguard Target Retirement 2045 Trust II",
          priceSource: "manual",
        });
        await seedDailyClose({ instrument: trust, date: "2026-03-31", close: "50.0000" });

        await seedPositionSet({
          account,
          asOf: "2026-01-31",
          holdings: [
            { instrument: trust, quantity: "42.00000000", costBasisPerShare: "10.0000" },
            { instrument: usd, quantity: "500.00000000" },
          ],
        });

        const holdings = await holdingsAt(ALL_OWNERS, "2026-02-13", db);
        const trustHolding = holdings.find((holding) => holding.symbol === null);

        // The row is here rather than dropped: an inner join to `price_daily`
        // would make it vanish and understate February with no error anywhere.
        expect(trustHolding).toMatchObject({
          quantity: "42.00000000",
          price: null,
          value: null,
          costBasis: "420.0000",
          unrealized: null,
          isPriced: false,
        });
        // The cash is counted, the trust is not, and the count says so.
        expect(await netWorthAt(ALL_OWNERS, "2026-02-13", db)).toEqual({
          amount: "500.0000",
          coverage: { known: 1, total: 2 },
        });
      },
    ),
  );

  it(
    "leaves unrealized null when cost basis is unknown, rather than reporting a fake gain",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose }) => {
      const account = await seedAccount({ kind: "401k", taxTreatment: "tax_deferred" });
      const fund = await seedInstrument({ symbol: "VTI" });
      await seedDailyClose({ instrument: fund, date: "2026-02-13", close: "250.0000" });

      // A 401k statement that omits cost basis, which is the common case.
      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: fund, quantity: "100.00000000" }],
      });

      const [holding] = await holdingsAt(ALL_OWNERS, "2026-02-13", db);

      // Zero here would report a $25,000 gain on a position whose basis is
      // simply not known.
      expect(holding).toMatchObject({
        value: "25000.0000",
        costBasisPerShare: null,
        costBasis: null,
        unrealized: null,
      });
    }),
  );
});

describe("the projection a past date will not make", () => {
  it(
    "reports no dividend on a past date, even while the instrument pays one today",
    withDatabase(
      async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote, seedDailyClose }) => {
        const account = await seedAccount();
        const fund = await seedInstrument({ symbol: "SCHD" });
        await seedPositionSet({
          account,
          asOf: "2026-01-31",
          holdings: [{ instrument: fund, quantity: "10.50000000" }],
        });
        await seedDailyClose({ instrument: fund, date: "2026-02-13", close: "27.5000" });
        // Today's rate, and the only rate the database has ever held: `quote`
        // is one row per instrument, overwritten on every refresh. It says
        // nothing whatever about February.
        await seedQuote({ instrument: fund, price: "27.5000", annualDividendPerShare: "3.6000" });

        const [holding] = await holdingsAt(ALL_OWNERS, "2026-02-13", db);

        // Not "37.8000", and not "0.0000" either. A projection forward from
        // today is not a fact about a date that has already happened, so the
        // honest answer for it is nothing at all.
        expect(holding).toMatchObject({ value: "288.7500", annualDividend: null });
      },
    ),
  );
});

describe("the shape a past date returns", () => {
  it(
    "carries the account, owner and classification every dashboard grouping needs",
    withDatabase(
      async ({
        db,
        seedPerson,
        seedAccount,
        seedClassification,
        seedInstrument,
        seedPositionSet,
        seedDailyClose,
      }) => {
        const owner = await seedPerson({ name: "Alice" });
        const equities = await seedClassification({
          name: "Total stock market (as of)",
          assetClass: "equity",
        });
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
        await seedDailyClose({ instrument: vti, date: "2026-02-13", close: "250.0000" });
        await seedPositionSet({
          account,
          asOf: "2026-01-31",
          holdings: [{ instrument: vti, quantity: "100.00000000", costBasisPerShare: "200.0000" }],
        });

        // The same field-for-field shape the current view returns: the as-of
        // answer is the view's row type, not a parallel one.
        expect(await holdingsAt(ALL_OWNERS, "2026-02-14", db)).toEqual([
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
            classification: "Total stock market (as of)",
            assetClass: "equity",
            quantity: "100.00000000",
            price: "250.0000",
            value: "25000.0000",
            costBasisPerShare: "200.0000",
            costBasis: "20000.0000",
            unrealized: "5000.0000",
            isPriced: true,
            isStale: false,
            // Written out rather than left off. `toEqual` reads a missing
            // property as equal to an undefined one, so omitting this would
            // pass just as happily on a function that emitted no such column —
            // which is the failure ADR-0001 exists to keep out.
            annualDividend: null,
          },
        ]);
      },
    ),
  );

  it(
    "carries a fractional-share quantity and its historical value at full scale",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose }) => {
      const account = await seedAccount();
      const fund = await seedInstrument({ symbol: "VTI" });
      await seedDailyClose({ instrument: fund, date: "2026-02-13", close: "250.0000" });

      // A dividend-reinvested holding: eight decimal places, exact.
      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: fund, quantity: "0.12345678", costBasisPerShare: "199.9900" }],
      });

      const [holding] = await holdingsAt(ALL_OWNERS, "2026-02-13", db);

      expect(holding).toMatchObject({
        quantity: "0.12345678",
        value: "30.8642",
        costBasis: "24.6901",
        // Literally value − cost_basis, rounded once, so the two can never
        // disagree by a fraction of a cent.
        unrealized: "6.1741",
      });
    }),
  );
});

describe("what the observation log may not touch", () => {
  it(
    "answers a past date from the daily close, whatever the observation log holds for it",
    withDatabase(
      async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose, seedObservation }) => {
        const account = await seedAccount();
        const fund = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
        await seedPositionSet({
          account,
          asOf: "2026-01-31",
          holdings: [{ instrument: fund, quantity: "10.00000000" }],
        });

        // The finished day, and a third price the feed reported during it. The
        // observation is real and correctly filed; it is simply not history.
        await seedDailyClose({ instrument: fund, date: "2026-02-13", close: "250.0000" });
        await seedObservation({
          instrument: fund,
          asOf: new Date("2026-02-13T18:30:00Z"),
          marketDate: "2026-02-13",
          price: "300.0000",
        });

        // ADR-0006's historical-line invariant, from its second front: a line
        // already drawn cannot move because a new tier arrived under it.
        expect(await netWorthAt(ALL_OWNERS, "2026-02-13", db)).toEqual({
          amount: "2500.0000",
          coverage: { known: 1, total: 1 },
        });
      },
    ),
  );

  it(
    "leaves a past date alone while a later session is being observed",
    withDatabase(
      async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose, seedObservation }) => {
        const account = await seedAccount();
        const fund = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
        await seedPositionSet({
          account,
          asOf: "2026-01-31",
          holdings: [{ instrument: fund, quantity: "10.00000000" }],
        });
        await seedDailyClose({ instrument: fund, date: "2026-02-13", close: "250.0000" });

        // Tuesday's session, running. Every fifteen minutes it writes another
        // observation, and none of them is a fact about the Friday before —
        // which is a line already drawn, and stays drawn.
        for (const [minute, price] of [
          ["14:30", "300.0000"],
          ["15:30", "310.0000"],
          ["16:30", "320.0000"],
        ]) {
          await seedObservation({
            instrument: fund,
            asOf: new Date(`2026-02-17T${minute}:00Z`),
            marketDate: "2026-02-17",
            price: price as string,
          });
        }

        expect(await netWorthAt(ALL_OWNERS, "2026-02-13", db)).toEqual({
          amount: "2500.0000",
          coverage: { known: 1, total: 1 },
        });
      },
    ),
  );
});
