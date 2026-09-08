// Pure function, no database, no socket — the database x worker matrix `/healthz`'s route test
// can't reach (tests/routes/healthz.test.ts explains why the unhealthy-database branches aren't
// faked there).
import { describe, expect, it } from "vitest";

import { healthzResponse } from "~/lib/health-response";

import type { HealthReport } from "~/lib/db.server";

const HEALTHY: HealthReport = { database: true, pendingMigrations: [], healthy: true };
const DB_DOWN: HealthReport = { database: false, pendingMigrations: [], healthy: false };
const PENDING: HealthReport = {
  database: true,
  pendingMigrations: ["0099_future.sql"],
  healthy: false,
};

describe("healthzResponse", () => {
  it("answers 200 ok when the database is healthy and the worker is available", () => {
    expect(healthzResponse(HEALTHY, "available")).toEqual({
      body: {
        status: "ok",
        database: true,
        migrations: "current",
        pendingMigrations: [],
        pricing: { worker: "available" },
      },
      status: 200,
    });
  });

  it("still answers 200 ok when the database is healthy and the worker is unavailable", () => {
    const { body, status } = healthzResponse(HEALTHY, "unavailable");

    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.pricing).toEqual({ worker: "unavailable" });
  });

  it("answers 503 unhealthy for an unreachable database, whether or not the worker is available", () => {
    expect(healthzResponse(DB_DOWN, "available").status).toBe(503);
    expect(healthzResponse(DB_DOWN, "unavailable").status).toBe(503);
    expect(healthzResponse(DB_DOWN, "available").body).toEqual({
      status: "unhealthy",
      database: false,
      migrations: "current",
      pendingMigrations: [],
      pricing: { worker: "available" },
    });
  });

  it("answers 503 unhealthy for a pending migration even with the worker available", () => {
    const { body, status } = healthzResponse(PENDING, "available");

    expect(status).toBe(503);
    expect(body).toEqual({
      status: "unhealthy",
      database: true,
      migrations: "pending",
      pendingMigrations: ["0099_future.sql"],
      pricing: { worker: "available" },
    });
  });
});
