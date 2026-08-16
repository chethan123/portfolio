# Portfolio Tracker

A self-hosted family portfolio and net worth tracker. See [DESIGN.md](DESIGN.md) for the full
design — domain model, ingest, pricing, screens, stack, and the accepted limitations.

## Running an instance

```sh
docker compose up -d
```

That is the whole procedure on a fresh machine. Postgres comes up, the app waits for it to report
healthy, applies the schema, and only then starts serving on <http://localhost:3000>. There is no
manual setup step and no migration to run by hand — migrations are idempotent, so restarting the
container is always safe.

Every setting is an environment variable and every one of them is documented in
[`.env.example`](.env.example) with its default. Copy it to `.env` only if you want to change
something. Configuration is validated once at startup: a missing or malformed value stops the
container immediately with a message naming the variable.

`GET /healthz` returns 200 while the instance is genuinely serving and a non-200 when it is not —
which includes the case where the database is reachable but a migration shipped in the image has
never been applied. It never requires authentication, so monitoring needs no credentials.

The app serves plain HTTP. TLS termination is your reverse proxy's job.

## Working on it

Requires Node 24.

```sh
npm install
npm run dev            # http://localhost:5173

npm run typecheck      # the runtime strips types without checking them
npm run build
```

Tests run against a real Postgres — the risk this codebase carries lives in Postgres-specific SQL
and `numeric` handling, both of which disappear under a mock.

```sh
docker compose -f compose.test.yaml up -d --wait
npm test
docker compose -f compose.test.yaml down -v
```

Integration tests seed through the fixture builder in [`tests/support/fixtures.ts`](tests/support/fixtures.ts) —
`seedPerson`, `seedAccount`, `seedPositionSet`, `seedQuote`, `seedDailyClose` — and run inside a transaction that is
always rolled back, so no test can see another's rows and ordering never matters. Wrap a test body
in `withDatabase` to get both. Raw `INSERT` statements belong in the builder and nowhere else; that
is what keeps a schema change from rewriting every test.

## Reading what is held

[`app/lib/valuation.server.ts`](app/lib/valuation.server.ts) is the only thing that reads the
`holding_valued` view and its as-of companion `holding_valued_at(d date)`, and it is the seam every
screen reads through:

```ts
currentHoldings()          // every holding held right now, valued
netWorth()                 // one SUM, plus how many holdings it was computed from
holdingsAt('2026-02-14')   // the same, for any past date
netWorthAt('2026-02-14')   // dates are 'YYYY-MM-DD' strings, both directions
```

DESIGN.md §8.2 names three dashboards drifting on the definition of "current holdings" as the
weakest point in the design; the view and this one module over it are the mitigation. A screen that
writes its own join over `holding` has left it. Partial data is reported as partial — an unpriced
holding still appears with `isPriced: false`, is left out of the total, and is counted in the
total's `coverage`, so a figure can be labelled "based on 8 of 12 holdings" rather than quietly
understated.

The as-of pair is not a second definition: `holding_valued_at` is declared `returns setof
holding_valued`, so it has the view's row type, and both resolve "which position set" through the
same `latest_position_set` function. It varies only what must vary — the position set is the newest
at or before the date, an account counts until its `closed_at`, and the price is the last
`price_daily` close at or before the date rather than the live quote. That carry-forward is why a
Saturday is worth what Friday closed at, and why cash prices at 1.00 on any date at all. An account
with no upload at or before the date contributes no rows rather than a zero: history starts at the
first upload (DESIGN.md §7).

## Migrations and database types

The database is the source of truth. A migration is a plain `.sql` file in [`migrations/`](migrations),
applied in filename order, each inside a transaction, with the applied filenames recorded in a
`schema_migrations` table. Re-running skips what is already recorded, which is why a restart is
always safe. The runner is a standalone TypeScript file run directly under Node's type stripping —
no build step — and exits non-zero on failure, which is what stops the container from starting the
server against a half-migrated schema.

```sh
docker compose -f compose.test.yaml up -d --wait
DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_test npm run migrate
```

### Adding a migration

1. Add `migrations/NNNN_what_it_does.sql` with the next zero-padded number. Filename order is
   apply order.
2. Apply it to a throwaway database, as above.
3. **Regenerate the database types.** This is a required step, not an optional one — Kysely is typed
   against [`app/lib/database.generated.ts`](app/lib/database.generated.ts), which `kysely-codegen`
   derives from the *live* database, views included, so `holding_valued` is typed like a table.
   The generated file is committed; nothing regenerates it for you.

   ```sh
   npm run db:types      # against the test database above by default
   ```

   Point it elsewhere with `DATABASE_URL=… npm run db:types`. Never hand-edit the generated file.
4. `npm run typecheck` — this is where a migration that broke a query surfaces.

`./scripts/smoke-test.sh` is the container smoke test CI runs: it brings the stack up against an
empty volume, waits for the app healthcheck, requests `/healthz`, restarts the app, and checks the
runtime image contains what it is meant to and nothing it is not. It is slow and is not where
behaviour gets tested.

## A note on money

The Postgres driver is configured to return `numeric` as **strings**, because its default is to
coerce them into JavaScript numbers, which silently rounds. Every money and quantity value therefore
crosses the application boundary as a decimal string. Do the arithmetic in SQL, or in a decimal
library — never `Number()`, `parseFloat`, or a JSON round trip as a number.

`date` is returned as a `YYYY-MM-DD` string for the same reason: the driver's default parses a
calendar date into a `Date` at *local* midnight, so formatting it back west of UTC gives the
previous day — and a statement's as-of date shifting by a day selects the wrong position set.
`timestamptz` is left alone; `created_at`, `closed_at` and `quote.as_of` are genuine instants.
