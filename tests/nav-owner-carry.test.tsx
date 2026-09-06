/**
 * Owner filter travelling between nav links (spec 0013, ADR-0008). No cookie, no storage —
 * shell markup is the mechanism, so asserted via renderThroughLayout, not a route test.
 */
import { describe, expect, it } from "vitest";

import { renderThroughLayout } from "./support/render.tsx";

const shell = (path: string) => renderThroughLayout(path, { gated: true, firstRun: null });

// scoped to nav links, not every href — masking toggle/refresh control round-trip pathname+search
// via redirectTo, a different job from carrying the filter
function navTargets(html: string): string[] {
  return [...html.matchAll(/<a [^>]*class="app-nav-link[^"]*" href="([^"]*)"/g)].map(
    ([, href]) => href ?? "",
  );
}

describe("the navigation under an owner filter", () => {
  it("carries the owner param onto every screen the filter reaches", () => {
    // rail + phone bar, twice each. `&amp;`: two owners spell as a repeated `owner=` key, escaped in href
    expect(navTargets(shell("/holdings?owner=1,3"))).toEqual([
      "/?owner=1&amp;owner=3",
      "/holdings?owner=1&amp;owner=3",
      "/analysis?owner=1&amp;owner=3",
      "/income?owner=1&amp;owner=3",
      "/settings",
      "/?owner=1&amp;owner=3",
      "/holdings?owner=1&amp;owner=3",
      "/analysis?owner=1&amp;owner=3",
      "/income?owner=1&amp;owner=3",
      "/settings",
    ]);
  });

  it("does not carry it onto Settings or the upload flow, which ignore it", () => {
    const html = shell("/holdings?owner=1,3");

    // ADR-0008: Settings/upload end the filtered reading; it must be set again
    expect(navTargets(html).filter((target) => target.startsWith("/settings"))).toEqual([
      "/settings",
      "/settings",
    ]);
    expect(html).toContain('href="/upload"');
    expect(html).not.toContain("/upload?owner");
  });

  it("carries nothing but the owner param, whatever else the address holds", () => {
    // verbatim location.search would drag this screen's sort/group/edit onto screens that don't own them
    const targets = navTargets(shell("/holdings?owner=3&group=kind&sort=quantity&dir=asc&edit=1.2"));

    expect(targets).toContain("/analysis?owner=3");
    expect(targets.some((target) => target.includes("sort=") || target.includes("edit="))).toBe(
      false,
    );
  });

  it("spells the selection the way the loaders redirect to, repeated key and all", () => {
    // a hand-joined "owner=1%2C3" would be a second spelling; screens compare url.search as raw text
    expect(navTargets(shell("/holdings?owner=1,3"))).toContain("/analysis?owner=1&amp;owner=3");
  });

  it("leaves an unfiltered instance's links bare", () => {
    // empty search collapses to a bare path — unchanged for a household that's never touched the filter
    expect(navTargets(shell("/holdings?group=kind"))).toEqual([
      "/",
      "/holdings",
      "/analysis",
      "/income",
      "/settings",
      "/",
      "/holdings",
      "/analysis",
      "/income",
      "/settings",
    ]);
  });

  it("keeps the brand tile pointing at the filtered Overview", () => {
    // rail head + phone top bar; unfiltered Overview from filtered Holdings would be the easiest way to lose it
    const html = shell("/holdings?owner=3");
    const brand = [...html.matchAll(/class="app-brand" href="([^"]*)"/g)];

    expect(brand.map(([, href]) => href)).toEqual(["/?owner=3", "/?owner=3"]);
  });

  it("marks the current screen active on the pathname alone, filter or none", () => {
    // NavLink resolves active state on the pathname alone; a trailing search doesn't change it
    expect(shell("/analysis?owner=3")).toContain(
      '<a aria-current="page" class="app-nav-link app-nav-link--active" href="/analysis?owner=3"',
    );
    expect(shell("/?owner=3")).toContain(
      '<a aria-current="page" class="app-nav-link app-nav-link--active" href="/?owner=3"',
    );
  });
});
