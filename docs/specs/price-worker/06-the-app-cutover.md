# 06 — The app cutover

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.3, §3.8)._

**What to build:** `app/lib/provider-socket.server.ts` — `ask`, `socketProvider` and `socketProbe`
— and the three callers moved onto it: `runRefresh`'s default provider, the poller's default
provider, and the ingest action's probe. The app's adapter loses its client use, so after this
ticket nothing in the app's module graph reaches `yahoo-finance2`. The worker deployed in
[05](05-deploy-the-worker-alongside.md) starts doing the work; the app stops fetching for itself.

Its own ticket because this is the single release where the fetch moves, and it has to land after
the worker is provably listening (or a deploy has no price refresh) and before the network lockdown
(or the app fetches from an isolated network and logs a failure every tick). It is code only: the
volume is already mounted in `app`.

**Blocked by:** [01](01-one-refresh-and-the-batch-abort.md), [02](02-the-batched-probe.md),
[03](03-the-three-hardening-rules.md), [05](05-deploy-the-worker-alongside.md).

**Status:** ready-for-agent

**The module** (`app/lib/provider-socket.server.ts`, new)

- [ ] `ask(kind, body, { budgetMs } = …)` with the production budgets as defaults, so a test passes
      200 ms instead of sleeping through real ones (`tests/price-poller.test.ts:139-149` documents
      why fake timers are not the answer). One `http.request({ socketPath:
      getConfig().PRICE_WORKER_SOCKET, method: "POST", path: "/" + kind, headers: { "content-type":
      "application/json" }, agent: false, signal: AbortSignal.timeout(budgetMs) })`, the body
      `JSON.stringify(body)`. `agent: false` because Node 24's global agent keeps sockets alive and
      pools by `socketPath` (research note §8.9): without it every call leaves an idle socket in the
      worker's eight `maxConnections` slots for six seconds, and a call landing as the worker's
      keep-alive timer fires is an `ECONNRESET` the ledger would record as a provider failure. The
      response is read to a per-kind cap and the request destroyed past it — `quotes` 512 KB (a
      hundred entries are about 400 KB), `history` 2 MiB (a ten-year chart answer is around 300 KB)
      — then `JSON.parse` of the whole. No handle, no flag: a dead worker costs one connect failure
      per call site, and the batch abort of [01](01-one-refresh-and-the-batch-abort.md) is what
      keeps a tick's cost at two of them (spec §3.3)
- [ ] The outcomes, told apart in this order: a request `error` whose `syscall` is `"connect"` —
      `ENOENT`, `ECONNREFUSED`, `EACCES`, `ENOTDIR`, whatever the code (research §8.8) — →
      `ProviderUnreachable` with the message `no worker listening at <path> (<code>)`, keyed on the
      syscall and not on a code list because a permission fault is persistent and is exactly "no
      worker reachable", and
      as a plain failure it would ledger five candidates a day; a request `error` named
      `AbortError` (`code: "ABORT_ERR"`, its `cause` the signal's `TimeoutError` — `http.request`
      wraps the reason where `fetch` throws it, research §8.9), or simply `signal.aborted` → an `Error`
      saying the worker did not answer within the budget; the body cap → an `Error` naming it; a
      status other than `200` → an `Error` carrying the body's `error` text, or the status when the
      body has none; `200` → the parsed body. Budgets as constants with their reasons: `quotes`
      15 s (a slow quote is stale prices either way, so the call is abandoned while the worker
      finishes it), `history` 35 s (past the worker's 30 s watchdog, so the app reads the worker's
      `504` and its reason rather than its own abort — the app's signal starts before `connect` and
      at 30 s would always win by transit time), `probe` 10 s (a cold worker's first probe pays a
      three-fetch crumb handshake, and the verdict a short budget loses is `non-usd`, the one a
      person acts on)
- [ ] Symbols failing `isWellFormedSymbol` (`server/symbol-pattern.ts`, imported the way
      `app/lib/db.server.ts:17` imports `server/db.ts`) are dropped before the call with one
      `console.warn` naming them, on every refresh — no memo; more than 100 symbols split into
      consecutive asks with the answers concatenated; an empty list after dropping is an empty
      answer and no call
- [ ] `socketProvider(): PriceProvider` — `getQuotes`: a body that is not an array is `[]`; each
      entry through `toProviderQuote`, `CurrencyRefused` logged and skipped exactly as
      `yahooPriceProvider` did (`price-provider.server.ts:719-731`). `getDailyCloses`:
      `ask("history", { symbol: matchKey(symbol), from: range.from })`; a refusal whose text matches
      `isMissingHistory` (`:787-793`, now exported) is `{ status: "no-history" }`; a `200` goes
      through `toProviderHistory(body, range, marketTimeZone)`
- [ ] `socketProbe: ProbeSymbols` ([02](02-the-batched-probe.md)'s type) — `ask("quotes", …)` for
      the batch, split at a hundred like `getQuotes`, then `probeVerdicts`; any throw is
      `unavailable` for every symbol; never throws
- [ ] The module header carries the argument: why a unix socket and not a TCP port on an internal
      network (a bridge is symmetric — the worker would reach `app:3000`); why no handle and no flag
      (a connect failure is immediate, so there is nothing to amortise); why no budget crosses the
      socket (the worker's watchdog is its own, spec §3.5); and that the app never reads the volume
      — no `readdir`, no `stat` — and never creates a unix socket of its own there, because a
      symlink the worker plants at the path is followed by `connect()` in the app's own mount
      namespace, and today that namespace holds no other socket to reach (spec §8)

**The callers**

- [ ] `runRefresh`'s default becomes `socketProvider()`, `startPricePoller`'s the same (one instance
      for the process, as today); `app/routes/upload/instruments.tsx:104-106` passes `{ probe:
      socketProbe }`
- [ ] `app/lib/price-provider.server.ts` loses `yahooPriceProvider` and `probeSymbols` and keeps the
      types, the schemas, `toProviderQuote`, `toProviderHistory`, `probeVerdicts`,
      `CurrencyRefused`, `ProviderUnreachable` and `isMissingHistory`; its header (`:1-12`) says the
      seam has two implementations and only one lives in this process, and keeps the package name in
      comments only. Nothing under `app/` imports `server/yahoo-client.ts` any more — `npm run
      build` is the gate
- [ ] `scripts/smoke-test.sh` gains the source-level assertion a container check cannot make: `grep`
      over `/app/build/server/` in the image finds no `yahoo-finance2` — comments are stripped by
      the build, a string literal would trip it. The package stays on disk and the guarantee is the
      network; this proves the graph
- [ ] `docs/operating.md:738`'s `Price provider failed` bullet under Logs — not `:761`'s "There is
      no price line in the log" list, whose four causes are a refresh that never ran, while a dead
      worker writes a `Price provider failed` line *every tick* — gains the worker-not-listening
      signature: dead, restarting, or absent because `compose.yaml` was never replaced and the
      volume does not exist. The text says "no worker listening at /run/price-worker/worker.sock
      (ENOENT)" — `ECONNREFUSED` for a stale file, `EACCES` for a permission slip — and `docker
      compose ps` shows `worker` unhealthy, restarting or missing. The upgrade note repeats
      [05](05-deploy-the-worker-alongside.md)'s compose-file rule and its symptom. The full record
      is [09](09-documents-and-runbooks.md)'s
- [ ] The developer's recipe, under Recipes (`docs/developing.md:331`), because from this ticket
      `npm run dev` has no refresh and every probe is `unavailable` without it:
      `PRICE_WORKER_SOCKET=/tmp/portfolio-worker.sock` in `.env` (Vite reads it, `:564-571`) and the
      same single line in `.env.worker`; `node --env-file=.env.worker ./server/price-worker.ts` in a
      second terminal — no database URL, no password, nothing the superuser's `.env` (`:56-60`) has;
      the without-a-worker behaviour (spec §3.8): stored prices only, one "no worker listening" line
      per refresh, probes `unavailable` at once, instruments created anyway

**Tests**

- [ ] `tests/provider-socket.test.ts` (new), no database for the transport cases:
      `process.env.PRICE_WORKER_SOCKET` set to a path under `os.tmpdir()` **before the first call of
      `getConfig()`** — imports are hoisted, and the precedent (`tests/price-poller.test.ts:37`, for
      `DATABASE_URL`) works because `getConfig` reads lazily and memoises (`server/config.ts:150-153`),
      not because of import order, so nothing in `provider-socket.server.ts` may call it at module
      level; a real `startWorker` ([04](04-the-price-worker-process.md)) on that path with a fake
      Yahoo client per case, closed in `afterEach`. Cases: `getQuotes` returns the parsed quotes and
      skips a `CurrencyRefused`; `getDailyCloses` sends the `matchKey`'d symbol and `range.from` and
      applies `until`; a `502` saying "No data found" is `no-history`; a `502` with other text
      throws it; no server on the path throws `ProviderUnreachable` naming the path and `ENOENT`,
      and within a second — the assertion that it is a connect failure and not a grace; a path whose
      parent is a regular file throws `ProviderUnreachable` too, naming `ENOTDIR` — the case that
      pins the rule on the syscall and not on a code list (a `0600` socket owned by another uid is
      not runnable in CI, so `EACCES` rides the same branch untested); a fake whose `quote` never
      resolves under `budgetMs: 200` throws the budget error, the request's own error being an
      `AbortError` whose `cause` is
      named `TimeoutError`; a `429` throws; a `200` history body over 2 MiB throws, and a quotes
      body over 512 KB; a symbol with a slash is dropped and logged and the request carries the
      rest; 101 symbols are two requests
- [ ] The probe: `socketProbe` answers `ok`, `non-usd` with the currency, `unavailable` for an
      absent symbol, and `unavailable` for all with no server listening — three symbols, one
      request; 101 symbols, two
- [ ] The route, `tests/routes/refresh.test.ts` (new; none exists today) through
      `tests/support/routes.ts`, keeps to what the route owns — the `done`/`busy`/`error` rules are
      [01](01-one-refresh-and-the-batch-abort.md)'s tests: the projection of a `done` report to
      `RefreshOutcome`, and the JavaScript-off branch redirecting (`refresh.ts:45-47`), with
      `request.headers.set("Sec-Fetch-Mode", "navigate")` on the request `post()` returns, as
      `withCookie` does (`tests/support/routes.ts:31-34`) — `post()` takes no headers
- [ ] The round trip, in the same file, **inside `withDatabase`** — no committing handle, because
      the transport is not the database (`tests/price-backfill.test.ts:1080-1084` is the shape):
      `refreshPrices(socketProvider(), …)` against the real server and a fake client answering a
      quote entry with a `Date` `regularMarketTime` and a chart with `Date` bars and one split — a
      `quote` row, a `price_daily` row and a backfilled close land with the exact figures, and the
      JSON round trip needs no schema change. The `price_poll` row it writes rolls back with the
      transaction; nothing to delete

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build`, `scripts/smoke-test.sh` green
