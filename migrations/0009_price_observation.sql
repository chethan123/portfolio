-- Intraday quotes become an observation log; every poll attempt is recorded too (ADR-0006). price_observation append-only/deduped; price_poll one row per refresh; quote/price_daily unchanged.
create table price_observation (
  instrument_id bigint not null
    references instrument (id) on delete cascade,

  -- Half the PK: an unchanged quote (same instant) writes nothing (dedup).
  as_of         timestamptz not null,

  -- as_of run through marketDateOf at write time -- session lookup stays an indexed date, not a timezone computation.
  market_date   date not null,

  -- numeric(20,4), matching price_daily/quote.
  price         numeric(20, 4) not null,

  fetched_at    timestamptz not null,

  -- Archive only, never computed from -- promote a needed figure to its own numeric column (ARCHITECTURE.md §5.6).
  payload       jsonb,

  primary key (instrument_id, as_of)
)
-- toast_tuple_target low: pushes payload out-of-line so price-only scans skip it.
-- autovacuum_vacuum_insert_scale_factor low (0.02): insert-only table -- keeps freeze batches small.
with (
  toast_tuple_target = 128,
  autovacuum_vacuum_insert_scale_factor = 0.02
);

-- (market_date, as_of): finds+walks the latest observed session for 1D; per-instrument "latest at/before" reuses the PK, no separate index needed.
create index price_observation_market_date_idx
  on price_observation (market_date, as_of);

-- One row per refresh attempt, success or not -- the only way to tell a quiet market from a dead poller.
create table price_poll (
  id            bigint generated always as identity primary key,

  -- Attempt start, not commit: measures latency; an attempt that never commits still leaves no row.
  started_at    timestamptz not null,

  requested     integer not null,
  priced        integer not null,
  stale         integer not null,

  constraint price_poll_counts_range
  check (requested >= 0 and priced >= 0 and stale >= 0)
);


comment on table price_observation is
  'The observation log: instants we were told about. Append-only, deduped per instant, never pruned, invisible to every valuation of a past date. `price` is the only column any query may compute from; `payload` is an archive, never an operand (ADR-0006).';

comment on table price_poll is
  'One refresh attempt, recorded whether or not any observation resulted — what tells a quiet market apart from a server that was not running. Written in the attempt''s own transaction, so an attempt that could not commit leaves no row.';

comment on table quote is
  'The current answer: one row per instrument, overwritten in place. Not a projection of the observation log — the seeded USD row never generates an observation, and `is_stale` asserts an absence an append-only log cannot represent.';

comment on table price_daily is
  'The finished-day spine: at most one row per instrument per trading day, read by `holding_valued_at` for every historical figure. History means dates that are finished; an observation is not history.';
