/**
 * The price-worker process: a real `node:http` server on a temporary unix
 * socket, a fake Yahoo client, and raw HTTP over the socket — no database,
 * no compose. This file pins the protocol (spec 0018 §3.2, §3.5), so it
 * speaks HTTP directly rather than through the app's own client.
 *
 * A house trap worth stating once: a raw `net.Socket` with no `'data'`
 * listener stays *paused* and never notices the peer closing the
 * connection — every socket below that isn't otherwise read calls
 * `.resume()` right after connecting, or it would falsely look like the
 * server never closed it.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRODUCTION_TIMEOUTS, startWorker, type WorkerTimeouts } from "../server/price-worker.ts";
import { createYahooClient, type YahooClient } from "../server/yahoo-client.ts";

/** The entry point itself: the SIGTERM handler belongs to it, not to `startWorker`. */
const WORKER_ENTRY = fileURLToPath(new URL("../server/price-worker.ts", import.meta.url));

/** Wait until the worker has created its socket, or give up loudly. */
async function waitForSocket(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the worker never created ${path}`);
}

/**
 * Accumulates a readable stream's text until `predicate` is satisfied, or
 * gives up loudly with whatever arrived. `waitForSocket` above is the wrong
 * tool for pinning a log line: the socket file lands (`server.listen`)
 * before `startWorker`'s own `console.log`, so a case racing the file
 * instead of the stream could pass on a build that never logs at all.
 */
async function waitForStdout(
  stream: NodeJS.ReadableStream,
  predicate: (text: string) => boolean,
  timeoutMs = 5_000,
): Promise<string> {
  let text = "";
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`stream never matched within ${timeoutMs}ms; got: ${JSON.stringify(text)}`));
    }, timeoutMs);
    stream.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (predicate(text)) {
        clearTimeout(timer);
        resolve(text);
      }
    });
  });
}

/** Short on purpose: a unix socket path is 107 usable bytes on Linux. */
function freshSocketPath(): string {
  return join(tmpdir(), `pw-${randomBytes(4).toString("hex")}.sock`);
}

/** Tens of milliseconds, per the ticket — `connectionsCheckingInterval` 50 ms is research §8.9's own probe. */
const TEST_TIMEOUTS: WorkerTimeouts = {
  timeout: 200,
  headersTimeout: 150,
  requestTimeout: 150,
  connectionsCheckingInterval: 50,
};

function fakeYahoo(overrides: Partial<YahooClient> = {}): YahooClient {
  return {
    quote: overrides.quote ?? (async () => []),
    chart: overrides.chart ?? (async () => ({})),
  };
}

let currentServer: http.Server | undefined;
let currentSocketPath: string;
const originalFetch = globalThis.fetch;

/**
 * `mkdtemp` dirs the entry-point cases below create, so a socket path can
 * live somewhere `rm(currentSocketPath, ...)` above never reaches — removed
 * here rather than per-case, since a case that fails before its own cleanup
 * would otherwise leak the directory, as this file's own history did (117
 * empty `/tmp/pw-term-*` left behind).
 */
const entryPointTempDirs: string[] = [];

/** A fresh `mkdtemp` dir for an entry-point case, tracked above, and a socket path inside it. */
async function freshEntryPointSocket(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  entryPointTempDirs.push(dir);
  return join(dir, "w.sock");
}

beforeEach(() => {
  currentSocketPath = freshSocketPath();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (currentServer) {
    await new Promise<void>((resolve) => currentServer!.close(() => resolve()));
    currentServer = undefined;
  }
  await rm(currentSocketPath, { force: true, recursive: true });
  await Promise.all(
    entryPointTempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

async function start(
  yahoo: YahooClient,
  timeouts: WorkerTimeouts = TEST_TIMEOUTS,
): Promise<http.Server> {
  currentServer = await startWorker({ socketPath: currentSocketPath, yahoo, timeouts });
  return currentServer;
}

type JsonResponse = { status: number; headers: http.IncomingHttpHeaders; json: unknown; text: string };

/**
 * `agent: false`: this file's own sockets must not be kept alive into the
 * next case. A `content-length` is added for any `body` the caller does not
 * already frame itself: Node's client only adds `Transfer-Encoding: chunked`
 * on its own for a method conventionally carrying a body — a `GET` with an
 * unframed `.write()` sends the bytes on the wire with nothing telling the
 * server's parser they belong to this message, so they land as garbage after
 * the terminating blank line rather than in `req`'s body stream, and the
 * worker sees an empty body regardless of what was written.
 */
function rawRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: string,
  headers: http.OutgoingHttpHeaders = {},
): Promise<JsonResponse> {
  const framedHeaders =
    body === undefined || "content-length" in headers
      ? headers
      : { ...headers, "content-length": Buffer.byteLength(body) };
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, agent: false, method, path, headers: framedHeaders }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown;
        try {
          json = text.length > 0 ? JSON.parse(text) : undefined;
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json, text });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function requestJson(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<JsonResponse> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers =
    payload === undefined
      ? {}
      : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) };
  return rawRequest(socketPath, method, path, payload, headers);
}

function connectSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: socketPath });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("the three endpoints", () => {
  it("answers /healthz with 200 { ok: true }, the fake untouched", async () => {
    const quote = vi.fn(async () => []);
    const chart = vi.fn(async () => ({}));
    await start(fakeYahoo({ quote, chart }));

    const res = await rawRequest(currentSocketPath, "GET", "/healthz");

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(quote).not.toHaveBeenCalled();
    expect(chart).not.toHaveBeenCalled();
  });

  it("answers every JSON body with content-type: application/json", async () => {
    await start(fakeYahoo());

    const res = await rawRequest(currentSocketPath, "GET", "/healthz");

    expect(res.headers["content-type"]).toBe("application/json");
  });

  it("answers /quotes with the fake's array verbatim, Date values serialised as ISO strings", async () => {
    const asOf = new Date("2024-06-07T13:30:00Z");
    const quote = vi.fn(async () => [
      { symbol: "VTI", regularMarketPrice: 271.5, regularMarketTime: asOf },
    ]);
    await start(fakeYahoo({ quote }));

    const res = await requestJson(currentSocketPath, "POST", "/quotes", {
      symbols: ["VTI", "VXUS", "BND"],
    });

    expect(res.status).toBe(200);
    expect(quote).toHaveBeenCalledWith(["VTI", "VXUS", "BND"]);
    expect(res.json).toEqual([
      { symbol: "VTI", regularMarketPrice: 271.5, regularMarketTime: asOf.toISOString() },
    ]);
  });

  it("forwards period1, interval and events to the fake's chart", async () => {
    const chart = vi.fn(async () => ({ meta: { currency: "USD" }, quotes: [] }));
    await start(fakeYahoo({ chart }));

    const res = await requestJson(currentSocketPath, "POST", "/history", {
      symbol: "VTI",
      from: "2024-06-01",
    });

    expect(res.status).toBe(200);
    expect(chart).toHaveBeenCalledWith("VTI", {
      period1: "2024-06-01",
      interval: "1d",
      events: "split",
    });
    expect(res.json).toEqual({ meta: { currency: "USD" }, quotes: [] });
  });
});

describe("400: a body or route the worker refuses before any library call", () => {
  it("answers 400 for a symbol the pattern refuses", async () => {
    const quote = vi.fn(async () => []);
    await start(fakeYahoo({ quote }));

    const res = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: ["BRK/B"] });

    expect(res.status).toBe(400);
    expect(quote).not.toHaveBeenCalled();
  });

  it("answers 400 for a null element in symbols", async () => {
    const quote = vi.fn(async () => []);
    await start(fakeYahoo({ quote }));

    const res = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: [null] });

    expect(res.status).toBe(400);
    expect(quote).not.toHaveBeenCalled();
  });

  it("answers 400 for an empty symbols array", async () => {
    const quote = vi.fn(async () => []);
    await start(fakeYahoo({ quote }));

    const res = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: [] });

    expect(res.status).toBe(400);
    expect(quote).not.toHaveBeenCalled();
  });

  it("answers 400 for 101 symbols", async () => {
    const quote = vi.fn(async () => []);
    await start(fakeYahoo({ quote }));

    const symbols = Array.from({ length: 101 }, (_, i) => `S${i}`);
    const res = await requestJson(currentSocketPath, "POST", "/quotes", { symbols });

    expect(res.status).toBe(400);
    expect(quote).not.toHaveBeenCalled();
  });

  it("answers 400 for a /quotes body that is not JSON", async () => {
    const quote = vi.fn(async () => []);
    await start(fakeYahoo({ quote }));

    const res = await rawRequest(currentSocketPath, "POST", "/quotes", "not json at all");

    expect(res.status).toBe(400);
    expect(quote).not.toHaveBeenCalled();
  });

  it("answers 400 for a /history body with no from", async () => {
    const chart = vi.fn(async () => ({}));
    await start(fakeYahoo({ chart }));

    const res = await requestJson(currentSocketPath, "POST", "/history", { symbol: "VTI" });

    expect(res.status).toBe(400);
    expect(chart).not.toHaveBeenCalled();
  });

  it("answers 400 for a /history symbol that would escape into the URL path, the fake's chart never called", async () => {
    // On /quotes the library puts symbols in a query parameter that
    // URLSearchParams escapes anyway; on /history it concatenates the symbol
    // into the URL *path*
    // (node_modules/yahoo-finance2/esm/src/modules/chart.js), so an
    // unchecked symbol here reaches a different endpoint entirely.
    const chart = vi.fn(async () => ({}));
    await start(fakeYahoo({ chart }));

    const traversal = await requestJson(currentSocketPath, "POST", "/history", {
      symbol: "../../v1/test/getcrumb",
      from: "2024-06-01",
    });
    const slash = await requestJson(currentSocketPath, "POST", "/history", {
      symbol: "AAA/BBB",
      from: "2024-06-01",
    });

    expect([traversal.status, slash.status]).toEqual([400, 400]);
    expect(chart).not.toHaveBeenCalled();
  });

  it("answers 400 for a /history from that is not YYYY-MM-DD", async () => {
    const chart = vi.fn(async () => ({}));
    await start(fakeYahoo({ chart }));

    const res = await requestJson(currentSocketPath, "POST", "/history", {
      symbol: "VTI",
      from: "2024-6-1",
    });

    expect(res.status).toBe(400);
    expect(chart).not.toHaveBeenCalled();
  });

  it("answers 400 for a /history from with a valid date only at the end of a longer string", async () => {
    // Pins the regex's leading `^`: without it, `.test()` only needs a match
    // anywhere, and `2024-06-01` occurring at the very end still satisfies
    // the trailing `$`.
    const chart = vi.fn(async () => ({}));
    await start(fakeYahoo({ chart }));

    const res = await requestJson(currentSocketPath, "POST", "/history", {
      symbol: "VTI",
      from: "not-a-date-2024-06-01",
    });

    expect(res.status).toBe(400);
    expect(chart).not.toHaveBeenCalled();
  });

  it("answers 400 for a /history from with a valid date only at the start of a longer string", async () => {
    // The mirror case, pinning the trailing `$`.
    const chart = vi.fn(async () => ({}));
    await start(fakeYahoo({ chart }));

    const res = await requestJson(currentSocketPath, "POST", "/history", {
      symbol: "VTI",
      from: "2024-06-01-extra-garbage",
    });

    expect(res.status).toBe(400);
    expect(chart).not.toHaveBeenCalled();
  });

  it("answers 400 for GET /quotes", async () => {
    await start(fakeYahoo());

    const res = await rawRequest(currentSocketPath, "GET", "/quotes");

    expect(res.status).toBe(400);
  });

  it("answers 400 for a method /quotes does not take, with a body that would otherwise parse", async () => {
    // `GET /quotes` above answers 400 either way — an empty body is not JSON —
    // so it cannot tell the method guard from the schema. `rawRequest` now
    // frames this body with a real `content-length`, so it genuinely would
    // parse if the method guard let it through.
    const quote = vi.fn(async () => []);
    await start(fakeYahoo({ quote }));

    const res = await rawRequest(currentSocketPath, "GET", "/quotes", '{"symbols":["VTI"]}');

    expect(res.status).toBe(400);
    expect(quote).not.toHaveBeenCalled();
  });

  it("answers 400 for a method /history does not take, with a body that would otherwise parse", async () => {
    const chart = vi.fn(async () => ({}));
    await start(fakeYahoo({ chart }));

    const res = await rawRequest(
      currentSocketPath,
      "GET",
      "/history",
      '{"symbol":"VTI","from":"2024-06-01"}',
    );

    expect(res.status).toBe(400);
    expect(chart).not.toHaveBeenCalled();
  });

  it("answers 400 for a path that merely starts with /quotes, matching the table and nothing else", async () => {
    // Spec §3.2 is the table and nothing else — a query string or extra
    // path text must not fall through to the /quotes handler.
    const quote = vi.fn(async () => []);
    await start(fakeYahoo({ quote }));

    const withQuery = await requestJson(currentSocketPath, "POST", "/quotes?x=1", {
      symbols: ["VTI"],
    });
    const suffixed = await requestJson(currentSocketPath, "POST", "/quotesFOO", {
      symbols: ["VTI"],
    });

    expect([withQuery.status, suffixed.status]).toEqual([400, 400]);
    expect(quote).not.toHaveBeenCalled();
  });

  it("answers 400 for a method /healthz does not take", async () => {
    await start(fakeYahoo());

    const res = await rawRequest(currentSocketPath, "POST", "/healthz");

    expect(res.status).toBe(400);
  });

  it("cuts an unknown route's text rather than echoing the whole URL", async () => {
    // The one refusal with no rate cap above it, and a URL can carry up to
    // Node's whole header allowance. Echoed whole it is a free way to fill
    // the log the operator reads.
    await start(fakeYahoo());

    const res = await rawRequest(currentSocketPath, "POST", `/${"x".repeat(8 * 1024)}`);

    expect(res.status).toBe(400);
    expect(res.text.length).toBeLessThan(2 * 1024);
  });

  it("answers 400 for POST /other", async () => {
    await start(fakeYahoo());

    const res = await rawRequest(currentSocketPath, "POST", "/other");

    expect(res.status).toBe(400);
  });

  it("logs one line naming the endpoint, the status and the reason for a non-200 answer", async () => {
    const calls: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });

    await start(fakeYahoo());
    const res = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: [] });
    spy.mockRestore();

    const reason = (res.json as { error: string }).error;
    expect(calls).toEqual([[`Price worker: quotes 400 ${reason}`]]);
  });
});

describe("the 16 KB body cap", () => {
  it(
    "destroys the socket past the cap, with no status and no library call",
    async () => {
      const quote = vi.fn(async () => []);
      // headersTimeout, requestTimeout and server.timeout all pinned far out
      // of reach (30 s, per the ticket): the body below completes framing
      // (a real content-length, fully sent) before the cap trips, so none of
      // the three timeout mechanisms is even in a position to fire — only
      // `readBody`'s own `req.destroy()` can end this connection. The test's
      // own timeout (third argument) is bounded well under 30 s so a build
      // missing that `destroy()` fails fast instead of hanging to it.
      await start(fakeYahoo({ quote }), {
        headersTimeout: 30_000,
        requestTimeout: 30_000,
        timeout: 30_000,
        connectionsCheckingInterval: 50,
      });

      const body = `{"symbols":["VTI"],"padding":"${"x".repeat(17 * 1024)}"}`;

      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            socketPath: currentSocketPath,
            agent: false,
            method: "POST",
            path: "/quotes",
            headers: { "content-length": Buffer.byteLength(body) },
          },
          (res) => {
            reject(new Error(`expected the connection to error, got status ${res.statusCode}`));
          },
        );
        req.on("error", (error) => {
          expect(["ECONNRESET", "EPIPE"]).toContain((error as NodeJS.ErrnoException).code);
          resolve();
        });
        req.write(body);
        req.end();
      });

      expect(quote).not.toHaveBeenCalled();
    },
    2_000,
  );

  it("answers 200 for the largest honest request — 100 symbols of 15 characters, about 1.9 KB", async () => {
    // Spec §3.5's own ceiling: 100 symbols, each at `SYMBOL_PATTERN`'s own
    // 15-character maximum. No existing case sends anything near the cap,
    // so `16 * 1024` shrinking to a much smaller floor (e.g. `1024`) would
    // survive every other test while rejecting a perfectly honest request.
    const symbols = Array.from({ length: 100 }, () => "A".repeat(15));
    const quote = vi.fn(async () => []);
    await start(fakeYahoo({ quote }));

    const res = await requestJson(currentSocketPath, "POST", "/quotes", { symbols });

    expect(res.status).toBe(200);
    expect(quote).toHaveBeenCalledWith(symbols);
  });

  it("answers 200 for a body of exactly 16384 bytes, the cap's own edge", async () => {
    // 16384 is `MAX_BODY_BYTES` (16 * 1024) in server/price-worker.ts.
    // `readBody` destroys the socket only once `total` exceeds the limit —
    // a body landing exactly on it must still be answered. `> limit`
    // becoming `>= limit` survives every other case here, none of which
    // sends a body of this exact size.
    const prefix = '{"symbols":["VTI"],"padding":"';
    const suffix = '"}';
    const padLength = 16 * 1024 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    const body = `${prefix}${"x".repeat(padLength)}${suffix}`;
    expect(Buffer.byteLength(body)).toBe(16 * 1024);

    const quote = vi.fn(async () => []);
    await start(fakeYahoo({ quote }));

    const res = await rawRequest(currentSocketPath, "POST", "/quotes", body);

    expect(res.status).toBe(200);
    expect(quote).toHaveBeenCalledWith(["VTI"]);
  });

  it(
    "logs nothing for an oversized body — the unhandled-request catch is for a genuine bug, not this",
    async () => {
      const calls: unknown[][] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        calls.push(args);
      });

      const quote = vi.fn(async () => []);
      await start(fakeYahoo({ quote }), {
        headersTimeout: 30_000,
        requestTimeout: 30_000,
        timeout: 30_000,
        connectionsCheckingInterval: 50,
      });

      const body = `{"symbols":["VTI"],"padding":"${"x".repeat(17 * 1024)}"}`;

      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            socketPath: currentSocketPath,
            agent: false,
            method: "POST",
            path: "/quotes",
            headers: { "content-length": Buffer.byteLength(body) },
          },
          (res) => {
            reject(new Error(`expected the connection to error, got status ${res.statusCode}`));
          },
        );
        req.on("error", () => resolve());
        req.write(body);
        req.end();
      });

      // A moment for a (wrongly logged) unhandled-request stack to land.
      await new Promise((resolve) => setTimeout(resolve, 100));
      spy.mockRestore();

      expect(calls).toHaveLength(0);
    },
    2_000,
  );
});

describe("a client that hangs up before its declared body arrives", () => {
  it("logs one line naming the endpoint, not the unhandled-bug line", async () => {
    const calls: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });

    await start(fakeYahoo());

    const socket = await connectSocket(currentSocketPath);
    socket.resume();
    // A content-length the client never fulfils, then the client itself
    // hangs up mid-body — `readBody`'s `for await` sees the peer gone.
    socket.write("POST /quotes HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n");
    socket.write("partial-body");
    await new Promise((resolve) => setTimeout(resolve, 30));
    socket.destroy();

    // Give the server a moment to observe the abort and log it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    spy.mockRestore();

    const lines = calls.map((args) => args.map(String).join(" "));
    const unhandled = lines.filter((line) => line.includes("unhandled request error"));
    const abandoned = lines.filter((line) => line.includes("quotes") && !line.includes("unhandled"));

    expect(unhandled).toHaveLength(0);
    expect(abandoned).toHaveLength(1);
  });

  it("still logs the unhandled-bug line for a genuine bug, rather than mistaking it for a disconnect", async () => {
    // A bug unrelated to the peer at all: `readBody`'s own final
    // `Buffer.concat`, on a body that arrived in full, throwing for a
    // reason that has nothing to do with the connection.
    // `isAbandonedRead`'s exact match on `"aborted"` + `ECONNRESET`
    // (module header) is what tells this apart from a real disconnect —
    // an error shaped like this one must never satisfy it.
    const calls: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
    const concatSpy = vi.spyOn(Buffer, "concat").mockImplementation(() => {
      throw new Error("simulated handler bug");
    });

    await start(fakeYahoo());

    await requestJson(currentSocketPath, "POST", "/quotes", { symbols: ["VTI"] }).catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 50));
    concatSpy.mockRestore();
    spy.mockRestore();

    const lines = calls.map((args) => args.map(String).join(" "));
    const unhandled = lines.filter((line) => line.includes("unhandled request error"));
    const disconnected = lines.filter((line) => line.includes("client disconnected"));

    expect(unhandled).toHaveLength(1);
    expect(disconnected).toHaveLength(0);
  });
});

describe("per-endpoint rate caps, a sliding sixty-second window", () => {
  it("does not spend the rate budget on a refused (400) request", async () => {
    // More refused calls than the ten-call cap, each one refused by the
    // schema before `admit()` ever runs — a confused app spamming invalid
    // bodies must not starve the honest refresh that follows.
    const quote = vi.fn(async () => []);
    await start(fakeYahoo({ quote }));

    for (let i = 0; i < 15; i++) {
      const res = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: [] });
      expect(res.status).toBe(400);
    }
    expect(quote).not.toHaveBeenCalled();

    for (let i = 0; i < 10; i++) {
      const res = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: ["VTI"] });
      expect(res.status).toBe(200);
    }
    expect(quote).toHaveBeenCalledTimes(10);
  });

  it("answers 429 for the eleventh quotes call within a minute, with no library call", async () => {
    const quote = vi.fn(async () => []);
    await start(fakeYahoo({ quote }));

    for (let i = 0; i < 10; i++) {
      const res = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: ["VTI"] });
      expect(res.status).toBe(200);
    }
    expect(quote).toHaveBeenCalledTimes(10);

    const eleventh = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: ["VTI"] });

    expect(eleventh.status).toBe(429);
    expect(eleventh.json).toEqual({ error: "rate limited" });
    expect(quote).toHaveBeenCalledTimes(10);
  });

  it("answers 429 for the twenty-first history call within a minute, with no library call", async () => {
    const chart = vi.fn(async () => ({}));
    await start(fakeYahoo({ chart }));

    for (let i = 0; i < 20; i++) {
      const res = await requestJson(currentSocketPath, "POST", "/history", {
        symbol: "VTI",
        from: "2024-06-01",
      });
      expect(res.status).toBe(200);
    }
    expect(chart).toHaveBeenCalledTimes(20);

    const twentyFirst = await requestJson(currentSocketPath, "POST", "/history", {
      symbol: "VTI",
      from: "2024-06-01",
    });

    expect(twentyFirst.status).toBe(429);
    expect(chart).toHaveBeenCalledTimes(20);
  });

  it("admits an eleventh quotes call once the window has slid a minute past the first", async () => {
    // Only `Date` is faked — `setTimeout`/`setInterval` stay real, so the
    // socket round trips below still complete on their own. The limiter
    // reads only `Date.now()` (server/price-worker.ts's `makeRateLimiter`),
    // which this patches; `AbortSignal.timeout` is the one fake timers do
    // not reach, and this path never touches it.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const quote = vi.fn(async () => []);
      await start(fakeYahoo({ quote }));

      for (let i = 0; i < 10; i++) {
        const res = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: ["VTI"] });
        expect(res.status).toBe(200);
      }
      const eleventh = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: ["VTI"] });
      expect(eleventh.status).toBe(429);

      // 60_000 is `RATE_LIMIT_WINDOW_MS` in server/price-worker.ts — past the
      // window the first of the ten calls above was recorded in, so without
      // eviction the cap spent above is never given back.
      vi.advanceTimersByTime(60_000);

      const afterWindow = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: ["VTI"] });

      expect(afterWindow.status).toBe(200);
      expect(quote).toHaveBeenCalledTimes(11);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mapping a provider failure to a status", () => {
  it("answers 504 with the TimeoutError text once the client's own fixed deadline expires", async () => {
    // The signal-honouring fetch fake yahoo-client.test.ts uses: rejects only
    // when its signal aborts, with the signal's own reason.
    globalThis.fetch = ((_url: string | URL, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;

    const realClient = createYahooClient({ timeoutMs: 50 });
    // A generous `timeout` here, exactly as the `maxConnections` case does:
    // this case is about the CLIENT's 50 ms deadline, not the socket-
    // inactivity watchdog, and the handler must complete a cold
    // `import("yahoo-finance2")` plus that 50 ms before answering — on a
    // cold run under vitest's transform that import alone can approach
    // `server.timeout`'s default 200 ms test value, closing the idle socket
    // before the handler ever gets to reply. `server.timeout` is noise in
    // this case; do not shorten the 50 ms client deadline to compensate.
    await start(
      { quote: async () => [], chart: realClient.chart },
      { ...TEST_TIMEOUTS, timeout: 2000 },
    );

    const res = await requestJson(currentSocketPath, "POST", "/history", {
      symbol: "VTI",
      from: "2024-06-01",
    });

    expect(res.status).toBe(504);
    expect((res.json as { error: string }).error).toBe("The operation was aborted due to timeout");
  });

  it("answers 502 with the message a provider failure threw", async () => {
    const quote = vi.fn(async () => {
      throw new Error("No data found, symbol may be delisted");
    });
    await start(fakeYahoo({ quote }));

    const res = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: ["GONE"] });

    expect(res.status).toBe(502);
    expect((res.json as { error: string }).error).toBe("No data found, symbol may be delisted");
  });

  it("appends a thrown cause's code to the message", async () => {
    const quote = vi.fn(async () => {
      throw new Error("fetch failed", { cause: { code: "ECONNREFUSED" } });
    });
    await start(fakeYahoo({ quote }));

    const res = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: ["VTI"] });

    expect(res.status).toBe(502);
    expect((res.json as { error: string }).error).toBe("fetch failed: ECONNREFUSED");
  });

  it("caps a causeless provider error's text at 1000 characters", async () => {
    // 1000 is `ERROR_TEXT_LIMIT` in server/price-worker.ts.
    const longMessage = "x".repeat(2000);
    const quote = vi.fn(async () => {
      throw new Error(longMessage);
    });
    await start(fakeYahoo({ quote }));

    const res = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: ["VTI"] });

    expect(res.status).toBe(502);
    const error = (res.json as { error: string }).error;
    expect(error).toBe(longMessage.slice(0, 1000));
    expect(error).toHaveLength(1000);
  });

  it("caps a provider error with a long cause message at 1000 characters", async () => {
    const longCauseMessage = "y".repeat(2000);
    const quote = vi.fn(async () => {
      throw new Error("fetch failed", { cause: new Error(longCauseMessage) });
    });
    await start(fakeYahoo({ quote }));

    const res = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: ["VTI"] });

    expect(res.status).toBe(502);
    const error = (res.json as { error: string }).error;
    expect(error).toBe(`fetch failed: ${longCauseMessage}`.slice(0, 1000));
    expect(error).toHaveLength(1000);
  });
});

describe("production's own timeout numbers, the deployed denial-of-service bounds", () => {
  it("pins the four PRODUCTION_TIMEOUTS values, three read back off the server startWorker returns with no timeouts option given", async () => {
    // Every other case in this file injects TEST_TIMEOUTS (directly, or via
    // `start`'s own default) — the module header's own numbers otherwise
    // reach no case at all.
    expect(PRODUCTION_TIMEOUTS).toEqual({
      timeout: 35_000,
      headersTimeout: 5_000,
      requestTimeout: 5_000,
      connectionsCheckingInterval: 1_000,
    });

    // No `timeouts` option: startWorker's own default is PRODUCTION_TIMEOUTS.
    // Reading three of the four back off the instance pins that the object
    // above is actually wired in, not merely a constant nothing consumes.
    // `connectionsCheckingInterval` is a constructor-only option (not one of
    // the `Server` instance's own properties, module header), so the
    // `PRODUCTION_TIMEOUTS` assertion above is what covers that one.
    currentServer = await startWorker({ socketPath: currentSocketPath, yahoo: fakeYahoo() });

    expect(currentServer.timeout).toBe(35_000);
    expect(currentServer.headersTimeout).toBe(5_000);
    expect(currentServer.requestTimeout).toBe(5_000);
  });
});

describe("the socket file and its lifecycle", () => {
  it("unlinks a stale file at the path and listens", async () => {
    writeFileSync(currentSocketPath, "");

    await start(fakeYahoo());

    const res = await rawRequest(currentSocketPath, "GET", "/healthz");
    expect(res.status).toBe(200);
  });

  it("rejects with the code and the path when a directory squats the socket path", async () => {
    mkdirSync(currentSocketPath);

    await expect(
      startWorker({ socketPath: currentSocketPath, yahoo: fakeYahoo(), timeouts: TEST_TIMEOUTS }),
    ).rejects.toMatchObject({ code: "EISDIR", path: currentSocketPath });
  });

  it("exits 1, naming EISDIR and the path, when the entry point's own listen fails", async () => {
    // The entry point, not `startWorker`: the `.catch` that logs and calls
    // `process.exit(1)` is the entry's own, below `import.meta.main`.
    const socketPath = await freshEntryPointSocket("pw-eisdir-");
    mkdirSync(socketPath);

    const child = spawn(process.execPath, [WORKER_ENTRY], {
      env: { ...process.env, PRICE_WORKER_SOCKET: socketPath },
      stdio: ["ignore", "ignore", "pipe"],
    });

    const stderrChunks: Buffer[] = [];
    child.stderr!.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const code = await new Promise<number | null>((resolve) => {
      child.once("close", resolve);
    });
    const stderr = Buffer.concat(stderrChunks).toString("utf8");

    expect(code).toBe(1);
    expect(stderr).toContain("EISDIR");
    expect(stderr).toContain(socketPath);
  });

  it("logs a startup line naming the socket path", async () => {
    const socketPath = await freshEntryPointSocket("pw-startup-");
    const child = spawn(process.execPath, [WORKER_ENTRY], {
      env: { ...process.env, PRICE_WORKER_SOCKET: socketPath },
      stdio: ["ignore", "pipe", "ignore"],
    });

    try {
      const stdout = await waitForStdout(child.stdout!, (text) => text.includes(socketPath));
      expect(stdout).toContain(`Price worker listening on ${socketPath}`);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("creates the socket file at mode 0660", async () => {
    await start(fakeYahoo());

    const mode = statSync(currentSocketPath).mode & 0o777;
    expect(mode).toBe(0o660);
  });

  it("accepts and closes a ninth connection while eight are held open", async () => {
    // A generous `timeout` here: this test is about `maxConnections`, not
    // the socket-inactivity watchdog, and establishing nine connections
    // must not race the held ones' own idle timers.
    await start(fakeYahoo(), { ...TEST_TIMEOUTS, timeout: 2000 });

    const held: net.Socket[] = [];
    for (let i = 0; i < 8; i++) held.push(await connectSocket(currentSocketPath));

    const ninth = await connectSocket(currentSocketPath);
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
      ninth.once("error", resolve);
      ninth.write("GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n");
    });

    expect(error.code).toBe("EPIPE");

    for (const socket of held) socket.destroy();
    ninth.destroy();
  });

  it("closes a silent connection within the injected timeout", async () => {
    // headersTimeout/requestTimeout pinned far above the wait below: on this
    // platform a byte-less connection is *also* within `checkConnections`'s
    // reach (contrary to the general rule for a connection that has sent
    // something — research §8.9), so a small headersTimeout here would let
    // that mechanism close the connection and leave `server.timeout` itself
    // unexercised, which is what this case is pinning.
    await start(fakeYahoo(), { ...TEST_TIMEOUTS, headersTimeout: 10_000, requestTimeout: 10_000 });

    const socket = await connectSocket(currentSocketPath);
    socket.resume(); // a paused socket never notices the peer closing (module header)

    const startedAt = Date.now();
    await new Promise<void>((resolve) => socket.once("close", resolve));

    expect(Date.now() - startedAt).toBeLessThan(TEST_TIMEOUTS.timeout + 1000);
  });

  it("closes a connection whose headers never complete within headersTimeout plus one checking interval", async () => {
    // `server.timeout` pinned far out of reach, and `requestTimeout`
    // disabled (0) rather than merely left alone: for a connection that has
    // sent no complete request, both header deadlines are in Node's reach at
    // once (verified on Node 24.12.0), so leaving requestTimeout at its
    // normal value would let it — not headersTimeout — be what closes this.
    await start(fakeYahoo(), { ...TEST_TIMEOUTS, timeout: 30_000, requestTimeout: 0 });

    const socket = await connectSocket(currentSocketPath);
    socket.resume();
    socket.write("GET /healthz HTTP/1.1\r\n");

    const startedAt = Date.now();
    await new Promise<void>((resolve) => socket.once("close", resolve));

    expect(Date.now() - startedAt).toBeLessThan(
      TEST_TIMEOUTS.headersTimeout + TEST_TIMEOUTS.connectionsCheckingInterval + 1000,
    );
  });

  it("closes a connection whose body never completes within requestTimeout plus one checking interval", async () => {
    // The mirror case, pinning `requestTimeout` alone. `headersTimeout` must
    // be disabled with 0 rather than pinned far out of reach: Node throws
    // ERR_OUT_OF_RANGE at server construction when a *nonzero* headersTimeout
    // exceeds requestTimeout (verified on Node 24.12.0), so 0 — which Node
    // exempts from that check — is the only way to hold it out of reach here.
    await start(fakeYahoo(), { ...TEST_TIMEOUTS, timeout: 30_000, headersTimeout: 0 });

    const socket = await connectSocket(currentSocketPath);
    socket.resume();
    // Headers complete (the terminating blank line is sent); the declared
    // body never arrives.
    socket.write("POST /quotes HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n");
    socket.write("partial-body");

    const startedAt = Date.now();
    await new Promise<void>((resolve) => socket.once("close", resolve));

    expect(Date.now() - startedAt).toBeLessThan(
      TEST_TIMEOUTS.requestTimeout + TEST_TIMEOUTS.connectionsCheckingInterval + 1000,
    );
  });

  it("exits on SIGTERM even while every connection it admits is held open", async () => {
    // The entry point, not `startWorker`, because the handler is the entry's.
    // A stop has to finish inside Docker's ten-second grace, and `close()`
    // waits for every connection: a socket that has sent nothing is not
    // *idle* in Node's sense, so closing only the idle ones leaves exactly
    // the eight a compromised app would hold and the stop becomes a SIGKILL.
    const socketPath = await freshEntryPointSocket("pw-term-");
    const child = spawn(process.execPath, [WORKER_ENTRY], {
      env: { ...process.env, PRICE_WORKER_SOCKET: socketPath },
      stdio: "ignore",
    });

    try {
      await waitForSocket(socketPath);

      const held = await Promise.all(
        Array.from({ length: 8 }, () => connectSocket(socketPath)),
      );
      held.forEach((socket) => socket.resume());

      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");

      const code = await Promise.race([
        exited,
        new Promise<"still running">((resolve) => setTimeout(() => resolve("still running"), 5_000)),
      ]);

      expect(code).toBe(0);
      expect(existsSync(socketPath)).toBe(false);
      held.forEach((socket) => socket.destroy());
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });

  it("answers only the first of two requests written on one connection, with Connection: close", async () => {
    await start(fakeYahoo());

    const socket = await connectSocket(currentSocketPath);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));

    socket.write("GET /healthz HTTP/1.1\r\nHost: x\r\n\r\nGET /healthz HTTP/1.1\r\nHost: x\r\n\r\n");
    // Node answers the excess pipelined request itself (a 503, past
    // `maxRequestsPerSocket`) — this only asserts on the first answer.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const raw = Buffer.concat(chunks).toString("utf8");
    const [firstResponse] = raw.split(/(?=HTTP\/1\.1 )/).filter((chunk) => chunk.length > 0);

    expect(firstResponse).toMatch(/^HTTP\/1\.1 200/);
    expect(firstResponse?.toLowerCase()).toContain("connection: close");

    socket.destroy();
  });
});
