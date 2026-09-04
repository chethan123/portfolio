# 05 — Deploy the worker alongside the still-fetching app

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.6, §3.8)._

**What to build:** The compose changes that put the worker into production without touching the
app's own fetching: the `price-worker-sock` volume, the `worker` service with the full hardening and
its resource bounds on its own egress bridge, `app` mounting the volume it does not yet use, the
socket healthcheck, the dev override that builds the worker from the checkout, the header and the
upgrade note — this is where the Engine floor is declared — and the smoke coverage. The app keeps
fetching and nothing calls the socket yet, so the worker listens, idles and reports healthy. Every
deploy from this commit still refreshes prices, which is what lets [06](06-the-app-cutover.md) be a
clean, code-only cutover. Nothing is asked of the operator's `.env`: the worker needs no credential
and no variable.

Its own ticket because a compose diff is reviewed apart from the code that will use it, and because
the release that introduces a service and a volume deserves its own upgrade note.

**Blocked by:** [04](04-the-price-worker-process.md).

**Status:** ready-for-agent

**The volume** (`compose.yaml`, the `volumes:` block at `:377`)

- [ ] `price-worker-sock`: `driver: local` with `driver_opts: { type: tmpfs, device: tmpfs, o:
      "size=1m,uid=1000,gid=1000,mode=0770" }` — the three keys pass through to `mount -t tmpfs`,
      and the exact string was mounted and read back (research note §8.1, which also has the two
      traps: `size` belongs inside `o`, and `o` is a quoted scalar). The comment beside it, in
      `db-store`'s form (`:378-394`): a tmpfs because the socket file is the only content and must
      not outlive the host; `uid`/`gid` 1000 because `app` and `worker` both run as the image's
      `node` user (research §8.4), so the socket file the worker creates at `0660` in the `0770`
      directory is connectable by uid 1000 or gid 1000 — and by root, which `CAP_DAC_OVERRIDE`
      admits regardless (research §8.5); the mode is not the fence, the app owning the directory and
      able to `chmod` it — the fence is that only `app` and `worker` mount the volume, which smoke
      asserts below; `driver_opts` are read once, when the volume is created, and a name-matched
      volume is reused untouched (research §8.2), so a release that changes this line changes the
      volume's *name*, as [08](08-the-egress-allowlist.md) does for the network, and its upgrade
      note says so — never `docker compose down -v`, which removes `db-store`'s record with it
      (`:392-394` guards the neighbouring hazard — a reused name that makes `up` offer to recreate
      the volume); a megabyte because a socket needs no blocks — a *data*-full volume does not stop
      `bind()`, while spent inodes (`nr_inodes` defaults from RAM, not from `size`) or a directory
      squatting the path do stop the worker's next start (`ENOSPC`; `EISDIR` then `EADDRINUSE` —
      research §8.8), a refresh outage recovered by recreating the volume
      ([09](09-documents-and-runbooks.md)'s runbook entry), never a data loss
- [ ] Mounted at `/run/price-worker` in `worker` and in `app` — `app` from this ticket, so the
      cutover changes no compose line. `read_only: true` stays on both: the volume is the one
      writable path either needs for this (research §8.3)

**The service** (`compose.yaml`)

- [ ] `worker`: the app's image (`:192`) and `pull_policy: always` (`:196`); `entrypoint: ["node",
      "./server/price-worker.ts"]` — an `entrypoint:` also drops the image `CMD`, so neither the
      migration step nor `react-router-serve` runs as the worker; `restart: unless-stopped` — every
      long-running service declares one, and a worker left stopped after a daemon restart is the
      sole fetcher silently gone; `logging: *container-logging` (`:38`); **no `depends_on`** — it
      needs no database and no other service, and startup needs nothing to exist but the volume
- [ ] Environment: nothing at all — no `DATABASE_URL`, no `PGPASSWORD`, no `MARKET_TIMEZONE`, and
      no `TZ` (the worker reads no clock, and the image sets `TZ=UTC`, `Dockerfile:94-96`);
      `PRICE_WORKER_SOCKET` is left at its default, which is the mount path
- [ ] Hardening copied from `app` (`:215-221`): `no-new-privileges`, `cap_drop: ALL`, `read_only`;
      the image's `node` user (uid 1000); no `ports:` — the worker has no TCP listener to publish.
      And bounds `app` does not carry, because this is the container the design expects to be
      compromised and nothing today stops a fork bomb, a memory balloon or a `dd` into an unsized
      `/tmp` from driving the host into the OOM killer, whose usual victim is Postgres:
      `pids_limit: 64`; a memory limit of `256m` — builder verifies whether the repo's Compose
      honours `mem_limit` or `deploy.resources.limits.memory` without swarm, and uses that one; and
      `tmpfs: ["/tmp:size=64m"]` in place of `app`'s unsized `/tmp`
- [ ] Healthcheck: `["CMD", "node", "-e", "<script>"]` where the script does `http.request({
      socketPath: '/run/price-worker/worker.sock', path: '/healthz', agent: false })` and exits 0 on
      a `200`, 1 on anything else, an error, or 5 s elapsed — `node -e` as `app`'s own check does
      (`:223-227`): `CMD` is exec'd with no shell, `node` is on the image's PATH, and the probe runs
      as the container's user, the right party to prove the socket's permissions (research §8.10);
      interval 15s, timeout 5s, retries 3, start_period 10s. The comment beside it says what
      `dump`'s says (`:174-178`): nothing restarts an unhealthy container, this is for `docker
      compose ps`, and "unhealthy" means the worker is not accepting requests on its socket — never
      "Yahoo is failing"
- [ ] The header (`:1-2`, `:20`) is corrected: one worker on the same image, reached over a socket
      in a shared volume and holding no credential; "every other setting has a working default"
      still true, since the worker adds none; and the Engine 28.0 floor with its check, `docker
      version --format '{{.Server.Version}}'` — declared here, one release before
      [07](07-the-network-lockdown.md) makes it load-bearing, so an operator learns of it before the
      isolated networks arrive: 26 ignores `gateway_mode_ipv4` silently and keeps a host address on
      the bridge, 27 refuses it

**The network (partial — the lockdown is [07](07-the-network-lockdown.md))**

- [ ] `egress-worker: { enable_ipv6: false }` — `enable_ipv6: false` written, not left to the
      daemon's default; `worker` on it alone. Every other service stays where it is, on the implicit
      `default` bridge, until [07](07-the-network-lockdown.md): no `networks:` list on `db`, so
      nothing about `db` changes and `up -d` recreates only `app` (its mounts changed) and adds
      `worker`
- [ ] `worker` shares no network with any other service: `app`, `gate` and `db` are unreachable
      from it by name and by IP, the volume being its only link to the stack

**Dev, env, docs**

- [ ] `compose.dev.yaml` gains a `worker` stanza with the same `build`, `image: portfolio-app:dev`
      and `pull_policy: build` as `app` (`:14-21`); without it smoke would pull a GHCR release that
      lacks `server/price-worker.ts` and certify stale code. The base file's `volumes` and
      `networks` survive the merge — mappings merge, sequences append, scalars override
- [ ] `.env.example` changes nothing required: `PRICE_WORKER_SOCKET`'s commented line landed with
      [04](04-the-price-worker-process.md)
- [ ] `docs/operating.md` Upgrading (`:949`), in this order: **replace `compose.yaml` with this
      release's copy** — the file is the operator's own and moves with no tag (`:962-965`); an image
      from [06](06-the-app-cutover.md) on under the old file runs with no volume and no worker:
      stale prices, `/healthz` green, one "no worker listening at /run/price-worker/worker.sock"
      line per tick; then check the engine; then `up -d`, which recreates `app` once (its mounts
      changed) — the brief outage every upgrade already has, not a fault. The note also states the
      volume convention for whoever edits it next: a changed option string is a new volume name in
      the release that changes it, never `down -v`. The environment table (`:238`) gains
      `PRICE_WORKER_SOCKET`, optional, and Monitoring gains the worker's healthcheck beside `:710`
      with its meaning. Installing (`:84-92`) gains one sentence for the hosts smoke never runs on —
      SELinux-enforcing, `userns-remap`, rootless Docker (research §8.5) — pointing at the
      from-`app` socket check below as the one command to run by hand after `up -d`. The rest of the
      record is
      [09](09-documents-and-runbooks.md)'s

**Smoke** (`scripts/smoke-test.sh`)

- [ ] The script fails first, naming the floor, when `docker version --format '{{.Server.Version}}'`
      is below 28 — so a runner-image regression on `ubuntu-latest`
      (`.github/workflows/ci.yml:138-145`) reads as "engine too old", not as a topology bug
- [ ] The refusal check (`:108-116`) is untouched: this release adds no `${VAR:?}`
- [ ] `worker` joins the five lists: the log dump (`:71`), `expect_caps worker "" 0000000000000000`
      (`:342-350`), `expect_no_new_privileges` (`:365-367`), `expect_uid worker 1000` (`:379-385`),
      `expect_read_only_root` (`:401-403`); `published_ports worker` shows no `HostPort`
      (`:281-290`)
- [ ] `wait_for_healthy` (`:81`) takes the service as `$1`, default `app` — it hard-codes `app`
      today, in both the `ps -q` and the failure text — and `wait_for_healthy worker` asserts the
      worker listens *in the built image*: an incomplete Dockerfile copy set dies on first import,
      and nothing else would catch it
- [ ] The "in the image" file checks (`:230-232`) cover the three files
      [04](04-the-price-worker-process.md) added
- [ ] From `app`: `docker compose exec -T app node -e '<GET /healthz over
      /run/price-worker/worker.sock, agent: false>'` exits 0 on a `200` — the one positive assertion
      the channel allows, and the proof that the volume, the uids and the mode line up; from
      `worker`, `grep ' /run/price-worker ' /proc/mounts` names `tmpfs`
- [ ] `docker inspect -f '{{range .Mounts}}{{.Name}} {{end}}'` of `db`, `dump`, `gate` and `caddy`
      names no `price-worker-sock` — the fence is the mount set, and this is its assertion; `docker
      inspect -f '{{.HostConfig.PidsLimit}} {{.HostConfig.Memory}}' <worker container>` prints two
      non-zero numbers
- [ ] From `worker`, through `node -e` with `net.connect` and a socket timeout of 3 s (a connect to
      an unroutable address otherwise waits on the kernel's default, minutes): `app:3000`,
      `gate:4180` and `db:5432` fail by name and by the addresses `docker inspect` reports; `timeout
      5 nslookup example.com` succeeds — until [08](08-the-egress-allowlist.md). Never `ping`:
      `NET_RAW` is dropped

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build`, `scripts/smoke-test.sh` green
