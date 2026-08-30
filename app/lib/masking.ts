/**
 * The masking vocabulary, once (spec 0007, ADR-0002). A screen is **masked**
 * when every amount is a fixed run of dots; the **masking policy** is the
 * household's standing choice for an untoggled browser (CONTEXT.md's words).
 *
 * Not a `.server` module (`account-options.ts`'s reason): the domain module
 * validates against these values and the Display form renders options from
 * them — a list written twice drifts from the check constraint. Four things
 * live here together because they are one rule seen from four sides: the
 * vocabulary, the policy/cookie precedence, the cookie both writers write,
 * and the hook every component reads — splitting them puts the cookie's name
 * in one file and its lifetime in another, the drift ADR-0002 fears most.
 */
import { useFetchers, useRouteLoaderData } from "react-router";

import type { Option } from "./account-options.ts";
import type { loader as rootLoader } from "../root.tsx";

/**
 * What an untoggled browser opens in. Values match
 * `app_setting_masking_policy_valid` in `0007` exactly; adding one is a
 * migration plus a line here, in that order.
 */
export type MaskingPolicy = "masked" | "unmasked" | "as_last_left";

/**
 * Three-way, never a boolean: the third value is the one a settled household
 * actually wants, and a boolean cannot say it. Each label completes the
 * Display tab's legend ("A browser opens") so the choice reads as a sentence
 * about future visits — getting that wrong is how a reader comes to believe
 * this control masks the page in front of them.
 */
export const MASKING_POLICIES: ReadonlyArray<Option<MaskingPolicy>> = [
  { value: "masked", label: "Masked — amounts hidden until shown, every time" },
  { value: "unmasked", label: "Showing amounts, every time" },
  { value: "as_last_left", label: "However it was last left on that browser" },
];

/** The stored values alone, in the shape Zod's `enum` wants. */
export const maskingPolicyValues = MASKING_POLICIES.map((policy) => policy.value) as [
  MaskingPolicy,
  ...MaskingPolicy[],
];

/**
 * Short and unprefixed: read and written by the toggle's own script, so it is
 * typed out in client code too, and it carries nothing a `__Host-` prefix
 * would protect.
 */
export const MASKING_COOKIE = "masked";

/**
 * The whole value vocabulary — anything else means the browser has not
 * answered. Two constants, not a boolean serialised per call site: two
 * writers, and a cookie written `true` by one and `1` by the other would
 * resolve to "not answered" exactly half the time.
 */
export const MASKED = "1";
export const UNMASKED = "0";

/** A year — long enough that *as last left* means what it says on a browser opened rarely. */
const REMEMBERED_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Is this screen masked? — the one place the precedence rule is written; the
 * root loader calls it once per request and everything downstream reads the
 * answer.
 *
 * **A recognised cookie always wins**, under every policy — what makes the
 * toggle work: a *start masked* household must still be able to unmask the
 * screen in front of them. **Anything else takes the policy's answer** —
 * absent, empty or hand-edited is not a vote, and reading a corrupted value
 * would let half the corruptions decide "show the balances". **And *as last
 * left* with nothing left is masked** — the case carrying the feature's
 * safety: a new device, a cleared jar, a private window.
 *
 * What keeps the fixed policies from being overridden forever is
 * {@link maskingCookie}'s lifetime, not this function: under either, the
 * cookie dies with the browser session and tomorrow falls through again.
 */
export function resolveMasked(policy: MaskingPolicy, cookie: string | undefined): boolean {
  if (cookie === MASKED) return true;
  if (cookie === UNMASKED) return false;

  switch (policy) {
    case "masked":
      return true;
    case "unmasked":
      return false;
    // Its own case, not a default, so adding a policy is a compile error at
    // the one place someone must decide what a silent browser gets.
    case "as_last_left":
      return true;
  }
}

/**
 * The `Set-Cookie` value for a just-toggled browser, serialised by hand in
 * one function because two writers must agree exactly: the server sets this
 * header and the toggle's script assigns the same string to
 * `document.cookie` — a server-only helper would leave the client copy free
 * to drift, which looks like a toggle that works until you reload.
 *
 * **The lifetime is the policy's, and that is the whole mechanism**:
 * persistent under *as last left*; session-scoped under either fixed policy,
 * so "on start" means "an untoggled browser session" with no timer anywhere.
 *
 * **Not `HttpOnly`** — a display preference, not a credential, and the
 * toggle's script must write it. **Not `Secure`** — the app serves plain HTTP
 * behind a terminating proxy, so `Secure` on an instance genuinely reached
 * over http would have the browser drop it, exactly like a toggle that stops
 * working on reload. Nothing here is a secret and nothing grants anything.
 */
export function maskingCookie(masked: boolean, policy: MaskingPolicy): string {
  const attributes = ["Path=/", "SameSite=Lax"];

  if (policy === "as_last_left") attributes.push(`Max-Age=${REMEMBERED_MAX_AGE}`);

  return [`${MASKING_COOKIE}=${masked ? MASKED : UNMASKED}`, ...attributes].join("; ");
}

/**
 * The `Set-Cookie` value that removes it, sent when the policy is saved —
 * otherwise the setting appears to do nothing on the browser that changed it,
 * and the old policy's lifetime outlives the policy itself (ADR-0002).
 */
export function clearedMaskingCookie(): string {
  return `${MASKING_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`;
}

/**
 * What this browser arrived with, or `undefined`. Parsed by hand: the value
 * is unsigned and two characters wide, and the framework's helper is async
 * and shaped for signed session payloads. Matched on the whole name, never a
 * substring — `unmasked=1` ends in `masked=1`, and a looser match would read
 * a different cookie's value as this one's, silently, in one direction.
 */
export function readMaskingCookie(request: Request): string | undefined {
  const header = request.headers.get("Cookie");
  if (header === null) return undefined;

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;

    if (pair.slice(0, separator).trim() === MASKING_COOKIE) {
      return pair.slice(separator + 1).trim();
    }
  }

  return undefined;
}

/**
 * The fetcher the toggle submits through, addressed by name — load-bearing:
 * `useFetcher()` with no key scopes to the calling component, so the toggle
 * in the chrome and an amount cell three screens down would watch two
 * different fetchers and the cell would never see a pending submission.
 * Naming it lets anything in the tree read the flip in flight.
 */
export const MASKING_FETCHER_KEY = "masking";

/** The field the toggle submits, carrying the state it is flipping *to*. */
export const MASKING_FIELD = "masked";

/** Where the form posts. One string, so the route and the control agree. */
export const MASKING_ACTION = "/masking";

/**
 * Is the screen this component is on masked? The pending submission's value
 * if there is one, else the loader's — the whole of the optimistic flip: the
 * click writes the cookie and submits, this hook reads the submission before
 * the server answers, and when the response lands the loader has caught up,
 * so nothing snaps back.
 *
 * **Guarded on `formData`, not `state`**: a mounted fetcher stays in
 * `useFetchers()` after going idle, and only `formData` is cleared when done
 * — the honest "is a submission in flight right now?". **Masked when there is
 * no loader data at all**: `Layout` wraps the error boundaries, where no
 * loader ran, and of the two ways to be wrong on a broken page, dots cannot
 * expose anything.
 */
export function useMasked(): boolean {
  const rootData = useRouteLoaderData<typeof rootLoader>("root");

  const pending = useFetchers().find(
    (fetcher) => fetcher.key === MASKING_FETCHER_KEY && fetcher.formData != null,
  )?.formData;

  if (pending !== undefined && pending !== null) {
    return pending.get(MASKING_FIELD) === MASKED;
  }

  return rootData?.masked ?? true;
}
