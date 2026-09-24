/**
 * A tick that fails mid-lock and returns its connection intact poisons the pool — silent,
 * permanent (§11; healthz can't see it). Plus the tick's own rules through the built instance:
 * dropped not queued, quotes gated, cadence re-read, the /healthz snapshot, the log lines.
 */
import { afterAll, describe, expect, it } from "vitest";

import { createDatabase, withDb } from "~/lib/db.server";
import {
  createPricePoller,
  pinPricePoller,
  readPollerSnapshot,
  requestRefresh,
  startPricePoller,
  stopPricePoller,
} from "~/lib/price-poller.server";
import { runRefresh } from "~/lib/refresh.server";
import { createPool } from "../server/db.ts";

import { action as refreshAction } from "../app/routes/refresh.ts";

import {
  TEST_DATABASE_URL,
  UNREACHABLE_DATABASE_URL,
  closeTestDatabase,
  withDatabase,
} from "./support/database.ts";
import { args, post } from "./support/routes.ts";

import type { BackfillReport, RefreshReport } from "~/lib/prices.server";
import type { PriceProvider } from "~/lib/price-provider.server";
import type { RefreshRun } from "~/lib/refresh.server";

// getConfig() memoises its first read — set before any test runs, as the container does before serving
process.env.DATABASE_URL = TEST_DATABASE_URL;

// a Thursday, 11:00 NY — inside the regular session, not a holiday
const TRADING_HOUR = new Date("2026-06-04T15:00:00Z");

const WEEKEND = new Date("2026-06-07T15:00:00Z");

const A_MINUTE_LATER = new Date(TRADING_HOUR.getTime() + 60_000);

const QUOTED: RefreshReport = {
  requested: 3,
  priced: 2,
  stale: 1,
  closes: 2,
  observed: 2,
  providerFailed: true,
};

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

// local copy, as tests/masking-browser.test.ts keeps its own
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

/** Every line the instance wrote, prefixed with its level. */
function capturedLog(): { lines: string[]; log: Pick<Console, "info" | "warn" | "error"> } {
  const lines: string[] = [];
  const at =
    (level: string) =>
    (...args: unknown[]) =>
      void lines.push(`${level}: ${args.map(String).join(" ")}`);

  return { lines, log: { info: at("info"), warn: at("warn"), error: at("error") } };
}

// emptyBackfillReport's keys, restated: it is unexported (spec 0025 §7)
function backfill(overrides: Partial<BackfillReport> = {}): BackfillReport {
  return {
    attempted: 0,
    written: 0,
    outcomes: {
      filled: 0,
      nothing_to_write: 0,
      no_history: 0,
      non_usd: 0,
      split_unresolved: 0,
      provider_failed: 0,
    },
    batchFailed: false,
    ...overrides,
  };
}

function done(quotes: RefreshReport | null, backfillReport = backfill()): RefreshRun {
  return { status: "done", report: { quotes, backfill: backfillReport } };
}

/** The factory with scripted defaults; `answer` gets the refresh call's index. */
function pollerWith(
  overrides: Partial<Parameters<typeof createPricePoller>[0]> & {
    answer?: (call: number) => RefreshRun | Promise<RefreshRun>;
  } = {},
) {
  const { answer = () => done(null), ...dependencies } = overrides;
  const refreshCalls: { quotes: boolean }[] = [];
  const { lines, log } = capturedLog();

  const poller = createPricePoller({
    provider: fakeProvider(),
    clock: () => TRADING_HOUR,
    readCadence: async () => 15,
    refresh: async (options) => {
      refreshCalls.push({ ...options });
      return answer(refreshCalls.length - 1);
    },
    log,
    ...dependencies,
  });

  return { poller, refreshCalls, lines };
}

describe("the connection a tick borrows", () => {
  it("is destroyed when the refresh throws, rather than returned to the pool still holding the lock", async () => {
    const pool = createPool(TEST_DATABASE_URL);
    const releases: unknown[] = [];
    pool.on("release", (err) => {
      releases.push(err);
    });
    // pool is fine, refresh is what breaks — a briefly unreachable database is the ordinary case
    const unreachable = createDatabase(UNREACHABLE_DATABASE_URL);
    const { poller } = pollerWith({ refresh: runRefresh });

    try {
      await withDb(unreachable, () => poller.tick(), pool);

      expect(releases).toEqual([true]);
      // nothing left to hand out — no later tick gets a session with unknown lock state
      expect(pool.totalCount).toBe(0);
      expect(pool.idleCount).toBe(0);
    } finally {
      await unreachable.destroy();
      await pool.end();
    }
  });

  it(
    "is handed back intact when it was the provider that failed, since a third-party outage is not a broken session",
    withDatabase(async ({ db, seedInstrument }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const pool = createPool(TEST_DATABASE_URL);
      const releases: unknown[] = [];
      pool.on("release", (err) => {
        releases.push(err);
      });
      const { poller } = pollerWith({ provider: brokenProvider(), refresh: runRefresh });

      try {
        await withDb(db, () => poller.tick(), pool);

        // destroying on every failure would force a fresh connect every tick during an outage
        expect(releases).toEqual([false]);
        expect(pool.idleCount).toBe(1);
      } finally {
        await pool.end();
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

      const pool = createPool(TEST_DATABASE_URL);
      const releases: unknown[] = [];
      pool.on("release", (err) => {
        releases.push(err);
      });
      const provider = fakeProvider();
      const { poller } = pollerWith({ provider, clock: () => WEEKEND, refresh: runRefresh });

      try {
        // calendar only gates quotes (ADR-0011) — weekend tick still spends a connection
        await withDb(db, () => poller.tick(), pool);

        expect(provider.asked).toEqual([]);
        expect(provider.askedHistory).toEqual(["VTI"]);
        expect(releases).toEqual([false]);
        expect(await db.selectFrom("price_poll").selectAll().execute()).toEqual([]);
      } finally {
        await pool.end();
      }
    }),
  );
});

describe("a cadence the household moved", () => {
  it("re-arms the timer at the next tick and stamps the tick's instant, so a save needs no restart", async () => {
    let now = TRADING_HOUR;
    const { poller } = pollerWith({ clock: () => now, readCadence: async () => 60 });

    poller.start();
    try {
      expect(poller.snapshot().minutes).toBe(15);

      now = A_MINUTE_LATER;
      await poller.tick();

      expect(poller.snapshot().minutes).toBe(60);
      expect(poller.snapshot().lastTickStartedAt).toEqual(A_MINUTE_LATER);
    } finally {
      poller.stop();
    }
  });

  it("keeps the armed cadence when the read fails, and says so", async () => {
    const failure = new Error("connection terminated");
    const { poller, lines } = pollerWith({
      readCadence: async () => {
        throw failure;
      },
    });

    await poller.tick();

    expect(poller.snapshot().minutes).toBe(15);
    expect(lines).toEqual([
      "error: Refresh cadence could not be read; keeping the current one: Error: connection terminated",
    ]);
  });

  it("is not armed by a tick whose read lands after the poller was stopped", async () => {
    const cadence = deferred<number>();
    const { poller } = pollerWith({ readCadence: () => cadence.promise });

    poller.start();
    const tick = poller.tick();
    poller.stop();

    cadence.resolve(60);
    await tick;

    expect(poller.snapshot().minutes).toBe(15);
  });
});

describe("starting the poller", () => {
  it("arms the timer without running a tick, so a crash-looping container never fetches on boot", () => {
    let now = TRADING_HOUR;
    const { poller, refreshCalls } = pollerWith({ clock: () => now });

    now = A_MINUTE_LATER;
    poller.start();
    try {
      expect(refreshCalls).toEqual([]);
      expect(poller.snapshot().lastTickStartedAt).toEqual(A_MINUTE_LATER);
    } finally {
      poller.stop();
    }
  });

  it("leaves no referenced timer behind, so the interval cannot hold a container open through shutdown", () => {
    const timeouts = () =>
      process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
    const { poller } = pollerWith();

    const before = timeouts();
    poller.start();
    try {
      expect(timeouts()).toBe(before);
    } finally {
      poller.stop();
    }
  });
});

describe("a tick that arrives while one is still running", () => {
  it("is dropped rather than queued, whether scheduled or requested, so a slow provider cannot stack requests", async () => {
    const first = deferred<RefreshRun>();
    const entered = deferred<void>();
    const { poller, refreshCalls } = pollerWith({
      answer: (call) => {
        if (call > 0) return done(null);
        entered.resolve();
        return first.promise;
      },
    });

    const firstTick = poller.tick();
    await entered.promise;

    await poller.tick();
    await poller.requestRefresh();

    expect(refreshCalls).toHaveLength(1);
    expect(poller.snapshot().running).toBe(true);
    expect(poller.snapshot().lastObservation).toBeUndefined();

    first.resolve(done(QUOTED));
    await firstTick;

    expect(poller.snapshot().running).toBe(false);
    expect(poller.snapshot().lastObservation?.outcome).toBe("quoted");
  });
});

describe("which ticks ask for quotes", () => {
  it("asks for quotes on a scheduled tick inside the window and not on one outside it", async () => {
    const trading = pollerWith({ clock: () => TRADING_HOUR });
    await trading.poller.tick();

    const weekend = pollerWith({ clock: () => WEEKEND });
    await weekend.poller.tick();

    expect(trading.refreshCalls).toEqual([{ quotes: true }]);
    expect(weekend.refreshCalls).toEqual([{ quotes: false }]);
  });

  it("forces quotes on a requested refresh outside the window, as an upload needs", async () => {
    const { poller, refreshCalls } = pollerWith({ clock: () => WEEKEND });

    await poller.requestRefresh();

    expect(refreshCalls).toEqual([{ quotes: true }]);
  });
});

describe("the snapshot /healthz reads", () => {
  it("is stamped synchronously when a tick starts, before anything it awaits", async () => {
    let now = TRADING_HOUR;
    const { poller } = pollerWith({ clock: () => now });

    poller.start();
    try {
      now = A_MINUTE_LATER;
      const tick = poller.tick();

      expect(poller.snapshot().lastTickStartedAt).toEqual(A_MINUTE_LATER);
      await tick;
    } finally {
      poller.stop();
    }
  });

  it("records a done run with quotes as quoted, with the counts healthz reports", async () => {
    const { poller } = pollerWith({ answer: () => done(QUOTED) });

    await poller.tick();

    expect(poller.snapshot().lastObservation).toStrictEqual({
      outcome: "quoted",
      requested: 3,
      priced: 2,
      providerFailed: true,
    });
  });

  it("keeps market_closed for a weekend tick whose backfill batch then fails", async () => {
    const { poller } = pollerWith({
      clock: () => WEEKEND,
      answer: () => done(null, backfill({ batchFailed: true })),
    });

    await poller.tick();

    expect(poller.snapshot().lastObservation).toStrictEqual({ outcome: "market_closed" });
  });

  it("keeps market_closed for a weekend tick that then finds the lock held", async () => {
    const { poller } = pollerWith({ clock: () => WEEKEND, answer: () => ({ status: "busy" }) });

    await poller.tick();

    expect(poller.snapshot().lastObservation).toStrictEqual({ outcome: "market_closed" });
    expect(poller.snapshot().running).toBe(false);
  });

  it("leaves the previous observation when a later tick finds the lock held", async () => {
    const { poller } = pollerWith({
      answer: (call) => (call === 0 ? done(QUOTED) : { status: "busy" }),
    });

    await poller.tick();
    const settled = poller.snapshot().lastObservation;
    await poller.tick();

    expect(settled?.outcome).toBe("quoted");
    expect(poller.snapshot().lastObservation).toStrictEqual(settled);
  });

  it("records an error run as error", async () => {
    const { poller } = pollerWith({ answer: () => ({ status: "error" }) });

    await poller.tick();

    expect(poller.snapshot().lastObservation).toStrictEqual({ outcome: "error" });
  });

  it("records a thrown refresh as error, clears running, and resolves the tick rather than rejecting", async () => {
    const { poller, lines } = pollerWith({
      answer: () => {
        throw new Error("socket hang up");
      },
    });

    await expect(poller.tick()).resolves.toBeUndefined();

    expect(poller.snapshot().lastObservation).toStrictEqual({ outcome: "error" });
    expect(poller.snapshot().running).toBe(false);
    expect(lines).toEqual([
      "error: Price refresh failed; last known prices are kept: Error: socket hang up",
    ]);
  });

  it("is a copy, so a reader mutating it leaves the next read unchanged", async () => {
    // fresh Date per read: a leaked reference must not reach the shared constant
    const { poller } = pollerWith({
      clock: () => new Date(TRADING_HOUR),
      answer: () => done(QUOTED),
    });
    await poller.tick();

    const read = poller.snapshot();
    read.lastTickStartedAt.setTime(0);
    const observation = read.lastObservation;
    if (observation?.outcome !== "quoted") throw new Error("expected a quoted observation");
    observation.priced = 99;

    expect(poller.snapshot()).toStrictEqual({
      running: false,
      lastTickStartedAt: TRADING_HOUR,
      minutes: 15,
      lastObservation: { outcome: "quoted", requested: 3, priced: 2, providerFailed: true },
    });
  });
});

describe("what a tick writes to the log", () => {
  it("reports every attempt at quotes at info, so a quiet loop is told from a dead one", async () => {
    const { poller, lines } = pollerWith({
      answer: () =>
        done({ requested: 1, priced: 1, stale: 0, closes: 1, observed: 1, providerFailed: false }),
    });

    await poller.tick();

    expect(lines).toEqual(["info: Price refresh: 1 of 1 priced, 0 stale, 1 closes written, 1 new."]);
  });

  it("warns when any instrument came back stale, the line an operator greps for", async () => {
    const { poller, lines } = pollerWith({
      answer: () =>
        done({ requested: 2, priced: 1, stale: 1, closes: 0, observed: 1, providerFailed: false }),
    });

    await poller.tick();

    expect(lines).toEqual(["warn: Price refresh: 1 of 2 priced, 1 stale, 0 closes written, 1 new."]);
  });

  it("says nothing on a weekend tick whose backfill found nothing to fill", async () => {
    // "no price line in the log" must keep meaning what docs/operating.md says
    const { poller, lines } = pollerWith({ clock: () => WEEKEND });

    await poller.tick();

    expect(lines).toEqual([]);
  });

  it("counts what the backfill attempted when there was something to fill", async () => {
    const { poller, lines } = pollerWith({
      clock: () => WEEKEND,
      answer: () => done(null, backfill({ attempted: 1 })),
    });

    await poller.tick();

    // an answer isn't a failure, the ledger names the reason
    expect(lines).toEqual(["info: Price backfill: 1 attempted, 0 closes written, 0 failed."]);
  });

  it("warns when a backfill call failed or the batch itself failed", async () => {
    const failedCall = pollerWith({
      clock: () => WEEKEND,
      answer: () =>
        done(
          null,
          backfill({
            attempted: 2,
            written: 1,
            outcomes: { ...backfill().outcomes, provider_failed: 1 },
          }),
        ),
    });
    await failedCall.poller.tick();

    const failedBatch = pollerWith({
      clock: () => WEEKEND,
      answer: () => done(null, backfill({ batchFailed: true })),
    });
    await failedBatch.poller.tick();

    expect(failedCall.lines).toEqual([
      "warn: Price backfill: 2 attempted, 1 closes written, 1 failed.",
    ]);
    expect(failedBatch.lines).toEqual([
      "warn: Price backfill: 0 attempted, 0 closes written, 0 failed. The batch itself failed; see the line above.",
    ]);
  });
});

describe("the pinned poller", () => {
  // the two module-level lines have no instance to carry a `log`
  function capturedConsole() {
    const calls: { level: string; args: unknown[] }[] = [];
    const restore = (["info", "warn", "error"] as const).map((level) => {
      const was = console[level];
      console[level] = (...args: unknown[]) => void calls.push({ level, args });
      return () => {
        console[level] = was;
      };
    });

    return { calls, restore: () => restore.forEach((undo) => undo()) };
  }

  /** Bounded poll on real timers: module `requestRefresh()` returns void, so there is nothing to await. */
  async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("condition was never met");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("builds once when pinned twice, since the second call is only the idempotent guard", () => {
    let firstBuilds = 0;
    let secondBuilds = 0;

    try {
      pinPricePoller(() => {
        firstBuilds += 1;
        return pollerWith().poller;
      });
      pinPricePoller(() => {
        secondBuilds += 1;
        return pollerWith().poller;
      });

      expect(firstBuilds).toBe(1);
      expect(secondBuilds).toBe(0);
    } finally {
      stopPricePoller();
    }
  });

  it("swallows a throwing build, logs it, and leaves no poller pinned", () => {
    const failure = new Error("no worker listening at /run/price-worker/worker.sock (ENOENT)");
    const captured = capturedConsole();

    try {
      expect(() =>
        pinPricePoller(() => {
          throw failure;
        }),
      ).not.toThrow();

      expect(readPollerSnapshot()).toBeUndefined();
      expect(captured.calls).toEqual([
        { level: "error", args: ["Price poller did not start; prices will not refresh:", failure] },
      ]);
      expect(captured.calls[0]?.args[1]).toBe(failure);
    } finally {
      captured.restore();
      stopPricePoller();
    }
  });

  it("leaves no poller pinned when starting the one it built throws, since the slot is written last", () => {
    const captured = capturedConsole();

    try {
      pinPricePoller(() => ({
        ...pollerWith().poller,
        start() {
          throw new Error("setInterval refused");
        },
      }));

      expect(readPollerSnapshot()).toBeUndefined();
      expect(captured.calls.map(({ level, args }) => [level, args[0]])).toEqual([
        ["error", "Price poller did not start; prices will not refresh:"],
      ]);
    } finally {
      captured.restore();
      stopPricePoller();
    }
  });

  it("reads as not started once stopped", () => {
    try {
      startPricePoller(fakeProvider());
      expect(readPollerSnapshot()).not.toBeUndefined();

      stopPricePoller();
      expect(readPollerSnapshot()).toBeUndefined();
    } finally {
      stopPricePoller();
    }
  });

  it("drops a refresh requested before the poller started, says so, and does not replay it", () => {
    const captured = capturedConsole();

    try {
      // action runs before its own request's middleware, so the poller may not exist yet
      requestRefresh();
      startPricePoller(fakeProvider());

      expect(captured.calls).toEqual([
        {
          level: "info",
          args: [
            "A refresh was requested before the price poller started in this process; it was dropped, and a later tick will do the work.",
          ],
        },
      ]);
      // a replayed tick sets running synchronously
      expect(readPollerSnapshot()?.running).toBe(false);
      expect(readPollerSnapshot()?.lastObservation).toBeUndefined();
    } finally {
      captured.restore();
      stopPricePoller();
    }
  });

  it(
    "reaches the first poller started with quotes forced, while a direct POST /refresh leaves it alone",
    withDatabase(async ({ seedInstrument }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      // the route calls runRefresh itself and never imports price-poller.server.ts
      await refreshAction(args(post("/refresh", {})));
      expect(readPollerSnapshot()).toBeUndefined();

      const first = fakeProvider();
      const second = fakeProvider();

      try {
        startPricePoller(first);
        startPricePoller(second);
        requestRefresh();
        await waitFor(() => readPollerSnapshot()?.lastObservation !== undefined);

        expect(first.asked).toEqual([["VTI"]]);
        expect(second.asked).toEqual([]);
        expect(readPollerSnapshot()?.lastObservation).toStrictEqual({
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
});
