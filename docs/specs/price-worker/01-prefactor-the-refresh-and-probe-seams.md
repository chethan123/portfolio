# 01 — The prefactor: one refresh, a provider factory, a batched probe

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.1, §3.4)._

**What to build:** Four refactors and two hardening rules on the code as it stands, all against the
existing Yahoo adapter, so that the cutover in [05](05-the-app-cutover.md) becomes "swap the
provider, delete the client use". (a) `runRefresh({ quotes }, makeProvider)` in a new
`app/lib/refresh.server.ts` owns the lock, builds one provider per refresh from a factory, runs
`refreshPrices` and maps the result to the outcome the control renders; the route, the poller's
tick and `requestRefresh` become thin callers (issue #159). (b) The poller holds a provider
*factory*, not an instance. (c) `ResolutionDeps.probe` becomes required and batched over one
library call (issue #205's first item). (d) A named `ProviderUnreachable` that `backfillCloses`
treats as a batch abort with nothing ledgered. (e) A price ceiling in `toProviderQuote`, and a
refusal to write a `price_daily` close more than seven days old through the quote path.

Its own ticket because every piece typechecks and tests against `yahooPriceProvider()` today, and
the two hardening rules guard against an honest provider's bad day as much as against a hostile
worker. The cutover then changes one factory and one probe.

**Blocked by:** Nothing. Parallel with [02](02-the-mailbox-and-the-worker-role.md).

**Status:** ready-for-agent

**`runRefresh`** (`app/lib/refresh.server.ts`, new)

- [ ] `runRefresh({ quotes }, makeProvider = liveProvider): Promise<RefreshRun>` wraps
      `withRefreshLock(() => refreshPrices(makeProvider(), getConfig().MARKET_TIMEZONE, { quotes },
      getDb()))`: `null` is `{ status: "busy" }`, a throw is logged with the stem the route uses
      today (`app/routes/refresh.ts:83`) and becomes `{ status: "error" }`, a report is
      `{ status: "done", report }`. `outcomeOf(run): RefreshOutcome` projects `report.quotes` as the
      route does now (`:74-81`). The default factory is `() => yahooPriceProvider()`, in this one
      place; [05](05-the-app-cutover.md) changes it
- [ ] The route (`refresh.ts:58-86`) becomes `outcomeOf(await runRefresh({ quotes: true }))`; the
      redirect rule at `:45-47` is untouched. `RefreshOutcome` (`:21-33`) moves to the new module
      and `app/components/price-freshness.tsx:16` imports the type from there — the one
      `lib → routes` import in the tree, gone
- [ ] The poller's tick (`app/lib/price-poller.server.ts:127-147`) and `requestRefresh` (`:245-259`)
      call `runRefresh`; the market-hours decision (`:114`) and the cadence read (`:119-123`) stay
      the poller's — #159's constraint — and its two log lines (`:139-146`) are written from the
      run's report exactly as today. Neither caller constructs a provider afterwards

**The provider factory** (`app/lib/price-poller.server.ts`)

- [ ] `PollerState.provider` (`:59-72`) becomes `makeProvider: () => PriceProvider`;
      `startPricePoller(makeProvider = () => yahooPriceProvider())` (`:193`) stores it and every
      tick hands it to `runRefresh`, which calls it once. Why: a per-handle unreachability flag
      (spec §3.3) on a process-lifetime instance would flip once and never recover
- [ ] `tests/price-poller.test.ts` passes `() => fake` where it passed the fake (`:55` builds it);
      one new case asserts the factory is called once per tick and once per `requestRefresh`

**The batched probe** (`instrument-resolution.server.ts`, `price-provider.server.ts`)

- [ ] `ResolutionDeps.probe` (`app/lib/instrument-resolution.server.ts:212-216`) becomes required:
      `probe(symbols: string[]) => Promise<Map<string, SymbolProbe>>`, keyed by the symbol as asked.
      The import at `:20` and the `?? probeSymbol` default at `:499` go
- [ ] The loop at `:502-525` collects every distinct feed symbol of the `create` plans, calls
      `probe` once, then applies the verdicts in plan order: `non-usd` refuses with today's sentence
      (`:515-524`), `ok` and `unavailable` behave as today, `quoteTypeOf` (`:533-537`) reads the
      same map, and a symbol the map lacks is `unavailable`
- [ ] The verdict logic of `probeSymbol` (`app/lib/price-provider.server.ts:665-694`) becomes a
      pure exported `probeVerdicts(symbols, raw: unknown, fetchedAt): Map<string, SymbolProbe>`: a
      non-array `raw` is empty (`:677`); each entry through `toProviderQuote`; an `ok` quote lands
      on the asked symbol whose `matchKey` equals `matchKey(quote.symbol)` — `refreshQuotes`'s rule
      (`prices.server.ts:805-809`); `CurrencyRefused` lands as `non-usd` on the symbol it names
      (`:170-182`); everything else is `unavailable`. `probeSymbols(symbols, client = yahooClient)`
      is one `quote(symbols)` call plus that function, never throws (`:688`'s reason), and replaces
      `probeSymbol`
- [ ] `app/routes/upload/instruments.tsx:104-106` passes `{ probe: probeSymbols }`;
      `tests/routes/upload-instruments.test.ts:84` and `:162` pass a stub answering an empty map —
      both fixtures are `manual` (`:91`, `:169`), so today they only *happen* not to reach the network
- [ ] `tests/instrument-resolution.test.ts`'s `okProbe` (`:38`) and `forbiddenProbe` take the batch
      shape at every `resolveAll` site from `:99`; the USD-probe cases (`:360`) gain one: three tickers, two strings each, cost one
      call carrying three symbols

**`ProviderUnreachable` and the batch abort**

- [ ] `export class ProviderUnreachable extends Error` beside `PriceProvider`
      (`price-provider.server.ts:155-162`), its message operator-facing; the Yahoo adapter never
      throws it
- [ ] `backfillCloses` (`prices.server.ts:548`) catches it from `getDailyCloses` ahead of the
      per-candidate ledger write (`:567-587`), wraps it in `BackfillBatchFailed` (`:501-509`) with
      the partial report and rethrows; the composition's catch (`:684-703`) logs it with the cause
      and returns `batchFailed: true`. The attempt in flight and every candidate after it get no
      ledger row, so the retry clock (`:306-316`) is not charged for a dead worker

**The two hardening rules**

- [ ] `PRICE_CEILING = 10 ** 16` beside `CLOSE_CEILING` (`price-provider.server.ts:219`), applied
      in `toProviderQuote` through `inRange` (`:231`): a price at or over it is dropped, not
      clamped, so the quote is `null` and the symbol goes stale. The docstring names the reader that
      would overflow (`migrations/0006_annual_dividend.sql:149`, its header `:53-61`)
- [ ] The close write (`writeDailyClose`, `prices.server.ts:931-950`, called at `:821-827`) is
      skipped — no insert, no update — when the quote's market date is more than seven days before
      today's market date in `marketTimeZone`; the quote and the observation still land. The
      constant sits beside `BACKFILL_RANGE_LEAD_DAYS` (`:106`) with the reasoning: the quote path is
      keyed by `regularMarketTime` (`:944-947`) and ADR-0011's immutability covers only the backfill
      writer. One `console.warn` per refresh naming the skipped instruments; the module header's
      account of which past rows a refresh can rewrite is updated with it

**Tests**

- [ ] `tests/refresh.test.ts` (new): `runRefresh` with a fake provider answers `done` with the
      quotes' counts; `busy` while a second `pg` client (`createPool(TEST_DATABASE_URL)`, the
      pattern `tests/price-poller.test.ts:104` builds on) holds the advisory lock; `error` when the
      factory throws. The route's own test comes with [05](05-the-app-cutover.md)
- [ ] `tests/price-provider.test.ts`: `probeVerdicts` — `ok` keyed by the asked symbol across a case
      difference, `non-usd` naming the currency, absent → `unavailable`, non-array → all
      `unavailable`; a `regularMarketPrice` at the ceiling yields `null`, one below it a string
- [ ] `tests/refresh-quotes.test.ts`: with `vi.useFakeTimers`, a fake quote struck eight days before
      today's market date writes `quote` and the observation but no `price_daily` row, and leaves a
      seeded row for that day byte-identical; one struck seven days before writes the close
- [ ] `tests/price-backfill.test.ts`: a fake throwing `ProviderUnreachable` on the second of three
      candidates leaves the first's ledger row, none for the other two, and `refreshPrices`
      reporting `batchFailed: true` with one attempt counted

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build` green
