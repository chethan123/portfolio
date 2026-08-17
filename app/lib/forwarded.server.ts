/**
 * Reading the request as the client actually made it, from behind a proxy.
 *
 * The app serves plain HTTP and never manages certificates; TLS termination is
 * the operator's reverse proxy (DESIGN.md §10). The consequence is that every
 * request the app sees arrives over `http` from a proxy on the Compose network,
 * so the request's own scheme describes the last hop rather than the browser's
 * connection, and its peer address is the proxy rather than the visitor.
 *
 * DESIGN.md §10.1 settles what to do about that: the app trusts `X-Forwarded-*`.
 * That trust is unconditional and has one deployment requirement behind it —
 * **the app must not be reachable directly**, because anything that can connect
 * to it can set these headers. Compose publishes the app port for a LAN
 * instance; an internet-facing instance belongs behind the proxy and nowhere
 * else. `docs/operating.md` says so where an operator will read it.
 *
 * What is at stake is small and worth being exact about: a forged
 * `X-Forwarded-Proto` changes only the `Secure` attribute on the sender's own
 * session cookie, which can cost them their own session and nobody else's. It
 * grants no access — the gate in `auth.server.ts` reads none of this.
 */

/** The first entry of a comma-separated header, trimmed, or null if absent. */
function firstValue(request: Request, header: string): string | null {
  const raw = request.headers.get(header);
  if (raw === null) return null;

  // `client, proxy1, proxy2` — the leftmost entry is the one furthest from us,
  // which is the client. Later entries are the proxies it passed through.
  const first = raw.split(",")[0]?.trim() ?? "";
  return first === "" ? null : first;
}

/**
 * The scheme the browser actually used.
 *
 * Falls back to the request's own scheme, which is right when there is no proxy
 * — `localhost` in development, or a direct connection on a LAN.
 */
export function requestProtocol(request: Request): "http" | "https" {
  const forwarded = firstValue(request, "X-Forwarded-Proto")?.toLowerCase();
  if (forwarded === "https" || forwarded === "http") return forwarded;

  return new URL(request.url).protocol === "https:" ? "https" : "http";
}

/**
 * Was the browser's connection encrypted?
 *
 * This is what decides whether a cookie is issued `Secure`. It has to be the
 * browser's connection rather than ours: marking a cookie `Secure` on an
 * instance genuinely served over plain HTTP would have the browser drop it and
 * nobody could stay logged in, and omitting it behind TLS would let the cookie
 * travel in the clear if the origin is ever reached over http.
 */
export function isSecureRequest(request: Request): boolean {
  return requestProtocol(request) === "https";
}

/**
 * The visitor's address, for a log line.
 *
 * Null when there is no proxy in front: a `Request` carries no socket, so
 * without the header there is nothing to report, and inventing "unknown" as an
 * address would be worse than saying nothing. Nothing authorises on this — it
 * is an operator reading logs after a failed login, not an access rule.
 */
export function clientAddress(request: Request): string | null {
  return firstValue(request, "X-Forwarded-For");
}
