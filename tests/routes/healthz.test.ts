import { afterAll, describe, expect, it } from "vitest";

import { closeTestDatabase, TEST_DATABASE_URL, withDatabase } from "../support/database.ts";

/**
 * `GET /healthz` — the answer Compose, the proxy and monitoring read.
 * `smoke-test.sh` asserts the status code; what is new is the body:
 * monitoring alerts on `status`, an operator reads `migrations` and
 * `pendingMigrations` to tell a down database from a behind schema, and a
 * quietly renamed key breaks both silently — 200 keeps answering while the
 * field is simply never there again. `Cache-Control: no-store` for the same
 * reason: a cached healthy verdict for an unhealthy instance is worse than
 * no health check. Scope, honestly: only the healthy branch is reachable —
 * `checkHealth` reads the ledger through `getPool()`, the process-wide pool
 * `withDatabase` does not override, so the unhealthy branches cannot be
 * staged without changing production code, and are deliberately not faked
 * (`migrations.test.ts` covers `pendingMigrations` itself). That pool is
 * also why `DATABASE_URL` is assigned before the import.
 */
process.env.DATABASE_URL = TEST_DATABASE_URL;

const { loader } = await import("../../app/routes/healthz.ts");

afterAll(closeTestDatabase);

describe("a healthy instance", () => {
  it(
    "answers 200 with the exact body monitoring parses",
    withDatabase(async () => {
      const response = await loader();

      expect(response.status).toBe(200);
      // Exact rather than a subset: a renamed or dropped key is the failure
      // this test exists for, and `toMatchObject` would not see either.
      expect(await response.json()).toEqual({
        status: "ok",
        database: true,
        migrations: "current",
        pendingMigrations: [],
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
