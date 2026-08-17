/**
 * Reading a request the way it arrived, from behind a reverse proxy.
 *
 * The app serves plain HTTP and TLS termination is the operator's proxy
 * (DESIGN.md §10), so every one of these requests reaches the app over `http`
 * and the headers are the only evidence of what the browser actually did. The
 * consequence being protected is the `Secure` attribute on the session cookie,
 * which is asserted here through the gate rather than only through the helpers.
 */
import { describe, expect, it } from "vitest";

import { createAuthGate } from "~/lib/auth.server";
import { clientAddress, isSecureRequest, requestProtocol } from "~/lib/forwarded.server";

const PASSWORD = "correct horse battery staple";

const gate = () => createAuthGate({ AUTH_PASSWORD: PASSWORD, SESSION_SECRET: "signing-key" });

/** A request as it reaches the app: plain http, whatever the browser used. */
const behindProxy = (headers: Record<string, string>) =>
  new Request("http://app:3000/login", { method: "POST", headers });

async function cookieFor(request?: Request): Promise<string> {
  const result = await gate().logIn(PASSWORD, null, request);
  if (!result.ok) throw new Error("expected the correct password to be accepted");
  return result.response.headers.get("Set-Cookie") ?? "";
}

describe("the scheme the browser actually used", () => {
  it("comes from the proxy when there is one", () => {
    expect(requestProtocol(behindProxy({ "X-Forwarded-Proto": "https" }))).toBe("https");
    expect(isSecureRequest(behindProxy({ "X-Forwarded-Proto": "https" }))).toBe(true);
  });

  it("falls back to the connection when there is no proxy", () => {
    // A LAN instance reached directly, or `localhost` in development.
    expect(requestProtocol(behindProxy({}))).toBe("http");
    expect(isSecureRequest(behindProxy({}))).toBe(false);
  });

  it("reads the first hop when the header lists several", () => {
    // `https, http` means the browser used https and a second proxy spoke http
    // to the next one. The browser's hop is the leftmost.
    expect(requestProtocol(behindProxy({ "X-Forwarded-Proto": "https, http" }))).toBe("https");
  });

  it("is case-insensitive, since proxies disagree about that", () => {
    expect(requestProtocol(behindProxy({ "X-Forwarded-Proto": "HTTPS" }))).toBe("https");
  });

  it("ignores a value that is not a scheme rather than guessing", () => {
    expect(requestProtocol(behindProxy({ "X-Forwarded-Proto": "gopher" }))).toBe("http");
    expect(requestProtocol(behindProxy({ "X-Forwarded-Proto": "" }))).toBe("http");
  });
});

describe("the client address", () => {
  it("is the leftmost entry, which is the visitor rather than a proxy", () => {
    const request = behindProxy({ "X-Forwarded-For": "203.0.113.7, 10.0.0.2, 10.0.0.3" });

    expect(clientAddress(request)).toBe("203.0.113.7");
  });

  it("is null when nothing forwarded one, rather than an invented placeholder", () => {
    expect(clientAddress(behindProxy({}))).toBeNull();
    expect(clientAddress(behindProxy({ "X-Forwarded-For": "  " }))).toBeNull();
  });
});

describe("the session cookie behind a proxy", () => {
  it("is issued Secure when the browser's connection was encrypted", async () => {
    const cookie = await cookieFor(behindProxy({ "X-Forwarded-Proto": "https" }));

    expect(cookie).toMatch(/Secure/i);
    // The rest of the attributes are unchanged by the proxy.
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it("is issued without Secure on a plain-HTTP instance", async () => {
    // A LAN instance with no TLS in front. A Secure cookie would be dropped by
    // the browser and nobody could stay logged in.
    expect(await cookieFor(behindProxy({}))).not.toMatch(/Secure/i);
  });

  it("is accepted whichever way it was issued", async () => {
    // Secure is an instruction to the browser, not part of the signature, so a
    // session survives an operator putting TLS in front of a running instance.
    const secureCookie = (await cookieFor(behindProxy({ "X-Forwarded-Proto": "https" })))
      .split(";")[0];

    const request = new Request("http://app:3000/holdings", {
      headers: { Cookie: secureCookie ?? "" },
    });

    await expect(gate().requireSession(request)).resolves.toBeUndefined();
  });
});
