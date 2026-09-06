-- Current holdings, valued — the one join every consumer reads (DESIGN.md §8.2).


-- Latest position set for an account (at-or-before p_as_of if given); shared so the tie-break can't drift.
create function latest_position_set(p_account_id bigint, p_as_of date default null)
returns bigint
language sql
stable
as $$
  select ps.id
  from position_set ps
  where ps.account_id = p_account_id
    and (p_as_of is null or ps.as_of_date <= p_as_of)
  order by ps.as_of_date desc, ps.created_at desc, ps.id desc
  limit 1
$$;


-- Column list is a contract: holding_valued_at() returns this same row shape — add a column here, update both.
-- quantity(20,8) * price(20,4) computed at scale 12, cast to money scale (20,4) once, here in SQL.
create view holding_valued as
select
  a.id                                                as account_id,
  a.name                                              as account_name,
  a.institution                                       as institution,
  a.kind                                              as account_kind,
  a.tax_treatment                                     as tax_treatment,
  p.id                                                as owner_id,
  p.name                                              as owner_name,

  -- Inner join: classification_id is NOT NULL, no unclassified fallback.
  i.id                                                as instrument_id,
  i.symbol                                            as symbol,
  i.name                                              as instrument_name,
  i.quote_type                                        as quote_type,
  i.price_source                                      as price_source,
  c.name                                              as classification,
  c.asset_class                                       as asset_class,

  -- Sign lives in quantity, not price (DESIGN.md §2).
  h.quantity                                          as quantity,
  q.price                                             as price,
  money.value                                         as value,
  h.cost_basis_per_share                              as cost_basis_per_share,
  money.cost_basis                                    as cost_basis,
  -- Null if either operand is null (no coalesce — avoids a fake gain); cast just types the column.
  cast(money.value - money.cost_basis
       as numeric(20, 4))                             as unrealized,

  -- is_priced false: missing from sums, present in the count — no silent understating.
  (q.price is not null)                               as is_priced,
  -- Unpriced != stale: staleness only applies to a price that exists.
  coalesce(q.is_stale, false)                         as is_stale

from account a
join person p
  on p.id = a.owner_id
join holding h
  on h.position_set_id = latest_position_set(a.id)
join instrument i
  on i.id = h.instrument_id
join classification c
  on c.id = i.classification_id
left join quote q
  on q.instrument_id = i.id
cross join lateral (
  select
    cast(h.quantity * q.price                as numeric(20, 4)) as value,
    cast(h.quantity * h.cost_basis_per_share as numeric(20, 4)) as cost_basis
) money
where a.closed_at is null;

comment on view holding_valued is
  'Current holdings, valued. The shared definition every dashboard reads; see '
  'DESIGN.md 8.2. Latest position set per account (tie-broken by created_at '
  'then id), closed accounts excluded, quote LEFT joined so an unpriced holding '
  'still appears with is_priced = false.';
