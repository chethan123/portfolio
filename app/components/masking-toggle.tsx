/**
 * The control that hides every amount on the screen (spec 0007, ADR-0002).
 *
 * **In the chrome, not in Settings**: first run under the seeded policy is a
 * page of dots, and dots with no visible cure is a broken app — so the
 * control is on every screen, icon *and* text label (why ADR-0002 says it
 * cannot move to Settings without revisiting that default).
 *
 * **Labelled with what it will do, never with what is true** — "Hide
 * amounts" while showing. A control announcing its state reads as a
 * description of the screen; story 5 is the consequence: someone unsure
 * which way round clicks, and publishes their balances to the room.
 *
 * **Two writers, one click.** A real form submitting to `/masking`, so it
 * works with JavaScript off (story 29); with it on, the same click writes
 * the cookie directly and the flip is optimistic — no network in the path,
 * because the moment masking is needed is the moment there may not be one
 * (stories 2, 3). Neither writer owns the cookie's name, vocabulary or
 * lifetime: `masking.ts` does, so the two cannot disagree.
 *
 * No keyboard shortcut, deliberately: the spec puts one out of scope, and a
 * chord that hides the screen is a chord that reveals it by accident.
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
  // Keyed so every amount on the page can find this submission in flight; an
  // unkeyed fetcher is private to this component and the optimistic flip
  // would reach nothing (`useMasked`).
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
        // The optimistic write. `useMasked` already flipped the screen off the
        // pending submission; this makes the flip survive a reload on a
        // connection that never carried the POST. In a `submit` handler, not
        // `click`, so it cannot run for a submission that never happens;
        // guarded on `document` so it is inert during the server render.
        if (typeof document !== "undefined") {
          document.cookie = maskingCookie(next === MASKED, rootData?.maskingPolicy ?? "masked");
        }
      }}
    >
      {/* Only the no-JavaScript path reads this, to put the reader back where
          they were — search included, so hiding amounts on a sorted Holdings
          table does not also reset the sort. */}
      <input type="hidden" name="redirectTo" value={`${location.pathname}${location.search}`} />

      {/* The state travels as the button's own value: an unchecked checkbox
          contributes nothing to the form data, which would make the pending
          submission read as "unmask" in both directions. */}
      <button type="submit" name={MASKING_FIELD} value={next} className="masking-toggle">
        <Glyph className="app-nav-icon" />
        <span>{label}</span>
      </button>
    </fetcher.Form>
  );
}
