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

  // A dropped connection must not be a dropped process.
  //
  // Postgres restarting, a `pg_terminate_backend`, or an idle connection reaped
  // by a proxy all reach `pg` as an `error` event on an EventEmitter. An
  // `error` event with no listener is rethrown by Node, and there is no
  // `uncaughtException` net here on purpose (three deliberate fail-closed exits
  // would be masked by one), so the whole application exits — including the
  // request that was being served and every other connection in the pool.
  //
  // BOTH handlers are load-bearing. They cover disjoint halves of a client's
  // life, and each was measured to leave the other half fatal:
  //
  //   client state | pool handler only | client handler only | both
  //   idle in pool | survived          | DIED                | survived
  //   checked out  | DIED              | survived            | survived
  //
  // The seam is `pg-pool`, which attaches its own `error` listener to an idle
  // client and *removes it on checkout* (`pg-pool/index.js:344`). So while a
  // client is idle its errors arrive re-emitted on the pool, and while it is
  // checked out they arrive on the client and nowhere else. The price poller
  // holds a client across a network round trip to the quote provider
  // (`price-poller.server.ts`), which is exactly the second window.
  //
  // Deleting either one reintroduces the crash on the half it covers. That the
  // client handler logs first on an idle drop is not evidence the pool handler
  // is dead code: `pg-pool`'s own idle listener re-emits on the pool afterwards,
  // and with no handler there the process still dies.
  pool.on("error", (error) => {
    console.error("Postgres pool error on an idle client; the pool will reconnect.", error);
  });

  // `connect`, not `acquire`. `acquire` fires *before* the idle listener is
  // removed (`pg-pool/index.js:340` precedes `:344`), so a handler that checks
  // `listenerCount("error")` there never sees zero and never attaches. And
  // because a pooled client is acquired many times, attaching on every acquire
  // adds a listener per checkout — measured at 13 after 13 acquires, past
  // Node's leak warning at 11. `connect` fires exactly once per physical
  // client, which is the lifetime this handler wants.
  //
  // Swallowing is safe: `pg` calls `_errorAllQueries` immediately before
  // `emit('error')` (`pg/lib/client.js:421-422`), so an in-flight query is
  // already rejected by the time this runs and no caller is left hanging.
  // The message deliberately does not say "while checked out". `connect` fires
  // before the idle listener is removed too, so an *idle* client's error also
  // reaches this handler — first, with the pool handler logging after it. Both
  // lines on one drop is the expected shape, and neither may claim a state it
  // cannot know.
  pool.on("connect", (client) => {
    client.on("error", (error) => {
      console.error("Postgres client error; the client will be discarded.", error);
    });
  });

  return pool;
}
