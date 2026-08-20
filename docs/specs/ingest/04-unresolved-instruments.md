# 04 — First sightings, resolved once and remembered

_Part of [0004-ingest.md](../0004-ingest.md)._

**What to build:** The screen §4.3's alias table was designed for. Every distinct string in the
mapped instrument column is looked up byte-exact in `instrument_alias`; the misses are listed here,
each resolved either to an instrument that already exists or to a new one created on the spot. Both
paths write the alias, so the same brokerage's next export passes through silently.

It is also the first place in the *application* that creates an `instrument` or an
`instrument_alias`. Both exist today only because `scripts/seed-demo.ts` writes them in raw SQL
(`scripts/seed-demo.ts:835`, `:883`) — so this screen is where the decisions that come with an
instrument get made by a person for the first time: a symbol and a feed, or no symbol and a manual
price.

**Blocked by:** 03 (the mapping names the instrument column).

**Status:** ready-for-agent

**Resolution**

- [ ] Distinct strings from the instrument column are looked up against `instrument_alias`, exactly
      as written — no trimming, no case folding, no normalisation. `collate "C"` on that column is
      the point
- [ ] Strings that resolve are not shown; the screen lists only first sightings
- [ ] With nothing unresolved, the step is skipped by redirect rather than rendering an empty screen
- [ ] The count is stated plainly — "2 of 14 holdings in this file have not been seen before"

**Per unresolved string**

- [ ] The raw string is shown exactly as the file wrote it, alongside the name column's value for
      that row when one is mapped, and the quantity — enough to recognise it
- [ ] **Point at an existing instrument:** a `<select>` of instruments by symbol and name, which is
      how a second spelling of a fund already held gets attached to it
- [ ] **Create a new one:** symbol (optional), name (required, defaulted from the mapped name column
      or the raw string), price source, and a classification
- [ ] Price source offers `feed` and `manual` only. `fixed` is the seeded USD row's, and a second
      fixed-price instrument is not a thing this screen makes
- [ ] `feed` requires a symbol; `manual` allows none, which is the collective investment trust case
      the `instrument` table's comment describes
- [ ] Classification is a `<select>` of existing classifications plus an inline "new classification"
      — a name and one of the four asset classes. With only the seeded `Cash` present, this is the
      path every equity takes on a first run
- [ ] A new classification name colliding with an existing one is a field-level refusal naming it,
      since `classification.name` is unique and it is the user-facing label
- [ ] Every unresolved string must be resolved before the step passes; there is no "skip this one",
      because a skipped row is a holding silently missing from the statement

**The USD probe**

- [ ] Creating a `feed` instrument asks the price provider for its symbol once, through 0002's
      existing interface
- [ ] A quote in a currency other than USD refuses the creation, naming the symbol and the currency,
      in the same words the refresh-time guard uses. This is the only moment the household can act
      on it
- [ ] A provider error, timeout or unknown symbol does **not** block creation: the instrument is
      created, and the next refresh marks it stale exactly as it does today for any symbol that
      stops quoting
- [ ] The probe is behind the provider interface, so tests drive a stub and no test touches the
      network

**Writes**

- [ ] Resolving writes an `instrument_alias` row for the raw string, pointing at the chosen or
      created instrument
- [ ] Creating writes `instrument` with symbol, name, price source and classification, and a
      `classification` row first when a new one was typed
- [ ] These writes happen at this step rather than at commit, deliberately: an alias is a fact about
      vocabulary, not about this statement, and re-uploading a corrected file should not ask the
      same questions again
- [ ] A string resolved here and then abandoned before commit leaves the alias behind, which is
      correct — the next upload is quieter and nothing was recorded as held
- [ ] Two drafts resolving the same string concurrently do not error: the alias insert tolerates the
      conflict and the existing row wins
