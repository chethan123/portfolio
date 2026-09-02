-- Regenerate the observation log over the scaled shape: one observation per
-- feed instrument per poll, every :cadence minutes from 09:30 to 16:00 New
-- York time, on each of the last :days sessions, with the instrument's own
-- seconds on `as_of` — the provider's last-trade instant, which is what makes
-- a session's instants number polls x instruments rather than polls
-- (migration 0009, ADR-0006).
--
--   psql "$DATABASE_URL" -v cadence=15 -v days=1 -f scale-observations.sql
--
-- cadence: minutes between polls; also written to app_setting.refresh_cadence_minutes
-- days:    how many sessions of observations to keep (the latest is the seed's newest close)
--
-- Replaces the whole log each run, so a re-run at another cadence measures
-- that cadence and nothing else.
\set ON_ERROR_STOP on

-- Throwaway databases only: this script deletes every row of
-- `price_observation`. The name is the only thing that says a database is
-- disposable, so it is what is checked. (The guard is repeated here rather
-- than included from one file: `\quit` inside an included script ends only
-- the include.)
select current_database() ~ '_(test|demo|bench)$' as throwaway \gset
\if :throwaway
\else
\echo 'Refusing: run this only against a database whose name ends in _test, _demo or _bench.'
do $$ begin raise exception 'not a throwaway database'; end $$;
\endif

begin;

delete from price_observation;

update app_setting set refresh_cadence_minutes = :cadence;

insert into price_observation (instrument_id, as_of, market_date, price, fetched_at)
select
  i.id,
  poll.at + make_interval(secs => (i.id * 37) % 60) as as_of,
  session.d,
  round(coalesce(q.price, 100) * (1 + (((i.id * 31 + poll.n) % 97) - 48) / 10000.0), 4),
  poll.at + interval '5 seconds'
from instrument i
join quote q on q.instrument_id = i.id
cross join (
  select d::date as d from generate_series(
    (select max(date) from price_daily where instrument_id <> (select id from instrument where symbol = 'USD')) - ((:days - 1) * interval '1 day'),
    (select max(date) from price_daily where instrument_id <> (select id from instrument where symbol = 'USD')),
    interval '1 day') as d
  where extract(isodow from d) < 6
) session
cross join lateral (
  select n, (session.d::timestamp + time '09:30') at time zone 'America/New_York' + make_interval(mins => n * :cadence) as at
  from generate_series(0, 390 / :cadence) as n
) poll
where i.price_source = 'feed' and i.symbol <> 'USD';

analyze;
commit;

select 'open accounts' as k, count(*)::text as v from account where closed_at is null
union all select 'current holdings', count(*)::text from holding_valued
union all select 'feed instruments', count(*)::text from instrument where price_source = 'feed' and symbol <> 'USD'
union all select 'price_observation rows', count(*)::text from price_observation
union all select 'sessions', count(distinct market_date)::text from price_observation
union all select 'distinct instants (latest session)', count(distinct as_of)::text
  from price_observation where market_date = (select max(market_date) from price_observation);
