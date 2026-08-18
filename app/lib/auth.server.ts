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

/** The outcome of a login attempt. */
export type LoginResult =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly message: string };

export type AuthGate = {
  /** Is a password configured? False means the instance is open to anyone. */
  readonly enabled: boolean;
  /** Does this request carry a valid session? */
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

/**
 * Only ever redirect somewhere on this instance.
 *
 * A `next` parameter is attacker-supplied by construction — it survives a
 * round trip through a login form — so anything that could leave the origin
 * (`//evil.example`, `https://…`, a backslash Windows treats as a slash)
 * becomes the home page instead.
 */
export function safeRedirectTarget(target: string | null | undefined): string {
  if (!target) return "/";
  if (!target.startsWith("/")) return "/";
  if (target.startsWith("//") || target.startsWith("/\\")) return "/";
  return target;
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
      const next = request.method === "GET" && target !== "/" ? target : null;
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
