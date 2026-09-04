# 08 — The network lockdown and the password cutover

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.6, §3.7)._

**What to build:** The release where `app`, `db` and `dump` lose their internet route and the
superuser password stops having a default. The full topology of spec §3.7 with the Engine and
Compose floors stated where they will be read, and `compose.external-db.yaml` for the installs that
keep their Postgres outside it; `POSTGRES_PASSWORD` required; `PGPASSWORD` on `app`
and `dump` with the three `DATABASE_URL` defaults carrying user and host only; the checked-in
`.env.example` URL line removed; the numbered upgrade runbook in an order Compose will actually run;
and the smoke assertions that prove the effect — or read the daemon's own record where the effect
cannot be provoked — rather than the configuration.

Its own ticket because after [07](07-the-app-cutover.md) the app fetches nothing itself, so this
diff is networks and passwords only, and a network diff is reviewed by drawing it. It is also the
second release that refuses `up` for an existing install, and the one whose upgrade touches the
database.

**Blocked by:** [07](07-the-app-cutover.md).

**Status:** ready-for-agent

**Topology** (`compose.yaml`)

- [ ] The networks exactly as spec §3.7: `backend`, `worker-db`, `caddy-app` and `caddy-gate`
      internal with `com.docker.network.bridge.gateway_mode_ipv4: isolated`; `egress-worker`,
      `egress-gate` and `ingress` plain bridges; **`enable_ipv6: false` written on every one of the
      seven** — unset, Compose sends a nil and the daemon's default decides; every service with an
      explicit list and none on `default` any more — `db: [backend, worker-db]`, `dump: [backend]`,
      `app: [backend, caddy-app]`, `worker: [worker-db, egress-worker]`, `gate: [caddy-gate,
      egress-gate]`, `caddy: [caddy-app, caddy-gate, ingress]`
- [ ] **`compose.external-db.yaml`**, shipped by this ticket, because this is the release that would
      otherwise break every install whose `DATABASE_URL` names a LAN or remote Postgres: on internal
      networks only, `app` and `worker` have no route to that host at all and both crash-loop on the
      first connection. The override is one plain bridge, `external-db: { enable_ipv6: false }`,
      attached to `app` and `worker` and to nothing else — `dump` stays off it, since on a
      bring-your-own install backups are the operator's Postgres's problem
      (`docs/operating.md:195-197`). It says plainly what that mode gives up, in the file's own
      header and in the docs: **the no-egress guarantee for `app` is off**, because that bridge
      carries a default route and requirement 1 is exactly what it relaxes; what remains is the role
      and the mailbox — the worker still reads no household table, and still shares no network with
      `app` or `gate`. The upgrade note for such installs is `docker compose -f compose.yaml -f
      compose.external-db.yaml up -d`, and the `-f` pair belongs on every later compose command,
      `ps`, `logs` and `down` included. [10](10-documents-and-runbooks.md) documents the mode; this
      ticket defines it
- [ ] The header repeats the Engine 28.0 floor [06](06-deploy-the-worker-alongside.md) introduced,
      with `docker version --format '{{.Server.Version}}'` and why: 26 ignores the gateway-mode
      option silently and keeps a host address on the bridge; 27 refuses it. Beside it the Compose
      floor: a network whose definition changed is recreated only by a Compose that recorded a
      config hash on it (research note §1.11) — the reason [09](09-the-egress-allowlist.md) uses a
      new network name — and Installing (`docs/operating.md:84-92`, "any v2 is new enough") gains
      both floors and their checks
- [ ] Caddy's reachability walk still holds against the `Caddyfile`: `/healthz` and the catch-all to
      `app:{$APP_PORT}` (`:31-33`, `:81`) over `caddy-app`; `/oauth2/*` and `forward_auth` to
      `gate:4180` (`:39-49`) over `caddy-gate`. Caddy makes no outbound call — a bare `:8080` site
      (`Caddyfile:27`), no `tls`, no ACME — so `ingress` carries the published port and nothing
      else; the gate's egress is `www.googleapis.com:443`, `accounts.google.com` being the browser's
      redirect

**Passwords**

- [ ] `db` (`:59`): `POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?missing POSTGRES_PASSWORD — see
      docs/operating.md, Upgrading}"`
- [ ] `app` (`:204`) and `dump` (`:126`): the `DATABASE_URL` default becomes
      `postgres://portfolio@db:5432/portfolio` and each gains `PGPASSWORD: ${POSTGRES_PASSWORD}`;
      `pg` 8.23, libpq and `pg_dump` read it when the URL carries no password (research note §4.1).
      `scripts/dump-loop.sh:95-97` still extracts `db` from a password-less URL, and `pg_dump` and
      `psql` (`:262`, `:204`) need no change
- [ ] `.env.example:23`'s explicit `DATABASE_URL` line goes; the comment says when to set one (your
      own Postgres) and that a URL password overrides `PGPASSWORD`. `:104`'s commented default
      becomes a required line generated with `openssl rand -hex 32`
- [ ] The header's "every other setting has a working default" (`:20`) is rewritten: three are
      deliberately without one

**The upgrade runbook** (`docs/operating.md`, Upgrading `:949`; the rest is
[10](10-documents-and-runbooks.md)'s)

- [ ] A numbered sequence with each step's reason, in the only order that runs — the new
      `compose.yaml` carries `${POSTGRES_PASSWORD:?}`, and Compose interpolates the whole model
      before *every* command, `exec` included, so nothing reaches Postgres until `.env` has the
      variable: (1) replace `compose.yaml` with this release's copy; (2) delete the `DATABASE_URL`
      line from `.env` unless you run your own Postgres — `pg` prefers a URL's password to
      `PGPASSWORD`, so a stale line crash-loops `app` and `dump` with `password authentication
      failed`; (3) generate the password **and write `POSTGRES_PASSWORD` to `.env`**; (4) `docker
      compose exec db psql -U portfolio -d portfolio -c "alter role portfolio password '…'"` —
      password-free through the container's loopback `trust` lines, so it works while `app` is
      already failing; (5) `docker compose up -d`. Between (4) and (5) only *new* connections from
      the old containers fail
- [ ] The rollback note: rolling `APP_VERSION` back under this compose file starts an image that
      fetches Yahoo itself from an isolated network and logs `Price provider failed` every tick with
      `/healthz` green — roll `compose.yaml` back with the image, or re-upgrade. Rolling the compose
      file back needs `DATABASE_URL=postgres://portfolio:<the generated password>@db:5432/portfolio`
      back in `.env` (or the role's password reset to `portfolio` first), since the old file's
      default URL carries the old password — and that is the moment the password is back in a URL.
      The mailbox table is additive and an old image ignores it
- [ ] `:308-319`'s rotation recipe and `docs/runbook.md:525-552` lose the URL half: `.env` first,
      then the role, then `up -d`

**Smoke** (`scripts/smoke-test.sh`)

- [ ] Export a throwaway `POSTGRES_PASSWORD` before the refusal check (`:108-116`), beside
      [06](06-deploy-the-worker-alongside.md)'s, and add the mirror refusal for it — `db` now comes
      first in file order, so without the export the check names the wrong variable
- [ ] From `app` (`node -e fetch` under `AbortSignal.timeout(5_000)` — with no route the embedded
      resolver answers `SERVFAIL` only after trying the host's upstreams), `db` and **`dump`**
      (busybox `wget -T 5`): a request to a public host fails; `timeout 5 nslookup example.com`
      exits non-zero; `/proc/net/route` holds no `00000000` destination (busybox `ip route` is
      present too, but `/proc` needs no applet). `dump` is not skippable: it holds the whole
      household's history in every dump it writes, requirement 1 names it beside `app` and `db`, and
      it runs the same `postgres:17-alpine` as `db` (`compose.yaml:33`, `:105`), so the three checks
      are the same three commands against a third service
- [ ] The isolation is read from the daemon's record, never provoked with a connect: for each of the
      four isolated networks `docker network inspect -f '{{if (index .IPAM.Config
      0).Gateway}}fail{{end}}'` prints nothing — under `isolated` no gateway address is allocated at
      all (research note §1.3), so the field is empty, and a connect to it would fall back to
      localhost and pass for the wrong reason — and on the host, `ip -4 addr show dev br-$(docker
      network inspect -f '{{slice .Id 0 12}}' …)` carries no `inet`. An engine that ignored
      `isolated` allocates the gateway, and both checks fail
- [ ] From `worker`: `app` and `gate` unreachable by name and IP (kept from
      [06](06-deploy-the-worker-alongside.md), with its 3 s socket timeout); `db:5432` connects; a
      public host resolves; a TCP connect to `egress-worker`'s gateway on `:80` **succeeds** — that
      network has a gateway, and the residual is proven rather than assumed; flipped by
      [09](09-the-egress-allowlist.md). Never `ping` anywhere: `NET_RAW` is dropped; `nc -z -w 3` is
      the probe in a container with no node
- [ ] The in-container `yahoo-finance2` import check (`:265-268`) runs in `worker` instead of `app`;
      [07](07-the-app-cutover.md)'s bundle grep stays
- [ ] Every assertion on caps, uid, read-only root and published ports still passes with the
      networks in place

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build`, `scripts/smoke-test.sh` green
