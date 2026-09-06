-- Fills price_daily's head so old positions aren't left unpriced before install; fills gaps only, never overwrites a live close (ADR-0011).
-- One row per attempt, whether it wrote or not -- the retry skip and the gap-reason query both read this log.
create table price_backfill (
  id            bigint generated always as identity primary key,

  instrument_id bigint not null
    references instrument (id) on delete cascade,

  -- Fetch start, not commit (price_poll's reasoning): a failed commit leaves no row.
  started_at    timestamptz not null,

  -- Requested range (until exclusive); the counts alone can't say what was covered.
  range_from    date not null,
  range_until   date not null,

  -- Rows actually new (from the insert's own RETURNING), not rows offered.
  written       integer not null,

  outcome       text not null,

  -- Provider's error text, present exactly when the call itself failed.
  error         text,

  constraint price_backfill_written_range
  check (written >= 0),

  -- Kept in sync by hand with BackfillOutcome (app/lib/prices.server.ts).
  constraint price_backfill_outcome_valid
  check (outcome in (
    'filled',            -- closes were written; the only outcome with written > 0
    'nothing_to_write',  -- the feed answered and the spine already held every day
    'no_history',        -- no history for the symbol: unknown, delisted or renamed
    'non_usd',           -- quoted in a currency this instance cannot hold
    'split_unresolved',  -- a split event in the response could not be applied
    'provider_failed'    -- the call itself failed; `error` carries the text
  )),

  -- filled iff written > 0; every other outcome writes nothing.
  constraint price_backfill_filled_wrote
  check ((outcome = 'filled') = (written > 0)),

  -- error text present iff provider_failed (an empty string still passes).
  constraint price_backfill_error_reported
  check ((outcome = 'provider_failed') = (error is not null)),

  -- Shape only, not a live guard: range_from sits a week before the earliest position set, range_until is today -- margin covers latestRecordableDate()'s tomorrow-UTC edge.
  constraint price_backfill_range_ordered
  check (range_from < range_until)
);

-- b-tree read either direction (no desc needed): retry-skip ("attempt in the last day") and the gap list ("latest attempt per instrument") both walk this.
create index price_backfill_instrument_started_idx
  on price_backfill (instrument_id, started_at);


comment on table price_backfill is
  'One backfill attempt per instrument, recorded whether or not it wrote — what makes an unfillable gap a named reason rather than a silence, and what keeps it to one request a day. Written in the same transaction as the closes it describes, or alone when there were none; never edited (ADR-0011).';
