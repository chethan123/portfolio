import { Link, Outlet, isRouteErrorResponse, useMatches, useRouteError } from "react-router";

import { ErrorPage } from "~/components/error-page";
import { UploadSteps, type UploadStepsData } from "~/components/upload-steps";

/**
 * Shared frame around every step of one draft (ingest brief §2.1, §7.4). No
 * loader here — each step loads its own draft, or a stale parent read could
 * disagree with the form. Strip data comes up via `useMatches`: the deepest
 * match with a `steps` field ({@link UploadStepsData}) is the active screen.
 */
export default function UploadDraftLayout() {
  const matches = useMatches();
  const steps = matches
    .map((match) => (match.data as { steps?: UploadStepsData } | undefined)?.steps)
    .filter((data) => data !== undefined)
    .at(-1);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Upload a statement</h1>
          <p className="page-subtitle">
            A statement lands as one photograph of what the account holds. Nothing is recorded
            until the last step.
          </p>
        </div>
      </header>

      {steps ? <UploadSteps steps={steps} /> : null}

      <Outlet />
    </section>
  );
}

// Account id a review re-POST's 404 carries (ingest brief §6.5, §7.4) — validated as an id, since it was once a posted field.
function accountIdOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as { accountId?: unknown }).accountId;
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}

// A draft URL that no longer answers is ordinary (sweep, commit, closed account) — gets this page; a genuine fault falls through.
export function ErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error) && error.status === 404) {
    // A GET can't tell a committed draft from a swept one, so it gets the /upload link only.
    const accountId = accountIdOf(error.data);

    return (
      <section className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">This upload has expired or was already recorded.</h1>
            <p className="page-subtitle">
              A draft is kept for a day and deleted once its statement lands, so a bookmarked
              or reopened step can outlive it. Nothing else was lost.
            </p>
          </div>
        </header>
        <p>
          <Link to="/upload">Start a new upload</Link>
          {accountId !== null ? (
            <>
              {" · "}
              <Link to={`/accounts/${accountId}`}>See what the account holds now</Link>
            </>
          ) : null}
        </p>
      </section>
    );
  }

  return <ErrorPage error={error} />;
}
