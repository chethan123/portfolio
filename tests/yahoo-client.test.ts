/**
 * The client's own surface — what `server/yahoo-client.ts` adds on top of
 * `yahoo-finance2`: a constructed instance rather than the class's own
 * broken static, the request it forwards, `validateResult: false`'s effect
 * on a drifted field, and the fixed timeout every call gets. No network:
 * every case swaps `globalThis.fetch` for the duration of the test, since
 * the client sets neither a constructor `fetch` nor a per-call one, so the
 * library falls through to it (`yahooFinanceFetch.js:58`).
 */
import { afterEach, describe, expect, it } from "vitest";

import { createYahooClient, type ChartRequest } from "../server/yahoo-client.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const REQUEST: ChartRequest = { period1: "2024-06-01", interval: "1d", events: "split" };

/** A minimally valid `chart()` response body, one bar, USD by default. */
function chartResponseBody({
  currency = "USD",
  close = 10,
}: { currency?: unknown; close?: unknown } = {}): string {
  return JSON.stringify({
    chart: {
      result: [
        {
          meta: { currency },
          timestamp: [1_717_200_000],
          indicators: {
            quote: [{ high: [10], low: [9], open: [9.5], close: [close], volume: [100] }],
          },
        },
      ],
      error: null,
    },
  });
}

describe("the shape of the library this client wraps", () => {
  it("constructs an instance rather than calling the class's own broken static", async () => {
    // yahoo-finance2's default export is the `YahooFinance` *class*, and the
    // class carries a static `quote`/`chart` that exist, type-check, and
    // throw "Call `const yahooFinance = new YahooFinance()` first" the
    // moment either runs — before any network access at all. If this
    // module's own construction ever regressed to the bare class, the call
    // below would throw synchronously and the fake `fetch` would never be
    // reached, so a fetch call actually happening is the proof the
    // instantiation is real.
    const seen: unknown[] = [];
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      seen.push(args);
      throw new Error("stop here — the point is that fetch was reached at all");
    }) as typeof fetch;

    await createYahooClient()
      .chart("VTI", REQUEST)
      .catch(() => {});

    expect(seen.length).toBeGreaterThan(0);
  });

  it("refuses to be used as a bare static, which is the trap this module exists to avoid", async () => {
    // The other direction, and the one the architecture document states as
    // fact: the class's statics are not a usable client. If a future version
    // makes them work, this fails and the indirection can go — which is the
    // only signal that would tell us so.
    const { default: YahooFinance } = await import("yahoo-finance2");
    const bare = YahooFinance as unknown as { chart(symbol: string, request: unknown): Promise<unknown> };

    // Synchronously, before any promise exists — so the failure a regression
    // to the bare class would produce is a throw at the call site, not a
    // rejection something might swallow.
    expect(() => bare.chart("VTI", REQUEST)).toThrow(/new YahooFinance/);
  });
});

describe("the request a chart call forwards", () => {
  it("sends period1, interval and events in the query, and a signal in the third argument", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(chartResponseBody());
    }) as typeof fetch;

    await createYahooClient().chart("VTI", REQUEST);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("expected fetch to have been called");
    const { url, init } = call;
    const params = new URL(url).searchParams;

    expect(params.get("interval")).toBe("1d");
    expect(params.get("events")).toBe("split");
    expect(params.get("period1")).toBe(String(Math.floor(new Date("2024-06-01").getTime() / 1000)));
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("passes validateResult: false so one drifted field does not fail the whole call", async () => {
    // The exact fixture research note 2026-09-04-price-worker-platform-facts.md
    // §3.3 exercised live: a currency that is not a string, and a close that
    // is not a number. At the default, either throws
    // `FailedYahooValidationError` for the whole response.
    globalThis.fetch = (async () =>
      new Response(chartResponseBody({ currency: 123, close: "not-a-number" }))) as typeof fetch;

    const result = (await createYahooClient().chart("VTI", REQUEST)) as {
      meta: { currency: unknown };
      quotes: Array<{ close: unknown }>;
    };

    expect(result.meta.currency).toBe(123);
    expect(result.quotes[0]?.close).toBe("not-a-number");
  });
});

describe("the client's fixed timeout", () => {
  it("rejects with the signal's own TimeoutError once the fixed deadline expires", async () => {
    // A fake that rejects only when its signal aborts — the library never
    // races the signal itself (`queue.js` awaits the job,
    // `yahooFinanceFetch.js` just calls `fetch`), so a fake that ignores
    // `init.signal` would hang this test to vitest's own timeout instead.
    globalThis.fetch = ((_url: string | URL, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;

    const client = createYahooClient({ timeoutMs: 50 });

    await expect(client.chart("VTI", REQUEST)).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
