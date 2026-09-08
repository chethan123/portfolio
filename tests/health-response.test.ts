// Pure function, no database, no socket — the database x worker matrix `/healthz`'s route test
// can't reach (tests/routes/healthz.test.ts explains why the unhealthy-database branches aren't
// faked there). `pricingHealth` itself is table-driven in tests/price-health.test.ts; here it is
// enough to prove `healthzResponse` threads a snapshot and a worker value into `pricing` and never
// lets either move the HTTP status.
import { describe, expect, it } from "vitest";

import { healthzResponse } from "~/lib/health-response";

import type { HealthReport } from "~/lib/db.server";
import type { PollerSnapshot } from "~/lib/price-health";

const HEALTHY: HealthReport = { database: true, pendingMigrations: [], healthy: true };
const DB_DOWN: HealthReport = { database: false, pendingMigrations: [], healthy: false };
const PENDING: HealthReport = {
  database: true,
  pendingMigrations: ["0099_future.sql"],
  healthy: false,
};

const NOW = new Date("2026-06-04T15:00:00Z");

const NOT_STARTED: PollerSnapshot = undefined;
const ON_SCHEDULE: PollerSnapshot = {
  running: false,
  lastTickStartedAt: new Date(NOW.getTime() - 60_000),
  minutes: 15,
  lastObservation: undefined,
};

describe("healthzResponse", () => {
  it("answers 200 ok when the database is healthy, the worker is available, and pricing is otherwise healthy", () => {
    expect(healthzResponse(HEALTHY, "available", ON_SCHEDULE, NOW)).toEqual({
      body: {
        status: "ok",
        database: true,
        migrations: "current",
        pendingMigrations: [],
        pricing: { ok: true, worker: "available", scheduler: "on_schedule", quotes: "not_attempted" },
      },
      status: 200,
    });
  });

  it("still answers 200 ok when the database is healthy and the worker is unavailable, with pricing.ok false", () => {
    const { body, status } = healthzResponse(HEALTHY, "unavailable", ON_SCHEDULE, NOW);

    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.pricing).toEqual({
      ok: false,
      worker: "unavailable",
      scheduler: "on_schedule",
      quotes: "not_attempted",
    });
  });

  it("answers pricing.ok false for a scheduler that has not started, even with the database and worker both healthy", () => {
    const { body } = healthzResponse(HEALTHY, "available", NOT_STARTED, NOW);

    expect(body.pricing).toEqual({
      ok: false,
      worker: "available",
      scheduler: "not_started",
      quotes: "not_attempted",
    });
  });

  it("answers 503 unhealthy for an unreachable database, whether or not pricing is healthy", () => {
    expect(healthzResponse(DB_DOWN, "available", ON_SCHEDULE, NOW).status).toBe(503);
    expect(healthzResponse(DB_DOWN, "unavailable", NOT_STARTED, NOW).status).toBe(503);
    expect(healthzResponse(DB_DOWN, "available", ON_SCHEDULE, NOW).body).toEqual({
      status: "unhealthy",
      database: false,
      migrations: "current",
      pendingMigrations: [],
      pricing: { ok: true, worker: "available", scheduler: "on_schedule", quotes: "not_attempted" },
    });
  });

  it("answers 503 unhealthy for a pending migration even with pricing healthy", () => {
    const { body, status } = healthzResponse(PENDING, "available", ON_SCHEDULE, NOW);

    expect(status).toBe(503);
    expect(body).toEqual({
      status: "unhealthy",
      database: true,
      migrations: "pending",
      pendingMigrations: ["0099_future.sql"],
      pricing: { ok: true, worker: "available", scheduler: "on_schedule", quotes: "not_attempted" },
    });
  });
});
