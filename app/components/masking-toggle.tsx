/**
 * The control that hides every amount on the screen (spec 0007, ADR-0002).
 *
 * **In the chrome, not in Settings.** A household's first run under the seeded
 * policy is a page of dots, and a page of dots with no visible cure is a broken
 * app. The control is therefore on every screen, wearing an icon *and* a text
 * label — which is also why ADR-0002 records that it cannot be moved into
 * Settings later without revisiting the default that put it here.
 *
 * **Labelled with what it will do, never with what is true.** "Hide amounts"
 * when they are showing; "Show amounts" when they are hidden. A control that
 * announced its state instead would be read as a description of the screen, and
 * story 5 is the consequence: someone unsure which way round it is clicks, and
 * publishes their balances to the room.
 *
 * **Two writers, one click.** The button is a real form submitting to
 * `/masking`, so it works with JavaScript off (story 29). With JavaScript on,
 * the same click writes the cookie directly and the flip is optimistic — the
 * amounts change in the frame the button was pressed in, with no network in the
 * path, because the moment masking is needed is the moment there may not be one
 * (story 2, 3). Neither writer owns the cookie's name, vocabulary or lifetime:
 * `masking.ts` does, so the two cannot disagree.
 *
 * No keyboard shortcut, deliberately: the spec puts one out of scope, and a
 * chord that hides the screen is a chord that reveals it by accident.
 */
import { useFetcher, useLocation, useRouteLoaderData } from "react-router";

import { HiddenIcon, VisibleIcon } from "~/components/icons";
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
  // Keyed, so that every amount on the page can find this submission while it
  // is in flight. An unkeyed fetcher is private to this component and the
  // optimistic flip would reach nothing (`useMasked`).
  const fetcher = useFetcher({ key: MASKING_FETCHER_KEY });
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  const masked = useMasked();
  const location = useLocation();

  const next = masked ? UNMASKED : MASKED;
  const label = masked ? "Show amounts" : "Hide amounts";
  const Glyph = masked ? HiddenIcon : VisibleIcon;

  return (
    <fetcher.Form
      method="post"
      action={MASKING_ACTION}
      className={className}
      // Only read on the no-JavaScript path, where the click is a real
      // navigation and the response has to put the reader back where they were.
      // Search included: hiding the amounts on a sorted Holdings table must not
      // also reset the sort.
      onSubmit={() => {
        // The optimistic write. `useMasked` has already flipped the screen off
        // the pending submission; this is what makes the flip survive a reload
        // on a connection that never carried the POST.
        //
        // In a `submit` handler rather than a `click` one so that it cannot run
        // for a submission that never happens, and guarded on `document` so
        // that it is inert during the server render.
        if (typeof document !== "undefined") {
          document.cookie = maskingCookie(next === MASKED, rootData?.maskingPolicy ?? "masked");
        }
      }}
    >
      <input type="hidden" name="redirectTo" value={`${location.pathname}${location.search}`} />

      {/* The state travels as the button's own value: an unchecked checkbox
          contributes nothing to the form data at all, which would make the
          pending submission read as "unmask" in both directions. */}
      <button type="submit" name={MASKING_FIELD} value={next} className="masking-toggle">
        <Glyph className="app-nav-icon" />
        <span>{label}</span>
      </button>
    </fetcher.Form>
  );
}
