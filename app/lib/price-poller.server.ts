/**
 * The refresh loop (DESIGN.md §6.2), in the app's own process (§10). Cadence is a row
 * (`0008_refresh_cadence.sql`), re-read each tick and re-armed — a save needs no restart.
 * Market hours gate only quotes (ADR-0011): a weekend tick still runs the backfill batch, and
 * writes no `price_poll` row because it attempted no quotes.
 *
 * Hazards handled: Vite HMR strands timers, so the handle sits on `globalThis`; two processes can
 * overlap, so each tick takes an advisory lock; a tick that outruns its interval is dropped, never
 * queued — queued fetches against an unofficial API are how an instance gets rate-limited.
 */
import { getConfig } from "../../server/config.ts";
import { isMarketOpen } from "./market-hours.ts";
import { socketProvider } from "./provider-socket.server.ts";
import { runRefresh } from "./refresh.server.ts";
import { readRefreshCadence } from "./settings.server.ts";

import type { BackfillReport } from "./prices.server.ts";
import type { PriceProvider } from "./price-provider.server.ts";

/** `globalThis` slot: a module-scope binding does not survive Vite's HMR invalidation. */
const SLOT = Symbol.for("portfolio.pricePoller");

/** What `0008_refresh_cadence.sql` seeds, kept in step by hand; the first tick corrects it. */
const SEEDED_CADENCE_MINUTES = 15;

type PollerState = {
  timer: ReturnType<typeof setInterval> | undefined;
  /** What the current timer was armed with, so a tick can tell a moved dial. */
  minutes: number;
  running: boolean;
  /** On the slot, not only in the tick's closure: {@link requestRefresh} reaches it from outside. */
  provider: PriceProvider;
};

type PollerHost = typeof globalThis & { [SLOT]?: PollerState };

/**
 * Re-arm at a moved cadence; replacing the interval resets its phase, as the Settings form
 * promises. The identity check stops a tick that was in flight when `stopPricePoller` ran from
 * arming a timer on a forgotten state — it would poll forever with no handle to clear it by.
 */
function retime(state: PollerState, minutes: number): void {
  if ((globalThis as PollerHost)[SLOT] !== state) return;

  clearInterval(state.timer);
  state.timer = setInterval(() => void tick(state, false), minutes * 60 * 1000);
  state.timer.unref?.();
  state.minutes = minutes;
}

/** Every failure path warns and returns: a timer has no caller to catch a throw (§6.1). */
async function tick(state: PollerState, quotesRegardless: boolean): Promise<void> {
  if (state.running) return;

  state.running = true;

  try {
    const config = getConfig();

    // The calendar gates quotes only, and being wrong cannot corrupt anything (`market-hours.ts`).
    const quotes = quotesRegardless || isMarketOpen(new Date(), config.MARKET_TIMEZONE);

    // Own catch: a failed read must not move the cadence — the last known value stands.
    const minutes = await readRefreshCadence().catch((error: unknown) => {
      console.error("Refresh cadence could not be read; keeping the current one:", error);
      return state.minutes;
    });
    if (minutes !== state.minutes) retime(state, minutes);

    // `runRefresh` owns the lock, and logs `busy`/`error` itself; only `done` has a report.
    const run = await runRefresh({ quotes }, state.provider);
    if (run.status === "done") {
      // One line per attempt at quotes, always: a log that speaks only on failure cannot tell a
      // quiet loop from a dead one. Stale > 0 warns — the line an operator greps for.
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
 * Only written when the batch attempted or failed something: a line on every idle tick would
 * stop "no price line in the log" meaning what `docs/operating.md` says it means.
 * "Failed" counts calls that failed, not the three refusals, which are answers.
 */
function logBackfill(report: BackfillReport): void {
  const failed = report.outcomes.provider_failed;
  if (report.attempted === 0 && !report.batchFailed) return;

  const summary =
    `Price backfill: ${report.attempted} attempted, ${report.written} closes written, ` +
    `${failed} failed.${report.batchFailed ? " The batch itself failed; see the line above." : ""}`;

  if (failed > 0 || report.batchFailed) console.warn(summary);
  else console.info(summary);
}

/**
 * Start the loop, once per process. Idempotent because the call site is a request path — there is
 * no server entry file to hook under `react-router-serve` (§9), so a root **middleware**
 * (`app/root.tsx`) starts it: the framework runs middleware for every request, resource routes
 * included, where a loader would not (`/healthz` has no `default`/`ErrorBoundary`, so its parent
 * loader never runs). No immediate poll: a crash-looping container would fetch on every boot.
 * `provider` is resolved lazily, inside the `try` below, so a middleware calling this on every
 * request never lets a throw from building `socketProvider()` escape as an uncaught response.
 */
export function startPricePoller(provider?: PriceProvider): void {
  const host = globalThis as PollerHost;
  if (host[SLOT] !== undefined) return;

  try {
    const state: PollerState = {
      running: false,
      minutes: SEEDED_CADENCE_MINUTES,
      timer: undefined,
      provider: provider ?? socketProvider(),
    };
    state.timer = setInterval(() => void tick(state, false), SEEDED_CADENCE_MINUTES * 60 * 1000);

    // A pending interval holds the event loop open, keeping a container alive through shutdown.
    state.timer.unref?.();

    host[SLOT] = state;
  } catch (error) {
    // Swallowed: the caller is now every request's middleware, not one page render — pricing
    // failing to arm must never turn into a refused request.
    console.error("Price poller did not start; prices will not refresh:", error);
  }
}

/**
 * Run a refresh now, off the schedule — what an upload asks for once its transaction commits.
 * The tick's own body with quotes forced, not a second copy: same flag, same lock, same log lines.
 *
 * Never rejects (nothing handles `unhandledRejection`, and Node 24 exits on one). Dropped silently
 * when a tick is already running; logged when the poller was never started in this process, which
 * is the case an operator would otherwise wonder about.
 */
export function requestRefresh(): void {
  const state = (globalThis as PollerHost)[SLOT];

  if (state === undefined) {
    // Not the `Price refresh` stem `docs/operating.md` reserves for a refresh that ran.
    console.info(
      "A refresh was requested before the price poller started in this process; " +
        "it was dropped, and a later tick will do the work.",
    );
    return;
  }

  void tick(state, true);
}

/** Exported for the hot-update hook and for tests — a stray timer holds vitest's process open. */
export function stopPricePoller(): void {
  const host = globalThis as PollerHost;
  const state = host[SLOT];
  if (state === undefined) return;

  clearInterval(state.timer);
  delete host[SLOT];
}

// Dev only, erased from the production bundle: without it every save strands the old timer.
if (import.meta.hot) {
  import.meta.hot.dispose(() => stopPricePoller());
}
