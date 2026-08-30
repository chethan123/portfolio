/**
 * Whose money a screen is showing (spec 0013, ADR-0008).
 *
 * The **owner filter** is a household-wide selection of one or more account
 * owners, carried between screens and never derived from who signed in.
 * `CONTEXT.md` defines it, and the words here are that glossary's: an *owner*
 * is the single person an account's money belongs to, a *person* is the record.
 *
 * Not a `.server` module, for `chart-range.ts`'s reason: nothing here touches
 * the database, and the control component — rendered again in the browser after
 * hydration — needs the type and the serialiser as much as a loader does.
 *
 * **The URL is the whole of the state.** There is no cookie, no middleware and
 * no stored setting, so this module has no fallback to resolve and nothing to
 * tag a source with: the filter is present when `?owner=` is, and absent
 * otherwise. ADR-0008 records the trade — closing the tab forgets the filter
 * because there is nothing left that remembers it, and a link pasted to another
 * family member carries the same view, which a cookie could never do.
 *
 * **Nothing is ever dropped at parse.** A syntactically plausible id naming
 * nobody, a 25-digit id, an id that is not digits at all — each is kept, and
 * narrows to nothing when the query runs. Dropping one would widen the view,
 * which is the failure `holdings-view.ts`'s `parseQuery` already names: it
 * would *"silently show the whole portfolio to someone who asked for a slice of
 * it"*. A selection of nothing but dropped ids would normalise all the way back
 * to the household. The syntactic guard therefore lives in the predicate that
 * runs the query, never here.
 */

/**
 * The selected owners, as ids. Empty means the whole household.
 *
 * Ids are strings because they are `bigint`: `server/db.ts` registers the type
 * parsers that keep them so, and a `bigint` does not survive `Number()`.
 */
export type OwnerFilter = readonly string[];

/**
 * The unfiltered household, spelled as a value so a diff can see the choice.
 *
 * It has a name because the household-scoped readers take the filter as a
 * required first argument with no default (spec 0013, ticket 02): a screen
 * reading everyone's money then says the word rather than omitting it, and the
 * omission is visible in review rather than invisible.
 */
export const ALL_OWNERS: OwnerFilter = Object.freeze([]);

/** Digits and nothing else — the only ids that can order numerically. */
const DIGITS = /^\d+$/;

/** Whether a screen is narrowed at all. The only way to ask. */
export function isFiltered(filter: OwnerFilter): boolean {
  return filter.length > 0;
}

/**
 * The owner filter a request asked for, canonically spelled.
 *
 * Takes `URLSearchParams` rather than a `Request` so a loader (which has a URL)
 * and a component (which has `useSearchParams`) can both call it.
 *
 * Reads every `owner` the address carries, not just the first, because that is
 * how the control submits: checkboxes sharing a name produce `owner=1&owner=3`,
 * and a `<Form method="get">` of them is the whole control (ticket 03). `get`
 * would keep the first box and drop the rest. It also closes the one shape that
 * would genuinely *widen* — `?owner=&owner=3` reads as the empty first value
 * under `get`, which is the whole household.
 *
 * Never throws and never refuses. A hand-edited parameter produces a filter,
 * the same rule `parseQuery` keeps for the Holdings table's own state.
 */
export function readOwnerFilter(params: URLSearchParams): OwnerFilter {
  return canonicalise(
    params
      .getAll("owner")
      .flatMap((value) => value.split(","))
      // An empty segment is skipped rather than kept: `?owner=1,,3` is two ids,
      // and an id of "" could only ever match nothing while looking deliberate.
      // The trim is what makes `?owner=1, 3` two ids and not one id and one
      // that silently empties the screen.
      .map((segment) => segment.trim())
      .filter((segment) => segment !== ""),
  );
}

/**
 * The canonical spelling, **without** a leading `?` — `owner=1,3`, or `""`
 * when the filter is off.
 *
 * The bare pair, for composing into a query alongside other parameters.
 * `toSearch` in `holdings-view.ts` returns its string *with* a `?`, and
 * concatenating two such strings gives `?sort=value&?owner=1`; the two
 * functions here exist so that cannot happen.
 *
 * Canonicalises what it is given rather than trusting it, so the name is true
 * for any caller: an unsorted filter would otherwise produce a second spelling
 * of a view, which is what the loaders redirect on.
 *
 * **A screen composing this into a longer query must append the pair as it
 * stands**, never round-trip it through `URLSearchParams.set`: that spells the
 * separator `%2C`, and a canonical generator disagreeing with this one about
 * how a comma is written is a redirect that fires on every click.
 */
export function toOwnerParam(filter: OwnerFilter): string {
  const canonical = canonicalise(filter);

  // Each id encoded, the separators not: the grammar is `owner=1,3`.
  return isFiltered(canonical) ? `owner=${canonical.map(encodeURIComponent).join(",")}` : "";
}

/**
 * A complete search string for a navigation target, **with** the `?` — or `""`
 * when the filter is off, which collapses `to={{ pathname, search }}` back to a
 * bare path so an unfiltered instance's URLs stay clean.
 *
 * This is the whole of what the shell carries between screens: the owner
 * parameter and nothing else. Carrying `location.search` verbatim would drag
 * one screen's `range`, `sort` or half-typed `edit` row key onto another that
 * does not own it.
 */
export function ownerSearch(filter: OwnerFilter): string {
  const param = toOwnerParam(filter);

  return param === "" ? "" : `?${param}`;
}

/**
 * The address a request should be reading: its owner parameter spelled
 * canonically and first, everything else kept.
 *
 * What the screens redirect on, before any database work — so it answers from
 * the address alone, with no roster to consult. A loader compares it to
 * `url.search` and bounces once if they differ, which is what
 * `holdings.tsx`'s own canonical redirect already does with `toSearch`.
 *
 * It returns the whole search rather than a yes/no for two reasons. A boolean
 * would have to be computed from the *decoded* values, which cannot tell
 * `?owner=1%2C3` from `?owner=1,3` — so a screen emitting the first would be
 * reported canonical and one view would have two URLs. And it leaves the
 * loader to build the target, where the obvious `pathname + ownerSearch(...)`
 * silently drops the `range` and `start`/`end` the same address is carrying.
 *
 * `?owner=` present but empty is not canonical: it is the unfiltered screen,
 * whose spelling is no parameter at all.
 */
export function canonicalOwnerSearch(params: URLSearchParams): string {
  const rest = new URLSearchParams(params);
  rest.delete("owner");

  const search = [toOwnerParam(readOwnerFilter(params)), rest.toString()]
    .filter((part) => part !== "")
    .join("&");

  return search === "" ? "" : `?${search}`;
}

/**
 * Sorted, de-duplicated, and nothing dropped.
 *
 * **Roster-free on purpose.** Three screens redirect a non-canonical `owner` to
 * its canonical spelling *before* any database work, so this cannot know which
 * ids name a real person. It follows that an id naming nobody survives here and
 * empties the screen later, and that a hand-typed selection naming the whole
 * household is legal and renders exactly as the unfiltered screen — the control
 * never emits that spelling, because the control is the one place with a roster.
 *
 * It must also be idempotent. The string it produces is the one every loader
 * redirects to, and a canonical spelling that is not a fixed point is an
 * infinite redirect loop that nothing notices until someone opens the screen.
 */
function canonicalise(ids: readonly string[]): OwnerFilter {
  const seen = [...new Set(ids.map(withoutLeadingZeros))].sort(compareIds);

  return seen.length === 0 ? ALL_OWNERS : seen;
}

/**
 * `03` and `3` are one owner, not two.
 *
 * Stripped before de-duplication, and only from an id that is all digits —
 * there is nothing to normalise about a string that was never a number.
 * An id of only zeros keeps one, so `?owner=000` is `"0"` rather than `""`:
 * no person can have id 0, so it correctly matches nothing.
 */
function withoutLeadingZeros(id: string): string {
  return DIGITS.test(id) ? id.replace(/^0+(?=\d)/, "") : id;
}

/**
 * A total order that never calls `Number()`.
 *
 * Digit-only ids first, by length then lexicographically — which *is* numeric
 * order once the leading zeros are gone — and anything else after them,
 * lexicographically. A `Number(a) - Number(b)` comparator returns `NaN` for a
 * non-digit id, which makes `sort` implementation-defined, the canonical
 * spelling undefined, and the redirect loop above possible.
 *
 * Code-unit comparison, deliberately, and **not** `localeCompare` — which
 * `holdings-view.ts` argues for at length and is right to, for text a person
 * reads. This is not that: collation depends on the ICU data in the image, so
 * a locale-aware canonical spelling would be a URL that differs between two
 * deployments of the same application.
 */
function compareIds(a: string, b: string): number {
  const aNumeric = DIGITS.test(a);
  const bNumeric = DIGITS.test(b);

  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  if (aNumeric && a.length !== b.length) return a.length - b.length;

  return a < b ? -1 : a > b ? 1 : 0;
}
