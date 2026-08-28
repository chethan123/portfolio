/**
 * The control in the chrome (spec 0007, stories 5 and 34).
 *
 * Rendered through `Layout` rather than on its own, for the reason
 * `open-instance-banner.test.tsx` gives: the rule is "every screen carries it",
 * and a component test would not notice the shell dropping it.
 *
 * What is pinned here is the two things a person could be hurt by. The label
 * has to name the *action*, because someone who reads it as a description of
 * the screen clicks the wrong way and publishes their balances to the room. And
 * the control has to be on the page at all, because the seeded policy means a
 * first run is a page of dots, and dots with no visible cure is a broken app.
 */
import { describe, expect, it } from "vitest";

import { renderThroughLayout } from "./support/render.tsx";

const renderChrome = (masked: boolean) =>
  renderThroughLayout("/", { gated: true, firstRun: null, masked });

/**
 * The value each toggle button would submit.
 *
 * There are two of them in the markup — the rail's and the phone top bar's,
 * one of which CSS hides at any width — so this returns both, and a shell that
 * dropped one would fail here rather than pass on the survivor.
 */
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
    // The other half of story 5. A control that said "Amounts hidden" in this
    // state would be read as a label rather than as a button, and the reader
    // who wanted them back would have nothing to press.
    const markup = renderChrome(true);

    expect(markup).toContain("Show amounts");
    expect(markup).not.toContain("Hide amounts");
  });

  it("submits the state it is flipping to, not the one it is in", () => {
    // The button carries its value itself. A checkbox would contribute no entry
    // to the form data when unchecked, so the pending submission would read as
    // "unmask" in both directions and the optimistic flip would only ever work
    // one way.
    //
    // Read off the tag rather than matched as a substring: React does not
    // promise attribute order, and `name="masked" value="1"` passed or failed
    // on which order it happened to choose.
    expect(submittedStates(renderChrome(false))).toEqual(["1", "1"]);
    expect(submittedStates(renderChrome(true))).toEqual(["0", "0"]);
  });

  it("is a real form, so the toggle works with JavaScript off", () => {
    // Story 29. Asserted as one thing rather than as two attributes: what
    // matters is that a browser running no script has somewhere to post to,
    // and either half missing means the control does nothing at all there.
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
