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
for a tick that asked for no quotes — are rules about rows and are proved against Postgres.

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
      `inTransaction` (`:182`); the three non-`ok` statuses write the ledger row alone, in their
      own transaction, with `written = 0`, each under its ledger outcome through the one-to-one
      mapping ticket 01 names; the fourth path is a throw, next
- [ ] A provider throw for one instrument is caught, ledgered as `provider_failed` with the error's
      message as `error`, and the batch continues to the next instrument — the batch is bounded and
      the next symbol may be fine
- [ ] A database failure stops the batch — the instrument being written is what would fail again —
      and the attempt it interrupted leaves no ledger row and is simply next time's candidate. It
      is not caught here: the composition below catches it, because the batch must not be allowed
      to falsify what the quotes already did
- [ ] Returns a `BackfillReport`: instruments attempted, closes written across the batch, a count
      per outcome, and `batchFailed`, false here and set by the composition below — the log line
      and the tests read it

**The write** (`writeBackfilledCloses`, private, beside `writeDailyClose` at `:372`)

- [ ] One `insert into price_daily` for the whole series, `on conflict (instrument_id, date) do
      nothing`, `returning` a column so the number of rows actually new is counted where it is
      known — `writeObservations` (`:460-475`) is the pattern and the reasoning. A separate
      statement from `writeDailyClose`, which must go on upserting for the poller
- [ ] The stored close is the string the provider handed over, cast to `numeric` in the statement
      and nothing more: the un-adjust for splits already happened in the adapter's pure conversion
      on `money.ts`'s units (ticket 01), and this write multiplies nothing, in SQL or anywhere
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
- [ ] Catches the batch's own failure — a database error mid-batch — logs it with
      `console.error`, and still returns the quotes' report, with `batchFailed: true` on the
      `BackfillReport` so the log line can say so. The reason is the button: `app/routes/refresh.ts`
      turns anything thrown out of the lock into `{ status: "error" }` (`:75-77`), which
      `app/components/price-freshness.tsx:81` renders as "Refresh failed. The figures above are
      unchanged." — false once `refreshQuotes` has committed its closes. No caller's outcome is
      changed by the batch: a press reports its quotes, a tick logs its quotes' line, and the
      batch's trouble is the batch's own line
- [ ] The module header (`:1-43`) names `price_backfill` beside `price_poll` among the tables a
      refresh may write, and the rule that the backfill's insert never rewrites a row, beside the
      header's existing account of which past rows a refresh *can* rewrite and why

**The poller** (`app/lib/price-poller.server.ts`)

- [ ] `isMarketOpen` (`:95`) stops deciding whether the tick returns and starts deciding whether
      quotes are asked for: the tick sets `running`, reads the cadence on every tick, and calls
      `withRefreshLock(() => refreshPrices(provider, zone, { quotes: open }, getDb()))`. The
      cadence read comes out from behind the gate: the comment at `:91-94` argued that a weekend
      must not cost a round trip every interval, and the gap query is now that round trip, so the
      read no longer earns its place behind the calendar. The comment is rewritten beside the
      header's (`:8-12`); `:99-101`'s reasoning for the read's own catch still holds
- [ ] The module header's promise that a weekend stays free of database traffic (`:8-12`) is now
      false and is rewritten: a weekend tick costs the cadence read and the gap query, and a
      request to the feed only when there is a gap. The test that states the old promise is
      rewritten with it: `tests/price-poller.test.ts:211-229` ("is not spent at all outside market
      hours") asserts `pool.totalCount` is 0 on a weekend, and the file header (`:1-19`) describes
      a tick as returning outside hours; both now say a weekend tick spends a connection and no
      provider request
- [ ] The quotes' log line (`:118-120`) is unchanged and written only when quotes were asked
      for. A second line, stem `Price backfill`, is written when the batch attempted anything or
      failed: instruments attempted, closes written, failures, and that the batch itself failed
      when `batchFailed` is set — a warning when any attempt or the batch failed, informational
      otherwise. A batch that found no candidates writes nothing, so "no price line in the log"
      keeps the meaning `docs/operating.md` gives it
- [ ] `requestRefresh(): void` is exported: the tick with quotes forced — one body, one
      parameter saying whether quotes are asked for regardless of the calendar, not a second body
      — through the same `running` flag, the same lock and the same log lines. The promise it
      starts never rejects: nothing registers an `unhandledRejection` handler and Node 24 exits
      on one, so a request that cannot be honoured is a log line and a return. A request landing
      while a tick or another request is running is dropped, not queued, the rule an overlapping
      tick obeys; the consequence is that decision 2's one refresh after a commit is best-effort,
      and a dropped request means the uploaded instruments wait for the next tick. When the poller
      has not been started in this process the request is dropped the same way, at the cost of one
      more tick: `app/root.tsx:67` starts it from a loader, and an action runs before that
      request's loaders, so after a process restart a review page rendered by the previous process
      posts to a fresh one whose poller is not yet up — and in dev, after `import.meta.hot.dispose`
      (`:185-187`) has stopped it. In a test that never started it no provider is ever reached
- [ ] `stopPricePoller` still arms nothing afterwards, and that is all it guarantees: a request or
      tick in flight when the poller stops runs to completion holding a state object the slot has
      forgotten, and `retime`'s identity check (`:71`) is what keeps it from arming a timer. A test
      therefore waits on the pool handing its connection back before `closeTestDatabase`, as the
      existing poller tests do through `watchedPool`

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
  - [ ] A candidate with no spine gets every trading day the fake returned, at exactly the figure
        the fake gave — a fake answering `"1200.0000"` stores `"1200.0000"`; the un-adjust is
        ticket 01's and is not repeated here
  - [ ] A close the poller already wrote is byte-identical after a batch that offered a different
        figure for that day, and the ledger's `written` counts only the new rows
  - [ ] A hole inside an existing series is filled; a day the fake did not return gets no row
  - [ ] Each provider status becomes its ledger outcome, with `written = 0` and, for a throw, the
        message in `error`; the batch continues past a throw to the next candidate
  - [ ] A batch that fails against the database — a fake `db` whose insert throws, or a ledger row
        the constraint refuses — leaves `refreshPrices` returning the quotes' report with
        `batchFailed` set, and the quotes' own rows committed
  - [ ] The fake was asked one symbol per call, in ticket 02's order, with `range.from` seven days
        before the first-held date and `range.until` today's market date — `backfillCloses` takes
        no clock, so the test fakes `Date` through `vi.useFakeTimers` as
        `tests/price-poller.test.ts:146` does
  - [ ] After a batch, the instruments it attempted are not candidates for the next one
  - [ ] `refreshPrices` with `quotes: false` writes no `price_poll` row; with `quotes: true` it
        writes one and the batch still runs
- [ ] `tests/price-poller.test.ts`, driven as the existing cases are, every case waiting on the
      pool's hand-back before the database closes:
  - [ ] "is not spent at all outside market hours" (`:211-229`) is rewritten: a tick outside market
        hours spends a connection, runs the batch, writes no `price_poll` row, and asks the fake for
        no quotes; the header (`:1-19`) says the same
  - [ ] `requestRefresh` runs quotes regardless of market hours and is dropped while a tick is
        running
  - [ ] `requestRefresh` before `startPricePoller` reaches no provider
- [ ] `tests/refresh-quotes.test.ts` is unchanged in what it asserts; its fake gains the method
