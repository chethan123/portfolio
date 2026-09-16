/** Masking toggle's no-JS writer and enhanced-form revalidation. spec 0007, ADR-0002 */
import { redirect } from "react-router";

import { formFields } from "~/lib/input.server";
import { MASKED, MASKING_ENHANCED_FIELD, UNMASKED, maskingCookie } from "~/lib/masking";
import { readMaskingPolicy } from "~/lib/settings.server";

import { safeReturn } from "../lib/return-path.ts";

import type { Route } from "./+types/masking";

export async function action({ request }: Route.ActionArgs) {
  const { masked, redirectTo, [MASKING_ENHANCED_FIELD]: enhanced } = formFields(
    await request.formData(),
  );

  if (masked !== MASKED && masked !== UNMASKED) {
    return new Response("Not a masking state.", { status: 400 });
  }

  const destination = safeReturn(redirectTo);

  // The enhanced form wrote the cookie synchronously before this request. Its response must not
  // write it again: a Show POST from one tab can finish after a newer Hide in another tab. A real
  // document POST has no client writer, so it still receives the progressive-enhancement cookie.
  if (enhanced === "1") return redirect(destination);

  return redirect(destination, {
    // Stored policy, not the form's — keeps cookie lifetime right after a policy change in another tab.
    headers: { "Set-Cookie": maskingCookie(masked === MASKED, await readMaskingPolicy()) },
  });
}
