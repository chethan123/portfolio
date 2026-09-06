-- annual_dividend: quantity * annual_dividend_per_share, projected forward; null on holding_valued_at (no historical rate stored).
-- View + function must be replaced together, in one transaction: shared row-type contract breaks silently otherwise (docs/adr/0001-holding-valued-row-type-contract.md).
-- Appended after is_stale: `create or replace view` requires existing columns unchanged and in order.
-- Missing rate coalesces to 0 (a lower bound, not sum-of-known) -- accepted limitation 9, DESIGN.md §14.


create or replace view holding_valued as
select
  a.id                                                as account_id,
  a.name                                              as account_name,
  a.institution                                       as institution,
  a.kind                                              as account_kind,
  a.tax_treatment                                     as tax_treatment,
  p.id                                                as owner_id,
  p.name                                              as owner_name,

  i.id                                                as instrument_id,
  i.symbol                                            as symbol,
  i.name                                              as instrument_name,
  i.quote_type                                        as quote_type,
  i.price_source                                      as price_source,
  c.name                                              as classification,
  c.asset_class                                       as asset_class,

  h.quantity                                          as quantity,
  q.price                                             as price,
  money.value                                         as value,
  h.cost_basis_per_share                              as cost_basis_per_share,
  money.cost_basis                                    as cost_basis,
  cast(money.value - money.cost_basis
       as numeric(20, 4))                             as unrealized,

  (q.price is not null)                               as is_priced,
  coalesce(q.is_stale, false)                         as is_stale,

  money.annual_dividend                               as annual_dividend

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
    cast(h.quantity * h.cost_basis_per_share as numeric(20, 4)) as cost_basis,
    -- Overflow-guarded by fitsTheMoneyColumn (app/lib/positions.server.ts) at every quantity write; negative quantity => negative dividend, not income.
    cast(h.quantity * coalesce(q.annual_dividend_per_share, 0)
                                             as numeric(20, 4)) as annual_dividend
) money
where a.closed_at is null;

comment on view holding_valued is
  'Current holdings, valued. The shared definition every dashboard reads; see '
  'DESIGN.md 8.2. Latest position set per account (tie-broken by created_at '
  'then id), closed accounts excluded, quote LEFT joined so an unpriced holding '
  'still appears with is_priced = false. annual_dividend is the exception to '
  'that honesty: a missing rate is coalesced to zero, so the figure is a lower '
  'bound rather than a null (DESIGN.md 14, limitation 9).';


create or replace function holding_valued_at(d date)
returns setof holding_valued
language sql
stable
as $$
  select
    a.id                                                as account_id,
    a.name                                              as account_name,
    a.institution                                       as institution,
    a.kind                                              as account_kind,
    a.tax_treatment                                     as tax_treatment,
    p.id                                                as owner_id,
    p.name                                              as owner_name,

    i.id                                                as instrument_id,
    i.symbol                                            as symbol,
    i.name                                              as instrument_name,
    i.quote_type                                        as quote_type,
    i.price_source                                      as price_source,
    c.name                                              as classification,
    c.asset_class                                       as asset_class,

    h.quantity                                          as quantity,
    daily.close                                         as price,
    money.value                                         as value,
    h.cost_basis_per_share                              as cost_basis_per_share,
    money.cost_basis                                    as cost_basis,
    cast(money.value - money.cost_basis
         as numeric(20, 4))                             as unrealized,

    (daily.close is not null)                           as is_priced,
    false                                               as is_stale,
    null::numeric(20, 4)                                as annual_dividend

  from account a
  join person p
    on p.id = a.owner_id
  join holding h
    on h.position_set_id = latest_position_set(a.id, d)
  join instrument i
    on i.id = h.instrument_id
  join classification c
    on c.id = i.classification_id
  left join lateral (
    select pd.close
    from price_daily pd
    where pd.instrument_id = i.id
      and pd.date <= d
    order by pd.date desc
    limit 1
  ) daily on true
  cross join lateral (
    select
      cast(h.quantity * daily.close             as numeric(20, 4)) as value,
      cast(h.quantity * h.cost_basis_per_share  as numeric(20, 4)) as cost_basis
  ) money

  where a.closed_at is null
     or a.closed_at > d;
$$;

comment on function holding_valued_at(date) is
  'Holdings, valued, as of a date. Same row type as holding_valued; see '
  'DESIGN.md 8.2. Latest position set at or before the date (same tie-break), '
  'accounts closed after the date still counted, price carried forward from '
  'price_daily so a non-trading day takes the previous close. annual_dividend '
  'is null: the projection describes the portfolio now and no historical rate '
  'is stored to compute one from.';
