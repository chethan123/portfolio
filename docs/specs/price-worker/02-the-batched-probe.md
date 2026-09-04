# 02 — The batched probe

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.4)._

**What to build:** `ResolutionDeps.probe` becomes required and batched — one library call for every
feed symbol an upload creates, answered as a map of verdicts — with the verdict logic a pure
exported function that the Yahoo batch probe uses now and the socket probe
([06](06-the-app-cutover.md)) uses later. Issue #205's first item, on the code as it stands.

Its own ticket because the loop at `resolveAll` probes serially today, and over the socket each
call would be a round trip; the change touches the resolver, the probe, one route
and two test files, and none of that shares a line with [01](01-one-refresh-and-the-batch-abort.md)
or [03](03-the-three-hardening-rules.md).

**Blocked by:** Nothing. Parallel with [01](01-one-refresh-and-the-batch-abort.md) and
[03](03-the-three-hardening-rules.md); [04](04-the-price-worker-process.md) waits on it, since both
rewrite the probe's client and the describe at `tests/price-provider.test.ts:291`.

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
- [ ] When that collection is empty — a manual-only submission, the common case — the resolver
      returns an empty verdict map and **does not call `probe` at all**. Today's serial loop makes
      no provider call on that path (every plan fails the `create`/`feed` guard at `:502-505`), and
      the batched form must keep making none: a call of zero symbols is a round trip per manual
      upload, and over the socket the worker answers it `400` — one to a hundred symbols is the
      bound (spec §3.2), so the ask would be refused after a round trip it should never have made

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
      never throws (`:688`'s reason), and replaces `probeSymbol`. Its type replaces `ProbeSymbol`
      (`:649`): `export type ProbeSymbols = (symbols: string[]) => Promise<Map<string,
      SymbolProbe>>`, the shape `ResolutionDeps.probe` is declared with and the socket probe
      ([06](06-the-app-cutover.md)) is typed as
- [ ] `app/routes/upload/instruments.tsx:104-106` passes `{ probe: probeSymbols }` — the route names
      the dependency and states no rule

**Tests**

- [ ] `tests/routes/upload-instruments.test.ts:84` and `:162` pass a stub answering an empty map —
      both fixtures are `manual` (`:91`, `:169`), so today they only *happen* not to reach the
      network
- [ ] `tests/instrument-resolution.test.ts`'s `okProbe` (`:38`) and `forbiddenProbe` take the batch
      shape at every `resolveAll` site from `:99` (fourteen); the USD-probe cases (`:360`) gain two:
      three tickers, two strings each, cost one call carrying three symbols, with the verdicts on
      the right plans; and a manual-only submission resolves with a probe stub that was **never
      called** — the case that would otherwise become a worker call per upload
- [ ] `tests/price-provider.test.ts`: `probeVerdicts` — `ok` keyed by the asked symbol across a case
      difference, `non-usd` naming the currency, absent → `unavailable`, non-array → all
      `unavailable`. The describe at `:291` re-targets `probeSymbols` through the same client stub

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build` green
