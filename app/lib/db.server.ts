/**
 * The one place a Postgres connection pool is constructed.
 *
 * It is deliberately the only place, because of the type-parser override below:
 * `node-postgres` parses `numeric` into a JavaScript number by default, which
 * silently rounds. A six-figure balance then surfaces later as two dashboards
 * disagreeing by cents, with no error anywhere (DESIGN.md §4.1). Registering
 * the override anywhere other than at pool construction would leave a code path
 * that gets numbers.
 *
 * Consequence for every caller: money and quantity values cross the application
 * boundary as decimal strings. Never `Number()`, `parseFloat` or JSON
 * round-trip them as numbers; do the arithmetic in SQL, or in a decimal library.
 */
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";

import { getConfig } from "../../server/config.ts";

/**
 * Postgres type OIDs whose default `pg` parser loses information.
 *
 * - 1700 `numeric` — parsed to a float by default, which rounds.
 * - 20 `int8` — outside `Number.MAX_SAFE_INTEGER`. `pg` already returns this as
 *   a string, but stating it makes the guarantee explicit rather than inherited.
 */
const STRING_TYPE_OIDS = [
  pg.types.builtins.NUMERIC,
  pg.types.builtins.INT8,
] as const;

const asString = (value: string): string => value;

for (const oid of STRING_TYPE_OIDS) {
  pg.types.setTypeParser(oid, asString);
}

/**
 * The database shape Kysely is typed against.
 *
 * Empty until the schema slice lands; `kysely-codegen` will generate this from
 * the live database (including views, so `holding_valued` is typed like a
 * table) once there is a schema to generate from.
 */
export interface Database {}

/**
 * Construct a pool with the numeric guarantee applied.
 *
 * Exported so tests can point one at a throwaway database without reaching for
 * a second construction site.
 */
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    // Bounded so `/healthz` reports unreachable rather than hanging until the
    // Compose healthcheck times out.
    connectionTimeoutMillis: 5_000,
    // The database stores UTC regardless of the container clock (DESIGN.md §10).
    options: "-c timezone=UTC",
  });
}

/** A Kysely instance over a pool built by {@link createPool}. */
export function createDatabase(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: createPool(connectionString) }),
  });
}

let instance: Kysely<Database> | undefined;

/** The process-wide database handle, opened on first use. */
export function getDb(): Kysely<Database> {
  instance ??= createDatabase(getConfig().DATABASE_URL);
  return instance;
}

/**
 * Is the database reachable?
 *
 * Reachability only — this slice has no schema. The migrations slice extends
 * `/healthz` to also assert that every migration on disk is recorded as applied.
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
