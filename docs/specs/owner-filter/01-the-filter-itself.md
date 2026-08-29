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
lesson at `:554-558`: a hand-typed param must fall through, never match something on a prototype.

**Blocked by:** Nothing. It touches no schema, no route and no reader.

**Status:** ready-for-agent

**The type**

- [ ] `OwnerFilter` is `readonly string[]` — owner ids as strings, because a `bigint` does not
      survive `Number()` (`server/db.ts:28-30`, ARCHITECTURE.md:738-739)
- [ ] `ALL_OWNERS` is an exported frozen empty array, so "the whole household" is a value a diff can
      see rather than an omission
- [ ] A predicate `isFiltered(filter)` exists and is the only way a caller asks — no `.length` checks
      scattered across screens

**Parsing `?owner=`**

- [ ] `owner=3` yields `["3"]`; `owner=1,3` yields `["1","3"]`
- [ ] Ids are sorted numerically, not lexically — `owner=10,9` is `["9","10"]`, so two spellings of
      one selection cannot both be canonical
- [ ] Canonicalisation is **roster-free**: sort, de-duplicate, drop nothing. It must stay pure, because
      three screens redirect a non-canonical param *before any database work* and cannot know the
      roster at that point
- [ ] Duplicates collapse: `owner=3,3` is `["3"]`
- [ ] An empty value, a missing param, and a value of only separators all yield `ALL_OWNERS`
- [ ] A syntactically plausible id is **kept**, whatever it names. Dropping it would widen the view,
      which `app/lib/holdings-view.ts:399-407` names as the hazard: *"dropping it would silently show
      the whole portfolio to someone who asked for a slice of it"*
- [ ] `isOneOf` (ticket 02) emits `false` for an id that cannot be a `bigint`, so "no such owner"
      comes out of the query — `isAccount`'s posture at `app/lib/valuation.server.ts:370-384`, whose
      guard is `/^\d+$/` and nothing more
- [ ] A value over 18 digits is refused at parse — the one genuine addition, since `isAccount` lacks
      it and an out-of-range bigint currently reaches Postgres and 500s
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

**The cookie**

- [ ] `OWNER_COOKIE = "owner_filter"`, a name distinct from `chart_range` and `masked`
- [ ] `Path=/`, `SameSite=Lax`, and **no `Max-Age`** — session-scoped, which is ADR-0008's condition
      on a filter that survives navigation, and the one deliberate difference from `chart_range`
- [ ] Encoding is the same comma list as the URL; decoding returns null on a value it cannot read at
      all, the way `decodeRangeCookieValue` does (`app/lib/chart-range.ts:495-506`) — it rejects the
      whole value and never prunes members
- [ ] **The header reader is extracted, not copied.** `app/lib/masking.ts:182-196` and
      `app/lib/chart-range.ts:514-528` are already the same fourteen lines; a third copy is the point
      at which `docs/developing.md`'s "one site per hazard" bites. A shared
      `readCookie(request, name)` returning the raw value, with both existing callers moved onto it
      and each still decoding as it does today — masking deliberately does not decode

**Resolution**

- [ ] `readOwnerFilter(request)` returns the selection **and its source**: an explicit `owner` param
      wins, then the cookie, then `ALL_OWNERS`
- [ ] The source is part of the return value because the caller's handling of an unresolvable id
      depends on it
- [ ] A request with `?owner=` present but empty is explicit — it means the household, and it clears
      the memory rather than falling back to it. This is a **deliberate divergence** from
      `readChartRange`, where an empty `?range=` fails `Object.hasOwn` and falls through to the
      cookie (`app/lib/chart-range.ts:563`); without the divergence there is no way to say "everyone"
      from a link

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
- [ ] An unknown id is kept and narrows to nothing, from either source
- [ ] An id of 25 digits is refused at parse and never reaches Postgres
- [ ] Cookie round trip, and a cookie string carrying an unrelated name alongside
- [ ] Resolution precedence, including `?owner=` empty beating a set cookie
