import { describe, expect, it } from "vitest";

import { renderThroughLayout } from "./support/render.tsx";

/**
 * The persistent open-instance warning.
 *
 * Rendered through `Layout`, the shared shell every route is wrapped in, rather
 * than through the banner component on its own — the rule being protected is
 * "every page carries it", which a component test would not notice the shell
 * dropping.
 *
 * The absence case is the one that matters most: the banner is real security
 * signal, so showing it behind the gate would train the household to scroll
 * past the sentence that is true on an instance with nothing in front of it.
 */

/** The banner reads only `gated`; the first-run prompt is another file's rule. */
const renderPage = (path: string, gated: boolean) =>
  renderThroughLayout(path, { gated, firstRun: null });

/** The opening words, which are the whole of what the banner claims. */
const WARNING = "Nothing stands in front of this instance.";

describe("the open-instance warning banner", () => {
  it("appears when the app has not been told a gate fronts it", () => {
    expect(renderPage("/", false)).toContain(WARNING);
  });

  it("appears on a page other than the home page too", () => {
    expect(renderPage("/some/page/added/later", false)).toContain(WARNING);
  });

  it("does not appear once an external gate is declared", () => {
    const markup = renderPage("/", true);

    expect(markup).not.toContain(WARNING);
    expect(markup).toContain("page body");
  });

  it("never offers the configuration value as the way to make it go away", () => {
    // Naming AUTH_GATE would teach the one action that silences the warning
    // while leaving the instance open to anyone who can reach it. The fix the
    // banner points at is a gate in front, which is a deploy-time act.
    expect(renderPage("/", false)).not.toContain("AUTH_GATE");
  });
});
