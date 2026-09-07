# 02 — Scheduler and fetch status on `/healthz`

_Part of [0021-price-health.md](../0021-price-health.md)._

**What to build:** Deepen `app/lib/price-poller.server.ts`'s existing process-wide slot into the one
readable scheduler snapshot, then extend `/healthz`'s `pricing` object with scheduler and latest quote
states. This answers whether scheduled pricing is moving without a database heartbeat, a provider
probe, or a second copy of poller rules.

Separate because worker reachability is a transport fact and this is scheduler state. It depends on
ticket 01's public object and adds fields without changing its non-gating rule.

**Blocked by:** [01](01-worker-reachability.md).

**Status:** ready-for-agent

**One state owner**

- [ ] Extend the existing `globalThis` poller slot; do not add a second global, singleton table,
      timer, or query of `price_poll`
- [ ] Store the armed time, next scheduled due time, running-since time, last completed tick time,
      and the last tick's quote result; expose them only through a typed read function
- [ ] `startPricePoller` records the armed/next-due state without running a refresh
- [ ] `retime` resets the next-due instant with the interval phase it actually arms
- [ ] The scheduled interval callback advances next-due to its next real phase before the running
      guard, including when that firing is dropped; `requestRefresh` does not move the phase
- [ ] Set running state before cadence/provider/database work and clear it in `finally`; a local
      tick dropped because one is already running leaves that state untouched
- [ ] `stopPricePoller` still deletes the slot, so the next read is `not_started`
- [ ] A state-bookkeeping failure cannot reject a page render or turn a completed price transaction
      into failure

**The snapshot**

- [ ] Return only closed categories and `Date` values internally; no timer handles, providers, raw
      errors, symbols, counts, or mutable state escape the module
- [ ] Derive scheduler as `not_started`, `waiting`, `running`, `on_schedule`, or `overdue`
- [ ] `overdue` begins at next-due plus five minutes, whether the market is open or closed
- [ ] Derive quotes as `not_attempted`, `market_closed`, `ok`, `partial`, `failed`, or `unknown`
- [ ] `ok` includes a completed quote attempt with no feed instruments; do not expose an empty-set
      category which reveals household shape
- [ ] `partial` means at least one but fewer than requested instruments were priced
- [ ] `failed` means `providerFailed`, or a positive request count with nothing priced
- [ ] Database/lock error becomes `unknown`; advisory-lock `busy` leaves the previous quote result
      intact because it observed no provider outcome
- [ ] Record `market_closed` when the tick gates quotes off, separately from whether backfill later
      succeeds; an error in backfill alone cannot rewrite it to `unknown`
- [ ] An upload-triggered `requestRefresh` updates the snapshot; direct `POST /refresh` does not,
      because it bypasses the poller
- [ ] Inject `now` into the reader so boundary tests use no fake global clock

**The completed health contract**

- [ ] Add `scheduler` and `quotes` to `pricing`; every key is present on every response
- [ ] Derive aggregate `unknown`, `degraded`, `idle`, or `ok` exactly as spec 0021 defines
- [ ] A healthy database with any pricing state remains HTTP 200 and top-level `status: "ok"`
- [ ] The health loader reads the snapshot but never starts, stops, or retimes the poller
- [ ] Return no timestamps or counts publicly; monitoring consumes categories, detailed diagnosis
      stays in logs and the existing ledgers
- [ ] Do not claim whether a latest fetch failure belongs to the proxy or Yahoo

**Tests that would hurt to omit**

- [ ] Never started; armed but not due; running; exactly due; four minutes late; five minutes late;
      stopped; and retimed state
- [ ] Market-closed tick; zero instruments; complete quotes; partial quotes; provider-wide failure;
      database error; advisory-lock busy; and recovery after failure
- [ ] An upload-requested refresh does not move the scheduled phase
- [ ] A dropped interval cannot replace `running` with idle or a stale result
- [ ] Route exact-body tests cover aggregate `ok`, `idle`, `degraded`, and `unknown`, while HTTP status
      remains owned only by database/migrations

**Documents**

- [ ] `ARCHITECTURE.md` records the poller slot as the status owner and the single-process scope
- [ ] `docs/operating.md` gives alert meanings for worker unavailable, scheduler overdue, partial,
      failed, idle, and unknown without transcribing raw log strings
- [ ] `docs/runbook.md` starts each pricing-status symptom with the JSON categories, then uses Compose
      state and existing log stems to locate the fault
- [ ] Add a dated addendum to `docs/research/2026-09-07-price-fetch-coordination-audit.md` pointing at
      the shipped contract; preserve the original audit as a snapshot rather than rewriting it
