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
 * unlock.test.ts`'s own header says why — so most assertion or registration
 * responses below come from `tests/support/webauthn.ts`, signed for a
 * challenge one of this file's own calls actually minted, posted straight to
 * `action` without ever going through the client-side ceremony. The pure
 * decisions this route pulls out of its own effects — `runConfirmCeremony`,
 * `applyRemovalOptionsResult`, `removalConfirmDisabled`, `runRemovalCeremony`
 * (this file's own header on why the two ceremonies need different ones) —
 * are the exception: those are driven directly, with `~/lib/unlock-ceremony`
 * mocked file-wide exactly as `unlock.test.ts` mocks it, since calling them
 * directly is what actually exercises `requestAssertion`.
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

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

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

// Mocked file-wide, the same shape and the same reason as `unlock.test.ts`:
// nothing in this suite has a browser to run the real ceremony, and the
// component code under test here never calls either export outside a
// `useEffect` or a click handler — except the four pure functions
// (`runConfirmCeremony`, `applyRemovalOptionsResult`,
// `removalConfirmDisabled`, `runRemovalCeremony`) this file drives directly,
// which is exactly what needs `requestAssertion` mocked to be testable at all.
vi.mock("~/lib/unlock-ceremony", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/unlock-ceremony")>();
  return { ...actual, requestAssertion: vi.fn(), supportsPasskeys: vi.fn() };
});

const {
  action,
  applyRemoveResult,
  applyRemovalOptionsResult,
  default: Passkeys,
  enrolBusy,
  enrolledText,
  lastUsedText,
  loader,
  lockedByOtherRow,
  NO_CEREMONY_MESSAGE,
  REGISTRATION_OPTIONS_EXPIRED_MESSAGE,
  registrationOptionsExpired,
  removalConfirmDisabled,
  removalWarningKind,
  removalWarningText,
  runConfirmCeremony,
  runRemovalCeremony,
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
const { requestAssertion } = await import("~/lib/unlock-ceremony");
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

  it("says the credential can sync to other devices only when the stored flag is backup-eligible, never that a copy already exists", () => {
    expect(syncLabel(true)).toBe("Can sync to other devices");
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
    // This is the pin: the pre-fix version of this route minted the
    // confirm-identity ceremony's options from a click handler's own fetch,
    // which is exactly the bug `unlock.tsx`'s own commit c0af420 fixed on
    // the sibling screen — a network round trip awaited ahead of the
    // ceremony, spending the press's activation on the wait rather than the
    // check. Minting `enrolOptions` here, in the loader, is what lets the
    // confirm press run `requestAssertion` with no fetch ahead of it.
    "returns this page's own enrolment assertion options, minted here rather than by a later press",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const loaderData = await loader(args(get("/settings/passkeys")));

      expect(loaderData.enrolOptions.challenge).toBeTruthy();
    }),
  );

  it(
    "mints a fresh enrolment challenge on every load, not the same one twice — the same rule `/unlock`'s own loader follows",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const first = await loader(args(get("/settings/passkeys")));
      const second = await loader(args(get("/settings/passkeys")));

      expect(second.enrolOptions.challenge).not.toBe(first.enrolOptions.challenge);
    }),
  );

  it(
    "mints nothing per row for removal — a household of many passkeys must not flood the shared budget on every load (finding 5)",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const loaderData = await loader(args(get("/settings/passkeys")));

      expect(loaderData.passkeys[0]).not.toHaveProperty("removalOptions");
    }),
  );
});

describe("removal options are minted on demand, per press, never once per row on every load (finding 5)", () => {
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

  it(
    // Locks in the shape this file's own header argues for: minting the
    // confirm-identity ceremony's options is the loader's job now, not a
    // press's — an `enrolOptions` intent reaching the action at all is
    // itself the pre-fix shape coming back.
    "no longer answers an 'enrolOptions' intent — that ceremony's options come from the loader now",
    withDatabase(async () => {
      const response = await responseOf(() => action(args(post("/settings/passkeys", { intent: "enrolOptions" }))));

      expect(response.status).toBe(400);
    }),
  );
});

describe(
  "runConfirmCeremony — the confirm-identity ceremony's own outcome handler, run directly with no browser " +
    "(`unlock.tsx`'s own `runCeremony`, this route's analogue)",
  () => {
    const FAKE_OPTIONS = { challenge: "fixture-challenge" } as Awaited<ReturnType<typeof enrolmentAssertionOptions>>;

    afterEach(() => {
      vi.mocked(requestAssertion).mockReset();
    });

    it(
      "submits beginEnrolment with the signed assertion and never revalidates once the ceremony succeeds",
      async () => {
        const response = assertionResponse("fixture-challenge");
        vi.mocked(requestAssertion).mockResolvedValue({ status: "ok", response });
        const submit = vi.fn().mockResolvedValue(undefined);
        const setPhase = vi.fn();
        const setNote = vi.fn();
        const revalidate = vi.fn();

        await runConfirmCeremony(FAKE_OPTIONS, "Kitchen iPad", submit as never, setPhase, setNote, revalidate);

        expect(submit).toHaveBeenCalledWith(
          { intent: "beginEnrolment", label: "Kitchen iPad", assertion: JSON.stringify(response) },
          { method: "post" },
        );
        expect(setPhase).not.toHaveBeenCalled();
        expect(setNote).not.toHaveBeenCalled();
        // `submit`'s own promise already carries a post-action revalidation
        // (`unlock.tsx`'s own header) — a second one here would be redundant.
        expect(revalidate).not.toHaveBeenCalled();
      },
    );

    it(
      // The pin: a retry used to wait for a *later* press to revalidate,
      // running the ceremony behind a pending network round trip and
      // outside that press's own user activation (`unlock.tsx`'s commit
      // c0af420). This is what proves the fix landed here too — the
      // instant the outcome settles, not deferred to whenever the reader
      // next presses Confirm.
      "revalidates immediately once a dismissed prompt leaves loaderData.enrolOptions stale, without submitting",
      async () => {
        vi.mocked(requestAssertion).mockResolvedValue({ status: "dismissed" });
        const submit = vi.fn();
        const setPhase = vi.fn();
        const setNote = vi.fn();
        const revalidate = vi.fn();

        await runConfirmCeremony(FAKE_OPTIONS, "Kitchen iPad", submit as never, setPhase, setNote, revalidate);

        expect(submit).not.toHaveBeenCalled();
        expect(setPhase).toHaveBeenCalledWith("idle");
        expect(setNote).toHaveBeenCalledWith(expect.stringContaining("did not complete"));
        expect(revalidate).toHaveBeenCalled();
      },
    );

    it(
      "revalidates immediately once a failed ceremony leaves loaderData.enrolOptions stale, carrying its own message",
      async () => {
        vi.mocked(requestAssertion).mockResolvedValue({ status: "failed", message: "No authenticator found." });
        const submit = vi.fn();
        const setPhase = vi.fn();
        const setNote = vi.fn();
        const revalidate = vi.fn();

        await runConfirmCeremony(FAKE_OPTIONS, "Kitchen iPad", submit as never, setPhase, setNote, revalidate);

        expect(submit).not.toHaveBeenCalled();
        expect(setNote).toHaveBeenCalledWith("No authenticator found.");
        expect(setPhase).toHaveBeenCalledWith("idle");
        expect(revalidate).toHaveBeenCalled();
      },
    );
  },
);

describe("registrationOptionsExpired — the stale-registration-options guard", () => {
  it("is not expired the instant options are minted", () => {
    expect(registrationOptionsExpired(1_000, 1_000)).toBe(false);
  });

  it("is not expired just under the two-minute TTL lock.server.ts's own CHALLENGE_TTL_MS grants", () => {
    expect(registrationOptionsExpired(0, 2 * 60 * 1000 - 1)).toBe(false);
  });

  it("is expired at exactly the two-minute mark", () => {
    expect(registrationOptionsExpired(0, 2 * 60 * 1000)).toBe(true);
  });

  it(
    // The case the finding names: a dismissed creation deliberately keeps its
    // options (`runCreate`'s own header), so the reader can sit on the
    // Create step for as long as they like before pressing it again.
    "stays expired well past the TTL, the case a dismissed creation followed by a long pause produces",
    () => {
      expect(registrationOptionsExpired(0, 5 * 60 * 1000)).toBe(true);
    },
  );
});

describe("enrolBusy — the Add-a-passkey panel's own disabled check, including the revalidator", () => {
  it("is busy while a fresh confirm press is running", () => {
    expect(enrolBusy("confirming", "idle", "idle")).toBe(true);
  });

  it("is busy while the beginEnrolment/completeRegistration fetcher is in flight", () => {
    expect(enrolBusy("idle", "submitting", "idle")).toBe(true);
  });

  it(
    // The pin: before this fix, a dismissed or failed confirm started
    // `loaderData.enrolOptions` revalidating (`runConfirmCeremony`'s own
    // header) while `phase` had already reset to "idle" — leaving Confirm
    // pressable during exactly the window a press must not be accepted.
    "is busy while a dismissed or failed confirm's own revalidation is still settling, even though phase itself is idle",
    () => {
      expect(enrolBusy("idle", "idle", "loading")).toBe(true);
      expect(enrolBusy("idle", "idle", "submitting")).toBe(true);
    },
  );

  it("is not busy once idle across the phase, the fetcher and the revalidator", () => {
    expect(enrolBusy("idle", "idle", "idle")).toBe(false);
  });

  it("stays pressable in readyToCreate — the Create button's own busy check is this same one, not a different variable", () => {
    expect(enrolBusy("readyToCreate", "idle", "idle")).toBe(false);
  });
});

describe("REGISTRATION_OPTIONS_EXPIRED_MESSAGE — printed once handleCreatePasskey refuses to call WebAuthn on a stale challenge", () => {
  it("tells the reader to start again, rather than describing the failure in server terms alone", () => {
    expect(REGISTRATION_OPTIONS_EXPIRED_MESSAGE).toMatch(/start again/i);
  });
});

describe("applyRemovalOptionsResult — landing a row's own options-fetch never runs a ceremony", () => {
  const FAKE_OPTIONS = { challenge: "fixture-challenge" } as Awaited<ReturnType<typeof enrolmentAssertionOptions>>;

  afterEach(() => {
    vi.mocked(requestAssertion).mockReset();
  });

  it(
    // The bug this whole ticket fixes was exactly this: a row auto-ran the
    // ceremony the moment its own options landed. This is the pin — landing
    // a successful fetch only ever stores the options, never touches
    // `requestAssertion`; that call belongs to `runRemovalCeremony` alone,
    // off the reader's own second press.
    "stores the landed options without ever calling requestAssertion",
    () => {
      const setNote = vi.fn();
      const setExpanded = vi.fn();
      const setRemovalOptions = vi.fn();

      applyRemovalOptionsResult(
        { intent: "removalOptions", ok: true, credentialId: "abc", options: FAKE_OPTIONS },
        setNote,
        setExpanded,
        setRemovalOptions,
      );

      expect(setRemovalOptions).toHaveBeenCalledWith(FAKE_OPTIONS);
      expect(setNote).not.toHaveBeenCalled();
      expect(setExpanded).not.toHaveBeenCalled();
      expect(requestAssertion).not.toHaveBeenCalled();
    },
  );

  it("collapses the row back and notes the refusal when the fetch itself is refused", () => {
    const setNote = vi.fn();
    const setExpanded = vi.fn();
    const setRemovalOptions = vi.fn();

    applyRemovalOptionsResult(
      { intent: "removalOptions", ok: false, formError: "refused", credentialId: "abc" },
      setNote,
      setExpanded,
      setRemovalOptions,
    );

    expect(setNote).toHaveBeenCalledWith("refused");
    expect(setExpanded).toHaveBeenCalledWith(false);
    expect(setRemovalOptions).not.toHaveBeenCalled();
  });

  it("ignores a result meant for a different intent entirely", () => {
    const setNote = vi.fn();
    const setExpanded = vi.fn();
    const setRemovalOptions = vi.fn();

    applyRemovalOptionsResult(
      { intent: "remove", ok: true, credentialId: "abc" },
      setNote,
      setExpanded,
      setRemovalOptions,
    );

    expect(setNote).not.toHaveBeenCalled();
    expect(setExpanded).not.toHaveBeenCalled();
    expect(setRemovalOptions).not.toHaveBeenCalled();
  });
});

describe(
  "applyRemoveResult — the server-rejection twin of applyRemovalOptionsResult, for a row's own landed removal",
  () => {
    it("clears the note once the removal itself succeeds, and asks for nothing further", () => {
      const setNote = vi.fn();
      const refetchOptions = vi.fn();

      applyRemoveResult({ intent: "remove", ok: true, credentialId: "abc" }, setNote, refetchOptions);

      expect(setNote).toHaveBeenCalledWith(null);
      expect(refetchOptions).not.toHaveBeenCalled();
    });

    it(
      // The pin: before this fix, a removal the *server* refused left this
      // row's stale options in place — every later Confirm removal press
      // reused a challenge `lock.server.ts` had already marked spent the
      // moment it was read, and could never succeed again.
      "notes the server's own refusal and re-mints this row's options, because the challenge behind it is already spent",
      () => {
        const setNote = vi.fn();
        const refetchOptions = vi.fn();

        applyRemoveResult(
          { intent: "remove", ok: false, formError: "This passkey is no longer enrolled.", credentialId: "abc" },
          setNote,
          refetchOptions,
        );

        expect(setNote).toHaveBeenCalledWith("This passkey is no longer enrolled.");
        expect(refetchOptions).toHaveBeenCalledTimes(1);
      },
    );

    it("ignores a result meant for a different intent entirely", () => {
      const setNote = vi.fn();
      const refetchOptions = vi.fn();

      applyRemoveResult(
        { intent: "removalOptions", ok: true, credentialId: "abc", options: {} as never },
        setNote,
        refetchOptions,
      );

      expect(setNote).not.toHaveBeenCalled();
      expect(refetchOptions).not.toHaveBeenCalled();
    });
  },
);

describe("lockedByOtherRow — the page-level removal lock a row's own busy check folds in", () => {
  it("locks a row while a different row's removal is in flight", () => {
    expect(lockedByOtherRow("other-credential", "this-credential")).toBe(true);
  });

  it("leaves a row unlocked when no removal is in flight anywhere on the page", () => {
    expect(lockedByOtherRow(null, "this-credential")).toBe(false);
  });

  it(
    // A row's own in-flight removal is already covered by its own
    // `confirming`/`fetcher.state` — this only ever adds the case those two
    // cannot see: a *different* row's removal.
    "leaves a row unlocked for its own in-flight removal",
    () => {
      expect(lockedByOtherRow("this-credential", "this-credential")).toBe(false);
    },
  );
});

describe("removalConfirmDisabled — a row's own Confirm removal button, disabled while press 1's fetch is still in flight", () => {
  it.for([{ state: "loading" }, { state: "submitting" }] as const)(
    "stays disabled while this row's own options-fetch is $state, even once acknowledged",
    ({ state }) => {
      expect(removalConfirmDisabled(state, true, false)).toBe(true);
    },
  );

  it("is enabled once the fetch has landed, the checkbox is ticked, and nothing else is busy", () => {
    expect(removalConfirmDisabled("idle", true, false)).toBe(false);
  });

  it("stays disabled once landed if the acknowledgement is not ticked", () => {
    expect(removalConfirmDisabled("idle", false, false)).toBe(true);
  });

  it("stays disabled once landed and acknowledged if something else already makes the row busy", () => {
    expect(removalConfirmDisabled("idle", true, true)).toBe(true);
  });
});

describe("runRemovalCeremony — the removal's own ceremony, run directly off its own press with no browser", () => {
  const FAKE_OPTIONS = { challenge: "fixture-challenge" } as Awaited<ReturnType<typeof enrolmentAssertionOptions>>;

  afterEach(() => {
    vi.mocked(requestAssertion).mockReset();
  });

  it("submits the remove intent with the signed assertion and the removal acknowledgement once the ceremony succeeds, leaving the page-level lock in place", async () => {
    const response = assertionResponse("fixture-challenge");
    vi.mocked(requestAssertion).mockResolvedValue({ status: "ok", response });
    const submit = vi.fn().mockResolvedValue(undefined);
    const setNote = vi.fn();
    const setConfirming = vi.fn();
    const refetchOptions = vi.fn();
    const releaseLock = vi.fn();

    await runRemovalCeremony(
      FAKE_OPTIONS,
      "target-credential",
      submit as never,
      setNote,
      setConfirming,
      refetchOptions,
      releaseLock,
    );

    expect(refetchOptions).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith(
      {
        intent: "remove",
        credentialId: "target-credential",
        assertion: JSON.stringify(response),
        confirmRemoval: "true",
      },
      { method: "post" },
    );
    expect(setConfirming).toHaveBeenCalledWith(false);
    expect(setNote).not.toHaveBeenCalled();
    // The lock survives until this row's own submission actually lands
    // (the concurrent-removal lock) — releasing it here, before the response
    // is even in flight, is exactly what would let a second row's removal
    // race it.
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it("notes a dismissed prompt, submits nothing, re-mints this row's options, and releases the page-level lock", async () => {
    vi.mocked(requestAssertion).mockResolvedValue({ status: "dismissed" });
    const submit = vi.fn();
    const setNote = vi.fn();
    const setConfirming = vi.fn();
    const refetchOptions = vi.fn();
    const releaseLock = vi.fn();

    await runRemovalCeremony(
      FAKE_OPTIONS,
      "target-credential",
      submit as never,
      setNote,
      setConfirming,
      refetchOptions,
      releaseLock,
    );

    expect(submit).not.toHaveBeenCalled();
    expect(setNote).toHaveBeenCalledWith(expect.stringContaining("did not complete"));
    expect(setConfirming).toHaveBeenCalledWith(false);
    // The challenge is unspent but not immortal — two minutes, `lock.server.ts`.
    expect(refetchOptions).toHaveBeenCalledTimes(1);
    // No `remove` submission is ever going to land for this press, so nothing
    // else would ever release the lock this same press set.
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("carries a failed ceremony's own message, submits nothing, re-mints this row's options, and releases the page-level lock", async () => {
    vi.mocked(requestAssertion).mockResolvedValue({ status: "failed", message: "No authenticator found." });
    const submit = vi.fn();
    const setNote = vi.fn();
    const setConfirming = vi.fn();
    const refetchOptions = vi.fn();
    const releaseLock = vi.fn();

    await runRemovalCeremony(
      FAKE_OPTIONS,
      "target-credential",
      submit as never,
      setNote,
      setConfirming,
      refetchOptions,
      releaseLock,
    );

    expect(submit).not.toHaveBeenCalled();
    expect(setNote).toHaveBeenCalledWith("No authenticator found.");
    expect(setConfirming).toHaveBeenCalledWith(false);
    expect(refetchOptions).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });
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
      // The half that is not certain, pinned separately from the half that
      // is: whether a browser holding no passkey can be unlocked from one
      // that does is the registering provider's decision, and no device has
      // been tried (docs/operating.md, "Before the household's first
      // passkey"). A reader deciding whether to lock the household out is
      // owed both sentences, so both are asserted.
      expect(withoutOne).toContain("depends on the provider making this passkey");

      await seedFixturePasskey(seedPasskey);
      const withOne = renderRoute(
        Passkeys,
        "/settings/passkeys",
        await loader(args(get("/settings/passkeys"))),
      );
      expect(withOne).not.toContain("Enrolling this passkey locks every other browser");
      expect(withOne).not.toContain("depends on the provider making this passkey");
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

      expect(markup).toContain("Can sync to other devices");
      expect(markup).toContain("Bound to a single device");
    }),
  );

  it(
    // The browser-local date fix's first paint: the server has no browser
    // zone to correct to, so the enrolled/last-used columns render inside a
    // `<time>` element carrying the raw instant and `formatDate`'s own
    // UTC-pinned text — identical to what the client's own hydration render
    // produces before its effect ever runs, so nothing here can mismatch.
    "renders each date inside a <time> element carrying the raw instant, with formatDate's own UTC text as the first paint",
    withDatabase(async ({ seedPasskey }) => {
      await seedPasskey({
        publicKey: BYSTANDER_PUBLIC_KEY,
        label: "Kitchen iPad",
        lastUsedAt: new Date("2026-03-14T12:00:00Z"),
      });

      const markup = renderRoute(Passkeys, "/settings/passkeys", await loader(args(get("/settings/passkeys"))));

      expect(markup).toContain('dateTime="2026-03-14T12:00:00.000Z"');
      expect(markup).toContain(">14 Mar 2026<");
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
