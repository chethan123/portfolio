/**
 * The client's own surface — what `server/yahoo-client.ts` adds on top of
 * `yahoo-finance2`: a constructed instance rather than the class's own
 * broken static, the request it forwards, `validateResult: false`'s effect
 * on a drifted field, and the fixed timeout every call gets. No network:
 * every case swaps `globalThis.fetch` for the duration of the test, since
 * the client sets neither a constructor `fetch` nor a per-call one, so the
 * library falls through to it (`yahooFinanceFetch.js:58`).
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

describe("the deadline every call carries", () => {
  it("defaults to thirty seconds, the number the spec fixes and no caller may change", async () => {
    // The default is what production uses — the worker, the adapter and the
    // probe all call `createYahooClient()` with no argument — so the number
    // itself needs a case. Read off the signal the call forwards rather than
    // waited out.
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
    // `AbortSignal.timeout` keeps its deadline private, so the observable is
    // that it has not fired: a one-millisecond default would abort by now.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(signal?.aborted).toBe(false);
  });

  it("passes exactly 30 000 ms to AbortSignal.timeout, not merely something above 50 ms", async () => {
    // The case above only pins "greater than about 50 ms" — 100 ms and 60 s
    // both survive it. A default above `server.timeout` would silently put
    // every call past the worker's own socket watchdog.
    //
    // Fake timers were tried first and do not work here: verified on Node
    // 24.12.0 that `vi.useFakeTimers()` (any `toFake` set) never flips a
    // `AbortSignal.timeout(...)` signal's `.aborted` even after advancing
    // past its delay — the internal timer it schedules is not one Node
    // routes through the global `setTimeout` that fake timers patch. A
    // direct spy on `AbortSignal.timeout` reads the exact argument instead,
    // with no waiting at all.
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

describe("the per-call options built for each request", () => {
  it("gives two calls made more than the deadline apart two different, live signals", async () => {
    // A hoisted `moduleOptions` (one built per client rather than per call)
    // would hand the second call the same, already-expired signal: the
    // worker builds one client for the process's life, so from 30 s after
    // start every call would carry a pre-aborted signal and answer 504
    // forever, silently.
    const seenSignals: Array<AbortSignal | undefined> = [];
    globalThis.fetch = (async (_url: string | URL, init: RequestInit) => {
      seenSignals.push(init.signal ?? undefined);
      return new Response(chartResponseBody());
    }) as typeof fetch;

    const client = createYahooClient({ timeoutMs: 50 });

    const first = await client.chart("VTI", REQUEST);
    // Longer than the client's own 50 ms deadline.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await client.chart("VTI", REQUEST);

    // Both succeeding alone proves too little — a fake that never inspects
    // `init.signal` would let a hoisted, already-expired one "succeed" the
    // same way, which is why the signal identity below is the real pin.
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

describe("the shared library instance", () => {
  // Both cases here need a `yahoo-finance2` this file's earlier tests never
  // touched — the module-level `library` in server/yahoo-client.ts is
  // memoised for the life of the process, so by this point in the file a
  // real instance may already be cached from a prior case, which would make
  // "one instance" trivially true regardless of `library ??=` vs `library =`.
  // `vi.doMock` plus a fresh dynamic import gives each case its own module
  // graph instead.
  afterEach(() => {
    vi.doUnmock("yahoo-finance2");
    vi.resetModules();
  });

  it("constructs the library with versionCheck: false, never the library's own default", async () => {
    // The default is `true` and, on the library's options-validation-failure
    // path only, fetches registry.npmjs.org/yahoo-finance2/latest — a
    // process with no business resolving npm's hostname must never risk that
    // call (module header).
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
    // A fresh instance per call would redo the library's cookie/crumb
    // handshake on every history call — the burst an unofficial,
    // rate-limiting endpoint punishes (module header).
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
