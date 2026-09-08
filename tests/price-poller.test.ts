/**
 * Connection lifecycle for one tick (prices are refresh-quotes.test.ts's job). A tick that fails
 * mid-lock and returns its connection intact poisons the pool — silent, permanent (§11; healthz
 * can't see it). Fake interval + fake provider, real pool patched to report handbacks.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

import { createDatabase, withDb } from "~/lib/db.server";
import {
  readPollerSnapshot,
  requestRefresh,
  startPricePoller,
  stopPricePoller,
} from "~/lib/price-poller.server";
import * as providerSocketModule from "~/lib/provider-socket.server";
import { createPool } from "../server/db.ts";

import { action as refreshAction } from "../app/routes/refresh.ts";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "./support/database.ts";
import { args, post } from "./support/routes.ts";

import type { Kysely, KyselyPlugin } from "kysely";
import type pg from "pg";
import type { Database } from "~/lib/db.server";
import type { PriceProvider, ProviderQuote } from "~/lib/price-provider.server";

// getConfig() memoises its first read — set before any test runs, as the container does before serving
process.env.DATABASE_URL = TEST_DATABASE_URL;

// refused immediately — how "the database went away" arrives here
const UNREACHABLE_DATABASE_URL = "postgres://portfolio:portfolio@127.0.0.1:1/portfolio_test";

// seeded refresh cadence the timer is first armed with; no tick re-arms it
const INTERVAL_MS = 15 * 60 * 1000;

// a Thursday, 11:00 NY — inside the regular session, not a holiday
const TRADING_HOUR = new Date("2026-06-04T15:00:00Z");

const WEEKEND = new Date("2026-06-07T15:00:00Z");

// withRefreshLock's own key (refresh.test.ts's own copy, kept in step by hand) — taken from a
// second real session, so a test holds the lock exactly as a second tab or a racing tick would.
const REFRESH_ADVISORY_LOCK_KEY = "7295380114023642";

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
  handedBack(count: number): Promise<void>;
  close(): Promise<void>;
};

/**
 * Real pool, patched not replaced: the lock is a real advisory lock on a real session, so
 * idleCount/totalCount stay the pool's own accounting. Handback is the last observable step of a
 * tick — wait on it, not a sleep.
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

// handedBack fires before the tick's log line resolves (finally releases early); one macrotask
// (setImmediate) drains the rest — a sleep would be guessing.
const tickFinished = () => new Promise<void>((resolve) => setImmediate(resolve));

// Only setInterval/clearInterval/Date faked — pg's connect timeout uses a real setTimeout.
// advanceTimersByTime returns once ticks have started; caller then waits on the pool.
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
      // nothing left to hand out — no later tick gets a session with unknown lock state
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

        // destroying on every failure would force a fresh connect every tick during an outage
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
      // held from a date the spine doesn't reach — makes this a backfill candidate
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
        // calendar only gates quotes now (ADR-0011) — weekend tick still spends a connection
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

            // tick read 60 and re-armed; 15 more minutes must fire nothing. Real setTimeout race,
            // not a fake advance — a fire reaches the pool via real IO.
            vi.advanceTimersByTime(INTERVAL_MS);
            const early = await Promise.race([
              watched.handedBack(2).then(() => "ticked" as const),
              new Promise<"quiet">((resolve) => setTimeout(() => resolve("quiet"), 300)),
            ]);
            expect(early).toBe("quiet");

            // 45 more minutes completes the re-armed 60-minute cadence
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

            // request lands on the same `running` flag an overlapping tick would
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
            // action runs before its own request's loaders, so the poller may not exist yet
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

// A provider whose getQuotes never resolves on its own — the running-guard test's own control.
// `entered` settles the instant getQuotes() is actually called, so a caller can wait past the
// cadence read and lock acquisition that precede it rather than guessing at a sleep long enough to
// outlast them: too short and resolveQuotes() below fires before a resolver exists to receive it,
// leaving the tick — and the poller's own timer — hanging for good.
function controllableProvider(): {
  provider: PriceProvider;
  entered: Promise<void>;
  resolveQuotes: (quotes: ProviderQuote[]) => void;
} {
  let release: ((quotes: ProviderQuote[]) => void) | undefined;
  let markEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  return {
    provider: {
      getQuotes: () => {
        markEntered?.();
        return new Promise<ProviderQuote[]>((resolve) => {
          release = resolve;
        });
      },
      async getDailyCloses() {
        return { status: "no-history" };
      },
    },
    entered,
    resolveQuotes: (quotes) => release?.(quotes),
  };
}

// plugin, not a Proxy (breaks on private fields); throws in JS so it aborts the transaction —
// copied from price-backfill.test.ts's own helper, trimmed to the one shape needed here (always
// refuses, rather than letting the first `after` attempts through).
function refusingInsertInto(db: Kysely<Database>, table: string): Kysely<Database> {
  const plugin: KyselyPlugin = {
    transformQuery({ node }) {
      if (
        node.kind === "InsertQueryNode" &&
        "into" in node &&
        node.into?.table.identifier.name === table
      ) {
        throw new Error(`the database refused an insert into ${table}`);
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };

  return db.withPlugin(plugin);
}

/**
 * Bounded polling for a condition driven by a fire-and-forget tick (`requestRefresh`, or a
 * fake-timer-fired scheduled tick once real timers are restored) — there is no connection-handback
 * signal to await here, unlike `tickFinished` above, since these tests read the snapshot itself
 * rather than pool state.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was never met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// The tests above fake Date (and, where a scheduled tick must fire, setInterval too) to control the
// market-hours decision, matching this file's existing convention. The tests below that don't need
// to control wall-clock time run on real timers instead — `pricingHealth`'s own `now`-as-parameter
// cases are pure and live in tests/price-health.test.ts, with no clock to fake at all.
describe("the healthz snapshot the poller slot now carries (spec price-health/03)", () => {
  it(
    "stamps the phase overdue is measured from on every tick, not only when the timer is armed",
    withDatabase(async () => {
      // The one field `scheduler` is computed against, and until this test nothing read it off the
      // real slot — deleting the stamp in `tick` left the whole suite green. A tick that runs
      // without moving it leaves a healthy poller reporting `overdue` one grace period after it
      // armed, on the endpoint the slice exists for.
      const armedAt = new Date("2026-09-08T14:00:00Z");
      vi.useFakeTimers({ toFake: ["Date"], now: armedAt });

      try {
        startPricePoller(fakeProvider());
        expect(readPollerSnapshot()?.lastTickStartedAt).toEqual(armedAt);

        const tickAt = new Date(armedAt.getTime() + 60_000);
        vi.setSystemTime(tickAt);

        // The stamp is taken synchronously at the top of `tick`, before its first await, so it is
        // already observable here — no polling under a frozen clock, whose `Date.now()` would leave
        // `waitFor`'s own deadline unreachable and turn a failure into a hang.
        requestRefresh();
        expect(readPollerSnapshot()?.lastTickStartedAt).toEqual(tickAt);

        // Real timers back before waiting on anything, then drain the tick this test set going
        // rather than leaving it running against a transaction about to roll back.
        vi.useRealTimers();
        await waitFor(() => readPollerSnapshot()?.running === false);
      } finally {
        stopPricePoller();
        vi.useRealTimers();
      }
    }),
  );

  it("makes the next read not_started once stopped", () => {
    startPricePoller(fakeProvider());
    expect(readPollerSnapshot()).not.toBeUndefined();

    stopPricePoller();
    expect(readPollerSnapshot()).toBeUndefined();
  });

  it(
    "is updated by requestRefresh but left alone by a direct POST /refresh, which calls runRefresh on its own",
    withDatabase(async () => {
      expect(readPollerSnapshot()).toBeUndefined();

      // app/routes/refresh.ts's action calls runRefresh directly — it never imports price-poller.server.ts.
      await refreshAction(args(post("/refresh", {})));
      expect(readPollerSnapshot()).toBeUndefined();

      try {
        startPricePoller(fakeProvider());
        requestRefresh();
        await waitFor(() => readPollerSnapshot()?.lastObservation !== undefined);

        expect(readPollerSnapshot()?.lastObservation).toEqual({
          outcome: "quoted",
          requested: 0,
          priced: 0,
          providerFailed: false,
        });
      } finally {
        stopPricePoller();
      }
    }),
  );

  it(
    "changes neither running nor the previous observation when a tick is dropped by the running guard",
    withDatabase(async ({ seedInstrument }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const { provider, entered, resolveQuotes } = controllableProvider();

      try {
        startPricePoller(provider);
        requestRefresh();
        await waitFor(() => readPollerSnapshot()?.running === true);
        expect(readPollerSnapshot()?.lastObservation).toBeUndefined();

        // Only once getQuotes() has actually been called is a resolver in place to receive
        // resolveQuotes() below — waiting on `running` alone races the cadence read and lock
        // acquisition that still separate it from this point.
        await entered;

        // Dropped: `state.running` is already true, so this returns before touching anything.
        requestRefresh();
        expect(readPollerSnapshot()?.running).toBe(true);
        expect(readPollerSnapshot()?.lastObservation).toBeUndefined();

        resolveQuotes([]);
        await waitFor(() => readPollerSnapshot()?.lastObservation !== undefined);

        expect(readPollerSnapshot()?.running).toBe(false);
        expect(readPollerSnapshot()?.lastObservation).toEqual({
          outcome: "quoted",
          requested: 1,
          priced: 0,
          providerFailed: false,
        });
      } finally {
        stopPricePoller();
      }
    }),
  );

  it(
    "leaves the previous observation intact when a later tick finds the advisory lock held",
    withDatabase(async ({ seedInstrument }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const lockPool = createPool(TEST_DATABASE_URL);
      const holder = await lockPool.connect();

      try {
        startPricePoller(fakeProvider());
        requestRefresh();
        await waitFor(() => readPollerSnapshot()?.lastObservation !== undefined);

        const settled = readPollerSnapshot()?.lastObservation;
        expect(settled).toEqual({
          outcome: "quoted",
          requested: 1,
          priced: 0,
          providerFailed: false,
        });

        await holder.query(`select pg_advisory_lock(${REFRESH_ADVISORY_LOCK_KEY})`);
        try {
          requestRefresh();
          // Wait for the busy tick to return — state.running flips true synchronously inside
          // requestRefresh's own call to tick(), then back to false once the attempt finds the
          // lock held and gives up — all while `holder` still has it. Releasing on a blind sleep
          // instead risks the unlock landing before the attempt: the tick would then acquire the
          // lock itself and run an ordinary refresh, which happens to leave the same observation
          // behind and could pass without ever exercising the busy path this test is named for.
          await waitFor(() => readPollerSnapshot()?.running === false);
        } finally {
          await holder.query(`select pg_advisory_unlock(${REFRESH_ADVISORY_LOCK_KEY})`);
        }

        expect(readPollerSnapshot()?.running).toBe(false);
        expect(readPollerSnapshot()?.lastObservation).toEqual(settled);
      } finally {
        stopPricePoller();
        holder.release();
        await lockPool.end();
      }
    }),
  );

  it(
    "still reports market_closed for a weekend tick whose backfill batch then fails against the database",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      // held from a date the spine doesn't reach — makes this a backfill candidate, as in
      // "the connection a tick borrows" above
      const account = await seedAccount();
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedPositionSet({
        account,
        asOf: "2024-03-29",
        holdings: [{ instrument, quantity: "1.00000000" }],
      });

      const provider: PriceProvider = {
        async getQuotes() {
          return [];
        },
        async getDailyCloses() {
          return { status: "ok", closes: [{ date: "2024-03-25", close: "10.0000" }] };
        },
      };

      try {
        await withDb(refusingInsertInto(db, "price_backfill"), async () => {
          vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: WEEKEND });
          try {
            startPricePoller(provider);
            vi.advanceTimersByTime(INTERVAL_MS);
          } finally {
            // Real timers before waiting: the market-hours decision above already read the fake
            // clock synchronously: switching now only affects timing this test doesn't assert on.
            vi.useRealTimers();
          }

          await waitFor(() => readPollerSnapshot()?.lastObservation !== undefined);
          expect(readPollerSnapshot()?.lastObservation).toEqual({ outcome: "market_closed" });
        });
      } finally {
        stopPricePoller();
      }
    }),
  );

  it(
    "still reports market_closed for a weekend tick that then finds the advisory lock held",
    withDatabase(async () => {
      const lockPool = createPool(TEST_DATABASE_URL);
      const holder = await lockPool.connect();

      try {
        await holder.query(`select pg_advisory_lock(${REFRESH_ADVISORY_LOCK_KEY})`);

        try {
          vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: WEEKEND });
          try {
            startPricePoller(fakeProvider());
            vi.advanceTimersByTime(INTERVAL_MS);
          } finally {
            vi.useRealTimers();
          }

          await waitFor(() => readPollerSnapshot()?.lastObservation !== undefined);
          expect(readPollerSnapshot()?.lastObservation).toEqual({ outcome: "market_closed" });
          expect(readPollerSnapshot()?.running).toBe(false);
        } finally {
          stopPricePoller();
        }
      } finally {
        await holder.query(`select pg_advisory_unlock(${REFRESH_ADVISORY_LOCK_KEY})`);
        holder.release();
        await lockPool.end();
      }
    }),
  );
});

describe("the default provider, when none is passed", () => {
  it(
    "is built once even when startPricePoller is called twice, since the second call is only the idempotent guard",
    () => {
      // Pins the lazy default (`provider ?? socketProvider()`, resolved inside the try): a default
      // parameter would have built one on the first call's own argument evaluation regardless of
      // this spy, and a second, unguarded build on the second call would double-count here.
      const socketProviderSpy = vi.spyOn(providerSocketModule, "socketProvider");

      try {
        startPricePoller();
        startPricePoller();

        expect(socketProviderSpy).toHaveBeenCalledTimes(1);
      } finally {
        stopPricePoller();
        socketProviderSpy.mockRestore();
      }
    },
  );

  it(
    "swallows a throw from building the default provider, logs it, and leaves the poller unarmed — the failure the lazy resolve inside the try exists to catch",
    () => {
      // Reproduces the defect this ticket fixes: were `provider ?? socketProvider()` still a default
      // parameter (evaluated before the `try`), this throw would escape `startPricePoller` — a 500 on
      // every request once a middleware is the caller, `/healthz` included, rather than the swallowed
      // failure asserted below.
      stopPricePoller();
      const buildFailure = new Error("no worker listening at /run/price-worker/worker.sock (ENOENT)");
      const socketProviderSpy = vi
        .spyOn(providerSocketModule, "socketProvider")
        .mockImplementation(() => {
          throw buildFailure;
        });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const POLLER_SLOT = Symbol.for("portfolio.pricePoller");
      const host = globalThis as unknown as Record<symbol, unknown>;

      try {
        expect(() => startPricePoller()).not.toThrow();
        expect(host[POLLER_SLOT]).toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith(
          "Price poller did not start; prices will not refresh:",
          buildFailure,
        );
      } finally {
        stopPricePoller();
        socketProviderSpy.mockRestore();
        errorSpy.mockRestore();
      }
    },
  );
});
