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
 * converges within one old cadence.
 *
 * **A weekend is no longer free of database traffic** (ADR-0011). The
 * market-hours check used to return before the tick touched anything; it now
 * decides only whether *quotes* are asked for, because a refresh is quotes and
 * then one bounded backfill batch, and a statement uploaded on a Saturday
 * should be valued by Monday's open rather than after it. So a weekend tick
 * costs the cadence read and the gap query, and a request to the feed only when
 * there is a gap to fill. It writes no `price_poll` row: a poll is an attempt
 * at quotes, and this one attempted none.
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
import { isMarketOpen } from "./market-hours.ts";
import { yahooPriceProvider, type PriceProvider } from "./price-provider.server.ts";
import { runRefresh } from "./refresh.server.ts";
import { readRefreshCadence } from "./settings.server.ts";

import type { BackfillReport } from "./prices.server.ts";

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
  /**
   * The injected provider, on the slot rather than only in the `setInterval`
   * closure: {@link requestRefresh} has to reach it from outside a tick that
   * is already armed.
   */
  provider: PriceProvider;
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
function retime(state: PollerState, minutes: number): void {
  if ((globalThis as PollerHost)[SLOT] !== state) return;

  clearInterval(state.timer);
  state.timer = setInterval(() => void tick(state, false), minutes * 60 * 1000);
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
async function tick(state: PollerState, quotesRegardless: boolean): Promise<void> {
  if (state.running) return;

  state.running = true;

  try {
    const config = getConfig();

    // The calendar decides only whether to spend a request on *quotes*; being
    // wrong cannot corrupt anything (`market-hours.ts`). It no longer decides
    // whether the tick runs: the backfill batch below rides a tick at any hour,
    // and the cadence read has come out from behind the gate with it — the
    // round trip a weekend must not cost is no longer avoidable, because the
    // gap query is one too.
    const quotes = quotesRegardless || isMarketOpen(new Date(), config.MARKET_TIMEZONE);

    // Read with its own catch: a briefly unreachable database fails the refresh
    // below in its own well-handled way, and a failed read must not change the
    // cadence — the last known value stands until the row says otherwise.
    const minutes = await readRefreshCadence().catch((error: unknown) => {
      console.error("Refresh cadence could not be read; keeping the current one:", error);
      return state.minutes;
    });
    if (minutes !== state.minutes) retime(state, minutes);

    // `runRefresh` owns the lock and the catch around `refreshPrices` itself
    // (issue #159): `busy` (another caller — the other container, or a
    // pressed Refresh — is already doing it) and `error` (the database or the
    // lock; `runRefresh` has already logged its own line) need nothing further
    // here. Only a `done` run has a report to log.
    const run = await runRefresh({ quotes }, state.provider);
    if (run.status === "done") {
      // One line per attempt at quotes, always: "prices stopped updating" must
      // be answerable from `docker compose logs` alone, and a log that only
      // speaks on failure cannot tell a healthy quiet loop from a dead one.
      // Stale > 0 logs as a warning — the line an operator is looking for.
      if (run.report.quotes !== null) {
        const quoted = run.report.quotes;
        const summary = `Price refresh: ${quoted.priced} of ${quoted.requested} priced, ${quoted.stale} stale, ${quoted.closes} closes written, ${quoted.observed} new.`;
        if (quoted.stale > 0) console.warn(summary);
        else console.info(summary);
      }

      logBackfill(run.report.backfill);
    }
  } catch (error) {
    console.error("Price refresh failed; last known prices are kept:", error);
  } finally {
    state.running = false;
  }
}

/**
 * The batch's own line, written only when the batch attempted or failed
 * something.
 *
 * Narrower than the quotes' line above, which speaks on every attempt: a tick
 * at any hour whose gap query found nothing would otherwise write a line, and
 * "no price line in the log" would stop meaning what `docs/operating.md` says
 * it means.
 *
 * "Failed" is the count of attempts whose *call* failed, and not of the three
 * refusals — a delisted ticker, a foreign listing and an unapplied split are
 * answers rather than failures, and the ledger names each one for the person
 * reading Settings → Prices. A failure of either kind is a warning, which is
 * the line an operator greps for.
 */
function logBackfill(report: BackfillReport): void {
  const failed = report.outcomes.provider_failed;
  if (report.attempted === 0 && !report.batchFailed) return;

  const summary =
    `Price backfill: ${report.attempted} attempted, ${report.written} closes written, ` +
    `${failed} failed.${report.batchFailed ? " The batch itself failed; see the error above." : ""}`;

  if (failed > 0 || report.batchFailed) console.warn(summary);
  else console.info(summary);
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
      provider,
    };
    state.timer = setInterval(() => void tick(state, false), SEEDED_CADENCE_MINUTES * 60 * 1000);

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
 * Run a refresh now, off the timer's schedule — what an upload asks for once
 * its transaction has committed, so the statement it just landed is priced
 * without waiting for the next tick.
 *
 * The tick's own body with quotes forced, not a second copy of it: the same
 * `running` flag, the same lock, the same log lines. Quotes regardless of the
 * calendar, because the person who just uploaded is present and a request is
 * what they are implicitly asking for.
 *
 * **Returns nothing and never rejects.** Nothing registers an
 * `unhandledRejection` handler and Node 24 exits the process on one, so a
 * request that cannot be honoured returns rather than throwing. Two ways it is
 * not honoured, both of which cost at most one more tick: a tick or another
 * request is already running, which is dropped **silently**, exactly as an
 * overlapping tick is — a line per dropped request would make a busy instance
 * noisier without telling anyone anything they can act on; and the poller has
 * not been started in this process, which does log, because
 * it is the one an operator might otherwise wonder about: a fresh process sees
 * it when an action runs before any loader has started the poller
 * (`app/root.tsx` starts it from one), and so does every test that never starts
 * it — which is what keeps a test from reaching a provider through this.
 */
export function requestRefresh(): void {
  const state = (globalThis as PollerHost)[SLOT];

  if (state === undefined) {
    // Deliberately not the `Price refresh` stem `docs/operating.md` reserves
    // for a refresh the poller actually ran; nothing ran here.
    console.info(
      "A refresh was requested before the price poller started in this process; " +
        "it was dropped, and a later tick will do the work.",
    );
    return;
  }

  void tick(state, true);
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
