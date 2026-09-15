-- Stamped at the insert, not at BEGIN: a writer that waited for the account lock (ARCHITECTURE.md
-- §7.2) would otherwise date its set before the one it copied and lose the same-date tie-break to it.
alter table position_set
  alter column created_at set default statement_timestamp();
