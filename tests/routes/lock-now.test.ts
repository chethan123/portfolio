/**
 * The chrome's explicit "Lock now" control, and the reentry guard's own
 * automatic post — both target this one action (ticket 06, docs/adr/0012).
 *
 * Driven exactly as `masking.test.ts` drives `/masking`'s action: a
 * `Request` in, the returned `Response` out. What only a route test can show
 * is that a subsequent request is genuinely refused afterwards — not merely
 * redirected past — which is why this file also runs the real lock
 * middleware, the way `root.test.ts` does.
 *
 * The environment is configured before the import for `root.test.ts`'s
 * reason — `getConfig()` memoises its first read.
 */
import { afterAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import { args, get, post, responseOf, servedThrough } from "../support/routes.ts";

process.env.DATABASE_URL = TEST_DATABASE_URL;

const { action } = await import("../../app/routes/lock-now.ts");
const { middleware } = await import("../../app/root.tsx");
const { LOCK_COOKIE, readGrant } = await import("~/lib/lock.server");

afterAll(closeTestDatabase);

/** No test below verifies a signature; only a distinct byte string per row matters. */
const A_PUBLIC_KEY = new Uint8Array([7, 8, 9]);

describe("the lock-now action", () => {
  it(
    "deletes the grant this browser's cookie names",
    withDatabase(async ({ db, seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedPasskey({ publicKey: A_PUBLIC_KEY });
      const grant = await seedUnlockGrant({ passkeyId: passkey.credentialId });

      await responseOf(() => action(args(post("/lock-now", {}, `${LOCK_COOKIE}=${grant.id}`))));

      expect(await readGrant(grant.id, db)).toBeUndefined();
    }),
  );

  it(
    "clears the grant cookie",
    withDatabase(async ({ seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedPasskey({ publicKey: A_PUBLIC_KEY });
      const grant = await seedUnlockGrant({ passkeyId: passkey.credentialId });

      const response = await responseOf(() =>
        action(args(post("/lock-now", {}, `${LOCK_COOKIE}=${grant.id}`))),
      );

      expect(response.headers.get("Set-Cookie")).toMatch(/max-age=0/i);
    }),
  );

  it(
    "redirects to the unlock screen",
    withDatabase(async ({ seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedPasskey({ publicKey: A_PUBLIC_KEY });
      const grant = await seedUnlockGrant({ passkeyId: passkey.credentialId });

      const response = await responseOf(() =>
        action(args(post("/lock-now", {}, `${LOCK_COOKIE}=${grant.id}`))),
      );

      expect(response.headers.get("Location")).toBe("/unlock");
    }),
  );

  it(
    "still redirects a browser carrying no grant cookie at all, with nothing to delete",
    withDatabase(async () => {
      const response = await responseOf(() => action(args(post("/lock-now", {}))));
      expect(response.headers.get("Location")).toBe("/unlock");
    }),
  );

  it(
    "ends this browser's admission outright: a request carrying the old cookie is refused, not merely redirected past",
    withDatabase(async ({ seedPasskey, seedUnlockGrant }) => {
      const passkey = await seedPasskey({ publicKey: A_PUBLIC_KEY });
      const grant = await seedUnlockGrant({ passkeyId: passkey.credentialId });

      await responseOf(() => action(args(post("/lock-now", {}, `${LOCK_COOKIE}=${grant.id}`))));

      // The grant row is gone, not merely a cookie the middleware would
      // still have honoured — proven the same way `root.test.ts` proves
      // every other refusal: on `next()` never being invoked, never on
      // inspecting a response a refusal never produced.
      let called = false;
      await responseOf(() =>
        servedThrough(middleware, get("/holdings", `${LOCK_COOKIE}=${grant.id}`), {}, () => {
          called = true;
        }),
      );

      expect(called).toBe(false);
    }),
  );
});
