-- The same answer as `holding_valued`, for any date in the past.
--
-- Positions are constant between uploads by construction (DESIGN.md §7: there
-- is no position backfill and no per-transaction ledger), so net worth on a past
-- date is that date's positions priced at that date's close. That is the whole
-- idea, and this function is the whole implementation of it.
--
-- A plain view cannot be parameterised, so this is a set-returning function
-- (DESIGN.md §8.2). What matters is that it is not a SECOND definition of
-- "holdings, valued": it returns `setof holding_valued`, so the row type is
-- literally the view's row type and adding a column there forces this to move
-- with it, and it resolves "which position set" through
-- `latest_position_set(a.id, d)` rather than repeating the tie-break ordering.
--
-- Exactly three things differ from the view, and each is a decision:
--
--   * The position set is the greatest `as_of_date <= d` per account, via the
--     shared helper's `p_as_of` bound. An account with no set at or before `d`
--     contributes NO rows — not a zero. That is "history starts at day zero"
--     (DESIGN.md §7) made mechanical: the earliest date with any value is the
--     first upload, and nothing before it is invented. The pre-app period is the
--     `manual_networth` series' job, not this function's.
--   * An account is included when `closed_at is null or closed_at > d`, so it
--     counts on the dates it was open and stops counting after it closed.
--     History before a closure is preserved; today's figures are not polluted.
--   * The price is the greatest `price_daily.close` at or before `d` — the
--     carry-forward — rather than the live `quote`. Non-trading days get no
--     `price_daily` row at all (DESIGN.md §6.2), so a Saturday resolves to
--     Friday's close, a Sunday to the same Friday, and a market holiday to the
--     trading day before it, with no calendar table anywhere. `is_stale` is
--     reported false: staleness describes a live quote that failed to refresh,
--     and a historical close is simply the close.
--
-- Cash and liabilities need no branch here either, and specifically none for
-- dates before the app existed. `USD` is seeded with a `1970-01-01` close of
-- 1.00 by the initial migration, so the same carry-forward that turns Friday
-- into Saturday turns 1970 into 1999: a bank balance queried at any date the
-- system is asked about prices at 1.00, through the ordinary path.


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
    -- Not `coalesce(..., false)` over a column but the constant: there is no
    -- staleness to carry. See the header.
    false                                               as is_stale

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
  -- prevent.
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
  'price_daily so a non-trading day takes the previous close.';
