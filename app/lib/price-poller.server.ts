/**
 * The refresh loop (DESIGN.md §6.2), in the app's own process, on the cadence
 * the household chose at Settings → Prices.
 *
 * §10 chose an in-process scheduler over a worker container — "one process to
 * deploy, one place to read logs" — and states the trade-off it accepts: a
 * restart mid-session misses a poll until the next tick. That is why there is
 * no third service in `compose.yaml`.
 *
 * **The cadence is a row, not an environment variable** (`0008_refresh_cadence.sql`
 * has the argument), so a tick re-reads it and re-arms the timer when it moved.
 * That is the whole of how a save takes effect: no restart, no signal between
 * processes — every process holding a timer converges within one old cadence,
 * because each one's next tick reads the same row. The read sits behind the
 * market-hours gate with the rest of the work, so a weekend stays free of
 * database traffic and a cadence saved on one applies at the first in-session
 * tick, which is also the first moment it could matter.
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
import { getConfig } from "../../server/config.ts";
import { getDb } from "./db.server.ts";
import { isMarketOpen } from "./market-hours.ts";
import { refreshQuotes, withRefreshLock } from "./prices.server.ts";
import { yahooPriceProvider, type PriceProvider } from "./price-provider.server.ts";
import { readRefreshCadence } from "./settings.server.ts";

/**
 * Where the timer is kept.
 *
 * A `Symbol.for` slot on `globalThis`, not a module-scope binding, because a
 * module-scope binding does not survive Vite's HMR invalidation — see the
 * module comment. In production this is simply a global that gets written once.
 */
const SLOT = Symbol.for("portfolio.pricePoller");

/**
 * What the timer assumes the cadence is until a tick has read the row — the
 * value `0008_refresh_cadence.sql` seeds, kept in step by hand the way
 * `masking.ts` keeps step with its check constraint. Reading the row here
 * instead would make starting the poller an async database operation on the
 * first page render's path; assuming the seed makes it a property write, and
 * the first tick corrects the assumption within fifteen minutes of boot.
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
 * Re-arm the timer at a cadence the household just moved.
 *
 * Replacing the interval resets its phase — the next tick lands one *new*
 * cadence after the one that noticed, which is what the Settings form promises.
 * The identity check is what keeps a re-arm from resurrecting a stopped poller:
 * a tick in flight when `stopPricePoller` ran holds a state object the slot has
 * already forgotten, and arming a timer on it would poll forever with no handle
 * left to clear it by.
 */
function retime(state: PollerState, provider: PriceProvider, minutes: number): void {
  if ((globalThis as PollerHost)[SLOT] !== state) return;

  clearInterval(state.timer);
  state.timer = setInterval(() => void tick(state, provider), minutes * 60 * 1000);
  state.timer.unref?.();
  state.minutes = minutes;
}

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
  // cannot corrupt anything — see `market-hours.ts`. It sits above the cadence
  // read on purpose: a weekend must not cost a database round trip every
  // interval, so a cadence saved while the market is shut applies at the first
  // in-session tick — the first moment it could matter.
  if (!isMarketOpen(new Date(), config.MARKET_TIMEZONE)) return;

  state.running = true;

  // The dial, as the household last left it. Read with its own catch rather
  // than the tick's: a database that is briefly unreachable will fail the
  // refresh below in its own well-handled way, and a read that failed must
  // not change the cadence — the last known value is the household's answer
  // until the row says otherwise.
  const minutes = await readRefreshCadence().catch((error: unknown) => {
    console.error("Refresh cadence could not be read; keeping the current one:", error);
    return state.minutes;
  });
  if (minutes !== state.minutes) retime(state, provider, minutes);

  try {
    // `null` when another caller — the other container, or a person who just
    // pressed Refresh — is already doing it. Not an error: the prices will be
    // fresh either way, which is the only thing this loop is for.
    await withRefreshLock(async () => {
      const report = await refreshQuotes(provider, config.MARKET_TIMEZONE, getDb());

      // One line per attempt, always — "prices stopped updating" has to be
      // answerable from `docker compose logs` alone, and a log that only speaks
      // up on failure cannot distinguish a healthy quiet loop from a dead one.
      // A tick that left something stale is a warning rather than information,
      // because it is the line an operator is looking for.
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
    // Armed at the seeded cadence rather than the row's: reading the row here
    // would make this an async database call on a page render's path. The
    // first tick reads the row and re-arms if the household had moved the
    // dial, so a non-default cadence is honoured within one seeded interval
    // of boot.
    const state: PollerState = {
      running: false,
      minutes: SEEDED_CADENCE_MINUTES,
      timer: undefined,
    };
    state.timer = setInterval(() => void tick(state, provider), SEEDED_CADENCE_MINUTES * 60 * 1000);

    // Node holds the event loop open for a pending interval, which would keep a
    // container alive through a shutdown it had already been asked to perform.
    state.timer.unref?.();

    host[SLOT] = state;
  } catch (error) {
    // Swallowed on purpose. The caller is a page render, and a background
    // refresh loop failing to start is not a reason a family member cannot see
    // their net worth. Nothing above throws in any run anyone has seen — the
    // guard survives because this is called with no caller to catch it.
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
