import { Link, Outlet, isRouteErrorResponse, useMatches, useRouteError } from "react-router";

import { UploadSteps, type UploadStepsData } from "~/components/upload-steps";

/**
 * The shared frame around every step of one draft (ingest brief §2.1, §7.4).
 *
 * Deliberately no loader: each step loads its own draft, because a step that
 * rendered against a parent's stale read could disagree with the form beneath
 * it. What the layout adds is the two things every step shares — the page
 * header with the strip under it, and the expired-draft page, written once
 * here rather than once per step.
 *
 * The strip's data comes up from the child through `useMatches`: every step
 * loader returns a `steps` field ({@link UploadStepsData}), and the deepest
 * match that carries one is the screen being rendered.
 */
export default function UploadDraftLayout() {
  const matches = useMatches();
  const steps = matches
    .map((match) => (match.data as { steps?: UploadStepsData } | undefined)?.steps)
    .filter((data) => data !== undefined)
    .at(-1);

  return (
    <section className="page">
      {/* The same title on every step — the strip beneath it is what changes,
          and a title that mutated per step would fight it for the same job. */}
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
 * extra link (ingest brief §6.5, §7.4). The review action reads it from the
 * form's hidden field — the draft the id would be read from is gone by then —
 * and throws it as `data({ accountId }, { status: 404 })`. It fed a posted
 * field once, so it is validated as an id here too, before anything links to
 * it; every other step's 404 carries a plain string body and yields null.
 */
function accountIdOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as { accountId?: unknown }).accountId;
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}

/**
 * A draft URL that no longer answers is ordinary, not an error in anything: a
 * bookmark outlives its draft when the sweep, the commit or a closed account
 * takes the row. The 404 the steps throw for it gets this titled page; only a
 * genuine fault falls through to the generic rendering root uses.
 */
export function ErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error) && error.status === 404) {
    // "Already recorded" means the reader most likely wants to see the result,
    // so the review re-POST's page adds the account link. A GET cannot tell a
    // committed draft from a swept one — same absence in the database — so it
    // gets the /upload link only, and the title's "or" stays honest.
    const accountId = accountIdOf(error.data);

    // Worded here rather than echoing the response body, whose sentence leads
    // with the same words the title already carries.
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

  const title = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : "Something went wrong";
  const detail = isRouteErrorResponse(error)
    ? error.data
    : error instanceof Error
      ? error.message
      : "Unknown error";

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="page-subtitle">{String(detail)}</p>
        </div>
      </header>
    </section>
  );
}
