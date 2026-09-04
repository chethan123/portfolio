# 03 — The price-worker process

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.5)._

**What to build:** Three `server/` modules and the image change that lets the published image run
them. `server/yahoo-client.ts` is the one place `yahoo-finance2` is imported from now on —
constructed with `versionCheck: false`, result validation off, every call under an `AbortSignal` —
and the app's adapter uses it from this ticket, so the import site moves once and is never
doubled. `server/symbol-pattern.ts` holds the symbol pattern as a regex. `server/price-worker.ts`
is the process: a claimer every 250 ms feeding two lanes, quotes and history, that answer rows with
the library's raw JSON. The app's behaviour changes in one way: its own Yahoo calls become bounded
at 30 s.

Its own ticket because everything here is testable from a checkout against real Postgres before
any compose change exists; [04](04-deploy-the-worker-alongside.md) deploys what this proved.

**Blocked by:** [02](02-the-mailbox-and-the-worker-role.md).

**Status:** ready-for-agent

**The client** (`server/yahoo-client.ts`, new)

- [ ] `createYahooClient(): Promise<{ quote(symbols, deadlineAt): Promise<unknown>; chart(symbol,
      request, deadlineAt): Promise<unknown> }>`, memoised as a promise the way `yahooClient` is
      today (`app/lib/price-provider.server.ts:586`, `:617-624`), so the crumb handshake happens
      once per process
- [ ] `new YahooFinance({ versionCheck: false })`: the default is `true` and fetches
      `registry.npmjs.org/yahoo-finance2/latest` from the validation-failure path
      (`esm/src/lib/options/defaults.js:25`, `esm/src/lib/versions.js:6`, 4.0.2). Result validation
      off — one drifted field must not fail a whole `quote()` when the app validates with its own
      schemas. **Builder verifies the option name in the pinned source:** `esm/src/lib/moduleCommon.d.ts`
      declares a per-call `validateResult` for the third argument, and the constructor's
      `validation` object is the other candidate; prove which one silences the library's own check
      with a hand-broken payload before relying on it
- [ ] Every call passes `{ fetchOptions: { signal: AbortSignal.timeout(Math.min(30_000, deadlineAt
      - Date.now())) } }` in the third module-options argument — forwarded to `fetch` unvalidated,
      and covering the crumb handshake. Never in the constructor's `fetchOptions`: that would be one
      signal for the instance's life. An already-expired deadline rejects at once
- [ ] `chart(symbol, { period1, interval: "1d", events: "split" }, deadlineAt)`; `ChartRequest`
      (`:589-598`) moves here and the app imports the type
- [ ] Imports `yahoo-finance2` and nothing from `app/lib` — `matchKey` would pull Kysely into the
      worker's closure; upper-casing stays app-side
- [ ] `app/lib/price-provider.server.ts` deletes its `import("yahoo-finance2")` (`:619`),
      `yahooClient` and the `QuoteClient`/`YahooClient` types (`:601-604`), and takes the client from
      this module with `new Date(Date.now() + 30_000)` as the deadline — the bound issue #205 asks
      for, now covering `chart`. ARCHITECTURE.md §4.2's import-site row (`:338`) is re-pointed at
      `server/yahoo-client.ts` here, not four pull requests later
- [ ] `tests/price-provider.test.ts`'s client-facing describes move to `tests/yahoo-client.test.ts`:
      the probe's client half (`:291`), the chart request shape (`:704`), the library's shape
      (`:788-818`, the one test that imports the package for real at `:812`); the Zod and arithmetic
      cases stay. One new case: a `fetch` injected through the constructor option that never
      resolves is rejected at the deadline with an `AbortError`

**The pattern** (`server/symbol-pattern.ts`, new)

- [ ] `SYMBOL_PATTERN = /^[A-Za-z0-9.^=-]{1,15}$/` and `isWellFormedSymbol(symbol)`; no imports. A
      comment names the migration's `symbols_wellformed` as the same pattern kept in step by hand

**The process** (`server/price-worker.ts`, new)

- [ ] Config through `loadConfig(process.env)`; only `DATABASE_URL` is needed. Pool through
      `createPool(url, { max: 3 })` — the options argument is new on the single construction site
      (`server/db.ts:45`) and is the edit issue #208 also needs; `CONNECTION LIMIT 5` stays above it
- [ ] Startup: `select 1 from provider_call limit 0`, retried with backoff forever, one log line per
      failure. A `28P01`, a "not permitted to log in" and an unreachable host are all retryable:
      under `restart: unless-stopped` the worker can come up before the app has provisioned it, and
      a fatal auth failure would crash-loop looking like a wrong password. No ledger check, no
      migration
- [ ] The claimer, every 250 ms, is spec §3.5's `update … set claimed_at = now() where id in (select
      … order by requested_at limit 50) returning …`; it runs whether or not calls are in flight, and
      after every successful poll — empty ones included — touches `/tmp/price-worker-heartbeat`
- [ ] Two lanes, quotes and history, each a serial queue; a claimed row goes to its lane by `kind`.
      Before a call: `deadline_at` in the past answers `failed` with `error = "expired"` and no call;
      a symbol failing `isWellFormedSymbol` answers `failed` with no call. The row's `deadline_at` is
      the deadline the client gets
- [ ] The answer is one `update provider_call set answered_at = now(), outcome = $2, payload = $3,
      error = $4 where id = $1 and answered_at is null` — `payload` the library's raw return value
      through `JSON.stringify`, `error` the throw's message cut to 1000 characters. Zero rows updated
      is not an error: someone answered first
- [ ] `export const statements` — `probe`, `claim`, `answer(...)` — as `{ text, values }`; the role
      test of [02](02-the-mailbox-and-the-worker-role.md) now runs exactly these through
      `CompiledQuery.raw(text, values)` and deletes the literals it carried
- [ ] `export async function workRow(row, yahoo)` produces one row's answer without touching the
      database; `export async function drainOnce(client, yahoo)` claims one round and works it; the
      loop sits behind `if (import.meta.main)` — Node ≥ 24.2, `true` for the entry file and `false`
      when imported — so vitest imports the module without starting anything
- [ ] Logs: one line per failed drain, stem `Price worker`, naming the row ids and the cause; a
      startup line naming the database host and nothing secret; nothing per successful poll
- [ ] The worker reads no setting, no clock but its own, and no table but `provider_call`

**The image**

- [ ] `Dockerfile:104-110` gains `server/yahoo-client.ts`, `server/symbol-pattern.ts` and
      `server/price-worker.ts`. Manual check here, asserted by smoke in
      [04](04-deploy-the-worker-alongside.md): the image builds, and `node -e 'await
      import("/app/server/price-worker.ts")'` inside it imports without starting the loop. The
      kept-package list (`scripts/smoke-test.sh:249-252`) is unchanged — the prune walks declared
      dependencies and cannot remove `yahoo-finance2`

**Tests** (`tests/price-worker.test.ts`, new; a committing handle, precedent at
`tests/price-backfill.test.ts:955-1035`)

- [ ] Why not `withDatabase`: its transaction is invisible to the worker's own connection. Every case
      seeds rows through a committing Kysely handle, runs `drainOnce` with a `pg` client from
      `createPool(TEST_DATABASE_URL)` and a fake Yahoo client, and deletes its rows by id in `finally`
- [ ] Claim order is `requested_at`, the cap is 50, and a row past `deadline_at` is never claimed
- [ ] A claimed row whose deadline passes before its lane reaches it is answered `failed`/`expired`
      and the fake was not called
- [ ] A fake `quote` that never resolves is aborted at the row's deadline and the row answered
      `failed` with the abort's message
- [ ] `workRow` on a hand-built row carrying `BRK/B` — the CHECK keeps such a row out of the table,
      and the worker's check is the one that binds when a superuser app has dropped the CHECK —
      answers `failed` and the fake was not called
- [ ] First write wins: a second answer to an answered row updates zero rows and changes nothing
- [ ] The heartbeat file's mtime moves on an empty poll
- [ ] The role test of [02](02-the-mailbox-and-the-worker-role.md) runs `statements` and passes

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build` green
