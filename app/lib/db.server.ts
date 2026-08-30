/**
 * The application's handle on the database. The pool is constructed in
 * `server/db.ts` — the single construction site, where the `numeric`/`int8`
 * type-parser override is registered; a second site would leave a code path
 * that gets JavaScript numbers. It lives under `server/` because the
 * migration runner needs it from a runtime image with no source tree.
 * Consequence for every caller: money, quantities and ids cross the boundary
 * as strings — never `Number()`, `parseFloat` or a JSON round trip;
 * arithmetic happens in SQL or a decimal library.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { Kysely, PostgresDialect, sql } from "kysely";
import type pg from "pg";

import { getConfig } from "../../server/config.ts";
import { createPool } from "../../server/db.ts";
import { pendingMigrations } from "../../server/migrations.ts";
import type { DB } from "./database.generated.ts";

/**
 * The database shape Kysely is typed against — generated from the live
 * database by `npm run db:types` (kysely-codegen), views included, so
 * `holding_valued` types like a table. Regenerating is required after any
 * migration.
 */
export type Database = DB;

function kyselyOver(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * A pool and a Kysely instance over it, for a connection string. Exported so
 * tests can point at a throwaway database without a second construction site.
 */
export function createDatabase(connectionString: string): Kysely<Database> {
  return kyselyOver(createPool(connectionString));
}

let pool: pg.Pool | undefined;
let instance: Kysely<Database> | undefined;

/**
 * A handle that overrides the process-wide one for the duration of a call.
 * Every query reaches the database through a trailing `db = getDb()`
 * parameter, which lets a test pass a rolled-back transaction — but a route
 * loader calls `listAccounts()` with no argument by design, so a route test
 * would commit. `AsyncLocalStorage` closes that gap without changing a
 * signature: `getDb()` is never called at module scope — every call site is
 * a default-parameter expression, evaluated per call, or a function body —
 * so a store entered around a loader is visible to every query it makes,
 * however deep, and to nothing outside it. The running application never
 * enters the store; in production this is one `undefined` lookup per query.
 */
const override = new AsyncLocalStorage<{ db: Kysely<Database>; pool?: pg.Pool }>();

/**
 * Run `body` with `db` standing in for the process-wide handle, scoped to
 * the call and everything it awaits. Pass `pool` too for paths that speak
 * `pg` rather than Kysely — {@link checkHealth} reads the migration ledger
 * that way.
 *
 * @see tests/support/database.ts, the only caller.
 */
export function withDb<T>(
  db: Kysely<Database>,
  body: () => Promise<T>,
  overridePool?: pg.Pool,
): Promise<T> {
  return override.run({ db, pool: overridePool }, body);
}

/**
 * The process-wide pool, opened on first use. Exported for the things that
 * speak `pg` rather than Kysely — the migration ledger is the only one today.
 */
export function getPool(): pg.Pool {
  const scoped = override.getStore()?.pool;
  if (scoped !== undefined) return scoped;

  pool ??= createPool(getConfig().DATABASE_URL);
  return pool;
}

/** The process-wide database handle, opened on first use. */
export function getDb(): Kysely<Database> {
  const scoped = override.getStore()?.db;
  if (scoped !== undefined) return scoped;

  instance ??= kyselyOver(getPool());
  return instance;
}

/** What `/healthz` reports. */
export type HealthReport = {
  /** Is the database reachable at all? */
  database: boolean;
  /** Migrations on disk that are not recorded as applied. */
  pendingMigrations: string[];
  /** True when the database is reachable and every migration is recorded. */
  healthy: boolean;
};

/** Reachability only — {@link checkHealth} also asks whether the schema is
 * current. */
export async function isDatabaseReachable(): Promise<boolean> {
  try {
    await sql`select 1`.execute(getDb());
    return true;
  } catch (error) {
    console.error("Database health check failed:", error);
    return false;
  }
}

/**
 * Reachability plus schema currency. A migration on disk the database has no
 * record of means the image and the database disagree — a non-200: the
 * instance runs, but it is not the one the operator deployed, and its pages
 * are backed by a schema older than the code reading it.
 */
export async function checkHealth(): Promise<HealthReport> {
  if (!(await isDatabaseReachable())) {
    return { database: false, pendingMigrations: [], healthy: false };
  }

  try {
    const pending = await pendingMigrations(getPool());
    return { database: true, pendingMigrations: pending, healthy: pending.length === 0 };
  } catch (error) {
    console.error("Migration status check failed:", error);
    return { database: true, pendingMigrations: [], healthy: false };
  }
}
