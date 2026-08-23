import { describe, expect, it } from "vitest";

import { renderThroughLayout } from "./support/render.tsx";

/**
 * The persistent open-instance warning (DESIGN.md §10).
 *
 * Rendered through `Layout`, the shared shell every route is wrapped in, rather
 * than through the banner component on its own — the rule being protected is
 * "every page carries it", which a component test would not notice the shell
 * dropping.
 */

/** The banner reads only `authConfigured`; the prompt is another file's rule. */
const renderPage = (path: string, authConfigured: boolean) =>
  renderThroughLayout(path, { authConfigured, firstRun: null });

describe("the open-instance warning banner", () => {
  it("appears when no password is configured", () => {
    const markup = renderPage("/", false);

    expect(markup).toContain("This instance has no password.");
    expect(markup).toContain("AUTH_PASSWORD");
  });

  it("appears on a page other than the home page too", () => {
    const markup = renderPage("/some/page/added/later", false);

    expect(markup).toContain("This instance has no password.");
  });

  it("does not appear once a password is configured", () => {
    const markup = renderPage("/", true);

    expect(markup).not.toContain("This instance has no password.");
    expect(markup).toContain("page body");
  });
});
