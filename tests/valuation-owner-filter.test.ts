/**
 * Every household reader narrowed to an owner (spec 0013, ticket 02).
 *
 * Same contract as `dashboard-queries.test.ts`: the query module's public
 * functions against a real Postgres, seeded through the fixture builder, with
 * every money assertion an exact decimal string at the stored scale. The risk
 * lives in Postgres-specific SQL and `numeric` handling, which is exactly what
 * disappears under a mock.
 *
 * Two rules here are silent when they are wrong, and both have a comment in
 * `valuation.server.ts` warning about them already.
 *
 * **The series readers narrow inside the lateral.** An outer WHERE is evaluated
 * after the LEFT join and rejects the all-null row the join manufactures for a
 * date this owner holds nothing on — which takes the date off the line
 * altogether instead of reporting it as uncovered. A shorter chart, with
 * nothing anywhere saying so.
 *
 * **An unusable id narrows to nothing rather than erroring.** `owner-filter.ts`
 * deliberately keeps an id naming nobody, because dropping it would widen the
 * view back to the whole household; the guard that makes that safe is here, in
 * the predicate, and it has to survive twenty-five digits as well as letters.
 */
import { afterAll, describe, expect, it } from "vitest";

import { ALL_OWNERS } from "~/lib/owner-filter";
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

import type { TestContext } from "./support/database.ts";

afterAll(closeTestDatabase);

/** An id no person in a transaction-scoped test can ever have been issued. */
const NOBODY = "999999999";

/** All digits, and far past `bigint` — the id that used to reach Postgres. */
const TOO_LONG = "1234567890123456789012345";

/**
 * Two owners, one account each, priced so their totals are different numbers
 * and their sum is a third — the shape every assertion below needs.
 *
 * Alice holds 100 VTI at 250.0000; Bob holds 40 VXUS at 60.0000. Both accounts
 * record on `asOf`, and both instruments get a close on that date at the same
 * price as the quote — `holding_valued_at` prices from the close and carries it
 * forward, so without one every dated reader would answer "held but unpriced"
 * and the narrowing under test would be invisible behind it.
 */
async function seedTwoOwners(
  ctx: Pick<
    TestContext,
    | "seedPerson"
    | "seedAccount"
    | "seedInstrument"
    | "seedPositionSet"
    | "seedQuote"
    | "seedDailyClose"
  >,
  asOf: string,
) {
  const alice = await ctx.seedPerson({ name: "Alice" });
  const bob = await ctx.seedPerson({ name: "Bob" });

  const vti = await ctx.seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
  const vxus = await ctx.seedInstrument({ symbol: "VXUS", name: "Vanguard Total International" });
  await ctx.seedQuote({ instrument: vti, price: "250.0000" });
  await ctx.seedQuote({ instrument: vxus, price: "60.0000" });
  await ctx.seedDailyClose({ instrument: vti, date: asOf, close: "250.0000" });
  await ctx.seedDailyClose({ instrument: vxus, date: asOf, close: "60.0000" });

  const hers = await ctx.seedAccount({ name: "Alice Brokerage", owner: alice, kind: "brokerage" });
  const his = await ctx.seedAccount({ name: "Bob Brokerage", owner: bob, kind: "brokerage" });

  await ctx.seedPositionSet({
    account: hers,
    asOf,
    holdings: [{ instrument: vti, quantity: "100.00000000" }],
  });
  await ctx.seedPositionSet({
    account: his,
    asOf,
    holdings: [{ instrument: vxus, quantity: "40.00000000" }],
  });

  return { alice, bob, hers, his, vti, vxus };
}

describe("the readers that take the filter", () => {
  it(
    "returns only the selected owner's holdings, and both owners' totals sum to the household's",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx, "2026-02-28");

      const hers = await currentHoldings([alice.id], ctx.db);
      expect(hers.map((holding) => holding.ownerName)).toEqual(["Alice"]);
      expect(hers.map((holding) => holding.value)).toEqual(["25000.0000"]);

      // Exact decimal strings at the stored scale. `toBeCloseTo` would hide the
      // driver-coercion regression these assertions exist to catch.
      expect((await netWorth([alice.id], ctx.db)).amount).toBe("25000.0000");
      expect((await netWorth([bob.id], ctx.db)).amount).toBe("2400.0000");
      expect((await netWorth(ALL_OWNERS, ctx.db)).amount).toBe("27400.0000");

      // Two owners selected is the household here, arrived at the other way.
      expect((await netWorth([alice.id, bob.id], ctx.db)).amount).toBe("27400.0000");
    }),
  );

  it(
    "narrows the dated twins on the same terms as the readers every screen uses",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx, "2026-02-28");

      const hers = await holdingsAt([alice.id], "2026-03-15", ctx.db);
      expect(hers.map((holding) => holding.ownerName)).toEqual(["Alice"]);

      expect((await netWorthAt([alice.id], "2026-03-15", ctx.db)).amount).toBe("25000.0000");
      expect((await netWorthAt([bob.id], "2026-03-15", ctx.db)).amount).toBe("2400.0000");

      // Before either statement: nothing was recorded yet, which is a coverage
      // of zero rows rather than a household that held nothing.
      const before = await netWorthAt([alice.id], "2026-01-01", ctx.db);
      expect(before).toEqual({ amount: "0.0000", coverage: { known: 0, total: 0 } });
    }),
  );

  it(
    "rolls up only the selected owner's accounts, and still reports one holding nothing as 0.0000",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx, "2026-02-28");

      // An account of Alice's whose statements are all empty. It has no rows in
      // the view at all, and the LEFT join is what keeps it from vanishing —
      // narrowing must not quietly turn that back into an inner join.
      const empty = await ctx.seedAccount({ name: "Alice Cash", owner: alice, kind: "bank" });
      await ctx.seedPositionSet({ account: empty, asOf: "2026-02-28", holdings: [] });

      const hers = await accountTotals([alice.id], ctx.db);
      expect(hers.map((account) => account.accountName)).toEqual(["Alice Brokerage", "Alice Cash"]);
      expect(hers.map((account) => account.amount)).toEqual(["25000.0000", "0.0000"]);

      const both = await accountTotals([alice.id, bob.id], ctx.db);
      expect(both.map((account) => account.accountName)).toEqual(
        (await accountTotals(ALL_OWNERS, ctx.db)).map((account) => account.accountName),
      );
    }),
  );

  it(
    "compares owner to owner on both ends of the delta, never one owner against the household",
    withDatabase(async (ctx) => {
      const { alice, bob, hers } = await seedTwoOwners(ctx, "2026-01-31");
      const vti = await ctx.seedInstrument({ symbol: "VTI2", name: "Another Total Market" });
      await ctx.seedQuote({ instrument: vti, price: "300.0000" });

      // Alice doubles up in February; Bob does not move.
      await ctx.seedPositionSet({
        account: hers,
        asOf: "2026-02-28",
        holdings: [{ instrument: vti, quantity: "200.00000000" }],
      });

      const change = await netWorthChange([alice.id], "2026-02-01", ctx.db);
      expect(change.previous).toBe("25000.0000");
      expect(change.current).toBe("60000.0000");
      expect(change.difference).toBe("35000.0000");

      // Bob's own delta is flat, and narrowing the past CTE is what makes it so:
      // against the household's past it would read as a large fall.
      const his = await netWorthChange([bob.id], "2026-02-01", ctx.db);
      expect(his).toMatchObject({ previous: "2400.0000", current: "2400.0000", difference: "0.0000" });
    }),
  );

  it(
    "reports the selected owners' first recorded date, not the household's",
    withDatabase(async (ctx) => {
      const { alice, bob, his } = await seedTwoOwners(ctx, "2026-02-28");
      await ctx.seedPositionSet({ account: his, asOf: "2024-06-30", holdings: [] });

      expect(await firstRecordedDate(ALL_OWNERS, ctx.db)).toBe("2024-06-30");
      expect(await firstRecordedDate([alice.id], ctx.db)).toBe("2026-02-28");
      expect(await firstRecordedDate([bob.id], ctx.db)).toBe("2024-06-30");
    }),
  );

  it(
    "still reaches an owner's history when every account of theirs has been closed",
    withDatabase(async (ctx) => {
      // The asymmetry `firstRecordedDate`'s docstring records: it reads
      // `position_set` through `account`, which spans closed accounts, where
      // `holding_valued` excludes them. So this owner holds nothing today and
      // has a reachable past, and the two answers disagreeing is correct.
      const alice = await ctx.seedPerson({ name: "Alice" });
      const usd = await ctx.usdInstrument();
      const closed = await ctx.seedAccount({
        name: "Closed Savings",
        owner: alice,
        kind: "bank",
        closedAt: "2026-03-01",
      });
      await ctx.seedPositionSet({
        account: closed,
        asOf: "2025-05-31",
        holdings: [{ instrument: usd, quantity: "1000.00000000" }],
      });

      expect(await currentHoldings([alice.id], ctx.db)).toEqual([]);
      expect((await netWorth([alice.id], ctx.db)).amount).toBe("0.0000");
      expect(await firstRecordedDate([alice.id], ctx.db)).toBe("2025-05-31");
    }),
  );
});

describe("the series readers narrow inside the lateral", () => {
  it(
    "keeps a date only the excluded owner recorded on, and carries the selected one forward",
    withDatabase(async (ctx) => {
      // The reproducing case, and the whole reason the predicate goes inside
      // the lateral. Bob records in January; Alice's first statement is in
      // February. Narrowed to Alice, 2026-01-31 is a date the *household* has
      // rows for and she has none — so the lateral returns nothing, the LEFT
      // join manufactures its all-null row, and the date is reported as
      // uncovered. Move the predicate to the outer WHERE and that null row
      // fails it, taking the date off the line: a chart that silently starts
      // later than it should, with nothing anywhere saying so.
      const { alice, his, vxus } = await seedTwoOwners(ctx, "2026-02-28");
      await ctx.seedPositionSet({
        account: his,
        asOf: "2026-01-31",
        holdings: [{ instrument: vxus, quantity: "40.00000000" }],
      });
      await ctx.seedDailyClose({ instrument: vxus, date: "2026-01-31", close: "60.0000" });

      const dates = ["2026-01-31", "2026-02-28", "2026-03-31"];
      const line = await netWorthSeries([alice.id], dates, ctx.db);

      expect(line.map((point) => point.date)).toEqual(dates);
      expect(line.map((point) => point.amount)).toEqual(["0.0000", "25000.0000", "25000.0000"]);
      // Zero coverage on the first, which is what says "nothing of hers was
      // recorded yet" rather than "she held nothing"; carried forward on the
      // third, because positions are constant between statements.
      expect(line.map((point) => point.coverage.total)).toEqual([0, 1, 1]);

      // And the household still sees January, so the difference above is the
      // filter and not the seed.
      expect((await netWorthSeries(ALL_OWNERS, dates, ctx.db)).map((point) => point.amount)).toEqual(
        ["2400.0000", "27400.0000", "27400.0000"],
      );
    }),
  );

  it(
    "narrows the intra-session line while leaving its instants the whole log's",
    withDatabase(async (ctx) => {
      const { alice, bob, vti, vxus } = await seedTwoOwners(ctx, "2026-02-27");

      // Two instants, and only Bob's instrument moves at the second one. The
      // instants come from the log as a whole, so Alice's line has to have a
      // point at both — flat, which is the honest answer, rather than one point.
      // The closes the helper seeded on 2026-02-27 are what price Alice's
      // holding at both instants: strictly before the session, per ADR-0006.
      await ctx.seedObservation({ instrument: vxus, asOf: "2026-02-28T14:30:00.000Z", price: "61.0000" });
      await ctx.seedObservation({ instrument: vxus, asOf: "2026-02-28T20:00:00.000Z", price: "62.0000" });

      const hers = await netWorthSessionSeries([alice.id], "2026-02-28", ctx.db);
      expect(hers.map((point) => point.amount)).toEqual(["25000.0000", "25000.0000"]);

      const his = await netWorthSessionSeries([bob.id], "2026-02-28", ctx.db);
      expect(his.map((point) => point.amount)).toEqual(["2440.0000", "2480.0000"]);

      const household = await netWorthSessionSeries(ALL_OWNERS, "2026-02-28", ctx.db);
      expect(household.map((point) => point.amount)).toEqual(["27440.0000", "27480.0000"]);
    }),
  );
});

describe("an id that cannot name an owner", () => {
  it(
    "narrows to nothing rather than widening back to the household",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx, "2026-02-28");

      expect(await currentHoldings([NOBODY], ctx.db)).toEqual([]);
      expect((await netWorth([NOBODY], ctx.db)).amount).toBe("0.0000");
      expect(await accountTotals([NOBODY], ctx.db)).toEqual([]);
      expect(await firstRecordedDate([NOBODY], ctx.db)).toBeNull();

      // Beside a real one it contributes nothing, rather than poisoning the
      // whole predicate — the selection is still Alice's.
      expect((await netWorth([alice.id, NOBODY], ctx.db)).amount).toBe("25000.0000");
    }),
  );

  it(
    "answers empty for an id far past bigint, where it used to error inside Postgres",
    withDatabase(async (ctx) => {
      await seedTwoOwners(ctx, "2026-02-28");

      expect(await currentHoldings([TOO_LONG], ctx.db)).toEqual([]);
      expect((await netWorth([TOO_LONG], ctx.db)).amount).toBe("0.0000");
      expect(await accountTotals([TOO_LONG], ctx.db)).toEqual([]);
      expect(await firstRecordedDate([TOO_LONG], ctx.db)).toBeNull();
      expect(await netWorthSeries([TOO_LONG], ["2026-02-28"], ctx.db)).toEqual([
        { date: "2026-02-28", amount: "0.0000", coverage: { known: 0, total: 0 } },
      ]);
    }),
  );

  it(
    "answers empty for an id that is not digits at all",
    withDatabase(async (ctx) => {
      await seedTwoOwners(ctx, "2026-02-28");

      expect(await currentHoldings(["alice"], ctx.db)).toEqual([]);
      expect((await netWorthChange(["alice"], "2026-02-01", ctx.db)).difference).toBe("0.0000");
    }),
  );
});
