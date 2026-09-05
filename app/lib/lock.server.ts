/**
 * The lock (docs/adr/0012, CONTEXT.md's `Locked`/`Passkey`): every rule about
 * unlocking a browser, enrolling a passkey and removing one, and the grant
 * that records one browser's current unlock. **The only module in the app
 * that imports `@simplewebauthn/server`.** Routes translate a form and
 * render whatever comes back; the middleware (ticket 03) asks this module
 * one question — is there a live grant — and acts on the answer. No route
 * states a rule that belongs here.
 *
 * **The grant cookie's builders live here, not in `lock.ts`.** They are
 * `HttpOnly`: only this module and `app/root.tsx`'s middleware ever read or
 * write them, so nothing browser-reachable needs the import. An earlier
 * version placed them beside `lock.ts`'s browser-safe vocabulary on the
 * claim that they shared masking's "two writers, one cookie" argument for
 * doing so — they do not. Masking's cookie is genuinely written by client
 * script; this one cannot be, which is the whole of that argument, so it
 * does not transfer.
 *
 * **The honest limit, stated where somebody will act on it.** A provider
 * whose vault is already unlocked can return a verified assertion without
 * prompting anybody — WebAuthn gives no freshness signal an assertion could
 * carry (ADR-0012's platform limits). Requiring a fresh assertion before
 * enrolling or removing a passkey therefore raises the cost of a borrowed
 * phone rather than closing it. It is worth having anyway, because it fails
 * closed on every authenticator that does prompt — and nothing here should
 * be read as claiming more than that.
 *
 * **The challenge map is a module-level `Map`, not a table.** The migration
 * this module reads and writes against makes the argument this module
 * leans on rather than restates: a challenge outlives one ceremony by
 * seconds, and a table for it would be schema nobody reads twice. Sweeping
 * on mint (the same reasoning `createDraft`'s sweep already follows for
 * `upload_draft`) removes what is already dead, but dead entries are not
 * the only way this map grows: a household's *live* entries are bounded
 * only by request rate unless something else caps them, which is what
 * {@link MAX_LIVE_CHALLENGES_PER_PURPOSE} is for — one budget per purpose,
 * not one shared across all four, so a flood minting the one purpose an
 * un-granted browser can reach can never evict a different purpose's
 * challenge (that budget's own header says why, and what it does not
 * promise). Expiry is enforced again on read, which is the authoritative
 * check.
 *
 * **A failed ceremony spends its challenge.** {@link takeChallenge} marks an
 * entry spent the moment it is read, whether or not what follows verifies —
 * deliberate, since handing the same challenge back for a second guess is
 * how a stolen response gets brute-forced against a counter or a public key.
 * The consequence ticket 04's author needs: a mistap that draws an honest
 * refusal must re-fetch options before retrying, or the retry lands on
 * "already used" — a true statement that reads as a lie about what just
 * happened.
 *
 * **What a server restart does.** The map lives in process memory and
 * nowhere else. Every outstanding challenge is lost, so both ceremonies
 * refuse ("never issued") until a browser fetches fresh options — no
 * different, from the family's side, than any other mid-ceremony drop. An
 * enrolment interrupted between its two requests is the sharper case: the
 * authenticator has already written a credential into the family member's
 * own vault, this instance never persisted anything for it, and — because
 * migration 0012 deliberately does not store the WebAuthn user handle —
 * there is no way to recognise or exclude that credential on the next
 * attempt. The person ends up with a spare, harmless entry in their
 * password manager and tries again.
 *
 * **One string becomes a number, and only here.** {@link verifyScopedAssertion}
 * reads a stored signature counter back out of `passkey.counter` and hands
 * the library a JavaScript number. Money, quantities, ids and dates cross
 * the driver boundary as strings for a reason that does not apply here: a
 * signature counter is a 32-bit unsigned integer by specification, the
 * column's `check` bounds it to exactly that range, and `Number()` cannot
 * lose anything converting a value that narrow. This is not an exception to
 * the numeric-boundary rule — it is a value the rule was never about.
 *
 * **A WebAuthn response arrives as `unknown`, because it is client-submitted
 * JSON.** Every exported function that takes one types its parameter
 * `unknown` and narrows through {@link narrowAssertion} or
 * {@link narrowRegistration} before touching it — this is the boundary
 * CLAUDE.md means by "Zod at the boundaries only, in the domain module".
 * Only the outer shape this module itself dereferences (the id, the client
 * data) is checked; the rest is the library's own response schema to state,
 * left untouched for `verifyAuthenticationResponse` and
 * `verifyRegistrationResponse` to accept or refuse on their own terms.
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
import { IDLE_WINDOW_MS, LABEL_MAX_LENGTH, joinTransports, splitTransports } from "./lock.ts";

/** The household's own name, shown to a password manager as the relying party. */
const RP_NAME = "Portfolio Tracker";

/** One enrolled credential, as Settings (ticket 05) needs to print it. */
export type Passkey = {
  credentialId: string;
  label: string;
  backupEligible: boolean;
  enrolledAt: Date;
  lastUsedAt: Date | null;
};

/** One browser's current unlock. */
export type UnlockGrant = {
  id: string;
  passkeyId: string;
  expiresAt: Date;
};

/**
 * What this instance expects a WebAuthn response to have been made for —
 * both derived from `PUBLIC_ORIGIN` (ADR-0012): the origin is the value
 * itself, the relying-party id is its bare hostname. Computed fresh on every
 * call rather than cached, and never taken as a parameter: no route may ever
 * supply a different relying-party expectation than this instance's own
 * configured origin (a domain rule a route must never state), and a
 * per-call override is exactly the seam that invites one to try. Tests get
 * their own control by mocking `../../server/config.ts` instead — see
 * `tests/lock.test.ts`.
 */
type RelyingPartyExpectation = { origin: string; rpID: string };

function expectedRelyingParty(): RelyingPartyExpectation {
  const origin = getConfig().PUBLIC_ORIGIN;
  return { origin, rpID: new URL(origin).hostname };
}

// ---------------------------------------------------------------------------
// Is the household locked at all
// ---------------------------------------------------------------------------

/**
 * Whether the household holds at least one passkey — the whole of what
 * "locked" means (ADR-0012). There is no setting to read.
 *
 * A failure to answer is not an answer of "no": this throws rather than
 * swallowing a database error, unlike `app/root.tsx`'s loader, which
 * catches around `firstRunStep` because a first-run prompt failing open is
 * the right call for *that* read. This one guards a boundary, and a
 * boundary that fails open on a database hiccup is not a boundary.
 */
export async function isLocked(db: Kysely<Database> = getDb()): Promise<boolean> {
  const row = await db
    .selectNoFrom((eb) => eb.exists(eb.selectFrom("passkey").select("passkey.credential_id").limit(1)).as("locked"))
    .executeTakeFirstOrThrow();
  return Boolean(row.locked);
}

/** The household's enrolled passkeys, oldest first — Settings' whole list (ticket 05). */
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

// ---------------------------------------------------------------------------
// The grant cookie (ticket 03)
// ---------------------------------------------------------------------------

/**
 * The grant's cookie — named for the table the id it carries addresses.
 * `__Host-` prefixed because this one carries a credential, where masking's
 * cookie deliberately carries neither prefix nor `Secure` (its own header):
 * a passkey will not run outside a secure context anyway, so the attributes
 * cost this feature nothing.
 *
 * **The dev loop's plain-http localhost was tried, not argued.** Chromium
 * 141 accepts, stores and returns this cookie over `http://localhost` and
 * over `http://127.0.0.1` alike — both are potentially-trustworthy origins,
 * so `Secure` is not the bar there that it is elsewhere. The control run
 * says the observation is real rather than an artefact: the same cookie with
 * the prefix and *without* `Secure` is refused outright, as the prefix's own
 * rules require. Firefox and WebKit were not available to try and are
 * therefore still unknown; Firefox has historically been stricter about
 * loopback addresses that are not literally `localhost`, so `127.0.0.1` is
 * the case to re-check first if the dev loop ever misbehaves there.
 */
export const LOCK_COOKIE = "__Host-unlock_grant";

/**
 * The `Set-Cookie` value for a browser whose assertion this module just
 * verified. `Secure`, `HttpOnly`, `Path=/` and the `__Host-` prefix all
 * follow from carrying a credential rather than a preference (this file's
 * comment on {@link LOCK_COOKIE}). No `Max-Age`: the *grant row* is the
 * authority on how long this lasts, extended by the request that uses it
 * ({@link touchGrant}) — a fixed cookie lifetime set once at unlock would
 * expire the cookie under a family member still actively reading, even
 * though the row itself had just been pushed further out, which would read
 * as a lock that relocks mid-use for no reason anyone could see.
 *
 * **`SameSite=Lax`, never `Strict`.** The gate's own redirect through Google
 * returns as a top-level, cross-site navigation — not on every request,
 * since the gate's own cookie is seven days and does not roll (ADR-0012),
 * but on the weekly sign-in bounce every browser eventually takes. `Strict`
 * would withhold this cookie on that very return trip and re-lock every
 * browser on that same schedule, which would read as a random bug rather
 * than anything this feature did.
 */
export function lockCookie(grantId: string): string {
  return `${LOCK_COOKIE}=${grantId}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

/**
 * The `Set-Cookie` value that removes it — sent whenever the grant it names
 * turns out to be gone, so a stale id does not survive to confuse the next
 * unlock. Carries the same attributes {@link lockCookie} does: a `__Host-`
 * prefixed cookie is dropped by the browser unless *every* `Set-Cookie` that
 * names it — clearing included — carries `Secure` and `Path=/`.
 */
export function clearedLockCookie(): string {
  return `${LOCK_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * What this browser's grant cookie names, or `undefined` — nothing else:
 * the row is the authority, and the cookie carries no claim, no timestamp
 * and no signature for that reason (docs/adr/0012).
 */
export function readLockCookie(request: Request): string | undefined {
  return readCookie(request, LOCK_COOKIE);
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

/** A row this module reads or writes back, as `unlock_grant`'s own columns — never hand-copied. */
type UnlockGrantRow = Pick<Selectable<Database["unlock_grant"]>, "id" | "passkey_id" | "expires_at">;

function toGrant(row: UnlockGrantRow): UnlockGrant {
  return { id: row.id, passkeyId: row.passkey_id, expiresAt: row.expires_at };
}

/** A cryptographically random opaque id, well past `unlock_grant`'s `length(id) >= 32` check. */
function randomGrantId(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * What every caller of {@link mintGrant} refuses with when the passkey it was
 * about to credit no longer exists — a race genuinely reachable from two
 * ordinary requests (an unlock and a removal, say) landing at once, never a
 * 500.
 */
const PASSKEY_REMOVED_MID_VERIFICATION_MESSAGE =
  "This passkey was removed while this confirmation was being checked. Start again.";

/** Whether `error` is a foreign-key violation naming `constraint` — Postgres's `23503`. */
function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  if (!(error instanceof Error)) return false;
  const { code, constraint: violated } = error as { code?: unknown; constraint?: unknown };
  return code === "23503" && violated === constraint;
}

/**
 * Mint a grant for a passkey that just verified. Sweeps expired grants
 * first, in the same statement path — minting is the moment this table is
 * guaranteed to be looked at, the rule `upload_draft`'s `createDraft`
 * already follows. No scheduler, no throttle.
 *
 * Module-private: every caller in tickets 03-06 reaches this through a
 * verified ceremony (`verifyUnlock`, an authorised `beginEnrolment` or
 * `completeRegistration`, `removePasskey`) — none of them hands out a grant
 * on its own say-so, and this function must not become the one export that
 * does.
 *
 * **The passkey this credits can vanish after the caller last checked it.**
 * `verifyScopedAssertion` reads the row, verifies the assertion, and only
 * then reaches here — a window wide enough for a concurrent removal to land
 * inside it. Rather than re-reading the row first (itself no closer to
 * atomic), the insert is left to find out: `unlock_grant.passkey_id`
 * references `passkey.credential_id`, so a passkey gone by the time this
 * runs makes the insert itself fail with `unlock_grant_passkey_id_fkey`,
 * caught here and turned into the one message every such race shares — never
 * the raw violation, which is what a concurrent unlock, enrolment or removal
 * used to surface as a 500. The insert runs through
 * {@link guardedAgainstConstraintViolation}, the same as
 * {@link completeRegistration}'s own inserts, so a caught violation cannot
 * leave a caller's own transaction — a test's `withDatabase`, today;
 * conceivably a future multi-step route wrapping this call in one —
 * aborted for whatever runs after it.
 */
async function mintGrant(passkeyId: string, db: Kysely<Database> = getDb()): Promise<UnlockGrant> {
  const now = new Date();
  await db.deleteFrom("unlock_grant").where("expires_at", "<=", now).execute();

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

/**
 * A grant by its opaque id — nothing for an id that does not exist and
 * nothing for one past its expiry, without the caller checking the clock.
 */
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
 * Is this grant live right now, rolling its expiry a fresh idle window out
 * if less than half the window remains — one atomic statement, which is
 * what the middleware (ticket 03) needs and `readGrant` followed by a
 * separate `extendGrant` call could not give it.
 *
 * **What two round trips could not tell apart.** A middleware that reads a
 * grant and then extends it as two separate calls has a gap between them —
 * a browser's grant can be deleted in that gap (ticket 06's "Lock now", or a
 * concurrent removal cascading it away) without the extend call ever
 * learning why it wrote nothing: `UPDATE ... WHERE id = ? AND expires_at >
 * now() AND expires_at <= half-window` matches zero rows whether the row is
 * gone or simply not due for a refresh yet, and a caller that only checked
 * the *first* call's answer would serve the page regardless — the grant it
 * decided to trust was already stale. One statement removes the gap: the
 * decision the caller acts on and the write that keeps a live grant alive
 * are the same round trip, so there is no window between them left for a
 * concurrent deletion to land in unnoticed.
 *
 * **The row lock, not only the `WHERE`, is what closes the race.** A plain
 * `SELECT` takes its snapshot at the start of the statement and would still
 * report a grant deleted by a since-committed concurrent transaction as
 * live, if that transaction's delete was merely in flight, uncommitted, the
 * instant this statement's read ran. `for update` forces this read to
 * behave like a write: if another transaction holds a conflicting lock on
 * this row — `deleteGrant`'s `DELETE`, say — this blocks until that
 * transaction resolves, and then re-checks the row's current state exactly
 * as an `UPDATE` would (Postgres's own `SELECT ... FOR UPDATE` semantics) —
 * gone if the other transaction deleted and committed, unchanged if it rolled
 * back. Without it, this function would have traded one silent wrong answer
 * for another.
 *
 * **The write stays conditional.** The `rolled` CTE's own `WHERE` still
 * skips the actual `UPDATE` while more than half the window remains, the
 * same predicate `extendGrant` used to carry — so this is not an
 * unconditional write on every document and data request, merely an
 * unconditional row lock (cheap, held only for this one statement) on every
 * live one.
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

/** Delete a grant outright — the explicit lock control (ticket 06) needs this. */
export async function deleteGrant(id: string, db: Kysely<Database> = getDb()): Promise<void> {
  await db.deleteFrom("unlock_grant").where("id", "=", id).execute();
}

// ---------------------------------------------------------------------------
// The challenge map
// ---------------------------------------------------------------------------

/**
 * What a challenge was minted for. The four purposes this slice has, kept
 * distinct so a challenge minted for one can never satisfy another: an
 * assertion minted to unlock must not authorise an enrolment, one minted to
 * remove a passkey must not authorise removing a different one than the
 * form named, and a registration is only ever accepted against a challenge
 * that carries the very label the person typed.
 */
type ChallengePurpose =
  | { kind: "unlock" }
  | { kind: "enrol" }
  | { kind: "remove"; credentialId: string }
  | { kind: "register"; label: string; bootstrap: boolean };

/** The purposes an *assertion* (a `navigator.credentials.get()` response) may be scoped to. */
type AssertionScope = { kind: "unlock" } | { kind: "enrol" } | { kind: "remove"; credentialId: string };

/**
 * How long a minted challenge is good for, in milliseconds. Longer than the
 * ceremony's own 60-second default `timeout` (`generateRegistrationOptions`,
 * `generateAuthenticationOptions`), so a slow password-manager prompt does
 * not race the browser's own give-up against ours; short enough that an
 * abandoned challenge does not linger.
 */
const CHALLENGE_TTL_MS = 2 * 60 * 1000;

/** Every kind a challenge can be minted for — {@link ChallengePurpose} without its per-target fields. */
type ChallengeKind = ChallengePurpose["kind"];

/** Every {@link ChallengeKind}, so the partition below can sweep each in turn. */
const CHALLENGE_KINDS: readonly ChallengeKind[] = ["unlock", "enrol", "remove", "register"];

/**
 * The most live challenges *one purpose* ever holds at once — a budget
 * partitioned by {@link ChallengeKind}, not one shared across all four. An
 * un-granted browser can reach exactly one of them: ticket 03's middleware
 * exempts `/unlock` itself, so `unlockOptions` is the one mint reachable by a
 * browser holding no grant at all. The household's actual recovery paths —
 * enrolling another passkey and removing a lost one, both behind the lock —
 * mint only `enrol`/`remove`/`register` challenges. A single shared budget
 * with oldest-first eviction let a flood of the one anonymous kind evict the
 * other three, which is exactly backwards: it let a browser this slice does
 * not trust yet evict the confirmation a browser it already trusts was
 * relying on. Partitioning makes that impossible by construction — eviction
 * below only ever removes an entry of the very kind that is over its own
 * budget, never another's.
 *
 * A household legitimately minting a challenge is one family member opening
 * one screen — a handful at a time, at most; 500 is not a number any real
 * household gets near, for any one purpose. **This bounds memory, not
 * availability, and says so plainly**: a flood that keeps minting one kind's
 * challenges denies *that kind* for as long as it runs — once its own budget
 * is full, every fresh mint evicts whatever same-kind challenge came before
 * it, a legitimate family member's in-flight one included. That is the
 * honest residual of a single-process, in-memory challenge store; rate
 * limiting — the fix for a flood itself, rather than for what a flood can
 * reach — is out of scope for this slice by name (spec 0019's "Out of
 * Scope"). What partitioning buys is narrower and real: the flood stays
 * confined to the one door it is reachable through, and never reaches the
 * two recovery paths sitting behind the lock.
 */
const MAX_LIVE_CHALLENGES_PER_PURPOSE = 500;

type ChallengeEntry = { purpose: ChallengePurpose; expiresAt: number; spent: boolean };

/**
 * The one Node process holds this. Entries are marked spent rather than
 * deleted on read — deleting on first read would make a *replayed* use
 * indistinguishable from one *never issued*, and those refuse with
 * different sentences. A spent entry still leaves the map on the next
 * mint's sweep, once its own TTL passes.
 *
 * One `Map` rather than one per {@link ChallengeKind}: expiry sweeping reads
 * every entry regardless of kind, so a single map keeps that walk to one
 * pass; only eviction — {@link evictOldestOfKind} below — needs to reason
 * about one kind at a time, and it does that by filtering this same map
 * rather than by splitting it.
 */
const challenges = new Map<string, ChallengeEntry>();

/**
 * Evict the oldest live entries of exactly one `kind` until that kind alone
 * is back at {@link MAX_LIVE_CHALLENGES_PER_PURPOSE} — an entry of any other
 * kind is never even considered, which is the whole of what partitioning the
 * budget means. `Map` preserves insertion order, so the first matching entry
 * found while walking it is that kind's oldest; cheap enough, since eviction
 * only ever runs once a kind is over its own budget, not on every mint.
 */
function evictOldestOfKind(kind: ChallengeKind): void {
  let live = 0;
  for (const entry of challenges.values()) {
    if (entry.purpose.kind === kind) live++;
  }

  while (live > MAX_LIVE_CHALLENGES_PER_PURPOSE) {
    let oldest: string | undefined;
    for (const [text, entry] of challenges) {
      if (entry.purpose.kind === kind) {
        oldest = text;
        break;
      }
    }
    if (oldest === undefined) break;
    challenges.delete(oldest);
    live--;
  }
}

/**
 * Drop everything past its expiry, then enforce {@link
 * MAX_LIVE_CHALLENGES_PER_PURPOSE} one {@link ChallengeKind} at a time via
 * {@link evictOldestOfKind}. Called from {@link mintChallenge} only — no
 * `setInterval`: a timer would hold the process open for a value nothing
 * else needs between requests, and minting is a moment every ceremony
 * already passes through, exactly as `createDraft`'s sweep of `upload_draft`
 * reads the clock at the one moment it is guaranteed to be asked to.
 */
function sweepChallenges(now: number): void {
  for (const [text, entry] of challenges) {
    if (entry.expiresAt <= now) challenges.delete(text);
  }

  for (const kind of CHALLENGE_KINDS) {
    evictOldestOfKind(kind);
  }
}

function mintChallenge(purpose: ChallengePurpose): { text: string; bytes: Uint8Array<ArrayBuffer> } {
  const now = Date.now();
  sweepChallenges(now);

  // A plain `ArrayBuffer`-backed `Uint8Array`, not `Buffer`: the library's
  // own option types (`Uint8Array<ArrayBuffer>`) are pickier than a Buffer's
  // `ArrayBufferLike` backing, the same seam `tests/support/webauthn.ts`
  // documents for itself.
  const bytes = new Uint8Array(32);
  randomFillSync(bytes);
  // The library re-encodes a `string` challenge as UTF-8 bytes before
  // base64url-encoding it for the browser (`generateRegistrationOptions`,
  // `generateAuthenticationOptions`) — passing a string here would hand the
  // browser a *different* value than the one keying this map. Passing the
  // raw bytes and computing the map key with the library's own
  // `isoBase64URL` is what keeps the two identical.
  const text = isoBase64URL.fromBuffer(bytes);

  challenges.set(text, { purpose, expiresAt: now + CHALLENGE_TTL_MS, spent: false });
  return { text, bytes };
}

/**
 * Spend a challenge, or refuse — unknown, expired and already-spent each
 * with their own sentence, so a screen (and a test) can tell the three
 * apart. Expiry is checked before spent-ness: an entry that is both is an
 * expired one, not a replay.
 */
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

/** The shape of a response's signed client data this module ever reads. */
const clientDataSchema = z.object({ challenge: z.string() });

/** The challenge embedded in a response's signed client data — never re-derived from `id`. */
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
 * The outer shape of a WebAuthn response this module actually dereferences
 * before either verifier runs: the credential id, read to look up the
 * enrolled passkey, and the client data, handed to {@link decodeChallenge}.
 * Everything past that — `rawId`, `type`, `clientExtensionResults`,
 * `authenticatorData`, `signature`, `attestationObject`, and every other
 * field either verifier reads — is the library's own response schema to
 * state, not this module's to restate (CLAUDE.md: Zod at the boundaries
 * only, in the domain module).
 *
 * A response reaches this module as JSON from the client, and so as
 * `unknown` at every exported entry point below. Without this check, `{}`
 * or `{"response": null}` dereferences straight into a `TypeError` — no
 * verifier's own `catch` is in scope that early, so a hostile or merely
 * broken answer became a 500 rather than a refusal.
 */
const webAuthnResponseShape = z.object({
  id: z.string().min(1),
  response: z.object({ clientDataJSON: z.string().min(1) }),
});

const UNREADABLE_RESPONSE_MESSAGE = "This passkey response could not be read.";

/**
 * Narrow a client-submitted assertion, or refuse before it is ever
 * dereferenced. The original `value` is returned, not the parsed one: only
 * the outer shape is checked here, so every field neither this module nor
 * the schema above names still reaches the verifier untouched.
 */
function narrowAssertion(value: unknown): AuthenticationResponseJSON {
  if (!webAuthnResponseShape.safeParse(value).success) {
    throw ValidationError.form(UNREADABLE_RESPONSE_MESSAGE);
  }
  return value as AuthenticationResponseJSON;
}

/** {@link narrowAssertion}'s registration-response twin. */
function narrowRegistration(value: unknown): RegistrationResponseJSON {
  if (!webAuthnResponseShape.safeParse(value).success) {
    throw ValidationError.form(UNREADABLE_RESPONSE_MESSAGE);
  }
  return value as RegistrationResponseJSON;
}

// ---------------------------------------------------------------------------
// Unlocking, and the shared assertion machinery enrolling and removing lean on
// ---------------------------------------------------------------------------

async function allowCredentialList(
  db: Kysely<Database>,
): Promise<{ id: string; transports?: string[] }[]> {
  const rows = await db.selectFrom("passkey").select(["credential_id", "transports"]).execute();
  return rows.map((row) => ({ id: row.credential_id, transports: splitTransports(row.transports) }));
}

/**
 * A `PublicKeyCredentialRequestOptionsJSON` this module actually hands out —
 * narrower than the library's own declared return type by exactly one
 * property, and truthfully so: {@link authenticationOptionsFor} below never
 * passes an `extensions` option to `generateAuthenticationOptions`, so the
 * value it returns never carries that key at all. Declaring the narrower
 * type here, once, is what lets every consumer of {@link unlockOptions},
 * {@link enrolmentAssertionOptions} and {@link removalAssertionOptions} — the
 * unlock screen today, ticket 05's two option builders once they exist — read
 * `.options` straight into `startAuthentication` with no assertion of their
 * own. The alternative this replaces was a wide `as
 * PublicKeyCredentialRequestOptionsJSON` at each such call site, forced by a
 * typegen quirk unrelated to any of them: react-router's wire-type
 * serialisation rewrites a loader's `ArrayBuffer`-typed properties, and the
 * library's own type nests exactly one, `AuthenticationExtensionsClientInputs`
 * → `prf.eval.first: BufferSource`, deep inside the very `extensions` this
 * type asserts away. Fixed at the one place the value is actually produced,
 * the assertion is scoped to the one property it is really about, rather
 * than blanketing the whole object the way a client-side assertion had to.
 */
type UnlockOptions = PublicKeyCredentialRequestOptionsJSON & { extensions?: undefined };

async function authenticationOptionsFor(
  purpose: ChallengePurpose & AssertionScope,
  db: Kysely<Database>,
  expected: RelyingPartyExpectation,
): Promise<UnlockOptions> {
  // Handing every credential id to a browser that has not unlocked is
  // accepted, not hidden: everyone the gate admitted is a family member, and
  // this is what makes a never-enrolled browser locked rather than exempt
  // (ADR-0012). `allowCredentials`, not "discoverable-only", is what carries
  // each stored transport so the browser can offer the cross-device flow.
  const allowCredentials = await allowCredentialList(db);
  const { bytes } = mintChallenge(purpose);

  const options = await generateAuthenticationOptions({
    rpID: expected.rpID,
    userVerification: "required",
    challenge: bytes,
    allowCredentials,
  });

  // The one assertion {@link UnlockOptions}'s own header promises: nothing
  // above ever sets `extensions`, so the library's wider declared return
  // type is honestly narrower here, in the one value this function actually
  // produces.
  return options as UnlockOptions;
}

/** Options for the unlock screen's one action (spec 0019). */
export async function unlockOptions(db: Kysely<Database> = getDb()): Promise<UnlockOptions> {
  return authenticationOptionsFor({ kind: "unlock" }, db, expectedRelyingParty());
}

/** Options for the "prove yourself" step before enrolling another passkey. */
export async function enrolmentAssertionOptions(
  db: Kysely<Database> = getDb(),
): Promise<UnlockOptions> {
  return authenticationOptionsFor({ kind: "enrol" }, db, expectedRelyingParty());
}

/** Options for the "prove yourself" step before removing one named passkey. */
export async function removalAssertionOptions(
  credentialId: string,
  db: Kysely<Database> = getDb(),
): Promise<UnlockOptions> {
  return authenticationOptionsFor({ kind: "remove", credentialId }, db, expectedRelyingParty());
}

/**
 * Verify an assertion scoped to `expected` — refusing a challenge that was
 * never issued, one already spent, one that has expired, and one minted for
 * a different action or a different target, each its own message before the
 * library is ever called. The library performs the signature-counter
 * comparison itself, under the condition the specification states, so a
 * platform authenticator reporting a constant zero is not treated as a
 * clone; a regression makes it throw, surfaced here as a refusal — logged
 * with the underlying cause and which ceremony it was, never silently
 * ignored, and answered with its own sentence rather than the generic one
 * ({@link isCounterRegression}) — rather than restated: the library owns
 * that comparison, and this only observes what it decided. `requireUserVerification` is left at
 * the library's own default (`true`) rather than restated.
 *
 * On success: the stored counter moves forward only (`greatest`, one
 * statement, so two assertions completing out of order cannot walk it
 * back), `last_used_at` is written regardless (a passkey whose counter is a
 * constant zero still gets used), backup eligibility is not re-read, and a
 * grant is minted — every verified assertion mints one, which is exactly
 * what makes a grant insufficient on its own to authorise enrolling or
 * removing (see this module's header).
 *
 * Nothing is written before `verified.verified` is checked: a response
 * verified against the wrong public key refuses here, mints no grant, and
 * touches neither `counter` nor `last_used_at`.
 *
 * **The passkey read above can be removed by another request before this
 * returns.** The counter update that follows is silently a no-op against a
 * row that is already gone — Postgres raises nothing for an `update` that
 * matches zero rows — so it is {@link mintGrant}'s own insert, not this
 * function, that discovers the passkey is gone and refuses; see its header
 * for why catching that one violation there, rather than re-checking the
 * row count here, is what closes the race regardless of exactly when the
 * concurrent removal lands.
 */
/**
 * The one refusal the family can act on, told apart from every other
 * verification failure by the library's own message.
 *
 * `verifyAuthenticationResponse` throws at
 * `node_modules/@simplewebauthn/server/esm/authentication/verifyAuthenticationResponse.js:182-188`
 * when `(counter > 0 || credential.counter > 0) && counter <= credential.counter`,
 * with a message that begins `Response counter value`. Matched on that
 * prefix rather than on `instanceof Error` alone, which every other failure
 * in that function also satisfies — a loose match would relabel a wrong
 * public key, a wrong relying-party id and a missing user verification as
 * clones, which is the one mistake worth more than the message is.
 *
 * **It is judged before the signature is checked** (`:192`), so a forged
 * response carrying a low counter reaches this branch too. The sentence
 * below therefore says the counter went backwards and what that can mean,
 * and never that the passkey *was* copied — which is all this instance
 * knows, and all a household can act on either way.
 */
function isCounterRegression(cause: unknown): boolean {
  return cause instanceof Error && cause.message.startsWith("Response counter value");
}

/**
 * Deliberately not "cloned", "copied device" or any of the words
 * `CONTEXT.md`'s `Passkey` and `Locked` entries rule out: it names what
 * happened, what it can mean, and the one thing to do about it.
 */
const COUNTER_WENT_BACKWARDS_MESSAGE =
  "This passkey's counter went backwards, which can mean a copy of it exists somewhere. " +
  "The check was refused. Remove this passkey from Settings → Passkeys and enrol it again.";

async function verifyScopedAssertion(
  response: AuthenticationResponseJSON,
  expected: AssertionScope,
  db: Kysely<Database>,
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
    // The one conversion this module's header explains.
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

  return mintGrant(passkeyRow.credential_id, db);
}

/**
 * Verify the unlock screen's assertion. Refuses; on success, mints and
 * returns the grant. `response` is the client's submitted JSON, `unknown`
 * until {@link narrowAssertion} checks it — see that function's header.
 */
export async function verifyUnlock(
  response: unknown,
  db: Kysely<Database> = getDb(),
): Promise<UnlockGrant> {
  return verifyScopedAssertion(narrowAssertion(response), { kind: "unlock" }, db);
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
  "A label cannot carry a line break or another control character.";
const NOT_WELL_FORMED_MESSAGE = "A label cannot carry an incomplete character.";

const labelInput = z.object({
  label: requiredText("A label", LABEL_MAX_LENGTH)
    .refine((value) => !/[\p{Cc}]/u.test(value), { message: NO_CONTROL_CHARACTERS_MESSAGE })
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
 * alone, and that migration's comment on the index is explicit about why.
 * That same bootstrap case also requires `acknowledgement` to be exactly
 * `"true"` — see {@link FIRST_PASSKEY_NOT_ACKNOWLEDGED_MESSAGE}. Ignored once
 * the household holds a passkey: the warning this guards is shown only for
 * the first one, and enrolling a second changes nothing for anybody.
 *
 * Every later enrolment needs `assertion`, verified as scoped to `"enrol"`
 * — which also mints a grant, the same as any verified assertion. The
 * registration challenge returned here carries `label`, and is accepted by
 * {@link completeRegistration} only against it.
 */
export async function beginEnrolment(
  label: string,
  input: { assertion: unknown; acknowledgement?: string },
  db: Kysely<Database> = getDb(),
): Promise<{ options: RegistrationOptions; grant: UnlockGrant | undefined }> {
  const { assertion, acknowledgement } = input;
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
    grant = await verifyScopedAssertion(narrowAssertion(assertion), { kind: "enrol" }, db);
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
 * sufficient alone (migration 0012's comment on `passkey_bootstrap_idx`).
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
 */
export async function removePasskey(
  credentialId: string,
  input: { assertion: unknown; confirmRemoval?: string },
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

  const grant = await verifyScopedAssertion(narrowAssertion(input.assertion), { kind: "remove", credentialId }, db);

  const deleted = await db.deleteFrom("passkey").where("credential_id", "=", credentialId).executeTakeFirst();
  if (deleted.numDeletedRows === 0n) {
    // Removed by another request between the resolve above and here —
    // genuinely concurrent, not the common case, but still a refusal rather
    // than a crash.
    throw new NotFoundError(`No passkey with id ${credentialId}.`);
  }

  return { grant };
}
