// Pool is built in server/db.ts (single site, registers numeric/int8 string
// parsers) so money/quantities/ids cross the boundary as strings — never
// Number()/parseFloat/JSON round-trip; arithmetic in SQL or a decimal lib.
import { AsyncLocalStorage } from "node:async_hooks";

import { Kysely, PostgresDialect, sql } from "kysely";
import type pg from "pg";

import { getConfig } from "../../server/config.ts";
import { createPool } from "../../server/db.ts";
import { pendingMigrations } from "../../server/migrations.ts";
import type { DB } from "./database.generated.ts";

// Kysely's type, generated from the live db by `npm run db:types` — rerun after every migration.
export type Database = DB;

function kyselyOver(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

// Exported so tests can point at a throwaway db without a second construction site.
export function createDatabase(connectionString: string): Kysely<Database> {
  return kyselyOver(createPool(connectionString));
}

let pool: pg.Pool | undefined;
let instance: Kysely<Database> | undefined;

// Scopes db/pool to a call via AsyncLocalStorage so tests can override a
// no-arg `getDb()` call (e.g. inside a route loader) with a rolled-back
// transaction without changing any signature. No-op lookup in production.
const override = new AsyncLocalStorage<{ db: Kysely<Database>; pool?: pg.Pool }>();

// Only caller: tests/support/database.ts. `pool` is for pg-only paths (checkHealth's migration ledger read).
export function withDb<T>(
  db: Kysely<Database>,
  body: () => Promise<T>,
  overridePool?: pg.Pool,
): Promise<T> {
  return override.run({ db, pool: overridePool }, body);
}

// Exported for pg-only callers (migration ledger).
export function getPool(): pg.Pool {
  const scoped = override.getStore()?.pool;
  if (scoped !== undefined) return scoped;

  pool ??= createPool(getConfig().DATABASE_URL);
  return pool;
}

export function getDb(): Kysely<Database> {
  const scoped = override.getStore()?.db;
  if (scoped !== undefined) return scoped;

  instance ??= kyselyOver(getPool());
  return instance;
}

// What /healthz reports.
export type HealthReport = {
  database: boolean;
  pendingMigrations: string[];
  healthy: boolean;
};

// Reachability only — checkHealth also checks schema currency.
export async function isDatabaseReachable(): Promise<boolean> {
  try {
    await sql`select 1`.execute(getDb());
    return true;
  } catch (error) {
    console.error("Database health check failed:", error);
    return false;
  }
}

// Unrecorded migration on disk = image/db mismatch = non-200.
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
