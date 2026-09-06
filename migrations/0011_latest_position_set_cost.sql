-- Costed high: keeps the planner from hash-joining this call, ~2x faster reads (docs/research/2026-09-01-overview-1d-latency).
-- `create or replace` resets procost to the default -- a pinned test in tests/migrations.test.ts guards it.
alter function latest_position_set(bigint, date) cost 1000;
