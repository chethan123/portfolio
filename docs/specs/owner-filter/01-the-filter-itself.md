# 01 — The owner filter, parsed, normalised and carried

_Part of [0013-owner-filter.md](../0013-owner-filter.md)._

**What to build:** One pure module, `app/lib/owner-filter.ts`, and the route middleware that writes
its cookie. No screen changes, no reader changes, no database access — the module is plain `.ts`
rather than `.server` for the reason `app/lib/chart-range.ts:12-15` gives about itself: the control
component will need the type and the serialiser, and neither touches the database.

Doing this alone is worth a ticket because the awkward parts of this feature are all decisions about
a string. What `?owner=1,3,3` means, what a selection naming everybody means, what a stale cookie
naming a deleted person means — each is a fixture and a test here, or a bug found later on four
screens at once. `chart-range.ts` is the shape to copy throughout, including the `Object.hasOwn`
lesson at `:555-558`: a hand-typed param must fall through, never match something on a prototype.

**Blocked by:** Nothing. It touches no schema, no route and no reader.

**Status:** ready-for-agent

**The type**

- [ ] `OwnerFilter` is `readonly string[]` — owner ids as strings, because a `bigint` id never
      crosses through `Number()` (ARCHITECTURE.md §5.6)
- [ ] `ALL_OWNERS` is an exported frozen empty array, so "the whole household" is a value a diff can
      see rather than an omission
- [ ] A predicate `isFiltered(filter)` exists and is the only way a caller asks — no `.length` checks
      scattered across screens

**Parsing `?owner=`**

- [ ] `owner=3` yields `["3"]`; `owner=1,3` yields `["1","3"]`
- [ ] Ids are sorted numerically, not lexically — `owner=10,9` is `["9","10"]`, so two spellings of
      one selection cannot both be canonical
- [ ] Duplicates collapse: `owner=3,3` is `["3"]`
- [ ] An empty value, a missing param, and a value of only separators all yield `ALL_OWNERS`
- [ ] A non-digit id, a negative, a value over 18 digits, and a leading-zero id are each dropped —
      the guard `isAccount` already applies for the same reason (`app/lib/valuation.server.ts:370-384`)
- [ ] Dropping every id of a selection yields `ALL_OWNERS`, not an empty-but-filtered state
- [ ] Parsing never throws and never rejects: a hand-edited param produces a filter, never an error
      page, matching `parseQuery`'s rule at `app/lib/holdings-view.ts:400-407`

**Canonical spelling**

- [ ] `toOwnerParam(filter)` yields `""` for `ALL_OWNERS` and `owner=<ids>` otherwise, so an
      unfiltered screen's URL carries no `owner` at all
- [ ] A helper reports whether a request's `owner` param already matches its canonical spelling, for
      the redirect the screens will do

**Normalising against the roster**

- [ ] Given the account-owning roster, a selection naming every one of them normalises to
      `ALL_OWNERS` — ticking everybody is the unfiltered view, not a second spelling of it
- [ ] A selection naming a subset is left alone
- [ ] From the **URL**, an id matching no roster member is **kept** — the caller can then narrow to
      nothing and say so
- [ ] From the **cookie**, an id matching no roster member is **dropped**, and a selection emptied
      that way becomes `ALL_OWNERS`
- [ ] The two behaviours are separate exported functions, or one function taking the source
      explicitly — never a boolean nobody can read at the call site

**The cookie**

- [ ] `OWNER_COOKIE = "owner_filter"`, a name distinct from `chart_range` and `masked`
- [ ] `Path=/`, `SameSite=Lax`, and **no `Max-Age`** — session-scoped, which is ADR-0008's condition
      on a filter that survives navigation, and the one deliberate difference from `chart_range`
- [ ] Encoding is the same comma list as the URL; decoding returns null on anything it does not
      recognise, the way `decodeRangeCookieValue` does (`app/lib/chart-range.ts:495-506`)
- [ ] The `Cookie` header is matched on the whole name, so a cookie named `x_owner_filter` is not
      mistaken for this one

**Resolution**

- [ ] `readOwnerFilter(request)` returns the selection **and its source**: an explicit `owner` param
      wins, then the cookie, then `ALL_OWNERS`
- [ ] The source is part of the return value because the caller's handling of an unresolvable id
      depends on it
- [ ] A request with `?owner=` present but empty is explicit — it means the household, and it clears
      the cookie rather than falling back to it

**The middleware**

- [ ] `ownerFilterMiddleware()` writes the cookie from the request's **explicit** param only, never
      from the resolved value — the reasoning `chart-range.ts:580-602` gives about not wrapping a
      loader's return in `data(…, {headers})`
- [ ] An explicit household selection clears the cookie rather than storing an empty one
- [ ] It is exported and wired to nothing yet; ticket 03 mounts it

**Tests** (`tests/owner-filter.test.ts`)

- [ ] Every parse rule above, including the malformed ids, as a table of inputs
- [ ] Sort is numeric: `10,9` and `9,10` produce one canonical spelling
- [ ] All-selected normalises to `ALL_OWNERS` for a two-person and a four-person roster
- [ ] URL keeps an unknown id; cookie drops it; a cookie of only unknown ids yields the household
- [ ] Cookie round trip, and a cookie string carrying an unrelated name alongside
- [ ] Resolution precedence, including `?owner=` empty beating a set cookie
