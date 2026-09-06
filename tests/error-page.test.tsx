import { isRouteErrorResponse } from "react-router";
import { describe, expect, it } from "vitest";

import { renderRoute } from "./support/render.tsx";

import { ErrorPage } from "~/components/error-page";

// Error page every thrown error lands on (a4#11). Bug this guards: one boundary produced two
// different pages for one status — /no-such-page printed the router's raw error string, while
// /accounts/999999 printed "404 " (empty statusText) over a loader's bare message. Rule: same
// status renders the same page, nothing the throwing code wrote appears on it.
// The two shapes below are hand-built (unreachable without a running router) and verified
// through isRouteErrorResponse so a shape drift fails here, not silently in the fallback branch.

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
    // Status line, empty on one and stale on the other, is never the title.
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
