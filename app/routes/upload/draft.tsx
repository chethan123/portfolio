import { Link, Outlet, isRouteErrorResponse, useMatches, useRouteError } from "react-router";

import { ErrorPage } from "~/components/error-page";
import { UploadSteps, type UploadStepsData } from "~/components/upload-steps";

/**
 * The shared frame around every step of one draft (ingest brief §2.1, §7.4).
 * Deliberately no loader — each step loads its own draft, since a step
 * rendered against a parent's stale read could disagree with the form
 * beneath it. The layout adds the two things every step shares: the page
 * header with the strip, and the expired-draft page, written once. The
 * strip's data comes up through `useMatches`: every step loader returns a
 * `steps` field ({@link UploadStepsData}); the deepest match carrying one is
 * the screen being rendered.
 */
export default function UploadDraftLayout() {
  const matches = useMatches();
  const steps = matches
    .map((match) => (match.data as { steps?: UploadStepsData } | undefined)?.steps)
    .filter((data) => data !== undefined)
    .at(-1);

  return (
    <section className="page">
      {/* One title on every step — the strip beneath is what changes, and a
          title mutating per step would fight it for the same job. */}
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

/**
 * The account id a review re-POST's 404 carries for the expired page's one
 * extra link (ingest brief §6.5, §7.4): the review action reads it from the
 * form's hidden field — the draft is gone by then — and throws
 * `data({ accountId }, { status: 404 })`. Once a posted field, so validated
 * as an id here too before anything links to it; every other step's 404
 * carries a plain string body and yields null.
 */
function accountIdOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as { accountId?: unknown }).accountId;
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}

/**
 * A draft URL that no longer answers is ordinary: a bookmark outlives its
 * draft when the sweep, the commit or a closed account takes the row. The
 * steps' 404 gets this titled page; only a genuine fault falls through to
 * the generic rendering root uses.
 */
export function ErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error) && error.status === 404) {
    // "Already recorded" means the reader likely wants the result, so the
    // review re-POST's page adds the account link. A GET cannot tell a
    // committed draft from a swept one — same absence in the database — so it
    // gets the /upload link only, and the title's "or" stays honest.
    const accountId = accountIdOf(error.data);

    // Worded here, not echoing the response body, whose sentence leads with
    // the words the title already carries.
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

  // Everything that is not an expired draft gets the page root would give
  // it. One page, one place, so a fix cannot reach one boundary and miss the
  // other — this used to be a copy of root's boundary, defects included.
  return <ErrorPage error={error} />;
}
