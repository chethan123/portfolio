/**
 * The queries the account drill-down reads through (DESIGN.md §8.2).
 *
 * Same contract as `dashboard-queries.test.ts`: driven through the query
 * module's public functions against a real Postgres, seeded through the fixture
 * builder, with every money assertion an exact decimal string at the stored
 * scale.
 *
 * What this file is really about is the drill-down's version of §8.2's weakest
 * point. One account's page shows a figure that also appears in a row on the
 * overview and in a slice of the total, so the first test here is that those
 * are literally the same arithmetic — and the rest are the three cases where a
 * per-account query is most tempted to invent an answer of its own: an account
 * holding nothing, a date before it held anything, and an id that is not an
 * account at all.
 */
import { afterAll, describe, expect, it } from "vitest";

import {
  accountFirstRecordedDate,
  accountHoldings,
  accountSeries,
  accountTotal,
  accountTotals,
  netWorth,
} from "~/lib/valuation.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";

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
        institution: "Fidelity",
        accountKind: "brokerage",
        ownerName: "Alice",
        amount: "28000.0000",
        coverage: { known: 2, total: 2 },
      });

      // The drill-down's consistency check, and the reason this returns the
      // same type the list does: the page's headline is the overview's row.
      const [row] = (await accountTotals(db)).filter(
        (candidate) => candidate.accountId === brokerage.id,
      );
      expect(total).toEqual(row);
    }),
  );

  it(
    "reports an account holding nothing as nothing to value, not as worth nothing",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet }) => {
      const owner = await seedPerson({ name: "Alice" });
      // Never uploaded to, and uploaded to but emptied — "sold everything" is
      // recorded as a position set with no holdings, so both reach the view as
      // no rows at all and both must survive the LEFT join.
      const fresh = await seedAccount({ name: "New brokerage", owner });
      const emptied = await seedAccount({ name: "Closed out", owner });
      await seedPositionSet({ account: emptied, asOf: "2026-01-31", holdings: [] });

      for (const account of [fresh, emptied]) {
        const total = await accountTotal(account.id, db);

        // Zero over a coverage of zero rows. Not null, which would 404 an
        // account that exists, and not a figure a screen can call complete.
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

      // The sign lives in quantity, against a positive price (§2).
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

      // "Based on 1 of 2 holdings" — the trust is missing from the amount and
      // present in the count, so the page can say so.
      expect(total?.amount).toBe("2500.0000");
      expect(total?.coverage).toEqual({ known: 1, total: 2 });

      // And the account's own figure is the household's, since it is the only
      // account: the drill-down and the headline are one arithmetic (§8.2).
      expect(await netWorth(db)).toEqual({ amount: "2500.0000", coverage: { known: 1, total: 2 } });
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

      // No such row. Identity ids start at 1 and this test's transaction is
      // rolled back, so nothing can have reached this one.
      expect(await accountTotal("999999999", db)).toBeNull();

      // Closed is null rather than a zero: `holding_valued` excludes closed
      // accounts, so a drill-down on one would be a page of blanks.
      expect(await accountTotal(closed.id, db)).toBeNull();

      // Straight off a URL path, and never a bigint. This is a 404, not a 500.
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
      // Null, never a zero standing in for unknown — the table shows a dash.
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
      // The household's earliest statement is January's, on an older account —
      // the account-scoped query must not report that date for one that
      // started later, the way the household-wide fallback used to.
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

      // The other account's 70,000 is nowhere in this line, and the dates come
      // back sorted whatever order they were asked for.
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

      // The date is reported rather than dropped, and it is reported as having
      // nothing behind it — which is what stops the account's chart drawing a
      // fictional climb from zero at its head (§7). The screen filters on
      // coverage, never on the amount.
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

      // USD carries a 1970-01-01 close of 1.00 from the initial migration, so
      // the ordinary carry-forward prices debt on any date without a branch.
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

      // Not the household's 1,000 leaking through a filter that did not apply,
      // and not an empty array either: the dates asked for are still answered.
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
