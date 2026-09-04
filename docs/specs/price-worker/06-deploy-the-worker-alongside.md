# 06 — Deploy the worker alongside the still-fetching app

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.7, §3.9)._

**What to build:** The compose changes that put the worker into production without touching the
app's own fetching: the `worker` service with the full hardening, its two networks, `db` attached to
the worker's, the dev override that builds it from the checkout, the `.env.example` entry, the
upgrade note — this is where the Engine floor first bites — and the smoke coverage. The app keeps
fetching and nothing reads the mailbox yet, so the worker idles, polls, and reports healthy. Every
deploy from this commit still refreshes prices, which is what lets [07](07-the-app-cutover.md) be a
clean cutover.

Its own ticket because a compose and network diff is reviewed apart from the code that will use it,
and because this is the first release that refuses `up` for an existing install — which deserves its
own upgrade note.

**Blocked by:** [05](05-the-price-worker-process.md).

**Status:** needs-triage — becomes ready-for-agent when §2.5 of the spec is answered

**The service** (`compose.yaml`)

- [ ] `worker`: the app's image (`:192`) and `pull_policy: always` (`:196`); `entrypoint: ["node",
      "./server/price-worker.ts"]` — an `entrypoint:` also drops the image `CMD`, so neither the
      migration step nor `react-router-serve` runs as the worker; `restart: unless-stopped` — every
      long-running service declares one, and a worker left stopped after a daemon restart is the
      sole fetcher silently gone; `logging: *container-logging`; `depends_on: app: condition:
      service_healthy` — app healthy means migrated and provisioned, and the condition is evaluated
      host-side over the Docker API, so no shared network is needed
- [ ] Environment: `DATABASE_URL: postgres://portfolio_worker@db:5432/portfolio`; `PGPASSWORD:
      "${WORKER_DB_PASSWORD:?missing WORKER_DB_PASSWORD — see docs/operating.md, Upgrading}"`; `TZ:
      UTC`. No `MARKET_TIMEZONE`: the worker reads no setting. `app` gains `WORKER_DB_PASSWORD:
      ${WORKER_DB_PASSWORD}` for the provisioning step — it adds nothing to a compromised app,
      already the superuser
- [ ] Hardening copied from `app` (`:215-221`): `no-new-privileges`, `cap_drop: ALL`, `read_only`,
      `tmpfs: [/tmp]`; the image's `node` user (uid 1000); no `ports:`
- [ ] Healthcheck: `["CMD", "sh", "-c", "test -f /tmp/price-worker-heartbeat && test $(( $(date +%s)
      - $(stat -c %Y /tmp/price-worker-heartbeat) )) -lt 60"]` — the `test -f` first, because the
      arithmetic on a missing file is a shell error, exit 2, which Docker's docs reserve; interval
      15s, timeout 5s, retries 3, start_period 30s — tight against the worker's own login backoff,
      and the cost of a slow boot is only an `unhealthy` in `docker compose ps`, since nothing
      depends on the worker. busybox `stat -c %Y` and `date` are in `node:24-alpine`, and the probe
      runs as the container's own uid on its read-only root. The comment beside it says what
      `dump`'s says (`:174-178`): nothing restarts an unhealthy container, this is for `docker
      compose ps` and `depends_on`, and "unhealthy" means no completed poll in a minute — never
      "Yahoo is failing"
- [ ] The header (`:1-2`, `:20`) is corrected: one worker on the same image, one more variable
      without a default, and the Engine 28.0 floor with its check, `docker version --format
      '{{.Server.Version}}'` — 26 ignores `gateway_mode_ipv4` silently and keeps a host address on
      the bridge, 27 refuses it, and `worker-db` below is the first network that uses it

**The networks (partial — the lockdown is [08](08-the-network-lockdown.md))**

- [ ] `worker-db: { internal: true, enable_ipv6: false, driver_opts: {
      com.docker.network.bridge.gateway_mode_ipv4: isolated } }` and `egress-worker: { enable_ipv6:
      false }` — `enable_ipv6: false` written, not left to the daemon's default; `worker` on both;
      `db` on `[default, worker-db]` — **`default` stays listed explicitly**, because a
      service-level `networks:` list detaches the service from the implicit `default` bridge, and
      `app` and `dump` still reach `db` there until [08](08-the-network-lockdown.md)
- [ ] `worker` shares no network with `app` or `gate`

**Dev, env, docs**

- [ ] `compose.dev.yaml` gains a `worker` stanza with the same `build`, `image: portfolio-app:dev`
      and `pull_policy: build` as `app` (`:14-21`); without it smoke would pull a GHCR release that
      lacks `server/price-worker.ts` and certify stale code. The base file's `networks` list
      survives the merge — sequences append, scalars override
- [ ] `.env.example`: `WORKER_DB_PASSWORD` required, generated with `openssl rand -hex 32` — hex
      avoids `$` under compose interpolation and every URL and shell delimiter — and the comment
      says a human-chosen password defeats the slice, since the worker's network can attempt logins
      unthrottled
- [ ] `docs/operating.md` Upgrading (`:949`), in this order: **replace `compose.yaml` with this
      release's copy** — the file is the operator's own and moves with no tag (`:962-965`); an image
      from [07](07-the-app-cutover.md) on under the old file runs with no worker: stale prices,
      `/healthz` green, one "no worker claimed" line per tick; then **write `WORKER_DB_PASSWORD` to
      `.env` before any compose command** — interpolation of `:?` runs on every one, `exec`, `ps`,
      `logs` and `down` included, so until it exists nothing answers, not even `docker compose
      logs`; then check the engine; then `up -d`, which recreates `db` (its networks changed) and
      therefore restarts `app` and `dump` once — a brief outage to expect, not a fault. The
      environment table (`:238`) gains the variable; `docs/runbook.md:49` gains that `ps`, `logs`
      and `down` refuse too. The rest of the record is [10](10-documents-and-runbooks.md)'s

**Smoke** (`scripts/smoke-test.sh`)

- [ ] The script fails first, naming the floor, when `docker version --format '{{.Server.Version}}'`
      is below 28 — so a runner-image regression on `ubuntu-latest`
      (`.github/workflows/ci.yml:138-145`) reads as "engine too old", not as a topology bug
- [ ] The refusal check (`:108-116`) must still see a *gate* variable named: export a throwaway
      `WORKER_DB_PASSWORD` **before** it. Compose reports only the first missing variable, in file
      order; `worker` sits after `gate` today so the assertion would pass by accident, and
      [08](08-the-network-lockdown.md) puts `POSTGRES_PASSWORD` on `db`, ahead of both. Add the
      mirror: with the gate's variables set and `WORKER_DB_PASSWORD` unset, `config --quiet` refuses
      naming it
- [ ] `worker` joins the five lists: the log dump (`:71`), `expect_caps worker "" 0000000000000000`
      (`:342-350`), `expect_no_new_privileges` (`:365-367`), `expect_uid worker 1000` (`:379-385`),
      `expect_read_only_root` (`:401-403`); `published_ports worker` shows no `HostPort`
      (`:281-290`)
- [ ] `wait_for_healthy` (`:81`) takes the service as `$1`, default `app` — it hard-codes `app`
      today, in both the `ps -q` and the failure text — and `wait_for_healthy worker` asserts the
      worker reaches its claimer loop *in the built image*: an incomplete Dockerfile copy set dies
      on first import, and nothing else would catch it
- [ ] The "in the image" file checks (`:230-232`) cover the three files
      [05](05-the-price-worker-process.md) added and `server/provision-worker-role.ts`
- [ ] From `worker`, through `node -e` with `net.connect` and a socket timeout of 3 s (a connect to
      an unroutable address otherwise waits on the kernel's default, minutes): `app:3000` and
      `gate:4180` fail by name and by the addresses `docker inspect` reports; `db:5432` connects;
      `timeout 5 nslookup example.com` succeeds — until [09](09-the-egress-allowlist.md). Never
      `ping`: `NET_RAW` is dropped

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build`, `scripts/smoke-test.sh` green
