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
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { LOCK_COOKIE } from "~/lib/lock";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import { args, get, redirectTo, responseOf, servedThrough } from "../support/routes.ts";

process.env.DATABASE_URL = TEST_DATABASE_URL;

const { LOCK_EXEMPT_PATHS, loader, middleware } = await import("../../app/root.tsx");
const { createDatabase, withDb } = await import("~/lib/db.server");
const { readGrant } = await import("~/lib/lock.server");
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
    "renders exactly as it does today once the browser holds a live grant",
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

      expect(called).toBe(true);
      expect(await response.text()).toBe("the page");
      // The case this header actually matters for: a back-forward-cache
      // restore of a page that *was* protected never asks the server at all,
      // so deleting the grant alone would not stop it from reappearing.
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }),
  );

  it(
    "refuses an expired grant and clears its cookie, so a stale value does not survive to confuse the next unlock",
    withDatabase(async ({ seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedPasskey({ publicKey: A_PUBLIC_KEY });
      const grant = await seedUnlockGrant({
        passkeyId: passkey.credentialId,
        expiresAt: new Date(Date.now() - 1000),
      });

      const response = await responseOf(() =>
        servedThrough(middleware, get("/holdings", `${LOCK_COOKIE}=${grant.id}`)),
      );

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
    "carries Cache-Control: no-store on a response it lets through",
    withDatabase(async () => {
      const response = await servedThrough(middleware, get("/"));
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }),
  );
});
