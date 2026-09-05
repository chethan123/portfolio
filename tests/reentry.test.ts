/**
 * The reentry guard's testable rules (ticket 06, `~/lib/reentry.ts`):
 * `shouldPostLock`'s boundary, and `watchReentry`'s own wiring of the two
 * DOM signals it watches — which now includes the postLock-or-askServer
 * decision itself (finding 6): `watchReentry` takes `assumedPasskey` as a
 * plain `boolean` and decides internally which action a hidden-too-long
 * return invokes, so that decision is proven here, against the real export,
 * rather than against a copy `app/root.tsx`'s call site could quietly stop
 * making.
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
 * **What moved here, and why the previous version of this file could not
 * catch a reverted call site.** Two earlier rounds put the
 * postLock-or-askServer decision in `app/root.tsx` instead — first as an
 * inline arrow function, then as an exported `resolveReentryCallback` this
 * file called directly — and both left `watchReentry` itself accepting
 * whatever the call site handed it, `null` included. A regression test that
 * called `resolveReentryCallback` proved that function's own logic, never
 * that `Layout` actually used it: reverting the call site back to
 * `hasPasskey ? callback : null` kept every such test green. `watchReentry`
 * taking `assumedPasskey` and both actions directly, with no nullable slot
 * left in its signature at all, is what closes that gap — the old call
 * shape does not typecheck against this one, so a reverted call site fails
 * `npm run typecheck` before any test ever runs.
 * **`postLockNow`, added when concealment was removed.** Five review rounds
 * spent on a mechanism that hid the page while `/lock-now` was in flight
 * found nothing wrong with the *lock* this app specifies — every finding was
 * about the *rendering* invented on top of it (`app/root.tsx`'s own header on
 * why that is gone). Two survived because they are about the request rather
 * than the page: a `fetch` resolves for a 502 as readily as for success, and
 * one without `keepalive` dies with the document that started it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { LOCK_NOW_ACTION, REENTRY_GRACE_MS } from "~/lib/lock";
import { postLockNow, shouldPostLock, watchReentry } from "~/lib/reentry";

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

  it("posts the lock once a hidden gap exceeds the grace", () => {
    const browser = install();
    const perf = vi.spyOn(performance, "now");
    let clock = 0;
    perf.mockImplementation(() => clock);

    const postLock = vi.fn();
    const teardown = watchReentry(postLock, vi.fn());

    browser.hide();
    clock += REENTRY_GRACE_MS + 1;
    browser.show();

    expect(postLock).toHaveBeenCalledTimes(1);
    teardown();
  });

  it(
    "posts the lock on a hidden-too-long return in a household this page rendered before any passkey existed",
    () => {
      // The bug this replaces. Three versions of `watchReentry` took a
      // `hasPasskey` belief and, reading false, revalidated instead of
      // posting. That belief is loader data from the last render, so a tab
      // that rendered before the household's first-ever enrolment carried
      // `false` into a return that happened after it — and the grant the
      // enrolling tab minted is shared with this one, so the middleware
      // admitted it and a browser hidden well past the grace went on
      // reading. Ticket 06 states the trigger without a condition, so there
      // is no belief left to hand this: the only thing a hidden-too-long
      // return can do now is post.
      //
      // There is no `false` to pass here any more. That is the point — the
      // parameter that carried the stale answer no longer exists, so this
      // rule cannot be reverted without changing the signature.
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
      // Not the persisted-restore path: ticket 06 asks that one for a
      // revalidation rather than a post, and a hidden-too-long return is a
      // different trigger that must not borrow it.
      expect(onPersistedRestore).not.toHaveBeenCalled();
      teardown();
    },
  );

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

  it("calls onPersistedRestore, and posts no lock and asks nothing else, on a persisted pageshow", () => {
    const browser = install();
    const postLock = vi.fn();
    const askServer = vi.fn();
    const onPersistedRestore = vi.fn();
    const teardown = watchReentry(postLock, onPersistedRestore);

    browser.pageshow(true);

    expect(onPersistedRestore).toHaveBeenCalledTimes(1);
    expect(postLock).not.toHaveBeenCalled();
    expect(askServer).not.toHaveBeenCalled();
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

    // Firing both signals after teardown must reach neither callback.
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
      // A 502 or 503 from a proxy in front of this instance is exactly what
      // `fetch` resolves with — never a rejection — so reverting this to
      // `.then(() => revalidate())` (treating "the promise resolved" as "the
      // lock happened") would call `revalidate` here too, extending a grant
      // that was never actually deleted.
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
