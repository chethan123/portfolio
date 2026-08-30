/**
 * Settings → Display (spec 0007, ADR-0002): the route's own contribution —
 * the header it sends back. Saving the policy must clear the browser's
 * state cookie, and nothing about the write itself would reveal that it
 * does not: the row updates, the form re-renders, and the screen goes on
 * obeying the cookie it already had — the setting appearing to do nothing
 * on the one browser whose owner just changed it (story 25), the stale
 * cookie keeping the old policy's lifetime.
 */
import { afterAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import { args, post } from "../support/routes.ts";

process.env.DATABASE_URL = TEST_DATABASE_URL;

const { action, loader } = await import("../../app/routes/settings/display.tsx");
const { MASKED, MASKING_COOKIE } = await import("~/lib/masking");
const { readMaskingPolicy } = await import("~/lib/settings.server");

afterAll(closeTestDatabase);

/** The response's `Set-Cookie`, whatever shape the route answered in. */
function cookieOf(outcome: unknown): string | null {
  return outcome instanceof Response ? outcome.headers.get("Set-Cookie") : null;
}

describe("saving a masking policy", () => {
  it(
    "records the choice",
    withDatabase(async ({ db }) => {
      await action(args(post("/settings/display", { maskingPolicy: "unmasked" })));

      expect(await readMaskingPolicy(db)).toBe("unmasked");
    }),
  );

  it(
    "answers a redirect, so a browser running no script actually repaints",
    withDatabase(async () => {
      // Story 25 wants the change to visibly take effect on the browser that
      // made it. A bare 204 satisfies every other assertion in this file and
      // leaves a no-JavaScript browser sitting on the page it submitted, with
      // the old screen still in front of it. Post/redirect/get is what makes
      // the repaint happen in both browsers.
      const outcome = await action(args(post("/settings/display", { maskingPolicy: "unmasked" })));

      expect(outcome).toBeInstanceOf(Response);
      expect((outcome as Response).status).toBeGreaterThanOrEqual(300);
      expect((outcome as Response).status).toBeLessThan(400);
      expect((outcome as Response).headers.get("Location")).toBe("/settings/display");
    }),
  );

  it(
    "clears this browser's state cookie, so the change takes effect where it was made",
    withDatabase(async () => {
      const outcome = await action(
        args(post("/settings/display", { maskingPolicy: "unmasked" }, `${MASKING_COOKIE}=${MASKED}`)),
      );

      const cookie = cookieOf(outcome);

      expect(cookie).toContain(`${MASKING_COOKIE}=`);
      // Expired rather than merely rewritten: the new policy decides what this
      // browser opens in, and it can only decide that for a browser with
      // nothing left to say.
      expect(cookie).toMatch(/max-age=0/i);
    }),
  );

  it(
    "refuses a policy it does not recognise, and leaves the stored one alone",
    withDatabase(async ({ db }) => {
      await action(args(post("/settings/display", { maskingPolicy: "unmasked" })));

      const outcome = await action(args(post("/settings/display", { maskingPolicy: "sometimes" })));

      // A refusal is an ordinary outcome of a form submission: data back for
      // the form to re-render with, never a 500.
      expect(outcome).toHaveProperty("errors");
      expect(await readMaskingPolicy(db)).toBe("unmasked");
    }),
  );

  it(
    "does not clear the cookie when it refused the write",
    withDatabase(async () => {
      // Otherwise a typo in a form would silently reset the reader's screen to
      // whatever the unchanged policy says — a state change with no cause the
      // reader could see.
      const outcome = await action(args(post("/settings/display", { maskingPolicy: "" })));

      expect(cookieOf(outcome)).toBeNull();
    }),
  );
});

describe("the tab itself", () => {
  it(
    "opens on the policy that is stored",
    withDatabase(async () => {
      await action(args(post("/settings/display", { maskingPolicy: "as_last_left" })));

      expect((await loader()).maskingPolicy).toBe("as_last_left");
    }),
  );
});
