// Reentry guard (docs/adr/0012, spec 0019): what a tab does about being hidden and shown
// again, on top of the server-side idle window lock.server.ts's touchGrant already enforces.
// Courtesy, not enforcement — can't tell a pocketed phone from a handed-over screen; the real
// effect is postLockNow's POST, which actually deletes the grant server-side. Never reaches a
// second tab's already-rendered screen (ADR-0012): the lock ends the next request, not a pixel.
import { LOCK_NOW_ACTION, REENTRY_GRACE_MS } from "./lock.ts";

type HiddenAt = { wallMs: number; monoMs: number };

// `hiddenAt === null` means never hidden yet, so never posts. Reads two clocks and takes the
// larger elapsed value — do not simplify to one: performance.now() stalls through device
// suspend (can under-measure a long pocketed phone), while Date.now() can jump backwards on
// an NTP correction (would silently disarm the trigger); each covers the other's failure mode.
// Pure so a test can pin the boundary without a browser or timer.
export function shouldPostLock(hiddenAt: HiddenAt | null, nowWallMs: number, nowMonoMs: number): boolean {
  if (hiddenAt === null) return false;

  const wall = nowWallMs - hiddenAt.wallMs; // advances through suspend; can go negative
  const mono = nowMonoMs - hiddenAt.monoMs; // never negative; can stall through suspend
  return Math.max(wall, mono) > REENTRY_GRACE_MS;
}

function readClocks(): HiddenAt {
  return { wallMs: Date.now(), monoMs: performance.now() };
}

// POSTs LOCK_NOW_ACTION and only revalidates once the response is actually ok — fetch
// resolves the same for a 502 as for success, so "promise resolved" alone can't mean "locked".
// keepalive:true so the request survives a document unload right after posting (the reader
// navigates away the instant they return). doFetch is a parameter, not globalThis.fetch, so
// tests inject a fake response without jsdom (AGENTS.md).
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

// Wires this file's signals onto document/window; returns the useEffect teardown. Both
// listeners install unconditionally, with no belief (e.g. hasPasskey) consulted first — a
// prior version gated the post on loader-derived belief and let a tab that rendered before
// the household's first enrolment revalidate instead of lock, admitting a grant minted after.
// A hidden-too-long return always posts the lock (ticket 06, spec 0019), never merely
// revalidates. onPersistedRestore (bfcache pageshow) only revalidates — a persisted restore
// alone isn't evidence the grant is gone.
export function watchReentry(postLock: () => void, onPersistedRestore: () => void): () => void {
  // Seeded from current visibilityState, not null: a tab opened already hidden (background
  // tab) never sees a transition *to* hidden, so hiddenAt must start armed or never measures
  // its gap at all. Cost (spec 0020): such a tab reads as "hidden since open", so a first
  // look past the grace locks it — deliberate, fails toward locking rather than the reverse.
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
