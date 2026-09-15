-- Same-date latest-position ordering follows serialized inserts, including caller-owned transactions.
alter table position_set
  alter column created_at set default statement_timestamp();
