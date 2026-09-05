/**
 * The lock's shared, browser-safe pieces (docs/adr/0012, CONTEXT.md's
 * `Locked`): the two windows it is measured in, plus the one encoding rule
 * `passkey.transports` is written and read through. A plain `.ts`, not
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
