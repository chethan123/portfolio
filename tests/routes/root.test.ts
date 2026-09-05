/**
 * The one loader, and — since ticket 03 — the one middleware, that runs on
 * every page render. The loader's first-run read is a hint, not data, and
 * nothing but this test enforces that: `firstRunStep()` throws when Postgres
 * is unreachable, and propagated from *this* loader that is an error
 * boundary on every route — a database merely restarting would answer every
 * screen with an error page while `/healthz` reported the real cause to
 * nobody. One `try` is the difference, and a `try` is the easiest thing in a
 * file to tidy away. The environment is configured before the import
 * because `getConfig()` memoises its first read.
 *
 * The middleware describe block below is the boundary's own test: every
 * refusal is proven on `next()` never being invoked (`servedThrough`'s
 * `onNext` parameter), never on inspecting a response a refusal never
 * produced — the vacuous shape ticket 03 is written to forbid.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import { args, get, post, redirectTo, responseOf, servedThrough } from "../support/routes.ts";
import { saveMaskingPolicy } from "~/lib/settings.server";

process.env.DATABASE_URL = TEST_DATABASE_URL;

/**
 * A seam onto `touchGrant`, mocked so one test can make the *grant* check
 * itself fail independently of the *lock* check (`isLocked`) — the two
 * database reads this middleware makes, which a single unreachable-database
 * URL cannot fail one at a time, since the first one reached (`isLocked`)
 * would already refuse. `undefined` (every test but one) defers to the real
 * function; the one test that sets `impl` restores it in a `finally`.
 */
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

/**
 * This loader also starts the refresh loop (§6.2), because it is the one
 * server-side path every page render passes through — so calling it here
 * creates a real fifteen-minute interval holding the live Yahoo provider. It is
 * `unref`'d, so it cannot hold vitest open, but it would outlive this file for
 * the rest of the run. Stopped after every test rather than left to that.
 */
afterEach(stopPricePoller);

afterAll(closeTestDatabase);

describe("the shell's loader", () => {
  it("reports no first-run step rather than propagating, when the database cannot be reached", async () => {
    const unreachable = createDatabase(UNREACHABLE_DATABASE_URL);

    try {
      const data = await withDb(unreachable, () => loader(args(get("/"))));

      // Null, which the shell renders as "no prompt" — not a thrown Response,
      // and not an error page over every screen in the application.
      expect(data.firstRun).toBeNull();

      // The masking read is down the same well and has the same duty, with one
      // extra: of the two ways to be wrong while the database is unreachable,
      // this is the one that cannot put a household's balances on a screen
      // (spec 0007).
      expect(data.masked).toBe(true);

      // The lock-now control's own read (ticket 06) has a different duty:
      // failing this shut costs a family member one control on the chrome,
      // never a figure, so the fail-safe answer here is "no control" rather
      // than "show one that clears a grant which may not exist".
      expect(data.hasPasskey).toBe(false);
    } finally {
      await unreachable.destroy();
    }
  });

  it(
    "reports the step the instance is actually on when the database answers",
    withDatabase(async ({ seedPerson }) => {
      // The counterpart, and what keeps the test above from passing on a
      // loader that had stopped asking the question at all.
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
  /**
   * React Router serialises whatever this function returns, whatever
   * `Layout` goes on to render with it — so the object this asserts against
   * *is* the payload, not a proxy for it. A markup assertion would pass
   * whether or not this fix existed, since `Layout` never prints any of
   * these fields for `/unlock` either way (this file's own header on
   * `isUnlockPath`) — which is exactly the gap the finding this test pins
   * named: hiding the chrome hid the consumers, not the data.
   */
  it(
    "answers gated, firstRun, masked, maskingPolicy and hasPasskey with fixed neutral values, never the household's real ones",
    withDatabase(async ({ db, seedPasskey, seedPerson }) => {
      // Real state that would answer differently for every field below, had
      // this loader read any of it for `/unlock`: a person with no account
      // yet answers "accounts" for `/`, AUTH_GATE defaults to "none" in this
      // suite (vitest.config.ts), which answers `gated: false` for `/`, and a
      // seeded passkey answers `hasPasskey: true` for `/`.
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
      // `SLOT` is a `Symbol.for` registry key (`price-poller.server.ts`'s own
      // header on why), so it names the identical global from here without
      // importing anything internal, and without ever forcing a real tick —
      // `requestRefresh()` would reach the live Yahoo provider by default,
      // which a test must not do. Undefined until something starts the
      // poller; `afterEach(stopPricePoller)` above deletes it again after
      // every test in this file, this one included.
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

      // The assertion that bites: not that the response carries no figure —
      // a refusal renders nothing, so that would pass whatever the
      // middleware did — but that `next` was never invoked at all.
      await responseOf(() =>
        servedThrough(middleware, get("/holdings"), {}, () => {
          called = true;
        }),
      );

      expect(called).toBe(false);
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
      // Exactly one parameter, and no literal `&` anywhere in the address —
      // the whole point: the gate's own sign-in redirect truncates a target
      // at the first ampersand (ADR-0012, docs/specs/0019-the-lock.md), and
      // an owner filter beside a chart range is exactly such a target.
      expect([...target.searchParams.keys()]).toEqual(["redirectTo"]);
      expect(target.searchParams.get("redirectTo")).toBe("/holdings?owner=2&range=5y");
      expect(location).not.toContain("&");
    }),
  );

  it(
    "sends a refused POST to / with no return address, since a GET cannot replay a form post",
    withDatabase(async ({ seedPasskey }) => {
      await seedPasskey({ publicKey: A_PUBLIC_KEY });

      // `/masking` exports an action only — exactly the route this rule
      // exists for: a return address built from its pathname would send an
      // unlocked reader to `GET /masking`, a 400.
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

      // Refused exactly like an ordinary "no grant" case — a redirect to the
      // unlock screen — and never treated as "no passkey enrolled", which is
      // a different answer this middleware must not collapse it into.
      expect(called).toBe(false);
      expect(response.status).toBeGreaterThanOrEqual(300);
      expect(response.status).toBeLessThan(400);
      // A read that merely failed to answer is not proof the cookie's grant
      // is gone, so nothing here is cleared.
      expect(response.headers.get("Set-Cookie")).toBeNull();
    } finally {
      await unreachable.destroy();
    }
  });

  it(
    "refuses rather than continues when the grant check itself cannot reach the database",
    withDatabase(async ({ seedPasskey }) => {
      // Distinct from the previous test: `isLocked` answers normally here (a
      // real, seeded passkey against the real test database) and only the
      // *second* read — the grant check `touchGrant` used to split across
      // `readGrant` then `extendGrant`, now one call — fails. A single
      // unreachable database cannot isolate this: `isLocked` is the first
      // read this middleware makes, and it would refuse first.
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
        // A read that merely failed to answer is not proof the cookie's
        // grant is gone, so nothing here is cleared.
        expect(response.headers.get("Set-Cookie")).toBeNull();
      } finally {
        touchGrantOverride.impl = undefined;
      }
    }),
  );

  it(
    "clears the grant cookie on a refusal that is itself a POST to /lock-now, since an outage must not strand a grant the reader asked to end",
    async () => {
      // Finding 3: `/lock-now`'s own action already clears the cookie on
      // every path through it (`lock-now.test.ts`'s own coverage), but an
      // outage in `isLocked` refuses *here*, before that action ever runs —
      // the exact case this middleware used to leave the cookie alone for,
      // on the reasoning (right everywhere else) that a mere read failure
      // is not proof the grant is gone. A reader who pressed "Lock now"
      // during the outage has already asked to end this browser's grant;
      // once the database recovers, an uncleared cookie would admit them
      // again — precisely the outcome pressing the control was supposed to
      // rule out.
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
        expect(response.headers.get("Set-Cookie")).toMatch(/max-age=0/i);
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

      // The assertion that actually proves something: not that the response
      // carries the stand-in body (`servedThrough` would produce that
      // whatever the middleware did with `next`), but that `next` itself ran.
      expect(called).toBe(true);
      expect(await response.text()).toBe("the page");
      // The case this header actually matters for: a back-forward-cache
      // restore of a page that *was* protected never asks the server at all,
      // so deleting the grant alone would not stop it from reappearing.
      expect(response.headers.get("Cache-Control")).toBe("no-store");
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

      // `compilePath` (react-router 7.18.2) matches case-insensitively and
      // tolerates any number of trailing slashes — `Array.includes` alone
      // does neither, so every one of these reached the health route while
      // silently missing this exemption before it was normalised.
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

      // Guards the matching rule's shape, not only its data: rewriting the
      // comparison as `LOCK_EXEMPT_PATHS.some((p) => pathname.startsWith(p))`
      // would wrongly wave both of these through, and the array-contents
      // test above cannot catch that — it never runs the comparison.
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
      // `/healthz` sets its own `no-store` today, which is exactly why this
      // branch's own header was invisible to removing `withNoStore` from it
      // alone — the moment `/unlock` exists, that screen becomes cacheable
      // instead, the bfcache hole the ADR names.
      const response = await servedThrough(middleware, get("/unlock"));
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }),
  );
});
