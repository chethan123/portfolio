/**
 * The refresh loop (DESIGN.md §6.2), in the app's own process, on the cadence
 * chosen at Settings → Prices. §10 chose in-process over a worker container —
 * "one process to deploy, one place to read logs" — accepting that a restart
 * mid-session misses a poll until the next tick; hence no third service in
 * `compose.yaml`.
 *
 * **The cadence is a row, not an environment variable**
 * (`0008_refresh_cadence.sql`): a tick re-reads it and re-arms when it moved —
 * the whole of how a save takes effect, no restart, no signal; every process
 * converges within one old cadence. The read sits behind the market-hours
 * gate, so a weekend stays free of database traffic.
 *
 * The three hazards a background timer brings, handled rather than assumed
 * away. **Two timers in one process**: `react-router dev` re-executes the
 * server module graph per edit, so the usual module-scope `??=` singleton
 * would leak a timer per save — the handle is pinned to `globalThis`, which
 * Vite does not reset, and disposed on hot update. **Two timers in two
 * processes**: a restart can overlap a still-shutting-down container, so each
 * tick takes the advisory-lock guard `server/migrations.ts` uses, different
 * key. **A tick that outlives its interval**: ticks are serialised by a flag
 * and a colliding tick is dropped, not queued — a queue of pending fetches
 * against an unofficial API is how an instance gets rate-limited.
 *
 * `/healthz` reports none of this, for `app/routes/healthz.ts`'s reason: a
 * health check failing during a third-party outage would have Compose restart
 * a perfectly healthy app.
 */
import { getConfig } from "../../server/config.ts";
import { getDb } from "./db.server.ts";
import { isMarketOpen } from "./market-hours.ts";
import { refreshQuotes, withRefreshLock } from "./prices.server.ts";
import { yahooPriceProvider, type PriceProvider } from "./price-provider.server.ts";
import { readRefreshCadence } from "./settings.server.ts";

/**
 * Where the timer is kept: a `Symbol.for` slot on `globalThis`, because a
 * module-scope binding does not survive Vite's HMR invalidation (module
 * comment). In production, simply a global written once.
 */
const SLOT = Symbol.for("portfolio.pricePoller");

/**
 * Assumed cadence until a tick reads the row — the value
 * `0008_refresh_cadence.sql` seeds, kept in step by hand (`masking.ts`'s
 * arrangement). Reading the row here would put an async database call on the
 * first render's path; the first tick corrects the assumption.
 */
const SEEDED_CADENCE_MINUTES = 15;

type PollerState = {
  /** Undefined only in the moment between construction and arming, which the
   * tick's closure needs the state object to exist for. */
  timer: ReturnType<typeof setInterval> | undefined;
  /** What the current timer was armed with, so a tick can tell a moved dial. */
  minutes: number;
  running: boolean;
};

type PollerHost = typeof globalThis & { [SLOT]?: PollerState };

/**
 * Re-arm at a cadence the household just moved. Replacing the interval resets
 * its phase — the next tick lands one *new* cadence after the one that
 * noticed, as the Settings form promises. The identity check keeps a re-arm
 * from resurrecting a stopped poller: a tick in flight when `stopPricePoller`
 * ran holds a state object the slot has forgotten, and arming a timer on it
 * would poll forever with no handle left to clear it by.
 */
function retime(state: PollerState, provider: PriceProvider, minutes: number): void {
  if ((globalThis as PollerHost)[SLOT] !== state) return;

  clearInterval(state.timer);
  state.timer = setInterval(() => void tick(state, provider), minutes * 60 * 1000);
  state.timer.unref?.();
  state.minutes = minutes;
}

/**
 * Run one refresh, if this process is the one that should. Every failure path
 * is a warning and a return, never a throw: called from a timer with no
 * caller to catch it, and an unhandled rejection would take the process down
 * over a third-party outage — what owning `price_daily` protects against
 * (§6.1).
 */
async function tick(state: PollerState, provider: PriceProvider): Promise<void> {
  if (state.running) return;

  const config = getConfig();

  // The calendar decides only whether to spend a request; being wrong cannot
  // corrupt anything (`market-hours.ts`). Above the cadence read on purpose:
  // a weekend must not cost a round trip every interval, and a cadence saved
  // while the market is shut applies at the first in-session tick anyway.
  if (!isMarketOpen(new Date(), config.MARKET_TIMEZONE)) return;

  state.running = true;

  // Read with its own catch: a briefly unreachable database fails the refresh
  // below in its own well-handled way, and a failed read must not change the
  // cadence — the last known value stands until the row says otherwise.
  const minutes = await readRefreshCadence().catch((error: unknown) => {
    console.error("Refresh cadence could not be read; keeping the current one:", error);
    return state.minutes;
  });
  if (minutes !== state.minutes) retime(state, provider, minutes);

  try {
    // `null` when another caller — the other container, or a pressed Refresh
    // — is already doing it. Not an error: the prices are fresh either way.
    await withRefreshLock(async () => {
      const report = await refreshQuotes(provider, config.MARKET_TIMEZONE, getDb());

      // One line per attempt, always: "prices stopped updating" must be
      // answerable from `docker compose logs` alone, and a log that only
      // speaks on failure cannot tell a healthy quiet loop from a dead one.
      // Stale > 0 logs as a warning — the line an operator is looking for.
      const summary = `Price refresh: ${report.priced} of ${report.requested} priced, ${report.stale} stale, ${report.closes} closes written, ${report.observed} new.`;
      if (report.stale > 0) console.warn(summary);
      else console.info(summary);
    });
  } catch (error) {
    console.error("Price refresh failed; last known prices are kept:", error);
  } finally {
    state.running = false;
  }
}

/**
 * Start the loop, once per process. Idempotent and cheap after the first
 * call, because the natural call site is a request path — no server entry
 * file to hook under `react-router-serve` (§9); `app/root.tsx`'s loader is
 * every route's ancestor, so the first render starts the timer and each call
 * after is a property lookup. Deliberately no immediate poll: a crash-looping
 * container would fetch on every boot, and the first tick is at most one
 * interval away.
 *
 * @param provider injected for the tests; defaults to the live one.
 */
export function startPricePoller(provider: PriceProvider = yahooPriceProvider()): void {
  const host = globalThis as PollerHost;
  if (host[SLOT] !== undefined) return;

  try {
    // Armed at the seeded cadence: reading the row here would put an async
    // database call on a render's path. The first tick re-arms if the
    // household had moved the dial.
    const state: PollerState = {
      running: false,
      minutes: SEEDED_CADENCE_MINUTES,
      timer: undefined,
    };
    state.timer = setInterval(() => void tick(state, provider), SEEDED_CADENCE_MINUTES * 60 * 1000);

    // Node holds the event loop open for a pending interval, which would keep
    // a container alive through a shutdown it was already asked to perform.
    state.timer.unref?.();

    host[SLOT] = state;
  } catch (error) {
    // Swallowed on purpose: the caller is a page render, and a refresh loop
    // failing to start is not a reason a family member cannot see their net
    // worth.
    console.error("Price poller did not start; prices will not refresh:", error);
  }
}

/**
 * Stop the loop and forget it. Exported for the hot-update hook below and for
 * tests, which must not leave a timer running across files — `vitest` would
 * hold the process open.
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
