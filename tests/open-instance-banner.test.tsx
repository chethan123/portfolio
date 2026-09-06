import { describe, expect, it } from "vitest";

import { renderThroughLayout } from "./support/render.tsx";

// Rendered through Layout, not the banner alone — "every page carries it" needs the shell tested.
// Absence matters most: showing it behind the gate trains the household to ignore real signal.

const renderPage = (path: string, gated: boolean) =>
  renderThroughLayout(path, { gated, firstRun: null });

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
    // naming AUTH_GATE would teach the one action that silences the warning while staying open
    expect(renderPage("/", false)).not.toContain("AUTH_GATE");
  });
});
