# 01 — The owner filter, parsed, normalised and carried

_Part of [0013-owner-filter.md](../0013-owner-filter.md)._

**What to build:** One pure module, `app/lib/owner-filter.ts`. No screen changes, no reader changes,
no database access, no cookie and no middleware — the module is plain `.ts` rather than `.server` for
the reason `app/lib/chart-range.ts:12-15` gives about itself: the control component will need the
type and the serialiser, and neither touches the database.

Doing this alone is worth a ticket because the awkward parts of this feature are all decisions about
a string. What `?owner=1,3,3` means, what a selection naming everybody means, what an id naming a
deleted person means — each is a fixture and a test here, or a bug found later on four screens at
once. `chart-range.ts` is the shape to copy throughout, including the `Object.hasOwn`
lesson at `:554-558`: a hand-typed param must fall through, never match something on a prototype.

**Blocked by:** Nothing. It touches no schema, no route and no reader.

**Status:** ready-for-agent

**The exports, by name and signature.** These are consumed by three later tickets, so they are
fixed here rather than left to the implementer:

```ts
export type OwnerFilter = readonly string[];
export const ALL_OWNERS: OwnerFilter;
export function isFiltered(filter: OwnerFilter): boolean;

/** Parse from a query string. Takes URLSearchParams, so a loader (which has a URL)
 *  and a component (which has useSearchParams) can both call it. */
export function readOwnerFilter(params: URLSearchParams): OwnerFilter;

/** The canonical spelling, WITHOUT a leading "?" — e.g. `owner=1,3`, or "" when off. */
export function toOwnerParam(filter: OwnerFilter): string;

/** A complete search string for a navigation target, WITH the "?" — e.g. `?owner=1,3`,
 *  or "" when off. This is what the shell puts in `to={{ pathname, search }}`. */
export function ownerSearch(filter: OwnerFilter): string;
```

**The `?` is a real trap.** `toSearch` (`app/lib/holdings-view.ts:452`) returns its string *with* a
leading `?`. Two functions exist here precisely so nobody concatenates two `?`-prefixed strings into
`?sort=value&?owner=1`. `toOwnerParam` is the bare pair for composing; `ownerSearch` is the complete
search for navigating. Nothing else returns a search string.

**The type**

- [ ] `OwnerFilter` is `readonly string[]` — owner ids as strings, because a `bigint` does not
      survive `Number()` (`server/db.ts:28-30`, ARCHITECTURE.md:738-739)
- [ ] `ALL_OWNERS` is an exported frozen empty array, so "the whole household" is a value a diff can
      see rather than an omission
- [ ] A predicate `isFiltered(filter)` exists and is the only way a caller asks — no `.length` checks
      scattered across screens

**Parsing `?owner=`**

- [ ] `owner=3` yields `["3"]`; `owner=1,3` yields `["1","3"]`
- [ ] Ids are ordered by a **total order that never calls `Number()`**: digit-only ids first, by
      length then lexicographically — numeric ordering for equal-length strings — and any other id
      last, lexicographically. `owner=10,9` is `["9","10"]`. A `Number(a) - Number(b)` comparator
      returns `NaN` on a non-digit id, which makes `sort` implementation-defined, the canonical
      spelling undefined, and a redirect-to-canonical loop possible
- [ ] Leading zeros are stripped from a digit-only id before de-duplication, so `?owner=03,3` is one
      selection and not two
- [ ] Canonicalisation is **roster-free**: sort, de-duplicate, drop nothing. It must stay pure, because
      three screens redirect a non-canonical param *before any database work* and cannot know the
      roster at that point
- [ ] Duplicates collapse: `owner=3,3` is `["3"]`
- [ ] An empty value, a missing param, and a value of only separators all yield `ALL_OWNERS`
- [ ] Whitespace around a separator is trimmed: `?owner=1, 3` is `["1","3"]`, not `["1"," 3"]`. An
      untrimmed id would be "kept, matching nothing" and silently empty the screen
- [ ] An empty segment is skipped, not kept: `?owner=1,,3` is `["1","3"]`
- [ ] `?owner=0`, and any id that is only zeros, reduces to `"0"` after leading-zero stripping and is
      kept — no person can have id 0, so it correctly matches nothing rather than becoming `""`
- [ ] A syntactically plausible id is **kept**, whatever it names. Dropping it would widen the view,
      which `app/lib/holdings-view.ts:399-407` names as the hazard: *"dropping it would silently show
      the whole portfolio to someone who asked for a slice of it"*
- [ ] **Nothing is refused at parse, including a 25-digit id.** The syntactic guard lives in
      `isOneOf` (ticket 02), which emits `false` for anything failing `/^\d+$/` or longer than 18
      digits, so "no such owner" comes out of the query. Guarding at parse would drop the id, and a
      selection of only dropped ids would normalise to the whole household — the widening this rule
      exists to prevent, two bullets above
- [ ] Parsing never throws and never rejects: a hand-edited param produces a filter, never an error
      page, matching `parseQuery`'s rule at `app/lib/holdings-view.ts:399-407`

**Canonical spelling**

- [ ] `toOwnerParam(filter)` yields `""` for `ALL_OWNERS` and `owner=<ids>` otherwise, so an
      unfiltered screen's URL carries no `owner` at all
- [ ] A helper reports whether a request's `owner` param already matches its canonical spelling, for
      the redirect the screens will do

**Normalising against the roster**

- [ ] The **control** never emits a selection naming every account-owning person: with everybody
      ticked it submits nothing, so the app never produces that URL. This is where Q7's "all-ticked
      is the household" lives — in the control, which has the roster, not in canonicalisation, which
      does not
- [ ] A hand-typed `?owner=` naming everybody is therefore legal and renders exactly as the
      unfiltered screen. One redundant spelling nobody generates is the price of a pure, roster-free
      redirect
- [ ] An id matching no roster member is kept, narrows to nothing, and the screen says so — the same
      rule whatever carried it

**Resolution**

- [ ] `readOwnerFilter(request)` reads the `owner` param and nothing else. Present means filtered,
      absent means `ALL_OWNERS`
- [ ] There is **no cookie, no middleware and no fallback**, and therefore no source to tag. ADR-0008
      records the trade: the URL is the whole of the state, so closing the tab forgets the filter
      because the URL is gone
- [ ] `?owner=` present but empty is the household — the same answer as absent, since there is
      nothing to fall back to

**Carrying it between screens**

- [ ] A helper the shell uses to build a navigation target's search. It emits **the canonical owner
      param and nothing else** — never the caller's whole `location.search`, which would drag
      `range`, `sort` or a half-typed `edit` row key onto a screen that does not own it
- [ ] It belongs here rather than in the component, so it is testable without a router
- [ ] It is exported and used by nothing yet; ticket 03 wires the nav

**Tests** (`tests/owner-filter.test.ts`)

- [ ] Every parse rule above, including the malformed ids, as a table of inputs
- [ ] Sort is numeric: `10,9` and `9,10` produce one canonical spelling
- [ ] Canonicalisation is idempotent: `canonical(canonical(x)) === canonical(x)` for every input in
      the table. This module produces the string three loaders redirect to, so a non-idempotent
      canonical spelling is an infinite redirect loop
- [ ] **No roster test here.** All-selected-is-the-household needs the roster and therefore lives in
      the control, in ticket 03 — this module never sees a roster
- [ ] An unknown id is kept and narrows to nothing
- [ ] A 25-digit id survives parsing unchanged — it is ticket 02's predicate that refuses it
- [ ] `?owner=` empty and `owner` absent both yield `ALL_OWNERS`
- [ ] The nav helper emits the owner param alone: given a filtered screen's full search it returns
      only `owner`, and given no filter it returns `""`
- [ ] The total order is deterministic for a selection mixing digit and non-digit ids
