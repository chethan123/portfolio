// The two ends of the masking toggle (spec 0007) that only a request can show — masking.test.ts pins the precedence rule and
// cookie shape as pure functions; this covers the shell's loader actually asking the resolver, and Set-Cookie's lifetime coming
// from the *stored* policy (the database-backed half no pure test can reach).
// getConfig() memoises its first read — DATABASE_URL is set before the import below, as in root.test.ts.
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
      // Fresh instance, fresh browser — the one case ADR-0002 has safety beat convenience.
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
      // maskingCookie's rule is pinned elsewhere; this shows the action reads the *stored* policy to pick a lifetime.
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
      // No JS: the click is a navigation, so the response must put them back (story 8's complaint).
      const response = await responseOf(() =>
        toggle(args(post("/masking", { masked: MASKED, redirectTo: "/holdings?sort=value" }))),
      );

      expect(response.headers.get("Location")).toBe("/holdings?sort=value");
    }),
  );

  it(
    "refuses to be pointed anywhere but back into this application",
    withDatabase(async () => {
      // redirectTo comes off an editable form field — an absolute URL here would make this an open redirect.
      const response = await responseOf(() =>
        toggle(args(post("/masking", { masked: MASKED, redirectTo: "https://elsewhere.test/" }))),
      );

      expect(response.headers.get("Location")).toBe("/");
    }),
  );

  it(
    "refuses a state it does not recognise rather than writing it",
    withDatabase(async () => {
      // An unrecognised cookie falls back to the stored policy, so writing junk here would silently break the toggle, not expose anything.
      const response = await responseOf(() =>
        toggle(args(post("/masking", { masked: "perhaps", redirectTo: "/" }))),
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("Set-Cookie")).toBeNull();
    }),
  );
});
