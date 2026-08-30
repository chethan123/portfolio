/**
 * The one place a Postgres pool is constructed, so the type-parser override
 * below covers every code path. Default `pg` parses `numeric` into a JS
 * number, which silently rounds — two dashboards disagreeing by cents, no
 * error anywhere (DESIGN.md §4.1).
 *
 * Consequence for every caller: money and quantities cross the boundary as
 * decimal strings. Never `Number()`, `parseFloat` or JSON round-trip them;
 * arithmetic happens in SQL or a decimal library.
 *
 * Under `server/`, not `app/`, because both the Vite bundle
 * (`app/lib/db.server.ts`) and `server/migrate.ts` — run under type stripping
 * from an image with no source tree — need this single construction site.
 */
import pg from "pg";

/**
 * OIDs whose default `pg` parser loses information.
 *
 * - 1700 `numeric` — parsed to a float, rounds.
 * - 20 `int8` — beyond `MAX_SAFE_INTEGER`. `pg` already returns strings;
 *   stated here so the guarantee is explicit. Every surrogate key is a bigint,
 *   hence ids cross as strings too.
 * - 1082 `date` — a calendar date, not an instant. Default parse lands at
 *   *local* midnight, so any zone west of UTC formats it back as the previous
 *   day and an as-of query picks the wrong position set, no error anywhere.
 *   Crosses as the `YYYY-MM-DD` string Postgres sent.
 *
 * `timestamp`/`timestamptz` deliberately stay `Date`s: genuine instants,
 * compared in SQL.
 */
const STRING_TYPE_OIDS = [
  pg.types.builtins.NUMERIC,
  pg.types.builtins.INT8,
  pg.types.builtins.DATE,
] as const;

const asString = (value: string): string => value;

for (const oid of STRING_TYPE_OIDS) {
  pg.types.setTypeParser(oid, asString);
}

/** Exported so tests and the migration runner reuse this construction site. */
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    // Bounded so `/healthz` reports unreachable rather than hanging past the
    // Compose healthcheck.
    connectionTimeoutMillis: 5_000,
    // The database stores UTC regardless of the container clock (DESIGN.md §10).
    options: "-c timezone=UTC",
  });
}
