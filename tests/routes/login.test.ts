import { describe, expect, it, vi } from "vitest";

import { args, get, post, redirectTo, responseOf } from "../support/routes.ts";

/**
 * The login page's own contribution — DESIGN.md §10.
 *
 * `auth.test.ts` already covers the gate's rules against `createAuthGate`
 * directly, and `root-gate.test.ts` covers that the gate is attached to every
 * route. What exists only here is this route: which of those rules it reaches
 * for, and what it does with the answer. Three of them are load-bearing and
 * none is checked anywhere else.
 *
 * - The page must not exist on an open instance. A password box on an instance
 *   with no password invites someone to type one and believe it did something.
 * - The loader is a second, independent call site for `safeRedirectTarget`.
 *   Nothing in the suite imports that function directly — `auth.test.ts` only
 *   reaches it through `logIn` — so a loader that skipped the call would put
 *   `//evil.example` in the form's hidden field, and the login itself would
 *   then post the visitor off this instance.
 * - A failed login has to come back as data. Throwing would turn a mistyped
 *   password into an error page, and the wording has to stay identical for a
 *   wrong password and an empty one, so the form never confirms which of the
 *   two the visitor actually managed.
 *
 * Configured through the environment before importing, because that is how the
 * running container configures it, and because `getConfig()` and `authGate()`
 * both memoise on first use. That memoisation is also why the gate-off case
 * needs a module registry of its own: `vi.resetModules()` gives the second
 * import one. Nothing is stubbed either side of it — both are the real modules
 * reading a real environment, which is the only way to have one run see both
 * states.
 */

const PASSWORD = "correct horse battery staple";

process.env.DATABASE_URL = "postgres://portfolio:portfolio@db:5432/portfolio";
process.env.SESSION_SECRET = "signing-key";

// The open instance is resolved now, while the environment still says open: the
// assignment below is what this registry would otherwise eventually read.
delete process.env.AUTH_PASSWORD;
const openInstance = await import("../../app/routes/login.tsx");
(await import("../../app/lib/auth.server.ts")).authGate();

vi.resetModules();

process.env.AUTH_PASSWORD = PASSWORD;
const { action, loader } = await import("../../app/routes/login.tsx");
const gate = (await import("../../app/lib/auth.server.ts")).authGate();

/** Log in for real, and hand back the cookie a browser would then send. */
async function sessionCookie(): Promise<string> {
  const result = await gate.logIn(PASSWORD);
  if (!result.ok) throw new Error("expected the correct password to be accepted");

  return (result.response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
}

/** The GET a browser makes once it is already carrying a session. */
function signedIn(path: string, cookie: string): Request {
  return new Request(`http://portfolio.local${path}`, { headers: { Cookie: cookie } });
}

/** `/login?next=…`, escaped the way the gate's own refusal escapes it. */
const loginFor = (next: string) => get(`/login?next=${encodeURIComponent(next)}`);

describe("a page that only exists while the gate is on", () => {
  it("sends a visitor away when no password is configured", async () => {
    // Both halves, because a GET and a POST arrive here by different routes: a
    // bookmark from before the operator unset AUTH_PASSWORD, and the form on
    // the page that bookmark used to serve.
    expect(await redirectTo(() => openInstance.loader(args(get("/login"))))).toBe("/");
    expect(
      await redirectTo(() => openInstance.action(args(post("/login", { password: PASSWORD })))),
    ).toBe("/");
  });

  it("sends a visitor who already has a session on to where they were headed", async () => {
    // The back button onto /login, or a second tab that logged in first. Asking
    // for the password again when the cookie is already good is a dead end.
    const request = signedIn(
      `/login?next=${encodeURIComponent("/holdings?account=7")}`,
      await sessionCookie(),
    );

    expect(await redirectTo(() => loader(args(request)))).toBe("/holdings?account=7");
  });
});

describe("the return address the form carries", () => {
  it("keeps a next that points off this instance on this instance", async () => {
    // `next` survives a round trip through a form, so it is attacker-supplied
    // by construction. Each of these is a shape a browser resolves against
    // another origin while still looking path-like to a naive check.
    for (const hostile of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
      expect(await loader(args(loginFor(hostile)))).toEqual({ next: "/" });
    }

    // And the same on the branch that redirects rather than renders, which
    // reads the parameter through a different line of the loader.
    const request = signedIn(
      `/login?next=${encodeURIComponent("//evil.example")}`,
      await sessionCookie(),
    );

    expect(await redirectTo(() => loader(args(request)))).toBe("/");
  });
});

describe("what a submission gets back", () => {
  it("reports the same refusal for a wrong password as for an empty one", async () => {
    // Not `outcomeOf`: a throw here is the failure under test, not an outcome —
    // a rejected password has to re-render this page, not raise an error one.
    const wrong = await action(args(post("/login", { password: "hunter2" })));
    const empty = await action(args(post("/login", { password: "" })));

    expect(wrong).toEqual({ error: "Incorrect password." });
    expect(empty).toEqual(wrong);
    // Nothing about the password it was compared against, including its length.
    expect(JSON.stringify(wrong)).not.toContain(PASSWORD);
  });

  it("treats a password field that is not text as an empty submission", async () => {
    // `formData()` yields `null` for a field nobody sent and a `File` for one
    // sent as a file part — neither is a string, and handing either to the
    // constant-time comparison unguarded is a crash on a request anyone can
    // make without a password.
    const missing = await action(args(post("/login", {})));

    const body = new FormData();
    body.set("password", new Blob([PASSWORD], { type: "text/plain" }), "password.txt");
    const asFile = await action(
      args(new Request("http://portfolio.local/login", { method: "POST", body })),
    );

    expect(missing).toEqual({ error: "Incorrect password." });
    // The right password sent as a file is still not a submitted password.
    expect(asFile).toEqual({ error: "Incorrect password." });
  });

  it("answers a correct password with a redirect that carries the session cookie", async () => {
    const response = await responseOf(() =>
      action(args(post("/login", { password: PASSWORD, next: "/holdings" }))),
    );

    // The redirect and the cookie have to be the same response. Issue the
    // cookie on anything else and the visitor arrives logged out.
    expect(response.headers.get("Location")).toBe("/holdings");
    expect(response.headers.get("Set-Cookie")).toContain("__portfolio_session=");
  });
});
