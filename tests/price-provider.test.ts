/**
 * The boundary between an unofficial API and a `numeric` column.
 *
 * Everything here exercises `toProviderQuote`, which is the whole of the
 * translation: what arrives is a JSON object shaped however Yahoo felt like
 * shaping it, and what leaves is decimal strings the write path can hand
 * straight to Postgres. No network, no database — the point of the seam
 * DESIGN.md §6.1 mandates is that this can be tested without either.
 *
 * The yield cases are the ones that matter most. A hundredfold error in
 * `yield_pct` produces an Income page where every figure is individually
 * plausible and the total is nonsense, with nothing in the logs.
 */
import { describe, expect, it } from "vitest";

import {
  CurrencyRefused,
  probeSymbols,
  probeVerdicts,
  toProviderHistory,
  toProviderQuote,
  yahooPriceProvider,
  type HistoryRange,
} from "~/lib/price-provider.server";

import type { ChartRequest, YahooClient } from "../server/yahoo-client.ts";

/** The fetch time, for the fallback path. Fixed so assertions can name it. */
const FETCHED_AT = new Date("2026-06-05T18:00:00Z");

const quoteFor = (raw: Record<string, unknown>) => toProviderQuote(raw, FETCHED_AT);

describe("reading a price", () => {
  it("returns money as a decimal string at scale 4, never a number", () => {
    const quote = quoteFor({ symbol: "VTI", regularMarketPrice: 271.5, currency: "USD" });

    expect(quote?.price).toBe("271.5000");
    expect(typeof quote?.price).toBe("string");
  });

  it("carries the provider's own quote type through unchanged", () => {
    // Theirs, not ours — §4.1 stores it unconstrained for exactly this reason.
    const quote = quoteFor({ symbol: "VTSAX", regularMarketPrice: 130, quoteType: "MUTUALFUND" });

    expect(quote?.quoteType).toBe("MUTUALFUND");
  });

  it("declines a payload with no price rather than inventing one", () => {
    // Yahoo drops delisted and unknown symbols. The caller's answer is to keep
    // the last known price and mark it stale, which needs no quote at all.
    expect(quoteFor({ symbol: "DELISTED", currency: "USD" })).toBeNull();
  });

  it("declines a payload it does not recognise", () => {
    expect(quoteFor({ nothing: "useful" })).toBeNull();
  });
});

describe("the yield unit hazard", () => {
  it("reads dividendYield as the percentage it is", () => {
    // 2.34 means 2.34%, and must not be multiplied or divided by a hundred on
    // the way to a `numeric(10,6)` column.
    const quote = quoteFor({
      symbol: "SCHD",
      regularMarketPrice: 100,
      dividendYield: 2.34,
    });

    expect(quote?.yieldPct).toBe("2.340000");
  });

  it("ignores trailingAnnualDividendYield even when it is the only yield offered", () => {
    // The field carries the same quantity as a fraction while the library's own
    // doc comment calls it a percentage. Reading it would put 0.0234 into a
    // column whose other rows hold 2.34. Deriving from the rate is preferred
    // precisely because it cannot be misread.
    const quote = quoteFor({
      symbol: "AMBIGUOUS",
      regularMarketPrice: 100,
      trailingAnnualDividendYield: 0.0234,
    });

    expect(quote?.yieldPct).toBeNull();
  });

  it("derives the yield from the rate and the price when no percentage is given", () => {
    // $2.50 a share against a $100 price is 2.5%. Both operands are in the
    // quote's own currency, so the unit cannot be mistaken.
    const quote = quoteFor({
      symbol: "DIVIDEND",
      regularMarketPrice: 100,
      dividendRate: 2.5,
    });

    expect(quote?.yieldPct).toBe("2.500000");
    expect(quote?.annualDividendPerShare).toBe("2.5000");
  });

  it("reports no yield rather than dividing by zero", () => {
    const quote = quoteFor({ symbol: "ZERO", regularMarketPrice: 0, dividendRate: 2.5 });

    // A zero price is not a price at all, so there is no quote to carry a yield.
    expect(quote).toBeNull();
  });

  it("prefers dividendYield when both yield fields disagree", () => {
    // The fixture the whole hazard is about: both present, mutually
    // inconsistent, and only one of them right. A future edit reaching for the
    // fraction gets 0.0234 here instead of 2.34.
    const quote = quoteFor({
      symbol: "BOTH",
      regularMarketPrice: 100,
      dividendYield: 2.34,
      trailingAnnualDividendYield: 0.0234,
    });

    expect(quote?.yieldPct).toBe("2.340000");
  });

  it("drops a derived yield too large for the column rather than losing the batch", () => {
    // $2.50 a share against a $0.02 price is 12500%, and `yield_pct` is
    // numeric(10,6) — max 9999.999999. Postgres answers an overflow by aborting
    // the statement, and the statement is inside the refresh transaction, so one
    // mispriced listing would roll back every other instrument's price and the
    // stale-marking with it.
    const quote = quoteFor({ symbol: "DISTRESSED", regularMarketPrice: 0.02, dividendRate: 2.5 });

    expect(quote?.price).toBe("0.0200");
    expect(quote?.yieldPct).toBeNull();
    // The per-share amount is a real figure and stays. $2.50 against the widest
    // legal quantity is 2.5 × 10^12, nowhere near the money column's 10^16, so
    // dropping it would trade a true rate for a $0 lower bound and buy nothing.
    expect(quote?.annualDividendPerShare).toBe("2.5000");
  });

  it("drops a per-share rate too large for its own column, as it does a yield", () => {
    // The asymmetry migration 0006 turned into a hazard. `yield_pct` has been
    // bounded since it was added; `annual_dividend_per_share` was written
    // straight through, and it is `numeric(20, 4)` in the same transaction — so
    // a provider answering with a figure that is not a rate would abort the
    // refresh and roll back every other instrument's price, the exact loss the
    // yield ceiling above exists to prevent.
    //
    // Sixteen integer digits is the first figure the column cannot hold.
    const quote = quoteFor({
      symbol: "GARBAGE",
      regularMarketPrice: 100,
      dividendRate: 1e16,
    });

    // The price is real and is kept: one unusable field does not discard a quote.
    expect(quote?.price).toBe("100.0000");
    expect(quote?.annualDividendPerShare).toBeNull();
    // Null, never clamped — a rate at the ceiling would read on the Holdings
    // table as a projected payout somebody could act on.
    expect(quote?.yieldPct).toBeNull();
  });

  it("keeps a rate that sits just inside the column", () => {
    // The ceiling bounds what cannot be stored and nothing else. A guard that
    // rounded honest data away would be the more expensive bug of the two.
    const quote = quoteFor({
      symbol: "WIDE",
      regularMarketPrice: 1e15,
      dividendRate: 9e15,
    });

    expect(quote?.annualDividendPerShare).toBe("9000000000000000.0000");
  });

  it("reads an ETF's dividend from trailingAnnualDividendRate", () => {
    // An ETF payload carries no `dividendRate` — that field is declared on
    // equities and mutual funds only. Reading just it leaves every ETF in a
    // taxable brokerage account with a null annual dividend.
    const quote = quoteFor({
      symbol: "VTI",
      quoteType: "ETF",
      regularMarketPrice: 271.5,
      trailingAnnualDividendRate: 3.39,
    });

    expect(quote?.annualDividendPerShare).toBe("3.3900");
    // And it derives the yield from the same figure: 3.39 / 271.5 * 100.
    expect(quote?.yieldPct).toBe("1.248619");
  });

  it("reports no yield when the provider offers neither field", () => {
    // Ordinary: a growth fund pays nothing. Null, never zero — §8.2's rule is
    // to label coverage, and a zero would claim the fund pays no dividend
    // rather than that nobody said.
    const quote = quoteFor({ symbol: "GROWTH", regularMarketPrice: 42 });

    expect(quote?.yieldPct).toBeNull();
    expect(quote?.annualDividendPerShare).toBeNull();
  });
});

describe("the currency guard", () => {
  it("refuses a quote that is not in USD", () => {
    // §6.1: the guard exists so a foreign listing cannot silently sum GBP into
    // a USD total. There is no currency column to store the difference in.
    expect(() => quoteFor({ symbol: "VOD.L", regularMarketPrice: 71.5, currency: "GBP" })).toThrow(
      CurrencyRefused,
    );
  });

  it("names the symbol and the currency in the refusal", () => {
    try {
      quoteFor({ symbol: "VOD.L", regularMarketPrice: 71.5, currency: "GBp" });
      expect.unreachable("the guard should have refused this");
    } catch (error) {
      expect(error).toBeInstanceOf(CurrencyRefused);
      expect((error as CurrencyRefused).symbol).toBe("VOD.L");
      expect((error as CurrencyRefused).currency).toBe("GBP");
    }
  });

  it("accepts a quote whose currency is absent, since USD is the only thing stored", () => {
    // Not every payload carries a currency. Refusing on absence would stop
    // pricing an instrument over a field nobody promised.
    expect(quoteFor({ symbol: "VTI", regularMarketPrice: 271.5 })?.price).toBe("271.5000");
  });
});

describe("the instant a price was struck", () => {
  it("takes the provider's own timestamp when it is a date", () => {
    const struck = new Date("2026-06-05T20:00:00Z");
    const quote = quoteFor({ symbol: "VTI", regularMarketPrice: 271.5, regularMarketTime: struck });

    expect(quote?.asOf).toEqual(struck);
  });

  it("reads epoch seconds, which is what the raw endpoint sends", () => {
    const quote = quoteFor({
      symbol: "VTI",
      regularMarketPrice: 271.5,
      regularMarketTime: 1780689600,
    });

    expect(quote?.asOf.toISOString()).toBe("2026-06-05T20:00:00.000Z");
  });

  it("falls back to the fetch time rather than inventing a trading day", () => {
    // Safe rather than lossy: the quote is being written now, so "now" is at
    // worst a few hours late on a NAV, and it never files a price under a day
    // the market did not trade.
    const quote = quoteFor({
      symbol: "VTI",
      regularMarketPrice: 271.5,
      regularMarketTime: "not a date",
    });

    expect(quote?.asOf).toEqual(FETCHED_AT);
  });

  it("carries when we learned the price alongside when it was struck", () => {
    const struck = new Date("2026-06-05T20:00:00Z");
    const quote = quoteFor({ symbol: "VTI", regularMarketPrice: 271.5, regularMarketTime: struck });

    // Two different facts, and the observation log files under the first while
    // recording the second (ADR-0006). A seam carrying only one of them would
    // make an evening NAV indistinguishable from a morning fetch of it.
    expect(quote?.asOf).toEqual(struck);
    expect(quote?.fetchedAt).toEqual(FETCHED_AT);
  });
});

describe("the raw entry kept for the archive", () => {
  it("hands back the entry as it arrived, not the fields this module reads", () => {
    const raw = {
      symbol: "VTI",
      regularMarketPrice: 271.5,
      currency: "USD",
      // Neither of these is in the schema above, and that is the point: the
      // archive exists for what the typed parse throws away (ADR-0006).
      marketState: "REGULAR",
      fiftyTwoWeekHigh: 280.1,
    };

    expect(quoteFor(raw)?.payload).toEqual(raw);
  });

  it("archives nothing for an entry it refused, because there is no quote to archive it against", () => {
    // The rule stated the other way round: a payload is stored only when the
    // typed parse succeeded, so a shape change stays a refusal rather than
    // becoming a stored surprise.
    expect(quoteFor({ nothing: "useful" })).toBeNull();
    expect(quoteFor({ symbol: "DELISTED", currency: "USD" })).toBeNull();
  });
});

describe("probeVerdicts — the verdict logic a batched probe answers with", () => {
  it("lands an ok verdict on the asked symbol across a case difference", () => {
    // The provider echoes its own spelling; the verdict must key on what was
    // asked, `refreshQuotes`'s own matching rule, or a caller's map lookup by
    // its own symbol would miss.
    const verdicts = probeVerdicts(
      ["vti"],
      [{ symbol: "VTI", regularMarketPrice: 271.5, currency: "USD" }],
      FETCHED_AT,
    );

    expect(verdicts).toEqual(new Map([["vti", { status: "ok", quoteType: null }]]));
  });

  it("answers both spellings when one ticker was asked for twice", () => {
    // Two rows of a statement can name one ticker two ways. Each used to be
    // probed on its own and each got the answer; batched, one entry has to
    // serve both asked symbols, or the second instrument is created with no
    // quote type for a ticker the feed answered perfectly well.
    const verdicts = probeVerdicts(
      ["vti", "VTI"],
      [{ symbol: "VTI", regularMarketPrice: 271.5, currency: "USD", quoteType: "ETF" }],
      FETCHED_AT,
    );

    expect(verdicts).toEqual(
      new Map([
        ["vti", { status: "ok", quoteType: "ETF" }],
        ["VTI", { status: "ok", quoteType: "ETF" }],
      ]),
    );
  });

  it("names the currency a CurrencyRefused carries, on the symbol it names", () => {
    const verdicts = probeVerdicts(
      ["VOD.L"],
      [{ symbol: "VOD.L", regularMarketPrice: 71.5, currency: "GBp" }],
      FETCHED_AT,
    );

    expect(verdicts).toEqual(new Map([["VOD.L", { status: "non-usd", currency: "GBP" }]]));
  });

  it("leaves a symbol unavailable when the only entry names a ticker nobody asked about", () => {
    // The rule batching newly needs: serially the feed could only answer
    // about the symbol in front of it, so any usable entry was that symbol's.
    // One answer must not be spent on whichever symbol was asked first, or a
    // refusal lands on an instrument the feed never spoke about.
    const verdicts = probeVerdicts(
      ["VTI", "VWRL"],
      [{ symbol: "ZZZ", regularMarketPrice: 1, currency: "GBp" }],
      FETCHED_AT,
    );

    expect(verdicts).toEqual(
      new Map([
        ["VTI", { status: "unavailable" }],
        ["VWRL", { status: "unavailable" }],
      ]),
    );
  });

  it("matches an entry whose own spelling differs in case from the symbol asked", () => {
    // The other half of the rule: the match key is taken on *both* sides, so
    // the feed echoing its own casing still answers the symbol we asked.
    const verdicts = probeVerdicts(
      ["VTI"],
      [{ symbol: "vti", regularMarketPrice: 271.5, currency: "USD", quoteType: "ETF" }],
      FETCHED_AT,
    );

    expect(verdicts).toEqual(new Map([["VTI", { status: "ok", quoteType: "ETF" }]]));
  });

  it("answers unavailable for a symbol no entry claims", () => {
    const verdicts = probeVerdicts(["MISTYPED"], [], FETCHED_AT);

    expect(verdicts).toEqual(new Map([["MISTYPED", { status: "unavailable" }]]));
  });

  it("answers unavailable for every symbol asked when the payload is not even a list", () => {
    // An object, not a string: a string is iterable, so `for…of` walks its
    // characters and the guard this case exists for never runs. `{}` is what
    // a JSON body decoding to the wrong shape actually looks like, and
    // iterating one throws.
    const verdicts = probeVerdicts(["VTI", "VXUS"], { quotes: [] }, FETCHED_AT);

    expect(verdicts).toEqual(
      new Map([
        ["VTI", { status: "unavailable" }],
        ["VXUS", { status: "unavailable" }],
      ]),
    );
  });
});

describe("probing symbols at creation time", () => {
  // The creation-time half of the currency guard (0004, "Resolution, and the
  // guard that has to run here"). Stubs only: the probe takes the client as a
  // parameter for exactly this reason, and no test here reaches the network.
  // `chart` is never called by anything below — it exists only so the fake
  // satisfies `YahooClient`'s shape (`server/yahoo-client.ts`).
  const clientAnswering = (quote: (symbols: string[]) => Promise<unknown>): YahooClient => ({
    quote,
    chart: () => {
      throw new Error("not used in these tests");
    },
  });

  it("answers ok for a symbol that resolves in USD", async () => {
    const verdicts = await probeSymbols(
      ["VTI"],
      clientAnswering(async () => [
        { symbol: "VTI", regularMarketPrice: 271.5, currency: "USD" },
      ]),
    );

    // Null rather than a guess: this payload never said what the thing is, and
    // the column it feeds is the provider's vocabulary or nothing.
    expect(verdicts.get("VTI")).toEqual({ status: "ok", quoteType: null });
  });

  it("carries what the provider calls the instrument, for the row it creates", async () => {
    const verdicts = await probeSymbols(
      ["VTI"],
      clientAnswering(async () => [
        { symbol: "VTI", regularMarketPrice: 271.5, currency: "USD", quoteType: "ETF" },
      ]),
    );

    expect(verdicts.get("VTI")).toEqual({ status: "ok", quoteType: "ETF" });
  });

  it("carries the provider's currency when the quote is not in USD", async () => {
    // The one outcome the person creating the instrument can act on, so it
    // must not be flattened into "unavailable" — which is why this cannot be
    // built on getQuotes, where a refusal becomes an absent quote. The
    // currency arrives as the refresh guard spells it, so the refusal names
    // symbol and currency in the same words.
    const verdicts = await probeSymbols(
      ["VOD.L"],
      clientAnswering(async () => [
        { symbol: "VOD.L", regularMarketPrice: 71.5, currency: "GBp" },
      ]),
    );

    expect(verdicts.get("VOD.L")).toEqual({ status: "non-usd", currency: "GBP" });
  });

  it("answers unavailable for a symbol the provider does not know", async () => {
    // Yahoo drops unknown symbols from the response entirely; absence is its
    // ordinary spelling of "never heard of it". Creation proceeds and the next
    // refresh marks the instrument stale, same as any symbol that stops
    // quoting.
    const verdicts = await probeSymbols(["MISTYPED"], clientAnswering(async () => []));

    expect(verdicts.get("MISTYPED")).toEqual({ status: "unavailable" });
  });

  it("answers unavailable for every symbol asked rather than throwing when the provider fails", async () => {
    // A provider error or timeout must not block creation (0004). The probe
    // never throws; the caller has no catch to write.
    const verdicts = await probeSymbols(
      ["VTI", "VXUS"],
      clientAnswering(async () => {
        throw new Error("socket hang up");
      }),
    );

    expect(verdicts.get("VTI")).toEqual({ status: "unavailable" });
    expect(verdicts.get("VXUS")).toEqual({ status: "unavailable" });
  });

  it("answers unavailable for a payload that is not even a list", async () => {
    // An unofficial endpoint can change shape under us. A payload the schema
    // has never seen is a provider failure, not a reason to refuse creation.
    const verdicts = await probeSymbols(["VTI"], clientAnswering(async () => ({ quotes: [] })));

    expect(verdicts.get("VTI")).toEqual({ status: "unavailable" });
  });

  it("answers unavailable for an entry it does not recognise", async () => {
    const verdicts = await probeSymbols(
      ["VTI"],
      clientAnswering(async () => [{ nothing: "useful" }]),
    );

    expect(verdicts.get("VTI")).toEqual({ status: "unavailable" });
  });

  it("costs one call carrying every symbol asked", async () => {
    const calls: string[][] = [];
    const verdicts = await probeSymbols(
      ["VTI", "VXUS", "BND"],
      clientAnswering(async (symbols) => {
        calls.push(symbols);
        return [
          { symbol: "VTI", regularMarketPrice: 271.5, currency: "USD" },
          { symbol: "VXUS", regularMarketPrice: 60.2, currency: "USD" },
          { symbol: "BND", regularMarketPrice: 72.1, currency: "USD" },
        ];
      }),
    );

    expect(calls).toEqual([["VTI", "VXUS", "BND"]]);
    expect(verdicts.get("VTI")).toEqual({ status: "ok", quoteType: null });
    expect(verdicts.get("VXUS")).toEqual({ status: "ok", quoteType: null });
    expect(verdicts.get("BND")).toEqual({ status: "ok", quoteType: null });
  });
});

const NEW_YORK = "America/New_York";

/** A range wide enough that nothing in these payloads falls outside it. */
const RANGE: HistoryRange = { from: "2024-06-01", until: "2024-12-31" };

/**
 * A daily bar, stamped at the session open — 13:30Z for a June NYSE session,
 * which is 09:30 in New York. Spelled out rather than defaulted because the
 * whole meaning of a bar is which day it is.
 */
const bar = (date: string, close: number | null) => ({
  date: new Date(`${date}T13:30:00Z`),
  close,
});

/** A split as the library hands it back in `return: "array"` mode. */
const split = (date: string, numerator: number, denominator: number) => ({
  date: new Date(`${date}T13:30:00Z`),
  numerator,
  denominator,
  splitRatio: `${numerator}:${denominator}`,
});

const chartOf = (payload: {
  currency?: string;
  splits?: ReturnType<typeof split>[];
  quotes: ReturnType<typeof bar>[];
}) => ({
  meta: { currency: payload.currency ?? "USD" },
  ...(payload.splits === undefined ? {} : { events: { splits: payload.splits } }),
  quotes: payload.quotes,
});

const historyOf = (
  payload: Parameters<typeof chartOf>[0],
  range: HistoryRange = RANGE,
) => toProviderHistory(chartOf(payload), range, NEW_YORK);

/** The closes of an `ok` answer, or a failure naming what came back instead. */
function closesOf(history: ReturnType<typeof toProviderHistory>) {
  if (history.status !== "ok") throw new Error(`expected closes, got ${history.status}`);
  return history.closes;
}

describe("reading a day of history", () => {
  it("returns a close as a decimal string at scale 4, never a number", () => {
    const closes = closesOf(historyOf({ quotes: [bar("2024-06-07", 271.5)] }));

    // `toEqual` is strict about the type, so the exact string is the whole
    // assertion: a number 271.5 would not match it.
    expect(closes).toEqual([{ date: "2024-06-07", close: "271.5000" }]);
  });

  it("files a bar under the trading day inside its own timestamp, not its UTC one", () => {
    // 02:00Z is the previous evening in New York. A UTC truncation would file
    // this under the 8th; the spine would then carry a close for a day whose
    // real close overwrites it, losing the earlier one entirely.
    const history = toProviderHistory(
      { meta: { currency: "USD" }, quotes: [{ date: new Date("2024-06-08T02:00:00Z"), close: 10 }] },
      RANGE,
      NEW_YORK,
    );

    expect(closesOf(history)).toEqual([{ date: "2024-06-07", close: "10.0000" }]);
  });

  it("drops a bar on the range's end and keeps the day before it", () => {
    // The end is exclusive: today's row stays the poller's provisional one.
    const closes = closesOf(
      historyOf({ quotes: [bar("2024-06-11", 10), bar("2024-06-12", 11)] }, {
        from: "2024-06-01",
        until: "2024-06-12",
      }),
    );

    expect(closes).toEqual([{ date: "2024-06-11", close: "10.0000" }]);
  });

  it("skips a bar with no close rather than writing a row for it", () => {
    const closes = closesOf(
      historyOf({ quotes: [bar("2024-06-07", null), bar("2024-06-10", 12)] }),
    );

    expect(closes).toEqual([{ date: "2024-06-10", close: "12.0000" }]);
  });

  it("skips a non-positive close, which is what a half-known symbol returns", () => {
    const closes = closesOf(historyOf({ quotes: [bar("2024-06-07", 0), bar("2024-06-10", 12)] }));

    expect(closes).toEqual([{ date: "2024-06-10", close: "12.0000" }]);
  });

  it("answers no-history for a response whose every close was skipped", () => {
    expect(historyOf({ quotes: [bar("2024-06-07", null), bar("2024-06-10", null)] })).toEqual({
      status: "no-history",
    });
  });

  it("skips a close too small to render as anything but zero", () => {
    // `> 0` is not enough: `toFixed(4)` turns anything under half a
    // ten-thousandth into "0.0000", which would value the holding at nothing —
    // permanently, because the backfill's write is insert-where-absent on a
    // finished day and nothing in the application rewrites it.
    const closes = closesOf(
      historyOf({ quotes: [bar("2024-06-07", 0.000049), bar("2024-06-10", 12)] }),
    );

    expect(closes).toEqual([{ date: "2024-06-10", close: "12.0000" }]);
  });

  it("skips a close too large for the column it is bound for", () => {
    // The guard `inRange` exists for on the sibling columns: a figure this big
    // is not a price, and a `numeric` overflow would abort the transaction the
    // whole batch of closes commits in.
    const closes = closesOf(historyOf({ quotes: [bar("2024-06-07", 1e21), bar("2024-06-10", 12)] }));

    expect(closes).toEqual([{ date: "2024-06-10", close: "12.0000" }]);
  });

  it("refuses a currency it cannot read rather than taking it for an absent one", () => {
    // The quote path refuses the whole payload for a non-string currency, and
    // this is the guard where guessing is worst: a foreign listing summed into
    // a USD net worth, with no error anywhere.
    expect(
      toProviderHistory(
        { meta: { currency: 123 }, quotes: [bar("2024-06-07", 10)] },
        RANGE,
        NEW_YORK,
      ),
    ).toEqual({ status: "no-history" });
  });

  it("answers no-history for a valid range with nothing in it", () => {
    expect(historyOf({ quotes: [] })).toEqual({ status: "no-history" });
  });

  it("answers no-history for a payload whose shape is not the one required", () => {
    expect(toProviderHistory({ nothing: "useful" }, RANGE, NEW_YORK)).toEqual({
      status: "no-history",
    });
  });

  it("refuses a history quoted in a currency this instance cannot hold", () => {
    // Before any figure is read: the failure this prevents is the worst
    // available — GBP quietly summed into a USD net worth, with no error.
    expect(historyOf({ currency: "GBP", quotes: [bar("2024-06-07", 271.5)] })).toEqual({
      status: "non-usd",
      currency: "GBP",
    });
  });

  it("proceeds when the payload states no currency at all, as the quote path does", () => {
    const history = toProviderHistory(
      { meta: {}, quotes: [bar("2024-06-07", 10)] },
      RANGE,
      NEW_YORK,
    );

    expect(closesOf(history)).toEqual([{ date: "2024-06-07", close: "10.0000" }]);
  });

  it("keeps the later instant when two bars file under one trading day", () => {
    // Yahoo inserts extra bars at event times; two bars under one day are one
    // day, and the later instant is the nearer thing to a close.
    const history = toProviderHistory(
      {
        meta: { currency: "USD" },
        quotes: [
          { date: new Date("2024-06-07T13:30:00Z"), close: 10 },
          { date: new Date("2024-06-07T20:00:00Z"), close: 11 },
        ],
      },
      RANGE,
      NEW_YORK,
    );

    expect(closesOf(history)).toEqual([{ date: "2024-06-07", close: "11.0000" }]);
  });

  it("skips a bar whose timestamp cannot be read, rather than filing it under today", () => {
    // Unlike a quote, whose fallback to fetch time is the lesser error: a
    // bar's whole meaning is its day.
    const history = toProviderHistory(
      {
        meta: { currency: "USD" },
        quotes: [{ date: "not a date", close: 10 }, bar("2024-06-10", 12)],
      },
      RANGE,
      NEW_YORK,
    );

    expect(closesOf(history)).toEqual([{ date: "2024-06-10", close: "12.0000" }]);
  });
});

describe("un-adjusting the closes Yahoo restates through splits", () => {
  // The figures are chosen so the un-adjusted close is checkable by eye, and
  // asserted as the resulting close rather than as a factor: a factor asserted
  // against itself would pass whichever direction the arithmetic went.

  it("multiplies a pre-split close back by the split's ratio", () => {
    const closes = closesOf(
      historyOf({
        splits: [split("2024-06-10", 4, 1)],
        quotes: [bar("2024-06-07", 200), bar("2024-06-10", 50), bar("2024-06-11", 52)],
      }),
    );

    expect(closes).toEqual([
      // Held at 200 a share the Friday before; Yahoo restates it as 50.
      { date: "2024-06-07", close: "800.0000" },
      // The split's own day already trades at the new price.
      { date: "2024-06-10", close: "50.0000" },
      { date: "2024-06-11", close: "52.0000" },
    ]);
  });

  it("carries both ratios on a row that precedes two splits, and the later one between them", () => {
    const closes = closesOf(
      historyOf({
        splits: [split("2024-06-10", 4, 1), split("2024-09-10", 2, 1)],
        quotes: [bar("2024-06-07", 100), bar("2024-07-15", 125), bar("2024-09-11", 60)],
      }),
    );

    expect(closes).toEqual([
      { date: "2024-06-07", close: "800.0000" },
      { date: "2024-07-15", close: "250.0000" },
      { date: "2024-09-11", close: "60.0000" },
    ]);
  });

  it("takes a reverse split the other way round, with no case of its own", () => {
    const closes = closesOf(
      historyOf({
        splits: [split("2024-06-10", 1, 10)],
        quotes: [bar("2024-06-07", 10)],
      }),
    );

    expect(closes).toEqual([{ date: "2024-06-07", close: "1.0000" }]);
  });

  it("refuses the whole response when a split's ratio cannot be applied", () => {
    // Some rows right and some wrong is the outcome worth refusing: every
    // figure would look plausible.
    expect(
      historyOf({
        splits: [split("2024-06-10", 4, 0)],
        quotes: [bar("2024-06-07", 200)],
      }),
    ).toEqual({ status: "split-unresolved" });
  });

  it("refuses the whole response when a split's date cannot be read", () => {
    expect(
      toProviderHistory(
        {
          meta: { currency: "USD" },
          events: { splits: [{ date: "not a date", numerator: 4, denominator: 1 }] },
          quotes: [bar("2024-06-07", 200)],
        },
        RANGE,
        NEW_YORK,
      ),
    ).toEqual({ status: "split-unresolved" });
  });

  it("refuses an events block it cannot read, rather than reporting no history", () => {
    // The raw endpoint keys splits by epoch second, and `return: "object"`
    // mode hands them back that way. An events block we cannot read may be
    // hiding a split, and a close un-adjusted by a split nobody saw is the
    // silent wrong figure — where `no-history` would have the ledger say the
    // ticker is unknown or delisted, which it is not.
    expect(
      toProviderHistory(
        {
          meta: { currency: "USD" },
          events: { splits: { "1718022600": { date: 1718022600, numerator: 10, denominator: 1 } } },
          quotes: [bar("2024-06-07", 200)],
        },
        RANGE,
        NEW_YORK,
      ),
    ).toEqual({ status: "split-unresolved" });
  });

  it("carries a close whose un-adjusted value does not land on a whole cent", () => {
    // One rounding, at the end, half away from zero: rounding per split would
    // answer "0.0002" for the second case below.
    expect(
      closesOf(historyOf({ splits: [split("2024-06-10", 1, 3)], quotes: [bar("2024-06-07", 200)] })),
    ).toEqual([{ date: "2024-06-07", close: "66.6667" }]);

    expect(
      closesOf(
        historyOf({
          splits: [split("2024-06-10", 1, 2), split("2024-09-10", 1, 2)],
          quotes: [bar("2024-06-07", 0.0005)],
        }),
      ),
    ).toEqual([{ date: "2024-06-07", close: "0.0001" }]);
  });

  it("drops a row whose un-adjusted product outgrows the column, keeping the rest", () => {
    // The figure that arrived fits; the product does not. An overflow inside
    // the batch's transaction would cost every other close committing with it.
    const closes = closesOf(
      historyOf({
        splits: [split("2024-06-10", 1000, 1)],
        quotes: [bar("2024-06-07", 1e15), bar("2024-06-11", 12)],
      }),
    );

    expect(closes).toEqual([{ date: "2024-06-11", close: "12.0000" }]);
  });

  it("refuses a split whose ratio is not a whole number of shares", () => {
    expect(
      historyOf({
        splits: [split("2024-06-10", 1.5, 1)],
        quotes: [bar("2024-06-07", 200)],
      }),
    ).toEqual({ status: "split-unresolved" });
  });
});

describe("asking the client for one symbol's history", () => {
  /** A client with both halves, so the provider's type is satisfied honestly. */
  const clientCharting = (
    chart: (symbol: string, options: ChartRequest) => Promise<unknown>,
  ): YahooClient => ({ quote: async () => [], chart });

  it("sends one symbol per call, upper-cased, over the range's start", async () => {
    const seen: Array<{ symbol: string; options: ChartRequest }> = [];

    const provider = yahooPriceProvider(
      clientCharting(async (symbol, options) => {
        seen.push({ symbol, options });
        return chartOf({ quotes: [bar("2024-06-07", 10)] });
      }),
    );

    await provider.getDailyCloses(" vti ", RANGE, NEW_YORK);

    expect(seen).toEqual([
      {
        symbol: "VTI",
        // No `period2`: the library defaults it to the instant of the call, and
        // the range's real end is enforced on each bar's market date.
        options: { period1: "2024-06-01", interval: "1d", events: "split" },
      },
    ]);
  });

  it("answers no-history for the error an unknown or delisted symbol throws", async () => {
    const provider = yahooPriceProvider(
      clientCharting(async () => {
        throw new Error("No data found, symbol may be delisted");
      }),
    );

    expect(await provider.getDailyCloses("GONE", RANGE, NEW_YORK)).toEqual({
      status: "no-history",
    });
  });

  it("answers no-history for a period1 before the symbol was listed", async () => {
    const provider = yahooPriceProvider(
      clientCharting(async () => {
        throw new Error("Data doesn't exist for startDate = 1717718400, endDate = 1719878400");
      }),
    );

    expect(await provider.getDailyCloses("NEW", RANGE, NEW_YORK)).toEqual({
      status: "no-history",
    });
  });

  it("reads the stem off any thrown error, never off its class", async () => {
    // The library picks the class from Yahoo's own error `code` with the spaces
    // removed, and only "Bad Request" resolves to one it defines — so the "Not
    // Found" a delisted symbol answers arrives as a plain `Error`. This stands
    // in for the library's class, which its `exports` map does not expose.
    class BadRequestError extends Error {
      override readonly name = "BadRequestError";
    }

    const provider = yahooPriceProvider(
      clientCharting(async () => {
        throw new BadRequestError("No data found, symbol may be delisted");
      }),
    );

    expect(await provider.getDailyCloses("GONE", RANGE, NEW_YORK)).toEqual({
      status: "no-history",
    });
  });

  it("propagates any other failure, because the caller's ledger wants the text", async () => {
    const provider = yahooPriceProvider(
      clientCharting(async () => {
        throw new Error("429 Too Many Requests");
      }),
    );

    await expect(provider.getDailyCloses("VTI", RANGE, NEW_YORK)).rejects.toThrow(
      "429 Too Many Requests",
    );
  });
});
