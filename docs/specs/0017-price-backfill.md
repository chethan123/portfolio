# Price backfill — the spine reaches back as far as the positions do

> Triage label to apply when this is filed: `ready-for-agent`
>
> Covers [ADR-0011](../adr/0011-a-backfill-fills-the-spine-but-never-moves-it.md), which decides
> the shape and reverses one recorded decision: that `price_daily` is never backfilled
> ([0002-pricing.md](0002-pricing.md), Out of Scope). Read it first — this spec builds what that
> ADR argues for and does not restate the argument. It closes the root cause of
> [issue #83](https://github.com/chethan123/portfolio/issues/83); the chart-side warning the same
> issue asks for is not in this slice.

**Status:** approved · **Slice directory:** [`price-backfill/`](price-backfill/) · **ADR:**
[0011](../adr/0011-a-backfill-fills-the-spine-but-never-moves-it.md)

## Problem Statement

The spine begins the first time the poller quotes an instrument. A statement describes its own
date, not the day it was uploaded (DESIGN.md §5), so the first upload of any instrument new to the
system routinely predates that instrument's first `price_daily` row by days, and a household loading
its history predates it by years. On every date in between, `holding_valued_at(d)` finds no close at
or before `d` for the security, keeps the holding with `is_priced = false` and a null value
(`migrations/0003_holding_valued_at.sql`), and the point on the chart is cash minus loans drawn on
the ordinary solid line. Nothing stored is wrong. The line is.

[`docs/importing-history.md`](../importing-history.md) §5 is the workaround: a `psql` job that
finds each gap with a query, sources closes from the same unofficial endpoint the poller quotes
from, un-adjusts them for splits by hand, and `\copy`s them in under an insert-where-absent rule
the document has to state in prose. It is careful, it is correct, and it is a job with three silent
traps that somebody has to remember to do — after the most recent statement and before the older
ones, or the older ones land wrong and stay wrong until the job is run. Spec 0002 put "Backfilling
`price_daily`" out of scope on the grounds that a provider outage leaves a gap carry-forward covers
([0002-pricing.md:445-447](0002-pricing.md)). That was about outage holes; the gap this slice
closes is the head of the series, and the out-of-scope line is reversed for it.

## Solution

A refresh becomes **quotes, then one bounded backfill batch**. Every refresh — the poller's tick,
a press of **Refresh now**, and a new trigger fired when an upload commits — runs through one code
path under the one advisory lock, and the batch is what changes: it asks the database which
feed-priced instruments still carry a **coverage gap** (a spine that starts later than the
instrument's position history does, or no spine at all), fetches each one's daily history from the
feed, one symbol per call, and inserts every trading day the feed returned **where the spine has no
row**, never overwriting one. Each attempt is recorded in a new `price_backfill` ledger with its
outcome, so an instrument that cannot be filled is retried daily rather than every tick, and "why is
this still unpriced in March" is answerable from the database. Settings → Prices lists what is
still open.

Nothing is asked of the household. There is no "backfill N years" screen, no re-upload, and no
change to the chart: every distorted point repairs itself the moment closes for it exist, which is
the payoff of computing history on read (spec 0009).

## Implementation Decisions

### The trigger is a coverage gap

An instrument is a candidate when it is `price_source = 'feed'` with a non-null symbol, and either
has no `price_daily` row at all or its earliest close is later than the earliest
`position_set.as_of_date` of any `holding` referencing it. That is the gap query
`docs/importing-history.md:227-238` already states, made a domain read and narrowed to what a feed
can fill; `fixed` and `manual` are excluded for the reasons `selectFeedInstruments` gives
(`app/lib/prices.server.ts:133-148`), and a null symbol is excluded separately because `feed` allows
one. It reads every position set ever recorded, superseded same-date corrections included, so an
instrument held only in a superseded set keeps a gap no valuation reads — the recipe's caveat,
inherited rather than resolved.

Not "new instrument": instruments are created at resolution, before any position set exists
(`app/lib/instrument-resolution.server.ts:582-597`), and the gap is a property of the positions. Not
a person's request: history already uploaded is already a gap, and asking for it again would be
asking the household to know the mechanism.

### A refresh is quotes, then one bounded batch

`refreshQuotes` keeps its name and its job (`app/lib/prices.server.ts:200`). A new composition in
the same module runs it and then the batch, and the three callers wrap that composition in
`withRefreshLock` (`prices.server.ts:72`) exactly as the poller and the button wrap `refreshQuotes`
today. The lock guards the decision to spend a request; two refreshes cannot backfill the same
instrument twice, and one refresh holding the lock while it works through a batch is the point.

Outside market hours the poller's tick still runs the batch. `isMarketOpen` stops deciding whether
the tick returns and starts deciding whether quotes are asked for
(`app/lib/price-poller.server.ts:95`); a tick that asked for no quotes writes no `price_poll` row,
because a poll is an attempt at quotes and a backfill-only tick attempted none. The market-hours
gate does not apply to the batch: a statement uploaded on a Saturday is valued by Monday's open
rather than after it.

The commit of an upload triggers one refresh once its transaction has committed
(`commitUpload`, `app/lib/uploads.server.ts:901`; the route action at
`app/routes/upload/review.tsx:67-76`). The response does not wait for it. The trigger goes through
the poller module, which already holds the injected provider, the in-process serialising flag, the
lock and the log line, so a commit landing mid-tick is dropped rather than queued — the same rule an
overlapping tick obeys. The refresh after a commit is therefore best-effort: a dropped request means
the uploaded instruments wait for the next tick. The same drop covers a process that has just
restarted, where the action runs before any loader has started the poller. A test that never starts
the poller therefore never reaches a provider.

### The whole range is fetched; only the head gap triggers

The range asked for runs from **one week before the instrument's earliest position-set date** — so a
statement dated on a weekend or a holiday finds a close to carry forward — to **the previous market
day**. Today's row stays the poller's provisional row (0002's "today's row is rewritten within the
session"); the batch never writes today. The start is computed in SQL beside the gap; the end is
today's market date under `marketDateOf(now, MARKET_TIMEZONE)`, treated as exclusive.

Holes inside an existing series — the days a provider outage cost — are filled as a side effect of
the write below whenever the instrument is fetched for its head gap. A hole is never a trigger on
its own; that is the half of 0002's reasoning that survives.

### Insert where absent, never overwrite

`insert … on conflict (instrument_id, date) do nothing`, as a separate statement from
`writeDailyClose` (`prices.server.ts:372`), which upserts with `do update` and must go on doing so
for the poller's own writes. The invariant is the one `docs/importing-history.md:283` states: a
backfill must never overwrite what the running system recorded live. `writeObservations`
(`prices.server.ts:460-475`) is the pattern — one insert for the whole series, counted from
`returning`, so the ledger records how many rows were new rather than how many were offered.

Only trading days the feed returned are written. No row is ever fabricated for a non-trading day: a
row for a weekend would state a close that never happened, where carry-forward already answers those
dates honestly (DESIGN.md §6.2). A bar the feed returns with no close, or a non-positive one, is
skipped for the reason `toProviderQuote` skips a non-positive price
(`app/lib/price-provider.server.ts:203-210`).

### Pacing

A small fixed number of instruments per refresh — a module constant in `prices.server.ts`, not a
setting, named by ticket [02](price-backfill/02-the-ledger-and-the-gap-query.md) — fetched
sequentially, one symbol per call. Nothing queues against the unofficial endpoint: a batch that
cannot finish before the next tick is simply resumed by the next tick, because the gap query is
re-asked every time and answers with whatever is still open. The library's own request queue is not
relied on. A household loading a decade of statements for forty instruments is filled over a
handful of refreshes; nobody is asked to wait for it and nothing on screen is held by it.

### The ledger: `price_backfill`

One row per attempt per instrument, written in the same transaction as the closes it describes, or
alone when there were none to write. The shape copies `price_poll`
(`migrations/0009_price_observation.sql:115-129`): an identity key, when the attempt began, the
counts it produced, and a `check` on every count. It adds the range that was asked for and a closed
outcome vocabulary:

| Column | Meaning |
|---|---|
| `id` | identity primary key |
| `instrument_id` | the instrument attempted; `on delete cascade`, as every price table does |
| `started_at` | when the attempt began — the fetch, not the commit |
| `range_from`, `range_until` | the dates asked for, `until` exclusive |
| `written` | closes the spine did not already hold, counted from the insert's own `returning` |
| `outcome` | one of the values below, `check`-constrained like `price_poll`'s counts |
| `error` | the provider's error text; present exactly when the outcome is a provider failure |

The outcomes, each a fact the next reader can act on:

| `outcome` | What happened |
|---|---|
| `filled` | closes were written — `written > 0`, and only this outcome has that |
| `nothing_to_write` | the feed answered and the spine already held every day it returned |
| `no_history` | the feed has no history for the symbol — an unknown, delisted or renamed ticker |
| `non_usd` | the history is quoted in a currency this instance cannot hold; nothing written |
| `split_unresolved` | a split event in the response could not be applied; nothing written |
| `provider_failed` | the call itself failed; `error` carries the text |

The candidate query skips any instrument with a row in the last day, so an unfillable gap is retried
daily — one request per unfillable instrument per day, which is the cost of not asking a person to
mark it — rather than every tick. The interval is a module constant beside the batch bound.

### Split adjustment, and the verification it depends on

Yahoo's chart endpoint returns `close` split-adjusted by Yahoo's stated convention (`adjclose` is
split-and-dividend adjusted, and is not read). Statements record shares as held on the day, so a
pre-split close taken as stored would value a position held before the split at a fraction of its
worth — by exactly the split factor, with every figure looking plausible. The closes are therefore
**un-adjusted**: for each split event in the response, every close dated before the split's trading
day is multiplied by `numerator / denominator`, cumulatively where the range holds more than one
split, to four decimals. The un-adjust happens inside the provider adapter's pure conversion, on
`money.ts`'s units: the close through `toUnits` at scale four, multiplied by the cumulative
numerator, `divide`d by the cumulative denominator — half away from zero, `money.ts:70` — and
`render`ed at scale four; never as a float in JavaScript. The history leaves the provider as plain
scale-4 close strings, and the writer is a plain insert-where-absent that multiplies nothing.

The convention is unverified by the library's own documentation. Ticket
[01](price-backfill/01-the-provider-history-method.md) therefore includes a one-off verification
against a real split — NVDA's 10:1 on 2024-06-10 is the worked example: pre-split closes in the
response should be near $120, not near $1,200, if the closes are adjusted — recorded where the
adapter states the convention it relies on. **If the verification fails**, the fallback rule is
fixed now rather than left to the builder: the adapter refuses to backfill any instrument whose
response carries a split inside the range, the ledger records `split_unresolved`, and the rest of
the batch proceeds. Mutual funds, which is most of a retirement account, essentially never split,
so the fallback costs little and misvalues nothing.

### What changes in each module

- **`app/lib/price-provider.server.ts`** — `PriceProvider` gains a second method beside `getQuotes`
  (`:62-64`): one symbol, one range, the market zone, answering with a closed set of statuses in
  the shape `SymbolProbe` already uses (`:298-310`) and throwing only when the call itself fails.
  The adapter uses `chart()` on the memoised client (`:283-291`, whose type widens to name it),
  one symbol per call, `interval: "1d"`, split events requested, `period1` from the range's start,
  and reads the result through Zod as `yahooQuote` does (`:135-162`). `historical()` is not used:
  in yahoo-finance2 4.0.2 it is a wrapper over `chart()`. Floats become four-decimal strings
  through `decimal` (`:96`) at the boundary, the trading day of each bar is `marketDateOf` of the
  bar's own timestamp, and `meta.currency` is guarded as the quote's currency is. The module stays
  the only importer of `yahoo-finance2`.
- **`app/lib/prices.server.ts`** — stays the only price writer and gains its second write path: the
  gap read, the sequential batch, the insert-where-absent, the ledger row, and the composition that
  runs quotes then the batch. The composition catches and logs a database failure inside the batch
  and still returns the quotes' report, with a batch-failed flag on the backfill report for the log
  line: the quotes have already committed by then, and no caller's outcome is changed by the batch.
  Its header, which names the tables a refresh writes, adds `price_backfill` to the list.
- **`app/lib/price-poller.server.ts`** — the tick runs the composition; outside market hours it
  asks for no quotes and still runs the batch. A weekend tick now costs the gap query, which the
  module header currently promises it does not; the header changes with it. The module also exports
  the request the commit trigger calls.
- **`app/routes/refresh.ts`** — the button's behaviour is unchanged for the person pressing it; the
  press now also runs a batch, and the outcome it renders is the quotes' outcome as today
  (`:57-79`); a batch that failed never turns a committed refresh into the error outcome.
- **`app/routes/upload/review.tsx`** — after `commitUpload` returns and before the redirect, one
  refresh is requested and not awaited.
- **`migrations/0010_price_backfill.sql`** and `app/lib/database.generated.ts` — the ledger, with a
  `comment on table` in the form 0009 uses.
- **`app/routes/settings/prices.tsx`** — the gap list, below the cadence form, and a subtitle that
  stops claiming nights and weekends cost nothing (`:54-58`, `:103-107`): a batch may run on a
  Saturday, and only when there is a gap to fill.
- **`tests/support/fixtures.ts`** — a builder for a ledger row, so the retry-skip rule can be tested
  without a raw insert.

### What is visible

Settings → Prices lists every instrument still carrying a gap: what it is, when it was first held,
when its spine begins, and the date and outcome of the last attempt — so the household sees an
unfillable gap as a named thing with a reason, and the operator sees which ticker to check against a
statement. Instruments the batch will never try — no symbol, or hand-priced — appear with the reason
and no attempt, because their gap is just as real and Settings → Instruments (`pricing/05`) is
still the answer for them. An empty list is a sentence saying the spine covers everything held.

One log line per batch that attempted anything, in the poller's own form (`price-poller.server.ts:118`)
and with its own grep-able stem: instruments attempted, closes written, failures. A tick whose gap
query found nothing writes nothing, which keeps "no price line in the log" meaning what
`docs/operating.md` says it means.

Nothing on the chart changes in this slice.

## Out of Scope

- A manual backfill screen.
- A per-date coverage warning on the chart — the second half of issue #83, its own ticket later.
- Holes as a trigger.
- Ticker-reuse detection: an instrument that changed symbols gets the current ticker's history — a
  documented limitation, spot-checked against a statement.
- Manual-priced instruments: no feed history exists; the Settings → Instruments form in
  `pricing/05` is still the answer.
- Anything touching `holding_valued_at`, `quote`, or `price_observation`.

## Testing Decisions

**Yahoo is never mocked, always injected.** Every rule in this slice is reachable through a fake
`PriceProvider` whose second method returns what a test states, in the pattern of
`tests/refresh-quotes.test.ts:33-64`. The existing fakes gain the method; a fake that cannot
answer history is not this application's provider. No test reaches the network, for the reason
0002 gives: a contract test against the live endpoint would be the flakiest thing in the repository.

**One hand-written chart response spanning a split** exercises the un-adjust arithmetic in
`tests/price-provider.test.ts` beside `toProviderQuote`'s cases — bars before and after one split
with figures chosen so the un-adjusted close is checkable by eye, asserted as the resulting close
and never as a factor, and a second case with two splits in range for the cumulative product. Hand-written, not captured: the point is the arithmetic, and a captured
payload would make the test depend on what Yahoo said one afternoon.

**Real Postgres, through `withDatabase`,** for everything that is a rule about rows: the gap query
(no spine; a spine that starts late; a spine that covers; `fixed`, `manual` and symbol-less
instruments never candidates; the deterministic order; the bound), the insert-where-absent rule (a
poller-written close is byte-identical before and after a batch that offered a different figure
for that day; a hole inside a series is filled), the ledger (one row per attempt with the right
outcome and count, written with the closes or alone), the daily retry skip (an attempt in the last
day excludes the instrument; an older one does not), and the poller's rule that a backfill-only tick
writes no `price_poll` row. Money assertions are exact decimal strings at scale four.

**The one-off split verification is not a test.** It runs once against the real endpoint, by hand,
and its result is recorded in the adapter's header with the library version it was checked against.

## Documents this changes on landing

Ticket [05](price-backfill/05-documents-and-the-issue.md) carries the list; the summary here is the
promise:

- `DESIGN.md` §6.2 (the spine is backfilled; a missed day may be filled as a side effect), §7 (day
  zero remains the rule for positions, not for prices), §8.4 (the Prices tab's row), §14 (ticker
  reuse as an accepted limitation, and the chart warning still owed).
- `ARCHITECTURE.md` §2 (a second Yahoo endpoint on the one outbound dependency), §4.2 (the
  writer's row, and the two hand-written `holding` joins added to the stated valuation exceptions),
  §4.5 (the backfill's write path), §6.2 (the batch beside the quotes), §7.2, §7.4, §7.5
  (the seam's second method), Appendix A (three modules, the migration) and Appendix B (**Backfill**,
  and the spine's entry).
- `docs/importing-history.md` — §5 becomes what to check rather than what to load, and the ordering
  in "Before you upload anything backdated" loses its manual step.
- `docs/specs/0002-pricing.md:445-447` — a **Reversed** banner on the out-of-scope line, in the
  struck-through form `docs/design/pricing-ui-brief.md` uses for its reversed rule, pointing here
  and at ADR-0011.
- `docs/developing.md` — a recipe for exercising a backfill locally and re-running the split
  verification after a library upgrade.
- `docs/operating.md`, `docs/runbook.md`, `docs/data-model.md`, `docs/guide/settings.md`,
  `docs/guide/prices.md`, `README.md`, and the glossary's **Refresh cadence** entry in `CONTEXT.md` —
  each where it states a claim this slice falsifies; ticket 05 names the lines.
- `docs/specs/README.md` — the slice row and the ticket directory, landed with this spec.
- Issue #83 closed by ticket 05, with the chart-side warning filed as its own issue so the half this
  slice does not do stays tracked.

## Tickets

- [`price-backfill/01-the-provider-history-method.md`](price-backfill/01-the-provider-history-method.md)
  — the second method on `PriceProvider`, the `chart()` adapter, the un-adjust, the fake, and the
  one-off split verification. Blocked by nothing.
- [`price-backfill/02-the-ledger-and-the-gap-query.md`](price-backfill/02-the-ledger-and-the-gap-query.md)
  — `migrations/0010_price_backfill.sql`, the regenerated types, the fixture, and the candidate
  query as a domain read. Blocked by nothing.
- [`price-backfill/03-the-backfill-step-in-every-refresh.md`](price-backfill/03-the-backfill-step-in-every-refresh.md)
  — the batch, the composition every caller shares, the poller outside market hours, the commit
  trigger, the log line. Blocked by 01 and 02.
- [`price-backfill/04-settings-prices-gap-list.md`](price-backfill/04-settings-prices-gap-list.md)
  — the list on Settings → Prices. Blocked by 02 and 03.
- [`price-backfill/05-documents-and-the-issue.md`](price-backfill/05-documents-and-the-issue.md)
  — every document brought level, the reversed line banner, the recipe, the issue. Blocked by 03
  and 04.

## Further Notes

**Routine calls, made without asking and recorded here as decisions.** The trading day of each daily
bar is derived in `MARKET_TIMEZONE` from the bar's own timestamp through `marketDateOf`, never by
truncating UTC — bars are stamped at the session open, 13:30Z for NYSE, and a UTC truncation would
be right by accident. A non-USD `meta.currency` writes nothing and records the outcome, matching the
guard at resolution and at refresh. Floats become four-decimal strings at the boundary the way
quotes do, and the split multiplication is arithmetic and therefore happens on `money.ts`'s units,
never as a float. The history call sends `matchKey(symbol)` — trim and upper-case,
`app/lib/prices.server.ts:174`, exported from there — which is what `refreshQuotes` sends as its
keys (`:235`); the stored value is untouched, and nothing here matches a symbol back, because one
call is one instrument.

**Choices this spec makes where the decisions record is silent**, each the smallest thing that fits
the repository and each open to the reviewer: the range's end is today's market date treated as
exclusive, and the adapter drops any bar filed on or after it by market date rather than trusting
`period2` alone; two instruments sharing a symbol are two candidates and two calls, bounded by the
batch; a provider failure for one instrument is ledgered and the batch continues, while a database
failure stops the batch, since the next instrument would fail the same way, and is caught and logged
by the composition rather than propagated, so the quotes already committed are reported as they
happened and no caller's outcome is changed by the batch; the batch's
order is by earliest position-set date and then id, so the deepest gap is worked first and two ticks
agree on what "next" means; the gap list on Settings → Prices includes instruments the batch will
never try, with the reason, rather than only the feed's; and the commit trigger is a request to the
poller module rather than a third copy of the button's three lines, so that it inherits the
injected provider and is a no-op in any test that never started the poller.

**Numbering.** The migration is `0010`, the next free number in `migrations/`; spec 0015's tickets
also plan a `0010`, and whichever lands first takes it. The ADR is `0011` because `0010` is reserved
by spec 0015's header for an ADR not yet written.

**This does not anticipate spec 0015.** The second method, the second write path and the ledger are
in-process, and nothing here is shaped as a mailbox for a worker. If that spec is built, it inherits
a second endpoint to move, and that is a cost recorded in ADR-0011 rather than avoided here.
