# 04 — Deploy the worker alongside the still-fetching app

_Part of [0015-price-worker.md](../0015-price-worker.md) (§3.1, §4)._

**What to build:** The compose changes that put the worker into production *without touching the
app*: the `worker` service, its two networks (`worker-db`, `egress-worker`), and the smoke-test
coverage for all of it. The app keeps fetching; `withRefreshLock` arbitrates the two processes —
the cross-process contention it was built for. Every deploy from this commit still refreshes
prices, which is what lets ticket 05 be a clean cutover instead of a coupled release.

**Blocked by:** 03.

**Status:** ready-for-agent

**The service**

- [ ] Same image as `app`, `entrypoint: ["node", "./server/price-worker.ts"]` (overriding the
      image ENTRYPOINT, which would run migrations as a role that cannot)
- [ ] `restart: unless-stopped` — every long-running service declares a policy, and a worker
      left stopped after a daemon restart is the sole price-fetcher silently gone
- [ ] Full hardening copied: `cap_drop: ALL`, `no-new-privileges`, `read_only`, tmpfs,
      non-root
- [ ] Healthcheck is a DB-connect probe only — deliberately not provider reachability
      (`app/routes/healthz.ts:9`'s reason: a Yahoo outage must not have Compose restart a
      healthy worker); it counts against the role's connection limit
- [ ] `depends_on: app: condition: service_healthy` (app healthy ⇒ migrations applied;
      conditions are host-side, no shared network needed)
- [ ] `DATABASE_URL` from `WORKER_DB_PASSWORD` (`:?` required), naming `portfolio_worker`

**The networks (partial topology — the lockdown is ticket 05)**

- [ ] `worker-db` (internal) and `egress-worker` (bridge) declared; `worker` on both, `db`
      additionally attached to `worker-db`; every other service stays on the default network
      for now
- [ ] The worker shares no network with `app` or `gate` — `app:3000` (unauthenticated behind
      the gate) and `gate:4180` (holds the Google client secret) are unreachable from it

**Dev and smoke**

- [ ] `compose.dev.yaml` gains a `worker` override reusing the locally built
      `portfolio-app:dev` image (`pull_policy: build` semantics) — without it, smoke would pull
      a GHCR release that lacks `server/price-worker.ts`, certifying stale code
- [ ] `smoke-test.sh`: `worker` added to the three hardcoded service lists (`:71`, `:365`,
      `:401`), `expect_caps worker "" 0000000000000000`, `expect_uid`, no published port
      (the per-service block at `:281-289`)
- [ ] New assertion: the worker container reaches its polling loop in the built image — not
      merely that a process started (an incomplete Dockerfile copy set dies on first import,
      and nothing else would catch it)
- [ ] New assertion: `app:3000` and `gate:4180` are unreachable from the worker; `db:5432`
      connects

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build`, `scripts/smoke-test.sh` green
