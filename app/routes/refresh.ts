/**
 * "Refresh now": the one way a person can spend a provider request.
 *
 * A resource route rather than an action on each screen, because the control is
 * carried by five of them and an action per screen would be the same twenty
 * lines five times. It follows `masking.ts` — no component, a real form target,
 * so the control keeps working with JavaScript off.
 *
 * Nothing here guards who may press it, and nothing needs to: the deployment
 * puts an auth gate in front of the whole app (§11), and every family member
 * sees and can do everything.
 */
import { redirect } from "react-router";

import { getConfig } from "../../server/config.ts";
import { getDb } from "../lib/db.server.ts";
import { yahooPriceProvider } from "../lib/price-provider.server.ts";
import { refreshQuotes, withRefreshLock } from "../lib/prices.server.ts";
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

  // A document POST means the browser submitted the form itself, which means
  // JavaScript is off and there is no fetcher waiting for this data — it would
  // render as a bare payload on a blank page. Send them back to the screen they
  // pressed on and let the as-of line be the confirmation, which is what it is
  // for. `Sec-Fetch-Mode` is set by the browser and cannot be spoofed by the
  // page; a fetch that omits it is treated as the scripted path, which is the
  // safe way round — a fetcher renders the outcome either way.
  if (request.headers.get("Sec-Fetch-Mode") === "navigate") {
    return redirect(safeReturn(form.get("redirectTo")?.toString()));
  }

  return outcome;
}

/**
 * Never throws.
 *
 * A throw from a route action reaches the nearest error boundary and replaces
 * the whole page — so the one failure this control promises to show inline,
 * leaving the figures exactly as they were (story 18), is the one a throw
 * cannot show. Every path returns something the control can render instead.
 */
async function run(): Promise<RefreshOutcome> {
  try {
    const report = await withRefreshLock(() =>
      refreshQuotes(yahooPriceProvider(), getConfig().MARKET_TIMEZONE, getDb()),
    );

    // `null` is the lock being held. Not a failure: the prices are being
    // fetched right now by whoever holds it.
    if (report === null) return { status: "busy" };

    return {
      status: "done",
      requested: report.requested,
      priced: report.priced,
      stale: report.stale,
      observed: report.observed,
      providerFailed: report.providerFailed,
    };
  } catch (error) {
    console.error("Manual price refresh failed; last known prices are kept:", error);
    return { status: "error" };
  }
}
