/**
 * The fifteen-minute refresh loop (DESIGN.md §6.2), in the app's own process.
 *
 * §10 chose an in-process scheduler over a worker container — "one process to
 * deploy, one place to read logs" — and states the trade-off it accepts: a
 * restart mid-session misses a poll until the next tick. That is why there is
 * no third service in `compose.yaml`.
 *
 * Nothing in this codebase had a background timer before, so the three hazards
 * a timer brings are handled here rather than assumed away:
 *
 * **Two timers in one process.** `react-router dev` re-executes the server
 * module graph on every edit, and a module-scope `let` is re-initialised each
 * time — so the usual `??=` singleton the rest of this codebase uses would leak
 * a timer per save, each polling on its own schedule. The handle is pinned to
 * `globalThis` instead, which Vite does not reset, and disposed explicitly on
 * hot update.
 *
 * **Two timers in two processes.** A restart can overlap a still-shutting-down
 * container, and a determined operator can run two. Each tick takes a Postgres
 * advisory lock and skips itself if another holder has it — the same guard
 * `server/migrations.ts` uses against two migration runners racing, with a
 * different arbitrary key.
 *
 * **A tick that outlives its interval.** A slow provider must not stack
 * requests. Ticks are serialised by a flag, and a tick that arrives while one
 * is running is dropped rather than queued: at a fifteen-minute cadence the
 * next one is along shortly, and a queue of pending fetches against an
 * unofficial API is how an instance gets rate-limited.
 *
 * `/healthz` deliberately reports none of this. `app/routes/healthz.ts` already
 * refuses to check the price provider, on the grounds that a health check
 * failing during a third-party outage would make Compose restart a perfectly
 * healthy app. Poller state is the same argument.
 */
import type pg from "pg";

import { getConfig } from "../../server/config.ts";
import { getDb, getPool } from "./db.server.ts";
import { isMarketOpen } from "./market-hours.ts";
import { refreshQuotes } from "./prices.server.ts";
import { yahooPriceProvider, type PriceProvider } from "./price-provider.server.ts";

/**
 * The lock every poller tick contends for.
 *
 * Arbitrary, and must not change — and must not equal the migration runner's
 * `7295380114023641`, or a cold start would have a poll and a migration
 * blocking each other for no reason.
 */
const ADVISORY_LOCK_KEY = "7295380114023642";

/**
 * Where the timer is kept.
 *
 * A `Symbol.for` slot on `globalThis`, not a module-scope binding, because a
 * module-scope binding does not survive Vite's HMR invalidation — see the
 * module comment. In production this is simply a global that gets written once.
 */
const SLOT = Symbol.for("portfolio.pricePoller");

type PollerState = {
  timer: ReturnType<typeof setInterval>;
  running: boolean;
};

type PollerHost = typeof globalThis & { [SLOT]?: PollerState };

/**
 * Run one refresh, if this process is the one that should.
 *
 * Every failure path here is a warning and a return, never a throw. This is
 * called from a timer with no caller to catch it, and an unhandled rejection
 * would take the process down over a third-party outage — precisely what §6.1
 * says owning `price_daily` is supposed to protect against.
 */
async function tick(state: PollerState, provider: PriceProvider): Promise<void> {
  if (state.running) return;

  const config = getConfig();

  // The calendar decides only whether to spend a request. Being wrong here
  // cannot corrupt anything — see `market-hours.ts`.
  if (!isMarketOpen(new Date(), config.MARKET_TIMEZONE)) return;

  state.running = true;

  // A dedicated connection: an advisory lock belongs to the session that took
  // it, so taking and releasing it have to happen on the same client. The work
  // itself goes through Kysely on a different connection, which is fine — the
  // lock guards the decision to run, not the rows.
  //
  // Declared before the `try` and acquired inside it. Acquiring it outside
  // would put a throw — a database that is briefly unreachable is the ordinary
  // case — above the `finally` that clears `running`, and the loop would then
  // be wedged for the lifetime of the process by one failed connect.
  let client: pg.PoolClient | undefined;
  let broken = false;

  try {
    client = await getPool().connect();

    const held = await client.query<{ locked: boolean }>(
      `select pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) as locked`,
    );

    // Another process is mid-refresh. Not an error: the prices will be fresh
    // either way, which is the only thing this loop is for.
    if (!held.rows[0]?.locked) return;

    try {
      const report = await refreshQuotes(provider, config.MARKET_TIMEZONE, getDb());

      // One line per attempt, always — "prices stopped updating" has to be
      // answerable from `docker compose logs` alone, and a log that only speaks
      // up on failure cannot distinguish a healthy quiet loop from a dead one.
      // A tick that left something stale is a warning rather than information,
      // because it is the line an operator is looking for.
      const summary = `Price refresh: ${report.priced} of ${report.requested} priced, ${report.stale} stale, ${report.closes} closes written.`;
      if (report.stale > 0) console.warn(summary);
      else console.info(summary);
    } finally {
      await client.query(`select pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
    }
  } catch (error) {
    // A session-level lock outlives the query that failed but not the session
    // holding it, and a connection handed back to the pool keeps its session.
    // If anything above threw, this connection may still hold the lock, and
    // returning it to the pool would block every future tick forever — so it
    // is destroyed rather than reused.
    broken = true;
    console.error("Price refresh failed; last known prices are kept:", error);
  } finally {
    client?.release(broken);
    state.running = false;
  }
}

/**
 * Start the loop, once per process.
 *
 * Idempotent and cheap on every call after the first, because the natural place
 * to call it is a request path — there is no server entry file to hook, since
 * the app is served by `react-router-serve` over the framework's own build
 * (§9). `app/root.tsx`'s loader is the ancestor of every route, so the first
 * page render starts the timer and every one after it is a property lookup.
 *
 * Deliberately does not poll immediately on start. A container that crash-loops
 * would otherwise fetch on every boot, and the first tick is at most one
 * interval away.
 *
 * @param provider injected for the tests; defaults to the live one.
 */
export function startPricePoller(provider: PriceProvider = yahooPriceProvider()): void {
  const host = globalThis as PollerHost;
  if (host[SLOT] !== undefined) return;

  try {
    const minutes = getConfig().PRICE_POLL_INTERVAL_MINUTES;

    const state: PollerState = {
      running: false,
      timer: setInterval(() => void tick(state, provider), minutes * 60 * 1000),
    };

    // Node holds the event loop open for a pending interval, which would keep a
    // container alive through a shutdown it had already been asked to perform.
    state.timer.unref?.();

    host[SLOT] = state;
  } catch (error) {
    // Swallowed on purpose. The caller is a page render, and a background
    // refresh loop failing to start is not a reason a family member cannot see
    // their net worth. `getConfig()` is the realistic thrower here — the
    // container validates configuration before serving, so reaching this means
    // something unusual, and the operator wants it in the log rather than on
    // the page.
    console.error("Price poller did not start; prices will not refresh:", error);
  }
}

/**
 * Stop the loop and forget it.
 *
 * Exported for the hot-update hook below and for tests, which must not leave a
 * timer running across files — `vitest` would hold the process open.
 */
export function stopPricePoller(): void {
  const host = globalThis as PollerHost;
  const state = host[SLOT];
  if (state === undefined) return;

  clearInterval(state.timer);
  delete host[SLOT];
}

// Dev only, and erased from the production bundle. Without it, every save
// during `react-router dev` would strand the previous module's timer — still
// holding a closure over the old code, still polling.
if (import.meta.hot) {
  import.meta.hot.dispose(() => stopPricePoller());
}
