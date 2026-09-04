# 02 — The batched probe

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.4)._

**What to build:** `ResolutionDeps.probe` becomes required and batched — one library call for every
feed symbol an upload creates, answered as a map of verdicts — with the verdict logic a pure
exported function that the Yahoo batch probe uses now and the mailbox probe
([07](07-the-app-cutover.md)) uses later. Issue #205's first item, on the code as it stands.

Its own ticket because the loop at `resolveAll` probes serially today, and under the mailbox each
call would be a round trip with a 3 s grace; the change touches the resolver, the probe, one route
and two test files, and none of that shares a line with [01](01-one-refresh-and-the-batch-abort.md)
or [03](03-the-two-hardening-rules.md).

**Blocked by:** Nothing. Parallel with [01](01-one-refresh-and-the-batch-abort.md),
[03](03-the-two-hardening-rules.md) and [04](04-the-mailbox-and-the-worker-role.md).

**Status:** ready-for-agent

**The resolver** (`app/lib/instrument-resolution.server.ts`)

- [ ] `ResolutionDeps.probe` (`:212-216`) becomes required: `probe(symbols: string[]) =>
      Promise<Map<string, SymbolProbe>>`, keyed by the symbol as asked. The import at `:20`, the `??
      probeSymbol` default at `:499` and `resolveAll`'s `deps: ResolutionDeps = {}` default (`:270`)
      all go — with the default kept, "required" would be a type and not a fact, and the production
      caller could still reach the network by omission
- [ ] The loop at `:502-525` collects every distinct feed symbol of the `create` plans, calls
      `probe` once, then applies the verdicts in plan order: `non-usd` refuses with today's sentence
      (`:515-524`), `ok` and `unavailable` behave as today, `quoteTypeOf` (`:533-537`) reads the
      same map, and a symbol the map lacks is `unavailable`

**The probe** (`app/lib/price-provider.server.ts`)

- [ ] The verdict logic of `probeSymbol` (`:665-694`) becomes a pure exported
      `probeVerdicts(symbols, raw: unknown, fetchedAt): Map<string, SymbolProbe>`: a non-array `raw`
      is empty (`:677`); each entry through `toProviderQuote`; an `ok` quote lands on the asked
      symbol whose `matchKey` equals `matchKey(quote.symbol)` — `refreshQuotes`'s rule
      (`prices.server.ts:805-809`); `CurrencyRefused` lands as `non-usd` on the symbol it names
      (`:170-182`); everything else is `unavailable`. Built on the raw entries and not on
      `getQuotes`, because the seam collapses a refusal into an absence by design (`:719-731`) and
      the probe needs the refusal named
- [ ] `probeSymbols(symbols, client = yahooClient)` is one `quote(symbols)` call plus that function,
      never throws (`:688`'s reason), and replaces `probeSymbol`
- [ ] `app/routes/upload/instruments.tsx:104-106` passes `{ probe: probeSymbols }` — the route names
      the dependency and states no rule

**Tests**

- [ ] `tests/routes/upload-instruments.test.ts:84` and `:162` pass a stub answering an empty map —
      both fixtures are `manual` (`:91`, `:169`), so today they only *happen* not to reach the
      network
- [ ] `tests/instrument-resolution.test.ts`'s `okProbe` (`:38`) and `forbiddenProbe` take the batch
      shape at every `resolveAll` site from `:99` (fourteen); the USD-probe cases (`:360`) gain one:
      three tickers, two strings each, cost one call carrying three symbols, and the verdicts land
      on the right plans
- [ ] `tests/price-provider.test.ts`: `probeVerdicts` — `ok` keyed by the asked symbol across a case
      difference, `non-usd` naming the currency, absent → `unavailable`, non-array → all
      `unavailable`. The describe at `:291` re-targets `probeSymbols` through the same client stub

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build` green
