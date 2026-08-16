import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import { Layout } from "../app/root.tsx";

/**
 * The persistent open-instance warning (DESIGN.md §10).
 *
 * Rendered through `Layout`, the shared shell every route is wrapped in, rather
 * than through the banner component on its own — the rule being protected is
 * "every page carries it", which a component test would not notice the shell
 * dropping.
 */

/** Render an arbitrary path inside the real `Layout`, with root loader data. */
function renderPage(path: string, rootData: { authConfigured: boolean }): string {
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "*",
      Component: () => (
        <Layout>
          <p>page body</p>
        </Layout>
      ),
    },
  ]);

  return renderToStaticMarkup(
    <Stub initialEntries={[path]} hydrationData={{ loaderData: { root: rootData } }} />,
  );
}

describe("the open-instance warning banner", () => {
  it("appears when no password is configured", () => {
    const markup = renderPage("/", { authConfigured: false });

    expect(markup).toContain("This instance has no password.");
    expect(markup).toContain("AUTH_PASSWORD");
  });

  it("appears on a page other than the home page too", () => {
    const markup = renderPage("/some/page/added/later", { authConfigured: false });

    expect(markup).toContain("This instance has no password.");
  });

  it("does not appear once a password is configured", () => {
    const markup = renderPage("/", { authConfigured: true });

    expect(markup).not.toContain("This instance has no password.");
    expect(markup).toContain("page body");
  });
});
