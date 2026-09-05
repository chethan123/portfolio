/**
 * The toggle's server-side writer (spec 0007, ADR-0002). A resource route,
 * action only — the control lives in the chrome, and this exists so the
 * toggle works with JavaScript off (story 29), which is why the control is a
 * form rather than a button with a handler.
 *
 * **Two writers, one cookie.** With JavaScript on, the toggle's own script
 * writes `document.cookie` at the speed of a hand — the moment masking is
 * needed is the moment there may not be one; this action writes the
 * identical value for the browser that cannot. Neither writer decides the
 * cookie's name, vocabulary or lifetime: all three live in `masking.ts`, so
 * the two cannot drift.
 *
 * Who may press it is the gate's own business, unchanged: it admits or
 * refuses a request before the router ever sees it, and every family member
 * it admits sees and can do everything. Since ticket 03, whether a browser
 * may reach this route *at all* is the lock's: root middleware refuses a
 * request from a browser holding no live grant before this action runs, and
 * a refusal here is redirected to `/`, never back to this route — `POST`
 * has no return address a redirect's own `GET` could land on
 * (`app/root.tsx`'s `redirectToUnlock`).
 */
import { redirect } from "react-router";

import { formFields } from "~/lib/input.server";
import { MASKED, UNMASKED, maskingCookie } from "~/lib/masking";
import { readMaskingPolicy } from "~/lib/settings.server";

import { safeReturn } from "../lib/return-path.ts";

import type { Route } from "./+types/masking";

export async function action({ request }: Route.ActionArgs) {
  const { masked, redirectTo } = formFields(await request.formData());

  // Refused rather than coerced: an unrecognised cookie resolves to the
  // policy's answer, so junk written here would expose nothing — it would
  // just make the toggle silently stop working until the jar was cleared, a
  // worse failure than a refusal because nothing reports it.
  if (masked !== MASKED && masked !== UNMASKED) {
    return new Response("Not a masking state.", { status: 400 });
  }

  return redirect(safeReturn(redirectTo), {
    // The stored policy, not the one the form thought was in force: the
    // lifetime is what makes "on start" mean "an untoggled browser session",
    // and reading it here keeps that true after the policy changes in
    // another tab.
    headers: { "Set-Cookie": maskingCookie(masked === MASKED, await readMaskingPolicy()) },
  });
}
