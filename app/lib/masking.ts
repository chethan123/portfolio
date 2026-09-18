/** Masking vocabulary, cookie and precedence rule, shared by server and browser. spec 0007, ADR-0002 */
import { useSyncExternalStore } from "react";
import { useRouteLoaderData } from "react-router";

import type { Option } from "./account-options.ts";
import { readCookie, readCookieHeader } from "./cookies.ts";
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

/** The rail and phone controls share one submission and one lifetime-reconciliation signal. */
export const MASKING_FETCHER_KEY = "masking";

/** Carries the state being flipped *to*. */
export const MASKING_FIELD = "masked";

/** Added during a scripted submit; absent from the same forms when JavaScript is unavailable. */
export const MASKING_ENHANCED_FIELD = "enhanced";

export const MASKING_ACTION = "/masking";

const MASKING_CHANNEL = "portfolio:masking-change";
const MASKING_INTENT_STORAGE = "portfolio:masking-intent";

type MaskingSubscriber = () => void;
const UNREAD_MASKING_SNAPSHOT = Symbol("unread masking snapshot");

// One channel per browser tab, however many Amount components subscribe. The message is only an
// invalidation: the receiver reads the shared cookie instead of trusting state from another tab.
const maskingSubscribers = new Set<MaskingSubscriber>();
let maskingChannel: BroadcastChannel | null | undefined;
let maskingIntentReliable = true;
let browserMaskingSnapshotValue: string | undefined | typeof UNREAD_MASKING_SNAPSHOT =
  UNREAD_MASKING_SNAPSHOT;

function notifyMaskingSubscribers(): void {
  for (const subscriber of maskingSubscribers) subscriber();
}

function readBrowserMaskingCookie(): string | undefined {
  return readCookieHeader(document.cookie, MASKING_COOKIE);
}

function acceptExternalMaskingChange(): void {
  // Hide propagates immediately. Show cannot populate a tab whose loader deliberately omitted
  // exact amounts, so that tab stays at its dot gate until its own intentional Show revalidation.
  const current = readBrowserMaskingCookie();
  if (current !== MASKED) return;
  browserMaskingSnapshotValue = current;
  notifyMaskingSubscribers();
}

function notifyVisibleMaskingSubscribers(): void {
  if (document.visibilityState === "visible") acceptExternalMaskingChange();
}

export function newMaskingIntent(): string {
  try {
    const words = crypto.getRandomValues(new Uint32Array(4));
    return Array.from(words, (word) => word.toString(16).padStart(8, "0")).join("");
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function readBrowserMaskingIntent(): string | undefined {
  if (!maskingIntentReliable) return undefined;
  try {
    return localStorage.getItem(MASKING_INTENT_STORAGE) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Captures the ordering point before an enhanced Settings write; unavailable storage fails safe. */
export function captureBrowserMaskingIntent(): string | undefined {
  if (typeof window === "undefined") return undefined;

  const existing = readBrowserMaskingIntent();
  if (existing !== undefined) return existing;

  try {
    const initial = newMaskingIntent();
    localStorage.setItem(MASKING_INTENT_STORAGE, initial);
    maskingIntentReliable = true;
    return initial;
  } catch {
    maskingIntentReliable = false;
    return undefined;
  }
}

/** True only when no masking choice has followed the captured ordering point, including an ABA. */
export function browserMaskingIntentIsCurrent(intent: string | undefined): boolean {
  return intent !== undefined && readBrowserMaskingIntent() === intent;
}

function advanceBrowserMaskingIntent(): string | undefined {
  const intent = newMaskingIntent();
  try {
    localStorage.setItem(MASKING_INTENT_STORAGE, intent);
    maskingIntentReliable = true;
    return intent;
  } catch {
    maskingIntentReliable = false;
    // Remove an old token where storage permits it. Otherwise the local reliability flag still
    // prevents a Settings response from mistaking that stale token for a current one.
    try {
      localStorage.removeItem(MASKING_INTENT_STORAGE);
    } catch {
      // Storage is wholly unavailable; Settings preserves the existing cookie.
    }
    return undefined;
  }
}

function startBrowserMaskingWatchers(): void {
  window.addEventListener("focus", acceptExternalMaskingChange);
  document.addEventListener("visibilitychange", notifyVisibleMaskingSubscribers);

  if (typeof BroadcastChannel === "undefined") {
    maskingChannel = null;
    return;
  }

  try {
    maskingChannel = new BroadcastChannel(MASKING_CHANNEL);
    maskingChannel.addEventListener("message", acceptExternalMaskingChange);
  } catch {
    // Focus and visibility still adopt an external Hide if channel construction is unavailable.
    maskingChannel = null;
  }
}

function stopBrowserMaskingWatchers(): void {
  window.removeEventListener("focus", acceptExternalMaskingChange);
  document.removeEventListener("visibilitychange", notifyVisibleMaskingSubscribers);
  maskingChannel?.removeEventListener("message", acceptExternalMaskingChange);
  maskingChannel?.close();
  maskingChannel = undefined;
}

function browserMaskingSnapshot(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const current = readBrowserMaskingCookie();
  if (browserMaskingSnapshotValue === UNREAD_MASKING_SNAPSHOT || current === MASKED) {
    // A tab can temporarily have no subscribers (the bare unlock shell). Adopt Hide during the
    // next render instead of letting a cached Show survive until subscription effects restart.
    browserMaskingSnapshotValue = current;
  }
  return browserMaskingSnapshotValue;
}

function serverMaskingSnapshot(): undefined {
  return undefined;
}

function subscribeToBrowserMasking(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;

  maskingSubscribers.add(onChange);
  if (maskingSubscribers.size === 1) startBrowserMaskingWatchers();

  return () => {
    maskingSubscribers.delete(onChange);
    if (maskingSubscribers.size === 0) stopBrowserMaskingWatchers();
  };
}

/** The browser's subscribable masking state; lifecycle stays inside this module. */
export const browserMaskingStore = {
  subscribe: subscribeToBrowserMasking,
  getSnapshot: browserMaskingSnapshot,
  getServerSnapshot: serverMaskingSnapshot,
} as const;

/** Cookie writes have no browser event; tell this tab and the browser's other tabs to reread it. */
function publishBrowserMaskingChange(): void {
  if (typeof window === "undefined") return;
  browserMaskingSnapshotValue = readBrowserMaskingCookie();
  notifyMaskingSubscribers();
  maskingChannel?.postMessage("changed");
}

/**
 * A settled toggle may repair its cookie's lifetime only against root data newer than the snapshot
 * it submitted against. An idle fetcher is not that evidence: an errored action settles without
 * reloading any loader, which would apply this tab's possibly stale policy to a year-long cookie.
 */
export function maskingRepairIsWarranted<T>(
  submitted: T | undefined,
  current: T | undefined,
): current is T {
  return current !== undefined && current !== submitted;
}

export type BrowserMaskingWrite = {
  value: typeof MASKED | typeof UNMASKED;
  intent: string | undefined;
};

/**
 * Assign while `intent` still owns the choice, then publish the resulting cookie. Cookie writes
 * are not atomic across tabs: a detected overlap writes a session Hide, and whichever tab assigns
 * last leaves either that newer choice or the corrective Hide, never this stale assignment.
 */
function assignBrowserMaskingCookie(cookie: string, intent: string | undefined): boolean {
  document.cookie = cookie;
  const stillCurrent = intent === undefined || browserMaskingIntentIsCurrent(intent);
  if (!stillCurrent) document.cookie = maskingCookie(true, "masked");
  publishBrowserMaskingChange();
  return stillCurrent;
}

/** Writes one enhanced toggle and records the ordering point its revalidation may reconcile. */
export function writeBrowserMaskingChoice(
  masked: boolean,
): BrowserMaskingWrite {
  const value = masked ? MASKED : UNMASKED;
  const intent = advanceBrowserMaskingIntent();
  // The policy in this tab may be stale. Extend to *as last left* only after revalidation.
  assignBrowserMaskingCookie(maskingCookie(masked, "masked"), intent);
  return { value, intent };
}

/** Applies the revalidated policy only while this toggle still owns the same browser choice. */
export function reconcileBrowserMaskingChoice(
  written: BrowserMaskingWrite,
  fresh: MaskingLoaderState & { maskingPolicy: MaskingPolicy },
): void {
  if (written.intent === undefined) return;
  if (readBrowserMaskingCookie() !== written.value) return;
  if (!browserMaskingIntentIsCurrent(written.intent)) return;

  assignBrowserMaskingCookie(
    fresh.maskingResolved
      ? maskingCookie(written.value === MASKED, fresh.maskingPolicy)
      : maskingCookie(true, "masked"),
    written.intent,
  );
}

/** Keeps a saved policy safe across root revalidation, then removes its temporary override. */
export async function adoptSavedMaskingPolicy(
  policy: MaskingPolicy,
  intent: string | undefined,
  revalidate: () => Promise<void>,
): Promise<void> {
  if (!browserMaskingIntentIsCurrent(intent)) return;

  // Always session-only: this cookie exists only to cover one root revalidation.
  if (
    !assignBrowserMaskingCookie(
      maskingCookie(resolveMasked(policy, undefined), "masked"),
      intent,
    )
  ) {
    return;
  }

  try {
    await revalidate();
  } catch {
    // Keep the session bridge. Clearing it could expose an older unmasked root answer.
    return;
  }

  if (!browserMaskingIntentIsCurrent(intent)) {
    // A newer choice landed after the bridge; it owns the cookie now.
    return;
  }

  assignBrowserMaskingCookie(clearedMaskingCookie(), intent);
}

type MaskingLoaderState = {
  masked: boolean;
  maskingResolved: boolean;
};

/** Browser precedence after hydration; a failed/missing server answer always remains masked. */
export function resolveBrowserMasked(
  rootData: MaskingLoaderState | undefined,
  browser: string | undefined,
): boolean {
  if (rootData === undefined || !rootData.maskingResolved) return true;
  if (browser === MASKED) return true;
  if (browser === UNMASKED) return false;
  return rootData.masked;
}

/**
 * Server/root data supplies SSR and hydration. After hydration the browser cookie wins over loader
 * responses that successfully resolved policy, including an older revalidation finishing last
 * after a newer direct cookie write. Missing or failed policy data stays masked.
 */
export function useMasked(): boolean {
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  const browser = useSyncExternalStore(
    browserMaskingStore.subscribe,
    browserMaskingStore.getSnapshot,
    browserMaskingStore.getServerSnapshot,
  );

  return resolveBrowserMasked(rootData, browser);
}
