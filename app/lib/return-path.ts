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

  return `${url.pathname}${url.search}`;
}
