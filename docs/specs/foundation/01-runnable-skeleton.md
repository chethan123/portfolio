# 01 — Runnable skeleton: image, Compose, `/healthz`, app shell

_Part of [0001-foundation-day-zero.md](../0001-foundation-day-zero.md)._

**What to build:** A self-hoster clones the repo, runs `docker compose up` on a fresh machine with
an empty data directory, and gets a working instance with no manual steps. Postgres comes up, the
app waits for it, and `/healthz` answers 200. Opening the published port in a browser shows the
application with its navigation in place. Nothing is stored yet — this is the tracer bullet that
proves the whole deployment path end to end before there is a schema to put in it.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

> **Amended after shipping.** Ingress now runs through a bundled `caddy` service, so two criteria
> below no longer describe the deployment: there are three services rather than two, and `app`
> publishes no port at all — `caddy` is the only one that does. The criteria are left as written
> because they record what this slice was asked to build; DESIGN.md §10.1 is the current topology.

- [ ] `docker compose up` on a fresh machine with an empty volume produces a working instance with
      no manual steps
- [ ] Two services only: `db` on `postgres:17-alpine` and `app` built from the repo
- [ ] `db` has a `pg_isready` healthcheck and its port is not published to the host by default
- [ ] `app` starts only once `db` reports healthy, publishes one port, restarts unless stopped, and
      has a `/healthz` healthcheck
- [ ] One named volume holds all Postgres data; the app container writes nothing to its own
      filesystem
- [ ] Three-stage image: dependency install from the lockfile alone, client and server build, then a
      `node:24-slim` runtime containing production dependencies and build output only
- [ ] The runtime stage runs as a non-root user and contains no compiler, no dev dependencies and no
      source tree
- [ ] Changing only source code rebuilds without reinstalling dependencies
- [ ] `GET /healthz` returns 200 while the database is reachable and a non-200 when it is not
- [ ] Every setting is an environment variable, validated once at startup against a schema; the
      process exits with a readable message naming the offending variable
- [ ] The full environment surface is documented with defaults: `DATABASE_URL`, `SESSION_SECRET`,
      `AUTH_PASSWORD`, `PORT`, `PRICE_POLL_INTERVAL_MINUTES`, `MARKET_TIMEZONE`, `TZ`
- [ ] `PRICE_POLL_INTERVAL_MINUTES` and `MARKET_TIMEZONE` are parsed and validated even though
      nothing reads them yet, so the configuration surface is complete from the first release
- [ ] The connection pool is constructed in exactly one place, with a type-parser override making
      the driver return `numeric` as strings
- [ ] A test asserts a `numeric` value round-trips as a decimal string at full scale, not as a
      JavaScript number
- [ ] The container clock and the database both use UTC
- [ ] The browser shows navigation in the order Overview, Holdings, Income, Upload, Settings, with
      stub routes behind each
- [ ] `tsc --noEmit` runs in CI, since the runtime strips types without checking them
- [ ] A CI-only smoke test brings the stack up against an empty volume, waits for the `app`
      healthcheck and requests `/healthz`
