/** Masking vocabulary, cookie and precedence rule, shared by server and browser. spec 0007, ADR-0002 */
import { useFetchers, useRouteLoaderData } from "react-router";

import type { Option } from "./account-options.ts";
import { readCookie } from "./cookies.ts";
import type { loader as rootLoader } from "../root.tsx";

/** Values must match `app_setting_masking_policy_valid` (migration 0007); migration first. */
export type MaskingPolicy = "masked" | "unmasked" | "as_last_left";

/** Labels complete the Display tab legend "A browser opens". */
export const MASKING_POLICIES: ReadonlyArray<Option<MaskingPolicy>> = [
  { value: "masked", label: "Masked — amounts hidden until shown, every time" },
  { value: "unmasked", label: "Showing amounts, every time" },
  { value: "as_last_left", label: "However it was last left on that browser" },
];

/** Shape Zod's `enum` wants. */
export const maskingPolicyValues = MASKING_POLICIES.map((policy) => policy.value) as [
  MaskingPolicy,
  ...MaskingPolicy[],
];

export const MASKING_COOKIE = "masked";

/** Any other value means the browser has not answered. */
export const MASKED = "1";
export const UNMASKED = "0";

const REMEMBERED_MAX_AGE = 60 * 60 * 24 * 365;

/** Fixed policies are not overridden forever: their cookie is session-scoped ({@link maskingCookie}). */
export function resolveMasked(policy: MaskingPolicy, cookie: string | undefined): boolean {
  if (cookie === MASKED) return true;
  if (cookie === UNMASKED) return false;

  switch (policy) {
    case "masked":
      return true;
    case "unmasked":
      return false;
    // Own case, not `default`: a new policy becomes a compile error here.
    case "as_last_left":
      return true;
  }
}

/**
 * Also assigned verbatim to `document.cookie` by the toggle's script — same string both sides.
 * Lifetime is the mechanism: session-scoped under a fixed policy, persistent under *as last left*.
 * No `HttpOnly` (the script writes it), no `Secure` (app serves plain HTTP behind the proxy).
 */
export function maskingCookie(masked: boolean, policy: MaskingPolicy): string {
  const attributes = ["Path=/", "SameSite=Lax"];

  if (policy === "as_last_left") attributes.push(`Max-Age=${REMEMBERED_MAX_AGE}`);

  return [`${MASKING_COOKIE}=${masked ? MASKED : UNMASKED}`, ...attributes].join("; ");
}

/** Sent when the policy is saved, else the old policy's lifetime outlives it. ADR-0002 */
export function clearedMaskingCookie(): string {
  return `${MASKING_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`;
}

export function readMaskingCookie(request: Request): string | undefined {
  return readCookie(request, MASKING_COOKIE);
}

/** Keyed: an unkeyed `useFetcher()` scopes to its caller, so amount cells could not see the flip in flight. */
export const MASKING_FETCHER_KEY = "masking";

/** Carries the state being flipped *to*. */
export const MASKING_FIELD = "masked";

export const MASKING_ACTION = "/masking";

/**
 * Pending submission wins over loader data — the optimistic flip.
 * Guarded on `formData`, not `state`: an idle fetcher stays in `useFetchers()`, only `formData` clears.
 * Masked when there is no loader data (error boundaries) — the safe way to be wrong.
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
