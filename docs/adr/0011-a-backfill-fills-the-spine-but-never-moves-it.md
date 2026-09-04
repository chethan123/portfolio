# A backfill fills the spine but never moves it

The daily spine has always begun the first time the poller quoted an instrument. Spec 0002 put
"Backfilling `price_daily`" out of scope — "the spine starts the first time the poller runs. A
provider outage leaves a gap that carry-forward covers, and no job goes back to fill it in"
([`docs/specs/0002-pricing.md`](../specs/0002-pricing.md), Out of Scope) — and DESIGN.md §7's
"History starts at day zero" was read as covering prices as well as positions. We are reversing
the first and narrowing the second. Whenever an instrument's position history reaches back behind
its spine, the running system fetches that instrument's daily history from the feed and inserts
every trading day the spine does not already hold. It never replaces a row it recorded itself. This
ADR is numbered 0011 because 0010 is reserved by spec 0015's header for an ADR not yet written.

**Superseded in part** by [0018](../specs/0018-price-worker.md): "spec 0015" here — in the
paragraph above, under "In-process", under "Mailbox-shaped, for the worker" and in "The outbound
surface grows" — is the price-worker proposal that was never indexed and is deleted with 0018; by
number, 0015 is now `0015-chart-series-assembly.md`. 0018 builds that worker as a remote provider
behind one table and inherits the second call exactly as foreseen below; ADR-0010 stays reserved
for it. Nothing else here is rewritten.

## What changed the mind

A statement describes its own date, not the day it was uploaded, so the first upload of any
instrument new to the system predates that instrument's first close — by days in the ordinary
case, by years for a household loading its history. `holding_valued_at(d)` then finds no close at
or before `d`, keeps the holding as unpriced and null, and the net worth line runs at cash minus
loans until the day the instance was installed, then cliffs up to the real total
([issue #83](https://github.com/chethan123/portfolio/issues/83)). Nothing stored is wrong; the
drawn line is, on every long range, for the life of the instance.

The out-of-scope line was right about outage holes and wrong about this. An outage hole is one day
inside a series carry-forward already answers honestly. The head of a series is the whole era before
it, and carry-forward has nothing to carry.

[`docs/importing-history.md`](../importing-history.md) §5 was the answer: find the gaps with a
query, source closes from the same unofficial endpoint the poller quotes from, un-adjust them for
splits by hand, `\copy` them in under an insert-where-absent rule the document has to state in prose,
and do all of it after the most recent statement and before the older ones. It is a correct
procedure with three silent traps, done in a terminal, on a day nothing reminds anyone — the shape
[ADR-0009](0009-the-stack-takes-dumps-not-backups.md) already rejected for dumps.

## The decision

- **Gap-triggered.** An instrument is backfilled because its spine starts later than its position
  history does, or does not exist — the recipe's own gap query, made a domain read. Not because it
  is new, and not because a person asked. History already uploaded is already a gap.
- **Coupled to the refresh.** A refresh is quotes, then one bounded batch of backfills, under the
  one advisory lock, whoever started it: the poller's tick, a press of Refresh now, or the request
  fired when an upload commits. Outside market hours the tick asks for no quotes and still runs the
  batch, and writes no `price_poll` row for it, because a poll is an attempt at quotes.
- **Insert where absent.** `on conflict (instrument_id, date) do nothing`, never `do update`. A
  close the poller wrote live is the record; the feed's later restatement of it is not. Only
  trading days the feed returned are written, and no row is ever fabricated for a day the market
  did not trade.
- **Un-adjusted.** The feed returns closes restated through later splits; statements record shares
  as held on the day. Every close before a split is multiplied back by the split's ratio,
  cumulatively, to four decimals, on `money.ts`'s units. The convention this rests on is verified
  once against a real split and recorded where the adapter states it; if it does not hold, the
  fallback is to refuse any instrument with a split in range and fill the rest.
- **Ledgered.** One `price_backfill` row per attempt per instrument — when, the range asked for,
  how many closes were new, and a closed outcome — so an unfillable gap is retried daily rather
  than every tick, and "why is this still unpriced in March" is a query rather than a memory.
- **In-process.** A second method on the provider interface and a second write path in the one
  module that writes prices. Nothing is shaped for spec 0015's worker.

## Considered options

- **A manual "backfill N years" screen.** Rejected: it asks the household to know that a spine
  exists, that it has a head, and how far back a statement reaches — and the answer to all three is
  already in the database. A screen would also invite backfilling further than any statement
  needs, which is data nothing reads.
- **Overwrite with the feed's close.** Rejected: the poller's row for a finished day was the
  provider's own figure at the time, and a restated close months later is a revision nobody asked
  for. The insert-where-absent rule is the only thing that lets two writers share one table without
  one silently owning the other's rows. It costs the ability to correct a live row from history,
  which `docs/importing-history.md` already declined to promise.
- **A separate scheduled job.** Rejected on ADR-0009's grounds read the other way: that job earned
  a second container because `pg_dump` does not belong in the app image and a dump must survive the
  app being down. Neither holds here — this is the app's own provider and its own table, and a
  refresh already runs on a cadence under a lock. A second schedule would be a second thing to
  miss for no property gained.
- **Mailbox-shaped, for the worker.** Spec 0015 would move every Yahoo call into an egress-isolated
  sidecar coordinated through rows. Rejected for now: that spec is not built, and shaping this as a
  request row a worker would consume means building half of a design that may not land, in the
  process that does the work today. If 0015 is built, it moves this method with the other.
- **Adjusted closes, and adjust the quantities instead.** Rejected: a position set is a photograph
  of what was held, and the schema says so everywhere; restating share counts through splits would
  make every statement disagree with the file it came from. The price is the side that has to give.
- **Holes as a trigger.** Rejected: an outage hole is one date carry-forward already answers, the
  original reasoning stands, and a trigger on any absent trading day would need a calendar to say
  which absences are holes — the calendar no write path may consult
  (`app/lib/market-hours.ts:1-13`, DESIGN.md §10). Holes are filled as a side effect whenever the
  instrument is fetched for its head gap, and only then.

## Consequences

- **What is now promised.** Every feed-priced instrument with a symbol whose positions reach back
  behind its spine gets its closes without anyone asking, a bounded number of instruments per
  refresh, so a household loading a decade of statements is filled over a handful of refreshes and
  every distorted point on the chart repairs itself as the rows land. The poller's own rows are
  never touched. Every attempt is on record.
- **What is not.** The chart still draws a partially-priced past date on the ordinary line while the
  gap is open, and says nothing — the second half of issue #83, still owed and filed on its own.
  Nothing on any screen changes in this slice except the list at Settings → Prices.
- **Ticker reuse is an accepted limitation.** A symbol's history belongs to whatever holds the
  ticker now. An instrument that changed symbols gets the current ticker's past, and the only guard
  is a person spot-checking a figure against a statement. Detecting it would need a source of
  symbol history this instance does not have.
- **Manual instruments stay outside it.** A collective investment trust has no feed history
  anywhere. It appears in the gap list with the reason, and the hand-typed price form
  (`pricing/05`) remains the only answer.
- **The split-convention dependency is explicit.** The arithmetic assumes the feed's stated
  convention, verified once against the library version pinned when this landed. A library upgrade
  is a reason to re-run that check; the fallback rule is written down so the answer to a failed
  check is a refusal, not a wrong price.
- **A delisted symbol is never filled.** The feed removes all history for a delisted ticker,
  including the years it traded, so the outcome is a daily retry that answers no-history forever —
  one request a day per such instrument, accepted as the cost of not asking a person to mark it.
- **A weekend costs a query.** The poller's tick used to return before touching the database
  outside market hours. It now spends a cadence read and the gap query every tick, and a request
  only when the gap query's answer is not empty.
- **The outbound surface grows by one endpoint on the same host.** ARCHITECTURE.md §2's "batched
  quote fetch" is now a quote fetch and a history fetch, still from one module, still with no
  credential. Spec 0015, if built, inherits a second call to move.
- The glossary's **Backfill** entry is the word for this, and "historical import", "catch-up",
  "re-pricing" and "price sync" are avoided because each implies something this does not do.
