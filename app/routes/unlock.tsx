/**
 * The screen a browser holding no valid grant is shown (docs/adr/0012, spec
 * 0019, ticket 04) — the one screen `LOCK_EXEMPT_PATHS` (app/root.tsx) lets
 * through unconditionally, because it is what lifts the refusal every other
 * route is behind. `app/root.tsx`'s `Layout` renders this screen without the
 * app chrome for the same reason — see its own header for where that branch
 * lives and why.
 *
 * **The loader asks the domain module before assuming its own premise.** A
 * browser can reach this address in two states that have no work left to do
 * here: an instance holding no passkey at all (nothing to unlock), and a
 * browser that already holds a live grant (an unlock already happened, from
 * another tab or an earlier visit). Both are sent back to `redirectTo`
 * rather than shown a screen whose one control either cannot succeed or
 * would only mint a second, redundant grant (finding 4) — the same question
 * `app/root.tsx`'s middleware already asks of every other route, asked here
 * too rather than assumed away because this route is exempt from asking it
 * first.
 *
 * **One button, one action.** Once neither of those escapes applies, the
 * loader mints a fresh single-use challenge (`unlockOptions`) on every GET
 * this route answers — including a background revalidation, not only the
 * first document request — and hands it to the client, which turns it into
 * an assertion through `~/lib/unlock-ceremony.ts`'s client-only seam and
 * posts the result back here. The action verifies it in full through
 * `verifyUnlock` and only then sets the grant cookie: this route states no
 * rule of its own about what a valid assertion is, matching every other
 * route's "translate a form, render what comes back."
 *
 * **The client-only seam, and what proves it.** This file and
 * `unlock-ceremony.ts` both avoid a module-scope import of
 * `@simplewebauthn/browser` — every reference to it is a dynamic `import()`
 * inside a function only a `useEffect` or a click handler ever calls, never
 * during a server render. That is a claim about what *ships*, and the only
 * way to check it is to read the built output: after `npm run build`,
 * `build/client/assets/**` carries the package in its own separate,
 * lazily-loaded chunk. `build/server/index.js` carries no *evaluated*
 * reference to it and none of the package's own implementation — grepping
 * that file for the package's name or for
 * `startAuthentication`/`browserSupportsWebAuthn` finds both, because
 * `import()`'s own string argument and the two identifiers this file passes
 * to it are still text sitting in the bundle as the two unevaluated
 * specifiers of a dynamic import the server entry never calls; that is
 * exactly the shape this file's whole argument rests on; a grep expecting
 * *no textual trace* is checking the wrong thing and will cry wolf. Say so
 * again if this file is ever changed to import it any other way.
 *
 * **Options are re-fetched exactly when the last attempt never reached the
 * server, never when it might have spent one — and the re-fetch starts the
 * moment that becomes true, not on the next press.** `lock.server.ts`'s own
 * header explains why a stale challenge cannot simply be resubmitted: it is
 * spent the moment the server reads it, whether or not what followed
 * verified, so a second try against the same one answers "already used" —
 * true, and misleading about what actually just happened. The component's
 * own `phase` state carries this distinction (see its declaration below):
 * "idle" means either nothing has been tried yet or the last attempt reached
 * the server one way or the other, and React Router's own automatic
 * post-action revalidation already freshened `loaderData.options` either
 * way; a dismissed prompt or a ceremony that never produced an assertion
 * leaves `phase` at "dismissed"/"failed" instead — the two cases that never
 * spent anything and left the options page loaded with genuinely stale ones.
 * `runCeremony` calls `useRevalidator`'s `revalidate` itself, right there,
 * the instant it sets `phase` to one of those two ({@link
 * shouldRevalidateBeforeRetry}) — never the click handler that starts the
 * *next* attempt. A version that instead waited for that next press to call
 * `revalidate` and only then ran the ceremony would call
 * `navigator.credentials.get()` after the click that started the wait, once
 * the network round trip finished — outside the very user activation that
 * click granted, on any loader, database or network slower than WebKit's
 * transient-activation window. The prompt then never even opens; the
 * `NotAllowedError` that produces is indistinguishable from a dismissal
 * (this file's next paragraph) and reads as one, so the reader is told they
 * cancelled a check they were never shown.
 *
 * **A dismissed prompt and a ceremony that timed out are not distinguished**,
 * on purpose — `unlock-ceremony.ts`'s header found that both surface as the
 * identical `NotAllowedError`, and a screen that guessed which one happened
 * would sometimes guess wrong. Both leave the screen exactly as usable as
 * before, because neither is a refusal.
 *
 * **The real-device checks this ticket owes are recorded in the ticket
 * itself** (`docs/specs/lock/04-the-unlock-screen.md`), not here — that file
 * already carries the checklist item they answer, so checking it off there
 * with a note is one fact in one place rather than two copies free to drift.
 */
import { useEffect, useRef, useState } from "react";
import { redirect, useRevalidator, useSubmit } from "react-router";

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
 * `redirectTo` resolved once, here, through `safeReturn` — the same single
 * site `/masking` and `/refresh` already read back through — never restated.
 *
 * Asks the domain module two questions before minting anything: whether the
 * instance is locked at all, and — if it is — whether this very request
 * already carries a live grant. Either answer sends the browser on to
 * `redirectTo` instead of rendering the screen (finding 4): an instance
 * holding no passkey has nothing here to unlock, and a browser that already
 * holds a grant gains nothing from a second one but a second cookie. Both
 * reads fail toward *showing* the screen rather than away from it — a
 * database hiccup here is not licence to either strand an open instance
 * behind a screen it cannot use or wave an unproven browser through, so a
 * failed read is logged and treated as "keep showing this", the opposite of
 * `app/root.tsx`'s middleware, which fails toward refusing everything else.
 * `unlockOptions` mints a fresh challenge on every remaining call; this
 * loader is called for the first document request *and* for every later
 * `useRevalidator`-driven refresh the component asks for, and both need a
 * live one.
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
 * Verify through the domain module and act on nothing else. Reading the body
 * is wrapped the same as everything after it (finding 1): `request.formData()`
 * throws for a body this route was never going to be able to read anyway — a
 * `Content-Type` it does not recognise, a body cut off mid-stream, malformed
 * multipart — and this is the only reachable route left standing once a
 * browser holds no grant, so a thrown `TypeError` here must become the same
 * printable refusal every other malformed submission gets, not the
 * framework's own error page behind a link the middleware refuses.
 * `fields.assertion` arrives as a JSON string — the wire shape a `<button>`
 * with no `<form>` around it can carry as a plain POST field — and a value
 * that fails to parse becomes `undefined` rather than a route-invented
 * refusal: `verifyUnlock` already refuses `undefined` with its own message,
 * so parsing failure and a missing field read as the identical, correct
 * sentence.
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
    const grant = await verifyUnlock(response);

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

/** What one press of Unlock is doing right now. */
type Phase = "idle" | "confirming" | "dismissed" | "failed";

/** A submission this route could not even read — never a passkey problem, so it says so plainly. */
const UNREADABLE_SUBMISSION_MESSAGE = "This submission could not be read. Reload the page and try again.";

/**
 * The recoveries that actually exist for a browser that cannot run — or is
 * not letting scripting run — the passkey check: another browser on this
 * device, a device that can reach a passkey the household has enrolled, or
 * the one recovery that is not either of those. Named in words a family
 * member can act on rather than "the operator" — `CONTEXT.md` defines that
 * word for nobody a family member is, and ticket 04 asks for a message that
 * is not a dead end either way (finding 8). Never "an enrolled device"
 * (CONTEXT.md's `Passkey` entry) — a passkey is not one; "a passkey the
 * household has enrolled" keeps the same fact in the order that avoids it.
 */
const OTHER_RECOVERIES =
  "another browser on this device, a device that can reach a passkey the household has enrolled, " +
  "or ask whoever set this app up for your household to help you back in";

/** Shown once this browser is confirmed unable to run the ceremony at all — an in-app WebView, say. */
const NO_CEREMONY_MESSAGE = `This browser cannot run the passkey check. Try ${OTHER_RECOVERIES}.`;

/**
 * Shown only inside `<noscript>` (finding 8): the reason this reader sees no
 * working control is that scripting is off, not that their browser lacks a
 * capability — `browserSupportsWebAuthn()` never even runs without it, so
 * this is never a guess between the two. Naming the actual fix first
 * (turn scripting on) before the recoveries that apply when it cannot be.
 */
const NOSCRIPT_MESSAGE = `This browser has scripting turned off, and unlocking needs it. Turn scripting on, or try ${OTHER_RECOVERIES}.`;

/**
 * The note shown once a prompt is dismissed or times out — the screen stays
 * exactly as usable as before, because neither is a refusal (this file's own
 * header on `unlock-ceremony.ts`'s finding). Extracted so a mutation dropping
 * it fails a direct render test rather than surviving one that never
 * reaches a phase this suite has no browser to drive it into.
 */
function DismissedNote({ phase }: { phase: Phase }) {
  if (phase !== "dismissed") return null;
  return (
    <p className="field-note">
      That passkey check did not complete. Nothing has changed here — press Unlock to try again.
    </p>
  );
}

/**
 * The one control, or the message replacing it — never both, and never
 * neither: `supported` is `null` until the mount check answers (the server
 * can never know, so the button renders by default per ticket 04: the two
 * are not alternatives the server chooses between) and only ever narrows to
 * `false` after hydration. Extracted as its own component so both branches —
 * the message ticket 04 says has no test at all today, and the `disabled`
 * attribute a mutation could quietly drop — are each a direct render
 * assertion rather than a state this suite has no browser to reach.
 *
 * **`revalidatorState` disables the button too, not only `phase` (finding
 * 5).** A dismissed or failed attempt starts `loaderData.options` refreshing
 * (`runCeremony`'s own header) without moving `phase` off whatever it
 * settled to — `"idle"` once the ceremony effect resets it. A press accepted
 * during that window would run `requestAssertion` only after the effect
 * waits for the revalidation already in flight to resolve, spending this very
 * click's activation on the network round trip it started — exactly the
 * `NotAllowedError`-as-dismissal bug this screen was rewritten to avoid
 * (`shouldRevalidateBeforeRetry`'s own header, commit c0af420).
 */
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
  if (supported === false) {
    return <p className="empty-note">{NO_CEREMONY_MESSAGE}</p>;
  }

  return (
    <button
      type="button"
      className="button"
      onClick={onUnlock}
      disabled={phase === "confirming" || revalidatorState !== "idle"}
    >
      Unlock
    </button>
  );
}

/**
 * The server's own refusal, or this attempt's own client-only one — never
 * both, and never a refusal that belonged to a different attempt (finding
 * 10's "stale refusal shown in every phase"). `"idle"` is the only phase that
 * may show `serverFormError`: every other phase means a fresh press has
 * already happened since that refusal was rendered, and `serverFormError`
 * itself is read directly off `actionData` by the caller rather than
 * mirrored into local state, so there is nothing here that can go stale on
 * its own. `"failed"` shows this attempt's own `clientMessage` instead —
 * never the server's, which never applied to a ceremony that never reached
 * it. Every other phase shows nothing: `"confirming"` has nothing to show
 * yet, and `"dismissed"` has its own note ({@link DismissedNote}), not a
 * refusal.
 */
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
 * Whether settling into `phase` leaves `loaderData.options` stale and so
 * must trigger a background refresh — called from {@link runCeremony} the
 * moment an outcome settles into `"dismissed"` or `"failed"`, never from a
 * later button press.
 *
 * **Why the refresh cannot wait for the next press.** WebKit requires each
 * `navigator.credentials.get()` call to sit inside its own user activation
 * (this file's own header, and `docs/specs/0019-the-lock.md`'s "two
 * deliberate taps, not one"); a click handler that started the revalidation
 * itself and then waited on it to resolve before running the ceremony would
 * spend that very click's activation waiting on a network round trip, and a
 * slow loader, a slow database, or a slow network leaves
 * `navigator.credentials.get()` called *after* the activation the click
 * granted has already lapsed — rejected with no prompt ever shown, and that
 * `NotAllowedError` then reads as a second dismissal the reader never
 * produced. Starting the refresh here, as soon as the previous attempt is
 * known to have left the options stale, means it has every idle moment
 * between attempts — the reader reading the failure, deciding to retry,
 * moving a finger — to finish before the *next* press's own activation ever
 * has to wait on it. `"idle"` means the options already in hand are fresh —
 * see this file's own header on why a dismissed or failed attempt is the
 * only case that leaves them genuinely stale.
 */
function shouldRevalidateBeforeRetry(phase: Phase): boolean {
  return phase !== "idle";
}

/**
 * Whether the ceremony effect below should actually run right now — every
 * guard the effect needs, in one place a test can drive directly without a
 * browser: a fresh press (`"confirming"`), a challenge that has finished
 * being refreshed if this press asked for that (`revalidatorState ===
 * "idle"`), and no ceremony already in flight for this same press
 * (`!alreadyStarted`). Pulled out of the effect so a mutation that makes the
 * effect return early for the wrong reason is a failing assertion on this
 * function rather than a silent no-op only a real browser could ever notice
 * (finding 10).
 */
function shouldRunCeremony(
  phase: Phase,
  revalidatorState: "idle" | "loading" | "submitting",
  alreadyStarted: boolean,
): boolean {
  return phase === "confirming" && revalidatorState === "idle" && !alreadyStarted;
}

/**
 * What running the ceremony once actually does, pulled out of the effect
 * that decides *whether* to run it ({@link shouldRunCeremony}) so this half —
 * what happens once it runs — is callable and assertable on its own, with
 * `requestAssertion` and `submit` supplied by the caller rather than closed
 * over. Awaits `submit(...)` rather than firing it and forgetting: `submit`'s
 * own promise settles only once this route's action *and* its automatic
 * post-action revalidation have both finished — success or refusal alike —
 * so resuming after it is the one moment `actionData` and a fresh
 * `loaderData.options` are both guaranteed current. A successful unlock has
 * already navigated the browser away by then; setting `phase` on an
 * unmounted component is an inert no-op under React 19, not a hazard this
 * needs to guard against (finding 7 — the guard this replaced blocked that
 * hazard and, as a side effect, also blocked this same resolution whenever
 * the effect's own dependencies changed mid-ceremony, which is the bug that
 * finding actually named).
 *
 * **`revalidate` is called from here, not from the next press.** A dismissed
 * or failed outcome is exactly the case {@link shouldRevalidateBeforeRetry}
 * says leaves `loaderData.options` stale — and this is the moment that
 * becomes true, so the refresh starts immediately, while whatever idle time
 * passes before the reader presses Unlock again is free. A caller that instead
 * waited for that next press to call `revalidate` and only *then* awaited it
 * would run the ceremony's `navigator.credentials.get()` after the click that
 * started the wait, outside the very user activation that click granted
 * (`shouldRevalidateBeforeRetry`'s own header) — a slow loader turns an
 * honest retry into a `NotAllowedError` no prompt ever produced, mislabelled
 * as a second dismissal. Never called on the `"ok"` branch: a successful
 * `submit` already carries its own automatic post-action revalidation, and a
 * second, redundant one here would spend a load on options nothing is going
 * to read.
 */
async function runCeremony(
  optionsJSON: Parameters<typeof requestAssertion>[0],
  redirectTo: string,
  submit: ReturnType<typeof useSubmit>,
  setPhase: (phase: Phase) => void,
  setClientMessage: (message: string | null) => void,
  revalidate: () => void,
): Promise<void> {
  const outcome = await requestAssertion(optionsJSON);

  if (outcome.status === "ok") {
    await submit({ assertion: JSON.stringify(outcome.response), redirectTo }, { method: "post" });
    setPhase("idle");
    return;
  }

  const settledPhase: Phase = outcome.status === "dismissed" ? "dismissed" : "failed";
  if (outcome.status === "failed") setClientMessage(outcome.message);
  setPhase(settledPhase);
  if (shouldRevalidateBeforeRetry(settledPhase)) revalidate();
}

export default function Unlock({ loaderData, actionData }: Route.ComponentProps) {
  const { options, redirectTo } = loaderData;
  const revalidator = useRevalidator();
  const submit = useSubmit();

  const [supported, setSupported] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  // A client-only failure's own message — never the server's (see {@link visibleRefusal}).
  const [clientMessage, setClientMessage] = useState<string | null>(null);
  // Guards the ceremony effect below against firing twice for one press —
  // reset only when a fresh press starts a new one.
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

  /**
   * Runs the ceremony once {@link shouldRunCeremony} says to, never inline in
   * the click handler: reading `loaderData`/`revalidator` synchronously after
   * awaiting a state change is exactly the stale-closure trap React's own
   * re-render is what correctly avoids, so this waits for the *props* to
   * reflect refreshed options rather than guessing when a promise settles.
   * No cleanup, and no guard against the component having unmounted: nothing
   * this effect's own async work resolves to is unsafe to apply late (see
   * {@link runCeremony}'s own header).
   */
  useEffect(() => {
    if (!shouldRunCeremony(phase, revalidator.state, ceremonyStarted.current)) return;
    ceremonyStarted.current = true;

    void runCeremony(options, redirectTo, submit, setPhase, setClientMessage, revalidator.revalidate);
  }, [phase, revalidator.state, revalidator.revalidate, options, redirectTo, submit]);

  // Never calls `revalidator.revalidate()` itself (finding: a retry run
  // outside its own user activation) — that already happened, if it needed
  // to, the moment the previous attempt settled into "dismissed" or "failed"
  // (`runCeremony`'s own header). All this does is start a fresh press; by
  // the time it runs, `loaderData.options` is either already fresh or the
  // effect above's `revalidator.state === "idle"` guard waits for it to
  // become so, exactly as it always has.
  function handleUnlock() {
    if (phase === "confirming") return;
    ceremonyStarted.current = false;
    setClientMessage(null);
    setPhase("confirming");
  }

  const refusal = visibleRefusal(phase, actionData?.formError ?? null, clientMessage);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Locked</h1>
          <p className="page-subtitle">
            This browser is locked. Unlocking uses a passkey — this device's own provider, or
            another device this browser offers.
          </p>
        </div>
      </header>

      <section className="panel">
        <div className="panel-body panel-body--empty">
          <UnlockControl
            supported={supported}
            phase={phase}
            revalidatorState={revalidator.state}
            onUnlock={handleUnlock}
          />

          <DismissedNote phase={phase} />

          {refusal ? (
            <p className="form-error" role="alert">
              {refusal}
            </p>
          ) : null}

          {/* Real HTML, not a React branch: this is only ever shown by a
              browser actually running with scripting off, the one case
              `supported` above can never observe (`supportsPasskeys` never
              runs without JavaScript). */}
          <noscript>
            <p className="empty-note">{NOSCRIPT_MESSAGE}</p>
          </noscript>
        </div>
      </section>
    </section>
  );
}

export {
  runCeremony,
  shouldRevalidateBeforeRetry,
  shouldRunCeremony,
  UnlockControl,
  DismissedNote,
  visibleRefusal,
  NO_CEREMONY_MESSAGE,
  NOSCRIPT_MESSAGE,
  UNREADABLE_SUBMISSION_MESSAGE,
};
export type { Phase };
