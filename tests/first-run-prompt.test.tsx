import { describe, expect, it } from "vitest";

import { renderThroughLayout } from "./support/render.tsx";

import type { FirstRunStep } from "~/lib/first-run.server";

// Single first-run prompt (DESIGN.md §8.4). Rendered through Layout (same reason as the
// open-instance banner): "one prompt, on the pages a family member is looking at" is a
// property of the shell, not any page.

/** Every case here is on a configured instance; the banner is another file's rule. */
const renderPage = (path: string, firstRun: FirstRunStep) =>
  renderThroughLayout(path, { gated: true, firstRun });

describe("the first-run prompt", () => {
  it("points at People on an instance with nobody in it", () => {
    const markup = renderPage("/", "people");

    expect(markup).toContain("Add the people in your household");
    expect(markup).toContain('href="/settings/people"');
  });

  it("points at Accounts once somebody exists", () => {
    const markup = renderPage("/", "accounts");

    expect(markup).toContain('href="/settings/accounts"');
    // One step at a time: the People step is done and is not repeated.
    expect(markup).not.toContain('href="/settings/people"');
  });

  it("disappears once there is a person and an account", () => {
    const markup = renderPage("/", null);

    expect(markup).not.toContain("Start here.");
    expect(markup).not.toContain("One more step.");
    expect(markup).toContain("page body");
  });

  it("shows on the other read pages too, not only the home page", () => {
    expect(renderPage("/holdings", "people")).toContain(
      "Add the people in your household",
    );
    expect(renderPage("/income", "accounts")).toContain(
      "One more step.",
    );
  });

  it("does not nag inside Settings, where the work is actually done", () => {
    // Telling someone to go to Settings → People while standing on it is noise, sitting
    // right above the form that resolves it.
    const markup = renderPage("/settings/people", "people");

    expect(markup).not.toContain("Start here.");
    expect(markup).toContain("page body");
  });

  it("survives a first-run check that could not run", () => {
    // Root loader reports null when the database is unreachable — page renders without
    // a prompt, not as an error.
    expect(renderPage("/", null)).toContain("page body");
  });
});
