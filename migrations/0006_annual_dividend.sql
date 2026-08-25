-- The projected annual dividend: a column on `holding_valued`, and a null on
-- `holding_valued_at`.
--
-- `quote.annual_dividend_per_share` has been filled on every price refresh
-- since the initial migration and nothing has ever read it. This turns it into
-- a figure a household can act on — what a holding is projected to pay over the
-- coming year, `quantity * annual_dividend_per_share` — computed once in SQL
-- beside `value`, so that no two screens can arrive at it differently.
--
-- THIS FILE REPLACES TWO OBJECTS, AND IT HAS TO. `holding_valued_at` declares
-- `returns setof holding_valued`, so the view's row type is a contract binding
-- both — and PostgreSQL does not check that contract at replace time.
-- `create or replace view` accepts an appended column and reports CREATE VIEW
-- with no error and no warning, leaving the function returning too few columns.
-- Nothing fails until something CALLS it, which is to say: a migration that
-- replaces only the view deploys green and throws the first time anyone opens
-- the net worth chart. Each migration runs in its own transaction
-- (server/migrations.ts), so replacing both here is atomic. The reproduction is
-- in docs/adr/0001-holding-valued-row-type-contract.md, written for whoever
-- adds the next column.
--
-- The same contract fixes where the column goes: `create or replace view`
-- requires the existing columns to be unchanged and in the same order, with
-- anything new APPENDED. So `annual_dividend` is last, after `is_stale`, rather
-- than beside `value` where it belongs by meaning — and the function's select
-- list matches it position for position, because that is what the row type is.
--
-- Two decisions inside the figure itself:
--
--   * A null rate is ZERO, not unknown, and the coalesce is in the SQL because
--     the zero rule is the figure's definition rather than a rendering choice.
--     This is the one place the codebase departs from §8.2's "sum what is known
--     and label the coverage", and it is recorded as accepted limitation 9 in
--     DESIGN.md §14. Three unlike things produce that null — a growth ETF the
--     provider answered "no dividend fields" for, a workplace-plan trust with
--     no symbol that the refresh never asks about, and the seeded `USD` row no
--     provider will ever quote — and only the first is genuinely zero. Applied
--     literally, a portfolio where nineteen of twenty-three holdings correctly
--     pay nothing would be captioned "based on 4 of 23 holdings": true, and
--     useless. The screens label the total a lower bound instead.
--   * `yield_pct` is deliberately NOT exposed alongside it. Where the provider
--     supplies its own yield it struck that yield against its own price
--     snapshot rather than the price in our `quote` row, so `value * yield` and
--     `quantity * per-share` disagree about the same holding. One figure is
--     stored and the displayed percentage is derived from it — the same
--     arrangement that makes `unrealized` literally `value - cost_basis` rather
--     than a second expression free to round differently.
--
-- No fan-out. `quote.instrument_id` is the primary key and `holding` is unique
-- on (position_set_id, instrument_id), so the view's existing LEFT join stays
-- one row per holding and no total doubles.


create or replace view holding_valued as
select
  -- account and owner: every dashboard grouping in the design is available
  -- without adding a join (DESIGN.md §8.1).
  a.id                                                as account_id,
  a.name                                              as account_name,
  a.institution                                       as institution,
  a.kind                                              as account_kind,
  a.tax_treatment                                     as tax_treatment,
  p.id                                                as owner_id,
  p.name                                              as owner_name,

  -- instrument and label. classification_id is NOT NULL, so this is an inner
  -- join with no fallback for an unclassified instrument.
  i.id                                                as instrument_id,
  i.symbol                                            as symbol,
  i.name                                              as instrument_name,
  i.quote_type                                        as quote_type,
  i.price_source                                      as price_source,
  c.name                                              as classification,
  c.asset_class                                       as asset_class,

  -- the numbers. The sign lives in quantity, never in price (DESIGN.md §2).
  h.quantity                                          as quantity,
  q.price                                             as price,
  money.value                                         as value,
  h.cost_basis_per_share                              as cost_basis_per_share,
  money.cost_basis                                    as cost_basis,
  -- Null when EITHER side is null, which is what subtraction already does; a
  -- coalesce on either operand here would be the fake-gain bug. The cast is
  -- numerically a no-op — both operands are already at scale 4 — and is here to
  -- declare the column's type, so the row shape stays stable for whatever
  -- reuses it.
  cast(money.value - money.cost_basis
       as numeric(20, 4))                             as unrealized,

  -- Coverage, told honestly rather than as a zero. A row with is_priced false
  -- is missing from the sum and present in the count, so a total can be
  -- labelled "based on 8 of 12 holdings" instead of quietly understating.
  (q.price is not null)                               as is_priced,
  -- Unpriced is not stale: staleness is a property of a price that exists.
  coalesce(q.is_stale, false)                         as is_stale,

  -- Last, because the row type is a contract and a replacement may only append
  -- (see the header). Unlike every figure above it this one is never null here:
  -- a missing rate is a zero, by the rule the header states.
  money.annual_dividend                               as annual_dividend

from account a
join person p
  on p.id = a.owner_id
-- The whole "current" resolution, in one join condition.
join holding h
  on h.position_set_id = latest_position_set(a.id)
join instrument i
  on i.id = h.instrument_id
join classification c
  on c.id = i.classification_id
left join quote q
  on q.instrument_id = i.id
-- Rounded to the money scale exactly once, and named, so that `unrealized` is
-- literally `value - cost_basis` rather than a second rounding of a second
-- expression that could disagree with the first by a fraction of a cent. The
-- dividend belongs here for that same reason and not one line later: it is a
-- quantity at scale 8 by a rate at scale 4, so it needs the one declared
-- rounding down to the money scale exactly as `value` does.
cross join lateral (
  select
    cast(h.quantity * q.price                as numeric(20, 4)) as value,
    cast(h.quantity * h.cost_basis_per_share as numeric(20, 4)) as cost_basis,
    -- The coalesce, in the one place the figure is defined. A negative quantity
    -- carries through it unchanged, so a liability whose instrument ever
    -- carries a rate reports interest owed as a negative dividend rather than
    -- as income.
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


-- Replaced to keep the row type, and for nothing else: the historical answer is
-- unchanged and its new column is a constant.
--
-- There is no historical dividend anywhere to report. `quote` is one row per
-- instrument, overwritten on every refresh, and `price_daily` holds a close and
-- nothing else — so the rate behind today's projection is the only rate the
-- database has ever held. A projected forward dividend describes the portfolio
-- now; it is not a fact about 2019, and carrying today's figure back to a past
-- date is the same anachronism this function already refuses for `is_stale`.
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
    -- Not `coalesce(..., false)` over a column but the constant: there is no
    -- staleness to carry. See the header.
    false                                               as is_stale,
    -- Not `coalesce(..., 0)` over a column but the constant: there is no
    -- dividend to carry. See the header — the null is the answer here, not a
    -- gap in it, and it is what stops a past date reporting today's dividend.
    null::numeric(20, 4)                                as annual_dividend

  from account a
  join person p
    on p.id = a.owner_id
  -- The shared tie-break, bounded. `latest_position_set` is the only place
  -- `order by as_of_date desc, created_at desc, id desc` is written down, so the
  -- as-of answer cannot drift from the current one on a re-upload.
  join holding h
    on h.position_set_id = latest_position_set(a.id, d)
  join instrument i
    on i.id = h.instrument_id
  join classification c
    on c.id = i.classification_id
  -- The carry-forward. LEFT, for the same reason the view left-joins `quote`:
  -- an instrument with no close on or before `d` yields a null price and the
  -- holding STILL APPEARS, carrying is_priced = false. Inner-joining would make
  -- it vanish from every historical total silently.
  --
  -- Ordered descending on (instrument_id, date), which is the primary key of
  -- price_daily, so this is an index scan stopping at the first row.
  left join lateral (
    select pd.close
    from price_daily pd
    where pd.instrument_id = i.id
      and pd.date <= d
    order by pd.date desc
    limit 1
  ) daily on true
  -- Rounded to the money scale exactly once, and named, so that `unrealized` is
  -- literally `value - cost_basis` — the same construction as the view, for the
  -- same reason: two roundings of two expressions can disagree by a fraction of
  -- a cent, and two figures for one holding is the drift all of this exists to
  -- prevent. No dividend in here: it is the constant above, not a product.
  cross join lateral (
    select
      cast(h.quantity * daily.close             as numeric(20, 4)) as value,
      cast(h.quantity * h.cost_basis_per_share  as numeric(20, 4)) as cost_basis
  ) money

  -- `closed_at` is a timestamptz and `d` a date; the comparison promotes `d` to
  -- midnight, so an account closed at any time during `d` is still counted on
  -- `d` (it was held for part of that day) and excluded from `d + 1` onward.
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
