/**
 * Transport in front of the worker (spec 0018 §3.3): `ask`, and socketProvider()/socketProbe
 * built on it. No database — a real startWorker on a temp unix socket, a fake Yahoo client per
 * case (price-worker.test.ts's shape); pins the HTTP exchange and batching, never the worker's
 * own protocol. PRICE_WORKER_SOCKET is set once, before any getConfig() call, since it memoises
 * on first use (price-poller.test.ts:37's precedent) — every case but the ENOTDIR one (which
 * needs vi.resetModules() for a fresh path) shares this fixed path.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderUnreachable } from "~/lib/price-provider.server";
import { ask, socketProbe, socketProvider } from "~/lib/provider-socket.server";

import * as configModule from "../server/config.ts";
import { startWorker } from "../server/price-worker.ts";

import type { HistoryRange, PriceProvider } from "~/lib/price-provider.server";
import type { YahooClient } from "../server/yahoo-client.ts";

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

    // before mockRestore(), which also clears the recorded calls
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("AAA/BBB"));
    warn.mockRestore();

    expect(seen).toEqual([["VTI"]]);
    expect(quotes.map((quote) => quote.symbol)).toEqual(["VTI"]);
  });

  it("scrubs a refused symbol's newline before it reaches the log, so a forged line stays inert", async () => {
    // ask's own scrubForLog guard, at its other call site: instrument-resolution.server.ts
    // accepts any character in a stored symbol, even when the probe was "unavailable" — one
    // saved with a newline would otherwise forge an operator-visible log line on every refresh
    const seen: string[][] = [];
    await start({
      quote: async (symbols) => {
        seen.push(symbols);
        return [{ symbol: "VTI", regularMarketPrice: 271.5, currency: "USD" }];
      },
      chart: async () => ({}),
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const quotes = await socketProvider().getQuotes(["VTI", "AAA\nPrice worker: forged line"]);

    // before mockRestore(), which also clears the recorded calls
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0]!;
    expect(message).toBe(
      "Price provider: dropping symbols the pattern refuses: AAA Price worker: forged line",
    );
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
            // range's own end — exclusive, never sent to the worker as period2 — must be filtered client-side
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

  it("rejects with ProviderUnreachable, rather than answering no-history, when no worker is listening", async () => {
    // not start(): nothing listening at SOCKET_PATH is exactly what a dead worker looks like.
    // isMissingHistory matches on message stems alone, never the error's class — this is the
    // case that would silently pass if that check ever widened to catch ProviderUnreachable too
    await expect(socketProvider().getDailyCloses("VTI", RANGE, NEW_YORK)).rejects.toBeInstanceOf(
      ProviderUnreachable,
    );
  });
});

describe("ask", () => {
  it("keeps the history budget past the worker's own Yahoo watchdog", async () => {
    // spied, not waited out — a real 30s+ timeout would make this test as slow as the bug it
    // guards against. AbortSignal.timeout(budgetMs) is ask's one call per request, so its
    // argument is BUDGET_MS.history. 30_000 here (not an import) is Yahoo's own fetch timeout
    // default (yahoo-client.ts:135), not PRODUCTION_TIMEOUTS.timeout (Node's idle bound, a
    // different, only-coincidentally-equal 35s). A shorter budget would always win the race
    // and report "no answer" where the worker's 504 already carries the reason.
    await start({ quote: async () => [], chart: async () => ({}) });

    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    await ask("history", { symbol: "VTI", from: "2024-06-01" });
    const historyBudgetMs = timeoutSpy.mock.calls[0]?.[0];
    timeoutSpy.mockRestore();

    const YAHOO_WATCHDOG_MS = 30_000;
    expect(historyBudgetMs).toBeGreaterThan(YAHOO_WATCHDOG_MS);
  });

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
    // no start() — nothing listening at SOCKET_PATH; a slow answer would not fail this fast
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
    // rule is keyed on the syscall, not a code list — a different code, same branch (EACCES via
    // a 0600 socket owned by another uid would work too, but isn't runnable in CI)
    const parent = join(tmpdir(), `psock-parent-${randomBytes(4).toString("hex")}`);
    writeFileSync(parent, "");
    const badPath = join(parent, "worker.sock");

    // fresh module graph: getConfig() already memoised SOCKET_PATH for every top-level
    // binding — resetModules + a dynamic re-import gives this case its own config instance
    vi.resetModules();
    process.env.PRICE_WORKER_SOCKET = badPath;
    const { ask: freshAsk } = await import("~/lib/provider-socket.server");

    let caught: unknown;
    try {
      await freshAsk("quotes", { symbols: ["VTI"] });
    } catch (error) {
      caught = error;
    } finally {
      // shared ask binding is already memoised and unaffected; restoring the env var keeps the
      // process honest for anything else reading it directly
      process.env.PRICE_WORKER_SOCKET = SOCKET_PATH;
    }

    expect((caught as Error)?.name).toBe("ProviderUnreachable");
    expect((caught as Error)?.message).toBe(`no worker listening at ${badPath} (ENOTDIR)`);
  });

  it("does not treat a mid-stream read error as ProviderUnreachable", async () => {
    // rule is keyed on syscall === "connect" and nothing broader — a mid-stream ECONNRESET
    // carries syscall: "read" and must reach the caller as a plain, ledgered failure, never
    // abort the batch as if no worker were reachable. A real TCP reset isn't reproducible over
    // a unix socket here, so this synthesises the exact error shape on the real request.
    await start({
      // never resolves — nothing here should settle the promise before the synthetic error does
      quote: () => new Promise<never>(() => undefined),
      chart: async () => ({}),
    });

    const requestSpy = vi.spyOn(http, "request");
    const promise = ask("quotes", { symbols: ["VTI"] }, { budgetMs: 5_000 });

    // one microtask turn so http.request has actually run and returned
    await new Promise((resolve) => setImmediate(resolve));
    const req = requestSpy.mock.results[0]?.value as ReturnType<typeof http.request>;
    const readReset = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
      syscall: "read",
    });
    req.emit("error", readReset);

    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    } finally {
      requestSpy.mockRestore();
    }

    expect(caught).not.toBeInstanceOf(ProviderUnreachable);
    expect((caught as Error)?.message).toBe("read ECONNRESET");
  });

  it(
    "throws the budget error under a 200ms budget, the request's own error an AbortError whose cause is TimeoutError",
    async () => {
      await start({
        // never resolves — the budget, not the fake, is what ends this call
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

  it(
    "rejects, well within its budget, when the peer destroys the socket after the headers and before the declared body completes",
    async () => {
      // not start(): sendJson writes the whole answer in one res.end(), which can never
      // reproduce a death mid-body. Needs a raw server to put the socket in the exact state a
      // worker killed mid-answer (OOM kill, restart) leaves it in: headers sent, part of a
      // declared body written, connection destroyed with no FIN/RST courtesy.
      currentServer = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
        res.write("x".repeat(500));
        // setImmediate, not sync destroy — a same-tick destroy surfaces as a plain "socket hang
        // up" error instead, never exercising the gap this test pins
        setImmediate(() => res.socket?.destroy());
      });
      await new Promise<void>((resolve) => currentServer!.listen(SOCKET_PATH, resolve));

      const startedAt = Date.now();
      await expect(ask("quotes", { symbols: ["VTI"] }, { budgetMs: 5_000 })).rejects.toThrow(
        "the worker's connection closed before the quotes answer completed",
      );

      // well under the 5s budget: req's own close settles the promise, never the budget
      // expiring — this would time out at 5s if the fix regressed
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    },
    10_000,
  );

  it("scrubs a control character out of a non-200 error before it becomes the rejection's message", async () => {
    // JSON.stringify escapes this on the wire, but this is the first thing under app/ that
    // JSON.parses a worker error body back — a forged line would otherwise print as three
    // physical lines wherever this Error's message lands
    await start({
      quote: async () => {
        throw new Error("boom\nPrice worker: forged line\nmore");
      },
      chart: async () => ({}),
    });

    let caught: unknown;
    try {
      await ask("quotes", { symbols: ["VTI"] });
    } catch (error) {
      caught = error;
    }

    expect((caught as Error)?.message).toBe("boom Price worker: forged line more");
  });

  it("caps a non-200 error's length at 1000 characters", async () => {
    // raw server, not start(): the real worker's providerErrorText already cuts to this limit
    // before the wire, so a fake YahooClient throwing something huge would only prove the
    // worker's own cap, never this reading side's — a compromised worker skips its own cap
    currentServer = http.createServer((req, res) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "x".repeat(300_000) }));
    });
    await new Promise<void>((resolve) => currentServer!.listen(SOCKET_PATH, resolve));

    let caught: unknown;
    try {
      await ask("quotes", { symbols: ["VTI"] });
    } catch (error) {
      caught = error;
    }

    expect((caught as Error)?.message).toHaveLength(1_000);
  });

  it("rejects, rather than silently answering as if nothing came back, when a 200 body is not valid JSON", async () => {
    // raw server again: sendJson always writes valid JSON, so only a server outside the
    // worker's protocol can produce this. Swallowing it silently would read a quotes batch
    // back as empty or a history call as no-history — neither is true: something answered
    currentServer = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("not json");
    });
    await new Promise<void>((resolve) => currentServer!.listen(SOCKET_PATH, resolve));

    await expect(ask("quotes", { symbols: ["VTI"] })).rejects.toThrow(
      "quotes response from the worker was not valid JSON",
    );
  });

  it("rejects an empty body on a 200, but still takes the status-only path when a non-200 has one", async () => {
    // two different meanings for the same empty wire shape: a 200 with nothing behind it is
    // the same lie an unparseable body is (a drifted undefined result rendering as no body).
    // A non-200 with nothing behind it is the legitimate shape of a refusal Node itself writes
    // (its clientError path) — that half must still resolve via the ordinary status fallback.
    const empty200 = http.createServer((req, res) => {
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((resolve) => empty200.listen(SOCKET_PATH, resolve));

    await expect(ask("quotes", { symbols: ["VTI"] })).rejects.toThrow(
      "the worker answered quotes with 200 and an empty body",
    );

    await new Promise<void>((resolve) => empty200.close(() => resolve()));

    // fresh server on the same path (safe: the unix socket file goes with the first server's
    // close) for the non-200 half, so this one test pins both
    currentServer = http.createServer((req, res) => {
      res.writeHead(502);
      res.end();
    });
    await new Promise<void>((resolve) => currentServer!.listen(SOCKET_PATH, resolve));

    await expect(ask("quotes", { symbols: ["VTI"] })).rejects.toThrow("502");
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

      // one bad batch costs every symbol in it its guard, and the only trace is this one line
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

  it("keeps the second chunk's verdict, non-usd included, when only the first chunk's request throws", async () => {
    // first chunk's ask throws immediately and the second still runs and keeps its own verdict
    // — proof socketProbe has no `break` after a failed batch. A real timeout on the last chunk
    // could never pin this (nothing after it to skip), so a fast thrown failure is enough here.
    let call = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await start({
      quote: async (symbols) => {
        call += 1;
        if (call === 1) {
          throw new Error("502 Bad Gateway");
        }
        return symbols.map((symbol) => ({ symbol, regularMarketPrice: 10, currency: "GBP" }));
      },
      chart: async () => ({}),
    });

    const symbols = Array.from({ length: 101 }, (_, i) => `S${i}`);
    const verdicts = await socketProbe(symbols);
    warn.mockRestore();

    expect(verdicts.get("S0")).toEqual({ status: "unavailable" });
    expect(verdicts.get("S99")).toEqual({ status: "unavailable" });
    // second chunk's own verdict, not the trailing default — the only way to tell "ran and
    // answered" from "skipped by a break", since both land the first chunk's symbols on unavailable
    expect(verdicts.get("S100")).toEqual({ status: "non-usd", currency: "GBP" });
  });
});

describe("socketProvider()'s own construction", () => {
  it("reads no configuration until a method is actually called", async () => {
    // .not.toThrow() alone can't tell "reads no config" from "reads it and happens not to
    // throw" — spying on the getConfig binding provider-socket.server.ts imports is what
    // actually pins "not called yet" against "called once a method runs"
    const getConfigSpy = vi.spyOn(configModule, "getConfig");

    let provider: PriceProvider | undefined;
    expect(() => {
      provider = socketProvider();
    }).not.toThrow();
    expect(getConfigSpy).not.toHaveBeenCalled();

    await start({ quote: async () => [], chart: async () => ({}) });
    await provider!.getQuotes(["VTI"]);
    expect(getConfigSpy).toHaveBeenCalled();

    getConfigSpy.mockRestore();
  });
});
