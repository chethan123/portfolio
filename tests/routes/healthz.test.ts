import { afterAll, describe, expect, it } from "vitest";

import { closeTestDatabase, TEST_DATABASE_URL, withDatabase } from "../support/database.ts";

// Only the healthy branch is reachable: checkHealth reads via getPool(), the process-wide pool withDatabase doesn't override, so
// unhealthy branches aren't faked here (migrations.test.ts covers pendingMigrations; health-response.test.ts covers the
// database x worker matrix, unhealthy branches included, as a pure function). DATABASE_URL must be set before the import below.
process.env.DATABASE_URL = TEST_DATABASE_URL;

const { loader } = await import("../../app/routes/healthz.ts");

afterAll(closeTestDatabase);

describe("a healthy instance", () => {
  it(
    // No worker listens at the default PRICE_WORKER_SOCKET in this environment, so `pricing.worker`
    // is genuinely "unavailable" here — proof the route wires the real probe, not a stub, and that
    // a database-healthy instance still answers 200 while it is.
    "answers 200 with the exact body monitoring parses, worker unreachable included",
    withDatabase(async () => {
      const response = await loader();

      expect(response.status).toBe(200);
      // toEqual, not toMatchObject: a renamed or dropped key must fail here.
      expect(await response.json()).toEqual({
        status: "ok",
        database: true,
        migrations: "current",
        pendingMigrations: [],
        pricing: { worker: "unavailable" },
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
