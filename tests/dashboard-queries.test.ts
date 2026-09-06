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

      // 25,000 + 3,000 = 28,000, and it sorts above the 12,500.
      expect(totals.map((total) => [total.accountName, total.amount])).toEqual([
        ["Fidelity Taxable", "28000.0000"],
        ["Checking", "12500.0000"],
      ]);

      // Consistency check: rollup and headline are one arithmetic — summing parts
      // reproduces the whole.
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

      // Tail must arrive on the empty account too (row the LEFT join manufactures),
      // pre-masked as loader data.
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
      // Never-quoted CIT — dropping instead of counting would silently understate the total.
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
      // Two ways to reach no rows: never uploaded, or uploaded-then-emptied ("sold everything").
      const fresh = await seedAccount({ name: "Never uploaded", owner });
      const emptied = await seedAccount({ name: "Sold out", owner });
      await seedPositionSet({ account: emptied, asOf: "2026-01-31", holdings: [] });
      // Closed leaves the list entirely, not a zero — matches accountTotal's null.
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

      // Zero over zero coverage — "nothing to value", not "complete".
      for (const name of ["Never uploaded", "Sold out"]) {
        const total = totals.find((candidate) => candidate.accountName === name);
        expect(total?.coverage).toEqual({ known: 0, total: 0 });
      }

      // List and drill-down are one figure shown twice — neither may report an
      // account the other doesn't.
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

      // Stops the chart drawing a fictional climb from zero — amount is 0 but coverage
      // says nothing was recorded; screen filters on coverage, not amount.
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
      // Dividing by signed −10,000 would report this recovery as −50% — wrong sign on
      // the fastest-read figure.
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

      // Unmerged on purpose — "computed wins on overlapping dates" (§7 rule 2) is a
      // screen rule, not a query fact.
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

      // Friday, then a quiet weekend — 1D shows Friday regardless of today, since the
      // session comes from what was observed (ADR-0006), not the UTC-today/market-day seam.
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

      // Unsampled — one point per observation, as granular as the refresh cadence (story 3).
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

      // Cash contributes its fixed dollar every instant (carried forward from the 1970
      // row, quoted by nobody).
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

      // Session's own provisional close converges on the day's last observation — reading
      // it at 13:30 would leak the close backward into the open, so carry-forward reaches
      // strictly past it.
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

      // Normal path: one refresh writes both — headline and last point are the same
      // price by construction (story 8).
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

      // Feed stamps each instrument's own instant — session interleaves VTI, BND, VTI,
      // GLD, BND: five instants, none shared.
      await seedObservation({ instrument: vti, asOf: "2026-06-05T13:30:00Z", price: "110.0000" });
      await seedObservation({ instrument: bnd, asOf: "2026-06-05T13:45:00Z", price: "60.0000" });
      await seedObservation({ instrument: vti, asOf: "2026-06-05T14:00:00Z", price: "130.0000" });
      await seedObservation({ instrument: gld, asOf: "2026-06-05T14:15:00Z", price: "45.0000" });
      await seedObservation({ instrument: bnd, asOf: "2026-06-05T14:30:00Z", price: "70.0000" });

      expect((await netWorthSessionSeries(ALL_OWNERS, "2026-06-05", db)).map((point) => [point.at, point.amount])).toEqual([
        // 10 × 110 + 10 × 50 + 10 × 30, only VTI having spoken.
        ["2026-06-05T13:30:00.000Z", "1900.0000"],
        // 10 × 110 + 10 × 60 + 10 × 30
        ["2026-06-05T13:45:00.000Z", "2000.0000"],
        // 10 × 130 + 10 × 60 + 10 × 30 — VTI's second quote displaces its own
        // first, with BND's sitting between them, and leaves BND's alone.
        ["2026-06-05T14:00:00.000Z", "2200.0000"],
        // 10 × 130 + 10 × 60 + 10 × 45
        ["2026-06-05T14:15:00.000Z", "2350.0000"],
        // 10 × 130 + 10 × 70 + 10 × 45
        ["2026-06-05T14:30:00.000Z", "2450.0000"],
      ]);
    }),
  );

  it(
    "leaves a holding with no price of any kind out of the amount, and counts it in from the instant it is first observed",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose, seedObservation }) => {
      const account = await seedAccount();
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      // Bought/first-priced today: no close before the session, no earlier observation —
      // genuinely no price to carry forward.
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
          // 10 × 120; unpriced holding contributes nothing — a step in the line, via
          // coverage not a guess.
          amount: "1200.0000",
          coverage: { known: 1, total: 2 },
        },
        {
          at: "2026-06-05T14:00:00.000Z",
          // 10 × 120 + 5 × 40, once the second instrument had a price at all.
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

      // Yesterday evening's NAV: not an instant of this session, but later than
      // yesterday's close — rule is the latest observation at or before the instant,
      // from any date.
      await seedObservation({ instrument: quiet, asOf: "2026-06-04T20:30:00Z", price: "210.0000" });

      // Only VTI is quoted today, so the session's instants are its.
      await seedObservation({ instrument: vti, asOf: "2026-06-05T13:30:00Z", price: "130.0000" });
      await seedObservation({ instrument: vti, asOf: "2026-06-05T14:00:00Z", price: "140.0000" });

      expect((await netWorthSessionSeries(ALL_OWNERS, "2026-06-05", db)).map((point) => [point.at, point.amount])).toEqual([
        // 10 × 210 + 10 × 130 — the evening observation, never the 200.0000 close.
        ["2026-06-05T13:30:00.000Z", "3400.0000"],
        // 10 × 210 + 10 × 140
        ["2026-06-05T14:00:00.000Z", "3500.0000"],
      ]);
    }),
  );

  it(
    "rounds each holding on its own before summing, so two dust positions of one instrument round up separately",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose, seedObservation }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedDailyClose({ instrument: vti, date: "2026-06-04", close: "1.0000" });

      // Quantity is numeric(20,8), so 0.00005 is exact — the rounding half is really
      // there, twice.
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
          // cast(0.00005×3.0000 as numeric(20,4)) = 0.0002 per holding, twice. Summing
          // quantities first (or one step per instrument, not per holding) would give 0.0003.
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

      // One as_of shared by two instruments (a batch-stamped provider) — instants are
      // distinct values, one moment not two.
      await seedObservation({ instrument: vti, asOf: "2026-06-05T14:00:00Z", price: "150.0000" });
      await seedObservation({ instrument: bnd, asOf: "2026-06-05T14:00:00Z", price: "80.0000" });

      expect(await netWorthSessionSeries(ALL_OWNERS, "2026-06-05", db)).toEqual([
        {
          at: "2026-06-05T14:00:00.000Z",
          // 10 × 150 + 10 × 80, both quotes landing in the one point.
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
      // Filed under the next market date — not one MARKET_TIMEZONE writes, but the table
      // can hold it. Not an instant of this session (no point of its own), but still the
      // latest observation at or before 14:00 — the rule cares about the instant, not the
      // market date.
      await seedObservation({
        instrument: vti,
        asOf: "2026-06-05T13:45:00Z",
        price: "33.0000",
        marketDate: "2026-06-06",
      });
      await seedObservation({ instrument: bnd, asOf: "2026-06-05T14:00:00Z", price: "1.0000" });

      expect((await netWorthSessionSeries(ALL_OWNERS, "2026-06-05", db)).map((point) => [point.at, point.amount])).toEqual([
        // 1 × 31 + 1 × 1
        ["2026-06-05T13:30:00.000Z", "32.0000"],
        // 1 × 33 + 1 × 1 — the 13:45 observation counted, with no point of its own.
        ["2026-06-05T14:00:00.000Z", "34.0000"],
      ]);
    }),
  );
});
