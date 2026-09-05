/**
 * `app/lib/lock.server.ts` — the module that offers a WebAuthn challenge and
 * judges the answer (docs/adr/0012, docs/specs/lock/02-the-two-ceremonies.md).
 * No browser and no route sits between these tests and the refusals; every
 * one is provoked by varying either the *server's* expectation — a wrong
 * configured origin or relying-party id, a spent, unknown or expired
 * challenge — mocking `../server/config.ts` to do it (the module derives
 * its expectation from `getConfig()` internally and takes no override
 * parameter), or a *response's own* signed content — a wrong relying-party
 * id, a bumped signed counter, a wrong public key — using
 * `tests/support/webauthn.ts`'s re-signing options. Never by breaking a
 * signature outright, which is that file's own rule and would pass a test
 * for the wrong reason.
 *
 * Two tests below (`describe("duplicate credential id"`, `describe("counter
 * concurrency"`) drive genuine cross-connection races against the real test
 * database rather than `withDatabase`'s single rolled-back transaction —
 * the same reason `tests/lock-schema.test.ts` does for `passkey_bootstrap_idx`.
 * Each cleans up its own committed rows at both ends, the way that file
 * does, because both share `tests/support/webauthn.ts`'s one signable
 * credential id with every `withDatabase` test in this file.
 */
import { generateKeyPairSync } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isoCBOR } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, VerifiedAuthenticationResponse } from "@simplewebauthn/server";

import { createDatabase } from "~/lib/db.server";
import { NotFoundError, ValidationError } from "~/lib/input.server";
import { IDLE_WINDOW_MS, joinTransports, splitTransports } from "~/lib/lock";

import { closeTestDatabase, testDatabase, withDatabase } from "./support/database.ts";
import type { Fixtures } from "./support/fixtures.ts";
import {
  assertionResponse,
  backupEligible,
  credentialId,
  expectedOrigin,
  publicKey,
  registrationResponse,
  transports,
} from "./support/webauthn.ts";

// `verifyAuthenticationResponse` is spied on, not replaced: every other test
// in this file needs the library's real verification. Hoisted because
// `vi.mock`'s factory runs before this file's own top-level `const`s would
// otherwise exist.
const capturedAssertionOptions = vi.hoisted(
  () => [] as Array<{ requireUserVerification?: boolean }>,
);

vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyAuthenticationResponse: async (
      options: Parameters<typeof actual.verifyAuthenticationResponse>[0],
    ): Promise<VerifiedAuthenticationResponse> => {
      capturedAssertionOptions.push(options);
      return actual.verifyAuthenticationResponse(options);
    },
  };
});

/**
 * `lock.server.ts` derives its relying-party expectation from
 * `getConfig().PUBLIC_ORIGIN`, computed fresh on every call rather than
 * taken as a parameter (§2 of the review this file folds in). This is the
 * seam that gives tests control instead: mock the config module the same
 * way `@simplewebauthn/server` is mocked above, and let one test-local knob
 * override `PUBLIC_ORIGIN` for the duration of a single call.
 * `server/config.ts` memoises its real answer with no reset (its own
 * header), which is exactly why a route parameter felt necessary to the
 * original author — mocking is the way round it without changing a
 * signature, `app/lib/db.server.ts`'s `withDb` comment's own principle.
 */
const configOverride = vi.hoisted(() => ({ origin: undefined as string | undefined }));

vi.mock("../server/config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/config.ts")>();
  return {
    ...actual,
    getConfig: () => {
      const real = actual.getConfig();
      return configOverride.origin === undefined ? real : { ...real, PUBLIC_ORIGIN: configOverride.origin };
    },
  };
});

/** Point every call the module makes at a different configured origin, until the next reset. */
function mockPublicOrigin(origin: string): void {
  configOverride.origin = origin;
}

/**
 * `expectedOrigin` with a different port — the hostname (and so the
 * relying-party id `lock.server.ts` derives from it) is unchanged, which is
 * what isolates "wrong expected origin" from "wrong expected relying-party
 * id": each test below is provoked by exactly one of the two.
 */
const DIFFERENT_PORT_ORIGIN = `${expectedOrigin}:8443`;

const {
  beginEnrolment,
  completeRegistration,
  deleteGrant,
  enrolmentAssertionOptions,
  extendGrant,
  isLocked,
  listPasskeys,
  readGrant,
  removalAssertionOptions,
  removePasskey,
  unlockOptions,
  verifyUnlock,
} = await import("~/lib/lock.server");

afterAll(closeTestDatabase);

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Every refusal below logs its cause (§6 of the review) — silenced here so
  // a deliberately-provoked refusal does not spam the test run, and
  // inspected directly by the one test about the logging itself.
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  configOverride.origin = undefined;
});

/** No test here decodes it; only its bytes matter for a bystander row. */
const BYSTANDER_PUBLIC_KEY = new Uint8Array([1, 2, 3, 4]);

/** A well-formed COSE EC public key nobody's private key here corresponds to. */
function unrelatedPublicKeyCose(): Uint8Array {
  const { publicKey: generated } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = generated.export({ format: "jwk" }) as { x?: string; y?: string };
  if (jwk.x === undefined || jwk.y === undefined) {
    throw new Error("expected an EC JWK with x/y coordinates");
  }
  return isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x, "base64url")],
      [-3, Buffer.from(jwk.y, "base64url")],
    ]) as Parameters<typeof isoCBOR.encode>[0],
  );
}

/** The refusal a call produced, or a test failure if it did not refuse. */
async function refusalOf(run: () => Promise<unknown>): Promise<ValidationError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("expected the call to be refused, and it was not");
}

/** Bytes a base64url string decodes to, for asserting a challenge's or a grant id's true length. */
function decodedByteLength(base64url: string): number {
  return Buffer.from(base64url, "base64url").length;
}

describe("isLocked", () => {
  it(
    "answers false when the household holds no passkey",
    withDatabase(async ({ db }) => {
      expect(await isLocked(db)).toBe(false);
    }),
  );

  it(
    "answers true once a passkey is enrolled",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY });
      expect(await isLocked(db)).toBe(true);
    }),
  );

  it("propagates a read failure rather than answering false", async () => {
    const unreachable = createDatabase("postgres://portfolio:portfolio@127.0.0.1:1/portfolio_test");
    try {
      await expect(isLocked(unreachable)).rejects.toThrow();
    } finally {
      await unreachable.destroy();
    }
  });
});

describe("listPasskeys", () => {
  it(
    "reports each passkey's label, sync flag and instants",
    withDatabase(async ({ db, seedPasskey }) => {
      const enrolledAt = new Date("2026-01-01T00:00:00Z");
      const lastUsedAt = new Date("2026-02-01T00:00:00Z");
      await seedPasskey({
        publicKey: BYSTANDER_PUBLIC_KEY,
        label: "Kitchen iPad",
        backupEligible: true,
        enrolledAt,
        lastUsedAt,
      });

      const rows = await listPasskeys(db);
      expect(rows).toEqual([
        {
          credentialId: expect.any(String),
          label: "Kitchen iPad",
          backupEligible: true,
          enrolledAt,
          lastUsedAt,
        },
      ]);
    }),
  );

  it(
    "reports a never-used passkey as null rather than a placeholder date",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY, label: "Laptop" });
      const [row] = await listPasskeys(db);
      expect(row?.lastUsedAt).toBeNull();
    }),
  );
});

describe("transports encoding", () => {
  // `lock.server.ts` and `tests/support/fixtures.ts`'s `seedPasskey` both
  // import these from `app/lib/lock.ts` now (§8 of the review) — pinned here
  // as the module's own exported behaviour, not restated per caller.
  it("joins no transports as null rather than an empty string", () => {
    // The exact bug migration 0012's `transports` comment says the writer
    // has to refuse: `[].join(",")` is `""`, and `"".split(",")` reads back
    // as one bogus transport rather than none.
    expect(joinTransports([])).toBeNull();
    expect(joinTransports(undefined)).toBeNull();
  });

  it("splits a null column back into no transports", () => {
    expect(splitTransports(null)).toBeUndefined();
  });

  it("round-trips a real transport list", () => {
    const joined = joinTransports(["internal", "hybrid"]);
    expect(splitTransports(joined)).toEqual(["internal", "hybrid"]);
  });
});

describe("grants", () => {
  it(
    "reads nothing for an id past its expiry",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY });
      const grant = await seedUnlockGrant({
        passkeyId: passkey.credentialId,
        expiresAt: new Date(Date.now() - 1000),
      });

      expect(await readGrant(grant.id, db)).toBeUndefined();
    }),
  );

  it(
    "reads nothing for an id that does not exist",
    withDatabase(async ({ db }) => {
      expect(await readGrant("no-such-grant-id-at-all-xxxxxxxxxxxx", db)).toBeUndefined();
    }),
  );

  it(
    "never resurrects an already-expired grant when extended",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY });
      const grant = await seedUnlockGrant({
        passkeyId: passkey.credentialId,
        expiresAt: new Date(Date.now() - 1000),
      });

      await extendGrant(grant.id, db);

      expect(await readGrant(grant.id, db)).toBeUndefined();
    }),
  );

  it(
    "skips the extension while more than half the idle window remains",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY });
      const originalExpiry = new Date(Date.now() + IDLE_WINDOW_MS - 5000);
      const grant = await seedUnlockGrant({ passkeyId: passkey.credentialId, expiresAt: originalExpiry });

      await extendGrant(grant.id, db);

      const row = await db
        .selectFrom("unlock_grant")
        .select("expires_at")
        .where("id", "=", grant.id)
        .executeTakeFirstOrThrow();
      expect(row.expires_at.getTime()).toBe(originalExpiry.getTime());
    }),
  );

  it(
    "moves the expiry out once at or past half the idle window",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY });
      const originalExpiry = new Date(Date.now() + 1000);
      const grant = await seedUnlockGrant({ passkeyId: passkey.credentialId, expiresAt: originalExpiry });

      await extendGrant(grant.id, db);

      const row = await db
        .selectFrom("unlock_grant")
        .select("expires_at")
        .where("id", "=", grant.id)
        .executeTakeFirstOrThrow();
      expect(row.expires_at.getTime()).toBeGreaterThan(originalExpiry.getTime());
    }),
  );

  it(
    "sweeps expired grants at the moment a new one is minted",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      const stale = await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY, credentialId: "stale-owner" });
      await seedFixturePasskey(seedPasskey);
      const expired = await seedUnlockGrant({
        passkeyId: stale.credentialId,
        expiresAt: new Date(Date.now() - 1000),
      });

      // Minting has no exported entry point of its own (§4 of the review —
      // it is not authority anybody should be able to hand out on its own
      // say-so) — reached here, as every real caller reaches it, through a
      // verified ceremony.
      const options = await unlockOptions(db);
      await verifyUnlock(assertionResponse(options.challenge), db);

      const remaining = await db
        .selectFrom("unlock_grant")
        .select("id")
        .where("id", "=", expired.id)
        .execute();
      expect(remaining).toHaveLength(0);
    }),
  );

  it(
    "deletes a grant outright",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY });
      const grant = await seedUnlockGrant({ passkeyId: passkey.credentialId });

      await deleteGrant(grant.id, db);

      expect(await readGrant(grant.id, db)).toBeUndefined();
    }),
  );
});

/** Seed the one passkey `tests/support/webauthn.ts`'s fixtures can sign for. */
function seedFixturePasskey(seedPasskey: Fixtures["seedPasskey"], counter = 0) {
  return seedPasskey({ publicKey, credentialId, transports, backupEligible, counter });
}

describe("unlocking", () => {
  it(
    "asks for a required user verification on the options, and hands back every enrolled id",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const options = await unlockOptions(db);

      expect(options.userVerification).toBe("required");
      expect(options.allowCredentials?.map((c) => c.id)).toEqual([credentialId]);
      expect(options.allowCredentials?.[0]?.transports).toEqual(transports);
    }),
  );

  it(
    "issues a challenge that decodes to a full 32 bytes, not a short or predictable one",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const options = await unlockOptions(db);
      expect(decodedByteLength(options.challenge)).toBe(32);
    }),
  );

  it(
    "verifies a fresh assertion, updates last_used_at, and mints a grant",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const options = await unlockOptions(db);

      const grant = await verifyUnlock(assertionResponse(options.challenge), db);

      expect(typeof grant.id).toBe("string");
      expect(grant.id.length).toBeGreaterThanOrEqual(32);
      // A length check alone would pass a shorter, non-random encoding of
      // the right character count; decoding to exactly 32 bytes is what
      // kills a sequential or otherwise guessable id (migration 0012's own
      // reasoning about `unlock_grant.id`).
      expect(decodedByteLength(grant.id)).toBe(32);
      expect(grant.passkeyId).toBe(credentialId);
      expect(grant.expiresAt).toBeInstanceOf(Date);
      // The idle window named in `app/lib/lock.ts`, not some other figure —
      // a year-long grant would also satisfy every other assertion here.
      expect(grant.expiresAt.getTime()).toBeGreaterThan(Date.now() + IDLE_WINDOW_MS - 5000);
      expect(grant.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + IDLE_WINDOW_MS + 5000);
      expect(await readGrant(grant.id, db)).toEqual(grant);

      const row = await db
        .selectFrom("passkey")
        .select("last_used_at")
        .where("credential_id", "=", credentialId)
        .executeTakeFirstOrThrow();
      expect(row.last_used_at).not.toBeNull();
    }),
  );

  it(
    "requires user verification on the call, not only on the options",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const options = await unlockOptions(db);
      capturedAssertionOptions.length = 0;

      await verifyUnlock(assertionResponse(options.challenge), db);

      expect(capturedAssertionOptions).toHaveLength(1);
      // Left at the library's own default (`true`) rather than restated —
      // asserted here, on the call, rather than by forging a UV=false
      // assertion the fixture cannot produce without breaking its signature.
      expect(capturedAssertionOptions[0]?.requireUserVerification).toBeUndefined();
    }),
  );

  it(
    "moves the stored counter forward on a higher signed counter",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey, /* counter */ 1);
      const options = await unlockOptions(db);

      await verifyUnlock(assertionResponse(options.challenge, { counter: 7 }), db);

      const row = await db
        .selectFrom("passkey")
        .select("counter")
        .where("credential_id", "=", credentialId)
        .executeTakeFirstOrThrow();
      expect(row.counter).toBe("7");
    }),
  );

  it(
    "refuses a challenge that was never issued",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const refusal = await refusalOf(() =>
        verifyUnlock(assertionResponse("bm90LWEtcmVhbC1jaGFsbGVuZ2U"), db),
      );
      expect(refusal.fieldErrors.form).toMatch(/never issued/);
    }),
  );

  it(
    "refuses a challenge already spent",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const options = await unlockOptions(db);
      const response: AuthenticationResponseJSON = assertionResponse(options.challenge);

      await verifyUnlock(response, db);
      const refusal = await refusalOf(() => verifyUnlock(response, db));
      expect(refusal.fieldErrors.form).toMatch(/already been used/);
    }),
  );

  it(
    "refuses an expired challenge",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const options = await unlockOptions(db);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + 3 * 60 * 1000);
        const refusal = await refusalOf(() => verifyUnlock(assertionResponse(options.challenge), db));
        expect(refusal.fieldErrors.form).toMatch(/expired/);
      } finally {
        vi.useRealTimers();
      }
    }),
  );

  it(
    "evicts the oldest live challenge once the map's cap is exceeded",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const first = await unlockOptions(db);

      // 500 is `lock.server.ts`'s own cap (§5 of the review): the map holds
      // `first` plus 500 more once this loop ends (501 total), and eviction
      // only runs on the *next* mint's sweep — so it takes one more call
      // past the cap, not merely reaching it, to actually force `first` out.
      for (let i = 0; i < 501; i++) {
        await unlockOptions(db);
      }

      // Evicted, not merely unspent: a spent-or-expired refusal would be the
      // wrong sentence here and would mean the cap did not actually apply.
      const refusal = await refusalOf(() => verifyUnlock(assertionResponse(first.challenge), db));
      expect(refusal.fieldErrors.form).toMatch(/never issued/);
    }),
    20_000,
  );

  it(
    "refuses a wrong expected origin",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const options = await unlockOptions(db);

      mockPublicOrigin(DIFFERENT_PORT_ORIGIN);
      const refusal = await refusalOf(() => verifyUnlock(assertionResponse(options.challenge), db));
      expect(refusal).toBeInstanceOf(ValidationError);
    }),
  );

  it(
    "refuses a response whose relying-party id does not match this instance",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const options = await unlockOptions(db);

      const refusal = await refusalOf(() =>
        verifyUnlock(assertionResponse(options.challenge, { rpID: "attacker.example.com" }), db),
      );
      expect(refusal).toBeInstanceOf(ValidationError);
    }),
  );

  it(
    "refuses a bumped stored counter as a signature-counter regression, and logs the cause",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey, /* counter */ 1);
      const options = await unlockOptions(db);

      const refusal = await refusalOf(() => verifyUnlock(assertionResponse(options.challenge), db));
      expect(refusal).toBeInstanceOf(ValidationError);

      // The family-facing message stays generic (they cannot act on the
      // difference); the operator's own log names the ceremony and carries
      // the library's real cause, rather than the failure being logged and
      // ignored (ticket 02's own rule for a counter regression specifically).
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("assertion (unlock)"),
        expect.anything(),
      );
    }),
  );

  it(
    "refuses a response verified against the wrong public key, writing nothing",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedPasskey({ publicKey: unrelatedPublicKeyCose(), credentialId, transports });
      const options = await unlockOptions(db);

      await expect(verifyUnlock(assertionResponse(options.challenge), db)).rejects.toThrow(
        ValidationError,
      );

      const row = await db
        .selectFrom("passkey")
        .select(["counter", "last_used_at"])
        .where("credential_id", "=", credentialId)
        .executeTakeFirstOrThrow();
      expect(row.counter).toBe("0");
      expect(row.last_used_at).toBeNull();

      const grants = await db.selectFrom("unlock_grant").select("id").execute();
      expect(grants).toHaveLength(0);
    }),
  );
});

describe("enrolling", () => {
  it(
    "lets a request with no grant enrol before any passkey exists, and refuses once one does",
    withDatabase(async ({ db }) => {
      const begun = await beginEnrolment("Kitchen iPad", undefined, db);
      expect(begun.grant).toBeUndefined();

      const completed = await completeRegistration(registrationResponse(begun.options.challenge), db);
      expect(completed.passkey.label).toBe("Kitchen iPad");
      // The bootstrap case mints a grant — the browser that enrolled the
      // first passkey must not be locked out by its own redirect back.
      expect(completed.grant).toBeDefined();
      expect(await isLocked(db)).toBe(true);

      const refusal = await refusalOf(() => beginEnrolment("Second phone", undefined, db));
      expect(refusal.fieldErrors.form).toMatch(/fresh confirmation/);
    }),
  );

  it(
    "issues a registration challenge that decodes to a full 32 bytes",
    withDatabase(async ({ db }) => {
      const { options } = await beginEnrolment("Kitchen iPad", undefined, db);
      expect(decodedByteLength(options.challenge)).toBe(32);
    }),
  );

  it(
    "asks for a platform authenticator, required verification and no attestation",
    withDatabase(async ({ db }) => {
      const { options } = await beginEnrolment("Kitchen iPad", undefined, db);
      expect(options.authenticatorSelection?.authenticatorAttachment).toBe("platform");
      expect(options.authenticatorSelection?.userVerification).toBe("required");
      expect(options.attestation).toBe("none");
    }),
  );

  it(
    "refuses an empty label without minting or storing anything",
    withDatabase(async ({ db }) => {
      const refusal = await refusalOf(() => beginEnrolment("", undefined, db));
      expect(refusal).toBeInstanceOf(ValidationError);
      expect(await isLocked(db)).toBe(false);
    }),
  );

  it(
    "excludes already-enrolled credential ids, authorised by a fresh scoped assertion",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const assertionOptions = await enrolmentAssertionOptions(db);
      const assertion = assertionResponse(assertionOptions.challenge);

      const { options, grant } = await beginEnrolment("Laptop", assertion, db);

      expect(options.excludeCredentials?.map((c) => c.id)).toEqual([credentialId]);
      if (grant === undefined) throw new Error("expected the verified assertion to mint a grant");
      expect(await readGrant(grant.id, db)).toEqual(grant);
    }),
  );

  it(
    "mints no grant for a later, already-authorised registration",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const assertionOptions = await enrolmentAssertionOptions(db);
      const { options } = await beginEnrolment("Laptop", assertionResponse(assertionOptions.challenge), db);

      // A distinct credential id from the one proving the assertion above —
      // "none" attestation carries no signature, so a second, unrelated
      // public key needs no private key to register successfully here.
      const completed = await completeRegistration(
        registrationResponse(options.challenge, {
          credentialId: "second-device",
          publicKey: unrelatedPublicKeyCose(),
        }),
        db,
      );

      // The assertion step already minted one — a second here would leave
      // one request setting two cookies (this module's header).
      expect(completed.grant).toBeUndefined();
    }),
  );

  it(
    "records backup eligibility from what verification actually reported",
    withDatabase(async ({ db }) => {
      const begun = await beginEnrolment("Kitchen iPad", undefined, db);
      await completeRegistration(registrationResponse(begun.options.challenge), db);

      const [row] = await listPasskeys(db);
      // The fixture's signed authData carries the backup-eligible flag
      // (`tests/support/webauthn.ts`'s `backupEligible`); `listPasskeys`
      // seeded rows alone cannot prove the writer reads it off verification
      // rather than off some other default.
      expect(row?.backupEligible).toBe(backupEligible);
    }),
  );

  it(
    "refuses a duplicate enrolment of a credential already stored, rather than creating a row",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const assertionOptions = await enrolmentAssertionOptions(db);
      const { options } = await beginEnrolment("Laptop", assertionResponse(assertionOptions.challenge), db);

      const refusal = await refusalOf(() =>
        completeRegistration(registrationResponse(options.challenge), db),
      );
      expect(refusal.fieldErrors.form).toMatch(/already enrolled/);

      const rows = await db
        .selectFrom("passkey")
        .select("credential_id")
        .where("credential_id", "=", credentialId)
        .execute();
      expect(rows).toHaveLength(1);
    }),
  );

  it(
    "refuses a bootstrap registration once another passkey landed while it was in flight",
    withDatabase(async ({ db, seedPasskey }) => {
      const begun = await beginEnrolment("Kitchen iPad", undefined, db);

      // Simulates a second bootstrap enrolment committing in between —
      // ticket 01's `passkey_bootstrap_idx` is what closes the genuinely
      // concurrent version of this race; this is the simpler half, the
      // conditional insert finding the table no longer empty.
      await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY, credentialId: "already-there", bootstrap: true });

      const refusal = await refusalOf(() =>
        completeRegistration(registrationResponse(begun.options.challenge), db),
      );
      expect(refusal.fieldErrors.form).toMatch(/no longer without one/);

      const rows = await db
        .selectFrom("passkey")
        .select("credential_id")
        .where("credential_id", "=", credentialId)
        .execute();
      expect(rows).toHaveLength(0);
    }),
  );

  it(
    "does not authorise an enrolment with an assertion scoped to unlocking",
    withDatabase(async ({ db, seedPasskey }) => {
      // Any enrolled passkey makes the household locked, so `beginEnrolment`
      // actually inspects the assertion instead of taking the bootstrap path.
      await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY });
      const unlockOpts = await unlockOptions(db);
      const scopedToUnlock = assertionResponse(unlockOpts.challenge);

      const refusal = await refusalOf(() => beginEnrolment("Laptop", scopedToUnlock, db));
      expect(refusal.fieldErrors.form).toMatch(/not issued for this action/);
    }),
  );

  it(
    "refuses a registration presented without its own scoped challenge",
    withDatabase(async ({ db }) => {
      const refusal = await refusalOf(() =>
        completeRegistration(registrationResponse("bmV2ZXItaXNzdWVkLWNoYWxsZW5nZQ"), db),
      );
      expect(refusal.fieldErrors.form).toMatch(/never issued/);
    }),
  );

  it(
    "refuses a registration presented against a challenge issued for unlocking, not for enrolling",
    withDatabase(async ({ db, seedPasskey }) => {
      // A valid, issued, unspent challenge — just the wrong purpose. The
      // "never issued" test above cannot reach this branch: an unknown
      // challenge is refused earlier, before `purpose.kind` is even read.
      await seedFixturePasskey(seedPasskey);
      const unlockOpts = await unlockOptions(db);

      const refusal = await refusalOf(() =>
        completeRegistration(registrationResponse(unlockOpts.challenge), db),
      );
      expect(refusal.fieldErrors.form).toMatch(/not issued for enrolling/);
    }),
  );

  it(
    "refuses a registration verified against a wrong expected origin",
    withDatabase(async ({ db }) => {
      const begun = await beginEnrolment("Kitchen iPad", undefined, db);

      mockPublicOrigin(DIFFERENT_PORT_ORIGIN);
      const refusal = await refusalOf(() =>
        completeRegistration(registrationResponse(begun.options.challenge), db),
      );
      expect(refusal).toBeInstanceOf(ValidationError);
    }),
  );

  it(
    "refuses a registration whose relying-party id does not match this instance, storing nothing",
    withDatabase(async ({ db }) => {
      const begun = await beginEnrolment("Kitchen iPad", undefined, db);

      const refusal = await refusalOf(() =>
        completeRegistration(registrationResponse(begun.options.challenge, { rpID: "attacker.example.com" }), db),
      );
      expect(refusal).toBeInstanceOf(ValidationError);

      const rows = await db.selectFrom("passkey").select("credential_id").execute();
      expect(rows).toHaveLength(0);
    }),
  );
});

describe("removing", () => {
  it(
    "leaves the passkey and its grants in place without the acknowledgement",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedFixturePasskey(seedPasskey);
      const grant = await seedUnlockGrant({ passkeyId: passkey.credentialId });

      const refusal = await refusalOf(() =>
        removePasskey(credentialId, { assertion: undefined, confirmRemoval: undefined }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/one-way/);

      expect(
        await db.selectFrom("passkey").select("credential_id").where("credential_id", "=", credentialId).execute(),
      ).toHaveLength(1);
      expect(await readGrant(grant.id, db)).toBeDefined();
    }),
  );

  it(
    "cannot remove with a live grant but no fresh assertion",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedFixturePasskey(seedPasskey);
      const grant = await seedUnlockGrant({ passkeyId: passkey.credentialId });

      const refusal = await refusalOf(() =>
        removePasskey(credentialId, { assertion: undefined, confirmRemoval: "true" }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/fresh confirmation/);

      // The live grant bought no authority at all: still there afterward.
      expect(await readGrant(grant.id, db)).toBeDefined();
    }),
  );

  it(
    "lets the household's last passkey authorise removing itself, turning the lock off",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const options = await removalAssertionOptions(credentialId, db);

      const { grant } = await removePasskey(
        credentialId,
        { assertion: assertionResponse(options.challenge), confirmRemoval: "true" },
        db,
      );

      expect(grant.passkeyId).toBe(credentialId);
      expect(await isLocked(db)).toBe(false);
      // The cascade takes the grant this same removal minted with it.
      expect(await readGrant(grant.id, db)).toBeUndefined();
    }),
  );

  it(
    "does not let an assertion minted to remove one passkey authorise removing another",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY, credentialId: "bystander" });

      const options = await removalAssertionOptions("bystander", db);
      const scopedToBystander = assertionResponse(options.challenge);

      const refusal = await refusalOf(() =>
        removePasskey(credentialId, { assertion: scopedToBystander, confirmRemoval: "true" }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/not issued for this action/);

      const rows = await db
        .selectFrom("passkey")
        .select("credential_id")
        .where("credential_id", "in", [credentialId, "bystander"])
        .execute();
      expect(rows).toHaveLength(2);
    }),
  );

  it(
    "refuses removing a passkey that does not exist, minting no grant and writing nothing",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const options = await removalAssertionOptions("ghost", db);
      const assertion = assertionResponse(options.challenge);

      await expect(
        removePasskey("ghost", { assertion, confirmRemoval: "true" }, db),
      ).rejects.toThrow(NotFoundError);

      // The target is resolved before the assertion is ever verified (§7 of
      // the review, matching `closeAccount`'s precedent) — so the challenge
      // it minted was never spent, and no grant exists to show for it.
      const grants = await db.selectFrom("unlock_grant").select("id").execute();
      expect(grants).toHaveLength(0);
    }),
  );
});

describe("duplicate credential id", () => {
  it(
    "refuses a duplicate credential id reaching completeRegistration from two connections at once",
    async () => {
      const database = await testDatabase();

      // Guards against a previous crashed run leaving this fixture's shared
      // credential id behind — `tests/lock-schema.test.ts`'s own reasoning
      // for cleaning up both before and after its cross-connection race.
      await database.deleteFrom("passkey").where("credential_id", "=", credentialId).execute();

      const trxA = await database.startTransaction().execute();
      const trxB = await database.startTransaction().execute();
      let bodyFailed = false;

      try {
        const beginA = await beginEnrolment("Device A", undefined, trxA);
        const beginB = await beginEnrolment("Device B", undefined, trxB);

        // A's bootstrap registration lands, uncommitted — a tentative row
        // whose fate B cannot yet know.
        await completeRegistration(registrationResponse(beginA.options.challenge), trxA);

        // B registers the identical credential (the fixture only ever signs
        // one) while A is still open, so Postgres cannot yet say whether A's
        // row will exist. Both rows are flagged bootstrap, so this racing
        // insert can conflict on either unique constraint — a reviewer
        // proved Postgres reports the primary key (`passkey_pkey`) first,
        // not the partial bootstrap index, which is exactly the case the
        // old code's catch did not recognise.
        const blocked = completeRegistration(registrationResponse(beginB.options.challenge), trxB);
        blocked.catch(() => {});

        // Gives B's insert time to actually reach Postgres and block on A's
        // still-uncommitted row before A resolves that race by committing —
        // without it, this is a race against how fast the driver dispatches
        // B's statement, not a race the module's code is being asked to win.
        await new Promise((resolve) => setTimeout(resolve, 100));
        await trxA.commit().execute();

        // Whichever constraint actually fired, this must be a printable
        // refusal — never the raw database error escaping uncaught.
        const refusal = await refusalOf(() => blocked);
        expect(refusal.fieldErrors.form).toMatch(/already enrolled|no longer without one/);
      } catch (error) {
        bodyFailed = true;
        throw error;
      } finally {
        if (!trxA.isCommitted && !trxA.isRolledBack) await trxA.rollback().execute().catch(() => {});
        if (!trxB.isCommitted && !trxB.isRolledBack) await trxB.rollback().execute().catch(() => {});

        let cleanupError: unknown;
        try {
          await database.deleteFrom("passkey").where("credential_id", "=", credentialId).execute();
        } catch (error) {
          cleanupError = error;
        }
        if (cleanupError !== undefined && !bodyFailed) throw cleanupError;
      }
    },
    20_000,
  );
});

describe("counter concurrency", () => {
  it(
    "keeps a lower out-of-order write from undoing an already-committed counter advance",
    async () => {
      const database = await testDatabase();

      await database.deleteFrom("passkey").where("credential_id", "=", credentialId).execute();
      await database
        .insertInto("passkey")
        .values({
          credential_id: credentialId,
          public_key: Buffer.from(publicKey),
          counter: 0,
          transports: joinTransports(transports),
          backup_eligible: backupEligible,
          label: "Race",
          bootstrap: false,
        })
        .execute();

      const trxA = await database.startTransaction().execute();
      const trxB = await database.startTransaction().execute();
      let bodyFailed = false;

      try {
        const optionsA = await unlockOptions(trxA);
        const optionsB = await unlockOptions(trxB);

        // A verifies against the committed counter (0), signs a higher one,
        // and its write lands — uncommitted — inside trxA.
        await verifyUnlock(assertionResponse(optionsA.challenge, { counter: 9 }), trxA);

        // B's verification is issued while A is still open, so the
        // library's own check reads the SAME committed counter (0) A did —
        // the stale read this rule protects against; B's own check passes.
        // Its UPDATE then blocks on A's uncommitted row.
        const blocked = verifyUnlock(assertionResponse(optionsB.challenge, { counter: 3 }), trxB);
        blocked.catch(() => {});

        // Gives B's own read and its update time to actually reach Postgres
        // and block on A's still-uncommitted row before A resolves that
        // race by committing — without it, whether B's own stale-or-fresh
        // read wins is a race against driver dispatch speed, not the
        // property this test is pinning.
        await new Promise((resolve) => setTimeout(resolve, 100));
        await trxA.commit().execute();
        // Once unblocked, Postgres re-evaluates `greatest(passkey.counter, 3)`
        // against A's now-committed row (READ COMMITTED's own rule for a
        // write that waited on another), so B's write does not throw — it
        // simply re-affirms 9. `blocked` therefore resolves normally.
        await blocked;
        await trxB.commit().execute();

        const row = await database
          .selectFrom("passkey")
          .select("counter")
          .where("credential_id", "=", credentialId)
          .executeTakeFirstOrThrow();
        // The property `greatest(...)` exists for: dropping it in favour of
        // an unconditional write would leave this at "3".
        expect(row.counter).toBe("9");
      } catch (error) {
        bodyFailed = true;
        throw error;
      } finally {
        if (!trxA.isCommitted && !trxA.isRolledBack) await trxA.rollback().execute().catch(() => {});
        if (!trxB.isCommitted && !trxB.isRolledBack) await trxB.rollback().execute().catch(() => {});

        let cleanupError: unknown;
        try {
          await database.deleteFrom("passkey").where("credential_id", "=", credentialId).execute();
        } catch (error) {
          cleanupError = error;
        }
        if (cleanupError !== undefined && !bodyFailed) throw cleanupError;
      }
    },
    20_000,
  );
});
