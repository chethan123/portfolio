# 04 — The price-worker process

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.2, §3.5)._

**What to build:** Three `server/` modules, one function beside `loadConfig`, and the image change
that carries them. `server/yahoo-client.ts` is the one place `yahoo-finance2` is imported from now
on — `versionCheck: false`, every call with the library's own result validation off and under a
fixed 30 s `AbortSignal` — and the app's adapter uses it from this ticket. `server/symbol-pattern.ts`
holds the symbol pattern, the only copy. `server/price-worker.ts` is the process: a `node:http`
server on a unix socket answering the three endpoints of spec §3.2 with the library's raw JSON,
rate-capped, watchdogged, holding no database. `loadWorkerConfig` in `server/config.ts` is the
whole of its configuration. The app's behaviour changes in two ways: its own Yahoo calls become
bounded at 30 s, and one drifted entry no longer fails the whole `quote()` — it fails `safeParse`
alone and its symbol goes stale.

Its own ticket because everything here is testable from a checkout with no database and no compose
change — a temporary socket path and a fake client are the whole harness;
[05](05-deploy-the-worker-alongside.md) deploys what this proved, and [06](06-the-app-cutover.md)
writes the app's side against the protocol this pins.

**Blocked by:** [02](02-the-batched-probe.md) — both rewrite the probe's client and the describe at
`tests/price-provider.test.ts:291`, so this ticket edits `probeSymbols` once rather than rebasing
across 02's rewrite of `probeSymbol`. Parallel with [01](01-one-refresh-and-the-batch-abort.md) and
[03](03-the-three-hardening-rules.md).

**Status:** ready-for-agent

**The client** (`server/yahoo-client.ts`, new)

- [ ] `createYahooClient({ timeoutMs = 30_000 } = {}): YahooClient` — an object returned
      synchronously whose `quote(symbols)` and `chart(symbol, request)` await the memoised
      `import("yahoo-finance2")` as `yahooClient` does today
      (`app/lib/price-provider.server.ts:586`, `:617-624`), both `Promise<unknown>`; `export type
      YahooClient` is the seam `startWorker`, the adapter and every fake share. `new YahooFinance({
      versionCheck: false })`: the default is `true` and fetches
      `registry.npmjs.org/yahoo-finance2/latest` from the validation-failure path
      (`esm/src/lib/options/defaults.js:25`, `esm/src/lib/versions.js:6`, 4.0.2)
- [ ] Every call passes `{ validateResult: false, fetchOptions: { signal:
      AbortSignal.timeout(timeoutMs) } }` as the third module-options argument. `validateResult:
      false` is the setting: `moduleExec.js:89-91` reads it and `:127-130` skips the throw (research
      note §3.3 has the rest, exercised). The signal is forwarded to `fetch` (`moduleExec.js:82`)
      and reaches the crumb handshake; never in the constructor's `fetchOptions`
- [ ] The 30 s is the client's own and fixed — no call takes a deadline: the crumb handshake is
      memoised single-flight under the *first* caller's `fetchOptions` (`yahooFinanceFetch.js:74`),
      so a shorter signal from one caller could abort a handshake another had joined. `chart(symbol,
      { period1, interval: "1d", events: "split" })`; `ChartRequest` (`:589-598`) moves here with
      `period1` typed as a plain `string`, and the app imports the type. Imports nothing from
      `app/lib` — `matchKey` would pull Kysely in, and a *type* is not safe either unless it is a
      whole-statement `import type`: under Node's type stripping the inline `{ type X }` form leaves
      a live `import {} from "…"` (`tsconfig.json:21`'s `verbatimModuleSyntax` keeps it), and
      `app/` is not in the image (`Dockerfile:98-110`), so the worker would die at import
- [ ] `app/lib/price-provider.server.ts` deletes its `import("yahoo-finance2")` (`:619`),
      `yahooClient` and the `QuoteClient`/`YahooClient` types (`:601-604`) and takes the client and
      its type from this module — the adapter's parameter becomes that object; `probeSymbols`
      ([02](02-the-batched-probe.md)) takes it too. ARCHITECTURE.md §4.2's import-site row (`:338`)
      is re-pointed at `server/yahoo-client.ts` here
- [ ] `tests/yahoo-client.test.ts` (new) takes the client's own surface: the library's shape
      (`tests/price-provider.test.ts:788-818`); the request shape — `chart` forwarded with
      `period1`, `interval`, `events` and a signal in the third argument, through an injected
      `fetch` (`yahooFinanceFetch.js:58`); and the timeout — a `fetch` fake that rejects only when
      its signal aborts, `(url, init) => new Promise((_, reject) =>
      init.signal.addEventListener("abort", () => reject(init.signal.reason)))`, under `timeoutMs:
      50` and `chart` (no crumb handshake, one code path), rejected with a `DOMException` named
      **`TimeoutError`** — the signal's reason, which a real `fetch` rejects with. The library never
      races the signal itself (`queue.js:52-57` awaits the job, `yahooFinanceFetch.js:59` just calls
      `fetch`), so a fake that ignores `init.signal` hangs the test to vitest's own timeout. The
      adapter's cases (`:291`, `:704-786`) stay in `tests/price-provider.test.ts`, the fake narrowed
      to the client's new shape, until [06](06-the-app-cutover.md) deletes them with the adapter

**The pattern** (`server/symbol-pattern.ts`, new)

- [ ] `SYMBOL_PATTERN = /^[A-Za-z0-9.^=-]{1,15}$/` and `isWellFormedSymbol(value: unknown): value is
      string` — a string check before the pattern (`RegExp.test(null)` matches `"null"`). No
      imports; the only copy (spec §3.2), checked by the worker before any URL and by the app before
      any call

**The configuration** (`server/config.ts`)

- [ ] `PRICE_WORKER_SOCKET` joins `configSchema` (`:35-94`) as `z.string().min(1).default(…)`, the
      default `/run/price-worker/worker.sock` an exported constant — the app's side reads it through
      `getConfig()` in [06](06-the-app-cutover.md), and `server/config.ts` stays the only reader of
      `process.env` (ARCHITECTURE.md §4.2, `:345`). `.env.example` gains a commented line under
      "Optional: everything else" (`:72-97`) saying when to set it: a checkout running the worker
      under `/tmp`
- [ ] `export function loadWorkerConfig(env): WorkerConfig` beside `loadConfig` (`:121`): a second,
      one-key schema — `PRICE_WORKER_SOCKET` with the same default — through the same empty-as-unset
      loop (`:122-128`, lifted into a helper the two share) and the same `ConfigError`. No `TZ`: the
      worker reads no clock, `period1` is the library's to parse, and the runtime reads `TZ` itself
      (`UTC` in the image, `Dockerfile:94-96`). No `DATABASE_URL`: the worker never sees one, and
      one present in its environment is ignored rather than validated
- [ ] `tests/config.test.ts`: `loadWorkerConfig({})` answers the default path and throws nothing —
      the assertion that the worker needs no database; `loadConfig(MINIMAL)` carries the default
      path and `loadConfig({ ...MINIMAL, PRICE_WORKER_SOCKET: "/tmp/w.sock" })` the override

**The process** (`server/price-worker.ts`, new)

- [ ] `export async function startWorker({ socketPath, yahoo, timeouts? })` — `yahoo: YahooClient`;
      `timeouts` carries `timeout`, `headersTimeout`, `requestTimeout` and
      `connectionsCheckingInterval`, defaulting to production's numbers below — returns the
      listening `http.Server`: the test seam, and the entry's one call. Before `listen`: `unlink`
      the path when a file is there (`EADDRINUSE` otherwise, after any unclean exit — research note
      §8.8); then `server.listen(socketPath)`; then `chmod(socketPath, 0o660)` — `listen` creates
      the file at `0777 & ~umask`, 0755 under the image's 022, and takes no mode (research §8.6);
      the volume's `uid`/`gid`/`mode` mount options are the other half of the fence
      ([05](05-deploy-the-worker-alongside.md)). A failed unlink or listen — `EISDIR` and then
      `EADDRINUSE` on a directory squatting the path, `ENOSPC` with the volume's inodes spent — is
      logged with the path and the code and exits 1, not an unhandled `'error'` stack, so `docker
      compose logs worker` reads `listen EADDRINUSE /run/price-worker/worker.sock` and the crash
      loop under `restart: unless-stopped` is visible. `process.on("SIGTERM", () => server.close(()
      => process.exit(0)))`: Node is PID 1 under the compose `entrypoint` and ignores a signal it
      has no handler for, so without it every stop is Docker's 10 s plus `SIGKILL` and a stale
      socket file; `close()` removes the file (research §8.8), so the app sees `ENOENT` at once
- [ ] The server's bounds, a set: `server.maxConnections = 8`; `server.maxRequestsPerSocket = 1`
      (Node then answers `Connection: close` — one request per connection from the worker's side
      too); `headersTimeout` and `requestTimeout` 5 000 ms with `connectionsCheckingInterval` 1 000
      ms — the default interval is 30 s, and the two deadlines expire only a connection that has
      sent a byte (research §8.9), so they are polled every second; `server.timeout` 35 000 ms for
      the silent connection they never touch — past the 30 s watchdog, because a request waiting on
      Yahoo is inactive on the socket; a body read to 16 KB and the socket destroyed past it, with
      no status. The loop sits behind `if (import.meta.main)` (Node ≥ 24.2; `undefined` under
      vitest; research note §5.3), reading `loadWorkerConfig(process.env)` and passing
      `createYahooClient()`; one startup line naming the socket path
- [ ] The routes, spec §3.2's table and nothing else — any other method or path is `400`. Bodies
      parsed as JSON and narrowed by two Zod schemas in the module: `quotes` is `{ symbols:
      z.array(symbol).min(1).max(100) }`, `history` is `{ symbol, from }` with `from` as
      `z.string().regex(/^\d{4}-\d{2}-\d{2}$/)` — it becomes `period1`, and `IsoDate` lives under
      `app/` (`app/lib/market-hours.ts:20`), which the worker must not import — where `symbol` is
      `z.string().refine(isWellFormedSymbol)` — the worker's own check against the pattern, before
      any URL, whatever the app sent (spec §2.1 says why this copy is the binding one). A parse
      failure is `400 { error }`, the fake never called
- [ ] Per-endpoint rate caps, a sliding minute in memory: the eleventh `quotes` call and the
      twenty-first `history` call inside sixty seconds are answered `429 { error: "rate limited" }`
      with no library call and one log line — the reasoning is spec §3.5's, restated in the header
      with the cap's arithmetic
- [ ] The library call is the client's own `quote(symbols)` or `chart(symbol, { period1: from,
      interval: "1d", events: "split" })`, under the client's fixed 30 s signal and never a caller's
      — no budget crosses the socket. A `TimeoutError` from the client is `504 { error }`; any other
      throw is `502 { error }` with the message and its `cause` appended — `${message}:
      ${cause?.code ?? cause?.message}` — cut to 1000 characters, since undici says `fetch failed`
      for every network failure and keeps the detail there. Success is `200` with `JSON.stringify`
      of the library's raw return value under `content-type: application/json`
- [ ] `GET /healthz` is `200 { ok: true }` with nothing consulted — the container healthcheck in
      [05](05-deploy-the-worker-alongside.md) calls it, and it must say "accepting requests", never
      "Yahoo is fine"
- [ ] Logs: one line per non-`200` answer naming the endpoint, the status and the reason, stem
      `Price worker`; nothing per successful call. Imports: `node:http`, `node:fs/promises`, `zod`,
      `./config.ts`, `./yahoo-client.ts`, `./symbol-pattern.ts` — no `pg`, no Kysely, nothing under
      `app/`; `npm run build` and a `grep` of the import lines are the check

**The image**

- [ ] `Dockerfile:104-110` gains `server/yahoo-client.ts`, `server/symbol-pattern.ts` and
      `server/price-worker.ts`. Checked by hand here and by smoke in
      [05](05-deploy-the-worker-alongside.md): the image builds, and `node -e 'await
      import("/app/server/price-worker.ts")'` inside it imports without listening

**Tests** (`tests/price-worker.test.ts`, new; no database)

- [ ] Each case starts `startWorker` on a socket path under `os.tmpdir()` — short on purpose: a unix
      socket path is 107 usable bytes on Linux and 103 on macOS (`sun_path` is 108 with its
      terminator, research note §8.7) — with a fake client and `timeouts` in tens of milliseconds
      (`connectionsCheckingInterval` 50 ms, the interval research §8.9's probe used), closes it in
      `afterEach`, and speaks to it with `http.request({ socketPath, agent: false, … })`, so its own
      sockets are not kept alive into the next case. The app's provider module is
      [06](06-the-app-cutover.md)'s, so this file talks raw HTTP on purpose — it pins the protocol,
      not a client of it
- [ ] `/healthz` answers `200 { ok: true }` with the fake untouched; `/quotes` with three symbols
      answers `200` and the fake's array verbatim, `Date` values serialised as ISO strings;
      `/history` forwards `period1`, `interval: "1d"` and `events: "split"` to the fake's `chart`
- [ ] `400` with no library call: a body naming `BRK/B`; a null element; an empty `symbols`; 101
      symbols; a body that is not JSON; a `history` body without `from`, and one whose `from` is
      `2024-6-1`; `GET /quotes`; `POST /other`
- [ ] A 17 KB body: the socket is destroyed at the cap with no status — the request errors
      (`ECONNRESET` or `EPIPE`), and the fake is never called
- [ ] Eleven `quotes` requests in one minute: ten calls, the eleventh `429` with no call; `history`
      at twenty-one the same
- [ ] A client built with `timeoutMs: 50` over the signal-honouring `fetch` fake above, asked for a
      `chart`, answers `504` with the `TimeoutError` text; a fake whose `quote` throws `Error("No
      data found, symbol may be delisted")` answers `502` with that text in `error`; a throw
      carrying a `cause` with a `code` answers `502` with the code appended
- [ ] A stale file at the path is unlinked and the server listens; a directory at the path makes
      `startWorker` reject with the code and the path (the entry logs that and exits 1); the socket
      file's mode is `0660`; a ninth connection is accepted and closed at once while eight are held
      open — its request errors (`EPIPE`), the self-denial spec §8 states; a connection that sends
      nothing is gone within the injected `timeout`; a request line with no headers is gone within
      the injected `headersTimeout` plus one `connectionsCheckingInterval`; two requests written on
      one connection get the first answer with `Connection: close`

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build` green
