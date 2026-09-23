-- At most one open account records a given account number (ADR-0015). Supersedes 0001's "never a
-- selector" on external_account_number: a guard on a single-account upload, the selector on a
-- multi-account one, where two open accounts sharing a number would leave a row's account a guess.
-- Closed accounts are outside it: nothing is routed to one.
-- Trimmed first, a blank as none: the router compares trimmed numbers (decision 15), so " A-1" and
-- "A-1" are one number to it and must be one to the index. btrim's second argument is ASCII
-- whitespace; anything else the router's shared-number refusal catches. The raise below rolls this
-- back too.
update account
   set external_account_number = nullif(btrim(external_account_number, E' \t\r\n\f\v'), '')
 where external_account_number
       is distinct from nullif(btrim(external_account_number, E' \t\r\n\f\v'), '');

-- Duplicates already recorded are named, not chosen between. The index alone would fail naming a
-- number but no account. Read in a crash-looping server's log (docker-entrypoint.sh migrates
-- before it serves), so it says what to run.
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
      'Nothing was changed. Keep each number on one of its accounts and clear it from the others '
      'by running, once per account to clear: '
      'update account set external_account_number = null where id = <id>; '
      'then start the application again.', duplicates;
  end if;
end
$$;

create unique index account_open_number_unique on account (external_account_number)
  where closed_at is null and external_account_number is not null;
