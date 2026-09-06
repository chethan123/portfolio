/** Masking toggle's no-JS writer. spec 0007, ADR-0002 */
import { redirect } from "react-router";

import { formFields } from "~/lib/input.server";
import { MASKED, UNMASKED, maskingCookie } from "~/lib/masking";
import { readMaskingPolicy } from "~/lib/settings.server";

import { safeReturn } from "../lib/return-path.ts";

import type { Route } from "./+types/masking";

export async function action({ request }: Route.ActionArgs) {
  const { masked, redirectTo } = formFields(await request.formData());

  if (masked !== MASKED && masked !== UNMASKED) {
    return new Response("Not a masking state.", { status: 400 });
  }

  return redirect(safeReturn(redirectTo), {
    // Stored policy, not the form's — keeps cookie lifetime right after a policy change in another tab.
    headers: { "Set-Cookie": maskingCookie(masked === MASKED, await readMaskingPolicy()) },
  });
}
