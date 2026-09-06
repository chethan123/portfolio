/**
 * Chrome control (spec 0007, stories 5, 34). Rendered through Layout, not standalone —
 * see open-instance-banner.test.tsx: "every screen carries it" needs the shell tested.
 */
import { describe, expect, it } from "vitest";

import { renderThroughLayout } from "./support/render.tsx";

const renderChrome = (masked: boolean) =>
  renderThroughLayout("/", { gated: true, firstRun: null, masked });

// two toggle buttons exist (rail + phone bar); returns both so a dropped one fails here
function submittedStates(markup: string): string[] {
  return [...markup.matchAll(/<button[^>]*class="masking-toggle"[^>]*>/g)].map(
    ([tag]) => /value="([^"]*)"/.exec(tag)?.[1] ?? "",
  );
}

describe("the masking toggle", () => {
  it("offers to hide the amounts while they are showing", () => {
    const markup = renderChrome(false);

    expect(markup).toContain("Hide amounts");
    expect(markup).not.toContain("Show amounts");
  });

  it("offers to show them again once they are hidden", () => {
    // story 5's other half — "Amounts hidden" reads as a label, nothing to press
    const markup = renderChrome(true);

    expect(markup).toContain("Show amounts");
    expect(markup).not.toContain("Hide amounts");
  });

  it("submits the state it is flipping to, not the one it is in", () => {
    // button carries its own value — a checkbox contributes no entry when unchecked
    // read off the tag itself: React doesn't promise attribute order, so a substring match wouldn't
    expect(submittedStates(renderChrome(false))).toEqual(["1", "1"]);
    expect(submittedStates(renderChrome(true))).toEqual(["0", "0"]);
  });

  it("is a real form, so the toggle works with JavaScript off", () => {
    // story 29 — no-JS needs both action and method; either missing breaks it
    expect(renderChrome(false)).toMatch(/<form[^>]*action="\/masking"[^>]*method="post"/);
  });

  it("carries the screen it was pressed on, so that path can return there", () => {
    const markup = renderThroughLayout("/holdings", {
      gated: true,
      firstRun: null,
      masked: false,
    });

    expect(markup).toContain('name="redirectTo" value="/holdings"');
  });
});
