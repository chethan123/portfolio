/**
 * The price-worker process (spec 0018 §3.2, §3.5): `node:http` on a unix
 * socket, answering three endpoints with the library's raw JSON. Holds no
 * database, no domain logic, no clock reading of its own — transport plus
 * `./yahoo-client.ts`, gated by the pattern in `./symbol-pattern.ts` before
 * any URL is built (spec §2.1: the worker's own check is the one that
 * binds, the app's a courtesy). `loadWorkerConfig` (`./config.ts`) is the
 * whole of its configuration: no `DATABASE_URL`, no `PUBLIC_ORIGIN`, nothing
 * but a socket path.
 *
 * Imports, and only these: `node:http`, `node:fs/promises`, `zod`,
 * `./config.ts`, `./yahoo-client.ts`, `./symbol-pattern.ts` — no `pg`, no
 * Kysely, nothing under `app/`. `npm run build` and a grep of the import
 * lines are the check the ticket names; nothing here should ever need more.
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
 * other two no longer touch once the headers have landed; a body read to
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
 * call — a healthy worker is silent.
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

/** Every non-`200` answer: logged once, stem `Price worker`, then sent. */
function refuse(res: http.ServerResponse, endpoint: string, status: number, reason: string): void {
  console.error(`Price worker: ${endpoint} ${status} ${reason}`);
  sendJson(res, status, { error: reason });
}

/**
 * A sliding-window admission check, one instance per endpoint per server —
 * `startWorker` creates a fresh pair on every call so tests (and, in
 * production, a fresh process) never share state with a previous run.
 * Sliding rather than fixed-window: the eleventh call *within the last
 * sixty seconds*, not the eleventh since some fixed clock boundary.
 */
function makeRateLimiter(limit: number): () => boolean {
  const calls: number[] = [];

  return function admit(): boolean {
    const now = Date.now();
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

async function handleQuotes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  yahoo: YahooClient,
  admit: () => boolean,
): Promise<void> {
  const endpoint = "quotes";

  let raw: Buffer;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return;
    throw error;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    refuse(res, endpoint, 400, "body is not valid JSON");
    return;
  }

  const parsed = quotesBodySchema.safeParse(body);
  if (!parsed.success) {
    refuse(res, endpoint, 400, parsed.error.issues[0]?.message ?? "invalid body");
    return;
  }

  if (!admit()) {
    refuse(res, endpoint, 429, "rate limited");
    return;
  }

  try {
    const answer = await yahoo.quote(parsed.data.symbols);
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

  let raw: Buffer;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return;
    throw error;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    refuse(res, endpoint, 400, "body is not valid JSON");
    return;
  }

  const parsed = historyBodySchema.safeParse(body);
  if (!parsed.success) {
    refuse(res, endpoint, 400, parsed.error.issues[0]?.message ?? "invalid body");
    return;
  }

  if (!admit()) {
    refuse(res, endpoint, 429, "rate limited");
    return;
  }

  try {
    const answer = await yahoo.chart(parsed.data.symbol, {
      period1: parsed.data.from,
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
 * the entry's one call below. Before `listen`: a stale file is unlinked
 * (`EADDRINUSE` otherwise, research §8.8); then `listen`; then
 * `chmod(socketPath, 0o660)` — `listen` creates the file at `0777 & ~umask`
 * (`0755` under the image's `022`) and takes no mode of its own (research
 * §8.6). A failed unlink or listen rejects the returned promise with the
 * raw error — its `code` and the path are already in `.message` — so the
 * caller below is the one place that logs and exits.
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

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  await chmod(socketPath, 0o660);

  // Node is PID 1 under the compose `entrypoint` and ignores a signal it has
  // no handler for — without this, every stop is Docker's 10 s wait plus
  // `SIGKILL`, and a stale socket file (spec §3.2). `close()` removes the
  // file itself, so the app sees `ENOENT` at once rather than a stale
  // file's `ECONNREFUSED`. Removed once the server itself closes — every
  // test in `tests/price-worker.test.ts` starts a fresh server, and a
  // listener left on the shared `process` object per server would exceed
  // Node's default max within one test file.
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
