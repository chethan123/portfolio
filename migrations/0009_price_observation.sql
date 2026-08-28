-- The price poller stops discarding: every distinct quote becomes a retained
-- observation, and every refresh attempt becomes a poll record.
--
-- This is the schema half of ADR-0006 ("Intraday quotes are an observation log,
-- not a third history tier"), which the 1D chart range is built on. Until now a
-- refresh overwrote `quote` in place, so every price the poller ever fetched
-- between two closes was thrown away — there was nothing to draw a session with
-- and nothing kept for any later use of that data.
--
-- **Three tiers, and what each one means.** The ADR fixes the vocabulary; the
-- `comment on table` statements at the foot of this file put the same one-line
-- contracts where `\d+` will show them.
--
--   price_observation  instants we were told about — append-only, deduped, forever
--   quote              the current answer — one row per instrument, overwritten
--   price_daily        the finished-day spine — unchanged by this migration
--
-- An observation is not history and a quote is not a fact. `holding_valued_at`
-- keeps reading `price_daily` alone, so an observation can never move a line
-- that has already been drawn.
--
-- **`as_of` is the provider's instant, never the poll time.** Same rule, and the
-- same reason, as the date a close is filed under (`prices.server.ts`): a mutual
-- fund's evening NAV fetched this morning belongs to yesterday. `market_date` is
-- that instant run through `marketDateOf` at write time, so resolving "the most
-- recent session" is an indexed date lookup rather than a timezone computation
-- at read time, and the instant-to-day rule stays in its one existing home.
--
-- **The payload is an archive, never an operand.** `price` is the only column in
-- this table any query may compute from. The raw provider entry is kept on the
-- same precedent that keeps every uploaded CSV in `position_set.raw_file`: an
-- audit artifact that may later be re-read, never computed from. A figure needed
-- for arithmetic is promoted to a typed `numeric` column in its own migration —
-- summing out of `payload` is exactly the numeric-boundary violation
-- (ARCHITECTURE.md §5.6) that rule exists to prevent.
--
-- **Storage is the accepted cost.** At the design envelope — about a hundred
-- feed instruments at the seeded 15-minute cadence, payloads on — this table
-- grows by roughly half a gigabyte a year, and a 1-minute cadence is about
-- fifteen times that. That is priced and accepted (ADR-0006, docs/operating.md);
-- Settings → Prices states it at the dial. Nothing prunes it.
create table price_observation (
  instrument_id bigint not null
    references instrument (id) on delete cascade,

  -- The instant the provider says the price was struck. Half of the primary
  -- key, which is what makes an unchanged quote write nothing.
  as_of         timestamptz not null,

  -- The trading day `as_of` belongs to, in the market's zone, stamped by the
  -- same rule that files the daily close.
  market_date   date not null,

  -- Same precision as the other two tiers. The only column a query may compute
  -- from.
  price         numeric(20, 4) not null,

  -- When we learned it, as distinct from when it was struck. A fact about us.
  fetched_at    timestamptz not null,

  -- The provider's raw entry, archived only when the typed parse succeeded, so
  -- a shape change stays a refusal rather than becoming a stored surprise.
  -- Nullable: a provider or a fake that hands over nothing raw still observes.
  payload       jsonb,

  primary key (instrument_id, as_of)
)
-- Two storage parameters, both about the payload rather than the price.
--
-- `toast_tuple_target` at its floor pushes the payload out of line early, so the
-- heap pages this table is scanned through stay dense with the four small
-- columns any query actually reads. The default 2032 would keep a typical quote
-- payload inline and make a price-only scan drag every archived JSON document
-- through the buffer cache with it.
--
-- `autovacuum_vacuum_insert_scale_factor` is lowered because this table is
-- insert-only and never updated or deleted: without it, the insert-triggered
-- vacuum that freezes tuples would fire at 20% of an ever-growing table, so each
-- freeze is larger and rarer than the last. At 2% the same work happens in small
-- chunks that stay small.
with (
  toast_tuple_target = 128,
  autovacuum_vacuum_insert_scale_factor = 0.02
);

-- Session resolution, both halves of it: `max(market_date)` finds the most
-- recent session that was observed at all, and the leading-column range scan
-- then walks that session's distinct instants in order. Reading the session off
-- what was observed — rather than off a calendar — is what keeps the UTC-today
-- versus market-day seam from ever deciding what 1D shows.
--
-- The per-instrument "latest observation at or before this instant" lookup that
-- values each point needs no index of its own: the primary key is already
-- `(instrument_id, as_of)`, which that lookup matches exactly.
create index price_observation_market_date_idx
  on price_observation (market_date, as_of);

-- One row per refresh attempt, whether or not any new observation resulted.
--
-- Dedup is what makes this table necessary. Because an unchanged quote writes no
-- observation, a silence in the log is ambiguous: a quiet market, a provider
-- that failed, and a server that was not running all look identical. This is the
-- record that tells them apart years later, at about twenty-six rows a day.
--
-- One case it does not separate, because the row is written in the same
-- transaction as the prices it describes: a refresh that ran and could not
-- commit leaves no row, and so reads as a server that was not running. Buying
-- that case would cost the one-fetch-one-unit-of-work property the write path
-- is built on, so it is stated rather than bought.
--
-- It stores the report the refresh already assembles, minus one figure: the
-- daily-close count is deliberately not kept. It is a count of writes to another
-- tier, not a fact about the attempt, and `priced` already says how many
-- instruments answered.
create table price_poll (
  id            bigint generated always as identity primary key,

  -- When the attempt began, not when it committed: the span between the two is
  -- how long the provider took, and the reason to record the earlier one is that
  -- an attempt that never commits leaves no row at all.
  started_at    timestamptz not null,

  requested     integer not null,
  priced        integer not null,
  stale         integer not null,

  constraint price_poll_counts_range
  check (requested >= 0 and priced >= 0 and stale >= 0)
);

create index price_poll_started_at_idx on price_poll (started_at);

-- The one-line contract for each tier, stated where the schema is read.
comment on table price_observation is
  'The observation log: instants we were told about. Append-only, deduped per instant, never pruned, invisible to every valuation of a past date. `price` is the only column any query may compute from; `payload` is an archive, never an operand (ADR-0006).';

comment on table price_poll is
  'One refresh attempt, recorded whether or not any observation resulted — what tells a quiet market apart from a server that was not running. Written in the attempt''s own transaction, so an attempt that could not commit leaves no row.';

comment on table quote is
  'The current answer: one row per instrument, overwritten in place. Not a projection of the observation log — the seeded USD row never generates an observation, and `is_stale` asserts an absence an append-only log cannot represent.';

comment on table price_daily is
  'The finished-day spine: at most one row per instrument per trading day, read by `holding_valued_at` for every historical figure. History means dates that are finished; an observation is not history.';
