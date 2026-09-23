-- At most one open account records a given account number (ADR-0015). Supersedes 0001's "never a
-- selector" on external_account_number: a guard on a single-account upload, the selector on a
-- multi-account one, where two open accounts sharing a number would leave a row's account a guess.
-- Closed accounts are outside it: nothing is routed to one.
-- Duplicates already recorded are named, not chosen between. The index alone would fail naming a
-- number but no account.
do $$
declare
  duplicates text;
begin
  select string_agg(format('"%s" on %s', number, holders), '; ' order by number)
    into duplicates
  from (
    select external_account_number as number,
           string_agg(format('%s (id %s)', name, id), ', ' order by id) as holders
    from account
    where closed_at is null and external_account_number is not null
    group by external_account_number
    having count(*) > 1
  ) as shared;

  if duplicates is not null then
    raise exception 'Open accounts share an account number, and at most one may record each: %. '
      'Clear it from all but one of them in Settings, under the version this upgrade replaced, '
      'then upgrade again.', duplicates;
  end if;
end
$$;

create unique index account_open_number_unique on account (external_account_number)
  where closed_at is null and external_account_number is not null;
