/**
 * The owner filter travelling between screens (spec 0013, ADR-0008).
 *
 * The filter survives a nav click because the links carry it and for no other
 * reason: there is no cookie and nothing stored, so the shell's markup *is* the
 * mechanism. That makes this the one rule in the slice a route test cannot see
 * — `tests/support/routes.ts` drives loaders, and a loader never renders the
 * rail — so it is asserted through `renderThroughLayout` on the real `Layout`.
 *
 * Two halves, and the second is the one that would go wrong quietly. The four
 * main items carry the owner param; Settings, rendered by the same component
 * from a different array, must not — it ignores the filter, and a parameter a
 * screen never reads should not appear in its URL. `NavItems` renders four
 * times and cannot tell which array it was handed, which is why the carry is a
 * prop at the call site rather than a change inside it.
 */
import { describe, expect, it } from "vitest";

import { renderThroughLayout } from "./support/render.tsx";

/** The shell, at an address, with the least root data `Layout` reads. */
const shell = (path: string) => renderThroughLayout(path, { gated: true, firstRun: null });

/**
 * Every navigation target the shell draws, in render order.
 *
 * Scoped to the nav links rather than to every `href` in the document, because
 * the masking toggle and the refresh control deliberately round-trip the whole
 * `pathname + search` through a `redirectTo` field — they put the reader back
 * where they were, which is a different job from carrying the filter.
 */
function navTargets(html: string): string[] {
  return [...html.matchAll(/<a [^>]*class="app-nav-link[^"]*" href="([^"]*)"/g)].map(
    ([, href]) => href ?? "",
  );
}

describe("the navigation under an owner filter", () => {
  it("carries the owner param onto every screen the filter reaches", () => {
    // Once for the desktop rail, once for the phone's bottom bar. `&amp;`
    // because `ownerSearch` now spells two owners as a repeated key
    // (`owner=1&owner=3`), and that `&` is HTML-escaped like any other
    // attribute value once it lands in an `href`.
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

    // The consequence ADR-0008 accepts out loud: an excursion into Settings or
    // an upload ends the reading, and the filter has to be set again.
    expect(navTargets(html).filter((target) => target.startsWith("/settings"))).toEqual([
      "/settings",
      "/settings",
    ]);
    expect(html).toContain('href="/upload"');
    expect(html).not.toContain("/upload?owner");
  });

  it("carries nothing but the owner param, whatever else the address holds", () => {
    // `location.search` verbatim would drag this screen's sort, its grouping
    // and a half-typed `edit` row key onto three screens that do not own any
    // of them — and would bounce every nav click through Holdings' canonical
    // redirect.
    const targets = navTargets(shell("/holdings?owner=3&group=kind&sort=quantity&dir=asc&edit=1.2"));

    expect(targets).toContain("/analysis?owner=3");
    expect(targets.some((target) => target.includes("sort=") || target.includes("edit="))).toBe(
      false,
    );
  });

  it("spells the selection the way the loaders redirect to, repeated key and all", () => {
    // `owner=1%2C3` (from a hand-joined string) would be a second spelling of
    // one view, and the screens compare the canonical address to `url.search`
    // as raw text — a nav link built from anything but `toOwnerParam` itself
    // risks exactly that.
    expect(navTargets(shell("/holdings?owner=1,3"))).toContain("/analysis?owner=1&amp;owner=3");
  });

  it("leaves an unfiltered instance's links bare", () => {
    // An empty search collapses to a bare path, so nothing about these URLs
    // changes for a household that has never touched the filter.
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
    // Rendered twice — the rail's head and the phone's top bar — and it is a
    // nav item in all but name: landing on an unfiltered Overview from a
    // filtered Holdings would be the most-clicked way to lose the filter.
    const html = shell("/holdings?owner=3");
    const brand = [...html.matchAll(/class="app-brand" href="([^"]*)"/g)];

    expect(brand.map(([, href]) => href)).toEqual(["/?owner=3", "/?owner=3"]);
  });

  it("marks the current screen active on the pathname alone, filter or none", () => {
    // `NavLink` resolves its active state on the pathname, so `end` on "/" and
    // the `aria-current` behaviour are unchanged by a search hanging off it.
    expect(shell("/analysis?owner=3")).toContain(
      '<a aria-current="page" class="app-nav-link app-nav-link--active" href="/analysis?owner=3"',
    );
    expect(shell("/?owner=3")).toContain(
      '<a aria-current="page" class="app-nav-link app-nav-link--active" href="/?owner=3"',
    );
  });
});
