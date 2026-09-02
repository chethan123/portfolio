/**
 * What one tick of the refresh loop does with the connection it borrows.
 * Not about prices (`refresh-quotes.test.ts` owns those; no `quote` row is
 * asserted on): what lives only in the poller is the Postgres *session*
 * holding `pg_try_advisory_lock`, and a connection handed back keeps
 * whatever its session held. A tick that failed halfway and returned its
 * connection intact poisons the pool: a later tick is handed the lock
 * holder back, the lock answers "someone else has it", and prices stop
 * refreshing for the life of the process — no throw, no failing health
 * check (`healthz.ts` deliberately reports none of this), the screens
 * showing last week's prices as live: §11's worst available failure.
 *
 * The tick is not exported and stays so; it is driven through
 * `startPricePoller` as production drives it. The interval is faked so no
 * real timer exists and nothing waits; the provider is a hand-written fake;
 * the pool is the real one, patched only to say when it got its connection
 * back. A tick has no caller to catch it, so a throw arrives as an
 * unhandled rejection and vitest fails the run — every test below is also a
 * statement that the tick returned rather than threw.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

import { createDatabase, withDb } from "~/lib/db.server";
import { requestRefresh, startPricePoller, stopPricePoller } from "~/lib/price-poller.server";
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
 * this returns with the ticks *started* and the caller waits on the pool. A
 * tick outside market hours no longer stops there: it asks for no quotes and
 * goes on to spend a connection on the backfill batch, so every case here waits
 * on the pool rather than assuming a weekend tick returns first.
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
    "is spent outside market hours on the backfill, but no quote is asked for and no poll recorded",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      // Held from a date the spine does not reach, which is what makes this a
      // backfill candidate — an instrument nobody holds has no gap, and a
      // weekend tick would then be indistinguishable from one that skipped the
      // batch entirely.
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
        // The calendar used to keep the tick off the database all weekend. It
        // no longer can: a refresh is quotes and then one backfill batch
        // (ADR-0011), and a statement uploaded on a Saturday should be valued
        // by Monday's open rather than after it. So the calendar now decides
        // only whether *quotes* are asked for, and a weekend tick spends a
        // connection on the cadence read and the gap query.
        await withDb(
          db,
          async () => {
            runTicks(provider, { at: WEEKEND });
            await watched.handedBack(1);
          },
          watched.pool,
        );

        // No quotes, and the batch ran anyway: a statement uploaded on a
        // Saturday should be valued by Monday's open rather than after it.
        expect(provider.asked).toEqual([]);
        expect(provider.askedHistory).toEqual(["VTI"]);
        expect(watched.destroyed).toEqual([false]);

        // A poll is an attempt at quotes, and this tick attempted none.
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

            // The person who just uploaded is present, and a quote is what
            // they are implicitly asking for — a Saturday upload should not
            // have to wait until Monday for its first price.
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

            // The tick is started and has not finished; the request lands on
            // the same `running` flag an overlapping tick lands on. A queue of
            // pending fetches against an unofficial API is how an instance
            // gets rate-limited.
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
            // What an action sees in a process whose first loader has not run
            // yet: `app/root.tsx` starts the poller from a loader, and an
            // action runs before its own request's loaders. Dropped, not
            // queued — so starting the poller afterwards does not replay it,
            // and the uploaded instruments wait for the next tick.
            requestRefresh();

            startPricePoller(provider);

            // Long enough for a replayed request to have shown up.
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
  /** Every line the tick wrote, whatever level it chose. */
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
      // An instrument nobody holds has no gap. "No price line in the log"
      // has to keep meaning what `docs/operating.md` says it means, so a tick
      // at any hour that found no candidates must write no backfill line.
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
          },
          watched.pool,
        );
      } finally {
        console.restore();
        await watched.close();
      }

      expect(console.lines.filter((line) => line.startsWith("Price backfill"))).toEqual([
        // The fake answers `no-history`, so nothing was written and nothing
        // failed: an answer is not a failure, and the ledger names the reason.
        "Price backfill: 1 attempted, 0 closes written, 0 failed.",
      ]);
    }),
  );
});
