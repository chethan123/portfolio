# 06 — The network lockdown and the password cutover

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.6, §3.7)._

**What to build:** The release where `app`, `db` and `dump` lose their internet route and the
superuser password stops having a default. The full topology of spec §3.7 with the Engine 28.0
floor stated where it will be read; `POSTGRES_PASSWORD` required; `PGPASSWORD` on `app` and `dump`
with the three `DATABASE_URL` defaults carrying user and host only; the checked-in `.env.example`
URL line removed; the numbered upgrade runbook; and the smoke assertions that prove the effect
rather than the configuration.

Its own ticket because after [05](05-the-app-cutover.md) the app fetches nothing itself, so this
diff is networks and passwords only, and a network diff is reviewed by drawing it. It is also the
second release that refuses `up` for an existing install, and the one whose upgrade touches the
database.

**Blocked by:** [05](05-the-app-cutover.md).

**Status:** ready-for-agent

**Topology** (`compose.yaml`)

- [ ] The networks exactly as spec §3.7: `backend`, `worker-db`, `caddy-app` and `caddy-gate`
      internal with `com.docker.network.bridge.gateway_mode_ipv4: isolated`; `egress-worker`,
      `egress-gate` and `ingress` plain bridges; every service with an explicit list and none on
      `default` any more — `db: [backend, worker-db]`, `dump: [backend]`, `app: [backend,
      caddy-app]`, `worker: [worker-db, egress-worker]`, `gate: [caddy-gate, egress-gate]`, `caddy:
      [caddy-app, caddy-gate, ingress]`. No `enable_ipv6` anywhere, and a comment saying so
- [ ] The header states the Engine 28.0 floor as hard, with `docker info --format
      '{{.ServerVersion}}'`, and why: 26 ignores the gateway-mode option silently and keeps a host
      address on the bridge; 27 refuses it
- [ ] Caddy's reachability walk still holds against the `Caddyfile`: `/healthz` and the catch-all
      to `app:{$APP_PORT}` (`:31-33`, `:81`) over `caddy-app`; `/oauth2/*` and `forward_auth` to
      `gate:4180` (`:39-49`) over `caddy-gate`. Caddy makes no outbound call — a bare `:8080` site
      (`Caddyfile:27`), no `tls`, no ACME — so `ingress` carries the published port and nothing else;
      the gate's egress is `www.googleapis.com:443`, `accounts.google.com` being the browser's
      redirect

**Passwords**

- [ ] `db` (`:59`): `POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?missing POSTGRES_PASSWORD — see
      docs/operating.md, Upgrading}"`
- [ ] `app` (`:204`) and `dump` (`:126`): the `DATABASE_URL` default becomes
      `postgres://portfolio@db:5432/portfolio` and each gains `PGPASSWORD: ${POSTGRES_PASSWORD}`;
      `pg` 8.23 and libpq read it when the URL carries no password. `scripts/dump-loop.sh:95-97`
      still extracts `db` from a password-less URL, and `pg_dump` and `psql` (`:262`, `:204`) need
      no change
- [ ] `.env.example:23`'s explicit `DATABASE_URL` line goes; the comment says when to set one (your
      own Postgres) and that a URL password overrides `PGPASSWORD`. `:104`'s commented default
      becomes a required line generated with `openssl rand -hex 32`
- [ ] The header's "every other setting has a working default" (`:20`) is rewritten: three are
      deliberately without one

**The upgrade runbook** (`docs/operating.md`, Upgrading `:949`; the rest is
[08](08-documents-and-runbooks.md)'s)

- [ ] A numbered sequence with each step's reason: (1) delete the `DATABASE_URL` line from `.env`
      unless you run your own Postgres — `pg` prefers a URL's password to `PGPASSWORD`, so a stale
      line crash-loops `app` and `dump` with `password authentication failed`; (2) generate the
      password; (3) `docker compose exec db psql -U portfolio -d portfolio -c "alter role portfolio
      password '…'"` — password-free through the container's loopback `trust` lines, so it works
      while `app` is already failing; (4) set `POSTGRES_PASSWORD` in `.env`; (5) `docker compose up
      -d`. Between (3) and (5) only *new* connections from the old containers fail
- [ ] The rollback note: rolling `APP_VERSION` back under this compose file starts an image that
      fetches Yahoo itself from an isolated network and logs `Price provider failed` every tick with
      `/healthz` green — roll `compose.yaml` back with the image, or re-upgrade. The mailbox table is
      additive and an old image ignores it
- [ ] `:308-319`'s rotation recipe and `docs/runbook.md:525-552` lose the URL half: change the
      role, set `POSTGRES_PASSWORD`, `up -d`
- [ ] Installing (`:84-92`, which says "any v2 is new enough") gains the engine floor and its check

**Smoke** (`scripts/smoke-test.sh`)

- [ ] Export a throwaway `POSTGRES_PASSWORD` before the refusal check (`:108-116`), beside
      [04](04-deploy-the-worker-alongside.md)'s, and add the mirror refusal for it — `db` now comes
      first in file order, so without the export the check names the wrong variable
- [ ] From `app` (`node -e fetch`) and `db` (busybox `wget`): a request to a public host fails;
      `timeout 5 nslookup example.com` exits non-zero (an external lookup from an internal-only
      container ends in `SERVFAIL`, possibly slowly); `ip route` shows no default route; a TCP
      connect to the network's IPAM gateway address (`docker network inspect -f '{{(index
      .IPAM.Config 0).Gateway}}'`) on `:80` fails. Effects, not the option: an engine that ignored
      `isolated` passes the first three and fails the last
- [ ] From `worker`: `app` and `gate` unreachable by name and IP (kept from
      [04](04-deploy-the-worker-alongside.md)); `db:5432` connects; a public host resolves; a TCP
      connect to its egress network's gateway on `:80` **succeeds** — the residual, proven rather
      than assumed, and flipped by [07](07-the-egress-allowlist.md)
- [ ] The in-container `yahoo-finance2` import check (`:265-268`) runs in `worker` instead of
      `app`; [05](05-the-app-cutover.md)'s bundle grep stays
- [ ] Every assertion on caps, uid, read-only root and published ports still passes with the
      networks in place

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build`, `scripts/smoke-test.sh` green
