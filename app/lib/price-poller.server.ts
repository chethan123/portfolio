/**
 * The refresh loop (DESIGN.md §6.2), in the app's own process (§10). Cadence is a row
 * (`0008_refresh_cadence.sql`), re-read each tick and re-armed — a save needs no restart.
 * The scheduled quote window gates only quotes (ADR-0011): a weekend tick still runs the backfill
 * batch, and writes no `price_poll` row because it attempted no quotes.
 *
 * Hazards handled: Vite HMR strands timers, so the one built instance sits on `globalThis`; two
 * processes can overlap, so each tick takes an advisory lock; a tick that outruns its interval is
 * dropped, never queued — queued fetches against an unofficial API are how an instance gets
 * rate-limited.
 *
 * The instance also owns `GET /healthz`'s scheduler and quote status (spec price-health/03):
 * `lastTickStartedAt` and `lastObservation`, read out defensively by its `snapshot()`. Built by
 * {@link createPricePoller}, which takes the clock, cadence read, refresh and log, so a test
 * awaits `tick()` instead of faking timers (spec 0025).
 * The derivation itself lives in `price-health.ts`, which this module only supplies types from.
 */
import { getConfig } from "../../server/config.ts";
import { isScheduledQuoteWindow } from "./market-hours.ts";
import { socketProvider } from "./provider-socket.server.ts";
import { runRefresh, type RefreshRun } from "./refresh.server.ts";
import { readRefreshCadence } from "./settings.server.ts";

import type { BackfillReport, DividendReport } from "./prices.server.ts";
import type { PollerSnapshot, TickObservation } from "./price-health.ts";
import type { PriceProvider } from "./price-provider.server.ts";

/** `globalThis` slot: a module-scope binding does not survive Vite's HMR invalidation. */
const SLOT = Symbol.for("portfolio.pricePoller");

/** What `0008_refresh_cadence.sql` seeds, kept in step by hand; the first tick corrects it. */
const SEEDED_CADENCE_MINUTES = 15;

export type PricePoller = {
  /** Arms the timer at the seeded cadence and runs no tick. */
  start(): void;
  /** Clears the timer, final: a stopped poller never re-arms. */
  stop(): void;
  /** One scheduled tick; quotes only inside the scheduled quote window. Resolves when done, or at
   * once when dropped by a running tick. Never rejects. */
  tick(): Promise<void>;
  /** The same body with quotes forced. */
  requestRefresh(): Promise<void>;
  /** A copy, never the live state. */
  snapshot(): NonNullable<PollerSnapshot>;
};

type PollerHost = typeof globalThis & { [SLOT]?: PricePoller };

/** The loop as a built instance; its `tick()` promise is the completion signal. {@link startPricePoller}
 * builds the one the app runs. */
export function createPricePoller(dependencies: {
  provider: PriceProvider;
  clock: () => Date;
  readCadence: () => Promise<number>;
  refresh: (
    options: { quotes: boolean; dividends: boolean },
    now: Date,
    provider: PriceProvider,
  ) => Promise<RefreshRun>;
  log?: Pick<Console, "info" | "warn" | "error">;
}): PricePoller {
  const { provider, clock, readCadence, refresh, log = console } = dependencies;

  let timer: ReturnType<typeof setInterval> | undefined;
  /** What the current timer was armed with, so a tick can tell a moved dial. */
  let minutes = SEEDED_CADENCE_MINUTES;
  let running = false;
  let stopped = false;
  /** Stamped by {@link arm} and by every tick past the running guard, scheduled or requested alike
   * — what `scheduler` is measured from (spec price-health/03). Two fields, deliberately, and no
   * "has completed a tick" third one; 0021's Rejected section is why. A placeholder until `start`,
   * never the injected clock: a scripted clock's reads belong to `start` and the ticks. */
  let lastTickStartedAt = new Date(0);
  /** The last tick that observed a provider outcome; `undefined` before any has. Left untouched by
   * a `busy` tick, which observed none — see {@link run}'s `finally`. */
  let lastObservation: TickObservation | undefined;

  /**
   * The one place a timer is created, so the interval, `minutes` and `lastTickStartedAt` can never
   * drift out of step with each other: whatever arms the timer stamps the phase it armed, the same
   * way replacing the interval resets its own phase.
   *
   * `stopped` is checked first: it is what stops a tick that was in flight when `stop` ran from
   * arming a timer nothing can clear (spec 0025 §2.6).
   */
  function arm(nextMinutes: number): void {
    if (stopped) return;

    // Read before the interval exists: a throw here must not leave one nothing holds.
    const armedAt = clock();
    clearInterval(timer);
    timer = setInterval(() => void run(false), nextMinutes * 60 * 1000);
    // A pending interval would hold the event loop open, keeping a container alive through shutdown.
    timer.unref?.();
    minutes = nextMinutes;
    lastTickStartedAt = armedAt;
  }

  /** Every failure path warns and returns: a timer has no caller to catch a throw (§6.1). */
  async function run(quotesRegardless: boolean): Promise<void> {
    if (running) return;
    running = true;

    // Assigned at specific points below, never in more than one place per tick, and committed once —
    // see the `finally`. Left `undefined` by a `busy` run: the advisory lock was held, so this tick
    // observed no provider outcome to report.
    let pending: TickObservation | undefined;

    try {
      const now = clock();
      lastTickStartedAt = now;

      const config = getConfig();

      // The calendar gates quotes only, and being wrong cannot corrupt anything (`market-hours.ts`).
      const quotes = quotesRegardless || isScheduledQuoteWindow(now, config.MARKET_TIMEZONE);
      // Recorded here, before any provider or database work, so a later backfill failure in this
      // same tick cannot overwrite what the calendar actually decided.
      if (!quotes) pending = { outcome: "market_closed" };

      // Own catch: a failed read must not move the cadence — the last known value stands.
      const nextMinutes = await readCadence().catch((error: unknown) => {
        log.error("Refresh cadence could not be read; keeping the current one:", error);
        return minutes;
      });
      // Re-arms a running schedule only: a tick on a poller never started must not start one.
      if (nextMinutes !== minutes && timer !== undefined) arm(nextMinutes);

      // `refresh` owns the lock, and logs `busy`/`error` itself; only `done` has a report.
      // The sweep runs every tick, calendar or not: a dividend goes ex on any date, and the batch
      // bound is what paces it. Only a person's own button press skips it (`app/routes/refresh.ts`).
      const result = await refresh({ quotes, dividends: true }, now, provider);
      if (result.status === "done") {
        // One line per attempt at quotes, always: a log that speaks only on failure cannot tell a
        // quiet loop from a dead one. Stale > 0 warns — the line an operator greps for.
        if (result.report.quotes !== null) {
          const quoted = result.report.quotes;
          pending = {
            outcome: "quoted",
            requested: quoted.requested,
            priced: quoted.priced,
            providerFailed: quoted.providerFailed,
          };

          const summary = `Price refresh: ${quoted.priced} of ${quoted.requested} priced, ${quoted.stale} stale, ${quoted.closes} closes written, ${quoted.observed} new.`;
          if (quoted.stale > 0) log.warn(summary);
          else log.info(summary);
        }
        // else: quotes were not asked for, and `pending` already holds the market-closed observation
        // recorded above.

        logBackfill(result.report.backfill);
        if (result.report.dividends !== null) logDividends(result.report.dividends);
      } else if (result.status === "error") {
        pending = { outcome: "error" };
      }
      // `busy`: no provider outcome was observed this tick, so `pending` is left exactly as it was —
      // `undefined`, or the market-closed observation this same tick already recorded.
    } catch (error) {
      log.error("Price refresh failed; last known prices are kept:", error);
      pending = { outcome: "error" };
    } finally {
      running = false;
      // Conditional, deliberately: committing `undefined` unconditionally here would wipe the
      // previous good observation on every `busy` tick and report `not_attempted` in its place — the
      // opposite of the rule.
      if (pending !== undefined) lastObservation = pending;
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

    if (failed > 0 || report.batchFailed) log.warn(summary);
    else log.info(summary);
  }

  /** {@link logBackfill}'s sibling — a different report shape, the same silence rule. */
  function logDividends(report: DividendReport): void {
    if (report.attempted === 0 && !report.batchFailed) return;

    const summary =
      `Price dividends: ${report.attempted} attempted, ${report.written} rates written, ` +
      `${report.refused} refused, ${report.failed} failed.` +
      `${report.batchFailed ? " The batch itself failed; see the line above." : ""}`;

    if (report.failed > 0 || report.batchFailed) log.warn(summary);
    else log.info(summary);
  }

  return {
    start() {
      arm(SEEDED_CADENCE_MINUTES);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      timer = undefined;
    },
    tick: () => run(false),
    requestRefresh: () => run(true),
    snapshot() {
      return {
        running,
        lastTickStartedAt: new Date(lastTickStartedAt.getTime()),
        minutes,
        lastObservation: lastObservation === undefined ? undefined : { ...lastObservation },
      };
    },
  };
}

/**
 * Pins one poller on the slot, once per process. Built and started inside the `try`, stored last,
 * so a throw from either leaves the slot empty. Exported for the test that hands it a failing
 * build.
 */
export function pinPricePoller(build: () => PricePoller): void {
  const host = globalThis as PollerHost;
  if (host[SLOT] !== undefined) return;

  try {
    const poller = build();
    poller.start();
    host[SLOT] = poller;
  } catch (error) {
    // Swallowed: the caller is now every request's middleware, not one page render — pricing
    // failing to arm must never turn into a refused request.
    console.error("Price poller did not start; prices will not refresh:", error);
  }
}

/**
 * Start the loop, once per process. Idempotent because the call site is a request path — there is
 * no server entry file to hook under `react-router-serve` (§9), so a root **middleware**
 * (`app/root.tsx`) starts it: the framework runs middleware for every request, resource routes
 * included, where a loader would not (`/healthz` has no `default`/`ErrorBoundary`, so its parent
 * loader never runs). No immediate poll: a crash-looping container would fetch on every boot.
 * `provider` is resolved lazily, inside the build {@link pinPricePoller} calls within its `try`, so
 * a middleware calling this on every request never lets a throw from building `socketProvider()`
 * escape as an uncaught response.
 */
export function startPricePoller(provider?: PriceProvider): void {
  pinPricePoller(() =>
    createPricePoller({
      provider: provider ?? socketProvider(),
      clock: () => new Date(),
      readCadence: readRefreshCadence,
      refresh: runRefresh,
    }),
  );
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
  const poller = (globalThis as PollerHost)[SLOT];

  if (poller === undefined) {
    // Not the `Price refresh` stem `docs/operating.md` reserves for a refresh that ran.
    console.info(
      "A refresh was requested before the price poller started in this process; " +
        "it was dropped, and a later tick will do the work.",
    );
    return;
  }

  void poller.requestRefresh();
}

/**
 * `GET /healthz`'s read of the pinned poller (spec price-health/03) — its {@link PricePoller.snapshot}.
 * No timer handle, no provider, no raw error, no symbol — only what
 * `price-health.ts`'s `pricingHealth` needs. `undefined` when this process holds no poller slot at
 * all.
 */
export function readPollerSnapshot(): PollerSnapshot {
  return (globalThis as PollerHost)[SLOT]?.snapshot();
}

/** Exported for the hot-update hook and for tests — a stray timer holds vitest's process open. */
export function stopPricePoller(): void {
  const host = globalThis as PollerHost;
  const poller = host[SLOT];
  if (poller === undefined) return;

  poller.stop();
  delete host[SLOT];
}

// Dev only, erased from the production bundle: without it every save strands the old timer.
if (import.meta.hot) {
  import.meta.hot.dispose(() => stopPricePoller());
}
