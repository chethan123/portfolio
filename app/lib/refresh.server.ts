/**
 * One refresh end to end: the lock, the provider call, and the mapping to what a caller renders.
 * The only place `withRefreshLock` wraps `refreshPrices`.
 */
import { getConfig } from "../../server/config.ts";

import { getDb } from "./db.server.ts";
import { socketProvider } from "./provider-socket.server.ts";
import {
  refreshPrices,
  withRefreshLock,
  type BackfillReport,
  type RefreshPricesReport,
  type RefreshReport,
} from "./prices.server.ts";

import type { PriceProvider } from "./price-provider.server.ts";

/** What one press of "Refresh now" came to, in the shape the control renders. */
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

/** `report.quotes` is null unless quotes were asked for; {@link runRefresh}'s `{ quotes: true }` overload narrows it. */
export type RefreshRun =
  | { status: "done"; report: RefreshPricesReport }
  | { status: "busy" }
  | { status: "error" };

/** `runRefresh({ quotes: true })`'s own answer: `report.quotes` is never null. */
type RunWithQuotes =
  | { status: "done"; report: { quotes: RefreshReport; backfill: BackfillReport } }
  | { status: "busy" }
  | { status: "error" };

/**
 * Never throws, and the route depends on that: a throw out of an action replaces the whole page,
 * and an inline failure with the figures left standing is what the control promises (story 18).
 * `null` from {@link withRefreshLock} is `busy`. `error` is the lock or the database only — a
 * provider failure returns inside a `done` run (`providerFailed`, or `backfill.batchFailed`).
 * The `socketProvider()` default is a default parameter, evaluated before the `try`: building one
 * must never throw (`provider-socket.server.ts` keeps that constraint).
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
  provider: PriceProvider = socketProvider(),
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

/** Takes the narrowed overload's answer, so there is no null `report.quotes` to invent an outcome for. */
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
