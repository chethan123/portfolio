import { Link, isRouteErrorResponse } from "react-router";

/**
 * Wording is ours; status alone picks it — the transport's own strings vary
 * by throw path and once gave this app's two 404s two different pages.
 * Nothing the throwing code wrote is printed. No open-instance banner: a
 * URL matching no route never runs root's loader, so printing it on faith
 * would call a gated instance open.
 */
export function ErrorPage({ error }: { error: unknown }) {
  const notFound = isRouteErrorResponse(error) && error.status === 404;

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">{notFound ? "404 Not found" : "Something went wrong"}</h1>
          <p className="page-subtitle">
            {notFound
              ? "Nothing in this instance answers to that address."
              : "This page could not be built."}
          </p>
        </div>
      </header>

      <div className="empty-state">
        <p className="empty-state-headline">There is nothing to show here.</p>
        <p className="empty-state-detail">
          {notFound
            ? "A link may be out of date, or whatever it named may since have been removed. "
            : "Reloading may be enough; if it is not, the fault is in the instance rather than in what you asked for. "}
          Every screen is reachable from the dashboard — <Link to="/">go back to it</Link> and
          start again from there.
        </p>
      </div>
    </section>
  );
}
