import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeTestDatabase, TEST_DATABASE_URL, withDatabase } from "../support/database.ts";

// Only the healthy branch is reachable: checkHealth reads via getPool(), the process-wide pool withDatabase doesn't override, so
// unhealthy branches aren't faked here (migrations.test.ts covers pendingMigrations; health-response.test.ts covers the
// database x worker matrix, unhealthy branches included, as a pure function). DATABASE_URL must be set before the import below.
process.env.DATABASE_URL = TEST_DATABASE_URL;
// A unique, guaranteed-nonexistent path — not just "whatever the host happens not to be running" —
// so `pricing.worker` below is deterministically "unavailable" on a machine where something really
// is listening at the default PRICE_WORKER_SOCKET. getConfig() memoises on first read, so this must
// be set before the loader import below ever calls it.
process.env.PRICE_WORKER_SOCKET = join(tmpdir(), `healthz-test-${randomBytes(4).toString("hex")}.sock`);

const { loader } = await import("../../app/routes/healthz.ts");

afterAll(closeTestDatabase);

describe("a healthy instance", () => {
  it(
    // Nothing listens at the nonexistent PRICE_WORKER_SOCKET set above, so `pricing.worker` is
    // genuinely "unavailable" here — proof the route wires the real probe, not a stub, and that a
    // database-healthy instance still answers 200 while it is.
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
