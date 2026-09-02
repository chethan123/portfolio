# The 1D latency harness

The scripts every number in
[`../../2026-09-01-overview-1d-latency.md`](../../2026-09-01-overview-1d-latency.md) came from, kept
so a reader can reproduce them rather than trust them. They are evidence, not part of the
application: nothing in `app/`, `server/` or `tests/` imports them, and nothing runs them in CI.
`npm run typecheck` does compile `time-overview.ts`, because `tsconfig.json` includes every `.ts`
file, and that coupling is kept on purpose: a harness that no longer compiles against the modules
it times is evidence that has rotted, and a signature change to `chartSeries` or `chartReach`
should fail there rather than the next time somebody reruns this.

The two scripts that write refuse any database whose name does not end in `_test`, `_demo` or
`_bench` — `scale-shape.sql` inserts accounts and instruments beside the household's own, and
`scale-observations.sql` deletes the whole observation log — and `scale-shape.sql` also refuses a
database it has already scaled. A refusal is an error exit, so a chained command stops with it.
The guard is written out in both rather than included from one file, because `\quit` inside an
included script ends only the include. The two query files and `compare.sql` only read, so they
carry no guard and can be pointed at any database whose 1D line is in doubt.

| File | What it is |
|---|---|
| `scale-shape.sql` | clones the demo seed up to 21 open accounts, 97 holdings, 98 feed instruments |
| `scale-observations.sql` | regenerates the observation log at `:cadence` minutes over `:days` sessions, each instrument carrying its own seconds on `as_of` |
| `session-current.sql` | the 1D series as `readSessionSeries` computed it at `46d65df`, before spec 0016, `:'session'` as the parameter |
| `session-rewrite.sql` | the same series as the running total spec 0016 approves |
| `compare.sql` | both into temporary tables, `except` both ways |
| `time-overview.ts` | every query the Overview loader runs, in the loader's two waves, timed |

`session-current.sql` and `session-rewrite.sql` take an optional `prefix` variable that is emitted
in front of the select — `create temp table … as` is how `compare.sql` captures the rows, and
`explain (analyze, buffers)` is how a plan is taken.

## Reproducing, from an empty throwaway database

```sh
psql postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_test -c 'create database portfolio_bench'
printf 'DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_bench\n' > .env.bench
node --env-file=.env.bench ./server/migrate.ts
node --env-file=.env.bench ./scripts/seed-demo.ts       # its header explains what it refuses

DB=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_bench
H=docs/research/2026-09-01-overview-1d-latency/harness

psql "$DB" -f $H/scale-shape.sql                        # once, on a fresh seed
psql "$DB" -v cadence=15 -v days=1 -f $H/scale-observations.sql

SESSION=$(psql "$DB" -tAc 'select max(market_date) from price_observation')

DATABASE_URL=$DB node $H/time-overview.ts 1d 1y         # the loader's queries, wave by wave
psql "$DB" -v session=$SESSION -f $H/compare.sql        # 0 differences, both ways

psql "$DB" -v session=$SESSION -v prefix='explain (analyze, buffers)' -f $H/session-current.sql
psql "$DB" -v session=$SESSION -v prefix='explain (analyze, buffers)' -f $H/session-rewrite.sql
```

`scale-shape.sql` runs once per seed and refuses a database it has already scaled: a second run
would add fifteen more accounts and multiply the feed instruments by seven. `scale-observations.sql`
replaces the whole log, so re-run it to change either dial:

```sh
psql "$DB" -v cadence=1  -v days=1   -f $H/scale-observations.sql   # 23,460 instants in the session
psql "$DB" -v cadence=15 -v days=250 -f $H/scale-observations.sql   # 178 trading sessions, 470,988 rows
psql "$DB" -v cadence=15 -v days=350 -f $H/scale-observations.sql   # 250 trading sessions, 661,500 rows: the first run's log
```

The year of sessions is what the plan check needs: on one session the log is small enough that
Postgres sequentially scans it whatever the query says, and the `changes` join only shows its index
scan on `price_observation_pkey` once there is a log to avoid reading. Put the log back to
`-v days=1` before timing a cadence, so the two dials are not moving at once.

Timings print because both query files set `\timing on`; send the rows away with `-o /dev/null`
when the number is what you are after.
