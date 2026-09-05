/**
 * One refresh, start to finish: the lock, the provider call, and the mapping
 * from what came back to what a caller renders. Before this module the lock
 * was taken in two places — the route, which also built its own provider, and
 * the poller's tick, which `requestRefresh` drives (issue #159); a worker
 * cutover
 * ([spec 0018](../../docs/specs/0018-price-worker.md) §3.4) has to change one
 * default in one place instead of three, and the batch abort that cutover
 * relies on (§3.1) needs one caller to test against a fake provider.
 *
 * `runRefresh` is the only place `withRefreshLock` wraps `refreshPrices` now.
 * Everything `refreshPrices` itself leaves untouched stays untouched here too:
 * `refreshQuotes`, every price write, ADR-0011's rules, `price_poll` and the
 * observation log are reached only through it.
 */
import { getConfig } from "../../server/config.ts";

import { getDb } from "./db.server.ts";
import { yahooPriceProvider, type PriceProvider } from "./price-provider.server.ts";
import {
  refreshPrices,
  withRefreshLock,
  type BackfillReport,
  type RefreshPricesReport,
  type RefreshReport,
} from "./prices.server.ts";

/**
 * What one press of "Refresh now" came to, in the shape the control renders.
 * Moved here from `app/routes/refresh.ts` (issue #159) — the tree's one
 * import out of `app/routes/`, gone: `price-freshness.tsx` took the type from
 * a route module, where a *value* import would have compiled. From a
 * `.server.ts` module the build refuses one, so the boundary is now enforced
 * rather than merely observed.
 */
export type RefreshOutcome =
  | {
      status: "done";
      requested: number;
      priced: number;
      stale: number;
      observed: number;
      providerFailed: boolean;
    }
  /** Someone else — the poller, or another tab — holds the lock. */
  | { status: "busy" }
  /** The database, not the provider. A provider failure is a `done` above. */
  | { status: "error" };

/**
 * What one `runRefresh` call came to, whatever it was asked for. The general
 * shape: `report.quotes` is `RefreshPricesReport`'s own, nullable when quotes
 * were not asked for. {@link runRefresh}'s `{ quotes: true }` overload narrows
 * it further, mirroring how `refreshPrices` narrows `RefreshPricesReport`
 * itself (`prices.server.ts:687-704`).
 */
export type RefreshRun =
  | { status: "done"; report: RefreshPricesReport }
  /** Someone else already holds the refresh lock. */
  | { status: "busy" }
  /** The lock or the database failed — never a provider fault (see below). */
  | { status: "error" };

/** `runRefresh({ quotes: true })`'s own answer: `report.quotes` is never null. */
type RunWithQuotes =
  | { status: "done"; report: { quotes: RefreshReport; backfill: BackfillReport } }
  | { status: "busy" }
  | { status: "error" };

/**
 * Run a refresh: quotes when asked for, then one bounded backfill batch,
 * inside the advisory lock every caller used to take by hand.
 *
 * `null` from {@link withRefreshLock} is `busy`, not a failure — someone else
 * is doing the work and the prices will be fresh either way. A throw is
 * everything that escapes `refreshPrices` itself: the pool, the lock, the
 * transaction. It is never a provider fault — `refreshQuotes` catches that and
 * reports `providerFailed` inside a `done` run
 * (`prices.server.ts:824-830`), and `backfillCloses` ledgers a provider
 * failure per candidate rather than throwing one out (the one exception,
 * `ProviderUnreachable`, still surfaces as `done` with `backfill.batchFailed`
 * — the composition inside `refreshPrices` catches it, per §3.1 of the
 * price-worker spec). So `error` here means the database or the lock, and
 * nothing else — logged under the poller's own stem
 * (`docs/operating.md:740`), which every caller now shares: the route's
 * former "Manual …" line retires with it.
 *
 * **It never throws**, and the route depends on that: a throw out of a route
 * action reaches the error boundary and replaces the whole page, and the one
 * failure the "Refresh now" control promises to show inline with the figures
 * untouched (story 18) is the one a throw cannot show. Every path here returns
 * something {@link outcomeOf} can render.
 *
 * The default provider is `yahooPriceProvider()`, and this is the only place
 * a *caller* of a refresh names one — the price-worker cutover changes it here
 * and in `startPricePoller`'s own default, which holds one instance for the
 * process. An instance, not a factory: with no per-operation state to reset
 * there is nothing a factory would buy.
 */
export async function runRefresh(
  options: { quotes: true },
  provider?: PriceProvider,
): Promise<RunWithQuotes>;
export async function runRefresh(
  options: { quotes: boolean },
  provider?: PriceProvider,
): Promise<RefreshRun>;
export async function runRefresh(
  { quotes }: { quotes: boolean },
  provider: PriceProvider = yahooPriceProvider(),
): Promise<RefreshRun> {
  try {
    const result = await withRefreshLock(() =>
      refreshPrices(provider, getConfig().MARKET_TIMEZONE, { quotes }, getDb()),
    );

    if (result === null) return { status: "busy" };
    return { status: "done", report: result };
  } catch (error) {
    console.error("Price refresh failed; last known prices are kept:", error);
    return { status: "error" };
  }
}

/**
 * `runRefresh({ quotes: true })`'s report, projected the way the "Refresh
 * now" control renders it — the mapping `app/routes/refresh.ts` held before
 * this module existed, moved unchanged rather than rewritten. Takes the
 * narrowed overload's answer, not the general `RefreshRun`, so there is no
 * null `report.quotes` to invent an outcome for.
 */
export function outcomeOf(run: RunWithQuotes): RefreshOutcome {
  if (run.status !== "done") return run;

  const { quotes } = run.report;
  return {
    status: "done",
    requested: quotes.requested,
    priced: quotes.priced,
    stale: quotes.stale,
    observed: quotes.observed,
    providerFailed: quotes.providerFailed,
  };
}
