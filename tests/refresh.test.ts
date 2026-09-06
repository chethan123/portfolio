/**
 * runRefresh's own answer, apart from what it wraps: the lock (busy), the database or lock itself
 * (error), and a fake provider's counts (done) — `error` is never what a provider throw becomes
 * (refreshQuotes catches that itself). runRefresh reads through getDb()/getPool() rather than
 * taking either as a parameter, so a test scopes both through withDb: `db` is withDatabase's
 * rolled-back transaction, `pool` is a real connection for the advisory lock withRefreshLock takes.
 */
import { afterAll, describe, expect, it } from "vitest";

import { withDb } from "~/lib/db.server";
import { outcomeOf, runRefresh } from "~/lib/refresh.server";
import { createPool } from "../server/db.ts";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "./support/database.ts";

import type { PriceProvider, ProviderQuote } from "~/lib/price-provider.server";

// getConfig() memoises its first read — set before any test runs
process.env.DATABASE_URL = TEST_DATABASE_URL;

// refused immediately — how "the database went away" arrives here
const UNREACHABLE_DATABASE_URL = "postgres://portfolio:portfolio@127.0.0.1:1/portfolio_test";

// withRefreshLock's own key, which must never change — taken from a second real session, so the
// test holds the lock exactly as a second tab or racing tick would
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

/** The instant every fake quote is struck at, so a seeded observation can collide with it. */
const QUOTED_AT = new Date("2026-06-05T20:00:00Z");

const quote = (symbol: string): ProviderQuote => ({
  symbol,
  price: "100.0000",
  quoteType: "ETF",
  yieldPct: null,
  annualDividendPerShare: null,
  asOf: QUOTED_AT,
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
    withDatabase(async ({ db, seedInstrument, seedObservation }) => {
      // 5 instruments, 3 quoted, 2 already observed: requested 5, priced 3, stale 2, observed 1.
      // Every count a different number — with any two equal, a crossed projection would read correctly.
      const quoted = [
        await seedInstrument({ symbol: "VTI", priceSource: "feed" }),
        await seedInstrument({ symbol: "VXUS", priceSource: "feed" }),
        await seedInstrument({ symbol: "BND", priceSource: "feed" }),
      ];
      await seedInstrument({ symbol: "VNQ", priceSource: "feed" });
      await seedInstrument({ symbol: "VTV", priceSource: "feed" });

      for (const instrument of quoted.slice(0, 2)) {
        await seedObservation({ instrument, asOf: QUOTED_AT, price: "100.0000" });
      }

      const pool = createPool(TEST_DATABASE_URL);

      try {
        const outcome = await withDb(
          db,
          async () =>
            outcomeOf(
              await runRefresh(
                { quotes: true },
                fakeProvider(quoted.map((instrument) => quote(instrument.symbol!))),
              ),
            ),
          pool,
        );

        expect(outcome).toEqual({
          status: "done",
          requested: 5,
          priced: 3,
          stale: 2,
          observed: 1,
          providerFailed: false,
        });
      } finally {
        await pool.end();
      }
    }),
  );

  it(
    "projects a provider failure as a done outcome that says so",
    withDatabase(async ({ db, seedInstrument }) => {
      // other half of the projection: providerFailed is the one field no count can stand in for
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const pool = createPool(TEST_DATABASE_URL);

      try {
        const outcome = await withDb(
          db,
          async () => outcomeOf(await runRefresh({ quotes: true }, brokenQuotesProvider())),
          pool,
        );

        expect(outcome).toEqual({
          status: "done",
          requested: 1,
          priced: 0,
          stale: 1,
          observed: 0,
          providerFailed: true,
        });
      } finally {
        await pool.end();
      }
    }),
  );

  it(
    "answers done with providerFailed, not error, when the provider itself throws",
    withDatabase(async ({ db, seedInstrument }) => {
      // refreshQuotes catches this and marks every selected instrument stale — no provider fault reaches runRefresh's own catch
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
        // passed through untouched — no report to project; the control renders "someone else is refreshing" from this alone
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
      // not the provider, not a candidate's history call — the very connection withRefreshLock opens to take the lock
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
