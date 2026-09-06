import { afterAll, describe, expect, it } from "vitest";

import { closeTestDatabase, TEST_DATABASE_URL, withDatabase } from "../support/database.ts";

// Only the healthy branch is reachable: checkHealth reads via getPool(), the process-wide pool withDatabase doesn't override, so
// unhealthy branches aren't faked here (migrations.test.ts covers pendingMigrations). DATABASE_URL must be set before the import below.
process.env.DATABASE_URL = TEST_DATABASE_URL;

const { loader } = await import("../../app/routes/healthz.ts");

afterAll(closeTestDatabase);

describe("a healthy instance", () => {
  it(
    "answers 200 with the exact body monitoring parses",
    withDatabase(async () => {
      const response = await loader();

      expect(response.status).toBe(200);
      // toEqual, not toMatchObject: a renamed or dropped key must fail here.
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
