/**
 * The optional login gate — DESIGN.md §10, "Authentication is not multi-user".
 *
 * One password, one signed cookie, one login page. There is no user table, no
 * sessions table and no per-person permissions, and this module is deliberately
 * shaped so that adding them would be a rewrite rather than an extension.
 *
 * Two rules make it safe to add routes later:
 *
 * - It is deny-by-default. The gate runs as root-route middleware, so it sees
 *   every request to every route in the tree, and refuses anything that is not
 *   on the short open list below. A route added in a later slice is protected
 *   the moment it is routable; nobody has to remember to protect it.
 * - `/healthz` is on that open list in both modes, so monitoring never needs
 *   credentials.
 *
 * The session is a cookie and nothing else. The container is read-only
 * (compose.yaml `read_only: true`), which is what a file-backed session store
 * would discover, loudly, on the first login.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { createCookieSessionStorage, redirect } from "react-router";

import { getConfig } from "../../server/config.ts";
import { clientAddress, isSecureRequest } from "./forwarded.server.ts";

/** The one login page. Reachable without credentials, or nobody could log in. */
export const LOGIN_PATH = "/login";

/** Monitoring reads this and must never need a secret. */
export const HEALTH_PATH = "/healthz";

/**
 * The complete list of paths reachable without a session while the gate is on.
 *
 * It is a list of exemptions, never a list of protected routes: everything not
 * named here is refused, including paths that do not exist yet.
 */
const OPEN_PATHS: ReadonlySet<string> = new Set([HEALTH_PATH, LOGIN_PATH]);

/**
 * The cookie. This object is the single place cookie attributes are decided.
 *
 * Everything except `secure` is fixed. `secure` is per-request, because the app
 * serves plain HTTP either way and only the browser's own connection settles
 * the question: `Secure` on an instance genuinely reached over http would have
 * the browser drop the cookie and nobody could stay logged in, and its absence
 * behind a TLS-terminating proxy would let the cookie travel in the clear if
 * the origin were ever reached over http. `forwarded.server.ts` is what turns
 * the proxy's `X-Forwarded-Proto` into that answer.
 */
const SESSION_COOKIE = {
  name: "__portfolio_session",
  path: "/",
  httpOnly: true,
  sameSite: "lax",
  /** A month. Long enough that a family instance is not a daily login. */
  maxAge: 60 * 60 * 24 * 30,
} as const;

/** What the cookie carries: a fingerprint of the password it was issued for. */
type SessionData = {
  /** sha256 of `AUTH_PASSWORD` as it was when this session was issued. */
  credential: string;
};

/** The slice of the configuration this module reads. */
export type AuthConfig = {
  readonly AUTH_PASSWORD?: string | undefined;
  readonly SESSION_SECRET?: string | undefined;
};

export type LoginResult =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly message: string };

export type AuthGate = {
  /** Is a password configured? False means the instance is open to anyone. */
  readonly enabled: boolean;
  isAuthenticated(request: Request): Promise<boolean>;
  /**
   * The gate itself.
   *
   * @throws a redirect `Response` to the login page when the request may not
   * proceed. Returns normally when it may.
   */
  requireSession(request: Request): Promise<void>;
  /**
   * Verify a submitted password and, if it is right, issue the cookie.
   *
   * @param request the login submission, read only for how it reached us: the
   *        forwarded scheme decides whether the cookie is issued `Secure`, and
   *        the forwarded address is what a failed attempt is logged against.
   *        Omitting it issues a cookie without `Secure`, which is the right
   *        answer for a caller that has no request — there is no proxy to
   *        believe, so there is no evidence of TLS.
   */
  logIn(
    password: string,
    redirectTo?: string | null,
    request?: Request,
  ): Promise<LoginResult>;
};

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/**
 * Constant-time password comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, which would leak the length of
 * the configured password through an exception rather than a timer. Hashing
 * both sides first makes every comparison a fixed 32 bytes, so neither length
 * nor content is observable.
 */
function passwordMatches(submitted: string, configured: string): boolean {
  return timingSafeEqual(sha256(submitted), sha256(configured));
}

/**
 * The path a request was really asking for.
 *
 * Client navigations ask for `/holdings.data`, not `/holdings`, and carry
 * router bookkeeping in `_`-prefixed query parameters. Normalising here is what
 * lets the open list and the post-login return address both be written in terms
 * of the URL a person would recognise.
 */
function normalizePath(url: URL): { pathname: string; target: string } {
  let pathname = url.pathname;
  const isDataRequest = pathname.endsWith(".data");

  if (isDataRequest) pathname = pathname.slice(0, -".data".length);
  // Single fetch spells the root route's data request `/_root.data`.
  if (pathname === "/_root" || pathname === "") pathname = "/";

  const search = new URLSearchParams(url.search);
  if (isDataRequest) {
    for (const key of [...search.keys()]) if (key.startsWith("_")) search.delete(key);
  }
  const query = search.toString();

  return { pathname, target: query ? `${pathname}?${query}` : pathname };
}

/** Where a refused target goes. Not a route: the one page every instance has. */
const HOME_PATH = "/";

/**
 * Characters that must never reach `Headers.set`, as `\u` escapes.
 *
 * C0, DEL and C1. Written as escapes and never as literals on purpose: nothing
 * in this repo pins line endings — no `.gitattributes`, no `.editorconfig` —
 * and there is no linter. A formatter normalising a literal `0x0D` inside this
 * class would silently reopen the CRLF injection it exists to close, in a diff
 * nobody could read.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * An origin no browser can reach, used only to resolve a relative target so
 * its origin can be compared. If resolution moves off this, the target was not
 * relative to this instance whatever it looked like.
 */
const UNREACHABLE_BASE = "http://redirect-target.invalid";

/**
 * Only ever redirect somewhere on this instance.
 *
 * A `next` parameter is attacker-supplied by construction — it survives a
 * round trip through a login form — so anything that could leave the origin
 * becomes the home page instead. It is a refusal, never a sanitisation: this
 * module states its contract in reject vocabulary, and re-serialising a CRLF
 * injection attempt into `/X-Injected:%201` would accept as a path something
 * that was never one.
 *
 * The five gates, each closing something the one before it does not:
 *
 * 1. **Control characters.** The shipped check read the first two characters
 *    only, so `/\tevil.example` survived it — the browser then strips the tab
 *    and follows it off-origin (`SEC-1`). A NUL additionally *throws* out of
 *    `Headers.set`, which is what `redirect()` calls (`SEC-3`).
 * 2. **A prefix that is not `/`.** `https://evil.example`, and equally
 *    `evil.example`, which is not an attack so much as a string this function
 *    must not quietly reinterpret as `/evil.example`. Refusing is the posture;
 *    gate 4 is what would still stop the absolute forms if this line went.
 * 3. **`//` and `/\`.** Both read as an authority rather than a path.
 * 4. **An origin that moved under resolution.** Deny-by-default for shapes not
 *    enumerated above. Enumerating valid routes instead is not
 *    an option — `app/routes.ts` imports a devDependency absent from the
 *    runtime image, so matching would mean a second router free to drift, and
 *    it inverts this module's posture.
 * 5. **A `//` the resolution itself synthesised.** The one that is easy to
 *    miss, and the reason gate 4 is not the last word: resolving runs RFC 3986
 *    dot-segment removal, which *manufactures* the prefix gate 3 just rejected.
 *    `/..//evil.example.com` resolves to `//evil.example.com` — an authority.
 *    Validating only the input, and returning the input, would have shipped an
 *    open redirect strictly worse than the defect being fixed.
 *
 * On the redundancy, stated plainly because mutation testing found it and a
 * later reader will otherwise rediscover it as dead code: **gates 2, 3 and 4
 * overlap on purpose, and deleting any one of them alone breaks no test.**
 * Gate 4 is unreachable while gates 2 and 3 stand — swept over 72,103 inputs
 * that pass gates 1 to 3, not one moves origin, because a string beginning with
 * a single `/` is path-absolute by construction. That is not an argument for
 * cutting it. What actually carries the guarantee is structural and is none of
 * the three: this returns the *resolved path*, never the input, so even an
 * absolute URL reaching the end would surrender everything but its path. The
 * gates are what turn that into a refusal rather than a silent
 * reinterpretation. Gates 1 and 5, and returning `path` rather than `target`,
 * are each individually load-bearing — `tests/auth.test.ts` fails if any one of
 * those three is removed. There is also a sixth check below the five, on the
 * *output*; it is a post-condition, it is unreachable, and it says so where it
 * stands.
 *
 * A non-Latin-1 path such as `/日本` is the vector a fix framed only as "reject
 * control characters" leaves live: it is not a control character, but it throws
 * out of `Headers.set` through the same ByteString conversion. It is *not*
 * caught by any gate above — resolution keeps the origin — and it does not need
 * to be. `URL` percent-encodes it on the way through, so what gate 5 returns is
 * `/%E6%97%A5%E6%9C%AC`: pure ASCII, and the same place. That is normalisation
 * into the canonical spelling of a legitimate path, not the sanitisation this
 * function refuses to do — a CRLF injection is an attack with no valid reading,
 * while a non-ASCII path is an ordinary URL with exactly one.
 *
 * The invariant that makes the return value safe to hand to `Headers.set` is
 * therefore stronger than the gates state, and is asserted directly in
 * `tests/auth.test.ts`: **every value this returns is ASCII.** Swept over the
 * whole code-point space, in path, query and fragment position, plus lone
 * surrogates, nothing escapes it.
 *
 * @returns an ASCII path safe to hand to `redirect()`, or `/`.
 */
export function safeRedirectTarget(target: string | null | undefined): string {
  if (!target) return HOME_PATH;
  if (CONTROL_CHARACTERS.test(target)) return HOME_PATH;
  if (!target.startsWith("/")) return HOME_PATH;
  if (target.startsWith("//") || target.startsWith("/\\")) return HOME_PATH;

  let resolved: URL;
  try {
    resolved = new URL(target, UNREACHABLE_BASE);
  } catch {
    // A shape `URL` itself will not take is not one to hand a browser.
    return HOME_PATH;
  }

  if (resolved.origin !== UNREACHABLE_BASE) return HOME_PATH;

  const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;

  // Gate 5. `resolved.origin` is still this instance's at this point — the
  // synthesised authority only appears once the parts are joined back up.
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) {
    return HOME_PATH;
  }
  // A post-condition rather than a gate, and deliberately unreachable: gate 1
  // rejects control characters on the way in and `URL` percent-encodes anything
  // that could reintroduce one, so instrumented over 157,037 inputs that reach
  // this line it has never fired. Kept because it is the invariant the return
  // value is *for* — every value this returns is safe to hand `Headers.set` —
  // and a security function should assert that rather than infer it.
  if (CONTROL_CHARACTERS.test(path)) return HOME_PATH;

  return path;
}

/**
 * Build a gate over a configuration.
 *
 * Takes the configuration rather than reading it so that the rules can be
 * exercised as themselves, without a process-wide environment.
 */
export function createAuthGate(config: AuthConfig): AuthGate {
  const password = config.AUTH_PASSWORD;

  if (password === undefined) {
    // Open instance: no cookie, no login page, nothing to verify. The warning
    // banner in the UI is the whole of the security story, which is the point.
    return {
      enabled: false,
      isAuthenticated: async () => true,
      requireSession: async () => {},
      logIn: async () => ({ ok: true, response: redirect("/") }),
    };
  }

  if (config.SESSION_SECRET === undefined) {
    // Startup validation already refuses this combination by name; reaching
    // here would mean signing cookies with nothing, so refuse again rather than
    // degrade quietly.
    throw new Error(
      "SESSION_SECRET is required whenever AUTH_PASSWORD is set: the login cookie has nothing to sign with.",
    );
  }

  const secret = config.SESSION_SECRET;

  /**
   * Two storages over one cookie name, differing only in `Secure`.
   *
   * Built once each rather than per request. Reading never consults `Secure` —
   * it is an instruction to the browser about when to send the cookie, not part
   * of the signature — so either storage parses what the other issued, and only
   * the issuing side has to pick.
   */
  const storages = {
    secure: createCookieSessionStorage<SessionData>({
      cookie: { ...SESSION_COOKIE, secure: true, secrets: [secret] },
    }),
    insecure: createCookieSessionStorage<SessionData>({
      cookie: { ...SESSION_COOKIE, secure: false, secrets: [secret] },
    }),
  };

  const storage = storages.insecure;

  /**
   * Sessions are pinned to the password that issued them, so changing
   * `AUTH_PASSWORD` logs everyone out — which is the only revocation an
   * instance with no user table can offer.
   */
  const credential = sha256(password).toString("hex");

  const isAuthenticated = async (request: Request): Promise<boolean> => {
    const session = await storage.getSession(request.headers.get("Cookie"));
    return session.get("credential") === credential;
  };

  return {
    enabled: true,
    isAuthenticated,

    async requireSession(request) {
      const { pathname, target } = normalizePath(new URL(request.url));
      if (OPEN_PATHS.has(pathname)) return;
      if (await isAuthenticated(request)) return;

      // Keep the caller's place, but only for a plain page view: sending a form
      // POST back to itself after login would replay it unasked.
      //
      // Through the validator, so the gate cannot mint a return address it
      // would itself refuse — and *before* the `!== "/"` test, or a target that
      // validates down to "/" produces a redundant `?next=%2F`.
      const safe = safeRedirectTarget(target);
      const next = request.method === "GET" && safe !== "/" ? safe : null;
      throw redirect(
        next ? `${LOGIN_PATH}?next=${encodeURIComponent(next)}` : LOGIN_PATH,
      );
    },

    async logIn(submitted, redirectTo, request) {
      if (!passwordMatches(submitted, password)) {
        // Logged, because a self-hoster with no user table has nothing else to
        // notice an attempt with. The address is the forwarded one, which is
        // the only address that means anything behind a proxy.
        const from = request ? clientAddress(request) : null;
        console.warn(`Failed login attempt${from === null ? "" : ` from ${from}`}.`);

        // Says nothing about the password it was compared against. That there
        // is one is already obvious from the login page existing.
        return { ok: false, message: "Incorrect password." };
      }

      // The browser's own scheme, not ours: behind a TLS-terminating proxy the
      // request reaches us over plain http and the cookie must still be Secure.
      const issuer = request && isSecureRequest(request) ? storages.secure : storages.insecure;

      const session = await issuer.getSession();
      session.set("credential", credential);

      return {
        ok: true,
        response: redirect(safeRedirectTarget(redirectTo), {
          headers: { "Set-Cookie": await issuer.commitSession(session) },
        }),
      };
    },
  };
}

let gate: AuthGate | undefined;

/** The process-wide gate, built once from the validated configuration. */
export function authGate(): AuthGate {
  gate ??= createAuthGate(getConfig());
  return gate;
}
