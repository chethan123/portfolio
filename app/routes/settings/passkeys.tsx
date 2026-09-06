/**
 * Settings → Passkeys: list, enrol, remove. Every rule about whether either is allowed belongs to
 * `~/lib/lock.server`. docs/adr/0012, spec 0019
 *
 * Enrolling is always two presses, the first passkey included: WebKit requires each WebAuthn call
 * inside its own user activation, so a ceremony may never sit behind an awaited round trip. The
 * enrolment challenge is therefore minted in the loader, once per load; a removal's is scoped to one
 * credential and minted by that row's first press, so minting all of them per load would flood the
 * `remove` purpose's budget.
 *
 * Every verified assertion mints a grant, so the confirm step and every removal set this browser's
 * cookie. A removal's assertion may be signed by a passkey other than the target — `allowCredentials`
 * cannot exclude it without stranding a one-passkey household — so the action reads back what is
 * actually still live rather than assuming the signer survived.
 */
import { useEffect, useRef, useState } from "react";
import { data, useFetcher, useRevalidator } from "react-router";

import { formatDate, formatDateLocal } from "~/lib/format";
import { NotFoundError, ValidationError, formFields } from "~/lib/input.server";
import { CHALLENGE_TTL_MS, LABEL_MAX_LENGTH } from "~/lib/lock";
import {
  beginEnrolment,
  clearedLockCookie,
  completeRegistration,
  enrolmentAssertionOptions,
  listPasskeys,
  lockCookie,
  readGrant,
  readLockCookie,
  removalAssertionOptions,
  removePasskey,
  type Passkey,
} from "~/lib/lock.server";
import { requestAssertion, requestRegistration, supportsPasskeys } from "~/lib/unlock-ceremony";

import { shouldRevalidateBeforeRetry, shouldRunCeremony } from "../unlock";

import type { Route } from "./+types/passkeys";

export function meta() {
  return [{ title: "Passkeys · Settings · Portfolio" }];
}

/** Derived from the domain module's own return: `lock.server.ts` is the only importer of `@simplewebauthn/server`. */
type RegistrationOptions = Awaited<ReturnType<typeof beginEnrolment>>["options"];

type AssertionOptions = Awaited<ReturnType<typeof enrolmentAssertionOptions>>;

type ActionData =
  | { intent: "beginEnrolment"; ok: true; options: RegistrationOptions }
  | { intent: "beginEnrolment"; ok: false; formError: string }
  | { intent: "completeRegistration"; ok: true }
  | { intent: "completeRegistration"; ok: false; formError: string }
  | { intent: "remove"; ok: true; credentialId: string }
  | { intent: "remove"; ok: false; formError: string; credentialId: string }
  | { intent: "removalOptions"; ok: true; credentialId: string; options: AssertionOptions }
  | { intent: "removalOptions"; ok: false; formError: string; credentialId: string }
  | { intent: "unreadable"; ok: false; formError: string };

/** Three states, not two: `"unknown"` is a grant read that failed, which must not read as "no grant". */
type OwnPasskey = string | undefined | "unknown";

/** `enrolOptions` is minted on every GET, revalidations included. A row's removal options are not — per press. */
export async function loader({ request }: Route.LoaderArgs) {
  const passkeys = await listPasskeys();
  const hasPasskeys = passkeys.length > 0;

  let ownPasskeyId: OwnPasskey;
  const grantId = readLockCookie(request);
  if (grantId !== undefined) {
    try {
      ownPasskeyId = (await readGrant(grantId))?.passkeyId;
    } catch (error) {
      // Not "no grant": the row falls back to the cautious warning.
      ownPasskeyId = "unknown";
      console.error("Grant lookup failed while listing passkeys; rendering without it:", error);
    }
  }

  const enrolOptions = await enrolmentAssertionOptions();

  return { passkeys, hasPasskeys, ownPasskeyId, enrolOptions };
}

/** Unparseable becomes `undefined`, which the domain module already refuses in its own words. */
function parseJSONField(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export const UNREADABLE_SUBMISSION_MESSAGE = "This submission could not be read. Reload the page and try again.";

export async function action({ request }: Route.ActionArgs) {
  let fields: Record<string, string>;
  try {
    fields = formFields(await request.formData());
  } catch {
    return data({ intent: "unreadable" as const, ok: false as const, formError: UNREADABLE_SUBMISSION_MESSAGE });
  }
  const intent = fields.intent;

  try {
    if (intent === "removalOptions") {
      const credentialId = fields.credentialId ?? "";
      const options = await removalAssertionOptions(credentialId);
      return data({ intent, ok: true as const, credentialId, options });
    }

    if (intent === "beginEnrolment") {
      const assertion = parseJSONField(fields.assertion);
      const { options, grant } = await beginEnrolment(fields.label ?? "", {
        assertion,
        acknowledgement: fields.acknowledged,
        // Replaces the grant this browser holds rather than adding a second.
        supersedes: readLockCookie(request),
      });

      return data(
        { intent, ok: true as const, options },
        // Present only when an assertion was verified; absent for the household's first passkey.
        grant ? { headers: { "Set-Cookie": lockCookie(grant.id) } } : undefined,
      );
    }

    if (intent === "completeRegistration") {
      const response = parseJSONField(fields.response);
      const { grant } = await completeRegistration(response);

      return data(
        { intent, ok: true as const },
        // Only the first passkey mints one here: every later one already has its assertion's.
        grant ? { headers: { "Set-Cookie": lockCookie(grant.id) } } : undefined,
      );
    }

    if (intent === "remove") {
      const assertion = parseJSONField(fields.assertion);
      const priorGrantId = readLockCookie(request);

      const { grant } = await removePasskey(fields.credentialId ?? "", {
        assertion,
        confirmRemoval: fields.confirmRemoval,
        supersedes: priorGrantId,
      });

      // The minted grant is credited to whichever passkey signed, which may be the one just
      // deleted. At most one of the two branches below finds a live row; a browser unlocked under
      // the passkey it removed finds neither, which is what the cleared cookie is for.
      const mintedGrant = await readGrant(grant.id);
      let setCookie: string;
      if (mintedGrant !== undefined) {
        setCookie = lockCookie(mintedGrant.id);
      } else {
        // Signer was the deleted passkey, so its grant is gone with it: fall back to the prior one.
        const priorGrant = priorGrantId === undefined ? undefined : await readGrant(priorGrantId);
        setCookie = priorGrant === undefined ? clearedLockCookie() : lockCookie(priorGrant.id);
      }

      return data(
        { intent, ok: true as const, credentialId: fields.credentialId ?? "" },
        { headers: { "Set-Cookie": setCookie } },
      );
    }

    throw new Response(`Unknown intent ${JSON.stringify(intent)}.`, { status: 400 });
  } catch (error) {
    if (error instanceof ValidationError) {
      // Joins every refused field: a label refusal is keyed `label`, not `FORM_ERROR`.
      const formError = error.message;
      if (intent === "remove") {
        return data({ intent, ok: false as const, formError, credentialId: fields.credentialId ?? "" });
      }
      if (intent === "removalOptions") {
        // Unreachable; the shape exists so the type is total.
        return data({ intent, ok: false as const, formError, credentialId: fields.credentialId ?? "" });
      }
      return data({ intent: intent as "beginEnrolment" | "completeRegistration", ok: false as const, formError });
    }
    if (error instanceof NotFoundError) {
      // Reachable: a tab left open while another browser removed this very passkey. Printed, not 404'd.
      if (intent === "remove") {
        return data({
          intent,
          ok: false as const,
          formError:
            "This passkey is no longer enrolled — another browser removed it. Reload to see " +
            "the current list.",
          credentialId: fields.credentialId ?? "",
        });
      }
      throw new Response(error.message, { status: 404 });
    }
    throw error;
  }
}

export type RemovalWarningKind = "turnsOffTheLock" | "locksThisBrowser" | "safeElsewhere";

/**
 * The last passkey wins over every other case: removing it turns the lock off, so warning about a
 * lockout would be a lie. Otherwise the only question is whether the target owns *this browser's*
 * grant. `"unknown"` takes the cautious branch — never told it is safe on a fact this request could
 * not confirm.
 */
export function removalWarningKind(
  targetId: string,
  totalPasskeys: number,
  ownPasskeyId: OwnPasskey,
): RemovalWarningKind {
  if (totalPasskeys <= 1) return "turnsOffTheLock";
  if (ownPasskeyId === "unknown") return "locksThisBrowser";
  return targetId === ownPasskeyId ? "locksThisBrowser" : "safeElsewhere";
}

const REMOVAL_WARNING_TEXT: Record<RemovalWarningKind, (label: string) => string> = {
  turnsOffTheLock: (label) =>
    `Remove ${label}: this is the household's last passkey. Nothing will be enrolled ` +
    "afterwards, so this turns the lock off — every browser renders again until a passkey " +
    "is enrolled once more.",
  locksThisBrowser: (label) =>
    `Remove ${label}: this passkey currently unlocks this browser. If it is the one that ` +
    "signs this confirmation, removing it locks this browser the moment it succeeds — not a " +
    "sign-out, the lock coming back on right here. A different, still-enrolled passkey may " +
    "sign instead (your passkey provider's own choice to make, not this screen's) — then this " +
    "browser stays unlocked under that one.",
  safeElsewhere: (label) =>
    `Remove ${label}: a different, still-enrolled passkey is authorising this removal, so ` +
    "this browser stays unlocked afterwards. Use this to revoke a passkey that is lost or " +
    "gone for good.",
};

export function removalWarningText(kind: RemovalWarningKind, label: string): string {
  return REMOVAL_WARNING_TEXT[kind](label);
}

/** Eligibility, never an accomplished backup — "synced" would claim redundancy that may not exist. */
export function syncLabel(backupEligible: boolean): string {
  return backupEligible ? "Can sync to other devices" : "Bound to a single device";
}

export function enrolledText(enrolledAt: Date): string {
  return formatDate(enrolledAt);
}

export function lastUsedText(lastUsedAt: Date | null): string {
  return lastUsedAt === null ? "never" : formatDate(lastUsedAt);
}

/**
 * First paint uses `initialText`, identical on server and hydration render, so nothing mismatches;
 * the effect then corrects to the browser's zone. Safe here and never for masking: a date one day
 * off is cosmetic, a figure drawn then hidden is not.
 */
function LocalDate({ instant, initialText }: { instant: Date; initialText: string }) {
  const [text, setText] = useState(initialText);

  useEffect(() => {
    setText(formatDateLocal(instant));
  }, [instant]);

  return (
    <time dateTime={instant.toISOString()} suppressHydrationWarning>
      {text}
    </time>
  );
}

/** `"confirming"` is the confirm-with-an-existing-passkey step; it never waits on a fetch of its own. */
type EnrolPhase = "idle" | "confirming" | "busy" | "readyToCreate";

export const ALREADY_REGISTERED_MESSAGE =
  "This provider already holds a passkey for this app and will not make a second. " +
  "Make the next one from a different device, or from a different provider on this one.";

/** Scoped to enrolling and removing: the chrome's Lock now is a real form post and still works. */
export const NOSCRIPT_MESSAGE =
  "This browser has scripting turned off, and enrolling or removing a passkey needs it. " +
  "Turn scripting on, or use a browser that has it.";

/** Checked before calling WebAuthn: past the TTL the authenticator would create a credential the server then refuses. */
export function registrationOptionsExpired(mintedAt: number, now: number): boolean {
  return now - mintedAt >= CHALLENGE_TTL_MS;
}

export const REGISTRATION_OPTIONS_EXPIRED_MESSAGE =
  "That took too long, so the registration challenge behind it has expired. Start again.";

export const NO_CEREMONY_MESSAGE =
  "This browser cannot run the passkey check, so it cannot enrol or remove one here. Try " +
  "another browser on this device, or a device that can reach a passkey the household has " +
  "enrolled.";

type EnrolPanelProps = { hasPasskeys: boolean; supported: boolean | null; enrolOptions: AssertionOptions };

/**
 * `revalidate` on the settled outcome, never from the next press: `enrolOptions` is minted once per
 * load, so a dismissed or failed attempt leaves it stale, and refreshing inside the next click would
 * spend that click's user activation on the round trip. Never on `"ok"` — the submit carries its own.
 */
export async function runConfirmCeremony(
  optionsJSON: AssertionOptions,
  label: string,
  submit: ReturnType<typeof useFetcher<ActionData>>["submit"],
  setPhase: (phase: EnrolPhase) => void,
  setNote: (note: string | null) => void,
  revalidate: () => void,
): Promise<void> {
  const outcome = await requestAssertion(optionsJSON);

  if (outcome.status === "ok") {
    const body: Record<string, string> = {
      intent: "beginEnrolment",
      label,
      assertion: JSON.stringify(outcome.response),
    };
    void submit(body, { method: "post" });
    return;
  }

  setPhase("idle");
  setNote(
    outcome.status === "dismissed"
      ? "That confirmation did not complete. Nothing has changed — press Confirm to try again."
      : outcome.message,
  );
  if (shouldRevalidateBeforeRetry(outcome.status === "dismissed" ? "dismissed" : "failed")) revalidate();
}

/**
 * `revalidatorState` counts: a dismissed confirm starts `enrolOptions` refreshing without moving
 * `phase`, and a press accepted then would wait on that round trip inside its own activation.
 * Never `"readyToCreate"` — that is exactly when Create must stay pressable.
 */
export function enrolBusy(
  phase: EnrolPhase,
  fetcherState: "idle" | "loading" | "submitting",
  revalidatorState: "idle" | "loading" | "submitting",
): boolean {
  return phase === "confirming" || phase === "busy" || fetcherState !== "idle" || revalidatorState !== "idle";
}

function EnrolPanel({ hasPasskeys, supported, enrolOptions }: EnrolPanelProps) {
  const fetcher = useFetcher<ActionData>();
  const revalidator = useRevalidator();
  const [label, setLabel] = useState("");
  const [warningAcknowledged, setWarningAcknowledged] = useState(false);
  const [phase, setPhase] = useState<EnrolPhase>("idle");
  const [note, setNote] = useState<string | null>(null);
  const [registrationOptions, setRegistrationOptions] = useState<RegistrationOptions | null>(null);
  // Client-side `Date.now()`; `null` exactly when `registrationOptions` is.
  const [registrationMintedAt, setRegistrationMintedAt] = useState<number | null>(null);
  // Guards the effect below against firing twice for one press.
  const confirmCeremonyStarted = useRef(false);

  const busy = enrolBusy(phase, fetcher.state, revalidator.state);

  // Off a render, never by reading `fetcher.data` straight after `submit` resolves — stale closure.
  useEffect(() => {
    if (fetcher.state !== "idle" || fetcher.data === undefined) return;
    const result = fetcher.data;

    if (result.intent !== "beginEnrolment" && result.intent !== "completeRegistration") return;

    if (!result.ok) {
      resetEnrolment(setNote, setPhase, setRegistrationOptions, setRegistrationMintedAt, result.formError);
      return;
    }

    if (result.intent === "beginEnrolment") {
      setNote(null);
      setRegistrationOptions(result.options);
      setRegistrationMintedAt(Date.now());
      // A second, separate press runs the creation ceremony — never auto-run from here.
      setPhase("readyToCreate");
      return;
    }

    setLabel("");
    setWarningAcknowledged(false);
    setRegistrationOptions(null);
    setRegistrationMintedAt(null);
    setNote(null);
    setPhase("idle");
  }, [fetcher.state, fetcher.data]);

  // `shouldRunCeremony` is `unlock.tsx`'s, imported: the phases it does not share map to `"idle"`,
  // which it treats identically. An effect, not the click handler, so it waits on props.
  useEffect(() => {
    const mappedPhase = phase === "confirming" ? "confirming" : "idle";
    if (!shouldRunCeremony(mappedPhase, revalidator.state, confirmCeremonyStarted.current)) return;
    confirmCeremonyStarted.current = true;

    void runConfirmCeremony(enrolOptions, label, fetcher.submit, setPhase, setNote, revalidator.revalidate);
  }, [phase, revalidator.state, revalidator.revalidate, enrolOptions, label, fetcher]);

  function handleConfirmIdentity() {
    setNote(null);
    confirmCeremonyStarted.current = false;
    setPhase("confirming");
  }

  // Runs `requestRegistration` off this gesture with nothing awaited ahead of it; the expiry check
  // is synchronous, so it costs no activation.
  function handleCreatePasskey() {
    if (registrationOptions === null || registrationMintedAt === null) return;

    if (registrationOptionsExpired(registrationMintedAt, Date.now())) {
      // The whole flow resets, not just this step, so a second press cannot meet the same stale options.
      setPhase("idle");
      setRegistrationOptions(null);
      setRegistrationMintedAt(null);
      setNote(REGISTRATION_OPTIONS_EXPIRED_MESSAGE);
      return;
    }

    setNote(null);
    setPhase("busy");
    void runCreate(registrationOptions);
  }

  async function runCreate(options: RegistrationOptions) {
    const outcome = await requestRegistration(options);

    if (outcome.status === "ok") {
      const body: Record<string, string> = {
        intent: "completeRegistration",
        response: JSON.stringify(outcome.response),
      };
      void fetcher.submit(body, { method: "post" });
      return;
    }

    // Nothing reached the server, so the challenge is unspent: staying ready lets a retry — through
    // a different provider, for the already-registered case — reuse it.
    setPhase("readyToCreate");
    setNote(
      outcome.status === "dismissed"
        ? "That passkey creation did not complete. Nothing has changed — press Create passkey to try again."
        : outcome.status === "alreadyRegistered"
          ? ALREADY_REGISTERED_MESSAGE
          : outcome.message,
    );
  }

  function handleBeginFirstPasskey() {
    setNote(null);
    setPhase("busy");
    void fetcher.submit(
      { intent: "beginEnrolment", label, acknowledged: warningAcknowledged ? "true" : "false" },
      { method: "post" },
    );
  }

  const confirmedLabel = registrationOptions?.user.name ?? label;
  const canUseAPasskey = supported !== false;
  // Keyed on the options, not `phase`: the Create button must not flicker back to the confirm step
  // while its own ceremony runs.
  const readyToCreate = registrationOptions !== null;

  return (
    <section className="panel">
      <header className="panel-header">
        <h2 className="panel-title">Add a passkey</h2>
      </header>

      <div className="panel-form">
        <div>
          <label htmlFor="passkey-label">
            Label
            <input
              id="passkey-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Alex's phone"
              autoComplete="off"
              maxLength={LABEL_MAX_LENGTH}
              disabled={busy || readyToCreate}
            />
          </label>
          <p className="field-note">
            What this passkey is called in the list below, and what a password manager shows
            when it offers this one — typed now, not read off this browser.
          </p>
        </div>

        {!hasPasskeys ? (
          <label className="choice choice--prose">
            <input
              type="checkbox"
              checked={warningAcknowledged}
              onChange={(event) => setWarningAcknowledged(event.target.checked)}
            />
            <strong>
              Enrolling this passkey locks every other browser in the household immediately —
              each one will need its own passkey to see anything here again. Whether a locked
              browser can instead be unlocked by approving from a device that already holds this
              passkey depends on the provider that made it, and nobody has tried it here yet —
              whoever set this app up for the household knows how to check. This browser stays
              unlocked.
            </strong>
          </label>
        ) : null}

        {note ? (
          <p className="form-error" role="alert">
            {note}
          </p>
        ) : null}

        {!canUseAPasskey ? (
          <p className="empty-note">{NO_CEREMONY_MESSAGE}</p>
        ) : readyToCreate ? (
          <>
            <button type="button" className="button" onClick={handleCreatePasskey} disabled={busy}>
              Create the passkey named "{confirmedLabel}"
            </button>
            <button
              type="button"
              className="button button--quiet"
              onClick={() =>
                resetEnrolment(setNote, setPhase, setRegistrationOptions, setRegistrationMintedAt)
              }
              disabled={busy}
            >
              Start over
            </button>
          </>
        ) : hasPasskeys ? (
          <>
            <p className="field-note">
              First, confirm it is you with a passkey already enrolled — adding one is held to
              the same rule as removing one.
            </p>
            <button
              type="button"
              className="button"
              onClick={handleConfirmIdentity}
              disabled={busy || label.trim() === ""}
            >
              Confirm with an existing passkey
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button"
            onClick={handleBeginFirstPasskey}
            disabled={busy || label.trim() === "" || !warningAcknowledged}
          >
            Continue
          </button>
        )}

        {/* Stays last: `.panel-form`'s sibling rule only zeroes a button's top margin when it
            directly follows a full-line member, and even a `display: none` element between reopens
            the 24px drop. */}
        <noscript>
          <p className="empty-note">{NOSCRIPT_MESSAGE}</p>
        </noscript>
      </div>
    </section>
  );
}

/** The unspent `register` challenge is simply abandoned — refused on arrival anyway, and budget-bounded. */
export function resetEnrolment(
  setNote: (note: string | null) => void,
  setPhase: (phase: EnrolPhase) => void,
  setRegistrationOptions: (options: RegistrationOptions | null) => void,
  setRegistrationMintedAt: (mintedAt: number | null) => void,
  note: string | null = null,
): void {
  setNote(note);
  setPhase("idle");
  setRegistrationOptions(null);
  setRegistrationMintedAt(null);
}

/** The one place fetched removal options are stored; it never runs the ceremony — that is {@link runRemovalCeremony}. */
export function applyRemovalOptionsResult(
  result: ActionData,
  setNote: (note: string | null) => void,
  setExpanded: (expanded: boolean) => void,
  setRemovalOptions: (options: AssertionOptions | null) => void,
): void {
  if (result.intent !== "removalOptions") return;

  if (!result.ok) {
    setNote(result.formError);
    setExpanded(false);
    return;
  }

  setRemovalOptions(result.options);
}

/**
 * A removal the *server* refused has already spent its challenge, so this re-mints. Without it every
 * later Confirm press on the row retries a challenge that can never succeed.
 */
export function applyRemoveResult(
  result: ActionData,
  setNote: (note: string | null) => void,
  refetchOptions: () => void,
): void {
  if (result.intent !== "remove") return;

  if (!result.ok) {
    setNote(result.formError);
    refetchOptions();
    return;
  }

  setNote(null);
}

/**
 * Two rows submitting removals at once each carry a `Set-Cookie`, and the later one can name a grant
 * the other already cascaded away. A row's own in-flight removal is covered by its own fetcher.
 */
export function lockedByOtherRow(activeRemovalId: string | null, credentialId: string): boolean {
  return activeRemovalId !== null && activeRemovalId !== credentialId;
}

/** Never pressable while this row's own options fetch is in flight, or the ceremony queues behind a network wait. */
export function removalConfirmDisabled(
  optionsFetcherState: "idle" | "loading" | "submitting",
  acknowledged: boolean,
  otherwiseBusy: boolean,
): boolean {
  return optionsFetcherState !== "idle" || !acknowledged || otherwiseBusy;
}

/**
 * Run straight off the Confirm removal press, no effect: a row's options are never carried across a
 * revalidation, so there is no revalidator state to wait on. A dismissed or failed outcome leaves
 * them in place — the challenge was never spent.
 *
 * `releaseLock` fires only on that branch: the `"ok"` branch must stay locked until its own
 * submission lands, which is what stops two removals racing.
 */
export async function runRemovalCeremony(
  optionsJSON: AssertionOptions,
  credentialId: string,
  submit: ReturnType<typeof useFetcher<ActionData>>["submit"],
  setNote: (note: string | null) => void,
  setConfirming: (confirming: boolean) => void,
  refetchOptions: () => void,
  releaseLock: () => void,
): Promise<void> {
  const outcome = await requestAssertion(optionsJSON);
  setConfirming(false);

  if (outcome.status !== "ok") {
    setNote(
      outcome.status === "dismissed"
        ? "That confirmation did not complete. Nothing has changed — press Confirm removal to try again."
        : outcome.message,
    );
    // Unspent but not immortal — two minutes — so refresh now, never inside the next press.
    refetchOptions();
    releaseLock();
    return;
  }

  const body: Record<string, string> = {
    intent: "remove",
    credentialId,
    assertion: JSON.stringify(outcome.response),
    confirmRemoval: "true",
  };
  void submit(body, { method: "post" });
}

function PasskeyRow({
  passkey,
  warningKind,
  supported,
  activeRemovalId,
  setActiveRemovalId,
}: {
  passkey: Passkey;
  warningKind: RemovalWarningKind;
  supported: boolean | null;
  // The page's one shared removal lock ({@link lockedByOtherRow}), not this row's to keep.
  activeRemovalId: string | null;
  setActiveRemovalId: (credentialId: string | null) => void;
}) {
  const fetcher = useFetcher<ActionData>();
  const optionsFetcher = useFetcher<ActionData>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Set when press 1 fires the options fetch, so Confirm appears already disabled rather than late.
  const [expanded, setExpanded] = useState(false);
  const [removalOptions, setRemovalOptions] = useState<AssertionOptions | null>(null);
  // True only while `requestAssertion` runs; disabling the button on it is enough — no effect guard.
  const [confirming, setConfirming] = useState(false);
  const busy =
    fetcher.state !== "idle" ||
    confirming ||
    supported === false ||
    lockedByOtherRow(activeRemovalId, passkey.credentialId);

  useEffect(() => {
    if (fetcher.state !== "idle" || fetcher.data === undefined) return;
    applyRemoveResult(fetcher.data, setNote, requestRemovalOptions);
    setActiveRemovalId(null);
  }, [fetcher.state, fetcher.data]);

  useEffect(() => {
    if (optionsFetcher.state !== "idle" || optionsFetcher.data === undefined) return;
    applyRemovalOptionsResult(optionsFetcher.data, setNote, setExpanded, setRemovalOptions);
  }, [optionsFetcher.state, optionsFetcher.data]);

  function handleRemove() {
    setNote(null);

    if (!acknowledged) {
      // No ceremony: the domain module refuses an unticked acknowledgement before looking for an
      // assertion, so this carries no `Set-Cookie` and needs no page lock.
      void fetcher.submit({ intent: "remove", credentialId: passkey.credentialId }, { method: "post" });
      return;
    }

    // Press 1 mints this row's options and runs no ceremony.
    setExpanded(true);
    requestRemovalOptions();
  }

  // Cleared first, so a Confirm press can never find options a fetch is mid-way through replacing.
  function requestRemovalOptions() {
    setRemovalOptions(null);
    void optionsFetcher.submit(
      { intent: "removalOptions", credentialId: passkey.credentialId },
      { method: "post" },
    );
  }

  // Press 2 runs the ceremony off this click, against options press 1 already fetched.
  function handleConfirmRemoval() {
    if (removalOptions === null) return;
    setNote(null);
    setConfirming(true);
    // Locks every other row before the assertion can resolve.
    setActiveRemovalId(passkey.credentialId);
    void runRemovalCeremony(
      removalOptions,
      passkey.credentialId,
      fetcher.submit,
      setNote,
      setConfirming,
      requestRemovalOptions,
      () => setActiveRemovalId(null),
    );
  }

  return (
    <li>
      {/* `.record` alone carries neither padding nor wrap — both live on `.record-form`. */}
      <div className="record record-form">
        <div>
          <p>
            <strong>{passkey.label}</strong>
          </p>
          <p className="record-note">
            Enrolled{" "}
            <span className="u-data">
              <LocalDate instant={passkey.enrolledAt} initialText={enrolledText(passkey.enrolledAt)} />
            </span>{" "}
            · Last used{" "}
            <span className="u-data">
              {passkey.lastUsedAt === null ? (
                "never"
              ) : (
                <LocalDate instant={passkey.lastUsedAt} initialText={lastUsedText(passkey.lastUsedAt)} />
              )}
            </span>
            {" · "}
            {syncLabel(passkey.backupEligible)}
          </p>
        </div>

        <div className="record-actions">
          <label className="choice choice--prose">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            {removalWarningText(warningKind, passkey.label)}
          </label>

          {expanded ? (
            <button
              type="button"
              className="button button--danger"
              onClick={handleConfirmRemoval}
              disabled={removalConfirmDisabled(optionsFetcher.state, acknowledged, busy)}
              aria-label={`Confirm removing ${passkey.label}`}
            >
              Confirm removal
            </button>
          ) : (
            <button
              type="button"
              className="button button--danger"
              onClick={handleRemove}
              disabled={busy}
              aria-label={`Remove ${passkey.label}`}
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {note ? (
        <p className="field-error" role="alert">
          {note}
        </p>
      ) : null}
    </li>
  );
}

export default function Passkeys({ loaderData }: Route.ComponentProps) {
  const { passkeys, hasPasskeys, ownPasskeyId, enrolOptions } = loaderData;

  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void supportsPasskeys().then((ok) => {
      if (alive) setSupported(ok);
    });
    return () => {
      alive = false;
    };
  }, []);

  const [activeRemovalId, setActiveRemovalId] = useState<string | null>(null);

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Passkeys</h1>
          <p className="page-subtitle">
            What can unlock a browser once the household holds one — and who has proven
            themselves recently enough to change that list.
          </p>
        </div>
      </header>

      {!hasPasskeys ? (
        <p className="empty-note">
          No passkey is enrolled — this instance is not locked, and anyone who reaches it sees
          every figure. Enrolling one locks every other browser in the household.
        </p>
      ) : (
        <section className="panel">
          <ul className="record-list">
            {passkeys.map((passkey) => (
              <PasskeyRow
                key={passkey.credentialId}
                passkey={passkey}
                warningKind={removalWarningKind(passkey.credentialId, passkeys.length, ownPasskeyId)}
                supported={supported}
                activeRemovalId={activeRemovalId}
                setActiveRemovalId={setActiveRemovalId}
              />
            ))}
          </ul>
        </section>
      )}

      {passkeys.length === 1 ? (
        <p className="field-note">
          The household holds one passkey. Enrol a second soon: removing a passkey needs a fresh
          confirmation from one already enrolled, so a household on one that loses it cannot
          revoke it and has to ask whoever set this app up for the household to help.
        </p>
      ) : null}

      <EnrolPanel hasPasskeys={hasPasskeys} supported={supported} enrolOptions={enrolOptions} />
    </>
  );
}
