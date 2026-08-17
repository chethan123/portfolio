import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import { Layout } from "../app/root.tsx";

import type { FirstRunStep } from "~/lib/first-run.server";

/**
 * The single first-run prompt (DESIGN.md §8.4).
 *
 * Rendered through `Layout`, the shared shell, for the same reason the
 * open-instance banner is: the rule is "one prompt, on the pages a family
 * member is actually looking at", which is a property of the shell rather than
 * of any page.
 */

function renderPage(
  path: string,
  rootData: { authConfigured: boolean; firstRun: FirstRunStep },
): string {
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

const configured = { authConfigured: true };

describe("the first-run prompt", () => {
  it("points at People on an instance with nobody in it", () => {
    const markup = renderPage("/", { ...configured, firstRun: "people" });

    expect(markup).toContain("Add the people in your household");
    expect(markup).toContain('href="/settings/people"');
  });

  it("points at Accounts once somebody exists", () => {
    const markup = renderPage("/", { ...configured, firstRun: "accounts" });

    expect(markup).toContain('href="/settings/accounts"');
    // One step at a time: the People step is done and is not repeated.
    expect(markup).not.toContain('href="/settings/people"');
  });

  it("disappears once there is a person and an account", () => {
    const markup = renderPage("/", { ...configured, firstRun: null });

    expect(markup).not.toContain("Start here.");
    expect(markup).not.toContain("One more step.");
    expect(markup).toContain("page body");
  });

  it("shows on the other read pages too, not only the home page", () => {
    expect(renderPage("/holdings", { ...configured, firstRun: "people" })).toContain(
      "Add the people in your household",
    );
    expect(renderPage("/income", { ...configured, firstRun: "accounts" })).toContain(
      "One more step.",
    );
  });

  it("does not nag inside Settings, where the work is actually done", () => {
    // Telling someone to go to Settings → People while they are standing on
    // Settings → People is noise, and it would sit directly above the form that
    // resolves it.
    const markup = renderPage("/settings/people", { ...configured, firstRun: "people" });

    expect(markup).not.toContain("Start here.");
    expect(markup).toContain("page body");
  });

  it("survives a first-run check that could not run", () => {
    // The root loader reports null when the database is unreachable, so the
    // page renders without a prompt rather than as an error.
    expect(renderPage("/", { ...configured, firstRun: null })).toContain("page body");
  });
});
