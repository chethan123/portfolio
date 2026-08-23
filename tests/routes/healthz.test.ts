import { afterAll, describe, expect, it } from "vitest";

import { closeTestDatabase, TEST_DATABASE_URL, withDatabase } from "../support/database.ts";

/**
 * `GET /healthz` — the answer Compose, a reverse proxy and any monitoring read.
 *
 * `scripts/smoke-test.sh` already asserts the status code, so what is new here
 * is the body: monitoring alerts on `status`, and an operator diagnosing a
 * half-deployed instance reads `migrations` and `pendingMigrations` to tell a
 * database that is down from a schema that is behind. A key that quietly
 * changes name breaks both of those silently — the endpoint keeps answering
 * 200, and the field the dashboard reads is simply never there again.
 *
 * `Cache-Control: no-store` is here for the same reason. A proxy that is
 * allowed to cache this serves a healthy verdict for an instance that stopped
 * being healthy, which is strictly worse than serving no health check at all.
 *
 * Scope, honestly: only the healthy branch is reachable from a test. The
 * unhealthy ones are decided by `checkHealth`, which reads the migration ledger
 * through `getPool()` — the process-wide pool, which `withDatabase` does not
 * override. So the pending-migration and unreachable-database branches cannot
 * be staged from here without changing production code or the harness, and are
 * deliberately not faked. `migrations.test.ts` covers `pendingMigrations`
 * itself.
 *
 * That process-wide pool is also why `DATABASE_URL` is assigned before the
 * import: the ledger read goes to whatever it names, so it has to name the same
 * throwaway database the transaction below runs in.
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
