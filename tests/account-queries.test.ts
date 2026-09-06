// Account drill-down queries (DESIGN.md §8.2), same contract as dashboard-queries.test.ts:
// real Postgres, fixture seeds, exact decimal strings.
import { afterAll, describe, expect, it } from "vitest";

import {
  accountFirstRecordedDate,
  accountHoldings,
  accountSeries,
  accountSessionSeries,
  accountTotal,
  accountTotals,
  netWorth,
} from "~/lib/valuation.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";
import { ALL_OWNERS } from "../app/lib/owner-filter.ts";

afterAll(closeTestDatabase);

describe("accountTotal", () => {
  it(
    "reports the figure the overview's row for that account already shows",
    withDatabase(async ({ db, seedPerson, seedAccount, seedInstrument, seedPositionSet, seedQuote, usdInstrument }) => {
      const owner = await seedPerson({ name: "Alice" });
      const usd = await usdInstrument();
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market ETF" });
      await seedQuote({ instrument: vti, price: "250.0000" });

      const brokerage = await seedAccount({
        name: "Fidelity Taxable",
        institution: "Fidelity",
        owner,
        kind: "brokerage",
      });
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

      const total = await accountTotal(brokerage.id, db);

      expect(total).toEqual({
        accountId: brokerage.id,
        accountName: "Fidelity Taxable",
        accountNumberTail: null,
        institution: "Fidelity",
        accountKind: "brokerage",
        ownerName: "Alice",
        amount: "28000.0000",
        coverage: { known: 2, total: 2 },
      });

      // Consistency check: account total must equal its row in the overview list.
      const [row] = (await accountTotals(ALL_OWNERS, db)).filter(
        (candidate) => candidate.accountId === brokerage.id,
      );
      expect(total).toEqual(row);
    }),
  );

  it(
    "reports an account holding nothing as nothing to value, not as worth nothing",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet }) => {
      const owner = await seedPerson({ name: "Alice" });
      // Never uploaded vs. uploaded-then-emptied — both must survive the LEFT join as zero rows.
      const fresh = await seedAccount({ name: "New brokerage", owner });
      const emptied = await seedAccount({ name: "Closed out", owner });
      await seedPositionSet({ account: emptied, asOf: "2026-01-31", holdings: [] });

      for (const account of [fresh, emptied]) {
        const total = await accountTotal(account.id, db);

        // Zero over zero coverage — not null (would 404 an existing account), not "complete".
        expect(total?.amount).toBe("0.0000");
        expect(total?.coverage).toEqual({ known: 0, total: 0 });
        expect(total?.accountName).toBe(account.name);
      }
    }),
  );

  it(
    "keeps a liability account negative, with no branch for it",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet, usdInstrument }) => {
      const owner = await seedPerson();
      const usd = await usdInstrument();
      const loan = await seedAccount({ name: "Car loan", owner, kind: "liability" });

      // Sign lives in quantity, against a positive price (§2).
      await seedPositionSet({
        account: loan,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "-8000.00000000" }],
      });

      const total = await accountTotal(loan.id, db);

      expect(total?.amount).toBe("-8000.0000");
      expect(total?.accountKind).toBe("liability");
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

      const total = await accountTotal(account.id, db);

      // Missing from amount, present in count — lets the page say "1 of 2 holdings".
      expect(total?.amount).toBe("2500.0000");
      expect(total?.coverage).toEqual({ known: 1, total: 2 });

      // Only account in the household — drill-down and headline are one arithmetic (§8.2).
      expect(await netWorth(ALL_OWNERS, db)).toEqual({ amount: "2500.0000", coverage: { known: 1, total: 2 } });
    }),
  );

  it(
    "is null for an account that does not exist, one that is closed, and an id that never could be",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet, usdInstrument }) => {
      const owner = await seedPerson();
      const usd = await usdInstrument();
      const closed = await seedAccount({ name: "Old 401k", owner, closedAt: "2026-02-01" });
      await seedPositionSet({
        account: closed,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "1000.00000000" }],
      });

      // Identity ids start at 1 in a rolled-back transaction — this id can't exist.
      expect(await accountTotal("999999999", db)).toBeNull();

      // holding_valued excludes closed accounts — null, not zero.
      expect(await accountTotal(closed.id, db)).toBeNull();

      // Non-bigint id straight off a URL path — 404, not 500.
      expect(await accountTotal("not-an-id", db)).toBeNull();
      expect(await accountTotal("1; drop table account", db)).toBeNull();
    }),
  );
});

describe("accountHoldings", () => {
  it(
    "returns the holdings of the account asked for and no others",
    withDatabase(async ({ db, seedPerson, seedAccount, seedInstrument, seedPositionSet, seedQuote, usdInstrument }) => {
      const owner = await seedPerson();
      const usd = await usdInstrument();
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market ETF" });
      await seedQuote({ instrument: vti, price: "250.0000" });

      const brokerage = await seedAccount({ name: "Fidelity Taxable", owner });
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

      const holdings = await accountHoldings(brokerage.id, db);

      expect(holdings.map((holding) => [holding.instrumentName, holding.value])).toEqual([
        ["US Dollar", "3000.0000"],
        ["Vanguard Total Stock Market ETF", "25000.0000"],
      ]);
      expect(holdings.every((holding) => holding.accountId === brokerage.id)).toBe(true);
    }),
  );

  it(
    "keeps an unpriced holding, marked, rather than hiding the gap",
    withDatabase(async ({ db, seedPerson, seedAccount, seedInstrument, seedPositionSet }) => {
      const owner = await seedPerson();
      const account = await seedAccount({ owner });
      const cit = await seedInstrument({ symbol: null, name: "Target 2045 Trust II" });

      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: cit, quantity: "500.00000000" }],
      });

      const [holding] = await accountHoldings(account.id, db);

      expect(holding?.quantity).toBe("500.00000000");
      expect(holding?.price).toBeNull();
      // Null, not zero — table renders a dash for unknown.
      expect(holding?.value).toBeNull();
      expect(holding?.isPriced).toBe(false);
    }),
  );

  it(
    "is empty for an account holding nothing, a closed one, and an id that is not an account",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet, usdInstrument }) => {
      const owner = await seedPerson();
      const usd = await usdInstrument();
      const empty = await seedAccount({ owner });
      const closed = await seedAccount({ owner, closedAt: "2026-02-01" });
      await seedPositionSet({
        account: closed,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "1000.00000000" }],
      });

      expect(await accountHoldings(empty.id, db)).toEqual([]);
      expect(await accountHoldings(closed.id, db)).toEqual([]);
      expect(await accountHoldings("999999999", db)).toEqual([]);
      expect(await accountHoldings("not-an-id", db)).toEqual([]);
    }),
  );
});

describe("accountFirstRecordedDate", () => {
  it(
    "is this account's own earliest statement, not the household's — spec 0008's chart-range work",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet }) => {
      const owner = await seedPerson();
      // Must be this account's own earliest date, not the household's older one.
      const older = await seedAccount({ name: "Older", owner });
      const younger = await seedAccount({ name: "Younger", owner });
      await seedPositionSet({ account: older, asOf: "2026-01-31", holdings: [] });
      await seedPositionSet({ account: younger, asOf: "2026-06-30", holdings: [] });

      expect(await accountFirstRecordedDate(older.id, db)).toBe("2026-01-31");
      expect(await accountFirstRecordedDate(younger.id, db)).toBe("2026-06-30");
    }),
  );

  it(
    "is null for an account with no statements, a closed one, and an id that is not an account",
    withDatabase(async ({ db, seedPerson, seedAccount }) => {
      const owner = await seedPerson();
      const fresh = await seedAccount({ owner });
      const closed = await seedAccount({ owner, closedAt: "2026-02-01" });

      expect(await accountFirstRecordedDate(fresh.id, db)).toBeNull();
      expect(await accountFirstRecordedDate(closed.id, db)).toBeNull();
      expect(await accountFirstRecordedDate("999999999", db)).toBeNull();
      expect(await accountFirstRecordedDate("not-an-id", db)).toBeNull();
    }),
  );
});

describe("accountSeries", () => {
  it(
    "prices each date against that account's own positions, in one query",
    withDatabase(async ({ db, seedPerson, seedAccount, seedInstrument, seedPositionSet, seedDailyClose }) => {
      const owner = await seedPerson();
      const mine = await seedAccount({ name: "Mine", owner });
      const other = await seedAccount({ name: "Other", owner });

      const vti = await seedInstrument({ symbol: "VTI", name: "VTI" });
      const bnd = await seedInstrument({ symbol: "BND", name: "BND" });

      await seedPositionSet({
        account: mine,
        asOf: "2026-01-31",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });
      await seedPositionSet({
        account: other,
        asOf: "2026-01-31",
        holdings: [{ instrument: bnd, quantity: "1000.00000000" }],
      });

      await seedDailyClose({ instrument: vti, date: "2026-01-31", close: "200.0000" });
      await seedDailyClose({ instrument: vti, date: "2026-02-28", close: "250.0000" });
      await seedDailyClose({ instrument: bnd, date: "2026-01-31", close: "70.0000" });

      const series = await accountSeries(mine.id, ["2026-02-28", "2026-01-31"], db);

      // Other account's 70,000 excluded; dates return sorted regardless of input order.
      expect(series).toEqual([
        { date: "2026-01-31", amount: "20000.0000", coverage: { known: 1, total: 1 } },
        { date: "2026-02-28", amount: "25000.0000", coverage: { known: 1, total: 1 } },
      ]);
    }),
  );

  it(
    "reports a date before the account's first statement as uncovered, not as a zero balance",
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

      const series = await accountSeries(account.id, ["2025-06-01", "2026-01-31"], db);

      // Reported, not dropped — stops the chart drawing a fictional climb from zero (§7). Screen filters on coverage, not amount.
      expect(series[0]).toEqual({
        date: "2025-06-01",
        amount: "0.0000",
        coverage: { known: 0, total: 0 },
      });
      expect(series[1]?.coverage).toEqual({ known: 1, total: 1 });
    }),
  );

  it(
    "keeps a liability account's line negative on every date",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet, usdInstrument }) => {
      const owner = await seedPerson();
      const usd = await usdInstrument();
      const loan = await seedAccount({ name: "Car loan", owner, kind: "liability" });

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

      // USD's 1970-01-01 close of 1.00 (initial migration) prices debt via ordinary carry-forward.
      const series = await accountSeries(loan.id, ["2026-03-31", "2026-07-31"], db);

      expect(series.map((point) => point.amount)).toEqual(["-10000.0000", "-5000.0000"]);
    }),
  );

  it(
    "reports every date as uncovered for an account that does not exist",
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

      // Not the household's 1,000 leaking through, and not empty — dates asked for are still answered.
      const uncovered = [
        { date: "2026-01-31", amount: "0.0000", coverage: { known: 0, total: 0 } },
      ];

      expect(await accountSeries("999999999", ["2026-01-31"], db)).toEqual(uncovered);
      expect(await accountSeries("not-an-id", ["2026-01-31"], db)).toEqual(uncovered);
    }),
  );

  it(
    "returns nothing for no dates rather than querying for none",
    withDatabase(async ({ db, seedAccount }) => {
      const account = await seedAccount();
      expect(await accountSeries(account.id, [], db)).toEqual([]);
    }),
  );
});

describe("one account's 1D series", () => {
  it(
    "draws only this account's holdings, at the whole log's instants",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose, seedObservation }) => {
      const mine = await seedAccount({ name: "Fidelity Brokerage" });
      const theirs = await seedAccount({ name: "Schwab Brokerage" });
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      await seedPositionSet({
        account: mine,
        asOf: "2026-06-04",
        holdings: [{ instrument: vti, quantity: "10.00000000" }],
      });
      await seedPositionSet({
        account: theirs,
        asOf: "2026-06-04",
        holdings: [{ instrument: vti, quantity: "90.00000000" }],
      });
      await seedDailyClose({ instrument: vti, date: "2026-06-04", close: "200.0000" });

      await seedObservation({ instrument: vti, asOf: "2026-06-05T13:30:00Z", price: "210.0000" });
      await seedObservation({ instrument: vti, asOf: "2026-06-05T14:00:00Z", price: "220.0000" });

      // Ten shares, not a hundred — narrows to this account's holdings only.
      expect(
        (await accountSessionSeries(mine.id, "2026-06-05", db)).map((point) => [point.at, point.amount]),
      ).toEqual([
        ["2026-06-05T13:30:00.000Z", "2100.0000"],
        ["2026-06-05T14:00:00.000Z", "2200.0000"],
      ]);
    }),
  );

  it(
    "gives a cash-only account its flat line rather than an empty chart",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose, seedObservation, usdInstrument }) => {
      const bank = await seedAccount({ name: "Ally Savings", kind: "bank" });
      const usd = await usdInstrument();
      await seedPositionSet({
        account: bank,
        asOf: "2026-06-04",
        holdings: [{ instrument: usd, quantity: "5000.00000000" }],
      });

      // Instrument this account doesn't hold — instants come from the whole log, so every account answers at the same moments (story 10).
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedDailyClose({ instrument: vti, date: "2026-06-04", close: "200.0000" });
      await seedObservation({ instrument: vti, asOf: "2026-06-05T13:30:00Z", price: "210.0000" });
      await seedObservation({ instrument: vti, asOf: "2026-06-05T14:00:00Z", price: "220.0000" });

      expect(await accountSessionSeries(bank.id, "2026-06-05", db)).toEqual([
        { at: "2026-06-05T13:30:00.000Z", amount: "5000.0000", coverage: { known: 1, total: 1 } },
        { at: "2026-06-05T14:00:00.000Z", amount: "5000.0000", coverage: { known: 1, total: 1 } },
      ]);
    }),
  );

  it(
    "reports an instant it holds nothing at rather than dropping it from the line",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedObservation, seedDailyClose }) => {
      const empty = await seedAccount({ name: "Opened, never funded" });
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedDailyClose({ instrument: vti, date: "2026-06-04", close: "200.0000" });
      await seedObservation({ instrument: vti, asOf: "2026-06-05T13:30:00Z", price: "210.0000" });

      // Zero over zero coverage — caller must not draw as real zero (DESIGN.md §7).
      expect(await accountSessionSeries(empty.id, "2026-06-05", db)).toEqual([
        { at: "2026-06-05T13:30:00.000Z", amount: "0.0000", coverage: { known: 0, total: 0 } },
      ]);
    }),
  );

  it(
    "refuses an account id that is not one, rather than reading it as SQL",
    withDatabase(async ({ db, seedInstrument, seedObservation, seedDailyClose }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedDailyClose({ instrument: vti, date: "2026-06-04", close: "200.0000" });
      await seedObservation({ instrument: vti, asOf: "2026-06-05T13:30:00Z", price: "210.0000" });

      expect(await accountSessionSeries("1 or true", "2026-06-05", db)).toEqual([
        { at: "2026-06-05T13:30:00.000Z", amount: "0.0000", coverage: { known: 0, total: 0 } },
      ]);
    }),
  );
});
