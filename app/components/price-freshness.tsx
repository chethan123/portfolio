// How old the figures are, and the control that refreshes them (§11) — one component, one sentence. Stamp arrives pre-formatted, in market time.
import { useFetcher, useLocation } from "react-router";

import { RefreshIcon } from "./icons.tsx";

import type { RefreshOutcome } from "../lib/refresh.server.ts";

export type FreshnessView = {
  stamp: string | null;
  stale: number;
};

export function PriceFreshness({ freshness }: { freshness: FreshnessView }) {
  const fetcher = useFetcher<RefreshOutcome>();
  const location = useLocation();

  // Own fetcher, so this idiom applies directly — `useFetchers()` (someone else's) would need a form-data guard.
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
        {/* Only the no-JS path reads this — the action redirects a document POST back here. */}
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

// `observed`, not a count of instruments priced — a weekend refresh re-prices everything from Friday's close with nothing new.
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
