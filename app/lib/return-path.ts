// Guards against open redirect. Uses the URL parser, not a `//` pattern match:
// `/\evil.test` and other backslash tricks fool a pattern match but not the parser.
const BASE = "http://return.invalid";

export function safeReturn(to: string | null | undefined): string {
  if (to === null || to === undefined || to === "") return "/";

  let url: URL;
  try {
    url = new URL(to, BASE);
  } catch {
    return "/";
  }

  if (url.origin !== BASE) return "/";

  const path = `${url.pathname}${url.search}`;

  // Re-parse the serialised path: a leading ".." or "//" can re-resolve to a different origin.
  let serialised: URL;
  try {
    serialised = new URL(path, BASE);
  } catch {
    return "/";
  }
  if (serialised.origin !== BASE) return "/";

  return path;
}
