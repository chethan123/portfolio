import { Link, isRouteErrorResponse } from "react-router";

/**
 * The page a thrown error lands on, wherever it is caught. The wording is
 * ours and the status alone picks it, because the transport's own strings
 * vary by throw path — `statusText` is the router's for an unmatched route
 * and empty for a `data()` throw; `error.data` is a developer sentence
 * (quoted URL, `Error:` prefix) or a loader's bare words — which once gave
 * the two 404s this app produces two different pages. Nothing the throwing
 * code wrote is printed: a message naming an internal cause is not something
 * a household member on a phone can act on.
 *
 * The `.empty-state` under the header offers the route back every other
 * empty screen offers (DESIGN.md §8.4). Deliberately not restored: the
 * open-instance banner — a claim about the deployment that root's loader
 * establishes, and a URL matching no route never runs that loader; printing
 * it on faith would call a gated instance open.
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
