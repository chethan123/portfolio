# 04 — App cutover: the app stops fetching

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.4)._

**What to build:** The release where the app stops fetching. One new app module implementing an
interface the app already injects, and two call sites that swap which implementation they construct.
The app keeps an egress route it no longer uses — ticket 05 takes it away, and splitting them is
what makes each a diff you can hold in your head and revert on its own.

**How small the app change is, is the point.** `refreshPrices`, `refreshQuotes`, `backfillCloses`,
`selectBackfillCandidates`, `withRefreshLock`, `requestRefresh`, `app/root.tsx` and the route's
outcome union are all **untouched**. If this ticket's diff reaches into `prices.server.ts`, the seam
is in the wrong place.

**Blocked by:** 03 (the worker must already be running and proven, or this commit deploys an
instance with no price refresh).

**Status:** ready-for-agent

**The one new module**

- [ ] `app/lib/price-mailbox.server.ts` exports `mailboxPriceProvider(budget)` returning a
      `PriceProvider` (`price-provider.server.ts:155-162`) and `mailboxProbeSymbol(budget)`
      returning a `ProbeSymbol` (`:649`). Each call inserts a `fetch_request`, polls it (~100 ms),
      and returns the parsed payload — throwing for the two provider methods, and returning
      `{ status: "unavailable" }` for the probe, whose contract is never to throw (`:688-693`).
- [ ] **One shared deadline budget per invocation, not per call.** A refresh makes up to six calls
      (one `getQuotes`, up to `BACKFILL_BATCH_SIZE` = 5 `getDailyCloses`, `prices.server.ts:87`) and
      ingest probes sequentially (`instrument-resolution.server.ts:502-511`). Per-call deadlines
      stack: against a dead worker one press would cost six timeouts and six new symbols six more.
      One budget per `refreshPrices` invocation and one per `resolveAll`; once spent, later calls
      fail immediately. One helper serves both — do not write two poll loops.
- [ ] **The app does not trust the payload.** Re-parse every answer with a Zod schema for
      `ProviderQuote[]` / `ProviderHistory` / `SymbolProbe` before it reaches `prices.server.ts`. A
      compromised worker is then exactly as trusted as Yahoo, which is the honest bar.
- [ ] **`asOf` and `fetchedAt` are `Date` objects** (`price-provider.server.ts:88-99`) and JSON makes
      them strings. `prices.server.ts:1039` calls `quote.asOf.toISOString()` and `:941`/`:1045` pass
      it to `marketDateOf(instant: Date, …)`, whose `partsIn` (`market-hours.ts:67-68`) then throws
      `RangeError: Invalid time value`. `observationsOf` runs first inside the transaction (`:816`),
      so the throw happens before anything is written and lands *outside* `refreshPrices`'s try
      (`:684`) — the household sees "Price refresh failed", not a stale feed. Use `z.coerce.date()`
      and pin a round trip in a test.
- [ ] **Decide what happens to `ProviderQuote.payload`** — an *optional* `unknown` (`:107`), Yahoo's
      raw entry (`:381`), which the app archives verbatim into `price_observation.payload`,
      append-only and never pruned (`migrations/0009_price_observation.sql:134`). Two things follow.
      `JSON.stringify` drops an `undefined` key, so the schema must mark it optional — the module
      records that Zod 4 trap in its own words at `:401-406`. And it is an unbounded permanent write
      channel for a worker holding no grant, so bound its size at the boundary or drop it there on
      the grounds that a proxied answer is no longer "what Yahoo said". Say which; the ADR carries
      the residual.
- [ ] **Filter the batch; never refuse the call.** `getQuotes` carries every feed instrument in one
      row (`prices.server.ts:794`), so one `BRK/B` or `CASH SWEEP` — both reachable, since app-side
      validation is length-only (`instrument-resolution.server.ts:308-312`) and `matchKey` only
      trims and upper-cases (`:733`) — would violate `symbols_fetchable` for the whole array, fail
      the insert, throw out of `getQuotes`, and mark **every** instrument stale with `providerFailed`
      on every tick until someone edits that symbol. Drop offenders from the batch and let those
      instruments go stale individually, which is what the existing per-instrument stale path is
      for. A test seeds one bad symbol among good ones and asserts the good ones price.
- [ ] **Chunk `getQuotes` at 500 symbols.** `refreshQuotes` sends every feed instrument in one call
      and the table caps `symbols` at 500, so a household past the cap would see every refresh fail
      permanently on a constraint violation dressed up as `providerFailed`. Chunk and concatenate —
      the batched call was an optimisation, not a contract.
- [ ] **`getDailyCloses` passes `marketTimeZone` and the row must carry it.** Letting the worker
      substitute its own `MARKET_TIMEZONE` makes a divergence between two separately interpolated
      environment variables a silent wrong-day error — the class ADR-0011 exists to prevent.
- [ ] **The sweep runs once per budget**, not once per call: `createDraft`'s precedent
      (`uploads.server.ts:207-210`) sweeps on a rare human action, and sweeping before each of six
      provider calls is six DELETEs a tick. It belongs in the helper that creates the budget.
- [ ] **The money schema must reject non-finite decimals.** `'NaN'` is a valid `numeric(20,4)`, and
      `money.ts:47` throws `Cannot convert NaN0000 to a BigInt` on it — one fabricated payload would
      500 every screen. Money crosses as decimal strings (`ProviderDailyClose = { date, close:
      string }`, `price-provider.server.ts:110-120`); pin that a JSON *number* is refused rather
      than coerced, and that `NaN`/`Infinity` are refused.

**The two swaps, and nothing else**

- [ ] `refresh.ts:14`/`:67` constructs a provider per press, so it substitutes directly
- [ ] **The poller's seam changes shape, and it is the one existing test file this ticket touches.**
      `startPricePoller(provider: PriceProvider = yahooPriceProvider())`
      (`price-poller.server.ts:193`) stores the provider on the poller state (`:201-206`), is
      idempotent (`:195`), and every tick reuses `state.provider` (`:129`) — so a
      `mailboxPriceProvider(budget)` there holds **one budget for the life of the container**. The
      first worker outage spends it and every later tick then fails immediately, for ever, against a
      healthy worker, with the household told only that the feed could not be reached. The parameter
      becomes a factory:
      `startPricePoller(makeProvider: () => PriceProvider = () => mailboxPriceProvider(newBudget()))`,
      with `tick` calling it. The five sites in `tests/price-poller.test.ts` (`:160`, `:290`, `:369`,
      `:402`, `:444`) each become `startPricePoller(() => provider)` — one line apiece, fake still
      injected.
- [ ] `ResolutionDeps.probe` becomes required: the `probeSymbol` import and `?? probeSymbol` default
      are deleted from `instrument-resolution.server.ts:20,499`;
      `app/routes/upload/instruments.tsx:104` passes the mailbox probe;
      `tests/routes/upload-instruments.test.ts:84,162` (which call `resolveAll` with no deps) get a
      stub
- [ ] Nothing in the app's module graph value-imports `price-provider.server.ts` afterwards
- [ ] **No new outcome variant.** `backfillCloses` already ledgers a per-instrument provider throw
      as `providerFailed` and continues (`prices.server.ts:537-540`); `refreshQuotes` already maps a
      throw to `RefreshReport.providerFailed`. So `refresh.ts:21-33` and its renderer
      (`app/components/price-freshness.tsx:71`) are untouched and the household reads "the feed could
      not be reached", which is true. Telling "worker down" from "Yahoo down" is an operator
      question — it goes in the log line and the runbook entry (ticket 05).

**The one comment this ticket owns in `prices.server.ts`**

- [ ] `prices.server.ts:562-565` says "the span to the commit is how long the provider took", which
      stops being true once the span includes a mailbox round trip. Nothing computes from it — the
      retry clock is a point comparison (`:314`) — so this is a comment fix, and CLAUDE.md makes the
      header the authority nearest the code. It is the sole exception to "this ticket does not touch
      `prices.server.ts`".

**Gates

- [ ] `npm run typecheck`, `npm test`, `npm run build`, `scripts/smoke-test.sh` green
