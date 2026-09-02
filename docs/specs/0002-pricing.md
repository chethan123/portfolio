# Pricing — live quotes, an immutable daily spine, and a UI that says how fresh it is

> Triage label to apply when this is filed: `ready-for-agent`
>
> Covers DESIGN.md §6 (pricing) in full, together with §10's in-process scheduler and market
> calendar, §8.4's Settings → Instruments tab, and §11's "as of" timestamp. Builds on the foundation
> slice (0001), which created `quote`, `price_daily` and the query layer that reads them.

## Problem Statement

Every price in the database is a seed or a test fixture. `quote` holds one row — `USD` at 1.00 — and
`price_daily` holds one row dated 1970-01-01. The foundation slice's honesty machinery works exactly
as designed: `holding_valued` left-joins `quote`, reports `is_priced = false` rather than
substituting zero, and a family that has uploaded a brokerage statement sees its cash counted, every
security reported as unpriced, and a net worth "based on 2 of 14 holdings".

The mechanism for telling the truth exists. Nothing feeds it.

- **No current value.** The largest numbers on the balance sheet — a 401k in mutual funds, a taxable
  brokerage account in ETFs — contribute nothing to any total, and the app's central question is
  unanswerable.
- **No spine under history.** `price_daily` is what every time series in §7 and §8.1 stands on. With
  no daily closes, the trend line moves only when a statement is uploaded, so a quarterly uploader
  gets a step function and reads it as market movement.
- **No freshness anywhere in the UI.** §11 calls the "as of" timestamp non-negotiable and names
  silently showing yesterday's net worth as though it were live as *the one genuinely dangerous
  failure mode in a finance app*. Today the app shows a number and says nothing about when it was
  true. The stale-price treatment §6.2 requires has no UI at all, and `--warning` and
  `--warning-surface` were derived in §13.2 specifically for it and have no consumer.

Four traps sit between here and a working refresh, and every one of them fails silently:

- **Currency.** A foreign-listed line arrives with a price and a currency, and nothing in the schema
  records currency. A £10,000 holding read as $10,000 understates it by about a fifth at any
  exchange rate of the last decade, with no error anywhere.
- **The date a price is filed under.** Mutual funds strike one NAV after the close, so a 2pm poll
  returns *yesterday's* NAV. Filing quotes under "today" writes that stale NAV against today's date,
  and a poll on Thanksgiving manufactures a `price_daily` row for a day §6.2 says gets none.
- **The yield field.** `yahoo-finance2` reports `dividendYield` as a percent (`2.34`) and
  `trailingAnnualDividendYield` as a fraction (`0.0234`), and its own docstrings describe both as a
  "percentage". Reading the wrong one is a 100× error going straight onto the Income page: a 2.34%
  yielder shown as 234%, or a $2,340 projected income shown as $23.
- **The timer.** The scheduler runs in the app process. A module-scope `let` does not survive a Vite
  HMR invalidation in dev, so a developer editing the pricing module leaks one live timer per edit,
  each of them polling.

## Solution

A `PriceProvider` interface with a single batched method, a `yahoo-finance2` adapter behind it, and a
fake behind it for tests. One refresh operation selects every instrument that is fed by a symbol,
asks for all of them in one call, and writes two tiers: the `quote` row that `holding_valued` reads,
and a `price_daily` row on the immutable spine.

The `price_daily` row is keyed on the calendar date inside the quote's *own* timestamp, resolved in
`MARKET_TIMEZONE` — never on "today". That one decision disarms two of the four traps: the
afternoon poll files yesterday's NAV under yesterday, and a holiday poll rewrites Friday's row
idempotently instead of inventing a holiday row. Today's row is provisional, rewritten by each poll
and converging on the close; rows for past dates are never touched, which is what §6.2's "an
intraday refresh can never corrupt history" actually means.

Anything that cannot be priced is said out loud rather than dropped. A non-USD quote is refused: no
price is written, the instrument is marked stale, and the refusal is logged with the currency that
caused it. A symbol the provider omits keeps its last known price and gets `is_stale = true`. A
symbol that never had a price gets no row at all and stays honestly unpriced.

A poller inside the app process runs the refresh on `PRICE_POLL_INTERVAL_MINUTES`, skipping ticks
when the market calendar says the market is shut. The calendar is a cost optimisation and nothing
more: because rows are keyed on the quote's own timestamp, the worst a wrong calendar can do is
waste one HTTP request or miss one poll.

On screen: an "as of" timestamp on every page that shows a figure, a stale banner and per-row stale
treatment in the existing warning tokens, a "Refresh now" control, and the Settings → Instruments
tab where a collective investment trust gets its manual price and a ticker change gets applied.

No migration. The schema from §4.1 already holds everything this slice writes.

## User Stories

**Seeing what things are worth**

1. As a family member, I want my securities priced automatically, so that my net worth is a real
   figure rather than my cash balance next to a list of unpriced holdings.
2. As a family member, I want prices to refresh on their own while the market is open, so that
   opening the app mid-afternoon shows something close to live.
3. As a family member, I want pages to read the database rather than call the price provider while
   rendering, so that a page load is fast and does not depend on a third party being up.
4. As a family member, I want a "Refresh now" control, so that I do not wait up to fifteen minutes
   after uploading a statement to see it valued.
5. As a family member, I want "Refresh now" to work outside market hours, so that I can pull the
   closing price the evening it settles.
6. As a family member, I want my mutual funds priced at their NAV, so that my 401k is not the
   unpriced part of my balance sheet.

**Knowing how fresh a number is**

7. As a family member, I want every page that shows a figure to say what it is as of, so that I am
   never reading yesterday's net worth as though it were live.
8. As a family member, I want that timestamp in my own timezone, so that I do not translate from
   UTC to know whether it is fresh.
9. As a family member, I want to be told when a price is stale, so that a number that stopped
   updating does not look the same as one that is current.
10. As a family member, I want a stale row to keep showing its last known price, so that the value
    does not blank out or drop to zero while the symbol is unavailable.
11. As a family member, I want staleness marked in words as well as colour, so that it reads without
    perceiving hue.
12. As a family member, I want a holding that has never been priced to look different from one whose
    price is merely old, so that I know which one needs a manual price.

**When pricing fails**

13. As a family member, I want a delisted symbol to leave my other holdings priced, so that one dead
    ticker does not blank the whole page.
14. As a family member, I want a provider outage to leave the app working on its last known figures,
    so that I still see my portfolio when Yahoo is down.
15. As a family member, I want to be told when an instrument was refused because it is not priced in
    dollars, so that I understand why it shows unpriced instead of guessing.
16. As a maintainer, I want a non-USD quote never written to any table, so that a GBP price cannot
    sum into a USD total.
17. As a maintainer, I want a failed fetch to write neither zero nor null, so that a total is never
    quietly understated by the size of a position.
18. As a family member, I want a failed manual refresh to leave the figures already on screen, so
    that pressing a button never makes the page worse.

**Instruments no feed covers**

19. As a family member, I want to set a price by hand for a collective investment trust, so that my
    workplace plan is valued at all.
20. As a family member, I want a manual price to carry forward until I change it, so that I am not
    re-entering the same number every week.
21. As a family member, I want one place that answers "which manual prices have gone stale", so that
    I can revisit them on a schedule rather than by memory.
22. As a family member, I want to change an instrument's symbol when a ticker changes, so that my
    position and price history stay one series.
23. As a family member, I want to change an instrument's price source, so that a CIT that gains a
    public symbol can start being fetched.
24. As a family member, I want to see the aliases pointing at an instrument, so that I can tell why
    a CSV line resolved the way it did.

**The daily spine**

25. As a maintainer, I want at most one `price_daily` row per instrument per trading day, so that
    the spine stays one price per day.
26. As a maintainer, I want no `price_daily` row created for a non-trading day, so that a weekend or
    a holiday resolves by carry-forward exactly as `holding_valued_at` already assumes.
27. As a maintainer, I want an intraday refresh never to modify a row for a past date, so that
    history cannot be rewritten by a poll.
28. As a maintainer, I want today's row rewritten by each poll during the session, so that it
    converges on the closing price without a separate end-of-day job.
29. As a maintainer, I want a NAV filed under the date it was struck rather than the date it was
    fetched, so that an afternoon poll does not record yesterday's fund price as today's.

**Running the poller**

30. As a self-hoster, I want the poller inside the application container rather than a third Compose
    service, so that there is one image to deploy and one place to read logs.
31. As a self-hoster, I want the poll cadence configurable by the environment variable already
    documented, so that I can slow it down without editing code.
32. As a self-hoster, I want weekends, evenings and market holidays skipped, so that a closed market
    costs me no requests against an unofficial API.
33. As a self-hoster, I want a wrong calendar entry to be unable to corrupt my data, so that the
    worst outcome of a stale holiday table is a wasted request.
34. As a self-hoster, I want two overlapping containers not to poll twice, so that a restart that
    overlaps a shutdown does not double the request rate.
35. As a self-hoster, I want the health endpoint to keep ignoring the price provider, so that a
    Yahoo outage does not make Compose restart a healthy app.
36. As a self-hoster, I want a failing poll not to stop the schedule, so that the next tick still
    runs after a transient error.
37. As a self-hoster, I want one log line per tick saying what happened, so that "prices stopped
    updating" is a question I can answer from logs.

**Building on it**

38. As a maintainer, I want all symbols fetched in one batched call, so that a hundred instruments
    cost one request rather than a hundred.
39. As a maintainer, I want the provider behind an interface, so that swapping to FMP is a day's
    work when the unofficial client breaks.
40. As a maintainer, I want no test to make a network call, so that the suite does not fail on a
    third-party outage — the same reasoning that keeps the provider out of `/healthz`.
41. As a maintainer, I want a fake provider implementing the same interface, so that delisted
    symbols, non-USD quotes and after-the-close NAVs are all reachable in a test.
42. As a maintainer, I want provider values converted to decimal strings before they reach Postgres,
    so that float coercion cannot round a price on the way in.
43. As a maintainer, I want the yield read from an unambiguously-united field, so that the Income
    page cannot be wrong by a factor of a hundred.
44. As a maintainer, I want this slice to require no migration, so that pricing is proved against the
    schema the design already fixed.

## Implementation Decisions

### The provider interface

Exactly §6.1's shape, unchanged:

```ts
interface PriceProvider {
  getQuotes(symbols: string[]): Promise<Quote[]>
}
```

**One method, one batched call.** It is the test seam, and it is the FMP escape hatch §6.1 buys with
the unofficial-client risk. Two implementations ship: a `yahoo-finance2` adapter, and a fake used by
every test. Nothing outside the adapter module imports `yahoo-finance2`, so a provider swap touches
one file.

A returned quote carries symbol, price, currency, yield percent, annual dividend per share, quote
type, and the provider's own as-of instant. The as-of instant is part of the contract rather than an
adapter detail, because the whole `price_daily` keying decision below depends on it.

### Yields: the unit hazard

**The adapter reads `dividendYield` and nothing else.** `yahoo-finance2` reports it as a percent
(`2.34`) and reports `trailingAnnualDividendYield` as a fraction (`0.0234`) while describing both as
a "percentage" in its own documentation. `quote.yield_pct` is a percent, so taking the second field
is a silent 100× error that surfaces as a plausible-looking wrong number on the Income page — the
most expensive kind, because nothing errors and the figure is the right order of magnitude to be
believed if you are not looking for it.

When `dividendYield` is absent, the yield is derived as `dividendRate / price * 100`. The ambiguous
field is never read, and the adapter says so in a comment, because the next person to add a field
will be looking at the same two names.

### The USD guard runs at refresh time

§6.1 places the currency guard at instrument resolution. Resolution belongs to the ingest slice,
which does not exist, so **refresh is currently the only place in the system where a currency is
ever observed at all.** Putting the guard there is what makes the guarantee real today rather than
after §5 ships.

A quote whose currency is not `USD` is refused: the price is not written to `quote`, no
`price_daily` row is created, the instrument is marked `is_stale = true`, and the refusal is logged
naming the symbol and the currency that caused it. Refusing loudly and keeping the last known price
is the same failure posture as every other unpriceable case in this slice — the alternative, writing
the number and hoping, sums GBP into a USD total with nothing anywhere to notice.

When resolution arrives it gets the same guard at the earlier point. The two are not in conflict and
neither makes the other redundant, since a security can be re-listed in another currency long after
it was resolved. This extends DESIGN.md and is recorded in Further Notes.

### Which instruments get fetched

`price_source = 'feed' AND symbol IS NOT NULL`. `fixed` (the seeded `USD` row) and `manual` (CITs)
are never fetched — the `USD` row must never be asked for, because a provider quote for a currency
pair would overwrite the 1.00 that the entire cash-and-debt path depends on.

**`instrument.symbol` carries no unique constraint,** deliberately: the same symbol can appear on two
instruments during a ticker migration or a mis-resolution not yet cleaned up. The refresh therefore
deduplicates symbols into the provider call and fans each returned quote back out to *every*
instrument holding that symbol. Assuming one instrument per symbol would silently leave the second
one stale forever.

### `price_daily` is keyed on the quote's own timestamp

**The date comes from the quote's `regularMarketTime`, resolved in `MARKET_TIMEZONE` — never from
the system clock.** Two concrete failures make this load-bearing:

- **Mutual funds strike one NAV after the close.** A 2pm poll returns yesterday's NAV. Keyed on
  today, that files a stale price as today's close, and the trend line shows a fund moving a day
  late forever after.
- **A poll that should not have happened must not manufacture data.** §6.2 states plainly that
  non-trading days get no `price_daily` row, and `holding_valued_at` relies on it: carry-forward is
  what makes Saturday equal Friday. A holiday poll returns Friday's quote with Friday's timestamp,
  so it rewrites Friday's row with the value it already holds. The gap appears by construction.

The consequence worth stating explicitly: the holiday calendar is not load-bearing for correctness.
It cannot be, once the date is the quote's own.

### Today's row is provisional and converges to the close

During a session, each poll rewrites today's `price_daily` row, so it holds the latest price and
settles at the last one of the day. There is no separate end-of-day job to miss, and no window in
which today has no row.

**Rows for past dates are never written by a refresh.** That is the precise reading of §6.2's "an
intraday refresh can never corrupt history": history means dates that are finished. Narrowing the
spine's immutability to past dates is recorded in Further Notes.

### The market calendar is a cost optimisation

Weekday plus session-hours check in `MARKET_TIMEZONE`, plus a small hardcoded NYSE holiday table,
exactly as §10 describes. §10 also supplies the calibration — "a wrongly skipped poll costs nothing;
a wrongly attempted one costs one request" — and this spec takes that literally: the calendar is a
pure function of an instant, it gates only whether a poll is *attempted*, and no write path consults
it. A holiday the table has never heard of costs one HTTP request and writes nothing new.

Session boundaries are computed in the market timezone rather than by UTC offset arithmetic, so the
two DST transitions each year need no special case. Half-day early closes are not modelled; the
worst they cost is a handful of requests after the market shuts.

### Partial failure needs no new schema

Yahoo omits symbols it does not know rather than returning an error for them, so partial success is
the normal case, not an edge case.

- A symbol absent from the response **keeps its existing `quote` row untouched except for
  `is_stale = true`.** §6.2: never zero, never null into a sum.
- A symbol that has never been quoted gets **no row at all**. `holding_valued` already reports it as
  `is_priced = false`, and the coverage count already says the total is partial. Inventing a
  zero-priced quote row to represent "we tried" would be exactly the silent understatement the
  foundation slice was built to prevent.
- A provider call that throws — network failure, rate limit, the unofficial endpoint changing shape
  — marks every selected instrument stale and writes no price.

`is_stale` is cleared on the next successful quote for that instrument. No column, no table, and no
migration is added by this slice.

### Numerics

Provider values arrive as JavaScript floats. They are converted to fixed-scale decimal **strings**
at the adapter boundary and reach Postgres as strings, never as numbers — the same guarantee
`server/db.ts` enforces on the way out, applied on the way in. All money arithmetic, including the
derived yield, is done in SQL or in decimal string form. Per §4.1 the scales are fixed by the schema:
prices `numeric(20,4)`, `yield_pct` `numeric(10,6)`.

### The in-process poller

§10.1 is explicit that the in-process scheduler is why there is no third service, and there is no
custom server entry to hang it off — `start` is a plain `react-router-serve`. The poller therefore
lives in module scope of a server module that the application imports, started on first import.

- **Pinned on `globalThis`, not a module-scope `let`.** A module-scope binding does not survive a
  Vite HMR invalidation in dev: the old module keeps its timer, the new module creates another, and
  a developer working on pricing accumulates one poller per save. A `globalThis` key lets the new
  module find and replace the timer the old one installed.
- **Guarded by a Postgres session-level advisory lock.** Compose's `restart: unless-stopped` plus a
  slow shutdown means two app containers can briefly overlap, and both would poll. Each tick takes
  the lock, refreshes, and releases it; a tick that cannot take the lock skips. `server/migrations.ts`
  already uses `pg_advisory_lock` for exactly this class of race on a cold start — this is the same
  idiom with a different arbitrary key, and reusing the migration key would deadlock a poll against
  a migration.
- The lock also serialises a slow refresh against the next tick, so a fifteen-minute cadence and a
  twenty-minute outage do not pile up overlapping calls.
- **`/healthz` continues to say nothing about the poller or the provider.** `app/routes/healthz.ts`
  already documents why: a health check that fails on a third-party outage would make Compose
  restart a perfectly healthy app. A stopped poller is a logging problem, not a liveness one.

### Manual prices write both tiers

§6.2 says a manual price writes a `price_daily` row and carries forward. Taken alone that leaves a
CIT reading as unpriced on every current page, because `holding_valued` resolves current price from
`quote`. So the manual price form writes **both**: the `price_daily` row §6.2 specifies, and a
`quote` row with `is_stale = false` and `as_of` at the moment of entry.

Staleness for a manual instrument is a question of *age*, not of a failed fetch — the refresh path
never touches it — so the Instruments tab derives it from the age of the last manual price. That is
what makes §8.4's "which manual-priced instruments have gone stale?" answerable.

### Configuration

No new environment variables. `PRICE_POLL_INTERVAL_MINUTES` and `MARKET_TIMEZONE` were validated by
the foundation slice specifically so this slice would only have to read them, and `server/config.ts`
carries a comment saying so that should be removed when they gain their first reader.

## Testing Decisions

### What makes a good test here

Assert on what ended up in the database and on what a page says, never on how the provider was
called. Concretely:

- **No test makes a network call.** Every test drives the fake `PriceProvider`. A contract test
  against the live Yahoo endpoint would fail in CI on the outage this design already decided to
  tolerate, and would be the flakiest thing in the repository.
- **The clock is injected, never read.** Every rule in this slice is a rule about dates and times —
  after-the-close NAVs, holidays, session boundaries, staleness. A test that reads the wall clock
  passes in London and fails in New York, or passes in June and fails in December.
- Assert on decimal strings at full stored scale, following the foundation slice: `'123.4500'`, not
  `toBeCloseTo`.
- One behaviour per test, named for the rule — "a quote timestamped before midnight files under
  yesterday", not "refreshQuotes writes price_daily".
- The yield hazard gets a test whose fixture supplies **both** yield fields with mutually
  inconsistent values, so that reading the wrong one fails loudly rather than by a factor of a
  hundred.

### The seam

**One primary seam:** the refresh operation, driven with a fake `PriceProvider` and an injected
clock, against the real Postgres already established by 0001, seeded through the existing fixture
builder and read back through `holding_valued`. Every rule in this slice — selection, the USD
refusal, date keying, provisional today, staleness, fan-out to two instruments sharing a symbol — is
reachable from it, and reading results back through the view rather than the raw tables is what
proves the pricing path and the valuation path agree.

**A second, deliberately pure seam:** the market calendar as a function from instant to open/closed.
It has no database and no provider, it is where DST and holiday table cases are cheap, and keeping it
pure is what stops calendar logic leaking into the refresh path where it would become load-bearing.

There is no third seam. The poller itself is a timer, an advisory lock and a call to the refresh
operation; asserting that a `setInterval` was scheduled tests the standard library. Its one genuinely
untestable-in-unit property — that two containers do not both poll — is worth one integration test
that takes the lock from a second connection and asserts the tick skips.

### What gets tested

Through the primary seam:

- Selection: `feed` instruments with a symbol are fetched; `fixed` and `manual` are not; the seeded
  `USD` row is never sent to the provider; symbols are deduplicated into one call; two instruments
  sharing a symbol are both updated from one quote; an empty selection makes no call at all.
- Writing: `quote` is upserted with price, yield, annual dividend and the provider's own `as_of`;
  `is_stale` is cleared by a successful quote; `holding_valued` reports the new value.
- Date keying: a quote timestamped this morning files under today; a quote timestamped yesterday
  afternoon — the mutual fund case — files under yesterday; a poll on a holiday rewrites the previous
  trading day's row and creates no row for the holiday; an instant near midnight files under the
  market-timezone date, not the UTC one.
- Convergence: two polls in one session leave one row for today holding the later price; a row for a
  past date is byte-identical before and after a refresh.
- Failure: an omitted symbol keeps its price and gains `is_stale`; a never-quoted omitted symbol
  gains no row and stays `is_priced = false` through the view; a throwing provider marks every
  selected instrument stale and writes no price; a refusal and an omission in the same batch do not
  prevent the healthy symbols in it from being written.
- The USD guard: a GBP quote writes nothing, marks the instrument stale, and is reported in the
  refresh summary with its currency.
- Yields and numerics: the percent field is used and the fraction field ignored even when both are
  present; the derived fallback produces a percent; a price carrying more precision than the column
  holds is rounded by Postgres at the stated scale rather than by a float on the way in.
- Manual prices: writing one makes the instrument priced in `holding_valued`, and it carries forward
  to a later date through `holding_valued_at`.

Through the calendar seam: weekend, weekday inside and outside session hours, the minute before and
after the open, a hardcoded holiday, and a date on each side of both DST transitions.

### Prior art

The foundation slice set all of it: a real Postgres per 0001's `tests/support/database.ts`, seeded
through `tests/support/fixtures.ts`, asserted on decimal strings. This slice adds two things to that
kit — a fake `PriceProvider` and an injected clock — and both belong in the same support directory
rather than in a test file, because the dashboards and ingest slices will want them.

## Out of Scope

- **Instrument resolution and the upload flow** (§5) — the alias prompt, unresolved-instrument
  handling, and the resolution-time position of the currency guard. This slice guards at refresh
  instead; see Further Notes.
- **FMP fallback** (§6.1). The interface is the whole preparation. Building a second adapter before
  the first one has broken is speculative work against an API we may never call.
- **The History tab and the manual net worth series** (§7, §8.4). `manual_networth` exists and stays
  empty.
- **Multi-currency** (§14.6). No currency column, no conversion, no display of a foreign price. The
  guard is the entire currency story.
- **Realized gains, dividend history and tax lots** (§14.1). `annual_dividend_per_share` and
  `yield_pct` are stored as a forward-looking estimate; nothing here records what was actually paid.
- **Any change to `holding_valued` or `holding_valued_at`** (§8.2). They already handle unpriced and
  stale rows correctly, and this slice is partly a proof of that. If a pricing rule seems to need a
  view change, the rule is wrong.
- ~~**Backfilling `price_daily`.** History starts at day zero (§7); the spine starts the first time the
  poller runs. A provider outage leaves a gap that carry-forward covers, and no job goes back to fill
  it in.~~
  **Reversed** by [0017](0017-price-backfill.md) and
  [ADR-0011](../adr/0011-a-backfill-fills-the-spine-but-never-moves-it.md): whenever an instrument's
  position history reaches back behind its spine, every refresh fills what is absent from the feed's
  own history. Struck through rather than deleted, because half of it survives and the half that
  does is the reason the other half was wrong. **A provider-outage hole is still not a trigger** —
  it is one date inside a series carry-forward already answers honestly, and a trigger on any absent
  trading day would need a calendar no write path may consult. What the line missed is that the
  *head* of a series is not a hole: it is the whole era before the instance was installed, and
  carry-forward has nothing to carry. Holes are filled as a side effect when an instrument is
  fetched for its head gap, and only then.
- **Alerting on staleness.** Staleness is surfaced in the UI and in logs. No email, no push, no
  threshold configuration.

## Further Notes

**Contradicts nothing in `docs/adr/`** — that directory still does not exist, and neither does
`CONTEXT.md`. This spec uses DESIGN.md's vocabulary: *quote*, *daily close*, *price source*,
*stale*, *manual price*. Two terms are used here that the design does not name and that a future
glossary should pick up: the **provisional row** (today's `price_daily` row, before the close) and
the **spine** (`price_daily` as the immutable series everything time-based reads).

**Five decisions in this spec extend DESIGN.md rather than merely implementing it,** and are worth
noticing on review:

1. **The USD guard runs at refresh time, not only at instrument resolution.** §6.1 puts it at
   resolution. Resolution does not exist yet, and refresh is currently the only place a currency is
   ever observed, so a guard placed only at resolution would guard nothing for as long as this slice
   is the newest one. Refresh-time is additionally the only place that catches a security re-listed
   in another currency after it was resolved. If this is wrong, the alternative is shipping pricing
   with the currency risk §14.6 names entirely unmitigated.
2. **`price_daily` rows are keyed on the quote's own timestamp rather than on the poll date.** §6.2
   fixes what a row means but not which date a refresh files under. Keying on the quote makes the
   after-the-close NAV correct and makes the holiday rule hold without a calendar. The visible
   consequence is that a provider reporting a wrong or missing timestamp misfiles a row, so the
   adapter treats a missing `regularMarketTime` as a reason to skip the daily write rather than to
   fall back to now.
3. **Today's `price_daily` row is rewritten within the session.** §6.2 calls `price_daily` an
   immutable spine. This spec narrows that to *past dates are immutable*, on the grounds that the
   alternative is either a separate end-of-day job — a second scheduled thing to miss — or a day with
   no row until after the close.
4. **The market calendar is demoted to a cost optimisation.** §10 already implies it with its
   cost calibration, but this spec states it as an invariant and arranges the write path so that it
   holds: no correctness rule may depend on the calendar, and a reviewer should treat a calendar
   check appearing inside the refresh path as a defect.
5. **The poller takes a Postgres advisory lock.** §10 assumes a single instance and accepts a missed
   poll on restart. It does not consider the overlap in the other direction, which `restart:
   unless-stopped` makes routine. The lock is cheap, and it reuses an idiom already in the repo.

**Manual prices writing the `quote` row as well as `price_daily`** is a gap-filling decision rather
than an extension, but it is the one most likely to be "tidied" later by someone reading §6.2 alone.
Removing the `quote` write would make every CIT read as unpriced on the Overview page while looking
perfectly priced in history.

**The UI ticket is in the slice on purpose.** It could be split, at the cost of shipping a subsystem
nobody can see and leaving §11's non-negotiable timestamp missing for another slice. It also carries
the only genuinely undesigned work here: per `docs/research/2026-08-19-stitch-screen-audit.md`, the
Stitch set has no stale-data indicator, no empty state, no error state, and no Settings screen at
all, and its one as-of timestamp appears on a single mobile screen. The design brief for that ticket
lives at `docs/design/pricing-ui-brief.md`.

**The provider is the accepted limitation this slice is built around** (§14.5). Everything defensive
here — owning `price_daily`, the fake, the interface, the refusal to let `/healthz` depend on Yahoo,
staleness rather than deletion — is the mitigation that limitation promises. A reviewer should read
any shortcut past those as spending down the mitigation rather than saving effort.
