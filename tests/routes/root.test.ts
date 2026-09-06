// The one loader and (ticket 03) one middleware that run on every page render. firstRunStep() throws when Postgres is
// unreachable and this loader is an error boundary on every route, so a database merely restarting would error-page
// every screen — one try is the fix, and the easiest thing to tidy away. Every middleware refusal below is proven on
// next() never being invoked (servedThrough's onNext), never on inspecting a response a refusal never produced.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import { args, get, post, redirectTo, responseOf, servedThrough } from "../support/routes.ts";
import { saveMaskingPolicy } from "~/lib/settings.server";

process.env.DATABASE_URL = TEST_DATABASE_URL;

// Seam onto touchGrant so one test can fail the grant check independently of isLocked — a single unreachable DB can't fail
// one without the other, since isLocked (read first) would already refuse. undefined defers to the real function.
const touchGrantOverride = vi.hoisted(() => ({
  impl: undefined as ((id: string, db?: unknown) => Promise<unknown>) | undefined,
}));

vi.mock("~/lib/lock.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/lock.server")>();
  return {
    ...actual,
    touchGrant: (...callArgs: Parameters<typeof actual.touchGrant>) =>
      touchGrantOverride.impl ? touchGrantOverride.impl(...callArgs) : actual.touchGrant(...callArgs),
  };
});

const { LOCK_EXEMPT_PATHS, loader, middleware } = await import("../../app/root.tsx");
const { createDatabase, withDb } = await import("~/lib/db.server");
const { LOCK_COOKIE, readGrant } = await import("~/lib/lock.server");
const { stopPricePoller } = await import("~/lib/price-poller.server");

/** Refused immediately, which is how "the database is down" arrives here. */
const UNREACHABLE_DATABASE_URL = "postgres://portfolio:portfolio@127.0.0.1:1/portfolio_test";

// This loader also starts the refresh loop (§6.2) — a real 15-minute interval holding the live Yahoo provider, unref'd
// but otherwise outliving this file. Stopped after every test.
afterEach(stopPricePoller);

afterAll(closeTestDatabase);

describe("the shell's loader", () => {
  it("reports no first-run step rather than propagating, when the database cannot be reached", async () => {
    const unreachable = createDatabase(UNREACHABLE_DATABASE_URL);

    try {
      const data = await withDb(unreachable, () => loader(args(get("/"))));

      expect(data.firstRun).toBeNull(); // "no prompt", not a thrown Response or an error page
      expect(data.masked).toBe(true); // fail-safe: cannot put balances on screen while unreachable (spec 0007)
      expect(data.hasPasskey).toBe(false); // fail-safe: no control, rather than one clearing a grant that may not exist
    } finally {
      await unreachable.destroy();
    }
  });

  it(
    "reports the step the instance is actually on when the database answers",
    withDatabase(async ({ seedPerson }) => {
      await seedPerson();

      expect((await loader(args(get("/")))).firstRun).toBe("accounts");
    }),
  );

  it(
    "reports hasPasskey once the household holds a passkey, so the lock-now control has something to do",
    withDatabase(async ({ seedPasskey }) => {
      await seedPasskey({ publicKey: new Uint8Array([1, 1, 1]) });

      expect((await loader(args(get("/")))).hasPasskey).toBe(true);
    }),
  );

  it(
    "reports no passkey while the household holds none at all",
    withDatabase(async () => {
      expect((await loader(args(get("/")))).hasPasskey).toBe(false);
    }),
  );
});

describe("the shell's loader on /unlock — the household's setup state must not reach the hydration payload", () => {
  // Asserted on the loader's returned object, not markup — Layout never prints these fields for /unlock either way,
  // so a markup assertion would pass whether or not this fix existed (hiding the chrome hid the consumers, not the data).
  it(
    "answers gated, firstRun, masked, maskingPolicy and hasPasskey with fixed neutral values, never the household's real ones",
    withDatabase(async ({ db, seedPasskey, seedPerson }) => {
      // Real state that would answer differently below for /unlock, had this loader read any of it there.
      await seedPerson();
      await seedPasskey({ publicKey: new Uint8Array([2, 2, 2]) });
      await saveMaskingPolicy({ maskingPolicy: "unmasked" }, db);

      const real = await loader(args(get("/")));
      expect(real).toMatchObject({
        gated: false,
        firstRun: "accounts",
        masked: false,
        maskingPolicy: "unmasked",
        hasPasskey: true,
      });

      const unlockScreen = await loader(args(get("/unlock")));
      expect(unlockScreen).toEqual({
        gated: true,
        firstRun: null,
        masked: true,
        maskingPolicy: "masked",
        hasPasskey: false,
      });
    }),
  );

  it(
    "answers the same neutral values even when the database cannot be reached at all",
    async () => {
      const unreachable = createDatabase(UNREACHABLE_DATABASE_URL);
      try {
        const data = await withDb(unreachable, () => loader(args(get("/unlock"))));
        expect(data).toEqual({
          gated: true,
          firstRun: null,
          masked: true,
          maskingPolicy: "masked",
          hasPasskey: false,
        });
      } finally {
        await unreachable.destroy();
      }
    },
  );

  it(
    "still starts the price poller on a request to /unlock — the one route every render passes through before anyone has unlocked anything",
    withDatabase(async () => {
      // Symbol.for registry key (price-poller.server.ts) names the identical global without importing anything internal or forcing a real tick.
      const POLLER_SLOT = Symbol.for("portfolio.pricePoller");
      const host = globalThis as unknown as Record<symbol, unknown>;
      expect(host[POLLER_SLOT]).toBeUndefined();

      await loader(args(get("/unlock")));

      expect(host[POLLER_SLOT]).toBeDefined();
    }),
  );
});

/** No test below verifies a signature; only a distinct byte string per row matters. */
const A_PUBLIC_KEY = new Uint8Array([1, 2, 3, 4]);

describe("the lock middleware", () => {
  it("names exactly the two paths the lock does not guard, so a third takes a deliberate edit here", () => {
    expect(LOCK_EXEMPT_PATHS).toEqual(["/unlock", "/healthz"]);
  });

  it(
    "calls next unconditionally while the household holds no passkey — the no-op this pull request ships",
    withDatabase(async () => {
      let called = false;
      const response = await servedThrough(middleware, get("/holdings"), {}, () => {
        called = true;
      });

      expect(called).toBe(true);
      expect(await response.text()).toBe("the page");
    }),
  );

  it(
    "never invokes next once a passkey is enrolled and the browser carries no grant",
    withDatabase(async ({ seedPasskey }) => {
      await seedPasskey({ publicKey: A_PUBLIC_KEY });
      let called = false;

      await responseOf(() =>
        servedThrough(middleware, get("/holdings"), {}, () => {
          called = true;
        }),
      );

      expect(called).toBe(false); // next never invoked — not merely "response carries no figure", which a refusal renders vacuously
    }),
  );

  it(
    "sends a locked, grant-less browser to the unlock screen carrying its own address as one encoded parameter",
    withDatabase(async ({ seedPasskey }) => {
      await seedPasskey({ publicKey: A_PUBLIC_KEY });

      const location = await redirectTo(() =>
        servedThrough(middleware, get("/holdings?owner=2&range=5y")),
      );

      const target = new URL(location, "http://portfolio.local");
      expect(target.pathname).toBe("/unlock");
      // The whole point: the sign-in redirect truncates a target at the first & (ADR-0012, docs/specs/0019-the-lock.md).
      expect([...target.searchParams.keys()]).toEqual(["redirectTo"]);
      expect(target.searchParams.get("redirectTo")).toBe("/holdings?owner=2&range=5y");
      expect(location).not.toContain("&");
    }),
  );

  it(
    "sends a refused POST to / with no return address, since a GET cannot replay a form post",
    withDatabase(async ({ seedPasskey }) => {
      await seedPasskey({ publicKey: A_PUBLIC_KEY });

      // /masking exports an action only — a return address built from its pathname would send GET /masking, a 400.
      const location = await redirectTo(() => servedThrough(middleware, post("/masking", {})));

      expect(location).toBe("/unlock");
    }),
  );

  it("refuses rather than continues when the lock check itself cannot reach the database", async () => {
    const unreachable = createDatabase(UNREACHABLE_DATABASE_URL);
    let called = false;

    try {
      const response = await withDb(unreachable, () =>
        responseOf(() =>
          servedThrough(middleware, get("/holdings"), {}, () => {
            called = true;
          }),
        ),
      );

      // Refused exactly like an ordinary "no grant" — never collapsed into "no passkey enrolled", a different answer.
      expect(called).toBe(false);
      expect(response.status).toBeGreaterThanOrEqual(300);
      expect(response.status).toBeLessThan(400);
      expect(response.headers.get("Set-Cookie")).toBeNull(); // a failed read is not proof the cookie's grant is gone
    } finally {
      await unreachable.destroy();
    }
  });

  it(
    "refuses rather than continues when the grant check itself cannot reach the database",
    withDatabase(async ({ seedPasskey }) => {
      // Distinct from above: isLocked answers normally (real seeded passkey) and only the second read (touchGrant) fails —
      // a single unreachable DB can't isolate this since isLocked would refuse first.
      await seedPasskey({ publicKey: A_PUBLIC_KEY });
      let called = false;
      touchGrantOverride.impl = async () => {
        throw new Error("connection reset mid-query");
      };

      try {
        const response = await responseOf(() =>
          servedThrough(middleware, get("/holdings", `${LOCK_COOKIE}=some-grant-id`), {}, () => {
            called = true;
          }),
        );

        expect(called).toBe(false);
        expect(response.status).toBeGreaterThanOrEqual(300);
        expect(response.status).toBeLessThan(400);
        expect(response.headers.get("Set-Cookie")).toBeNull(); // a failed read is not proof the grant is gone
      } finally {
        touchGrantOverride.impl = undefined;
      }
    }),
  );

  it(
    "clears the grant cookie on a refusal that is itself a POST to /lock-now carrying that browser's own grant, since an outage must not strand a grant the reader asked to end",
    async () => {
      // Finding 3: an outage in isLocked refuses here, before /lock-now's own action (which clears the cookie) ever
      // runs — pressing "Lock now" during the outage must still end the grant, or the cookie survives to readmit once
      // the DB recovers. Cookie seeded here (finding 4) since a genuine same-origin press always carries it.
      const unreachable = createDatabase(UNREACHABLE_DATABASE_URL);
      let called = false;

      try {
        const response = await withDb(unreachable, () =>
          responseOf(() =>
            servedThrough(middleware, post("/lock-now", {}, `${LOCK_COOKIE}=some-grant-id`), {}, () => {
              called = true;
            }),
          ),
        );

        expect(called).toBe(false);
        expect(response.status).toBeGreaterThanOrEqual(300);
        expect(response.status).toBeLessThan(400);
        expect(response.headers.get("Set-Cookie")).toMatch(/max-age=0/i);
      } finally {
        await unreachable.destroy();
      }
    },
  );

  it(
    "leaves the grant cookie alone on a refusal that is a POST to /lock-now during an outage, when the request carries no grant cookie at all — the cross-site forgery shape (finding 4, P1)",
    async () => {
      // SameSite=Lax withholds LOCK_COOKIE from a cross-site form POST, so a request with no cookie at all is exactly
      // what a forged auto-submit to /lock-now produces — indistinguishable by path+method from a real press during an
      // outage. Requiring the cookie fixes this without a second CSRF mechanism beside Origin/SameSite=Lax (ADR-0005).
      const unreachable = createDatabase(UNREACHABLE_DATABASE_URL);
      let called = false;

      try {
        const response = await withDb(unreachable, () =>
          responseOf(() =>
            servedThrough(middleware, post("/lock-now", {}), {}, () => {
              called = true;
            }),
          ),
        );

        expect(called).toBe(false);
        expect(response.status).toBeGreaterThanOrEqual(300);
        expect(response.status).toBeLessThan(400);
        expect(response.headers.get("Set-Cookie")).toBeNull();
      } finally {
        await unreachable.destroy();
      }
    },
  );

  it(
    "leaves the grant cookie alone on a refusal that is a POST to /lock-now with no grant cookie, even while the household is locked and the database is perfectly reachable — the ordinary-operation cross-site shape (finding 4, P1)",
    withDatabase(async ({ seedPasskey }) => {
      // The same forgery without needing an outage — no outage required, the more common shape in practice.
      await seedPasskey({ publicKey: A_PUBLIC_KEY });
      let called = false;

      const response = await responseOf(() =>
        servedThrough(middleware, post("/lock-now", {}), {}, () => {
          called = true;
        }),
      );

      expect(called).toBe(false);
      expect(response.status).toBeGreaterThanOrEqual(300);
      expect(response.status).toBeLessThan(400);
      expect(response.headers.get("Set-Cookie")).toBeNull();
    }),
  );

  it(
    "leaves the grant cookie alone on a refusal from a GET to /lock-now, since a crawler or a pasted link never asked to end anyone's session",
    async () => {
      // /lock-now is action-only, so nothing a reader did produces a GET there — a crawler, pasted URL, or stray retry, never an intent to end the session.
      const unreachable = createDatabase(UNREACHABLE_DATABASE_URL);
      let called = false;

      try {
        const response = await withDb(unreachable, () =>
          responseOf(() =>
            servedThrough(middleware, get("/lock-now"), {}, () => {
              called = true;
            }),
          ),
        );

        expect(called).toBe(false);
        expect(response.status).toBeGreaterThanOrEqual(300);
        expect(response.status).toBeLessThan(400);
        expect(response.headers.get("Set-Cookie")).toBeNull();
      } finally {
        await unreachable.destroy();
      }
    },
  );

  it(
    "clears the grant cookie on a refusal from a POST to a percent-encoded spelling of /lock-now, since the router would match it the same way",
    async () => {
      // Finding D: react-router decodes each pathname segment before matching (decodePath, 7.18.2), so POST /lock%2Dnow
      // reaches the same action as /lock-now. Comparing the raw undecoded pathname (normalizedPathname reverted to
      // pathname.toLowerCase() without decoding) fails this the same way finding 3 failed the plain spelling.
      const unreachable = createDatabase(UNREACHABLE_DATABASE_URL);
      let called = false;

      try {
        const response = await withDb(unreachable, () =>
          responseOf(() =>
            servedThrough(middleware, post("/lock%2Dnow", {}, `${LOCK_COOKIE}=some-grant-id`), {}, () => {
              called = true;
            }),
          ),
        );

        expect(called).toBe(false);
        expect(response.status).toBeGreaterThanOrEqual(300);
        expect(response.status).toBeLessThan(400);
        expect(response.headers.get("Set-Cookie")).toMatch(/max-age=0/i);
      } finally {
        await unreachable.destroy();
      }
    },
  );

  it(
    "refuses without throwing, and leaves the cookie alone, on a path carrying a malformed percent escape",
    async () => {
      // Finding D's other half: decodeURIComponent throws on a dangling % — decodedPathname's catch falls back to the
      // raw value (matching decodePath), so this is an ordinary refusal, not a 500 from an uncaught URIError.
      const unreachable = createDatabase(UNREACHABLE_DATABASE_URL);
      let called = false;

      try {
        const response = await withDb(unreachable, () =>
          responseOf(() =>
            servedThrough(middleware, post("/lock-now%", {}), {}, () => {
              called = true;
            }),
          ),
        );

        expect(called).toBe(false);
        expect(response.status).toBeGreaterThanOrEqual(300);
        expect(response.status).toBeLessThan(400);
        expect(response.headers.get("Set-Cookie")).toBeNull();
      } finally {
        await unreachable.destroy();
      }
    },
  );

  it(
    "invokes next, and lets its stand-in response through, once the browser holds a live grant",
    withDatabase(async ({ seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedPasskey({ publicKey: A_PUBLIC_KEY });
      const grant = await seedUnlockGrant({ passkeyId: passkey.credentialId });
      let called = false;

      const response = await servedThrough(
        middleware,
        get("/holdings", `${LOCK_COOKIE}=${grant.id}`),
        {},
        () => {
          called = true;
        },
      );

      expect(called).toBe(true); // that next itself ran, not just that the stand-in body came back
      expect(await response.text()).toBe("the page");
      expect(response.headers.get("Cache-Control")).toBe("no-store"); // a bfcache restore never asks the server, so deleting the grant alone wouldn't stop it reappearing
    }),
  );

  it(
    "refuses an expired grant, never invoking next, and clears its cookie so a stale value does not survive to confuse the next unlock",
    withDatabase(async ({ seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedPasskey({ publicKey: A_PUBLIC_KEY });
      const grant = await seedUnlockGrant({
        passkeyId: passkey.credentialId,
        expiresAt: new Date(Date.now() - 1000),
      });
      let called = false;

      const response = await responseOf(() =>
        servedThrough(middleware, get("/holdings", `${LOCK_COOKIE}=${grant.id}`), {}, () => {
          called = true;
        }),
      );

      expect(called).toBe(false);
      expect(response.headers.get("Set-Cookie")).toMatch(/max-age=0/i);
    }),
  );

  it(
    "extends a grant with less than half its idle window remaining, and it survives past its original expiry",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedPasskey({ publicKey: A_PUBLIC_KEY });
      const originalExpiry = new Date(Date.now() + 1000);
      const grant = await seedUnlockGrant({ passkeyId: passkey.credentialId, expiresAt: originalExpiry });

      await servedThrough(middleware, get("/holdings", `${LOCK_COOKIE}=${grant.id}`));

      const extended = await readGrant(grant.id, db);
      expect(extended?.expiresAt.getTime()).toBeGreaterThan(originalExpiry.getTime());
    }),
  );

  it(
    "lets each exempt path through while the household is locked",
    withDatabase(async ({ seedPasskey }) => {
      await seedPasskey({ publicKey: A_PUBLIC_KEY });

      for (const path of LOCK_EXEMPT_PATHS) {
        let called = false;
        await servedThrough(middleware, get(path), {}, () => {
          called = true;
        });
        expect(called).toBe(true);
      }
    }),
  );

  it(
    "exempts a path the router would also match, whatever case or trailing slash it arrives in",
    withDatabase(async ({ seedPasskey }) => {
      await seedPasskey({ publicKey: A_PUBLIC_KEY });

      // compilePath (react-router 7.18.2) matches case-insensitively and tolerates trailing slashes — Array.includes alone does neither.
      for (const path of ["/HEALTHZ", "/healthz/", "/healthz//", "/Unlock", "/unlock/"]) {
        let called = false;
        await servedThrough(middleware, get(path), {}, () => {
          called = true;
        });
        expect(called).toBe(true);
      }
    }),
  );

  it(
    "does not exempt a path that merely starts with an exempt one",
    withDatabase(async ({ seedPasskey }) => {
      await seedPasskey({ publicKey: A_PUBLIC_KEY });

      // Guards the comparison's shape, not just its data — a startsWith rewrite would wrongly wave both through, uncaught by the array-contents test above.
      for (const path of ["/unlockables", "/healthz-debug"]) {
        let called = false;
        await responseOf(() =>
          servedThrough(middleware, get(path), {}, () => {
            called = true;
          }),
        );
        expect(called).toBe(false);
      }
    }),
  );

  it(
    "carries Cache-Control: no-store on a response it lets through",
    withDatabase(async () => {
      const response = await servedThrough(middleware, get("/"));
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }),
  );

  it(
    "carries Cache-Control: no-store on a response the exempt branch lets through too",
    withDatabase(async () => {
      // /healthz sets its own no-store today, masking a removed withNoStore here — /unlock has no such fallback, the bfcache hole the ADR names.
      const response = await servedThrough(middleware, get("/unlock"));
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }),
  );
});

// Listed before the lock: who may ask, answered for document/single-fetch mutations, never a resource route
// (crossOriginMutationMiddleware's header cites where each runs). Runs the whole exported array, as the lock's tests do.
describe("the cross-origin mutation refusal", () => {
  it("refuses a mutation whose Origin is not this instance, before any database call is made", async () => {
    // Unreachable DB deliberately — isLocked() would throw and redirect, so a 400 proves this refusal ran ahead of it.
    const unreachable = createDatabase(UNREACHABLE_DATABASE_URL);
    let called = false;

    try {
      const response = await withDb(unreachable, () =>
        responseOf(() =>
          servedThrough(middleware, post("/lock-now", {}, undefined, { Origin: "https://evil.test" }), {}, () => {
            called = true;
          }),
        ),
      );

      expect(response.status).toBe(400);
      expect(called).toBe(false);
      expect(response.headers.get("Set-Cookie")).toBeNull();
      expect(await response.text()).toBe(""); // no body — tells a forger nothing, not even which rule turned them away
    } finally {
      await unreachable.destroy();
    }
  });

  it(
    "lets a mutation whose Origin names this instance through to the lock",
    withDatabase(async ({ seedPasskey }) => {
      await seedPasskey({ publicKey: A_PUBLIC_KEY });

      // The lock refuses it (a redirect, not this middleware's 400) — proof the request passed through here.
      const location = await redirectTo(() =>
        servedThrough(middleware, post("/lock-now", {}, undefined, { Origin: "http://portfolio.local" })),
      );

      expect(location).toBe("/unlock");
    }),
  );

  it(
    "lets a mutation carrying no Origin through, the way the framework's own check does",
    withDatabase(async () => {
      let called = false;
      await servedThrough(middleware, post("/masking", {}), {}, () => {
        called = true;
      });

      expect(called).toBe(true);
    }),
  );

  it(
    "judges no Origin on a read, so a link followed from anywhere still renders",
    withDatabase(async () => {
      const request = get("/holdings");
      request.headers.set("Origin", "https://evil.test");
      let called = false;

      await servedThrough(middleware, request, {}, () => {
        called = true;
      });

      expect(called).toBe(true);
    }),
  );

  it(
    "refuses the literal Origin: null, which is a value rather than a missing header",
    withDatabase(async () => {
      let called = false;

      const response = await responseOf(() =>
        servedThrough(middleware, post("/lock-now", {}, undefined, { Origin: "null" }), {}, () => {
          called = true;
        }),
      );

      expect(response.status).toBe(400);
      expect(called).toBe(false);
    }),
  );

  it(
    "refuses an Origin that is not a URL at all",
    withDatabase(async () => {
      let called = false;

      const response = await responseOf(() =>
        servedThrough(middleware, post("/lock-now", {}, undefined, { Origin: "evil.test" }), {}, () => {
          called = true;
        }),
      );

      expect(response.status).toBe(400);
      expect(called).toBe(false);
    }),
  );
});
