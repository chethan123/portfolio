/**
 * Where a form may send the browser back to. A control posting to a resource
 * route carries the page it was pressed on; that field arrives from the
 * request, so it is attacker-controlled — unguarded, a link to
 * `/refresh?redirectTo=https://evil.test` makes this app an open redirect.
 *
 * Resolving against a throwaway origin and demanding that origin back is the
 * whole check — deliberately not a pattern match on the first two
 * characters: `/\evil.test` starts with exactly one forward slash and passes
 * any such test, and the URL standard treats a backslash as a slash for
 * special schemes, resolving it to `https://evil.test/`. The parser that
 * decides where the browser actually goes is the only thing worth asking.
 *
 * Asking it once is not enough, because what leaves here is a *string* and the
 * browser parses it again: the parser pops a leading `..` off the path before
 * it appends the next segment, so `/..//evil.test` resolves to this origin
 * with a pathname of `//evil.test`, which is scheme-relative the second time
 * round. So the serialised answer is re-parsed against the same base and made
 * to name the same origin — the parser asked about the value actually handed
 * to `redirect()`, rather than a leading `//` pattern-matched by hand.
 */
const BASE = "http://return.invalid";

export function safeReturn(to: string | null | undefined): string {
  if (to === null || to === undefined || to === "") return "/";

  let url: URL;
  try {
    url = new URL(to, BASE);
  } catch {
    return "/";
  }

  // Anything that resolved somewhere else — an absolute URL, a
  // protocol-relative one, or a backslash the parser reads as a slash — is not
  // a page of ours.
  if (url.origin !== BASE) return "/";

  const path = `${url.pathname}${url.search}`;

  // The same question, asked of the answer. `new URL("//evil.test", BASE)` is
  // `http://evil.test` — and `new URL("//", BASE)` throws, an empty host being
  // no host at all for a special scheme.
  let serialised: URL;
  try {
    serialised = new URL(path, BASE);
  } catch {
    return "/";
  }
  if (serialised.origin !== BASE) return "/";

  return path;
}
