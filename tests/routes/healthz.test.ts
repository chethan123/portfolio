import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  readPollerSnapshot,
  requestRefresh,
  startPricePoller,
  stopPricePoller,
} from "~/lib/price-poller.server";
import * as workerReachabilityModule from "~/lib/worker-reachability.server";

import { closeTestDatabase, TEST_DATABASE_URL, withDatabase } from "../support/database.ts";

import type { PriceProvider } from "~/lib/price-provider.server";

// Only the healthy branch is reachable: checkHealth reads via getPool(), the process-wide pool withDatabase doesn't override, so
// unhealthy branches aren't faked here (migrations.test.ts covers pendingMigrations; health-response.test.ts covers the
// database x worker matrix, unhealthy branches included, as a pure function). DATABASE_URL must be set before the import below.
process.env.DATABASE_URL = TEST_DATABASE_URL;
// A unique, guaranteed-nonexistent path — not just "whatever the host happens not to be running" —
// so `pricing.worker` below is deterministically "unavailable" wherever a test doesn't spy over the
// real probe. getConfig() memoises on first read, so this must be set before the loader import below
// ever calls it.
process.env.PRICE_WORKER_SOCKET = join(tmpdir(), `healthz-test-${randomBytes(4).toString("hex")}.sock`);

const { loader } = await import("../../app/routes/healthz.ts");

afterAll(closeTestDatabase);

// A process-wide slot in a serial suite (fileParallelism off): a poller armed by an earlier file
// would make `pricing.scheduler` non-deterministic here, the same reason
// tests/framework-wiring.test.ts:22-25 stops it in its own fixture.
afterEach(() => {
  stopPricePoller();
});

/** A provider that answers no quotes and no history — these tests never let a tick reach a real one. */
function silentProvider(): PriceProvider {
  return {
    async getQuotes() {
      return [];
    },
    async getDailyCloses() {
      return { status: "no-history" };
    },
  };
}

describe("a healthy instance", () => {
  it(
    // Nothing listens at the nonexistent PRICE_WORKER_SOCKET set above, so `pricing.worker` is
    // genuinely "unavailable" here — proof the route wires the real probe, not a stub, and that a
    // database-healthy instance still answers 200 while it is. The poller was never started in this
    // process either, so `scheduler` and `quotes` are the fresh-container values.
    "answers 200 with the exact body monitoring parses, worker unreachable and the poller unarmed",
    withDatabase(async () => {
      const response = await loader();

      expect(response.status).toBe(200);
      // toEqual, not toMatchObject: a renamed or dropped key must fail here.
      expect(await response.json()).toEqual({
        status: "ok",
        database: true,
        migrations: "current",
        pendingMigrations: [],
        pricing: { ok: false, worker: "unavailable", scheduler: "not_started", quotes: "not_attempted" },
      });
    }),
  );

  it(
    "forbids caching, so nothing between here and the monitor can answer for it",
    withDatabase(async () => {
      expect((await loader()).headers.get("Cache-Control")).toBe("no-store");
    }),
  );
});

describe("pricing.ok, one cause at a time", () => {
  it(
    "is true when the worker is reachable and the scheduler has not yet had a turn since it armed",
    withDatabase(async () => {
      const workerSpy = vi
        .spyOn(workerReachabilityModule.workerHealthProbe, "check")
        .mockResolvedValue("available");

      try {
        startPricePoller(silentProvider());

        const response = await loader();
        expect(response.status).toBe(200);
        expect((await response.json()).pricing).toEqual({
          ok: true,
          worker: "available",
          scheduler: "on_schedule",
          quotes: "not_attempted",
        });
      } finally {
        workerSpy.mockRestore();
      }
    }),
  );

  it(
    "is false for the worker alone, with the scheduler on_schedule and quotes not_attempted otherwise",
    withDatabase(async () => {
      // No spy: the fixed, nonexistent PRICE_WORKER_SOCKET above already answers "unavailable" for real.
      startPricePoller(silentProvider());

      const response = await loader();
      expect(response.status).toBe(200);
      expect((await response.json()).pricing).toEqual({
        ok: false,
        worker: "unavailable",
        scheduler: "on_schedule",
        quotes: "not_attempted",
      });
    }),
  );

  it(
    "is false for the scheduler alone (not_started), with the worker available and quotes not_attempted otherwise",
    withDatabase(async () => {
      const workerSpy = vi
        .spyOn(workerReachabilityModule.workerHealthProbe, "check")
        .mockResolvedValue("available");

      try {
        // No startPricePoller: the default state for this process is not_started.
        const response = await loader();
        expect(response.status).toBe(200);
        expect((await response.json()).pricing).toEqual({
          ok: false,
          worker: "available",
          scheduler: "not_started",
          quotes: "not_attempted",
        });
      } finally {
        workerSpy.mockRestore();
      }
    }),
  );

  it(
    "is false for quotes alone (failed), with the worker available and the scheduler on_schedule otherwise",
    withDatabase(async ({ seedInstrument }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const workerSpy = vi
        .spyOn(workerReachabilityModule.workerHealthProbe, "check")
        .mockResolvedValue("available");

      try {
        startPricePoller(silentProvider());
        requestRefresh();

        // Bounded polling for the fire-and-forget tick to record its observation — no connection
        // handback to await here, unlike tests/price-poller.test.ts's watched pool.
        const deadline = Date.now() + 2_000;
        while (readPollerSnapshot()?.lastObservation === undefined) {
          if (Date.now() > deadline) throw new Error("the requested tick never recorded an observation");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        const response = await loader();
        expect(response.status).toBe(200);
        expect((await response.json()).pricing).toEqual({
          ok: false,
          worker: "available",
          scheduler: "on_schedule",
          quotes: "failed",
        });
      } finally {
        workerSpy.mockRestore();
      }
    }),
  );
});
