# 02 — The ledger and the gap query

_Part of [0017-price-backfill.md](../0017-price-backfill.md)._

**What to build:** The `price_backfill` table in `migrations/0010_price_backfill.sql`, the
regenerated `app/lib/database.generated.ts`, a fixture builder for a ledger row, and — in
`app/lib/prices.server.ts` — the read that says which instruments a batch should try next. The read
is the gap definition from `docs/importing-history.md:227-238`, made a domain query and narrowed
to what a feed can fill: feed-priced, with a symbol, whose spine starts later than its position
history or does not exist, not attempted in the last day, in a fixed order, bounded.

Its own ticket because a migration and a query are reviewed against a database and a ticket that
also contains a provider adapter is two reviews in one. It touches no provider and no write, so
[01](01-the-provider-history-method.md) can be built beside it.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**The migration** (`migrations/0010_price_backfill.sql`)

- [ ] `0010` is the next free number: `migrations/` runs `0001` to `0009` today. Spec 0015's
      tickets also plan a `0010`; whichever lands first takes it and the other renumbers — say so
      in the pull request, not in the file
- [ ] A header comment carrying the reasoning, in `0009_price_observation.sql`'s form: what a
      backfill is (the glossary's words), why an attempt is recorded whether or not it wrote, and
      why the spine's own rows are never touched by one
- [ ] `price_backfill`: an identity primary key; `instrument_id` referencing `instrument` with
      `on delete cascade`, as every price table does; `started_at timestamptz not null` — when the
      fetch began, not when the row committed, `price_poll`'s reasoning (`0009:118-121`);
      `range_from date not null` and `range_until date not null`, `until` exclusive;
      `written integer not null`; `outcome text not null`; `error text`
- [ ] `check` constraints, named as `price_poll_counts_range` is: `written >= 0`; `outcome` in
      exactly `filled`, `nothing_to_write`, `no_history`, `non_usd`, `split_unresolved`,
      `provider_failed`; `(outcome = 'filled') = (written > 0)`, so a count and an outcome cannot
      disagree; `(outcome = 'provider_failed') = (error is not null)`, so the text is there exactly
      when there is something to read; `range_from < range_until`
- [ ] An index on `(instrument_id, started_at desc)` — the retry skip asks "any attempt in the last
      day for this instrument" and the Settings list asks "the latest attempt for each", and both
      walk it
- [ ] `comment on table price_backfill` stating the one-line contract, as `0009:132-143` does for
      the price tiers: one row per attempt per instrument, written with the closes it describes or
      alone, never edited
- [ ] Applied against the throwaway Postgres, then `npm run db:types`, and the regenerated file
      committed — `PriceBackfill` appears beside `PricePoll` (`database.generated.ts:144-150`) and
      CI's `db:types -- --verify` is what rejects a skipped regeneration

**The outcome vocabulary in code** (`app/lib/prices.server.ts`)

- [ ] A `const` object of the six outcome literals and a `BackfillOutcome` type derived from it —
      no enum; `tsconfig` sets `erasableSyntaxOnly`. Kept in step with the migration's `check` by
      hand, the arrangement `app/lib/account-options.ts` has with the schema's other vocabularies,
      and stated as such in a comment
- [ ] One test inserts a row for each value through the fixture below, so a value the constraint
      does not know fails here rather than on a Saturday night

**The two constants** (`app/lib/prices.server.ts`, beside `ADVISORY_LOCK_KEY`)

- [ ] `BACKFILL_BATCH_SIZE` — how many instruments one refresh may attempt. Small, single digits;
      five is a reasonable first value, and no test may depend on the number. A module constant,
      not a setting: the household has no reason to turn it and a wrong value is a request-rate
      problem, not a preference
- [ ] `BACKFILL_RETRY_INTERVAL` — how recently an attempt must have been made for an instrument to
      be skipped: one day, as a Postgres interval literal the query interpolates, so an unfillable
      gap costs one request a day and not one a tick

**The candidate read** (`selectBackfillCandidates`, `app/lib/prices.server.ts`)

- [ ] Exported, taking `db` last and defaulting to `getDb()` as every read in the module does
- [ ] Selects `instrument` rows with `price_source = 'feed'` and a non-null `symbol` — the two
      exclusions `selectFeedInstruments` argues (`:133-148`), and the null symbol excluded on its
      own because `feed` allows one
- [ ] Joins `holding` to `position_set` and takes `min(position_set.as_of_date)` as the instrument's
      first-held date; left-joins `price_daily` and takes `min(date)` as its first close; keeps a
      row where the first close is null or later than the first-held date. Every set ever recorded
      counts, superseded corrections included — the recipe's caveat at
      `docs/importing-history.md:243-246`, inherited and stated in the docstring
- [ ] Excludes any instrument with a `price_backfill` row whose `started_at` is within
      `BACKFILL_RETRY_INTERVAL` of `now()`
- [ ] Orders by first-held date ascending, then `instrument.id` — the deepest gap first, and two
      ticks agree on what "next" is
- [ ] Limits to `BACKFILL_BATCH_SIZE`
- [ ] Returns `{ id: string; symbol: string; rangeFrom: IsoDate }` per row, `rangeFrom` computed
      in SQL as the first-held date less seven days — a statement dated on a weekend or a holiday
      then finds a close to carry forward — so no date arithmetic happens in JavaScript. The
      range's end is the caller's, because it is today's market date and this read has no clock

**The fixture** (`tests/support/fixtures.ts`)

- [ ] `seedBackfillAttempt({ instrument, startedAt, outcome, rangeFrom?, rangeUntil?, written?,
      error? })`, one row per call, defaults chosen so the common test — "attempted recently" —
      is one line. Raw inserts belong in the builder and nowhere else

**Tests** (a new `tests/price-backfill.test.ts`, through `withDatabase`, seeded through the
builders; `afterAll(closeTestDatabase)`)

- [ ] An instrument with a position set and no close at all is a candidate
- [ ] An instrument whose first close is later than its first-held date is a candidate; one whose
      first close is on or before it is not
- [ ] A `fixed` instrument, a `manual` instrument, and a `feed` instrument with a null symbol are
      never candidates, whatever their positions
- [ ] An instrument with no holding anywhere is not a candidate — a gap is a property of positions
- [ ] An attempt seeded within the last day removes the instrument from the batch; one seeded
      older than that does not
- [ ] `rangeFrom` is exactly seven days before the earliest position-set date, as a `YYYY-MM-DD`
      string
- [ ] The order is first-held date then id, asserted with two instruments that would sort the other
      way by symbol
- [ ] More candidates than the bound returns the bound, and the ones returned are the first in that
      order — asserted without naming the bound's value
- [ ] Each of the six outcomes can be written through the fixture; a seventh cannot
- [ ] The count-and-outcome constraint refuses `filled` with zero written and `nothing_to_write`
      with one, and the error constraint refuses a provider failure without text
