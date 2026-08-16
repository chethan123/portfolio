import { describe, expect, it } from "vitest";

import { createAuthGate, type AuthGate } from "../app/lib/auth.server.ts";

/**
 * The optional login gate (DESIGN.md §10).
 *
 * Every test here is about what a visitor can reach, not about how the gate
 * decides it — the gate is exercised through `Request` objects and the
 * `Response`s it produces, which is exactly what the middleware in `root.tsx`
 * hands it.
 */

const PASSWORD = "correct horse battery staple";

const closed = (overrides: Partial<{ AUTH_PASSWORD: string; SESSION_SECRET: string }> = {}) =>
  createAuthGate({ AUTH_PASSWORD: PASSWORD, SESSION_SECRET: "signing-key", ...overrides });

const open = () => createAuthGate({});

const get = (path: string, cookie?: string) =>
  new Request(`http://portfolio.local${path}`, cookie ? { headers: { Cookie: cookie } } : {});

/** The refusal, or `undefined` when the request was allowed through. */
async function refusalFor(gate: AuthGate, request: Request): Promise<Response | undefined> {
  try {
    await gate.requireSession(request);
    return undefined;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

/** Log in for real and hand back the cookie a browser would then send. */
async function signIn(gate: AuthGate, next?: string): Promise<string> {
  const result = await gate.logIn(PASSWORD, next);
  if (!result.ok) throw new Error("expected the correct password to be accepted");

  const setCookie = result.response.headers.get("Set-Cookie");
  if (setCookie === null) throw new Error("expected a session cookie to be issued");

  return setCookie.split(";")[0] ?? "";
}

describe("with a password set", () => {
  it("refuses an unauthenticated request to an application page", async () => {
    const refusal = await refusalFor(closed(), get("/holdings"));

    expect(refusal?.status).toBe(302);
    expect(refusal?.headers.get("Location")).toContain("/login");
  });

  it("protects a route that did not exist when the gate was written", async () => {
    // Nothing routes here today. Protection is by default, not by enumeration,
    // so a page a later slice adds is covered before anyone thinks about it.
    const refusal = await refusalFor(closed(), get("/people/3/accounts/new"));

    expect(refusal?.status).toBe(302);
    expect(refusal?.headers.get("Location")).toContain("/login");
  });

  it("refuses an unauthenticated form submission rather than running it", async () => {
    const post = new Request("http://portfolio.local/settings", { method: "POST" });

    expect((await refusalFor(closed(), post))?.status).toBe(302);
  });

  it("keeps the visitor's place so they land back where they were", async () => {
    const refusal = await refusalFor(closed(), get("/holdings?account=7"));
    const location = refusal?.headers.get("Location") ?? "";

    expect(location).toContain(encodeURIComponent("/holdings?account=7"));
  });

  it("returns the visitor to somewhere on this instance, never off it", async () => {
    const result = await closed().logIn(PASSWORD, "https://evil.example/steal");

    expect(result.ok && result.response.headers.get("Location")).toBe("/");
  });

  it("leaves the health endpoint reachable without credentials", async () => {
    expect(await refusalFor(closed(), get("/healthz"))).toBeUndefined();
  });

  it("leaves the login page itself reachable without credentials", async () => {
    expect(await refusalFor(closed(), get("/login"))).toBeUndefined();
  });

  it("protects the data requests a client navigation makes, not just the pages", async () => {
    // A browser that has hydrated asks for `/holdings.data`, so a gate that only
    // knew about `/holdings` would serve the page's data to anyone.
    const refusal = await refusalFor(closed(), get("/holdings.data?_routes=routes%2Fholdings"));

    expect(refusal?.status).toBe(302);
  });

  it("accepts the correct password and lets the resulting session through", async () => {
    const gate = closed();
    const cookie = await signIn(gate);

    expect(await refusalFor(gate, get("/holdings", cookie))).toBeUndefined();
  });

  it("rejects a wrong password", async () => {
    const result = await closed().logIn("hunter2");

    expect(result.ok).toBe(false);
    expect(await refusalFor(closed(), get("/holdings"))).toBeDefined();
  });

  it("says nothing about the configured password when a login fails", async () => {
    const result = await closed().logIn("hunter2");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe("Incorrect password.");
    expect(result.message).not.toContain(PASSWORD);
    expect(result.message).not.toMatch(/length|character|configured|unset/i);
  });

  it("rejects a wrong password of a different length without throwing", async () => {
    // Constant-time comparison over raw bytes throws on a length mismatch; the
    // hash on both sides is what keeps this a plain "no".
    await expect(closed().logIn("x")).resolves.toMatchObject({ ok: false });
    await expect(closed().logIn(`${PASSWORD} and then some`)).resolves.toMatchObject({
      ok: false,
    });
  });

  it("issues a session cookie that scripts cannot read and other sites cannot use", async () => {
    const result = await closed().logIn(PASSWORD);
    const setCookie = (result.ok && result.response.headers.get("Set-Cookie")) || "";

    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//i);
  });

  it("ignores a session cookie signed with a different secret", async () => {
    const forged = await signIn(closed({ SESSION_SECRET: "someone-elses-key" }));

    expect(await refusalFor(closed(), get("/holdings", forged))).toBeDefined();
  });

  it("ignores a session issued for a password that has since been changed", async () => {
    const cookie = await signIn(closed());
    const rotated = closed({ AUTH_PASSWORD: "a new password entirely" });

    expect(await refusalFor(rotated, get("/holdings", cookie))).toBeDefined();
  });

  it("refuses to start without a session secret to sign the cookie with", async () => {
    expect(() => createAuthGate({ AUTH_PASSWORD: PASSWORD })).toThrow(/SESSION_SECRET/);
  });
});

describe("with no password set", () => {
  it("lets every page through without credentials", async () => {
    const gate = open();

    expect(await refusalFor(gate, get("/"))).toBeUndefined();
    expect(await refusalFor(gate, get("/holdings"))).toBeUndefined();
    expect(await refusalFor(gate, get("/people/3/accounts/new"))).toBeUndefined();
  });

  it("leaves the health endpoint reachable without credentials", async () => {
    expect(await refusalFor(open(), get("/healthz"))).toBeUndefined();
  });

  it("reports itself as open, which is what the warning banner renders from", async () => {
    expect(open().enabled).toBe(false);
    expect(closed().enabled).toBe(true);
  });
});
