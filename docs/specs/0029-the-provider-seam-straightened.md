# 0029 — The provider seam straightened: no cycle, the probe a third method, one default, the freshness readers their own module

_Candidate 2.12 of [the second architecture review](../research/2026-09-24-architecture-review.md)
(card 12 of its [visual companion](../research/2026-09-24-architecture-review/report.html)). Line
numbers below were read at `87732bb`._

**What to build:** Four partitions of the pricing seam, none of which changes what a price is, when
one is fetched, or what the household sees.

1. **The cycle.** `price-provider.server.ts:11` imports `matchKey` from `prices.server.ts:438`, a
   one-line symbol normaliser, while `prices.server.ts:12` imports `ProviderUnreachable` back.
   `matchKey` moves into `price-provider.server.ts`; the writer imports it from the seam, and the
   seam imports nothing from the writer.
2. **The probe.** `ProbeSymbols` (`price-provider.server.ts:322`) is a second seam beside
   `PriceProvider` (`:47-55`), and its socket adapter `socketProbe` (`provider-socket.server.ts:214`)
   repeats `socketProvider`'s batch loop step for step. `PriceProvider` gains `probe`;
   `socketProvider()` implements all three methods, and its two quote-asking methods share one
   private batch loop that takes the budget. `ProbeSymbols` and `socketProbe` are deleted.
   `probeVerdicts` stays pure and named (spec price-worker/02).
3. **The default.** The socket adapter is named as the default at three sites
   (`refresh.server.ts:52`, `price-poller.server.ts:241`, `upload/instruments.tsx:19, :103`) where
   Appendix A's `refresh.server.ts` row claims two. One `defaultProvider()` in `refresh.server.ts`
   serves all three.
4. **The freshness readers.** `priceFreshness` (`prices.server.ts:765`) and `asOfView` (`:791`),
   imported by five screens from the 800-line writer, move to `app/lib/price-freshness.server.ts`,
   and §4.2 names the module instead of a line.

Worth doing on its own: the seam stops depending on the module that owns every price write, a
provider swap is one edit, the probe is tested where `getQuotes` is, and the only thing a screen
imports from pricing is a reader.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**Out of scope:**
- Candidate 2.4's leftovers, the health chain (`worker-reachability.server.ts`, `price-health.ts`),
  the worker's mirrored text rules.
- Any budget, cap, batch size, the `ProviderUnreachable` mapping, `ask` itself, and every log line.
- What the instruments step says on a refusal; `resolveAll`'s rules.
- `socket-transport.server.ts`, `server/price-worker.ts`, `server/symbol-pattern.ts`, the egress
  proxy, the Dockerfile and the smoke test.
- ARCHITECTURE.md's stale `provider-socket.server.ts:11` citations at `:2062` and `:2383` (the line
  is `:9` and this change does not move it).

## 1. Where `matchKey` lives

In `app/lib/price-provider.server.ts`, exported, beside the types whose symbols it normalises:

```ts
/** Match form only — the stored symbol stays as typed (§4.3). */
export const matchKey = (symbol: string): string => symbol.trim().toUpperCase();
```

`prices.server.ts` adds it to its existing value import from `./price-provider.server.ts` (`:12`)
and deletes its own definition (`:437-438`). `provider-socket.server.ts` drops its import from
`./prices.server.ts` (`:25`) and takes `matchKey` in its existing import from
`./price-provider.server.ts` (`:11-24`).

Not `server/symbol-pattern.ts`, though both sides import it. That file is in the worker's import
closure (its header, `:1-2`; ADR-0010), and `matchKey` is the app's rule for matching a quote to an
instrument, which the worker never applies (`server/price-worker.ts` does not call it). Putting an
app-side matching rule in the file the worker shares would be the first rule the worker's side
carries about what a price is matched to. It would also need nothing: `symbol-pattern.ts` ships by
explicit listing (`Dockerfile:77`, `scripts/smoke-test.sh:227`), which this placement leaves alone.

After the move the imports among the three modules are one-way:
`prices.server.ts → price-provider.server.ts`, `provider-socket.server.ts → price-provider.server.ts`,
and `price-provider.server.ts` imports only `zod`, `market-hours.ts` and `money.ts`.

## 2. `probe`, and the one loop

```ts
// price-provider.server.ts
/** `getQuotes` batches — why Yahoo was chosen. History has no batch form: one symbol per call. */
export type PriceProvider = {
  getQuotes(symbols: string[]): Promise<ProviderQuote[]>;
  getDailyCloses(symbol: string, range: HistoryRange, marketTimeZone: string): Promise<ProviderHistory>;
  /** A verdict for every symbol asked, never a throw: a provider failure must not block creating an instrument. */
  probe(symbols: string[]): Promise<Map<string, SymbolProbe>>;
};
```

`SymbolProbe` and `probeVerdicts` are unchanged. `ProbeSymbols` is deleted.

In `provider-socket.server.ts`, one private async generator holds what the two loops repeat today
(well-formed filter, one fetch instant, batches of `BATCH_SIZE`, sequential `ask("quotes", …)` under
a budget):

```ts
type QuoteBatch = { batch: string[]; fetchedAt: Date } & ({ raw: unknown } | { error: unknown });

async function* quoteBatches(symbols: string[], budgetMs: number): AsyncGenerator<QuoteBatch> {
  const wellFormed = wellFormedSymbols(symbols);
  const fetchedAt = new Date();
  // Sequential: pacing costs one unnoticed round trip, against a worker whose `maxConnections` is eight.
  for (const batch of batchesOf(wellFormed)) {
    let answer: { raw: unknown } | { error: unknown };
    try {
      answer = { raw: await ask("quotes", { symbols: batch }, { budgetMs }) };
    } catch (error) {
      answer = { error };
    }
    yield { batch, fetchedAt, ...answer };
  }
}
```

The `try` wraps only the `ask`, and the `yield` sits outside it, so nothing the consumer does
between batches can land in that `catch`.

- `getQuotes(symbols)` iterates `quoteBatches(symbols, BUDGET_MS.quotes)`; an `error` arm is
  rethrown as it is, which ends the iteration (the generator's `return` runs and asks nothing
  more). Otherwise its per-entry body is today's (`:179-187`) unchanged. `BUDGET_MS.quotes` is
  `ask`'s default for `"quotes"` today (`:67`), so the budget does not move. An empty or all-refused
  list now reaches the loop and yields nothing instead of returning early (`:170`); the result is
  the same `[]`, and no `ask` is made.
- `probe(symbols)` iterates `quoteBatches(symbols, PROBE_BUDGET_MS)`. Each batch runs inside one
  `try`, as today's (`:220-232`) does: an `error` arm is rethrown into it, and a `raw` arm feeds
  `probeVerdicts(batch, raw, fetchedAt)` into the map, so a throw from `probeVerdicts` (its
  non-`CurrencyRefused` rethrow, `price-provider.server.ts:344`, unreachable today) is still caught
  and `probe` still never throws. The `catch` logs today's warning (`:227-230`, same text, same
  arguments) and marks the batch `unavailable`. The fill of symbols
  the pattern refused (`:236-238`) stays. Its doc comment (`:210-213`) moves with it.
- `getDailyCloses` is unchanged.
- The "Must not throw when built" comment (`:162-165`) stays on `socketProvider()`. All three
  methods are closures over nothing, so `defaultProvider().probe` passed alone (§3) is safe: none
  reads `this`.
- `ask`'s comment naming `socketProbe` (`:100`) names `probe`.

`ResolutionDeps.probe` (`instrument-resolution.server.ts:201-204`) is typed
`PriceProvider["probe"]`, keeping its function shape, so every stub that is a bare function
survives; its import of `ProbeSymbols` (`:11`) becomes a type import of `PriceProvider`, and the
`Awaited<ReturnType<ProbeSymbols>>` annotation (`:461`) becomes
`Awaited<ReturnType<PriceProvider["probe"]>>`.

**Why a generator.** The two methods keep different failure policies by design: `getQuotes` lets a
failed batch fail the refresh (the refresh records the provider failure), `probe` never throws.
What they shared was everything before the policy. A callback parameter would say the same thing
with the policy inverted into the loop; the generator keeps each method's policy readable in its own
body.

## 3. One default

In `refresh.server.ts`, beside `runRefresh`:

```ts
/** The adapter every caller takes unless handed one: a provider swap is this one edit. */
export function defaultProvider(): PriceProvider {
  return socketProvider();
}
```

| Site today | After |
|---|---|
| `refresh.server.ts:52` `provider: PriceProvider = socketProvider()` | `= defaultProvider()` |
| `price-poller.server.ts:241` `provider ?? socketProvider()` (import `:20`) | `provider ?? defaultProvider()`, imported from `./refresh.server.ts` beside `runRefresh` (`:21`); the `provider-socket` import goes |
| `upload/instruments.tsx:19` import, `:103` `{ probe: socketProbe }` | `{ probe: defaultProvider().probe }`, imported from `~/lib/refresh.server` |

`refresh.server.ts` is where Appendix A already puts "the only place a caller names a provider by
default"; the poller already imports it; so it gains a name rather than the codebase gaining a
module. The comments naming `socketProvider()` as the default (`refresh.server.ts:46-47`,
`price-poller.server.ts:234-236`) name `defaultProvider()`. The header of `refresh.server.ts` gains
"and the provider every caller takes by default".

## 4. The freshness module

`app/lib/price-freshness.server.ts`, header: "The as-of line every screen shows: read from
`holding_valued`, never written (ARCHITECTURE.md §4.2's valuation exceptions)." It holds
`priceFreshness` and `asOfView` moved verbatim with their comments, importing `sql` and `Kysely`
from `kysely`, `getDb` and `Database` from `./db.server.ts`, `marketStampOf` from
`./market-hours.ts`.

Importers after:

| Importer | Before | After |
|---|---|---|
| `app/routes/overview.tsx:49` | `asOfView` from `~/lib/prices.server` | from `~/lib/price-freshness.server` |
| `app/routes/income.tsx:23` | same | same |
| `app/routes/analysis.tsx:25` | same | same |
| `app/routes/holdings.tsx:67` | same | same |
| `app/routes/account.tsx:60` | same | same |
| `tests/refresh-quotes.test.ts:5` | `priceFreshness` | from `~/lib/price-freshness.server` |
| `docs/research/2026-09-01-overview-1d-latency/harness/time-overview.ts` | `asOfView` | from the new module (amended 2026-09-25: the research harness is typechecked, which the plan missed) |

`prices.server.ts` keeps its `marketStampOf` import only if another use remains (today `asOfView`
is its only use, `:11`), and `sql` stays (other uses). The module name sits beside
`app/components/price-freshness.tsx` (the component that renders the line); the `.server` suffix
and the directory keep them apart, as `upload-steps.tsx` and `uploads.server.ts` are.

## 5. Every test double of `PriceProvider`

Each of the eight gains `probe`. None of them is ever asked to probe, so each answers the way a
double that must not be reached does in this suite, by throwing. They stay local, one per file, as
this suite keeps its provider doubles (`price-poller.test.ts:56`, `:74`; `refresh-quotes.test.ts:18`); no shared double exists in
`tests/support` to reuse:

```ts
async probe() {
  throw new Error("This provider is never asked to probe.");
},
```

| File | Doubles |
|---|---|
| `tests/price-poller.test.ts` | `fakeProvider()` `:56-72`, `brokenProvider()` `:74-83` |
| `tests/refresh-quotes.test.ts` | `fakeProvider(quotes)` `:18-30`, `brokenProvider(message)` `:32-40` |
| `tests/refresh.test.ts` | `fakeProvider(quotes)` `:33-42`, `brokenQuotesProvider()` `:45-54` |
| `tests/routes/healthz.test.ts` | `silentProvider()` `:42-51` |
| `tests/price-backfill.test.ts` | `fakeProvider(answer, quotes)` `:477-505` |

`tests/instrument-resolution.test.ts`'s `ProbeSymbols`-typed stubs (`okProbe` `:31-40`,
`unavailableProbe` `:42-43`, `foreignProbe` `:45-48`, `forbiddenProbe` `:50-52`, inline `:508`,
`:557`, `:590`, `:654`, `silentProbe` `:707`, `probe` `:747`) retype to `PriceProvider["probe"]` (import `:24`). The untyped
`{ probe: async () => new Map() }` stubs (`column-mapping.test.ts:275`, `commit-upload.test.ts:1052,
:1894, :2074`, `multi-account-upload.test.ts:521`, `upload-draft.test.ts:85`,
`routes/upload-instruments.test.ts:151`) are unchanged.

## 6. Tests

- **`tests/price-provider.test.ts`.** The describe "probing symbols at creation time" (`:356-456`, with its helper `clientAnswering` `:358-363`)
  starts a real worker to prove verdicts the pure table (`:274-354`) already proves. It is deleted,
  after the pure table gains the one row it lacks, so no verdict loses its test: an entry
  `toProviderQuote` does not recognise (`[{ nothing: "useful" }]`) leaves the symbol `unavailable`
  (`:428`). The ok verdict carrying `quoteType` (`:375`) is already pinned by `:286-299` and
  `:327-335`. Its two socket-level cases are already in `tests/provider-socket.test.ts`: the worker
  answering 502 (`:406`) as `:513`, the one call (`:436`) as the batching test below. The
  real-worker harness (`:17-36`) stays for `getDailyCloses` (`:792` onward); the import at `:15`
  shrinks to `socketProvider`.
- **`tests/provider-socket.test.ts`.** The describe `socketProbe` (`:427`) becomes
  `socketProvider().probe`, its cases calling `socketProvider().probe(…)`. The two batching tests
  (quotes `:100`, probe `:493`) become one `it.each` over both methods: 101 symbols reach the worker
  as two requests of 100 and 1, and every symbol is answered. Probe's per-batch isolation (`:513`)
  and every other case stay. The construction test (`:539-540`) becomes
  `it.each(["getQuotes", "probe"])`, a fresh `getConfig` spy per row, each row building the
  provider, asserting no config read, then calling its method and asserting one.
- **Unchanged** apart from §5's doubles, imports and type annotations:
  `tests/instrument-resolution.test.ts`, `tests/refresh-quotes.test.ts`, `tests/refresh.test.ts`,
  `tests/price-poller.test.ts`, `tests/routes/healthz.test.ts`, `tests/price-backfill.test.ts`.
  Unchanged entirely: the untyped stubs' files listed in §5, `tests/symbol-pattern.test.ts`,
  `tests/routes/refresh.test.ts`.
- **Count:** 2435 − 8 (the deleted describe) + 1 (the pure row) + 0 (two batching tests become one
  two-row `it.each`) + 1 (the construction `it.each`'s second row) = **2429**. Amended 2026-09-25:
  plus two added in code review (below), **2431**.

## 7. Documentation this change moves

- ARCHITECTURE.md §4.2's valuation-exception bullet (`:416`), "`prices.server.ts:765`
  (`priceFreshness`)", names `price-freshness.server.ts` (`priceFreshness`, `asOfView`) instead.
- §6.2's freshness paragraph (`:1475-1488`) names the module where it names `priceFreshness`.
- §7.5 (`:1867-1922`): the diagram shows three methods and drops the stale
  `(provider-socket.server.ts:213)`; "the tests' fake — implements both" becomes "all three";
  "Both methods are required, not optional" (`:1894-1896`) becomes "All three"; the currency-guard
  line naming `socketProbe` (`:1912-1915`) names `probe`. The `socketProbe` mentions at `:106` and
  `:1174` name `probe`.
- Appendix A: `prices.server.ts` (`:2398`) drops "the freshness read"; `price-provider.server.ts`
  (`:2399`) reads "The provider interface, its three methods and `matchKey`, and the pure probe
  verdicts…"; `provider-socket.server.ts` (`:2400`) drops `socketProbe` and says `socketProvider()`
  implements all three methods over one batch loop; `refresh.server.ts` (`:2405`) says
  `defaultProvider()` is the one place a provider is named by default, for the poller, a refresh
  and the instruments step; a new `price-freshness.server.ts` row after `prices.server.ts`.
- `docs/specs/README.md`: the 0029 row (added with this spec).

Shipped specs that name `socketProbe` or `ProbeSymbols` (`0018-price-worker.md`,
`price-worker/*`, `price-health/02-worker-reachability.md:74`) are records of what was built and
are left as they are.

## 8. Differential validation

The claim: for the same instant and the same worker answers, every price row, probe verdict and
refusal is identical on `origin/main` and the branch. A `sonnet` sub-agent can run it from this
section alone. `S` is the scratchpad.

**Setup.** As spec 0028 §7: `git worktree add "$S/wt-main" origin/main` and `"$S/wt-branch"` at
the branch head, `node_modules` symlinked, a private Postgres per tree run (fresh, migrated), the
harness an untracked `tests/differential/provider.test.ts` copied unchanged into both, run with
`--no-cache`, twice on main first to prove it deterministic, then `diff -r`.

The harness starts a real in-process worker exactly as `tests/provider-socket.test.ts:19-36` does
(`startWorker({ socketPath, yahoo })` with a scripted `YahooClient`, `PRICE_WORKER_SOCKET` set to a
temp path), so both trees ask through `ask` over the socket. It pins `Date.now`/`new Date()` with
`vi.useFakeTimers({ toFake: ["Date"], now: <fixed instant> })` so `fetchedAt` and every stamp match.
The worker's socket path goes in `process.env.PRICE_WORKER_SOCKET` at the module's top, before
the first `getConfig()`, as `tests/provider-socket.test.ts:20` does. Faking only `Date` leaves
`AbortSignal.timeout` and the worker's `performance.now()` alone. It imports only what exists on
both trees: `refreshPrices` from `~/lib/prices.server`; `socketProvider` from
`~/lib/provider-socket.server`; `rememberMapping` from `~/lib/uploads.server`; the instruments
route's `action`; `withDatabase` and `closeTestDatabase` from `tests/support/database.ts`;
`args`, `post` and `outcomeOf` from `tests/support/routes.ts`; the builders in
`tests/support/fixtures.ts`. It copies `tests/routes/upload-instruments.test.ts:19-64`'s
file-local `encode`, `CSV`, `MAPPING`, `stageDraft` and `createAnswer`, passing each case's own CSV
as `stageDraft`'s second argument, posting `priceSource: "feed"` where that helper posts
`"manual"`. The probe is reached **through the instruments route's
action**, which on main passes `socketProbe` and on the branch `defaultProvider().probe`, so the
harness never names either.

**Cases**, each writing `$DIFF_OUT/<nn>-<name>.json`:

| # | Case | Recorded |
|---|---|---|
| 1 | `refreshPrices(socketProvider(), "America/New_York", now, { quotes: true })` over three feed instruments, one answered in USD, one in GBp, one missing | the report, and every `quote`, `price_observation`, `price_daily` and `price_poll` row |
| 2 | the same with a backfill gap (a held instrument with no closes), the scripted client answering history | the report and the `price_daily` and `price_backfill` rows |
| 3 | 101 feed instruments | the report and the number of `/quotes` requests the worker saw |
| 4a | the instruments step posting first sightings with symbols `VTI` (USD), `ZZZZ` (unknown), `bad sym!` (ill-formed) | the route outcome (`outcomeOf`) and the `instrument`, `classification` and `upload_draft_answer` rows |
| 4b | the same step posting `VOD.L` (GBp) alone, refused before any write (`instrument-resolution.server.ts:470-483`) | the route outcome |
| 5 | case 4a with the worker stopped | the same as 4a |

**Expected result.** `diff -r` is empty. Any difference is a defect.

**Run, 2026-09-25.** Cases 1, 2, 3, 4a, 4b and 5 ran on a private Postgres recreated and migrated
before each run. Two runs on `87732bb` were byte-identical. The run on the branch head (`5a7a924`)
matched them: `diff -r` empty, ids included. One trap for a rerun: migration 0001 seeds a fixed USD
instrument whose `quote.as_of` is the migrate's wall clock, so the harness reads `quote`,
`price_observation` and `price_daily` scoped to each case's own instruments. On the dev server,
**Refresh now** said "Refresh failed — the price provider did not respond. Showing last known prices
from 22 Sep 2026, 5:08 PM EDT." on both trees; an upload with a first sighting answered as a feed
instrument landed on Review with it "never priced" on both; `/healthz` was byte-identical. A walk
from worktrees with `node_modules` symlinked needs `server.fs.allow` in the worktree's Vite config,
or the dev server 403s the client entry and silently tests the no-JavaScript fallback.

**In the running app.** On the dev server over `scripts/seed-demo.ts` data, with Playwright, on
main and the branch: press **Refresh now** (no worker runs, so the provider is unreachable, a
normal outcome: capture the control's message); an upload with a first sighting, through the
instruments step to Review; `GET /healthz`'s body. Identical text on both. Captures go in the pull
request, not the tree.

## Acceptance

**The cycle**
- [ ] `grep -n "from \"./prices.server" app/lib/price-provider.server.ts app/lib/provider-socket.server.ts`
  returns nothing, and `matchKey` is defined once, in `price-provider.server.ts`. (Amended
  2026-09-25: the bare `prices.server` grep also matches a comment citing the module by name at
  `price-provider.server.ts:288`, which this change does not touch.)

**The probe**
- [ ] `PriceProvider` has `getQuotes`, `getDailyCloses` and `probe` with §2's signatures.
- [ ] `grep -rn "ProbeSymbols\|socketProbe" app tests` returns nothing.
- [ ] `ask("quotes"` appears once in `provider-socket.server.ts`, inside `quoteBatches`, and
  `PROBE_BUDGET_MS` and `BUDGET_MS.quotes` are each passed at exactly one call of `quoteBatches`.
- [ ] `probeVerdicts` is unchanged (`git diff origin/main -- app/lib/price-provider.server.ts`
  shows no line inside it changed).

**The default**
- [ ] `grep -rn "socketProvider()" app` returns only `defaultProvider`'s body and
  `socketProvider`'s own definition.

**The freshness module**
- [ ] `app/lib/price-freshness.server.ts` exports `priceFreshness` and `asOfView`; neither is
  defined or exported in `prices.server.ts`; the five routes import `asOfView` from it.

**Tests**
- [ ] §6's changes; every double in §5 has `probe`; the files §6 lists as unchanged are.

**Documentation**
- [ ] §7's edits and no others; the shipped specs §7 names are untouched.

**Gates**
- [ ] `npm run typecheck`, `npm test` (2431 passing, §6's count), `npm run build` clean.
- [ ] §8's differential: `diff -r` empty.

## Merged with `main` at `1e971f7`, 2026-09-25

\#390 (the trailing dividend rate) landed while this was in review and gave `PriceProvider` a
method of its own, `getTrailingDividend`. The merge keeps both: the interface has four methods, and
`probe` is the one this spec adds. `socketProvider()` implements all four; `getTrailingDividend`
asks `/dividends` per symbol, as `getDailyCloses` asks `/history`, and does not use the quote batch
loop. `prices.server.ts` imports #390's `DRIFT_EXTENSION_DAYS` and `TRAILING_WINDOW_DAYS` beside
`matchKey`. Every provider double carries both methods, including #390's new one in
`tests/dividend-sweep.test.ts`, which gains the same throwing `probe`. ARCHITECTURE.md reads "four"
where §7 said "three", and keeps #390's `selectDividendCandidates` exception beside the freshness
module in §4.2. Wherever this spec says "three methods", read four.

## Review findings rejected

Grounding review, two rounds. Round 1: twelve findings, two material, both folded in. The pure
verdict table already pinned `quoteType`, so it gains one row, not two, and the count is 2429.
§8 named a `daily_close` table that does not exist (`price_daily`, `price_backfill`). The minor
findings are folded in: the probe keeps `probeVerdicts` inside its per-batch `catch`, so it still
never throws; two more resolution stubs; §8's imports and copied helpers; the 502 case at `:513`;
the construction test as a two-row `it.each`; line drift. Round 2: six minor findings, all folded
in (case 4 split, since a non-USD sighting refuses the whole post before any write). Both rounds
walked §2's generator against today's two loops and found no observable difference.

Rejected: none. Round 1 raised a shared `probe`-throwing helper in `tests/support` as the one
simpler shape for §5's doubles. They stay local, as the suite keeps its provider doubles, and §5
says so.

Code review, two reviewers (correctness and concurrency; standards and shape), none blocking. The
correctness reviewer mutated the adapter in a scratch worktree: swapping the two budgets survived
every test, and so did a `getQuotes` that asked every batch before throwing. Both were unpinned on
`main` too, but this change puts each budget at its own call site, so both are now pinned in
`tests/provider-socket.test.ts`'s batch-loop describe: quotes ask with 15 s and the probe with 10 s
(`AbortSignal.timeout`, as the history-budget test does), and `getQuotes` fails on the first failed
batch having asked for no other. Folded in from the standards review: the header's doubled "and",
the default's comment trimmed, the probe's "never throws" stated once (on the interface),
`matchKey`'s citation made `DESIGN.md §4.3`, the §4.2 bullet saying `asOfView` renders what
`priceFreshness` reads, the diagram's column, one import order.

Rejected: *the batch-loop `it.each` branches on the method.* The two arms assert different shapes
(101 quotes; 101 `ok` verdicts), which is the point of running one loop through both.

