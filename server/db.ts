/**
 * Only pg pool construction site — keeps numeric/int8/date as strings, not JS
 * numbers (DESIGN.md §4.1). Arithmetic crosses via SQL or money.ts, never Number()/parseFloat.
 */
import pg from "pg";

// numeric (1700) parses to float, rounds; int8 (20) exceeds MAX_SAFE_INTEGER
// (pg already strings it — every id is a bigint too); date (1082) parses at
// local midnight, breaking as-of queries west of UTC. timestamp/timestamptz
// stay Date: real instants, compared in SQL.
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
  const pool = new pg.Pool({
    connectionString,
    // Bounded so `/healthz` reports unreachable rather than hanging past the
    // Compose healthcheck.
    connectionTimeoutMillis: 5_000,
    // The database stores UTC regardless of the container clock (DESIGN.md §10).
    options: "-c timezone=UTC",
  });

  const reportConnectionError = (error: Error): void => {
    console.error("Postgres connection error:", error);
  };

  // pg-pool drops its idle-error listener while a client is checked out (the
  // poller holds one across network calls) — pool catches idle failures,
  // client catches that gap. Detach on release or an idle death double-reports.
  pool.on("error", reportConnectionError);
  pool.on("acquire", (client) => {
    client.on("error", reportConnectionError);
  });
  pool.on("release", (_error, client) => {
    client.removeListener("error", reportConnectionError);
  });

  return pool;
}
