-- Same shape as holding_valued, for a past date d -- that date's positions priced at that date's close (DESIGN.md §7).
-- returns setof holding_valued: one row type, no second definition to drift.


create function holding_valued_at(d date)
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
    -- Constant, not coalesce: a historical close has no staleness to carry.
    false                                               as is_stale

  from account a
  join person p
    on p.id = a.owner_id
  -- No set at-or-before d => no rows (not zero); pre-app history is manual_networth's job.
  join holding h
    on h.position_set_id = latest_position_set(a.id, d)
  join instrument i
    on i.id = h.instrument_id
  join classification c
    on c.id = i.classification_id
  -- Carry-forward: greatest price_daily close <= d, an index scan on its PK (instrument_id, date desc).
  -- LEFT: unpriced holding still appears (is_priced=false), never vanishes from a historical total.
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

  -- d promotes to midnight: an account closed during d still counts on d, not d+1.
  where a.closed_at is null
     or a.closed_at > d;
$$;

comment on function holding_valued_at(date) is
  'Holdings, valued, as of a date. Same row type as holding_valued; see '
  'DESIGN.md 8.2. Latest position set at or before the date (same tie-break), '
  'accounts closed after the date still counted, price carried forward from '
  'price_daily so a non-trading day takes the previous close.';
