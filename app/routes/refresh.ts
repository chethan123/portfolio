/**
 * "Refresh now" resource route — no component, a real form target, so it works with JavaScript
 * off. Lock refusals redirect to `/`, never back here: a POST has no return address a redirect's
 * GET could land on (`app/root.tsx`'s `redirectToUnlock`).
 */
import { redirect } from "react-router";

import { outcomeOf, runRefresh, type RefreshOutcome } from "../lib/refresh.server.ts";
import { safeReturn } from "../lib/return-path.ts";

import type { Route } from "./+types/refresh";

export async function action({ request }: Route.ActionArgs): Promise<RefreshOutcome | Response> {
  const form = await request.formData();

  // A press runs the backfill batch too (ADR-0011); it reports the quotes.
  const outcome = outcomeOf(await runRefresh({ quotes: true }));

  // Document POST (`Sec-Fetch-Mode` is browser-set, unspoofable): no fetcher waiting, so redirect
  // rather than render a bare payload. A fetch omitting the header counts as scripted.
  if (request.headers.get("Sec-Fetch-Mode") === "navigate") {
    return redirect(safeReturn(form.get("redirectTo")?.toString()));
  }

  return outcome;
}
