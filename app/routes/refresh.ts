/**
 * "Refresh now": the one way a person can spend a provider request on
 * demand — quotes, and the backfill batch every refresh runs. A
 * resource route because five screens carry the control — an action per
 * screen would be the same twenty lines five times. Follows `masking.ts`: no
 * component, a real form target, so the control works with JavaScript off.
 * Nothing guards who may press it and nothing needs to: the gate fronts the
 * whole app (§11), and every family member sees and can do everything.
 */
import { redirect } from "react-router";

import { getConfig } from "../../server/config.ts";
import { getDb } from "../lib/db.server.ts";
import { yahooPriceProvider } from "../lib/price-provider.server.ts";
import { refreshPrices, withRefreshLock } from "../lib/prices.server.ts";
import { safeReturn } from "../lib/return-path.ts";

import type { Route } from "./+types/refresh";

/** What one press did, in the shape the control renders. */
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

export async function action({ request }: Route.ActionArgs): Promise<RefreshOutcome | Response> {
  const form = await request.formData();

  const outcome = await run();

  // A document POST means JavaScript is off and no fetcher waits for this
  // data — it would render as a bare payload on a blank page. Redirect back
  // and let the as-of line confirm. `Sec-Fetch-Mode` is browser-set,
  // unspoofable by the page; a fetch omitting it is treated as scripted,
  // the safe way round — a fetcher renders the outcome either way.
  if (request.headers.get("Sec-Fetch-Mode") === "navigate") {
    return redirect(safeReturn(form.get("redirectTo")?.toString()));
  }

  return outcome;
}

/**
 * Never throws: a throw from a route action reaches the error boundary and
 * replaces the whole page — the one failure this control promises to show
 * inline, figures untouched (story 18), is the one a throw cannot show.
 * Every path returns something the control can render.
 */
async function run(): Promise<RefreshOutcome> {
  try {
    // A press runs the backfill batch too (ADR-0011), and reports the quotes
    // as it always has: what it promises the person is prices, and the batch is
    // a side effect they will see on the chart. A batch that failed is the
    // composition's own log line and never this outcome — the control renders
    // an error as "the figures above are unchanged", which is false the moment
    // the quotes have committed.
    const report = await withRefreshLock(() =>
      refreshPrices(yahooPriceProvider(), getConfig().MARKET_TIMEZONE, { quotes: true }, getDb()),
    );

    // `null` is the lock held elsewhere — not a failure: whoever holds it is
    // fetching the prices right now.
    if (report === null) return { status: "busy" };

    return {
      status: "done",
      requested: report.quotes.requested,
      priced: report.quotes.priced,
      stale: report.quotes.stale,
      observed: report.quotes.observed,
      providerFailed: report.quotes.providerFailed,
    };
  } catch (error) {
    console.error("Manual price refresh failed; last known prices are kept:", error);
    return { status: "error" };
  }
}
