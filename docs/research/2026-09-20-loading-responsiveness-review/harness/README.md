# Loading and responsiveness harness

Evidence for the [20 September report](../../2026-09-20-loading-responsiveness-review.md),
not an application dependency or a production monitoring tool.

## Contents and preservation

| File | Purpose |
|---|---|
| `measurements.json` | Original browser resource/timing records and direct HTTP measurements |
| `formatter-comparison.json` | Original seven-pair formatter A/B results after warmups |
| `chart-precision-results.json` | Original geometry size estimates and preservation assertions |
| `measure.mjs` | Direct HTTP checks, then one cold/repeat browser pair for each of three pages |
| `compare-formatters.mjs` | Alternate requests between baseline and instrumented production processes |
| `reuse-formatters.mjs` | Diagnostic process-local constructor interception; never use in normal startup |
| `chart-precision.mjs` | Read one HTML response, transform geometry in memory, assert invariants and print JSON |

The three JSON records retain the original values; publication adds a final newline to the two
files that lacked one. Publication edits only made scripts
portable: package-based Playwright imports, optional browser/origin configuration, a normal `node`
command in the example, and explicit output directories with exclusive file creation. The browser
script now labels the original fixture counts `referenceDataset`: it does not query current counts.
Timing loops, throttling, geometry transforms and A/B interception are unchanged.

`measure.mjs` and `compare-formatters.mjs` require an existing output directory and refuse to
overwrite a result file. Keep reruns outside this directory; original evidence must not silently
become a measurement of another revision. `chart-precision.mjs` prints its result to stdout.

## Safety and prerequisites

Use only a new disposable database. `seed-demo.ts` replaces demo data, and
`scale-observations.sql` deletes the observation log. The existing scale scripts guard the database
name, but a suffix is not permission to use someone else's database. The commands below create
a dedicated loopback-only, tmpfs-backed PostgreSQL container. Do not replace its database URL
with a household or shared database.

Need Node 24.12+ (the original run used 24.21.0), npm, Docker and Chromium for Playwright.
Run `npm ci` in the report checkout so `measure.mjs` can resolve Playwright. Either install the
matching browser with `npx playwright install chromium`, or set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an already-installed compatible executable. The original
run used Chromium headless shell from Playwright's local browser cache.

Record the revision, Node/browser/package versions, date and actual fixture counts on a rerun.
Do not claim the stored timings reproduce exactly: hardware, caches and date-dependent fixture
content vary. `days=92` means calendar days; the original run produced 66 weekday sessions.

## 1. Prepare the measured application

These examples use fixed new paths, ports and a container name. Check that they are unused;
creation failing because one exists is a reason to choose a new name, not delete the existing one.
Run the first block from the checkout containing this report:

```sh
npm ci
export REVIEW_HARNESS="$PWD/docs/research/2026-09-20-loading-responsiveness-review/harness"
git worktree add --detach /tmp/portfolio-loading-replay-20260920 705e758d424b52f61addf8e5c20323f8c544b0c0
cd /tmp/portfolio-loading-replay-20260920
npm ci
npm run build
```

The harness remains in the report checkout; the app runs the pinned revision in the disposable
checkout. To investigate current code instead, use a separate checkout of that revision and record
the difference. The report's measured revision included icon PR #364, not just its `main` base.

## 2. Create and seed an isolated database

From the application checkout:

```sh
docker run --detach --rm --name portfolio-loading-replay-20260920-db \
  --tmpfs /var/lib/postgresql/data \
  --publish 127.0.0.1:55439:5432 \
  --env POSTGRES_USER=portfolio --env POSTGRES_PASSWORD=portfolio \
  --env POSTGRES_DB=portfolio_perf_bench postgres:17-alpine
docker exec portfolio-loading-replay-20260920-db pg_isready -U portfolio -d portfolio_perf_bench
```

Wait until `pg_isready` succeeds before continuing. The password above is solely for this new
throwaway container. It is not a deployment credential.

```sh
export DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55439/portfolio_perf_bench
export PUBLIC_ORIGIN=http://localhost:3417
export AUTH_GATE=external
node server/migrate.ts
node scripts/seed-demo.ts
docker exec -i portfolio-loading-replay-20260920-db \
  psql -U portfolio -d portfolio_perf_bench -v ON_ERROR_STOP=1 \
  < docs/research/2026-09-01-overview-1d-latency/harness/scale-shape.sql
docker exec -i portfolio-loading-replay-20260920-db \
  psql -U portfolio -d portfolio_perf_bench -v ON_ERROR_STOP=1 -v cadence=15 -v days=92 \
  < docs/research/2026-09-01-overview-1d-latency/harness/scale-observations.sql
```

Run the scale shape once, on the fresh seed. The reused
[scale harness documentation](../../2026-09-01-overview-1d-latency/harness/README.md) explains its
guards and fixture. Do not start a price worker for this run. The app has background scheduling;
keep the fixture stationary and stop both app processes promptly after the measurements.

## 3. Start two production processes

In two separate terminals, from the pinned application checkout. Keep both in the foreground so
each can be stopped with Ctrl-C. The second terminal needs `REVIEW_HARNESS` set to the same absolute
report-harness directory exported above; set it explicitly if the terminal did not inherit it.

Baseline:

```sh
NODE_ENV=production HOST=127.0.0.1 PORT=3417 \
DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55439/portfolio_perf_bench \
PUBLIC_ORIGIN=http://localhost:3417 AUTH_GATE=external \
node node_modules/@react-router/serve/dist/cli.js ./build/server/index.js
```

Instrumented, changing only formatter construction in this process:

```sh
NODE_ENV=production HOST=127.0.0.1 PORT=3418 \
DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55439/portfolio_perf_bench \
PUBLIC_ORIGIN=http://localhost:3418 AUTH_GATE=external \
node --import "$REVIEW_HARNESS/reuse-formatters.mjs" \
  node_modules/@react-router/serve/dist/cli.js ./build/server/index.js
```

Use `NODE_ENV=production` for both; omitting it can mix development and production React exports.
These servers intentionally bypass the deployed gate and must stay bound to loopback.

## 4. Collect a new run

In the terminal that exported `REVIEW_HARNESS`:

```sh
REVIEW_OUTPUT=$(mktemp -d /tmp/portfolio-loading-results.XXXXXX)
node "$REVIEW_HARNESS/measure.mjs" "$REVIEW_OUTPUT"
node "$REVIEW_HARNESS/compare-formatters.mjs" "$REVIEW_OUTPUT"
node "$REVIEW_HARNESS/chart-precision.mjs" 'http://127.0.0.1:3417/?range=1d' 1620
```

The first two commands save new JSON in `REVIEW_OUTPUT`; the last prints JSON and asserts the
expected 1,620 hit targets, readout equality, point counts, edge precision and total target width.
Do not redirect it over the committed `chart-precision-results.json`.

The timing scripts default to baseline `http://127.0.0.1:3417` and instrumented
`http://127.0.0.1:3418`. If ports must change, use `REVIEW_BASELINE_ORIGIN` and
`REVIEW_REUSED_ORIGIN` and adjust the server commands and geometry URL too.

Formatter results must have `sameHtml: true` for every range before treating timings as an A/B
comparison of equivalent output. If labels or fixture data change between requests, investigate
before drawing a speed conclusion. Geometry estimates must not be described as observed wire
savings: local compression does not reproduce the server's streaming flush behavior.

The pending-navigation screenshot came from a separate manual browser check: load 1W, hold the
next `*.data*` response, select 1D, inspect active-range and busy/status feedback, then release the
response. It is not produced by these timing scripts.

## 5. Cleanup

Stop both foreground app processes with Ctrl-C first. Then stop only the container created above:

```sh
docker stop portfolio-loading-replay-20260920-db
```

Because it used `--rm` and tmpfs, stopping it removes the container and permanently discards its
synthetic database. Keep the new result directory if needed. The disposable application checkout
and installed dependencies remain for inspection; remove that exact worktree separately only when
finished with it. Never apply cleanup commands to an existing household database or another worktree.
