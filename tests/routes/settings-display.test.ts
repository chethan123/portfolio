// Settings → Display (spec 0007, ADR-0002): the route's headers. Saving must clear the state cookie — otherwise the row
// updates but this browser keeps obeying its old cookie, looking like the setting did nothing (story 25).
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
      // A bare 204 would satisfy every other assertion here but leave a no-JS browser on the stale page (story 25) — needs post/redirect/get.
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
      // Expired, not merely rewritten — the stored policy alone decides what this browser opens in.
      expect(cookie).toMatch(/max-age=0/i);
    }),
  );

  it(
    "refuses a policy it does not recognise, and leaves the stored one alone",
    withDatabase(async ({ db }) => {
      await action(args(post("/settings/display", { maskingPolicy: "unmasked" })));

      const outcome = await action(args(post("/settings/display", { maskingPolicy: "sometimes" })));

      expect(outcome).toHaveProperty("errors");
      expect(await readMaskingPolicy(db)).toBe("unmasked");
    }),
  );

  it(
    "does not clear the cookie when it refused the write",
    withDatabase(async () => {
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
