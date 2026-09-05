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

  it("rejects with ProviderUnreachable, rather than answering no-history, when no worker is listening", async () => {
    // Not `start()`: nothing listening at `SOCKET_PATH` is exactly what a
    // dead worker looks like. `isMissingHistory` matches on message stems
    // alone (`price-provider.server.ts`), never on the error's class, so
    // this is the one case that would silently pass if that check ever
    // widened to catch `ProviderUnreachable` too — [01]'s own batch abort
    // depends on this propagating, not on it being ledgered `no_history`.
    await expect(socketProvider().getDailyCloses("VTI", RANGE, NEW_YORK)).rejects.toBeInstanceOf(
      ProviderUnreachable,
    );
  });
});

describe("ask", () => {
  it("keeps the history budget past the worker's own Yahoo watchdog", async () => {
    // Spied rather than waited out: actually letting a history call run 30s+
    // to observe the real timeout would make this test as slow as the thing
    // it is guarding against. `AbortSignal.timeout(budgetMs)` is `ask`'s own
    // one call per request, so its argument is the exact number
    // `BUDGET_MS.history` resolves to today, captured without waiting for it
    // to fire.
    //
    // `30_000` here, not an import: the worker's own watchdog is Yahoo's own
    // fetch timeout, `createYahooClient`'s `timeoutMs` default
    // (`server/yahoo-client.ts:135`) — a default parameter, not an exported
    // constant, and *not* `PRODUCTION_TIMEOUTS.timeout` (`server/price-worker
    // .ts`), which is Node's own idle-connection bound, a different 35s that
    // only coincidentally equals `BUDGET_MS.history` today and would still
    // equal it after the exact swap this pins.
    //
    // Module header: a shorter budget would always win the race against the
    // worker's own watchdog by transit time alone and report only "no
    // answer" where the worker's `504` already carries the reason — the
    // failure this budget exists to avoid, and the one a `quotes`/`history`
    // swap between the two constants would silently reintroduce.
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

  it("does not treat a mid-stream read error as ProviderUnreachable", async () => {
    // The rule is keyed on `syscall === "connect"` and nothing broader — a
    // mid-stream `ECONNRESET` carries `syscall: "read"`, the exact case
    // `agent: false`'s own reasoning names, and must reach the caller as a
    // plain, ledgered failure, never abort the batch as though no worker
    // were reachable. Real OS-level TCP resets are not reproducible over a
    // unix domain socket in this environment (`net.Socket#resetAndDestroy`
    // rejects a pipe handle outright), so this synthesises the exact error
    // shape a genuine one carries and emits it on the real request `http
    // .request` returns, spied on rather than replaced.
    await start({
      // Never resolves — nothing here should settle the promise before the
      // synthetic error below does.
      quote: () => new Promise<never>(() => undefined),
      chart: async () => ({}),
    });

    const requestSpy = vi.spyOn(http, "request");
    const promise = ask("quotes", { symbols: ["VTI"] }, { budgetMs: 5_000 });

    // One microtask turn so `http.request` has actually run and returned.
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

  it(
    "rejects, well within its budget, when the peer destroys the socket after the headers and before the declared body completes",
    async () => {
      // Not `start()`: `startWorker`'s own `sendJson` writes the whole answer
      // in one `res.end()`, which can never reproduce a death mid-body. This
      // is the one case in this file that needs a raw server instead, to put
      // the socket in the exact state a worker killed mid-answer (an OOM
      // kill, spec 0018's own `mem_limit`, or a bare restart) leaves it in:
      // headers sent, part of a declared body written, then the connection
      // destroyed with no FIN and no RST courtesy.
      currentServer = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
        res.write("x".repeat(500));
        // `setImmediate`, not a synchronous destroy: a same-tick destroy
        // instead surfaces as a `req` `error` ("socket hang up") the
        // existing catch-all already rejects with, and never exercises the
        // gap this test pins — the peer genuinely finishing its write before
        // dying, which is what an OOM kill or a `docker compose restart`
        // between writes actually leaves the socket looking like.
        setImmediate(() => res.socket?.destroy());
      });
      await new Promise<void>((resolve) => currentServer!.listen(SOCKET_PATH, resolve));

      const startedAt = Date.now();
      await expect(ask("quotes", { symbols: ["VTI"] }, { budgetMs: 5_000 })).rejects.toThrow(
        "the worker's connection closed before the quotes answer completed",
      );

      // Well under the 5s budget: this is `req`'s own `close` settling the
      // promise, never the budget expiring (`ask`'s own 200ms case already
      // pins that path; this one would time out at 5s if the fix regressed).
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    },
    10_000,
  );

  it("scrubs a control character out of a non-200 error before it becomes the rejection's message", async () => {
    // `JSON.stringify` escapes this on the wire, but this line is the first
    // thing under `app/` that `JSON.parse`s a worker error body back — a
    // forged line under the worker's own `Price worker:` stem, or Yahoo's own
    // HTTP error body copied verbatim by `providerErrorText`, would otherwise
    // print as three physical lines wherever this `Error`'s message lands.
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
    // A raw server, not `start()`: the real worker's own `providerErrorText`
    // already cuts to the same limit before it ever reaches the wire, so a
    // fake `YahooClient` throwing something huge would only prove the
    // worker's own cap, never this reading side's — a compromised worker (F1)
    // is exactly a worker that skips its own writing-side cap.
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
    // A raw server again (module header on the earlier case): `sendJson`
    // always writes valid JSON, so only a server outside the worker's own
    // protocol can produce this. Silently swallowing it would read a quotes
    // batch back as empty (`providerFailed: false`, nothing logged) or a
    // history call back as `no-history` — `price-provider.server.ts`'s own
    // "a lie the ledger repeats" — neither of which is the truth: something
    // answered, and it was not the shape promised.
    currentServer = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("not json");
    });
    await new Promise<void>((resolve) => currentServer!.listen(SOCKET_PATH, resolve));

    await expect(ask("quotes", { symbols: ["VTI"] })).rejects.toThrow(
      "quotes response from the worker was not valid JSON",
    );
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

  it("keeps the second chunk's verdict, non-usd included, when only the first chunk's request throws", async () => {
    // The first chunk's `ask` throws immediately (a worker `502`, say) and
    // the second still runs and keeps its own verdict — proof `socketProbe`
    // has no `break` after a failed batch, which a real timeout on the
    // *second* (last) chunk could never pin: there would be nothing after it
    // to skip. `ask`'s own 200ms budget case above already pins the real
    // timeout path itself, so this only needs a fast, thrown failure.
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
    // The second chunk's own verdict, not the trailing "never reached a
    // batch" default — the only way to tell "ran and answered" from "skipped
    // by a `break`", since both a skip and a genuine failure land the first
    // chunk's symbols on `unavailable` the same way.
    expect(verdicts.get("S100")).toEqual({ status: "non-usd", currency: "GBP" });
  });
});

describe("socketProvider()'s own construction", () => {
  it("reads no configuration until a method is actually called", async () => {
    // `.not.toThrow()` alone cannot tell "reads no configuration" from "reads
    // it and happens not to throw" — a builder that called `getConfig()`
    // eagerly would still pass that assertion whenever the path is set, and
    // only fail it once `PRICE_WORKER_SOCKET` was unset entirely. Spying on
    // the same `getConfig` binding `provider-socket.server.ts` imports is
    // what actually pins "not called yet" against "called once a method
    // runs" — the claim the module header makes (`app/lib/provider-socket
    // .server.ts:283-291` in the ticket's own numbering).
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
