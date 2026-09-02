-- Equivalence: run both statements into temporary tables and `except` them
-- both ways. Zero on both sides is the claim the rewrite rests on — same
-- instants, same amounts to the last digit, same coverage.
--
--   psql "$DATABASE_URL" -v session=2026-09-01 -f compare.sql
--
-- Reads only (the two temporary tables are this session's), so it carries no
-- throwaway guard and can be pointed at any database whose 1D line is in
-- doubt.
\set ON_ERROR_STOP on

\set prefix 'create temp table current_series as'
\ir session-current.sql

\set prefix 'create temp table rewrite_series as'
\ir session-rewrite.sql

\unset prefix
\timing off

select
  (select count(*) from current_series) as current_rows,
  (select count(*) from rewrite_series) as rewrite_rows,
  (select count(*) from (select * from current_series except select * from rewrite_series) d) as in_current_only,
  (select count(*) from (select * from rewrite_series except select * from current_series) d) as in_rewrite_only;
