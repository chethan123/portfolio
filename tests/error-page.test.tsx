import { isRouteErrorResponse } from "react-router";
import { describe, expect, it } from "vitest";

import { renderRoute } from "./support/render.tsx";

import { ErrorPage } from "~/components/error-page";

/**
 * The page every thrown error lands on (a4#11).
 *
 * The bug this protects against is that one boundary produced two pages for one
 * status code. `/no-such-page` printed "404 Not Found" over the router's own
 * `Error: No route matches URL "/no-such-page"`, and `/accounts/999999` printed
 * "404 " — the trailing space is an empty `statusText` — over a loader's bare
 * "Not found". Both defects came from printing the transport's strings, so the
 * rule is: **the same status renders the same page, and nothing the throwing
 * code wrote appears on it.**
 *
 * The two error shapes below are what the router hands a boundary in those two
 * cases. They are built by hand because neither is reachable without a running
 * router, so each is first put through `isRouteErrorResponse` — if the shape
 * ever drifts, these fail here rather than silently testing the fallback
 * branch.
 */

/** What React Router throws when no route matches the URL at all. */
const NO_ROUTE_MATCHES = {
  status: 404,
  statusText: "Not Found",
  internal: true,
  data: 'Error: No route matches URL "/no-such-page"',
};

/** What a loader's `data("Not found", { status: 404 })` becomes. */
const LOADER_NOT_FOUND = {
  status: 404,
  statusText: "",
  internal: false,
  data: "Not found",
};

const render = (error: unknown) =>
  renderRoute(() => <ErrorPage error={error} />, "/anything", null);

describe("the error page", () => {
  it("is built from the shapes the router actually throws", () => {
    expect(isRouteErrorResponse(NO_ROUTE_MATCHES)).toBe(true);
    expect(isRouteErrorResponse(LOADER_NOT_FOUND)).toBe(true);
  });

  it("renders one page for both of the 404s this application can produce", () => {
    expect(render(NO_ROUTE_MATCHES)).toBe(render(LOADER_NOT_FOUND));
  });

  it("prints neither the status text nor the body the throwing code wrote", () => {
    const markup = render(NO_ROUTE_MATCHES) + render(LOADER_NOT_FOUND);

    expect(markup).not.toContain("No route matches");
    expect(markup).not.toContain("/no-such-page");
    // The status line, empty on one and stale on the other, is never the title.
    expect(markup).toContain("404 Not found");
    expect(markup).not.toContain("404 Not Found");
  });

  it("offers a route back out, which neither 404 used to have", () => {
    expect(render(LOADER_NOT_FOUND)).toContain('href="/"');
    expect(render(LOADER_NOT_FOUND)).toContain("empty-state");
  });

  it("says something else for a fault, and still does not print its message", () => {
    const markup = render(new Error("connect ECONNREFUSED 127.0.0.1:5432"));

    expect(markup).toContain("Something went wrong");
    expect(markup).not.toContain("ECONNREFUSED");
    expect(markup).toContain('href="/"');
  });
});
