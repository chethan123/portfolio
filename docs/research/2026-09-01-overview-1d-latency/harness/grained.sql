-- The grained series (spec 0022's readGrainedSeries), run against the harness's
-- scaled shape and log. Same parameters GrainedWindow carries — a window (its
-- last date and its length in days, since psql has no array literal to hand
-- in `dates` directly), a grain in minutes and a market time zone — and the
-- same narrowing slot session-rewrite.sql uses: `true` is what the reader
-- substitutes with the owner filter off, the unfiltered case measured here.
--
--   psql "$DATABASE_URL" -v enddate=2026-09-18 -v windowdays=92 -v grain=180 -v zone=America/New_York -f grained.sql -o /dev/null
--
-- `prefix`, when set, is emitted in front of the select: how a plan is taken
-- (`explain (analyze, buffers)`).
\timing on
\if :{?prefix}
:prefix
\endif
with days as (
  select d::date as d, row_number() over (order by d) as ord
  from generate_series(
    :'enddate'::date - (:windowdays - 1) * interval '1 day',
    :'enddate'::date,
    interval '1 day'
  ) as t(d)
),
steps as (
  -- The day cut into steps of the grain from its midnight on the market clock; never the window's first day.
  select dy.d,
         ((dy.d::timestamp) at time zone :'zone') + make_interval(mins => :grain::int * k) as starts
  from days dy
  cross join generate_series(0, 1440 / :grain::int - 1) as k
  where dy.ord > 1
),
instants as (
  -- A step's point is its last observation of that day; a step with none is no point. One backward
  -- index step on price_observation_market_date_idx per (day, step), whatever the cadence.
  select s.d, m.at
  from steps s
  cross join lateral (
    select max(o.as_of) as at
    from price_observation o
    where o.market_date = s.d
      and o.as_of >= s.starts
      and o.as_of < s.starts + make_interval(mins => :grain::int)
  ) m
  where m.at is not null
),
dated as (
  -- The window's first day, and any day no step found an observation on: the spine's close for that
  -- date. Read off `instants`, never the log again: a probe of price_observation per day is planned
  -- as a sequential scan, and one definition of "observed" is enough.
  select dy.d
  from days dy
  where dy.ord = 1
     or not exists (select 1 from instants i where i.d = dy.d)
),
held as (
  -- Positions in force on each plotted day, one row per (day, holding); narrowed here, never in an outer WHERE.
  select p.d, h.id, h.instrument_id, h.quantity
  from (select distinct d from instants) p
  join account a on a.closed_at is null or a.closed_at > p.d
  join holding h on h.position_set_id = latest_position_set(a.id, p.d)
  where true
),
instant_points as (
  select i.d, i.at, false as dated,
    cast(coalesce(sum(cast(h.quantity * px.price as numeric(20, 4))), 0) as numeric(20, 4)) as amount,
    count(px.price) as known,
    count(h.id) as total
  from instants i
  left join held h on h.d = i.d
  left join lateral (
    select coalesce(
      (select o.price from price_observation o
        where o.instrument_id = h.instrument_id and o.as_of <= i.at
        order by o.as_of desc limit 1),
      (select pd.close from price_daily pd
        where pd.instrument_id = h.instrument_id and pd.date < i.d
        order by pd.date desc limit 1)
    ) as price
  ) px on true
  group by i.d, i.at
),
dated_points as (
  select dt.d, null::timestamptz as at, true as dated,
    cast(coalesce(sum(v.value), 0) as numeric(20, 4)) as amount,
    count(*) filter (where v.is_priced) as known,
    count(v.instrument_id) as total
  from dated dt
  left join lateral (
    select * from holding_valued_at(dt.d) v where true
  ) v on true
  group by dt.d
)
select cast(d as text) as day, at, dated, amount, known, total from instant_points
union all
select cast(d as text) as day, at, dated, amount, known, total from dated_points
order by day, at;
