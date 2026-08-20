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

import { CurrencyRefused, toProviderQuote } from "~/lib/price-provider.server";

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
