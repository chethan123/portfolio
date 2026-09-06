/**
 * The one screen `LOCK_EXEMPT_PATHS` (app/root.tsx) lets through, since it is what lifts the
 * refusal. docs/adr/0012, spec 0019
 *
 * A challenge is spent the moment the server reads it, so a dismissed or failed attempt — the two
 * outcomes that never reached the server — must refresh options before retrying. That refresh
 * starts when the attempt settles, never on the next press: WebKit requires each
 * `navigator.credentials.get()` inside its own user activation, and awaiting a round trip inside
 * the click that granted it produces a `NotAllowedError` no prompt was ever shown for.
 *
 * `@simplewebauthn/browser` is reachable only through dynamic `import()` here and in
 * `~/lib/unlock-ceremony.ts`. `build/server/index.js` still contains the specifier as text — that
 * is the shape, not a leak; a grep expecting no textual trace is checking the wrong thing.
 */
import { startTransition, useEffect, useRef, useState } from "react";
import { redirect, useRevalidator, useSubmit } from "react-router";

import { LockIcon, SpinnerIcon } from "~/components/icons";
import { FORM_ERROR, ValidationError, formFields } from "~/lib/input.server";
import { RETURN_PARAM } from "~/lib/lock";
import { isLocked, lockCookie, readGrant, readLockCookie, unlockOptions, verifyUnlock } from "~/lib/lock.server";
import { requestAssertion, supportsPasskeys } from "~/lib/unlock-ceremony";

import { safeReturn } from "../lib/return-path.ts";

import type { Route } from "./+types/unlock";

export function meta() {
  return [{ title: "Unlock · Portfolio" }];
}

/**
 * Redirects an instance holding no passkey and a browser already holding a live grant — neither has
 * work here. Both reads fail toward *showing* the screen, the opposite of the middleware, which
 * fails toward refusing. `unlockOptions` mints a fresh challenge on every call, revalidations too.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const redirectTo = safeReturn(url.searchParams.get(RETURN_PARAM));

  let locked = true;
  try {
    locked = await isLocked();
  } catch (error) {
    console.error("Lock check failed; showing the unlock screen rather than guessing:", error);
  }

  if (!locked) return redirect(redirectTo);

  const grantId = readLockCookie(request);
  if (grantId !== undefined) {
    let grant: Awaited<ReturnType<typeof readGrant>>;
    try {
      grant = await readGrant(grantId);
    } catch (error) {
      grant = undefined;
      console.error("Grant check failed; showing the unlock screen rather than guessing:", error);
    }
    if (grant !== undefined) return redirect(redirectTo);
  }

  const options = await unlockOptions();
  return { options, redirectTo };
}

/**
 * `request.formData()` is inside the `try` too: this is the only route a locked browser can reach,
 * so an unreadable body must print a refusal rather than the framework's error page. An assertion
 * that fails to parse becomes `undefined`, which `verifyUnlock` already refuses in its own words.
 */
export async function action({ request }: Route.ActionArgs) {
  let fields: Record<string, string>;
  try {
    fields = formFields(await request.formData());
  } catch {
    return { formError: UNREADABLE_SUBMISSION_MESSAGE };
  }

  let response: unknown;
  try {
    response = fields.assertion === undefined ? undefined : JSON.parse(fields.assertion);
  } catch {
    response = undefined;
  }

  try {
    // Superseded rather than left live beside the new one: a stale `redirectTo` lands here with a
    // live cookie.
    const supersedes = readLockCookie(request);
    const grant = await verifyUnlock(response, undefined, supersedes);

    return redirect(safeReturn(fields.redirectTo), {
      headers: { "Set-Cookie": lockCookie(grant.id) },
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      return { formError: error.fieldErrors[FORM_ERROR] ?? null };
    }
    throw error;
  }
}

/**
 * `"confirming"` is the provider's own prompt, still cancellable; `"verifying"` is the window after
 * it answered, while the assertion is with this instance. Only the second has proved anything.
 */
type Phase = "idle" | "confirming" | "verifying" | "dismissed" | "failed";

/** The phases an attempt comes to rest in — the in-flight two leave nothing stale to ask about. */
type SettledPhase = Extract<Phase, "idle" | "dismissed" | "failed">;

const UNREADABLE_SUBMISSION_MESSAGE = "This submission could not be read. Reload the page and try again.";

/** Wording per CONTEXT.md: never "the operator", never "an enrolled device". */
const OTHER_RECOVERIES =
  "another browser on this device, a device that can reach a passkey the household has enrolled, " +
  "or ask whoever set this app up for your household to help you back in";

const NO_CEREMONY_MESSAGE = `This browser cannot run the passkey check. Try ${OTHER_RECOVERIES}.`;

/** `<noscript>` only: with scripting off the capability check never runs, so this is not a guess. */
const NOSCRIPT_MESSAGE = `This browser has scripting turned off, and unlocking needs it. Turn scripting on, or try ${OTHER_RECOVERIES}.`;

/** Open on `"verifying"` alone: a press that produced no assertion has proved nothing. */
function LockMark({ phase }: { phase: Phase }) {
  return (
    <span className={phase === "verifying" ? "lock-mark lock-mark--open" : "lock-mark"}>
      <LockIcon />
    </span>
  );
}

/** `role="status"`, not `alert`: nothing has gone wrong in either phase. */
function WaitingNote({ phase }: { phase: Phase }) {
  if (phase === "confirming") return <p className="field-note">Waiting for your passkey…</p>;
  if (phase === "verifying") return <p className="field-note">Checking that passkey with this instance…</p>;
  return null;
}

/** Neither a dismissal nor a timeout is a refusal — the screen stays as usable as before. */
function DismissedNote({ phase }: { phase: Phase }) {
  if (phase !== "dismissed") return null;
  return (
    <p className="field-note">
      That passkey check did not complete. Nothing has changed here — press Unlock to try again.
    </p>
  );
}

/**
 * Printed into the live region rather than swapped in where the button was: `supported` is `null`
 * until the mount check answers, so a reader can already have reached a button that then vanishes
 * announcing nothing.
 */
function UnsupportedNote({ supported }: { supported: boolean | null }) {
  if (supported !== false) return null;
  return <p className="empty-note">{NO_CEREMONY_MESSAGE}</p>;
}

/**
 * One rule, two enforcers: the button's `disabled` and the click handler. Also refused while the
 * revalidator refreshes stale options — accepting there runs the ceremony after the click's own
 * user activation went into the network ({@link shouldRevalidateBeforeRetry}).
 */
function pressIsRefused(phase: Phase, revalidatorState: "idle" | "loading" | "submitting"): boolean {
  return phase === "confirming" || phase === "verifying" || revalidatorState !== "idle";
}

function UnlockControl({
  supported,
  phase,
  revalidatorState,
  onUnlock,
}: {
  supported: boolean | null;
  phase: Phase;
  revalidatorState: "idle" | "loading" | "submitting";
  onUnlock: () => void;
}) {
  if (supported === false) return null;

  const busy = pressIsRefused(phase, revalidatorState);

  return (
    <button type="button" className="button button--block" onClick={onUnlock} disabled={busy}>
      {busy ? <SpinnerIcon className="lock-spinner" /> : null}
      Unlock
    </button>
  );
}

/** Only `"idle"` may show the server's refusal: every other phase means a fresh press happened after it. */
function visibleRefusal(
  phase: Phase,
  serverFormError: string | null,
  clientMessage: string | null,
): string | null {
  if (phase === "idle") return serverFormError;
  if (phase === "failed") return clientMessage;
  return null;
}

/**
 * Started the moment an attempt settles, never on the next press: each `navigator.credentials.get()`
 * must sit inside its own user activation, and a click that first awaits a round trip has spent it.
 */
function shouldRevalidateBeforeRetry(phase: SettledPhase): boolean {
  return phase !== "idle";
}

function shouldRunCeremony(
  phase: Phase,
  revalidatorState: "idle" | "loading" | "submitting",
  alreadyStarted: boolean,
): boolean {
  return phase === "confirming" && revalidatorState === "idle" && !alreadyStarted;
}

/**
 * Awaits `submit`, whose promise settles only once the action *and* its automatic revalidation have
 * finished — the one moment `actionData` and fresh options are both current. Setting state after an
 * unmount is inert under React 19. `revalidate` is never called on the `"ok"` branch: `submit`
 * already carried one.
 */
async function runCeremony(
  optionsJSON: Parameters<typeof requestAssertion>[0],
  redirectTo: string,
  submit: ReturnType<typeof useSubmit>,
  setPhase: (phase: Phase) => void,
  setClientMessage: (message: string | null) => void,
  revalidate: () => void,
  scheduleAsTransition: (update: () => void) => void,
): Promise<void> {
  const outcome = await requestAssertion(optionsJSON);

  if (outcome.status === "ok") {
    setPhase("verifying");
    await submit({ assertion: JSON.stringify(outcome.response), redirectTo }, { method: "post" });
    // A transition, so this commits with the navigation instead of ahead of it: React 19 renders
    // urgent lanes first, which would paint one frame of a shut padlock on the way out. Rests on
    // the router publishing in a transition — `HydratedRouter`'s default, absent an `entry.client.tsx`
    // passing `useTransitions={false}`.
    scheduleAsTransition(() => setPhase("idle"));
    return;
  }

  const settledPhase: SettledPhase = outcome.status === "dismissed" ? "dismissed" : "failed";

  // Same lane argument: left urgent, these commit a frame ahead of `revalidate()`'s own transition,
  // showing a live button beside a note telling the reader to press it. Scheduled before it, both
  // land in one commit.
  scheduleAsTransition(() => {
    if (outcome.status === "failed") setClientMessage(outcome.message);
    setPhase(settledPhase);
  });
  if (shouldRevalidateBeforeRetry(settledPhase)) revalidate();
}

export default function Unlock({ loaderData, actionData }: Route.ComponentProps) {
  const { options, redirectTo } = loaderData;
  const revalidator = useRevalidator();
  const submit = useSubmit();

  const [supported, setSupported] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [clientMessage, setClientMessage] = useState<string | null>(null);
  // Guards the effect against firing twice for one press.
  const ceremonyStarted = useRef(false);

  useEffect(() => {
    let alive = true;
    void supportsPasskeys().then((ok) => {
      if (alive) setSupported(ok);
    });
    return () => {
      alive = false;
    };
  }, []);

  // In an effect, not the click handler: this waits for *props* to carry refreshed options rather
  // than reading `loaderData` after an await, which is the stale-closure trap.
  useEffect(() => {
    if (!shouldRunCeremony(phase, revalidator.state, ceremonyStarted.current)) return;
    ceremonyStarted.current = true;

    void runCeremony(
      options,
      redirectTo,
      submit,
      setPhase,
      setClientMessage,
      revalidator.revalidate,
      startTransition,
    );
  }, [phase, revalidator.state, revalidator.revalidate, options, redirectTo, submit]);

  // Never revalidates: that already happened when the previous attempt settled, so this press keeps
  // its own user activation.
  function handleUnlock() {
    if (pressIsRefused(phase, revalidator.state)) return;
    ceremonyStarted.current = false;
    setClientMessage(null);
    setPhase("confirming");
  }

  const refusal = visibleRefusal(phase, actionData?.formError ?? null, clientMessage);

  return (
    <section className="panel lock-card">
      <LockMark phase={phase} />

      <div className="lock-heading">
        <h1 className="lock-title">Locked</h1>
        <p className="lock-lede">
          This browser is locked. Unlocking uses a passkey — this device's own provider, or
          another device this browser offers.
        </p>
      </div>

      <div className="lock-actions">
        <UnlockControl
          supported={supported}
          phase={phase}
          revalidatorState={revalidator.state}
          onUnlock={handleUnlock}
        />

        {/* Both live regions render empty and fill later: one first met already full is commonly
            not announced. Held open at two lines so a sentence never moves the button. */}
        <div className="lock-message">
          <div role="status">
            <UnsupportedNote supported={supported} />
            <WaitingNote phase={phase} />
            <DismissedNote phase={phase} />
          </div>

          <div role="alert">{refusal ? <p className="form-error">{refusal}</p> : null}</div>

          <noscript>
            <p className="empty-note">{NOSCRIPT_MESSAGE}</p>
          </noscript>
        </div>
      </div>
    </section>
  );
}

export {
  runCeremony,
  shouldRevalidateBeforeRetry,
  shouldRunCeremony,
  UnlockControl,
  DismissedNote,
  LockMark,
  UnsupportedNote,
  WaitingNote,
  pressIsRefused,
  visibleRefusal,
  NO_CEREMONY_MESSAGE,
  NOSCRIPT_MESSAGE,
  UNREADABLE_SUBMISSION_MESSAGE,
};
export type { Phase };
