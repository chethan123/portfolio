/**
 * The price-worker process (spec 0018 §3.2, §3.5): `node:http` on a unix
 * socket, answering three endpoints with the library's raw JSON. Holds no
 * database and no domain logic, and reads no wall clock at all: the rate
 * window below slides on `performance.now()`'s monotonic clock rather than
 * `Date.now()`, immune to a step backward (a restored snapshot, an NTP
 * correction) that would otherwise freeze it open, and it is also why the
 * worker needs no `TZ` — it interprets no date and no zone. Transport plus
 * `./yahoo-client.ts`, gated by the pattern in
 * `./symbol-pattern.ts` before
 * any URL is built (spec §2.1: the worker's own check is the one that
 * binds, the app's a courtesy). `loadWorkerConfig` (`./config.ts`) is the
 * whole of its configuration: no `DATABASE_URL`, no `PUBLIC_ORIGIN`, nothing
 * but a socket path.
 *
 * Imports, and only these: `node:http`, `node:fs/promises`, `zod`,
 * `./config.ts`, `./yahoo-client.ts`, `./symbol-pattern.ts` — no `pg`, no
 * Kysely, nothing under `app/`. `npm run build` does not check this: nothing
 * under `app/` imports the worker, so the server bundle never carries it —
 * `grep "Price worker listening on" build/server/index.js` finds nothing.
 * `npm run typecheck` resolves these imports but would not fail on a new one.
 * What binds is a grep of the import lines here and the in-image import that
 * ticket 05's smoke runs; nothing here should ever need more.
 *
 * **Bounds, all of them defensive against the app's own compromise, not
 * against Yahoo:** `maxConnections` 8 and `maxRequestsPerSocket` 1 (so Node
 * itself answers `Connection: close`); `headersTimeout`/`requestTimeout` at
 * 5 s, checked every `connectionsCheckingInterval` (1 s in production — the
 * default is 30 s, which would let a 5 s deadline bind anywhere up to 35).
 * On this Node a connection that sends nothing is expired by those two as
 * well, not only by `server.timeout`: research §8.9 said otherwise and is
 * corrected in place, its own probe having never called `.resume()` and so
 * never seen the close. `server.timeout` at 35 s is still the bound worth
 * having, past the 30 s Yahoo watchdog — it catches the connection that has
 * sent its request and gone idle while a handler waits on Yahoo, which the
 * other two no longer touch once the request has completed — `requestTimeout`
 * reaches past the headers to the body's last byte; a body read to
 * 16 KB with the socket destroyed and no status past it.
 *
 * Per-endpoint rate caps — quotes ten calls a minute, history twenty —
 * exist because the worker is the honest component when the app is not: a
 * runaway or compromised app must not spend the household's one Yahoo
 * relationship (spec §3.5's arithmetic: a tick costs at most
 * ⌈instruments / 100⌉ quotes calls and a handful of histories, so an honest
 * household sits far under either cap).
 *
 * **Logs:** one line per non-`200` answer, naming the endpoint, the status
 * and the reason, stem `Price worker`; nothing at all for a successful
 * call — a healthy worker is silent. The one exception is a client that
 * hangs up before its declared body arrives: there is no status to name
 * because nothing was ever sent, so {@link isAbandonedRead} logs one line
 * naming just the endpoint rather than falling into the unhandled-request
 * catch below, which stays for a genuine bug in the handler itself.
 */
import { chmod, unlink } from "node:fs/promises";
import http from "node:http";

import { z } from "zod";

import { loadWorkerConfig } from "./config.ts";
import { isWellFormedSymbol } from "./symbol-pattern.ts";
import { createYahooClient } from "./yahoo-client.ts";
// Its own statement, never inlined into the value import above: the inline
// `{ type X }` form leaves a live `import {} from "…"` under Node's type
// stripping if the specifier were ever the only thing imported from a
// module — this file's own header explains why that is fatal for anything
// reaching into `app/`. `./yahoo-client.ts` ships in the image regardless,
// but every `import type` under `server/` stays a whole statement on
// principle, so no other edit here can reintroduce the trap by accident.
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

/**
 * One symbol, checked against the pattern before any URL is built — the
 * binding check (spec §2.1), whatever the app already checked or sent.
 */
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
 * `readBody`'s own `for await` rejects with exactly this shape when the peer
 * hangs up before its declared body arrives — Node's own `abortIncoming`
 * (`_http_server.js`) destroys the request with a plain `Error("aborted")`
 * carrying `.code === "ECONNRESET"`. Not a bug in the handler: the client is
 * simply gone, there is no answer to send and nothing left to destroy.
 */
function isAbandonedRead(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "aborted" &&
    (error as NodeJS.ErrnoException).code === "ECONNRESET"
  );
}

/**
 * The request body, capped at {@link MAX_BODY_BYTES}. Past the cap the
 * socket is destroyed immediately — no `400`, no status at all, because the
 * honest app never sends anywhere near this much and the cap exists against
 * a compromised or confused one (spec §3.2).
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
 * CR, LF and every other control character collapsed to a single space —
 * for the log line only. A provider failure's `reason` can be Yahoo's own
 * HTTP error body used verbatim as the thrown error's message
 * (`providerErrorText`), and `ERROR_TEXT_LIMIT` caps its length but does
 * nothing about its content: left alone, one upstream failure could write
 * many physical lines to the file an operator reads to find trouble, one of
 * them free to start with this module's own `Price worker` stem. The
 * response body needs no equivalent — it goes through `sendJson`'s own
 * `JSON.stringify`, which already escapes every one of these — so this
 * touches only what reaches `console.error`, never `reason` itself.
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
 * The status and raw response line Node's own default `clientError` handling
 * (`node:http`'s `socketOnError`) answers with for each parser error code —
 * verified against Node 24.12.0's own `lib/_http_server.js`. `default`
 * covers every other parse error the HTTP parser throws (a malformed
 * request line among them), which is also what Node's own `default` case
 * answers.
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
 * Attaching any `clientError` listener replaces Node's own default handling
 * of it entirely — for every error the parser throws, not only the three
 * spec names (a malformed request line, an oversized header block, a client
 * that never finishes its headers) — so this reproduces that default
 * exactly rather than inventing a narrower one: the same status by the same
 * mapping ({@link clientErrorResponse}), the same response line, the socket
 * destroyed after. There is no endpoint to name — the request never
 * parsed — so the log line says that rather than inventing one.
 *
 * The one case Node's own default also leaves unanswered is a socket no
 * longer writable when the event fires — `this.writable` is Node's own
 * guard, reproduced here — which is what a bare `ECONNRESET` looks like:
 * nothing was ever received to refuse, so nothing is logged, or a
 * compromised app gets exactly the log flood this contract exists to
 * prevent. `err.code` is checked too, defensively, in case a future Node
 * ever reports one for a socket this function still sees as writable.
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
 * A sliding-window admission check, one instance per endpoint per server —
 * `startWorker` creates a fresh pair on every call so tests (and, in
 * production, a fresh process) never share state with a previous run.
 * Sliding rather than fixed-window: the eleventh call *within the last
 * sixty seconds*, not the eleventh since some fixed clock boundary.
 *
 * A duration is not a wall-clock question, so this ages entries by
 * `performance.now()` rather than `Date.now()`: monotonic, immune to a
 * step in either direction. A restored VM snapshot or an NTP correction
 * that moves `Date` backward used to make `now - calls[0]` negative, and
 * with it never true — no entry was ever evicted until wall time climbed
 * back past the old timestamp plus the whole window, freezing every
 * endpoint's cap at whatever it held for as long as that backward gap
 * lasted, with `/healthz` staying green throughout.
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
 * The text a provider failure answers with: the message alone, or —
 * undici's own errors are all `TypeError: fetch failed` with the real
 * reason in `cause` — the message with the cause's `code` (or, absent one,
 * the cause's own message) appended, cut to {@link ERROR_TEXT_LIMIT}
 * characters. A `TimeoutError`'s own message ("The operation was aborted
 * due to timeout") passes through the same way, since it carries no cause.
 */
function providerErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;

  if (cause === undefined) return message.slice(0, ERROR_TEXT_LIMIT);

  const detail =
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof (cause as { code?: unknown }).code === "string"
      ? (cause as { code: string }).code
      : cause instanceof Error
        ? cause.message
        : String(cause);

  return `${message}: ${detail}`.slice(0, ERROR_TEXT_LIMIT);
}

/** `504` for the client's own watchdog, `502` for anything else Yahoo or the library threw. */
function respondProviderError(res: http.ServerResponse, endpoint: string, error: unknown): void {
  const text = providerErrorText(error);
  refuse(res, endpoint, isTimeoutError(error) ? 504 : 502, text);
}

/**
 * The part `handleQuotes` and `handleHistory` used to duplicate verbatim:
 * the body read (`BodyTooLargeError` and {@link isAbandonedRead} handled
 * the same way for both endpoints), the JSON parse, the endpoint's own
 * schema, and the rate check. `undefined` means the caller's work is done —
 * a response already sent by `refuse`, or, for `BodyTooLargeError` and an
 * abandoned read, no response at all (module header) — and a genuine bug
 * still propagates, uncaught, to `handle`'s own catch.
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
    // No Yahoo call, no database: "the worker accepts requests", never
    // "Yahoo is fine" (spec §3.5).
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

  // Cut like every other refusal text: a URL is bounded only by Node's 16 KB
  // header cap, and this route has no rate cap to spend, so an unbounded echo
  // would let anything that can reach the socket flush the log ring the
  // operator reads the worker's own trouble from.
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
    // Anything else — EISDIR on a directory squatting the path, EACCES —
    // is the caller's to log and exit on (spec §3.2).
    throw error;
  }
}

/**
 * Starts the worker and returns the listening server — the test seam, and
 * the entry's one call below. In order: a stale file is unlinked
 * (`EADDRINUSE` otherwise, research §8.8); the `SIGTERM` handler is
 * registered, before anything can be connected to; then `listen`; then
 * `chmod(socketPath, 0o660)` — `listen` creates the file at `0777 & ~umask`
 * (`0755` under the image's `022`) and takes no mode of its own (research
 * §8.6), and since `connect(2)` wants write permission, that mode admits
 * only the worker until this `chmod` opens it to the group. Any of the
 * three failing rejects with the raw error — its `code` and the path are
 * already in `.message` — so the caller below is the one place that logs and
 * exits; the two that fail after the handler is registered take it back off
 * on their way out, and the `chmod` one closes the server it is leaving.
 */
export async function startWorker(options: StartWorkerOptions): Promise<http.Server> {
  const { socketPath, yahoo } = options;
  const timeouts = options.timeouts ?? PRODUCTION_TIMEOUTS;

  await unlinkIfExists(socketPath);

  const admitQuotes = makeRateLimiter(RATE_CAPS.quotes);
  const admitHistory = makeRateLimiter(RATE_CAPS.history);

  // `connectionsCheckingInterval` is a constructor-only option in @types/node
  // (absent from the `Server` instance's own declarations, though the
  // runtime accepts it as a plain property too) — passed here rather than
  // assigned after, alongside the two it is polled for.
  const server = http.createServer(
    {
      headersTimeout: timeouts.headersTimeout,
      requestTimeout: timeouts.requestTimeout,
      connectionsCheckingInterval: timeouts.connectionsCheckingInterval,
    },
    (req, res) => {
      handle(req, res, yahoo, admitQuotes, admitHistory).catch((error: unknown) => {
        // A bug in the handler itself, not a provider or validation failure —
        // both of those are already caught above. Nothing documented in spec
        // §3.2's table covers this, so the safe answer is the same one an
        // oversized body gets: no half-written response, socket gone.
        console.error("Price worker: unhandled request error", error);
        req.socket.destroy();
      });
    },
  );

  server.maxConnections = 8;
  server.maxRequestsPerSocket = 1;
  server.timeout = timeouts.timeout;
  // Node answers a malformed request line, an oversized header block, and a
  // client that never finishes its headers itself — the header/request
  // deadlines above included, since `ERR_HTTP_REQUEST_TIMEOUT` arrives
  // through this same event — but only while nothing is listening for it
  // (module header, {@link onClientError}'s own).
  server.on("clientError", onClientError);

  // Node is PID 1 under the compose `entrypoint` and ignores a signal it has
  // no handler for — without this, every stop is Docker's 10 s wait plus
  // `SIGKILL`, and a stale socket file (spec §3.2). `close()` removes the
  // file itself, so the app sees `ENOENT` at once rather than a stale
  // file's `ECONNREFUSED`. Removed once the server itself closes — every
  // test in `tests/price-worker.test.ts` starts a fresh server, and a
  // listener left on the shared `process` object per server would exceed
  // Node's default max within one test file.
  //
  // Registered *before* `listen`, which is the whole point of where it sits.
  // The socket file appears — and accepts connections through the kernel's
  // backlog — the instant `listen` succeeds, while the `chmod` below is
  // another turn of the loop away. A `SIGTERM` arriving in that gap used to
  // find no handler at all and take Node's default disposition: the process
  // died by signal with the socket file still on disk, which is exactly the
  // stop this handler exists to prevent. The gap is real but narrow — `listen`
  // returning to `chmod` resolving measured under two milliseconds — so it is
  // a race, not a certainty: spawning the entry point and signalling it the
  // instant the socket file appeared, five of twelve starts died by signal
  // before the move and none of twelve after, every one of the five leaving
  // the file behind. The case pinning it in `tests/price-worker.test.ts` gates
  // the `chmod` open rather than racing that window, which is why it fails
  // every run instead of five times in twelve.
  const onSigterm = (): void => {
    // Every connection, not just the idle ones. `close()` waits for all of
    // them, and a socket that has never sent a byte is not *idle* in Node's
    // sense — it has no request to be between — so `closeIdleConnections()`
    // leaves exactly the eight a compromised app would hold, and the wait
    // outlasts Docker's ten-second grace: the stop degrades into the
    // `SIGKILL` this handler exists to avoid. A request in flight is lost
    // with them, which is the same answer a stopped worker gives anyway —
    // the app reads it as a provider failure and keeps the last price.
    server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", onSigterm);
  server.once("close", () => {
    process.removeListener("SIGTERM", onSigterm);
  });

  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: Error): void => {
      // Nothing to close and nothing to stop: take the listener back off the
      // shared `process` object rather than leaving one per failed start.
      process.removeListener("SIGTERM", onSigterm);
      reject(error);
    };
    server.once("error", onListenError);
    server.listen(socketPath, () => {
      // Named, so this takes off the one listener this promise added and
      // leaves any other alone.
      server.removeListener("error", onListenError);
      resolve();
    });
  });

  try {
    await chmod(socketPath, 0o660);
  } catch (error) {
    // The other failure path with a listener to take back — and the only one
    // with a live server behind it, `listen` having already succeeded. What
    // is left behind is not an over-open socket: `connect(2)` on a unix
    // socket wants *write* permission, so the `0755` `listen` leaves under
    // the image's umask admits nobody but the worker, and this `chmod` is
    // what opens it to the group. Left alone it is worse than useless — a
    // server still bound to a path the caller was told it never got, that
    // `app` cannot reach and nothing will now widen. `close()` unlinks the
    // path on its way out.
    process.removeListener("SIGTERM", onSigterm);
    server.closeAllConnections();
    server.close();
    throw error;
  }

  console.log(`Price worker listening on ${socketPath}`);

  return server;
}

// `undefined` under vitest (Node ≥ 24.2; research §5.3) — the loop below
// never runs under the test suite.
if (import.meta.main) {
  const config = loadWorkerConfig(process.env);

  startWorker({ socketPath: config.PRICE_WORKER_SOCKET, yahoo: createYahooClient() }).catch(
    (error: unknown) => {
      console.error(`Price worker: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
