/**
 * The transport in front of the worker (spec 0018 §3.3): `ask` itself, and
 * `socketProvider()`/`socketProbe` built on it. No database — the point of
 * this seam is that it never needs one. A real `startWorker` on a temporary
 * unix socket and a fake Yahoo client per case (`tests/price-worker.test.ts`'s
 * own shape), so what is pinned here is the HTTP exchange and the batching in
 * front of it, never the worker's own protocol (that file's).
 *
 * `PRICE_WORKER_SOCKET` is set once, below, **before any test's first call of
 * `getConfig()`** — imports are hoisted, so this only works because
 * `getConfig` reads lazily and memoises on first use rather than at import
 * time (`server/config.ts`'s own `getConfig`; `tests/price-poller.test.ts:37`
 * is the precedent for `DATABASE_URL`). That memoisation is also why every
 * case but one shares the same fixed path: once `getConfig()` has answered
 * once in this file, nothing later can change it. The one exception — the
 * `ENOTDIR` case, which needs a structurally different, broken path — gets
 * its own fresh module graph through `vi.resetModules()` (`tests/yahoo-client
 * .test.ts`'s own pattern), never by mutating this file's shared path.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ask, socketProbe, socketProvider } from "~/lib/provider-socket.server";

import { startWorker } from "../server/price-worker.ts";

import type { HistoryRange } from "~/lib/price-provider.server";
import type { YahooClient } from "../server/yahoo-client.ts";
import type http from "node:http";

const SOCKET_PATH = join(tmpdir(), `psock-${randomBytes(4).toString("hex")}.sock`);
process.env.PRICE_WORKER_SOCKET = SOCKET_PATH;

const NEW_YORK = "America/New_York";
const RANGE: HistoryRange = { from: "2024-06-01", until: "2024-12-31" };

let currentServer: http.Server | undefined;

afterEach(async () => {
  if (currentServer === undefined) return;
  await new Promise<void>((resolve) => currentServer!.close(() => resolve()));
  currentServer = undefined;
});

/** Starts a real worker on {@link SOCKET_PATH} with the given fake Yahoo client. */
async function start(yahoo: YahooClient): Promise<void> {
  currentServer = await startWorker({ socketPath: SOCKET_PATH, yahoo });
}

describe("socketProvider().getQuotes", () => {
  it("returns the parsed quotes and skips a CurrencyRefused", async () => {
    await start({
      quote: async () => [
        { symbol: "VTI", regularMarketPrice: 271.5, currency: "USD" },
        { symbol: "VOD.L", regularMarketPrice: 71.5, currency: "GBP" },
      ],
      chart: async () => ({}),
    });

    const quotes = await socketProvider().getQuotes(["VTI", "VOD.L"]);

    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.symbol).toBe("VTI");
    expect(quotes[0]?.price).toBe("271.5000");
  });

  it("drops a symbol the pattern refuses, logs it, and sends the request with the rest", async () => {
    const seen: string[][] = [];
    await start({
      quote: async (symbols) => {
        seen.push(symbols);
        return [{ symbol: "VTI", regularMarketPrice: 271.5, currency: "USD" }];
      },
      chart: async () => ({}),
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const quotes = await socketProvider().getQuotes(["VTI", "AAA/BBB"]);

    // Before `mockRestore()`, which also clears the recorded calls.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("AAA/BBB"));
    warn.mockRestore();

    expect(seen).toEqual([["VTI"]]);
    expect(quotes.map((quote) => quote.symbol)).toEqual(["VTI"]);
  });

  it("splits 101 symbols into two requests", async () => {
    const seen: string[][] = [];
    await start({
      quote: async (symbols) => {
        seen.push(symbols);
        return [];
      },
      chart: async () => ({}),
    });

    const symbols = Array.from({ length: 101 }, (_, i) => `S${i}`);
    await socketProvider().getQuotes(symbols);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toHaveLength(100);
    expect(seen[1]).toHaveLength(1);
  });
});

describe("socketProvider().getDailyCloses", () => {
  it("sends the matchKey'd symbol and range.from, and applies until on the answer", async () => {
    const seen: Array<{ symbol: string; options: unknown }> = [];
    await start({
      quote: async () => [],
      chart: async (symbol, options) => {
        seen.push({ symbol, options });
        return {
          meta: { currency: "USD" },
          quotes: [
            { date: "2024-06-07T13:30:00Z", close: 10 },
            // On the range's own end — exclusive, and never sent to the
            // worker as `period2` (module header) — so this must be filtered
            // here, client-side, or it would leak into the spine.
            { date: "2024-06-12T13:30:00Z", close: 11 },
          ],
        };
      },
    });

    const range: HistoryRange = { from: "2024-06-01", until: "2024-06-12" };
    const history = await socketProvider().getDailyCloses(" vti ", range, NEW_YORK);

    expect(seen).toEqual([
      { symbol: "VTI", options: { period1: "2024-06-01", interval: "1d", events: "split" } },
    ]);
    expect(history).toEqual({ status: "ok", closes: [{ date: "2024-06-07", close: "10.0000" }] });
  });

  it("answers no-history for a 502 saying 'No data found'", async () => {
    await start({
      quote: async () => [],
      chart: async () => {
        throw new Error("No data found, symbol may be delisted");
      },
    });

    expect(await socketProvider().getDailyCloses("GONE", RANGE, NEW_YORK)).toEqual({
      status: "no-history",
    });
  });
});

describe("ask", () => {
  it("throws a 502 whose text does not match a missing-history stem", async () => {
    await start({
      quote: async () => [],
      chart: async () => {
        throw new Error("429 Too Many Requests");
      },
    });

    await expect(ask("history", { symbol: "VTI", from: "2024-06-01" })).rejects.toThrow(
      "429 Too Many Requests",
    );
  });

  it("throws for a 429 once the worker's own rate cap is spent", async () => {
    await start({ quote: async () => [], chart: async () => ({}) });

    for (let i = 0; i < 10; i++) {
      await ask("quotes", { symbols: ["VTI"] });
    }

    await expect(ask("quotes", { symbols: ["VTI"] })).rejects.toThrow("rate limited");
  });

  it("throws ProviderUnreachable naming the path and ENOENT when no worker is listening, well within a second", async () => {
    // No `start()` — nothing is listening at `SOCKET_PATH`, the assertion
    // that this is a connect failure and not a grace: a slow answer would
    // not fail this fast.
    const startedAt = Date.now();

    let caught: unknown;
    try {
      await ask("quotes", { symbols: ["VTI"] });
    } catch (error) {
      caught = error;
    }

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect((caught as Error)?.name).toBe("ProviderUnreachable");
    expect((caught as Error)?.message).toBe(`no worker listening at ${SOCKET_PATH} (ENOENT)`);
  });

  it("throws ProviderUnreachable naming ENOTDIR when the path's parent is a regular file", async () => {
    // The rule is keyed on the syscall, not a code list — this is the case
    // that pins that: a different code, same branch. A `0600` socket owned
    // by another uid would exercise `EACCES` the same way, but is not
    // runnable in CI.
    const parent = join(tmpdir(), `psock-parent-${randomBytes(4).toString("hex")}`);
    writeFileSync(parent, "");
    const badPath = join(parent, "worker.sock");

    // A fresh module graph: `getConfig()` has already memoised `SOCKET_PATH`
    // for every binding imported at the top of this file, and nothing can
    // change that — `vi.resetModules()` plus a dynamic re-import is what
    // gives this one case its own `server/config.ts` instance instead
    // (`tests/yahoo-client.test.ts`'s own pattern).
    vi.resetModules();
    process.env.PRICE_WORKER_SOCKET = badPath;
    const { ask: freshAsk } = await import("~/lib/provider-socket.server");

    let caught: unknown;
    try {
      await freshAsk("quotes", { symbols: ["VTI"] });
    } catch (error) {
      caught = error;
    } finally {
      // The original path never actually changed for the file's own shared
      // `ask` binding (already memoised), but restoring the environment
      // variable itself keeps the process honest for anything else that
      // might read it directly.
      process.env.PRICE_WORKER_SOCKET = SOCKET_PATH;
    }

    expect((caught as Error)?.name).toBe("ProviderUnreachable");
    expect((caught as Error)?.message).toBe(`no worker listening at ${badPath} (ENOTDIR)`);
  });

  it(
    "throws the budget error under a 200ms budget, the request's own error an AbortError whose cause is TimeoutError",
    async () => {
      await start({
        // Never resolves: the budget, not the fake, is what ends this call.
        quote: () => new Promise<never>(() => undefined),
        chart: async () => ({}),
      });

      let caught: unknown;
      try {
        await ask("quotes", { symbols: ["VTI"] }, { budgetMs: 200 });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("the worker did not answer quotes within 200ms");

      const requestError = (caught as Error & { cause?: unknown }).cause;
      expect(requestError).toBeInstanceOf(Error);
      expect((requestError as Error).name).toBe("AbortError");
      const timeoutError = (requestError as Error & { cause?: unknown }).cause;
      expect((timeoutError as Error)?.name).toBe("TimeoutError");
    },
    5_000,
  );

  it("throws when a 200 quotes body exceeds the 512 KB cap", async () => {
    const padding = "x".repeat(512 * 1024 + 1);
    await start({
      quote: async () => [{ padding }],
      chart: async () => ({}),
    });

    await expect(ask("quotes", { symbols: ["VTI"] })).rejects.toThrow(/exceeded 524288 bytes/);
  });

  it("throws when a 200 history body exceeds the 2 MiB cap", async () => {
    const padding = "x".repeat(2 * 1024 * 1024 + 1);
    await start({
      quote: async () => [],
      chart: async () => ({ padding }),
    });

    await expect(
      ask("history", { symbol: "VTI", from: "2024-06-01" }),
    ).rejects.toThrow(/exceeded 2097152 bytes/);
  });
});

describe("socketProbe", () => {
  it("answers ok for a symbol that resolves in USD", async () => {
    await start({
      quote: async () => [{ symbol: "VTI", regularMarketPrice: 271.5, currency: "USD" }],
      chart: async () => ({}),
    });

    const verdicts = await socketProbe(["VTI"]);

    expect(verdicts.get("VTI")).toEqual({ status: "ok", quoteType: null });
  });

  it("answers non-usd with the currency for a foreign listing", async () => {
    await start({
      quote: async () => [{ symbol: "VOD.L", regularMarketPrice: 71.5, currency: "GBP" }],
      chart: async () => ({}),
    });

    const verdicts = await socketProbe(["VOD.L"]);

    expect(verdicts.get("VOD.L")).toEqual({ status: "non-usd", currency: "GBP" });
  });

  it("answers unavailable for a symbol the feed never mentions", async () => {
    await start({ quote: async () => [], chart: async () => ({}) });

    const verdicts = await socketProbe(["MISTYPED"]);

    expect(verdicts.get("MISTYPED")).toEqual({ status: "unavailable" });
  });

  it("drops a symbol the pattern refuses, without poisoning the rest of the batch", async () => {
    await start({
      quote: async (symbols) =>
        symbols.map((symbol) => ({ symbol, regularMarketPrice: 10, currency: "USD" })),
      chart: async () => ({}),
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const verdicts = await socketProbe(["VTI", "AAA/BBB"]);
    warn.mockRestore();

    expect(verdicts.get("VTI")).toEqual({ status: "ok", quoteType: null });
    expect(verdicts.get("AAA/BBB")).toEqual({ status: "unavailable" });
  });

  it(
    "answers unavailable for every symbol, one request, when no worker is listening — and logs once",
    async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const verdicts = await socketProbe(["VTI", "VXUS", "BND"]);

      // Before `mockRestore()`, which also clears the recorded calls. [02]'s
      // own point: one bad batch costs every symbol in it its guard, and the
      // only trace is this one line — `socketProbe`'s to write, where a
      // serial probe never had to.
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();

      expect(verdicts).toEqual(
        new Map([
          ["VTI", { status: "unavailable" }],
          ["VXUS", { status: "unavailable" }],
          ["BND", { status: "unavailable" }],
        ]),
      );
    },
  );

  it("splits 101 symbols into two chunks, each answered on its own", async () => {
    const seen: string[][] = [];
    await start({
      quote: async (symbols) => {
        seen.push(symbols);
        return symbols.map((symbol) => ({ symbol, regularMarketPrice: 10, currency: "USD" }));
      },
      chart: async () => ({}),
    });

    const symbols = Array.from({ length: 101 }, (_, i) => `S${i}`);
    const verdicts = await socketProbe(symbols);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toHaveLength(100);
    expect(seen[1]).toHaveLength(1);
    expect(verdicts.get("S0")).toEqual({ status: "ok", quoteType: null });
    expect(verdicts.get("S100")).toEqual({ status: "ok", quoteType: null });
  });

  it(
    "keeps the first chunk's verdicts, non-usd included, when only the second chunk times out",
    async () => {
      let call = 0;
      await start({
        quote: async (symbols) => {
          call += 1;
          if (call === 1) {
            // The first chunk answers — one refusal among ordinary quotes.
            return symbols.map((symbol, index) =>
              index === 0
                ? { symbol, regularMarketPrice: 10, currency: "GBP" }
                : { symbol, regularMarketPrice: 10, currency: "USD" },
            );
          }
          // The second chunk never resolves — `socketProbe`'s own 10s budget
          // is what ends it, a real wait rather than a substitute failure,
          // since the chunk-isolation this pins is only meaningful against
          // the actual timeout path `ask`'s own test above already proved.
          return new Promise(() => undefined);
        },
        chart: async () => ({}),
      });

      const symbols = Array.from({ length: 101 }, (_, i) => `S${i}`);
      const verdicts = await socketProbe(symbols);

      expect(verdicts.get("S0")).toEqual({ status: "non-usd", currency: "GBP" });
      expect(verdicts.get("S1")).toEqual({ status: "ok", quoteType: null });
      expect(verdicts.get("S100")).toEqual({ status: "unavailable" });
    },
    15_000,
  );
});

describe("socketProvider()'s own construction", () => {
  it("does not throw when built, only when its methods are called", () => {
    // `runRefresh`'s default parameter, evaluated before that function's own
    // `try` runs (`app/lib/refresh.server.ts`) — a constructor that threw
    // here would escape "never throws" straight into the route's error
    // boundary. Nothing about the socket or the configuration is touched
    // until `getQuotes`/`getDailyCloses` is actually called.
    expect(() => socketProvider()).not.toThrow();
  });
});
