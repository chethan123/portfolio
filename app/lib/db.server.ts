/**
 * The application's handle on the database.
 *
 * The pool itself is constructed in `server/db.ts` — the single construction
 * site, because that is where the `numeric`/`int8` type-parser override is
 * registered and a second site would leave a code path that gets JavaScript
 * numbers. It lives under `server/` rather than here because the migration
 * runner needs it too, from a runtime image that contains no source tree.
 *
 * Consequence for every caller: money, quantity and id values cross the
 * application boundary as strings. Never `Number()`, `parseFloat` or JSON
 * round-trip them as numbers; do the arithmetic in SQL, or in a decimal library.
 */
import { Kysely, PostgresDialect, sql } from "kysely";
import type pg from "pg";

import { getConfig } from "../../server/config.ts";
import { createPool } from "../../server/db.ts";
import { pendingMigrations } from "../../server/migrations.ts";
import type { DB } from "./database.generated.ts";

/**
 * The database shape Kysely is typed against.
 *
 * Generated from the live database by `npm run db:types` (kysely-codegen),
 * including views — so `holding_valued` will be typed like a table by
 * everything that reads it. Regenerating is a required step after any
 * migration; see the README.
 */
export type Database = DB;

/** A Kysely instance over an existing pool. */
function kyselyOver(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * A pool and a Kysely instance over it, for a connection string.
 *
 * Exported so tests can point one at a throwaway database without reaching for
 * a second construction site.
 */
export function createDatabase(connectionString: string): Kysely<Database> {
  return kyselyOver(createPool(connectionString));
}

let pool: pg.Pool | undefined;
let instance: Kysely<Database> | undefined;

/**
 * The process-wide pool, opened on first use.
 *
 * Exported for the things that speak `pg` rather than Kysely — the migration
 * ledger below is the only one today.
 */
export function getPool(): pg.Pool {
  pool ??= createPool(getConfig().DATABASE_URL);
  return pool;
}

/** The process-wide database handle, opened on first use. */
export function getDb(): Kysely<Database> {
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

/**
 * Is the database reachable?
 *
 * Reachability only — {@link checkHealth} is the one that also asks whether the
 * schema is current.
 */
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
 * Reachability plus schema currency.
 *
 * A migration sitting on disk that the database has no record of means the
 * image and the database disagree. That is a non-200: the instance is running,
 * but it is not the instance the operator deployed, and the pages it serves are
 * backed by a schema older than the code reading it.
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
