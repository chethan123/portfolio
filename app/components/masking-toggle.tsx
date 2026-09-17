/**
 * Hides every amount on screen (spec 0007, ADR-0002). Labelled with what it
 * will do, never what is true — "Hide amounts" while showing (story 5: a
 * state-announcing control invites clicking the wrong way). Two writers:
 * a real form to `/masking` (JS off, story 29) and, with JS, an optimistic
 * direct cookie write — neither owns the cookie's shape, `masking.ts` does.
 */
import { useEffect, useRef } from "react";
import { useFetcher, useLocation, useRouteLoaderData } from "react-router";

import { MaskedIcon, UnmaskedIcon } from "~/components/icons";
import {
  MASKED,
  MASKING_ACTION,
  MASKING_ENHANCED_FIELD,
  MASKING_FETCHER_KEY,
  MASKING_FIELD,
  UNMASKED,
  reconcileBrowserMaskingChoice,
  useMasked,
  writeBrowserMaskingChoice,
  type BrowserMaskingWrite,
} from "~/lib/masking";

import type { loader as rootLoader } from "../root.tsx";

export function MaskingToggle({ className }: { className?: string }) {
  // The rail and phone copies share one submission, including React Router's newer-request cancellation.
  const fetcher = useFetcher({ key: MASKING_FETCHER_KEY });
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  const masked = useMasked();
  const location = useLocation();
  const pending = useRef<{
    write: BrowserMaskingWrite;
    started: boolean;
    rootData: typeof rootData;
  } | null>(null);

  useEffect(() => {
    if (pending.current === null) return;
    if (fetcher.state !== "idle") {
      pending.current.started = true;
      return;
    }
    if (!pending.current.started) return;
    if (rootData === undefined || rootData === pending.current.rootData) {
      // Idle alone does not prove a new root snapshot. Keep the optimistic cookie session-scoped
      // rather than applying a possibly stale policy lifetime.
      pending.current = null;
      return;
    }

    reconcileBrowserMaskingChoice(pending.current.write, rootData);
    pending.current = null;
  }, [fetcher.state, rootData]);

  const next = masked ? UNMASKED : MASKED;
  const label = masked ? "Show amounts" : "Hide amounts";
  const Glyph = masked ? MaskedIcon : UnmaskedIcon;

  return (
    <fetcher.Form
      method="post"
      action={MASKING_ACTION}
      className={className}
      onSubmit={(event) => {
        const enhanced = event.currentTarget.elements.namedItem(MASKING_ENHANCED_FIELD);
        if (enhanced instanceof HTMLInputElement) enhanced.value = "1";

        // Optimistic write, so the flip survives a reload before the POST lands. Guarded on `document` for the server render.
        if (typeof document !== "undefined") {
          pending.current = {
            write: writeBrowserMaskingChoice(next === MASKED),
            started: false,
            rootData,
          };
        }
      }}
    >
      {/* Only the no-JS path reads this — search included, so it doesn't reset a sorted table's sort. */}
      <input type="hidden" name="redirectTo" value={`${location.pathname}${location.search}`} />
      <input type="hidden" name={MASKING_ENHANCED_FIELD} defaultValue="" />

      {/* State travels as the button's own value, not a checkbox — unchecked contributes nothing either way. */}
      <button type="submit" name={MASKING_FIELD} value={next} className="masking-toggle">
        <Glyph className="app-nav-icon" />
        <span>{label}</span>
      </button>
    </fetcher.Form>
  );
}
