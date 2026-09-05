/**
 * `runRefresh`'s own answer, apart from what it wraps: the lock (`busy`), the
 * database or the lock itself (`error`), and a fake provider's counts
 * (`done`) — plus the one case that pins what `error` is *not*, since a
 * provider throwing is `refreshQuotes`'s job to catch, never `runRefresh`'s
 * (`prices.server.ts:824-830`).
 *
 * `runRefresh` reads through `getDb()`/`getPool()` rather than taking either
 * as a parameter, exactly as every real caller does, so a test scopes both
 * through `withDb`: `db` is the fixture-seeded transaction `withDatabase`
 * always rolls back, and `pool` is a real connection for the advisory lock
 * `withRefreshLock` takes on its own session — `tests/price-poller.test.ts`'s
 * precedent (its header comment, and `:105`'s `watchedPool`), needed here for
 * the same reason: `withRefreshLock` reaches the process-wide pool, which a
 * transaction is not.
 */
import { afterAll, describe, expect, it } from "vitest";

import { withDb } from "~/lib/db.server";
import { outcomeOf, runRefresh } from "~/lib/refresh.server";
import { createPool } from "../server/db.ts";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "./support/database.ts";

import type { PriceProvider, ProviderQuote } from "~/lib/price-provider.server";

/**
 * `runRefresh` reads its own configuration (`getConfig().MARKET_TIMEZONE`)
 * and `withRefreshLock` reaches the process-wide pool, so the environment is
 * set before any test runs — `tests/price-poller.test.ts:37`'s precedent:
 * `getConfig()` memoises its first read.
 */
process.env.DATABASE_URL = TEST_DATABASE_URL;

/** Refused immediately, which is how "the database went away" arrives here. */
const UNREACHABLE_DATABASE_URL = "postgres://portfolio:portfolio@127.0.0.1:1/portfolio_test";

/**
 * `withRefreshLock`'s own key (`prices.server.ts`), which its own comment
 * says must never change. Taken here from a second real session, so the test
 * holds the lock exactly as a second browser tab or a racing tick would.
 */
const REFRESH_ADVISORY_LOCK_KEY = "7295380114023642";

afterAll(closeTestDatabase);

/** A provider that answers the quotes it is handed and no history. */
function fakeProvider(quotes: ProviderQuote[] = []): PriceProvider {
  return {
    async getQuotes() {
      return quotes;
    },
    async getDailyCloses() {
      return { status: "no-history" };
    },
  };
}

/** A provider whose quotes call fails the way a rate limit or outage does. */
function brokenQuotesProvider(): PriceProvider {
  return {
    async getQuotes(): Promise<never> {
      throw new Error("429 Too Many Requests");
    },
    async getDailyCloses() {
      return { status: "no-history" };
    },
  };
}

const quote = (symbol: string): ProviderQuote => ({
  symbol,
  price: "100.0000",
  quoteType: "ETF",
  yieldPct: null,
  annualDividendPerShare: null,
  asOf: new Date("2026-06-05T20:00:00Z"),
  fetchedAt: new Date("2026-06-05T20:00:05Z"),
});

describe("a run that takes the lock", () => {
  it(
    "answers done with the quotes' counts, from a fake provider",
    withDatabase(async ({ db, seedInstrument }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const pool = createPool(TEST_DATABASE_URL);

      try {
        const run = await withDb(
          db,
          () => runRefresh({ quotes: true }, fakeProvider([quote("VTI")])),
          pool,
        );

        if (run.status !== "done") throw new Error(`expected done, got ${run.status}`);
        expect(run.report.quotes.requested).toBe(1);
        expect(run.report.quotes.priced).toBe(1);
        expect(run.report.quotes.observed).toBe(1);
      } finally {
        await pool.end();
      }
    }),
  );

  it(
    "projects a done run's quotes into the outcome the control renders",
    withDatabase(async ({ db, seedInstrument }) => {
      // The mapping the route used to hold (`app/routes/refresh.ts` before
      // this module), over a real report rather than a hand-built one: a
      // field crossed here shows the household the wrong figure, and the
      // route has no assertion of its own until [06] gives it one.
      // Two instruments and one quote, so every count in the outcome is a
      // different number: with all five equal, a projection that crossed two
      // fields would read correctly and the case would prove nothing.
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedInstrument({ symbol: "VXUS", priceSource: "feed" });
      const pool = createPool(TEST_DATABASE_URL);

      try {
        const outcome = await withDb(
          db,
          async () => outcomeOf(await runRefresh({ quotes: true }, fakeProvider([quote("VTI")]))),
          pool,
        );

        expect(outcome).toEqual({
          status: "done",
          requested: 2,
          priced: 1,
          stale: 1,
          observed: 1,
          providerFailed: false,
        });
      } finally {
        await pool.end();
      }
    }),
  );

  it(
    "answers done with providerFailed, not error, when the provider itself throws",
    withDatabase(async ({ db, seedInstrument }) => {
      // `refreshQuotes` catches this and marks every selected instrument
      // stale (`prices.server.ts:825-830`) — no provider fault ever reaches
      // `runRefresh`'s own catch, which is why the dead-worker path a future
      // slice adds reports `providerFailed` and not a failed run.
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const pool = createPool(TEST_DATABASE_URL);

      try {
        const run = await withDb(db, () => runRefresh({ quotes: true }, brokenQuotesProvider()), pool);

        if (run.status !== "done") throw new Error(`expected done, got ${run.status}`);
        expect(run.report.quotes.providerFailed).toBe(true);
        expect(run.report.quotes.stale).toBe(1);
      } finally {
        await pool.end();
      }
    }),
  );
});

describe("a run that cannot take the lock", () => {
  it(
    "answers busy while a second session holds the advisory lock",
    withDatabase(async ({ db }) => {
      const pool = createPool(TEST_DATABASE_URL);
      const holder = await pool.connect();

      try {
        await holder.query(`select pg_advisory_lock(${REFRESH_ADVISORY_LOCK_KEY})`);

        const run = await withDb(db, () => runRefresh({ quotes: true }, fakeProvider()), pool);

        expect(run).toEqual({ status: "busy" });
        // Passed through untouched: there is no report to project, and the
        // control renders "someone else is refreshing" from this alone.
        expect(outcomeOf(run)).toEqual({ status: "busy" });
      } finally {
        await holder.query(`select pg_advisory_unlock(${REFRESH_ADVISORY_LOCK_KEY})`);
        holder.release();
        await pool.end();
      }
    }),
  );
});

describe("a run where the database or the lock fails", () => {
  it(
    "answers error when the pool behind the lock cannot connect",
    withDatabase(async ({ db }) => {
      // Not the provider, and not a candidate's history call — the very
      // connection `withRefreshLock` opens to take the lock.
      const unreachable = createPool(UNREACHABLE_DATABASE_URL);

      try {
        const run = await withDb(db, () => runRefresh({ quotes: true }, fakeProvider()), unreachable);

        expect(run).toEqual({ status: "error" });
      } finally {
        await unreachable.end();
      }
    }),
  );
});
