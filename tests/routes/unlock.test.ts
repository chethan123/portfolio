/**
 * `app/routes/unlock.tsx` — the route's own contribution: asking the domain
 * module whether this screen is even needed before rendering it, reading a
 * submission it can never assume is well-formed, verifying through the
 * domain module, setting the grant cookie only on success, and honouring the
 * return path through `safeReturn`. Every rule about what a valid assertion
 * *is* belongs to `~/lib/lock.server` and is tested there
 * (`tests/lock.test.ts`); this file never re-derives one.
 *
 * The ceremony itself — `navigator.credentials.get()` — has no browser in
 * this suite and is not simulated here (the ticket's own list). What *is*
 * simulated is everything the component decides once the ceremony hands
 * back an outcome: `~/lib/unlock-ceremony` is mocked for exactly that,
 * leaving `shouldRunCeremony`/`runCeremony`/`shouldRevalidateBeforeRetry`
 * — the pure decisions the route pulls out of its effects so a mutation to
 * any of them is a failing assertion here rather than a state only a real
 * browser could ever notice (finding 10) — driven directly, with no DOM.
 *
 * Every assertion below that needs a signed WebAuthn response comes from
 * `tests/support/webauthn.ts`, signed for a challenge this file's own calls
 * to the loader actually minted, the same fixture `tests/lock.test.ts` signs
 * with.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import type { Fixtures } from "../support/fixtures.ts";
import { renderRoute } from "../support/render.tsx";
import { args, get, post, redirectTo } from "../support/routes.ts";
import { assertionResponse, backupEligible, credentialId, publicKey, transports } from "../support/webauthn.ts";

process.env.DATABASE_URL = TEST_DATABASE_URL;

// Mocked file-wide: nothing else in this suite exercises the real
// `@simplewebauthn/browser` ceremony (there is no browser here), and the
// component under test never calls either export outside a `useEffect` or a
// click handler, neither of which a server render or a direct loader/action
// call ever runs. `importOriginal` keeps every *type* this file borrows from
// the module (`AssertionOutcome` et al.) resolving against the real source.
vi.mock("~/lib/unlock-ceremony", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/unlock-ceremony")>();
  return { ...actual, requestAssertion: vi.fn(), supportsPasskeys: vi.fn() };
});

const {
  action,
  default: Unlock,
  loader,
  DismissedNote,
  NO_CEREMONY_MESSAGE,
  NOSCRIPT_MESSAGE,
  UNREADABLE_SUBMISSION_MESSAGE,
  UnlockControl,
  runCeremony,
  shouldRevalidateBeforeRetry,
  shouldRunCeremony,
  visibleRefusal,
} = await import("../../app/routes/unlock.tsx");
const { requestAssertion } = await import("~/lib/unlock-ceremony");
const { LOCK_COOKIE, verifyUnlock } = await import("~/lib/lock.server");
const { RETURN_PARAM } = await import("~/lib/lock");

afterAll(closeTestDatabase);

/** The one enrolled passkey `tests/support/webauthn.ts`'s fixture can sign for. */
function seedFixturePasskey(seedPasskey: Fixtures["seedPasskey"]) {
  return seedPasskey({ credentialId, publicKey, transports, backupEligible });
}

/**
 * Narrows the loader's own union return type for a call a test already
 * knows will render the screen rather than redirect past it — every caller
 * here has just seeded a passkey and sent no grant cookie, so the loader's
 * own escapes (finding 4) do not apply. Throwing on the redirect half turns
 * a wrong assumption into a clear failure right here, rather than a
 * confusing one three lines later against `undefined.challenge`.
 */
function expectScreenData(
  data: Awaited<ReturnType<typeof loader>>,
): Exclude<Awaited<ReturnType<typeof loader>>, Response> {
  if (data instanceof Response) {
    throw new Error("Expected the unlock screen's own data, and got a redirect instead.");
  }
  return data;
}

/** The `redirectTo` query string a browser's redirect to this screen carries (`lock.ts`'s `RETURN_PARAM`). */
function returnQuery(to: string): string {
  return new URLSearchParams({ [RETURN_PARAM]: to }).toString();
}

describe("the loader's own escapes — asking rather than assuming (finding 4)", () => {
  it(
    "sends a browser back to where it was going rather than rendering the screen, once the household holds no passkey at all",
    withDatabase(async () => {
      const location = await redirectTo(() =>
        loader(args(get(`/unlock?${returnQuery("/holdings?owner=2")}`))),
      );
      expect(location).toBe("/holdings?owner=2");
    }),
  );

  it(
    "sends an already-unlocked browser back to where it was going too, rather than minting it a second grant",
    withDatabase(async ({ db, seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const { options } = expectScreenData(await loader(args(get("/unlock"))));
      const grant = await verifyUnlock(assertionResponse(options.challenge), db);

      const before = await db
        .selectFrom("unlock_grant")
        .select((eb) => eb.fn.countAll().as("n"))
        .executeTakeFirstOrThrow();

      const location = await redirectTo(() =>
        loader(args(get(`/unlock?${returnQuery("/holdings")}`, `${LOCK_COOKIE}=${grant.id}`))),
      );
      expect(location).toBe("/holdings");

      const after = await db
        .selectFrom("unlock_grant")
        .select((eb) => eb.fn.countAll().as("n"))
        .executeTakeFirstOrThrow();
      expect(after.n).toBe(before.n);
    }),
  );

  it(
    "still renders the screen for a browser carrying a cookie that names no live grant",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const data = await loader(args(get("/unlock", `${LOCK_COOKIE}=not-a-real-grant-id`)));
      expect(data).not.toBeInstanceOf(Response);
    }),
  );
});

describe("the tab itself", () => {
  it(
    "reads the return address back through safeReturn, exactly as /masking and /refresh do",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const data = expectScreenData(
        await loader(args(get(`/unlock?${returnQuery("/holdings?owner=2&range=5y")}`))),
      );

      expect(data.redirectTo).toBe("/holdings?owner=2&range=5y");
    }),
  );

  it(
    "refuses an absolute URL as a return address, the way safeReturn always does",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const data = expectScreenData(await loader(args(get(`/unlock?${returnQuery("https://evil.test")}`))));

      expect(data.redirectTo).toBe("/");
    }),
  );

  it(
    "falls back to / when no return address was carried at all",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const data = expectScreenData(await loader(args(get("/unlock"))));

      expect(data.redirectTo).toBe("/");
    }),
  );

  it(
    "mints a fresh challenge on every load, not the same one twice",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const first = expectScreenData(await loader(args(get("/unlock"))));
      const second = expectScreenData(await loader(args(get("/unlock"))));

      expect(second.options.challenge).not.toBe(first.options.challenge);
    }),
  );
});

describe("a submission this route cannot even read (finding 1)", () => {
  it(
    "refuses a POST whose Content-Type it cannot parse as a form, rather than crashing",
    withDatabase(async () => {
      const request = new Request("http://portfolio.local/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assertion: "x" }),
      });
      const outcome = await action(args(request));
      expect(outcome).not.toBeInstanceOf(Response);
      expect((outcome as { formError: string }).formError).toBe(UNREADABLE_SUBMISSION_MESSAGE);
    }),
  );

  it(
    "refuses a POST with no body and no Content-Type, rather than crashing",
    withDatabase(async () => {
      const request = new Request("http://portfolio.local/unlock", { method: "POST" });
      const outcome = await action(args(request));
      expect(outcome).not.toBeInstanceOf(Response);
      expect((outcome as { formError: string }).formError).toBe(UNREADABLE_SUBMISSION_MESSAGE);
    }),
  );

  it(
    "refuses a POST of plain text, rather than crashing",
    withDatabase(async () => {
      const request = new Request("http://portfolio.local/unlock", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "not a form body",
      });
      const outcome = await action(args(request));
      expect(outcome).not.toBeInstanceOf(Response);
      expect((outcome as { formError: string }).formError).toBe(UNREADABLE_SUBMISSION_MESSAGE);
    }),
  );

  it(
    "refuses malformed multipart, rather than crashing",
    withDatabase(async () => {
      const request = new Request("http://portfolio.local/unlock", {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=broken" },
        body: "not actually multipart",
      });
      const outcome = await action(args(request));
      expect(outcome).not.toBeInstanceOf(Response);
      expect((outcome as { formError: string }).formError).toBe(UNREADABLE_SUBMISSION_MESSAGE);
    }),
  );

  it.for([{ method: "PUT" }, { method: "DELETE" }, { method: "PATCH" }])(
    "refuses a $method request the same way, rather than crashing",
    async ({ method }) => {
      const request = new Request("http://portfolio.local/unlock", { method });
      const outcome = await action(args(request));
      expect(outcome).not.toBeInstanceOf(Response);
      expect((outcome as { formError: string }).formError).toBe(UNREADABLE_SUBMISSION_MESSAGE);
    },
  );
});

describe("unlocking", () => {
  it(
    "verifies through the domain module and sets the cookie only on success",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const { options } = expectScreenData(await loader(args(get("/unlock"))));
      const response = assertionResponse(options.challenge);

      const outcome = await action(
        args(post("/unlock", { assertion: JSON.stringify(response), redirectTo: "/holdings" })),
      );

      expect(outcome).toBeInstanceOf(Response);
      const redirectResponse = outcome as Response;
      expect(redirectResponse.status).toBeGreaterThanOrEqual(300);
      expect(redirectResponse.status).toBeLessThan(400);
      expect(redirectResponse.headers.get("Location")).toBe("/holdings");
      expect(redirectResponse.headers.get("Set-Cookie")).toContain(`${LOCK_COOKIE}=`);
    }),
  );

  it(
    "honours the return path on success, and refuses an absolute one through safeReturn",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const { options } = expectScreenData(await loader(args(get("/unlock"))));
      const response = assertionResponse(options.challenge);

      const outcome = await action(
        args(post("/unlock", { assertion: JSON.stringify(response), redirectTo: "https://evil.test" })),
      );

      expect((outcome as Response).headers.get("Location")).toBe("/");
    }),
  );

  it(
    "supersedes the grant the browser arrived carrying, rather than leaving a second one live",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      // A browser reaches this screen still holding a live cookie whenever it
      // followed a stale `redirectTo` or raced its own re-entry post. The
      // route hands that cookie down as `supersedes`, so what it carries next
      // is the only row it has.
      const passkey = await seedFixturePasskey(seedPasskey);
      const prior = await seedUnlockGrant({ passkeyId: passkey.credentialId });

      const { options } = expectScreenData(await loader(args(get("/unlock"))));
      const response = assertionResponse(options.challenge);

      const outcome = await action(
        args(
          post(
            "/unlock",
            { assertion: JSON.stringify(response), redirectTo: "/" },
            `${LOCK_COOKIE}=${prior.id}`,
          ),
        ),
      );

      const setCookie = (outcome as Response).headers.get("Set-Cookie") ?? "";
      const minted = setCookie.slice(`${LOCK_COOKIE}=`.length).split(";")[0];
      expect(minted).not.toBe(prior.id);

      const live = await db.selectFrom("unlock_grant").select("id").execute();
      expect(live.map((row) => row.id)).toEqual([minted]);
    }),
  );

  it(
    "a refused assertion sets no cookie and mints no grant",
    withDatabase(async ({ db }) => {
      // A challenge this instance never minted — refused by `takeChallenge`
      // before the library's own verifier ever runs, the same as any request
      // naming a confirmation this instance did not issue.
      const response = assertionResponse("never-issued-AAAAAAAAAAAAAAAAAAAA");
      const before = await db
        .selectFrom("unlock_grant")
        .select((eb) => eb.fn.countAll().as("n"))
        .executeTakeFirstOrThrow();

      const outcome = await action(
        args(post("/unlock", { assertion: JSON.stringify(response), redirectTo: "/" })),
      );

      expect(outcome).not.toBeInstanceOf(Response);
      expect((outcome as { formError: string }).formError).toContain("never issued");

      const after = await db
        .selectFrom("unlock_grant")
        .select((eb) => eb.fn.countAll().as("n"))
        .executeTakeFirstOrThrow();
      expect(after.n).toBe(before.n);
    }),
  );

  it(
    "treats an assertion field that is not JSON as an unreadable response, not a crash",
    withDatabase(async () => {
      const outcome = await action(args(post("/unlock", { assertion: "not-json-at-all", redirectTo: "/" })));

      expect(outcome).not.toBeInstanceOf(Response);
      expect((outcome as { formError: string }).formError).toContain("could not be read");
    }),
  );

  it(
    "refuses a submission carrying no assertion at all, the same way, rather than crashing",
    withDatabase(async () => {
      const outcome = await action(args(post("/unlock", { redirectTo: "/" })));

      expect(outcome).not.toBeInstanceOf(Response);
      expect((outcome as { formError: string }).formError).toContain("could not be read");
    }),
  );

  it(
    "prints the domain module's own refusal verbatim, driven end to end through the real action rather than a hand-built fixture (finding 10)",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const loaderData = await loader(args(get("/unlock")));
      const never = assertionResponse("never-issued-AAAAAAAAAAAAAAAAAAAA");

      const actionData = await action(
        args(post("/unlock", { assertion: JSON.stringify(never), redirectTo: "/" })),
      );

      const markup = renderRoute(Unlock, "/unlock", loaderData, { actionData });

      // Anchored on both sides, not a bare substring: a mutation returning
      // `String(error)` instead of the domain module's own message would
      // print `ValidationError: This one-time confirmation…`, which still
      // *contains* the sentence below but never sits immediately after `>`.
      expect(markup).toContain(">This one-time confirmation was never issued by this instance. Start again.</p>");
    }),
  );
});

describe("what the screen renders", () => {
  it(
    "says the app is locked and offers exactly one button",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const loaderData = await loader(args(get("/unlock")));
      const markup = renderRoute(Unlock, "/unlock", loaderData);

      expect(markup).toContain("Locked");
      expect(markup).toContain("passkey");
      expect(markup).toContain(">Unlock<");
      expect(markup.match(/<button\b/g)?.length ?? 0).toBe(1);
    }),
  );

  it(
    "says this browser is locked, not this instance — CONTEXT.md's Locked entry is about the browser",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const loaderData = await loader(args(get("/unlock")));
      const markup = renderRoute(Unlock, "/unlock", loaderData);

      expect(markup).toContain("This browser is locked");
      expect(markup).not.toContain("This instance is locked");
    }),
  );

  it(
    "never reaches for the vocabulary CONTEXT.md's Passkey entry rules out",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const loaderData = await loader(args(get("/unlock")));
      const markup = renderRoute(Unlock, "/unlock", loaderData).toLowerCase();

      // "key" is deliberately not in this list: `passkey`/`passkeys` — the
      // one word this screen is built around — contains it as a bare
      // substring, so checking for it naively would fail against the
      // screen's own correct copy rather than against a regression.
      for (const word of ["biometric", "fingerprint", "face", "device credential", "enrolled device"]) {
        expect(markup).not.toContain(word);
      }
    }),
  );

  it(
    "carries a noscript message that says scripting is what is missing, not what this browser lacks",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const loaderData = await loader(args(get("/unlock")));
      const markup = renderRoute(Unlock, "/unlock", loaderData);

      expect(markup).toContain("<noscript");
      expect(markup).toContain(NOSCRIPT_MESSAGE);
      expect(markup).toContain("scripting");
    }),
  );

  it(
    "names three recoveries: another browser, another device, and someone a family member can actually ask",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const loaderData = await loader(args(get("/unlock")));
      const markup = renderRoute(Unlock, "/unlock", loaderData);

      expect(markup).toContain("another browser on this device");
      expect(markup).toContain("a device that can reach a passkey the household has enrolled");
      expect(markup).toContain("ask whoever set this app up");
    }),
  );

  it(
    "prints the domain module's own refusal, verbatim, when the last attempt was refused",
    withDatabase(async ({ seedPasskey }) => {
      await seedFixturePasskey(seedPasskey);
      const loaderData = await loader(args(get("/unlock")));
      const markup = renderRoute(Unlock, "/unlock", loaderData, {
        actionData: { formError: "This passkey is not enrolled on this instance." },
      });

      expect(markup).toContain("This passkey is not enrolled on this instance.");
    }),
  );
});

describe("visibleRefusal — which phase may show which refusal (finding 10: a stale one in every phase)", () => {
  it("shows the server's own refusal only while idle", () => {
    expect(visibleRefusal("idle", "server said no", null)).toBe("server said no");
  });

  it("hides the server's refusal the moment a fresh press starts, before any outcome exists", () => {
    expect(visibleRefusal("confirming", "server said no", null)).toBeNull();
  });

  it("shows this attempt's own client message only once it has failed, never the server's stale one", () => {
    expect(visibleRefusal("failed", "an older server refusal", "this attempt's own message")).toBe(
      "this attempt's own message",
    );
  });

  it("shows nothing for a dismissed prompt — that is a note, not a refusal", () => {
    expect(visibleRefusal("dismissed", "server said no", "client said no")).toBeNull();
  });
});

describe("shouldRevalidateBeforeRetry — finding 10's revalidator.revalidate() guard", () => {
  it("does not refetch when the last attempt round-tripped to the server", () => {
    expect(shouldRevalidateBeforeRetry("idle")).toBe(false);
  });

  it.for([{ phase: "dismissed" }, { phase: "failed" }] as const)(
    "refetches before a retry when the last attempt was $phase — it never reached the server, so the options page never spent",
    ({ phase }) => {
      expect(shouldRevalidateBeforeRetry(phase)).toBe(true);
    },
  );
});

describe("shouldRunCeremony — finding 10's 'returning early so no ceremony ever runs'", () => {
  it("runs on a fresh press once options are not mid-refresh and nothing is already in flight", () => {
    expect(shouldRunCeremony("confirming", "idle", false)).toBe(true);
  });

  it.for([{ phase: "idle" }, { phase: "dismissed" }, { phase: "failed" }] as const)(
    "never runs before a press ($phase)",
    ({ phase }) => {
      expect(shouldRunCeremony(phase, "idle", false)).toBe(false);
    },
  );

  it.for([{ state: "loading" }, { state: "submitting" }] as const)(
    "never runs while the loader is $state — the options in hand might not be this press's yet",
    ({ state }) => {
      expect(shouldRunCeremony("confirming", state, false)).toBe(false);
    },
  );

  it("never runs a second time for the same press", () => {
    expect(shouldRunCeremony("confirming", "idle", true)).toBe(false);
  });
});

describe("UnlockControl — finding 10's untested unsupported-browser branch and disabled attribute", () => {
  it.for([{ supported: null }, { supported: true }] as const)(
    "offers the button when supported is $supported",
    ({ supported }) => {
      const markup = renderToStaticMarkup(
        UnlockControl({ supported, phase: "idle", revalidatorState: "idle", onUnlock: () => {} }),
      );
      expect(markup).toContain(">Unlock<");
    },
  );

  it("shows the no-ceremony message instead of a button once the browser is confirmed unable to run one", () => {
    const markup = renderToStaticMarkup(
      UnlockControl({ supported: false, phase: "idle", revalidatorState: "idle", onUnlock: () => {} }),
    );
    expect(markup).not.toContain("<button");
    expect(markup).toContain(NO_CEREMONY_MESSAGE);
  });

  it("disables the button while a ceremony is in flight", () => {
    const confirming = renderToStaticMarkup(
      UnlockControl({ supported: true, phase: "confirming", revalidatorState: "idle", onUnlock: () => {} }),
    );
    expect(confirming).toContain('disabled=""');

    const idle = renderToStaticMarkup(
      UnlockControl({ supported: true, phase: "idle", revalidatorState: "idle", onUnlock: () => {} }),
    );
    expect(idle).not.toContain("disabled");
  });

  it(
    // The pin for finding 5: a dismissed or failed attempt starts
    // `loaderData.options` revalidating without moving `phase` off "idle"
    // (`runCeremony`'s own header) — before this fix, a press accepted here
    // ran the ceremony only after this same effect waited on that
    // already-in-flight network round trip, spending the click's activation
    // on the wait rather than the check.
    "disables the button while its revalidator is refreshing stale options, even though phase itself is idle",
    () => {
      const loading = renderToStaticMarkup(
        UnlockControl({ supported: true, phase: "idle", revalidatorState: "loading", onUnlock: () => {} }),
      );
      expect(loading).toContain('disabled=""');

      const submitting = renderToStaticMarkup(
        UnlockControl({ supported: true, phase: "idle", revalidatorState: "submitting", onUnlock: () => {} }),
      );
      expect(submitting).toContain('disabled=""');
    },
  );
});

describe("DismissedNote — finding 10's cancelled-prompt note", () => {
  it("shows the note only once a prompt is dismissed", () => {
    const markup = renderToStaticMarkup(DismissedNote({ phase: "dismissed" }));
    expect(markup).toContain("did not complete");
  });

  it.for([{ phase: "idle" }, { phase: "confirming" }, { phase: "failed" }] as const)(
    "shows nothing while $phase",
    ({ phase }) => {
      expect(renderToStaticMarkup(DismissedNote({ phase }))).toBe("");
    },
  );
});

describe("runCeremony", () => {
  const FAKE_OPTIONS = { challenge: "fixture-challenge" } as Parameters<typeof requestAssertion>[0];

  afterEach(() => {
    vi.mocked(requestAssertion).mockReset();
  });

  it(
    "submits the response and returns the button to idle once the ceremony succeeds, without revalidating",
    async () => {
      const response = assertionResponse("fixture-challenge");
      vi.mocked(requestAssertion).mockResolvedValue({ status: "ok", response });
      const submit = vi.fn().mockResolvedValue(undefined);
      const setPhase = vi.fn();
      const setClientMessage = vi.fn();
      const revalidate = vi.fn();

      await runCeremony(FAKE_OPTIONS, "/holdings", submit as never, setPhase, setClientMessage, revalidate);

      expect(submit).toHaveBeenCalledWith(
        { assertion: JSON.stringify(response), redirectTo: "/holdings" },
        { method: "post" },
      );
      expect(setPhase).toHaveBeenCalledWith("idle");
      expect(setClientMessage).not.toHaveBeenCalled();
      // `submit`'s own promise already carries a post-action revalidation
      // (this file's own header) — a second one here would be redundant.
      expect(revalidate).not.toHaveBeenCalled();
    },
  );

  it(
    // Finding: a retry used to wait for a *later* button press to call
    // `revalidator.revalidate()`, which ran the ceremony behind a pending
    // network round trip and outside that press's own user activation. This
    // is the pin: `runCeremony` — not a subsequent press — is what calls
    // `revalidate` the moment it learns the options it just used are now
    // stale, immediately on this same outcome rather than deferred to
    // whenever a reader next presses Unlock.
    "revalidates immediately once a dismissed prompt leaves the options stale, without ever submitting",
    async () => {
      vi.mocked(requestAssertion).mockResolvedValue({ status: "dismissed" });
      const submit = vi.fn();
      const setPhase = vi.fn();
      const setClientMessage = vi.fn();
      const revalidate = vi.fn();

      await runCeremony(FAKE_OPTIONS, "/", submit as never, setPhase, setClientMessage, revalidate);

      expect(submit).not.toHaveBeenCalled();
      expect(setPhase).toHaveBeenCalledWith("dismissed");
      expect(setClientMessage).not.toHaveBeenCalled();
      expect(revalidate).toHaveBeenCalled();
    },
  );

  it(
    // Same pin as the dismissed case above, for the other outcome that
    // leaves `loaderData.options` stale.
    "revalidates immediately once a failed ceremony leaves the options stale, carrying its own message without submitting",
    async () => {
      vi.mocked(requestAssertion).mockResolvedValue({ status: "failed", message: "No authenticator found." });
      const submit = vi.fn();
      const setPhase = vi.fn();
      const setClientMessage = vi.fn();
      const revalidate = vi.fn();

      await runCeremony(FAKE_OPTIONS, "/", submit as never, setPhase, setClientMessage, revalidate);

      expect(submit).not.toHaveBeenCalled();
      expect(setClientMessage).toHaveBeenCalledWith("No authenticator found.");
      expect(setPhase).toHaveBeenCalledWith("failed");
      expect(revalidate).toHaveBeenCalled();
    },
  );
});
