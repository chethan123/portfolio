/** Builds a registration response and assertion the library's own verifier accepts, byte by byte, using
 * the same isoCBOR/isoBase64URL primitives it verifies with — never a replayed blob. Never provoke a
 * refusal with a broken signature: authData/clientDataJSON are signed as one string, so flip a byte and
 * re-sign (`counter`, `rpID` below) rather than mutate after signing. Pairs with seedPasskey (fixtures.ts,
 * ADR-0012): credentialId/publicKey/transports/backupEligible here are exactly its non-defaulted params. */
import { createHash, createPrivateKey, sign as nodeSign } from "node:crypto";

import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

import { getConfig } from "../../server/config.ts";

/** The subset of CBOR's value space this file ever needs to write. */
type CBORValue = string | number | Uint8Array | Map<string | number, CBORValue>;

const encodeCBOR = (value: CBORValue): Uint8Array =>
  isoCBOR.encode(value as Parameters<typeof isoCBOR.encode>[0]);

// Seam cast: isoBase64URL.fromBuffer wants the library's Uint8Array<ArrayBuffer> alias, pickier than the bare Uint8Array the byte-builders return.
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

// P-256 keypair committed on purpose — fixture, not a secret, protects nothing real. Every run must sign identical bytes.
const PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQga5Mw2tno81QYke+N
PYuzebb6dmP5/AUIsJy6IgmjopahRANCAARrBRbJuSzvcDI/5vgRtorut05Si61/
SylDdrr4OLGWyMWYf6zaKDrnWiXs1nUl84CIUtouD88Nvttu8a4T0kkC
-----END PRIVATE KEY-----
`;

const privateKey = createPrivateKey(PRIVATE_KEY_PEM);

// x/y derived from the key's own JWK export rather than typed in separately, so the two can't drift.
const { x, y } = privateKey.export({ format: "jwk" });
if (!x || !y) throw new Error("fixture private key did not export EC x/y coordinates");
const publicKeyX = Buffer.from(x, "base64url");
const publicKeyY = Buffer.from(y, "base64url");

/** Sixteen zero bytes. Nothing in this slice reads the AAGUID (migration 0012's comment). */
const AAGUID = new Uint8Array(16);

/** Base64url text, exactly as the library would hand back a fresh credential id. */
export const credentialId = "WSaiL2H92GTWItltL3w8OPjY4HeycM2MiFa6wrYfW00";
const credentialIdBytes = isoBase64URL.toBuffer(credentialId);

/** COSE_Key CBOR: { 1: kty EC2, 3: alg ES256, -1: crv P-256, -2: x, -3: y }, encoded with the same isoCBOR the verifier decodes with. */
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

/** Backup-eligible — a synced passkey, what Settings' "synced" column is tested against (ADR-0012). */
export const backupEligible = true;

// up | uv | be | bs | at — the attested-credential-data flag only registration sets.
const REGISTRATION_FLAGS = 0x5d;
// up | uv | be | bs — no attested credential data on an assertion.
const AUTHENTICATION_FLAGS = 0x1d;
/** Same assertion, user-verification bit cleared and re-signed — `required` refuses what `preferred` would accept. */
export const NO_USER_VERIFICATION_FLAGS = AUTHENTICATION_FLAGS & ~0x04;

// Derived from getConfig().PUBLIC_ORIGIN so this fixture can't drift from the suite's configured origin. RP id is the bare hostname.
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
  const json = JSON.stringify({ type, challenge, origin: expectedOrigin });
  return new TextEncoder().encode(json);
}

/** A RegistrationResponseJSON verifyRegistrationResponse accepts — fmt: "none", empty attStmt, no signature,
 * so rpID/credentialId/attestedCredentialId can be overridden with nothing to re-sign. A credentialId override
 * must be canonical base64url — completeRegistration refuses a decode/re-encode mismatch. `transports` is
 * `unknown` and replaces the module constant wholesale, so a test can send what a broken client might. */
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

  // `in`, not `??`: lets a test send an explicitly absent transports, distinct from no override at all.
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

/** An AuthenticationResponseJSON verifyAuthenticationResponse accepts, signed with the fixture's private key
 * over authData || clientDataHash. `counter` (default 0) and `rpID` vary and re-sign, for counter cases and wrong-rpIdHash. */
export function assertionResponse(
  challenge: string,
  options?: { counter?: number; rpID?: string; flags?: number },
): AuthenticationResponseJSON {
  const authData = authenticatorData(options?.flags ?? AUTHENTICATION_FLAGS, options?.counter ?? 0, {
    rpID: options?.rpID,
  });
  const rawClientDataJSON = clientDataJSON("webauthn.get", challenge);
  const clientDataHash = createHash("sha256").update(rawClientDataJSON).digest();

  // DER-encoded ECDSA signature (SEQUENCE{INTEGER r, INTEGER s}) — Node's default dsaEncoding — which @simplewebauthn/server unwraps itself.
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
