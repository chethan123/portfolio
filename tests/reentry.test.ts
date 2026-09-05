/**
 * The reentry guard's testable rules (ticket 06, `~/lib/reentry.ts`):
 * `shouldPostLock`'s boundary, and `watchReentry`'s own wiring of the two
 * DOM signals it watches.
 *
 * `shouldPostLock` is exercised as the pure function it is — no document, no
 * window, no clock of its own. `watchReentry` genuinely touches `document`
 * and `window`, but only two methods of each
 * (`addEventListener`/`removeEventListener`) and a clock, so the second
 * describe block below stands a plain object in for each rather than a real
 * browser or jsdom (AGENTS.md's own rule against both) — the same call spec
 * 0007 made for masking's client-side cookie write, extended here now that
 * this file has something in that shape worth exercising for real.
 *
 * Every `shouldPostLock` assertion below measures the gap against the
 * *imported* `REENTRY_GRACE_MS` rather than a number copied out of it — not
 * because doing so pins every possible drift (a hard-coded `60_000` that
 * happens to equal today's grace would pass every assertion here exactly as
 * if it still imported the constant), but because the one drift this file
 * can actually catch — `reentry.ts` changing to declare a *different*
 * number instead of importing `lock.ts`'s — shows up here rather than only
 * in a real browser nobody is running.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { REENTRY_GRACE_MS } from "~/lib/lock";
import { shouldPostLock, watchReentry } from "~/lib/reentry";

describe("shouldPostLock", () => {
  it("never posts when this browser has not been hidden since it loaded", () => {
    expect(shouldPostLock(null, Date.now())).toBe(false);
  });

  it("does not post for a gap that merely reaches the grace", () => {
    // "Exceeds", not "reaches" — the ticket's own word. A story-4 app switch
    // landing exactly on the boundary must not read as tiresome.
    const now = Date.now();
    expect(shouldPostLock(now - REENTRY_GRACE_MS, now)).toBe(false);
  });

  it("does not post for a gap one millisecond short of the grace", () => {
    const now = Date.now();
    expect(shouldPostLock(now - REENTRY_GRACE_MS + 1, now)).toBe(false);
  });

  it("posts once the gap exceeds the grace by even one millisecond", () => {
    const now = Date.now();
    expect(shouldPostLock(now - REENTRY_GRACE_MS - 1, now)).toBe(true);
  });

  it("posts for a browser that was gone far longer than the grace", () => {
    const now = Date.now();
    expect(shouldPostLock(now - REENTRY_GRACE_MS * 10, now)).toBe(true);
  });
});

/**
 * Everything `watchReentry` actually asks of the global `document` and
 * `window` it closes over: two listener methods on each, one settable
 * `visibilityState`. Firing an event here is a direct call to whatever was
 * registered for it — no capture phase, no bubbling, none of jsdom's own
 * machinery — because `watchReentry` never asks for any of that either.
 */
type Listener = (event?: { persisted: boolean }) => void;

function fakeBrowser() {
  const documentListeners = new Map<string, Set<Listener>>();
  const windowListeners = new Map<string, Set<Listener>>();
  let visibilityState: "hidden" | "visible" = "visible";

  const on =
    (registry: Map<string, Set<Listener>>) =>
    (type: string, listener: Listener): void => {
      if (!registry.has(type)) registry.set(type, new Set());
      registry.get(type)?.add(listener);
    };
  const off =
    (registry: Map<string, Set<Listener>>) =>
    (type: string, listener: Listener): void => {
      registry.get(type)?.delete(listener);
    };

  const fakeDocument = {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener: on(documentListeners),
    removeEventListener: off(documentListeners),
  };
  const fakeWindow = {
    addEventListener: on(windowListeners),
    removeEventListener: off(windowListeners),
  };

  return {
    fakeDocument,
    fakeWindow,
    hide(): void {
      visibilityState = "hidden";
      documentListeners.get("visibilitychange")?.forEach((listener) => listener());
    },
    show(): void {
      visibilityState = "visible";
      documentListeners.get("visibilitychange")?.forEach((listener) => listener());
    },
    pageshow(persisted: boolean): void {
      windowListeners.get("pageshow")?.forEach((listener) => listener({ persisted }));
    },
    listenerCount(target: "document" | "window", type: string): number {
      const registry = target === "document" ? documentListeners : windowListeners;
      return registry.get(type)?.size ?? 0;
    },
  };
}

describe("watchReentry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // @ts-expect-error -- test-only globals, removed so no other file in this
    // serial suite (fileParallelism is off) ever sees a stray document/window.
    delete globalThis.document;
    // @ts-expect-error -- see above.
    delete globalThis.window;
  });

  function install(): ReturnType<typeof fakeBrowser> {
    const browser = fakeBrowser();
    globalThis.document = browser.fakeDocument as unknown as Document;
    globalThis.window = browser.fakeWindow as unknown as Window & typeof globalThis;
    return browser;
  }

  it("posts the lock, and does not ask the server, once a hidden gap exceeds the grace", () => {
    const browser = install();
    const perf = vi.spyOn(performance, "now");
    let clock = 0;
    perf.mockImplementation(() => clock);

    const postLock = vi.fn();
    const askServer = vi.fn();
    const teardown = watchReentry(postLock, askServer);

    browser.hide();
    clock += REENTRY_GRACE_MS + 1;
    browser.show();

    expect(postLock).toHaveBeenCalledTimes(1);
    expect(askServer).not.toHaveBeenCalled();
    teardown();
  });

  it("does not post for a hidden gap within the grace — an ordinary app switch", () => {
    const browser = install();
    const perf = vi.spyOn(performance, "now");
    let clock = 0;
    perf.mockImplementation(() => clock);

    const postLock = vi.fn();
    const teardown = watchReentry(postLock, vi.fn());

    browser.hide();
    clock += REENTRY_GRACE_MS - 1;
    browser.show();

    expect(postLock).not.toHaveBeenCalled();
    teardown();
  });

  it("asks the server, and does not post the lock, on a persisted pageshow", () => {
    const browser = install();
    const postLock = vi.fn();
    const askServer = vi.fn();
    const teardown = watchReentry(postLock, askServer);

    browser.pageshow(true);

    expect(askServer).toHaveBeenCalledTimes(1);
    expect(postLock).not.toHaveBeenCalled();
    teardown();
  });

  it("does not ask the server on an ordinary, non-persisted pageshow", () => {
    const browser = install();
    const askServer = vi.fn();
    const teardown = watchReentry(vi.fn(), askServer);

    browser.pageshow(false);

    expect(askServer).not.toHaveBeenCalled();
    teardown();
  });

  it("removes both listeners on teardown, so neither fires again afterward", () => {
    const browser = install();
    const perf = vi.spyOn(performance, "now");
    let clock = 0;
    perf.mockImplementation(() => clock);

    const postLock = vi.fn();
    const askServer = vi.fn();
    const teardown = watchReentry(postLock, askServer);

    expect(browser.listenerCount("document", "visibilitychange")).toBe(1);
    expect(browser.listenerCount("window", "pageshow")).toBe(1);

    teardown();

    expect(browser.listenerCount("document", "visibilitychange")).toBe(0);
    expect(browser.listenerCount("window", "pageshow")).toBe(0);

    // Firing both signals after teardown must reach neither callback.
    browser.hide();
    clock += REENTRY_GRACE_MS + 1;
    browser.show();
    browser.pageshow(true);

    expect(postLock).not.toHaveBeenCalled();
    expect(askServer).not.toHaveBeenCalled();
  });

  it(
    "still posts the lock once the grace is exceeded even when the wall clock jumps backwards while hidden",
    () => {
      // The point of finding 7: `Date.now()` can run backwards (an NTP
      // correction, someone setting the system clock back) and, unmocked,
      // would make this exact scenario silently disarm the trigger. Moving
      // `Date.now()` backwards here while `performance.now()` keeps
      // advancing normally proves the implementation reads the monotonic
      // clock rather than the wall clock — reverting `reentry.ts` to
      // `Date.now()` would fail this test, since the gap it would measure
      // goes negative instead of past the grace.
      const browser = install();
      const dateNow = vi.spyOn(Date, "now");
      let simulatedWallClock = 1_700_000_000_000;
      dateNow.mockImplementation(() => simulatedWallClock);

      const perf = vi.spyOn(performance, "now");
      let clock = 0;
      perf.mockImplementation(() => clock);

      const postLock = vi.fn();
      const teardown = watchReentry(postLock, vi.fn());

      browser.hide();
      // The wall clock jumps back an hour while the tab sits hidden — far
      // more than the grace, in the wrong direction.
      simulatedWallClock -= 60 * 60 * 1000;
      // `performance.now()` cannot jump backwards; it keeps moving forward
      // past the grace, same as any other hidden period this long.
      clock += REENTRY_GRACE_MS + 1;
      browser.show();

      expect(postLock).toHaveBeenCalledTimes(1);
      teardown();
    },
  );
});
