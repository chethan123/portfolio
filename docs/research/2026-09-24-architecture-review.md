# Architecture review — deepening opportunities, second pass

*Reviewed 2026-09-24 against `8f0cf8f`. Thirteen candidates, eight smaller cuts, one reopened
refutation. The [archived visual report](2026-09-24-architecture-review/report.html) carries a
before/after diagram for every candidate; this document is the one to pick work up from.
Follow-up in [§7](#7-follow-up--25-september-2026-what-landed-within-a-day), 2026-09-25: three of
the seven Strong candidates landed within a day, and the cards below are kept as written.*

A second look for **deepening opportunities**, a month after the
[first](2026-08-23-architecture-review.md): places where a module's interface carries knowledge
its implementation could hold instead. The vocabulary is `.claude/skills/codebase-design/SKILL.md`'s:
**module**, **interface** (everything a caller must know: types, invariants, ordering, error modes,
what must be locked first), **depth** (leverage at the interface), **seam**, **adapter**,
**leverage** (what callers get), **locality** (what maintainers get). The **deletion test**: delete
the module, and if complexity vanishes it was a pass-through, if it reappears across N callers it
earned its keep. **The interface is the test surface**: a test that reaches past it says the module
is the wrong shape.

Nothing here is an approved slice. The first review's five refuted shapes (its §4.1–4.5) are not
re-proposed; one candidate reopens §4.5 and says which of its legs expired. Its accepted findings
§2.6 (`<FieldError>`), §2.8 (`holdingsTable`) and §2.10 (`makeValuedHolding`) have not landed, and
two of them appear below with what changed since.

## Method and its limits

- Scoped by `git log` hot spots over the last fifty commits. Ingest first: `app/lib/uploads.server.ts`
  is 2 420 lines, touched ten times, and the multi-account upload (#382, #383) landed the day before
  this review. Then pricing, the account lock (#329, #357, #351), and the chart (#353, #379).
- Four exploring agents (ingest; pricing; valuation, chart and screens; lock, masking and settings),
  each briefed with the authority documents for its area: ARCHITECTURE.md's sections, CONTEXT.md, the
  ADRs, and the first review's rejected findings. Then one adversarial grounding pass over this
  document, re-verifying every `file:line`, count and duplicate it names against the source.
- Fifteen ADRs and a glossary exist now, unlike in August. No candidate reverses an ADR. Each card
  says which ADR it touches and why it is not a reversal.
- Route bodies are testable only as far as they export (§9.3 of ARCHITECTURE.md): the suite calls
  loaders and actions directly and renders route components through `tests/support/render.tsx`, so
  a helper left unexported in a route body is reachable only through a full request. Several
  candidates lean on that standing constraint.
- Line numbers were the weakest part of the first draft, as in August. The grounding pass checked
  about four hundred `file:line` references and corrected seventy-three: most by a few lines, a few
  of substance (the suite is no longer mock-free, route components are rendered in tests, only one
  of the poller's two log stems is pinned). All are folded in below.
- Counts and line numbers describe `8f0cf8f`. They will drift; the shape of each finding will not.

---

## 1. What is already deep — still true, plus what shipped since

The first review's §1 table holds. Additions worth naming, because a candidate below leans on each:

| Module | Why it earns its keep |
|---|---|
| `withAccountLock` / `withAccountLocks` (`accounts.server.ts:151-189`) | The one door onto an account's history, `select … for no key update` on the bare row, ascending `compareIds` order for several. Every writer of `position_set` runs inside it (§7.2). Candidate 2.1 keeps it exactly where it is. |
| `resolveAll` (`instrument-resolution.server.ts:225`) and `routeStatement` (`statement-routing.server.ts:75`) | Validate-then-write behind one call; a pure matcher with a closed taxonomy. Candidate 2.8 is about who *interprets* the taxonomy, not the matcher. |
| `createWorkerHealthProbe` (`worker-reachability.server.ts:85-110`) | Builds an instance whose `check(now)` takes the clock as a parameter; one pinned `workerHealthProbe`. The shape candidate 2.3 asks the poller to copy. |
| `socket-transport.server.ts` | Two callers (`ask`, the health probe), one settle-once guard. Spec 0021 rejected hand-copying it. |
| `chart-series.server.ts` | 89 lines, two callers, the one site of the `coverage.total > 0` rule (spec 0015). Candidate 2.6 deepens *above* it. |
| `tests/support/webauthn.ts` | Signs real assertions; WebAuthn is never mocked server-side. Candidate 2.11 leaves it alone. |
| The trailing `db` parameter | Unchanged since August; do not let it be "modernised". August's "zero mocks" no longer holds: nineteen test files use `vi.mock`, `vi.spyOn` or `vi.fn`, three of them cited in 2.3 and 2.11 as tests past the interface. |

---

## 2. Candidates

Ranked by friction removed. Each card names the dependency category the deepening skill uses to say
how the deepened module is tested across its seam: **in-process** (pure), **local-substitutable**
(Postgres inside the test transaction), **ports & adapters** (the worker over the socket), **mock**
(Yahoo).

### 2.1 One commit over N routed sections; a chosen account is a routing of one

> **Landed 2026-09-24** in #385 (`91216ad`), as [spec 0024](../specs/0024-one-commit-over-routed-sections.md). Kept as written; §7 has what shipped and what it decided.

**Rating: Strong.** Local-substitutable. Ingest.
**Files:** `app/lib/uploads.server.ts` — `commitUploadUnderLock` (`:1704-1836`) against
`commitMultiAccountUnderLocks` (`:1861-1973`); `assembleDiff` (`:1371-1448`) against
`assembleMultiDiff` (`:1453-1578`); `UploadDiff.accounts: AccountDiff[] | null` (`:939`).
`app/routes/upload/review.tsx` — two render branches (`:655-748`, `:750-794`) over the same
`Comparison` and `DiffTable`.

**The problem.** The single-account and multi-account commits are two near-copies above a seam that
is already shared: `compareAccount` (`:1109`), `reasonsToRefuse` (`:2146`), `insertStatement`
(`:2058`), `promoteAnswers`, `verifyVocabulary` and `deleteDraft` (`:1978-2056`). The duplicated
orchestration, pairwise: lock and re-read the draft (`:1711` / `:1867`); the closed refusal (`:1716`
/ `:1871`); assemble, then `refuseStaleReview` with a closure that re-runs the whole assemble to
reproduce a hash (`:1729-1753` / `:1874-1903`); the `boundedNumber` refusal (`:1788-1794` / `:1918-1924`);
`recordAccountNumber` with a refuse closure (`:1797-1804` and `:1819-1821` / `:1936-1949`); `reasonsToRefuse` (`:1810` / `:1930`); the `CommittedUpload` counts literal, identical but for `diff.` against `section.` (`:1823-1835` / `:1958-1970`).
In the assemblers: the review-revision hash written twice with different recipes (v3 at
`:1396-1418` folds `accountId` and the append watermark in; v4 at `:1519-1534` folds the bound
sections in), and the `UploadDiff` literal twice (`:1421-1448` / `:1540-1577`), the second filling
eleven figure fields with `[]`, `0`, `false` and `null` (`:1548-1568`) and four header fields with
`null`, because the type is the single path's. The genuinely
single-path behaviour is about fifty lines: the two-numbers-in-one-file refusal (`:1755-1769`), the
recorded-number guard (`:1771-1785`), capture from the file (`:1787-1808`).

**Drift is already visible.** The single path reads `numberHolder` ahead of the confirmations (`:1805-1808`) while the multi path lets the unique index alone decide, after `promoteAnswers`
(`:1934-1949`). The single path checks the posted `accountId` (`:1719-1724`); the multi path always
posts `""` (`review.tsx:738`). The multi path names a moved account through a separately posted
`appendWatermark-<id>` (`:1888-1894`) that is also inside its hash; the single path only through
the hash.

**Deletion test.** Delete the single path: the multi path needs the fifty-line guard and n = 1.
Delete the multi path: everything but that guard reappears. Two near-copies, not two adapters.

**What would change.** The assembler and the commit take a list of groups (account, positions,
combined rows, skipped rows, as-of date, answered number). A chosen-account draft yields one group
from its guard, so `accounts` is always an array, there is one hash recipe over sections, the
single-account review renders one section, and `recordUpload` returns `CommittedUpload[]` with the
route picking the landing page from the draft rather than a union tag. `withAccountLock` and
`withAccountLocks` stay exactly where they are.

**Tests.** Today two encoders of one binding (`tests/commit-upload.test.ts:96-114`,
`tests/multi-account-upload.test.ts:111-122`), three `written.multiAccount ?` ternaries and one
`if (!written.multiAccount) throw` guard in the latter, and shape assertions that pin the split ("a
single-account draft carries no groups", `tests/routes/upload-wizard.test.ts:1302`; `accountId: null …
added: []` on a multi-account diff, `tests/upload-draft.test.ts:226-227`).
After: one staging helper, assertions on sections.

**ADR.** None. ADR-0015 fixes behaviour (the number is a guard on one path, a selector on the
other), not code shape; the guard becomes the one-group adapter's own rule.

### 2.2 A review-binding module: draw it, post it, verify it

> **Half landed 2026-09-24** with 2.1: the *draw* half is `app/lib/review-form.ts`. The *verify* half remains and is smaller now; §7 re-rates it Worth exploring.

**Rating: Strong.** In-process for the comparison; the reproduce-at-reviewed-date closure stays
local-substitutable. Ingest. Falls out of 2.1, since one hash over sections is most of it.
**Files:** `uploads.server.ts` — the two hash recipes (`:1396-1418`, `:1519-1534`),
`appendWatermark` (`:1343`), `refuseStaleReview` (`:1681`) and its closures (`:1751-1752`, `:1899-1901`),
`baselineMoved` (`:2127`, called `:1914`, `:2157`), `CommitInput`'s key scheme (`:1605-1620`), the reason ordering (`refuseStaleReview` at `:1688-1701`, rerouted `:1883-1886`, watermark `:1889-1894`, baseline `:1914`, ticks voided at `:2197-2202`), and `""` as null's wire form explained at `:900` and `:1618`.
`review.tsx` — hidden inputs (`:715-742`, `:779-786`), `withoutTicks` (`:91-95`), `resetKey`
(`:639`), the same `""` explained a third time (`:780`).

**The problem.** "Is this commit still authorised" is nine sites in two files. The wire encoding is
in the route, and the ordering of refusal reasons (revision, then rerouted, then watermark, then
baseline, with ticks voided by a moved baseline) is readable only by walking both commit paths. The
interface is the test surface, and it fails: three test files each hand-write the diff-to-form
encoding (`commit-upload.test.ts:96-114`, `multi-account-upload.test.ts:111-122`,
`tests/journeys/dated-upload-baseline-orderings.test.ts:59-61`), and
`tests/dated-upload-baseline-review.test.ts:121, :147-149, :212, :233-235` re-encodes `?? ""` by hand. The
reason ordering is reachable only through a whole commit against Postgres
(`multi-account-upload.test.ts:508-540`, `orderings:266-336`).

**Deletion test.** Delete the scattered pieces and the compare-and-set reappears in both commit
paths and the route. Earning its keep, wrong shape.

**What would change.** `bindReview(diff)` returns the fields the form renders as hidden inputs;
`verifyBinding(posted, fresh, reproduceAt)` returns ok or `stale { reason, moved }`. The route
renders fields it does not interpret. Tests reuse `bindReview`'s output as the fixture, and the
reason ordering becomes a table test with no database.

**ADR.** None.

### 2.3 The poller as a built instance, not module functions over a `globalThis` bag

> **Landed 2026-09-24** in #386 (`231a92b`), as [spec 0025](../specs/0025-the-poller-as-a-built-instance.md). Kept as written; §7 has what shipped.

**Rating: Strong.** In-process (clock, timer) plus local-substitutable. Pricing. Independent of
everything else here; the cheapest Strong.
**Files:** `app/lib/price-poller.server.ts` — `SLOT` (`:26`); `tick` (`:73-137`) with `new Date()`
at `:59`, `:77`, `:88`, `getConfig()` at `:85`, `readRefreshCadence()` at `:94`, `runRefresh` at
`:101`; `startPricePoller` (`:165`), `requestRefresh` (`:200`), `readPollerSnapshot` (`:222`),
`stopPricePoller` (`:235`). `tests/price-poller.test.ts` — fake `Date`/`setInterval` eight times plus one `setSystemTime`;
`watchedPool` (`:94-127`) patching `pool.connect` and `client.release` to learn that a tick ended;
`tickFinished` (`:131`); `waitFor` (`:552-559`); a direct `Symbol.for("portfolio.pricePoller")`
poke (`:828-830`); `vi.spyOn` on `socketProvider` (`:799`, `:822-823`). Three test files call
`stopPricePoller()` in `afterEach`, and `tests/price-poller.test.ts` calls it fifteen times in
`finally` blocks, because the slot is process-wide.

**The problem.** Every export starts by reading the slot (`:166`, `:201`, `:223`, `:237`; `retime` too, `:68`).
`tick` has five ambient dependencies and returns nothing observable (`void tick(...)` at `:56`,
`:212`), so its tests reach past the interface on four axes: timers, the pool, the symbol, module
spies. `readPollerSnapshot` exists to hand out a defensive copy of mutable global state.

**Deletion test.** The `globalThis` pin earns its keep (Vite HMR, `:25`, `:245`; §6.2's hazards
table). The module-functions-over-a-global shape does not: `createWorkerHealthProbe()`
(`worker-reachability.server.ts:85-110`) already solves the same problem the other way, an instance whose `check(now)` takes the clock as a parameter, and one pinned singleton. The poller is the odd one out in its own slice.

**What would change.** `createPricePoller({ provider, clock, readCadence, refresh })` returns
`{ start, stop, requestRefresh, tick(): Promise<void>, snapshot }`; `startPricePoller()` builds one
and pins it, keeping the idempotent guard and the `retime` identity check. The `tick` promise is the
completion signal. Spec price-health/03 forbids "a second global"; a factory plus one pinned instance
is still one.

**Tests.** After: `await poller.tick()` with a fake clock and provider. The connection-poisoning
test keeps `watchedPool` (a genuine pool property) but awaits the tick instead of counting handbacks.
The three `afterEach` hooks and the fifteen `finally` calls go. Keep the log lines out of the blast radius: `docs/operating.md:1121-1127`
fixes the `Price refresh` / `Price backfill` stems; `tests/price-poller.test.ts:450, :484-486` pins
`Price backfill`, and nothing yet pins `Price refresh`.

**ADR.** None.

### 2.4 `refreshPrices`: drop the mode flag's overloads, take `now`

> **Landed 2026-09-24** in #387 (`ec03f55`), as [spec 0026](../specs/0026-refresh-prices-takes-now.md). Kept as written; §7 has what shipped.

**Rating: Strong.** In-process. Pricing.
**Files:** `app/lib/prices.server.ts` — `refreshPrices` overloads (`:394-411`); `new Date()` inside
the writer at `:298` (the backfill's `until`), `:309` and `:462` (`startedAt`), `:606` (the ±7-day
window). `app/lib/refresh.server.ts` — `RefreshRun` (`:35-38`), `RunWithQuotes` (`:41-44`, a
hand-narrowed copy), `runRefresh` overloads (`:54-65`), `outcomeOf` (`:80-92`). The clock faking it
forces: `tests/refresh-quotes.test.ts` `withClockNear` (`:52-59`), `tests/price-backfill.test.ts` three times plus one `setSystemTime`, `tests/routes/refresh.test.ts:86-91` computing fixture dates relative to real `now`
because "a fixed-past fixture would age out of range".

**The problem.** `{ quotes: boolean }` selects between two behaviours, and to let `outcomeOf` avoid
a null branch the distinction is restated as two overloads on `refreshPrices`, two on `runRefresh`
and `RunWithQuotes`: four declarations to learn one fact. Separately, "today" is read off the wall
clock inside the writer, so three test files fake `Date`. `price-health.ts` (`:82-86`) and
`createWorkerHealthProbe.check(now)` already take `now` as a parameter; the writer is the one
pricing module that does not.

**Deletion test.** Delete the overloads: nothing vanishes but a type narrowing; `outcomeOf` gains one
`null` branch. Delete `runRefresh` itself: the lock and the never-throw mapping reappear in the
poller and the route, so it stays.

**What would change.** One entry whose result names the null case (`quotes: RefreshReport | null`,
`outcomeOf` owning it), and `now` alongside `marketTimeZone` on `refreshPrices`, `refreshQuotes`
and `backfillCloses`; `runRefresh` passes `new Date()`, the poller (2.3) passes its clock. No global
`Date` faking in the writer's tests; fixtures stop ageing out.

**ADR.** None. ADR-0011 fixes what the batch writes, not how "today" is obtained.

### 2.5 Deepen the refusal round trip

**Rating: Strong.** In-process. Every form. **Reopens the first review's §4.5**; see the end of this
card.
**Files:** `app/lib/input.server.ts` owns the type (`ValidationError`, `FORM_ERROR`, `parseInput`,
`:14-32`, `:65-89`) and nothing owns the round trip. The copies at `8f0cf8f`:

- `formFields(await request.formData())` — 15 route sites.
- `instanceof ValidationError` — 16 route sites.
- `const { [FORM_ERROR]: formError, ...fieldErrors } = error.fieldErrors` — 11 sites, and its
  justifying comment ("Split here, not in the component — `FORM_ERROR`'s `.server` module can't
  reach the client bundle") copied near-verbatim at ten of them: `settings/people.tsx:40`,
  `tax.tsx:31`, `prices.tsx:36`, `display.tsx:51`, `instruments.tsx:43`, `upload.tsx:59`,
  `upload/columns.tsx:242`, `upload/accounts.tsx:66`, `upload/instruments.tsx:108`,
  `upload/review.tsx:146`.
- Three payload spellings for the same error: the split (11 sites in 10 files); wholesale
  `error.fieldErrors` (`settings/accounts.tsx:36`, `settings/account.tsx:47`, `holdings.tsx:203`,
  `account.tsx:172`); joined `error.message` (`settings/passkeys.tsx:165`).
- `<p className="field-error" role="alert">` — 21 sites in 14 files; `<p className="form-error"
  role="alert">` — 21 sites in 15 files, one of them (`unlock.tsx:301`) with the role on the
  wrapping `div`. Two files already wrote a local helper for it
  (`account-fields.tsx:28`, `upload/instruments.tsx:124`).

§11.3's "two settings routes never render a form-level refusal" is the wholesale spelling: `AccountFields`
renders only `errors?.[name]` (`account-fields.tsx:29`), so a `form`-keyed refusal lands nowhere. It
is still live, and it exists because there is no single place to fix it.

**Deletion test.** Delete the split line: eleven destructures reappear. Delete one refusal paragraph:
forty-two reappear. Both earn their keep.

**What would change.** A server-side `refused(error, values)` beside `parseInput`, returning
`{ errors, formError, values }` that actions spread their own fields onto (`intent`, `personId`,
`saved`, `preview`, `applied`), and a browser-safe `<FieldError>` / `<FormError>` pair in
`app/components`. Routes import less, still never touch Zod or state a rule (§4.1 kept), and the next
settings tab does not copy thirty lines. `holdings.tsx:940` keeps its brief-mandated fixed order
(form first, then Quantity, then Cost basis) and still uses the element. The `refusalOf` test
helper, duplicated in sixteen test files, moves to `tests/support`.

**Tests.** Today `tests/routes/settings-tax.test.tsx:16-24` builds a Request plus FormData to assert
one paragraph's `id` / `aria-describedby` shape. After: the shape is asserted once against the
element; route tests assert placement only.

**Why this reopens §4.5.** The first review refuted a `refusal()` module on four legs. Two have
expired: "one canonical comment plus back-references" is now ten near-verbatim copies, and "one
destructuring line goes back to six routes" is eleven. Two still stand and are honoured above:
`holdings.tsx`'s fixed-order rendering keeps its own order, and heterogeneous action payloads spread
their extension fields rather than being forced into one shape. §2.6's `<FieldError>` was accepted
then and has not landed; its count has grown from "roughly fifteen" to forty-two.

### 2.6 One chart entry, one tier discriminant, the manual-prefix rule as a pure function

**Rating: Strong.** In-process for `chart-range.ts`; local-substitutable for the seam. Read path.
**Files:** `app/routes/overview.tsx:76-124` and `app/routes/account.tsx:78-97` — `chartReach` →
build `earliest` → `chartWindow(surface, { request, today, earliest, session, timeZone })` →
`chartSeries(scope, resolved)` → spread `controls`, about fifteen lines each, wired by hand twice.
`app/lib/chart-range.ts` — `RangeWindow.session?` / `.grain?` (`:44-57`), the `SessionAxis` mirror
(`:71-75`), probes at `:81` and `:387-391`. `app/lib/chart-series.server.ts` — probes at `:55-56`,
`:66-67`; reads `MARKET_TIMEZONE` again at `:60`, `:71`. `app/components/net-worth-chart.tsx` —
probes at `:91`, `:106`, `:244`, `:262`, `:471`; `all.length < 2 → null` at `:312`, predicted at `overview.tsx:389`
and, stricter, `account.tsx:340`. DESIGN.md §7's rules 2–3 (computed wins on overlap, prefix withheld
while narrowed) as a loader-body array filter: `reachable` (`overview.tsx:85`), `earliest.manual`
(`:88`), `manualPrefix` (`:112-122`), `manualWithheld` (`:137-140`), with eight Postgres-seeded
loader tests (`tests/routes/overview.test.ts:152, 227, 297, 363, 494, 514, 883, 984`).

**The problem.** The tier (dated, session, grained) is decided once in `resolveRange` but encoded as
two optional fields, so every hop re-derives it: at least eight presence tests of
`session !== null && !session.grained` or `session === null || point.dated` across four modules.
`surface` crosses twice per route and the timezone twice per chart. A DESIGN §7 rule whose inputs
are two arrays, a window and an axis is tested through seeded loaders. Drawability is predicted in
two routes for a chart that decides it itself; the first review's §2.2 named this and
`ChartEmptyNote` was added, but the predicate stayed per route.

**Deletion test.** Delete `chart-series.server.ts`: the reader dispatch and the coverage rule
reappear in both routes, so it stays (two callers, a real seam). Delete the route-side composition:
it reappears identically in two routes. Pass-through.

**What would change.** One entry, `chart(scope, request, { today, manual? })`, returning
`{ resolved, controls, points }`, so a route names the scope once and the timezone never.
`RangeWindow` and `SessionAxis` carry `tier: "dated" | "session" | "grained"` instead of two
optionals, so each hop switches rather than probes. The manual-prefix filter moves beside `dayOf` in
`chart-range.ts` as a pure function; the chart takes a fallback node instead of returning `null`.
`tests/chart-range.test.ts:599-700` pins the controls block and gains the discriminant; the eight
loader tests become array-level unit tests.

**ADR.** None. ADR-0003, 0004 and 0014 are untouched. ADR-0008's `reading` stays a required field of
`ChartScope`, the shape §6.3 already blesses.

### 2.7 Valuation's surface × time matrix: two dead exports, one twin, twelve predicate-only variants

**Rating: Strong for step one, Worth exploring for step two.** Local-substitutable. Read path.
**Files:** `app/lib/valuation.server.ts` — 19 exported functions; the `ValuedSource` seam (`:103-110`); the
household/account pairs at `:155-187`, `:247-341`, `:381-397`, `:538-553`, `:685-706`, `:770-802`.

**The problem.** Twelve exports are household/account pairs over five private helpers, where the pair
members differ in exactly one predicate, `ownedBy("x.owner_id", filter)` against
`isAccount("x.account_id", id)`, three to eight lines each: `readHoldings` ×4 (`:155`, `:171`,
`:325`, `:335`), `readTotal` ×2 (`:162`, `:180`), `readSeries` ×2 (`:381`, `:390`),
`readSessionSeries` ×2 (`:538`, `:547`), `readGrainedSeries` ×2 (`:685`, `:697`), plus
`firstRecordedDate` / `accountFirstRecordedDate` (`:770`, `:791`). Evidence the matrix outran demand:

- `holdingsAt` (`:171`) and `netWorthAt` (`:180`) have **zero production callers** (grep over `app`,
  `server`, `scripts`). They are held up by eight test files: `tests/holdings-at.test.ts` (thirty calls),
  `tests/valuation-owner-filter.test.ts`, the invariant suite's oracle, and one-off oracle reads in
  `accounts`, `revise-position`, `grained-series`, `dated-upload-baseline-review` and
  `journeys/dated-upload-baseline`.
- `accountTotal` (`:290-322`) and `accountTotals` (`:247-287`) are hand-written twins: the
  `selectFrom` / `innerJoin` / `leftJoin` / nine-column `select` block is identical (`:254-267` against
  `:295-308`), as is the `groupBy` (`:272-279` / `:311-318`), and `tests/account-queries.test.ts:21-70` exists to assert that they agree, the test a
  duplicate buys.
- `chart-series.server.ts:26-28` already invented the union this module lacks
  (`ChartScope = { surface: "household", reading } | { surface: "account", accountId }`) and then
  unpacks it back into the pairs.

Five SQL shapes are five genuine behaviours (the view, the as-of function, the dated lateral, the
running total, the grained union). The ×2 surface and ×2 now/at is the shallow part. §6.3's "four
narrowing shapes" hazard is real, but it is a per-helper fact, spelled today at two exports per helper.

**Deletion test.** Fold `accountTotal` into `accountTotals` with an account narrowing: about
twenty-five lines vanish and the agreement test becomes redundant by construction. Delete the two
dead exports: nothing outside tests moves. Replace each pair with `x(scope, …)`: the predicate
wiring vanishes, the helpers stay.

**What would change.** Step one: delete `holdingsAt` and `netWorthAt` (or keep one as the documented
oracle), fold `accountTotal` into `accountTotals`. Step two: promote `ChartScope` to valuation's own
`Scope`, each helper computing its narrowing from the scope beside its SQL, one place per shape
instead of two; exports drop from 19 to about 11. `tests/holdings-at.test.ts` (586 lines) states
`holding_valued_at`'s rules through the dead exports and would restate them through
`accountHoldingsAt` or `netWorthSeries([d])`.

**ADR.** ADR-0008 wants the filter visible in review; a required `reading` inside a required `Scope`
is the shape §6.3 already accepts for the chart's four reads. Not a reversal.

### 2.8 The router owns which step its problems belong to; one draft read per request

**Rating: Worth exploring.** In-process. Ingest.
**Files:** `app/lib/statement-routing.server.ts` emits seven `RoutingProblem` kinds (`:47-59`).
`app/lib/uploads.server.ts` interprets them in four places: `refusalsByStep` (`:369-382`, which
kinds "ask again"), `stepOf` (`:548-556`, rebuilding `unanswered` from problems), `accountsScreen`
(`:704-709`, a stale map by hand), `answerAccountNumbers` (`:795-808`, `as-of` and
`nothing-to-record` re-filtered under a comment about which step owns them). `numberQuestions`
(`:677-690`) is a third reader of `readDraft` beside `parseDraft` (`:574`) and `accountsScreen`
(`:692`).

**The problem.** A leak across the seam: the router's taxonomy is the router's knowledge, and its
step ownership lives next door. And re-derivation per request: an accounts POST parses and routes
three times (`numberQuestions` at `:744`, the trial route at `:797`, `parseDraft` at `:849`); an
instruments GET calls `unresolvedStrings` twice (`stepOf` at `:562`, then `resolutionScreen` at
`instrument-resolution.server.ts:109`); the columns loader reads the CSV twice (`columns.tsx:55` via
its own `readDraftFile`, then `parseDraft` at `columns.tsx:81`) and its action twice more. The
first review's §2.1 moved the redirect decision, but its "parsed twice" table still holds. The
stale-form guard lives in the route for instruments (`instruments.tsx:89-96`) and in the domain for
accounts (`uploads.server.ts:748-753`).

**Deletion test.** Delete `refusalsByStep` and the "asks again" predicate reappears in three
callers. It earns its keep, in the wrong module.

**What would change.** `routeStatement` returns a step-shaped result (columns problems, or accounts
questions, or routed groups), building `AccountQuestion` (`:636-643`) from the `firstRow`,
`unknownNumbers` and `skipped` it already holds. `readDraft` becomes the one read a screen takes its
result from; `DraftParse`'s arms then come from one place. `tests/statement-routing.test.ts:93-240`
covers the kinds; the step mapping, pinned today only through `tests/routes/upload-accounts.test.ts:185-372`,
moves into the pure test.

**ADR.** None; "asked once, never guessed" (ADR-0015) is unchanged.

### 2.9 A `resumeAt` translator for the wizard's step machine

**Rating: Worth exploring.** Local-substitutable. Ingest, route side.
**Files:** `uploads.server.ts` — `parseDraft` (`:574-581`) decides the step; `DraftNotReadyError`
(`:621-632`) carries "blocked" as an exception payload; `instrumentsStepSkipped` (`:595-597`) is
restated in `accounts.tsx:42` and `instruments.tsx:59`. Across `app/routes/upload/`: step-to-redirect translated at nine sites; `?stale=true` carried by hand at twelve (`columns.tsx:180, 217`;
`accounts.tsx:29-30, 59`; `instruments.tsx:40-41, 75`; `review.tsx:60, 82, 163, 188`); `NotFoundError` to 404 at ten; the `steps` literal built six times (`columns.tsx:153-158`, `accounts.tsx:39-44`,
`instruments.tsx:56-61`, `review.tsx:51-56, 68-73`, `upload.tsx:86`); the blocked-or-redirect branch
three times in `review.tsx` alone (`:65-83`, `:159-165`, `:184-190`). Four spellings of the draft
header: `UploadDraft` (`:85-99`), `BlockedDraft` (`:583-593`), `UploadDiff` (`:925-940`),
`columns.tsx:159-165`.

**The problem.** Forgetting one stale carry silently drops the "review went stale" warning; nothing
fails. `tests/routes/upload-wizard.test.ts:1-4` admits `parseDraft` "has no test of its own; the
matrix below pins it": 1 587 lines of route tests standing in for a state-machine test.

**Deletion test.** Delete a `resumeAt(draft, step, url)` and the stale / 404 / redirect trio
reappears in five files.

**What would change.** `parseDraft` returns header plus step, with `blocked` as an arm rather than an
exception payload; one route-side translator in `upload/draft.tsx` builds every redirect with stale
carried, and the `steps` literal once from the header. `parseDraft` gets its own table test.

**Not a re-litigation of §4.5.** The first review refuted an app-wide refusal module. This is one
folder, one draft, one query parameter, and a rule that fails silently.

### 2.10 `holdingsTable`: five calls became eight, and masking is threaded four times

**Rating: Worth exploring.** In-process. Read path. **Accepted as §2.8 in August, not landed.**
**Files:** `app/routes/holdings.tsx` loader (`:76-173`, 98 lines, about 45 of composition):
`availableFilters(household, q)` / `applyFilters(visible, q)` (`:113-114`, same signature, different
arrays, the August hazard, still live); `groupHoldings` or `sortHoldings` (`:127-131`); `summarise`
(`:132`); `projectGroup` / `projectHolding` / `projectTotal` (`:151-153`) each taking
`amountsAvailable`; a fourth hand-masking at `:165` (`written.quantity`). Stranded in the route body
and untestable there: sort-reset (`:80-84`), `columnsFor` / `firstDirection` (`:264-274`), `describe`
(`:444-481`, 38 lines of prose rules), `hiddenFields` (`:512-525`, a copy of `toSearch`'s loop at
`holdings-view.ts:284-291`), `Coverage` (`:1025-1059`). `holdings-view.ts` exports 19 values;
`holdings.tsx` imports 21 names (`:28-50`).

**Deletion test.** Delete the module: the dimension registry reappears in Holdings, Analysis
(`analysis.tsx:160-163`) and Income (`income.tsx:67-68`), so it earns its keep as a registry. Delete
the loader's composition: it reappears once. A deep registry under a toolbox interface.

**What would change.** `holdingsTable(household, visible, query, { available })` returning filters,
rows-or-groups, total and counts, with named parameters so the array mix-up is a type error, and
masking applied once inside. `COLUMNS` and `columnsFor` move with it. `describe` cannot move yet: it
imports `UNREADABLE_OWNER` and `holdsNothing` from `owner-filter-control.tsx:130-136`; lift those
fragments to a lib first. The registry exports stay for the other two screens, and
`tests/holdings-view.test.ts`'s rule tests stay; one composition test replaces the loader-level
sort-reset and filter-building route tests (`tests/routes/holdings.test.ts:71, 191`).

**What changed since August.** Three of its four corrections hold as written; the first's count (five, not
eight) is now eight, though its reason, that the three calls before the canonicalising redirect
cannot merge, still stands. §2.2 (the chart-range primitives) has landed. August's sequencing note,
`holdingsTable` last because it rewrites `groupHoldings` and `summarise`'s call shape and moves
`COLUMNS`, still applies. §11.4's count is stale.

### 2.11 Admission, and the grant a browser is left holding

**Rating: Worth exploring.** Local-substitutable. The lock.
**Files:** `app/lib/lock.server.ts` — the ceremony entries are narrow and deep (`:401-421`,
`:506-512`, `:569-594`, `:632-740`, `:747-789`); the grant-and-cookie primitives are wide and shallow: `readLockCookie`, `lockCookie`,
`clearedLockCookie`, `isLocked`, `readGrant`, `touchGrant`, `deleteGrant` (`:64-69`, `:89-102`,
`:163-213`); `signerIsRemovalTarget` (`:500-503`); the passkey delete whose cascade takes the grant
(`:782`). `app/root.tsx:145-171` —
cookie → `isLocked` → `touchGrant` → clear-or-not, two fail-closed `try/catch` branches; it imports
four names (`:32`) and asks two. `app/routes/unlock.tsx:31-50` — cookie → `isLocked` → `readGrant`,
failing open (argued at `:25-26`); `supersedes: readLockCookie(request)` at `:75`.
`app/routes/settings/passkeys.tsx:133-158` — 26 lines: two extra `readGrant` reads and a three-way
cookie choice after `removePasskey`; `supersedes` at `:112`, `:140`. `Set-Cookie` built at nine
sites.

**The problem.** The composition is the rule, and it lives in three routes. "Is this browser
admitted" is spelled twice with different fail directions. "Which grant is this browser left holding
after a removal" is 26 lines of route detecting a row the module already knows it deleted
(`lock.server.ts:500-503` computes `signerIsRemovalTarget`, then returns a grant the passkey delete
at `:782` cascades away). `supersedes` is threaded from three call sites under an invariant the module states
("never a form field", `:124-125`) but only callers uphold.

**Deletion test.** The primitives pass through by count only if the composition also moves; deleting
them today scatters cookie parsing into four routes. The finding is the composition.

**What would change.** One admission reader (request → `{ locked, grant, clearCookie }`) serving
`root.tsx` and `unlock.tsx`, with the fail direction a caller argument, the one thing that genuinely
differs. `removePasskey` returns the grant this browser is left holding, or none, so
`passkeys.tsx:133-158` collapses to one header. `verifyUnlock` and `beginEnrolment` read the
presented grant id from the request themselves, closing "never a form field" structurally.

**Tests.** `tests/routes/settings-passkeys.test.ts:1048-1295` (seven removal tests) and
`tests/lock.test.ts:1404-1490` prove the same cookie rule twice, the route copies via a regex over
`Set-Cookie` (`grantIdOf`, `:122-124`). `tests/routes/root.test.ts:53-63` mocks `touchGrant` and
`isLocked` individually to fail one read, a test past the interface that a behaviour-preserving
merge of those reads would break. `tests/support/webauthn.ts` signs real assertions and stays.

**ADR.** None. ADR-0012's "the middleware asks whether a live grant exists" is what this restores.

### 2.12 Straighten the provider seam: break the cycle, fold the probe in, lift the freshness readers out

**Rating: Worth exploring.** In-process; ports & adapters for the probe. Pricing.
**Files:** `app/lib/price-provider.server.ts:11` imports `matchKey` from `prices.server.ts:448`;
`prices.server.ts:12` imports `ProviderUnreachable` back; `provider-socket.server.ts:25` imports
`matchKey` too. `ProbeSymbols` (`price-provider.server.ts:314-322`, with `probeVerdicts` at
`:325-362`) is a second seam beside
`PriceProvider` (`:48`); `socketProbe` (`provider-socket.server.ts:214-241`) repeats
`socketProvider`'s batch loop: `wellFormedSymbols` (`:169` / `:215`), `batchesOf` (`:176` / `:219`),
`ask("quotes", …)` (`:177` / `:221`), `fetchedAt` (`:172` / `:216`), `toProviderQuote` (`:181` / via
`probeVerdicts` at `:336`). The socket adapter is named at three sites (`refresh.server.ts:64`,
`price-poller.server.ts:174`, `upload/instruments.tsx:102`) where Appendix A claims two.
`priceFreshness` / `asOfView` (`prices.server.ts:775-808`) are imported by five screens from the
808-line writer; §4.2 has to cite the exception by line because it has no module.

**The problem.** A one-line symbol normaliser makes the provider seam import the module that owns
every price write. Two adapters exist for each seam (socket plus test stubs), so both are real, but
they are one seam split in two, and the split costs a second batch loop and a third default-adapter
site.

**Deletion test.** Delete `ProbeSymbols` and give `PriceProvider` a third method: `socketProbe`'s
loop collapses into `socketProvider`'s; `probeVerdicts` (pure, `:325`) stays. Nothing reappears.
The cycle break and the freshness move are a partition, not a deletion: leverage unchanged,
locality gained.

**What would change.** `matchKey` moves beside the provider types, or into `server/symbol-pattern.ts`,
which both sides already import. `PriceProvider = { getQuotes, getDailyCloses, probe }`;
`socketProvider()` implements all three over one loop; one `defaultProvider()` site.
`ResolutionDeps.probe` keeps its function shape so the resolver's Map stubs survive.
`priceFreshness` and `asOfView` move to `price-freshness.server.ts`. `tests/price-provider.test.ts:356-449`
starts a real worker to re-prove the pure verdict table; after, one batching test shared with
`getQuotes`.

**ADR.** None. ADR-0010 already calls the worker "a second implementation of the provider seam"
and §7.5 already requires every method. Spec price-worker/02's reason for a pure `probeVerdicts` (a
refusal must stay named, `:324`) is untouched.

### 2.13 One product at money scale

**Rating: Worth exploring, small.** In-process. Cross-cutting; §4.2's "worth watching".
**Files:** `migrations/0006_annual_dividend.sql:51` (the view's quantity(8) × price(4) → money(4),
the authority); `uploads.server.ts` `valueAt` (`:1032-1043`, called `:1245`, `:1273`, `:1299`),
`render(divide(toUnits(q, 8) * toUnits(p, 4), 10n ** 8n, 0), MONEY_SCALE)`; `positions.server.ts`
`fitsTheMoneyColumn` (`:118-135`), the same product rounded inline at `:132`, the "rounding rule
spelled twice" §4.2 records; `format.ts:31-48`, a third half-away-from-zero on digit strings, kept
equal to `money.ts:17` by a comment; `breakdown.tsx:27`, `Number(share)` claiming `toPlotValue`'s
licence. `tests/invariants/ingest-rounding.test.ts:187-215` exists only because the JS mirror exists.

**The problem.** All JS money arithmetic already runs on `money.ts` primitives. What is spelled three
times is the one composition the view does in SQL, and one of the spellings is the only valuation
figure produced outside the view.

**What would change, two shapes.** The cheaper: one exported product in `money.ts`, called by
`valueAt` and `fitsTheMoneyColumn`, each keeping its own guard; §4.2's "spelled twice" closes. The
deeper: the review's Value column computed in SQL. The facts query at `uploads.server.ts:1187-1204`
already joins `quote`; hand it `unnest(ids, quantities)` and a `valueAtCurrentQuote(pairs)` in
`valuation.server.ts` makes every figure the review shows SQL's, by §4.2's own argument for
`readSessionSeries` ("the same module owns both"). The invariant test then pins nothing and goes.
Either way `breakdown.tsx` calls `toPlotValue`.

**ADR.** None.

---

## 3. Smaller cuts

- **Lock path predicates out of `root.tsx`** (Worth exploring). `decodedPathname`,
  `normalizedPathname`, `isUnlockPath`, `isLockNowPath` (`root.tsx:55-84`) and `LOCK_EXEMPT_PATHS`
  (`:53`) are pure string logic used on both sides of the `.server` line (middleware `:141`, `Layout`
  `:297`). Move them to `lock.ts`, and `tests/routes/root.test.ts:566-600` stops seeding a passkey to
  check a string comparison. §4.2:390, §4.4:513, §7.2:1829 and §7.6:1919 say "in `app/root.tsx`" and move
  with it.
- **Health chain trims** (Worth exploring). `WorkerReachability` is declared twice
  (`price-health.ts:9`, `worker-reachability.server.ts:23`) though `import type` crosses freely.
  `health-response.ts` is one seventeen-line function with one caller; delete it and three lines
  reappear in the route once. The other three modules in the chain are deep and stay.
- **Worker/app mirrored text rules** (Speculative). `ERROR_TEXT_LIMIT` (`price-worker.ts:22`,
  `provider-socket.server.ts:49`) and the control-character regex (`:96` / `:53`) could share a
  `server/` module as `symbol-pattern.ts` does. The body caps are not a duplicate (a request and a
  response over different stream APIs); symbol validation on both sides is deliberate (spec 0018 §2.1).
- **A settings column accessor** (Speculative). Three read/save pairs of one shape in
  `settings.server.ts` (`:20-42`, `:55-82`, `:116-138`) and five tests of one shape per pair;
  the promised theme setting (`display.tsx:21`) would be a fourth copy. Marginal leverage, and a risk
  of a shape more elaborate than three pairs need.
- **Masking: return the parsed policy** (Speculative). `display.tsx:37` discards
  `saveMaskingPolicy`'s result and re-narrows the raw value at `:83-86`; `routes/masking.ts:17-19`
  restates the vocabulary check. Three lines. Everything else in masking is one resolver per side by
  design (ADR-0002).
- **One group-and-fold** (Speculative). `compareAccount` (`uploads.server.ts:1117-1160`)
  re-implements `parseStatement`'s grouping loop (`statement.ts:522-583`) around the shared
  `foldLots`; a `foldBy(positions, keyOf)` in `statement.ts` removes about forty lines. Two callers.
- **Noted.** `people.server.ts` computes the two account counts twice (`:37-62`, `:171-190`) and
  `createPerson` (`:114`) hard-codes the zeros. `DAY_MS` (`chart-range.ts:29`,
  `net-worth-chart.tsx:36`), `IsoDate` (`market-hours.ts:9`, `valuation.server.ts:100`) and `TILES`
  (`overview.tsx:189`, `account.tsx:180`) are each still declared twice, remnants of August's §2.2.
- **Invariant suite gaps** (`tests/invariants/aggregates-agree.test.ts`). Not pinned: the Holdings
  total row (`summarise`, JS) against the Overview headline (`netWorth`, SQL), the most visible pair
  and exactly the shape the file's header names; `readGrainedSeries`'s instant branch (`:627-655`)
  against `readSessionSeries` for the same instant, two SQL valuations ADR-0014 says agree;
  `netWorthChange.current` against `netWorth.amount`, two hand-written `sum(value)` (`:740-744`,
  `:141`). And `tests/dashboard-queries.test.ts:57-59` compares totals through `Number()`, a float sum
  in an exact-string suite.
- **Housekeeping.** `app/lib/uploads.server.ts.orig` and `tests/commit-upload.test.ts.orig` are
  tracked, 2 597 and 1 425 diff lines behind their originals, imported by nothing. Delete them.

---

## 4. Looks shallow, is deliberate

Checked and left alone, with the document that says why, so the next review does not spend effort here.

- `commitUpload` / `recordUpload` thin over `withAccountLock`, and the unlocked `draftAccountId`
  read (`uploads.server.ts:275-288`): §4.2's "Appending to an account's history" row, §7.2's "Two
  commits of one draft".
- `routeDraft`'s three-line pass-through (`:357-364`) keeps `routeStatement` pure (Appendix A).
  `readUploadForm`'s single caller is §4.2's upload-cap row; August's §4.4 refuted absorbing it.
- `aliasesFor`'s two queries, the second overwriting the first
  (`instrument-resolution.server.ts:44-57`): ADR-0013, vocabulary wins. `had_first_sightings`
  written at the columns step, not derived later (`uploads.server.ts:95-97`, `:390-393`): "written
  here, where the answer exists" (`:390`; §6.1). Created instruments outliving an abandoned draft: ADR-0013.
- Conversion on the app side of the worker's raw JSON (§7.5; ADR-0010's "no second schema"; the
  worker holds no domain logic, `price-worker.ts:2-3`). `socket-transport.server.ts` as its own
  module (spec 0021, Rejected). `worker-reachability` memoising while `provider-socket` remembers
  nothing (its header, `:9-14`).
- Fixtures planting price rows raw (`fixtures.ts:393-489`, 24 test files): §4.2's "Writing a price"
  row. `writeDailyClose` refuses history older than seven days by design (`prices.server.ts:608`), so
  a 2024 close cannot come through the writer; the fixtures are not evidence that the write interface
  is hard to drive. `isMarketOpen` (`market-hours.ts:108`) is live: `scripts/seed-demo.ts:421` walks
  sessions with the unpadded window.
- `chart-series.server.ts` at 89 lines: the one site of the coverage rule, two callers (spec 0015).
  `manualNetWorth` and `latestObservedSession` take no filter (`valuation.server.ts:708`, ADR-0008).
  `owner-reading.server.ts` reads no money (its header `:3-4`; §4.2). Holdings reads
  `currentHoldings` twice while narrowed (`holdings.tsx:109`): SQL narrows, never JS. Analysis and
  Income discard `netWorth`'s coverage for the array's own count (`analysis.tsx:155`; August's §4.1).
- The owner-filter obligation on four screens, about 55 lines: the loader half is deliberately not
  absorbable, since `currentHoldings(reading)` must stay visible in review (ADR-0008;
  `owner-reading.server.ts:3-4`). The element half (control, sentence, empty state, and the three
  identical `instance` lines at `overview.tsx:126`, `analysis.tsx:147`, `income.tsx:53`) could take one
  `OwnerBlock` prop with visibility unchanged. Speculative; not carded.
- `expectedRelyingParty()` reads config per call (`lock.server.ts:59`), and the `getConfig` mock in
  `tests/lock.test.ts:52-66` is the accepted price. The in-memory challenge map, one adapter
  (ADR-0012). The lock middleware throws before `next()` while chart-range's decorates after
  (ADR-0012 names the contrast). `LOCK_EXEMPT_PATHS` pinned to length (`tests/routes/root.test.ts:226`).
  Ceremony state machines in `unlock.tsx` and `passkeys.tsx` with their pure decisions exported
  (`unlock.tsx:312-327`; §9.3).
- Four cookie encoders (`masking.ts:54, :63`; `chart-range.ts:298`; `lock.server.ts:92-98`) differ
  in every attribute that matters and each difference is argued (ADR-0002, ADR-0012,
  `chart-range.ts:290`). A shared builder would take five attribute sets from five callers.
  `cookies.ts` is already the one reader. `safeReturn` (`return-path.ts`): one implementation, four
  callers, deep enough.
- `first-run.server.ts` at 21 lines fails the deletion test by count and passes it by §4.1:
  deleting it puts a query and a rule into a route. Correctly small.
- `holdings.tsx:940` renders the form-level refusal as `.field-error` in a fixed order
  (`docs/design/holdings-ui-brief.md:644-645`; August's §4.5). `Amount` as the one renderer, enforced
  by `tests/masking-boundary.test.ts` (ADR-0002).
- `tests/account-lock.test.ts` is `withAccountLock`, the account row lock (§7.2), not the passkey
  lock; `tests/lock*.test.ts` are the passkey lock. A naming collision with CONTEXT.md's "Locked";
  worth one line in `docs/developing.md`, nothing more.

---

## 5. Stale facts in ARCHITECTURE.md, found on the way

Not architecture findings. Cheap to fix, and the document promises that "where a claim can be
checked, it is anchored to a file and a symbol".

- §6.1: `recordAccountNumber (uploads.server.ts:2096)` → `:2098`. "Six live in
  `tests/fixtures/statements/`" → eight. The commit flowchart omits the bounded-number (`:1793`) and
  already-recorded-elsewhere (`:1808`) refusals between F and H.
- §7.2: `uploads.server.ts:1878-1885` for the rerouted refusal → `:1883-1886`.
  `balances.server.ts:104, :132-149` → `:104` is inside `balanceReceipt`; the locked
  `currentStatement` read is `:145`, the guard CTE `:172-190`. §7.2:1774's "not a
  read first" (and `accounts.server.ts:191`'s "The index decides, not a read first", the same
  sentence): the single-account commit now reads `numberHolder` first (`:1805-1808`); the guarantee
  holds, the sentence does not. `migrations.ts:126-128` for the ledger's `create table if not exists` before the
  lock → `:61` (create) and `:84` (lock).
- §7.5: "`socketProvider()` dials the worker's socket (`provider-socket.server.ts:213`)" → `:166`;
  `:214` is `socketProbe`. Appendix A:2366 and §8.1:2045 cite
  `provider-socket.server.ts:11` for the `symbol-pattern` import; it is at `:9`. Appendix A's `refresh.server.ts` row: "one edit here and
  one in `startPricePoller`" misses `upload/instruments.tsx:102`. Not an ARCHITECTURE.md fact, since
  §5.6:969's `price-provider.server.ts:99` is current, but August §5's float excursion at `:266-270`
  is now `:172-176`, with `inRange`'s `Number(value)` at `:99-102`.
- §11.3: "`<FieldError>` is open-coded at roughly fifteen sites" → 42, in 14 and 15 files.
  Appendix A's `settings.server.ts` row, "The capital gains rate" → also the masking policy and the
  refresh cadence. Appendix A's `lock.server.ts` row, "the middleware asks this module one question"
  → `root.tsx:32` imports four names and asks two. §7.6:1925, "`mintGrant` inserts unconditionally"
  → it sweeps expired rows and deletes `supersedes` first (`lock.server.ts:133-138`); the consequence
  holds, the mechanism sentence does not. §7.6:1932, "both resource routes use it" → `unlock.tsx:29,
  :78`, a document route, also uses `safeReturn`. React Router is cited as 7.18.2 (§4.4:530,
  `root.tsx:55`), 7.18.3 (§4.2:391) and resolves to 7.18.4 (`package-lock.json`).
- §6.3:1510 and Appendix A:2374, "seven reads through `ValuedSource`: `readHoldings`, `readTotal`
  and `readSeries`" → `readSeries` (`valuation.server.ts:344-379`) inlines `holding_valued_at` and
  never takes a `ValuedSource`; the seventh is `netWorthChange` (`:740-744`). "Three household-scoped
  reads no longer called by the screen" → four (`netWorthGrainedSeries`, `chart-series.server.ts:57`).
  §5.6: `toPlotValue` is at `format.ts:162-164`, and `breakdown.tsx:27` is a third `Number()` on a
  money-derived string. §11.4: "five array calls" → eight. §6.3's screen table lists Overview's
  reads as `netWorth, manualNetWorth, netWorthChange`; the rollup and `holdingCount` come from
  `accountTotals` (`overview.tsx:103`) and `netWorth` is read only while narrowed (`:107`).

---

## 6. Suggested sequence

> Items 1 and 2 landed on 2026-09-24 (§7). The live sequence is at the end of §7.

1. **2.1, one commit over N routed sections**, first. It sits in the hottest module in the
   repository, the multi-account commit landed the day before this review as a second copy of the
   first, and the two have already drifted in three places. Taking it gives 2.2 its single hash for
   free and puts the next ingest rule in one place. 2.8 and 2.9 inherit a settled shape if they
   follow it rather than precede it.
2. **2.3, the poller**, whenever a pricing change is next. The cheapest Strong, independent of
   everything else, and 2.4 is naturally the same pull request.
3. **2.7 step one**, minutes: two dead exports and one twin. Step two after 2.6, which already
   carries `ChartScope` as the shape.
4. **2.5, the refusal round trip**, as its own pull request. It touches fifteen routes and should
   carry nothing else; §11.3's two-route gap closes with it.
5. **2.10 `holdingsTable`** last among the read-path items, as August already said, and only if
   DESIGN.md §8.3's saved-view builder is still next.

---

## 7. Follow-up — 25 September 2026: what landed within a day

*Checked against `ec03f55`, the day after the review merged. The cards above are the original
evidence and stay as written; this section is the status.*

Four commits landed on `main` after `cf11d01`. Three of them are this review's candidates, each
run as its own spec and pull request; the fourth (#358, the change chip's baseline) touches two
cards' evidence without addressing either. Every status below was re-verified in the code, not read
off a commit subject.

| Candidate | Status at `ec03f55` | Evidence |
|---|---|---|
| 2.1 One commit over N routed sections | **Landed.** #385, spec 0024 | `commitUnderLocks` is the one commit; `assembleDiff` takes groups; `UploadDiff.accounts: AccountDiff[]` (`uploads.server.ts:940`); `recordUpload` returns `CommittedUpload[]` (`:1581-1585`); one hash recipe; `review.tsx` one branch; the file is 2 295 lines, from 2 420. Spec 0024 §4 records the three drift decisions: (a) both survive, the chosen-account guard reading `numberHolder` for the number it captured and the unique index deciding for every account; (b) the posted `accountId` check survives for both kinds; (c) the watermark is posted and hashed for both. Tests: one staging helper (`tests/support/review.ts`: `posted`, `reviewAndRecord`) replaces the two encoders; `tests/review-revision.test.ts` (643 lines) pins the hash field by field. |
| 2.2 A review-binding module | **Half landed** with #385 | The draw half: `app/lib/review-form.ts` (`sectionKey`, `reviewedFields`), browser-safe, the one encoder the page and the tests share. The verify half (`refuseStaleReview` at `:1611`, `baselineMoved`, the reason ordering) is still inside the commit; spec 0024 §5 names it as this candidate. With one recipe, one encoder and one commit path, what is left is a `verifyBinding(posted, fresh)` over sections. **Re-rated Worth exploring.** |
| 2.3 The poller as a built instance | **Landed.** #386, spec 0025 | `createPricePoller` (`price-poller.server.ts:52`); `startPricePoller` pins one instance (`:238`). `tests/price-poller.test.ts` fakes no `Date`, pokes no symbol, spies no module; its one `useFakeTimers` fakes only `setInterval`, for the arming test, by design (`:287`); `Price refresh` is pinned. The `afterEach(stopPricePoller)` hooks in the four other files stay, as the spec predicted: the root middleware arms the process-wide slot. |
| 2.4 `refreshPrices` takes `now` | **Landed.** #387, spec 0026 | No `new Date()` in `prices.server.ts` or `refresh.server.ts`; one `refreshPrices`, one `runRefresh`; `RunWithQuotes` gone; no clock faking left in `refresh-quotes`, `price-backfill`, `refresh` or `routes/refresh` tests. Shape chosen: one entry with the null case named (spec 0026 §1). |
| 2.5 The refusal round trip | Unchanged | 11 splits, 10 comment copies, 21 + 21 paragraphs. `refusalOf` copies grew from sixteen to eighteen with #385's new test files. Still Strong. |
| 2.6 One chart entry | Unchanged, and the loader grew | #358 added the change chip's basis rule (`ChangeBasis`, the *clamped* label) to the Overview loader: more loader-body logic, not less. Still Strong. |
| 2.7 Valuation's matrix | Unchanged; one export more | #358 added `manualNetWorthAt` (twenty exported functions now). `holdingsAt` and `netWorthAt` still have no production caller; the `accountTotal` / `accountTotals` twins are intact. #358 pinned `netWorthChange`'s baseline rules (`tests/dashboard-queries.test.ts:275-410`); the `netWorthChange.current` against `netWorth.amount` agreement in §3 is still not in the invariant suite. Step one is still minutes. |
| 2.8, 2.9 Router step ownership, `resumeAt` | Unchanged in shape; counts moved | #385's `review.tsx` rewrite took the `?stale=true` carries from twelve to nine and the `steps` literals from six to five. `refusalsByStep`, `stepOf`, `numberQuestions` and the third `readDraft` reader are all still there. |
| 2.10, 2.11 | Unchanged | `holdings.tsx` and the lock were not touched. |
| 2.12 The provider seam | Unchanged | The cycle is still there (`price-provider.server.ts:11`, `provider-socket.server.ts:25`); `priceFreshness` moved to `:765` and ARCHITECTURE.md §4.2 followed it, by line number again. |
| 2.13 One product at money scale | Unchanged | `valueAt` (`uploads.server.ts:1035`) and the inline rounding (`positions.server.ts:132`) both stand; #385 kept the mirror test (`tests/invariants/ingest-rounding.test.ts:180-183`). |

**Smaller cuts and housekeeping.** The `.orig` files are still tracked. `tests/dashboard-queries.test.ts:57-58`
still sums through `Number()`. New: #385 left its eight PR-lifetime captures in
`docs/specs/ingest/screenshots/0024-*.png`; docs/README.md says they are deleted once the pull
request merges, and each `-main` / `-branch` pair is byte-identical, so there is nothing in them to
keep.

**Stale facts (§5).** Fixed on the way: the `recordAccountNumber` line number (dropped), the
`:1878-1885` row (rewritten for `commitUnderLocks`), and, by #358, the "seven reads through
`ValuedSource`" sentence and §6.3's Overview reads row. Still open: the eight statement fixtures, the
flowchart's two missing refusals, `balances.server.ts:104`, `migrations.ts:126-128`,
§7.2's "not a read first" (spec 0024 §4 kept both behaviours, so the sentence is still
wrong the same way), `provider-socket.server.ts:213` and `:11`, the "one edit here and one in
`startPricePoller`" claim,
"roughly fifteen sites", "The capital gains rate", "asks this module one question",
"`mintGrant` inserts unconditionally", "both resource routes", the three React Router versions,
"three of the household-scoped reads", `format.ts:139`, "five array calls". New, from spec 0025's
review record: Appendix A `:2385` names a provider default on `refreshPrices` that is
`runRefresh`'s.

**The live sequence.** 2.7 step one (two dead exports, one twin: minutes). 2.5 as its own pull
request. 2.6, which #358 has made slightly more valuable. 2.2's verify half, now that its inputs are
one recipe and one encoder. 2.12. Then 2.8 and 2.9 on the settled ingest shape, in that order.
