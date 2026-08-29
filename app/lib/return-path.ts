/**
 * Where a form is allowed to send the browser back to.
 *
 * Any control that posts to a resource route has to carry the page it was
 * pressed on, because the action has no other way to know. That field arrives
 * from the request, so it is attacker-controlled: without a guard, a link to
 * `/refresh?redirectTo=https://evil.test` turns this app into an open redirect
 * with its own domain on the address bar.
 *
 * Resolving against a throwaway origin and demanding that origin back is the
 * whole check, and it is deliberately not a pattern match on the first two
 * characters. `/\evil.test` starts with exactly one forward slash and passes
 * any such test — and then the URL standard, which treats a backslash as a
 * slash for special schemes, resolves it to `https://evil.test/`. The parser
 * that decides where the browser actually goes is the only thing worth asking.
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
