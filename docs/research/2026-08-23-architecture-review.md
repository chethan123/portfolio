# Architecture review — deepening opportunities

*Reviewed 2026-08-23 against `f550132`. Ten candidates, five rejected findings.*

An architectural review looking for **deepening opportunities**: places where a module's interface
carries knowledge that its implementation could hold instead. The vocabulary is the one in
`.claude/skills/codebase-design/SKILL.md` — **module**, **interface** (everything a caller must know:
signature, invariants, ordering constraints, error modes), **depth** (leverage at the interface),
**seam**, **adapter**, **leverage** (what callers get), **locality** (what maintainers get).

Nothing here is an approved slice. The rejected findings in [§4](#4-rejected-findings) matter as much
as the accepted ones: this codebase argues its decisions in module headers, so the dominant failure
mode for a review like this is **re-litigation**, and three of the five rejections killed a finding
this review had initially rated *Strong*.

## Method and its limits

- Scoped by `git log` hot spots over the last forty commits: holdings, allocation, analysis, ingest,
  pricing. `app/app.css` is the single most-touched file (10 commits) and was examined and set aside
  — 135 classes, one shared `.data-table` family, no depth problem.
- Three exploring agents (ingest, holdings/valuation, pricing/persistence), then **three adversarial
  passes**. Every claim that survived was re-verified directly against the source.
- **Line numbers were the weakest part of the first draft.** Corrections found during review are
  recorded inline below, because the same miscounts would otherwise be inherited by whoever acts on
  this.
- No `CONTEXT.md` and no `docs/adr/` exist, so there were no ADR conflicts to flag. `DESIGN.md` is
  the design record. (An ADR directory was created in `c4c5e7c` and deliberately removed in `d242e1b`.)
- **The whole review is loader-side and lib-side.** No test in this repo imports a route
  (`grep` over `tests/` for `routes/` returns nothing, and there is no `@testing-library`,
  `happy-dom` or `jsdom` in `package.json`), so anything living in a route module is untestable by
  construction. That fact drives several candidates below and is worth treating as a standing
  constraint rather than a finding.

---

## 1. What is already deep — do not break these

Listed first because several candidates lean on them, and because a future review should not spend
effort here.

| Module | Why it earns its keep |
|---|---|
| `app/lib/money.ts` | The only place JS money arithmetic happens. `BigInt` counts of the last decimal place; no float, no decimal library. Header at `:19-29` records that it was *moved* rather than copied out of `allocation.ts`. |
| `allocation.ts`'s private `group()` (`:132-165`) | Three thin public groupings over one private function holding the gross-positive-denominator argument, the coverage discipline and the exact summation. |
| `valuation.server.ts`'s `ValuedSource` (`:162-170`) | The cleanest seam in the repo. `valuedNow()` and `valuedAt(date)` are two adapters; nine public reads fall out of three private helpers written once against both. |
| `server/db.ts:43-70` | Single pool construction site, because that is where the `numeric`/`int8`/`date` type-parser override is registered. A second site would silently reintroduce float money. |
| `commitUpload` (`uploads.server.ts:884-1048`) | Three parameters over the closed-account refusal, the forged-account guard, the account-number guard, the as-of resolution, the product guard, the delete-first transaction guard. `review.tsx:69-103` is pure translation. The model the rest of ingest should follow. |
| `resolveAll` (`instrument-resolution.server.ts:293-675`) | Validate-then-probe-then-write behind one call, with `ResolutionDeps.probe` a real seam and real adapters. |
| `readCsv` (`csv.ts:135-163`), `parseStatement` (`statement.ts:275-571`) | Two stated invariants downstream leans on; refusals as data addressed to row and column. |
| `market-hours.ts` | The trust asymmetry between `isMarketOpen` (a cost optimisation nothing trusts) and `marketDateOf` (a correctness mechanism) is the module's real interface, stated in one place. |
| `auth.server.ts:168`, `server/config.ts:125-158` | `createAuthGate(config)` and `loadConfig(env)` take their input rather than reading it; the memoised process-wide wrapper sits beside them. |
| `rowKey`/`parseRowKey` (`holdings-view.ts:743-780`) | One canonical spelling of a row's URL identity, round-trip tested. |
| `balances.server.ts:60-97` | Exhaustive `Record<AccountKind, boolean>` rather than a list, so a new account kind is a compile error where someone must decide. |
| The `db: Kysely<Database> = getDb()` trailing parameter | 57 signatures. Production omits it, tests pass a transaction. A seam for rollback-per-test at zero cost to callers. |
| `tests/support/database.ts:98-113` + `fixtures.ts` | Real Postgres on tmpfs, per-test transaction rollback, one-line setup. **The suite has zero mocks** — `vi.mock`/`vi.spyOn`/`vi.fn` appear nowhere. Every double is a hand-written object satisfying a declared type. Do not let this be "modernised". |

**`holding_valued` is carrying its weight.** DESIGN.md §8.2 names hand-rolled query drift as "the
weakest point in the design". It isn't, currently: only two reads in the application touch
`holding`/`position_set` outside the view (`positions.server.ts:147-161`, `balances.server.ts:146-150`),
both are edit-form reads, and both resolve "which set" through `latest_position_set(...)` rather than
writing a second `order by as_of_date desc`. `holding_valued_at` reuses the view's row type
(`returns setof holding_valued`, `0003_holding_valued_at.sql:41`). No bypass found.

---

## 2. Accepted findings

### 2.1 `rememberMapping` — one predicate, computed twice, at two instants

**Rating: Strong. Top recommendation.**
**Files:** `app/routes/upload/columns.tsx:237-278`, `app/lib/uploads.server.ts:323-350`

The only *correctness* finding in this review; everything else is locality.

`had_first_sightings` drives the upload step strip (`uploads.server.ts:802`,
`upload/instruments.tsx:71`). It is computed inside `saveMapping` (`uploads.server.ts:332-340`) from
the module's own `unresolvedStrings` query. The redirect target — instruments or review — is then
chosen at `columns.tsx:275-278` from a **second, strictly later** `unresolvedStrings` query.

Two computations of one predicate at two instants. An alias inserted between them leaves the
persisted step-strip bit disagreeing with the step the reader was actually sent to.

Four operations also run twice per POST, which is the smaller half of the problem:

| Operation | First | Second |
|---|---|---|
| `requireDraft` | `columns.tsx:238` | `uploads.server.ts:328` (inside `saveMapping`) |
| `readCsv` over the same bytes | `columns.tsx:237` (`readDraftFile`) | `uploads.server.ts:330` |
| `parseStatement` | `columns.tsx:241` | `uploads.server.ts:331` |
| `unresolvedStrings` | `uploads.server.ts:336` | `columns.tsx:275` |

**The author already argued the premise.** `saveMapping`'s header:

> `had_first_sightings` is decided and written here too, because **this is the one moment the answer
> exists**: whether *this* mapping's parse raised any string no alias resolves.

If that is the one moment, the redirect decision belongs to it too. This is an *unfinished* argument,
not a re-litigation — the rarest and most actionable kind of finding in this codebase.

**Proposal.** `rememberMapping(draftId, mapping, rows, db) -> { nextStep }` or a field-keyed refusal.
`nextStep` plugs into the existing `DraftParse.step` vocabulary (`uploads.server.ts:365-375`), whose
doc already says "`step` names the earliest step still owed; `null` means none is."

Two things to preserve:
- The `requireDraft` re-check inside is a deliberate TOCTOU guard, named in the `@throws` doc. Keep it.
- A domain refusal currently sits in the route at `columns.tsx:260-266` ("no positions and nothing
  skipped means the instrument column is wrong"). Moving it inside makes it reachable by a test for
  the first time.

**Deletion test: passes.** Delete `rememberMapping` and the predicate splits across two files again.

**Corrections made during review:** the bytes are parsed **twice**, not three times — `columns.tsx:241`
parses already-split rows, not bytes. The route never names `hadFirstSightings`; it computes the same
predicate via `unresolvedStrings`. A companion `stageUpload(request)` was proposed and **dropped**
(see §4.4).

---

### 2.2 The chart-range primitives, once

**Rating: Strong.** Highest genuine call-count leverage on the list.
**Files:** `app/routes/overview.tsx:73-160`, `app/routes/account.tsx:77-135`,
`app/components/net-worth-chart.tsx:45,133`

`RANGES`, `RangeKey`, `DEFAULT_RANGE`, `DAY_MS` and `isoDate` (including its doc comment) are
byte-identical across `overview.tsx` and `account.tsx`; `SAMPLES` has the same value and a different
comment. `net-worth-chart.tsx` carries a **third** copy of `DAY_MS` (`:45`) and of `isoDate` (`:133`,
identical body, `string` return instead of `IsoDate`).

`export type IsoDate = string` is itself declared twice — `market-hours.ts:29` and
`valuation.server.ts:151`.

`account.tsx:70-76` already says what to do:

> That makes this a copy of the overview's sampler rather than an import … **and the pair should move
> into a shared module the next time either changes.**

Both have since changed.

**The drawability rule has drifted three ways.** `net-worth-chart.tsx:173` returns `null` when it
cannot draw — unstated in its type, so every caller independently predicts it:

| Site | Predicate |
|---|---|
| `net-worth-chart.tsx:173` | `all.length < 2` → returns `null` silently |
| `overview.tsx:390` | `computed.length + manual.length >= 2` |
| `account.tsx:454` | `computed.length >= 2 && last` — **stricter than the chart's own** |

With the chart's internal per-series guards (`:241`, `:249`, `:257`), Overview with one computed and
one manual point renders a dashed line only, under a caption describing it as the computed total.

**Proposal.** A `chart-range` module holding `RANGES`/`RangeKey`/`DEFAULT_RANGE`/`SAMPLES`/`DAY_MS`/
`isoDate`/`sampleWindow`. Separately, have the chart take a fallback node instead of returning `null`,
so drawability stops being three predictions of one rule.

**Do not share `windowDays`.** The two differ for a documented domain reason —
`account.tsx:118-123`: "The hand-typed pre-history plays no part, here or in the chart:
`manual_networth` is the household's net worth (§7), not an account's." Share the primitives, not the
policy.

**Correction made during review:** an earlier draft claimed `windowDays` had drifted in its return
type. It has not — both return `Promise<number>`. The `{since, dates}` vs dates-only difference is
between the differently-named `overview.tsx:123 sampleWindow` and `account.tsx:103 sampleDates`.

**Related, same area:** the "drop the uncovered samples" filter is byte-identical at
`overview.tsx:182-184` and `account.tsx:179-181`. `valuation.server.ts:552-559` states the invariant
("must not draw as a real zero") and then requires every caller to enforce it — a documented
obligation on callers *is* interface complexity. Consider moving the filter behind the read.

---

### 2.3 One `inTransaction`

**Rating: Strong.** Highest certainty on the list; roughly five minutes.
**Files:** `prices.server.ts:132`, `instrument-resolution.server.ts:256`, `uploads.server.ts:541`

Three byte-identical bodies, doc comment included:

```ts
function inTransaction<T>(
  db: Kysely<Database>,
  body: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.isTransaction ? body(db) : db.transaction().execute(body);
}
```

They form a documented copy-chain: `prices.server.ts:120-131` holds the real argument;
`instrument-resolution.server.ts:251-254` says "the same helper **`prices.server.ts`** carries, for the
same reason"; `uploads.server.ts:535-539` says "the same helper **`instrument-resolution.server.ts`**
carries, for the same reason." The author copied it twice and left a pointer each time. The comment is
the seam that should have been a module — and the pointers show the debt is being tracked, not
defended.

**Cost is zero.** All three already `import { getDb, type Database } from "./db.server.ts"`. Move it
there, change three imports, delete 18 lines. No new module, no new import edge.

**Caveat.** The `db.isTransaction` check is load-bearing for the rollback-per-test seam. Moving it is
safe; "simplifying" it away breaks every test.

By the deletion test this is a pass-through, so it is a chore rather than a deepening. It is listed
because it is free and certain.

---

### 2.4 One `labelOf`

**Rating: Strong but tiny.** 12 lines.
**Files:** `account-options.ts:60` (exported), `allocation.ts:168-173`, `holdings-view.ts:108-113`

All three bodies are character-for-character identical, and the two private copies share the same
one-line doc ("The label for a stored value, or the value itself if it has none."). Both modules
already import from `account-options.ts` — `holdings-view.ts:48` takes `ACCOUNT_KINDS`,
`TAX_TREATMENTS`, `type Option`; `allocation.ts:62` takes `ACCOUNT_KINDS`, `type Option`. They import
the data and re-declare the accessor.

Add `labelOf` to two existing import lines; delete 12 lines. No new import edge.

---

### 2.5 Two routes never render a form-level refusal

**Rating: Worth exploring. Latent, not live.**
**Files:** `settings/accounts.tsx:34`, `settings/account.tsx:48`, against the rule at `settings/tax.tsx:73-76`

Both return `error.fieldErrors` wholesale. `app/components/account-fields.tsx:43-46` renders only
`errors?.[name]` per named field — correctly; that is its job. So a refusal keyed `FORM_ERROR` would
land in the payload and render as **nothing**.

**The codebase already states the rule for exactly this case.** `settings/tax.tsx:73-76`, in an
identical position (flat schema, form-level unreachable), renders it anyway:

> A refusal that names no field would otherwise be a form that did nothing and said nothing. There is
> one field here, so this is **close to unreachable — which is exactly why it must not be the case
> that goes unrendered.**

**Currently unreachable.** `accountInput` (`accounts.server.ts:73-94`) is a flat `z.object` with no
top-level `refine`/`superRefine`; `createAccount:191` and `updateAccount:225` parse through it, and the
only hand-thrown refusal is `requireOwner` (`:290`), keyed `ownerId`. `parseInput`'s
`issue.path[0] ?? FORM_ERROR` fallback (`input.server.ts:110`) needs an issue with an empty path, which
needs a non-object `raw` — and `raw` is always `formFields()`'s `Record<string, string>`. One
`.superRefine` on that schema makes it live. Compare `people.server.ts:167`, which definitely produces one.

**Fix.** The same destructure plus one `.form-error` paragraph in each. Nothing changes in
`account-fields.tsx`.

---

### 2.6 A `<FieldError>` component

**Rating: Worth exploring.** ~15 sites.
**Files:** `account-fields.tsx:42` (`Error_`), `upload/instruments.tsx:144` (`fieldError`),
`upload/columns.tsx` (equivalent), plus ~12 inline copies

The identical block —

```tsx
errors?.[x] ? <p className="field-error" role="alert">{errors[x]}</p> : null
```

— appears about fifteen times, and three modules have each written their own local helper for it.
Purely presentational, so it crosses no `.server` line. This is the piece of the rejected "refusal
protocol" finding (§4.5) that has real leverage.

---

### 2.7 Rehome `fitsTheMoneyColumn` and the closed-account refusal

**Rating: Worth exploring.**
**Files:** `positions.server.ts:236`, `balances.server.ts:192-197`, `uploads.server.ts:894-901`

**First, the refactor that does *not* work.** `commitUpload`, `setBalance` and `revisePosition` look
like one module's behaviour spread across three, and they are not. What each computes genuinely
differs, and each carries a concurrency guard that cannot be lifted out — the draft-deletion-as-guard
(`uploads.server.ts:985-990`) and the `source` CTE that makes a changed account write nothing
(`positions.server.ts:350-360`, argued at `:41-44`). A `recordPositionSet(...)` general enough to host
all three needs a guard-SQL parameter: interface as large as implementation.

What *is* spread across three is the **precondition set**:

- **`fitsTheMoneyColumn` is homed by discovery order.** It is a schema fact — what `numeric(20,4)` can
  hold (`positions.server.ts:189-206`) — living in a module named after the single-position editor.
  `uploads.server.ts:56` imports it from there to guard bulk statement commits. It belongs beside
  `money.ts`.
- **Only two of the three writes call it.** `setBalance` does not, and is safe by an entirely
  different and **unstated** argument: `moneyMagnitude` caps at 12 integer digits
  (`input.server.ts:181`) and USD is priced at 1.0000, so the product cannot overflow. The function's
  own doc says "Two callers, both at the moment of a write" and never explains the third's exemption.
  A maintainer has to reconstruct it.
- **The closed-account refusal is written three times** in near-identical prose, two of them saying
  "in `setBalance`'s words".

---

### 2.8 `holdingsTable` — absorb the five array calls

**Rating: Worth exploring. Downgraded from Strong during review.**
**Files:** `app/lib/holdings-view.ts`, `app/routes/holdings.tsx:120-165`

**What survives.** `availableFilters(holdings, query)` and `applyFilters(holdings, query)` have the
**same signature** but must be called with different arrays — all holdings for the first
(`holdings-view.ts:465`, argued at `:33-42`), so the filter options do not vanish as you narrow. Swap
them and the screen still renders, wrongly, with no error anywhere. An interface that cannot
distinguish correct use from incorrect use is shallow.

`holdings.tsx` is also the highest-rework file in the repo — 1276+/206− across 9 commits, against
`holdings-view.ts`'s 793+/13−. The pieces are settled; the wiring is what keeps being rewritten.

**What review took away.** Four corrections, all material:

1. It is **five** calls downstream of the array, not eight. `parseQuery` (`:69`), `parseRowKey`
   (`:110-111`) and `toSearch` (`:113`) all run *before* the canonicalising `throw redirect` at
   `:118`, which runs before `currentHoldings()` at `:120`. They cannot merge — the redirect must fire
   before the query.
2. **`columns` cannot be in the return object.** `columnsFor` is consumed at `holdings.tsx:91`, 29
   lines before any holding exists, to decide whether to reset an unreachable sort. Putting it in
   `holdingsTable(holdings, query)` is a design error. Absorbing that rule means moving `COLUMNS`
   (`holdings.tsx:275-299`) into `holdings-view.ts` too — a real scope expansion.
3. **The "must not pre-sort the grouped branch" hazard is unreachable.** `holdings.tsx:161-164` are
   two arms of mutually exclusive ternaries on `query.group === null`. No caller can pre-sort the
   grouped branch, because that is the branch where `sortHoldings` is not called.
4. **The test surface is the cost.** Thirteen exports are imported directly by
   `tests/holdings-view.test.ts` (641 lines, 45 cases). The interface *is* the test surface, so this
   is either a real test rewrite, or you keep the exports and have **added** an interface rather than
   hidden one. Note also that collapsing costs the direct entry point to `sortHoldings`, whose doc
   (`:313-320`) names the exact reason it needs one: "**Absence is settled before the direction is
   applied** … Reversing them along with everything else … puts every holding nobody can price at the
   top of the page the moment someone sorts ascending."

**Verdict.** Worth doing *if* DESIGN.md §8.3's saved-view builder is genuinely next — it says the
Holdings table "is ~70% of this already", which would make the leverage real and amortise the test
rewrite. Today the payoff is locality alone, at one call site.

**Also stranded in `holdings.tsx`, and untestable:** `describe(filters)` (`:492-516`, three prose
outcomes), `Coverage` (`:1031-1068`), `columnsFor`/`firstDirection` (`:296-310`), `withRow`
(`:258-266`), `note()` (`:677-682`). Same in `analysis.tsx`: `ring()` (`:120-144`, the one place a
`stroke-dasharray` could go negative) and `isPositive` (`:88-90`).

---

### 2.9 The demo seed's write section

**Rating: Worth exploring. Downgraded from Strong during review.**
**Files:** `scripts/seed-demo.ts:801-1053`, `tests/support/fixtures.ts:8-10`

`fixtures.ts:8-10` declares itself:

> This is the one piece of test code allowed to know the schema. Everything else **in a test** knows
> only the domain and the query module, which is what keeps the tests honest about behaviour rather
> than about column names.

`scripts/seed-demo.ts` imports no `app/lib` module at all — only `server/config.ts`, `server/db.ts`,
`server/migrations.ts` — and writes 11 raw `insert into` statements. So `holding`, `quote` and
`account` each have three writers: the production module, `fixtures.ts`, and the seed. Add a column
and you edit three places; two of them fail late. `seed-demo.ts:736-745` also hand-maintains a
`WIPE` list in dependency order, with `USD`/`Cash` carve-outs encoding what migration 0001 seeds.

**Why this was downgraded.** The two writers are not the same operation. `makeFixtures` writes one row
per call so a test can say "an account with two holdings" in three lines. `seed-demo` holds a raw
`pg.PoolClient`, plans the whole id graph up front, and writes three years of daily closes in chunked
4,000-row `unnest` arrays (`:902-911`). Merging means teaching the fixture writer a bulk mode it
exists specifically not to have — **complexity relocated and grown, not concentrated**. That fails the
deletion test.

**Corrections made during review:** the write section is `seed(client, calendar)` at **801-1053 = 253
lines**, not the "~450" first claimed; perhaps 80 are genuinely shareable. The other ~1000 lines are
invented data, the calendar, the seeded price walk, the pristine guard and the report — none of which
duplicates anything. Ship-safety is a non-issue: `.dockerignore` excludes both `tests` and `scripts`.

**Narrower proposal.** Share the per-row inserts (person, classification, instrument, alias, account)
via `createDatabase(connectionString)` (`db.server.ts:43`, which exists precisely to hand Kysely to a
non-app process). Leave the bulk price walk alone. Note `seed-demo.ts:1038-1046` already does the
right thing once, computing the manual net-worth prefix by calling `holding_valued_at($3::date)`
rather than re-deriving it.

---

### 2.10 A pure `makeValuedHolding`

**Rating: Speculative.**
**Files:** `tests/holdings-view.test.ts:58-89`, `tests/allocation.test.ts:43-74`, `allocation.ts:257-258`

The two hand-built `ValuedHolding` factories differ in exactly **two string defaults**
(`accountName: "Taxable"` vs `"Account"`, `institution: "Fidelity"` vs `"Institution"`) plus one
doc sentence. Everything else, including the derive-`isPriced` tail, is byte-identical.

The interesting part is `allocation.ts:257-258`:

> A second module would also be a third copy of the twenty-field holding factory the tests build these
> from, **and this codebase has already watched one copied helper drift.**

That is a missing test fixture deciding where domain code is allowed to live — the tail wagging the
dog, and the one item on this list currently *preventing a refactor elsewhere*.

**Why still speculative.** Both test headers name the duplication as a deliberate choice — "unit tests
with a fixture function instead of a fixture builder" (`allocation.test.ts:5-6`), "unit tests over a
fixture function rather than a fixture builder" (`holdings-view.test.ts:8-9`). The proposal argues
against a stated position.

**Correction made during review:** `ValuedHolding` has **21** fields (`valuation.server.ts:46-79`).
The code comment saying "twenty-field" is itself off by one, and the first draft of this review said 22.

---

## 3. Suggested sequence

The candidates interact. If three are taken:

1. **§2.3 `inTransaction` and §2.4 `labelOf`** — minutes each, byte-identical duplication, cannot
   break anything. Do them first regardless of what else happens.
2. **§2.1 `rememberMapping`** — the correctness finding, small, and it finishes an argument already
   started.
3. **§2.2 chart-range primitives** — the largest genuine call-count leverage.

**§2.8 `holdingsTable` should go last** if at all. It is the one candidate that *conflicts*: it
rewrites the call shape of `groupHoldings`/`summarise`, and it wants `COLUMNS` moved at the same time.
Doing it after the others means it inherits a settled state instead of colliding with one.

---

## 4. Rejected findings

Recorded per this directory's stated purpose — "so a rejected option is not rediscovered later". In
almost every case the author had already argued the decision, and the finding was a re-litigation.
**Three of these five were initially rated Strong**, including two that were, at different points,
this review's top recommendation.

### 4.1 A renderer for the coverage sentence — REFUTED

Proposed on the claim that the "based on K of N holdings" sentence was written five times across the
dashboard routes while `Coverage` (`valuation.server.ts:88`) shipped as a type with no renderer, and
that two screens re-derived the counts by hand.

Both legs fail.

`holdings.tsx:1025-1029` is not a copy of a sentence; it is a component with four branches whose doc
pre-refutes the finding:

> **Three counts, not one, because they are genuinely three.** A workplace plan routinely reports a
> price and no cost basis at all, so the value total can be complete while the unrealized total is
> short … **Saying "40 of 42" once would have to pick one of those and misreport the others.**

And the two alleged re-derivations are the *opposite* of a mistake. Both carry the same justification:

- `overview.tsx:201-202` — "Summed from the same rollup the table renders, rather than counted
  separately — **two counts of one thing are two things that can disagree.**"
- `analysis.tsx:435-436` — "Counted off the rows already in hand rather than asked for separately —
  **two counts of one thing are two things that can disagree.**"

`analysis.tsx`'s loader deliberately discards the `Coverage` on `netWorth()` so its count matches the
array the three breakdowns were computed from.

Extracting the remaining variation would produce a component whose interface is
`{coverage, opener, tail, asFragment}` — as large as its body. Shallow; deletion test fails.

### 4.2 A shared `withAdvisoryLock` — REFUTED

Proposed because `price-poller.server.ts:101-134` and `server/migrations.ts:128,167` both take a
Postgres advisory lock. They share a shape and nothing else:

| | `price-poller.server.ts:104` | `migrations.ts:128` |
|---|---|---|
| Acquire | `pg_try_advisory_lock` — non-blocking, skip the tick | `pg_advisory_lock` — block and queue |
| On contention | silently skip | wait, then **re-read the ledger** |
| Release | inner `finally`, unguarded | outer `finally`, `.catch(() => {})` |
| Connection | `client.release(broken)` — **destroys** it | plain `client.release()` |

A shared helper needs key, try-vs-block, what-to-do-when-not-acquired, and connection-disposal policy:
four knobs for two callers.

It also **cannot live in `db.server.ts`**, which already imports `server/migrations.ts` (`:19`) — that
would be a cycle. And `server/db.ts:15-20` records that `server/` exists because `server/migrate.ts`
runs "from a runtime image that deliberately contains no source tree"; the migration runner cannot see
`app/` at all.

*Still true and unaddressed:* there is no `tests/price-poller.test.ts`. The tick/lock/release
discipline — especially the connection-poisoning rule at `:126-134` — is untested.

### 4.3 Unifying the zero-denominator share convention — REFUTED

Proposed because `allocation.ts:162` renders `"0.000000"` where `holdings-view.ts:652-655` renders
`null` for the same condition. Both are argued at length, in their own headers, in opposing prose:

- `allocation.ts:57-60` — "there is no base to be a fraction of and every share is `0.000000`. **That
  zero is not a claim that the slice is nothing**; the amount beside it says what it is."
- `holdings-view.ts:595-602` — "`null` in the two cases where there is no fraction to state rather
  than a fraction that happens to be zero … **Coercing either to `0.000000` would be the same
  null-as-zero this module refuses everywhere else.**"

They are also not symmetric. `AllocationSlice.amount` is never null; `HoldingsTotal.value` can be. So
`holdings-view` has **two** null conditions (`base === 0n` *and* `total.value === null`) where
`allocation` has one, and no analogue for the second. Unifying the share requires unifying
amount-nullability first — a much larger and probably wrong change.

The alleged workaround is also weak: `analysis.tsx:212`'s `hasRing` is `wedges.length > 0`, derived
from `ring(slices)` filtering on `isPositive(slice.share)`. It would exist unchanged under either
encoding.

### 4.4 `stageUpload(request)`, and a shared `figure()` — REFUTED

`stageUpload` was proposed to absorb the "check content-length before `formData()`" ordering at
`upload.tsx:48`. Against it: `refuseOversizedBody` has exactly **one** production caller (a
hypothetical seam, not a real one); it is directly unit-tested at `tests/upload-form.test.ts:104-122`,
and burying it destroys that entry point; `values = formFields(form)` is assigned *before*
`parseUploadForm` precisely so the catch block can re-render with the account choice intact. And
`uploads.server.ts`'s header already argues the split — its guards "live in `uploads.server.ts`, so
this action stays the same thin translation every other route is."

The `figure()` claim was simply wrong. `holdings-view.ts:554-555` is a local arrow const inside
`totalOf`; `allocation.ts:364-366` is a module-level declaration with an explicit return type. Same
logic, different construct and scope; the shared part is one expression.

### 4.5 A `refusal(error, values)` module — REFUTED

The largest single retraction in this review; it was the top recommendation for one round.

Proposed on two claims: that the justifying comment had been copy-pasted into six routes, and that
three incompatible spellings of the refusal protocol had emerged across ten route actions.

**The comment is one canonical argument plus back-references.** `settings/people.tsx:52-55` carries the
full version, including a sentence none of the others have ("The action is stripped from that bundle,
so this is the right side of the line"). `upload.tsx:61` then reads: "Split here, not in the component,
**for the reason people.tsx gives**". That is the documented-decision pattern, not a symptom.

**The second "spelling" is specified.** `holdings.tsx:827` reads `["form","quantity","costBasisPerShare"]`
as one ordered list rather than splitting `formError` out. `docs/design/holdings-ui-brief.md:637-639`
requires exactly that:

> **Or every refusal**, as `.field-error` paragraphs … **replacing** the note rather than sitting under
> it, **in a fixed order: the form-level one first, then Quantity, then Cost basis.**

The correlation is perfect: every route that splits `formError` renders `.form-error`; the two that
keep the key in the map render `.field-error`. Splitting there would work against the brief.

**The proposal also failed on its own terms.** Of ten action return shapes, only four fit
`{errors, formError, values}` exactly; two need spreads; four would have to change behaviour to adopt
it. It needs two modules (the `.server` split is real). And it fails the deletion test — delete
`refusal()` and one destructuring line goes back to six routes. Nothing concentrates.

The two salvageable pieces are recorded as §2.5 and §2.6.

---

## 5. Noted, not proposed

- **`app/root.tsx:223-227`** puts `error.message` from any non-`Response` throw straight into the page
  subtitle. That is Postgres error text on a user-facing page. Not an architecture finding; worth a fix.
- **Rank→colour has no home.** DESIGN.md §13.3's rule ("the same position means the same colour on
  every screen") is implemented twice with different clamps: `analysis.tsx:76-78` folds the tail,
  `overview.tsx:260` does not. Both comments assert the cross-screen invariant; neither can enforce it.
- **`ParsedStatement.asOfMapped`** (`statement.ts:162`, set at `:281`, returned at `:570`) has no
  consumer outside `statement.ts` and its test. Its doc says "so a screen must ask", but the review
  screen asks off `diff.asOf.source` instead. Dead interface surface.
- **Two float excursions in pricing.** `price-provider.server.ts:266-270` derives yield by float
  division; `:135` then converts a `toFixed(6)` string back through `Number()` for a range check —
  three conversions for one comparison. `input.server.ts:413` explicitly refuses that pattern
  ("Compared on the digits rather than through `Number(value) > 100`"). Two modules, two rules for one
  question.
- **`refusalOf` test helper** is duplicated verbatim in four test files (`upload-form.test.ts:29-37`,
  `upload-draft.test.ts:30-38`, `commit-upload.test.ts:50-58`, `instrument-resolution.test.ts:75-83`).
- **`tests/column-mapping.test.ts:54-63`**'s `plantAlias` inserts `instrument_alias` rows directly with
  a comment saying "The domain writer is step 04's resolution screen and does not exist yet." It does
  now (`resolveAll`). Stale justification.
- **`parseMappingForm`** (`column-mapping.server.ts:202-246`) — the only thing turning a real
  submission into a `StatementMapping` — has **no test**. Its `NOT_IN_FILE` sentinel, duplicate-column
  refusal (`:169-177`) and hidden-`headerRow` refusal (`:209-216`) are unexercised.
