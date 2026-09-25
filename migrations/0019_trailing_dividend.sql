-- annual_dividend's rate becomes the trailing year's distributions summed (from the provider's own
-- dividend events), used as the projection for the coming year. Yahoo's dividendRate /
-- trailingAnnualDividendRate do not mean one thing across quote types and are low or absent for
-- ETFs: ITOT read 0.7% against a real 1.0%, SGOV $0 against 3.74%.
-- Stamp plus outcome, no ledger: nothing reads payment history, and the stamp is the retry clock.
-- The view reads one operand, never a coalesce over two provenances -- the outcome column, not the
-- value, tells a measured rate from a carried one.

alter table quote
  add column trailing_dividend_per_share numeric(20, 4),
  add column trailing_dividend_as_of     timestamptz,
  -- Kept in step by hand with DIVIDEND_OUTCOMES (app/lib/prices.server.ts), as 0010 does.
  add column trailing_dividend_outcome   text
    constraint quote_trailing_dividend_outcome_valid
    check (trailing_dividend_outcome in
           ('ok', 'no_data', 'non_usd', 'unreadable', 'provider_failed'));

-- One-time carry-over: the old figure keeps showing until the sweep replaces it, so deploying
-- does not blank every dividend. The stamp is backdated to exactly the staleness bound rather
-- than left null, so every carried row is due immediately BUT still sorts behind a genuinely
-- new instrument, whose stamp is null. A null stamp therefore means "never measured by us",
-- and a null outcome beside a non-null rate means "carried from the provider, not yet measured".
update quote
   set trailing_dividend_per_share = annual_dividend_per_share,
       trailing_dividend_as_of     = now() - interval '7 days'
 where annual_dividend_per_share is not null;


-- IDENTICAL to migrations/0006_annual_dividend.sql:7-57 except the money lateral's annual_dividend.
-- Column list, order and types unchanged, so holding_valued_at's row-type contract
-- (docs/adr/0001-holding-valued-row-type-contract.md) is not engaged and the function is
-- deliberately left alone.
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
    cast(h.quantity * coalesce(q.trailing_dividend_per_share, 0)
                                             as numeric(20, 4)) as annual_dividend
) money
where a.closed_at is null;

comment on view holding_valued is
  'Current holdings, valued. The shared definition every dashboard reads; see '
  'DESIGN.md 8.2. Latest position set per account (tie-broken by created_at '
  'then id), closed accounts excluded, quote LEFT joined so an unpriced holding '
  'still appears with is_priced = false. annual_dividend is the exception to '
  'that honesty: it projects the trailing year of distributions summed into '
  'quote.trailing_dividend_per_share, and a missing rate is coalesced to zero, '
  'so the figure is a lower bound rather than a null (DESIGN.md 14, '
  'limitation 9).';
