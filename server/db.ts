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
 *
 * This lives under `server/` rather than under `app/` because two things need
 * it and only one of them is the bundled application: `app/lib/db.server.ts`
 * imports it through Vite, and `server/migrate.ts` imports it directly under
 * Node's type stripping, from a runtime image that deliberately contains no
 * source tree. Moving it here is what keeps the count of construction sites at
 * one rather than two.
 */
import pg from "pg";

/**
 * Postgres type OIDs whose default `pg` parser loses information.
 *
 * - 1700 `numeric` — parsed to a float by default, which rounds.
 * - 20 `int8` — outside `Number.MAX_SAFE_INTEGER`. `pg` already returns this as
 *   a string, but stating it makes the guarantee explicit rather than inherited.
 *   Every surrogate key in the schema is a bigint, so this is also why ids cross
 *   the boundary as strings.
 * - 1082 `date` — a calendar date, not an instant. `pg` parses it into a JS
 *   `Date` at *local* midnight, so formatting it back in any timezone west of
 *   UTC yields the previous day. That is the same class of silent bug as the
 *   numeric coercion above: `position_set.as_of_date` shifting by a day would
 *   select the wrong position set in an as-of query, with no error anywhere.
 *   A date crosses the boundary as the `YYYY-MM-DD` string Postgres sent.
 *
 * `timestamp` (1114) and `timestamptz` (1184) are deliberately left alone.
 * `created_at`, `closed_at` and `quote.as_of` are genuine instants, are compared
 * in SQL rather than in JavaScript, and a `Date` is the right shape for them.
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

/**
 * Construct a pool with the numeric guarantee applied.
 *
 * Exported so tests and the migration runner can point one at a throwaway
 * database without reaching for a second construction site.
 */
export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    // Bounded so `/healthz` reports unreachable rather than hanging until the
    // Compose healthcheck times out.
    connectionTimeoutMillis: 5_000,
    // The database stores UTC regardless of the container clock (DESIGN.md §10).
    options: "-c timezone=UTC",
  });

  const reportConnectionError = (error: Error): void => {
    console.error("Postgres connection error:", error);
  };

  // Both paths are necessary: pg-pool removes its idle error listener while a
  // client is checked out, and the price poller holds one across provider
  // network work. The pool catches idle failures; the client catches that gap.
  // Detaching on release keeps the paths disjoint — an idle death would
  // otherwise fire both this listener and pg-pool's own, reporting one error
  // twice.
  pool.on("error", reportConnectionError);
  pool.on("acquire", (client) => {
    client.on("error", reportConnectionError);
  });
  pool.on("release", (_error, client) => {
    client.removeListener("error", reportConnectionError);
  });

  return pool;
}
