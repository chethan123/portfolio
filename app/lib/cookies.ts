// Matches the whole cookie name, never a substring (`unmasked=1` ends in `masked=1`).
export function readCookieHeader(header: string, name: string): string | undefined {
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;

    if (pair.slice(0, separator).trim() === name) {
      return pair.slice(separator + 1).trim();
    }
  }

  return undefined;
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie");
  return header === null ? undefined : readCookieHeader(header, name);
}
