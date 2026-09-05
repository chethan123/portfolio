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
 * Five `describe` blocks below — `duplicate credential id`, `concurrent
 * bootstrap registrations`, `counter concurrency`, `passkey removed
 * mid-verification` and `touchGrant, deleted mid-touch` — drive genuine
 * cross-connection races against the real test database rather than
 * `withDatabase`'s single rolled-back transaction, the same reason
 * `tests/lock-schema.test.ts` does for `passkey_bootstrap_idx`. Each cleans
 * up its own committed rows at both ends, the way that file does, because
 * they share `tests/support/webauthn.ts`'s one signable credential id with
 * every `withDatabase` test here. All but `duplicate credential id`
 * synchronise through {@link waitUntilBlocked} — polling real, observable
 * database state rather than a fixed delay — so the interleaving each pins
 * is not a guess about timing that a loaded runner can guess wrong; that one
 * still sleeps, and races only against how fast the driver dispatches a
 * statement rather than against which of two refusals fires.
 */
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

describe("the grant cookie", () => {
  // Pinned the way masking's is pinned (tests/masking.test.ts) — the same
  // kind of test, not the same values: this cookie carries the id of a live
  // unlock rather than a preference, so it parts company with masking's on
  // exactly the two attributes that matter for that (ticket 03).
  it("carries Secure, HttpOnly and the __Host- prefix, unlike masking's cookie", () => {
    const cookie = lockCookie("a-grant-id");
    expect(cookie).toMatch(/;\s*secure\b/i);
    expect(cookie).toMatch(/;\s*httponly\b/i);
    expect(LOCK_COOKIE.startsWith("__Host-")).toBe(true);
    expect(cookie.startsWith(`${LOCK_COOKIE}=a-grant-id`)).toBe(true);
  });

  it("is SameSite=Lax, never Strict, because the gate's own sign-in bounce is a top-level cross-site return", () => {
    // `Strict` would withhold this cookie on that very navigation and
    // re-lock every browser on the weekly sign-in bounce the gate's own
    // seven-day, non-rolling cookie eventually forces (ADR-0012's first
    // paragraph) — a random-looking bug rather than anything this feature
    // did (ADR-0012's own reasoning, restated as a test rather than only a
    // comment).
    expect(lockCookie("a-grant-id")).toMatch(/samesite=lax/i);
  });

  it("is scoped to the whole app, and to exactly that", () => {
    // `toContain("Path=/")` alone also accepts `Path=/settings`, which would
    // scope the grant to one screen and lock every other one; the attribute
    // has to *end* there.
    expect(lockCookie("a-grant-id")).toMatch(/;\s*Path=\/(?:;|$)/);
  });

  it("carries no Domain, which the __Host- prefix forbids and a browser would reject the cookie over", () => {
    // The absence of an attribute, which no other test here checks: a
    // `Domain=` added to either builder makes every browser drop the cookie
    // outright, so the lock would refuse every request and no assertion on
    // the four attributes that *are* present would notice.
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

/**
 * `touchGrant` replaces the middleware's old `readGrant` then `extendGrant`
 * pair with the one atomic read-and-maybe-extend statement §2 of the review
 * this file folds in asked for — the tests below pin the same three
 * outcomes `readGrant`/`extendGrant` used to split across two calls, now
 * from the one call the middleware actually makes. The genuinely
 * concurrent race — a grant deleted while `touchGrant` is reading it —
 * has its own two-connection test beside this file's other such races,
 * further down.
 */
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
      // Never resurrected: touching an already-expired grant did not roll it
      // forward on the strength of merely being asked.
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
      // Left at the library's own default (`true`) rather than restated.
      // This pins only that it was not restated; that the default is
      // actually in force is the signed assertion below.
      expect(capturedAssertionOptions[0]?.requireUserVerification).toBeUndefined();
    }),
  );

  it(
    "refuses an assertion the authenticator signed without verifying anybody, writing nothing",
    withDatabase(async ({ db, seedPasskey }) => {
      // The library's default is `requireUserVerification: true`
      // (`authentication/verifyAuthenticationResponse.js:24`) and it refuses
      // at `:175-176`. Signed with the bit cleared rather than flipped after
      // signing, so the refusal is the UV rule rather than a broken
      // signature — the same re-signing the `counter` and `rpID` options do.
      await seedFixturePasskey(seedPasskey, /* counter */ 3);
      const options = await unlockOptions(db);

      // Signed with a counter *ahead* of the stored one, deliberately. The
      // library checks user verification first (`:175-176`) and the counter
      // after (`:182-188`), so on this code either counter refuses and the
      // choice looks arbitrary. It is not: the case this test exists for is
      // the one where UV enforcement has gone — and there a counter at or
      // below the stored one refuses on the counter instead, so the test
      // would stay green while pinning nothing. Ahead of it, there is
      // nothing left to refuse but the missing UV bit, and the stored 3
      // below is what a wrongly-accepted assertion would have moved to 5.
      const refusal = await refusalOf(() =>
        verifyUnlock(
          assertionResponse(options.challenge, { counter: 5, flags: NO_USER_VERIFICATION_FLAGS }),
          db,
        ),
      );
      expect(refusal).toBeInstanceOf(ValidationError);
      // Which refusal, not merely that there was one: every library throw
      // collapses into the same `ValidationError` here, so without this the
      // test would stay green if the fixture ever stopped signing a
      // non-default `flags` correctly — pinning a broken signature rather
      // than the rule. The operator's own log carries the cause, and the
      // counter test below asserts it the same way.
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

      // 500 is `lock.server.ts`'s own cap (§5 of the review): the map holds
      // `first` plus 500 more once this loop ends (501 total), and eviction
      // only runs on the *next* mint's sweep — so it takes one more call
      // past the cap, not merely reaching it, to actually force `first` out.
      for (let i = 0; i < 501; i++) {
        await unlockOptions(db);
      }

      // Evicted, not merely unspent: a spent-or-expired refusal would be the
      // wrong sentence here and would mean the cap did not actually apply —
      // this is the "unlock" purpose's own budget (finding 2's partition),
      // exercised in isolation from the other three.
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

      // The one purpose an un-granted browser can reach at all, flooded past
      // its own budget — the exact repro finding 2 describes against
      // `/unlock` itself, minted straight against the domain module here.
      for (let i = 0; i < 501; i++) {
        await unlockOptions(db);
      }

      // Not evicted: the enrol challenge minted before the flood still
      // verifies, rather than refusing "never issued" for a confirmation
      // that really was issued.
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
      // The generic sentence, and the one test that catches the counter match
      // being loosened: match on `instanceof Error` alone and this refusal
      // starts telling a household their passkey may have been copied. It is
      // the only such guard here, and not the sharpest available — a response
      // signed with the user-verification bit clear throws from *inside*
      // `verifyAuthenticationResponse`, six lines above the counter check
      // rather than thirty-three — but producing one needs a `flags` option
      // on `assertionResponse` that ticket 02 adds; this is what exists
      // today.
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
      // A counter that went backwards is the one signal WebAuthn gives a
      // household it can act on. "Try again" reads as a transient failure
      // they will retry until the idle window passes.
      expect(refusal.fieldErrors.form).toBe(
        "This passkey's counter went backwards, which can mean a copy of it exists somewhere. " +
          "The check was refused. Remove this passkey from Settings → Passkeys and enrol it again.",
      );

      // The operator's own log still names the ceremony and carries the
      // library's real cause, rather than the failure being logged and
      // ignored.
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("assertion (unlock)"),
        expect.anything(),
      );

      // Nothing written, the same as the wrong-key refusal below.
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
      // The generic sentence. Note where this one comes from: a wrong public
      // key makes `verifySignature` answer false rather than throw, so this
      // refusal is the `!verified.verified` branch and never passes the
      // catch at all. The relying-party test above is the one that pins the
      // counter branch's own reach.
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

/**
 * The challenge map's own housekeeping — the two rules that decide whether a
 * family member is told something true when a ceremony goes wrong. Driven
 * against the real module-level map, since that is where both rules live.
 */
describe("the challenge map's housekeeping", () => {
  it(
    "tells a reader their confirmation expired rather than that this instance never issued it",
    withDatabase(async ({ db }) => {
      // The sweep used to delete on the instant of expiry, so the next mint
      // by anybody made a stale submission read as "never issued by this
      // instance" — true of the map, false about what happened, and the more
      // alarming of the two to somebody who simply took too long.
      const base = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(base);

      try {
        const stale = await unlockOptions(db);

        clock.mockReturnValue(base + CHALLENGE_TTL_MS + 1_000);
        // A later ceremony, which is what sweeps.
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
      // Eviction used to take the oldest of the kind whatever its state, so
      // a flood of spend-and-retry cycles evicted the confirmation somebody
      // was in the middle of. The oldest below is unspent and must survive;
      // the ones spent in the middle are what the budget should reclaim.
      const oldest = await unlockOptions(db);
      const spent: string[] = [];

      for (let i = 1; i < MAX_LIVE_CHALLENGES_PER_PURPOSE; i++) {
        const { challenge } = await unlockOptions(db);
        // Spend a handful from the middle, well away from the oldest.
        if (i >= 400 && i < 405) {
          await refusalOf(() => verifyUnlock(assertionResponse(challenge), db));
          spent.push(challenge);
        }
      }

      // Past the budget, so eviction runs.
      for (let i = 0; i < spent.length; i++) await unlockOptions(db);

      const refusal = await refusalOf(() => verifyUnlock(assertionResponse(oldest.challenge), db));
      // Whatever else it says, not that this instance never issued it: the
      // oldest is unspent, and the spent ones were there to be taken first.
      expect(refusal.fieldErrors.form).not.toMatch(/never issued/);
    }),
  );

  it(
    "still answers a replayed confirmation with already-used once its purpose has filled its budget",
    withDatabase(async ({ db }) => {
      // The other half of the same rule, and the one a single budget got
      // wrong in the opposite direction: keeping a spent entry is only worth
      // anything if the next five hundred mints do not reclaim it. They have
      // their own budget, so they do not.
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
      // The bootstrap case mints a grant — the browser that enrolled the
      // first passkey must not be locked out by its own redirect back.
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
      // Refused at this end of the ceremony, not after `completeRegistration`'s
      // own insert — the browser never even creates a credential.
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

  // One example per class the label rule refuses beyond C0/C1. Each is a
  // character a reader cannot see in the list this label prints in: a line
  // separator the message already promises against, an override and an
  // isolate that can make a row read back to front so the wrong passkey is
  // removed, and a zero width space that makes a label look blank or look
  // identical to another.
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
    "keeps a label whose emoji is held together by a zero width joiner",
    withDatabase(async ({ db }) => {
      // The deliberate exception. A family emoji is a sequence joined by
      // U+200D, and refusing the joiner to catch an invisible character
      // would refuse an ordinary label somebody actually chose.
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

      // A distinct credential id from the one proving the assertion above —
      // "none" attestation carries no signature, so a second, unrelated
      // public key needs no private key to register successfully here.
      const completed = await completeRegistration(
        registrationResponse(options.challenge, {
          credentialId: "second-devic",
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
      const begun = await beginEnrolment("Kitchen iPad", { assertion: undefined, acknowledgement: "true" }, db);
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
    "refuses a bootstrap registration once an ordinary passkey landed while it was in flight",
    withDatabase(async ({ db, seedPasskey }) => {
      const begun = await beginEnrolment("Kitchen iPad", { assertion: undefined, acknowledgement: "true" }, db);

      // The twin of the test above, and the one that pins the conditional
      // insert on its own. There the interloper is flagged `bootstrap`, so
      // `passkey_bootstrap_idx` refuses before the insert's own predicate
      // ever decides anything; here it is an ordinary passkey — the state a
      // household reaches after "bootstrap A, enrol B, remove A" — so the
      // index sees nothing to conflict with and only
      // `where not exists (select 1 from passkey)` is left to say no.
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
      // Any enrolled passkey makes the household locked, so `beginEnrolment`
      // actually inspects the assertion instead of taking the bootstrap path.
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
      // Every other test of this refusal sends no assertion at all, so the
      // passkey survives whichever of the two checks fires and deleting the
      // acknowledgement check changes only a message. This one sends an
      // assertion that would otherwise succeed.
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
      // Nothing minted: the assertion was never verified.
      expect(await db.selectFrom("unlock_grant").select("id").execute()).toHaveLength(1);

      // And the challenge was never spent, which is the other half of
      // "still ahead of verification": the very same assertion still works.
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

/**
 * What a registration is allowed to *store*. The library forwards two values
 * from the client without judging them — `transports` verbatim, and the
 * attested credential id at whatever length the authenticator claimed — so
 * these drive `completeRegistration` with answers no honest authenticator
 * sends and assert both the refusal and that nothing landed.
 */
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
      // `null`, never `''` — the value migration 0012's own comment says the
      // writer must never produce.
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

      // The one that mattered: a stored `""` would ride in every browser's
      // `allowCredentials` from the next unlock onwards.
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

      // The library compares `id` to `rawId` and neither of them to the
      // attested bytes, so this passes verification and would be stored under
      // an id no browser will ever send back.
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

/**
 * A WebAuthn response is client-submitted JSON, so every exported function
 * that takes one accepts `unknown` and narrows the outer shape it actually
 * dereferences (the id, the client data) before reading it — CLAUDE.md's
 * "Zod at the boundaries only, in the domain module". Each hostile shape
 * below dereferenced straight into a `TypeError` before that narrowing
 * existed: a `{}` or a null `response` has no `.response.clientDataJSON` to
 * read, and a missing `id` reached the database as `undefined`. Every one
 * of these must be a refusal, never a throw.
 *
 * `verifyUnlock` carries all four shapes, since every exported entry point
 * narrows through the same two functions (`narrowAssertion`,
 * `narrowRegistration`) in `lock.server.ts`; `completeRegistration`,
 * `beginEnrolment` and `removePasskey` each carry one, confirming that
 * every entry point narrows before it dereferences rather than only the
 * one most directly tested.
 */
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
      // The outer-shape check above passes it through as a string; it is
      // `decodeChallenge`'s own pre-existing try/catch, unaffected by this
      // narrowing, that turns the decode failure into this refusal.
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


/**
 * One browser, one live grant. Every verified assertion mints one, so before
 * this rule an unlock, an enrolment confirm and a removal left three live
 * rows for the same browser and "Lock now" — which deletes only the row the
 * cookie names — ended one of them. `supersedes` is always the request's own
 * cookie; these tests hand it down the way the routes do.
 */
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

      // The signer is the fixture credential and the target is `bystander`,
      // so this is the ordinary case rather than the exception below.
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

      // The whole table, not just the three ids: nothing else may be live
      // for this household either.
      const live = await db.selectFrom("unlock_grant").select("id").execute();
      expect(live.map((row) => row.id)).toEqual([third.id]);
    }),
  );

  it(
    "keeps the prior grant when the removal's signer is the passkey being removed, which is the one grant left",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      // This browser is unlocked under `mine`, a passkey it cannot sign with
      // here; the vault answers the removal with `target`, the very passkey
      // being removed, which ADR-0012 allows. Superseding `mine`'s grant too
      // would leave the browser with nothing live, against what the removal
      // screen has just promised it.
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
      // Cascaded away with the passkey that signed for it.
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

/**
 * Poll real, observable database state — never a fixed delay — until
 * `pid`'s own backend is genuinely waiting on a lock. The two-connection
 * races below need to know transaction B has actually reached its blocking
 * statement before transaction A resolves the race by committing; a fixed
 * sleep only guesses that a wait was long enough, and a loaded CI runner is
 * exactly where that guess reads wrong. Bounded so a genuine deadlock or a
 * broken assumption fails loudly here rather than hanging the suite.
 */
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

/** The Postgres backend pid a given Kysely handle is running on. */
async function backendPid(handle: Kysely<Database>): Promise<number> {
  const result = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(handle);
  return result.rows[0]!.pid;
}

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
        const beginA = await beginEnrolment("Device A", { assertion: undefined, acknowledgement: "true" }, trxA);
        const beginB = await beginEnrolment("Device B", { assertion: undefined, acknowledgement: "true" }, trxB);

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

describe("concurrent bootstrap registrations", () => {
  it(
    "lets exactly one of two bootstrap registrations with distinct credential ids land",
    async () => {
      // The partial index's own half of the first-enrolment race, driven
      // through the module rather than through raw fixture SQL. The
      // duplicate-credential-id race above cannot reach it: both inserts
      // there carry the same id, so `passkey_pkey` fires first and the
      // index never decides anything. With two *distinct* ids the primary
      // key has nothing to say and `passkey_bootstrap_idx` is the only
      // thing left that can refuse — the review's surviving mutation, which
      // wrote `bootstrap = false` into the conditional insert, is red here.
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

        // B's own `where not exists` cannot see A's uncommitted row, so it
        // proceeds to insert and blocks on A's index entry instead.
        const blocked = completeRegistration(
          registrationResponse(beginB.options.challenge, {
            credentialId: otherCredentialId,
            publicKey: unrelatedPublicKeyCose(),
          }),
          trxB,
        );
        blocked.catch(() => {});

        // Waited for, never guessed at. A fixed sleep only assumes B's insert
        // reached Postgres and blocked before A committed, and if A commits
        // first B's own `where not exists` refuses it instead — the same
        // message, from the other half, so the assertions below cannot tell
        // the difference and this stops pinning the index at all. Polling
        // for B's backend actually waiting on a lock is what makes the
        // interleaving the one this test claims.
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
        // B's own connection, watched below so this test knows — rather than
        // guesses — the moment its UPDATE actually blocks.
        const pidB = await backendPid(trxB);

        // A verifies against the committed counter (0), signs a higher one,
        // and its write lands — uncommitted — inside trxA.
        await verifyUnlock(assertionResponse(optionsA.challenge, { counter: 9 }), trxA);

        // B's verification is issued while A is still open, so the
        // library's own check reads the SAME committed counter (0) A did —
        // the stale read this rule protects against; B's own check passes.
        // Its UPDATE then blocks on A's uncommitted row.
        const blocked = verifyUnlock(assertionResponse(optionsB.challenge, { counter: 3 }), trxB);
        blocked.catch(() => {});

        // Waits on B's own backend genuinely blocking on A's still-uncommitted
        // row, polled through `database` — a third connection, neither A nor
        // B — before A resolves that race by committing. A fixed delay here
        // only guesses that B's read and its update had time to reach
        // Postgres and block; on a loaded runner that guess is exactly what
        // reads wrong, exercising a different interleaving than the one this
        // test is pinning and failing for the wrong reason (or not at all).
        await waitUntilBlocked(database, pidB);
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
        // B's own connection, watched below so this test knows — rather
        // than guesses — the moment its counter update actually blocks.
        const pidB = await backendPid(trxB);

        // A removes the very passkey B is about to verify against,
        // uncommitted — a tentative deletion B cannot yet know about.
        await trxA.deleteFrom("passkey").where("credential_id", "=", credentialId).execute();

        // B's assertion verifies against the row's pre-delete snapshot
        // (READ COMMITTED takes it fresh per statement, and A has not
        // committed yet), so the verifier itself succeeds; B's own counter
        // UPDATE is what blocks, wanting the same row A's delete already
        // holds a lock on.
        const blocked = verifyUnlock(assertionResponse(optionsB.challenge), trxB);
        blocked.catch(() => {});

        await waitUntilBlocked(database, pidB);
        await trxA.commit().execute();

        // Unblocked, B's UPDATE re-evaluates against A's now-committed
        // delete and simply matches zero rows — Postgres raises nothing for
        // an update that matches nothing. It is `mintGrant`'s own insert
        // that discovers the passkey is gone (its header explains why
        // catching that violation there, rather than re-checking a row
        // count on the update, is what closes this race regardless of
        // exactly when the concurrent removal lands) — a refusal, never
        // the raw `unlock_grant_passkey_id_fkey` violation escaping as a
        // 500.
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

      // Guards against a previous crashed run leaving this fixture's own
      // rows behind, the same reasoning the other cross-connection races in
      // this file give for cleaning up both before and after.
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
          // Comfortably in the future: this race is about a concurrent
          // deletion, not about whether the grant is due for extension.
          expires_at: new Date(Date.now() + 60 * 60 * 1000),
        })
        .execute();

      const trxA = await database.startTransaction().execute();
      const trxB = await database.startTransaction().execute();
      let bodyFailed = false;

      try {
        // B's own connection, watched below so this test knows — rather
        // than guesses — the moment its read actually blocks.
        const pidB = await backendPid(trxB);

        // A deletes the very grant B is about to touch, uncommitted — a
        // tentative deletion B cannot yet know about.
        await trxA.deleteFrom("unlock_grant").where("id", "=", raceGrantId).execute();

        // B's `touchGrant` blocks on its own `SELECT ... FOR UPDATE`: without
        // that row lock, B's read would take its snapshot before A's delete
        // and report the grant as live regardless of what A does next — the
        // exact stale answer this function exists to close off.
        const blocked = touchGrant(raceGrantId, trxB);
        blocked.catch(() => {});

        await waitUntilBlocked(database, pidB);
        await trxA.commit().execute();

        // Unblocked, B's `FOR UPDATE` read re-checks the row's now-committed
        // state — gone — the same re-check an `UPDATE` gets, rather than
        // returning the pre-delete row it was blocked holding a lock
        // against.
        expect(await blocked).toBeUndefined();
      } catch (error) {
        bodyFailed = true;
        throw error;
      } finally {
        if (!trxA.isCommitted && !trxA.isRolledBack) await trxA.rollback().execute().catch(() => {});
        if (!trxB.isCommitted && !trxB.isRolledBack) await trxB.rollback().execute().catch(() => {});

        let cleanupError: unknown;
        try {
          // The passkey's own cascade takes any surviving grant row with it.
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
