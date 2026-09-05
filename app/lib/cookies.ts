/**
 * The one place a cookie is read off a request's `Cookie` header by hand.
 * Extracted from `masking.ts`'s original `readMaskingCookie` (spec 0007) so
 * every cookie this app reads shares the exact same matching rule instead of
 * each restating its own hand-rolled parser: `chart-range.ts`'s
 * `readRangeCookie` was the second (ticket 03's review is what caught it
 * still hand-rolling the loop this file replaces), and the lock's grant
 * cookie (ticket 03, `lock.server.ts`) is the third, reusing this from the
 * start rather than needing to be caught.
 *
 * Matched on the whole cookie name, never a substring: `unmasked=1` ends in
 * `masked=1`, and a looser match would silently read a different cookie's
 * value as this one's, in one direction only.
 */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie");
  if (header === null) return undefined;

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;

    if (pair.slice(0, separator).trim() === name) {
      return pair.slice(separator + 1).trim();
    }
  }

  return undefined;
}
