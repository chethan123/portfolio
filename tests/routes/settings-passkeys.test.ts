/**
 * `app/routes/settings/passkeys.tsx` (docs/adr/0012, spec 0019, ticket 05) —
 * the route's own contribution: reading a submission, handing it straight to
 * `~/lib/lock.server`, and rendering back whatever that module decided.
 * Every rule about what a valid assertion, enrolment or removal *is* belongs
 * to that module and is exhaustively tested there (`tests/lock.test.ts`);
 * this file never re-derives one, and every refusal below is asserted by
 * its exact printed sentence rather than a route-invented paraphrase.
 *
 * The two ceremonies have no browser in this suite — `tests/routes/
 * unlock.test.ts`'s own header says why — so every assertion or
 * registration response below comes from `tests/support/webauthn.ts`,
 * signed for a challenge one of this file's own calls actually minted.
 *
 * This route's `action` returns most of its answers through react-router's
 * `data()` helper so it can attach a `Set-Cookie` alongside a plain payload;
 * called directly (never through the framework's own data strategy),
 * `data()` hands back a `{ data, init }` wrapper rather than the payload or
 * a `Response` — {@link payloadOf} and {@link grantIdOf} below unwrap it,
 * the same move `tests/routes/upload-wizard.test.ts` makes for the one other
 * `data()` return in this codebase.
 */
import { generateKeyPairSync } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { isoCBOR } from "@simplewebauthn/server/helpers";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import type { Fixtures } from "../support/fixtures.ts";
import { renderRoute } from "../support/render.tsx";
import { args, get, post, responseOf, servedThrough } from "../support/routes.ts";
import {
  assertionResponse,
  backupEligible,
  credentialId,
  publicKey,
  registrationResponse,
  transports,
} from "../support/webauthn.ts";

process.env.DATABASE_URL = TEST_DATABASE_URL;

const {
  action,
  default: Passkeys,
  enrolledText,
  lastUsedText,
  loader,
  NO_CEREMONY_MESSAGE,
  removalWarningKind,
  removalWarningText,
  syncLabel,
  UNREADABLE_SUBMISSION_MESSAGE,
} = await import("../../app/routes/settings/passkeys.tsx");
const {
  LOCK_COOKIE,
  clearedLockCookie,
  enrolmentAssertionOptions,
  isLocked,
  listPasskeys,
  readGrant,
  removalAssertionOptions,
  unlockOptions,
} = await import("~/lib/lock.server");
const { middleware } = await import("../../app/root.tsx");

afterAll(closeTestDatabase);

/** A passkey nobody signs for — good for a row that is only ever a removal *target*, never an authoriser. */
const BYSTANDER_PUBLIC_KEY = new Uint8Array([1, 2, 3, 4]);

/**
 * A well-formed COSE EC public key nobody's private key here corresponds to
 * — `tests/lock.test.ts`'s own `unrelatedPublicKeyCose`, not shared from
 * `tests/support/webauthn.ts` because it signs nothing: it exists purely so
 * a *second* credential can be stored and actually verified against, never
 * asserted as. A malformed stand-in (four raw bytes, say) makes
 * `completeRegistration` refuse before it ever reaches the rule a test built
 * on it claims to prove — this is what closes that hole (finding 6).
 */
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

/** The one enrolled passkey `tests/support/webauthn.ts`'s fixture can sign for. */
function seedFixturePasskey(seedPasskey: Fixtures["seedPasskey"], label = "Kitchen iPad") {
  return seedPasskey({ credentialId, publicKey, transports, backupEligible, label });
}

/** What `data(payload, init)` becomes once read back outside the framework's own data strategy. */
type DataResult<T> = { data: T; init: ResponseInit | null };

/** The payload half of a `data()` return — the route's answer, never the wrapper around it. */
function payloadOf<T>(outcome: unknown): T {
  return (outcome as DataResult<T>).data;
}

/** The `Set-Cookie` header this action's `init.headers` carried, if any — a plain object, never a `Headers` instance, since that is all this route ever passes. */
function setCookieOf(outcome: unknown): string | undefined {
  const headers = (outcome as DataResult<unknown>).init?.headers as Record<string, string> | undefined;
  return headers?.["Set-Cookie"];
}

/** The grant id a `Set-Cookie` names, or undefined. */
function grantIdOf(outcome: unknown): string | undefined {
  return setCookieOf(outcome)?.match(new RegExp(`${LOCK_COOKIE}=([^;]+)`))?.[1];
}

/**
 * `renderToStaticMarkup`'s own escaping turns an apostrophe into `&#x27;` —
 * compare a sentence carrying one against *that*, never the raw string, the
 * same move the last-passkey warning test below already had to make for its
 * own apostrophe.
 */
function htmlEscaped(text: string): string {
  return text.replace(/'/g, "&#x27;");
}

type EnrolRefusal = { ok: false; formError: string };
type BeginEnrolmentOk = { ok: true; options: { challenge: string; user: { name: string } } };
type RemoveRefusal = { ok: false; formError: string; credentialId: string };

describe("removalWarningKind — which warning a row's removal shows (pure, per the ticket's own instruction)", () => {
  it("is the last-passkey warning whenever only one remains, even for the passkey that owns this browser's grant", () => {
    expect(removalWarningKind("only-one", 1, "only-one")).toBe("turnsOffTheLock");
  });

  it("is the last-passkey warning for a lone passkey when this browser resolves no grant at all", () => {
    expect(removalWarningKind("only-one", 1, undefined)).toBe("turnsOffTheLock");
  });

  it("is this-browser's-own-lockout when the target is this browser's live grant and another passkey survives", () => {
    expect(removalWarningKind("mine", 2, "mine")).toBe("locksThisBrowser");
  });

  it("is the safe, lost-passkey warning when a different, surviving passkey authorises this browser", () => {
    expect(removalWarningKind("lost", 2, "mine")).toBe("safeElsewhere");
  });

  it("is never decided by the count alone — the same two-passkey household reads differently per target", () => {
    expect(removalWarningKind("mine", 2, "mine")).not.toBe(removalWarningKind("lost", 2, "mine"));
  });

  it("is the cautious lockout warning, never the reassuring one, when this browser's own grant could not be resolved at all", () => {
    expect(removalWarningKind("lost", 2, "unknown")).toBe("locksThisBrowser");
  });
});

describe("removalWarningText — the sentence a removal's own checkbox carries", () => {
  it("names the household's last passkey and says the lock turns off", () => {
    const text = removalWarningText("turnsOffTheLock", "Kitchen iPad");
    expect(text).toContain("household's last passkey");
    expect(text).toContain("turns the lock off");
  });

  it("says removing it locks this browser the moment it succeeds", () => {
    expect(removalWarningText("locksThisBrowser", "Kitchen iPad")).toContain("locks this browser");
  });

  it("says this browser stays unlocked, and that this is for a passkey lost for good", () => {
    const text = removalWarningText("safeElsewhere", "Kitchen iPad");
    expect(text).toContain("this browser stays unlocked");
    expect(text).toContain("lost or gone for good");
  });
});

describe("enrolledText / lastUsedText / syncLabel — a row's own rendered summary, pure (finding 7)", () => {
  it("renders the enrolled column through formatDate, never a stand-in literal", () => {
    expect(enrolledText(new Date("2026-01-01T00:30:00Z"))).toBe("1 Jan 2026");
  });

  it("says never for a passkey that has not been used yet", () => {
    expect(lastUsedText(null)).toBe("never");
  });

  it("renders a real last-used instant through formatDate once one exists", () => {
    expect(lastUsedText(new Date("2026-03-14T12:00:00Z"))).toBe("14 Mar 2026");
  });

  it("says Synced only when the stored flag is backup-eligible", () => {
    expect(syncLabel(true)).toBe("Synced");
  });

  it("says Bound to a single device when the stored flag is not backup-eligible", () => {
    expect(syncLabel(false)).toBe("Bound to a single device");
  });
});

describe("the loader", () => {
  it(
    "resolves which passkey owns this browser's own grant from its cookie",
    withDatabase(async ({ seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedFixturePasskey(seedPasskey);
      const grant = await seedUnlockGrant({ passkeyId: passkey.credentialId });

      const loaderData = await loader(args(get("/settings/passkeys", `${LOCK_COOKIE}=${grant.id}`)));

      expect(loaderData.ownPasskeyId).toBe(passkey.credentialId);
    }),
  );

  it(
    "resolves nothing when this browser carries no grant cookie at all",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const loaderData = await loader(args(get("/settings/passkeys")));

      expect(loaderData.ownPasskeyId).toBeUndefined();
    }),
  );

  it(
    "mints no options at all — every control mints its own on demand instead (finding 5)",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const loaderData = await loader(args(get("/settings/passkeys")));

      expect(loaderData).not.toHaveProperty("enrolOptions");
      expect(loaderData.passkeys[0]).not.toHaveProperty("removalOptions");
    }),
  );
});

describe("minting options on demand, not once per row on every load (finding 5)", () => {
  it(
    "mints fresh enrol assertion options when the confirm control asks for them",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);

      const outcome = await action(args(post("/settings/passkeys", { intent: "enrolOptions" })));
      const payload = payloadOf<{ ok: true; options: { challenge: string } }>(outcome);

      expect(payload.ok).toBe(true);
      expect(payload.options.challenge).toBeTruthy();
    }),
  );

  it(
    "mints fresh removal assertion options scoped to the requested passkey when a row's Remove control asks for them",
    withDatabase(async ({ seedPasskey }) => {
      const passkey = await seedFixturePasskey(seedPasskey);

      const outcome = await action(
        args(post("/settings/passkeys", { intent: "removalOptions", credentialId: passkey.credentialId })),
      );
      const payload = payloadOf<{ ok: true; credentialId: string; options: { challenge: string } }>(outcome);

      expect(payload.ok).toBe(true);
      expect(payload.credentialId).toBe(passkey.credentialId);
      expect(payload.options.challenge).toBeTruthy();
    }),
  );
});

describe("a submission this route cannot even read (finding 2, `unlock.tsx`'s own precedent)", () => {
  it(
    "refuses a POST whose Content-Type it cannot parse as a form, rather than crashing",
    withDatabase(async () => {
      const request = new Request("http://portfolio.local/settings/passkeys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: "remove" }),
      });
      const outcome = await action(args(request));
      expect(outcome).not.toBeInstanceOf(Response);
      expect(payloadOf<EnrolRefusal>(outcome).formError).toBe(UNREADABLE_SUBMISSION_MESSAGE);
    }),
  );

  it(
    "refuses a POST with no body and no Content-Type, rather than crashing",
    withDatabase(async () => {
      const request = new Request("http://portfolio.local/settings/passkeys", { method: "POST" });
      const outcome = await action(args(request));
      expect(payloadOf<EnrolRefusal>(outcome).formError).toBe(UNREADABLE_SUBMISSION_MESSAGE);
    }),
  );

  it(
    "refuses a POST of plain text, rather than crashing",
    withDatabase(async () => {
      const request = new Request("http://portfolio.local/settings/passkeys", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "not a form body",
      });
      const outcome = await action(args(request));
      expect(payloadOf<EnrolRefusal>(outcome).formError).toBe(UNREADABLE_SUBMISSION_MESSAGE);
    }),
  );
});

describe("enrolling with no grant and no assertion", () => {
  it(
    "can enrol when the household holds no passkey at all, once the acknowledgement is ticked",
    withDatabase(async ({ db }) => {
      const outcome = await action(
        args(
          post("/settings/passkeys", {
            intent: "beginEnrolment",
            label: "Kitchen iPad",
            acknowledged: "true",
          }),
        ),
      );
      const payload = payloadOf<BeginEnrolmentOk | EnrolRefusal>(outcome);

      expect(payload.ok).toBe(true);
      expect(await isLocked(db)).toBe(false); // beginning does not itself enrol anything yet
    }),
  );

  it(
    "refuses to enrol the first passkey without that acknowledgement (finding 11)",
    withDatabase(async ({ db }) => {
      const outcome = await action(
        args(post("/settings/passkeys", { intent: "beginEnrolment", label: "Kitchen iPad" })),
      );
      const payload = payloadOf<EnrolRefusal>(outcome);

      expect(payload.ok).toBe(false);
      expect(payload.formError).toMatch(/tick that acknowledgement/);
      expect(await isLocked(db)).toBe(false);
    }),
  );

  it(
    "cannot enrol without an assertion once the household holds one",
    withDatabase(async ({ seedPasskey }) => {
      await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY });

      const outcome = await action(
        args(post("/settings/passkeys", { intent: "beginEnrolment", label: "Laptop" })),
      );
      const payload = payloadOf<BeginEnrolmentOk | EnrolRefusal>(outcome);

      expect(payload.ok).toBe(false);
      expect((payload as EnrolRefusal).formError).toMatch(/fresh confirmation/);
    }),
  );

  it(
    "prints the domain module's own refusal verbatim, not a route-invented paraphrase",
    withDatabase(async ({ seedPasskey }) => {
      await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY });

      const outcome = await action(
        args(post("/settings/passkeys", { intent: "beginEnrolment", label: "Laptop" })),
      );
      const payload = payloadOf<EnrolRefusal>(outcome);

      expect(payload.formError).toBe(
        "Enrolling another passkey needs a fresh confirmation from one already enrolled — " +
          "being unlocked on this browser is not enough on its own.",
      );
    }),
  );

  it(
    "prints a label refusal instead of a silent empty note (finding 4)",
    withDatabase(async () => {
      const outcome = await action(
        args(
          post("/settings/passkeys", {
            intent: "beginEnrolment",
            label: "x".repeat(61),
            acknowledged: "true",
          }),
        ),
      );
      const payload = payloadOf<EnrolRefusal>(outcome);

      expect(payload.ok).toBe(false);
      expect(payload.formError).not.toBe("");
      expect(payload.formError).toMatch(/60 characters or fewer/);
    }),
  );

  it(
    "refuses a label carrying a NUL byte before any ceremony could run (finding 3)",
    withDatabase(async ({ db }) => {
      const outcome = await action(
        args(
          post("/settings/passkeys", {
            intent: "beginEnrolment",
            label: "Kitchen\u0000iPad",
            acknowledged: "true",
          }),
        ),
      );
      const payload = payloadOf<EnrolRefusal>(outcome);

      expect(payload.ok).toBe(false);
      expect(await isLocked(db)).toBe(false);
    }),
  );
});

describe("a live grant does not substitute for the fresh assertion these two writes need", () => {
  it(
    "enrolling is not authorised by merely being unlocked (finding 13 — this used to be half a sentence split across two tests)",
    withDatabase(async ({ seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY });
      const grant = await seedUnlockGrant({ passkeyId: passkey.credentialId });

      const outcome = await action(
        args(
          post(
            "/settings/passkeys",
            { intent: "beginEnrolment", label: "Laptop" },
            `${LOCK_COOKIE}=${grant.id}`,
          ),
        ),
      );
      const payload = payloadOf<EnrolRefusal>(outcome);

      expect(payload.ok).toBe(false);
      expect(payload.formError).toMatch(/fresh confirmation/);
    }),
  );

  it(
    "removing is not authorised by merely being unlocked either",
    withDatabase(async ({ seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY });
      const grant = await seedUnlockGrant({ passkeyId: passkey.credentialId });

      const outcome = await action(
        args(
          post(
            "/settings/passkeys",
            { intent: "remove", credentialId: passkey.credentialId, confirmRemoval: "true" },
            `${LOCK_COOKIE}=${grant.id}`,
          ),
        ),
      );
      const payload = payloadOf<RemoveRefusal>(outcome);

      expect(payload.ok).toBe(false);
      expect(payload.formError).toMatch(/fresh confirmation/);
    }),
  );
});

describe("scope enforcement carries through the route (ticket 02's rule, wired here rather than restated)", () => {
  it(
    "an assertion minted for unlocking does not authorise a removal",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const unlock = await unlockOptions(db);
      const assertion = assertionResponse(unlock.challenge);

      const outcome = await action(
        args(
          post("/settings/passkeys", {
            intent: "remove",
            credentialId,
            confirmRemoval: "true",
            assertion: JSON.stringify(assertion),
          }),
        ),
      );
      const payload = payloadOf<RemoveRefusal>(outcome);

      expect(payload.ok).toBe(false);
      expect(payload.formError).toMatch(/not issued for this action/);
    }),
  );

  it(
    "an assertion minted to remove one passkey does not authorise removing another",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey); // the one signable identity, at `credentialId`
      await seedPasskey({ credentialId: "bystander", publicKey: BYSTANDER_PUBLIC_KEY });

      const scoped = await removalAssertionOptions(credentialId, db);
      const assertion = assertionResponse(scoped.challenge); // signed as `credentialId`, scoped to remove it

      const outcome = await action(
        args(
          post("/settings/passkeys", {
            intent: "remove",
            credentialId: "bystander",
            confirmRemoval: "true",
            assertion: JSON.stringify(assertion),
          }),
        ),
      );
      const payload = payloadOf<RemoveRefusal>(outcome);

      expect(payload.ok).toBe(false);
      expect(payload.formError).toMatch(/not issued for this action/);
    }),
  );
});

describe("a duplicate credential is refused rather than creating a second row", () => {
  it(
    "refuses re-registering the same credential id, and the roster stays at one",
    withDatabase(async ({ db }) => {
      const begun = payloadOf<BeginEnrolmentOk>(
        await action(
          args(
            post("/settings/passkeys", {
              intent: "beginEnrolment",
              label: "Kitchen iPad",
              acknowledged: "true",
            }),
          ),
        ),
      );
      await action(
        args(
          post("/settings/passkeys", {
            intent: "completeRegistration",
            response: JSON.stringify(registrationResponse(begun.options.challenge)),
          }),
        ),
      );

      const enrolOptions = await enrolmentAssertionOptions(db);
      const secondBegun = payloadOf<BeginEnrolmentOk>(
        await action(
          args(
            post("/settings/passkeys", {
              intent: "beginEnrolment",
              label: "Second phone",
              assertion: JSON.stringify(assertionResponse(enrolOptions.challenge)),
            }),
          ),
        ),
      );

      // The very same credential id and public key as the first — the
      // authenticator "replaying" its one credential rather than minting a
      // second, which is exactly what `excludeCredentials` cannot prevent
      // client-side once a test drives this without a browser.
      const duplicate = payloadOf<{ ok: false; formError: string } | { ok: true }>(
        await action(
          args(
            post("/settings/passkeys", {
              intent: "completeRegistration",
              response: JSON.stringify(registrationResponse(secondBegun.options.challenge)),
            }),
          ),
        ),
      );

      expect(duplicate.ok).toBe(false);
      expect((duplicate as { formError: string }).formError).toBe("This passkey is already enrolled.");
      expect(await listPasskeys(db)).toHaveLength(1);
    }),
  );
});

describe("enrolling the first passkey", () => {
  it(
    "leaves the enrolling browser able to load the next screen",
    withDatabase(async () => {
      const begun = payloadOf<BeginEnrolmentOk>(
        await action(
          args(
            post("/settings/passkeys", {
              intent: "beginEnrolment",
              label: "Kitchen iPad",
              acknowledged: "true",
            }),
          ),
        ),
      );

      const completed = await action(
        args(
          post("/settings/passkeys", {
            intent: "completeRegistration",
            response: JSON.stringify(registrationResponse(begun.options.challenge)),
          }),
        ),
      );

      const grantId = grantIdOf(completed);
      expect(grantId).toBeDefined();

      let nextCalled = false;
      await servedThrough(middleware, get("/", `${LOCK_COOKIE}=${grantId}`), {}, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
    }),
  );

  it(
    "sets this browser's cookie when a later enrolment's own confirm step verifies (finding 7)",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const enrolOptions = await enrolmentAssertionOptions(db);

      const outcome = await action(
        args(
          post("/settings/passkeys", {
            intent: "beginEnrolment",
            label: "Second phone",
            assertion: JSON.stringify(assertionResponse(enrolOptions.challenge)),
          }),
        ),
      );

      expect(payloadOf<BeginEnrolmentOk>(outcome).ok).toBe(true);
      expect(grantIdOf(outcome)).toBeDefined();
    }),
  );

  it(
    "mints no grant for anything past the first — the assertion just before it already did",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const enrolOptions = await enrolmentAssertionOptions(db);
      const begun = payloadOf<BeginEnrolmentOk>(
        await action(
          args(
            post("/settings/passkeys", {
              intent: "beginEnrolment",
              label: "Second phone",
              assertion: JSON.stringify(assertionResponse(enrolOptions.challenge)),
            }),
          ),
        ),
      );

      const completed = await action(
        args(
          post("/settings/passkeys", {
            intent: "completeRegistration",
            response: JSON.stringify(
              registrationResponse(begun.options.challenge, {
                credentialId: "second-device",
                // A well-formed public key nobody signs for, not a four-byte
                // stand-in: a malformed one makes this call refuse before it
                // ever reaches the rule this test is named for, passing for
                // the wrong reason (finding 6).
                publicKey: unrelatedPublicKeyCose(),
              }),
            ),
          }),
        ),
      );

      expect(payloadOf<{ ok: boolean }>(completed).ok).toBe(true);
      expect(setCookieOf(completed)).toBeUndefined();
    }),
  );
});

describe("removing", () => {
  it(
    "ends its grants; removing the last leaves every screen rendering again",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedFixturePasskey(seedPasskey);
      const grant = await seedUnlockGrant({ passkeyId: passkey.credentialId });

      const removalOptions = await removalAssertionOptions(passkey.credentialId, db);
      const assertion = assertionResponse(removalOptions.challenge);

      const outcome = await action(
        args(
          post(
            "/settings/passkeys",
            {
              intent: "remove",
              credentialId: passkey.credentialId,
              confirmRemoval: "true",
              assertion: JSON.stringify(assertion),
            },
            `${LOCK_COOKIE}=${grant.id}`,
          ),
        ),
      );
      expect(payloadOf<{ ok: boolean }>(outcome).ok).toBe(true);

      expect(await readGrant(grant.id, db)).toBeUndefined();
      expect(await isLocked(db)).toBe(false);

      let nextCalled = false;
      await servedThrough(middleware, get("/"), {}, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
    }),
  );

  it(
    "refuses a removal missing its own acknowledgement — the route forwards the real field, never a hard-coded one (finding 7)",
    withDatabase(async ({ seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedFixturePasskey(seedPasskey);
      const grant = await seedUnlockGrant({ passkeyId: passkey.credentialId });

      const outcome = await action(
        args(
          post(
            "/settings/passkeys",
            { intent: "remove", credentialId: passkey.credentialId },
            `${LOCK_COOKIE}=${grant.id}`,
          ),
        ),
      );
      const payload = payloadOf<RemoveRefusal>(outcome);

      expect(payload.ok).toBe(false);
      expect(payload.formError).toMatch(/ticked first/);
    }),
  );

  it(
    "prints a refusal instead of throwing the 404 that replaces the whole screen, when the target is already gone (finding 8)",
    withDatabase(async ({ db, seedPasskey }) => {
      const target = await seedFixturePasskey(seedPasskey, "Already gone");
      const removalOptions = await removalAssertionOptions(target.credentialId, db);
      const assertion = assertionResponse(removalOptions.challenge);

      // Another browser removed it first — the reachable case this finding
      // names, a Passkeys tab left open while a different device deletes
      // the very passkey this one is about to submit a removal for.
      await db.deleteFrom("passkey").where("credential_id", "=", target.credentialId).execute();

      const outcome = await action(
        args(
          post("/settings/passkeys", {
            intent: "remove",
            credentialId: target.credentialId,
            confirmRemoval: "true",
            assertion: JSON.stringify(assertion),
          }),
        ),
      );

      expect(outcome).not.toBeInstanceOf(Response);
      const payload = payloadOf<RemoveRefusal>(outcome);
      expect(payload.ok).toBe(false);
      expect(payload.credentialId).toBe(target.credentialId);
    }),
  );

  it(
    "locks this browser the moment it succeeds, by clearing its cookie, when the target owns this browser's own grant",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      const mine = await seedFixturePasskey(seedPasskey, "This phone");
      await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY, label: "Spare tablet" });
      const priorGrant = await seedUnlockGrant({ passkeyId: mine.credentialId });

      const removalOptions = await removalAssertionOptions(mine.credentialId, db);
      const assertion = assertionResponse(removalOptions.challenge);

      const outcome = await action(
        args(
          post(
            "/settings/passkeys",
            {
              intent: "remove",
              credentialId: mine.credentialId,
              confirmRemoval: "true",
              assertion: JSON.stringify(assertion),
            },
            `${LOCK_COOKIE}=${priorGrant.id}`,
          ),
        ),
      );

      // The assertion that authorised this removal was signed by the very
      // passkey it deletes, so the grant it mints is cascaded away in the
      // same statement as the delete — there is no live grant left to name,
      // so the cookie is cleared outright rather than naming one that
      // resolves to nothing (finding 1a).
      expect(setCookieOf(outcome)).toBe(clearedLockCookie());
      expect(await isLocked(db)).toBe(true); // the spare tablet's passkey survives it

      let nextCalled = false;
      const refusal = await responseOf(() =>
        servedThrough(middleware, get("/", `${LOCK_COOKIE}=${priorGrant.id}`), {}, () => {
          nextCalled = true;
        }),
      );
      expect(nextCalled).toBe(false);
      expect(refusal.status).toBeGreaterThanOrEqual(300);
      expect(refusal.status).toBeLessThan(400);
    }),
  );

  it(
    "leaves this browser unlocked when the target does not own this browser's own grant",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      const mine = await seedFixturePasskey(seedPasskey, "This phone");
      const lost = await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY, label: "Lost phone" });
      const priorGrant = await seedUnlockGrant({ passkeyId: mine.credentialId });

      const removalOptions = await removalAssertionOptions(lost.credentialId, db);
      const assertion = assertionResponse(removalOptions.challenge); // signed by `mine`, scoped to remove `lost`

      const outcome = await action(
        args(
          post(
            "/settings/passkeys",
            {
              intent: "remove",
              credentialId: lost.credentialId,
              confirmRemoval: "true",
              assertion: JSON.stringify(assertion),
            },
            `${LOCK_COOKIE}=${priorGrant.id}`,
          ),
        ),
      );

      const newGrantId = grantIdOf(outcome);
      expect(newGrantId).toBeDefined();
      expect(await readGrant(newGrantId as string, db)).toBeDefined();

      let nextCalled = false;
      await servedThrough(middleware, get("/", `${LOCK_COOKIE}=${newGrantId}`), {}, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
    }),
  );

  it(
    "keeps this browser's own still-live grant rather than naming the one this removal's assertion minted and then cascaded away (finding 1a)",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      // This browser's own grant belongs to a passkey (`mine`) that plays no
      // part in signing this removal at all — the OS picker (or a synced
      // vault) answers instead with `target`, the very passkey being
      // removed, exactly as ADR-0012's synced-vault case allows.
      const mine = await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY, label: "This phone" });
      const target = await seedFixturePasskey(seedPasskey, "Spare tablet");
      const priorGrant = await seedUnlockGrant({ passkeyId: mine.credentialId });

      const removalOptions = await removalAssertionOptions(target.credentialId, db);
      const assertion = assertionResponse(removalOptions.challenge); // signed by `target`, not `mine`

      const outcome = await action(
        args(
          post(
            "/settings/passkeys",
            {
              intent: "remove",
              credentialId: target.credentialId,
              confirmRemoval: "true",
              assertion: JSON.stringify(assertion),
            },
            `${LOCK_COOKIE}=${priorGrant.id}`,
          ),
        ),
      );

      expect(payloadOf<{ ok: boolean }>(outcome).ok).toBe(true);
      // `mine`'s own grant never named the passkey this removal deleted, so
      // it survives untouched — the cookie must go on naming it rather than
      // the fresh grant this same request minted for `target` and then
      // cascaded away in the very next statement.
      expect(await readGrant(priorGrant.id, db)).toBeDefined();
      expect(grantIdOf(outcome)).toBe(priorGrant.id);

      let nextCalled = false;
      await servedThrough(middleware, get("/", `${LOCK_COOKIE}=${priorGrant.id}`), {}, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
    }),
  );

  it(
    "stays unlocked under a different, still-enrolled passkey's fresh grant even when the removal targets this browser's own (finding 1b)",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      const target = await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY, label: "This phone" });
      await seedFixturePasskey(seedPasskey, "Spare tablet");
      const priorGrant = await seedUnlockGrant({ passkeyId: target.credentialId });

      const removalOptions = await removalAssertionOptions(target.credentialId, db);
      const assertion = assertionResponse(removalOptions.challenge); // signed by the spare tablet, not `target`

      const outcome = await action(
        args(
          post(
            "/settings/passkeys",
            {
              intent: "remove",
              credentialId: target.credentialId,
              confirmRemoval: "true",
              assertion: JSON.stringify(assertion),
            },
            `${LOCK_COOKIE}=${priorGrant.id}`,
          ),
        ),
      );

      expect(payloadOf<{ ok: boolean }>(outcome).ok).toBe(true);
      const newGrantId = grantIdOf(outcome);
      expect(newGrantId).toBeDefined();
      expect(newGrantId).not.toBe(priorGrant.id);
      expect(await readGrant(newGrantId as string, db)).toBeDefined();
      expect(await isLocked(db)).toBe(true);

      // Proves the point findings 1 and 10 both make: the screen's own
      // warning cannot promise a lockout unconditionally, because which
      // passkey actually signs is not this screen's choice to make.
      let nextCalled = false;
      await servedThrough(middleware, get("/", `${LOCK_COOKIE}=${newGrantId}`), {}, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
    }),
  );
});

describe("the list, rendered from the real loader (tests/support/render.tsx's own rule against a hand-built fixture)", () => {
  it(
    "says the instance is not locked, and that enrolling one changes that, when none exists",
    withDatabase(async () => {
      const markup = renderRoute(Passkeys, "/settings/passkeys", await loader(args(get("/settings/passkeys"))));

      expect(markup).toContain("this instance is not locked");
      expect(markup).toContain("locks every other browser in the household");
    }),
  );

  it(
    "prints the empty state once, not twice near-verbatim (finding 10)",
    withDatabase(async () => {
      const markup = renderRoute(Passkeys, "/settings/passkeys", await loader(args(get("/settings/passkeys"))));

      expect(markup.match(/this instance is not locked/g)).toHaveLength(1);
    }),
  );

  it(
    "shows the first-passkey acknowledgement only when none exists",
    withDatabase(async ({ seedPasskey }) => {
      const withoutOne = renderRoute(
        Passkeys,
        "/settings/passkeys",
        await loader(args(get("/settings/passkeys"))),
      );
      expect(withoutOne).toContain("Enrolling this passkey locks every other browser");

      await seedFixturePasskey(seedPasskey);
      const withOne = renderRoute(
        Passkeys,
        "/settings/passkeys",
        await loader(args(get("/settings/passkeys"))),
      );
      expect(withOne).not.toContain("Enrolling this passkey locks every other browser");
    }),
  );

  it(
    "presses for a second passkey, in words a family member can act on rather than naming the operator (finding 10)",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const markup = renderRoute(Passkeys, "/settings/passkeys", await loader(args(get("/settings/passkeys"))));

      expect(markup).toContain("The household holds one passkey");
      expect(markup).not.toContain("the operator");
      expect(markup).toContain("whoever set this app up for the household");
    }),
  );

  it(
    "says nothing about a second passkey once there already are two",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY, label: "Second phone" });
      const markup = renderRoute(Passkeys, "/settings/passkeys", await loader(args(get("/settings/passkeys"))));

      expect(markup).not.toContain("The household holds one passkey");
    }),
  );

  it(
    "renders a synced and a device-bound passkey differently, from the stored flag",
    withDatabase(async ({ seedPasskey }) => {
      await seedPasskey({
        credentialId: "synced-one",
        publicKey: BYSTANDER_PUBLIC_KEY,
        label: "Synced phone",
        backupEligible: true,
      });
      await seedPasskey({
        credentialId: "bound-one",
        publicKey: BYSTANDER_PUBLIC_KEY,
        label: "Work laptop",
        backupEligible: false,
      });

      const markup = renderRoute(Passkeys, "/settings/passkeys", await loader(args(get("/settings/passkeys"))));

      expect(markup).toContain("Synced");
      expect(markup).toContain("Bound to a single device");
    }),
  );

  it(
    "renders the row's own distinctive label, not a stand-in shared with another test (finding 7)",
    withDatabase(async ({ seedPasskey }) => {
      await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY, label: "Zzyzx Field Station Tablet" });
      const markup = renderRoute(Passkeys, "/settings/passkeys", await loader(args(get("/settings/passkeys"))));

      expect(markup).toContain("Zzyzx Field Station Tablet");
    }),
  );

  it(
    "shows each row's own removal warning, matching whether it owns this browser's grant",
    withDatabase(async ({ seedPasskey, seedUnlockGrant }) => {
      const mine = await seedFixturePasskey(seedPasskey, "This phone");
      const lost = await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY, label: "Lost phone" });
      const grant = await seedUnlockGrant({ passkeyId: mine.credentialId });

      const loaderData = await loader(args(get("/settings/passkeys", `${LOCK_COOKIE}=${grant.id}`)));
      const markup = renderRoute(Passkeys, "/settings/passkeys", loaderData);

      expect(markup).toContain(htmlEscaped(removalWarningText("locksThisBrowser", "This phone")));
      expect(markup).toContain(htmlEscaped(removalWarningText("safeElsewhere", "Lost phone")));
    }),
  );

  it(
    "shows the last-passkey warning instead, once the household holds only one",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey, "Only phone");
      const markup = renderRoute(Passkeys, "/settings/passkeys", await loader(args(get("/settings/passkeys"))));

      // Not a bare `toContain(removalWarningText(...))`: the sentence's own
      // apostrophe renders HTML-escaped (`&#x27;`) in static markup, so the
      // two substrings either side of it are what a literal-string compare
      // can actually match.
      expect(markup).toContain("Remove Only phone: this is the household");
      expect(markup).toContain("turns the lock off");
    }),
  );

  it(
    "labels the input with the same bound the domain module enforces",
    withDatabase(async () => {
      const markup = renderRoute(Passkeys, "/settings/passkeys", await loader(args(get("/settings/passkeys"))));

      expect(markup).toContain('maxLength="60"');
    }),
  );
});

describe("a browser that cannot run the ceremony at all — no dead end (finding 10)", () => {
  it("names at least one recovery a family member can act on, not only that it cannot run the check", () => {
    expect(NO_CEREMONY_MESSAGE).toMatch(/another browser|another device/);
    expect(NO_CEREMONY_MESSAGE).not.toContain("the operator");
  });
});

describe("the two-step control surface", () => {
  it(
    "offers a first-tap 'Continue' control when no passkey exists yet, not the two-step confirmation",
    withDatabase(async () => {
      const markup = renderRoute(Passkeys, "/settings/passkeys", await loader(args(get("/settings/passkeys"))));

      expect(markup).toContain(">Continue<");
      expect(markup).not.toContain("Confirm with an existing passkey");
      // Never one press straight into `create()`: the first passkey is two
      // taps too (finding 12), so its own first button never reads as
      // though pressing it creates anything by itself.
      expect(markup).not.toContain(">Create passkey<");
    }),
  );

  it(
    "offers the 'Confirm with an existing passkey' first step once the household holds one",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const markup = renderRoute(Passkeys, "/settings/passkeys", await loader(args(get("/settings/passkeys"))));

      expect(markup).toContain("Confirm with an existing passkey");
    }),
  );
});

describe("vocabulary — CONTEXT.md's Passkey entry rules these out, and this screen is mostly interface copy", () => {
  it(
    "never reaches for the vocabulary the glossary avoids, including calling a passkey a device",
    withDatabase(async ({ seedPasskey }) => {
      const mine = await seedFixturePasskey(seedPasskey, "This phone");
      await seedPasskey({ publicKey: BYSTANDER_PUBLIC_KEY, label: "Lost phone" });
      const loaderData = await loader(args(get("/settings/passkeys")));
      const markup = renderRoute(Passkeys, "/settings/passkeys", { ...loaderData, ownPasskeyId: mine.credentialId }).toLowerCase();

      // "key" is deliberately not in this list, the same exception
      // `tests/routes/unlock.test.ts` documents: "passkey"/"passkeys" is
      // this screen's own vocabulary and contains it as a bare substring.
      for (const word of ["biometric", "fingerprint", "face", "device credential", "enrolled device"]) {
        expect(markup).not.toContain(word);
      }
    }),
  );
});
