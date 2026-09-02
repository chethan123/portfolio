-- The same series as a running total over the session's observations of held
-- instruments — the shape spec 0016 approves. Same parameters as
-- session-current.sql, and compare.sql is what proves the two agree.
--
--   psql "$DATABASE_URL" -v session=2026-09-01 -f session-rewrite.sql -o /dev/null
--
-- `prefix`, when set, is emitted in front of the select: how compare.sql
-- captures the rows (`create temp table … as`) and how a plan is taken
-- (`explain (analyze, buffers)`).
\timing on
\if :{?prefix}
:prefix
\endif
with instants as (
  select distinct as_of from price_observation where market_date = :'session'::date
),
held as (
  select h.id, h.instrument_id, h.quantity
  from account a
  join holding h on h.position_set_id = latest_position_set(a.id)
  where a.closed_at is null
    -- The narrowing slot: `true` is what the reader substitutes with the owner
    -- filter off, which is the unfiltered Overview and the measured case.
    and true
),
opening as (
  select
    h.id, h.instrument_id, h.quantity,
    coalesce(
      (select o.price from price_observation o
        where o.instrument_id = h.instrument_id
          and o.as_of < (select min(as_of) from instants)
        order by o.as_of desc limit 1),
      (select pd.close from price_daily pd
        where pd.instrument_id = h.instrument_id and pd.date < :'session'::date
        order by pd.date desc limit 1)
    ) as price
  from held h
),
changes as (
  -- The bounds are scalar subqueries, not a `bounds` CTE: as init-plan
  -- parameters the planner can put them into an index condition, which is the
  -- difference between a bitmap index scan per holding and a sequential scan
  -- of the whole log.
  select
    o.as_of,
    op.quantity,
    o.price,
    coalesce(lag(o.price) over (partition by op.id order by o.as_of), op.price) as previous
  from opening op
  join price_observation o
    on o.instrument_id = op.instrument_id
   and o.as_of >= (select min(as_of) from instants)
   and o.as_of <= (select max(as_of) from instants)
),
deltas as (
  select
    as_of,
    sum(cast(quantity * price as numeric(20, 4))
        - coalesce(cast(quantity * previous as numeric(20, 4)), 0)) as value_delta,
    count(*) filter (where previous is null) as known_delta
  from changes
  group by as_of
),
opening_total as (
  select
    coalesce(sum(cast(quantity * price as numeric(20, 4))), 0) as amount,
    count(price) as known,
    count(*) as total
  from opening
),
timeline as (
  select as_of, true as plotted, cast(0 as numeric) as value_delta, cast(0 as bigint) as known_delta
  from instants
  union all
  select as_of, false, value_delta, known_delta
  from deltas
),
running as (
  select
    as_of, plotted,
    sum(value_delta) over (order by as_of) as value_delta,
    sum(known_delta) over (order by as_of) as known_delta
  from timeline
)
-- `where r.plotted` is here and not in `running`: a WHERE is evaluated before
-- the window functions and would drop the delta rows before they were summed.
select
  r.as_of                                              as at,
  cast(ot.amount + r.value_delta as numeric(20, 4))    as amount,
  cast(ot.known + r.known_delta as bigint)             as known,
  ot.total                                             as total
from running r
cross join opening_total ot
where r.plotted
order by r.as_of;
