# 02 — The price-worker process

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.2)._

**What to build:** `server/price-worker.ts` — the standalone Node process that will become the only
internet-touching code in the stack — and the Dockerfile additions that let the published image
actually run it. The worker reuses the existing modules (`refreshQuotes`, `backfillCloses`,
`yahooPriceProvider`); what is new is the composition: a polled mailbox, leases, and a bounded
provider. It holds **no timer and no market calendar** — the app decides what to fetch and says so
in the request row (spec §2.4).

The value of a standalone process ticket: everything here is testable from the checkout against real
Postgres before any compose change exists, and ticket 03 then only deploys what this ticket proved.

**Blocked by:** 01 (mailbox tables + role).

**Status:** ready-for-agent

**Startup**

- [ ] Config through the existing `loadConfig` — no second config module; `DATABASE_URL` is the
      worker role's URL, `MARKET_TIMEZONE` is read (both halves of a refresh take it), every other
      var defaults
- [ ] Schema-ledger check: every `.sql` the image ships is present in `schema_migrations` (via the
      SELECT-only `pendingMigrations`, `server/migrations.ts:65-75`); waits, does not migrate — the
      role cannot, by design
- [ ] The worker pool's `max` is pinned explicitly (`server/db.ts:45` pins none; the `pg` default of
      10 would collide with `connection limit 10` alongside the lock client and the healthcheck's
      own session). Budget the per-instrument transactions `backfillCloses` opens
      (`prices.server.ts:573`, `:592`, `:610`).

**One small change to `prices.server.ts`**

- [ ] `backfillCloses` takes its candidate list as a parameter instead of calling
      `selectBackfillCandidates` itself (`prices.server.ts:554`). `selectBackfillCandidates`
      (`:295-345`) stays exactly where it is, app-side, because it joins `holding` and
      `position_set`. Nothing else moves: the price-writing rules and their tests stay where
      ARCHITECTURE.md §4.2 says they live.
- [ ] Existing `backfillCloses` tests keep passing with the candidates injected — if they need
      rewriting rather than re-wiring, the seam is in the wrong place

**The drain loop**

- [ ] Polls all three tables every 1–2 seconds off the pool — no LISTEN/NOTIFY (no reconnect
      machinery, no lost-notification fallback; two mechanisms fewer)
- [ ] A run claims every `pending` refresh row (`status='running'`, `claimed_at=now()`), reads the
      claimed requests' `backfill_candidate` rows, runs quotes when the row says `quotes` and the
      batch over those candidates, and writes the same report to every claimed row — N pending
      requests are one Yahoo fetch, never N
- [ ] One run at a time; `withRefreshLock` (`prices.server.ts:120-150`) stays as the cross-process
      belt. A lock refusal reverts claimed rows to `pending`
- [ ] `running` rows whose lease has expired are claimable again, so a crash between claim and report
      strands nothing
- [ ] Report and verdict writes are guarded on the claim (`where status = 'running'` /
      `status is null`) — first write wins; an overlapping worker cannot overwrite a landed verdict
- [ ] Probe fulfilment: validate the symbol against the pattern (offenders become `unavailable`
      without fetching), probe, write the verdict columns; independent of the refresh lock

**The bounded provider**

- [ ] Every provider call runs under a deadline (~30s watchdog) — **both** methods, since
      `getDailyCloses` is a separate per-symbol call (`price-provider.server.ts:157-161`, `:756-760`).
      `yahooClient` has no abort of its own (`:617-624`), and a stalled call would otherwise hold the
      run and the advisory lock forever while the DB-only healthcheck stayed green.
- [ ] Expiry counts as `providerFailed` for the quotes half and as the batch's own failure for the
      backfill half — `refreshPrices` already keeps a batch failure from falsifying the quotes
      (`prices.server.ts:686-702`), and the mailbox columns must preserve that distinction
- [ ] The Yahoo client is constructed with `versionCheck: false` — `price-provider.server.ts:620`
      passes no options at all today, and 4.0.2 defaults it true, then fetches
      `registry.npmjs.org/yahoo-finance2/latest` on validation failures; a test pins the option so
      "an honest worker contacts only Yahoo" stays true
- [ ] Symbols from `instrument.symbol` are checked by a validating wrapper around the two-method
      `PriceProvider` (`refreshQuotes` and `backfillCloses` are untouched); excluded symbols are not
      fetched and surface as `stale` in the quotes report or an unwritten candidate in the batch

**The image**

- [ ] The Dockerfile's runtime stage copies `server/price-worker.ts` and every module of its closure:
      `app/lib/prices.server.ts`, `price-provider.server.ts`, `db.server.ts`, `market-hours.ts`,
      `money.ts` (`server/config.ts`, `server/db.ts` and `server/migrations.ts` already ship).
      `money.ts` is the easy one to miss.
- [ ] The layout preserves `/app/app/lib/` and `/app/server/` as siblings — `db.server.ts:16-18`
      reaches `../../server/*.ts`
- [ ] The worker entrypoint lives under `server/`, not `scripts/` — `.dockerignore:13` excludes
      `scripts/` from the build context, so a `COPY` would fail
- [ ] The image builds; running the worker entrypoint in the built image reaches the polling loop
      (asserted properly by smoke in ticket 03 — here a manual check suffices)

**Tests** (real Postgres, `withDatabase`, fake provider through the `PriceProvider` seam)

- [ ] N pending refresh rows are satisfied by one report
- [ ] A request's `backfill_candidate` rows drive the batch — exactly those instruments are fetched,
      and their `price_backfill` ledger rows are written
- [ ] A request with `quotes = false` runs the batch and no quote fetch, and writes no `price_poll`
      row (`prices.server.ts:663-664`)
- [ ] An expired-lease `running` row is reclaimed and completed
- [ ] A landed verdict survives a second write attempt
- [ ] A provider deadline expiry writes `providerFailed`, and a deadline inside the batch writes
      `backfill_batch_failed` without falsifying the quotes counts
- [ ] A pattern-violating symbol is answered `unavailable` with no provider call

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build` green
