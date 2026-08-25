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
  probeSymbol,
  toProviderQuote,
  yahooClient,
} from "~/lib/price-provider.server";

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
});

describe("probing a symbol at creation time", () => {
  // The creation-time half of the currency guard (0004, "Resolution, and the
  // guard that has to run here"). Stubs only: the probe takes the client as a
  // parameter for exactly this reason, and no test here reaches the network.
  const clientAnswering = (quote: (symbols: string[]) => Promise<unknown>) => async () => ({
    quote,
  });

  it("answers ok for a symbol that resolves in USD", async () => {
    const probe = await probeSymbol(
      "VTI",
      clientAnswering(async () => [
        { symbol: "VTI", regularMarketPrice: 271.5, currency: "USD" },
      ]),
    );

    // Null rather than a guess: this payload never said what the thing is, and
    // the column it feeds is the provider's vocabulary or nothing.
    expect(probe).toEqual({ status: "ok", quoteType: null });
  });

  it("carries what the provider calls the instrument, for the row it creates", async () => {
    const probe = await probeSymbol(
      "VTI",
      clientAnswering(async () => [
        { symbol: "VTI", regularMarketPrice: 271.5, currency: "USD", quoteType: "ETF" },
      ]),
    );

    expect(probe).toEqual({ status: "ok", quoteType: "ETF" });
  });

  it("carries the provider's currency when the quote is not in USD", async () => {
    // The one outcome the person creating the instrument can act on, so it
    // must not be flattened into "unavailable" — which is why this cannot be
    // built on getQuotes, where a refusal becomes an absent quote. The
    // currency arrives as the refresh guard spells it, so the refusal names
    // symbol and currency in the same words.
    const probe = await probeSymbol(
      "VOD.L",
      clientAnswering(async () => [
        { symbol: "VOD.L", regularMarketPrice: 71.5, currency: "GBp" },
      ]),
    );

    expect(probe).toEqual({ status: "non-usd", currency: "GBP" });
  });

  it("answers unavailable for a symbol the provider does not know", async () => {
    // Yahoo drops unknown symbols from the response entirely; absence is its
    // ordinary spelling of "never heard of it". Creation proceeds and the next
    // refresh marks the instrument stale, same as any symbol that stops
    // quoting.
    const probe = await probeSymbol("MISTYPED", clientAnswering(async () => []));

    expect(probe).toEqual({ status: "unavailable" });
  });

  it("answers unavailable rather than throwing when the provider fails", async () => {
    // A provider error or timeout must not block creation (0004). The probe
    // never throws; the caller has no catch to write.
    const probe = await probeSymbol(
      "VTI",
      clientAnswering(async () => {
        throw new Error("socket hang up");
      }),
    );

    expect(probe).toEqual({ status: "unavailable" });
  });

  it("answers unavailable for a payload that is not even a list", async () => {
    // An unofficial endpoint can change shape under us. A payload the schema
    // has never seen is a provider failure, not a reason to refuse creation.
    const probe = await probeSymbol("VTI", clientAnswering(async () => "not an array"));

    expect(probe).toEqual({ status: "unavailable" });
  });

  it("answers unavailable for an entry it does not recognise", async () => {
    const probe = await probeSymbol("VTI", clientAnswering(async () => [{ nothing: "useful" }]));

    expect(probe).toEqual({ status: "unavailable" });
  });
});

describe("the shape of the library we depend on", () => {
  it("hands back a client whose quote method is callable", async () => {
    // The regression test for a bug that shipped. `yahoo-finance2`'s default
    // export is the `YahooFinance` *class*, and the class carries a static
    // `quote` that exists, type-checks, and throws "Call `const yahooFinance =
    // new YahooFinance()` first" the moment it runs. Calling it on the export
    // rather than on an instance fails on the first poll and every poll after,
    // with the poller's catch swallowing it — no price is ever fetched and
    // nothing in a fake-driven suite notices.
    //
    // No network: constructing the client and reading the method off it is the
    // whole assertion.
    const client = await yahooClient();

    expect(typeof client.quote).toBe("function");
  });

  it("refuses to be used as a bare static, which is the trap", async () => {
    // Pinning the reason the test above exists. If a future version makes the
    // export directly callable this fails, and the indirection can go.
    const { default: YahooFinance } = await import("yahoo-finance2");

    expect(() => (YahooFinance as unknown as { quote: () => unknown }).quote()).toThrow(
      /new YahooFinance\(\)/,
    );
  });
});
