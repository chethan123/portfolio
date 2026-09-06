// Owner filter (spec 0013, ADR-0008): a household-wide account-owner selection carried
// between screens, never derived from who signed in. The URL is the whole of the state —
// no cookie, no stored setting (ADR-0008) — so a pasted link reproduces the view exactly.
// Parsing never drops an id (unknown/malformed ids just match nothing later); the canonical
// spelling must be a fixed point of react-router's request-rebuild serialiser, not just
// the URL parser's — see toOwnerParam.

// Strings because ids are bigint (server/db.ts) and bigint doesn't survive Number().
export type OwnerFilter = readonly string[];

// Household-scoped readers require the filter (spec 0013); naming "all" keeps that visible in review.
export const ALL_OWNERS: OwnerFilter = Object.freeze([]);

const DIGITS = /^\d+$/;

export function isFiltered(filter: OwnerFilter): boolean {
  return filter.length > 0;
}

// getAll, never get: checkboxes share the "owner" name (owner=1&owner=3), and get would
// keep only the first, misreading "?owner=&owner=3" as the empty (whole-household) value.
export function readOwnerFilter(params: URLSearchParams): OwnerFilter {
  return canonicalise(
    params
      .getAll("owner")
      .flatMap((value) => value.split(","))
      .map((segment) => segment.trim())
      .filter((segment) => segment !== ""),
  );
}

// Without a leading "?" (ownerSearch adds it). Built as a repeated URLSearchParams key,
// never hand-joined as "owner=1,3" — a loader compares this against the react-router-rebuilt
// request's url.search with !==, so it must be a fixed point of that serialiser, which only
// URLSearchParams's own output is guaranteed to be. Only fixed for filters already through
// readOwnerFilter (e.g. pre-trimmed).
export function toOwnerParam(filter: OwnerFilter): string {
  const canonical = canonicalise(filter);
  if (!isFiltered(canonical)) return "";

  const params = new URLSearchParams();
  for (const id of canonical) params.append("owner", id);

  return params.toString();
}

// With the "?", or "" when unfiltered (so {pathname, search} collapses to a bare path).
// The only thing carried between screens — not location.search, which would drag one
// screen's range/sort/edit-row state onto another.
export function ownerSearch(filter: OwnerFilter): string {
  const param = toOwnerParam(filter);

  return param === "" ? "" : `?${param}`;
}

// The address a request should be reading: owner param canonical and first, everything
// else kept. Used by owner-reading.server.ts to redirect before any database work — the
// whole search rather than a yes/no, since a boolean can't distinguish "?owner=1%2C3" from
// "?owner=1,3" (same two ids once parsed) and would miss that the raw URLs still differ.
// `owners` overrides the address's own filter, for redirecting to a different selection
// (e.g. bouncing an all-roster pick back to the household).
export function canonicalOwnerSearch(params: URLSearchParams, owners?: OwnerFilter): string {
  const rest = new URLSearchParams(params);
  rest.delete("owner");

  const search = [toOwnerParam(owners ?? readOwnerFilter(params)), rest.toString()]
    .filter((part) => part !== "")
    .join("&");

  return search === "" ? "" : `?${search}`;
}

// Sorted, de-duplicated, nothing dropped. Roster-free on purpose — screens redirect a
// non-canonical owner param before any database work, so a bad id survives (matches
// nothing later) rather than being guessed at here. Must be idempotent: this is what every
// loader redirects to, and a non-fixed-point spelling is an infinite redirect loop.
function canonicalise(ids: readonly string[]): OwnerFilter {
  const seen = [...new Set(ids.map(withoutLeadingZeros))].sort(compareIds);

  return seen.length === 0 ? ALL_OWNERS : seen;
}

// "03" and "3" are one owner; only stripped from all-digit ids. All-zeros keeps one digit
// ("000" -> "0"), which correctly matches no real id.
function withoutLeadingZeros(id: string): string {
  return DIGITS.test(id) ? id.replace(/^0+(?=\d)/, "") : id;
}

// Never Number() (NaN on a non-digit id breaks sort's total order and the redirect-loop
// guard above). Digit ids first, by length then code-unit compare — not localeCompare,
// whose collation depends on the image's ICU data and would vary the canonical URL by deployment.
function compareIds(a: string, b: string): number {
  const aNumeric = DIGITS.test(a);
  const bNumeric = DIGITS.test(b);

  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  if (aNumeric && a.length !== b.length) return a.length - b.length;

  return a < b ? -1 : a > b ? 1 : 0;
}
