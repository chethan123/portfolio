import { describe, expect, it } from "vitest";

import { servedThrough } from "./support/routes.ts";

/**
 * The gate is wired to the root route, which is what makes it deny-by-default.
 *
 * The rules themselves are covered in `auth.test.ts`; what this file protects is
 * that they are actually attached to the route every other route descends from,
 * so a page added by a later slice is behind the gate without anyone wiring it
 * up. Configured through the environment before importing, because that is how
 * the running container configures it.
 */
process.env.DATABASE_URL = "postgres://portfolio:portfolio@db:5432/portfolio";
process.env.AUTH_PASSWORD = "correct horse battery staple";
process.env.SESSION_SECRET = "signing-key";

const { middleware } = await import("../app/root.tsx");
const { createAuthGate } = await import("../app/lib/auth.server.ts");

/** The password above, signed into a cookie the same way the app would. */
async function sessionCookie(): Promise<string> {
  const result = await createAuthGate({
    AUTH_PASSWORD: process.env.AUTH_PASSWORD,
    SESSION_SECRET: process.env.SESSION_SECRET,
  }).logIn("correct horse battery staple");

  if (!result.ok) throw new Error("expected the correct password to be accepted");
  return (result.response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
}

async function statusOf(request: Request): Promise<number> {
  try {
    return (await servedThrough(middleware, request)).status;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
}

describe("every route inherits the gate", () => {
  it("refuses a route nobody remembered to protect", async () => {
    expect(await statusOf(new Request("http://portfolio.local/a-page-from-a-later-slice"))).toBe(
      302,
    );
  });

  it("lets the health endpoint through untouched", async () => {
    expect(await statusOf(new Request("http://portfolio.local/healthz"))).toBe(200);
  });

  it("serves the page once a session is presented", async () => {
    const request = new Request("http://portfolio.local/a-page-from-a-later-slice", {
      headers: { Cookie: await sessionCookie() },
    });

    expect(await statusOf(request)).toBe(200);
  });
});
