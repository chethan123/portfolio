/**
 * The price-worker process (spec 0018 §3.2, §3.5): `node:http` on a unix socket, three endpoints
 * answering the library's raw JSON. No database, no domain logic, no wall clock — the rate window
 * slides on `performance.now()`, so a backward step cannot freeze it open and no `TZ` is needed.
 * Every bound here is defensive against the app's own compromise, not against Yahoo.
 */
import { chmod, unlink } from "node:fs/promises";
import http from "node:http";

import { z } from "zod";

import { loadWorkerConfig } from "./config.ts";
import { isWellFormedSymbol } from "./symbol-pattern.ts";
import { createYahooClient } from "./yahoo-client.ts";
// Its own statement, never inlined into the value import: the inline `{ type X }` form can leave a
// live `import {} from "…"` under Node's type stripping. Every `import type` under `server/` too.
import type { YahooClient } from "./yahoo-client.ts";

const MAX_BODY_BYTES = 16 * 1024;

/** `${message}: ${cause}` is cut here — undici's `fetch failed` keeps the detail in `cause`. */
const ERROR_TEXT_LIMIT = 1000;

const RATE_LIMIT_WINDOW_MS = 60_000;

const RATE_CAPS = { quotes: 10, history: 20 } as const;

export type WorkerTimeouts = {
  timeout: number;
  headersTimeout: number;
  requestTimeout: number;
  connectionsCheckingInterval: number;
};

export const PRODUCTION_TIMEOUTS: WorkerTimeouts = {
  timeout: 35_000,
  headersTimeout: 5_000,
  requestTimeout: 5_000,
  connectionsCheckingInterval: 1_000,
};

export type StartWorkerOptions = {
  socketPath: string;
  yahoo: YahooClient;
  timeouts?: WorkerTimeouts;
};

/** The binding check (spec §2.1), whatever the app already checked or sent. */
const symbolField = z.string().refine(isWellFormedSymbol);

const quotesBodySchema = z.object({
  symbols: z.array(symbolField).min(1).max(100),
});

const historyBodySchema = z.object({
  symbol: symbolField,
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

class BodyTooLargeError extends Error {}

/** Node's `abortIncoming` gives `Error("aborted")` with `ECONNRESET` when the peer hangs up mid-body. Not a bug. */
function isAbandonedRead(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "aborted" &&
    (error as NodeJS.ErrnoException).code === "ECONNRESET"
  );
}

/** Past {@link MAX_BODY_BYTES} the socket is destroyed with no status — the cap is against a compromised app. */
async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > limit) {
      req.destroy();
      throw new BodyTooLargeError();
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

/** Log line only: a provider `reason` can be Yahoo's body, and a raw newline would forge lines under this stem. */
function logSafe(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, " ");
}

function refuse(res: http.ServerResponse, endpoint: string, status: number, reason: string): void {
  console.error(`Price worker: ${endpoint} ${status} ${logSafe(reason)}`);
  sendJson(res, status, { error: reason });
}

/** Node's own default `clientError` answers, per parser error code — verified against 24.12.0's `lib/_http_server.js`. */
function clientErrorResponse(code: string | undefined): { status: number; line: string } {
  switch (code) {
    case "HPE_HEADER_OVERFLOW":
      return {
        status: 431,
        line: "HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n",
      };
    case "HPE_CHUNK_EXTENSIONS_OVERFLOW":
      return { status: 413, line: "HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\n\r\n" };
    case "ERR_HTTP_REQUEST_TIMEOUT":
      return { status: 408, line: "HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n" };
    default:
      return { status: 400, line: "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n" };
  }
}

/**
 * Any `clientError` listener replaces Node's default for every parser error, so this reproduces it.
 * The `writable`/`ECONNRESET` guard is Node's own: logging a bare reset would be the log flood.
 */
function onClientError(
  error: Error,
  socket: { writable: boolean; write: (data: string) => void; destroy: (error?: Error) => void },
): void {
  const err = error as NodeJS.ErrnoException;
  if (err.code !== "ECONNRESET" && socket.writable) {
    const { status, line } = clientErrorResponse(err.code);
    socket.write(line);
    const reason = logSafe(err.code ?? err.message).slice(0, ERROR_TEXT_LIMIT);
    console.error(`Price worker: (no endpoint — request never parsed) ${status} ${reason}`);
  }
  socket.destroy(err);
}

/**
 * Sliding window, one per endpoint per server. Aged by `performance.now()`: with `Date.now()` a
 * backward step makes `now - calls[0]` negative, evicting nothing and freezing every cap open.
 */
function makeRateLimiter(limit: number): () => boolean {
  const calls: number[] = [];

  return function admit(): boolean {
    const now = performance.now();
    while (calls.length > 0 && now - calls[0]! >= RATE_LIMIT_WINDOW_MS) calls.shift();
    if (calls.length >= limit) return false;
    calls.push(now);
    return true;
  };
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/** `message` over `code`: a DNS failure's `getaddrinfo ENOTFOUND egress-proxy` keeps the host, `code` alone drops it. */
function detailFor(value: unknown): string | undefined {
  if (value instanceof Error) return value.message;
  if (typeof value === "object" && value !== null && "code" in value) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * undici errors are all `TypeError: fetch failed` with the reason nested in `cause`, so: message plus
 * one more level, cut to {@link ERROR_TEXT_LIMIT}. That level is needed — a CONNECT refusal's first
 * cause is a `DOMException` naming nothing, with the real text at `cause.cause.message`.
 */
function providerErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;

  if (cause === undefined) return message.slice(0, ERROR_TEXT_LIMIT);

  const nestedCause = cause instanceof Error ? (cause as { cause?: unknown }).cause : undefined;
  const nested = nestedCause !== undefined ? (detailFor(nestedCause) ?? String(nestedCause)) : undefined;
  const detail = nested ?? detailFor(cause) ?? String(cause);

  return `${message}: ${detail}`.slice(0, ERROR_TEXT_LIMIT);
}

function respondProviderError(res: http.ServerResponse, endpoint: string, error: unknown): void {
  const text = providerErrorText(error);
  refuse(res, endpoint, isTimeoutError(error) ? 504 : 502, text);
}

/** `undefined` = already answered, or deliberately unanswered (oversized/abandoned body). Bugs still throw. */
async function readAdmittedBody<Schema extends z.ZodType>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  endpoint: string,
  schema: Schema,
  admit: () => boolean,
): Promise<z.output<Schema> | undefined> {
  let raw: Buffer;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return undefined;
    if (isAbandonedRead(error)) {
      console.error(`Price worker: ${endpoint} client disconnected before the body completed`);
      return undefined;
    }
    throw error;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    refuse(res, endpoint, 400, "body is not valid JSON");
    return undefined;
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    refuse(res, endpoint, 400, parsed.error.issues[0]?.message ?? "invalid body");
    return undefined;
  }

  if (!admit()) {
    refuse(res, endpoint, 429, "rate limited");
    return undefined;
  }

  return parsed.data;
}

async function handleQuotes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  yahoo: YahooClient,
  admit: () => boolean,
): Promise<void> {
  const endpoint = "quotes";

  const data = await readAdmittedBody(req, res, endpoint, quotesBodySchema, admit);
  if (data === undefined) return;

  try {
    const answer = await yahoo.quote(data.symbols);
    sendJson(res, 200, answer);
  } catch (error) {
    respondProviderError(res, endpoint, error);
  }
}

async function handleHistory(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  yahoo: YahooClient,
  admit: () => boolean,
): Promise<void> {
  const endpoint = "history";

  const data = await readAdmittedBody(req, res, endpoint, historyBodySchema, admit);
  if (data === undefined) return;

  try {
    const answer = await yahoo.chart(data.symbol, {
      period1: data.from,
      interval: "1d",
      events: "split",
    });
    sendJson(res, 200, answer);
  } catch (error) {
    respondProviderError(res, endpoint, error);
  }
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  yahoo: YahooClient,
  admitQuotes: () => boolean,
  admitHistory: () => boolean,
): Promise<void> {
  const { method, url } = req;

  if (method === "GET" && url === "/healthz") {
    // No Yahoo call, no database: "the worker accepts requests", never "Yahoo is fine" (spec §3.5).
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && url === "/quotes") {
    await handleQuotes(req, res, yahoo, admitQuotes);
    return;
  }

  if (method === "POST" && url === "/history") {
    await handleHistory(req, res, yahoo, admitHistory);
    return;
  }

  // Cut: a URL is bounded only by the 16 KB header cap and this route has no rate cap — an unbounded echo floods the log.
  refuse(
    res,
    "unknown",
    400,
    `no route for ${String(method)} ${String(url)}`.slice(0, ERROR_TEXT_LIMIT),
  );
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    // EISDIR on a squatting directory, EACCES — the caller's to log and exit on (spec §3.2).
    throw error;
  }
}

/**
 * Order matters: unlink a stale socket (else `EADDRINUSE`); register `SIGTERM` before anything can
 * connect; `listen`; `chmod` 0o660, since `listen` creates the file at `0777 & ~umask` and takes no
 * mode. Every failure path rejects raw and undoes its own setup; the caller below logs and exits.
 */
export async function startWorker(options: StartWorkerOptions): Promise<http.Server> {
  const { socketPath, yahoo } = options;
  const timeouts = options.timeouts ?? PRODUCTION_TIMEOUTS;

  await unlinkIfExists(socketPath);

  const admitQuotes = makeRateLimiter(RATE_CAPS.quotes);
  const admitHistory = makeRateLimiter(RATE_CAPS.history);

  // `connectionsCheckingInterval` is constructor-only in @types/node.
  const server = http.createServer(
    {
      headersTimeout: timeouts.headersTimeout,
      requestTimeout: timeouts.requestTimeout,
      connectionsCheckingInterval: timeouts.connectionsCheckingInterval,
    },
    (req, res) => {
      handle(req, res, yahoo, admitQuotes, admitHistory).catch((error: unknown) => {
        // A handler bug — provider and validation failures are caught above. No half-written response.
        console.error("Price worker: unhandled request error", error);
        req.socket.destroy();
      });
    },
  );

  server.maxConnections = 8;
  server.maxRequestsPerSocket = 1;
  server.timeout = timeouts.timeout;
  // Node answers a malformed request line itself, but only while nothing listens for `clientError`.
  server.on("clientError", onClientError);

  // Node is PID 1 under compose and ignores unhandled signals; without this every stop is 10 s then
  // `SIGKILL`, leaving a stale socket file (`close()` unlinks it). Before `listen`, not after: the
  // backlog accepts the instant `listen` returns, and a `SIGTERM` in that gap hit 12 tries in 12.
  const onSigterm = (): void => {
    // Not `closeIdleConnections()`: a socket that never sent a byte is not *idle*, so a compromised
    // app's eight would outlast Docker's grace. An in-flight request is lost, which is fine.
    server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", onSigterm);
  server.once("close", () => {
    process.removeListener("SIGTERM", onSigterm);
  });

  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: Error): void => {
      // Nothing to close: take the listener off the shared `process` rather than leak one per failed start.
      process.removeListener("SIGTERM", onSigterm);
      reject(error);
    };
    server.once("error", onListenError);
    try {
      server.listen(socketPath, () => {
        // Named, so this removes the one listener this promise added and leaves any other alone.
        server.removeListener("error", onListenError);
        resolve();
      });
    } catch (error) {
      // `listen` also throws: a numeric `socketPath` is read as a TCP port, and `99999` throws `ERR_SOCKET_BAD_PORT` here.
      server.removeListener("error", onListenError);
      onListenError(error instanceof Error ? error : new Error(String(error)));
    }
  });

  try {
    await chmod(socketPath, 0o660);
  } catch (error) {
    // The one failure path with a live server behind it: a rejected `startWorker` must leave nothing bound.
    process.removeListener("SIGTERM", onSigterm);
    server.closeAllConnections();
    server.close();
    throw error;
  }

  console.log(`Price worker listening on ${socketPath}`);

  return server;
}

if (import.meta.main) {
  const config = loadWorkerConfig(process.env);

  startWorker({ socketPath: config.PRICE_WORKER_SOCKET, yahoo: createYahooClient() }).catch(
    (error: unknown) => {
      console.error(`Price worker: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
