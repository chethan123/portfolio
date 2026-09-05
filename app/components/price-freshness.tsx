/**
 * How old the figures on this page are, and the one control that changes it.
 * One component because they are one sentence: a press outside market hours
 * usually rewrites the close it already held, so every figure is identical
 * afterwards — without a timestamp that moves, nothing separates a refresh
 * that worked from one that failed silently, which §11 calls the one
 * genuinely dangerous failure mode in a finance app. The stamp arrives
 * already formatted, in market time: no browser clock exists at render time,
 * and a caption in a different zone from the date its row is filed under is
 * a subtraction the reader must do before trusting either.
 */
import { useFetcher, useLocation } from "react-router";

import { RefreshIcon } from "./icons.tsx";

import type { RefreshOutcome } from "../lib/refresh.server.ts";

/** What the loader hands over. Already rendered; this component computes nothing. */
export type FreshnessView = {
  /** The oldest quote behind anything on screen, or null when nothing is priced. */
  stamp: string | null;
  /** Instruments whose price exists and failed to refresh. */
  stale: number;
};

export function PriceFreshness({ freshness }: { freshness: FreshnessView }) {
  const fetcher = useFetcher<RefreshOutcome>();
  const location = useLocation();

  // Reading its *own* fetcher, so the documented idiom applies; only
  // `useFetchers()` — reading someone else's — needs the form-data guard the
  // masking hook explains.
  const busy = fetcher.state !== "idle";

  return (
    <div className="price-freshness">
      <p className="as-of u-label">
        {freshness.stamp === null ? (
          "No prices yet"
        ) : (
          <>
            As of <span className="u-data">{freshness.stamp}</span>
          </>
        )}
      </p>

      <fetcher.Form method="post" action="/refresh" preventScrollReset>
        {/* Only the no-JavaScript path reads this: the action redirects a
            document POST back here, there being no fetcher to answer. */}
        <input type="hidden" name="redirectTo" value={`${location.pathname}${location.search}`} />

        <button type="submit" className="button button--quiet refresh-button" disabled={busy}>
          <RefreshIcon className={busy ? "refresh-icon refresh-icon--busy" : "refresh-icon"} />
          {busy ? "Refreshing…" : "Refresh now"}
        </button>
      </fetcher.Form>

      <Outcome outcome={busy ? undefined : fetcher.data} stamp={freshness.stamp} />
    </div>
  );
}

/**
 * What just happened, in one line. `observed` is why this is not a count of
 * instruments: on a Saturday evening every other figure reads as it does
 * mid-session — forty requested, forty priced, the provider handing back
 * Friday's close for every symbol. Only the number of instants new to the
 * log knows the difference, and that is the question the person pressing
 * the button actually asked.
 */
function Outcome({ outcome, stamp }: { outcome: RefreshOutcome | undefined; stamp: string | null }) {
  if (outcome === undefined) return null;

  if (outcome.status === "busy") {
    return <p className="coverage-note">A refresh is already running; the figures will follow.</p>;
  }

  if (outcome.status === "error") {
    return (
      <p className="form-error" role="alert">
        Refresh failed. The figures above are unchanged.
      </p>
    );
  }

  if (outcome.providerFailed) {
    return (
      <p className="form-error" role="alert">
        Refresh failed — the price provider did not respond.
        {stamp === null ? null : ` Showing last known prices from ${stamp}.`}
      </p>
    );
  }

  if (outcome.observed === 0) {
    return (
      <p className="coverage-note">
        Checked {outcome.requested} {outcome.requested === 1 ? "price" : "prices"}
        {stamp === null ? " · nothing new" : ` · nothing new since ${stamp}`}
      </p>
    );
  }

  return (
    <p className="coverage-note">
      Updated {outcome.priced} {outcome.priced === 1 ? "price" : "prices"}
      {outcome.stale === 0 ? null : ` · ${outcome.stale} marked stale`}
    </p>
  );
}
