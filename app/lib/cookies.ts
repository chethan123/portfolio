/**
 * The one place a cookie is read off a request's `Cookie` header by hand.
 * Extracted from `masking.ts`'s original `readMaskingCookie` (spec 0007) so
 * the lock's grant cookie (ticket 03, `lock.ts`) reuses the exact same
 * matching rule instead of becoming a third hand-rolled parser —
 * `chart-range.ts`'s `readRangeCookie` is already the second, restated by
 * hand rather than shared; this file is where that stops.
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
