/**
 * Whose money a screen is showing (spec 0013, ADR-0008): the **owner filter**,
 * a household-wide selection of account owners carried between screens, never
 * derived from who signed in (vocabulary: CONTEXT.md). Not a `.server` module
 * — the control component, rendered again after hydration, needs the type and
 * serialiser as much as a loader does.
 *
 * **The URL is the whole of the state** — no cookie, middleware or stored
 * setting: the filter is present when `?owner=` is. ADR-0008 records the
 * trade: closing the tab forgets the filter; a pasted link carries the same
 * view, which a cookie never could.
 *
 * **Nothing is dropped at parse.** An id naming nobody, a 25-digit id, an id
 * that is not digits at all — each is kept and narrows to nothing when the
 * query runs; dropping one would silently widen the view toward the whole
 * portfolio. The syntactic guard lives in the predicate that runs the query,
 * never here.
 *
 * **The canonical spelling must survive react-router's rebuild of the
 * request, not only URL parsing** — `toOwnerParam` says how, and
 * `tests/owner-filter.test.ts` round-trips it through both serialisers.
 */

/**
 * The selected owners, as ids — empty means the whole household. Strings
 * because they are `bigint`: `server/db.ts` keeps them so, and a `bigint`
 * does not survive `Number()`.
 */
export type OwnerFilter = readonly string[];

/**
 * The unfiltered household, named so a diff can see the choice: the
 * household-scoped readers take the filter required and undefaulted (spec
 * 0013), so a screen reading everyone's money says the word visibly in
 * review rather than omitting it invisibly.
 */
export const ALL_OWNERS: OwnerFilter = Object.freeze([]);

/** Digits and nothing else — the only ids that can order numerically. */
const DIGITS = /^\d+$/;

/** Whether a screen is narrowed at all. The only way to ask. */
export function isFiltered(filter: OwnerFilter): boolean {
  return filter.length > 0;
}

/**
 * The owner filter a request asked for, canonically spelled. Takes
 * `URLSearchParams` so a loader (has a URL) and a component
 * (`useSearchParams`) can both call it.
 *
 * `getAll`, never `get`: checkboxes sharing a name submit `owner=1&owner=3`
 * (ticket 03), and `get` would keep the first box, drop the rest, and read
 * `?owner=&owner=3` as the empty first value — the whole household. Never
 * throws, never refuses: a hand-edited parameter produces a filter, the rule
 * `parseQuery` keeps for the Holdings table's own state.
 */
export function readOwnerFilter(params: URLSearchParams): OwnerFilter {
  return canonicalise(
    params
      .getAll("owner")
      .flatMap((value) => value.split(","))
      // Empty segments skipped: `?owner=1,,3` is two ids, and "" could only
      // match nothing while looking deliberate. The trim makes `?owner=1, 3`
      // two ids, not one plus one that silently empties the screen.
      .map((segment) => segment.trim())
      .filter((segment) => segment !== ""),
  );
}

/**
 * The canonical spelling **without** a leading `?` — `owner=1&owner=3`, or
 * `""` when off — for composing into a longer query (`toSearch` returns
 * *with* `?`; two such would concatenate into `?sort=value&?owner=1`).
 *
 * **A repeated key, built by `URLSearchParams`, never joined.** A loader
 * compares this against its request's `url.search` with `!==`, and
 * `url.search` is react-router's own rebuild through the form-urlencoded
 * serialiser, not the address sent (`callRouteHandler`) — so the spelling
 * must be a fixed point of *that* serialiser, which a hand-joined `owner=1,3`
 * was not, and looped forever. `URLSearchParams` output re-parses to itself
 * and holds nothing the URL parser touches either, so it is a fixed point of
 * both, by construction — until `future.v8_passThroughRequests` stops the
 * rebuild altogether.
 *
 * Fixed only for a filter already through {@link readOwnerFilter}:
 * `toOwnerParam([" x "])` reads back trimmed, so it is not its own fixed
 * point. Every caller here passes read output.
 */
export function toOwnerParam(filter: OwnerFilter): string {
  const canonical = canonicalise(filter);
  if (!isFiltered(canonical)) return "";

  const params = new URLSearchParams();
  for (const id of canonical) params.append("owner", id);

  return params.toString();
}

/**
 * A complete search string **with** the `?`, or `""` when the filter is off
 * — which collapses `to={{ pathname, search }}` to a bare path, keeping an
 * unfiltered instance's URLs clean. This is all the shell carries between
 * screens: carrying `location.search` verbatim would drag one screen's
 * `range`, `sort` or half-typed `edit` row key onto another.
 */
export function ownerSearch(filter: OwnerFilter): string {
  const param = toOwnerParam(filter);

  return param === "" ? "" : `?${param}`;
}

/**
 * The address a request should be reading: its owner parameter spelled
 * canonically and first, everything else kept. What screens redirect on
 * before any database work — answered from the address alone, no roster.
 * `owner-reading.server.ts` is the caller that matters: it compares this
 * against a request's `url.search` — the react-router-rebuilt request a
 * loader actually receives, per `toOwnerParam`'s doc — with `!==`, so this
 * function's output has to carry that function's fixed-point property, and
 * does, being built from it.
 *
 * The whole search rather than a yes/no: a boolean computed from *decoded*
 * values cannot tell `?owner=1%2C3` from `?owner=1,3` — both parse to the
 * same two ids, since `readOwnerFilter` splits a decoded comma either way —
 * so one view would have two URLs where only the raw text still disagrees;
 * and leaving the loader to build the target as `pathname + ownerSearch(...)`
 * silently drops the `range` and `start`/`end` the same address carries.
 * `?owner=` present but empty is not canonical — the unfiltered spelling is
 * no parameter at all.
 *
 * `owners` overrides the address, for the caller spelling a *different*
 * selection into the same address: bouncing an all-roster selection back to
 * the household, and the "Show everyone" link that keeps range and sort.
 */
export function canonicalOwnerSearch(params: URLSearchParams, owners?: OwnerFilter): string {
  const rest = new URLSearchParams(params);
  rest.delete("owner");

  const search = [toOwnerParam(owners ?? readOwnerFilter(params)), rest.toString()]
    .filter((part) => part !== "")
    .join("&");

  return search === "" ? "" : `?${search}`;
}

/**
 * Sorted, de-duplicated, nothing dropped. **Roster-free on purpose**: screens
 * redirect a non-canonical `owner` before any database work, so this cannot
 * know which ids name a real person — an id naming nobody survives and
 * empties the screen later, and a hand-typed selection naming the whole
 * household renders as the unfiltered screen (the control, the one place
 * with a roster, never emits that spelling). Must be idempotent: this string
 * is what every loader redirects to, and a canonical spelling that is not a
 * fixed point is an infinite redirect loop.
 */
function canonicalise(ids: readonly string[]): OwnerFilter {
  const seen = [...new Set(ids.map(withoutLeadingZeros))].sort(compareIds);

  return seen.length === 0 ? ALL_OWNERS : seen;
}

/**
 * `03` and `3` are one owner. Stripped before de-duplication, only from
 * all-digit ids — nothing to normalise about a string that was never a
 * number. All zeros keeps one (`?owner=000` → `"0"`): no person has id 0,
 * so it correctly matches nothing.
 */
function withoutLeadingZeros(id: string): string {
  return DIGITS.test(id) ? id.replace(/^0+(?=\d)/, "") : id;
}

/**
 * A total order that never calls `Number()`: digit-only ids first, by length
 * then lexicographically — numeric order once leading zeros are gone — then
 * the rest lexicographically. `Number(a) - Number(b)` returns `NaN` for a
 * non-digit id, making `sort` implementation-defined, the canonical spelling
 * undefined, and the redirect loop above possible. Code-unit comparison,
 * **not** `localeCompare` (right for text a person reads, `holdings-view.ts`):
 * collation depends on the image's ICU data, and a locale-aware canonical
 * spelling is a URL that differs between deployments.
 */
function compareIds(a: string, b: string): number {
  const aNumeric = DIGITS.test(a);
  const bNumeric = DIGITS.test(b);

  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  if (aNumeric && a.length !== b.length) return a.length - b.length;

  return a < b ? -1 : a > b ? 1 : 0;
}
