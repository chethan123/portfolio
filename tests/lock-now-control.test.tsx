/**
 * The chrome control that ends a browser's own reading immediately (ticket
 * 06, docs/adr/0012).
 *
 * Rendered through `Layout`, `masking-toggle.test.tsx`'s own reason: "drawn
 * while the household holds a passkey at all" is a property of the shell,
 * not of any one page, and a component test rendering the control on its own
 * would not notice the shell dropping it or drawing it where it should not
 * appear.
 */
import { describe, expect, it } from "vitest";

import { LOCK_NOW_ACTION } from "~/lib/lock";

import { renderThroughLayout } from "./support/render.tsx";

const renderChrome = (hasPasskey: boolean) =>
  renderThroughLayout("/", { gated: true, firstRun: null, masked: false, hasPasskey });

/** Both markup copies — the rail's and the phone top bar's — the same reason `masking-toggle.test.tsx`'s `submittedStates` reads both. */
function lockNowForms(markup: string): string[] {
  return [...markup.matchAll(new RegExp(`<form[^>]*action="${LOCK_NOW_ACTION}"[^>]*>`, "g"))].map(
    ([tag]) => tag,
  );
}

/**
 * The markup from one container's opening tag to its own matching close,
 * read by class name rather than by nesting depth: `renderToStaticMarkup`
 * gives back one flat string, and counting forms alone (as the two tests
 * below used to) cannot tell "one in the rail, one in the bar" from "both in
 * the bar" or "one in the bottom nav the ticket forbids". Searching for the
 * first closing tag of `tag` after the opening one is enough here — none of
 * `app-rail`, `app-topbar-actions` or `app-bottomnav` nests another element
 * of its own tag name inside itself.
 */
function regionByClass(markup: string, className: string, tag: "nav" | "div"): string {
  const start = markup.indexOf(`class="${className}"`);
  if (start === -1) throw new Error(`no ${className} in markup`);
  const end = markup.indexOf(`</${tag}>`, start);
  return markup.slice(start, end);
}

describe("the lock-now control", () => {
  it("does not render at all while the household holds no passkey", () => {
    // The ticket's own reasoning: with nothing to unlock, this would clear a
    // grant that does not exist and send the reader to a screen no
    // credential can satisfy, while every route stays open behind it.
    const markup = renderChrome(false);

    expect(lockNowForms(markup)).toEqual([]);
    expect(markup).not.toContain("Lock now");
  });

  it("renders in the rail's foot and the top bar, and nowhere else, once the household holds a passkey", () => {
    // Not merely two forms in the markup — the ticket names exactly these
    // two positions and forbids a third, the phone's bottom nav; a control
    // moved there would still pass a bare `toHaveLength(2)`.
    const markup = renderChrome(true);

    expect(lockNowForms(markup)).toHaveLength(2);
    expect(regionByClass(markup, "app-rail", "nav")).toContain(`action="${LOCK_NOW_ACTION}"`);
    expect(regionByClass(markup, "app-topbar-actions", "div")).toContain(
      `action="${LOCK_NOW_ACTION}"`,
    );
    expect(regionByClass(markup, "app-bottomnav", "nav")).not.toContain(
      `action="${LOCK_NOW_ACTION}"`,
    );
    expect(regionByClass(markup, "app-bottomnav", "nav")).not.toContain("Lock now");
  });

  it("is a real form posting to the lock-now route, so it works with JavaScript off", () => {
    expect(renderChrome(true)).toMatch(
      new RegExp(`<form[^>]*action="${LOCK_NOW_ACTION}"[^>]*method="post"`),
    );
  });

  it("states the action, not a state — the only label this control ever has", () => {
    // Unlike the masking toggle, there is no second label: a browser
    // rendering this chrome at all is, by definition, not locked.
    expect(renderChrome(true)).toContain("Lock now");
  });

  it("does not render on the bare unlock shell, even on a household that holds a passkey", () => {
    // The bare-shell branch (`app/root.tsx`'s `Layout`) drops every control
    // for `/unlock`, this one included — a button offering to lock an
    // already-locked browser would also discard the return address that
    // screen was reached with. Guarded here rather than assumed, because it
    // is exactly the failure this control's own gating on `hasPasskey` would
    // reproduce if the bare-shell branch were ever narrowed to name
    // `MaskingToggle` alone.
    const markup = renderThroughLayout("/unlock", {
      gated: true,
      firstRun: null,
      masked: false,
      hasPasskey: true,
    });

    expect(markup).not.toContain("Lock now");
    expect(lockNowForms(markup)).toEqual([]);
  });
});
