-- Line breaks out of numbers captured before statement.ts stripped them (#312). A quoted CSV cell
-- may hold a CR or an LF, and an upload used to write one straight onto the account. Such a row
-- cannot be saved from the settings form at all -- the box drops the break, the parser folds the
-- CR, and the compare-and-set predicate matches neither value -- and uploads.server.ts refuses the
-- account's own next statement, since the file's cell is now canonicalised and the column is not.
-- Same rule as the parser's, so both sides of that check read one spelling again.

-- Open accounts this would fold into one number are named, not chosen between, as 0015 names the
-- duplicates it will not index. 0015 btrims the ends only, so an interior break survives it and
-- account_open_number_unique is built over both spellings; taking that break out below makes them
-- one number, and the index would refuse the update naming a key and no account, in the log of a
-- server that then crash-loops (docker-entrypoint.sh migrates before it serves). The folded number
-- is named rather than either stored one: the stored ones differ, and the folded one is what they
-- would collide on. Closed accounts are outside the index, so they fold freely.
do $$
declare
  duplicates text;
begin
  select string_agg(format('"%s" on %s', number, holders), '; ' order by number)
    into duplicates
  from (
    select folded as number,
           string_agg(format('%s (id %s)', name, id), ', ' order by id) as holders
    from (
      select id, name, nullif(translate(external_account_number, E'\r\n', ''), '') as folded
      from account
      where closed_at is null and external_account_number is not null
    ) as folded_accounts
    where folded is not null
    group by folded
    having count(*) > 1
  ) as shared;

  if duplicates is not null then
    raise exception 'Open accounts record account numbers that are one number once their line '
      'breaks come out, and at most one may record each: %. Nothing was changed. Keep each number '
      'on one of its accounts and clear it from the others by running, once per account to clear: '
      'update account set external_account_number = null where id = <id>; '
      'then start the application again.', duplicates;
  end if;
end
$$;

-- nullif because the domain has no "": a value that was only breaks would arm the upload's guard
-- against a number the form could never clear, both sides normalising it back to absent.
update account
set external_account_number = nullif(translate(external_account_number, E'\r\n', ''), '')
where external_account_number ~ E'[\r\n]';
