/**
 * A registration response and an assertion the library's own verifier
 * accepts, built one byte at a time rather than captured once from a real
 * authenticator and replayed as a blob.
 *
 * A captured blob is a single frozen case. Ticket 02's refusals are each a
 * *variation* — of what the server expects (a wrong configured origin or
 * relying-party id, a stale or spent or unknown challenge), or of what a
 * response itself carries (a wrong relying-party id baked into `authData`,
 * a signed counter) — and every one of them has to start from a response
 * that would otherwise verify. That means the suite needs the response *and* the
 * ability to reason about exactly which bytes back which check, which a
 * recorded capture cannot give: nobody can tell, from a blob, which bit of
 * which byte the relying-party-id check actually reads. Building it by hand
 * from `@simplewebauthn/server/helpers`'s `isoCBOR`/`isoBase64URL` — the
 * same primitives the library verifies with — means this file and the
 * module under test are provably reading the same bytes, and a case this
 * file doesn't yet cover is a function call away rather than a re-recording
 * session.
 *
 * **The one thing a test built on this file must not do: provoke a refusal
 * with a broken signature.** `authData` and `clientDataJSON` are signed as
 * one string; flipping a flag or a byte inside either *without re-signing*
 * breaks the signature over it, and a test built on a broken signature
 * passes because the verifier rejected the signature, not because it
 * enforced the rule the test claims to cover. Varying a byte and **re-signing**
 * is a different, legitimate input — `assertionResponse`'s `counter` and
 * `rpID` options below do exactly that: they change what goes into
 * `authData` and then sign over the changed bytes, so the response is
 * internally consistent and the verifier's rejection (when it rejects) is
 * for the reason the test names. `registrationResponse`'s `rpID` option is
 * the same move for the one ceremony whose attestation is never itself
 * signed (`fmt: "none"`): only the value baked into `authData`'s `rpIdHash`
 * changes, so the response stays otherwise identical.
 *
 * The credential id and its keypair are the one thing that stays fixed for
 * the life of this file regardless — a different credential id needs a
 * different keypair to sign for it, which is a second fixture identity this
 * file does not carry. A test naming a *different* credential (a bystander,
 * an unrelated key) seeds that row directly instead, the way
 * `unrelatedPublicKeyCose()` already does in `tests/lock.test.ts`.
 *
 * Paired with `seedPasskey` (`tests/support/fixtures.ts`, ADR-0012): the
 * `credentialId`, `publicKey`, `transports` and `backupEligible` exported
 * here are exactly its non-defaulted parameters, so a test seeds the row
 * this fixture's signature was actually made against rather than a
 * plausible-looking stand-in.
 */
import { createHash, createPrivateKey, sign as nodeSign } from "node:crypto";

import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

import { getConfig } from "../../server/config.ts";

/** The subset of CBOR's value space this file ever needs to write. */
type CBORValue = string | number | Uint8Array | Map<string | number, CBORValue>;

const encodeCBOR = (value: CBORValue): Uint8Array =>
  isoCBOR.encode(value as Parameters<typeof isoCBOR.encode>[0]);

// `isoBase64URL.fromBuffer` is typed against the library's own
// `Uint8Array<ArrayBuffer>` alias, one TypeScript version pickier than the
// bare `Uint8Array` every byte-builder below returns — this is the one seam
// between the two, not a loosening of either.
const base64url = (bytes: Uint8Array): string =>
  isoBase64URL.fromBuffer(bytes as Parameters<typeof isoBase64URL.fromBuffer>[0]);

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function uint16BE(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, false);
  return bytes;
}

function uint32BE(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

// A P-256 keypair generated once for this fixture and committed on purpose —
// every run has to sign the identical bytes, so the key cannot be minted
// fresh per process the way a real enrolment's would be. It is a fixture,
// not a secret: this repository carries it deliberately, and it protects
// nothing real. The public half is derived from it below rather than
// committed as a second constant, which is what stops the two from quietly
// drifting apart under an edit to one but not the other.
const PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQga5Mw2tno81QYke+N
PYuzebb6dmP5/AUIsJy6IgmjopahRANCAARrBRbJuSzvcDI/5vgRtorut05Si61/
SylDdrr4OLGWyMWYf6zaKDrnWiXs1nUl84CIUtouD88Nvttu8a4T0kkC
-----END PRIVATE KEY-----
`;

const privateKey = createPrivateKey(PRIVATE_KEY_PEM);

// `x`/`y` come out of the private key's own JWK export, never typed in
// separately, for the same drift-proofing reason the PEM above is the only
// key material in this file.
const { x, y } = privateKey.export({ format: "jwk" });
if (!x || !y) throw new Error("fixture private key did not export EC x/y coordinates");
const publicKeyX = Buffer.from(x, "base64url");
const publicKeyY = Buffer.from(y, "base64url");

/** Sixteen zero bytes. Nothing in this slice reads the AAGUID (migration 0012's comment). */
const AAGUID = new Uint8Array(16);

/** Base64url text, exactly as the library would hand back a fresh credential id. */
export const credentialId = "WSaiL2H92GTWItltL3w8OPjY4HeycM2MiFa6wrYfW00";
const credentialIdBytes = isoBase64URL.toBuffer(credentialId);

/**
 * The COSE_Key CBOR bytes the library will verify a signature against —
 * `{ 1: kty EC2, 3: alg ES256, -1: crv P-256, -2: x, -3: y }` — encoded with
 * the same `isoCBOR` the verifier decodes with, rather than a hand-rolled
 * byte string.
 */
export const publicKey: Uint8Array = encodeCBOR(
  new Map<number, number | Uint8Array>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, publicKeyX],
    [-3, publicKeyY],
  ]),
);

/** What registration reported. A platform authenticator offering the cross-device flow. */
export const transports: string[] = ["internal", "hybrid"];

/**
 * Backup-eligible, fixed by the flags this file signs into `authData` below
 * — a synced passkey, which is what Settings' "synced" column is tested
 * against (ADR-0012).
 */
export const backupEligible = true;

// up | uv | be | bs | at — the attested-credential-data flag only registration sets.
const REGISTRATION_FLAGS = 0x5d;
// up | uv | be | bs — no attested credential data on an assertion.
const AUTHENTICATION_FLAGS = 0x1d;

/**
 * The origin and relying-party id this fixture's signature was made for,
 * derived from `getConfig().PUBLIC_ORIGIN` rather than restated as a second
 * constant — the derivation is what stops this file and the suite's
 * configured origin silently drifting apart. The relying-party id is the
 * origin's bare hostname: no scheme, no port.
 */
export const expectedOrigin = getConfig().PUBLIC_ORIGIN;
export const expectedRPID = new URL(expectedOrigin).hostname;

function authenticatorData(
  flags: number,
  counter: number,
  options?: { attestedCredentialData?: Uint8Array; rpID?: string },
): Uint8Array {
  const rpIdHash = createHash("sha256").update(options?.rpID ?? expectedRPID, "utf8").digest();
  const parts = [rpIdHash, Uint8Array.of(flags), uint32BE(counter)];
  if (options?.attestedCredentialData) parts.push(options.attestedCredentialData);
  return concatBytes(parts);
}

function attestedCredentialData(id: Uint8Array, key: Uint8Array): Uint8Array {
  return concatBytes([AAGUID, uint16BE(id.byteLength), id, key]);
}

function clientDataJSON(type: "webauthn.create" | "webauthn.get", challenge: string): Uint8Array {
  // `challenge` arrives already base64url, exactly as the server hands it
  // out and exactly as a browser would echo it back — never re-encoded here.
  const json = JSON.stringify({ type, challenge, origin: expectedOrigin });
  return new TextEncoder().encode(json);
}

/**
 * A `RegistrationResponseJSON` `verifyRegistrationResponse` accepts for the
 * given (server-issued) challenge — `fmt: "none"`, empty `attStmt`, no
 * signature. `rpID` defaults to {@link expectedRPID}; pass a different one
 * to bake a wrong `rpIdHash` into `authData` (see the module header — this
 * is legitimate because `"none"` attestation carries no signature over
 * `authData` to break).
 *
 * `credentialId`/`publicKey` default to this file's one signable identity;
 * pass a different pair to register a *second*, distinct credential in the
 * same test — legitimate for the same reason `rpID` is: `"none"` attestation
 * has no signature to invalidate, so no private key is needed for a
 * credential this file's fixture never has to *assert* as. A test that
 * needs the new credential to later sign an assertion still has to use the
 * default identity, since that is the only one with a private key here. A
 * `credentialId` override has to be *canonical* base64url — text that
 * survives a decode and re-encode unchanged — because the id inside
 * `authData` is derived from it by decoding, and `completeRegistration` now
 * refuses a registration whose attested id and reported id disagree. A
 * browser's own id is canonical by construction; a hand-written literal is
 * not, unless its length is a multiple of four less than one.
 *
 * Two options exist only to produce answers a real authenticator should
 * never send, because the library does not refuse them and the domain module
 * now does. `attestedCredentialId` sets the id *inside* `authData`
 * independently of `id`/`rawId`, which is the pair the library compares —
 * zero bytes, 1024 bytes, or simply a different id from the one the client
 * reported. `transports` is typed `unknown` and replaces the module constant
 * wholesale, so a test can send the string, the number or the `null` a
 * broken client might; only that one field is cast on the way out, so
 * TypeScript goes on checking the other seven structurally against
 * `RegistrationResponseJSON` rather than accepting the whole literal on an
 * `as`.
 */
export function registrationResponse(
  challenge: string,
  options?: {
    rpID?: string;
    credentialId?: string;
    publicKey?: Uint8Array;
    attestedCredentialId?: Uint8Array;
    transports?: unknown;
  },
): RegistrationResponseJSON {
  const responseCredentialId = options?.credentialId ?? credentialId;
  const responseCredentialIdBytes = isoBase64URL.toBuffer(responseCredentialId);
  const responsePublicKey = options?.publicKey ?? publicKey;
  const attestedId = options?.attestedCredentialId ?? responseCredentialIdBytes;

  const authData = authenticatorData(REGISTRATION_FLAGS, 0, {
    attestedCredentialData: attestedCredentialData(attestedId, responsePublicKey),
    rpID: options?.rpID,
  });
  const attestationObject = encodeCBOR(
    new Map<string, CBORValue>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]),
  );

  // `"transports" in options` rather than `??`, so a test can send an
  // explicitly absent one — a real and legitimate answer — as distinct from
  // not asking for an override at all.
  const responseTransports: unknown =
    options !== undefined && "transports" in options ? options.transports : transports;

  return {
    id: responseCredentialId,
    rawId: responseCredentialId,
    response: {
      clientDataJSON: base64url(clientDataJSON("webauthn.create", challenge)),
      attestationObject: base64url(attestationObject),
      transports: responseTransports as string[] | undefined,
    },
    clientExtensionResults: {},
    type: "public-key",
  };
}

/**
 * An `AuthenticationResponseJSON` `verifyAuthenticationResponse` accepts for
 * the given (server-issued) challenge, signed with the fixture's committed
 * private key over `authData || clientDataHash` — the exact concatenation
 * `verifyAuthenticationResponse` reconstructs before checking it.
 *
 * `counter` defaults to 0 (a fresh credential's initial value); pass a
 * different one to sign an assertion for a chosen signature counter — what
 * a counter-progression or counter-regression test needs, re-signed so the
 * changed value stays inside a valid signature (module header). `rpID`
 * defaults to {@link expectedRPID}; pass a different one to bake a wrong
 * `rpIdHash` into `authData`, re-signed the same way.
 */
export function assertionResponse(
  challenge: string,
  options?: { counter?: number; rpID?: string },
): AuthenticationResponseJSON {
  const authData = authenticatorData(AUTHENTICATION_FLAGS, options?.counter ?? 0, { rpID: options?.rpID });
  const rawClientDataJSON = clientDataJSON("webauthn.get", challenge);
  const clientDataHash = createHash("sha256").update(rawClientDataJSON).digest();

  // The DER-encoded ECDSA signature (`SEQUENCE { INTEGER r, INTEGER s }`) an
  // authenticator actually produces — Node's default `dsaEncoding` for an EC
  // key — which `@simplewebauthn/server` unwraps itself. Never pre-converted
  // to raw r‖s.
  const signature = nodeSign("sha256", concatBytes([authData, clientDataHash]), privateKey);

  return {
    id: credentialId,
    rawId: credentialId,
    response: {
      clientDataJSON: base64url(rawClientDataJSON),
      authenticatorData: base64url(authData),
      signature: base64url(signature),
    },
    clientExtensionResults: {},
    type: "public-key",
  };
}
