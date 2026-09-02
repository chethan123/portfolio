# 03 — The backfill step in every refresh

_Part of [0017-price-backfill.md](../0017-price-backfill.md)._

**What to build:** The batch itself, in `app/lib/prices.server.ts`: candidates in, a sequential
fetch per instrument through the provider's history method, an insert of every returned trading
day the spine does not already hold, and a ledger row per attempt. Then the composition every
caller shares — quotes, then one batch — and the three callers moved onto it: the poller's tick,
which outside market hours now skips the quotes and still runs the batch; **Refresh now**, whose
behaviour for the person pressing it does not change; and a new request fired once an upload's
transaction has committed, which the response does not wait for. One log line per batch that
attempted anything.

Its own ticket because it is the one place the two pieces built beside each other meet, and
because the rules it carries — never overwrite, one transaction per attempt, no `price_poll` row
for a tick that fetched no quotes — are rules about rows and are proved against Postgres.

**Blocked by:** [01](01-the-provider-history-method.md), [02](02-the-ledger-and-the-gap-query.md).

**Status:** ready-for-agent

**The batch** (`backfillCloses(provider, marketTimeZone, db)`, exported from `prices.server.ts`)

- [ ] Reads the candidates through ticket 02's `selectBackfillCandidates`; the range's end is
      `marketDateOf(new Date(), marketTimeZone)`, exclusive, so the last day written is the
      previous trading day and today's row stays the poller's provisional one
- [ ] Fetches sequentially, one instrument at a time, awaiting each call before the next. Nothing is
      issued in parallel and nothing is queued: the library's per-instance queue is not relied on
      and the batch bound is the whole of the pacing
- [ ] Each attempt's `started_at` is taken before its fetch, `refreshQuotes`'s reasoning (`:205-207`)
- [ ] A history answered `ok` is written inside one transaction with its ledger row, through
      `inTransaction` (`:182`); the other four statuses write the ledger row alone, in their own
      transaction, with `written = 0`
- [ ] A provider throw for one instrument is caught, ledgered as `provider_failed` with the error's
      message as `error`, and the batch continues to the next instrument — the batch is bounded and
      the next symbol may be fine
- [ ] A database failure is not caught: it propagates to the caller, whose catch already logs it,
      and the attempt it interrupted leaves no ledger row and is simply next time's candidate. The
      instrument being written is what would fail again
- [ ] Returns a `BackfillReport`: instruments attempted, closes written across the batch, and a
      count per outcome — the log line and the tests read it

**The write** (`writeBackfilledCloses`, private, beside `writeDailyClose` at `:372`)

- [ ] One `insert into price_daily` for the whole series, `on conflict (instrument_id, date) do
      nothing`, `returning` a column so the number of rows actually new is counted where it is
      known — `writeObservations` (`:460-475`) is the pattern and the reasoning. A separate
      statement from `writeDailyClose`, which must go on upserting for the poller
- [ ] The stored close is `round(close × splitNumerator ÷ splitDenominator, 4)` computed in SQL from
      the strings the provider handed over, cast to `numeric` in the statement. The column's own
      scale would round on assignment anyway; the explicit `round` says the rule where the arithmetic
      is. Nothing multiplies a close in JavaScript
- [ ] Nothing is written for a day the provider did not return — no row is fabricated for a weekend
      or a holiday, and no carry-forward is materialised
- [ ] The docstring states the invariant in `docs/importing-history.md:283`'s words: a backfill never
      overwrites what the running system recorded live

**The ledger row** (`writeBackfillAttempt`, private, beside `writePoll` at `:486`)

- [ ] Writes `instrument_id`, `started_at`, `range_from`, `range_until`, `written`, `outcome`,
      `error`, with the outcome from ticket 02's vocabulary
- [ ] Its docstring names the one difference from `writePoll`: a provider failure here *is* a
      committed row, because the attempt happened and the next reader needs the text; only a
      database failure leaves nothing

**The composition** (`refreshPrices(provider, marketTimeZone, { quotes }, db)`, exported)

- [ ] Runs `refreshQuotes` when `quotes` is true, then `backfillCloses` always, and returns both
      reports — the quotes' as `null` when they were skipped
- [ ] Does not take the lock itself: every caller wraps it in `withRefreshLock` (`:72`) exactly as
      they wrap `refreshQuotes` today, so the test seam stays a transaction and the lock stays the
      caller's decision
- [ ] A backfill-only call writes no `price_poll` row, by construction: the poll row is
      `refreshQuotes`'s (`:295`), and a poll is an attempt at quotes
- [ ] The module header (`:1-43`) names the sixth table a refresh may write and the rule that the
      backfill's insert never rewrites a row, beside the header's existing account of which past
      rows a refresh *can* rewrite and why

**The poller** (`app/lib/price-poller.server.ts`)

- [ ] `isMarketOpen` (`:95`) stops deciding whether the tick returns and starts deciding whether
      quotes are fetched: the tick sets `running`, reads the cadence only when the market is open —
      the existing reasoning at `:91-94` and `:99-101` still holds for the read — and calls
      `withRefreshLock(() => refreshPrices(provider, zone, { quotes: open }, getDb()))`
- [ ] The module header's promise that a weekend stays free of database traffic (`:8-12`) is now
      false and is rewritten: a weekend tick costs the gap query, and a fetch only when there is a
      gap
- [ ] The quotes' log line (`:118-120`) is unchanged and written only when quotes were fetched. A
      second line, stem `Price backfill`, is written when the batch attempted anything: instruments
      attempted, closes written, failures — a warning when any attempt failed, informational
      otherwise. A batch that found no candidates writes nothing, so "no price line in the log"
      keeps the meaning `docs/operating.md` gives it
- [ ] `requestRefresh(): void` is exported: run one refresh now with quotes regardless of market
      hours, through the same `running` flag, the same lock and the same log lines as a tick, never
      throwing — a request landing while a tick or another request is running is dropped, not
      queued, the rule an overlapping tick obeys. When the poller has not been started in this
      process it does nothing beyond a log line: in production `app/root.tsx:67` has started it
      before any page could post, and in a test that never started it no provider is ever reached
- [ ] `stopPricePoller` still leaves nothing running: a request in flight when the poller stops
      holds a state object the slot has forgotten, and `retime`'s identity check (`:71`) is what
      keeps it from arming anything

**The button** (`app/routes/refresh.ts:57-79`)

- [ ] `run` calls `refreshPrices(..., { quotes: true }, ...)` under the lock in place of
      `refreshQuotes`, and renders the quotes' report as it does today. `RefreshOutcome` (`:20-32`)
      does not change: what the press promises the person is prices, and the batch is a side effect
      they will see on the chart
- [ ] The component (`app/components/price-freshness.tsx`) is untouched

**The commit trigger** (`app/routes/upload/review.tsx:67-76`)

- [ ] After `commitUpload` returns — its `inTransaction` has committed by then (`uploads.server.ts:901`
      and the transaction it returns from) — and before the redirect is thrown, the action calls
      `requestRefresh()` and does not await it. The person is on the account page while the batch
      runs, and the next render prices what it can
- [ ] Not inside `commitUpload`: a domain function called from a test transaction has committed
      nothing, and a refresh fired from there would need a provider the tests cannot inject. The
      request goes through the poller module for exactly that reason
- [ ] The action's own error handling is unchanged; a request that could not be made is the poller
      module's log line, never a refused upload

**Tests**

- [ ] `tests/price-backfill.test.ts` (ticket 02's file), through `withDatabase` with a fake provider
      whose `getDailyCloses` answers what each test states and records what it was asked:
  - [ ] A candidate with no spine gets every trading day the fake returned, at the un-adjusted
        figure — a fake answering a pre-split close of `"120.0000"` with factor `10/1` stores
        `"1200.0000"`
  - [ ] A close the poller already wrote is byte-identical after a batch that offered a different
        figure for that day, and the ledger's `written` counts only the new rows
  - [ ] A hole inside an existing series is filled; a day the fake did not return gets no row
  - [ ] Each provider status becomes its ledger outcome, with `written = 0` and, for a throw, the
        message in `error`; the batch continues past a throw to the next candidate
  - [ ] The fake was asked one symbol per call, in ticket 02's order, with `range.from` seven days
        before the first-held date and `range.until` today's market date under an injected clock
  - [ ] After a batch, the instruments it attempted are not candidates for the next one
  - [ ] `refreshPrices` with `quotes: false` writes no `price_poll` row; with `quotes: true` it
        writes one and the batch still runs
- [ ] `tests/price-poller.test.ts`, driven as the existing cases are:
  - [ ] A tick outside market hours runs the batch, writes no `price_poll` row, and asks the fake
        for no quotes
  - [ ] `requestRefresh` runs quotes regardless of market hours and is dropped while a tick is
        running
  - [ ] `requestRefresh` before `startPricePoller` reaches no provider
- [ ] `tests/refresh-quotes.test.ts` is unchanged in what it asserts; its fake gains the method
