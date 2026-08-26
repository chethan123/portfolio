/**
 * The masking vocabulary, once (spec 0007, ADR-0002).
 *
 * A screen is **masked** when every amount on it is replaced by a fixed run of
 * dots. The **masking policy** is the household's standing choice of what a
 * browser nobody has toggled yet opens in. `CONTEXT.md` defines both, and the
 * words here are that glossary's.
 *
 * Not a `.server` module, and for `account-options.ts`'s reason: the domain
 * module validates against these values and the Display form renders options
 * from them, and a list written twice is a list free to drift from the schema's
 * check constraint. Nothing here touches the database.
 *
 * Four things live here, and they live together because they are one rule seen
 * from four sides: the vocabulary a policy is written in, the precedence
 * between a policy and a cookie, the cookie both writers write, and the hook
 * every component reads. Splitting them would put the cookie's name in one file
 * and its lifetime in another, which is the drift ADR-0002 is most worried
 * about.
 */
import { useFetchers, useRouteLoaderData } from "react-router";

import type { Option } from "./account-options.ts";
import type { loader as rootLoader } from "../root.tsx";

/**
 * What a browser that has not been toggled yet opens in.
 *
 * The values match `app_setting_masking_policy_valid` in `0007` exactly.
 * Adding one is a migration plus a line here, in that order.
 */
export type MaskingPolicy = "masked" | "unmasked" | "as_last_left";

/**
 * Three-way, never a boolean, for the reason the migration gives: the third
 * value is the one a household with settled habits actually wants, and a
 * boolean has no way to say it.
 *
 * Each label completes the Display tab's legend — "A browser opens" — so that
 * the choice reads as a sentence about every future visit rather than as a
 * description of the screen someone is looking at now. Getting that wrong is
 * how a reader comes to believe this control masks the page in front of them.
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
 * The cookie's name.
 *
 * Short and unprefixed, unlike `__portfolio_session`: this one is read and
 * written by the toggle's own script, so it is typed out in client code as well
 * as here, and it carries nothing that a prefix would be protecting.
 */
export const MASKING_COOKIE = "masked";

/**
 * The whole value vocabulary — two words, and anything else means the browser
 * has not answered.
 *
 * Two constants rather than a boolean serialised at each call site, because
 * there are two writers (the toggle's script and the form's action) and a
 * cookie written `true` by one and `1` by the other would resolve to "not
 * answered" exactly half the time.
 */
export const MASKED = "1";
export const UNMASKED = "0";

/**
 * A year. Long enough that *as last left* means what it says on a browser
 * someone opens every few months.
 */
const REMEMBERED_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Is this screen masked? — policy plus what the browser arrived with.
 *
 * The one place the precedence rule is written. Everything else in the feature
 * asks this function rather than reasoning about a cookie: the root loader
 * calls it once per request, and every component downstream reads the answer.
 *
 * **A recognised cookie always wins**, under every policy. That is what makes
 * the toggle work at all — a household whose policy is *start masked* must
 * still be able to unmask the screen in front of them, and a policy that
 * overrode the cookie would make the control appear broken on the one browser
 * whose owner set the policy.
 *
 * **Anything else takes the policy's answer.** Absent, empty, truncated,
 * hand-edited: none of those is a vote, and reading a corrupted value as an
 * answer would let half the corruptions decide "show the balances".
 *
 * **And *as last left* with nothing left is masked**, which is the case that
 * carries the feature's safety. A new device, a cleared cookie jar and a
 * private window all arrive here.
 *
 * What keeps the two fixed policies from being overridden forever is not this
 * function but {@link maskingCookie}'s lifetime: under either of them the
 * cookie dies with the browser session, so tomorrow's first request arrives
 * with nothing and falls through to the policy again.
 */
export function resolveMasked(policy: MaskingPolicy, cookie: string | undefined): boolean {
  if (cookie === MASKED) return true;
  if (cookie === UNMASKED) return false;

  switch (policy) {
    case "masked":
      return true;
    case "unmasked":
      return false;
    // Nothing left to go on. Written as its own case rather than folded into
    // the default so that adding a policy is a compile error here, at the one
    // place someone has to decide what a browser with nothing to say gets.
    case "as_last_left":
      return true;
  }
}

/**
 * The `Set-Cookie` value for a browser that has just been toggled.
 *
 * Serialised by hand, in one function, because there are two writers and they
 * have to agree exactly: the server sets this header, and the toggle's script
 * assigns the same string to `document.cookie`. A helper that only the server
 * could call would leave the client's copy free to drift in its name, its
 * value or its lifetime, and the drift would look like a toggle that works
 * until you reload.
 *
 * **The lifetime is the policy's, and that is the whole mechanism.** Persistent
 * under *as last left*, so the browser remembers. Session-scoped under either
 * fixed policy, so "on start" means "a browser session that has not been
 * toggled yet" — with no timer anywhere and nothing to expire on the server.
 *
 * **Not `HttpOnly`**, which is correct rather than merely convenient: this is a
 * display preference, not a credential, and the script that owns the toggle has
 * to be able to write it. Not `Secure` either, for the reason `auth.server.ts`
 * gives at length — the app serves plain HTTP behind a terminating proxy, and
 * only the browser's own connection settles that question. Nothing here is a
 * secret and nothing here grants anything; the session cookie is a separate
 * thing and stays `HttpOnly`.
 */
export function maskingCookie(masked: boolean, policy: MaskingPolicy): string {
  const attributes = ["Path=/", "SameSite=Lax"];

  if (policy === "as_last_left") attributes.push(`Max-Age=${REMEMBERED_MAX_AGE}`);

  return [`${MASKING_COOKIE}=${masked ? MASKED : UNMASKED}`, ...attributes].join("; ");
}

/**
 * The `Set-Cookie` value that removes it.
 *
 * Sent when the policy is saved. Otherwise the setting appears to do nothing on
 * the browser that changed it — the old cookie would still win — and the stale
 * lifetime the old policy gave it would outlive the policy itself (ADR-0002).
 */
export function clearedMaskingCookie(): string {
  return `${MASKING_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`;
}

/**
 * What this browser arrived with, or `undefined` if it said nothing.
 *
 * Parsed here rather than through the framework's cookie helpers because the
 * value is unsigned and the vocabulary is two characters wide: the whole job is
 * splitting a header, and the framework's helper is async and shaped for signed
 * session payloads.
 *
 * The name is matched on the whole name, never as a substring. `unmasked=1`
 * ends in `masked=1`, and a looser match would read a different cookie's value
 * as this one's — silently, and in only one direction.
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
 * The fetcher the toggle submits through, addressed by name.
 *
 * A key rather than the default one, and this is load-bearing. `useFetcher()`
 * with no key scopes the fetcher to the component that called it — the key
 * defaults to that component's `useId()` — so the toggle in the chrome and an
 * amount cell three screens down would be looking at two different fetchers,
 * and the cell would see no pending submission ever. Naming the fetcher is what
 * lets anything in the tree read the flip that is in flight.
 */
export const MASKING_FETCHER_KEY = "masking";

/** The field the toggle submits, carrying the state it is flipping *to*. */
export const MASKING_FIELD = "masked";

/** Where the form posts. One string, so the route and the control agree. */
export const MASKING_ACTION = "/masking";

/**
 * Is the screen this component is on masked?
 *
 * The pending submission's value if there is one, and the loader's otherwise.
 * That is the whole of the optimistic flip: the click writes the cookie and
 * submits, this hook reads the submission before the server has answered, and
 * every amount on the page changes in the same frame. When the response lands,
 * the loader's value has caught up and the two agree — so nothing snaps back.
 *
 * **Guarded on `formData` rather than on `state`.** A mounted fetcher stays in
 * `useFetchers()` after it goes idle, so testing for membership or for
 * `state !== "idle"` would keep reporting a submission that finished. Only
 * `formData` is cleared when the fetcher is done, which makes it the honest
 * question: *is there a submission in flight right now?*
 *
 * **Masked when there is no loader data at all.** `Layout` wraps the error
 * boundaries too, where no loader has run. Of the two ways to be wrong on a
 * page that is already broken, dots are the one that cannot expose anything.
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
