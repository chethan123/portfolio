/**
 * The toggle's server-side writer (spec 0007, ADR-0002).
 *
 * A resource route: an action and nothing else. There is no screen here — the
 * control lives in the chrome, on every page — and this exists so that the
 * toggle keeps working with JavaScript off, which story 29 asks for and which
 * is the reason the control is a form rather than a button with a handler.
 *
 * **Two writers, one cookie.** With JavaScript on, the toggle's own script
 * writes `document.cookie` the moment it is clicked, because the flip has to
 * happen at the speed of a hand rather than of a network — the moment masking
 * is needed is the moment there may not be one. This action writes the
 * identical value for the browser that cannot do that. Neither writer decides
 * the cookie's name, its vocabulary or its lifetime: all three live in
 * `masking.ts`, so the two cannot drift.
 *
 * Nothing guards this route in particular and nothing needs to: the gate in
 * front of the app admits or refuses a request before the router ever sees it,
 * so a resource route with no screen is exactly as protected as a screen is.
 */
import { redirect } from "react-router";

import { formFields } from "~/lib/input.server";
import { MASKED, UNMASKED, maskingCookie } from "~/lib/masking";
import { readMaskingPolicy } from "~/lib/settings.server";

import { safeReturn } from "../lib/return-path.ts";

import type { Route } from "./+types/masking";

export async function action({ request }: Route.ActionArgs) {
  const { masked, redirectTo } = formFields(await request.formData());

  // Refused rather than coerced. An unrecognised cookie resolves to the
  // policy's answer, so a junk value written here would expose nothing — it
  // would just make the toggle silently stop working until the jar was
  // cleared, which is a worse failure than a refusal because nothing reports it.
  if (masked !== MASKED && masked !== UNMASKED) {
    return new Response("Not a masking state.", { status: 400 });
  }

  return redirect(safeReturn(redirectTo), {
    // The stored policy, not the one the form thought was in force: the
    // lifetime is what makes "on start" mean "a browser session nobody has
    // toggled yet", and reading it here is what keeps that true after the
    // policy changes in another tab.
    headers: { "Set-Cookie": maskingCookie(masked === MASKED, await readMaskingPolicy()) },
  });
}
