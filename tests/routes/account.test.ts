/**
 * The account drill-down's three guards (DESIGN.md §13).
 *
 * Every figure on this page comes out of `valuation.server.ts` and
 * `uploads.server.ts` already tested; what is only here is what the route does
 * with the *URL* — the id in the path and the two receipt parameters hung off
 * it. All three are reachable by hand, by a stale bookmark, or by a crawler,
 * and each has a way of failing that leaves no mark on the screen.
 *
 * The gate first: `accountTotal` answers null for an id naming no account, for
 * one that is not an id at all, and for a closed account. All three have to be
 * a 404, because a closed account is excluded from `holding_valued` and would
 * otherwise render as a header of blanks with nothing anywhere saying why.
 *
 * Then the receipts, which are the reason this file matters more than its size
 * suggests. `?uploaded=` and `?recorded=` say *which* set or date was written
 * and nothing about what is in it, and the confirmation beside them is read
 * back out of the database. Only the route enforces that. A receipt that
 * believed its own URL would tell someone their statement had been recorded
 * when nothing had been written at all — a false confirmation on the one screen
 * whose job is to confirm, and one that leaves no trace to find later.
 */
import { afterAll, describe, expect, it } from "vitest";

import { loader } from "../../app/routes/account.tsx";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { args, get, responseOf } from "../support/routes.ts";

import type { TestContext } from "../support/database.ts";

afterAll(closeTestDatabase);

/** Today in UTC, the way the route computes the end of its window. */
const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * An account with two statements behind it — a January one and the February
 * one that superseded it, so "the set the account is reading" is a fact with a
 * wrong answer available.
 */
async function seedTwoStatements(
  ctx: Pick<
    TestContext,
    "seedPerson" | "seedAccount" | "seedInstrument" | "seedPositionSet" | "seedQuote"
  >,
) {
  const owner = await ctx.seedPerson({ name: "Alice" });
  const account = await ctx.seedAccount({ name: "Fidelity Taxable", owner, kind: "brokerage" });

  const vti = await ctx.seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
  const vxus = await ctx.seedInstrument({ symbol: "VXUS", name: "Vanguard Total International" });
  await ctx.seedQuote({ instrument: vti, price: "250.0000" });
  await ctx.seedQuote({ instrument: vxus, price: "60.0000" });

  const january = await ctx.seedPositionSet({
    account,
    asOf: "2026-01-31",
    sourceFilename: "January.csv",
    holdings: [{ instrument: vti, quantity: "100.00000000" }],
  });
  const february = await ctx.seedPositionSet({
    account,
    asOf: "2026-02-28",
    sourceFilename: "February.csv",
    holdings: [
      { instrument: vti, quantity: "120.00000000" },
      { instrument: vxus, quantity: "50.00000000" },
    ],
  });

  return { account, january, february };
}

describe("the 404 gate", () => {
  it(
    "answers 404 for an account id that names no row and for one that is not an id at all",
    withDatabase(async () => {
      // The first is a bookmark to an instance that was reset; the second is
      // what a crawler or a truncated link produces. Neither may reach a query
      // that casts to `bigint`, where `'lookup'::bigint` is a driver error and
      // reaches the reader as a 500 rather than as "no such account".
      for (const accountId of ["999999999", "lookup"]) {
        const response = await responseOf(() =>
          loader(args(get(`/accounts/${accountId}`), { accountId })),
        );

        expect(response.status).toBe(404);
      }
    }),
  );
});

describe("the receipts", () => {
  it(
    "confirms an upload only for the set the account is actually reading",
    withDatabase(async (ctx) => {
      const { account, january, february } = await seedTwoStatements(ctx);
      const at = (search: string) =>
        loader(args(get(`/accounts/${account.id}${search}`), { accountId: account.id }));

      // The parameter the upload flow really redirects with. Every figure in
      // the sentence is counted off the stored rows, so it describes the
      // holdings printed beneath it or it does not appear.
      const real = await at(`?uploaded=${february.id}`);
      expect(real.receipt).toMatchObject({
        setId: february.id,
        asOf: "2026-02-28",
        filename: "February.csv",
        holdingCount: 2,
      });

      // Hand-typed: a set this account really owns, but not the one it is
      // reading. A receipt taken from the URL would announce that January's
      // statement had just been recorded while the page beneath it prints
      // February's — and would do the same for a set belonging to somebody
      // else's account entirely.
      expect((await at(`?uploaded=${january.id}`)).receipt).toBeNull();
      expect((await at("?uploaded=999999999")).receipt).toBeNull();
      expect((await at("?uploaded=%20or%201=1")).receipt).toBeNull();
    }),
  );

  it(
    "confirms a recorded balance only against the date the account is reading",
    withDatabase(async (ctx) => {
      const { account, february } = await seedTwoStatements(ctx);
      const at = (search: string) =>
        loader(args(get(`/accounts/${account.id}${search}`), { accountId: account.id }));

      // The redirect after `setBalance` says which date it wrote, and the
      // loader checks that against what the account now reads rather than
      // trusting it.
      expect((await at(`?recorded=${february.asOf}`)).justRecorded).toBe(true);

      // January is a date this account genuinely carries — it is simply not
      // the current one. Nothing was recorded for it just now, so nothing
      // confirms it; the same goes for a date invented outright.
      expect((await at("?recorded=2026-01-31")).justRecorded).toBe(false);
      expect((await at("?recorded=2026-07-04")).justRecorded).toBe(false);
      expect((await at("?recorded=whenever")).justRecorded).toBe(false);
    }),
  );
});

describe("the chart's range", () => {
  it(
    "falls back to the default window for a value it does not offer, rather than to an empty one",
    withDatabase(async (ctx) => {
      const owner = await ctx.seedPerson({ name: "Alice" });
      const account = await ctx.seedAccount({ name: "Checking", owner, kind: "bank" });
      const usd = await ctx.usdInstrument();

      await ctx.seedPositionSet({
        account,
        asOf: today(),
        holdings: [{ instrument: usd, quantity: "12500.00000000" }],
      });

      const at = (search: string) =>
        loader(args(get(`/accounts/${account.id}${search}`), { accountId: account.id }));

      // The window is a day count that becomes twenty-five `toISOString` calls.
      // A range key the table does not hold must resolve to a real one before
      // it gets there: an undefined day count makes every sample an invalid
      // date, which is a 500 on the whole page rather than a chart with an odd
      // span.
      const guessed = await at("?range=6m");
      const defaulted = await at("");

      expect(guessed.range).toBe("1y");
      expect(guessed.computed).toEqual(defaulted.computed);
      // And the fallback really draws: a window that silently collapsed would
      // pass a `range` assertion while leaving the reader an empty panel.
      expect(guessed.computed.at(-1)).toEqual({ date: today(), amount: "12500.0000" });
    }),
  );

  it.each(["toString", "constructor", "valueOf", "hasOwnProperty"])(
    "does not mistake %s for a range, however much it looks like a key",
    (inherited) =>
      withDatabase(async (ctx) => {
        // The gate was `requested in RANGES`, and `in` walks the prototype
        // chain — so each of these passed it, `RANGES[requested].days` read
        // `undefined`, and `sampleDates` reached `isoDate(NaN)` and threw.
        // A 500 on the account page from a query string alone.
        const { account } = await seedTwoStatements(ctx);

        const data = await loader(
          args(get(`/accounts/${account.id}?range=${inherited}`), { accountId: account.id }),
        );

        expect(data.range).toBe("1y");
      })(),
  );
});
