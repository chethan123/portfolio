-- Scale the seeded demo to the shape the slow Overview was reported on: 21
-- open accounts, 97 holdings, 98 feed instruments. The observation log is the
-- other script's job (scale-observations.sql), because the log is what the
-- measurement varies and this shape is what it varies against.
--
--   psql "$DATABASE_URL" -f scale-shape.sql
--
-- Runs in one transaction, on top of a fresh `scripts/seed-demo.ts` seed.
\set ON_ERROR_STOP on

-- Throwaway databases only: this script inserts accounts and instruments that
-- look like the household's own. The name is the only thing that says a
-- database is disposable, so it is what is checked.
select current_database() ~ '_(test|demo|bench)$' as throwaway \gset
\if :throwaway
\else
\echo 'Refusing: run this only against a database whose name ends in _test, _demo or _bench.'
\quit
\endif

begin;

-- 1. Six clones of every feed instrument (symbol suffixed), with their daily
--    spine and current quote copied, so ~98 feed instruments exist.
create temp table inst_clone as
select i.id as source_id, k as k,
       nextval(pg_get_serial_sequence('instrument', 'id')) as clone_id
from instrument i
cross join generate_series(1, 6) as k
where i.price_source = 'feed' and i.symbol is not null and i.symbol <> 'USD';

insert into instrument (id, symbol, name, quote_type, price_source, classification_id) overriding system value
select c.clone_id, i.symbol || '_' || c.k, i.name || ' clone ' || c.k, i.quote_type, i.price_source, i.classification_id
from inst_clone c join instrument i on i.id = c.source_id;

insert into price_daily (instrument_id, date, close)
select c.clone_id, pd.date, pd.close
from inst_clone c join price_daily pd on pd.instrument_id = c.source_id;

insert into quote (instrument_id, price, yield_pct, annual_dividend_per_share, as_of, is_stale)
select c.clone_id, q.price, q.yield_pct, q.annual_dividend_per_share, q.as_of, q.is_stale
from inst_clone c join quote q on q.instrument_id = c.source_id;

-- 2. Fifteen more open accounts, cloned round-robin from the six demo ones,
--    each with a copy of the source's latest position set. Feed holdings point
--    at the (j mod 6)+1-th instrument clone so the clones hold distinct
--    instruments; non-feed holdings (cash, trust) keep the original.
create temp table acct_clone as
with src as (
  select a.id, row_number() over (order by a.id) - 1 as n from account a where a.closed_at is null
)
select j, src.id as source_id, nextval(pg_get_serial_sequence('account', 'id')) as clone_id
from generate_series(1, 15) as j
join src on src.n = (j - 1) % 6;

insert into account (id, owner_id, name, institution, kind, tax_treatment, external_account_number) overriding system value
select c.clone_id, a.owner_id, a.name || ' #' || c.j, a.institution, a.kind, a.tax_treatment, null
from acct_clone c join account a on a.id = c.source_id;

create temp table set_clone as
select c.clone_id as account_id, c.j,
       latest_position_set(c.source_id) as source_set,
       nextval(pg_get_serial_sequence('position_set', 'id')) as set_id
from acct_clone c;

insert into position_set (id, account_id, as_of_date, source, source_filename, created_at) overriding system value
select s.set_id, s.account_id, ps.as_of_date, ps.source, ps.source_filename, ps.created_at
from set_clone s join position_set ps on ps.id = s.source_set;

insert into holding (position_set_id, instrument_id, quantity, cost_basis_per_share)
select s.set_id,
       coalesce(ic.clone_id, h.instrument_id),
       h.quantity, h.cost_basis_per_share
from set_clone s
join holding h on h.position_set_id = s.source_set
left join inst_clone ic on ic.source_id = h.instrument_id and ic.k = ((s.j - 1) % 6) + 1;

-- 3. Two extra holdings per cloned account on otherwise-unheld instrument
--    clones, to land on ~97 holdings in total.
insert into holding (position_set_id, instrument_id, quantity, cost_basis_per_share)
select s.set_id, x.clone_id, 10, 100
from set_clone s
join lateral (
  select ic.clone_id from inst_clone ic
  where ic.clone_id not in (select instrument_id from holding where position_set_id = s.set_id)
  order by (ic.clone_id * 7919 + s.j * 104729) % 1000
  limit 2
) x on true;

analyze;
commit;
