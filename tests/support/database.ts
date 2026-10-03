/**
 * Real Postgres, migrated, seeded through the fixture builder — no mock, no SQLite, since the risk
 * is Postgres-specific SQL and `numeric` handling. Isolation is by transaction rollback, always
 * rolled back, except the two-connection races and one price-backfill case, which commit and sweep
 * their own rows.
 * Requires `docker compose -f compose.test.yaml up -d --wait`.
 */
import { sql } from "kysely";

import { createDatabase, withDb, type Database } from "~/lib/db.server";
import { createPool } from "../../server/db.ts";
import { applyPendingMigrations } from "../../server/migrations.ts";

import { makeFixtures, type Fixtures } from "./fixtures.ts";

import type { Kysely, RawBuilder } from "kysely";
import type { Pool } from "pg";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_test";

/** Refused immediately, which is how a database outage arrives in fail-closed route tests. */
export const UNREACHABLE_DATABASE_URL =
  "postgres://portfolio:portfolio@127.0.0.1:1/portfolio_test";

let pool: Pool | undefined;
let db: Kysely<Database> | undefined;
let migrated: Promise<void> | undefined;

/** A migrated database handle, opened once per test file — safe regardless of call count or order, since migrating is idempotent. */
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
  /** The test's transaction — pass to the query module (`currentHoldings(ALL_OWNERS, db)`) so reads see seeded rows and vanish on rollback. */
  db: Kysely<Database>;
};

/** Thrown to unwind the transaction once the test body has finished. */
class Rollback extends Error {
  constructor() {
    super("Rolling back the test transaction");
  }
}

/**
 * Wraps a test body in a transaction that is always rolled back, failing
 * assertion or not:
 *
 *   it("a closed account is excluded from current holdings",
 *     withDatabase(async ({ db, seedAccount }) => { ... }));
 */
export function withDatabase(
  body: (context: TestContext) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const database = await testDatabase();

    try {
      await database.transaction().execute(async (trx) => {
        // withDb extends this transaction to callers that take no db argument by design (e.g. a loader's listAccounts()) — getDb() returns trx however deep the call goes, so a route test rolls back too.
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

/** The connection behind a handle, so another can watch it. Read it before issuing the statement expected to block: a query queued behind that one on the same connection blocks with it. */
export async function backendPid(handle: Kysely<Database>): Promise<number> {
  const result = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(handle);
  return result.rows[0]!.pid;
}

/** Scans this transaction has made on a table, sequential and index alike (pg_stat_xact_user_tables). Pure reads leave no other trace, so a "reads once" rule is a delta of this. */
export async function scansOf(table: string, handle: Kysely<Database>): Promise<number> {
  const result = await sql<{ scans: number }>`
    select (seq_scan + coalesce(idx_scan, 0))::int as scans
    from pg_stat_xact_user_tables
    where relname = ${table}
  `.execute(handle);
  return result.rows[0]?.scans ?? 0;
}

/** Polls pg_stat_activity (never a fixed delay) until pid is blocked on a lock, bounded so a deadlock fails loudly. `unless` is the statement expected to block: settling first is the race never contending, reported by name rather than as the timeout. */
export async function waitUntilBlocked(
  watcher: Kysely<Database>,
  pid: number,
  options: LockWait = {},
): Promise<void> {
  await waitUntilLocked(
    watcher,
    sql<{ blocked: boolean }>`
      select exists (
        select 1 from pg_stat_activity where pid = ${pid} and wait_event_type = 'Lock'
      ) as blocked
    `,
    `Backend ${pid}`,
    options,
  );
}

/** The same wait for a read whose connection the pool picks, so no pid can be read ahead of it: pg_locks names the relation it queues on instead. */
export async function waitUntilRelationBlocked(
  watcher: Kysely<Database>,
  relation: string,
  options: LockWait = {},
): Promise<void> {
  await waitUntilLocked(
    watcher,
    sql<{ blocked: boolean }>`
      select exists (
        select 1 from pg_locks where relation = ${relation}::regclass and not granted
      ) as blocked
    `,
    `A reader of ${relation}`,
    options,
  );
}

type LockWait = { timeoutMs?: number; unless?: Promise<unknown> };

async function waitUntilLocked(
  watcher: Kysely<Database>,
  probe: RawBuilder<{ blocked: boolean }>,
  subject: string,
  { timeoutMs = 5_000, unless }: LockWait,
): Promise<void> {
  let outcome: string | undefined;
  unless?.then(
    () => {
      outcome = "fulfilled";
    },
    (reason: unknown) => {
      outcome = `rejected (${reason instanceof Error ? reason.message : String(reason)})`;
    },
  );

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe.execute(watcher);
    if (result.rows[0]?.blocked === true) return;
    if (outcome !== undefined) {
      throw new Error(
        `${subject} ${outcome} before it blocked on a lock — the race this test drives ` +
          "no longer contends on the row it expects to.",
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms — ${subject} never blocked on a lock. Either the race ` +
          "this test drives no longer contends on the row it expects to, " +
          "or something is genuinely stuck.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
