// app/lib/lock.server.ts's WebAuthn ceremonies (docs/adr/0012, docs/specs/lock/02-the-two-ceremonies.md).
// No browser, no route — refusals come from varying the server's expectation (mocked
// ../server/config.ts) or the response's signed content (webauthn.ts's re-signing), never a
// broken signature outright.
// Five describe blocks below drive real cross-connection races against the database rather
// than withDatabase's rolled-back transaction, synchronising through waitUntilBlocked except
// "duplicate credential id", which still sleeps.
import { generateKeyPairSync } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sql, type Kysely } from "kysely";

import { isoCBOR } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, VerifiedAuthenticationResponse } from "@simplewebauthn/server";

import { createDatabase, type Database } from "~/lib/db.server";
import { NotFoundError, ValidationError } from "~/lib/input.server";
import { CHALLENGE_TTL_MS, IDLE_WINDOW_MS, RETURN_PARAM, joinTransports, splitTransports } from "~/lib/lock";

import { closeTestDatabase, testDatabase, withDatabase } from "./support/database.ts";
import type { Fixtures } from "./support/fixtures.ts";
import {
  NO_USER_VERIFICATION_FLAGS,
  assertionResponse,
  backupEligible,
  credentialId,
  expectedOrigin,
  publicKey,
  registrationResponse,
  transports,
} from "./support/webauthn.ts";

// Spied, not replaced — every other test needs the real verification; hoisted since vi.mock's factory runs first.
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

/** Mocks getConfig() so PUBLIC_ORIGIN can vary per test — lock.server.ts reads it fresh on every call, not as a parameter. */
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

function mockPublicOrigin(origin: string): void {
  configOverride.origin = origin;
}

/** expectedOrigin with a different port — same hostname/RP id, isolating "wrong origin" from "wrong RP id". */
const DIFFERENT_PORT_ORIGIN = `${expectedOrigin}:8443`;

const {
  LOCK_COOKIE,
  beginEnrolment,
  clearedLockCookie,
  completeRegistration,
  deleteGrant,
  enrolmentAssertionOptions,
  MAX_LIVE_CHALLENGES_PER_PURPOSE,
  isLocked,
  listPasskeys,
  lockCookie,
  readGrant,
  readLockCookie,
  removalAssertionOptions,
  removePasskey,
  touchGrant,
  unlockOptions,
  verifyUnlock,
} = await import("~/lib/lock.server");

afterAll(closeTestDatabase);

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Silenced so provoked refusals don't spam the run; asserted directly by the logging test.
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
  it("joins no transports as null rather than an empty string", () => {
    // [].join(",") is "" and "".split(",") reads back as one bogus transport (migration 0012).
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

describe("the grant cookie", () => {
  it("carries Secure, HttpOnly and the __Host- prefix, unlike masking's cookie", () => {
    const cookie = lockCookie("a-grant-id");
    expect(cookie).toMatch(/;\s*secure\b/i);
    expect(cookie).toMatch(/;\s*httponly\b/i);
    expect(LOCK_COOKIE.startsWith("__Host-")).toBe(true);
    expect(cookie.startsWith(`${LOCK_COOKIE}=a-grant-id`)).toBe(true);
  });

  it("is SameSite=Lax, never Strict, because the gate's own sign-in bounce is a top-level cross-site return", () => {
    // ADR-0012's first paragraph.
    expect(lockCookie("a-grant-id")).toMatch(/samesite=lax/i);
  });

  it("is scoped to the whole app, and to exactly that", () => {
    // toContain("Path=/") alone would also pass "Path=/settings".
    expect(lockCookie("a-grant-id")).toMatch(/;\s*Path=\/(?:;|$)/);
  });

  it("carries no Domain, which the __Host- prefix forbids and a browser would reject the cookie over", () => {
    expect(lockCookie("a-grant-id")).not.toMatch(/;\s*domain=/i);
    expect(clearedLockCookie()).not.toMatch(/;\s*domain=/i);
  });

  it("expires immediately when cleared, carrying the same Secure and Path attributes a __Host- cookie needs to actually clear", () => {
    const cleared = clearedLockCookie();
    expect(cleared).toMatch(/max-age=0/i);
    expect(cleared).toMatch(/;\s*secure\b/i);
    expect(cleared).toMatch(/;\s*Path=\/(?:;|$)/);
  });
});

describe("the unlock screen's return parameter", () => {
  it("is a stable name shared between the middleware that sets it and the screen that reads it back", () => {
    expect(RETURN_PARAM).toBe("redirectTo");
  });
});

describe("reading the grant cookie off a request", () => {
  const requestWith = (cookie: string): Request =>
    new Request("http://portfolio.local/", { headers: { Cookie: cookie } });

  it("finds its own value among the others a browser sends", () => {
    expect(readLockCookie(requestWith(`_oauth2_proxy=abc; ${LOCK_COOKIE}=grant-1`))).toBe("grant-1");
  });

  it("is undefined when the browser sent no cookies at all", () => {
    expect(readLockCookie(new Request("http://portfolio.local/"))).toBeUndefined();
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
    "sweeps expired grants at the moment a new one is minted",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      const stale = await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY, credentialId: "stale-owner" });
      await seedFixturePasskey(seedPasskey);
      const expired = await seedUnlockGrant({
        passkeyId: stale.credentialId,
        expiresAt: new Date(Date.now() - 1000),
      });

      // No exported mint entry point — reached here through a verified ceremony, like every real caller.
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

  it(
    "deletes only the one grant it is given, leaving a second browser's own grant live — ticket 06's 'Lock now' must never lock the whole household",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY });
      const thisOne = await seedUnlockGrant({ passkeyId: passkey.credentialId });
      const anotherBrowser = await seedUnlockGrant({ passkeyId: passkey.credentialId });

      await deleteGrant(thisOne.id, db);

      expect(await readGrant(thisOne.id, db)).toBeUndefined();
      expect(await readGrant(anotherBrowser.id, db)).toBeDefined();
    }),
  );
});

/** Atomic read-and-maybe-extend (§2 of the review); the read-while-deleted race has its own test below. */
describe("touchGrant", () => {
  it(
    "reads nothing for an id past its expiry, and writes nothing",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY });
      const grant = await seedUnlockGrant({
        passkeyId: passkey.credentialId,
        expiresAt: new Date(Date.now() - 1000),
      });

      expect(await touchGrant(grant.id, db)).toBeUndefined();
      expect(await readGrant(grant.id, db)).toBeUndefined();
    }),
  );

  it(
    "reads nothing for an id that does not exist",
    withDatabase(async ({ db }) => {
      expect(await touchGrant("no-such-grant-id-at-all-xxxxxxxxxxxx", db)).toBeUndefined();
    }),
  );

  it(
    "returns the grant unmodified while more than half the idle window remains",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY });
      const originalExpiry = new Date(Date.now() + IDLE_WINDOW_MS - 5000);
      const grant = await seedUnlockGrant({ passkeyId: passkey.credentialId, expiresAt: originalExpiry });

      expect(await touchGrant(grant.id, db)).toBeDefined();

      const row = await db
        .selectFrom("unlock_grant")
        .select("expires_at")
        .where("id", "=", grant.id)
        .executeTakeFirstOrThrow();
      expect(row.expires_at.getTime()).toBe(originalExpiry.getTime());
    }),
  );

  it(
    "rolls the expiry a fresh window out once at or past half the idle window remains, surviving past its original expiry",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY });
      const originalExpiry = new Date(Date.now() + 1000);
      const grant = await seedUnlockGrant({ passkeyId: passkey.credentialId, expiresAt: originalExpiry });

      expect(await touchGrant(grant.id, db)).toBeDefined();

      const row = await db
        .selectFrom("unlock_grant")
        .select("expires_at")
        .where("id", "=", grant.id)
        .executeTakeFirstOrThrow();
      expect(row.expires_at.getTime()).toBeGreaterThan(originalExpiry.getTime());
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
      // Byte length, not string length — a shorter, non-random encoding could pass a length-only check (migration 0012).
      expect(decodedByteLength(grant.id)).toBe(32);
      expect(grant.passkeyId).toBe(credentialId);
      expect(grant.expiresAt).toBeInstanceOf(Date);
      // Bounded to the idle window itself — a year-long grant would pass every assertion above.
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
      expect(capturedAssertionOptions[0]?.requireUserVerification).toBeUndefined();
    }),
  );

  it(
    "refuses an assertion the authenticator signed without verifying anybody, writing nothing",
    withDatabase(async ({ db, seedPasskey }) => {
      // Library defaults requireUserVerification: true (verifyAuthenticationResponse.js:24), signed
      // with the bit cleared rather than flipped after, so this is the UV refusal, not a broken signature.
      await seedFixturePasskey(seedPasskey, /* counter */ 3);
      const options = await unlockOptions(db);

      // Counter ahead of stored (library checks UV before counter, :175-176/:182-188) so only the missing UV bit can refuse.
      const refusal = await refusalOf(() =>
        verifyUnlock(
          assertionResponse(options.challenge, { counter: 5, flags: NO_USER_VERIFICATION_FLAGS }),
          db,
        ),
      );
      expect(refusal).toBeInstanceOf(ValidationError);
      // Log message, not just instanceof — every library throw collapses into the same ValidationError.
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("assertion (unlock)"),
        expect.objectContaining({ message: expect.stringContaining("User verification required") }),
      );

      const row = await db
        .selectFrom("passkey")
        .select(["counter", "last_used_at"])
        .where("credential_id", "=", credentialId)
        .executeTakeFirstOrThrow();
      expect(row.counter).toBe("3");
      expect(row.last_used_at).toBeNull();
      expect(await db.selectFrom("unlock_grant").select("id").execute()).toHaveLength(0);
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

      // Cap is 500 (§5); eviction runs on the next mint's sweep, so it takes one call past the cap to evict.
      for (let i = 0; i < 501; i++) {
        await unlockOptions(db);
      }

      const refusal = await refusalOf(() => verifyUnlock(assertionResponse(first.challenge), db));
      expect(refusal.fieldErrors.form).toMatch(/never issued/);
    }),
    20_000,
  );

  it(
    "a flood of unlock challenges cannot evict a live enrol challenge (finding 2's partition)",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const enrol = await enrolmentAssertionOptions(db);

      for (let i = 0; i < 501; i++) {
        await unlockOptions(db);
      }

      const { grant } = await beginEnrolment("Second phone", { assertion: assertionResponse(enrol.challenge) }, db);
      expect(grant).toBeDefined();
    }),
    20_000,
  );

  it(
    "a flood of unlock challenges cannot evict a live remove challenge (finding 2's partition)",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const remove = await removalAssertionOptions(credentialId, db);

      for (let i = 0; i < 501; i++) {
        await unlockOptions(db);
      }

      const { grant } = await removePasskey(
        credentialId,
        { assertion: assertionResponse(remove.challenge), confirmRemoval: "true" },
        db,
      );
      expect(grant).toBeDefined();
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
      expect(refusal.fieldErrors.form).toBe("This passkey could not be verified. Try again.");
    }),
  );

  it(
    "names a signature-counter regression rather than asking the family to try again, and writes nothing",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey, /* counter */ 1);
      const options = await unlockOptions(db);

      const refusal = await refusalOf(() => verifyUnlock(assertionResponse(options.challenge), db));
      expect(refusal).toBeInstanceOf(ValidationError);
      expect(refusal.fieldErrors.form).toBe(
        "This passkey's counter went backwards, which can mean a copy of it exists somewhere. " +
          "The check was refused. Remove this passkey from Settings → Passkeys and enrol it again.",
      );

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("assertion (unlock)"),
        expect.anything(),
      );

      const row = await db
        .selectFrom("passkey")
        .select(["counter", "last_used_at"])
        .where("credential_id", "=", credentialId)
        .executeTakeFirstOrThrow();
      expect(row.counter).toBe("1");
      expect(row.last_used_at).toBeNull();
      expect(await db.selectFrom("unlock_grant").select("id").execute()).toHaveLength(0);
    }),
  );

  it(
    "refuses a response verified against the wrong public key, writing nothing",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedPasskey({ publicKey: unrelatedPublicKeyCose(), credentialId, transports });
      const options = await unlockOptions(db);

      const refusal = await refusalOf(() => verifyUnlock(assertionResponse(options.challenge), db));
      expect(refusal).toBeInstanceOf(ValidationError);
      // Wrong key makes verifySignature return false, not throw — the !verified branch, not the catch (RP test above pins that branch).
      expect(refusal.fieldErrors.form).toBe("This passkey could not be verified. Try again.");

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

describe("the challenge map's housekeeping", () => {
  it(
    "tells a reader their confirmation expired rather than that this instance never issued it",
    withDatabase(async ({ db }) => {
      // Used to delete on the instant of expiry — a later mint then read a stale submission as "never issued".
      const base = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(base);

      try {
        const stale = await unlockOptions(db);

        clock.mockReturnValue(base + CHALLENGE_TTL_MS + 1_000);
        // This later mint is what sweeps.
        await unlockOptions(db);

        const refusal = await refusalOf(() => verifyUnlock(assertionResponse(stale.challenge), db));
        expect(refusal.fieldErrors.form).toMatch(/has expired/);
      } finally {
        clock.mockRestore();
      }
    }),
  );

  it(
    "drops a spent confirmation before an unspent one when a purpose is over its budget",
    withDatabase(async ({ db }) => {
      // Used to evict oldest regardless of state — a spend-and-retry flood could evict a confirmation mid-way through.
      const oldest = await unlockOptions(db);
      const spent: string[] = [];

      for (let i = 1; i < MAX_LIVE_CHALLENGES_PER_PURPOSE; i++) {
        const { challenge } = await unlockOptions(db);
        if (i >= 400 && i < 405) {
          await refusalOf(() => verifyUnlock(assertionResponse(challenge), db));
          spent.push(challenge);
        }
      }

      for (let i = 0; i < spent.length; i++) await unlockOptions(db);

      const refusal = await refusalOf(() => verifyUnlock(assertionResponse(oldest.challenge), db));
      expect(refusal.fieldErrors.form).not.toMatch(/never issued/);
    }),
  );

  it(
    "still answers a replayed confirmation with already-used once its purpose has filled its budget",
    withDatabase(async ({ db }) => {
      // Other half of the same bug: a spent entry surviving only matters if its own budget's next mints don't reclaim it.
      const { challenge } = await unlockOptions(db);
      await refusalOf(() => verifyUnlock(assertionResponse(challenge), db));

      for (let i = 0; i < MAX_LIVE_CHALLENGES_PER_PURPOSE; i++) await unlockOptions(db);

      const refusal = await refusalOf(() => verifyUnlock(assertionResponse(challenge), db));
      expect(refusal.fieldErrors.form).toMatch(/already been used/);
    }),
  );

  it(
    "still answers an expired confirmation with expired once its purpose has filled its budget",
    withDatabase(async ({ db }) => {
      const base = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(base);

      try {
        const { challenge } = await unlockOptions(db);
        clock.mockReturnValue(base + CHALLENGE_TTL_MS + 1_000);

        for (let i = 0; i < MAX_LIVE_CHALLENGES_PER_PURPOSE; i++) await unlockOptions(db);

        const refusal = await refusalOf(() => verifyUnlock(assertionResponse(challenge), db));
        expect(refusal.fieldErrors.form).toMatch(/has expired/);
      } finally {
        clock.mockRestore();
      }
    }),
  );
});

describe("enrolling", () => {
  it(
    "lets a request with no grant enrol before any passkey exists, and refuses once one does",
    withDatabase(async ({ db }) => {
      const begun = await beginEnrolment("Kitchen iPad", { assertion: undefined, acknowledgement: "true" }, db);
      expect(begun.grant).toBeUndefined();

      const completed = await completeRegistration(registrationResponse(begun.options.challenge), db);
      expect(completed.passkey.label).toBe("Kitchen iPad");
      expect(completed.grant).toBeDefined();
      expect(await isLocked(db)).toBe(true);

      const refusal = await refusalOf(() => beginEnrolment("Second phone", { assertion: undefined, acknowledgement: "true" }, db));
      expect(refusal.fieldErrors.form).toMatch(/fresh confirmation/);
    }),
  );

  it(
    "issues a registration challenge that decodes to a full 32 bytes",
    withDatabase(async ({ db }) => {
      const { options } = await beginEnrolment("Kitchen iPad", { assertion: undefined, acknowledgement: "true" }, db);
      expect(decodedByteLength(options.challenge)).toBe(32);
    }),
  );

  it(
    "asks for a platform authenticator, required verification and no attestation",
    withDatabase(async ({ db }) => {
      const { options } = await beginEnrolment("Kitchen iPad", { assertion: undefined, acknowledgement: "true" }, db);
      expect(options.authenticatorSelection?.authenticatorAttachment).toBe("platform");
      expect(options.authenticatorSelection?.userVerification).toBe("required");
      expect(options.attestation).toBe("none");
    }),
  );

  it(
    "refuses an empty label without minting or storing anything",
    withDatabase(async ({ db }) => {
      const refusal = await refusalOf(() => beginEnrolment("", { assertion: undefined, acknowledgement: "true" }, db));
      expect(refusal).toBeInstanceOf(ValidationError);
      expect(await isLocked(db)).toBe(false);
    }),
  );

  it(
    "refuses a label carrying a NUL byte before any ceremony could run (finding 3)",
    withDatabase(async ({ db }) => {
      const refusal = await refusalOf(() => beginEnrolment("Kitchen\u0000iPad", { assertion: undefined, acknowledgement: "true" }, db));
      expect(refusal).toBeInstanceOf(ValidationError);
      expect(await isLocked(db)).toBe(false);
    }),
  );

  it(
    "refuses a label carrying a newline",
    withDatabase(async ({ db }) => {
      const refusal = await refusalOf(() => beginEnrolment("Kitchen\niPad", { assertion: undefined, acknowledgement: "true" }, db));
      expect(refusal).toBeInstanceOf(ValidationError);
    }),
  );

  // One example per class beyond C0/C1: separators, an RTL override/isolate (flips reading order), a zero-width space (blank-looking label).
  it.each([
    ["a line separator", "Kitchen\u2028iPad"],
    ["a paragraph separator", "Kitchen\u2029iPad"],
    ["a right-to-left override", "Kitchen\u202EiPad"],
    ["a directional isolate", "Kitchen\u2066iPad"],
    ["a zero width space", "Kitchen\u200BiPad"],
  ])("refuses a label carrying %s", (_case, label) =>
    withDatabase(async ({ db }) => {
      const refusal = await refusalOf(() =>
        beginEnrolment(label, { assertion: undefined, acknowledgement: "true" }, db),
      );
      expect(refusal).toBeInstanceOf(ValidationError);
      expect(await isLocked(db)).toBe(false);
    })(),
  );

  it(
    "trims a separator off either edge rather than refusing it, as it trims a space",
    withDatabase(async ({ db }) => {
      // requiredText trims before this refinement sees the value — an edge separator never reaches it, same as a stray space.
      const { options } = await beginEnrolment(
        "\u2029Kitchen iPad\u2028",
        { assertion: undefined, acknowledgement: "true" },
        db,
      );
      expect(options.user.name).toBe("Kitchen iPad");
    }),
  );

  it(
    "keeps a label whose emoji is held together by a zero width joiner",
    withDatabase(async ({ db }) => {
      // Emoji joined by U+200D — refusing it would also refuse an ordinary chosen label.
      const { options } = await beginEnrolment(
        "\u{1F469}\u200D\u{1F469}\u200D\u{1F467} phone",
        { assertion: undefined, acknowledgement: "true" },
        db,
      );
      expect(options.user.name).toBe("\u{1F469}\u200D\u{1F469}\u200D\u{1F467} phone");
    }),
  );

  it(
    "refuses a label carrying a lone surrogate",
    withDatabase(async ({ db }) => {
      const refusal = await refusalOf(() => beginEnrolment("Kitchen\uD800iPad", { assertion: undefined, acknowledgement: "true" }, db));
      expect(refusal).toBeInstanceOf(ValidationError);
    }),
  );

  it(
    "refuses the household's first passkey without the acknowledgement ticked (finding 11)",
    withDatabase(async ({ db }) => {
      const refusal = await refusalOf(() => beginEnrolment("Kitchen iPad", { assertion: undefined }, db));
      expect(refusal).toBeInstanceOf(ValidationError);
      expect(refusal.fieldErrors.form).toMatch(/tick that acknowledgement/);
      expect(await isLocked(db)).toBe(false);
    }),
  );

  it(
    "ignores the acknowledgement once the household already holds a passkey — enrolling a second changes nothing for anybody",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const assertionOptions = await enrolmentAssertionOptions(db);
      const assertion = assertionResponse(assertionOptions.challenge);

      const { options } = await beginEnrolment("Laptop", { assertion: assertion }, db);
      expect(options.challenge).toBeTruthy();
    }),
  );

  it(
    "excludes already-enrolled credential ids, authorised by a fresh scoped assertion",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const assertionOptions = await enrolmentAssertionOptions(db);
      const assertion = assertionResponse(assertionOptions.challenge);

      const { options, grant } = await beginEnrolment("Laptop", { assertion: assertion }, db);

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
      const { options } = await beginEnrolment("Laptop", { assertion: assertionResponse(assertionOptions.challenge) }, db);

      // "none" attestation carries no signature, so an unrelated public key needs no matching private key.
      const completed = await completeRegistration(
        registrationResponse(options.challenge, {
          credentialId: "second-devic",
          publicKey: unrelatedPublicKeyCose(),
        }),
        db,
      );

      expect(completed.grant).toBeUndefined();
    }),
  );

  it(
    "records backup eligibility from what verification actually reported",
    withDatabase(async ({ db }) => {
      const begun = await beginEnrolment("Kitchen iPad", { assertion: undefined, acknowledgement: "true" }, db);
      await completeRegistration(registrationResponse(begun.options.challenge), db);

      const [row] = await listPasskeys(db);
      // Fixture's signed authData carries backupEligible — a seeded row alone can't prove this was read off verification.
      expect(row?.backupEligible).toBe(backupEligible);
    }),
  );

  it(
    "refuses a duplicate enrolment of a credential already stored, rather than creating a row",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const assertionOptions = await enrolmentAssertionOptions(db);
      const { options } = await beginEnrolment("Laptop", { assertion: assertionResponse(assertionOptions.challenge) }, db);

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
      const begun = await beginEnrolment("Kitchen iPad", { assertion: undefined, acknowledgement: "true" }, db);

      // Simulates a second bootstrap landing in between — ticket 01's passkey_bootstrap_idx; the conditional insert finds the table no longer empty.
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
    "refuses a bootstrap registration once an ordinary passkey landed while it was in flight",
    withDatabase(async ({ db, seedPasskey }) => {
      const begun = await beginEnrolment("Kitchen iPad", { assertion: undefined, acknowledgement: "true" }, db);

      // Twin of the test above with an ordinary (non-bootstrap) interloper, so only where-not-exists can refuse, not the partial index.
      await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY, credentialId: "already-there", bootstrap: false });

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
      await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY });
      const unlockOpts = await unlockOptions(db);
      const scopedToUnlock = assertionResponse(unlockOpts.challenge);

      const refusal = await refusalOf(() => beginEnrolment("Laptop", { assertion: scopedToUnlock }, db));
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
      // Wrong purpose only — an unknown challenge refuses before purpose.kind is even read (see the "never issued" test above).
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
      const begun = await beginEnrolment("Kitchen iPad", { assertion: undefined, acknowledgement: "true" }, db);

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
      const begun = await beginEnrolment("Kitchen iPad", { assertion: undefined, acknowledgement: "true" }, db);

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
    "leaves the passkey, its grants and the assertion itself alone when a valid removal arrives without the acknowledgement",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      // Every other test of this refusal sends no assertion; this one sends one that would otherwise succeed.
      const passkey = await seedFixturePasskey(seedPasskey);
      const grant = await seedUnlockGrant({ passkeyId: passkey.credentialId });
      const options = await removalAssertionOptions(credentialId, db);
      const assertion = assertionResponse(options.challenge);

      const refusal = await refusalOf(() =>
        removePasskey(credentialId, { assertion, confirmRemoval: undefined }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/one-way/);

      expect(
        await db.selectFrom("passkey").select("credential_id").where("credential_id", "=", credentialId).execute(),
      ).toHaveLength(1);
      expect(await readGrant(grant.id, db)).toBeDefined();
      expect(await db.selectFrom("unlock_grant").select("id").execute()).toHaveLength(1);

      // Challenge unspent too — the same assertion still works below.
      const { grant: minted } = await removePasskey(credentialId, { assertion, confirmRemoval: "true" }, db);
      expect(minted.passkeyId).toBe(credentialId);
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

      // Target resolved before verification (§7, matching closeAccount's precedent) — challenge never spent.
      const grants = await db.selectFrom("unlock_grant").select("id").execute();
      expect(grants).toHaveLength(0);
    }),
  );
});

/** Library forwards two client values unjudged — transports verbatim, attested credential id at whatever length claimed. */
describe("what a registration may store", () => {
  async function beginRegistration(db: Kysely<Database>): Promise<string> {
    const { options } = await beginEnrolment("Kitchen iPad", { assertion: undefined, acknowledgement: "true" }, db);
    return options.challenge;
  }

  it.each([
    ["a string where a list belongs", "internal,hybrid"],
    ["a number", 7],
    ["an explicit null rather than an absent field", null],
    ["an object", {}],
    ["an entry that is the empty string", [""]],
    ["an entry carrying the separator the reader splits on", ["a,b"]],
    ["an entry longer than any transport is", ["a".repeat(40)]],
    ["more entries than any authenticator has", Array.from({ length: 20_000 }, () => "internal")],
  ])("refuses a registration whose reported transports are %s", (_case, hostile) =>
    withDatabase(async ({ db }) => {
      const challenge = await beginRegistration(db);

      const refusal = await refusalOf(() =>
        completeRegistration(registrationResponse(challenge, { transports: hostile }), db),
      );
      expect(refusal).toBeInstanceOf(ValidationError);
      expect(refusal.fieldErrors.form).toMatch(/listed how it can be reached/);

      expect(await db.selectFrom("passkey").select("credential_id").execute()).toHaveLength(0);
    })(),
  );

  it(
    "stores a registration that reported no transports at all, which is a real answer",
    withDatabase(async ({ db }) => {
      const challenge = await beginRegistration(db);

      const { passkey } = await completeRegistration(
        registrationResponse(challenge, { transports: undefined }),
        db,
      );

      expect(passkey.credentialId).toBe(credentialId);
      const [row] = await db.selectFrom("passkey").select("transports").execute();
      // null, never '' — migration 0012's comment says the writer must never produce that.
      expect(row?.transports).toBeNull();
    }),
  );

  it(
    "refuses a registration whose authenticator attested a credential id of no bytes at all",
    withDatabase(async ({ db }) => {
      const challenge = await beginRegistration(db);

      const refusal = await refusalOf(() =>
        completeRegistration(
          registrationResponse(challenge, { attestedCredentialId: new Uint8Array(0) }),
          db,
        ),
      );
      expect(refusal.fieldErrors.form).toMatch(/an identifier of a length/);

      // The assertion that matters — a stored "" would ride in every browser's allowCredentials from the next unlock on.
      expect(await db.selectFrom("passkey").select("credential_id").execute()).toHaveLength(0);
    }),
  );

  it(
    "refuses a registration whose attested credential id is past the specification's ceiling",
    withDatabase(async ({ db }) => {
      const challenge = await beginRegistration(db);

      const refusal = await refusalOf(() =>
        completeRegistration(
          registrationResponse(challenge, { attestedCredentialId: new Uint8Array(1024) }),
          db,
        ),
      );
      expect(refusal.fieldErrors.form).toMatch(/an identifier of a length/);

      expect(await db.selectFrom("passkey").select("credential_id").execute()).toHaveLength(0);
    }),
  );

  it(
    "refuses a registration whose attested credential id is not the one its own response named",
    withDatabase(async ({ db }) => {
      const challenge = await beginRegistration(db);

      // Library compares id to rawId, neither to the attested bytes — verification passes, storing an id no browser would send back.
      const refusal = await refusalOf(() =>
        completeRegistration(
          registrationResponse(challenge, { attestedCredentialId: new Uint8Array([9, 9, 9, 9]) }),
          db,
        ),
      );
      expect(refusal.fieldErrors.form).toMatch(/two different things/);

      expect(await db.selectFrom("passkey").select("credential_id").execute()).toHaveLength(0);
    }),
  );
});

/** Each hostile shape here threw a TypeError before narrowAssertion/narrowRegistration existed (CLAUDE.md's
 * "Zod at the boundaries only") — must refuse, never throw. verifyUnlock carries all four shapes; the other
 * three entry points carry one each, confirming every entry narrows. */
describe("hostile responses", () => {
  it(
    "refuses an empty object rather than throwing when unlocking",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const refusal = await refusalOf(() => verifyUnlock({}, db));
      expect(refusal.fieldErrors.form).toMatch(/could not be read/);
    }),
  );

  it(
    "refuses a null response field rather than throwing when unlocking",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const refusal = await refusalOf(() => verifyUnlock({ id: credentialId, response: null }, db));
      expect(refusal.fieldErrors.form).toMatch(/could not be read/);
    }),
  );

  it(
    "refuses a response missing its id rather than throwing when unlocking",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const refusal = await refusalOf(() =>
        verifyUnlock({ response: { clientDataJSON: "e30" } }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/could not be read/);
    }),
  );

  it(
    "refuses a clientDataJSON that is not valid base64url rather than throwing when unlocking",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const refusal = await refusalOf(() =>
        verifyUnlock({ id: credentialId, response: { clientDataJSON: "@@@ not base64url @@@" } }, db),
      );
      // decodeChallenge's own try/catch turns the decode failure into this refusal.
      expect(refusal.fieldErrors.form).toMatch(/client data could not be read/);
    }),
  );

  it(
    "refuses a clientDataJSON that decodes to something other than JSON rather than throwing when unlocking",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const notJson = Buffer.from("not json at all").toString("base64url");
      const refusal = await refusalOf(() =>
        verifyUnlock({ id: credentialId, response: { clientDataJSON: notJson } }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/client data could not be read/);
    }),
  );

  it(
    "refuses an empty object rather than throwing when completing a registration",
    withDatabase(async ({ db }) => {
      const refusal = await refusalOf(() => completeRegistration({}, db));
      expect(refusal.fieldErrors.form).toMatch(/could not be read/);
    }),
  );

  it(
    "refuses an empty object rather than throwing when its assertion authorises an enrolment",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const refusal = await refusalOf(() => beginEnrolment("New device", { assertion: {} }, db));
      expect(refusal.fieldErrors.form).toMatch(/could not be read/);
    }),
  );

  it(
    "refuses an empty object rather than throwing when its assertion authorises a removal, writing nothing",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const refusal = await refusalOf(() =>
        removePasskey(credentialId, { assertion: {}, confirmRemoval: "true" }, db),
      );
      expect(refusal.fieldErrors.form).toMatch(/could not be read/);

      expect(
        await db.selectFrom("passkey").select("credential_id").where("credential_id", "=", credentialId).execute(),
      ).toHaveLength(1);
    }),
  );
});


/** Every verified assertion mints one grant per browser; before this rule an unlock, an enrolment confirm and a
 * removal left three live rows, and "Lock now" ended only one. supersedes is the request's own cookie, as routes hand it down. */
describe("one live grant per browser", () => {
  it(
    "leaves one live grant behind an unlock, an enrolment confirm and a removal made by the same browser",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY, credentialId: "bystander" });

      const unlock = await unlockOptions(db);
      const first = await verifyUnlock(assertionResponse(unlock.challenge), db);

      const enrol = await enrolmentAssertionOptions(db);
      const begun = await beginEnrolment(
        "Second phone",
        { assertion: assertionResponse(enrol.challenge), supersedes: first.id },
        db,
      );
      const second = begun.grant;
      if (second === undefined) throw new Error("An authorised enrolment must mint a grant.");

      // Signer is the fixture credential, target is bystander — ordinary case, not the exception below.
      const removal = await removalAssertionOptions("bystander", db);
      const { grant: third } = await removePasskey(
        "bystander",
        {
          assertion: assertionResponse(removal.challenge),
          confirmRemoval: "true",
          supersedes: second.id,
        },
        db,
      );

      expect(await readGrant(first.id, db)).toBeUndefined();
      expect(await readGrant(second.id, db)).toBeUndefined();
      expect(await readGrant(third.id, db)).toBeDefined();

      // Whole table, not just the three ids — nothing else may be live for this household either.
      const live = await db.selectFrom("unlock_grant").select("id").execute();
      expect(live.map((row) => row.id)).toEqual([third.id]);
    }),
  );

  it(
    "keeps the prior grant when the removal's signer is the passkey being removed, which is the one grant left",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      // Removal signed by target (the passkey being removed), which ADR-0012 allows — superseding mine too would leave the browser with nothing live.
      const mine = await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY, credentialId: "mine" });
      await seedFixturePasskey(seedPasskey);
      const prior = await seedUnlockGrant({ passkeyId: mine.credentialId });

      const removal = await removalAssertionOptions(credentialId, db);
      const { grant: minted } = await removePasskey(
        credentialId,
        {
          assertion: assertionResponse(removal.challenge),
          confirmRemoval: "true",
          supersedes: prior.id,
        },
        db,
      );

      expect(await readGrant(prior.id, db)).toBeDefined();
      expect(await readGrant(minted.id, db)).toBeUndefined();

      const live = await db.selectFrom("unlock_grant").select("id").execute();
      expect(live.map((row) => row.id)).toEqual([prior.id]);
    }),
  );

  it(
    "mints normally when the cookie names a grant that no longer exists",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);

      const unlock = await unlockOptions(db);
      const grant = await verifyUnlock(
        assertionResponse(unlock.challenge),
        db,
        "a-grant-id-this-instance-never-minted",
      );

      expect(await readGrant(grant.id, db)).toBeDefined();
      const live = await db.selectFrom("unlock_grant").select("id").execute();
      expect(live.map((row) => row.id)).toEqual([grant.id]);
    }),
  );
});

/** Polls real database state (never a fixed delay) until pid is genuinely blocked on a lock — bounded so a real deadlock fails loudly. */
async function waitUntilBlocked(
  watcher: Kysely<Database>,
  pid: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await sql<{ blocked: boolean }>`
      select exists (
        select 1 from pg_stat_activity where pid = ${pid} and wait_event_type = 'Lock'
      ) as blocked
    `.execute(watcher);
    if (result.rows[0]?.blocked === true) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for backend ${pid} to block on a lock — ` +
          "either the race this test drives no longer contends on the row it expects to, " +
          "or something is genuinely stuck.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function backendPid(handle: Kysely<Database>): Promise<number> {
  const result = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(handle);
  return result.rows[0]!.pid;
}

describe("duplicate credential id", () => {
  it(
    "refuses a duplicate credential id reaching completeRegistration from two connections at once",
    async () => {
      const database = await testDatabase();

      // Guards a crashed prior run's leftover row — same reasoning as lock-schema.test.ts's cleanup.
      await database.deleteFrom("passkey").where("credential_id", "=", credentialId).execute();

      const trxA = await database.startTransaction().execute();
      const trxB = await database.startTransaction().execute();
      let bodyFailed = false;

      try {
        const beginA = await beginEnrolment("Device A", { assertion: undefined, acknowledgement: "true" }, trxA);
        const beginB = await beginEnrolment("Device B", { assertion: undefined, acknowledgement: "true" }, trxB);

        // A's registration lands, uncommitted — B can't yet know its fate.
        await completeRegistration(registrationResponse(beginA.options.challenge), trxA);

        // B registers the same credential while A is open — Postgres reports passkey_pkey first, which the old code's catch didn't recognize.
        const blocked = completeRegistration(registrationResponse(beginB.options.challenge), trxB);
        blocked.catch(() => {});

        // Lets B's insert reach Postgres and block before A commits — without it this races dispatch speed, not the module.
        await new Promise((resolve) => setTimeout(resolve, 100));
        await trxA.commit().execute();

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

describe("concurrent bootstrap registrations", () => {
  it(
    "lets exactly one of two bootstrap registrations with distinct credential ids land",
    async () => {
      // Partial index's half of the race — distinct ids leave the primary key nothing to say, only passkey_bootstrap_idx can refuse.
      const database = await testDatabase();
      const otherCredentialId = "second-devic";
      const both = [credentialId, otherCredentialId];

      await database.deleteFrom("passkey").where("credential_id", "in", both).execute();

      const trxA = await database.startTransaction().execute();
      const trxB = await database.startTransaction().execute();
      let bodyFailed = false;

      try {
        const beginA = await beginEnrolment("Device A", { assertion: undefined, acknowledgement: "true" }, trxA);
        const beginB = await beginEnrolment("Device B", { assertion: undefined, acknowledgement: "true" }, trxB);

        await completeRegistration(registrationResponse(beginA.options.challenge), trxA);

        // B's where-not-exists can't see A's uncommitted row — proceeds, then blocks on A's index entry.
        const blocked = completeRegistration(
          registrationResponse(beginB.options.challenge, {
            credentialId: otherCredentialId,
            publicKey: unrelatedPublicKeyCose(),
          }),
          trxB,
        );
        blocked.catch(() => {});

        // Polled, not guessed — a fixed sleep could let A commit first, and B's own where-not-exists would refuse instead, pinning nothing.
        const pidB = await backendPid(trxB);
        await waitUntilBlocked(database, pidB);
        await trxA.commit().execute();

        const refusal = await refusalOf(() => blocked);
        expect(refusal.fieldErrors.form).toMatch(/no longer without one/);

        const landed = await database
          .selectFrom("passkey")
          .select("credential_id")
          .where("credential_id", "in", both)
          .execute();
        expect(landed.map((row) => row.credential_id)).toEqual([credentialId]);
      } catch (error) {
        bodyFailed = true;
        throw error;
      } finally {
        if (!trxA.isCommitted && !trxA.isRolledBack) await trxA.rollback().execute().catch(() => {});
        if (!trxB.isCommitted && !trxB.isRolledBack) await trxB.rollback().execute().catch(() => {});

        let cleanupError: unknown;
        try {
          await database.deleteFrom("passkey").where("credential_id", "in", both).execute();
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
        // B's own connection — watched so the test knows, not guesses, when its UPDATE blocks.
        const pidB = await backendPid(trxB);

        // A verifies against committed counter 0, signs higher — write lands uncommitted.
        await verifyUnlock(assertionResponse(optionsA.challenge, { counter: 9 }), trxA);

        // B reads the same committed counter 0 (the stale read this rule guards against); its check passes, then its UPDATE blocks on A's row.
        const blocked = verifyUnlock(assertionResponse(optionsB.challenge, { counter: 3 }), trxB);
        blocked.catch(() => {});

        // Polled via a third connection — a fixed delay would only guess B had time to reach Postgres.
        await waitUntilBlocked(database, pidB);
        await trxA.commit().execute();
        // Unblocked, greatest(counter, 3) re-evaluates against A's now-committed row (READ COMMITTED) — B's write re-affirms 9, doesn't throw.
        await blocked;
        await trxB.commit().execute();

        const row = await database
          .selectFrom("passkey")
          .select("counter")
          .where("credential_id", "=", credentialId)
          .executeTakeFirstOrThrow();
        // What greatest(...) exists for — an unconditional write would leave this at "3".
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

describe("passkey removed mid-verification", () => {
  it(
    "refuses with a printable message, not the raw foreign-key violation, when a concurrent removal wins the race",
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
        const optionsB = await unlockOptions(trxB);
        // B's own connection — watched so the test knows when its counter update blocks.
        const pidB = await backendPid(trxB);

        // A removes the very passkey B is about to verify against, uncommitted — B can't yet know.
        await trxA.deleteFrom("passkey").where("credential_id", "=", credentialId).execute();

        // B verifies against the pre-delete snapshot (READ COMMITTED) so it succeeds; its counter UPDATE then blocks on A's locked row.
        const blocked = verifyUnlock(assertionResponse(optionsB.challenge), trxB);
        blocked.catch(() => {});

        await waitUntilBlocked(database, pidB);
        await trxA.commit().execute();

        // Unblocked, B's UPDATE matches zero rows silently — mintGrant's own insert (not a row-count check) is what discovers the passkey gone, refusing rather than a raw fkey violation.
        const refusal = await refusalOf(() => blocked);
        expect(refusal.fieldErrors.form).toMatch(/removed while this confirmation/);

        const grants = await database.selectFrom("unlock_grant").select("id").execute();
        expect(grants).toHaveLength(0);
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

describe("touchGrant, deleted mid-touch", () => {
  it(
    "reports a grant deleted by a since-committed concurrent request as gone, never the stale snapshot its own read held a lock against",
    async () => {
      const database = await testDatabase();
      const racePasskeyId = "touch-grant-race-passkey";
      const raceGrantId = "touch-grant-race-grant-000000000000000000000000";

      // Guards a crashed prior run's leftover rows — same cleanup reasoning as the races above.
      await database.deleteFrom("passkey").where("credential_id", "=", racePasskeyId).execute();
      await database
        .insertInto("passkey")
        .values({
          credential_id: racePasskeyId,
          public_key: Buffer.from(BYSTANDER_PUBLIC_KEY),
          counter: 0,
          transports: null,
          backup_eligible: false,
          label: "Race",
          bootstrap: false,
        })
        .execute();
      await database
        .insertInto("unlock_grant")
        .values({
          id: raceGrantId,
          passkey_id: racePasskeyId,
          // Comfortably in the future — this race is about a concurrent deletion, not
          // whether the grant is due for extension.
          expires_at: new Date(Date.now() + 60 * 60 * 1000),
        })
        .execute();

      const trxA = await database.startTransaction().execute();
      const trxB = await database.startTransaction().execute();
      let bodyFailed = false;

      try {
        // B's own connection — watched so the test knows when its read blocks.
        const pidB = await backendPid(trxB);

        // A deletes the very grant B is about to touch, uncommitted — B can't yet know.
        await trxA.deleteFrom("unlock_grant").where("id", "=", raceGrantId).execute();

        // touchGrant's SELECT ... FOR UPDATE blocks here — without that lock, B would snapshot before A's delete and report the grant live regardless.
        const blocked = touchGrant(raceGrantId, trxB);
        blocked.catch(() => {});

        await waitUntilBlocked(database, pidB);
        await trxA.commit().execute();

        // Unblocked, B's FOR UPDATE re-checks the row's now-committed (gone) state, not the pre-delete row it blocked against.
        expect(await blocked).toBeUndefined();
      } catch (error) {
        bodyFailed = true;
        throw error;
      } finally {
        if (!trxA.isCommitted && !trxA.isRolledBack) await trxA.rollback().execute().catch(() => {});
        if (!trxB.isCommitted && !trxB.isRolledBack) await trxB.rollback().execute().catch(() => {});

        let cleanupError: unknown;
        try {
          // Passkey's own cascade takes any surviving grant row with it.
          await database.deleteFrom("passkey").where("credential_id", "=", racePasskeyId).execute();
        } catch (error) {
          cleanupError = error;
        }
        if (cleanupError !== undefined && !bodyFailed) throw cleanupError;
      }
    },
    20_000,
  );
});
