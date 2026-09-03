# 03 — Deploy the worker alongside the still-fetching app

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.1, §4)._

**What to build:** The compose changes that put the worker into production *without touching the
app*: the `worker` service, its two networks (`worker-db`, `egress-worker`), and the smoke coverage.
The app keeps fetching in-process; the worker drains a mailbox nothing writes to yet. Every deploy
from this commit still refreshes prices, which is what lets ticket 04 be a clean cutover rather than
a coupled release.

Because the worker fetches nothing until cutover, "it started" is no evidence. The smoke test seeds
a `fetch_request` and asserts the worker answers it — that is what this ticket proves.

**Blocked by:** 02.

**Status:** ready-for-agent

**The service**

- [ ] Same image as `app`, `entrypoint: ["node", "./server/price-worker.ts"]` (overriding the image
      ENTRYPOINT at `Dockerfile:131`, which would run migrations as a role that cannot)
- [ ] `restart: unless-stopped` — a worker left stopped after a daemon restart is the sole
      price-fetcher silently gone
- [ ] `logging: *container-logging` — every service carries the anchor (`compose.yaml:38-42`); one
      without it logs unbounded
- [ ] Full hardening copied: `cap_drop: ALL`, `no-new-privileges`, `read_only`, tmpfs, non-root
- [ ] Healthcheck is a DB-connect probe only — deliberately not provider reachability
      (`app/routes/healthz.ts:9`'s reason: a Yahoo outage must not have Compose restart a healthy
      worker). It runs in a `read_only` container with no script mounted, so it is a `node -e`
      one-liner over `pg`; `dump` got a mounted script for the equivalent job (`compose.yaml:179`)
      and this one is small enough not to. It counts against the role's connection limit.
- [ ] `depends_on: app: condition: service_healthy` — app healthy implies migrations applied, and
      Compose evaluates the condition daemon-side, so no shared network is needed
- [ ] `DATABASE_URL` from `WORKER_DB_PASSWORD` (`:?` required) naming `portfolio_worker`;
      `MARKET_TIMEZONE` and `TZ` follow the app's defaults

**The networks (partial topology — the lockdown is ticket 04)**

- [ ] `worker-db` (internal) and `egress-worker` (bridge) declared; `worker` on both. There is no
      `networks:` key anywhere in `compose.yaml` today — this is the first.
- [ ] **`db` must be written `networks: [default, worker-db]`.** Declaring any per-service
      `networks:` key detaches the implicit `default` bridge, so `networks: [worker-db]` alone would
      sever `app → db`, `dump → db` and the migration runner at this commit. Every other service
      stays untouched and therefore stays on `default`.
- [ ] The worker shares no network with `app` or `gate`

**Dev and smoke**

- [ ] `compose.dev.yaml` gains a `worker` override reusing the locally built `portfolio-app:dev`
      image with `pull_policy: build`, exactly as its `app` override does (`:14-21`) — without it,
      smoke pulls a GHCR release that lacks `server/price-worker.ts` and certifies stale code
- [ ] `smoke-test.sh`: `worker` added to every hardcoded service list — the teardown log dump
      (`:71`), `expect_caps worker "" 0000000000000000` (`:342-350`), the no-new-privileges loop
      (`:365`), `expect_uid worker 1000` (`:379-385`), the read-only-root loop (`:401`) — and to the
      published-port group (`:277-300`), which must show no `HostPort`
- [ ] **The assertion that matters:** insert a `fetch_request` row directly and assert the worker
      claims it and writes `answered_at` within a bounded wait. Seed a `probe` for a symbol that
      does not exist, so an unreachable feed still writes `error` and `answered_at` — the assertion
      proves the drain loop and the Dockerfile copy set, and deliberately proves nothing about
      egress. Say so in the test's comment; ticket 04 asserts egress.
- [ ] `app:3000` and `gate:4180` are unreachable from the worker; `db:5432` connects

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build`, `scripts/smoke-test.sh` green
