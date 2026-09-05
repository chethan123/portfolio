# 07 — The network lockdown and the password cutover

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.6)._

**What to build:** The release where `app`, `db` and `dump` lose their internet route and the
superuser password stops having a default. The full topology of spec §3.6 with the Engine and
Compose floors stated where they will be read, and `compose.external-db.yaml` for the installs that
keep their Postgres outside it; `POSTGRES_PASSWORD` required; `PGPASSWORD` on `app`
and `dump` with the two `DATABASE_URL` defaults carrying user and host only; the checked-in
`.env.example` URL line removed; the numbered upgrade runbook in an order Compose will actually run;
and the smoke assertions that prove the effect — or read the daemon's own record where the effect
cannot be provoked — rather than the configuration.

Its own ticket because after [06](06-the-app-cutover.md) the app fetches nothing itself, so this
diff is networks and passwords only, and a network diff is reviewed by drawing it. It is also the
first release that refuses `up` for an existing install — [05](05-deploy-the-worker-alongside.md)
asked nothing of `.env` — and the one whose upgrade touches the database.

**Blocked by:** [06](06-the-app-cutover.md).

**Status:** ready-for-agent

**Corrected — the citations, and four pieces of work the checklist does not count.**

Six releases landed between this ticket being written and being built, and two of them inserted
whole subsections into `docs/operating.md`, pushing everything after them down by two hundred lines
and more. Of the twenty-nine `file:line` references below, eleven still point where they claim.
**Twelve point at unrelated content entirely** — a different subsystem, a different recipe, a blank
line — and a search-and-replace anchored on one of those would edit the wrong paragraph and leave
the right one standing. Every number here was re-read on `main` at the commit this was built from
(`30ea392`). Use this table, never the inline numbers, and open the line before editing near it.

| Written as | Actually at | What is really there |
|---|---|---|
| `docs/operating.md:195-197` | `:208-210` | "backups become your Postgres's problem"; `:195-197` is the pointer to the variables table and the *Running against your own Postgres* heading |
| `docs/operating.md:84-92` | `:85-93` | the **Host requirements** paragraph — and the quoted phrase **"any v2 is new enough" is not in the tree at all**: it states a number, `Compose 1.27.4` (`:87`) |
| `compose.yaml:59` | `:68` | `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-portfolio}`; `:59` is inside the `user: "70:70"` argument |
| `compose.yaml:204` | `:213` | `app`'s `DATABASE_URL:` default |
| `compose.yaml:126` | `:135` | `dump`'s `DATABASE_URL:` default; `:126` is inside `dump`'s `depends_on` |
| `.env.example:104` | `:118` | `#POSTGRES_PASSWORD=portfolio`; `:104` is the `TZ` comment |
| `compose.yaml:20` | `:21` | "Every other setting, the worker's included, has a working default" |
| `compose.yaml:57` | `:66` | "credentials never face the LAN. Change them = change DATABASE_URL too"; `:57` is `logging: *container-logging` |
| `docs/runbook.md:586` | `:645-646` | the `.env`-carrying checklist, under *I need to move to another machine*; `:586` is the blank line under a different heading |
| `docs/operating.md:176` | `:188-189` | "every setting has a working default except `DATABASE_URL`" — the sentence wraps, so a grep for it on one line finds nothing; `:176` is a `chown` command |
| `docs/operating.md:1063` | `:1315` | "make sure `DATABASE_URL` agrees", in the Postgres major-upgrade section; `:1063` is a `POSTGRES_PASSWORD` recoverability bullet under Backups |
| `docs/operating.md:949` | `:1153` | `## Upgrading`; `:949` is the worker's log-stem bullet under Monitoring. (Ticket 05 already corrected this once, 949→1072; three more releases moved it again) |
| `docs/operating.md:308-319` | `:383-391` | the `POSTGRES_PASSWORD` rotation recipe and its `alter role` block (`:390`); `:308-319` is the gate's own Compose-level settings — a different subsystem |
| `docs/runbook.md:525-552` | `:590-604` | the rotation recipe under *I changed the database password and nothing connects*; `:525-552` is the passkey-wipe recovery |
| `scripts/smoke-test.sh:108-116` | `:120-133` | the refusal check (`config --quiet` at `:126-129`, the variable-name assertion at `:130-132`); `:108-116` is the tail of the Engine-floor check |
| `compose.yaml:33` | `:55` | `db`'s `image: *postgres-image`; `:33` is a header comment about `gateway_mode_ipv4` |
| `compose.yaml:105` | `:114` | `dump`'s `image: *postgres-image`; `:105` is blank |
| `scripts/smoke-test.sh:265-268` | `:290-298` | the in-container `yahoo-finance2` ESM import check; `:265-268` is the tail of the dev-dependency loop — see the first uncounted item below |

Still correct as written: `scripts/dump-loop.sh:90-97`, `:95-97`, `:204` and `:262`;
`scripts/smoke-test.sh:20-25` and `:26`; `Caddyfile:27`, `:31-33`, `:39-49` and `:81`;
`.env.example:23`.

Every number in that table is as of the commit this ticket was addressed to. This ticket's own diff
moves some of them again — `## Upgrading` ends up lower once the numbered sequence is in — so once
the work has landed, read the tree rather than the table.

**The uncounted work.**

- **Half of item 18 is already done.** `scripts/smoke-test.sh:295-297` already runs the
  `yahoo-finance2` ESM import check in `worker`, moved there by [06](06-the-app-cutover.md) with a
  comment at `:290-294` saying why. Nothing to move; confirm and tick. The other half — 06's bundle
  grep at `:307-310` staying — is the real content of the item.
- **Item 9 names four locations and there is a fifth.** `.env.example:117` reads "Change it =
  change `DATABASE_URL`'s password to match", directly above the `POSTGRES_PASSWORD` line item 7
  rewrites. It needs the same treatment as the four, and it is the one an operator reads while
  doing exactly what this ticket changes. Item 9 covers it.
- **`compose.yaml:523-536`'s network comment is superseded, not extended.** It argues that `worker`
  is the only service with a `networks:` key and that everything else "stays exactly where it is,
  on the implicit `default` bridge, until the network-lockdown release moves everyone off it". This
  is that release. Rewrite the block; do not append the six networks under a comment that denies
  they exist. `scripts/smoke-test.sh:544-548` carries the same claim in the same words ("app, gate
  and db stay on the implicit default bridge until 07") and goes false with it — the assertions
  under it stay correct, only the prose is wrong.
- **Two comments beside the lines this ticket edits are already false.** `compose.yaml:232-234`
  ("nothing calls it yet, `app` still fetches prices in-process — so the cutover in ticket 06
  changes no compose line, only code") and `:255-259` ("Nothing calls the socket yet … until ticket
  06's cutover"). 06 landed. This ticket edits `app`'s environment block a few lines below the
  first and `worker`'s `networks:` key a few lines below the second, so leaving them is a choice,
  not an oversight. Fix them in passing.

**Checked and needing nothing.** `container_ip` and `probe_all_ips`
(`scripts/smoke-test.sh:557-560`, `:594-601`) were written for the topology this ticket brings:
the `{{range}}` template already emits a trailing space per address and `probe_all_ips` already
word-splits and probes each one, so a service on two networks is probed twice rather than once
against two glued addresses. That fix landed in `94c32e4`; this ticket adds no smoke code for it.

**Two citations outside this ticket that this ticket's work invalidates**, recorded here because
the next person to follow them is building from them: spec §3.6
(`docs/specs/0018-price-worker.md:527`) cites `compose.yaml:257-260` for the sidecar's
`X-Forwarded-*` invariant, which actually lives at `Caddyfile:19` (`trusted_proxies static
private_ranges`) — `:257-260` is the worker service's intro comment. And both
`docs/specs/0018-price-worker.md:567` and
[09](09-documents-and-runbooks.md)'s own line 36 cite `ARCHITECTURE.md:345` for the env-reader row
that this ticket's `PGPASSWORD` work is what updates; `:345` is the *Writing a price* row and
*Reading the environment* is at `:352`.

**Topology** (`compose.yaml`)

- [ ] The networks exactly as spec §3.6: `backend`, `caddy-app` and `caddy-gate` internal with
      `com.docker.network.bridge.gateway_mode_ipv4: isolated`; `egress-worker`, `egress-gate` and
      `ingress` plain bridges; **`enable_ipv6: false` written on every one of the six** — unset,
      Compose sends a nil and the daemon's default decides; every service with an explicit list and
      none on `default` any more — `db: [backend]`, `dump: [backend]`, `app: [backend,
      caddy-app]`, `worker: [egress-worker]` (where [05](05-deploy-the-worker-alongside.md) put it),
      `gate: [caddy-gate, egress-gate]`, `caddy: [caddy-app, caddy-gate, ingress]`. `db` is
      recreated once for its network, and `app` and `dump` restart with it — the brief outage the
      upgrade note names
- [ ] **`compose.external-db.yaml`**, shipped by this ticket, because this is the release that would
      otherwise break every install whose `DATABASE_URL` names a LAN or remote Postgres: on internal
      networks only, `app` has no route to that host at all and crash-loops on the first
      connection. The override is one plain bridge, `external-db: { enable_ipv6: false }`, attached
      to `app` and to nothing else — the worker needs no database route, holding no credential — and
      a Compose profile, `profiles: ["bundled-db"]` on `db` and `dump` (sequences append across
      compose files, so the base file need not change), so neither starts with this override loaded
      and no profile named: `dump`'s `DATABASE_URL` is the same shared variable `app`'s now points
      elsewhere, and `scripts/dump-loop.sh:90-97` refuses any host but `db`, so left running it
      would crash-loop under its own `restart: on-failure`. Backups on a bring-your-own install
      become the operator's Postgres's problem in fact, not merely by the docs' say-so
      (`docs/operating.md:195-197`), `dump` never starting to contest it. It says plainly what that
      mode gives up otherwise, in the file's own header and in the docs: **the no-egress guarantee
      for `app` is off**, because that bridge carries a default route and requirement 1 is exactly
      what it relaxes; what remains is requirement 3 by construction — the worker holds no
      credential to read anything with — and
      requirement 5, the worker still sharing no network with `app` or `gate`. Such installs set
      `COMPOSE_FILE=compose.yaml:compose.external-db.yaml` in `.env`, once — Compose reads it from
      the project's `.env`, and `scripts/smoke-test.sh:26` is the repo's own precedent, with `:20-25`
      the argument against a flag per command — rather than `-f` on every `ps`, `logs` and `down`.
      The override forgotten has its own signature, and the docs name it: `app` crash-looping on
      `ETIMEDOUT`/`EHOSTUNREACH` to its Postgres, with no message naming the override.
      [09](09-documents-and-runbooks.md) documents the mode; this ticket defines it
- [ ] The header repeats the Engine 28.0 floor [05](05-deploy-the-worker-alongside.md) declared, now
      load-bearing,
      with `docker version --format '{{.Server.Version}}'` and why: 26 ignores the gateway-mode
      option silently and keeps a host address on the bridge; 27 refuses it. Beside it the Compose
      floor: a network whose definition changed is recreated only by a Compose that recorded a
      config hash on it (research note §1.11) — the reason [08](08-the-egress-allowlist.md) uses a
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
- [ ] The header's "every other setting has a working default" (`:20`) is rewritten:
      `POSTGRES_PASSWORD` joins the settings deliberately without one
- [ ] The lines that still say the password lives in a URL, each rewritten for `POSTGRES_PASSWORD`:
      `compose.yaml:57` ("Change them = change `DATABASE_URL` too"), `docs/runbook.md:586` (`.env`
      "holds `DATABASE_URL` and the gate's four"), `docs/operating.md:176` ("every setting has a
      working default except `DATABASE_URL`") and `:1063` (the Postgres major upgrade's "make sure
      `DATABASE_URL` agrees")

**The upgrade runbook** (`docs/operating.md`, Upgrading `:949`; the rest is
[09](09-documents-and-runbooks.md)'s)

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
      back in `.env` — the one documented path, the generated password carried into the URL. Never
      the role's password reset to the old file's hardcoded default: that would undo this ticket's
      whole point to save a rollback one step. That is the moment the password is back in a URL, not
      the moment it goes weak. An old image ignores the worker and its volume; nothing this slice
      added is in the database
- [ ] `:308-319`'s rotation recipe and `docs/runbook.md:525-552` lose the URL half: `.env` first,
      then the role, then `up -d`

**Smoke** (`scripts/smoke-test.sh`)

- [ ] Export a throwaway `POSTGRES_PASSWORD` before the refusal check (`:108-116`) and add the
      mirror refusal for it: Compose reports only the first missing variable, in file order, and
      `db` comes before `gate`, so without the export the gate check would name the wrong variable
- [ ] Under `compose.external-db.yaml` (`COMPOSE_FILE=compose.yaml:compose.external-db.yaml`, no
      `COMPOSE_PROFILES` naming `bundled-db`): `docker compose up -d` then `docker compose ps db
      dump` shows neither container created — the profile gate holds, so this mode never depends on
      the bundled Postgres coming up healthy, and `dump` never gets the chance to crash-loop against
      an external host it refuses
- [ ] From `app` (`node -e fetch` under `AbortSignal.timeout(5_000)` — with no route the embedded
      resolver answers `SERVFAIL` only after trying the host's upstreams), `db` and **`dump`**
      (busybox `wget -T 5`): a request to a public host fails; `timeout 5 nslookup example.com`
      exits non-zero; `/proc/net/route` holds no `00000000` destination (busybox `ip route` is
      present too, but `/proc` needs no applet). `dump` is not skippable: it holds the whole
      household's history in every dump it writes, requirement 1 names it beside `app` and `db`, and
      it runs the same `postgres:17-alpine` as `db` (`compose.yaml:33`, `:105`), so the three checks
      are the same three commands against a third service
- [ ] The isolation is read from the daemon's record, never provoked with a connect: for each of the
      three isolated networks `docker network inspect -f '{{if (index .IPAM.Config
      0).Gateway}}fail{{end}}'` prints nothing — under `isolated` no gateway address is allocated at
      all (research note §1.3), so the field is empty, and a connect to it would fall back to
      localhost and pass for the wrong reason — and on the host, `ip -4 addr show dev br-$(docker
      network inspect -f '{{slice .Id 0 12}}' …)` carries no `inet`. An engine that ignored
      `isolated` allocates the gateway, and both checks fail
- [ ] From `worker`: `app`, `gate` and `db` unreachable by name and IP (kept from
      [05](05-deploy-the-worker-alongside.md), with its 3 s socket timeout); a public host
      resolves; a TCP connect to `egress-worker`'s gateway on `:80` **succeeds** — that network has
      a gateway, and the residual is proven rather than assumed; flipped by
      [08](08-the-egress-allowlist.md). Never `ping` anywhere: `NET_RAW` is dropped; `nc -z -w 3` is
      the probe in a container with no node
- [ ] The in-container `yahoo-finance2` import check (`:265-268`) runs in `worker` instead of `app`;
      [06](06-the-app-cutover.md)'s bundle grep stays
- [ ] Every assertion on caps, uid, read-only root and published ports still passes with the
      networks in place

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build`, `scripts/smoke-test.sh` green
