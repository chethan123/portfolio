-- Same-date latest_position_set ordering must follow the serialized account write order even when
-- a caller supplied a transaction that began earlier. now() is the transaction start; this is the
-- start of the INSERT statement, which runs only after the account row lock has been acquired.
alter table position_set
  alter column created_at set default statement_timestamp();
