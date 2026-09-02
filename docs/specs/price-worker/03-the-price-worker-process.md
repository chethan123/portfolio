# 03 — The price-worker process

_Part of [0015-price-worker.md](../0015-price-worker.md) (§3.2)._

**What to build:** `server/price-worker.ts` — the standalone Node process that will become the
only internet-touching code in the stack — and the Dockerfile additions that let the published
image actually run it. The worker reuses the existing modules (`refreshQuotes`,
`yahooPriceProvider`, the poller's cadence logic); what is new is the composition: one
serialised executor, a polled mailbox, leases, and a bounded provider.

The value of a standalone process ticket: everything here is testable from the checkout against
real Postgres before any compose change exists, and ticket 04 then only deploys what this
ticket proved.

**Blocked by:** 01 (plain-Node closure), 02 (mailbox tables + role).

**Status:** ready-for-agent

**Startup**

- [ ] Config through the existing `loadConfig` — no second config module; `DATABASE_URL` is the
      worker role's URL, every other var defaults
- [ ] Schema-ledger check: every `.sql` the image ships is present in `schema_migrations`
      (via the SELECT-only `pendingMigrations`, `server/migrations.ts:65-75`); waits, does not
      migrate — the role cannot, by design
- [ ] The worker pool's `max` is pinned explicitly (`server/db.ts` pins none; the `pg` default
      of 10 would collide with `connection limit 10` alongside the lock client and healthcheck)

**The executor**

- [ ] One serialised executor is the process's only `withRefreshLock` taker; cadence ticks
      (market-hours gate + cadence re-read reused from `price-poller.server.ts`) *submit* runs
      to it rather than fetching on their own timer
- [ ] A run claims every `pending` refresh row (`status='running'`, `claimed_at=now()`),
      executes `refreshQuotes` once, and writes the same report to every claimed row — N
      pending requests are one Yahoo fetch, never N
- [ ] A lock refusal (second replica, operator-run worker) reverts claimed rows to `pending`
- [ ] `running` rows whose lease has expired are claimable again, so a crash between claim and
      report strands nothing
- [ ] Report and verdict writes are guarded on the claim (`where status = 'running'` /
      `status is null`) — first write wins; an overlapping worker cannot overwrite a landed
      verdict

**The mailbox drain**

- [ ] Polls both tables every 1–2 seconds off the pool — no LISTEN/NOTIFY (no reconnect
      machinery, no lost-notification fallback; two mechanisms fewer)
- [ ] Probe fulfilment: validate the symbol against the pattern (offenders become
      `unavailable` without fetching), probe, write the verdict columns; independent of the
      refresh lock

**The bounded provider**

- [ ] Every provider call runs under a deadline (~30s watchdog): `yahooClient` has no abort of
      its own, and a stalled call would otherwise hold the executor and advisory lock forever
      while the DB-only healthcheck stayed green; expiry counts as `providerFailed`
- [ ] The Yahoo client is constructed with `versionCheck: false` — 4.0.2 defaults it true and
      fetches `registry.npmjs.org/yahoo-finance2/latest` on validation failures; a test pins
      the option so "an honest worker contacts only Yahoo" stays true
- [ ] Symbols from `instrument.symbol` are checked by a validating wrapper around the
      `PriceProvider` (`refreshQuotes` itself is untouched); excluded symbols are not fetched
      and surface as `stale` in the report

**The image**

- [ ] The Dockerfile's runtime stage copies `server/price-worker.ts` and every module of its
      `app/lib` closure — `input.server.ts`, `money.ts`, and `masking-policy.ts` are the easy
      ones to miss; ticket 01's PR description carries the authoritative list
- [ ] The image builds; running the worker entrypoint in the built image reaches the polling
      loop (asserted properly by smoke in ticket 04 — here a manual check suffices)

**Tests** (real Postgres, `withDatabase`, fake provider through the `PriceProvider` seam)

- [ ] N pending refresh rows are satisfied by one report
- [ ] An expired-lease `running` row is reclaimed and completed
- [ ] A landed verdict survives a second write attempt
- [ ] A provider deadline expiry writes `providerFailed` and frees the executor
- [ ] A pattern-violating symbol is answered `unavailable` with no provider call

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build` green
