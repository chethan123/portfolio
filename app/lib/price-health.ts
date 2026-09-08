/**
 * `GET /healthz`'s pricing categories (spec price-health/03), derived from a snapshot of the price
 * poller's own live state. Plain `.ts`: no database, no request, no clock read and no `globalThis`
 * of its own — `now` is always a parameter, which is what lets the whole closed-set table below be
 * tested without Postgres or a faked global timer. `price-poller.server.ts` imports the types here,
 * never the reverse — this module ships to the browser and may not import a `.server` module.
 */

export type WorkerReachability = "available" | "unavailable";
export type SchedulerStatus = "not_started" | "running" | "on_schedule" | "overdue";
export type QuoteStatus =
  | "not_attempted"
  | "market_closed"
  | "ok"
  | "partial"
  | "failed"
  | "unknown";

/** What one tick saw. `busy` produces none: it observed no provider. */
export type TickObservation =
  | { outcome: "market_closed" }
  | { outcome: "quoted"; requested: number; priced: number; providerFailed: boolean }
  | { outcome: "error" };

/** The poller's live state, flattened. `undefined` is "no poller slot in this process". */
export type PollerSnapshot =
  | undefined
  | {
      running: boolean;
      lastTickStartedAt: Date;
      /** Cadence the current timer was armed with. */
      minutes: number;
      lastObservation: TickObservation | undefined;
    };

export type PricingHealth = {
  ok: boolean;
  worker: WorkerReachability;
  scheduler: SchedulerStatus;
  quotes: QuoteStatus;
};

/** Five minutes past a full cadence before a scheduler is called late. */
export const OVERDUE_GRACE_MINUTES = 5;

function schedulerStatus(snapshot: PollerSnapshot, now: Date): SchedulerStatus {
  if (snapshot === undefined) return "not_started";

  // Checked ahead of `running`, deliberately. `state.running` is cleared only in the tick's own
  // `finally` (price-poller.server.ts) and nothing else clears it, and the tick itself carries no
  // timeout of its own — the cadence read and the whole price transaction are unbounded, unlike the
  // worker's own 15/35-second call budgets. A tick that never returns would otherwise report
  // `running` forever, which is exactly the failure this endpoint exists to catch. This is the one
  // ordering a later "simplification" would put back.
  const overdueAfterMs = (snapshot.minutes + OVERDUE_GRACE_MINUTES) * 60_000;
  if (now.getTime() - snapshot.lastTickStartedAt.getTime() > overdueAfterMs) return "overdue";

  if (snapshot.running) return "running";
  return "on_schedule";
}

function quoteStatus(snapshot: PollerSnapshot): QuoteStatus {
  const observation = snapshot?.lastObservation;
  if (observation === undefined) return "not_attempted";
  if (observation.outcome === "market_closed") return "market_closed";
  if (observation.outcome === "error") return "unknown";

  // `observation.outcome === "quoted"`. The zero-instrument case takes no clause of its own:
  // `requested === 0` implies `providerFailed === false` (the provider is never called on an empty
  // feed, prices.server.ts), so `0 === 0` falls straight into `ok` below like any other fully-priced
  // run — a separate value here would report household shape, not pipeline health.
  if (observation.providerFailed) return "failed";
  if (observation.priced === observation.requested) return "ok";
  if (observation.priced === 0) return "failed";
  return "partial";
}

/**
 * `pricing.ok` is one conjunction over the three closed sets, exhaustive by construction — not an
 * ordered clause list, so nothing here can fall through unclassified.
 */
export function pricingHealth(
  snapshot: PollerSnapshot,
  worker: WorkerReachability,
  now: Date,
): PricingHealth {
  const scheduler = schedulerStatus(snapshot, now);
  const quotes = quoteStatus(snapshot);

  const ok =
    worker === "available" &&
    (scheduler === "running" || scheduler === "on_schedule") &&
    (quotes === "not_attempted" || quotes === "market_closed" || quotes === "ok");

  return { ok, worker, scheduler, quotes };
}
