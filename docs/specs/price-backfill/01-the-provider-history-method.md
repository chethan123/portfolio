# 01 — The provider's history method

_Part of [0017-price-backfill.md](../0017-price-backfill.md)._

**What to build:** A second method on `PriceProvider` in `app/lib/price-provider.server.ts` — one
symbol, one range, the market zone in, a closed set of answers out — and the `yahoo-finance2`
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
- [ ] `ProviderDailyClose` is `{ date: IsoDate; close: string }` — the close already un-adjusted
      for splits, scale 4, the figure the shares were worth on the day. The un-adjust happens here,
      in the pure conversion below, on `money.ts`'s units; the writer (ticket 03) inserts what it
      is handed and multiplies nothing
- [ ] `ProviderHistory` is a closed set in the shape `SymbolProbe` already uses (`:298-310`):
      `{ status: "ok"; closes: ProviderDailyClose[] }` with at least one close, or
      `{ status: "no-history" }`, `{ status: "non-usd"; currency: string }`,
      `{ status: "split-unresolved" }`. A call that fails throws; the caller records the text.
      The three refusals map one-to-one onto ticket 02's ledger outcomes (`no-history` →
      `no_history`, `non-usd` → `non_usd`, `split-unresolved` → `split_unresolved`) — a deliberate
      duplication, named as such where each vocabulary is declared (`docs/README.md:25`): one is
      the provider's answer in the form `SymbolProbe` uses, the other a `check` constraint's
      literal, and the mapping is one object in ticket 03's batch
- [ ] The module header's "single batched method" sentence (`:1-12`) now names two methods and says
      why history is one symbol per call: a range is per instrument, and the endpoint offers no
      batch for it

**The adapter** (`yahooPriceProvider`, `:371`)

- [ ] The memoised client's type (`:270`, `:283-291`) widens to name `chart(symbol, options)` beside
      `quote`; `tests/price-provider.test.ts:387`'s shape assertion — the client's method is
      callable, where the default export is a class whose statics throw — gains the same check for
      `chart`
- [ ] `yahooPriceProvider` takes the client the way `probeSymbol` does (`:332-335`), defaulting to
      `yahooClient`, so a test can hand it a client whose `chart` throws or answers a payload
- [ ] One `chart()` call per symbol, the symbol sent as `matchKey(symbol)` — trim and upper-case,
      `app/lib/prices.server.ts:174`, which is what `refreshQuotes` sends as its keys (`:235`);
      exported from there rather than moved, because the rule belongs beside the matcher that
      states it. The stored value is untouched. `period1` is `range.from` — the library parses a
      `YYYY-MM-DD` string to UTC midnight, which precedes any session open on that date; `period2`
      is left absent, and the library defaults it to the instant of the call (`chart.js` sets
      `period2 = new Date()` only when it is absent); `interval: "1d"`; `events: "split"` — the
      library's default is `"div|split|earn"` and dividends and earnings are neither read nor
      requested; `return` left at its default array form
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
      `instantOf` (`:175-187`) already parses every plausible shape; reuse the parsing but not the
      fallback. `instantOf` answers `fetchedAt` for a timestamp it cannot read, which is right for
      a quote — the price is real and the day is at worst hours late — and wrong for a bar, whose
      whole meaning is its day: a bar with an unreadable timestamp is skipped. Never a UTC
      truncation: daily bars are stamped at the session open, 13:30Z for NYSE, and truncation is
      right by accident
- [ ] Bars whose trading day is on or after `range.until` are dropped. Today's row is the poller's
      provisional row; the library's default `period2` is a cost optimisation and the market-date
      cut is the rule, the trust asymmetry `market-hours.ts`'s header states
- [ ] A bar with a missing, null or non-positive close is skipped, for the reason `toProviderQuote`
      skips one (`:203-210`); two bars filing under one trading day keep the later instant, because
      the library notes Yahoo inserts extra bars at event times
- [ ] Every close leaves through `decimal(value, 4)` (`:96`). Nothing leaves as a number
- [ ] The throw-versus-empty mapping: the library turns Yahoo's own
      `{ error: { code, description } }` into a throw whose message is Yahoo's `description` passed
      through verbatim, and whose class is chosen from the `code` — `code` with its spaces removed
      plus `Error`, looked up among the library's own error classes and falling back to a plain
      `Error` (`lib/yahooFinanceFetch.js:137-141` in yahoo-finance2 4.0.2). Only `"Bad Request"`
      maps to `BadRequestError`; an unknown symbol on the chart endpoint answers `"Not Found"`,
      which is a plain `Error`. So the class is not consulted: an unknown or delisted symbol ("No
      data found, symbol may be delisted") and a `period1` before the listing ("Data doesn't exist
      for startDate = …") both become `no-history` by matching the two stems on the message of
      *any* thrown error, never the sentence verbatim — the library's own example does the same
      (`chart.d.ts:112`, `error.message.includes('No data found')`, no class check). Any other
      throw propagates: the caller's ledger wants the text. A stem that does not match degrades
      gracefully — the ledger records `provider_failed` with the text, and the instrument is
      retried daily. A valid range with nothing in it returns `quotes: []`, which is `no-history`
      too, as is a response whose every close was skipped

**The un-adjust** (pure; exported as `toProviderHistory(raw: unknown, range, marketTimeZone)`)

- [ ] Each split's trading day is `marketDateOf(split.date, marketTimeZone)`, the same rule as a bar's
- [ ] A row's factor is the product of `numerator` over the product of `denominator` across every
      split whose trading day is later than the row's date, so a row before two splits carries both
      and a row between them carries the later one; a row on or after the last split carries `1/1`
- [ ] The products are computed with `BigInt` — integers, exact — and applied to the close on
      `money.ts`'s units, because this *is* money arithmetic and `money.ts` is where JavaScript-side
      money arithmetic goes (ARCHITECTURE.md §5.6): `render(divide(toUnits(close, 4) * n, d, 0), 4)`,
      with `toUnits(decimal, scale)` (`money.ts:41`) turning the scale-4 string into `BigInt` units
      of its last place, `divide(numerator, denominator, scale)` (`:70`) rounding half away from
      zero, and `render(units, scale)` (`:57`) reassembling the string. A row no split touches
      leaves as received. Never a float multiply
- [ ] A split whose numerator or denominator is not a positive integer, or whose date cannot be
      read, makes the whole answer `split-unresolved`: no closes for that instrument, rather than
      some rows right and some wrong
- [ ] A reverse split is the same arithmetic with the ratio the other way round and needs no case
      of its own

**The verification, once, against a real split**

- [ ] Before the un-adjust is trusted, call the real endpoint once, by hand and outside the suite —
      a one-off script or a REPL — for `NVDA` over a range spanning 2024-06-10 with `events:
      "split"`, and confirm two things: `events.splits` carries a 10:1 dated that day, and the
      closes for the week before it sit near $120 (adjusted) rather than near $1,200 (as struck).
      In the same sitting, call it for a symbol that does not exist and confirm which class the
      throw is — the mapping above does not depend on it, and the header should say what was seen
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
      the un-adjusted close is checkable by eye — a pre-split bar of `200.0000` leaves as
      `"800.0000"`; post-split rows and the row on the split's own day leave as received. Asserted
      as the resulting close string, never as a factor
- [ ] Two splits in range, 4:1 then 2:1: a bar before both of `100.0000` leaves as `"800.0000"`, a
      bar between them of `125.0000` as `"250.0000"`
- [ ] A reverse split, 1:10: a bar before it of `10.0000` leaves as `"1.0000"`
- [ ] A split with a zero denominator makes the answer `split-unresolved`
- [ ] A client whose `chart` throws a plain `Error` carrying either stem answers `no-history`, and
      so does one throwing the library's `BadRequestError` with it; one that throws anything else
      propagates it
- [ ] The client-shape assertion at `:387` covers `chart`
