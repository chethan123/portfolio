/**
 * The reentry guard (docs/adr/0012, spec 0019, ticket 06): what a browser
 * does about being hidden and shown again, on top of the server-side idle
 * window `lock.server.ts`'s `touchGrant` already enforces on its own. Plain
 * `.ts`, not `.server.ts` — `lock.ts`'s own reason: this runs in the browser,
 * and it imports {@link REENTRY_GRACE_MS} from there rather than declaring a
 * second constant naming the same grace.
 *
 * **The trigger is courtesy, never enforcement — worth saying here because
 * the next reader will otherwise assume the security lives in this file.**
 * The two clock reads that bracket a hidden period are exact, not a lower
 * bound: nothing here ticks while the tab is hidden, so there is no timer to
 * throttle and no drift to round away, and a browser suspended before
 * `visibilitychange` fires at all simply measures no gap rather than an
 * understated one. What this file genuinely cannot do is tell a phone locked
 * in somebody's pocket from a screen genuinely handed over — both hide the
 * page identically, and there is no signal here to tell them apart. That
 * limit is not the hole it sounds like: what {@link watchReentry}'s
 * `postLock` callback does once called is a real POST to the same route the
 * chrome's own "Lock now" control posts to, deleting the grant row
 * server-side — that deletion is not a courtesy, it is the one thing here
 * that is not a suggestion. And if a browser never fires `visibilitychange`
 * at all because it was suspended before it could, the grant simply rides
 * out its own fifteen-minute idle window instead; nothing about this file
 * staying silent leaves a browser unlocked forever.
 *
 * **The `pageshow` half answers a narrower, uglier gap than a timer ever
 * could.** Chrome has admitted a `Cache-Control: no-store` document to its
 * back/forward cache by default since 2025, caps such an entry's life at
 * three minutes, and evicts it early only when *this browser's* cookies
 * change — unconditionally for an `HttpOnly` one, which is what this lock's
 * own grant cookie is. Neither the cap nor that eviction fires when a
 * passkey or a grant is removed from a *different* device: nothing about
 * this cookie jar changes, and a Back gesture can hand back a fully rendered
 * page of balances with no request reaching the server at all, for as long
 * as three minutes. `pageshow`'s own `event.persisted` is exactly the signal
 * Chromium's own explainer names for this gap: true only on a restore from
 * that cache, never on an ordinary load. Firefox refuses a `no-store`
 * document into its own back/forward cache outright, regardless of
 * protocol; Safari/WebKit's refusal is narrower —
 * `Source/WebCore/history/BackForwardCache.cpp` (HEAD `6787a18c74`, lines
 * 156–160) guards it on `document->url().protocolIs("https")`, so the
 * identical response over plain HTTP is left eligible for its cache. This
 * app refuses a non-HTTPS `PUBLIC_ORIGIN` except for `localhost`/
 * `127.0.0.1` (`server/config.ts`), so in production Safari refuses the
 * cache too; it is the plain-HTTP development loop where it does not.
 * `event.persisted` is simply never true on the two engines and the one
 * protocol where the cache is refused outright — the same handler costs
 * nothing there, and closes the gap that survives everywhere else: Chrome,
 * unconditionally, and Safari's own local-dev loop.
 *
 * **A persisted restore is not by itself evidence the grant is gone.**
 * Unlike the hidden-too-long case, which already knows what it wants (end
 * this browser's reading, unconditionally), a bfcache restore might be
 * perfectly innocent — the grant may still be live and idle-fresh, and nine
 * requests out of ten it will be. So `askServer` never posts the lock action
 * on its own say-so; it asks the loaders to run again, through the very
 * middleware every ordinary navigation already passes through, and lets a
 * genuinely dead grant redirect the way one always does. Re-locking a
 * perfectly good session on every Back gesture would be wrong in the other
 * direction — the annoyance that gets a real security feature turned off.
 *
 * **What none of this reaches.** A grant deleted by this file, by the
 * explicit control, or by the ordinary fifteen-minute idle window ends the
 * *next* request — it does not reach into a page already drawn. A second tab
 * of this same browser, open on a different screen, keeps its rendered
 * figures on screen until it next asks the server for anything; this file
 * has no way to reach across tabs and no reason to try. The guarantee stays
 * exactly what ADR-0012 already states it as: the lock ends the reading, not
 * every pixel already on screen.
 */
import { REENTRY_GRACE_MS } from "./lock.ts";

/**
 * Whether a browser hidden since `hiddenAt` has been gone long enough, by
 * the time it is `now`, that coming back should post the lock action rather
 * than merely resuming. `hiddenAt === null` means this browser has not been
 * hidden since the page loaded — nothing to measure, so this never posts.
 * Both instants are `performance.now()`'s, not `Date.now()`'s — this
 * function does no clock reading itself, so any two consistent numbers pin
 * the same boundary in a test, but {@link watchReentry} below reads a
 * monotonic clock precisely so a wall-clock jump while hidden (an NTP
 * correction, someone setting the time back) cannot silently disarm it.
 *
 * A pure function on purpose, taking both instants rather than reading the
 * clock itself: {@link watchReentry} is the only real caller, and a test can
 * pin the boundary — exceeds the grace, not merely reaches it — without a
 * browser or a timer.
 */
export function shouldPostLock(hiddenAt: number | null, now: number): boolean {
  return hiddenAt !== null && now - hiddenAt > REENTRY_GRACE_MS;
}

/**
 * Wires the two signals this file's header is about onto `document` and
 * `window`, and hands back the teardown a `useEffect` needs.
 *
 * `postLock` runs only once {@link shouldPostLock} says the grace has
 * actually passed since this browser was last hidden — never on every
 * return, which would post on the ordinary few seconds of switching apps
 * story 4 asks this feature not to be tiresome about. `askServer` runs on
 * every `pageshow` whose `event.persisted` is true, unconditionally: see
 * this file's header for why that call must never assume the answer is
 * "gone" the way `postLock`'s does.
 */
export function watchReentry(postLock: () => void, askServer: () => void): () => void {
  let hiddenAt: number | null = null;

  function onVisibilityChange(): void {
    if (document.visibilityState === "hidden") {
      // `performance.now()`, not `Date.now()`: this measures an elapsed
      // duration, and only a monotonic clock keeps that duration from going
      // negative — and the grace with it, silently — when the wall clock
      // moves backwards while the tab sits hidden.
      hiddenAt = performance.now();
      return;
    }

    if (shouldPostLock(hiddenAt, performance.now())) postLock();
    hiddenAt = null;
  }

  function onPageShow(event: PageTransitionEvent): void {
    if (event.persisted) askServer();
  }

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pageshow", onPageShow);

  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pageshow", onPageShow);
  };
}
