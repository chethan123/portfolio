/**
 * The lock's shared, browser-safe pieces (docs/adr/0012, CONTEXT.md's
 * `Locked`): the two windows it is measured in, the one encoding rule
 * `passkey.transports` is written and read through, and — since ticket 03 —
 * the query parameter the unlock screen's return address travels under. A
 * plain `.ts`, not `lock.server.ts` — the same argument `masking.ts`'s
 * header makes for itself: ticket 06's client-side re-entry script has to
 * read {@link REENTRY_GRACE_MS} in the browser to decide when a hidden tab
 * posts the lock action, and a value import of a `.server` module from
 * browser-reachable code either ships server code into the client bundle or
 * breaks the build. The transport helpers live here for a narrower version
 * of the same reason: `tests/support/fixtures.ts` seeds the very column
 * `lock.server.ts` writes, and writing the encoding rule in both places is
 * the two-writers drift `app/lib/masking.ts` exists to prevent — so both
 * sides import it from here rather than the fixture reaching into
 * `lock.server.ts` (which would also drag in `@simplewebauthn/server` for
 * two one-line string functions).
 *
 * **The grant cookie itself is not here.** An earlier version of this file
 * kept `LOCK_COOKIE` and its `Set-Cookie` builders beside the return
 * parameter, on the claim that they shared masking's "two writers, one
 * cookie" argument for living beside its vocabulary. They do not: masking's
 * cookie is genuinely written by client script, which is that argument's
 * whole point, while this one is `HttpOnly` and can only ever be written by
 * the server — no browser-side writer ever needs its name or its attributes.
 * The cookie helpers live in `lock.server.ts` now, beside the grant they
 * name. `RETURN_PARAM` and the two window constants stay here because
 * ticket 04's screen and ticket 06's script genuinely read them in the
 * browser.
 *
 * **`LOCK_NOW_ACTION` and `UNLOCK_PATH` join them for the same reason
 * `masking.ts` names `MASKING_ACTION` once**: each is a route two or more
 * files independently have to agree on, and a string typed out twice is a
 * route rename either one could silently miss.
 */

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
 * Where the chrome's "Lock now" control and the reentry guard's own post
 * (`~/lib/reentry.ts`) both target. See this file's own header for why it
 * lives here rather than beside either poster.
 */
export const LOCK_NOW_ACTION = "/lock-now";

/**
 * The unlock screen's own path — named once rather than typed out at each of
 * its four call sites: `app/root.tsx`'s `LOCK_EXEMPT_PATHS`, `redirectToUnlock`
 * and `isUnlockPath`, and `app/routes/lock-now.ts`'s own redirect once the
 * grant is gone. The same argument this file's header makes for
 * `LOCK_NOW_ACTION` applied to the string actually left typed out four times.
 */
export const UNLOCK_PATH = "/unlock";
