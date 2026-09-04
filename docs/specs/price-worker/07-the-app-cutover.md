# 07 — The app cutover

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.3)._

**What to build:** `app/lib/provider-mailbox.server.ts` — `ask`, `mailboxProvider` and
`mailboxProbe` — and the three callers moved onto it: `runRefresh`'s default provider, the poller's
default provider, and the ingest action's probe. The app's adapter loses its client use, so after
this ticket nothing in the app's module graph reaches `yahoo-finance2`. The worker deployed in
[06](06-deploy-the-worker-alongside.md) starts doing the work; the app stops fetching for itself.

Its own ticket because this is the single release where the fetch moves, and it has to land after
the worker is provably running (or a deploy has no price refresh) and before the network lockdown
(or the app fetches from an isolated network and logs a failure every tick).

**Blocked by:** [01](01-one-refresh-and-the-batch-abort.md), [02](02-the-batched-probe.md),
[03](03-the-two-hardening-rules.md), [06](06-deploy-the-worker-alongside.md).

**Status:** needs-triage — becomes ready-for-agent when §2.5 of the spec is answered

**The module** (`app/lib/provider-mailbox.server.ts`, new)

- [ ] `ask(kind, symbols, rangeFrom, { graceMs = 3_000, budgetMs } = …)` with the production
      constants as defaults, so a test passes 200 ms instead of sleeping through real budgets
      (`tests/price-poller.test.ts:139-149` documents why fake timers are not the answer). No
      handle, no flag: `ProviderUnreachable` is thrown after the grace every time, and the batch
      abort of [01](01-one-refresh-and-the-batch-abort.md) is what keeps a dead worker's cost at one
      grace per kind (spec §3.3 states the cost)
- [ ] Symbols failing `isWellFormedSymbol` (`server/symbol-pattern.ts`, imported the way
      `app/lib/db.server.ts:17` imports `server/db.ts`) are dropped before the insert with one
      `console.warn` naming them, on every refresh — no memo; more than 100 symbols split into
      consecutive asks with the answers concatenated; an empty list after dropping is an empty
      answer and no row
- [ ] The sweep first, one plain statement with no transaction of its own and no `lock_timeout`:
      `delete from provider_call where id in (select id from provider_call where (answered_at is
      not null and answered_at < now() - interval '1 hour') or deadline_at < now() - interval '1
      hour' for update skip locked)` — a row a hostile worker holds `FOR UPDATE` is skipped at once
      and swept once its session ends; no `try`, a failure propagates as `createDraft`'s
      sweep-before-staging does (`app/lib/uploads.server.ts:207-210`, an awaited delete). Then the
      insert, which waits on no row lock, with `deadline_at` computed on the app's clock (`new
      Date(Date.now() + budgetMs)` — a `timestamptz` crosses as a `Date`, `server/db.ts:29-30`),
      `returning id`
- [ ] Poll the row every 100 ms: `claimed_at` still null after the grace → throw
      `ProviderUnreachable("no worker claimed the request within 3 s")`; `answered_at` null at the
      deadline → throw an `Error` saying the worker claimed but did not answer within the budget;
      `outcome = 'failed'` → throw an `Error` carrying the row's `error`; `ok` → the payload.
      Budgets as constants with their reasons: `quotes` 15 s, `history` 30 s (the worker's
      watchdog), `probe` 10 s (a cold worker's first probe pays the claim latency plus a three-fetch
      crumb handshake, and the verdict a short budget loses is `non-usd`, the one a person acts on)
- [ ] `mailboxProvider(): PriceProvider` — `getQuotes`: a payload that is not an array is `[]`; each
      entry through `toProviderQuote`, `CurrencyRefused` logged and skipped exactly as
      `yahooPriceProvider` did (`price-provider.server.ts:719-731`). `getDailyCloses`:
      `ask("history", [matchKey(symbol)], range.from)`; a `failed` row whose text matches
      `isMissingHistory` (`:787-793`, now exported) is `{ status: "no-history" }`; `ok` goes through
      `toProviderHistory(payload, range, marketTimeZone)`
- [ ] `mailboxProbe: ProbeSymbols` — one `ask("quotes", symbols)`, then `probeVerdicts`
      ([02](02-the-batched-probe.md)); any throw is `unavailable` for every symbol; never throws
- [ ] The module header carries the argument: why polling and not `LISTEN/NOTIFY` (no reconnect in
      `pg`, unqueued, needs the poll anyway); why the app sweeps and the worker never deletes; why
      `skip locked` and not a timeout

**The callers**

- [ ] `runRefresh`'s default becomes `mailboxProvider()`, `startPricePoller`'s the same (one
      instance for the process, as today); `app/routes/upload/instruments.tsx:104-106` passes `{
      probe: mailboxProbe }`
- [ ] `app/lib/price-provider.server.ts` loses `yahooPriceProvider` and `probeSymbols` and keeps the
      types, the schemas, `toProviderQuote`, `toProviderHistory`, `probeVerdicts`,
      `CurrencyRefused`, `ProviderUnreachable` and `isMissingHistory`; its header (`:1-12`) says the
      seam has two implementations and only one lives in this process, and keeps the package name in
      comments only. Nothing under `app/` imports `server/yahoo-client.ts` any more — `npm run
      build` is the gate. `inTransaction` is exported from `prices.server.ts` (`:741-746`) and not
      copied: two more private copies exist (`instrument-resolution.server.ts:237`,
      `uploads.server.ts:571`) and are out of scope
- [ ] `scripts/smoke-test.sh` gains the source-level assertion a container check cannot make: `grep`
      over `/app/build/server/` in the image finds no `yahoo-finance2` — comments are stripped by
      the build, a string literal would trip it. The package stays on disk and the guarantee is the
      network; this proves the graph
- [ ] `docs/operating.md:761`'s four causes gain the fifth — the worker is dead, unprovisioned or
      refused a login (a bring-your-own install without `CREATEROLE`): the stem is still `Price
      provider failed`, the text says "no worker claimed", and `docker compose ps` shows `worker`
      unhealthy or restarting. The upgrade note repeats [06](06-deploy-the-worker-alongside.md)'s
      compose-file rule and its symptom. The full record is [10](10-documents-and-runbooks.md)'s
- [ ] The developer's recipe, under Recipes (`docs/developing.md:331`), because from this ticket
      `npm run dev` has no refresh and every probe is `unavailable` without it: `.env.worker` with
      `DATABASE_URL=postgres://portfolio_worker@127.0.0.1:55432/portfolio_dev` and `PGPASSWORD=…`;
      the one-time provisioning run against the superuser's `.env` (`:56-60`) with
      `WORKER_DB_PASSWORD` set; `node --env-file=.env.worker ./server/price-worker.ts` in a second
      terminal; the without-a-worker behaviour (spec §3.9)

**Tests**

- [ ] `tests/provider-mailbox.test.ts` (new), inside `withDatabase`, with `graceMs: 200` and small
      budgets: a helper `answerNext(db, …)` polls the test's transaction for the pending row, sets
      `claimed_at` and answers it, run under `Promise.all` beside the call under test — one
      transaction, so the answer is visible and nothing commits (one connection; it works because
      `ask` yields on a timer between polls). Cases: `getQuotes` returns the parsed quotes and skips
      a `CurrencyRefused`; `getDailyCloses` sends `matchKey`'d symbols and `range.from`; a `failed`
      row saying "No data found" is `no-history`; a `failed` row with other text throws it; an
      unclaimed row throws `ProviderUnreachable` after the grace; a claimed-but-unanswered row
      throws at the deadline; the sweep deletes an old answered row and an old expired one and keeps
      a fresh one — seeded with explicit `deadline_at` values, since `now()` is frozen at
      transaction start — and a committed stale row a second client holds `FOR UPDATE` is skipped,
      at once, and the ask still inserts; a symbol with a slash is dropped and logged and the row
      holds the rest; 101 symbols are two rows
- [ ] The probe: `mailboxProbe` answers `ok`, `non-usd` with the currency, `unavailable` for an
      absent symbol, and `unavailable` for all after `ProviderUnreachable` — three symbols, one row
- [ ] The route, `tests/routes/refresh.test.ts` (new; none exists today) through
      `tests/support/routes.ts`, keeps to what the route owns — the `done`/`busy`/`error` rules are
      [01](01-one-refresh-and-the-batch-abort.md)'s tests: the projection of a `done` report to
      `RefreshOutcome`, and the JavaScript-off branch redirecting (`refresh.ts:45-47`), with
      `request.headers.set("Sec-Fetch-Mode", "navigate")` on the request `post()` returns, as
      `withCookie` does (`tests/support/routes.ts:31-34`) — `post()` takes no headers
- [ ] The round trip in `tests/price-worker.test.ts`, on a committing handle,
      `process.env.DATABASE_URL = TEST_DATABASE_URL` set before any import that reaches
      `getConfig()` (`tests/price-poller.test.ts:37`): `refreshPrices(mailboxProvider(), …)` with a
      real `drainOnce` on its own client and a fake Yahoo client answering a quote entry with a
      `Date` `regularMarketTime` and a chart with `Date` bars and one split — a `quote` row, a
      `price_daily` row and a backfilled close land with the exact figures: the JSON round trip
      through `jsonb` needs no schema change. In `finally`, besides the instrument's cascade, delete
      the `price_poll` rows the run wrote by id (above the `max(id)` read before the call): no
      foreign key reaches them, and `tests/refresh-quotes.test.ts:823-891`,
      `tests/price-backfill.test.ts:1059,1082` and `tests/price-poller.test.ts:264` count that table

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build`, `scripts/smoke-test.sh` green
