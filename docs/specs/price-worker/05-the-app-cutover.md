# 05 — The app cutover

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.3)._

**What to build:** `app/lib/provider-mailbox.server.ts` — the handle, `ask`, `mailboxProvider` and
`mailboxProbe` — and the three callers moved onto it: `runRefresh`'s default factory, the poller's
default factory, and the ingest action's probe. The app's adapter loses its client use, so after
this ticket nothing in the app's module graph reaches `yahoo-finance2`. The worker deployed in
[04](04-deploy-the-worker-alongside.md) starts doing the work; the app stops fetching for itself.

Its own ticket because this is the single release where the fetch moves, and it has to land after
the worker is provably running (or a deploy has no price refresh) and before the network lockdown
(or the app fetches from an isolated network and logs a failure every tick).

**Blocked by:** [01](01-prefactor-the-refresh-and-probe-seams.md),
[04](04-deploy-the-worker-alongside.md).

**Status:** ready-for-agent

**The module** (`app/lib/provider-mailbox.server.ts`, new)

- [ ] `mailboxHandle()` returns `{ unreachable: false }`; `ask(handle, kind, symbols, rangeFrom)`
      throws `ProviderUnreachable` at once when the flag is set
- [ ] Symbols failing `SYMBOL_PATTERN` (`server/symbol-pattern.ts`, imported the way
      `app/lib/db.server.ts:17` imports `server/db.ts`) are dropped before the insert with one
      `console.warn` naming them; more than 100 symbols split into consecutive asks with the answers
      concatenated; an empty list after dropping is an empty answer and no row
- [ ] Sweep and insert in one transaction — `inTransaction` exported from `prices.server.ts`
      (`:741-746`) rather than copied — with `set local lock_timeout = '2s'` first: `delete from
      provider_call where (answered_at is not null and answered_at < now() - interval '1 hour') or
      deadline_at < now() - interval '1 hour'`; then the insert with `deadline_at` computed on the
      app's clock (`new Date(Date.now() + budget)` — a `timestamptz` crosses as a `Date`,
      `server/db.ts:29-30`), `returning id`
- [ ] Poll the row every 100 ms: `claimed_at` still null 3 s after the insert → set the flag and
      throw `ProviderUnreachable("no worker claimed the request within 3 s")`; `answered_at` null at
      the deadline → throw an `Error` saying the worker claimed but did not answer within the
      budget; `outcome = 'failed'` → throw an `Error` carrying the row's `error`; `ok` → the payload
- [ ] Budgets as constants with their reasons: `quotes` 15 s, `history` 30 s (the worker's
      watchdog), `probe` 5 s
- [ ] `mailboxProvider(handle): PriceProvider` — `getQuotes`: a payload that is not an array is
      `[]`; each entry through `toProviderQuote`, `CurrencyRefused` logged and skipped exactly as
      `yahooPriceProvider` did (`price-provider.server.ts:719-731`). `getDailyCloses`:
      `ask("history", [matchKey(symbol)], range.from)`; a `failed` row whose text matches
      `isMissingHistory` (`:787-793`, now exported) is `{ status: "no-history" }`; `ok` goes through
      `toProviderHistory(payload, range, marketTimeZone)`
- [ ] `mailboxProbe(handle): ProbeSymbols` — one `ask("quotes", symbols)`, then `probeVerdicts`
      ([01](01-prefactor-the-refresh-and-probe-seams.md)); any throw is `unavailable` for every
      symbol; never throws
- [ ] The module header carries the argument: why polling and not `LISTEN/NOTIFY` (no reconnect in
      `pg`, unqueued, needs the poll anyway); why the app sweeps and the worker never deletes; why a
      handle is per operation

**The callers**

- [ ] `runRefresh`'s default factory becomes `() => mailboxProvider(mailboxHandle())`, the poller's
      the same; `app/routes/upload/instruments.tsx:104-106` passes `{ probe:
      mailboxProbe(mailboxHandle()) }` — one handle per request
- [ ] `app/lib/price-provider.server.ts` loses `yahooPriceProvider` and `probeSymbols` and keeps the
      types, the schemas, `toProviderQuote`, `toProviderHistory`, `probeVerdicts`,
      `CurrencyRefused`, `ProviderUnreachable` and `isMissingHistory`; its header (`:1-12`) says the
      seam has two implementations and only one lives in this process. Nothing under `app/` imports
      `server/yahoo-client.ts` any more
- [ ] `scripts/smoke-test.sh` gains the source-level assertion a container check cannot make: `grep`
      over `/app/build/server/` in the image finds no `yahoo-finance2`. The package stays on disk
      and the guarantee is the network; this proves the graph
- [ ] `docs/operating.md:761`'s four causes gain the fifth — the worker is dead or unprovisioned: the
      stem is still `Price provider failed`, the text says "no worker claimed", and `docker compose
      ps` shows `worker` unhealthy or restarting. The full record is
      [08](08-documents-and-runbooks.md)'s

**Tests**

- [ ] `tests/provider-mailbox.test.ts` (new), inside `withDatabase`: a helper `answerNext(db, …)`
      that polls the test's transaction for the pending row, sets `claimed_at` and answers it, run
      under `Promise.all` beside the call under test — both on the same transaction, so the answer
      is visible and nothing commits. Cases: `getQuotes` returns the parsed quotes and skips a
      `CurrencyRefused`; `getDailyCloses` sends `matchKey`'d symbols and `range.from`; a `failed` row
      saying "No data found" is `no-history`; a `failed` row with other text throws it; an unclaimed
      row throws `ProviderUnreachable` after the grace and the handle's next call throws with no row
      inserted; a claimed-but-unanswered row throws at the deadline; the sweep deletes an old
      answered row and an old expired one and keeps a fresh one — seeded with explicit `deadline_at`
      values, since `now()` is frozen at transaction start; a symbol with a slash is dropped and
      logged and the row holds the rest; 101 symbols are two rows
- [ ] The probe: `mailboxProbe` answers `ok`, `non-usd` with the currency, `unavailable` for an
      absent symbol, and `unavailable` for all after `ProviderUnreachable` — three symbols, one row
- [ ] The route, `tests/routes/refresh.test.ts` (new; none exists today) through
      `tests/support/routes.ts`: `done` with the counts through a fake factory, `busy` with the lock
      held, `error` when the factory throws, and the JavaScript-off branch redirecting
      (`refresh.ts:45-47`)
- [ ] The round trip in `tests/price-worker.test.ts`, on a committing handle:
      `refreshPrices(mailboxProvider(handle), …)` with a real `drainOnce` on its own client and a
      fake Yahoo client answering a quote entry with a `Date` `regularMarketTime` and a chart with
      `Date` bars and one split — a `quote` row, a `price_daily` row and a backfilled close land with
      the exact figures, proving the JSON round trip through `jsonb` needs no schema change
- [ ] `tests/price-poller.test.ts` and `tests/refresh-quotes.test.ts` still inject fakes and never
      touch the mailbox

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build`, `scripts/smoke-test.sh` green
