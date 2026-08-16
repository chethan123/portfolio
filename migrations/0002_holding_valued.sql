-- The one shared answer to "what do I hold right now, and what is it worth".
--
-- DESIGN.md §8.2 names three hand-rolled dashboard queries disagreeing as the
-- weakest point in the whole design. This view plus the single query module over
-- it is the entire mitigation: every consumer resolves "current holdings"
-- here, or it drifts.
--
-- The rules encoded below, each of which is a decision rather than an accident:
--
--   * "Latest" is max(as_of_date) per account, tie-broken by created_at
--     descending then id descending. Re-uploading a correction for an as-of date
--     that already has a set is a real occurrence, and without the tie-break the
--     answer is a coin flip.
--   * Accounts with a non-null closed_at are excluded. The filter lives here,
--     not in each consumer — putting it in the consumers is exactly the drift
--     this view exists to prevent.
--   * The join to `quote` is a LEFT join. An instrument that has never been
--     priced yields a null price and a null value and the row STILL APPEARS,
--     carrying is_priced = false. Inner-joining would make the holding vanish
--     from every total silently, which is the understatement this design
--     refuses everywhere.
--   * value, cost_basis and unrealized are computed in SQL, and null
--     propagates. Nothing here coalesces a null cost basis to zero — that would
--     report a fake gain equal to the entire untracked position.
--   * is_stale is carried through unchanged. A stale price is USED, not
--     discarded: the last known value beats a zero or a null.
--
-- There is no branch for cash and no branch for liabilities. A bank balance is a
-- USD position priced at 1.00 and a personal loan is a negative USD quantity
-- against that same positive price, so net worth is one SUM over `value`
-- (DESIGN.md §2).


-- ---------------------------------------------------- the "latest" tie-break --

-- Which position set speaks for an account, defined exactly once.
--
-- `p_as_of` bounds the search: null means "no bound", which is what the current
-- view wants, and a date means "at or before this date", which is what the
-- as-of function will want. Sharing the ordering is the point — a second copy
-- of `order by as_of_date desc, created_at desc, id desc` living somewhere else
-- is a tie-break free to drift from this one.
--
-- The ordering matches position_set_account_as_of_idx exactly, so this is an
-- index scan stopping at the first row.
--
-- STABLE, not IMMUTABLE: it reads tables.
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


-- ------------------------------------------------------------ holding_valued --

-- Plain, NOT materialised (DESIGN.md §8.2). The data changes on upload, a
-- household's portfolio is small, and a materialised view would introduce a
-- refresh step whose omission shows up as silently stale totals.
--
-- The column list below is a contract in two directions: the query module reads
-- these names, and the as-of function can declare `returns setof holding_valued`
-- — a view has a row type, so the historical answer reuses this shape rather
-- than forking it, and adding a column here forces both to move together. What
-- that function then varies is only what must vary: `latest_position_set(a.id,
-- d)` instead of `latest_position_set(a.id)`, `closed_at is null or closed_at >
-- d` instead of `closed_at is null`, and the greatest `price_daily` close at or
-- before `d` instead of `quote.price`.
--
-- Money is numeric(20,4) throughout, matching every stored money column
-- (DESIGN.md §4.1). quantity is numeric(20,8), so the product carries scale 12
-- and is cast back down to the money scale once, here, in SQL — never in
-- JavaScript, and never by a float.
create view holding_valued as
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
  coalesce(q.is_stale, false)                         as is_stale

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
-- expression that could disagree with the first by a fraction of a cent.
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
