# Portfolio Tracker

A self-hosted family portfolio and net worth tracker. See [DESIGN.md](DESIGN.md) for the full
design — domain model, ingest, pricing, screens, stack, and the accepted limitations.

## Running an instance

```sh
docker compose up -d
```

That is the whole procedure on a fresh machine. Postgres comes up, the app waits for it to report
healthy, and the instance is on <http://localhost:3000>. There is no manual setup step.

Every setting is an environment variable and every one of them is documented in
[`.env.example`](.env.example) with its default. Copy it to `.env` only if you want to change
something. Configuration is validated once at startup: a missing or malformed value stops the
container immediately with a message naming the variable.

`GET /healthz` returns 200 while the instance is genuinely serving and a non-200 when it is not.
It never requires authentication, so monitoring needs no credentials.

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

`./scripts/smoke-test.sh` is the container smoke test CI runs: it brings the stack up against an
empty volume, waits for the app healthcheck, requests `/healthz`, restarts the app, and checks the
runtime image contains what it is meant to and nothing it is not. It is slow and is not where
behaviour gets tested.

## A note on money

The Postgres driver is configured to return `numeric` as **strings**, because its default is to
coerce them into JavaScript numbers, which silently rounds. Every money and quantity value therefore
crosses the application boundary as a decimal string. Do the arithmetic in SQL, or in a decimal
library — never `Number()`, `parseFloat`, or a JSON round trip as a number.
