# Intraday quotes are an observation log, not a third history tier

The price poller has always fetched a live quote every refresh cadence during market hours and
overwritten it in place, discarding every intermediate price. To support a 1D chart range — and
because the owner deliberately values retaining rich data whose future use is unknown — we now
retain every distinct observation, forever, in a new `price_observation` table: one row per
instrument per provider-stated instant (`as_of`), inserted with `on conflict do nothing` inside the
same transaction that upserts `quote` and `price_daily`. This reverses the recorded "no sub-daily
range chips" decision in `docs/design/pricing-ui-brief.md` §8; the mutual-funds-strike-one-NAV
argument there remains true and is accepted as a caveat, not a blocker.

## The three price tiers

- **`price_observation` — the observation log.** Instants we were told about: what the provider
  said, filed under the moment the provider says the price was struck (never the poll time — a
  mutual fund's evening NAV fetched this morning belongs to yesterday). Append-only, deduped per
  instant, never pruned, read by no screen except the 1D chart.
- **`quote` — the current answer.** One row per instrument, overwritten in place. Not a projection
  of observations and not derivable from them: the seeded `USD` row (which prices every bank
  balance and liability) will never generate an observation, a future hand-typed `manual` price
  will not either, and `is_stale` asserts the *absence* of an observation — something an
  append-only log cannot represent.
- **`price_daily` — the finished-day spine.** Unchanged. "History means dates that are finished"
  (`docs/specs/0002-pricing.md`) stays exactly as written; the observation log is not history in
  that sense.

An observation is not history and a quote is not a fact: history is finished days, an observation
is a moment we were told about, and the quote is today's best answer.

## The payload is an archive, never an operand

Each observation carries the provider's full validated response as `payload jsonb`, on the same
precedent that keeps every uploaded CSV forever in `position_set.raw_file`: an audit artifact that
may later be re-read, never computed from. **`price` is the only column in `price_observation` any
query may compute from.** A figure needed for arithmetic is promoted to a typed `numeric` column in
its own migration; summing from `payload` is the §5.6 violation the numeric boundary exists to
prevent. The honest rationale for hoarding is recorded here on purpose: option value — no consuming
feature exists or is planned. A future reader should not hunt for one.

A sibling `price_poll` table records each refresh attempt (~26 rows/day), because dedup makes the
log's silences ambiguous: without it, "no observation for two hours" cannot distinguish a quiet
market from a server that was not running.

## Consequences

- **Past-navigable intraday is deferred, not obligated.** 1D reads the most recent session only.
  Drawing an *older* session is a separate decision with its own cost — an instant-parameterised
  sibling of `holding_valued_at` (a third object bound by ADR-0001's row-type contract), a second
  time vocabulary in `chart-range.ts`, and a time axis on the chart. The data existing is not a
  promise that it will be drawn.
- **The refresh cadence dial is now a storage decision.** At the design envelope (~100 feed
  instruments), 15-minute cadence with payloads grows the database by roughly half a GB per year;
  1-minute cadence roughly 15× that. Settings → Prices states this; `docs/operating.md`'s
  "a household instance grows by a few megabytes a year" premise is superseded, though its
  conclusion — no retention policy — survives as a deliberate, priced choice.
- **The historical-line invariant gains a second front.** An observation must never leak into a
  past date's valuation; `holding_valued_at` continues to read `price_daily` alone, and the
  `tests/holdings-at.test.ts` invariant gets a sibling case pinning it against `price_observation`.
- The observation archive is snapshots at the household's cadence, not market data: no OHLC bars,
  no interval volume, permanent unbackfillable gaps when the server was down, no corporate-action
  adjustment. It must not be mistaken for a backtest-grade series.
