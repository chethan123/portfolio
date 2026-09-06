/**
 * What server/yahoo-client.ts adds on top of yahoo-finance2: a constructed instance rather
 * than the class's own broken static, the request it forwards, validateResult:false's effect
 * on a drifted field, and the fixed timeout every call gets. No network — every case swaps
 * globalThis.fetch, since the client sets no fetch of its own and the library falls through to it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

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

/** A minimally valid `quote()` response body for one symbol. */
function quoteResponseBody({
  currency = "USD",
  regularMarketPrice = 250,
}: { currency?: unknown; regularMarketPrice?: unknown } = {}): string {
  return JSON.stringify({
    quoteResponse: {
      result: [{ symbol: "VTI", quoteType: "ETF", language: "en-US", currency, regularMarketPrice }],
      error: null,
    },
  });
}

// fake fetch for quote()'s crumb handshake (chart() never makes this round trip): first call is
// the cookie leg, second is getcrumb, every call from the third on goes to finalResponse. Every
// call recorded so a test can assert on request shape and signal.
function fakeFetchWithCrumbHandshake(finalResponse: () => Response): {
  calls: Array<{ url: string; init: RequestInit }>;
  fetch: typeof fetch;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFake = (async (url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return new Response("", { status: 200, headers: { "set-cookie": "A1=abc; Path=/" } });
    }
    if (calls.length === 2) {
      return new Response("test-crumb", { status: 200 });
    }
    return finalResponse();
  }) as typeof fetch;
  return { calls, fetch: fetchFake };
}

describe("the shape of the library this client wraps", () => {
  it("constructs an instance rather than calling the class's own broken static", async () => {
    // yahoo-finance2's default export is the YahooFinance class; its static quote/chart
    // type-check but throw before any network access. If construction ever regressed to the
    // bare class, this would throw synchronously and the fake fetch would never be reached —
    // so a fetch call happening at all is the proof instantiation is real.
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
    // the other direction — if a future library version makes the statics work, this fails
    // and the indirection can go; the only signal that would tell us so
    const { default: YahooFinance } = await import("yahoo-finance2");
    const bare = YahooFinance as unknown as { chart(symbol: string, request: unknown): Promise<unknown> };

    // synchronously, before any promise exists — a regression to the bare class throws at the call site, not a swallowed rejection
    expect(() => bare.chart("VTI", REQUEST)).toThrow(/new YahooFinance/);
  });
});

describe("the deadline every call carries", () => {
  it("defaults to thirty seconds, the number the spec fixes and no caller may change", async () => {
    // the default is what production uses — worker, adapter, probe all call createYahooClient()
    // with no argument. Read off the forwarded signal rather than waited out.
    const seen: Array<AbortSignal | undefined> = [];
    globalThis.fetch = (async (_url: string | URL, init: RequestInit) => {
      seen.push(init?.signal ?? undefined);
      throw new Error("stop here");
    }) as typeof fetch;

    await createYahooClient()
      .chart("VTI", REQUEST)
      .catch(() => {});

    const signal = seen[0];
    expect(signal).toBeInstanceOf(AbortSignal);
    // AbortSignal.timeout keeps its deadline private — the observable is that it hasn't fired
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(signal?.aborted).toBe(false);
  });

  it("passes exactly 30 000 ms to AbortSignal.timeout, not merely something above 50 ms", async () => {
    // case above only pins "greater than ~50ms" — 100ms and 60s both survive it. A default
    // above server.timeout would silently put every call past the worker's socket watchdog.
    // Fake timers don't work here: verified on Node 24.12.0 that vi.useFakeTimers() never flips
    // an AbortSignal.timeout's .aborted even after advancing past its delay — its internal
    // timer isn't routed through the global setTimeout fake timers patch. A direct spy reads
    // the exact argument instead, with no waiting at all.
    const spy = vi.spyOn(AbortSignal, "timeout");
    globalThis.fetch = (async () => {
      throw new Error("stop here");
    }) as typeof fetch;

    await createYahooClient()
      .chart("VTI", REQUEST)
      .catch(() => {});

    expect(spy).toHaveBeenCalledWith(30_000);
    spy.mockRestore();
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
    // fixture research note 2026-09-04-price-worker-platform-facts.md §3.3 exercised live: a
    // non-string currency and a non-number close. At the default, either throws FailedYahooValidationError.
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
    // a fake that rejects only when its signal aborts — the library never races the signal
    // itself, so a fake ignoring init.signal would hang this test to vitest's own timeout
    globalThis.fetch = ((_url: string | URL, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;

    const client = createYahooClient({ timeoutMs: 50 });

    await expect(client.chart("VTI", REQUEST)).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("the per-call options built for each request", () => {
  it("gives two calls made more than the deadline apart two different, live signals", async () => {
    // a hoisted per-client (not per-call) options object would hand the second call the same,
    // already-expired signal — the worker builds one client for the process's life, so every
    // call past 30s from start would carry a pre-aborted signal and answer 504 forever, silently
    const seenSignals: Array<AbortSignal | undefined> = [];
    globalThis.fetch = (async (_url: string | URL, init: RequestInit) => {
      seenSignals.push(init.signal ?? undefined);
      return new Response(chartResponseBody());
    }) as typeof fetch;

    const client = createYahooClient({ timeoutMs: 50 });

    const first = await client.chart("VTI", REQUEST);
    // longer than the client's own 50ms deadline
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await client.chart("VTI", REQUEST);

    // both succeeding alone proves too little — a fake ignoring init.signal would let a
    // hoisted, already-expired one "succeed" the same way; signal identity below is the real pin
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(seenSignals).toHaveLength(2);
    const [firstSignal, secondSignal] = seenSignals;
    expect(firstSignal).toBeInstanceOf(AbortSignal);
    expect(secondSignal).toBeInstanceOf(AbortSignal);
    expect(secondSignal).not.toBe(firstSignal);
    expect(secondSignal?.aborted).toBe(false);
  });
});

describe("the quote path the poller calls every tick", () => {
  // quote() needs a crumb, chart() never does, and the crumb is cached on the shared library's
  // cookie jar for the process's life once fetched — a second quote() call would skip the
  // handshake entirely (verified: vi.resetModules() doesn't reliably rebuild the real instance
  // the way vi.doMock does). So one call, one case, pins both facts.
  it("completes the crumb handshake, carries one live signal through all three requests, and passes validateResult: false so a drifted field survives", async () => {
    // fixture research note 2026-09-04-price-worker-platform-facts.md §3.3 exercised live: a
    // non-string currency. At the default (validateResult:true) this throws FailedYahooValidationError.
    const { calls, fetch: fetchFake } = fakeFetchWithCrumbHandshake(
      () => new Response(quoteResponseBody({ currency: 123, regularMarketPrice: "not-a-number" })),
    );
    globalThis.fetch = fetchFake;

    const result = (await createYahooClient().quote(["VTI"])) as Array<{
      currency: unknown;
      regularMarketPrice: unknown;
    }>;

    expect(result[0]?.currency).toBe(123);
    expect(result[0]?.regularMarketPrice).toBe("not-a-number");

    expect(calls).toHaveLength(3);
    const [cookieLeg, crumbLeg, mainCall] = calls;
    if (cookieLeg === undefined || crumbLeg === undefined || mainCall === undefined) {
      throw new Error("expected three fetch calls");
    }
    expect(cookieLeg.url).toBe("https://finance.yahoo.com/quote/AAPL");
    expect(crumbLeg.url).toBe("https://query1.finance.yahoo.com/v1/test/getcrumb");
    const mainParams = new URL(mainCall.url).searchParams;
    expect(mainParams.get("symbols")).toBe("VTI");
    expect(mainParams.get("crumb")).toBe("test-crumb");

    // one signal, built once per quote() call and forwarded to every fetch it makes — not a
    // fresh one per request, and not the constructor's one-per-process-life signal either
    for (const { init } of calls) expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(crumbLeg.init.signal).toBe(cookieLeg.init.signal);
    expect(mainCall.init.signal).toBe(cookieLeg.init.signal);
  });
});

describe("the shared library instance", () => {
  // both cases need a yahoo-finance2 this file's earlier tests never touched — the module-level
  // `library` is memoised for the process's life, so a real instance may already be cached by
  // this point, making "one instance" trivially true regardless of library ??= vs library =.
  // vi.doMock plus a fresh dynamic import gives each case its own module graph instead.
  afterEach(() => {
    vi.doUnmock("yahoo-finance2");
    vi.resetModules();
  });

  it("constructs the library with versionCheck: false, never the library's own default", async () => {
    // default is true and, on the library's options-validation-failure path only, fetches
    // registry.npmjs.org — a process with no business resolving npm's hostname must never risk that
    vi.resetModules();
    const seenOptions: unknown[] = [];
    vi.doMock("yahoo-finance2", () => ({
      default: class {
        constructor(options: unknown) {
          seenOptions.push(options);
        }
        quote = async () => [];
        chart = async () => ({});
      },
    }));

    const { createYahooClient: freshCreateYahooClient } = await import("../server/yahoo-client.ts");
    await freshCreateYahooClient().chart("VTI", REQUEST);

    expect(seenOptions).toHaveLength(1);
    expect(seenOptions[0]).toMatchObject({ versionCheck: false });
  });

  it("builds one shared instance across calls, memoised rather than rebuilt", async () => {
    // a fresh instance per call would redo the cookie/crumb handshake on every history call —
    // the burst an unofficial, rate-limiting endpoint punishes
    vi.resetModules();
    let constructions = 0;
    vi.doMock("yahoo-finance2", () => ({
      default: class {
        constructor() {
          constructions += 1;
        }
        quote = async () => [];
        chart = async () => ({});
      },
    }));

    const { createYahooClient: freshCreateYahooClient } = await import("../server/yahoo-client.ts");
    const client = freshCreateYahooClient();
    await client.chart("VTI", REQUEST);
    await client.chart("VTI", REQUEST);

    expect(constructions).toBe(1);
  });
});
