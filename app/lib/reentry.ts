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
 * app refuses a non-HTTPS `PUBLIC_ORIGIN` except for `localhost` itself
 * — `server/config.ts` turns away every IP address before it reaches
 * that carve-out, `127.0.0.1` included — so in production Safari refuses
 * the cache too; it is the plain-HTTP development loop, on that one
 * hostname, where it does not.
 * `event.persisted` is simply never true on the two engines and the one
 * protocol where the cache is refused outright — the same handler costs
 * nothing there, and closes the gap that survives everywhere else: Chrome,
 * unconditionally, and Safari's own local-dev loop.
 *
 * **No belief is consulted, and both halves install unconditionally,
 * always.** Three versions of this file asked `hasPasskey` — loader data
 * from the last render — what a hidden-too-long return should do, and each
 * one leaked through the same crack. First it decided *whether to install
 * the `visibilitychange` listener at all* (`watchReentry(hasPasskey ?
 * callback : null, askServer)`), which skipped the listener for the tab's
 * entire lifetime rather than for one return; the `pageshow` half only fires
 * on a bfcache restore, which an ordinary foreground-after-hidden never is,
 * so a page caught that way never got a second chance. Then it moved the
 * decision into a function the call site still chose whether to call, which
 * the call site could simply revert while every test stayed green. Then it
 * moved inside this function, which fixed the wiring but not the belief:
 * a tab that rendered before the household's first-ever enrolment still
 * carried `false` into a return that happened after it, downgraded its post
 * to a revalidation, and was admitted on the grant the enrolling tab minted
 * for this same browser — hidden well past the grace, still reading.
 *
 * So the belief is gone rather than fixed for a fourth time. There is no
 * parameter left to stale: a hidden-too-long return posts the lock, which is
 * what ticket 06 and spec 0019 both say without a condition, and what the
 * server was always the right place to answer anyway.
 *
 * **A persisted restore is not by itself evidence the grant is gone.**
 * Unlike the hidden-too-long case, which already knows what it wants (end
 * this browser's reading, unconditionally), a bfcache restore might be
 * perfectly innocent — the grant may still be live and idle-fresh, and nine
 * requests out of ten it will be. So `onPersistedRestore` never posts the
 * lock action on its own say-so; it asks the loaders to run again, through
 * the very middleware every ordinary navigation already passes through, and
 * lets a genuinely dead grant redirect the way one always does. Re-locking a
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
import { LOCK_NOW_ACTION, REENTRY_GRACE_MS } from "./lock.ts";

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
 * What actually posting the automatic lock does — the whole of
 * {@link watchReentry}'s own `postLock`, once a hidden-too-long return
 * decides this browser's grant should end. POST {@link LOCK_NOW_ACTION},
 * treat only a response that actually says the lock happened as success,
 * and only then run `revalidate` — never on the strength of the POST having
 * merely resolved.
 *
 * A review round proposed concealing the page while this settled, rather
 * than reading what the POST actually returns. That is not what settles it,
 * and nothing here conceals anything: spec 0019 ("What locking cannot
 * reach") is explicit that deleting the grant stops the next request and
 * does not reach into pages already rendered. Checking the response is the
 * whole fix.
 *
 * **`fetch` resolves for an HTTP failure exactly as it does for a genuine
 * success.** A 502 or 503 from a proxy in front of this instance is not a
 * rejected promise; treating "the promise resolved" alone as "the lock
 * happened" would continue exactly as if `/lock-now`'s own action had
 * actually run and deleted the grant. `response.ok` — 200-299, where the
 * redirect this action returns lands once `fetch`'s own default
 * redirect-following reaches `/unlock` — is the one answer here that
 * actually means the grant is gone; anything else must not go on to
 * revalidate as though it were, because a still-live grant would only be
 * extended by that call, never ended.
 *
 * **`keepalive: true`.** A plain `fetch` is aborted the instant its own
 * document unloads — exactly the moment this call matters most: the grace
 * has already elapsed, and a reader who returns only to immediately
 * navigate away leaves an un-kept-alive POST cut off mid-flight, its grant
 * never deleted. `keepalive` is the browser's own contract for a request
 * that must outlive the document, at a body-size cost this POST is nowhere
 * near paying — `lock-now.ts`'s own action reads no body at all.
 *
 * `doFetch` is a parameter, never the module-scope global, so a test can
 * hand this a fake response or a rejection without touching
 * `globalThis.fetch` — this file's own no-jsdom rule (AGENTS.md) applies to
 * this function exactly as it does to {@link watchReentry} below.
 */
export async function postLockNow(
  revalidate: () => void | Promise<unknown>,
  doFetch: (input: string, init: RequestInit) => Promise<Response>,
): Promise<void> {
  let response: Response;
  try {
    response = await doFetch(LOCK_NOW_ACTION, {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
    });
  } catch (error) {
    console.error(
      "Lock post could not reach this instance; the grant rides out its own idle window instead:",
      error,
    );
    return;
  }

  if (!response.ok) {
    console.error(
      `Lock post answered with ${response.status}; not treating that as the grant having been deleted.`,
    );
    return;
  }

  await revalidate();
}

/**
 * Wires this file's signals onto `document` and `window`, and hands back the
 * teardown a `useEffect` needs. Both listeners install unconditionally,
 * always — see this file's own header for why that is the fix rather than a
 * stylistic choice.
 *
 * **A hidden-too-long return posts the lock, and consults nothing first.**
 * Ticket 06 states the trigger without a condition — *"on return, if the gap
 * exceeds the grace, it **posts the lock action** — the same route the
 * control uses. Navigating to the unlock screen alone would leave the grant
 * row and its cookie live"* — and spec 0019 says the same in the same words.
 * This function briefly took a `hasPasskey` belief and downgraded the post to
 * a bare revalidation when it read false, to spare an unprotected household
 * a `/lock-now` round trip it had nothing to gain from. That belief is loader
 * data from the last render, and a tab that rendered before the household's
 * very first enrolment carries `false` into a return that happens after it:
 * the branch then revalidates, the middleware admits the grant the enrolling
 * tab minted for this same browser, and a browser hidden well past the grace
 * goes on reading. Which is the exact outcome both sentences above exist to
 * forbid. The saving was two requests that end where they started (the POST
 * is a documented no-op with no grant to delete — `app/routes/lock-now.ts` —
 * and `/unlock` bounces straight back to `/`, all inside `fetch`'s own
 * redirect following, so no reader ever sees it). Two invisible requests is
 * not a price worth a hole in the thing this slice is for.
 *
 * Nothing here posts on every ordinary return, which would be tiresome about
 * the few seconds of switching apps (story 4) — only once the grace has
 * actually passed.
 *
 * `onPersistedRestore` runs on every `pageshow` whose `event.persisted` is
 * true, and is deliberately *not* the same action: ticket 06 asks for "a
 * revalidation, not an unconditional lock post, because a persisted restore
 * is not by itself evidence the grant is gone". It stays its own parameter
 * because it answers its own trigger — a back/forward-cache restore, never a
 * hidden-too-long return.
 */
export function watchReentry(postLock: () => void, onPersistedRestore: () => void): () => void {
  // Seeded from the current visibility state, not `null` — a page mounted
  // into an already-hidden tab (opened in a background tab, or hydrated
  // while the document is already hidden) never sees a `visibilitychange`
  // *to* hidden; its first event is the transition back to visible, and
  // `shouldPostLock(null, …)` always answers false. Reading
  // `document.visibilityState` here means such a page measures its own
  // hidden gap from the moment this function ran, instead of never arming
  // the timer for its whole lifetime.
  let hiddenAt: HiddenAt | null = document.visibilityState === "hidden" ? readClocks() : null;

  function onVisibilityChange(): void {
    if (document.visibilityState === "hidden") {
      hiddenAt = readClocks();
      return;
    }

    const { wallMs, monoMs } = readClocks();
    if (shouldPostLock(hiddenAt, wallMs, monoMs)) postLock();
    hiddenAt = null;
  }

  function onPageShow(event: PageTransitionEvent): void {
    if (event.persisted) onPersistedRestore();
  }

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pageshow", onPageShow);

  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pageshow", onPageShow);
  };
}
