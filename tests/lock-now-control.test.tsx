// Lock-now chrome control (ticket 06, docs/adr/0012). Rendered through Layout (same reason as
// masking-toggle.test.tsx): "drawn only while the household holds a passkey" is a property of
// the shell, not any one page — a lone component test wouldn't notice the shell dropping it.
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

/** Markup from a container's opening tag to its matching close, by class name not nesting depth —
 * counting forms alone can't tell "one per region" from "both in one region" or "one in the
 * forbidden bottom nav". First closing tag after the opening one is enough — none of these nests. */
function regionByClass(markup: string, className: string, tag: "nav" | "div"): string {
  const start = markup.indexOf(`class="${className}"`);
  if (start === -1) throw new Error(`no ${className} in markup`);
  const end = markup.indexOf(`</${tag}>`, start);
  return markup.slice(start, end);
}

describe("the lock-now control", () => {
  it("does not render at all while the household holds no passkey", () => {
    // With nothing to unlock, this would clear a nonexistent grant and send the reader to
    // a screen no credential can satisfy, while every route stays open behind it.
    const markup = renderChrome(false);

    expect(lockNowForms(markup)).toEqual([]);
    expect(markup).not.toContain("Lock now");
  });

  it("renders in the rail's foot and the top bar, and nowhere else, once the household holds a passkey", () => {
    // Not merely two forms — ticket names exactly these two positions and forbids a third
    // (phone bottom nav); a control moved there would still pass a bare toHaveLength(2).
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
    // Unlike the masking toggle, no second label — rendering this chrome at all means not locked.
    expect(renderChrome(true)).toContain("Lock now");
  });

  it("does not render on the bare unlock shell, even on a household that holds a passkey", () => {
    // Bare-shell branch (app/root.tsx's Layout) drops every control for /unlock, this one included —
    // locking an already-locked browser would discard the return address. Guarded here, not assumed,
    // since narrowing the branch to name MaskingToggle alone would reproduce this failure.
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
