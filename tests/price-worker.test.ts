/**
 * The price-worker process: a real node:http server on a temp unix socket, a fake Yahoo
 * client, raw HTTP over the socket — no database, no compose. Pins the protocol (spec 0018
 * §3.2, §3.5) by speaking HTTP directly rather than through the app's own client.
 * Trap: a raw net.Socket with no 'data' listener stays paused and never notices the peer
 * closing — every socket not otherwise read calls .resume() right after connecting.
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
import type { Duplex } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRODUCTION_TIMEOUTS, startWorker, type WorkerTimeouts } from "../server/price-worker.ts";
import { createYahooClient, type YahooClient } from "../server/yahoo-client.ts";

// entry point as a real child process — the only way to watch a signal land and an exit code
// come back. SIGTERM handler is startWorker's own, registered before it listens; the entry
// adds only the .catch that logs a failed start.
const WORKER_ENTRY = fileURLToPath(new URL("../server/price-worker.ts", import.meta.url));

// the one seam this file controls: startWorker's own chmod call. undefined means the real one;
// two cases set `impl` (one holds the listen/chmod gap open, the other fails chmod), and
// afterEach always puts it back. Shape is tests/routes/lock-now.test.ts:28-49's.
const chmodOverride = vi.hoisted(() => ({
  impl: undefined as ((path: string, mode: number) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    chmod: (path: string, mode: number) =>
      chmodOverride.impl ? chmodOverride.impl(path, mode) : actual.chmod(path, mode),
  };
});

// wait until the worker has created its socket, or give up loudly
async function waitForSocket(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the worker never created ${path}`);
}

// accumulates a stream's text until predicate is satisfied, or gives up loudly. waitForSocket
// is the wrong tool for pinning a log line: the socket file lands before startWorker's own
// console.log, so racing the file instead of the stream could pass on a build that never logs
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

// short on purpose: a unix socket path is 107 usable bytes on Linux
function freshSocketPath(): string {
  return join(tmpdir(), `pw-${randomBytes(4).toString("hex")}.sock`);
}

// tens of milliseconds per the ticket — connectionsCheckingInterval 50ms is research §8.9's own probe
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

// mkdtemp dirs the entry-point cases create, cleaned centrally rather than per-case since a
// case failing before its own cleanup would leak the directory (this file's history did: 117
// empty /tmp/pw-term-* left behind)
const entryPointTempDirs: string[] = [];

// a fresh mkdtemp dir for an entry-point case, tracked above, and a socket path inside it
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
  chmodOverride.impl = undefined;
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

// agent:false — sockets must not be kept alive into the next case. content-length is added
// for any body the caller doesn't frame itself: Node only adds Transfer-Encoding: chunked for
// a method conventionally carrying a body, so an unframed GET body lands as garbage after the
// blank line instead of in req's body stream.
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

// accumulates raw bytes off a socket Node itself answers on (clientError refusals are a
// hand-written response line, not JSON via sendJson) and resolves once the peer closes —
// every clientError refusal does, since the handler always destroys the socket after
function readRawUntilClose(socket: net.Socket): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
    });
    socket.once("close", () => resolve(data));
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
    // /quotes puts symbols in a query parameter URLSearchParams escapes anyway; /history
    // concatenates the symbol into the URL path (yahoo-finance2's chart.js), so an unchecked
    // symbol here reaches a different endpoint entirely
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
    // pins the regex's leading ^ — without it, a match anywhere satisfies the trailing $
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
    // mirror case, pinning the trailing $
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
    // "GET /quotes" above can't tell the method guard from the schema (empty body isn't JSON
    // either way) — this body is framed with a real content-length, so it'd genuinely parse
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
    // spec §3.2 is the table and nothing else — a query string or extra path text must not fall through
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
    // the one refusal with no rate cap above it, and a URL can carry up to Node's whole header
    // allowance — echoed whole it's a free way to fill the log the operator reads
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

describe("refusals Node answers itself, before the request callback ever runs", () => {
  // Node's own clientError default writes these three statuses itself and logs nothing —
  // attaching any listener (onClientError) takes over both jobs at once, for every parser error
  it("still answers 400 for a malformed request line, and now logs it", async () => {
    const calls: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
    await start(fakeYahoo());

    const socket = await connectSocket(currentSocketPath);
    socket.resume();
    const rawResponse = readRawUntilClose(socket);
    socket.write("NOTAMETHOD /quotes GARBAGE\r\n\r\n");
    const raw = await rawResponse;
    spy.mockRestore();

    expect(raw).toMatch(/^HTTP\/1\.1 400 /);
    expect(calls).toEqual([
      [expect.stringMatching(/^Price worker: \(no endpoint — request never parsed\) 400 /)],
    ]);
  });

  it("still answers 431 for a header block over Node's own cap, and now logs it", async () => {
    const calls: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
    await start(fakeYahoo());

    const socket = await connectSocket(currentSocketPath);
    socket.resume();
    const rawResponse = readRawUntilClose(socket);
    // comfortably past Node's own default 16 KB header cap
    socket.write(`GET /healthz HTTP/1.1\r\nHost: x\r\nX-Big: ${"x".repeat(20 * 1024)}\r\n\r\n`);
    const raw = await rawResponse;
    spy.mockRestore();

    expect(raw).toMatch(/^HTTP\/1\.1 431 /);
    expect(calls).toEqual([
      [
        expect.stringMatching(
          /^Price worker: \(no endpoint — request never parsed\) 431 HPE_HEADER_OVERFLOW$/,
        ),
      ],
    ]);
  });

  it("still answers 408 for a client that never finishes its headers, and now logs it", async () => {
    const calls: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
    // server.timeout pinned far out of reach — at TEST_TIMEOUTS' default (200ms, only 50ms
    // past headersTimeout) the two would race under load and a socket.timeout win could
    // destroy the connection with no response at all
    await start(fakeYahoo(), { ...TEST_TIMEOUTS, timeout: 30_000 });

    const socket = await connectSocket(currentSocketPath);
    socket.resume();
    const rawResponse = readRawUntilClose(socket);
    socket.write("GET /healthz HTTP/1.1\r\n"); // no terminating blank line — headers never complete
    const raw = await rawResponse;
    spy.mockRestore();

    expect(raw).toMatch(/^HTTP\/1\.1 408 /);
    expect(calls).toEqual([
      [
        expect.stringMatching(
          /^Price worker: \(no endpoint — request never parsed\) 408 ERR_HTTP_REQUEST_TIMEOUT$/,
        ),
      ],
    ]);
  });

  it("stays silent for a bare connection reset — nothing was ever received to refuse", async () => {
    // a genuine mid-parse ECONNRESET isn't reproducible over a unix socket from a Node client,
    // so this drives the real listener with a synthetic event shaped like node:http's own
    // socketOnError passes: an error and the raw socket, not a status to answer with
    const calls: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
    const server = await start(fakeYahoo());

    const write = vi.fn();
    const destroy = vi.fn();
    const fakeSocket = { writable: false, write, destroy } as unknown as Duplex;
    const err = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });

    server.emit("clientError", err, fakeSocket);
    spy.mockRestore();

    expect(calls).toHaveLength(0);
    expect(write).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe("the 16 KB body cap", () => {
  it(
    "destroys the socket past the cap, with no status and no library call",
    async () => {
      const quote = vi.fn(async () => []);
      // all three timeouts pinned far out of reach (30s) — the body completes framing before
      // the cap trips, so only readBody's own req.destroy() can end this connection. Test's own
      // timeout (third arg) is bounded well under 30s so a missing destroy() fails fast.
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
    // spec §3.5's own ceiling: 100 symbols at SYMBOL_PATTERN's 15-char max — shrinking
    // MAX_BODY_BYTES to a much smaller floor would survive every other test but reject this
    const symbols = Array.from({ length: 100 }, () => "A".repeat(15));
    const quote = vi.fn(async () => []);
    await start(fakeYahoo({ quote }));

    const res = await requestJson(currentSocketPath, "POST", "/quotes", { symbols });

    expect(res.status).toBe(200);
    expect(quote).toHaveBeenCalledWith(symbols);
  });

  it("answers 200 for a body of exactly 16384 bytes, the cap's own edge", async () => {
    // 16384 = MAX_BODY_BYTES. readBody destroys the socket only once total exceeds the limit —
    // a body landing exactly on it must still be answered; `> limit` becoming `>= limit` would
    // survive every other case here
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

      // a moment for a (wrongly logged) unhandled-request stack to land
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
    // content-length the client never fulfils, then hangs up mid-body — readBody's for-await sees the peer gone
    socket.write("POST /quotes HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n");
    socket.write("partial-body");
    await new Promise((resolve) => setTimeout(resolve, 30));
    socket.destroy();

    // give the server a moment to observe the abort and log it
    await new Promise((resolve) => setTimeout(resolve, 150));
    spy.mockRestore();

    const lines = calls.map((args) => args.map(String).join(" "));
    const unhandled = lines.filter((line) => line.includes("unhandled request error"));
    const abandoned = lines.filter((line) => line.includes("quotes") && !line.includes("unhandled"));

    expect(unhandled).toHaveLength(0);
    expect(abandoned).toHaveLength(1);
  });

  it("still logs the unhandled-bug line for a genuine bug, rather than mistaking it for a disconnect", async () => {
    // a bug unrelated to the peer: readBody's final Buffer.concat throwing on a fully-arrived
    // body. isAbandonedRead's exact match on "aborted"+ECONNRESET is what tells this apart from
    // a real disconnect — an error shaped like this one must never satisfy it
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
    // more refused calls than the cap, each refused by the schema before admit() ever runs —
    // a confused app spamming invalid bodies must not starve the honest refresh that follows
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
    // only performance is faked — setTimeout/setInterval stay real (verified on vitest 4.1.11:
    // toFake:["performance"] alone leaves a real setTimeout firing on wall-clock time). The
    // limiter reads only performance.now() (makeRateLimiter), which this patches.
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const quote = vi.fn(async () => []);
      await start(fakeYahoo({ quote }));

      for (let i = 0; i < 10; i++) {
        const res = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: ["VTI"] });
        expect(res.status).toBe(200);
      }
      const eleventh = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: ["VTI"] });
      expect(eleventh.status).toBe(429);

      // 60_000 = RATE_LIMIT_WINDOW_MS — past the window the first call was recorded in, so
      // without eviction the cap spent above is never given back
      vi.advanceTimersByTime(60_000);

      const afterWindow = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: ["VTI"] });

      expect(afterWindow.status).toBe(200);
      expect(quote).toHaveBeenCalledTimes(11);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps sliding the window when the wall clock steps backward — a restored snapshot, an NTP correction", async () => {
    // both faked: Date drives the backward step, performance proves the limiter (which reads
    // only performance.now()) stays unaffected by it — a Date.now() limiter would see every
    // recorded call land in the future and never evict until wall time claws back past it
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    try {
      const quote = vi.fn(async () => []);
      await start(fakeYahoo({ quote }));

      for (let i = 0; i < 10; i++) {
        const res = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: ["VTI"] });
        expect(res.status).toBe(200);
      }
      const eleventh = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: ["VTI"] });
      expect(eleventh.status).toBe(429);

      // wall clock steps backward an hour, Date.now() alone — performance.now() untouched
      vi.setSystemTime(new Date(Date.now() - 60 * 60_000));

      // 60_000 = RATE_LIMIT_WINDOW_MS — elapsed monotonic time past the window, despite the
      // wall clock now reading an hour earlier
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
    // signal-honouring fetch fake yahoo-client.test.ts uses: rejects only when its signal
    // aborts, with the signal's own reason
    globalThis.fetch = ((_url: string | URL, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;

    const realClient = createYahooClient({ timeoutMs: 50 });
    // generous timeout here: this case is about the CLIENT's 50ms deadline, not the socket-
    // inactivity watchdog — a cold import("yahoo-finance2") plus 50ms can approach
    // server.timeout's default test value otherwise. Don't shorten the client deadline to compensate.
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

  it("keeps the TLS wording when the proxy tears a tunnel down after answering it", async () => {
    // the third signature the operator guide quotes, and the only one whose cause is an
    // ordinary ECONNRESET — measured against a real fetch behind NODE_USE_ENV_PROXY where
    // egress-proxy.ts destroys the socket after answering 200 on a server-name mismatch.
    // Taking .code would log "fetch failed: ECONNRESET", losing the one word — TLS — that
    // says the fence fired rather than the network wobbling.
    const quote = vi.fn(async () => {
      const cause = new Error(
        "Client network socket disconnected before secure TLS connection was established",
      ) as NodeJS.ErrnoException;
      cause.code = "ECONNRESET";
      throw new Error("fetch failed", { cause });
    });
    await start(fakeYahoo({ quote }));

    const res = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: ["VTI"] });

    expect(res.status).toBe(502);
    expect((res.json as { error: string }).error).toBe(
      "fetch failed: Client network socket disconnected before secure TLS connection was established",
    );
  });

  it("prefers a cause's own message over its bare code, so a DNS failure keeps the hostname", async () => {
    // measured against a real fetch resolving a bad hostname behind NODE_USE_ENV_PROXY:
    // cause.message already carries both the code and the host. Picking .code (ticket 08's
    // bug) answers "fetch failed: ENOTFOUND" — true, useless once more than one host is in play.
    const quote = vi.fn(async () => {
      const cause = new Error("getaddrinfo ENOTFOUND egress-proxy") as NodeJS.ErrnoException;
      cause.code = "ENOTFOUND";
      throw new Error("fetch failed", { cause });
    });
    await start(fakeYahoo({ quote }));

    const res = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: ["VTI"] });

    expect(res.status).toBe(502);
    expect((res.json as { error: string }).error).toBe("fetch failed: getaddrinfo ENOTFOUND egress-proxy");
  });

  it("walks one level into a nested cause for the text an unhelpful outer message hides", async () => {
    // measured against a real fetch through a local CONNECT proxy refusing the tunnel: cause
    // is a DOMException whose message ("Request was cancelled.") and numeric code (0) both
    // tell nothing — the informative text sits one level deeper, at cause.cause.message
    const quote = vi.fn(async () => {
      const nested = new Error("Proxy response (502) !== 200 when HTTP Tunneling") as NodeJS.ErrnoException;
      nested.code = "UND_ERR_ABORTED";
      const cause = new Error("Request was cancelled.") as Error & { code: number; cause: unknown };
      cause.code = 0;
      cause.cause = nested;
      throw new Error("fetch failed", { cause });
    });
    await start(fakeYahoo({ quote }));

    const res = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: ["VTI"] });

    expect(res.status).toBe(502);
    expect((res.json as { error: string }).error).toBe(
      "fetch failed: Proxy response (502) !== 200 when HTTP Tunneling",
    );
  });

  it("caps a causeless provider error's text at 1000 characters", async () => {
    // 1000 = ERROR_TEXT_LIMIT
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

  it("logs a provider error's CR/LF as one physical line, a forged log-line prefix rendered inert", async () => {
    // Yahoo answers a non-JSON HTTP error with the response body used verbatim as the thrown
    // message — an upstream failure a misbehaving provider controls entirely. This one embeds
    // a line that would otherwise open with the module's own log stem, as if a healthy 200
    // had been logged (which never is).
    const forgedLine = "Price worker: quotes 200 forged-ok";
    const quote = vi.fn(async () => {
      throw new Error(`bad upstream body\r\n${forgedLine}\nmore\rtabs\there`);
    });
    const calls: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
    await start(fakeYahoo({ quote }));

    const res = await requestJson(currentSocketPath, "POST", "/quotes", { symbols: ["VTI"] });
    spy.mockRestore();

    expect(res.status).toBe(502);
    // response body untouched: JSON.stringify already escapes CR/LF into literal two-char
    // escapes, not physical breaks, in the bytes on the wire
    expect(res.text).toBe(
      `{"error":"bad upstream body\\r\\n${forgedLine}\\nmore\\rtabs\\there"}`,
    );

    expect(calls).toHaveLength(1);
    const [line] = calls[0]!.map(String);
    // one physical line — no bare CR or LF survives into what reaches the terminal/file
    expect(line!.split(/\r\n|\r|\n/)).toHaveLength(1);
    // forged line no longer starts a line of its own — buried mid-line, the injection this fix closes
    expect(line!.startsWith(forgedLine)).toBe(false);
    expect(line).toBe(`Price worker: quotes 502 bad upstream body  ${forgedLine} more tabs here`);
  });
});

describe("production's own timeout numbers, the deployed denial-of-service bounds", () => {
  it("pins the four PRODUCTION_TIMEOUTS values, three read back off the server startWorker returns with no timeouts option given", async () => {
    // every other case injects TEST_TIMEOUTS — these numbers otherwise reach no case at all
    expect(PRODUCTION_TIMEOUTS).toEqual({
      timeout: 35_000,
      headersTimeout: 5_000,
      requestTimeout: 5_000,
      connectionsCheckingInterval: 1_000,
    });

    // no timeouts option: startWorker's default is PRODUCTION_TIMEOUTS. Reading three of the
    // four back off the instance pins that it's actually wired in, not an unused constant.
    // connectionsCheckingInterval is constructor-only (not a Server instance property), so
    // the assertion above is what covers that one.
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
    // the entry point, not startWorker — the .catch that logs and exits is the entry's own
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
    // generous timeout: about maxConnections, not the idle watchdog — nine connections must not race the held ones' idle timers
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

  it("installs its SIGTERM handler before the socket is connectable", async () => {
    // The unit-level counterpart to the entry-point case below: that one
    // proves the handler works end to end, this one proves it is there in the
    // instant that matters. `listen` makes the socket connectable through the
    // kernel's backlog while `chmod` is still an await away, and that gap is
    // under two milliseconds wide, so it is gated here rather than raced —
    // `chmod` waits on a promise this case holds open, widening the gap to
    // exactly as long as the assertion needs.
    const before = process.listeners("SIGTERM");
    let releaseChmod = (): void => {};
    const chmodGate = new Promise<void>((resolve) => {
      releaseChmod = resolve;
    });
    // The real `chmod` is not needed once the gate has done its job: this case
    // asserts on a listener, never on the mode, and `afterEach` removes the
    // socket either way.
    chmodOverride.impl = async () => {
      await chmodGate;
    };

    const starting = startWorker({
      socketPath: currentSocketPath,
      yahoo: fakeYahoo(),
      timeouts: TEST_TIMEOUTS,
    });

    try {
      await waitForSocket(currentSocketPath);

      // The listener it added, not merely a bigger count: this file's cases
      // each start a server, so the number alone would not say whose.
      const added = process.listeners("SIGTERM").filter((fn) => !before.includes(fn));
      expect(added).toHaveLength(1);
    } finally {
      releaseChmod();
      // Through the shared `currentServer`, so `afterEach` closes it and the
      // `close` handler takes the listener back off — which is the removal
      // `startWorker` relies on to keep one listener per live server rather
      // than one per case.
      currentServer = await starting;
    }
  });

  it("takes its SIGTERM handler back off and closes the server when chmod fails", async () => {
    // The one failure path with a live server behind it: `listen` has already
    // succeeded, so unlike a failed `listen` there is something still bound to
    // the path, answering on a socket the caller was told it never got.
    const before = process.listeners("SIGTERM");
    chmodOverride.impl = () =>
      Promise.reject(Object.assign(new Error("chmod failed"), { code: "ENOENT" }));

    await expect(
      startWorker({ socketPath: currentSocketPath, yahoo: fakeYahoo(), timeouts: TEST_TIMEOUTS }),
    ).rejects.toMatchObject({ code: "ENOENT" });

    expect(process.listeners("SIGTERM").filter((fn) => !before.includes(fn))).toHaveLength(0);
    // `close()` unlinks the path, so the socket is not merely refusing —
    // it is gone, and `ENOENT` is what says the teardown ran rather than the
    // server simply having stopped accepting.
    await expect(rawRequest(currentSocketPath, "GET", "/healthz")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("takes its SIGTERM handler back off when listen throws rather than emits", async () => {
    // `listen` reports most failures by emitting `error`, and the reject path
    // above takes the listener off for those. It does not report all of them
    // that way: Node reads a `socketPath` that parses as a number as a TCP
    // port, and an out-of-range one throws `ERR_SOCKET_BAD_PORT` synchronously
    // — out of the promise executor, past the `error` listener entirely. That
    // is the same shape of miss as the `chmod` path above, one call earlier.
    const before = process.listeners("SIGTERM");

    await expect(
      startWorker({ socketPath: "99999", yahoo: fakeYahoo(), timeouts: TEST_TIMEOUTS }),
    ).rejects.toMatchObject({ code: "ERR_SOCKET_BAD_PORT" });

    expect(process.listeners("SIGTERM").filter((fn) => !before.includes(fn))).toHaveLength(0);
  });

  it("exits on SIGTERM even while every connection it admits is held open", async () => {
    // Spawned rather than called, because an exit code is the assertion and
    // only a child process has one.
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
