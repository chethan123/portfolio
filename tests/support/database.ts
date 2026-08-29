/**
 * The primary test seam: a real Postgres with the migrations applied, seeded
 * through the fixture builder, read through the query module.
 *
 * No mock, no in-memory substitute, no SQLite. The risk this slice exists to
 * contain lives in Postgres-specific SQL and in `numeric` handling, and both
 * disappear under a substitute — a fake database would pass while the real one
 * silently rounded money or resolved the wrong position set.
 *
 * **Isolation is by transaction rollback.** Every test body runs inside a
 * transaction that is always rolled back, so no test can see another's rows and
 * ordering never matters. That also means a test may read its own writes but
 * nothing survives the test, so the suite leaves the database exactly as it
 * found it — including after a failure.
 *
 * Requires a database. See `compose.test.yaml`:
 *   docker compose -f compose.test.yaml up -d --wait
 */
import { createDatabase, withDb, type Database } from "~/lib/db.server";
import { createPool } from "../../server/db.ts";
import { applyPendingMigrations } from "../../server/migrations.ts";

import { makeFixtures, type Fixtures } from "./fixtures.ts";

import type { Kysely } from "kysely";
import type { Pool } from "pg";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_test";

let pool: Pool | undefined;
let db: Kysely<Database> | undefined;
let migrated: Promise<void> | undefined;

/**
 * A migrated database handle, opened once per test file.
 *
 * Applying migrations is idempotent, so this is safe however many test files
 * call it and whatever order they run in.
 */
export async function testDatabase(): Promise<Kysely<Database>> {
  pool ??= createPool(TEST_DATABASE_URL);
  db ??= createDatabase(TEST_DATABASE_URL);

  migrated ??= (async () => {
    try {
      await applyPendingMigrations(pool!);
    } catch (cause) {
      throw new Error(
        `Cannot prepare the test database at ${TEST_DATABASE_URL}.\n` +
          "Start it with: docker compose -f compose.test.yaml up -d --wait\n" +
          "or point TEST_DATABASE_URL at your own throwaway Postgres.",
        { cause },
      );
    }
  })();

  await migrated;
  return db;
}

/** Release both handles. Call from `afterAll`. */
export async function closeTestDatabase(): Promise<void> {
  await db?.destroy();
  await pool?.end();
  db = undefined;
  pool = undefined;
  migrated = undefined;
}

/** What a test body is handed. */
export type TestContext = Fixtures & {
  /**
   * The transaction everything in this test runs in. Pass it to the query
   * module — `currentHoldings(ALL_OWNERS, db)` — so the reads see the seeded
   * rows and the whole test disappears on rollback.
   */
  db: Kysely<Database>;
};

/** Thrown to unwind the transaction once the test body has finished. */
class Rollback extends Error {
  constructor() {
    super("Rolling back the test transaction");
  }
}

/**
 * Wrap a test body so it runs inside a transaction that is always rolled back.
 *
 *   it("a closed account is excluded from current holdings",
 *     withDatabase(async ({ db, seedAccount }) => { ... }));
 *
 * A failing assertion propagates out unchanged; the rollback happens either
 * way.
 */
export function withDatabase(
  body: (context: TestContext) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const database = await testDatabase();

    try {
      await database.transaction().execute(async (trx) => {
        // `withDb` is what extends this transaction to a caller that cannot be
        // handed it. A route loader calls `listAccounts()` with no argument by
        // design, so without this it would reach the process-wide pool, commit,
        // and leave rows behind for every later test to trip over. Inside the
        // store, `getDb()` returns `trx` however deep the call goes — so a
        // route test rolls back exactly like a query test.
        await withDb(trx, async () => {
          await body({ db: trx, ...makeFixtures(trx) });
        });
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  };
}
