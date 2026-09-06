/**
 * What one tick does with the connection it borrows (prices are refresh-quotes.test.ts's job).
 * What lives only here is the Postgres session holding pg_try_advisory_lock: a tick that fails
 * halfway and returns its connection intact poisons the pool, silently freezing prices for the
 * process's life (§11's worst failure — healthz.ts can't see it). Driven through startPricePoller
 * with a faked interval and a fake provider, against the real pool, patched to report handbacks.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

import { createDatabase, withDb } from "~/lib/db.server";
import { requestRefresh, startPricePoller, stopPricePoller } from "~/lib/price-poller.server";
import { createPool } from "../server/db.ts";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "./support/database.ts";

import type pg from "pg";
import type { PriceProvider } from "~/lib/price-provider.server";

// getConfig() memoises its first read — set before any test runs, as the container does before serving
process.env.DATABASE_URL = TEST_DATABASE_URL;

// refused immediately — how "the database went away" arrives here
const UNREACHABLE_DATABASE_URL = "postgres://portfolio:portfolio@127.0.0.1:1/portfolio_test";

// seeded refresh cadence the timer is first armed with; no tick re-arms it
const INTERVAL_MS = 15 * 60 * 1000;

// a Thursday, 11:00 NY — inside the regular session, not a holiday
const TRADING_HOUR = new Date("2026-06-04T15:00:00Z");

const WEEKEND = new Date("2026-06-07T15:00:00Z");

afterAll(closeTestDatabase);

/** A provider that answers nothing and records having been asked. */
function fakeProvider(): PriceProvider & { asked: string[][]; askedHistory: string[] } {
  const asked: string[][] = [];
  const askedHistory: string[] = [];
  return {
    asked,
    askedHistory,
    async getQuotes(symbols) {
      asked.push([...symbols]);
      return [];
    },
    async getDailyCloses(symbol) {
      askedHistory.push(symbol);
      return { status: "no-history" };
    },
  };
}

/** A provider that fails the way a rate limit or a shape change fails. */
function brokenProvider(): PriceProvider {
  return {
    async getQuotes() {
      throw new Error("429 Too Many Requests");
    },
    async getDailyCloses(): Promise<never> {
      throw new Error("429 Too Many Requests");
    },
  };
}

type WatchedPool = {
  /** The real pool, handed to the poller in place of the process-wide one. */
  pool: pg.Pool;
  /** One entry per connection handed back: true when it was destroyed. */
  destroyed: boolean[];
  /** Resolves once `count` connections have been handed back. */
  handedBack(count: number): Promise<void>;
  close(): Promise<void>;
};

/**
 * A real pool that says when the poller gives a connection back, and how. Patched, not
 * replaced by a stand-in: the lock is a real advisory lock on a real session (the whole
 * subject), and idleCount/totalCount are then the pool's own accounting. Handing a connection
 * back is the last thing a tick does that this file can see — the signal to wait on instead of a sleep.
 */
function watchedPool(): WatchedPool {
  const pool = createPool(TEST_DATABASE_URL);
  const destroyed: boolean[] = [];
  const waiting: { count: number; resolve: () => void }[] = [];

  // cast past connect's callback overload, unused here
  const openConnection = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;

  pool.connect = (async () => {
    const client = await openConnection();
    const handBack = client.release.bind(client);

    client.release = (broken?: Error | boolean) => {
      handBack(broken);
      destroyed.push(broken === true);
      for (const waiter of waiting.splice(0)) {
        if (destroyed.length >= waiter.count) waiter.resolve();
        else waiting.push(waiter);
      }
    };

    return client;
  }) as typeof pool.connect;

  return {
    pool,
    destroyed,
    handedBack: (count) =>
      destroyed.length >= count
        ? Promise.resolve()
        : new Promise((resolve) => waiting.push({ count, resolve })),
    close: () => pool.end(),
  };
}

// handedBack alone stopped meaning "tick done" once withRefreshLock releases the connection in
// its own finally, before its promise resolves — the tick's log lines land a few resolutions
// later. Nothing between does I/O, so one macrotask turn drains them (a sleep would be guessing).
const tickFinished = () => new Promise<void>((resolve) => setImmediate(resolve));

// only setInterval/clearInterval/Date are faked; pg times real connects with setTimeout. Runs
// up to the tick's first await inside advanceTimersByTime, then returns with ticks started —
// caller waits on the pool, since a weekend tick still spends a connection on the backfill batch.
// Poller is stopped before real timers return, so no test leaves a timer behind.
function runTicks(
  provider: PriceProvider,
  { at = TRADING_HOUR, ticks = 1 }: { at?: Date; ticks?: number } = {},
): void {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: at });
  try {
    startPricePoller(provider);
    vi.advanceTimersByTime(ticks * INTERVAL_MS);
  } finally {
    stopPricePoller();
    vi.useRealTimers();
  }
}

describe("the connection a tick borrows", () => {
  it("is destroyed when the refresh throws, rather than returned to the pool still holding the lock", async () => {
    const watched = watchedPool();
    // pool is fine, refresh is what breaks — a briefly unreachable database is the ordinary case
    const unreachable = createDatabase(UNREACHABLE_DATABASE_URL);

    try {
      await withDb(
        unreachable,
        async () => {
          runTicks(fakeProvider());
          await watched.handedBack(1);
        },
        watched.pool,
      );

      expect(watched.destroyed).toEqual([true]);
      // pool's own account: nothing left to hand out, so no later tick gets a session with unknown lock state
      expect(watched.pool.totalCount).toBe(0);
      expect(watched.pool.idleCount).toBe(0);
    } finally {
      await unreachable.destroy();
      await watched.close();
    }
  });

  it(
    "is handed back intact when it was the provider that failed, since a third-party outage is not a broken session",
    withDatabase(async ({ db, seedInstrument }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const watched = watchedPool();

      try {
        await withDb(
          db,
          async () => {
            runTicks(brokenProvider());
            await watched.handedBack(1);
          },
          watched.pool,
        );

        // counterpart to the test above — destroying on every failure would force a fresh connect every tick during an outage
        expect(watched.destroyed).toEqual([false]);
        expect(watched.pool.idleCount).toBe(1);
      } finally {
        await watched.close();
      }
    }),
  );

  it(
    "is spent outside market hours on the backfill, but no quote is asked for and no poll recorded",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      // held from a date the spine doesn't reach — makes this a backfill candidate, or a weekend
      // tick can't be told apart from one that skipped the batch entirely
      const account = await seedAccount();
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedPositionSet({
        account,
        asOf: "2024-03-29",
        holdings: [{ instrument, quantity: "1.00000000" }],
      });

      const watched = watchedPool();
      const provider = fakeProvider();

      try {
        // calendar used to keep the tick off the db all weekend; now it only gates quotes
        // (ADR-0011) — a weekend tick still spends a connection on the cadence read and gap query
        await withDb(
          db,
          async () => {
            runTicks(provider, { at: WEEKEND });
            await watched.handedBack(1);
          },
          watched.pool,
        );

        expect(provider.asked).toEqual([]);
        expect(provider.askedHistory).toEqual(["VTI"]);
        expect(watched.destroyed).toEqual([false]);

        // a poll is an attempt at quotes, and this tick attempted none
        expect(await db.selectFrom("price_poll").selectAll().execute()).toEqual([]);
      } finally {
        await watched.close();
      }
    }),
  );
});

describe("a cadence the household moved", () => {
  it(
    "re-arms the timer at the next tick, so a save needs no restart",
    withDatabase(async ({ db, seedInstrument }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      // boot case: timer arms at seeded 15 while the row already says 60; mid-run save is the same mechanism
      await db.updateTable("app_setting").set({ refresh_cadence_minutes: 60 }).execute();

      const watched = watchedPool();
      const provider = fakeProvider();

      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: TRADING_HOUR });
      try {
        await withDb(
          db,
          async () => {
            startPricePoller(provider);

            vi.advanceTimersByTime(INTERVAL_MS);
            await watched.handedBack(1);

            // tick read 60 and re-armed; 15 more minutes must fire nothing (what the old timer
            // would've done) — grace period, not a fake advance, since a fire reaches the pool via real IO
            vi.advanceTimersByTime(INTERVAL_MS);
            const early = await Promise.race([
              watched.handedBack(2).then(() => "ticked" as const),
              new Promise<"quiet">((resolve) => setTimeout(() => resolve("quiet"), 300)),
            ]);
            expect(early).toBe("quiet");

            // completing the hour fires the re-armed timer
            vi.advanceTimersByTime(45 * 60 * 1000);
            await watched.handedBack(2);
          },
          watched.pool,
        );

        expect(provider.asked).toHaveLength(2);
        expect(watched.destroyed).toEqual([false, false]);
      } finally {
        stopPricePoller();
        vi.useRealTimers();
        await watched.close();
      }
    }),
  );
});

describe("a tick that arrives while one is still running", () => {
  it(
    "is dropped rather than queued, so a slow provider cannot stack requests",
    withDatabase(async ({ db, seedInstrument }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const watched = watchedPool();
      const provider = fakeProvider();

      try {
        await withDb(
          db,
          async () => {
            runTicks(provider, { ticks: 2 });
            await watched.handedBack(1);
          },
          watched.pool,
        );

        // next tick is along shortly at this cadence — a queue of pending fetches is how an instance gets rate-limited
        expect(provider.asked).toHaveLength(1);
        expect(watched.destroyed).toEqual([false]);
      } finally {
        await watched.close();
      }
    }),
  );
});

describe("a refresh an upload asks for", () => {
  it(
    "runs quotes regardless of the calendar, unlike the tick's own schedule",
    withDatabase(async ({ db, seedInstrument }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const watched = watchedPool();
      const provider = fakeProvider();

      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: WEEKEND });
      try {
        await withDb(
          db,
          async () => {
            startPricePoller(provider);

            // uploader is implicitly asking for a quote — shouldn't wait until Monday for a first price
            requestRefresh();
            await watched.handedBack(1);
          },
          watched.pool,
        );

        expect(provider.asked).toEqual([["VTI"]]);
        expect(watched.destroyed).toEqual([false]);
      } finally {
        stopPricePoller();
        vi.useRealTimers();
        await watched.close();
      }
    }),
  );

  it(
    "is dropped while a tick is running, rather than queued behind it",
    withDatabase(async ({ db, seedInstrument }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const watched = watchedPool();
      const provider = fakeProvider();

      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: TRADING_HOUR });
      try {
        await withDb(
          db,
          async () => {
            startPricePoller(provider);

            // tick started, not finished — request lands on the same `running` flag an overlapping tick would
            vi.advanceTimersByTime(INTERVAL_MS);
            requestRefresh();

            await watched.handedBack(1);
          },
          watched.pool,
        );

        expect(provider.asked).toHaveLength(1);
      } finally {
        stopPricePoller();
        vi.useRealTimers();
        await watched.close();
      }
    }),
  );

  it(
    "reaches no provider when the poller was never started, and is not replayed when it is",
    withDatabase(async ({ db, seedInstrument }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const watched = watchedPool();
      const provider = fakeProvider();

      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: TRADING_HOUR });
      try {
        await withDb(
          db,
          async () => {
            // action runs before its own request's loaders, so the poller (started by
            // root.tsx's loader) may not exist yet; dropped, not queued or replayed
            requestRefresh();

            startPricePoller(provider);

            // long enough for a replayed request to have shown up
            await new Promise((resolve) => setTimeout(resolve, 50));
          },
          watched.pool,
        );

        expect(provider.asked).toEqual([]);
        expect(provider.askedHistory).toEqual([]);
        expect(watched.pool.totalCount).toBe(0);
      } finally {
        stopPricePoller();
        vi.useRealTimers();
        await watched.close();
      }
    }),
  );
});

describe("what the batch writes to the log", () => {
  // every line the tick wrote, whatever level it chose
  function capturedConsole() {
    const lines: string[] = [];
    const restore = (["info", "warn"] as const).map((level) => {
      const was = console[level];
      console[level] = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
      return () => {
        console[level] = was;
      };
    });

    return { lines, restore: () => restore.forEach((undo) => undo()) };
  }

  it(
    "says nothing when the gap query found nothing to fill",
    withDatabase(async ({ db, seedInstrument }) => {
      // no gap here — "no price line in the log" must keep meaning what docs/operating.md says
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      const watched = watchedPool();
      const provider = fakeProvider();
      const console = capturedConsole();

      try {
        await withDb(
          db,
          async () => {
            runTicks(provider, { at: WEEKEND });
            await watched.handedBack(1);
            await tickFinished();
          },
          watched.pool,
        );
      } finally {
        console.restore();
        await watched.close();
      }

      expect(console.lines.filter((line) => line.startsWith("Price backfill"))).toEqual([]);
    }),
  );

  it(
    "counts what it attempted when there was something to fill",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedPositionSet({
        account,
        asOf: "2024-03-29",
        holdings: [{ instrument, quantity: "1.00000000" }],
      });

      const watched = watchedPool();
      const provider = fakeProvider();
      const console = capturedConsole();

      try {
        await withDb(
          db,
          async () => {
            runTicks(provider, { at: WEEKEND });
            await watched.handedBack(1);
            await tickFinished();
          },
          watched.pool,
        );
      } finally {
        console.restore();
        await watched.close();
      }

      expect(console.lines.filter((line) => line.startsWith("Price backfill"))).toEqual([
        // fake answers no-history: an answer isn't a failure, the ledger names the reason
        "Price backfill: 1 attempted, 0 closes written, 0 failed.",
      ]);
    }),
  );
});
