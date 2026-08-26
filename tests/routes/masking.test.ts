/**
 * The two ends of the toggle that only a request can show (spec 0007).
 *
 * `masking.test.ts` pins the precedence rule and the cookie's shape as pure
 * functions. What is left is what only happens when a request goes through a
 * route: that the shell's loader actually asks the resolver rather than
 * defaulting on its own, and that the action's `Set-Cookie` carries the
 * lifetime the *stored policy* dictates — which is the half of the mechanism
 * that makes "on start" mean anything, and the half no pure test can reach
 * because the policy comes out of the database.
 *
 * Driven exactly as the existing route tests drive loaders and actions: a
 * `Request` in, the returned data or the thrown `Response` out.
 *
 * The environment is configured before the import for `root.test.ts`'s reason —
 * `getConfig()` memoises its first read.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import { args, get, post, responseOf } from "../support/routes.ts";

process.env.DATABASE_URL = TEST_DATABASE_URL;

const { loader: rootLoader } = await import("../../app/root.tsx");
const { action: toggle } = await import("../../app/routes/masking.ts");
const { MASKED, MASKING_COOKIE, UNMASKED } = await import("~/lib/masking");
const { saveMaskingPolicy } = await import("~/lib/settings.server");
const { stopPricePoller } = await import("~/lib/price-poller.server");

/** The shell's loader starts the refresh loop; `root.test.ts` explains. */
afterEach(stopPricePoller);

afterAll(closeTestDatabase);

/** The `Cookie` header a browser carrying a masking state would send. */
const carrying = (value: string): string => `${MASKING_COOKIE}=${value}`;

describe("what the shell publishes to every screen", () => {
  it(
    "is masked when the browser says so, whatever the household's policy is",
    withDatabase(async ({ db }) => {
      await saveMaskingPolicy({ maskingPolicy: "unmasked" }, db);

      // The policy says open unmasked and this browser has been toggled. If the
      // loader took the policy's answer here the control would appear broken on
      // the one browser whose owner set the policy.
      const data = await rootLoader(args(get("/", carrying(MASKED))));

      expect(data.masked).toBe(true);
    }),
  );

  it(
    "is unmasked when the browser says so, whatever the household's policy is",
    withDatabase(async ({ db }) => {
      await saveMaskingPolicy({ maskingPolicy: "masked" }, db);

      const data = await rootLoader(args(get("/", carrying(UNMASKED))));

      expect(data.masked).toBe(false);
    }),
  );

  it(
    "falls back to the stored policy when the browser has said nothing",
    withDatabase(async ({ db }) => {
      await saveMaskingPolicy({ maskingPolicy: "unmasked" }, db);
      expect((await rootLoader(args(get("/")))).masked).toBe(false);

      await saveMaskingPolicy({ maskingPolicy: "masked" }, db);
      expect((await rootLoader(args(get("/")))).masked).toBe(true);
    }),
  );

  it(
    "opens a browser that has never been toggled masked, under the seeded policy",
    withDatabase(async () => {
      // Nothing saved: this is a fresh instance meeting a fresh browser, which
      // is the case ADR-0002 calls the one place safety beat convenience.
      expect((await rootLoader(args(get("/")))).masked).toBe(true);
    }),
  );
});

describe("the toggle's no-JavaScript path", () => {
  it(
    "answers with a cookie carrying the state that was asked for",
    withDatabase(async () => {
      const response = await responseOf(() =>
        toggle(args(post("/masking", { masked: MASKED, redirectTo: "/holdings" }))),
      );

      expect(response.headers.get("Set-Cookie")).toContain(`${MASKING_COOKIE}=${MASKED}`);
    }),
  );

  it(
    "gives the cookie a lifetime that outlives the session only under as-last-left",
    withDatabase(async ({ db }) => {
      // The rule itself is `maskingCookie`'s and is pinned there. What only a
      // route can show is that the action reads the *stored* policy to decide
      // it — an action that hard-coded either lifetime would pass every pure
      // test and would break "on start" in exactly one of the three settings.
      await saveMaskingPolicy({ maskingPolicy: "as_last_left" }, db);
      const remembered = await responseOf(() =>
        toggle(args(post("/masking", { masked: UNMASKED, redirectTo: "/" }))),
      );

      expect(remembered.headers.get("Set-Cookie")).toMatch(/max-age=\d+/i);

      await saveMaskingPolicy({ maskingPolicy: "masked" }, db);
      const session = await responseOf(() =>
        toggle(args(post("/masking", { masked: UNMASKED, redirectTo: "/" }))),
      );

      expect(session.headers.get("Set-Cookie")).not.toMatch(/max-age/i);
    }),
  );

  it(
    "returns the reader to the screen they toggled from",
    withDatabase(async () => {
      // With JavaScript off the click is a navigation, so the response has to
      // put them back. Landing on the overview after hiding the amounts on
      // Holdings would lose their place — story 8's complaint, one screen up.
      const response = await responseOf(() =>
        toggle(args(post("/masking", { masked: MASKED, redirectTo: "/holdings?sort=value" }))),
      );

      expect(response.headers.get("Location")).toBe("/holdings?sort=value");
    }),
  );

  it(
    "refuses to be pointed anywhere but back into this application",
    withDatabase(async () => {
      // The field comes off a form and a form can be edited. An absolute URL
      // here would make the toggle an open redirect — small, but it is one
      // line to close and the line is cheaper than the argument about whether
      // anyone would bother.
      const response = await responseOf(() =>
        toggle(args(post("/masking", { masked: MASKED, redirectTo: "https://elsewhere.test/" }))),
      );

      expect(response.headers.get("Location")).toBe("/");
    }),
  );

  it(
    "refuses a state it does not recognise rather than writing it",
    withDatabase(async () => {
      // An unrecognised cookie resolves to the policy's answer, so a junk value
      // written here would not expose anything — it would just make the toggle
      // stop working, silently, until the cookie was cleared.
      const response = await responseOf(() =>
        toggle(args(post("/masking", { masked: "perhaps", redirectTo: "/" }))),
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("Set-Cookie")).toBeNull();
    }),
  );
});
