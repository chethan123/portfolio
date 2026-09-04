# 05 — The price-worker process

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.5)._

**What to build:** Three `server/` modules and the image change that runs them.
`server/yahoo-client.ts` is the one place `yahoo-finance2` is imported from now on — `versionCheck:
false`, every call with the library's own result validation off and under a fixed 30 s `AbortSignal`
— and the app's adapter uses it from this ticket. `server/symbol-pattern.ts` holds the symbol
pattern, the only copy. `server/price-worker.ts` is the process: a claimer feeding two rate-capped
lanes, quotes and history, that answer rows with the library's raw JSON. The app's behaviour changes
in two ways: its own Yahoo calls become bounded at 30 s, and one drifted entry no longer fails the
whole `quote()` — it fails `safeParse` alone and its symbol goes stale.

Its own ticket because everything here is testable from a checkout against real Postgres before any
compose change exists; [06](06-deploy-the-worker-alongside.md) deploys what this proved.

**Blocked by:** [04](04-the-mailbox-and-the-worker-role.md).

**Status:** ready-for-agent

**The client** (`server/yahoo-client.ts`, new)

- [ ] `createYahooClient({ timeoutMs = 30_000 } = {})` returning `{ quote(symbols), chart(symbol,
      request) }`, both `Promise<unknown>`, memoised as `yahooClient` is today
      (`app/lib/price-provider.server.ts:586`, `:617-624`). `new YahooFinance({ versionCheck: false
      })`: the default is `true` and fetches `registry.npmjs.org/yahoo-finance2/latest` from the
      validation-failure path (`esm/src/lib/options/defaults.js:25`, `esm/src/lib/versions.js:6`,
      4.0.2)
- [ ] Every call passes `{ validateResult: false, fetchOptions: { signal:
      AbortSignal.timeout(timeoutMs) } }` as the third module-options argument. `validateResult:
      false` is the setting: `moduleExec.js:89-91` reads it and `:127-130` skips the throw (research
      note §3.3 has the rest, exercised). The signal is forwarded to `fetch` (`moduleExec.js:82`)
      and reaches the crumb handshake; never in the constructor's `fetchOptions`
- [ ] The 30 s is the client's own and fixed — no call takes a deadline: the crumb handshake is
      memoised single-flight under the *first* caller's `fetchOptions` (`yahooFinanceFetch.js:74`),
      so a shorter signal from one caller could abort a handshake another had joined. `chart(symbol,
      { period1, interval: "1d", events: "split" })`; `ChartRequest` (`:589-598`) moves here and the
      app imports the type. Imports nothing from `app/lib` (`matchKey` would pull Kysely in)
- [ ] `app/lib/price-provider.server.ts` deletes its `import("yahoo-finance2")` (`:619`),
      `yahooClient` and the `QuoteClient`/`YahooClient` types (`:601-604`) and takes the client from
      this module; `probeSymbols` ([02](02-the-batched-probe.md)) — or today's `probeSymbol`
      (`:665-694`) while 02 has not landed — takes it too. ARCHITECTURE.md
      §4.2's import-site row (`:338`) is re-pointed at `server/yahoo-client.ts` here
- [ ] `tests/yahoo-client.test.ts` (new) takes the client's own surface: the library's shape
      (`tests/price-provider.test.ts:788-818`); the request shape — `chart` forwarded with
      `period1`, `interval`, `events` and a signal in the third argument, through an injected
      `fetch` (`yahooFinanceFetch.js:58`); and a `fetch` that never resolves under `timeoutMs: 50`,
      rejected with a `DOMException` named **`TimeoutError`** — not `AbortError`. The adapter's
      cases (`:291`, `:704-786`) stay in `tests/price-provider.test.ts`, the fake narrowed to the
      client's new shape, until [07](07-the-app-cutover.md) deletes them with the adapter

**The pattern** (`server/symbol-pattern.ts`, new)

- [ ] `SYMBOL_PATTERN = /^[A-Za-z0-9.^=-]{1,15}$/` and `isWellFormedSymbol(value: unknown): value is
      string` — a string check before the pattern (`RegExp.test(null)` matches `"null"`). No
      imports; the only copy (spec §3.2)

**The process** (`server/price-worker.ts`, new)

- [ ] Config through `loadConfig(process.env)`; only `DATABASE_URL` is needed. Pool through
      `createPool(url, { max: 3 })` — the options argument is new on the single construction site
      (`server/db.ts:45`), **optional** because `tests/support/database.ts:37`,
      `tests/price-poller.test.ts:105` and `tests/pool-resilience.test.ts:15-16` call it with one
      argument (issue #208 needs the same edit)
- [ ] Startup: `select 1 from provider_call limit 0`, retried forever with a backoff from 250 ms to
      a 5 s cap, one log line on the transition into failure and one on recovery — never per
      attempt. A `28P01`, "not permitted to log in" and an unreachable host are all retryable — the
      worker can come up before the app has provisioned it; no ledger check, no migration.; the same
      backoff governs a claimer whose database has gone
- [ ] The claimer is spec §3.5's `update … set claimed_at = now() where claimed_at is null and
      answered_at is null and deadline_at > now() and id in (select … order by requested_at limit
      50) returning …` — the guard in the outer `where` as well as the subquery, because read
      committed re-checks only the outer `WHERE` on a row it re-fetches, and two claimers running
      the subquery-only form both took the same rows (exercised) — every 250 ms when idle and again
      at once after a round that claimed something; after every successful poll — empty ones
      included, failed ones never — touches the heartbeat file, whose path is a parameter of the
      loop and of `drainOnce` (default `/tmp/price-worker-heartbeat`, the compose path)
- [ ] Two lanes, quotes and history, each a serial queue, a row routed by `kind`. Before a call, in
      order: `deadline_at` in the past answers `failed` / `expired` with no call; an element failing
      `isWellFormedSymbol` answers `failed` with no call; the lane's cap — ten quotes calls a
      minute, twenty history — exceeded answers `failed` / `rate limited` with no call and one log
      line. The row's `deadline_at` is never handed to the client
- [ ] The answer is one `update provider_call set answered_at = now(), outcome = $2, payload = $3,
      error = $4 where id = $1 and answered_at is null` — `payload` the library's raw return value
      through `JSON.stringify`, passed as that string (the round trip in [07](07-the-app-cutover.md)
      is the pin); `error` the throw's message with its `cause` appended — `${message}:
      ${cause?.code ?? cause?.message}` — cut to 1000 characters (undici says `fetch failed` for
      every network failure; the detail is in `cause`).; zero rows updated means someone answered
      first
- [ ] `export const statements` — `probe`, `claim`, `answer(...)` — as `{ text, values }`, which
      [04](04-the-mailbox-and-the-worker-role.md)'s role test now runs through `CompiledQuery.raw`.
      `export async function workRow(row, yahoo)` produces one row's answer without touching the
      database; `export async function drainOnce(client, yahoo, { heartbeatPath })` claims one
      round, works it and awaits the work; the loop sits behind `if (import.meta.main)` (Node ≥
      24.2; `undefined` under vitest; research note §5.3)
- [ ] Logs: one line per failed drain, stem `Price worker`, naming the row ids and the cause; a
      startup line naming the host; nothing per successful poll.

**The image**

- [ ] `Dockerfile:104-110` gains `server/yahoo-client.ts`, `server/symbol-pattern.ts` and
      `server/price-worker.ts`. Checked by hand here and by smoke in
      [06](06-deploy-the-worker-alongside.md): the image builds, and `node -e 'await
      import("/app/server/price-worker.ts")'` inside it imports without starting the loop.

**Tests** (`tests/price-worker.test.ts`, new; a committing handle, precedent at
`tests/price-backfill.test.ts:955-1035`)

- [ ] `withDatabase`'s transaction is invisible to the worker's own connection, so every case seeds
      rows through a committing Kysely handle, runs `drainOnce` with a `pg` client from
      `createPool(TEST_DATABASE_URL)`, a fake Yahoo client and a heartbeat path under the scratch
      directory, and deletes its rows by id in `finally`
- [ ] A row past `deadline_at` is never claimed; a claimed row whose deadline passes before its lane
      reaches it is answered `failed` / `expired` and the fake was not called; a client built with
      `timeoutMs: 50` over a `fetch` that never resolves gets the row answered `failed` with the
      `TimeoutError` text
- [ ] `workRow` on a hand-built row carrying `BRK/B`, and one carrying a null element, answers
      `failed` and the fake was not called. Eleven quotes rows in one minute: ten calls, the
      eleventh answered `failed` / `rate limited`
- [ ] First write wins: a second answer to an answered row updates zero rows and changes nothing;
      the heartbeat file's mtime moves on an empty poll and not on a failed one; the role test of
      [04](04-the-mailbox-and-the-worker-role.md) runs `statements` and passes

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build` green
