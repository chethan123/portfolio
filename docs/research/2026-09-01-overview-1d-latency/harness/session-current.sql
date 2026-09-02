-- The 1D series as `readSessionSeries` computes it today (46d65df): every
-- holding valued at every instant of the session, through two correlated
-- lookups per pair. Extracted verbatim except that the narrowing the two
-- public readers pass is the `true` the reader substitutes when the owner
-- filter is off, and `${session}` is a psql parameter.
--
--   psql "$DATABASE_URL" -v session=2026-09-01 -f session-current.sql -o /dev/null
--
-- `prefix`, when set, is emitted in front of the select: how compare.sql
-- captures the rows (`create temp table … as`) and how a plan is taken
-- (`explain (analyze, buffers)`).
\timing on
\if :{?prefix}
:prefix
\endif
select
  instants.as_of as at,
  cast(coalesce(sum(valued.value), 0) as numeric(20, 4)) as amount,
  count(*) filter (where valued.price is not null) as known,
  count(valued.instrument_id) as total
from (
  select distinct as_of from price_observation where market_date = :'session'::date
) instants
left join lateral (
  select held.instrument_id, resolved.price, cast(held.quantity * resolved.price as numeric(20, 4)) as value
  from account a
  join holding held on held.position_set_id = latest_position_set(a.id)
  left join lateral (
    select o.price from price_observation o
    where o.instrument_id = held.instrument_id and o.as_of <= instants.as_of
    order by o.as_of desc limit 1
  ) observed on true
  left join lateral (
    select pd.close from price_daily pd
    where pd.instrument_id = held.instrument_id and pd.date < :'session'::date
    order by pd.date desc limit 1
  ) carried on true
  cross join lateral (select coalesce(observed.price, carried.close) as price) resolved
  -- The narrowing slot: `true` is what the reader substitutes with the owner
  -- filter off, which is the unfiltered Overview and the measured case.
  where a.closed_at is null and true
) valued on true
group by instants.as_of
order by instants.as_of;
