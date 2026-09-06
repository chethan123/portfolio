// toProviderQuote translates Yahoo's JSON into decimal strings Postgres can take directly (DESIGN.md §6.1)
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CurrencyRefused,
  probeVerdicts,
  toProviderHistory,
  toProviderQuote,
  type HistoryRange,
} from "~/lib/price-provider.server";
import { socketProbe, socketProvider } from "~/lib/provider-socket.server";

import { startWorker } from "../server/price-worker.ts";

import type { ChartRequest, YahooClient } from "../server/yahoo-client.ts";
import type http from "node:http";

// getConfig() memoises its first read — set before any test can reach it
const SOCKET_PATH = join(tmpdir(), `pp-${randomBytes(4).toString("hex")}.sock`);
process.env.PRICE_WORKER_SOCKET = SOCKET_PATH;

let currentServer: http.Server | undefined;

afterEach(async () => {
  if (currentServer === undefined) return;
  await new Promise<void>((resolve) => currentServer!.close(() => resolve()));
  currentServer = undefined;
});

async function start(yahoo: YahooClient): Promise<void> {
  currentServer = await startWorker({ socketPath: SOCKET_PATH, yahoo });
}

const FETCHED_AT = new Date("2026-06-05T18:00:00Z");

const quoteFor = (raw: Record<string, unknown>) => toProviderQuote(raw, FETCHED_AT);

describe("reading a price", () => {
  it("returns money as a decimal string at scale 4, never a number", () => {
    const quote = quoteFor({ symbol: "VTI", regularMarketPrice: 271.5, currency: "USD" });

    expect(quote?.price).toBe("271.5000");
    expect(typeof quote?.price).toBe("string");
  });

  it("carries the provider's own quote type through unchanged", () => {
    const quote = quoteFor({ symbol: "VTSAX", regularMarketPrice: 130, quoteType: "MUTUALFUND" });

    expect(quote?.quoteType).toBe("MUTUALFUND");
  });

  it("declines a payload with no price rather than inventing one", () => {
    expect(quoteFor({ symbol: "DELISTED", currency: "USD" })).toBeNull();
  });

  it("drops a price at the ceiling rather than clamping it", () => {
    // quote.price is numeric(20,4); 16 integer digits overflows and would abort the whole refresh transaction
    expect(quoteFor({ symbol: "GARBAGE", regularMarketPrice: 1e16 })).toBeNull();
  });

  it("refuses a foreign currency even when the price is over the ceiling", () => {
    // order matters: size-drop happens first, letting the resolver create the instrument where non-usd would refuse it (spec 0018 §1).
    expect(() =>
      toProviderQuote(
        { symbol: "VWRL.L", currency: "GBP", regularMarketPrice: 10 ** 16 },
        FETCHED_AT,
      ),
    ).toThrow(CurrencyRefused);
  });

  it("keeps a price that sits just below the ceiling", () => {
    const quote = quoteFor({ symbol: "WIDE", regularMarketPrice: 9999999999999998 });

    expect(quote?.price).toBe("9999999999999998.0000");
  });

  it("declines a payload it does not recognise", () => {
    expect(quoteFor({ nothing: "useful" })).toBeNull();
  });
});

describe("the yield unit hazard", () => {
  it("reads dividendYield as the percentage it is", () => {
    // 2.34 means 2.34% — must not be multiplied/divided by 100 on the way to numeric(10,6)
    const quote = quoteFor({
      symbol: "SCHD",
      regularMarketPrice: 100,
      dividendYield: 2.34,
    });

    expect(quote?.yieldPct).toBe("2.340000");
  });

  it("ignores trailingAnnualDividendYield even when it is the only yield offered", () => {
    // library's doc comment calls this a percentage, but the value is a fraction: 0.0234 where other rows hold 2.34
    const quote = quoteFor({
      symbol: "AMBIGUOUS",
      regularMarketPrice: 100,
      trailingAnnualDividendYield: 0.0234,
    });

    expect(quote?.yieldPct).toBeNull();
  });

  it("derives the yield from the rate and the price when no percentage is given", () => {
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

    expect(quote).toBeNull();
  });

  it("prefers dividendYield when both yield fields disagree", () => {
    // a future edit reaching for the fraction field here gets 0.0234 instead of 2.34
    const quote = quoteFor({
      symbol: "BOTH",
      regularMarketPrice: 100,
      dividendYield: 2.34,
      trailingAnnualDividendYield: 0.0234,
    });

    expect(quote?.yieldPct).toBe("2.340000");
  });

  it("drops a derived yield too large for the column rather than losing the batch", () => {
    // $2.50/$0.02 = 12500%, over yield_pct's numeric(10,6) ceiling
    const quote = quoteFor({ symbol: "DISTRESSED", regularMarketPrice: 0.02, dividendRate: 2.5 });

    expect(quote?.price).toBe("0.0200");
    expect(quote?.yieldPct).toBeNull();
    // 2.5×10^12 at the widest legal quantity is nowhere near annualDividendPerShare's 10^16 ceiling
    expect(quote?.annualDividendPerShare).toBe("2.5000");
  });

  it("drops a per-share rate too large for its own column, as it does a yield", () => {
    // migration 0006's asymmetry: yield_pct is bounded, annual_dividend_per_share isn't — an unbounded figure here aborts the whole refresh.
    const quote = quoteFor({
      symbol: "GARBAGE",
      regularMarketPrice: 100,
      dividendRate: 1e16,
    });

    expect(quote?.price).toBe("100.0000");
    expect(quote?.annualDividendPerShare).toBeNull();
    // null, never clamped — a clamped rate would read as a real projected payout on Holdings
    expect(quote?.yieldPct).toBeNull();
  });

  it("keeps a rate that sits just inside the column", () => {
    const quote = quoteFor({
      symbol: "WIDE",
      regularMarketPrice: 1e15,
      dividendRate: 9e15,
    });

    expect(quote?.annualDividendPerShare).toBe("9000000000000000.0000");
  });

  it("reads an ETF's dividend from trailingAnnualDividendRate", () => {
    // ETF payloads carry no dividendRate (equities/mutual funds only)
    const quote = quoteFor({
      symbol: "VTI",
      quoteType: "ETF",
      regularMarketPrice: 271.5,
      trailingAnnualDividendRate: 3.39,
    });

    expect(quote?.annualDividendPerShare).toBe("3.3900");
    expect(quote?.yieldPct).toBe("1.248619");
  });

  it("reports no yield when the provider offers neither field", () => {
    const quote = quoteFor({ symbol: "GROWTH", regularMarketPrice: 42 });

    expect(quote?.yieldPct).toBeNull();
    expect(quote?.annualDividendPerShare).toBeNull();
  });
});

describe("the currency guard", () => {
  it("refuses a quote that is not in USD", () => {
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

    // ADR-0006 — losing either fact makes an evening NAV indistinguishable from a morning fetch of it
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
      // neither field is in the schema (ADR-0006: the archive exists for what the typed parse throws away)
      marketState: "REGULAR",
      fiftyTwoWeekHigh: 280.1,
    };

    expect(quoteFor(raw)?.payload).toEqual(raw);
  });

  it("archives nothing for an entry it refused, because there is no quote to archive it against", () => {
    expect(quoteFor({ nothing: "useful" })).toBeNull();
    expect(quoteFor({ symbol: "DELISTED", currency: "USD" })).toBeNull();
  });
});

describe("probeVerdicts — the verdict logic a batched probe answers with", () => {
  it("lands an ok verdict on the asked symbol across a case difference", () => {
    // keys on what was asked, not the provider's echoed spelling
    const verdicts = probeVerdicts(
      ["vti"],
      [{ symbol: "VTI", regularMarketPrice: 271.5, currency: "USD" }],
      FETCHED_AT,
    );

    expect(verdicts).toEqual(new Map([["vti", { status: "ok", quoteType: null }]]));
  });

  it("answers both spellings when one ticker was asked for twice", () => {
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
    // batching's rule: one answer must not be spent on whichever symbol was asked first
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
    // object, not string — a string is iterable and would silently walk characters instead of tripping this guard
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
  // `chart` exists only so the fake satisfies YahooClient's shape — socketProbe never calls it
  const clientAnswering = (quote: (symbols: string[]) => Promise<unknown>): YahooClient => ({
    quote,
    chart: () => {
      throw new Error("not used in these tests");
    },
  });

  it("answers ok for a symbol that resolves in USD", async () => {
    await start(
      clientAnswering(async () => [{ symbol: "VTI", regularMarketPrice: 271.5, currency: "USD" }]),
    );

    const verdicts = await socketProbe(["VTI"]);

    expect(verdicts.get("VTI")).toEqual({ status: "ok", quoteType: null });
  });

  it("carries what the provider calls the instrument, for the row it creates", async () => {
    await start(
      clientAnswering(async () => [
        { symbol: "VTI", regularMarketPrice: 271.5, currency: "USD", quoteType: "ETF" },
      ]),
    );

    const verdicts = await socketProbe(["VTI"]);

    expect(verdicts.get("VTI")).toEqual({ status: "ok", quoteType: "ETF" });
  });

  it("carries the provider's currency when the quote is not in USD", async () => {
    // must not flatten to "unavailable" — can't be built on getQuotes, where a refusal is just an absent quote
    await start(
      clientAnswering(async () => [{ symbol: "VOD.L", regularMarketPrice: 71.5, currency: "GBp" }]),
    );

    const verdicts = await socketProbe(["VOD.L"]);

    expect(verdicts.get("VOD.L")).toEqual({ status: "non-usd", currency: "GBP" });
  });

  it("answers unavailable for a symbol the provider does not know", async () => {
    await start(clientAnswering(async () => []));

    const verdicts = await socketProbe(["MISTYPED"]);

    expect(verdicts.get("MISTYPED")).toEqual({ status: "unavailable" });
  });

  it("answers unavailable for every symbol asked rather than throwing when the provider fails", async () => {
    // provider error/timeout must not block creation (0004) — probe never throws
    await start(
      clientAnswering(async () => {
        throw new Error("socket hang up");
      }),
    );

    const verdicts = await socketProbe(["VTI", "VXUS"]);

    expect(verdicts.get("VTI")).toEqual({ status: "unavailable" });
    expect(verdicts.get("VXUS")).toEqual({ status: "unavailable" });
  });

  it("answers unavailable for a payload that is not even a list", async () => {
    await start(clientAnswering(async () => ({ quotes: [] })));

    const verdicts = await socketProbe(["VTI"]);

    expect(verdicts.get("VTI")).toEqual({ status: "unavailable" });
  });

  it("answers unavailable for an entry it does not recognise", async () => {
    await start(clientAnswering(async () => [{ nothing: "useful" }]));

    const verdicts = await socketProbe(["VTI"]);

    expect(verdicts.get("VTI")).toEqual({ status: "unavailable" });
  });

  it("costs one call carrying every symbol asked", async () => {
    const calls: string[][] = [];
    await start(
      clientAnswering(async (symbols) => {
        calls.push(symbols);
        return [
          { symbol: "VTI", regularMarketPrice: 271.5, currency: "USD" },
          { symbol: "VXUS", regularMarketPrice: 60.2, currency: "USD" },
          { symbol: "BND", regularMarketPrice: 72.1, currency: "USD" },
        ];
      }),
    );

    const verdicts = await socketProbe(["VTI", "VXUS", "BND"]);

    expect(calls).toEqual([["VTI", "VXUS", "BND"]]);
    expect(verdicts.get("VTI")).toEqual({ status: "ok", quoteType: null });
    expect(verdicts.get("VXUS")).toEqual({ status: "ok", quoteType: null });
    expect(verdicts.get("BND")).toEqual({ status: "ok", quoteType: null });
  });
});

const NEW_YORK = "America/New_York";

const RANGE: HistoryRange = { from: "2024-06-01", until: "2024-12-31" };

// 13:30Z = 09:30 NY (June) — spelled out, not defaulted, since a bar's whole meaning is its day
const bar = (date: string, close: number | null) => ({
  date: new Date(`${date}T13:30:00Z`),
  close,
});

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

function closesOf(history: ReturnType<typeof toProviderHistory>) {
  if (history.status !== "ok") throw new Error(`expected closes, got ${history.status}`);
  return history.closes;
}

describe("reading a day of history", () => {
  it("returns a close as a decimal string at scale 4, never a number", () => {
    const closes = closesOf(historyOf({ quotes: [bar("2024-06-07", 271.5)] }));

    expect(closes).toEqual([{ date: "2024-06-07", close: "271.5000" }]);
  });

  it("files a bar under the trading day inside its own timestamp, not its UTC one", () => {
    // 02:00Z is the previous evening in NY — UTC truncation would file this under the 8th,
    // losing it when the real 8th close overwrites it
    const history = toProviderHistory(
      { meta: { currency: "USD" }, quotes: [{ date: new Date("2024-06-08T02:00:00Z"), close: 10 }] },
      RANGE,
      NEW_YORK,
    );

    expect(closesOf(history)).toEqual([{ date: "2024-06-07", close: "10.0000" }]);
  });

  it("drops a bar on the range's end and keeps the day before it", () => {
    // the end is exclusive — today's row stays the poller's provisional one
    const closes = closesOf(
      historyOf({ quotes: [bar("2024-06-11", 10), bar("2024-06-12", 11)] }, {
        from: "2024-06-01",
        until: "2024-06-12",
      }),
    );

    expect(closes).toEqual([{ date: "2024-06-11", close: "10.0000" }]);
  });

  it("drops a bar before the range's start and keeps the day inside it", () => {
    // a bar before range.from would insert-where-absent and permanently satisfy the gap predicate
    const closes = closesOf(
      historyOf({ quotes: [bar("2024-05-31", 10), bar("2024-06-07", 11)] }, {
        from: "2024-06-01",
        until: "2024-12-31",
      }),
    );

    expect(closes).toEqual([{ date: "2024-06-07", close: "11.0000" }]);
  });

  it("keeps a bar dated exactly at the range's start", () => {
    // an exclusive floor would drop the gap-closing bar and record a fill while the gap stays open
    const closes = closesOf(
      historyOf({ quotes: [bar("2024-06-01", 9), bar("2024-06-07", 11)] }, {
        from: "2024-06-01",
        until: "2024-12-31",
      }),
    );

    expect(closes).toEqual([
      { date: "2024-06-01", close: "9.0000" },
      { date: "2024-06-07", close: "11.0000" },
    ]);
  });

  it("judges a bar against its market date, not the instant's UTC date", () => {
    // 01:00Z on 06-01 is the evening of 05-31 in NY — a UTC-date comparison would wrongly keep it
    const closes = closesOf(
      historyOf({ quotes: [{ date: new Date("2024-06-01T01:00:00Z"), close: 9 }, bar("2024-06-07", 11)] }, {
        from: "2024-06-01",
        until: "2024-12-31",
      }),
    );

    expect(closes).toEqual([{ date: "2024-06-07", close: "11.0000" }]);
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
    // toFixed(4) rounds under half a ten-thousandth to "0.0000" — would value the holding at nothing, permanently
    const closes = closesOf(
      historyOf({ quotes: [bar("2024-06-07", 0.000049), bar("2024-06-10", 12)] }),
    );

    expect(closes).toEqual([{ date: "2024-06-10", close: "12.0000" }]);
  });

  it("skips a close too large for the column it is bound for", () => {
    // inRange exists for the sibling columns too — an overflow here would abort the whole batch's transaction
    const closes = closesOf(historyOf({ quotes: [bar("2024-06-07", 1e21), bar("2024-06-10", 12)] }));

    expect(closes).toEqual([{ date: "2024-06-10", close: "12.0000" }]);
  });

  it("refuses a currency it cannot read rather than taking it for an absent one", () => {
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
    // Yahoo inserts extra bars at event times — later instant of the pair is the nearer thing to a close
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
  // figures chosen to be checkable by eye; asserted as the resulting close, not a factor
  it("multiplies a pre-split close back by the split's ratio", () => {
    const closes = closesOf(
      historyOf({
        splits: [split("2024-06-10", 4, 1)],
        quotes: [bar("2024-06-07", 200), bar("2024-06-10", 50), bar("2024-06-11", 52)],
      }),
    );

    expect(closes).toEqual([
      // held at 200/share the Friday before; Yahoo restates it as 50
      { date: "2024-06-07", close: "800.0000" },
      // the split's own day already trades at the new price
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
    // some rows right, some wrong — the outcome worth refusing, since every figure would look plausible
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
    // raw endpoint keys splits by epoch second (return:"object" mode); an unreadable events
    // block may hide a split — a close un-adjusted by it is the silent wrong figure
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
    // one rounding at the end, half away from zero — per-split rounding would answer "0.0002" for the case below
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
    // figure fits, the un-adjusted product doesn't — an overflow here would cost every other close in the batch
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

describe("asking the worker for one symbol's history", () => {
  const clientCharting = (
    chart: (symbol: string, options: ChartRequest) => Promise<unknown>,
  ): YahooClient => ({ quote: async () => [], chart });

  it("sends one symbol per call, upper-cased, over the range's start", async () => {
    const seen: Array<{ symbol: string; options: ChartRequest }> = [];

    await start(
      clientCharting(async (symbol, options) => {
        seen.push({ symbol, options });
        return chartOf({ quotes: [bar("2024-06-07", 10)] });
      }),
    );

    await socketProvider().getDailyCloses(" vti ", RANGE, NEW_YORK);

    expect(seen).toEqual([
      {
        symbol: "VTI",
        // no period2 — library defaults it to now; the real end is enforced per-bar on its market date
        options: { period1: "2024-06-01", interval: "1d", events: "split" },
      },
    ]);
  });

  it("answers no-history for the error an unknown or delisted symbol throws", async () => {
    await start(
      clientCharting(async () => {
        throw new Error("No data found, symbol may be delisted");
      }),
    );

    expect(await socketProvider().getDailyCloses("GONE", RANGE, NEW_YORK)).toEqual({
      status: "no-history",
    });
  });

  it("answers no-history for a period1 before the symbol was listed", async () => {
    await start(
      clientCharting(async () => {
        throw new Error("Data doesn't exist for startDate = 1717718400, endDate = 1719878400");
      }),
    );

    expect(await socketProvider().getDailyCloses("NEW", RANGE, NEW_YORK)).toEqual({
      status: "no-history",
    });
  });

  it("reads the stem off any thrown error, never off its class", async () => {
    // library only defines a class for "Bad Request"; "Not Found" arrives as plain Error. Stands
    // in for a class its exports don't expose — and over the socket it's lost anyway (worker's
    // 502 carries only text).
    class BadRequestError extends Error {
      override readonly name = "BadRequestError";
    }

    await start(
      clientCharting(async () => {
        throw new BadRequestError("No data found, symbol may be delisted");
      }),
    );

    expect(await socketProvider().getDailyCloses("GONE", RANGE, NEW_YORK)).toEqual({
      status: "no-history",
    });
  });

  it("propagates any other failure, because the caller's ledger wants the text", async () => {
    await start(
      clientCharting(async () => {
        throw new Error("429 Too Many Requests");
      }),
    );

    await expect(socketProvider().getDailyCloses("VTI", RANGE, NEW_YORK)).rejects.toThrow(
      "429 Too Many Requests",
    );
  });
});
