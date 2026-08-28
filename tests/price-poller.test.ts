/**
 * What one tick of the refresh loop does with the connection it borrows.
 *
 * Nothing here is about prices — `refresh-quotes.test.ts` owns those, and this
 * file asserts on no `quote` row at all. What lives only in the poller is the
 * handling of the Postgres *session* it takes to decide whether to run: that
 * session holds `pg_try_advisory_lock`, and a connection handed back to the
 * pool keeps whatever its session was holding.
 *
 * So a tick that failed halfway and returned its connection intact would poison
 * the pool: some later tick is handed the lock holder back, `pg_try_advisory_lock`
 * answers "someone else has it", and the tick returns. Prices then stop
 * refreshing for the life of the process — no throw, no failing health check
 * (`healthz.ts` deliberately reports none of this), and nothing in the log after
 * the one line that recorded the original failure. The screens go on showing
 * last week's prices as though they were live, which §11 names as the worst
 * failure available in a finance app.
 *
 * The tick is not exported and this file does not make it so; it is driven the
 * way production drives it, through `startPricePoller`. The interval is faked
 * so that no real timer is ever created and nothing here waits — for fifteen
 * minutes or at all. That is the one piece of test machinery in this file: the
 * provider is a hand-written fake as everywhere else, and the pool is the real
 * one, patched only to say when it got its connection back.
 *
 * A tick has no caller to catch it, so a throw from one would arrive as an
 * unhandled rejection, which vitest fails the run on. Every test below is
 * therefore also a statement that the tick returned rather than threw.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

import { createDatabase, withDb } from "~/lib/db.server";
import { startPricePoller, stopPricePoller } from "~/lib/price-poller.server";
import { createPool } from "../server/db.ts";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "./support/database.ts";

import type pg from "pg";
import type { PriceProvider } from "~/lib/price-provider.server";

/**
 * The poller reads its own configuration, and `getConfig()` memoises the first
 * read — so the environment is set before any test runs, exactly as the
 * container sets it before serving.
 */
process.env.DATABASE_URL = TEST_DATABASE_URL;

/** Refused immediately, which is how "the database went away" arrives here. */
const UNREACHABLE_DATABASE_URL = "postgres://portfolio:portfolio@127.0.0.1:1/portfolio_test";

/** The seeded refresh cadence the timer is first armed with, which the
 * databases these tests run against also hold — so no tick re-arms it. */
const INTERVAL_MS = 15 * 60 * 1000;

/** A Thursday, 11:00 in New York: inside the regular session, not a holiday. */
const TRADING_HOUR = new Date("2026-06-04T15:00:00Z");

/** The Sunday of the same week. */
const WEEKEND = new Date("2026-06-07T15:00:00Z");

afterAll(closeTestDatabase);

/** A provider that answers nothing and records having been asked. */
function fakeProvider(): PriceProvider & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    async getQuotes(symbols) {
      asked.push([...symbols]);
      return [];
    },
  };
}

/** A provider that fails the way a rate limit or a shape change fails. */
function brokenProvider(): PriceProvider {
  return {
    async getQuotes() {
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
 * A real pool that says when the poller gives a connection back, and how.
 *
 * Patched rather than replaced by a stand-in, for two reasons. The lock the
 * tick takes is a real advisory lock on a real session, which is the whole
 * subject; and `idleCount` / `totalCount` below are then the pool's own
 * accounting of what became of the connection rather than this file's opinion
 * of it. Handing a connection back is also the last thing a tick does, which
 * makes it the signal a test waits on instead of a sleep.
 */
function watchedPool(): WatchedPool {
  const pool = createPool(TEST_DATABASE_URL);
  const destroyed: boolean[] = [];
  const waiting: { count: number; resolve: () => void }[] = [];

  // Cast past the callback overload of `connect`, which nothing here uses.
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

/**
 * Fire the poller's interval `ticks` times, at an instant it believes is `at`.
 *
 * Only `setInterval`, `clearInterval` and `Date` are faked: the connection this
 * drives is a real one, and `pg` times its connect attempts with `setTimeout`.
 * Everything up to the tick's first `await` — including the market-hours check,
 * which is why `Date` is faked at all — runs inside `advanceTimersByTime`, so
 * this returns with the ticks *started* and the caller waits on the pool.
 *
 * The poller is stopped before the real timers come back, so the handle being
 * cleared is the handle that was created and no test can leave a timer behind.
 */
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
    // The pool is fine and the refresh is what breaks: a database that is
    // briefly unreachable is the ordinary case the module plans for.
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
      // The pool's own account of it: nothing left to hand out, so no later
      // tick can be given the session whose lock state is unknown.
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

        // The counterpart to the test above, and what makes it mean anything:
        // destroying the connection on every failure would cost a fresh
        // connect on every tick for the duration of a Yahoo outage.
        expect(watched.destroyed).toEqual([false]);
        expect(watched.pool.idleCount).toBe(1);
      } finally {
        await watched.close();
      }
    }),
  );

  it(
    "is not spent at all outside market hours",
    withDatabase(async ({ db }) => {
      const watched = watchedPool();
      const provider = fakeProvider();

      try {
        // The calendar decides only whether to spend a request; getting it
        // wrong cannot corrupt anything. What it must not do is reach the
        // database and the network every quarter of an hour all weekend.
        await withDb(db, async () => runTicks(provider, { at: WEEKEND }), watched.pool);

        expect(provider.asked).toEqual([]);
        expect(watched.pool.totalCount).toBe(0);
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
      // Saved before the poller ever starts: the boot case, where the timer is
      // armed at the seeded 15 and the row already says otherwise. The mid-run
      // save is the same mechanism — every tick reads the row.
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

            // That tick read 60 and re-armed. Fifteen more minutes must now
            // fire nothing — a second refresh here is exactly what the old
            // timer would have done. Absence is asserted with a real-time
            // grace period rather than a fake advance, because a fire would
            // reach the pool by real IO; the grace only ever falsely passes,
            // never falsely fails.
            vi.advanceTimersByTime(INTERVAL_MS);
            const early = await Promise.race([
              watched.handedBack(2).then(() => "ticked" as const),
              new Promise<"quiet">((resolve) => setTimeout(() => resolve("quiet"), 300)),
            ]);
            expect(early).toBe("quiet");

            // Completing the hour fires the re-armed timer.
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

        // At a fifteen-minute cadence the next tick is along shortly; a queue
        // of pending fetches against an unofficial API is how an instance gets
        // rate-limited.
        expect(provider.asked).toHaveLength(1);
        expect(watched.destroyed).toEqual([false]);
      } finally {
        await watched.close();
      }
    }),
  );
});
