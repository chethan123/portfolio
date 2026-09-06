/**
 * Every lock rule; the only importer of `@simplewebauthn/server` (docs/adr/0012). Challenges are
 * in-memory: a restart loses every outstanding one. A verified assertion is not proof of a fresh
 * prompt — an already-unlocked vault answers without one, and WebAuthn carries no freshness signal.
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

/** Both from `PUBLIC_ORIGIN` (ADR-0012). Never a parameter: no route can supply another expectation. */
type RelyingPartyExpectation = { origin: string; rpID: string };

function expectedRelyingParty(): RelyingPartyExpectation {
  const origin = getConfig().PUBLIC_ORIGIN;
  return { origin, rpID: new URL(origin).hostname };
}

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

/** Chromium accepts the `__Host-` prefix over `http://localhost` and `http://127.0.0.1`; Firefox untested. */
export const LOCK_COOKIE = "__Host-unlock_grant";

/** No `Max-Age` — the row owns lifetime ({@link touchGrant} rolls it). `Lax`: the sign-in bounce is cross-site. */
export function lockCookie(grantId: string): string {
  return `${LOCK_COOKIE}=${grantId}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

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
 * No export hands out a grant without a verified ceremony. `supersedes` must come from the caller's
 * own `LOCK_COOKIE`, never a form field — nothing here can confirm the id belongs to the caller.
 * Deleted before the insert: a failure between the two leaves no live grant rather than two.
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

/** One statement, `for update`: two round trips would read a concurrently deleted grant as live. */
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

type ChallengePurpose =
  | { kind: "unlock" }
  | { kind: "enrol" }
  | { kind: "remove"; credentialId: string }
  | { kind: "register"; label: string; bootstrap: boolean };

type AssertionScope = { kind: "unlock" } | { kind: "enrol" } | { kind: "remove"; credentialId: string };

type ChallengeKind = ChallengePurpose["kind"];

const CHALLENGE_KINDS: readonly ChallengeKind[] = ["unlock", "enrol", "remove", "register"];

/** Per kind, never shared: `unlock` is the only kind a browser holding no grant can mint. */
export const MAX_LIVE_CHALLENGES_PER_PURPOSE = 500;

type ChallengeEntry = { purpose: ChallengePurpose; expiresAt: number; spent: boolean };

/** Spent rather than deleted on read, so a replay is still distinguishable from "never issued". */
const challenges = new Map<string, ChallengeEntry>();

function isUsable(entry: ChallengeEntry, now: number): boolean {
  return !entry.spent && entry.expiresAt > now;
}

/** Two budgets per kind: counting dead entries against the live one let a retry flood evict a live one. */
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

/** Only the fields this module dereferences. Without it a client `{}` is a `TypeError` and a 500. */
const webAuthnResponseShape = z.object({
  id: z.string().min(1),
  response: z.object({ clientDataJSON: z.string().min(1) }),
});

const UNREADABLE_RESPONSE_MESSAGE = "This passkey response could not be read.";

/** The library copies `transports` unchecked — unbounded, one registration poisons every `allowCredentials`. */
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

function narrowAssertion(value: unknown): AuthenticationResponseJSON {
  if (!webAuthnResponseShape.safeParse(value).success) {
    throw ValidationError.form(UNREADABLE_RESPONSE_MESSAGE);
  }
  return value as AuthenticationResponseJSON;
}

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

/** Narrower by exactly `extensions`: react-router's serialisation rewrites the `BufferSource` inside it. */
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
 * Message prefix, not `instanceof Error`, which every verification failure also satisfies
 * (@simplewebauthn/server 14.0.0, pinned). Judged before the signature check, so a forged response
 * with a low counter lands here too.
 */
function isCounterRegression(cause: unknown): boolean {
  return cause instanceof Error && cause.message.startsWith("Response counter value");
}

const COUNTER_WENT_BACKWARDS_MESSAGE =
  "This passkey's counter went backwards, which can mean a copy of it exists somewhere. " +
  "The check was refused. Remove this passkey from Settings → Passkeys and enrol it again.";

/**
 * Nothing is written before `verified.verified`; the counter only moves forward (`greatest`).
 * A passkey removed between the read and the mint is found by {@link mintGrant}'s insert, not
 * re-checked here.
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

export async function verifyUnlock(
  response: unknown,
  db: Kysely<Database> = getDb(),
  supersedes?: string,
): Promise<UnlockGrant> {
  return verifyScopedAssertion(narrowAssertion(response), { kind: "unlock" }, db, supersedes);
}

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
    // User id is left to the library, fresh per enrolment: a shared one lets an authenticator treat
    // the second enrolment as replacing the first. Neither id nor name is stored.
    userName: label,
    userDisplayName: label,
    challenge: bytes,
    attestationType: "none",
    authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
    // Consequence: a provider already holding one refuses client-side, so two passkeys from the
    // same provider are not supported.
    excludeCredentials,
  });

  return options as RegistrationOptions;
}

/**
 * Control chars, line/paragraph separators, bidi overrides (a row reading back to front removes the
 * wrong passkey), zero width space. U+200D and the variation selectors stay — emoji need them.
 */
const REFUSED_LABEL_CHARACTERS = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\u200B]/u;

const NO_CONTROL_CHARACTERS_MESSAGE =
  "A label cannot carry a line break, an invisible character, or another control character.";
const NOT_WELL_FORMED_MESSAGE = "A label cannot carry an incomplete character.";

const labelInput = z.object({
  label: requiredText("A label", LABEL_MAX_LENGTH)
    .refine((value) => !REFUSED_LABEL_CHARACTERS.test(value), { message: NO_CONTROL_CHARACTERS_MESSAGE })
    .refine((value) => value.isWellFormed(), { message: NOT_WELL_FORMED_MESSAGE }),
});

/** Enforced here, not by a client-side `disabled`, which a direct POST skips. Not a credential — a courtesy gate. */
const FIRST_PASSKEY_NOT_ACKNOWLEDGED_MESSAGE =
  "Enrolling the household's first passkey locks every other browser immediately — tick " +
  "that acknowledgement first.";

/**
 * The first passkey needs only the acknowledgement, and that is a courtesy: the conditional insert
 * and `passkey_bootstrap_idx` close the bootstrap race. Every later enrolment needs an assertion
 * scoped to `"enrol"`.
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

function uniqueViolationConstraint(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === "23505" && typeof constraint === "string" ? constraint : undefined;
}

/** Savepoint so a caught violation does not leave the caller's transaction aborted. No-op outside one. */
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

/** Spec ceiling, in decoded bytes. Checked against the library's output, not the client's `id`. */
const MAX_CREDENTIAL_ID_BYTES = 1023;

const CREDENTIAL_ID_LENGTH_MESSAGE =
  "This passkey gave itself an identifier of a length this app cannot store. Try enrolling it again.";

const CREDENTIAL_ID_MISMATCH_MESSAGE =
  "This passkey named itself two different things in one answer, so it was not enrolled.";

/**
 * Only against the single-use `"register"` challenge. Bootstrap's `where not exists` and
 * `passkey_bootstrap_idx` are each insufficient alone (migration 0012 says which interleaving stays
 * open); the race reports as `passkey_pkey`. Bootstrap mints a grant, or the browser that enrolled
 * the first passkey is locked out by its own redirect.
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

  // The library forwards the attested credential id unbounded — it compares `id` to `rawId`, never
  // to the attested bytes, and its emptiness guard passes a zero-length `Uint8Array`. A stored `""`
  // would then ride in every `allowCredentials` this app hands out.
  const credentialIdBytes = isoBase64URL.toBuffer(credential.id);
  if (credentialIdBytes.byteLength < 1 || credentialIdBytes.byteLength > MAX_CREDENTIAL_ID_BYTES) {
    throw ValidationError.form(CREDENTIAL_ID_LENGTH_MESSAGE);
  }
  // Also refuses a non-canonically encoded id: `isoBase64URL.fromBuffer` only ever emits the
  // unpadded base64url form.
  if (credential.id !== parsedResponse.id) {
    throw ValidationError.form(CREDENTIAL_ID_MISMATCH_MESSAGE);
  }

  const publicKey = Buffer.from(credential.publicKey);
  const transports = joinTransports(credential.transports);
  // BE, not BS: eligibility is what "synced" means to a reader. Fixed at enrolment.
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

/**
 * Target resolved before every other check, so an unknown one spends no challenge. The last passkey
 * may authorise its own removal — how the lock is turned off; deleting it cascades its grants away,
 * which is what locks this browser.
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
    // Removed concurrently between the resolve above and here.
    throw new NotFoundError(`No passkey with id ${credentialId}.`);
  }

  return { grant };
}
