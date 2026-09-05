/**
 * Settings → Passkeys (docs/adr/0012, spec 0019, ticket 05): list the
 * household's enrolled passkeys, enrol another, remove one. Everything this
 * screen prints about *whether* an enrolment or a removal is allowed is
 * `~/lib/lock.server`'s own rule, restated nowhere here — this route asks
 * for a label or a confirmation, hands the browser's own WebAuthn response
 * to the domain module, and prints back whatever it decided.
 *
 * **The two ceremonies never share a tap, including the first passkey's.**
 * Enrolling is always two ordinary button presses, whether or not the
 * household holds one yet. Once one already exists: "Confirm with an
 * existing passkey" runs an assertion (`requestAssertion`, the same seam
 * `unlock.tsx` uses); once the server accepts it and hands back a fresh
 * registration challenge, a second, separate press — "Create the passkey" —
 * runs the registration ceremony (`requestRegistration`,
 * `~/lib/unlock-ceremony`'s own export). For the very first passkey there is
 * nothing to confirm (`beginEnrolment`'s own header), so the first press
 * instead submits the label and the acknowledgement; the *second* press is
 * still what runs `requestRegistration`. They cannot be one press chained in
 * script either way: WebKit requires each WebAuthn call to sit inside its
 * own user activation, and a `create()` run from an effect after an awaited
 * network round trip is not that — a click handler that itself calls
 * `requestRegistration` synchronously, with no `await` ahead of it, is.
 *
 * **Every verified assertion mints a grant** (`lock.server.ts`'s own rule),
 * so both the "confirm with an existing passkey" step and every removal set
 * this browser's cookie on success — not because this route decided to, but
 * because refusing to would leave a browser that just proved itself locked
 * out by its own proof. Completing a *second-or-later* registration mints
 * none of its own (the assertion just before it already did); completing
 * the household's *first* registration does, which is the one case this
 * route must not forget to carry through, or the browser that just unlocked
 * everyone else's would lock only itself out.
 *
 * **A removal's own assertion is not guaranteed to be signed by the row it
 * targets.** `removalAssertionOptions` deliberately names every enrolled
 * credential in `allowCredentials` — excluding the target would strand a
 * one-passkey household, which is how the lock is turned off
 * (`removePasskey`'s own header) — so a synced vault's picker, or a family
 * member confirming with a different device on purpose, may answer with a
 * passkey other than the one being removed. The action below reads the
 * *actual* outcome back from the database rather than assuming the target
 * signed: it never overwrites a still-live prior grant with one this same
 * request is about to cascade away.
 *
 * **Options are minted on demand, not carried from page load.** A challenge
 * is spent, or refused as expired, the moment it is read
 * (`lock.server.ts`'s `takeChallenge` and its two-minute `CHALLENGE_TTL_MS`)
 * — a value fine to mint once per *ceremony* and wrong to mint once per
 * *row, per load*: a reader who leaves this tab open past that window would
 * have every control refuse "expired" the instant they finally pressed one,
 * and minting one for every row on every load and revalidation floods the
 * one budget each purpose's challenges share (`lock.server.ts`'s own
 * `MAX_LIVE_CHALLENGES_PER_PURPOSE`). So neither the "confirm with an
 * existing passkey" step's options nor a row's own removal options are in
 * `loaderData` at all — each control mints its own, via a dedicated
 * `intent`, at the moment it is actually pressed.
 *
 * **Reading a request's own grant, not only whether one is enrolled.** Which
 * warning a removal shows depends on whether the target *is* this browser's
 * own live grant — a fact the loader resolves once, from this request's
 * cookie, and hands to every row as `ownPasskeyId` ({@link
 * removalWarningKind}). A row cannot answer this from the passkey list
 * alone. A failed read is distinguished from "no grant at all": the former
 * shows every row the cautious, might-lock-you-out wording rather than the
 * falsely reassuring one a plain `undefined` would otherwise produce.
 */
import { useEffect, useRef, useState } from "react";
import { data, useFetcher } from "react-router";

import { formatDate } from "~/lib/format";
import { NotFoundError, ValidationError, formFields } from "~/lib/input.server";
import { LABEL_MAX_LENGTH } from "~/lib/lock";
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

import type { Route } from "./+types/passkeys";

export function meta() {
  return [{ title: "Passkeys · Settings · Portfolio" }];
}

/**
 * What {@link beginEnrolment} actually hands back — derived from its own
 * return type rather than a second, hand-written narrowing of
 * `@simplewebauthn/server`'s own declared shape. `lock.server.ts` already
 * does that narrowing once, at the one place the value is produced (its own
 * comment on `RegistrationOptions` says why); this route only ever needs to
 * name the result, never restate it, which is what keeps this file off the
 * short list `tests/unlock-ceremony-boundary.test.ts` polices — `lock.server.ts`
 * declares itself the only module in the app importing `@simplewebauthn/server`.
 */
type RegistrationOptions = Awaited<ReturnType<typeof beginEnrolment>>["options"];

/** What either ceremony's own options-request hands back. */
type AssertionOptions = Awaited<ReturnType<typeof enrolmentAssertionOptions>>;

/** What this route's one action answers, discriminated by `intent` and success. */
type ActionData =
  | { intent: "beginEnrolment"; ok: true; options: RegistrationOptions }
  | { intent: "beginEnrolment"; ok: false; formError: string }
  | { intent: "completeRegistration"; ok: true }
  | { intent: "completeRegistration"; ok: false; formError: string }
  | { intent: "remove"; ok: true; credentialId: string }
  | { intent: "remove"; ok: false; formError: string; credentialId: string }
  | { intent: "enrolOptions"; ok: true; options: AssertionOptions }
  | { intent: "enrolOptions"; ok: false; formError: string }
  | { intent: "removalOptions"; ok: true; credentialId: string; options: AssertionOptions }
  | { intent: "removalOptions"; ok: false; formError: string; credentialId: string }
  | { intent: "unreadable"; ok: false; formError: string };

/**
 * Which passkey (if any) owns this browser's own grant — resolved once, from
 * this request's cookie, distinguishing three states a plain `string |
 * undefined` cannot: a real credential id, no cookie at all (`undefined`),
 * and a cookie whose grant this read genuinely failed to resolve
 * (`"unknown"`). {@link removalWarningKind} treats the last of those as the
 * cautious case rather than the reassuring one a bare `undefined` would fall
 * into.
 */
type OwnPasskey = string | undefined | "unknown";

/**
 * What the household holds, plus which passkey (if any) owns this request's
 * own grant. No options are minted here at all — see this file's own header
 * on why every control mints its own, on demand, instead.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const passkeys = await listPasskeys();
  const hasPasskeys = passkeys.length > 0;

  let ownPasskeyId: OwnPasskey;
  const grantId = readLockCookie(request);
  if (grantId !== undefined) {
    try {
      ownPasskeyId = (await readGrant(grantId))?.passkeyId;
    } catch (error) {
      // Distinguished from "no grant at all": the row's warning falls back
      // to the cautious wording rather than the reassuring one (finding 13).
      ownPasskeyId = "unknown";
      console.error("Grant lookup failed while listing passkeys; rendering without it:", error);
    }
  }

  return { passkeys, hasPasskeys, ownPasskeyId };
}

/** A client-submitted field that failed to parse becomes `undefined`, exactly as `unlock.tsx`'s action treats one. */
function parseJSONField(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** A submission this route could not even read — never a passkey problem, so it says so plainly (`unlock.tsx`'s own precedent, finding 2). */
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
    if (intent === "enrolOptions") {
      const options = await enrolmentAssertionOptions();
      return data({ intent, ok: true as const, options });
    }

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
      });

      return data(
        { intent, ok: true as const, options },
        // A grant here means this very request's assertion just proved this
        // browser owns an already-enrolled passkey — every verified
        // assertion mints one (`lock.server.ts`'s header), so this browser's
        // cookie is refreshed the same way an unlock's is. No grant means
        // the household held none yet: nothing to refresh, and nothing is
        // owed until the registration below actually completes.
        grant ? { headers: { "Set-Cookie": lockCookie(grant.id) } } : undefined,
      );
    }

    if (intent === "completeRegistration") {
      const response = parseJSONField(fields.response);
      const { grant } = await completeRegistration(response);

      return data(
        { intent, ok: true as const },
        // Defined only for the household's very first passkey — every later
        // one already carries a grant from the assertion just before it
        // (this file's own header on why a second mint here would be wrong,
        // not merely redundant).
        grant ? { headers: { "Set-Cookie": lockCookie(grant.id) } } : undefined,
      );
    }

    if (intent === "remove") {
      const assertion = parseJSONField(fields.assertion);
      const priorGrantId = readLockCookie(request);

      const { grant } = await removePasskey(fields.credentialId ?? "", {
        assertion,
        confirmRemoval: fields.confirmRemoval,
      });

      // The assertion just verified mints `grant`, credited to whichever
      // passkey actually signed it — which may be the very passkey this
      // request is about to delete (this file's own header on why
      // `allowCredentials` cannot exclude the target). Overwriting this
      // browser's cookie with that grant's id regardless would either strand
      // a still-good prior grant behind a cookie naming something already
      // gone, or hand back a name that resolves to nothing the moment the
      // delete below runs. So the cookie is decided from what is actually
      // still true once the dust settles, not from which grant this one
      // verification happened to mint.
      const mintedGrant = await readGrant(grant.id);
      let setCookie: string;
      if (mintedGrant !== undefined) {
        // The signer survived this removal — its fresh grant is this
        // browser's proven identity right now, exactly as any other
        // verified assertion's would be.
        setCookie = lockCookie(mintedGrant.id);
      } else {
        // The signer *was* the passkey this request just deleted, so the
        // grant minted from it is already gone. This browser's own *prior*
        // cookie is the one true fact left about it: leave it alone if it
        // still names something live, and only clear it outright once it
        // does not either.
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
      // `error.message` joins every field the domain module refused
      // (`ValidationError`'s own constructor) — never only
      // `fieldErrors[FORM_ERROR]`, which a label refusal never carries
      // (`parseInput` keys it `label`, the field name) and which used to
      // print as a silent, empty note (finding 4).
      const formError = error.message;
      if (intent === "remove") {
        return data({ intent, ok: false as const, formError, credentialId: fields.credentialId ?? "" });
      }
      if (intent === "removalOptions") {
        // Neither control states a rule of its own — minting options cannot
        // itself be refused — but the shape still has to exist for the type
        // to be total.
        return data({ intent, ok: false as const, formError, credentialId: fields.credentialId ?? "" });
      }
      if (intent === "enrolOptions") {
        return data({ intent, ok: false as const, formError });
      }
      return data({ intent: intent as "beginEnrolment" | "completeRegistration", ok: false as const, formError });
    }
    if (error instanceof NotFoundError) {
      // The reachable case: a Passkeys tab left open while another browser
      // removes the very passkey this one is about to submit a removal for
      // (`removePasskey`'s own header). `ActionData` already has a shape for
      // this refusal — print it, rather than replacing the whole screen with
      // the framework's 404 boundary (finding 8).
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

// ---------------------------------------------------------------------------
// Which warning a removal shows — pure, so a mutation to this rule fails a
// direct assertion rather than surviving in a branch this suite has no DOM
// to reach (the ticket's own instruction, following ticket 04's precedent).
// ---------------------------------------------------------------------------

export type RemovalWarningKind = "turnsOffTheLock" | "locksThisBrowser" | "safeElsewhere";

/**
 * The household's last passkey takes priority over every other case: removing
 * it always unlocks the *instance*, even though — being the last — it is
 * necessarily also whatever authorised this very removal and so also "owns"
 * this browser's grant. Warning about a lockout there would be a lie about
 * the one action that turns the lock off (spec 0019's own words). Short of
 * that, the question is only ever whether the target is *this browser's own*
 * live grant, never how many passkeys remain — a lost-device removal
 * authorised by a *different*, surviving passkey leaves this browser
 * unlocked regardless of whether the household is down to one survivor or
 * several. `"unknown"` — this browser's own grant genuinely could not be
 * read — takes the cautious branch rather than the reassuring one: a
 * removal is never told it is safe on the strength of a fact this request
 * could not actually confirm.
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

/**
 * The sentence per {@link RemovalWarningKind} — a `const` object, not a
 * `switch`, so there is no fallthrough branch to fall off the end of
 * (CLAUDE.md: no enums, but the same reasoning favours a lookup here over a
 * `switch` with no `default`).
 */
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

/** The sentence a removal's own acknowledgement checkbox carries, per {@link removalWarningKind}. */
export function removalWarningText(kind: RemovalWarningKind, label: string): string {
  return REMOVAL_WARNING_TEXT[kind](label);
}

// ---------------------------------------------------------------------------
// A row's own rendered summary — pure, extracted so a mutation to any one
// piece (the sync label, the "never" branch, which date prints where) fails
// a direct assertion rather than surviving inside a component this suite can
// only reach through `renderToStaticMarkup` (finding 7 — the sibling screen
// extracts this shape of thing, this one extracted none of it).
// ---------------------------------------------------------------------------

/** "Synced" or "Bound to a single device", from the stored backup-eligibility flag alone. */
export function syncLabel(backupEligible: boolean): string {
  return backupEligible ? "Synced" : "Bound to a single device";
}

/** The enrolled column's own text — never computed, only rendered ({@link formatDate}'s own rule). */
export function enrolledText(enrolledAt: Date): string {
  return formatDate(enrolledAt);
}

/** The last-used column's own text: "never", or the date it was. */
export function lastUsedText(lastUsedAt: Date | null): string {
  return lastUsedAt === null ? "never" : formatDate(lastUsedAt);
}

// ---------------------------------------------------------------------------
// Enrolling
// ---------------------------------------------------------------------------

/**
 * What the Add-a-passkey control is doing right now. `"mintingOptions"` and
 * `"confirming"` exist only for the confirm-with-an-existing-passkey step
 * (past the first passkey); the first passkey's own first tap goes straight
 * from `"idle"` to `"busy"` (the `beginEnrolment` submission itself) and,
 * once options are back, to `"readyToCreate"` — the same phase the
 * non-first flow lands on once its own confirm step succeeds. Neither flow
 * ever runs `requestRegistration` from anywhere but a direct click handler
 * (this file's own header on why the first passkey is two taps too).
 */
type EnrolPhase = "idle" | "mintingOptions" | "confirming" | "busy" | "readyToCreate";

/** Recoveries a family member can actually act on — never "the operator" (`CONTEXT.md`'s `Gate`/`Allowlist`, finding 10; `unlock.tsx`'s own precedent). */
export const NO_CEREMONY_MESSAGE =
  "This browser cannot run the passkey check, so it cannot enrol or remove one here. Try " +
  "another browser on this device, or a device that can reach a passkey the household has " +
  "enrolled.";

function EnrolPanel({ hasPasskeys, supported }: { hasPasskeys: boolean; supported: boolean | null }) {
  const fetcher = useFetcher<ActionData>();
  const optionsFetcher = useFetcher<ActionData>();
  const [label, setLabel] = useState("");
  const [warningAcknowledged, setWarningAcknowledged] = useState(false);
  const [phase, setPhase] = useState<EnrolPhase>("idle");
  const [note, setNote] = useState<string | null>(null);
  const [registrationOptions, setRegistrationOptions] = useState<RegistrationOptions | null>(null);
  // Guards the confirm-ceremony effect below against firing twice for one
  // press — reset only when a fresh press starts a new one, the same shape
  // `unlock.tsx`'s own `ceremonyStarted` ref guards.
  const confirmCeremonyStarted = useRef(false);

  // Never "readyToCreate": that phase is exactly when the Create button must
  // stay pressable, waiting on the tap that runs `requestRegistration`.
  const busy =
    phase === "mintingOptions" ||
    phase === "confirming" ||
    phase === "busy" ||
    fetcher.state !== "idle" ||
    optionsFetcher.state !== "idle";

  // React to the beginEnrolment/completeRegistration submission's own
  // answer once it settles — never by reading `fetcher.data` right after
  // `submit` resolves, which is the stale-closure trap `unlock.tsx`'s own
  // header warns about; this always reads it off a render instead.
  useEffect(() => {
    if (fetcher.state !== "idle" || fetcher.data === undefined) return;
    const result = fetcher.data;

    if (result.intent !== "beginEnrolment" && result.intent !== "completeRegistration") return;

    if (!result.ok) {
      setNote(result.formError);
      setPhase("idle");
      setRegistrationOptions(null);
      return;
    }

    if (result.intent === "beginEnrolment") {
      setNote(null);
      setRegistrationOptions(result.options);
      // A second, separate press runs the creation ceremony, whether or not
      // this is the household's first passkey (this file's own header on
      // why the first is two taps too) — never auto-run from here.
      setPhase("readyToCreate");
      return;
    }

    // completeRegistration succeeded: the new row arrives through this same
    // submission's automatic revalidation, so there is nothing left to do
    // here but reset for the next one.
    setLabel("");
    setWarningAcknowledged(false);
    setRegistrationOptions(null);
    setNote(null);
    setPhase("idle");
  }, [fetcher.state, fetcher.data]);

  // Runs the "prove yourself" assertion once fresh, single-use options for
  // it have actually landed — minted on demand, right when Confirm is
  // pressed, rather than carried from page load (this file's own header,
  // finding 5).
  useEffect(() => {
    if (phase !== "mintingOptions" || optionsFetcher.state !== "idle" || optionsFetcher.data === undefined) {
      return;
    }
    if (confirmCeremonyStarted.current) return;
    confirmCeremonyStarted.current = true;

    const minted = optionsFetcher.data;
    if (!minted.ok || minted.intent !== "enrolOptions") {
      confirmCeremonyStarted.current = false;
      setPhase("idle");
      setNote("Could not start a confirmation. Press Confirm to try again.");
      return;
    }

    setPhase("confirming");
    void (async () => {
      const outcome = await requestAssertion(minted.options);
      confirmCeremonyStarted.current = false;

      if (outcome.status === "ok") {
        const body: Record<string, string> = {
          intent: "beginEnrolment",
          label,
          assertion: JSON.stringify(outcome.response),
        };
        void fetcher.submit(body, { method: "post" });
        return;
      }

      setPhase("idle");
      setNote(
        outcome.status === "dismissed"
          ? "That confirmation did not complete. Nothing has changed — press Confirm to try again."
          : outcome.message,
      );
    })();
  }, [phase, optionsFetcher.state, optionsFetcher.data, label, fetcher]);

  function handleConfirmIdentity() {
    setNote(null);
    confirmCeremonyStarted.current = false;
    setPhase("mintingOptions");
    void optionsFetcher.submit({ intent: "enrolOptions" }, { method: "post" });
  }

  // Runs `requestRegistration` directly off this press's own gesture — no
  // `await` ahead of it — for both the first passkey and every later one:
  // `registrationOptions` already carries a fresh challenge either way, from
  // whichever submission most recently landed on "readyToCreate".
  function handleCreatePasskey() {
    if (registrationOptions === null) return;
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

    // Neither ever reached the server, so nothing was spent: staying ready
    // to create lets a retry reuse the very same registration challenge
    // rather than reconfirming identity from scratch.
    setPhase("readyToCreate");
    setNote(
      outcome.status === "dismissed"
        ? "That passkey creation did not complete. Nothing has changed — press Create passkey to try again."
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
  // Once options for the actual creation are in hand, the create button
  // stays up through every phase that ceremony passes through — never
  // falling back to the confirm-step's button underneath its own prompt
  // (finding 13's render-flicker), which a check keyed on `phase` alone used
  // to do the moment `handleCreatePasskey` set it back to `"busy"`.
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
          <label className="choice">
            <input
              type="checkbox"
              checked={warningAcknowledged}
              onChange={(event) => setWarningAcknowledged(event.target.checked)}
            />
            <strong>
              Enrolling this passkey locks every other browser in the household immediately —
              each one will need its own passkey, or a cross-device unlock approved from one
              already enrolled, to see anything here again. This browser stays unlocked.
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
          <button type="button" className="button" onClick={handleCreatePasskey} disabled={busy}>
            Create the passkey named "{confirmedLabel}"
          </button>
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
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The list, and removing one
// ---------------------------------------------------------------------------

function PasskeyRow({
  passkey,
  warningKind,
  supported,
}: {
  passkey: Passkey;
  warningKind: RemovalWarningKind;
  supported: boolean | null;
}) {
  const fetcher = useFetcher<ActionData>();
  const optionsFetcher = useFetcher<ActionData>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [awaitingCeremony, setAwaitingCeremony] = useState(false);
  // Guards the ceremony effect below against firing twice for one press —
  // the same shape `unlock.tsx`'s own `ceremonyStarted` ref guards.
  const ceremonyStarted = useRef(false);
  const busy = fetcher.state !== "idle" || optionsFetcher.state !== "idle" || awaitingCeremony;

  useEffect(() => {
    if (fetcher.state !== "idle" || fetcher.data === undefined) return;
    if (fetcher.data.intent !== "remove") return;
    setNote(fetcher.data.ok ? null : fetcher.data.formError);
  }, [fetcher.state, fetcher.data]);

  // Runs the removal's own assertion once fresh, single-use options scoped
  // to *this* passkey have actually landed — minted on demand, right when
  // Remove is pressed, rather than once per row on every load (this file's
  // own header, finding 5).
  useEffect(() => {
    if (!awaitingCeremony || optionsFetcher.state !== "idle" || optionsFetcher.data === undefined) return;
    if (ceremonyStarted.current) return;
    ceremonyStarted.current = true;

    const minted = optionsFetcher.data;
    if (!minted.ok || minted.intent !== "removalOptions") {
      ceremonyStarted.current = false;
      setAwaitingCeremony(false);
      setNote("Could not start this confirmation. Press Remove to try again.");
      return;
    }

    void (async () => {
      const outcome = await requestAssertion(minted.options);
      ceremonyStarted.current = false;
      setAwaitingCeremony(false);

      if (outcome.status !== "ok") {
        setNote(
          outcome.status === "dismissed"
            ? "That confirmation did not complete. Nothing has changed — press Remove to try again."
            : outcome.message,
        );
        return;
      }

      const body: Record<string, string> = {
        intent: "remove",
        credentialId: passkey.credentialId,
        assertion: JSON.stringify(outcome.response),
        confirmRemoval: "true",
      };
      void fetcher.submit(body, { method: "post" });
    })();
  }, [awaitingCeremony, optionsFetcher.state, optionsFetcher.data, passkey.credentialId, fetcher]);

  function handleRemove() {
    setNote(null);

    if (!acknowledged) {
      // No ceremony for a submission the domain module refuses on its own
      // say-so — its own "tick first" message is what should print, not a
      // passkey prompt for nothing (`removePasskey` checks the
      // acknowledgement before it ever looks for an assertion).
      void fetcher.submit({ intent: "remove", credentialId: passkey.credentialId }, { method: "post" });
      return;
    }

    ceremonyStarted.current = false;
    setAwaitingCeremony(true);
    void optionsFetcher.submit(
      { intent: "removalOptions", credentialId: passkey.credentialId },
      { method: "post" },
    );
  }

  return (
    <li>
      <div className="record">
        <div>
          <p>
            <strong>{passkey.label}</strong>
          </p>
          <p className="record-note">
            Enrolled <span className="u-data">{enrolledText(passkey.enrolledAt)}</span> · Last used{" "}
            <span className="u-data">{lastUsedText(passkey.lastUsedAt)}</span>
            {" · "}
            {syncLabel(passkey.backupEligible)}
          </p>
        </div>

        <div className="record-actions">
          <label className="choice">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            {removalWarningText(warningKind, passkey.label)}
          </label>

          <button
            type="button"
            className="button button--danger"
            onClick={handleRemove}
            disabled={busy || supported === false}
            aria-label={`Remove ${passkey.label}`}
          >
            Remove
          </button>
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
  const { passkeys, hasPasskeys, ownPasskeyId } = loaderData;

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

      <EnrolPanel hasPasskeys={hasPasskeys} supported={supported} />
    </>
  );
}
