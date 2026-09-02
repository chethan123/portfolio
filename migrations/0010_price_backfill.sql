-- The price spine stops beginning where the poller happens to have started.
--
-- This is the schema half of ADR-0011 ("A backfill fills the spine but never
-- moves it"), which reverses one line of spec 0002: `price_daily` was never
-- backfilled, on the grounds that a provider outage leaves a hole carry-forward
-- covers. That was right about holes and wrong about the head of the series. A
-- statement describes its own date, so the first upload of any instrument new
-- to the system predates that instrument's first close — by days ordinarily,
-- by years for a household loading its history — and `holding_valued_at` finds
-- no close at or before those dates, keeps the holding unpriced, and draws the
-- net worth line at cash minus loans until the day the instance was installed.
--
-- **A backfill fills what is absent.** Whenever an instrument's position
-- history reaches back behind its spine, a refresh fetches that instrument's
-- daily history from the feed and inserts every trading day the spine does not
-- already hold — `on conflict (instrument_id, date) do nothing`, never `do
-- update`. A close the poller wrote live is the record; the feed's later
-- restatement of it is not, and the insert-where-absent rule is the only thing
-- that lets two writers share one table without one silently owning the other's
-- rows. No row is ever fabricated for a day the market did not trade.
--
-- **Why an attempt is recorded whether or not it wrote.** The counts alone
-- cannot say why a gap is still open. A delisted ticker whose history the feed
-- has dropped, a symbol quoted in another currency, a split the arithmetic
-- could not apply and a rate limit all write nothing, and they are four
-- different things to do about it. The ledger is also the retry clock: the
-- candidate query skips any instrument attempted within the last day, so an
-- unfillable gap costs one request a day rather than one every tick, and "why
-- is this still unpriced in March" is a query rather than a memory.
create table price_backfill (
  id            bigint generated always as identity primary key,

  instrument_id bigint not null
    references instrument (id) on delete cascade,

  -- When the fetch began, not when the row committed: the span between the two
  -- is how long the provider took, and `price_poll`'s reasoning for recording
  -- the earlier one holds here — an attempt that never commits leaves no row.
  started_at    timestamptz not null,

  -- The range asked for, `until` exclusive. Kept because the counts below
  -- cannot say what was covered: an attempt that wrote nothing over a week and
  -- one that wrote nothing over a decade are different facts.
  range_from    date not null,
  range_until   date not null,

  -- Closes the spine did not already hold, counted from the insert's own
  -- `returning` — how many rows were new, not how many were offered.
  written       integer not null,

  outcome       text not null,

  -- The provider's error text, present exactly when the call itself failed.
  error         text,

  constraint price_backfill_written_range
  check (written >= 0),

  -- Kept in step with `BackfillOutcome` in `app/lib/prices.server.ts` by hand,
  -- the arrangement `app/lib/account-options.ts` has with the schema's other
  -- vocabularies.
  constraint price_backfill_outcome_valid
  check (outcome in (
    'filled',            -- closes were written; the only outcome with written > 0
    'nothing_to_write',  -- the feed answered and the spine already held every day
    'no_history',        -- no history for the symbol: unknown, delisted or renamed
    'non_usd',           -- quoted in a currency this instance cannot hold
    'split_unresolved',  -- a split event in the response could not be applied
    'provider_failed'    -- the call itself failed; `error` carries the text
  )),

  -- A count and an outcome cannot disagree: `filled` is exactly the outcome
  -- that wrote, and every other one wrote nothing.
  constraint price_backfill_filled_wrote
  check ((outcome = 'filled') = (written > 0)),

  -- A failure carries text and nothing else does. It does not police the text
  -- itself: an empty string passes, because a provider that failed with nothing
  -- to say is a fact about the provider, not a row to refuse.
  constraint price_backfill_error_reported
  check ((outcome = 'provider_failed') = (error is not null)),

  -- The statement of the shape rather than a guard that can fire: a position
  -- set is dated at most one day ahead (`latestRecordableDate()` is tomorrow
  -- UTC), `range_from` sits a week before the earliest set and `range_until` is
  -- today's market date, so the week's margin covers the day.
  constraint price_backfill_range_ordered
  check (range_from < range_until)
);

-- Both readers walk this: the retry skip asks "any attempt in the last day for
-- this instrument", and the Settings → Prices gap list asks "the latest attempt
-- for each". A b-tree is read in either direction, so no `desc`.
create index price_backfill_instrument_started_idx
  on price_backfill (instrument_id, started_at);


comment on table price_backfill is
  'One backfill attempt per instrument, recorded whether or not it wrote — what makes an unfillable gap a named reason rather than a silence, and what keeps it to one request a day. Written in the same transaction as the closes it describes, or alone when there were none; never edited (ADR-0011).';
