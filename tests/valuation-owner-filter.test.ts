/**
 * The owner filter where it meets SQL (spec 0013 ticket 02, ADR-0008). ALL_OWNERS isn't
 * exercised here on purpose — the rest of the suite passing unchanged says the unfiltered
 * read is the query it always was. Two rules carry the weight: narrowing lives inside the
 * lateral in readSeries/readSessionSeries, so an uncovered date is reported, not dropped (an
 * outer WHERE would silently shorten the line); and firstRecordedDate narrows through account,
 * not the view, so it spans closed accounts. Exact decimal strings; the one JS sum goes through money.ts.
 */
import { afterAll, describe, expect, it } from "vitest";

import { MONEY_SCALE, render, sumMoney } from "~/lib/money";
import {
  accountTotals,
  currentHoldings,
  firstRecordedDate,
  holdingsAt,
  netWorth,
  netWorthAt,
  netWorthChange,
  netWorthSeries,
  netWorthSessionSeries,
} from "~/lib/valuation.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";
import { ALL_OWNERS } from "../app/lib/owner-filter.ts";

afterAll(closeTestDatabase);

// an id no person can have: appending zeros puts it far past anything bigserial could have
// issued, while staying inside the 18-digit bound so it reaches the query, not the guard
function noSuchOwner(id: string): string {
  return `${id}000000`;
}

// 25 digits: longer than a bigint holds, and shorter than nothing
const OUT_OF_RANGE_ID = "9999999999999999999999999";

describe("a household reader narrowed to one owner", () => {
  it(
    "returns that owner's holdings and account rollups and nobody else's",
    withDatabase(async ({ db, seedPerson, seedAccount, seedInstrument, seedPositionSet, seedQuote, usdInstrument }) => {
      const alice = await seedPerson({ name: "Alice" });
      const bob = await seedPerson({ name: "Bob" });
      const usd = await usdInstrument();
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market ETF" });
      await seedQuote({ instrument: vti, price: "250.0000" });

      const hers = await seedAccount({ name: "Alice Brokerage", owner: alice });
      const his = await seedAccount({ name: "Bob Checking", owner: bob, kind: "bank" });

      await seedPositionSet({
        account: hers,
        asOf: "2026-01-31",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });
      await seedPositionSet({
        account: his,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "12500.00000000" }],
      });

      const holdings = await currentHoldings([alice.id], db);

      expect(holdings.map((holding) => [holding.ownerName, holding.accountName, holding.value])).toEqual([
        ["Alice", "Alice Brokerage", "25000.0000"],
      ]);

      // rollup narrows through account.owner_id, not the view — a second predicate on a
      // second column, needing its own assertion
      expect(await accountTotals([alice.id], db)).toEqual([
        expect.objectContaining({ accountName: "Alice Brokerage", ownerName: "Alice", amount: "25000.0000" }),
      ]);
    }),
  );

  it(
    "narrows a past date on the same terms as the present",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet, usdInstrument }) => {
      const alice = await seedPerson({ name: "Alice" });
      const bob = await seedPerson({ name: "Bob" });
      const usd = await usdInstrument();

      const hers = await seedAccount({ name: "Alice Savings", owner: alice, kind: "bank" });
      const his = await seedAccount({ name: "Bob Savings", owner: bob, kind: "bank" });

      await seedPositionSet({
        account: hers,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "4000.00000000" }],
      });
      await seedPositionSet({
        account: his,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "9000.00000000" }],
      });

      const holdings = await holdingsAt([alice.id], "2026-02-15", db);

      expect(holdings.map((holding) => [holding.accountName, holding.value])).toEqual([
        ["Alice Savings", "4000.0000"],
      ]);
      expect(await netWorthAt([alice.id], "2026-02-15", db)).toEqual({
        amount: "4000.0000",
        coverage: { known: 1, total: 1 },
      });
    }),
  );

  it(
    "splits the household total between its two owners to the last decimal place",
    withDatabase(async ({ db, seedPerson, seedAccount, seedInstrument, seedPositionSet, seedQuote, usdInstrument }) => {
      const alice = await seedPerson({ name: "Alice" });
      const bob = await seedPerson({ name: "Bob" });
      const usd = await usdInstrument();
      // price/quantity chosen so the parts don't round tidily — a float anywhere in this path shows up in the last place
      const vti = await seedInstrument({ symbol: "VTI", name: "VTI" });
      await seedQuote({ instrument: vti, price: "333.3333" });

      const hers = await seedAccount({ name: "Alice Brokerage", owner: alice });
      const his = await seedAccount({ name: "Bob Checking", owner: bob, kind: "bank" });

      await seedPositionSet({
        account: hers,
        asOf: "2026-01-31",
        holdings: [{ instrument: vti, quantity: "7.00000000" }],
      });
      await seedPositionSet({
        account: his,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "1234.56000000" }],
      });

      const hersNow = await netWorth([alice.id], db);
      const hisNow = await netWorth([bob.id], db);
      const household = await netWorth(ALL_OWNERS, db);

      expect(hersNow.amount).toBe("2333.3331");
      expect(hisNow.amount).toBe("1234.5600");
      expect(household.amount).toBe("3567.8931");

      // added through money.ts, not `+` — the rule the whole numeric boundary exists for (§5.6)
      const { amount } = sumMoney([hersNow.amount, hisNow.amount]);
      expect(render(amount, MONEY_SCALE)).toBe(household.amount);
    }),
  );
});

describe("the narrowing inside the lateral", () => {
  it(
    "still reports a date only the excluded owner has a position set on",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet, usdInstrument }) => {
      const alice = await seedPerson({ name: "Alice" });
      const bob = await seedPerson({ name: "Bob" });
      const usd = await usdInstrument();

      const hers = await seedAccount({ name: "Alice Savings", owner: alice, kind: "bank" });
      const his = await seedAccount({ name: "Bob Savings", owner: bob, kind: "bank" });

      // Bob's history starts in January, Alice's not until April — February is covered for Bob, not Alice
      await seedPositionSet({
        account: his,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "9000.00000000" }],
      });
      await seedPositionSet({
        account: hers,
        asOf: "2026-04-30",
        holdings: [{ instrument: usd, quantity: "4000.00000000" }],
      });

      const dates = ["2026-02-15", "2026-04-30"];

      // the premise: unfiltered, February is a covered point — if this stops being true the test below passes for the wrong reason
      expect(await netWorthSeries(ALL_OWNERS, dates, db)).toEqual([
        { date: "2026-02-15", amount: "9000.0000", coverage: { known: 1, total: 1 } },
        { date: "2026-04-30", amount: "13000.0000", coverage: { known: 2, total: 2 } },
      ]);

      // narrowed to Alice, February is uncovered — reported, never dropped. A predicate in the
      // outer WHERE would reject the all-null LEFT JOIN row and take the date with it silently
      expect(await netWorthSeries([alice.id], dates, db)).toEqual([
        { date: "2026-02-15", amount: "0.0000", coverage: { known: 0, total: 0 } },
        { date: "2026-04-30", amount: "4000.0000", coverage: { known: 1, total: 1 } },
      ]);
    }),
  );

  it(
    "values only the selected owner's positions at each instant of a session",
    withDatabase(async ({ db, seedPerson, seedAccount, seedInstrument, seedPositionSet, seedObservation }) => {
      const alice = await seedPerson({ name: "Alice" });
      const bob = await seedPerson({ name: "Bob" });
      const vti = await seedInstrument({ symbol: "VTI", name: "VTI", priceSource: "feed" });

      const hers = await seedAccount({ name: "Alice Brokerage", owner: alice });
      const his = await seedAccount({ name: "Bob Brokerage", owner: bob });

      await seedPositionSet({
        account: hers,
        asOf: "2026-06-04",
        holdings: [{ instrument: vti, quantity: "10.00000000" }],
      });
      await seedPositionSet({
        account: his,
        asOf: "2026-06-04",
        holdings: [{ instrument: vti, quantity: "100.00000000" }],
      });

      await seedObservation({ instrument: vti, asOf: "2026-06-05T13:30:00Z", price: "210.0000" });
      await seedObservation({ instrument: vti, asOf: "2026-06-05T14:00:00Z", price: "220.0000" });

      // ten shares, not a hundred and ten — instants come from the whole observation log, value from one owner's holdings
      expect(await netWorthSessionSeries([alice.id], "2026-06-05", db)).toEqual([
        { at: "2026-06-05T13:30:00.000Z", amount: "2100.0000", coverage: { known: 1, total: 1 } },
        { at: "2026-06-05T14:00:00.000Z", amount: "2200.0000", coverage: { known: 1, total: 1 } },
      ]);
    }),
  );
});

describe("accountTotals narrowed", () => {
  it(
    "still reports an owned account holding nothing as nothing to value",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet, usdInstrument }) => {
      const alice = await seedPerson({ name: "Alice" });
      const bob = await seedPerson({ name: "Bob" });
      const usd = await usdInstrument();

      const funded = await seedAccount({ name: "Alice Funded", owner: alice, kind: "bank" });
      const emptied = await seedAccount({ name: "Alice Emptied", owner: alice });
      const his = await seedAccount({ name: "Bob Checking", owner: bob, kind: "bank" });

      await seedPositionSet({
        account: funded,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "5000.00000000" }],
      });
      // sold down to nothing: a legal, empty statement, no rows in the view
      await seedPositionSet({ account: emptied, asOf: "2026-01-31", holdings: [] });
      await seedPositionSet({
        account: his,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "12500.00000000" }],
      });

      const totals = await accountTotals([alice.id], db);

      // owner predicate sits beside the LEFT join, not replacing it — the emptied account is still here saying "nothing to value"
      expect(totals.map((total) => [total.accountName, total.amount])).toEqual([
        ["Alice Funded", "5000.0000"],
        ["Alice Emptied", "0.0000"],
      ]);
      expect(totals[1]?.coverage).toEqual({ known: 0, total: 0 });
    }),
  );
});

describe("netWorthChange narrowed", () => {
  it(
    "compares the selected owner to herself on both ends of the window",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet, usdInstrument }) => {
      const alice = await seedPerson({ name: "Alice" });
      const bob = await seedPerson({ name: "Bob" });
      const usd = await usdInstrument();

      const hers = await seedAccount({ name: "Alice Savings", owner: alice, kind: "bank" });
      const his = await seedAccount({ name: "Bob Savings", owner: bob, kind: "bank" });

      await seedPositionSet({
        account: hers,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "10000.00000000" }],
      });
      await seedPositionSet({
        account: hers,
        asOf: "2026-06-30",
        holdings: [{ instrument: usd, quantity: "15000.00000000" }],
      });
      // Bob's balance makes the two ends distinguishable — an unnarrowed `past` CTE would
      // report 60,000 here and turn Alice's rise into a fall
      await seedPositionSet({
        account: his,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "50000.00000000" }],
      });

      expect((await netWorthChange(ALL_OWNERS, "2026-01-31", db)).previous).toBe("60000.0000");

      expect(await netWorthChange([alice.id], "2026-01-31", db)).toEqual({
        current: "15000.0000",
        previous: "10000.0000",
        difference: "5000.0000",
        percent: "50.0000",
      });
    }),
  );
});

describe("an id that names nobody", () => {
  it(
    "empties every narrowed reader rather than failing",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet, usdInstrument }) => {
      const alice = await seedPerson({ name: "Alice" });
      const usd = await usdInstrument();
      const hers = await seedAccount({ name: "Alice Savings", owner: alice, kind: "bank" });
      await seedPositionSet({
        account: hers,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "4000.00000000" }],
      });

      // a hand-edited ?owner= is kept, not dropped at parse — so it empties the screen here instead of widening it back out
      const nobody = [noSuchOwner(alice.id)];

      expect(await currentHoldings(nobody, db)).toEqual([]);
      expect(await accountTotals(nobody, db)).toEqual([]);
      expect(await netWorth(nobody, db)).toEqual({ amount: "0.0000", coverage: { known: 0, total: 0 } });
      expect(await firstRecordedDate(nobody, db)).toBeNull();
    }),
  );

  it(
    "answers a 25-digit id in SQL rather than sending it to a bigint column",
    withDatabase(async ({ db, seedPerson, seedAccount, seedInstrument, seedPositionSet, seedObservation, usdInstrument }) => {
      const alice = await seedPerson({ name: "Alice" });
      const usd = await usdInstrument();
      const vti = await seedInstrument({ symbol: "VTI", name: "VTI", priceSource: "feed" });
      const hers = await seedAccount({ name: "Alice Brokerage", owner: alice });
      await seedPositionSet({
        account: hers,
        asOf: "2026-01-31",
        holdings: [
          { instrument: usd, quantity: "4000.00000000" },
          { instrument: vti, quantity: "10.00000000" },
        ],
      });
      await seedObservation({ instrument: vti, asOf: "2026-06-05T14:00:00Z", price: "220.0000" });

      // without the length bound this id reaches Postgres and errors out of range — a 500
      // where the honest answer is "no such owner". Every column is exercised since the bound
      // lives in isOneOf and each reader names its own column.
      const tooLong = [OUT_OF_RANGE_ID];

      expect(await currentHoldings(tooLong, db)).toEqual([]);
      expect(await accountTotals(tooLong, db)).toEqual([]);
      expect(await netWorth(tooLong, db)).toEqual({ amount: "0.0000", coverage: { known: 0, total: 0 } });
      expect(await netWorthAt(tooLong, "2026-02-15", db)).toEqual({
        amount: "0.0000",
        coverage: { known: 0, total: 0 },
      });
      expect(await firstRecordedDate(tooLong, db)).toBeNull();

      // the two lateral readers keep reporting their dates and instants — only the values inside go to nothing
      expect(await netWorthSeries(tooLong, ["2026-02-15"], db)).toEqual([
        { date: "2026-02-15", amount: "0.0000", coverage: { known: 0, total: 0 } },
      ]);
      expect(await netWorthSessionSeries(tooLong, "2026-06-05", db)).toEqual([
        { at: "2026-06-05T14:00:00.000Z", amount: "0.0000", coverage: { known: 0, total: 0 } },
      ]);
    }),
  );
});

describe("firstRecordedDate narrowed", () => {
  it(
    "reports the selected owner's first statement rather than the household's",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet, usdInstrument }) => {
      const alice = await seedPerson({ name: "Alice" });
      const bob = await seedPerson({ name: "Bob" });
      const usd = await usdInstrument();

      const hers = await seedAccount({ name: "Alice Savings", owner: alice, kind: "bank" });
      const his = await seedAccount({ name: "Bob Savings", owner: bob, kind: "bank" });

      await seedPositionSet({
        account: his,
        asOf: "2025-01-31",
        holdings: [{ instrument: usd, quantity: "9000.00000000" }],
      });
      await seedPositionSet({
        account: hers,
        asOf: "2026-03-01",
        holdings: [{ instrument: usd, quantity: "4000.00000000" }],
      });

      // day zero is per selection — a chart narrowed to Alice must not spend its "All" range on the year before she had an account
      expect(await firstRecordedDate(ALL_OWNERS, db)).toBe("2025-01-31");
      expect(await firstRecordedDate([alice.id], db)).toBe("2026-03-01");
      expect(await firstRecordedDate([alice.id, bob.id], db)).toBe("2025-01-31");
    }),
  );

  it(
    "keeps a real first recorded date for an owner whose accounts are all closed, though there is nothing left to value",
    withDatabase(async ({ db, seedPerson, seedAccount, seedPositionSet, usdInstrument }) => {
      const departed = await seedPerson({ name: "Cara" });
      const usd = await usdInstrument();

      const closed = await seedAccount({
        name: "Cara Rollover",
        owner: departed,
        closedAt: "2026-05-31",
      });
      await seedPositionSet({
        account: closed,
        asOf: "2026-02-28",
        holdings: [{ instrument: usd, quantity: "7000.00000000" }],
      });

      // deliberate asymmetry ticket 03's chart depends on: the view excludes closed accounts,
      // but firstRecordedDate reaches position_set through account, where closed is still history
      expect(await currentHoldings([departed.id], db)).toEqual([]);
      expect(await accountTotals([departed.id], db)).toEqual([]);
      expect(await netWorth([departed.id], db)).toEqual({
        amount: "0.0000",
        coverage: { known: 0, total: 0 },
      });
      expect(await firstRecordedDate([departed.id], db)).toBe("2026-02-28");
    }),
  );
});
