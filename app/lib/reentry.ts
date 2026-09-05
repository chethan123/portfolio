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
 * The clock reads that bracket a hidden period pin a boundary, not a lower
 * bound on suspicion — see {@link shouldPostLock}'s own header for why two
 * clocks are read rather than one. What this file genuinely cannot do is
 * tell a phone locked in somebody's pocket from a screen genuinely handed
 * over — both hide the page identically, and there is no signal here to
 * tell them apart. That limit is not the hole it sounds like: what
 * {@link watchReentry}'s `postLock` callback does once called is a real POST
 * to the same route the chrome's own "Lock now" control posts to, deleting
 * the grant row server-side — that deletion is not a courtesy, it is the one
 * thing here that is not a suggestion. And if a browser never fires
 * `visibilitychange` at all because it was suspended before it could, the
 * grant simply rides out its own fifteen-minute idle window instead;
 * nothing about this file staying silent leaves a browser unlocked forever.
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
 * **`postLock` is nullable, and that is what lets `app/root.tsx` gate the
 * two halves on different conditions.** `hasPasskey` is baked into a page at
 * render time and can go stale — a household may enrol its first passkey in
 * another tab after this one already rendered with none. The `pageshow`
 * half only asks the loaders to run again, which is cheap and correct
 * regardless of whether this browser's render believed a passkey existed,
 * so it always wires up here. Posting a lock when nothing is enrolled would
 * instead send the reader on a pointless `/lock-now` → `/unlock` → `/` round
 * trip for a browser that was never locked in the first place, so that half
 * — the `visibilitychange` listener and the hidden-timer state behind it —
 * is installed only when the caller passes a real `postLock`; passing `null`
 * skips it outright rather than installing a listener with nothing to call.
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

/** The two clock readings taken together at the instant a tab goes hidden. */
type HiddenAt = { wallMs: number; monoMs: number };

/**
 * Whether a browser hidden since `hiddenAt` has been gone long enough, by
 * the time it is `nowWallMs`/`nowMonoMs`, that coming back should post the
 * lock action rather than merely resuming. `hiddenAt === null` means this
 * browser has not been hidden since this function was wired up — nothing to
 * measure, so this never posts.
 *
 * **Two clocks, not one, because each has a failure mode the other does not
 * share.** `performance.now()` is monotonic — it never runs backwards — but
 * on Linux, Android, macOS and iOS it does not advance while the device is
 * suspended, so a phone locked in a pocket for ten minutes can come back
 * measuring only the few seconds either side of the suspend: under the
 * grace, on exactly the device and the exact scenario this feature exists
 * for. `Date.now()` keeps advancing through a suspend, but it is a wall
 * clock — an NTP correction or someone setting the system time back can
 * move it backwards while the tab sits hidden, which would make its own
 * elapsed value negative and silently disarm the trigger. Reading both and
 * taking the larger elapsed value means neither failure mode is fatal on
 * its own: a suspended device is carried by the wall-clock gap, and a
 * clock set backwards simply loses to the monotonic gap, which cannot go
 * negative. **Do not simplify this back to one clock** — that trades one of
 * these two bugs for the other, it does not remove a redundancy.
 *
 * A pure function on purpose, taking every instant it needs rather than
 * reading either clock itself: {@link watchReentry} is the only real caller,
 * and a test can pin the boundary — exceeds the grace, not merely reaches
 * it — without a browser or a timer.
 */
export function shouldPostLock(hiddenAt: HiddenAt | null, nowWallMs: number, nowMonoMs: number): boolean {
  if (hiddenAt === null) return false;

  const wall = nowWallMs - hiddenAt.wallMs; // advances through suspend; can go negative
  const mono = nowMonoMs - hiddenAt.monoMs; // never negative; can stall through suspend
  return Math.max(wall, mono) > REENTRY_GRACE_MS;
}

/** Both clocks, read together, for whichever moment the caller needs pinned. */
function readClocks(): HiddenAt {
  return { wallMs: Date.now(), monoMs: performance.now() };
}

/**
 * Wires this file's signals onto `document` and `window`, and hands back the
 * teardown a `useEffect` needs.
 *
 * `postLock` runs only once {@link shouldPostLock} says the grace has
 * actually passed since this browser was last hidden — never on every
 * return, which would post on the ordinary few seconds of switching apps
 * story 4 asks this feature not to be tiresome about. Pass `null` to skip
 * that half entirely — no `visibilitychange` listener, no hidden-timer
 * state — when there is nothing this browser's lock could protect (this
 * file's own header explains why `app/root.tsx` needs that). `askServer`
 * runs on every `pageshow` whose `event.persisted` is true, unconditionally
 * and regardless of `postLock`: see this file's header for why that call
 * must never assume the answer is "gone" the way `postLock`'s does.
 */
export function watchReentry(postLock: (() => void) | null, askServer: () => void): () => void {
  // Seeded from the current visibility state, not `null` — a page mounted
  // into an already-hidden tab (opened in a background tab, or hydrated
  // while the document is already hidden) never sees a `visibilitychange`
  // *to* hidden; its first event is the transition back to visible, and
  // `shouldPostLock(null, …)` always answers false. Reading
  // `document.visibilityState` here means such a page measures its own
  // hidden gap from the moment this function ran, instead of never arming
  // the timer for its whole lifetime.
  let hiddenAt: HiddenAt | null = postLock !== null && document.visibilityState === "hidden" ? readClocks() : null;

  function onVisibilityChange(): void {
    if (postLock === null) return; // never registered when null; see below.

    if (document.visibilityState === "hidden") {
      hiddenAt = readClocks();
      return;
    }

    const { wallMs, monoMs } = readClocks();
    if (shouldPostLock(hiddenAt, wallMs, monoMs)) postLock();
    hiddenAt = null;
  }

  function onPageShow(event: PageTransitionEvent): void {
    if (event.persisted) askServer();
  }

  if (postLock !== null) document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pageshow", onPageShow);

  return () => {
    if (postLock !== null) document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pageshow", onPageShow);
  };
}
