// Owner filter (spec 0013, ADR-0008): household-wide account-owner selection carried in the URL,
// never a cookie, so a pasted link reproduces the view. Canonical spelling must be a fixed point
// of react-router's rebuild serialiser, not just the URL parser's — see toOwnerParam.

// bigint ids as strings — bigint doesn't survive Number() (server/db.ts).
export type OwnerFilter = readonly string[];

// Household-scoped readers require the filter (spec 0013); naming "all" keeps that visible in review.
export const ALL_OWNERS: OwnerFilter = Object.freeze([]);

const DIGITS = /^\d+$/;

export function isFiltered(filter: OwnerFilter): boolean {
  return filter.length > 0;
}

// getAll, not get: checkboxes share the "owner" name (owner=1&owner=3) — get would misread
// "?owner=&owner=3" as the empty (whole-household) value.
export function readOwnerFilter(params: URLSearchParams): OwnerFilter {
  return canonicalise(
    params
      .getAll("owner")
      .flatMap((value) => value.split(","))
      .map((segment) => segment.trim())
      .filter((segment) => segment !== ""),
  );
}

// Without a leading "?", built via URLSearchParams (never hand-joined "owner=1,3") — a loader
// compares this to react-router's rebuilt url.search with !==, so it must stay a fixed point.
export function toOwnerParam(filter: OwnerFilter): string {
  const canonical = canonicalise(filter);
  if (!isFiltered(canonical)) return "";

  const params = new URLSearchParams();
  for (const id of canonical) params.append("owner", id);

  return params.toString();
}

// With the "?", or "" when unfiltered. The only state carried between screens — not
// location.search, which would drag one screen's range/sort/edit-row state onto another.
export function ownerSearch(filter: OwnerFilter): string {
  const param = toOwnerParam(filter);

  return param === "" ? "" : `?${param}`;
}

// The address a request should be reading, for owner-reading.server.ts's pre-database redirect —
// whole search since "?owner=1%2C3" and "?owner=1,3" parse equal but differ raw; `owners` overrides.
export function canonicalOwnerSearch(params: URLSearchParams, owners?: OwnerFilter): string {
  const rest = new URLSearchParams(params);
  rest.delete("owner");

  const search = [toOwnerParam(owners ?? readOwnerFilter(params)), rest.toString()]
    .filter((part) => part !== "")
    .join("&");

  return search === "" ? "" : `?${search}`;
}

// Sorted, de-duplicated, roster-free — a bad id survives (matches nothing later) rather than
// being guessed at here. Must be idempotent: every loader redirects to this, and a non-fixed
// point is an infinite redirect loop.
function canonicalise(ids: readonly string[]): OwnerFilter {
  const seen = [...new Set(ids.map(withoutLeadingZeros))].sort(compareIds);

  return seen.length === 0 ? ALL_OWNERS : seen;
}

// "03" and "3" are one owner; only stripped from all-digit ids. All-zeros keeps one digit
// ("000" -> "0"), matching no real id.
function withoutLeadingZeros(id: string): string {
  return DIGITS.test(id) ? id.replace(/^0+(?=\d)/, "") : id;
}

// Never Number() (NaN breaks sort's total order and the redirect-loop guard). Digit ids first,
// by length then code-unit compare — not localeCompare, whose ICU collation varies by deployment.
function compareIds(a: string, b: string): number {
  const aNumeric = DIGITS.test(a);
  const bNumeric = DIGITS.test(b);

  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  if (aNumeric && a.length !== b.length) return a.length - b.length;

  return a < b ? -1 : a > b ? 1 : 0;
}
