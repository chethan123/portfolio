# 01 — The provider's history method

_Part of [0017-price-backfill.md](../0017-price-backfill.md)._

**What to build:** A second method on `PriceProvider` in `app/lib/price-provider.server.ts` — one
symbol, one date range, the market zone in, a closed set of answers out — and the `yahoo-finance2`
adapter behind it, using the client's `chart()` call. Everything numeric leaves as a decimal string,
every bar is filed under the trading day inside its own timestamp, a non-USD history is refused
before a figure is read, and the split-adjusted closes Yahoo returns are un-adjusted into what the
shares were actually worth on the day. The un-adjust is a pure translation, exported beside
`toProviderQuote` and tested the same way: no network, no database, a hand-written payload.

Its own ticket because it is the whole of the boundary between an unofficial endpoint and a
`numeric` column, and it is testable without either. It touches no schema and no write path, so
[02](02-the-ledger-and-the-gap-query.md) can be built beside it.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**The interface** (`app/lib/price-provider.server.ts:62-64`)

- [ ] `PriceProvider` gains `getDailyCloses(symbol: string, range: HistoryRange, marketTimeZone:
      string): Promise<ProviderHistory>` beside `getQuotes`. Required, not optional: a provider that
      cannot answer history is not this application's provider, and an optional method would let
      the write path skip a batch with nothing saying so
- [ ] `HistoryRange` is `{ from: IsoDate; until: IsoDate }`, `until` exclusive, `IsoDate` being
      `market-hours.ts:20`'s `YYYY-MM-DD`
- [ ] `ProviderDailyClose` is `{ date: IsoDate; close: string; splitNumerator: string;
      splitDenominator: string }` — the close as received, scale 4; the factor as two positive
      integers rendered as strings, `"1"` and `"1"` for a row no split touches. The writer
      (ticket 03) multiplies in SQL; this module never multiplies a close
- [ ] `ProviderHistory` is a closed set in the shape `SymbolProbe` already uses (`:298-310`):
      `{ status: "ok"; closes: ProviderDailyClose[] }` with at least one close, or
      `{ status: "no-history" }`, `{ status: "non-usd"; currency: string }`,
      `{ status: "split-unresolved" }`. A call that fails throws; the caller records the text
- [ ] The module header's "single batched method" sentence (`:1-12`) now names two methods and says
      why history is one symbol per call: a range is per instrument, and the endpoint offers no
      batch for it

**The adapter** (`yahooPriceProvider`, `:371`)

- [ ] The memoised client's type (`:270`, `:283-291`) widens to name `chart(symbol, options)` beside
      `quote`; `tests/price-provider.test.ts:393`'s shape assertion — the default export is a class
      whose statics throw — gains the same check for `chart`
- [ ] `yahooPriceProvider` takes the client the way `probeSymbol` does (`:332-335`), defaulting to
      `yahooClient`, so a test can hand it a client whose `chart` throws or answers a payload
- [ ] One `chart()` call per symbol, the symbol sent as stored (`refreshQuotes`'s rule): `period1`
      is `range.from` — the library parses a `YYYY-MM-DD` string to UTC midnight, which precedes
      any session open on that date; `period2` is the instant of the call; `interval: "1d"`;
      `events: "split"` — the library's default is `"div|split|earn"` and dividends and earnings
      are neither read nor requested; `return` left at its default array form
- [ ] `historical()` is not used: in yahoo-finance2 4.0.2 it is a wrapper that calls `chart()` with
      fixed options and adds nothing this needs
- [ ] The result is narrowed through Zod as `yahooQuote` narrows a quote (`:127-162`), reading
      only `meta.currency`, `events.splits[].date / numerator / denominator`, and
      `quotes[].date / close`; the library's own types describe what the endpoint returned when they
      were written, this describes what we require
- [ ] `meta.currency` present and not USD, compared as `:220` compares, answers `non-usd` before a
      figure is read; absent, the adapter proceeds, as the quote path does
- [ ] Each bar's trading day is `marketDateOf(instant, marketTimeZone)` of the bar's own
      timestamp — the library hands back a `Date`, the raw endpoint sends epoch seconds, and
      `instantOf` (`:175`) already accepts every plausible shape; reuse it. Never a UTC truncation:
      daily bars are stamped at the session open, 13:30Z for NYSE, and truncation is right by
      accident
- [ ] Bars whose trading day is on or after `range.until` are dropped. Today's row is the poller's
      provisional row; `period2` is a cost optimisation and the market-date cut is the rule, the
      trust asymmetry `market-hours.ts`'s header states
- [ ] A bar with a missing, null or non-positive close is skipped, for the reason `toProviderQuote`
      skips one (`:203-210`); two bars filing under one trading day keep the later instant, because
      the library notes Yahoo inserts extra bars at event times
- [ ] Every close leaves through `decimal(value, 4)` (`:96`). Nothing leaves as a number
- [ ] The throw-versus-empty mapping: the library turns Yahoo's own
      `{ error: { code: "Bad Request", description } }` into a `BadRequestError` whose message is
      Yahoo's description (`lib/yahooFinanceFetch.js` in the package). An unknown or delisted symbol
      ("No data found, symbol may be delisted") and a `period1` before the listing ("Data doesn't
      exist for startDate = …") both arrive this way and both become `no-history`, matched on the
      error's `name` and a stem of the message, never the sentence verbatim. Any other throw
      propagates: the caller's ledger wants the text. A valid range with nothing in it returns
      `quotes: []`, which is `no-history` too, as is a response whose every close was skipped

**The un-adjust** (pure; exported as `toProviderHistory(raw: unknown, range, marketTimeZone)`)

- [ ] Each split's trading day is `marketDateOf(split.date, marketTimeZone)`, the same rule as a bar's
- [ ] A row's factor is the product of `numerator` over the product of `denominator` across every
      split whose trading day is later than the row's date, so a row before two splits carries both
      and a row between them carries the later one; a row on or after the last split carries `1/1`
- [ ] The products are computed with `BigInt` — integers, exact — and emitted as decimal integer
      strings. The close itself is never multiplied here; `money.ts` is not needed because nothing
      here is money arithmetic
- [ ] A split whose numerator or denominator is not a positive integer, or whose date cannot be
      read, makes the whole answer `split-unresolved`: no closes for that instrument, rather than
      some rows right and some wrong
- [ ] A reverse split is the same arithmetic with the ratio the other way round and needs no case
      of its own

**The verification, once, against a real split**

- [ ] Before the un-adjust is trusted, call the real endpoint once, by hand and outside the suite —
      a one-off script or a REPL — for `NVDA` over a range spanning 2024-06-10 with `events:
      "split"`, and confirm two things: `events.splits` carries a 10:1 dated that day, and the
      closes for the week before it sit near $120 (adjusted) rather than near $1,200 (as struck)
- [ ] Record the result in the adapter's header: the date checked, the installed library version
      (`package.json` pins `^4.0.2`; record what `node_modules` held), and the convention observed.
      Module headers carry the reasoning for non-obvious code, and this is the one fact the
      arithmetic stands on
- [ ] If the closes are adjusted, the un-adjust above ships as written
- [ ] If they are not — or are adjusted some other way — the fallback rule fixed by the spec
      applies: `toProviderHistory` answers `split-unresolved` for any response carrying a split
      whose trading day is inside the range, emits closes as received for everything else, and the
      header says so. The rest of the batch is unaffected; mutual funds essentially never split
- [ ] Ticket 05's recipe in `docs/developing.md` tells the next person how to repeat this after a
      library upgrade; this ticket only has to leave the header saying what was checked

**Fakes**

- [ ] Every fake `PriceProvider` in the suite gains the method or the suite stops typechecking —
      `tests/refresh-quotes.test.ts:33-64` and `tests/price-poller.test.ts:54` are the ones today.
      Here they may answer `no-history`, since nothing calls the method yet; ticket 03 makes them
      answer what a test states
- [ ] A fake returns what the test says and does not correct it — the reasoning at
      `tests/refresh-quotes.test.ts:25-31` holds for history as it does for quotes

**Tests** (`tests/price-provider.test.ts`, beside `toProviderQuote`'s cases; no database, no network)

- [ ] A close arrives as a scale-4 decimal string, never a number
- [ ] The trading day is the market-zone date of the bar's instant: a bar stamped at 02:00Z files
      under the previous New York date
- [ ] A bar on `range.until` is dropped; one the day before is kept
- [ ] A null close produces no row; a response of nothing but null closes is `no-history`
- [ ] A non-USD `meta.currency` answers `non-usd` naming the currency, and no close is read
- [ ] The hand-written split response: bars before and after one 4:1 split, with figures chosen so
      the factor is checkable by eye — pre-split rows carry `4/1`, post-split rows `1/1`, the row on
      the split's own day `1/1`
- [ ] Two splits in range, 4:1 then 2:1: rows before both carry `8/1`, rows between carry `2/1`
- [ ] A reverse split, 1:10, carries `1/10` on the rows before it
- [ ] A split with a zero denominator makes the answer `split-unresolved`
- [ ] A client whose `chart` throws a `BadRequestError` with the no-data stem answers `no-history`;
      one that throws anything else propagates it
- [ ] The client-shape assertion at `:393` covers `chart`
