import { Link, isRouteErrorResponse } from "react-router";

/**
 * The page a thrown error lands on, wherever it is caught.
 *
 * It exists because the two 404s this application can produce were two
 * different pages. Both come from one boundary and both are status 404, and
 * they rendered:
 *
 * ```
 *                    /no-such-page                   /accounts/999999
 *   title            404 Not Found                   "404 " (trailing space)
 *   subtitle         Error: No route matches         Not found
 *                    URL "/no-such-page"
 * ```
 *
 * Both defects are the same defect: the page printed the transport's own
 * strings. `statusText` is the router's for a route that matched nothing and
 * **empty** for a `data()`-thrown response, which is where the trailing space
 * came from; `error.data` is the router's developer sentence in one case —
 * quoted URL, `Error:` prefix and all — and a loader's bare "Not found" in the
 * other. A reader who hit one and then the other saw two designs for one event.
 *
 * So the wording here is ours and the status alone picks it. Nothing the
 * throwing code wrote is printed: a message that names an internal cause is
 * not something a household member on a phone can act on, and it is the reason
 * one of these two pages read like a stack trace.
 *
 * The `.empty-state` under the header is the other half. Both pages used to end
 * at the header's hairline — no route back from a dead URL, on an application
 * whose every other empty screen offers one (DESIGN.md §8.4).
 *
 * Deliberately not restored here: the open-instance banner, which `/accounts/…`
 * shows and `/no-such-page` does not. It is a claim about how this deployment
 * is configured, and root's loader is what establishes it; a URL that matched
 * no route never runs that loader, so the shell has no basis for the claim. The
 * banner says nothing stands in front of this instance — printing it on faith
 * would say that of an instance sitting behind the gate.
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
