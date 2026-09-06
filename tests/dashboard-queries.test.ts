// Overview screen's queries (DESIGN.md §8.2, §13). Same contract as current-holdings.test.ts:
// real Postgres, exact decimal strings. §8.2's weakest point under test: the rollup a screen
// shows and the headline above it must be the same arithmetic over the same view.
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

      expect(totals.map((total) => [total.accountName, total.amount])).toEqual([
        ["Fidelity Taxable", "28000.0000"],
        ["Checking", "12500.0000"],
      ]);

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
      const fresh = await seedAccount({ name: "Never uploaded", owner });
      const emptied = await seedAccount({ name: "Sold out", owner });
      await seedPositionSet({ account: emptied, asOf: "2026-01-31", holdings: [] });
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

      expect(totals.map((total) => [total.accountName, total.amount])).toEqual([
        ["Funded", "12500.0000"],
        ["Never uploaded", "0.0000"],
        ["Sold out", "0.0000"],
      ]);

      for (const name of ["Never uploaded", "Sold out"]) {
        const total = totals.find((candidate) => candidate.accountName === name);
        expect(total?.coverage).toEqual({ known: 0, total: 0 });
      }

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

      // ADR-0006.
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

      // Same-day close, so carry-forward isn't tempted to leak it in early.
      await seedDailyClose({ instrument: late, date: "2026-06-05", close: "80.0000" });

      await seedObservation({ instrument: early, asOf: "2026-06-05T13:30:00Z", price: "110.0000" });
      await seedObservation({ instrument: late, asOf: "2026-06-05T14:00:00Z", price: "80.0000" });

      expect((await netWorthSessionSeries(ALL_OWNERS, "2026-06-05", db)).map((point) => [point.at, point.amount])).toEqual([
        ["2026-06-05T13:30:00.000Z", "1600.0000"],
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

      expect(await netWorthSessionSeries(ALL_OWNERS, "2026-06-05", db)).toEqual([]);
    }),
  );

  it(
    "takes each instrument's latest observation, so a second quote replaces the first even with other instruments' quotes between them",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose, seedObservation }) => {
      const account = await seedAccount();
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const bnd = await seedInstrument({ symbol: "BND", priceSource: "feed" });
      const gld = await seedInstrument({ symbol: "GLD", priceSource: "feed" });
      await seedPositionSet({
        account,
        asOf: "2026-06-04",
        holdings: [
          { instrument: vti, quantity: "10.00000000" },
          { instrument: bnd, quantity: "10.00000000" },
          { instrument: gld, quantity: "10.00000000" },
        ],
      });
      await seedDailyClose({ instrument: vti, date: "2026-06-04", close: "100.0000" });
      await seedDailyClose({ instrument: bnd, date: "2026-06-04", close: "50.0000" });
      await seedDailyClose({ instrument: gld, date: "2026-06-04", close: "30.0000" });

      await seedObservation({ instrument: vti, asOf: "2026-06-05T13:30:00Z", price: "110.0000" });
      await seedObservation({ instrument: bnd, asOf: "2026-06-05T13:45:00Z", price: "60.0000" });
      await seedObservation({ instrument: vti, asOf: "2026-06-05T14:00:00Z", price: "130.0000" });
      await seedObservation({ instrument: gld, asOf: "2026-06-05T14:15:00Z", price: "45.0000" });
      await seedObservation({ instrument: bnd, asOf: "2026-06-05T14:30:00Z", price: "70.0000" });

      expect((await netWorthSessionSeries(ALL_OWNERS, "2026-06-05", db)).map((point) => [point.at, point.amount])).toEqual([
        ["2026-06-05T13:30:00.000Z", "1900.0000"],
        ["2026-06-05T13:45:00.000Z", "2000.0000"],
        ["2026-06-05T14:00:00.000Z", "2200.0000"],
        ["2026-06-05T14:15:00.000Z", "2350.0000"],
        ["2026-06-05T14:30:00.000Z", "2450.0000"],
      ]);
    }),
  );

  it(
    "leaves a holding with no price of any kind out of the amount, and counts it in from the instant it is first observed",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose, seedObservation }) => {
      const account = await seedAccount();
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const fresh = await seedInstrument({ symbol: "IPO", priceSource: "feed" });
      await seedPositionSet({
        account,
        asOf: "2026-06-04",
        holdings: [
          { instrument: vti, quantity: "10.00000000" },
          { instrument: fresh, quantity: "5.00000000" },
        ],
      });
      await seedDailyClose({ instrument: vti, date: "2026-06-04", close: "100.0000" });

      await seedObservation({ instrument: vti, asOf: "2026-06-05T13:30:00Z", price: "120.0000" });
      await seedObservation({ instrument: fresh, asOf: "2026-06-05T14:00:00Z", price: "40.0000" });

      expect(await netWorthSessionSeries(ALL_OWNERS, "2026-06-05", db)).toEqual([
        {
          at: "2026-06-05T13:30:00.000Z",
          amount: "1200.0000",
          coverage: { known: 1, total: 2 },
        },
        {
          at: "2026-06-05T14:00:00.000Z",
          amount: "1400.0000",
          coverage: { known: 2, total: 2 },
        },
      ]);
    }),
  );

  it(
    "opens an unobserved instrument at an earlier session's observation rather than at the close, the observation being the later of the two",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose, seedObservation }) => {
      const account = await seedAccount();
      const quiet = await seedInstrument({ symbol: "VBTLX", priceSource: "feed" });
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedPositionSet({
        account,
        asOf: "2026-06-04",
        holdings: [
          { instrument: quiet, quantity: "10.00000000" },
          { instrument: vti, quantity: "10.00000000" },
        ],
      });
      await seedDailyClose({ instrument: quiet, date: "2026-06-04", close: "200.0000" });
      await seedDailyClose({ instrument: vti, date: "2026-06-04", close: "100.0000" });

      await seedObservation({ instrument: quiet, asOf: "2026-06-04T20:30:00Z", price: "210.0000" });

      await seedObservation({ instrument: vti, asOf: "2026-06-05T13:30:00Z", price: "130.0000" });
      await seedObservation({ instrument: vti, asOf: "2026-06-05T14:00:00Z", price: "140.0000" });

      expect((await netWorthSessionSeries(ALL_OWNERS, "2026-06-05", db)).map((point) => [point.at, point.amount])).toEqual([
        ["2026-06-05T13:30:00.000Z", "3400.0000"],
        ["2026-06-05T14:00:00.000Z", "3500.0000"],
      ]);
    }),
  );

  it(
    "rounds each holding on its own before summing, so two dust positions of one instrument round up separately",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose, seedObservation }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedDailyClose({ instrument: vti, date: "2026-06-04", close: "1.0000" });

      // numeric(20,8): 0.00005 is exact, not an approximation.
      await seedPositionSet({
        account: await seedAccount({ name: "Fidelity Taxable" }),
        asOf: "2026-06-04",
        holdings: [{ instrument: vti, quantity: "0.00005000" }],
      });
      await seedPositionSet({
        account: await seedAccount({ name: "Vanguard IRA" }),
        asOf: "2026-06-04",
        holdings: [{ instrument: vti, quantity: "0.00005000" }],
      });

      await seedObservation({ instrument: vti, asOf: "2026-06-05T14:00:00Z", price: "3.0000" });

      expect(await netWorthSessionSeries(ALL_OWNERS, "2026-06-05", db)).toEqual([
        {
          at: "2026-06-05T14:00:00.000Z",
          amount: "0.0004",
          coverage: { known: 2, total: 2 },
        },
      ]);
    }),
  );

  it(
    "draws a single point for two instruments observed at exactly the same instant, priced with both",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose, seedObservation }) => {
      const account = await seedAccount();
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const bnd = await seedInstrument({ symbol: "BND", priceSource: "feed" });
      await seedPositionSet({
        account,
        asOf: "2026-06-04",
        holdings: [
          { instrument: vti, quantity: "10.00000000" },
          { instrument: bnd, quantity: "10.00000000" },
        ],
      });
      await seedDailyClose({ instrument: vti, date: "2026-06-04", close: "100.0000" });
      await seedDailyClose({ instrument: bnd, date: "2026-06-04", close: "50.0000" });

      await seedObservation({ instrument: vti, asOf: "2026-06-05T14:00:00Z", price: "150.0000" });
      await seedObservation({ instrument: bnd, asOf: "2026-06-05T14:00:00Z", price: "80.0000" });

      expect(await netWorthSessionSeries(ALL_OWNERS, "2026-06-05", db)).toEqual([
        {
          at: "2026-06-05T14:00:00.000Z",
          amount: "2300.0000",
          coverage: { known: 2, total: 2 },
        },
      ]);
    }),
  );

  it(
    "moves the line at an observation inside the session's span even when it was filed under another market date",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose, seedObservation }) => {
      const account = await seedAccount();
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const bnd = await seedInstrument({ symbol: "BND", priceSource: "feed" });
      await seedPositionSet({
        account,
        asOf: "2026-06-04",
        holdings: [
          { instrument: vti, quantity: "1.00000000" },
          { instrument: bnd, quantity: "1.00000000" },
        ],
      });
      await seedDailyClose({ instrument: vti, date: "2026-06-04", close: "30.0000" });
      await seedDailyClose({ instrument: bnd, date: "2026-06-04", close: "1.0000" });

      await seedObservation({ instrument: vti, asOf: "2026-06-05T13:30:00Z", price: "31.0000" });
      await seedObservation({
        instrument: vti,
        asOf: "2026-06-05T13:45:00Z",
        price: "33.0000",
        marketDate: "2026-06-06",
      });
      await seedObservation({ instrument: bnd, asOf: "2026-06-05T14:00:00Z", price: "1.0000" });

      expect((await netWorthSessionSeries(ALL_OWNERS, "2026-06-05", db)).map((point) => [point.at, point.amount])).toEqual([
        ["2026-06-05T13:30:00.000Z", "32.0000"],
        ["2026-06-05T14:00:00.000Z", "34.0000"],
      ]);
    }),
  );
});
