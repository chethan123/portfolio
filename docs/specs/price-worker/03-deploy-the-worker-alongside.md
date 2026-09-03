# 03 — Deploy the worker alongside the still-fetching app

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.1, §4)._

**What to build:** The compose changes that put the worker into production *without touching the
app*: the `worker` service, its two networks (`worker-db`, `egress-worker`), and the smoke-test
coverage for all of it. The app keeps fetching in-process; the worker drains a mailbox nothing writes
to yet. Every deploy from this commit still refreshes prices, which is what lets ticket 04 be a clean
cutover instead of a coupled release.

Because the worker fetches nothing until cutover, "it started" is not evidence it works. The smoke
test seeds a mailbox row and asserts the worker fulfils it — that is what this ticket actually
proves.

**Blocked by:** 02.

**Status:** ready-for-agent

**The service**

- [ ] Same image as `app`, `entrypoint: ["node", "./server/price-worker.ts"]` (overriding the image
      ENTRYPOINT at `Dockerfile:131`, which would run migrations as a role that cannot)
- [ ] `restart: unless-stopped` — every long-running service declares a policy, and a worker left
      stopped after a daemon restart is the sole price-fetcher silently gone
- [ ] `logging: *container-logging` — every service in `compose.yaml` carries the anchor (`:38-42`);
      a service without it logs unbounded
- [ ] Full hardening copied: `cap_drop: ALL`, `no-new-privileges`, `read_only`, tmpfs, non-root
- [ ] Healthcheck is a DB-connect probe only — deliberately not provider reachability
      (`app/routes/healthz.ts:9`'s reason: a Yahoo outage must not have Compose restart a healthy
      worker); it counts against the role's connection limit
- [ ] `depends_on: app: condition: service_healthy` (app healthy ⇒ migrations applied; conditions are
      host-side, no shared network needed)
- [ ] `DATABASE_URL` from `WORKER_DB_PASSWORD` (`:?` required), naming `portfolio_worker`;
      `MARKET_TIMEZONE` and `TZ` follow the app's defaults

**The networks (partial topology — the lockdown is ticket 04)**

- [ ] `worker-db` (internal) and `egress-worker` (bridge) declared; `worker` on both, `db`
      additionally attached to `worker-db`; every other service stays on the default network for now.
      There is no `networks:` key anywhere in `compose.yaml` today — this is the first.
- [ ] The worker shares no network with `app` or `gate` — `app:3000` (unauthenticated behind the
      gate) and `gate:4180` (holds the Google client secret) are unreachable from it

**Dev and smoke**

- [ ] `compose.dev.yaml` gains a `worker` override reusing the locally built `portfolio-app:dev`
      image with `pull_policy: build`, exactly as its `app` override does (`:14-21`) — without it,
      smoke would pull a GHCR release that lacks `server/price-worker.ts`, certifying stale code
- [ ] `smoke-test.sh`: `worker` added to every hardcoded service list — the teardown log dump
      (`:71`), `expect_caps worker "" 0000000000000000` (`:342-350`), the no-new-privileges loop
      (`:365`), `expect_uid worker 1000` (`:379-385`), the read-only-root loop (`:401`) — and to the
      published-port group (`:277-300`), which must show no `HostPort`
- [ ] **New assertion, the one that matters:** insert a `refresh_request` row directly into the
      database and assert the worker claims it and writes `completed_at` within a bounded wait. An
      incomplete Dockerfile copy set dies on first import, and with the app still fetching nothing
      else would notice.
- [ ] New assertion: `app:3000` and `gate:4180` are unreachable from the worker; `db:5432` connects

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build`, `scripts/smoke-test.sh` green
