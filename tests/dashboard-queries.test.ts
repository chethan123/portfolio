/**
 * The queries the Overview screen reads through (DESIGN.md §8.2, §13).
 *
 * Same contract as `current-holdings.test.ts`: driven through the query
 * module's public functions against a real Postgres, seeded through the fixture
 * builder, with every money assertion an exact decimal string at the stored
 * scale. `toBeCloseTo` would hide the driver-coercion regression these
 * assertions exist to catch.
 *
 * The rule under test throughout is the one §8.2 names as the design's weakest
 * point: the rollup a screen shows and the headline above it must be the same
 * arithmetic over the same view, because three hand-rolled dashboard queries
 * disagreeing is the failure mode this module exists to prevent.
 */
import { afterAll, describe, expect, it } from "vitest";

import {
  accountTotal,
  accountTotals,
  latestObservedSession,
  manualNetWorth,
  netWorth,
  netWorthChange,
  netWorthSeries,
  netWorthSessionSeries,
} from "~/lib/valuation.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";
import { ALL_OWNERS } from "../app/lib/owner-filter.ts";

afterAll(closeTestDatabase);

describe("accountTotals", () => {
  it(
    "rolls each account up and agrees with the net worth headline above it",
    withDatabase(async ({ db, seedPerson, seedAccount, seedInstrument, seedPositionSet, seedQuote, usdInstrument }) => {
      const owner = await seedPerson({ name: "Alice" });
      const usd = await usdInstrument();
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market ETF" });
      await seedQuote({ instrument: vti, price: "250.0000" });

      const brokerage = await seedAccount({ name: "Fidelity Taxable", owner, kind: "brokerage" });
      const checking = await seedAccount({ name: "Checking", owner, kind: "bank" });

      await seedPositionSet({
        account: brokerage,
        asOf: "2026-01-31",
        holdings: [
          { instrument: vti, quantity: "100.00000000" },
          { instrument: usd, quantity: "3000.00000000" },
        ],
      });
      await seedPositionSet({
        account: checking,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "12500.00000000" }],
      });

      const totals = await accountTotals(ALL_OWNERS, db);

      // 25,000 + 3,000 = 28,000, and it sorts above the 12,500.
      expect(totals.map((total) => [total.accountName, total.amount])).toEqual([
        ["Fidelity Taxable", "28000.0000"],
        ["Checking", "12500.0000"],
      ]);

      // The screen's own consistency check: the rollup and the headline are one
      // arithmetic, so summing the parts must reproduce the whole exactly.
      const headline = await netWorth(ALL_OWNERS, db);
      expect(headline.amount).toBe("40500.0000");
      expect(totals.reduce((sum, total) => sum + Number(total.amount), 0)).toBe(
        Number(headline.amount),
      );
    }),
  );

  it(
    "carries the recorded account number for the tail, and null where none is recorded",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet, usdInstrument }) => {
      const owner = await seedPerson({ name: "Alice" });
      const usd = await usdInstrument();

      const numbered = await seedAccount({
        name: "Fidelity Taxable",
        owner,
        externalAccountNumber: "X47-283910",
      });
      await seedAccount({ name: "Checking", owner, kind: "bank" });

      // Only one account holds anything: the tail must arrive on the empty
      // account too, whose row the LEFT join manufactures — and pre-masked,
      // because these rows are loader data.
      await seedPositionSet({
        account: numbered,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "3000.00000000" }],
      });

      const totals = await accountTotals(ALL_OWNERS, db);

      expect(
        totals.map((total) => [total.accountName, total.accountNumberTail]),
      ).toEqual([
        ["Fidelity Taxable", "····3910"],
        ["Checking", null],
      ]);
    }),
  );

  it(
    "sorts a liability account to the bottom without a branch for it",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet, usdInstrument }) => {
      const owner = await seedPerson();
      const usd = await usdInstrument();

      const checking = await seedAccount({ name: "Checking", owner, kind: "bank" });
      const loan = await seedAccount({ name: "Car loan", owner, kind: "liability" });

      await seedPositionSet({
        account: checking,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "12500.00000000" }],
      });
      // The sign lives in quantity, against a positive price (§2).
      await seedPositionSet({
        account: loan,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "-8000.00000000" }],
      });

      const totals = await accountTotals(ALL_OWNERS, db);

      expect(totals.map((total) => [total.accountName, total.amount])).toEqual([
        ["Checking", "12500.0000"],
        ["Car loan", "-8000.0000"],
      ]);
    }),
  );

  it(
    "counts an unpriced holding in coverage rather than dropping it",
    withDatabase(async ({ db, seedPerson, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      const owner = await seedPerson();
      const account = await seedAccount({ owner });
      const priced = await seedInstrument({ symbol: "VTI", name: "Priced" });
      // A CIT that has never been quoted — the case that would silently
      // understate the total if it were dropped instead of counted.
      const cit = await seedInstrument({ symbol: null, name: "Target 2045 Trust II" });
      await seedQuote({ instrument: priced, price: "250.0000" });

      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [
          { instrument: priced, quantity: "10.00000000" },
          { instrument: cit, quantity: "500.00000000" },
        ],
      });

      const [total] = await accountTotals(ALL_OWNERS, db);

      expect(total?.amount).toBe("2500.0000");
      expect(total?.coverage).toEqual({ known: 1, total: 2 });
    }),
  );

  it(
    "lists an open account holding nothing as nothing to value, and still omits a closed one",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet, usdInstrument }) => {
      const owner = await seedPerson({ name: "Alice" });
      const usd = await usdInstrument();

      const funded = await seedAccount({ name: "Funded", owner });
      // The two ways an open account reaches the view as no rows at all: never
      // uploaded to, and uploaded to but emptied — "sold everything" is
      // recorded as a position set with no holdings.
      const fresh = await seedAccount({ name: "Never uploaded", owner });
      const emptied = await seedAccount({ name: "Sold out", owner });
      await seedPositionSet({ account: emptied, asOf: "2026-01-31", holdings: [] });
      // Closed is not a zero: it leaves the list entirely, the way
      // `accountTotal` answers null rather than an account holding nothing.
      const closed = await seedAccount({
        name: "Old 401k",
        owner,
        closedAt: "2026-01-15",
      });
      await seedPositionSet({
        account: funded,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "12500.00000000" }],
      });
      await seedPositionSet({
        account: closed,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "9000.00000000" }],
      });

      const totals = await accountTotals(ALL_OWNERS, db);

      // The zeros sort under the funded account and tie-break on name.
      expect(totals.map((total) => [total.accountName, total.amount])).toEqual([
        ["Funded", "12500.0000"],
        ["Never uploaded", "0.0000"],
        ["Sold out", "0.0000"],
      ]);

      // Zero over a coverage of zero rows — "nothing to value", not a figure a
      // screen can call complete.
      for (const name of ["Never uploaded", "Sold out"]) {
        const total = totals.find((candidate) => candidate.accountName === name);
        expect(total?.coverage).toEqual({ known: 0, total: 0 });
      }

      // The rule this pair exists to hold: the list and the drill-down are one
      // figure shown twice, so neither may report an account the other does not.
      for (const account of [funded, fresh, emptied]) {
        expect(totals.find((candidate) => candidate.accountId === account.id)).toEqual(
          await accountTotal(account.id, db),
        );
      }
      expect(await accountTotal(closed.id, db)).toBeNull();
    }),
  );
});

describe("netWorthSeries", () => {
  it(
    "prices each date against the position set in force on it, in one query",
    withDatabase(async ({ db, seedPerson, seedAccount, seedInstrument, seedPositionSet, seedDailyClose }) => {
      const owner = await seedPerson();
      const account = await seedAccount({ owner });
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market ETF" });

      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });

      await seedDailyClose({ instrument: vti, date: "2026-01-31", close: "200.0000" });
      await seedDailyClose({ instrument: vti, date: "2026-02-28", close: "250.0000" });

      const series = await netWorthSeries(ALL_OWNERS, ["2026-02-28", "2026-01-31"], db);

      // Sorted by date regardless of the order asked for.
      expect(series.map((point) => [point.date, point.amount])).toEqual([
        ["2026-01-31", "20000.0000"],
        ["2026-02-28", "25000.0000"],
      ]);
    }),
  );

  it(
    "carries the last close forward across a day with no market",
    withDatabase(async ({ db, seedPerson, seedAccount, seedInstrument, seedPositionSet, seedDailyClose }) => {
      const owner = await seedPerson();
      const account = await seedAccount({ owner });
      const vti = await seedInstrument({ symbol: "VTI", name: "VTI" });

      await seedPositionSet({
        account,
        asOf: "2026-01-30",
        holdings: [{ instrument: vti, quantity: "10.00000000" }],
      });
      // Friday only. Saturday and Sunday are represented by absent rows.
      await seedDailyClose({ instrument: vti, date: "2026-01-30", close: "100.0000" });

      const series = await netWorthSeries(ALL_OWNERS, ["2026-01-31", "2026-02-01"], db);

      expect(series.map((point) => point.amount)).toEqual(["1000.0000", "1000.0000"]);
    }),
  );

  it(
    "reports a date before the first upload as zero rows, not as a zero balance",
    withDatabase(async ({ db, seedPerson, seedAccount, seedInstrument, seedPositionSet, seedDailyClose }) => {
      const owner = await seedPerson();
      const account = await seedAccount({ owner });
      const vti = await seedInstrument({ symbol: "VTI", name: "VTI" });

      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: vti, quantity: "10.00000000" }],
      });
      await seedDailyClose({ instrument: vti, date: "2026-01-31", close: "100.0000" });

      const series = await netWorthSeries(ALL_OWNERS, ["2025-06-01", "2026-01-31"], db);

      // This distinction is what stops the chart drawing a fictional climb from
      // zero at its head: the amount is 0 but the coverage says nothing was
      // recorded, and the screen filters on coverage rather than on amount.
      expect(series[0]).toEqual({
        date: "2025-06-01",
        amount: "0.0000",
        coverage: { known: 0, total: 0 },
      });
      expect(series[1]?.coverage).toEqual({ known: 1, total: 1 });
    }),
  );

  it(
    "returns nothing for no dates rather than querying for none",
    withDatabase(async ({ db }) => {
      expect(await netWorthSeries(ALL_OWNERS, [], db)).toEqual([]);
    }),
  );
});

describe("netWorthChange", () => {
  it(
    "computes the movement and its percentage in numeric, never in a float",
    withDatabase(async ({ db, seedPerson, seedAccount, seedInstrument, seedPositionSet, seedQuote, seedDailyClose }) => {
      const owner = await seedPerson();
      const account = await seedAccount({ owner });
      const vti = await seedInstrument({ symbol: "VTI", name: "VTI" });

      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });
      await seedDailyClose({ instrument: vti, date: "2026-01-31", close: "200.0000" });
      await seedQuote({ instrument: vti, price: "250.0000" });

      const change = await netWorthChange(ALL_OWNERS, "2026-01-31", db);

      expect(change.current).toBe("25000.0000");
      expect(change.previous).toBe("20000.0000");
      expect(change.difference).toBe("5000.0000");
      expect(change.percent).toBe("25.0000");
    }),
  );

  it(
    "reports a rise out of net debt as a rise",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet, usdInstrument, seedDailyClose }) => {
      const owner = await seedPerson();
      const loan = await seedAccount({ name: "Loan", owner, kind: "liability" });
      const usd = await usdInstrument();

      // Was −10,000 in January; −5,000 now. Debt halved, which is good news.
      await seedPositionSet({
        account: loan,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "-10000.00000000" }],
      });
      await seedPositionSet({
        account: loan,
        asOf: "2026-06-30",
        holdings: [{ instrument: usd, quantity: "-5000.00000000" }],
      });
      await seedDailyClose({ instrument: usd, date: "2026-01-31", close: "1.0000" });

      const change = await netWorthChange(ALL_OWNERS, "2026-01-31", db);

      expect(change.difference).toBe("5000.0000");
      // Dividing by the signed −10,000 would report this recovery as −50%,
      // which is the wrong sign on the figure a person reads fastest.
      expect(change.percent).toBe("50.0000");
    }),
  );

  it(
    "declines to invent a percentage change from nothing",
    withDatabase(async ({ db, seedPerson, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      const owner = await seedPerson();
      const account = await seedAccount({ owner });
      const vti = await seedInstrument({ symbol: "VTI", name: "VTI" });
      await seedQuote({ instrument: vti, price: "250.0000" });

      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });

      // Nothing existed in 2025, so there is no base to be a percentage of.
      const change = await netWorthChange(ALL_OWNERS, "2025-01-01", db);

      expect(change.previous).toBe("0.0000");
      expect(change.difference).toBe("25000.0000");
      expect(change.percent).toBeNull();
    }),
  );
});

describe("manualNetWorth", () => {
  it(
    "returns the hand-typed series in date order, unmerged",
    withDatabase(async ({ db, seedManualNetWorth }) => {
      await seedManualNetWorth({ date: "2024-12-31", amount: "820000.0000" });
      await seedManualNetWorth({ date: "2022-12-31", amount: "500000.0000" });

      // Unmerged on purpose: "computed wins on overlapping dates" (§7 rule 2)
      // is a display rule about two lines, not a fact about either one, so it
      // belongs to the screen rather than to the query.
      expect(await manualNetWorth(db)).toEqual([
        { date: "2022-12-31", amount: "500000.0000" },
        { date: "2024-12-31", amount: "820000.0000" },
      ]);
    }),
  );
});

describe("which session 1D plots", () => {
  it(
    "is the latest market date anything was observed on",
    withDatabase(async ({ db, seedInstrument, seedObservation }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      await seedObservation({ instrument: vti, asOf: "2026-06-04T17:00:00Z", price: "100.0000" });
      await seedObservation({ instrument: vti, asOf: "2026-06-05T17:00:00Z", price: "110.0000" });

      expect(await latestObservedSession(db)).toBe("2026-06-05");
    }),
  );

  it(
    "answers with the last session observed, not with a calendar day",
    withDatabase(async ({ db, seedInstrument, seedObservation }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      // Friday, and then a weekend nothing was polled through. Whatever today
      // is when this runs, 1D shows Friday — the session comes from what was
      // observed (ADR-0006), so the UTC-today versus market-day seam never
      // decides what is drawn.
      await seedObservation({
        instrument: vti,
        asOf: "2026-06-06T00:30:00Z",
        marketDate: "2026-06-05",
        price: "110.0000",
      });

      expect(await latestObservedSession(db)).toBe("2026-06-05");
    }),
  );

  it(
    "answers null on an instance that has never observed anything",
    withDatabase(async ({ db }) => {
      expect(await latestObservedSession(db)).toBeNull();
    }),
  );
});

describe("the 1D series", () => {
  it(
    "puts a point at every distinct instant of the session, priced at what was known then",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose, seedObservation }) => {
      const account = await seedAccount();
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedPositionSet({
        account,
        asOf: "2026-06-04",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });
      await seedDailyClose({ instrument: vti, date: "2026-06-04", close: "200.0000" });

      for (const [at, price] of [
        ["2026-06-05T13:30:00Z", "210.0000"],
        ["2026-06-05T13:45:00Z", "205.0000"],
        ["2026-06-05T14:00:00Z", "220.0000"],
      ]) {
        await seedObservation({ instrument: vti, asOf: at as string, price: price as string });
      }

      const series = await netWorthSessionSeries(ALL_OWNERS, "2026-06-05", db);

      // Unsampled: one point per observation, so the line is exactly as
      // granular as the refresh cadence the household chose (story 3).
      expect(series.map((point) => [point.at, point.amount])).toEqual([
        ["2026-06-05T13:30:00.000Z", "21000.0000"],
        ["2026-06-05T13:45:00.000Z", "20500.0000"],
        ["2026-06-05T14:00:00.000Z", "22000.0000"],
      ]);
    }),
  );

  it(
    "carries an instrument with no observation forward from the close before the session",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose, seedObservation, usdInstrument }) => {
      const account = await seedAccount({ kind: "bank" });
      const usd = await usdInstrument();
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedPositionSet({
        account,
        asOf: "2026-06-04",
        holdings: [
          { instrument: usd, quantity: "5000.00000000" },
          { instrument: vti, quantity: "10.00000000" },
        ],
      });
      await seedDailyClose({ instrument: vti, date: "2026-06-04", close: "200.0000" });

      await seedObservation({ instrument: vti, asOf: "2026-06-05T14:00:00Z", price: "300.0000" });

      // Cash contributes its fixed dollar at every instant — it is quoted by
      // nobody and carried forward from the 1970 row — so the point is
      // $5,000 plus ten shares at the price the feed had given us.
      expect(await netWorthSessionSeries(ALL_OWNERS, "2026-06-05", db)).toEqual([
        {
          at: "2026-06-05T14:00:00.000Z",
          amount: "8000.0000",
          coverage: { known: 2, total: 2 },
        },
      ]);
    }),
  );

  it(
    "prices an instrument at the previous close for the instants before its first quote of the day",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose, seedObservation }) => {
      const account = await seedAccount();
      const early = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const late = await seedInstrument({ symbol: "BND", priceSource: "feed" });
      await seedPositionSet({
        account,
        asOf: "2026-06-04",
        holdings: [
          { instrument: early, quantity: "10.00000000" },
          { instrument: late, quantity: "10.00000000" },
        ],
      });
      await seedDailyClose({ instrument: early, date: "2026-06-04", close: "100.0000" });
      await seedDailyClose({ instrument: late, date: "2026-06-04", close: "50.0000" });

      // The session's own provisional close, which converges on the last
      // observation of the day. Reading it at 13:30 would price the open at the
      // price of the close — the day's answer leaking backwards into its own
      // line — so the carry-forward reaches strictly past it.
      await seedDailyClose({ instrument: late, date: "2026-06-05", close: "80.0000" });

      await seedObservation({ instrument: early, asOf: "2026-06-05T13:30:00Z", price: "110.0000" });
      await seedObservation({ instrument: late, asOf: "2026-06-05T14:00:00Z", price: "80.0000" });

      expect((await netWorthSessionSeries(ALL_OWNERS, "2026-06-05", db)).map((point) => [point.at, point.amount])).toEqual([
        // 10 × 110 + 10 × 50, the second still at yesterday's close.
        ["2026-06-05T13:30:00.000Z", "1600.0000"],
        // 10 × 110 + 10 × 80, once its own quote arrived.
        ["2026-06-05T14:00:00.000Z", "1900.0000"],
      ]);
    }),
  );

  it(
    "ends at the same figure the current holdings total, when quote and observation were written together",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose, seedObservation, seedQuote }) => {
      const account = await seedAccount();
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedPositionSet({
        account,
        asOf: "2026-06-04",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });
      await seedDailyClose({ instrument: vti, date: "2026-06-04", close: "200.0000" });

      // The normal path: one refresh writes both, so the headline and the last
      // point of the line are the same price by construction (story 8).
      await seedObservation({ instrument: vti, asOf: "2026-06-05T14:00:00Z", price: "220.0000" });
      await seedQuote({ instrument: vti, price: "220.0000" });

      const series = await netWorthSessionSeries(ALL_OWNERS, "2026-06-05", db);

      expect(series.at(-1)?.amount).toBe((await netWorth(ALL_OWNERS, db)).amount);
    }),
  );

  it(
    "returns nothing at all for a session with no observations",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose }) => {
      const account = await seedAccount();
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedPositionSet({
        account,
        asOf: "2026-06-04",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });
      await seedDailyClose({ instrument: vti, date: "2026-06-04", close: "200.0000" });

      // Not a flat line: nothing was observed, which is not the same claim as
      // "nothing moved".
      expect(await netWorthSessionSeries(ALL_OWNERS, "2026-06-05", db)).toEqual([]);
    }),
  );
});
