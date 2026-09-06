/**
 * The price-worker process (spec 0018 §3.2, §3.5): `node:http` on a unix socket, answering three
 * endpoints with the library's raw JSON. No database, no domain logic, no wall clock — the rate
 * window slides on `performance.now()`, so a step backward (a restored snapshot, an NTP correction)
 * cannot freeze it open, and the worker needs no `TZ`. Symbols are gated by `./symbol-pattern.ts`
 * before any URL is built (spec §2.1: this check binds, the app's is a courtesy).
 *
 * Imports only `node:http`, `node:fs/promises`, `zod`, `./config.ts`, `./yahoo-client.ts`,
 * `./symbol-pattern.ts` — nothing under `app/`, no `pg`, no Kysely. Nothing enforces that but a
 * grep of the import lines and ticket 05's in-image smoke.
 *
 * The bounds are defensive against the app's own compromise, not against Yahoo: `maxConnections` 8,
 * `maxRequestsPerSocket` 1, 5 s headers/request deadlines polled every 1 s (the 30 s default would
 * let a 5 s deadline bind anywhere up to 35), `server.timeout` 35 s for a connection that has sent
 * its request and gone idle while a handler waits on Yahoo, and per-endpoint caps of ten quotes and
 * twenty history calls a minute.
 *
 * One log line per non-`200` answer, stem `Price worker`; nothing at all on success. The exception
 * is a client that hangs up mid-body: no status was ever sent, so {@link isAbandonedRead} logs the
 * endpoint alone rather than falling into the unhandled-request catch.
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

/** A body past this many bytes gets its socket destroyed, no status at all. */
const MAX_BODY_BYTES = 16 * 1024;

/** `${message}: ${cause}` is cut here — undici's `fetch failed` keeps the detail in `cause`. */
const ERROR_TEXT_LIMIT = 1000;

/** A sliding sixty-second window. */
const RATE_LIMIT_WINDOW_MS = 60_000;

/** Spec §3.5's caps: ten quotes calls and twenty history calls a minute. */
const RATE_CAPS = { quotes: 10, history: 20 } as const;

/** The four numbers {@link startWorker} accepts under `timeouts`, and production's own. */
export type WorkerTimeouts = {
  timeout: number;
  headersTimeout: number;
  requestTimeout: number;
  connectionsCheckingInterval: number;
};

/** Production's numbers (module header). Tests inject their own, in tens of milliseconds. */
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

/** Thrown by {@link readBody} once the cap is spent; the socket is already gone by then. */
class BodyTooLargeError extends Error {}

/**
 * Node's own `abortIncoming` destroys the request with `Error("aborted")` carrying `ECONNRESET`
 * when the peer hangs up mid-body. Not a handler bug: nothing to answer and nothing to destroy.
 */
function isAbandonedRead(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "aborted" &&
    (error as NodeJS.ErrnoException).code === "ECONNRESET"
  );
}

/**
 * The request body, capped at {@link MAX_BODY_BYTES}. Past the cap the socket is destroyed with no
 * status at all: the honest app never sends near this much, and the cap is against one that is not.
 */
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

/**
 * Control characters collapsed to a space, for the log line only — a provider failure's `reason`
 * can be Yahoo's own body, and a raw newline would forge lines under this module's own stem. The
 * response body needs none: `sendJson`'s `JSON.stringify` already escapes them.
 */
function logSafe(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, " ");
}

/** Every non-`200` answer: logged once, stem `Price worker`, then sent. */
function refuse(res: http.ServerResponse, endpoint: string, status: number, reason: string): void {
  console.error(`Price worker: ${endpoint} ${status} ${logSafe(reason)}`);
  sendJson(res, status, { error: reason });
}

/**
 * What Node's own default `clientError` handling answers per parser error code — verified against
 * Node 24.12.0's `lib/_http_server.js`, `default` included.
 */
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
 * Attaching any `clientError` listener replaces Node's default entirely, for every parser error, so
 * this reproduces it exactly rather than inventing a narrower one. There is no endpoint to name.
 *
 * The `writable`/`ECONNRESET` guard is Node's own: a bare reset received nothing to refuse, and
 * logging it would hand a compromised app the log flood this contract exists to prevent.
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
 * Sliding-window admission, one instance per endpoint per server: the eleventh call within the
 * last sixty seconds, not since a fixed boundary. Aged by `performance.now()` — with `Date.now()`,
 * a backward step made `now - calls[0]` negative, evicting nothing until wall time caught up and
 * freezing every cap at whatever it held, `/healthz` green throughout.
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

/** `error.name === "TimeoutError"` is what a `fetch` rejects with once its own signal aborts. */
function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/**
 * The one detail {@link providerErrorText} takes from a cause: an `Error`'s `message`, preferred
 * over its `code` rather than falling back to it — a real DNS failure's message is `getaddrinfo
 * ENOTFOUND egress-proxy`, where `code` alone drops the host (ticket 08's `fetch failed: ENOTFOUND`).
 */
function detailFor(value: unknown): string | undefined {
  if (value instanceof Error) return value.message;
  if (typeof value === "object" && value !== null && "code" in value) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * The text a provider failure answers with. undici's errors are all `TypeError: fetch failed` with
 * the real reason nested in `cause`, so the message plus exactly one more level of `cause`, cut to
 * {@link ERROR_TEXT_LIMIT}. One level is as far as the shape needs: a `fetch` refused by a CONNECT
 * proxy has a `DOMException` cause naming nothing, `code` the *number* 0, and the informative text
 * (`Proxy response (502) !== 200 when HTTP Tunneling`) at `cause.cause.message`.
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

/** `504` for the client's own watchdog, `502` for anything else Yahoo or the library threw. */
function respondProviderError(res: http.ServerResponse, endpoint: string, error: unknown): void {
  const text = providerErrorText(error);
  refuse(res, endpoint, isTimeoutError(error) ? 504 : 502, text);
}

/**
 * The body read, JSON parse, schema and rate check the two endpoints share. `undefined` means the
 * caller's work is done — a response already sent, or deliberately none for an oversized or
 * abandoned body; a genuine bug still propagates to `handle`'s own catch.
 */
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

  // Cut like every other refusal text: a URL is bounded only by Node's 16 KB header cap, and this
  // route has no rate cap to spend, so an unbounded echo could flush the operator's log ring.
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
    // Anything else — EISDIR on a directory squatting the path, EACCES — is the caller's to log
    // and exit on (spec §3.2).
    throw error;
  }
}

/**
 * Starts the worker and returns the listening server — the test seam and the entry's one call.
 * In order: unlink a stale socket file (`EADDRINUSE` otherwise); register `SIGTERM` before anything
 * can connect; `listen`; then `chmod` 0o660, because `listen` creates the file at `0777 & ~umask`
 * and takes no mode of its own. Each of the four failure paths rejects with the raw error, so the
 * caller below is the one place that logs and exits, and each undoes what it had set up.
 */
export async function startWorker(options: StartWorkerOptions): Promise<http.Server> {
  const { socketPath, yahoo } = options;
  const timeouts = options.timeouts ?? PRODUCTION_TIMEOUTS;

  await unlinkIfExists(socketPath);

  const admitQuotes = makeRateLimiter(RATE_CAPS.quotes);
  const admitHistory = makeRateLimiter(RATE_CAPS.history);

  // `connectionsCheckingInterval` is a constructor-only option in @types/node, so it is passed here
  // rather than assigned after.
  const server = http.createServer(
    {
      headersTimeout: timeouts.headersTimeout,
      requestTimeout: timeouts.requestTimeout,
      connectionsCheckingInterval: timeouts.connectionsCheckingInterval,
    },
    (req, res) => {
      handle(req, res, yahoo, admitQuotes, admitHistory).catch((error: unknown) => {
        // A bug in the handler itself — provider and validation failures are already caught above.
        // Same answer as an oversized body: no half-written response, socket gone.
        console.error("Price worker: unhandled request error", error);
        req.socket.destroy();
      });
    },
  );

  server.maxConnections = 8;
  server.maxRequestsPerSocket = 1;
  server.timeout = timeouts.timeout;
  // Node answers a malformed request line, an oversized header block and an unfinished header set
  // itself, but only while nothing is listening for `clientError`.
  server.on("clientError", onClientError);

  // Node is PID 1 under the compose `entrypoint` and ignores a signal it has no handler for —
  // without this, every stop is Docker's 10 s wait plus `SIGKILL`, and a stale socket file. `close()`
  // unlinks the file, so the app sees `ENOENT` rather than a stale file's `ECONNREFUSED`. Removed
  // once the server closes: one listener per server on the shared `process` would exceed Node's max
  // across a test file.
  //
  // Registered *before* `listen`: the socket accepts connections through the kernel backlog the
  // instant `listen` succeeds, and a `SIGTERM` in the sub-millisecond gap before this line used to
  // take Node's default disposition — dead by signal, socket file still on disk. Narrow, but a
  // busy spin on the file hit it twelve times in twelve.
  const onSigterm = (): void => {
    // Every connection, not just the idle ones: a socket that has never sent a byte is not *idle*
    // in Node's sense, so `closeIdleConnections()` leaves exactly the eight a compromised app would
    // hold and the wait outlasts Docker's grace. A request in flight is lost, which is the answer a
    // stopped worker gives anyway.
    server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", onSigterm);
  server.once("close", () => {
    process.removeListener("SIGTERM", onSigterm);
  });

  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: Error): void => {
      // Nothing to close and nothing to stop: take the listener back off the shared `process`
      // object rather than leaving one per failed start.
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
      // `listen` does not only *emit* its failures: Node reads a `socketPath` that parses as a
      // number as a TCP port, and `99999` throws `ERR_SOCKET_BAD_PORT` straight out of this
      // executor, past the `error` listener that would have cleaned up.
      server.removeListener("error", onListenError);
      onListenError(error instanceof Error ? error : new Error(String(error)));
    }
  });

  try {
    await chmod(socketPath, 0o660);
  } catch (error) {
    // The one failure path with a live server behind it. Not about permissions — `app` runs as the
    // same uid and is the socket's owner either way — but because a `startWorker` that rejected must
    // not leave a server bound to a path its caller was told it never got. `close()` unlinks it.
    process.removeListener("SIGTERM", onSigterm);
    server.closeAllConnections();
    server.close();
    throw error;
  }

  console.log(`Price worker listening on ${socketPath}`);

  return server;
}

// `undefined` under vitest (Node ≥ 24.2), so the loop below never runs under the test suite.
if (import.meta.main) {
  const config = loadWorkerConfig(process.env);

  startWorker({ socketPath: config.PRICE_WORKER_SOCKET, yahoo: createYahooClient() }).catch(
    (error: unknown) => {
      console.error(`Price worker: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
