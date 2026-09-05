/**
 * The lock's shared, browser-safe pieces (docs/adr/0012, CONTEXT.md's
 * `Locked`): the two windows it is measured in, the one encoding rule
 * `passkey.transports` is written and read through, and — since ticket 03 —
 * the grant cookie's name and attributes, and the query parameter the
 * unlock screen's return address travels under. A plain `.ts`, not
 * `lock.server.ts` — the same argument `masking.ts`'s header makes for
 * itself: ticket 06's client-side re-entry script has to read
 * {@link REENTRY_GRACE_MS} in the browser to decide when a hidden tab posts
 * the lock action, and a value import of a `.server` module from
 * browser-reachable code either ships server code into the client bundle or
 * breaks the build. The transport helpers live here for a narrower version
 * of the same reason: `tests/support/fixtures.ts` seeds the very column
 * `lock.server.ts` writes, and writing the encoding rule in both places is
 * the two-writers drift `app/lib/masking.ts` exists to prevent — so both
 * sides import it from here rather than the fixture reaching into
 * `lock.server.ts` (which would also drag in `@simplewebauthn/server` for
 * two one-line string functions).
 *
 * **The cookie and the return parameter are here for the same "two writers,
 * one truth" reason**, not because reading a request's `Cookie` header needs
 * anything browser-side: ticket 03's root middleware reads and clears the
 * cookie, and ticket 04's unlock route sets it and reads the return
 * parameter back — two modules that must agree on a name neither owns
 * alone, exactly `masking.ts`'s own cookie constant's argument for itself.
 */
import { readCookie } from "./cookies.ts";

/** How long an unlock grant lives while idle, in milliseconds. Fifteen minutes. */
export const IDLE_WINDOW_MS = 15 * 60 * 1000;

/**
 * How long a browser may sit hidden before coming back posts the lock
 * action rather than merely navigating, in milliseconds. Sixty seconds.
 */
export const REENTRY_GRACE_MS = 60 * 1000;

/**
 * `passkey.transports`, split back into a list — `null` reads as none
 * (migration 0012's comment on the column).
 */
export function splitTransports(value: string | null): string[] | undefined {
  return value === null ? undefined : value.split(",");
}

/**
 * `passkey.transports`'s writer side: `[]` and omitted both mean "none
 * reported". The empty-array case is the exact bug the migration's comment
 * says the writer has to refuse — `[].join(",")` would otherwise store
 * `''`, and `''.split(',')` reads back as one bogus transport rather than
 * none.
 */
export function joinTransports(transports: readonly string[] | undefined): string | null {
  return transports === undefined || transports.length === 0 ? null : transports.join(",");
}

// ---------------------------------------------------------------------------
// The grant cookie (ticket 03)
// ---------------------------------------------------------------------------

/**
 * The grant's cookie — named for the table the id it carries addresses.
 * `__Host-` prefixed because this one carries a credential, where masking's
 * cookie deliberately carries neither prefix nor `Secure` (its own header):
 * a passkey will not run outside a secure context anyway, so the attributes
 * cost this feature nothing.
 *
 * **Whether a `Secure` cookie actually survives the dev loop's plain-http
 * localhost is unverified.** Some browsers carve out `localhost` as a
 * secure-enough origin for `Secure` cookies and some do not, and this has not
 * actually been tried in a running browser — say so plainly rather than
 * claim it works on the strength of an argument alone.
 */
export const LOCK_COOKIE = "__Host-unlock_grant";

/**
 * The unlock screen's own return address, as one query parameter rather
 * than the query it came from. The gate's own sign-in bounce (Caddy)
 * interpolates the request URI it redirects back to without
 * percent-encoding it, truncating at the first literal `&` — already
 * tracked as an issue — and an owner filter beside a chart range is exactly
 * such a target. Encoding the whole return address into one parameter's
 * *value* (`URLSearchParams` does this for whoever builds the redirect)
 * means the URL carries zero literal `&` characters of its own, so there is
 * nothing left for that bug to truncate. Ticket 03's middleware builds the
 * redirect; ticket 04's unlock route reads it back through `safeReturn`
 * (`return-path.ts`) — sharing this name is what keeps the two agreeing on
 * which query key that is.
 */
export const RETURN_PARAM = "redirectTo";

/**
 * The `Set-Cookie` value for a browser whose assertion the domain module
 * just verified. `Secure`, `HttpOnly`, `Path=/` and the `__Host-` prefix all
 * follow from carrying a credential rather than a preference (this file's
 * comment on {@link LOCK_COOKIE}). No `Max-Age`: the *grant row* is the
 * authority on how long this lasts, extended by the request that uses it
 * (`lock.server.ts`'s `extendGrant`) — a fixed cookie lifetime set once at
 * unlock would expire the cookie under a family member still actively
 * reading, even though the row itself had just been pushed further out,
 * which would read as a lock that relocks mid-use for no reason anyone could
 * see.
 *
 * **`SameSite=Lax`, never `Strict`.** The gate's own redirect through Google
 * returns as a top-level, cross-site navigation; `Strict` would withhold
 * this cookie on that very request and re-lock every browser the instant
 * the gate's cookie merely refreshed, which would read as a random bug
 * rather than anything this feature did.
 */
export function lockCookie(grantId: string): string {
  return `${LOCK_COOKIE}=${grantId}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

/**
 * The `Set-Cookie` value that removes it — sent whenever the grant it names
 * turns out to be gone, so a stale id does not survive to confuse the next
 * unlock. Carries the same attributes {@link lockCookie} does: a `__Host-`
 * prefixed cookie is dropped by the browser unless *every* `Set-Cookie` that
 * names it — clearing included — carries `Secure` and `Path=/`.
 */
export function clearedLockCookie(): string {
  return `${LOCK_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * What this browser's grant cookie names, or `undefined` — nothing else:
 * the row is the authority, and the cookie carries no claim, no timestamp
 * and no signature for that reason (docs/adr/0012).
 */
export function readLockCookie(request: Request): string | undefined {
  return readCookie(request, LOCK_COOKIE);
}
