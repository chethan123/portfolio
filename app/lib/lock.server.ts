/**
 * Every lock rule — unlocking, enrolling, removing, and the grant recording one browser's unlock.
 * The only module importing `@simplewebauthn/server`. docs/adr/0012
 *
 * Challenges live in a module-level `Map`, so a restart loses every outstanding one. Reading a
 * challenge spends it whether or not what follows verifies: a retry must re-fetch options first.
 *
 * A verified assertion is not proof of a fresh prompt — an already-unlocked vault can answer
 * without one, and WebAuthn carries no freshness signal (ADR-0012).
 */
import { randomBytes, randomFillSync } from "node:crypto";

import { sql, type Kysely, type Selectable } from "kysely";
import { z } from "zod";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from "@simplewebauthn/server";

import { getConfig } from "../../server/config.ts";
import { readCookie } from "./cookies.ts";
import { getDb, type Database } from "./db.server.ts";
import { NotFoundError, ValidationError, parseInput, requiredText } from "./input.server.ts";
import { CHALLENGE_TTL_MS, IDLE_WINDOW_MS, LABEL_MAX_LENGTH, joinTransports, splitTransports } from "./lock.ts";

const RP_NAME = "Portfolio Tracker";

export type Passkey = {
  credentialId: string;
  label: string;
  backupEligible: boolean;
  enrolledAt: Date;
  lastUsedAt: Date | null;
};

export type UnlockGrant = {
  id: string;
  passkeyId: string;
  expiresAt: Date;
};

/**
 * Both derived from `PUBLIC_ORIGIN` (ADR-0012): the relying-party id is its bare hostname. Never a
 * parameter, so no route can supply a different expectation than this instance's configured origin.
 */
type RelyingPartyExpectation = { origin: string; rpID: string };

function expectedRelyingParty(): RelyingPartyExpectation {
  const origin = getConfig().PUBLIC_ORIGIN;
  return { origin, rpID: new URL(origin).hostname };
}

/** Holding a passkey is the whole of "locked" (ADR-0012). Throws rather than failing open. */
export async function isLocked(db: Kysely<Database> = getDb()): Promise<boolean> {
  const row = await db
    .selectNoFrom((eb) => eb.exists(eb.selectFrom("passkey").select("passkey.credential_id").limit(1)).as("locked"))
    .executeTakeFirstOrThrow();
  return Boolean(row.locked);
}

export async function listPasskeys(db: Kysely<Database> = getDb()): Promise<Passkey[]> {
  const rows = await db
    .selectFrom("passkey")
    .select(["credential_id", "label", "backup_eligible", "enrolled_at", "last_used_at"])
    .orderBy("enrolled_at")
    .orderBy("credential_id")
    .execute();

  return rows.map((row) => ({
    credentialId: row.credential_id,
    label: row.label,
    backupEligible: row.backup_eligible,
    enrolledAt: row.enrolled_at,
    lastUsedAt: row.last_used_at,
  }));
}

/**
 * Carries an opaque grant id with no claim of its own, so `__Host-` and `Secure` cost nothing here.
 * Chromium accepts the prefix over `http://localhost` and `http://127.0.0.1`; Firefox untested.
 */
export const LOCK_COOKIE = "__Host-unlock_grant";

/**
 * No `Max-Age`: the row is the authority on lifetime, rolled by {@link touchGrant}, so a fixed
 * cookie expiry would re-lock a family member mid-read. `Lax`, never `Strict` — the gate's weekly
 * sign-in bounce returns as a cross-site navigation and `Strict` would withhold this on it.
 */
export function lockCookie(grantId: string): string {
  return `${LOCK_COOKIE}=${grantId}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

/** Same attributes, or the browser drops the clear: a `__Host-` cookie needs them on every `Set-Cookie`. */
export function clearedLockCookie(): string {
  return `${LOCK_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readLockCookie(request: Request): string | undefined {
  return readCookie(request, LOCK_COOKIE);
}

type UnlockGrantRow = Pick<Selectable<Database["unlock_grant"]>, "id" | "passkey_id" | "expires_at">;

function toGrant(row: UnlockGrantRow): UnlockGrant {
  return { id: row.id, passkeyId: row.passkey_id, expiresAt: row.expires_at };
}

function randomGrantId(): string {
  return randomBytes(32).toString("base64url");
}

const PASSKEY_REMOVED_MID_VERIFICATION_MESSAGE =
  "This passkey was removed while this confirmation was being checked. Start again.";

function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  if (!(error instanceof Error)) return false;
  const { code, constraint: violated } = error as { code?: unknown; constraint?: unknown };
  return code === "23503" && violated === constraint;
}

/**
 * Module-private: no export hands out a grant without a verified ceremony behind it. Sweeps expired
 * rows on the way, the moment this table is guaranteed to be looked at.
 *
 * `supersedes` is the row this browser trades in, and must come from its own `LOCK_COOKIE` — never
 * a form field. Nothing here can confirm the id belongs to the caller; `HttpOnly` and `SameSite=Lax`
 * are what stop a page aiming it elsewhere. Deleted before the insert: a failure between the two
 * leaves no live grant rather than two.
 *
 * The passkey can be removed between the caller's read and this insert, so the foreign key is left
 * to find out — caught here as a refusal rather than a raw violation.
 */
async function mintGrant(
  passkeyId: string,
  db: Kysely<Database> = getDb(),
  supersedes?: string,
): Promise<UnlockGrant> {
  const now = new Date();
  await db.deleteFrom("unlock_grant").where("expires_at", "<=", now).execute();

  if (supersedes !== undefined) {
    await db.deleteFrom("unlock_grant").where("id", "=", supersedes).execute();
  }

  let row: UnlockGrantRow;
  try {
    row = await guardedAgainstConstraintViolation(db, () =>
      db
        .insertInto("unlock_grant")
        .values({
          id: randomGrantId(),
          passkey_id: passkeyId,
          expires_at: new Date(now.getTime() + IDLE_WINDOW_MS),
        })
        .returning(["id", "passkey_id", "expires_at"])
        .executeTakeFirstOrThrow(),
    );
  } catch (cause) {
    if (isForeignKeyViolation(cause, "unlock_grant_passkey_id_fkey")) {
      throw ValidationError.form(PASSKEY_REMOVED_MID_VERIFICATION_MESSAGE);
    }
    throw cause;
  }

  return toGrant(row);
}

/** Nothing for an unknown id and nothing for an expired one, without the caller reading the clock. */
export async function readGrant(
  id: string,
  db: Kysely<Database> = getDb(),
): Promise<UnlockGrant | undefined> {
  const row = await db
    .selectFrom("unlock_grant")
    .select(["id", "passkey_id", "expires_at"])
    .where("id", "=", id)
    .where("expires_at", ">", new Date())
    .executeTakeFirst();

  return row === undefined ? undefined : toGrant(row);
}

/**
 * Live-check and expiry roll in one statement: as two round trips, a grant deleted in the gap
 * (a "Lock now", a cascading removal) is indistinguishable from one merely not due for a refresh.
 * `for update` is what closes it — a plain `select`'s snapshot would still report a row as live
 * while a concurrent delete was in flight. The `UPDATE` stays conditional on half the window.
 */
export async function touchGrant(
  id: string,
  db: Kysely<Database> = getDb(),
): Promise<UnlockGrant | undefined> {
  const now = new Date();
  const halfWindowFromNow = new Date(now.getTime() + IDLE_WINDOW_MS / 2);
  const freshExpiry = new Date(now.getTime() + IDLE_WINDOW_MS);

  const result = await sql<UnlockGrantRow>`
    with live as (
      select id, passkey_id, expires_at
      from unlock_grant
      where id = ${id} and expires_at > ${now}
      for update
    ),
    rolled as (
      update unlock_grant
      set expires_at = ${freshExpiry}
      where id = (select id from live where expires_at <= ${halfWindowFromNow})
      returning id, passkey_id, expires_at
    )
    select
      coalesce(rolled.id, live.id) as id,
      coalesce(rolled.passkey_id, live.passkey_id) as passkey_id,
      coalesce(rolled.expires_at, live.expires_at) as expires_at
    from live
    left join rolled on rolled.id = live.id
  `.execute(db);

  const row = result.rows[0];
  return row === undefined ? undefined : toGrant(row);
}

export async function deleteGrant(id: string, db: Kysely<Database> = getDb()): Promise<void> {
  await db.deleteFrom("unlock_grant").where("id", "=", id).execute();
}

/** Kept distinct so a challenge minted for one action can never satisfy another. */
type ChallengePurpose =
  | { kind: "unlock" }
  | { kind: "enrol" }
  | { kind: "remove"; credentialId: string }
  | { kind: "register"; label: string; bootstrap: boolean };

type AssertionScope = { kind: "unlock" } | { kind: "enrol" } | { kind: "remove"; credentialId: string };

type ChallengeKind = ChallengePurpose["kind"];

const CHALLENGE_KINDS: readonly ChallengeKind[] = ["unlock", "enrol", "remove", "register"];

/**
 * Budget per {@link ChallengeKind}, never shared: `unlock` is the only kind a browser holding no
 * grant can mint, and a shared budget let a flood of those evict the recovery kinds behind the lock.
 * Bounds memory, not availability — a flood still denies its own kind. Exported for `tests/lock.test.ts`.
 */
export const MAX_LIVE_CHALLENGES_PER_PURPOSE = 500;

type ChallengeEntry = { purpose: ChallengePurpose; expiresAt: number; spent: boolean };

/** Spent rather than deleted on read, so a replay is still distinguishable from "never issued". */
const challenges = new Map<string, ChallengeEntry>();

function isUsable(entry: ChallengeEntry, now: number): boolean {
  return !entry.spent && entry.expiresAt > now;
}

/**
 * Two budgets per kind, live and dead. Counting dead entries against the live budget let a
 * spend-and-retry flood evict a confirmation somebody was mid-way through; not counting them at all
 * bounded nothing. `Map` insertion order makes the first match the oldest.
 */
function evictOldestOfKind(kind: ChallengeKind, now: number): void {
  for (const usable of [true, false]) {
    let held = 0;
    for (const entry of challenges.values()) {
      if (entry.purpose.kind === kind && isUsable(entry, now) === usable) held++;
    }

    while (held > MAX_LIVE_CHALLENGES_PER_PURPOSE) {
      let oldest: string | undefined;
      for (const [text, entry] of challenges) {
        if (entry.purpose.kind === kind && isUsable(entry, now) === usable) {
          oldest = text;
          break;
        }
      }
      if (oldest === undefined) break;
      challenges.delete(oldest);
      held--;
    }
  }
}

function sweepChallenges(now: number): void {
  // A whole TTL *past* expiry: dropping on the instant makes "has expired" unreachable, and the
  // same submission would then read as "never issued".
  for (const [text, entry] of challenges) {
    if (entry.expiresAt + CHALLENGE_TTL_MS <= now) challenges.delete(text);
  }

  for (const kind of CHALLENGE_KINDS) {
    evictOldestOfKind(kind, now);
  }
}

function mintChallenge(purpose: ChallengePurpose): { text: string; bytes: Uint8Array<ArrayBuffer> } {
  const now = Date.now();
  sweepChallenges(now);

  // Not `Buffer`: the library's option types want `Uint8Array<ArrayBuffer>` exactly.
  const bytes = new Uint8Array(32);
  randomFillSync(bytes);
  // Bytes in, library's own encoder for the key: a `string` challenge is re-encoded as UTF-8 first,
  // so the browser would receive a different value than the one keying this map.
  const text = isoBase64URL.fromBuffer(bytes);

  challenges.set(text, { purpose, expiresAt: now + CHALLENGE_TTL_MS, spent: false });
  return { text, bytes };
}

/** Expiry before spent-ness: an entry that is both is expired, not a replay. */
function takeChallenge(text: string): ChallengePurpose {
  const entry = challenges.get(text);
  if (entry === undefined) {
    throw ValidationError.form("This one-time confirmation was never issued by this instance. Start again.");
  }
  if (entry.expiresAt <= Date.now()) {
    throw ValidationError.form("This one-time confirmation has expired. Start again.");
  }
  if (entry.spent) {
    throw ValidationError.form("This one-time confirmation has already been used. Start again.");
  }

  entry.spent = true;
  return entry.purpose;
}

function scopeMatches(purpose: ChallengePurpose, expected: AssertionScope): boolean {
  if (purpose.kind !== expected.kind) return false;
  if (purpose.kind === "remove" && expected.kind === "remove") {
    return purpose.credentialId === expected.credentialId;
  }
  return true;
}

const clientDataSchema = z.object({ challenge: z.string() });

/** From the signed client data, never re-derived from `id`. */
function decodeChallenge(clientDataJSON: string): string {
  let parsed: unknown;
  try {
    const bytes = isoBase64URL.toBuffer(clientDataJSON);
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw ValidationError.form("This response's client data could not be read.");
  }

  const clientData = clientDataSchema.safeParse(parsed);
  if (!clientData.success) {
    throw ValidationError.form("This response's client data did not carry a challenge.");
  }
  return clientData.data.challenge;
}

/**
 * Only the fields this module itself dereferences; the rest is the library's own schema to state.
 * A response arrives as client JSON, so without this `{}` becomes a `TypeError` and a 500 rather
 * than a refusal.
 */
const webAuthnResponseShape = z.object({
  id: z.string().min(1),
  response: z.object({ clientDataJSON: z.string().min(1) }),
});

const UNREADABLE_RESPONSE_MESSAGE = "This passkey response could not be read.";

/**
 * `verifyRegistrationResponse` copies `transports` verbatim and checks nothing, so this is the only
 * guard before the column. The vocabulary is deliberately not enforced (migration 0012) — an unknown
 * transport is still worth keeping — but the count is, or one registration poisons every
 * `allowCredentials` this app hands out.
 */
const MAX_REPORTED_TRANSPORTS = 8;

const registrationResponseShape = webAuthnResponseShape.extend({
  response: webAuthnResponseShape.shape.response.extend({
    transports: z
      .array(z.string().min(1).max(32).refine((one) => !one.includes(",")))
      .max(MAX_REPORTED_TRANSPORTS)
      .optional(),
  }),
});

const REGISTRATION_TRANSPORTS_MESSAGE =
  "This passkey listed how it can be reached in a form this app cannot store. Try enrolling it again.";

/** Returns the original value, not the parsed one: fields this schema does not name must reach the verifier untouched. */
function narrowAssertion(value: unknown): AuthenticationResponseJSON {
  if (!webAuthnResponseShape.safeParse(value).success) {
    throw ValidationError.form(UNREADABLE_RESPONSE_MESSAGE);
  }
  return value as AuthenticationResponseJSON;
}

/** Checked in schema order, so the second failure can only be `transports` and gets its own sentence. */
function narrowRegistration(value: unknown): RegistrationResponseJSON {
  if (!webAuthnResponseShape.safeParse(value).success) {
    throw ValidationError.form(UNREADABLE_RESPONSE_MESSAGE);
  }
  if (!registrationResponseShape.safeParse(value).success) {
    throw ValidationError.form(REGISTRATION_TRANSPORTS_MESSAGE);
  }
  return value as RegistrationResponseJSON;
}

async function allowCredentialList(
  db: Kysely<Database>,
): Promise<{ id: string; transports?: string[] }[]> {
  const rows = await db.selectFrom("passkey").select(["credential_id", "transports"]).execute();
  return rows.map((row) => ({ id: row.credential_id, transports: splitTransports(row.transports) }));
}

/**
 * Narrower than the library's declared return by exactly `extensions`, which this module never
 * passes: react-router's wire-type serialisation rewrites the `BufferSource` nested inside it, so
 * every consumer would otherwise need an assertion of its own.
 */
type UnlockOptions = PublicKeyCredentialRequestOptionsJSON & { extensions?: undefined };

async function authenticationOptionsFor(
  purpose: ChallengePurpose & AssertionScope,
  db: Kysely<Database>,
  expected: RelyingPartyExpectation,
): Promise<UnlockOptions> {
  // Every credential id goes to a browser that has not unlocked: accepted, since the gate already
  // admitted a family member (ADR-0012). `allowCredentials` is also what carries the transports.
  const allowCredentials = await allowCredentialList(db);
  const { bytes } = mintChallenge(purpose);

  const options = await generateAuthenticationOptions({
    rpID: expected.rpID,
    userVerification: "required",
    challenge: bytes,
    allowCredentials,
  });

  return options as UnlockOptions;
}

export async function unlockOptions(db: Kysely<Database> = getDb()): Promise<UnlockOptions> {
  return authenticationOptionsFor({ kind: "unlock" }, db, expectedRelyingParty());
}

export async function enrolmentAssertionOptions(
  db: Kysely<Database> = getDb(),
): Promise<UnlockOptions> {
  return authenticationOptionsFor({ kind: "enrol" }, db, expectedRelyingParty());
}

export async function removalAssertionOptions(
  credentialId: string,
  db: Kysely<Database> = getDb(),
): Promise<UnlockOptions> {
  return authenticationOptionsFor({ kind: "remove", credentialId }, db, expectedRelyingParty());
}

/**
 * Matched on the library's own message prefix (@simplewebauthn/server 14.0.0, pinned) rather than
 * `instanceof Error`, which every other thrown verification failure also satisfies. Judged before
 * the signature is checked, so a forged response with a low counter lands here too — which is why
 * the message says the counter went backwards, never that the passkey was copied.
 */
function isCounterRegression(cause: unknown): boolean {
  return cause instanceof Error && cause.message.startsWith("Response counter value");
}

const COUNTER_WENT_BACKWARDS_MESSAGE =
  "This passkey's counter went backwards, which can mean a copy of it exists somewhere. " +
  "The check was refused. Remove this passkey from Settings → Passkeys and enrol it again.";

/**
 * Refuses a challenge never issued, spent, expired, or minted for a different action or target,
 * each with its own message. The library owns the signature-counter comparison; a regression is
 * surfaced as a refusal, not restated here.
 *
 * Nothing is written before `verified.verified`. The counter only moves forward (`greatest`, one
 * statement) and `last_used_at` is written regardless. The passkey can be removed between the read
 * and the mint: {@link mintGrant}'s insert is what discovers that, not a re-check here.
 */
async function verifyScopedAssertion(
  response: AuthenticationResponseJSON,
  expected: AssertionScope,
  db: Kysely<Database>,
  supersedes?: string,
): Promise<UnlockGrant> {
  const rp = expectedRelyingParty();
  const challengeText = decodeChallenge(response.response.clientDataJSON);
  const purpose = takeChallenge(challengeText);

  if (!scopeMatches(purpose, expected)) {
    throw ValidationError.form(
      "This one-time confirmation was not issued for this action. Start again from the screen that asked for it.",
    );
  }

  const passkeyRow = await db
    .selectFrom("passkey")
    .select(["credential_id", "public_key", "counter", "transports"])
    .where("credential_id", "=", response.id)
    .executeTakeFirst();
  if (passkeyRow === undefined) {
    throw ValidationError.form("This passkey is not enrolled on this instance.");
  }

  const credential: WebAuthnCredential = {
    id: passkeyRow.credential_id,
    publicKey: new Uint8Array(passkeyRow.public_key),
    // 32-bit unsigned by spec, bounded again by the column's check: `Number()` cannot lose it.
    counter: Number(passkeyRow.counter),
    transports: splitTransports(passkeyRow.transports),
  };

  let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challengeText,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      credential,
    });
  } catch (cause) {
    console.error(`Passkey assertion (${expected.kind}) failed to verify:`, cause);
    if (isCounterRegression(cause)) throw ValidationError.form(COUNTER_WENT_BACKWARDS_MESSAGE);
    throw ValidationError.form("This passkey could not be verified. Try again.");
  }

  if (!verified.verified) {
    console.error(`Passkey assertion (${expected.kind}) reported unverified with no thrown cause.`);
    throw ValidationError.form("This passkey could not be verified. Try again.");
  }

  await db
    .updateTable("passkey")
    .set({
      counter: sql`greatest(passkey.counter, ${verified.authenticationInfo.newCounter})`,
      last_used_at: new Date(),
    })
    .where("credential_id", "=", passkeyRow.credential_id)
    .execute();

  // The one case a prior grant is kept: a removal signed by its own target cascades the grant minted
  // below away with the passkey, so superseding as well would leave this browser holding nothing.
  const signerIsRemovalTarget =
    expected.kind === "remove" && expected.credentialId === passkeyRow.credential_id;

  return mintGrant(passkeyRow.credential_id, db, signerIsRemovalTarget ? undefined : supersedes);
}

/** `supersedes` is this request's own cookie: verifying replaces a stale grant rather than adding a second. */
export async function verifyUnlock(
  response: unknown,
  db: Kysely<Database> = getDb(),
  supersedes?: string,
): Promise<UnlockGrant> {
  return verifyScopedAssertion(narrowAssertion(response), { kind: "unlock" }, db, supersedes);
}

// ---------------------------------------------------------------------------
// Enrolling
// ---------------------------------------------------------------------------

/**
 * A `PublicKeyCredentialCreationOptionsJSON` this module actually hands
 * out — narrower than the library's own declared return type by exactly one
 * property, the registration twin of {@link UnlockOptions} above and for
 * the identical reason: {@link registrationOptionsFor} never passes
 * `extensions` to `generateRegistrationOptions`, so the value it returns
 * never carries that key at all. Fixed here, once, at the one place the
 * value is produced — the same move that type makes for the assertion
 * options — so that Settings → Passkeys (the one route that hands this to a
 * browser) derives its own type from {@link beginEnrolment}'s return rather
 * than importing `@simplewebauthn/server` a second time for a type this
 * module already narrows correctly.
 */
export type RegistrationOptions = PublicKeyCredentialCreationOptionsJSON & { extensions?: undefined };

async function registrationOptionsFor(
  label: string,
  bootstrap: boolean,
  db: Kysely<Database>,
  expected: RelyingPartyExpectation,
): Promise<RegistrationOptions> {
  const excludeCredentials = await allowCredentialList(db);
  const { bytes } = mintChallenge({ kind: "register", label, bootstrap });

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: expected.rpID,
    // The name is the label the person typed, so their password manager
    // shows something they recognise; the id is left to the library, which
    // mints a fresh one per enrolment (spec 0019) — a shared id would let an
    // authenticator treat a second enrolment as replacing the first, and
    // this household wants several to coexist. Neither id nor name is
    // stored (migration 0012's comment on `user_handle`).
    userName: label,
    userDisplayName: label,
    challenge: bytes,
    attestationType: "none",
    authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
    // Already-enrolled credential ids excluded, so one authenticator cannot
    // silently hold two credentials for this instance. The consequence: a
    // provider that recognises any of them refuses creation client-side, so
    // a second passkey *from the same provider* is not supported — several
    // across different devices and providers is what this household needs.
    excludeCredentials,
  });

  // The one assertion {@link RegistrationOptions}'s own header promises:
  // nothing above ever sets `extensions`, so the library's wider declared
  // return type is honestly narrower here, in the one value this function
  // actually produces.
  return options as RegistrationOptions;
}

/**
 * The characters a label may not carry, and the ones it deliberately may.
 *
 * Refused: `\p{Cc}` (C0 and C1, which is where a NUL or a newline lives);
 * U+2028 and U+2029, the line and paragraph separators — the message below
 * promises no line break, and those are line breaks; the bidirectional
 * overrides and isolates U+202A–U+202E and U+2066–U+2069, which can make a
 * row in Settings read back to front, so somebody removes the wrong passkey;
 * and U+200B, the zero width space, which makes a label that looks blank or
 * looks identical to another one.
 *
 * Allowed on purpose: U+200D, the zero width joiner, and the variation
 * selectors. Emoji sequences are built out of them, and a household that
 * labels a passkey with one is doing nothing wrong — refusing them to catch
 * an invisible character would cost more than it buys.
 *
 * This reads the *trimmed* value, because {@link requiredText} trims first.
 * So a separator or a newline at either edge is removed rather than refused,
 * exactly as a stray space is and exactly as an account or person name
 * already behaves — what reaches the column is clean either way. Only the
 * ones a trim cannot reach, which is all of them in the middle and the
 * invisibles at any position, come back as a refusal.
 */
const REFUSED_LABEL_CHARACTERS = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\u200B]/u;

/**
 * A label, bounded and trimmed by {@link requiredText} — plus what that
 * shared helper does not itself refuse. A control character (a NUL byte
 * among them) or a newline stored in this column is rendered verbatim in
 * Settings, and a lone surrogate is a value `JSON.stringify`'s own escaping
 * cannot make round-trip; either one reaches here only after the browser has
 * *already* created a real credential in the family member's own password
 * manager (this function refuses before that, {@link completeRegistration}'s
 * insert refuses only after), which is exactly why the refusal belongs at
 * this end of the ceremony and not the other.
 */
const NO_CONTROL_CHARACTERS_MESSAGE =
  "A label cannot carry a line break, an invisible character, or another control character.";
const NOT_WELL_FORMED_MESSAGE = "A label cannot carry an incomplete character.";

const labelInput = z.object({
  label: requiredText("A label", LABEL_MAX_LENGTH)
    .refine((value) => !REFUSED_LABEL_CHARACTERS.test(value), { message: NO_CONTROL_CHARACTERS_MESSAGE })
    .refine((value) => value.isWellFormed(), { message: NOT_WELL_FORMED_MESSAGE }),
});

/**
 * What {@link beginEnrolment} refuses the household's first passkey with when
 * `acknowledgement` is not the literal `"true"` — ticket 05's own rule that
 * the warning shown before that enrolment "is a statement the person must
 * pass", enforced here rather than left to a client-side `disabled` attribute
 * a direct POST can simply skip. This is not a second authorisation path for
 * the *write* — the bootstrap case still needs no assertion, exactly as
 * spec 0019 says, because there is still nothing to authorise against — it is
 * the same kind of courtesy gate {@link removePasskey}'s own `confirmRemoval`
 * already is: a plain "was this actually shown" check, never a credential.
 */
const FIRST_PASSKEY_NOT_ACKNOWLEDGED_MESSAGE =
  "Enrolling the household's first passkey locks every other browser immediately — tick " +
  "that acknowledgement first.";

/**
 * Begin enrolling a passkey: the very first, with nothing to prove, or
 * another, authorised by a fresh assertion from one already enrolled.
 *
 * A request may enrol with no assertion only while the household holds
 * none — the moment there is nothing to authorise against, because anyone
 * the gate admitted already sees every figure. That check is a courtesy
 * here, not the whole security boundary: the *committed* half is closed by
 * {@link completeRegistration}'s conditional insert, and the *concurrent*
 * half by migration 0012's `passkey_bootstrap_idx` — neither is enough
 * alone, and that migration's comment on the index is explicit about why,
 * and about the one interleaving the pair still leaves open.
 * That same bootstrap case also requires `acknowledgement` to be exactly
 * `"true"` — see {@link FIRST_PASSKEY_NOT_ACKNOWLEDGED_MESSAGE}. Ignored once
 * the household holds a passkey: the warning this guards is shown only for
 * the first one, and enrolling a second changes nothing for anybody.
 *
 * Every later enrolment needs `assertion`, verified as scoped to `"enrol"`
 * — which also mints a grant, the same as any verified assertion, and
 * supersedes the one `input.supersedes` names, so the browser confirming an
 * enrolment ends with one live grant rather than two ({@link mintGrant}).
 * `supersedes` is the request's own cookie and never a form field. The
 * registration challenge returned here carries `label`, and is accepted by
 * {@link completeRegistration} only against it.
 */
export async function beginEnrolment(
  label: string,
  input: { assertion: unknown; acknowledgement?: string; supersedes?: string },
  db: Kysely<Database> = getDb(),
): Promise<{ options: RegistrationOptions; grant: UnlockGrant | undefined }> {
  const { assertion, acknowledgement, supersedes } = input;
  const { label: validLabel } = parseInput(labelInput, { label });

  const locked = await isLocked(db);
  let grant: UnlockGrant | undefined;

  if (locked) {
    if (assertion === undefined) {
      throw ValidationError.form(
        "Enrolling another passkey needs a fresh confirmation from one already enrolled — " +
          "being unlocked on this browser is not enough on its own.",
      );
    }
    grant = await verifyScopedAssertion(narrowAssertion(assertion), { kind: "enrol" }, db, supersedes);
  } else if (acknowledgement !== "true") {
    throw ValidationError.form(FIRST_PASSKEY_NOT_ACKNOWLEDGED_MESSAGE);
  }

  const options = await registrationOptionsFor(validLabel, /* bootstrap */ !locked, db, expectedRelyingParty());
  return { options, grant };
}

/**
 * A row this module just wrote or found, as {@link Passkey} needs it printed
 * — derived from the generated schema (`Database["passkey"]`) via Kysely's
 * `Selectable` rather than hand-copied, so a schema change or a driver
 * type-parser change surfaces here at `typecheck` instead of leaving
 * `sql<PasskeyRow>` below asserting a shape the columns no longer have.
 */
type PasskeyRow = Pick<
  Selectable<Database["passkey"]>,
  "credential_id" | "label" | "backup_eligible" | "enrolled_at" | "last_used_at"
>;

function toPasskey(row: PasskeyRow): Passkey {
  return {
    credentialId: row.credential_id,
    label: row.label,
    backupEligible: row.backup_eligible,
    enrolledAt: row.enrolled_at,
    lastUsedAt: row.last_used_at,
  };
}

/** Which unique index a duplicate-key violation hit, or `undefined` for anything else. */
function uniqueViolationConstraint(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === "23505" && typeof constraint === "string" ? constraint : undefined;
}

/**
 * Run `body`'s one statement guarded by a SQL savepoint when `db` is already
 * inside a transaction — which is exactly what `withDatabase` hands every
 * test, and the point is that a *caught* constraint violation (a duplicate
 * key, in `completeRegistration`; a foreign key gone missing out from under
 * `mintGrant`) must not leave that whole transaction aborted for whatever
 * the caller runs next. Outside a transaction — `getDb()`'s ordinary,
 * autocommitting process-wide handle, what every real request uses — each
 * statement is already its own implicit transaction, so this does nothing
 * at all.
 */
async function guardedAgainstConstraintViolation<T>(
  db: Kysely<Database>,
  body: () => Promise<T>,
): Promise<T> {
  if (!db.isTransaction) return body();

  const savepoint = `lock_${randomBytes(4).toString("hex")}`;
  await sql`savepoint ${sql.id(savepoint)}`.execute(db);
  try {
    const result = await body();
    await sql`release savepoint ${sql.id(savepoint)}`.execute(db);
    return result;
  } catch (error) {
    await sql`rollback to savepoint ${sql.id(savepoint)}`.execute(db);
    throw error;
  }
}

const BOOTSTRAP_TAKEN_MESSAGE =
  "Another passkey was enrolled the moment this one was, so the household is no longer " +
  "without one. Reload and unlock with it, or add this device from Settings instead.";

const DUPLICATE_PASSKEY_MESSAGE = "This passkey is already enrolled.";

/**
 * The WebAuthn specification's ceiling on a credential id, in decoded bytes.
 * Checked against the library's *output* rather than the client's `id`,
 * because those are two different values and only one of them is stored —
 * see the comment beside the check in {@link completeRegistration}.
 */
const MAX_CREDENTIAL_ID_BYTES = 1023;

const CREDENTIAL_ID_LENGTH_MESSAGE =
  "This passkey gave itself an identifier of a length this app cannot store. Try enrolling it again.";

const CREDENTIAL_ID_MISMATCH_MESSAGE =
  "This passkey named itself two different things in one answer, so it was not enrolled.";

/**
 * Complete a registration begun by {@link beginEnrolment} — accepted only
 * against the single-use `"register"` challenge that call minted, never
 * against whatever challenge a stale or forged form happens to carry.
 *
 * The bootstrap half (no prior passkey) writes with `insert ... select ...
 * where not exists (select 1 from passkey)`, refusing when it inserts no
 * row: that closes the case where a passkey is already committed. The
 * partial unique index on `passkey.bootstrap` closes the other half — two
 * such statements each seeing an empty table under READ COMMITTED — and its
 * unique-violation surfaces here as a refusal, never a 500. Neither half is
 * sufficient alone, and the two together still leave one interleaving open:
 * a bootstrap insert racing an *ordinary* one, which was decided to be
 * ordinary by an earlier request that saw the passkey authorising it and
 * carries no predicate of its own. Migration 0012's comment on
 * `passkey_bootstrap_idx` sets out what the pair does and does not
 * guarantee, how narrow that window is, and why neither way of closing it
 * was taken; this is not the place to repeat it.
 *
 * **A duplicate credential id is always a printable refusal, however it
 * arrives.** Both the bootstrap and the non-bootstrap path let the unique
 * constraint on `credential_id` decide rather than preceding the insert
 * with a `select` — the very check-then-act shape the bootstrap comment
 * above warns against — so a concurrent or repeated registration of the
 * same credential id refuses cleanly instead of raising a raw `23505`. The
 * bootstrap path's own partial index can *also* fire concurrently with a
 * colliding credential id; because Postgres inserts the primary-key index
 * entry first, that race is reported as `passkey_pkey`, not
 * `passkey_bootstrap_idx`, so both constraint names are handled here rather
 * than only the one this path's own index owns. Both inserts run through
 * {@link guardedAgainstConstraintViolation}, so a caught violation cannot
 * leave a caller's own transaction — a test's `withDatabase`, today;
 * conceivably a future multi-step route wrapping this call in one —
 * aborted for whatever runs after it.
 *
 * Verifying a bootstrap registration mints a grant — the browser that
 * enrolled the first passkey must not be locked out by its own redirect
 * back. Every other enrolment already carries a verified assertion, which
 * has minted one; minting a second here would leave one request setting two
 * cookies, so it does not. One interleaving still leaves a browser holding
 * nothing, and is worth naming rather than discovering: browser A begins
 * enrolling a second passkey (its assertion verified, a grant minted),
 * browser B removes the household's last passkey — cascading A's grant away
 * with it — and A completes its registration within the challenge's
 * lifetime. This is not the bootstrap case, so no second grant is minted;
 * A now holds zero live grants and is bounced to unlock. That is fine, not
 * a bug to fix: A can unlock with the passkey it just created.
 */
export async function completeRegistration(
  response: unknown,
  db: Kysely<Database> = getDb(),
): Promise<{ passkey: Passkey; grant: UnlockGrant | undefined }> {
  const parsedResponse = narrowRegistration(response);
  const expected = expectedRelyingParty();
  const challengeText = decodeChallenge(parsedResponse.response.clientDataJSON);
  const purpose = takeChallenge(challengeText);
  if (purpose.kind !== "register") {
    throw ValidationError.form(
      "This one-time confirmation was not issued for enrolling a passkey. " +
        "Start again from the screen that asked for it.",
    );
  }

  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verified = await verifyRegistrationResponse({
      response: parsedResponse,
      expectedChallenge: challengeText,
      expectedOrigin: expected.origin,
      expectedRPID: expected.rpID,
    });
  } catch (cause) {
    console.error("Passkey registration failed to verify:", cause);
    throw ValidationError.form("This passkey could not be verified. Try enrolling it again.");
  }
  if (!verified.verified) {
    console.error("Passkey registration reported unverified with no thrown cause.");
    throw ValidationError.form("This passkey could not be verified. Try enrolling it again.");
  }

  const { credential, credentialDeviceType } = verified.registrationInfo;

  // **The library's own output, checked — for the one value it forwards from
  // client-chosen bytes without validating.** `credential.id` is
  // `isoBase64URL.fromBuffer(credentialID)` read straight out of the attested
  // credential data, whose length is whatever the two-byte `credIDLen` field
  // said (`helpers/parseAuthenticatorData.js:34-36`). Nothing bounds it: the
  // response-level checks compare `id` to `rawId` only
  // (`registration/verifyRegistrationResponse.js:38-44`) and never to the
  // attested bytes, and the emptiness guard at `:121` is `!credentialID`,
  // which a zero-length `Uint8Array` passes because it is an object. A stored
  // `""` then rides in every browser's `allowCredentials`, and an over-long
  // one is past the specification's 1023-byte ceiling.
  //
  // **No counter check here, deliberately.** The library reads it with
  // `getUint32` (`helpers/parseAuthenticatorData.js:27`), so it cannot arrive
  // outside the column's own range; the review's `4294967295` case is the
  // maximum that range accepts rather than a value outside it, and what makes
  // that passkey useless afterwards is the specification's own
  // strictly-greater rule, not anything this insert could have refused.
  const credentialIdBytes = isoBase64URL.toBuffer(credential.id);
  if (credentialIdBytes.byteLength < 1 || credentialIdBytes.byteLength > MAX_CREDENTIAL_ID_BYTES) {
    throw ValidationError.form(CREDENTIAL_ID_LENGTH_MESSAGE);
  }
  // Also the check that refuses a *non-canonically encoded* id — padded, or
  // spelled in standard base64 — since `isoBase64URL.fromBuffer` always emits
  // the canonical unpadded form. No browser reaches that: the library already
  // demands `id === rawId` and `@simplewebauthn/browser` derives both from
  // the same bytes through the same encoder. A client that did would meet
  // this message with its challenge already spent, so it has to fetch fresh
  // options before trying again.
  if (credential.id !== parsedResponse.id) {
    throw ValidationError.form(CREDENTIAL_ID_MISMATCH_MESSAGE);
  }

  const publicKey = Buffer.from(credential.publicKey);
  const transports = joinTransports(credential.transports);
  // BE, not BS: eligibility for backup is what "synced" means to a reader
  // (migration 0012's comment on `backup_eligible`), fixed at enrolment.
  const backupEligible = credentialDeviceType === "multiDevice";

  if (purpose.bootstrap) {
    let row: PasskeyRow | undefined;
    try {
      row = await guardedAgainstConstraintViolation(db, async () => {
        const result = await sql<PasskeyRow>`
          insert into passkey (credential_id, public_key, counter, transports, backup_eligible, label, bootstrap)
          select ${credential.id}, ${publicKey}, ${credential.counter}, ${transports}, ${backupEligible}, ${purpose.label}, true
          where not exists (select 1 from passkey)
          returning credential_id, label, backup_eligible, enrolled_at, last_used_at
        `.execute(db);
        return result.rows[0];
      });
    } catch (cause) {
      const constraint = uniqueViolationConstraint(cause);
      if (constraint === "passkey_bootstrap_idx") {
        throw ValidationError.form(BOOTSTRAP_TAKEN_MESSAGE);
      }
      if (constraint === "passkey_pkey") {
        throw ValidationError.form(DUPLICATE_PASSKEY_MESSAGE);
      }
      throw cause;
    }

    if (row === undefined) {
      throw ValidationError.form(BOOTSTRAP_TAKEN_MESSAGE);
    }

    const grant = await mintGrant(row.credential_id, db);
    return { passkey: toPasskey(row), grant };
  }

  let row: PasskeyRow;
  try {
    row = await guardedAgainstConstraintViolation(db, () =>
      db
        .insertInto("passkey")
        .values({
          credential_id: credential.id,
          public_key: publicKey,
          counter: credential.counter,
          transports,
          backup_eligible: backupEligible,
          label: purpose.label,
          bootstrap: false,
        })
        .returning(["credential_id", "label", "backup_eligible", "enrolled_at", "last_used_at"])
        .executeTakeFirstOrThrow(),
    );
  } catch (cause) {
    if (uniqueViolationConstraint(cause) === "passkey_pkey") {
      throw ValidationError.form(DUPLICATE_PASSKEY_MESSAGE);
    }
    throw cause;
  }

  return { passkey: toPasskey(row), grant: undefined };
}

// ---------------------------------------------------------------------------
// Removing
// ---------------------------------------------------------------------------

/**
 * Remove one named passkey — refusing anything but a fresh assertion scoped
 * to removing *this* target, plus its own acknowledgement, the way
 * `closeAccount` requires its confirmation: a destructive write a replayed
 * POST can reach silently was never acknowledged at all.
 *
 * The target is resolved first, before any of the other checks and before
 * the assertion is verified — `closeAccount`'s precedent — so a request
 * naming a passkey that does not exist writes nothing: it mints no grant
 * and stamps no `last_used_at`, rather than spending a fresh assertion on a
 * 404. The acknowledgement and assertion-presence checks come next, still
 * ahead of verification, so a request missing either never spends the
 * single-use challenge it was not going to be allowed to act on anyway.
 *
 * Removing the household's last passkey is allowed to be authorised by that
 * same passkey — the only credential that can, and how the lock is turned
 * off; excluding the target from `allowCredentials` would strand a
 * one-passkey household. Deleting it cascades away its own grants — the
 * just-minted one included, when the target is what authorised this
 * request — through the schema's cascade, which is what locks this browser
 * the moment such a removal succeeds; nothing here needs to special-case it.
 *
 * `input.supersedes` is the request's own cookie, and it is the one place
 * this module declines to supersede: when the signer *is* the target, the
 * grant just minted is about to be cascaded away, so the prior one is left
 * alone rather than deleted beside it — {@link verifyScopedAssertion} makes
 * that call and argues it there.
 */
export async function removePasskey(
  credentialId: string,
  input: { assertion: unknown; confirmRemoval?: string; supersedes?: string },
  db: Kysely<Database> = getDb(),
): Promise<{ grant: UnlockGrant }> {
  const existing = await db
    .selectFrom("passkey")
    .select("credential_id")
    .where("credential_id", "=", credentialId)
    .executeTakeFirst();
  if (existing === undefined) {
    throw new NotFoundError(`No passkey with id ${credentialId}.`);
  }

  if (input.confirmRemoval !== "true") {
    throw ValidationError.form(
      "This passkey stays enrolled — removing one is one-way in this version, " +
        "so it asks for the acknowledgement to be ticked first.",
    );
  }

  if (input.assertion === undefined) {
    throw ValidationError.form(
      "Removing a passkey needs a fresh confirmation from one already enrolled — " +
        "being unlocked on this browser is not enough on its own.",
    );
  }

  const grant = await verifyScopedAssertion(
    narrowAssertion(input.assertion),
    { kind: "remove", credentialId },
    db,
    input.supersedes,
  );

  const deleted = await db.deleteFrom("passkey").where("credential_id", "=", credentialId).executeTakeFirst();
  if (deleted.numDeletedRows === 0n) {
    // Removed by another request between the resolve above and here —
    // genuinely concurrent, not the common case, but still a refusal rather
    // than a crash.
    throw new NotFoundError(`No passkey with id ${credentialId}.`);
  }

  return { grant };
}
