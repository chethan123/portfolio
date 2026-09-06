/**
 * Reentry guard (ticket 06, ~/lib/reentry.ts): shouldPostLock's boundary, and watchReentry's
 * wiring of the two DOM signals it watches, against the real export. shouldPostLock is pure;
 * watchReentry gets a plain object standing in for document/window (AGENTS.md's rule against
 * jsdom), touching only addEventListener/removeEventListener and two clocks.
 * Measured against the imported REENTRY_GRACE_MS, not a copied number, so reentry.ts declaring
 * a different constant shows up here rather than only in a real browser.
 * watchReentry takes no hasPasskey belief — three earlier rounds gave it one, each leaving the
 * call site free to hand it something stale; the fix is that the old call shape no longer
 * typechecks, so a reverted call site fails `npm run typecheck` before any test runs.
 * postLockNow: review found nothing wrong with the lock itself, only invented rendering on top
 * of it (now removed); it still guards a fetch that resolves for a 502 and one without keepalive.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { LOCK_NOW_ACTION, REENTRY_GRACE_MS } from "~/lib/lock";
import { postLockNow, shouldPostLock, watchReentry } from "~/lib/reentry";

describe("shouldPostLock", () => {
  it("never posts when this browser has not been hidden since it loaded", () => {
    expect(shouldPostLock(null, Date.now(), performance.now())).toBe(false);
  });

  it("does not post for a gap that merely reaches the grace", () => {
    // "exceeds" not "reaches" (ticket's word) — landing exactly on the boundary must not read as tiresome
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
    // Math.max's scenario: performance.now() doesn't advance while suspended, so the wall gap
    // has to carry a phone locked in a pocket for ten minutes
    const hidden = { wallMs: 0, monoMs: 0 };
    expect(shouldPostLock(hidden, REENTRY_GRACE_MS + 1, 1)).toBe(true);
  });

  it("posts once the monotonic gap alone exceeds the grace, even though the wall clock ran backwards", () => {
    // other direction: NTP correction/clock set back makes the wall gap negative — the
    // monotonic gap (can't run backwards) carries this; the negative wall value just loses the Math.max
    const hidden = { wallMs: 1_700_000_000_000, monoMs: 0 };
    const nowWallMs = hidden.wallMs - 60 * 60 * 1000; // the clock jumps back an hour
    const nowMonoMs = REENTRY_GRACE_MS + 1;
    expect(shouldPostLock(hidden, nowWallMs, nowMonoMs)).toBe(true);
  });
});

// everything watchReentry asks of document/window: two listener methods each, one settable
// visibilityState. Firing here is a direct call to whatever registered — no capture/bubbling/jsdom.
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
    // sets visibilityState to hidden before any listener need exist to notice
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
    // @ts-expect-error -- test-only globals, removed so no other serial-suite file sees a stray document/window
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

  it("posts the lock once a hidden gap exceeds the grace", () => {
    const browser = install();
    const perf = vi.spyOn(performance, "now");
    let clock = 0;
    perf.mockImplementation(() => clock);

    const postLock = vi.fn();
    const onPersistedRestore = vi.fn();
    const teardown = watchReentry(postLock, onPersistedRestore);

    browser.hide();
    clock += REENTRY_GRACE_MS + 1;
    browser.show();

    expect(postLock).toHaveBeenCalledTimes(1);
    // only the lock — persisted-restore is a different trigger and must not borrow this one
    expect(onPersistedRestore).not.toHaveBeenCalled();
    teardown();
  });

  it("installs both listeners unconditionally, never skipping one the way the old hasPasskey-gated call site could", () => {
    const browser = install();
    const teardown = watchReentry(vi.fn(), vi.fn());

    expect(browser.listenerCount("document", "visibilitychange")).toBe(1);
    expect(browser.listenerCount("window", "pageshow")).toBe(1);

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
    // a background-tab or hidden-hydrated page never sees a visibilitychange to hidden — only
    // watchReentry's own read of visibilityState at wire time can arm the timer
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

  it("calls onPersistedRestore, and posts no lock and asks nothing else, on a persisted pageshow", () => {
    const browser = install();
    const postLock = vi.fn();
    const onPersistedRestore = vi.fn();
    const teardown = watchReentry(postLock, onPersistedRestore);

    browser.pageshow(true);

    expect(onPersistedRestore).toHaveBeenCalledTimes(1);
    expect(postLock).not.toHaveBeenCalled();
    teardown();
  });

  it("does not call onPersistedRestore on an ordinary, non-persisted pageshow", () => {
    const browser = install();
    const onPersistedRestore = vi.fn();
    const teardown = watchReentry(vi.fn(), onPersistedRestore);

    browser.pageshow(false);

    expect(onPersistedRestore).not.toHaveBeenCalled();
    teardown();
  });

  it("removes both listeners on teardown, so neither fires again afterward", () => {
    const browser = install();
    const perf = vi.spyOn(performance, "now");
    let clock = 0;
    perf.mockImplementation(() => clock);

    const postLock = vi.fn();
    const onPersistedRestore = vi.fn();
    const teardown = watchReentry(postLock, onPersistedRestore);

    expect(browser.listenerCount("document", "visibilitychange")).toBe(1);
    expect(browser.listenerCount("window", "pageshow")).toBe(1);

    teardown();

    expect(browser.listenerCount("document", "visibilitychange")).toBe(0);
    expect(browser.listenerCount("window", "pageshow")).toBe(0);

    // firing both signals after teardown must reach neither callback
    browser.hide();
    clock += REENTRY_GRACE_MS + 1;
    browser.show();
    browser.pageshow(true);

    expect(postLock).not.toHaveBeenCalled();
    expect(onPersistedRestore).not.toHaveBeenCalled();
  });

  it(
    "still posts the lock once the grace is exceeded even when the wall clock jumps backwards while hidden",
    () => {
      // Date.now() can run backwards (NTP, manual clock set); moving it back here while
      // performance.now() advances past the grace proves the monotonic gap carries this —
      // reverting to Date.now() alone would fail, since the gap would go negative instead
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
      // wall clock jumps back an hour while hidden — far more than the grace, wrong direction
      simulatedWallClock -= 60 * 60 * 1000;
      // performance.now() can't jump backwards — keeps advancing past the grace like any long hidden period
      clock += REENTRY_GRACE_MS + 1;
      browser.show();

      expect(postLock).toHaveBeenCalledTimes(1);
      teardown();
    },
  );

  it(
    "still posts the lock once the grace is exceeded even though the monotonic clock stalled through a suspend",
    () => {
      // the more important direction: performance.now() doesn't advance while suspended (all
      // major OSes) — the wall clock has to carry a phone locked in a pocket for ten minutes;
      // reverting to performance.now() alone would fail this test
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
      // device suspends: wall clock advances well past the grace, monotonic clock barely moves
      simulatedWallClock += REENTRY_GRACE_MS + 1;
      clock += 2;
      browser.show();

      expect(postLock).toHaveBeenCalledTimes(1);
      teardown();
    },
  );
});


describe("postLockNow", () => {
  it("posts to LOCK_NOW_ACTION with keepalive, and revalidates, once the response says the lock happened (finding 3's own request shape)", async () => {
    const revalidate = vi.fn();
    const doFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await postLockNow(revalidate, doFetch);

    expect(doFetch).toHaveBeenCalledWith(LOCK_NOW_ACTION, {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
    });
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it(
    "does not revalidate when the response answers with an HTTP failure, even though fetch itself resolved (finding 1)",
    async () => {
      // a 502/503 from a fronting proxy is exactly what fetch resolves with, never rejects —
      // reverting to .then(() => revalidate()) would extend a grant that was never actually deleted
      const revalidate = vi.fn();
      const doFetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));

      await postLockNow(revalidate, doFetch);

      expect(revalidate).not.toHaveBeenCalled();
    },
  );

  it(
    "does not revalidate when the post itself rejects — a network failure, or the document unloading mid-flight without keepalive",
    async () => {
      const revalidate = vi.fn();
      const doFetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

      await postLockNow(revalidate, doFetch);

      expect(revalidate).not.toHaveBeenCalled();
    },
  );
});
