/**
 * "Refresh now": the one way a person can spend a provider request on
 * demand — quotes, and the backfill batch every refresh runs. A
 * resource route because five screens carry the control — an action per
 * screen would be the same twenty lines five times. Follows `masking.ts`: no
 * component, a real form target, so the control works with JavaScript off.
 * Nothing guards who may press it and nothing needs to: the gate fronts the
 * whole app (§11), and every family member sees and can do everything.
 *
 * A thin translator, and nothing more (issue #159): the lock, the provider
 * and the outcome it renders all belong to `runRefresh`/`outcomeOf`
 * (`app/lib/refresh.server.ts`), which the poller's tick and `requestRefresh`
 * now share.
 */
import { redirect } from "react-router";

import { outcomeOf, runRefresh, type RefreshOutcome } from "../lib/refresh.server.ts";
import { safeReturn } from "../lib/return-path.ts";

import type { Route } from "./+types/refresh";

export async function action({ request }: Route.ActionArgs): Promise<RefreshOutcome | Response> {
  const form = await request.formData();

  // A press runs the backfill batch too (ADR-0011), and reports the quotes
  // as it always has: what it promises the person is prices, and the batch is
  // a side effect they will see on the chart.
  const outcome = outcomeOf(await runRefresh({ quotes: true }));

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
