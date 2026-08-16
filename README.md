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
