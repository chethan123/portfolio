/**
 * Hides every amount on screen (spec 0007, ADR-0002). Labelled with what it
 * will do, never what is true — "Hide amounts" while showing (story 5: a
 * state-announcing control invites clicking the wrong way). Two writers:
 * a real form to `/masking` (JS off, story 29) and, with JS, an optimistic
 * direct cookie write — neither owns the cookie's shape, `masking.ts` does.
 */
import { useFetcher, useLocation, useRouteLoaderData } from "react-router";

import { MaskedIcon, UnmaskedIcon } from "~/components/icons";
import {
  MASKED,
  MASKING_ACTION,
  MASKING_FETCHER_KEY,
  MASKING_FIELD,
  UNMASKED,
  maskingCookie,
  useMasked,
} from "~/lib/masking";

import type { loader as rootLoader } from "../root.tsx";

export function MaskingToggle({ className }: { className?: string }) {
  // Keyed so every amount on the page can find this submission in flight (`useMasked`).
  const fetcher = useFetcher({ key: MASKING_FETCHER_KEY });
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  const masked = useMasked();
  const location = useLocation();

  const next = masked ? UNMASKED : MASKED;
  const label = masked ? "Show amounts" : "Hide amounts";
  const Glyph = masked ? MaskedIcon : UnmaskedIcon;

  return (
    <fetcher.Form
      method="post"
      action={MASKING_ACTION}
      className={className}
      onSubmit={() => {
        // Optimistic write, so the flip survives a reload before the POST lands. Guarded on `document` for the server render.
        if (typeof document !== "undefined") {
          document.cookie = maskingCookie(next === MASKED, rootData?.maskingPolicy ?? "masked");
        }
      }}
    >
      {/* Only the no-JS path reads this — search included, so it doesn't reset a sorted table's sort. */}
      <input type="hidden" name="redirectTo" value={`${location.pathname}${location.search}`} />

      {/* State travels as the button's own value, not a checkbox — unchecked contributes nothing either way. */}
      <button type="submit" name={MASKING_FIELD} value={next} className="masking-toggle">
        <Glyph className="app-nav-icon" />
        <span>{label}</span>
      </button>
    </fetcher.Form>
  );
}
