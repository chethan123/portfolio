/** Lock constants shared with browser code — plain `.ts`, not `.server`. docs/adr/0012 */

export const IDLE_WINDOW_MS = 15 * 60 * 1000;

/** Hidden longer than this and re-entry posts the lock action instead of navigating. */
export const REENTRY_GRACE_MS = 60 * 1000;

/** Also the `maxLength` on Settings → Passkeys' label input. */
export const LABEL_MAX_LENGTH = 60;

/** Longer than the ceremony's own 60s timeout, so a slow password-manager prompt does not race it. */
export const CHALLENGE_TTL_MS = 2 * 60 * 1000;

export function splitTransports(value: string | null): string[] | undefined {
  return value === null ? undefined : value.split(",");
}

/** `[]` and undefined both store null: `[].join(",")` reads back as one bogus transport. */
export function joinTransports(transports: readonly string[] | undefined): string | null {
  return transports === undefined || transports.length === 0 ? null : transports.join(",");
}

/** Whole return address in one param value, so the URL carries no literal `&` — the gate's sign-in bounce truncates there. */
export const RETURN_PARAM = "redirectTo";

export const LOCK_NOW_ACTION = "/lock-now";

export const UNLOCK_PATH = "/unlock";
