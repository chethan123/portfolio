/**
 * The reentry guard's testable rules (ticket 06, `~/lib/reentry.ts`):
 * `shouldPostLock`'s boundary, and `watchReentry`'s own wiring of the two
 * DOM signals it watches.
 *
 * `shouldPostLock` is exercised as the pure function it is — no document, no
 * window, no clock of its own. `watchReentry` genuinely touches `document`
 * and `window`, but only two methods of each
 * (`addEventListener`/`removeEventListener`) and two clocks, so the second
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
 *
 * `resolveReentryCallback` lives in `app/root.tsx`, not here, because it is
 * `Layout`'s own decision, not `watchReentry`'s (its own header there argues
 * why) — but it is imported directly below, the same way `tests/routes/
 * root.test.ts` already reaches into `app/root.tsx` for `loader` and
 * `middleware` without rendering anything. A review of this pull request
 * found the previous version of the test just below constructed its own
 * copy of `Layout`'s decision instead of importing it, which stayed green
 * even after reverting the production wiring back to the bug it was meant to
 * catch — calling the real export is what closes that gap.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveReentryCallback } from "../app/root.tsx";
import { REENTRY_GRACE_MS } from "~/lib/lock";
import { shouldPostLock, watchReentry } from "~/lib/reentry";

describe("shouldPostLock", () => {
  it("never posts when this browser has not been hidden since it loaded", () => {
    expect(shouldPostLock(null, Date.now(), performance.now())).toBe(false);
  });

  it("does not post for a gap that merely reaches the grace", () => {
    // "Exceeds", not "reaches" — the ticket's own word. A story-4 app switch
    // landing exactly on the boundary must not read as tiresome. Both
    // clocks agree here, which is the ordinary case.
    const wallMs = Date.now();
    const monoMs = performance.now();
    expect(
      shouldPostLock({ wallMs: wallMs - REENTRY_GRACE_MS, monoMs: monoMs - REENTRY_GRACE_MS }, wallMs, monoMs),
    ).toBe(false);
  });

  it("does not post for a gap one millisecond short of the grace", () => {
    const wallMs = Date.now();
    const monoMs = performance.now();
    expect(
      shouldPostLock(
        { wallMs: wallMs - REENTRY_GRACE_MS + 1, monoMs: monoMs - REENTRY_GRACE_MS + 1 },
        wallMs,
        monoMs,
      ),
    ).toBe(false);
  });

  it("posts once the gap exceeds the grace by even one millisecond", () => {
    const wallMs = Date.now();
    const monoMs = performance.now();
    expect(
      shouldPostLock(
        { wallMs: wallMs - REENTRY_GRACE_MS - 1, monoMs: monoMs - REENTRY_GRACE_MS - 1 },
        wallMs,
        monoMs,
      ),
    ).toBe(true);
  });

  it("posts for a browser that was gone far longer than the grace", () => {
    const wallMs = Date.now();
    const monoMs = performance.now();
    expect(
      shouldPostLock(
        { wallMs: wallMs - REENTRY_GRACE_MS * 10, monoMs: monoMs - REENTRY_GRACE_MS * 10 },
        wallMs,
        monoMs,
      ),
    ).toBe(true);
  });

  it("posts once the wall gap alone exceeds the grace, even though the monotonic clock stalled through a suspend", () => {
    // The scenario `Math.max` exists for: `performance.now()` does not
    // advance while a device is suspended, so a phone locked in a pocket
    // for ten minutes can come back with a monotonic gap of only a
    // millisecond — under the grace on its own. The wall gap, which does
    // advance through a suspend, is what has to carry this.
    const hidden = { wallMs: 0, monoMs: 0 };
    expect(shouldPostLock(hidden, REENTRY_GRACE_MS + 1, 1)).toBe(true);
  });

  it("posts once the monotonic gap alone exceeds the grace, even though the wall clock ran backwards", () => {
    // The other direction: an NTP correction, or someone setting the system
    // clock back, makes the wall gap negative. The monotonic gap — which
    // cannot run backwards — is what has to carry this one, and the
    // negative wall value simply loses the `Math.max`.
    const hidden = { wallMs: 1_700_000_000_000, monoMs: 0 };
    const nowWallMs = hidden.wallMs - 60 * 60 * 1000; // the clock jumps back an hour
    const nowMonoMs = REENTRY_GRACE_MS + 1;
    expect(shouldPostLock(hidden, nowWallMs, nowMonoMs)).toBe(true);
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
    /** Sets `visibilityState` to hidden *before* any listener need exist to notice. */
    hideSilently(): void {
      visibilityState = "hidden";
    },
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

  it("arms the timer at wire time for a page that mounts into an already-hidden tab, not only on a later visibilitychange", () => {
    // A page opened in a background tab, or hydrated while the document is
    // already hidden, never sees a `visibilitychange` *to* hidden — its
    // first event is the transition back to visible. Hiding the fake
    // browser *before* `watchReentry` ever wires a listener reproduces
    // exactly that: nothing here catches the transition into hidden, only
    // `watchReentry`'s own read of the current `visibilityState` at wire
    // time can arm the timer.
    const browser = install();
    const perf = vi.spyOn(performance, "now");
    let clock = 0;
    perf.mockImplementation(() => clock);

    browser.hideSilently();

    const postLock = vi.fn();
    const teardown = watchReentry(postLock, vi.fn());

    clock += REENTRY_GRACE_MS + 1;
    browser.show();

    expect(postLock).toHaveBeenCalledTimes(1);
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

  it("installs no visibilitychange listener at all, and never posts, when there is nothing to post a lock for", () => {
    // `app/root.tsx` passes `null` wherever the household holds no passkey
    // (finding 3): the `pageshow` half still installs — it only
    // revalidates — but the `visibilitychange`/`postLock` half must not,
    // since posting a lock for nothing would send the reader on a pointless
    // round trip. Proven on the listener count, not only on the callback
    // never firing, because installing a no-op listener would still leave
    // stale hidden-timer state ticking for no reason.
    const browser = install();
    const askServer = vi.fn();
    const teardown = watchReentry(null, askServer);

    expect(browser.listenerCount("document", "visibilitychange")).toBe(0);
    expect(browser.listenerCount("window", "pageshow")).toBe(1);

    // Hiding and showing the tab has no listener left to notice at all.
    browser.hide();
    browser.show();

    browser.pageshow(true);
    expect(askServer).toHaveBeenCalledTimes(1);

    teardown();
    expect(browser.listenerCount("window", "pageshow")).toBe(0);
  });

  it(
    "still posts the lock once the grace is exceeded even when the wall clock jumps backwards while hidden",
    () => {
      // `Date.now()` can run backwards (an NTP correction, someone setting
      // the system clock back), which would make the *wall* gap negative.
      // Moving `Date.now()` backwards here while `performance.now()` keeps
      // advancing normally past the grace proves the monotonic gap is what
      // carries this — reverting `reentry.ts` to read only `Date.now()`
      // would fail this test, since the gap it would measure goes negative
      // instead of past the grace.
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

  it(
    "would have left a passkey enrolled elsewhere unnoticed for this tab's whole lifetime under the old, hasPasskey-gated installation — and does not under the fix",
    () => {
      // A page renders with `hasPasskey: false` — the household held none
      // yet — and then, in another browser entirely, enrols its first
      // passkey. This tab is never told; its own `hasPasskey` is baked in at
      // render time and stays false for as long as the page lives.
      // `app/root.tsx` used to decide whether to install this half *at all*
      // off that same stale flag (`hasPasskey ? cb : null`, reproduced
      // literally as `postLockOld` below): with no passkey believed
      // enrolled, it passed `null`, and `watchReentry` skips installing the
      // `visibilitychange` listener outright for a `null` `postLock` — not
      // only for the return in progress, but for the rest of this tab's
      // life, since nothing re-runs the effect that decided it.
      // Foregrounding the tab after the grace, having missed the enrolment,
      // produces an ordinary, non-persisted `pageshow` — the *other* half's
      // own trigger — so nothing here ever asks the server either. The fix
      // moves the decision inside the callback instead of into whether it
      // installs: `resolveReentryCallback` — imported from `app/root.tsx`
      // itself, not reproduced here — is what decides now, on the identical
      // stale-`false` render, always returning a real function rather than
      // `null`. Calling the production function directly, rather than a
      // hand-written stand-in for it, is what makes reverting `app/root.tsx`'s
      // wiring back to the old ternary fail this test: that revert removes
      // this function's only production caller and, with it, the export
      // this file imports.
      const perf = vi.spyOn(performance, "now");
      let clock = 0;
      perf.mockImplementation(() => clock);

      const hasPasskeyAtRender = false; // the stale belief this render was built on

      const postToLockNow = vi.fn();
      const postLockOld = hasPasskeyAtRender ? postToLockNow : null;
      const oldBrowser = install();
      const teardownOld = watchReentry(postLockOld, vi.fn());

      oldBrowser.hide();
      clock += REENTRY_GRACE_MS + 1;
      oldBrowser.show();

      // The bug, reproduced: no listener was ever installed, so nothing
      // here noticed the return at all.
      expect(oldBrowser.listenerCount("document", "visibilitychange")).toBe(0);
      expect(postToLockNow).not.toHaveBeenCalled();
      teardownOld();

      const askServer = vi.fn();
      const postLockNew = resolveReentryCallback(hasPasskeyAtRender, {
        postLock: postToLockNow,
        askServer,
      });
      const newBrowser = install();
      const teardownNew = watchReentry(postLockNew, vi.fn());

      newBrowser.hide();
      clock += REENTRY_GRACE_MS + 1;
      newBrowser.show();

      // The fix: the listener is installed regardless, so the return is
      // noticed — and, on this same stale belief, it asks the server
      // (which re-checks the live database) rather than staying silent.
      expect(newBrowser.listenerCount("document", "visibilitychange")).toBe(1);
      expect(askServer).toHaveBeenCalledTimes(1);
      expect(postToLockNow).not.toHaveBeenCalled();
      teardownNew();
    },
  );

  describe("resolveReentryCallback", () => {
    it("returns the postLock action once a passkey is believed enrolled, so the reentry guard still posts the lock", () => {
      const postLock = vi.fn();
      const askServer = vi.fn();

      resolveReentryCallback(true, { postLock, askServer })();

      expect(postLock).toHaveBeenCalledTimes(1);
      expect(askServer).not.toHaveBeenCalled();
    });

    it("returns the askServer action while no passkey is believed enrolled, rather than a callback that stays silent", () => {
      const postLock = vi.fn();
      const askServer = vi.fn();

      resolveReentryCallback(false, { postLock, askServer })();

      expect(askServer).toHaveBeenCalledTimes(1);
      expect(postLock).not.toHaveBeenCalled();
    });
  });

  it(
    "still posts the lock once the grace is exceeded even though the monotonic clock stalled through a suspend",
    () => {
      // The other direction, and the more important one: `performance.now()`
      // does not advance while a device is suspended (Linux, Android,
      // macOS, iOS), so a phone locked in a pocket for ten minutes can come
      // back measuring a monotonic gap of only a couple of milliseconds —
      // under the grace on its own. The wall clock, which does advance
      // through a suspend, is what has to carry this one; reverting
      // `reentry.ts` to read only `performance.now()` would fail this test,
      // since the monotonic gap it would measure alone stays under the
      // grace.
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
      // The device suspends: the wall clock keeps advancing well past the
      // grace, but the monotonic clock barely moves at all.
      simulatedWallClock += REENTRY_GRACE_MS + 1;
      clock += 2;
      browser.show();

      expect(postLock).toHaveBeenCalledTimes(1);
      teardown();
    },
  );
});
