# Operating an instance

Everything a self-hoster needs that is not in the [README](../README.md): what the containers are,
what to put in `.env`, how it sits behind your own proxy, the security decisions that are yours
rather than the code's, what to watch, backing the data up, restoring it, and upgrading.

When something is already broken and you want a procedure, that is [`runbook.md`](runbook.md). This
file is how the instance is meant to be run.

- [What runs here](#what-runs-here)
- [Installing](#installing)
- [Environment variables](#environment-variables)
- [Reverse proxy and TLS](#reverse-proxy-and-tls)
- [Installing on a phone](#installing-on-a-phone)
- [Security](#security)
- [The lock](#the-lock)
- [Monitoring](#monitoring)
- [Backups](#backups)
- [Restoring](#restoring)
- [Upgrading](#upgrading)
- [Growth and limits](#growth-and-limits)

---

## What runs here

The services defined in [`compose.yaml`](../compose.yaml), under the project name `portfolio`.

| Service | What it is | Published port |
|---|---|---|
| `db` | Postgres. All persistent state, in `./volumes/db/data` beside `compose.yaml` | none |
| `app` | The application: pages, uploads, and the price refresh loop, in one process | none |
| `gate` | oauth2-proxy. Answers "may this request in?" against Google and the allowlist | none |
| `caddy` | The ingress front door, and where the gate is enforced | **`80:8080`, on every interface** — host side still 80; 8080 is Caddy's own listener |

A request goes browser → `caddy` → `gate` → `caddy` → `app` → `db`: Caddy asks the gate about every
request except `/healthz` before it forwards anything. Only `caddy` is reachable from your LAN;
`app`, `db` and `gate` are reachable only on the compose network. That is not a hardening extra — it
is the assumption both the app's trust of `X-Forwarded-*` and the gate's own trust of them rest on,
and [Security](#security) says what breaks if you publish either port yourself.

They start in dependency order: `app` waits for `db` to report healthy, and `caddy` waits for both
`app` and `gate`.

**`gate` is pinned to an exact release**, not a floating major like `app`. Nobody here watches that
image for a breaking change, and it is the thing that keeps everyone out. It is the `-alpine`
flavour specifically, because its healthcheck needs `wget`, which the default distroless image does
not carry.

**`gate` is stateless.** The session is an encrypted cookie in the browser, so there is no volume
and no database behind it — only the read-only bind mount of `./allowed-emails.txt`, which is the
whole of who may enter.

**`app` is stateless and enforced as such.** It writes nothing to its own filesystem, so it can be
destroyed and recreated freely, and every upgrade does exactly that.

**Every service holds only the privileges it was proved to need.** All four drop every Linux
capability, set `no-new-privileges`, and run on a read-only root filesystem, with a tmpfs over what
each still writes to — `/tmp` for `app` and `gate`, Postgres's socket directory for `db`, `/config`
and `/data` for `caddy`. Three run as an unprivileged uid: `app` as `node`, `db` as the
image's `postgres` (70), `caddy` as 65532. Two capabilities are granted back, each argued in
`compose.yaml` from a start failure without it: `DAC_READ_SEARCH` on `gate`, which is
[still root](#security), so that it can open your allowlist whatever its mode and owner; and
`NET_BIND_SERVICE` on `caddy`, which its binary needs in order to `exec` at all rather than to bind
anything. `scripts/smoke-test.sh` asserts all of it against a running stack — nothing else would
notice a container quietly regaining root.

**`app` is pulled, not built.** The image is `ghcr.io/chethan123/portfolio-app`, published by CI
for `linux/amd64` and `linux/arm64` when a version tag is pushed. `compose.yaml` has no `build:`
stanza on purpose: if the registry is unreachable or the tag does not exist, the deploy fails and
says so, rather than starting a multi-minute Node build on this machine. Which tag it runs is
[`APP_VERSION`](#environment-variables), and it defaults to the floating major.

**`./volumes/db/data` is the whole of the state, and it is a directory you can see.** Every
statement, every stored original CSV, every price. It reaches the container as the `db-store` volume
name, which Compose's local driver binds to that path — so `docker compose down` leaves it alone and
`docker compose down -v` now leaves it alone too: that removes the volume *record*, not the
directory. Deleting the data is `rm -rf` and nothing else, which is a better place for the one
irreversible act to sit than a flag on a routine command.

---

## Installing

**Host requirements.** Docker Engine 28.0 or newer, with the Compose v2 plugin — `docker compose`,
two words, not the older `docker-compose` script — and Docker Compose 2.31.0 or newer beside it, a
second floor declared alongside the first. Only one of the two actually bites on this release, and
they are worth telling apart rather than checking together as if they meant the same thing.

**The Engine floor is load-bearing now.** It was declared when `worker` first brought a non-default
network into this file, even though nothing wired the kernel isolation that needed it yet; this
release is what makes it bite, with the `gateway_mode_ipv4: isolated` option `backend`, `caddy-app`
and `caddy-gate` below all carry — Engine 26 ignores that option silently, leaving a host address
reachable on the bridge, and Engine 27 refuses it outright, either way with `docker compose up`
still reporting success. Check it before you replace `compose.yaml`:
`docker version --format '{{.Server.Version}}'`; below `28.0`, upgrade the Engine first — it does
not merely miss a feature here, it leaves the network looking locked down when it is not, and
nothing in the output says so.

**The Compose floor is not load-bearing yet.** Resolving a volume's `device:` relative to the
Compose file has worked since Compose 1.27.4, well under it; the 2.31.0 floor exists for something
no release has needed so far. `docker compose up` only recreates an *existing* network to match a
changed definition when the Compose that created it stamped a config hash onto it, a comparison
`docker/compose` added in November 2024 and first shipped in 2.31.0 — below that version there is no
hash to compare, so a future release that redefines a network already running under an older
Compose would see `up` leave it exactly as it found it, a successful `up` with nothing in the output
to say the change never took. This release does not do that: `egress-worker` is the only network
here that predates it, and this release leaves that one byte-identical; the five others —
`backend`, `caddy-app`, `caddy-gate`, `egress-gate` and `ingress` — are all created from nothing, and
the implicit `default` network they replace is removed outright rather than redefined. There is
nothing already running for an old Compose to fail to reconcile, so nothing here fails on a Compose
below 2.31.0 — check it too (`docker compose version --short`), for whichever later release does
touch one of these five again, but it is not a reason to stop today.

Port 80 free. Outbound HTTPS to `ghcr.io`, because the app image is pulled, and to `quay.io`,
because the gate image is. A Google account for each family member, and one Google Cloud project to
hold the OAuth client. `linux/amd64` and `linux/arm64` are both published, so a Raspberry Pi or an
ARM NAS needs nothing special. There is no build step and therefore no build-memory requirement —
that is the whole point of publishing the image, and it is what makes a small NAS or VPS a
reasonable host.

Node itself is a requirement for *working on* this, not for running it.

**The worker socket's cross-container permissions are proven nowhere in this repo's CI**, because
its runner is none of these: an SELinux-enforcing host, `userns-remap`, or rootless Docker can each
leave them different from what this stack assumes. [Verify it actually worked](#verify-it-actually-worked)
has the one-time check to run yourself, right after your first `up -d`.

**Bringing it up is one command, and it belongs to the README:**
[Running an instance](../README.md#running-an-instance). It is deliberately not repeated here — that
reader has installed nothing and needs the whole shape; you are at a terminal and need what comes
after.

**It will refuse to start until the gate is configured, and that is the design.** There is no mode
in which this stack boots open: every variable in the gate section of `.env` is interpolated with
Compose's `${VAR:?}` form, so a missing or empty one stops `docker compose up` before any container
runs, with a message naming the variable. A missing `allowed-emails.txt` stops it the same way.
Everything in this section up to [Verify it actually worked](#verify-it-actually-worked) is
therefore prerequisite, not optional hardening.

### One-time Google setup

**[`google-sign-in.md`](google-sign-in.md) is the walkthrough, and it is deliberately not repeated
here.** It is the one document for standing the gate up: the Google Cloud project, the consent
screen and why it is published, the OAuth client and the redirect URI Google matches character for
character, the gate's settings, the allowlist, and how to prove that a real sign-in and a real
refusal both work. Read it before the first `up` — you need the public origin your house proxy will
serve this instance at decided first, because the redirect URI is built from it.

What it leaves here: the credentials it produces are `GATE_CLIENT_ID`, `GATE_CLIENT_SECRET`,
`GATE_COOKIE_SECRET` and `PUBLIC_ORIGIN` in `.env` ([Environment variables](#environment-variables)),
and none of them reaches the application — they configure the `gate` service alone.

### Who may enter

`./allowed-emails.txt`, beside `compose.yaml`, one Google address per line, bind-mounted read-only
into the gate and re-checked on every request. It is gitignored;
[`allowed-emails.example.txt`](../allowed-emails.example.txt) is the committed copy showing the
format, and [`google-sign-in.md`](google-sign-in.md#step-5--the-allowlist) is where it gets written.

There is no domain rule and deliberately no option for one: the narrowest domain that would admit
this household also admits every other Gmail account on earth. The file is the only authorization
this instance has, and everyone on it sees and can do everything. Editing it is
[a lever with real teeth](#revocation-and-the-levers-you-have).

### Where the database lives

`./volumes/db/data`, beside `compose.yaml`. Make it before the first `up`:

```sh
mkdir -p ./volumes/db/data
```

**It has to exist, and the first time it has to be empty.** Compose binds the `db-store` volume name
to that path; a missing directory stops `up` with a mount error naming it, rather than starting an
instance whose data quietly goes somewhere else. Only the full path will do — the driver mounts a
directory, it does not create one.

**You do not chown it.** `db` runs as uid 70 and never as root, and a plain bind mount would arrive
root-owned and stop `initdb` dead. A volume mounted over an *empty* directory takes the image's
ownership for it instead — the same seeding that gives Caddy a writable `/data`
([below](#before-you-enable-tls-give-caddy-volumes)) — so Docker sets `70:70` before Postgres looks,
whoever owns the checkout. Afterwards the directory is `0700` uid 70 and your own account cannot
read inside it. Borrow root from the daemon to look:

```sh
docker run --rm -v "$PWD/volumes/db:/v" postgres:17-alpine ls -la /v/data
```

**A directory with anything already in it skips that seeding**, and Postgres then refuses it by one
of two messages: `initdb: error: directory "/var/lib/postgresql/data" exists but is not empty` for a
stray file such as a `.gitkeep`, and
`initdb: error: could not access directory "/var/lib/postgresql/data": Permission denied` for a
cluster copied in by hand with its ownership lost. Set the ownership yourself in that case, still
without host root:

```sh
docker run --rm -v "$PWD/volumes/db:/v" postgres:17-alpine chown -R 70:70 /v/data
```

**Moving the deployment moves the database with it**, and the first `up` at the new path stops to
ask: `Volume "portfolio_db-store" exists but doesn't match configuration in compose file. Recreate
(data will be lost)?` — because the volume record holds the old absolute path. Answer `y`. What gets
recreated is that pointer, not the directory; this is the one configuration where the prompt's
warning does not apply, and `docker compose down -v` is harmless for the same reason.

### What to put in `.env`

`cp .env.example .env`, then fill in the gate section and generate `POSTGRES_PASSWORD` —
[`google-sign-in.md`](google-sign-in.md) walks you through where the gate's own values come from;
[Environment variables](#environment-variables) has `POSTGRES_PASSWORD`'s own recipe
(`openssl rand -hex 32`). Both are required now: `docker compose up` refuses to start with either
missing, naming whichever it reaches first. `POSTGRES_PASSWORD` is worth getting right before that
first `up` specifically, because Postgres reads it only when it first initialises an empty data
directory — setting it after is a different, more annoying operation
([Environment variables](#environment-variables) has that recipe too). Beyond the two of them, every
setting has a working default, `DATABASE_URL` included: Compose points it at the bundled `db` service
unless you say otherwise.

The full surface, with defaults, is the table in [Environment variables](#environment-variables).

### Running against your own Postgres

Set `DATABASE_URL` in `.env` to point at it. Four things that catch people:

- The connection is made from inside a container, so `localhost` in that URL means the *app
  container*, not your host. Use a hostname or address the container can actually reach.
- The bundled `db` service still starts, still initialises `./volumes/db/data`, and `app` still
  waits for it to report healthy. Setting `DATABASE_URL` alone does not remove it, and deleting the
  `db` service by hand does not work on this release: `dump` also depends on it and is not written
  to be optional, so removing `db` without removing `dump` too leaves `service "dump" depends on
  undefined service "db": invalid compose project` and every verb refuses. Load
  [`compose.external-db.yaml`](../compose.external-db.yaml) instead, built for exactly this — put
  `COMPOSE_FILE=compose.yaml:compose.external-db.yaml` in `.env` rather than passing `-f` on every
  command, and it gates `db` and `dump` behind a profile nothing sets by default, so neither starts,
  and gives `app` a fourth network, `external-db`, that — unlike every other network here — carries
  a default route, because reaching a host outside this Compose project needs one. Forgetting the
  override leaves the bundled `db` running and `app` still without that route, so the connection to
  your own Postgres fails outright: `EAI_AGAIN` or `ENOTFOUND` when `DATABASE_URL` names a hostname,
  since resolving it is what fails first, and `ETIMEDOUT` or `EHOSTUNREACH` when it names a bare IP
  instead, with nothing in either message naming this file. `POSTGRES_PASSWORD` is still required
  with the override loaded, even though `db` never starts under it — `compose.yaml` still
  interpolates its value for the `PGPASSWORD` `app` reads — so generate one regardless.
- Migrations run at every container start, against whatever `DATABASE_URL` names, so the role needs
  to be able to create tables. There is no separate migrate step to run.
- Every `pg_dump` command below runs *inside* the bundled `db` container. On your own Postgres,
  backups become your Postgres's problem, and [Backups](#backups) is then about `.env` and the
  allowlist only.

### Verify it actually worked

```sh
docker compose ps
curl -i http://localhost/healthz
```

`db`, `app`, `worker`, `gate` and `caddy` all `running` and `healthy` — and `dump` too unless
you set `DUMP_ENABLED=false`, which is meant to read as `Exited (0)` rather than as another
healthy row. `caddy`'s own check requests `/healthz` through its full
proxy path to `app`, so a healthy `caddy` means the hop works and not merely that the process is up.
Look for `worker` by name: nothing depends on it, so a command or a compose file that leaves it out
starts everything else correctly and simply never starts it — no error, no unhealthy row, an *absent*
one instead, the row nobody counts. And `/healthz` answering `200` with exactly:

```json
{"status":"ok","database":true,"migrations":"current","pendingMigrations":[]}
```

Any other body on that endpoint means something, and [Monitoring](#monitoring) says what.

That still proves nothing about `worker` — the `/healthz` above is `app`'s own and never crosses the
socket. Prove that hop too, once, right after this `up -d` and again after any change to the host's
engine or container runtime: an SELinux-enforcing host, `userns-remap`, or rootless Docker can each
leave the worker's socket permissions different from what this stack assumes, and none of it is
proven anywhere in this repo's CI, because its runner is none of those.

```sh
docker compose exec -T app node -e "
const r=require('node:http').request({socketPath:'/run/price-worker/worker.sock',path:'/healthz',agent:false,timeout:5000},res=>process.exit(res.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.on('timeout',()=>{r.destroy();process.exit(1)});r.end()
"
echo $?
```

`0` means `app` reached `worker` over the shared socket end to end; anything else — including a
silent hang, which the `timeout` above turns into a `1` within five seconds instead of blocking
forever, the same guard `worker`'s own healthcheck in `compose.yaml` carries — see
[Monitoring](#monitoring).

`/healthz` is the one path the gate does not challenge, so a `200` there proves nothing about
sign-in. Check the front door separately:

```sh
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' http://localhost/
```

A `302` to `/oauth2/sign_in` is the gate refusing an unauthenticated request, which is what you
want. A `200` means the gate is not in the path and every device on your LAN has the instance.

The last leg — a real Google account completing a real sign-in — is yours to walk once, from a
browser at your public origin. Nothing in CI can do it, and nothing on the box can either.

> **`scripts/smoke-test.sh` is a CI tool and it destroys data.** It empties `./volumes/db/data`
> before it starts and again from an exit trap — every statement, every stored original, every
> price. (`docker compose down -v` no longer would, so the script deletes the contents itself,
> through a root container.) It exists to prove that a *fresh* machine refuses
> to start until the gate is configured and then comes up whole, using throwaway Google credentials
> that never contact Google. Never point it at an instance you care about.

---

## Environment variables

The complete configuration surface an operator has. Every deployment setting is an environment
variable, with one exception — who may enter is [a file](#who-may-enter), because it is a list that
grows. The household's own settings (the capital gains rate, the masking policy, the refresh
cadence) are database rows edited under Settings instead, not here. [`.env.example`](../.env.example)
is this same table with the reasoning attached; copy it to `.env` and fill in the gate section.

All of them are validated once at startup. A missing or malformed value stops the container
immediately with a message naming the variable, rather than failing hours later on the request that
happens to need it.

| Variable | Required | Default | What it does |
|---|---|---|---|
| `DATABASE_URL` | **Yes** | — | Postgres connection string. Compose supplies one pointing at its own `db` service, so you only set this to run against your own Postgres. |
| `AUTH_GATE` | No | `none` | Whether the app has been *told* that something in front of it authenticates. `external` silences the unprotected-instance banner; `none` draws it. `compose.yaml` hardcodes `external` because the `gate` service is right there, so you do not set this — a developer running the app with nothing in front of it does. It is a description of the deployment, not a switch: setting it protects nothing. |
| `PORT` | No | `3000` | The port the app listens on *inside* the compose network, and the port Caddy proxies to. It is **not** the published host port: that is the fixed `80:8080` in [`compose.yaml`](../compose.yaml). Moving the host side means editing the left half of that line; the right half is Caddy's listener and is also the `Caddyfile`'s site address, so those two only ever move together. |
| `MAX_UPLOAD_MB` | No | `10` | The most a statement upload may carry, in whole mebibytes, minimum 1. A brokerage CSV is tens of kilobytes, so the cap bounds an accident, not real use. **Not wired through `compose.yaml`** — see below. |
| `MARKET_TIMEZONE` | No | `America/New_York` | IANA zone for deciding whether the market is open, and for reading which trading day a quote belongs to — so it picks the date a daily close is filed under. No effect on how timestamps are stored, which is UTC. |
| `TZ` | No | `UTC` | Container clock. The database stores UTC whatever this says, so this only affects how the app's own log lines read. Leaving it at `UTC` is recommended. |
| `PRICE_WORKER_SOCKET` | No | `/run/price-worker/worker.sock` | Where the app dials the price worker and where the worker listens. **Development only** — `compose.yaml` sets it for neither `worker` nor `app`, so both run this same fixed default, meeting at the mount inside the shared `price-worker-sock` volume. Set it only for a checkout running the worker outside Compose, under `/tmp`. |

**One variable this table used to carry is gone.** How often quotes are refreshed is the
household's dial rather than the deployment's, so it moved into the application: set it at
Settings → Prices (whole minutes, 1–1440, default 15; the automatic poll still runs in the app
process; its *quotes* are asked for only while the market is open, while the backfill batch beside
them rides a tick at any hour and only while some spine still has a gap. The **Refresh now** control
on any figure screen spends a request at any hour either way). An environment that still sets the old
`PRICE_POLL_INTERVAL_MINUTES` is ignored without error — if you had tuned it, re-enter the value
once on that screen after upgrading.

**The gate's own settings are Compose-level, and gate-only.** `GATE_CLIENT_ID`, `GATE_CLIENT_SECRET`
and `GATE_COOKIE_SECRET` configure the `gate` service alone — the application never sees any of
them. Each has no default on purpose, and `compose.yaml` interpolates each with `${VAR:?}`, so
`docker compose up` stops on the first one that is unset *or empty* and names it — before a
container exists, which is why the message is Compose's rather than the startup validator's at this
stage.

- `GATE_COOKIE_SECRET` must decode to exactly 16, 24 or 32 bytes; the gate builds an AES cipher from
  it and refuses to start otherwise, naming `cookie_secret` in its log. Generate one with
  `openssl rand -base64 32 | tr -- '+/' '-_'`. Rotating it is
  [the blunt revocation lever](#revocation-and-the-levers-you-have).

**`PUBLIC_ORIGIN` is not gate-only: the application reads it now too** — [the lock](#the-lock)
derives from it the one identity a passkey check has to run against, which makes it another setting
shared with the sidecar rather than owned by it alone — not the first: `compose.yaml` already passes
`TZ` to both `app` and `gate`, and the app validates and uses that one too. It carries the same
no-default,
`${VAR:?}` treatment as the settings above, so `docker compose up` stops on it too if it is unset or
empty. The gate still builds its Google redirect URL as `PUBLIC_ORIGIN` + `/oauth2/callback`, which
must match what is registered on the OAuth client exactly ([One-time Google setup](#one-time-google-setup)) —
that half is unchanged.
What is new is that the application's own startup validator checks the same value a second time,
stricter than Compose's "present and non-empty," and a value that clears Compose's bar can still
fail this one:

- the scheme has to be `https://` — `http://localhost` is the one exception, for the dev loop;
- the host cannot be an IP address, only a domain name;
- it has to be a bare origin: no path, no query string, no fragment — never
  `.../oauth2/callback`, the whole redirect rather than the origin it is built from;
- and it has to already be spelled canonically: no trailing slash, no differing case, no default
  port spelled out. `https://portfolio.example.com` passes; `https://portfolio.example.com/` and
  `https://Portfolio.Example.com:443` name the identical origin and are refused anyway.

The last one is the one worth knowing about before it surprises you. A passkey check compares this
value against what the browser actually sent, as plain text — neither side is renormalised first —
so a spelling that is merely *equivalent* is still a mismatch there, and the honest alternative to
refusing it up front would be every unlock and every enrolment failing quietly once the instance is
in production. Copying the address straight out of a browser's own address bar is exactly how a
trailing slash gets in; strip it before it goes in `.env`.

**Changing this value to a different hostname does more than move the gate's redirect.** The lock's
relying-party id is derived from it too — the bare hostname, via `expectedRelyingParty` in
[`app/lib/lock.server.ts`](../app/lib/lock.server.ts) — so every passkey enrolled against the old
hostname stops verifying the moment the new one is served, whether or not the database that still
lists it came along for the move. If the household holds any passkeys, moving to a new hostname is
not only this variable and the registered redirect: remove every enrolled passkey as part of the
move (the command is in
[the runbook](runbook.md#every-browser-is-locked-and-no-passkey-can-be-reached)), then have the
household enrol again once the new hostname is serving. Skipping that does not merely orphan the old
passkeys — it leaves the instance locked, with none that can unlock it.

**Two more that Compose reads and the application never sees.** `POSTGRES_PASSWORD` is the `db`
service's password; how to set it the first time is [above](#what-to-put-in-env), and how to change
it once the cluster already exists is a few paragraphs down in this same section — not under
[Running against your own Postgres](#running-against-your-own-postgres), which is only about
pointing at a Postgres this project does not manage.
`APP_VERSION` is the published image tag the `app` service runs — it defaults to `1`, the floating
major, which is what makes `docker compose up -d` an upgrade. Pin a full version (`APP_VERSION=1.0.3`)
to hold this instance where it is, or to go back to a known-good image; see
[There is no rollback](#there-is-no-rollback) first, because the image alone is not one. Neither
variable is validated at startup: they are resolved by Compose before a container exists, so a typo
surfaces as a failed pull, not as the message naming the variable that the settings below get.

**An empty value reads as unset, not as "configured to empty" — on both sides, in opposite
directions.** For the application's own variables an empty assignment falls back to the default, so
`AUTH_GATE=` in `.env` means `none` and the app draws its warning banner: it errs towards claiming
less protection than it has, never more. For the gate's own settings, empty is a refusal to start. Neither
can leave you quietly unprotected.

**`MAX_UPLOAD_MB` does not reach the container under the bundled Compose file.** It is validated and
read by the application, but it is missing from the `app` service's `environment:` block, so setting
it in `.env` changes nothing and the cap stays at 10. To raise it, add the variable to that block
yourself:

```yaml
    environment:
      MAX_UPLOAD_MB: ${MAX_UPLOAD_MB:-10}
```

`POSTGRES_PASSWORD` also appears in `.env.example`. It configures `compose.yaml` rather than the
app, which is why it is not in the table above.

**It only takes effect on an empty data directory.** Postgres reads it when it first initialises its
data directory and never again, so editing `POSTGRES_PASSWORD` in `.env` alone rotates nothing
already running. Write the new value to `.env` first, then change the role to match, then recreate
the containers that still hold the old one:

```sh
# In .env: POSTGRES_PASSWORD=the-new-one
docker compose exec db psql -U portfolio -d portfolio \
  -c "alter role portfolio with password 'the-new-one'"
docker compose up -d
```

`app` and `dump` read the password through `PGPASSWORD`, set from this same variable — there is no
`DATABASE_URL` to keep in sync with it any more.

---

## Reverse proxy and TLS

**Two proxies, and they do different jobs.** This stack assumes you already run a house-wide
reverse proxy that terminates TLS and owns the public hostname; the bundled `caddy` container sits
behind it, speaks plain HTTP on the box's port 80, and is where the gate is enforced. Caddy's
configuration lives in [`Caddyfile`](../Caddyfile) at the repository root.

| | Terminates TLS, owns the hostname | Enforces the gate |
|---|---|---|
| Your house proxy | **yes** | no |
| This stack's `caddy` | no | **yes** |

**Enforcement is deliberately not the house proxy's.** A device on your LAN can dial this box's
published port 80 directly and land on the bundled Caddy, skipping the house proxy entirely — and
that device is the whole reason the gate exists. So the gate travels with the app, in the one
container every path to it shares.

`caddy` is also still the only container that publishes a port. `app`, `db` and `gate` are reachable
only on the compose network, which is what keeps those ports off your LAN rather than relying on you
to bind them to loopback.

**Point your house proxy at this box's port 80**, and serve it at the origin you put in
`PUBLIC_ORIGIN`. Nothing else has to be configured there: the bundled Caddy sets the forwarded
headers the gate and the app need, and trusts the ones your proxy set
([Forwarded headers](#forwarded-headers)).

**The session belongs to that origin.** The gate issues its cookie `Secure` and scoped to the host
the browser used, so a browser that reaches this stack any other way — the box's IP over plain HTTP,
a second hostname — holds no cookie the gate will accept, and is bounced to Google and back to
`PUBLIC_ORIGIN` rather than being let in where it stands. That is the gate working, not a
misconfiguration.

### If this stack's Caddy is your only Caddy

Everything above assumes a proxy in front. Running without one is supported, but five things change,
and all five are yours to do:

- **Give the site block a real hostname** instead of `:8080` in the `Caddyfile`, so Caddy requests
  and renews a certificate for it, and add `http_port 8080` / `https_port 8443` to its global block.
  Then publish `443:8443` alongside the existing `80:8080`. Caddy is pinned to an unprivileged uid
  and cannot bind 80 or 443 inside the container; those two options are Caddy's own answer to exactly
  that — the ports it listens on internally, with the public ones forwarded onto them — and they do
  not change what a browser connects to. 80 still carries the redirect and the ACME HTTP challenge,
  one hop further in.
- **Swap Caddy's two tmpfs mounts for named volumes** before the first certificate is issued. The
  section below is then about you, and it is a replacement rather than an addition.
- **`PUBLIC_ORIGIN` is that hostname**, and the redirect URI registered with Google is that hostname
  plus `/oauth2/callback`. There is no second place to change.
- **Keep the `handle` blocks as they are.** The `/healthz` exemption, the `/oauth2/*` passthrough to
  the sidecar and the `forward_auth` on everything else are the gate. Adding TLS is editing the site
  address and the global block, never the body.
- **Adjust the container healthcheck, and any uptime monitor** — the end of the section below has
  the working shape.

The `trusted_proxies` line stays correct either way: with no proxy in front there is simply nothing
sending `X-Forwarded-*` for Caddy to believe.

### Before you enable TLS, give Caddy volumes

Relevant only if you terminate TLS here rather than at a house proxy. `compose.yaml` puts Caddy's
`/data` and `/config` on tmpfs, so both die with the container. `/data` is where it keeps the ACME
account key and every certificate it has ever issued. Recreating the container throws all of it away
— and recreating the container is exactly what the `docker compose up -d` in
[Upgrading](#upgrading) does, every time. The next start asks the certificate authority for
everything again from scratch. Enough of those in a week and Let's Encrypt's rate limit refuses,
which leaves the site with no certificate at all and a wait before it can have one.

**Replace the tmpfs entries; you cannot add volumes beside them.** Compose refuses two mounts on one
target — `target /data already mounted as services.caddy.tmpfs` — so the whole `tmpfs:` block goes:

```yaml
  caddy:
    # delete the `tmpfs:` block; these two take its place
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  # db-store keeps the driver_opts compose.yaml gives it — do not flatten it to
  # a bare name while adding these two, or the database moves.
  db-store:
    driver: local
    driver_opts: { type: none, o: bind, device: ./volumes/db/data }
  caddy_data:
  caddy_config:
```

**A fresh volume needs nothing more.** Volumes seed from the image, and the image's storage
directories — `/data/caddy`, `/config/caddy` — are world-writable, so uid 65532 writes them from the
first start. (The root-owned `0755` parents are why the tmpfs entries carry `mode=1777`: a tmpfs
seeds nothing.) A volume created any other way must have `/data/caddy` writable to 65532 — an
unwritable one fails at config load, `provisioning CA … permission denied`. Probe the storage path,
not its parent:

```sh
docker compose exec caddy sh -c 'touch /data/caddy/ok && rm /data/caddy/ok'
```

`caddy_data` is the one that matters. `caddy_config` only saves re-deriving the autosaved config,
and costs nothing to add at the same time.

**One more thing then needs adjusting: the container healthcheck, and any uptime monitor.** The
check requests `http://127.0.0.1:8080/healthz`, which on a hostname site meets the HTTPS redirect —
and pointing busybox `wget` at the TLS listener fails on SNI. Keep a plain-HTTP site carrying only
the exemption beside the hostname block:

```
http://127.0.0.1:8080 {
	handle /healthz {
		reverse_proxy app:{$APP_PORT:3000}
	}
}
```

External monitors move to `https://<hostname>/healthz` — plain-HTTP `/healthz` now answers only from
inside the container.

### Forwarded headers

The gate **trusts `X-Forwarded-*`**, and the bundled Caddy sets them itself — nothing to configure
there. The application now reads no forwarded header at all; the two it used to read went with the
password it served.

| Header | Who reads it | Effect |
|---|---|---|
| `X-Forwarded-Proto`, `X-Forwarded-Host` | `gate` | The scheme and host the sign-in redirects are built with. Without them the sidecar would build them from this stack's internal plain HTTP and nobody could follow them. |
| `X-Forwarded-For`, `X-Real-IP` | `gate` | The client address in the sidecar's own log lines. Nothing is authorised on either. |
| `X-Auth-Request-Email` | nothing, yet | The [authenticated email](../CONTEXT.md) the gate vouched for, forwarded to `app` on every admitted request. The app reads it nowhere today — it is attribution, never permission — and Caddy deletes any value a browser sent before copying the gate's, so nobody can assert their own identity. |

**The Caddyfile trusts these from any private address**, not from one named proxy: it sets
`trusted_proxies static private_ranges`, because the house proxy's address is yours and not this
repository's. The honest reading is that a peer on your LAN can forge `X-Forwarded-*` at this stack.
That is affordable only because nothing decides anything on them — the gate's verdict comes from a
session cookie it decrypts itself, and its redirect URL is pinned in `compose.yaml` rather than read
from a header. If you want it tighter, replace `private_ranges` with your proxy's address.

The database is never exposed either: `compose.yaml` publishes no port for it, and the app reaches
it over the compose network.

---

## Installing on a phone

**The instance installs as an app, at `PUBLIC_ORIGIN` and nowhere else.** The application ships a
web app manifest and a service worker, so a browser signed in through the house proxy's HTTPS
origin can add it to the home screen as a real install — its own icon, a standalone window.
Everything involved stays behind the gate, with no asset path exempted in the `Caddyfile` for it —
[`ARCHITECTURE.md` §7.7](../ARCHITECTURE.md#77-the-installed-shell) holds the mechanism.

Two properties are decisions rather than gaps
([ADR-0007](adr/0007-the-service-worker-stores-nothing.md)):

- **Nothing is stored on the phone.** The service worker is network-only — no cached screens, no
  last-known figures. Off the VPN, the installed app shows a branded connect-the-VPN page and
  nothing else, so a phone that leaves the household holds no balances.
- **A LAN address does not install.** Service workers require a secure context; the house proxy's
  TLS supplies it at [`PUBLIC_ORIGIN`](#reverse-proxy-and-tls), plain-HTTP LAN addresses supply
  none — and the gate refuses those requests anyway.

---

## Security

[`ARCHITECTURE.md` §7.6](../ARCHITECTURE.md#76-security-posture) holds the control table — what each
mechanism is and why it was built that way. **That table is deliberately not repeated here.** This
section is the other half: the decisions that are yours, and the consequences you inherit whether or
not you make them.

### What the gate checks, and what an attacker on your LAN reaches

Every request that arrives at the bundled Caddy — including routes that do not exist yet, and
including the JavaScript bundles, the CSS and the font, which the old in-app gate left open — is
put to the `gate` sidecar before Caddy will forward it. The sidecar admits it only if all of this
holds:

- the request carries the gate's session cookie, and that cookie decrypts with `GATE_COOKIE_SECRET`;
- the email inside it is on `allowed-emails.txt`, **re-checked on every single request**, not only
  at sign-in;
- and the person got that cookie by completing a real Google sign-in at `PUBLIC_ORIGIN`.

Anything else is a redirect to Google. A guest on your wifi who finds the instance by IP gets the
account picker and, if they sign in with an address that is not listed, an error from the gate — not
a page.

**`/healthz` is the one exemption**, so uptime monitoring keeps working without a Google account.
It carries no household data, but it does name the *filenames* of any migration the image carries
that the database has not applied — a version fingerprint available to anyone who can reach port 80.
That is unchanged from before the gate, which exempted the same path.

**The allowlist is the whole of authorization.** Everyone it admits sees and can do everything:
every balance, every account, every uploaded statement, and every screen that writes. There is no
read-only mode, no per-person permission, and no admin. The authenticated email the gate attaches to
each request is attribution, never permission, and nothing in the app reads it.

### Fail-closed, and what that buys you

There is no configuration of this stack that serves the application to an unauthenticated visitor.
A missing or empty gate credential stops `docker compose up` before a container exists; a missing
`allowed-emails.txt` stops it the same way; a `GATE_COOKIE_SECRET` of the wrong length stops the
sidecar; and a stopped sidecar means Caddy answers nothing but `/healthz`. The failure mode is an
instance that is **down**, never one that is open. That is the trade the old
"boots with no manual steps" contract was exchanged for, and it is deliberate.

The application still carries its unprotected-instance banner, and behind this stack you will never
see it — `compose.yaml` tells the app a gate fronts it. **If that banner ever appears on your
instance, believe it**: something is serving the app without the gate in front.

### What the code still does not do, that you may assume it does

**Rate limiting and lockout are Google's, not yours.** There is no password to guess here any more,
so the brute-force surface moved to Google's own sign-in — which does have rate limiting, lockout
and whatever second factor each family member has enabled. What is *not* rate limited is the gate
itself: an unlisted address can be offered at it as fast as the network allows, and each attempt is
refused with nothing counting them. Nothing in the Caddyfile limits rates either; the stock
`caddy:2-alpine` image has no rate-limiting module.

**Session handling is the sidecar's, and its shape is fixed in `compose.yaml`.** The cookie is
encrypted rather than merely signed, `SameSite=Lax` and `Secure` are set explicitly, and the
lifetime is the seven-day default — which is what makes signing in a once-per-device event rather
than a weekly ritual, because the renewal bounces through Google without showing anyone a screen.
The *gate* keeps no server-side session store, so there is nothing to revoke one of its cookies
against; see [the levers below](#revocation-and-the-levers-you-have). The lock's own grants are a
different matter — those are rows, and removing the passkey that minted them takes them with it;
[The lock](#the-lock) below and the runbook's own entries say how.

**There is no CSRF token anywhere.** `SameSite=Lax` is the whole of the posture. The app issues a
cookie of its own now too — [the lock](#the-lock)'s grant — so the posture no longer rests on the
app carrying none; it rests instead on that cookie carrying `SameSite=Lax` too, for the same reason
the gate's does. `compose.yaml` still pins the gate's own cookie to it; the app's is set the same way
in its own code (`lockCookie`, `app/lib/lock.server.ts`) rather than by `compose.yaml`, since this
cookie is the app's to attach, not the gate's. Against a signed-in household that covers the ordinary
cross-site form post.

**No security headers are set at all.** No CSP, no HSTS, no `X-Frame-Options`, no
`X-Content-Type-Options`: the app sets none and the Caddyfile sets none. If you want them, a `header`
block in the Caddyfile is where they go. Nothing in the app depends on their absence, but nothing has
been run behind a strict CSP either, so test it rather than assuming.

**The gate container runs as root, holding one capability.** `app`, `db` and `caddy` do not; `gate`
does, because the published `-alpine` image sets no `USER` and `compose.yaml` argues that pinning a
uid here would be the worse choice — it would decide on your behalf that your allowlist file is
readable by that uid, and hand you a sidecar that will not start over a file mode nobody mentioned.
What bounds it: every capability dropped but `DAC_READ_SEARCH`, which is exactly the root power being
kept — opening a file it does not own, whatever its mode — plus `no-new-privileges`, a `read_only`
filesystem with a tmpfs `/tmp`, no volume and no published port. Uid 0 holding one capability is a
far smaller soft spot than root was, and it is still written down rather than left to be discovered.

**A LAN peer can forge `X-Forwarded-*` at this stack**, because the Caddyfile trusts them from any
private address rather than from one named proxy ([Forwarded headers](#forwarded-headers)). That is
affordable only for as long as nothing authorises on them, which today nothing does.

### Revocation, and the levers you have

Three, in ascending order of blast radius. The first two are the real ones.

**Remove the address from `allowed-emails.txt` — this signs that person out everywhere.** The gate
re-validates every request's email against the file and watches the file for changes, so their next
request is refused and their cookie is cleared, on every device, without touching anyone else's
session. **Restart the gate afterwards anyway:**

```sh
docker compose restart gate
```

Not because the removal needs it, but because a single-file bind mount can stop following a file an
editor replaces by rename — you would be left with the gate holding the old list and no sign that
anything went wrong. The restart is cheap and removes the doubt.

**Rotate `GATE_COOKIE_SECRET` — this signs out everyone, on every device, at once.** Every existing
cookie stops decrypting the moment the new secret is in place. There is no rotation list, no grace
period and no overlap window, so plan it for an evening. This is the lever for a leaked cookie or a
lost device you cannot be sure about.

```sh
# In .env: GATE_COOKIE_SECRET=$(openssl rand -base64 32 | tr -- '+/' '-_')
docker compose up -d gate
```

**The sidecar's sign-out URL is `PUBLIC_ORIGIN` + `/oauth2/sign_out`, and it is worth less than it
sounds.** It clears the gate's own cookie in that one browser and nothing else: the Google session
on the device is untouched, and sign-in goes straight to Google with no screen of our own in the
way, so the next visit bounces out to Google and back and is re-admitted without anyone typing
anything — silently, on a device signed into one Google account. It is useful for handing a phone to
someone for a minute. It is not revocation, and there is no sign-out control in the UI — that is
deliberately deferred and tracked as [issue #89](https://github.com/chethan123/portfolio/issues/89),
and these limits are the argument for it.

### One thing that leaves the house

The app makes outbound requests to exactly one destination: the price provider. What goes out is the
list of ticker symbols being priced, plus your public IP. Quantities, balances, account names, people
and filenames do not. There is no analytics or error-reporting SDK anywhere in the image. It is still
worth knowing that the symbol list reveals *what* is held, if not how much — an operator who objects
can price instruments manually or block egress and accept permanently stale prices. The app degrades
to the last known price, never to zeros.

### Can I put this on the internet?

The honest answer changed with the gate, but not all the way to yes. The threat this was built
against is a device on the household's own LAN — the guest phones and the IoT that share the wifi —
which is why the gate is enforced here rather than at your house proxy
([`ARCHITECTURE.md` §7.6](../ARCHITECTURE.md#76-security-posture),
[ADR-0005](adr/0005-auth-is-a-forward-auth-gate.md)). Everything a stranger on the internet would
meet is the same gate, and the sign-in behind it is Google's. What does not change is that every gap
above stays yours to compensate for, in front of the app.

If you are going to do it:

- [ ] TLS terminated in front, with a real certificate, and — if that is this stack's own Caddy —
      its `/data` [on a volume](#before-you-enable-tls-give-caddy-volumes) so it survives an
      upgrade.
- [ ] `PUBLIC_ORIGIN` and the registered redirect URI on the public hostname, not a LAN one.
- [ ] `GATE_COOKIE_SECRET` generated fresh and not reused from anything else.
- [ ] The allowlist re-read as what it now is: the only thing between the internet and the
      household's finances.
- [ ] Rate limiting in front of `/oauth2/*`, if you want the gate itself bounded rather than only
      Google. The stock `caddy:2-alpine` image has no rate-limiting module, so this means a custom
      Caddy build or a different proxy.
- [ ] Accept that you are now responsible for patching an internet-facing surface — including the
      pinned `gate` image, which nothing here updates for you — on whatever schedule the internet
      decides.

One addition to §7.6's error-disclosure row, because it is a deployment fact rather than a code fact:
in a production build React Router replaces a thrown error's message with a generic one before it
reaches the page, so a Postgres error does not leak from the shipped image. That is a mitigation for
the deployed case only. It is not true under `react-router dev`, which should never face anything.

**A VPN is not the answer here, and that is a decision rather than an oversight.** It was the old
recommendation, and [ADR-0005](adr/0005-auth-is-a-forward-auth-gate.md) rejects it for this threat
model: a VPN onto the LAN does nothing about an adversary already on that LAN. Run one if you want
remote access without publishing a port — but run it as well as the gate, never instead of it.

---

## The lock

Once the household enrols a passkey — from Settings → Passkeys, inside the app itself — every
browser the gate has already admitted is additionally refused every screen until a passkey check
unlocks it.
[ADR-0012](adr/0012-a-browser-past-the-gate-is-shown-nothing.md) is the design record and
[the family guide](guide/passkeys.md) covers it in the household's own words. This section is what
it means for you.

### A fresh instance is not locked

There is no lock until somebody turns it on, and there is no separate switch: **the instance is
locked whenever the household holds at least one passkey, and open whenever it holds none.** A
brand-new instance holds none, so every family member the gate admits sees every figure, exactly as
it always has — nothing here changes what a fresh install looks like.

### Before the household's first passkey

**Nobody has done this yet.** The slice that shipped the lock was verified against a real Postgres
and a headless Chromium, and against no real device at all. Until somebody runs the two steps below
on the household's own phones, one sentence the enrolment screen shows is a reasonable expectation
rather than an observed fact, and that screen hedges it accordingly.

1. Enrol the household's first passkey on the household's primary phone.
2. On a second device holding no passkey, open the instance, press **Unlock**, and watch for an
   offer to use another device — a code to scan, or a prompt arriving on the phone. Approve it on
   the phone, and confirm the second device lands on the Overview.

If step 2 offers nothing of the kind, try it again in another browser on that device — WebKit and
Chromium do not read the stored transports the same way, so one browser's silence is not every
browser's. If none of them offers it, the first thing to try is another passkey rather than a
reset. A locked
browser is offered every credential the household holds (`allowCredentialList`,
[`app/lib/lock.server.ts`](../app/lib/lock.server.ts)), and the rule below turns on *any one* of
them reporting `hybrid`. So enrol a second passkey from a browser that is still unlocked — usually
the one that did the first enrolment — using a different provider, since a passkey is created on the
device doing the enrolling and the provider that made the first one is excluded from making a
second. If that is not possible either, deleting every passkey returns the instance to open —
[the runbook](runbook.md#every-browser-is-locked-and-no-passkey-can-be-reached) carries the command
and the order to run it in — and the household can enrol again from a provider whose passkeys reach
other devices.

Which providers those are is a fact about the *registering* client rather than about this app. The
credentials this instance offers a locked browser carry whatever transports the enrolling client
reported, and both WebKit and Chromium hide the use-another-device option when every offered
credential lists `internal` alone. Current iCloud Keychain and Google Password Manager report
`hybrid` beside `internal`, which is what makes the option appear, and Chrome's own macOS profile
authenticator reports no transports at all, which Chromium alone reads as "allow everything" —
WebKit offers the option only where a credential lists `hybrid` itself. Older
Safari and Android values were not verified, and nothing else has been checked.

**Write down what you find, here.** Once the walk has been run, record which providers were tried
and what each offered. That record is what lets a later change take the hedge out of the enrolment
screen's own sentence: it may say what was observed, and until then it keeps hedging.

### Enrolling the first one locks everyone else, from their very next request

The moment anyone enrols the household's first passkey, every *other* browser in the household is
locked — not on its next visit to Settings, not after some delay, but from the next request it makes.
The browser doing the enrolling is the one exception; it stays unlocked. The enrolment screen says so
before it lets anyone finish, and it is worth saying to the household yourself before you press it,
not after.

What it cannot do is reach into a screen somebody is already looking at. Deleting a grant stops the
next request; it does not repaint a page already drawn, so a browser sitting on a rendered screen
keeps those figures until it asks the server for something. Protected responses carry
`Cache-Control: no-store` so a Back gesture has to ask, but the guarantee is worth stating as what it
is: the lock ends the reading, not every pixel already on screen. Somebody who wants a particular
screen gone *now* should press **Lock now** on that browser rather than expect an enrolment
elsewhere to blank it.

That first enrolment needs no passkey check of its own — there is nothing yet to check against, and
anyone the gate has already admitted is already seeing every figure at that moment. Every enrolment
after the first, and every removal, does require one: a fresh check right there, not merely an
already-unlocked browser, because an unlocked browser is exactly what the threat this exists for
hands an adversary.

### If every passkey the household holds becomes unreachable

A household down to one passkey has no lever narrower than yours if that one becomes unreachable.
Removing a passkey needs a fresh check from a reachable enrolled passkey — even the very one being
removed, which is exactly how removing a household's last passkey turns the lock off — so what
strands a household is not the removal rule but the passkey itself going missing: lost, broken, or
otherwise out of reach, with nothing else enrolled to check in with. Encourage a second passkey the
moment the first is enrolled, for exactly this reason.

**Recovering is deleting every enrolled passkey**, which is the one thing that lifts the lock without
a check — and it is deliberately the only thing. There is no token, no recovery code and no way in
through the front door: doing it means reaching into the database directly, the same shell
[ADR-0005](adr/0005-auth-is-a-forward-auth-gate.md) already names as this instance's break-glass. See
[the runbook](runbook.md#every-browser-is-locked-and-no-passkey-can-be-reached) for the command. Once
every passkey is gone the instance reads exactly as though none was ever enrolled — unlocked, with
anyone the gate admits free to enrol again — because that is what "holds no passkey" already means;
there is no third state.

**Every browser in the household still holds a cookie naming a row you just deleted, and that is
fine.** The row is the authority and the cookie carries no claim of its own, so once the passkeys are
gone those cookies name nothing; the instance is unlocked for everybody either way. Each is cleared
on that browser's first refusal after somebody enrols again. Nobody has to clear anything by hand.

**The delete alone does not close a ceremony already in flight — stopping `app` before you delete does.**
A registration challenge lives in the app's own process memory, not in the database, for two minutes
after it is minted (`CHALLENGE_TTL_MS` in [`app/lib/lock.ts`](../app/lib/lock.ts)); a
browser that had already reached the "Create the passkey" step keeps that challenge live until either
it completes or the two minutes pass, and `app` is the only thing that can complete it. Delete first
and only stop-and-restart `app` afterward, and there is a live gap between the delete committing and
the stop taking hold: a registration that finishes inside that gap writes a passkey — because the
challenge was minted while the household still held one, the server accepts the completed ceremony as
an ordinary later enrolment rather than a first one, with no check required — and the instance is
locked again within seconds of you having cleared it, having made the restart do nothing. Stop `app`
first instead: with it down, nothing can complete a registration no matter how long the delete takes,
so there is no such gap left to race.

### `PUBLIC_ORIGIN` is stricter now than "must be set"

The application validates it, not only the gate, and refuses to start on anything less than an exact
canonical `https://` origin — see [Environment variables](#environment-variables) for the shape it
wants and why. If the container is refusing to start over it, [the runbook](runbook.md#the-app-container-keeps-restarting)
has the command that confirms it.

**Planning to move this instance to a new hostname?** Read
[the `PUBLIC_ORIGIN` entry in Environment variables](#environment-variables) before you do — the
lock's identity is derived from this value too, and a hostname change orphans every passkey the
household holds unless you remove them as part of the move.

---

## Monitoring

[`ARCHITECTURE.md` §7.4](../ARCHITECTURE.md#74-observability) lists the signals and where each one
comes from. **That table is not repeated here.** This section is what the answers mean, and — more
usefully — what they do not.

### `/healthz`

No credentials, `Cache-Control: no-store`, `200` or `503`. **Point your monitor at this path and no
other**: it is the one Caddy exempts from the gate, so anything else you probe answers with a
redirect to Google and reads as an outage. The response body is an API contract
pinned by a test (`tests/routes/healthz.test.ts` asserts it key for key, precisely so a rename cannot
break your dashboard silently), which is why it is quoted here rather than described:

```json
200  {"status":"ok","database":true,"migrations":"current","pendingMigrations":[]}
503  {"status":"unhealthy","database":false,"migrations":"current","pendingMigrations":[]}
503  {"status":"unhealthy","database":true,"migrations":"pending","pendingMigrations":["…","…"]}
```

Alert on `status`. Read `database` before `migrations`, and read `migrations` only when `database` is
true: the migration ledger lives *in* the database, so when the database is unreachable there is
nothing to read and the field still says `current`. **`migrations` is meaningless whenever `database`
is false**, and the second line above is what that looks like.

### What `/healthz` does not catch

**A database that is ahead of the code.** The check compares migrations on disk against migrations
applied, in one direction only: what is on disk and unapplied. It never asks the reverse. So an older
image against a newer database — a rollback, or a spare machine on an old tag — finds every migration
it ships already applied and reports `200` `"ok"` `"current"`, while the code queries a schema it was
never written against. **Rolling an image back is completely invisible to health checking.** It
surfaces as 500s on individual pages, never as an unhealthy instance. If you take one thing from this
section, take this one, and see [Upgrading](#upgrading).

**Writes failing.** The probe is `select 1`. A full disk, a read-only tablespace, a revoked `insert`
grant — all of them leave that succeeding. The container is healthy, the dashboard is green, and
every upload returns a 500.

**The price provider, deliberately.** A third-party outage must not make Compose restart a perfectly
healthy app. Stale prices are a UI signal — the "as of" line — not a health signal.

**Whether anybody can actually get in.** `/healthz` is the one path Caddy does not put to the gate,
which is what lets a monitor probe it without a Google account — and means a gate that is down,
crash-looping on a bad secret, or holding an allowlist that no longer has anyone on it leaves this
endpoint answering `200` while the household is locked out. Nothing watches the gate's verdict for
you, and `gate`'s own container healthcheck only asks whether the sidecar is alive, not whether it
would admit anyone.

**Disk and memory.** Nothing here watches either. `caddy` does now carry a healthcheck — a
`/healthz` request through its own proxy path to `app`, so an ingress that is up but cannot reach the
app shows as unhealthy. It still says nothing about whether anybody can sign in.

One shape worth being able to recognise: if the ledger read itself throws, the body comes back
`"database":true` and `"migrations":"current"` with `"status":"unhealthy"` — the healthy body with a
single field changed. Another reason to alert on `status` rather than on the fields.

### An unhealthy container is not restarted

`restart: unless-stopped` fires when the process **exits**, not when the healthcheck fails. An app
that is wedged but still running stays unhealthy, stays in service, and stays that way indefinitely.
`docker compose restart app` is a manual step. Whatever you point at `/healthz` therefore has to be
able to *act*, not only to alert — or you have to be the one who acts.

### The worker's own healthcheck

`worker` carries a healthcheck of the same shape as `app`'s — `node -e`, no shell, on an interval —
reached over `/run/price-worker/worker.sock` instead of a port, since the container publishes none.
Its `/healthz` consults nothing: it answers `200` the moment the process is accepting requests,
before it has made a single call to Yahoo. So "unhealthy" here means exactly that and nothing wider
— the worker is not accepting requests on its socket, ordinarily the process gone or wedged — never
"Yahoo is failing," which is a different thing entirely and shows up instead as stale prices and
`app`'s own `Price provider failed` line, with `worker` reporting healthy the whole time. Nor does
`/healthz` spend from either endpoint's own rate budget — the branch above answers before either
`admitQuotes` or `admitHistory` is ever consulted — so a worker whose ten quotes or twenty history
calls this minute are already spent keeps answering `200` while every real call over `/quotes` or
`/history` comes back `429`: the identical all-green, no-prices shape this subsection exists to
warn about, and post-cutover the one place it shows at all is `app`'s own log, not this healthcheck
(see [Logs](#logs)). And the restart rule above still holds: nothing here recreates `worker` on this
failing, so an unhealthy row in `docker compose ps` is where you look, not something Compose
resolves for you.

**Its resource bounds are argued in `compose.yaml` and watched nowhere.** `worker` runs under
`pids_limit: 64` and `mem_limit: 256m` — comfortable for what it does, which is hold one HTTP
connection at a time and wait on Yahoo. The two fail differently. Reaching the *memory* limit is a
plain `SIGKILL`: the worker logs nothing on the way out, the container exits `137`,
`restart: unless-stopped` brings it back, and it answers its own healthcheck again before anyone
looks — an OOM loop and a healthy worker are the identical row in `docker compose ps`. Reaching the
*process* limit kills nothing: the kernel simply refuses the next thread or process, so the worker
stays up, keeps answering `/healthz` — which starts no threads — and fails the work instead. The one tell is in the logs: `Price worker listening on …` is written once per
process start, so seeing it more than once is the process having started more than once — see
[Logs](#logs).

### Logs

`docker compose logs -f app` is the entire pipeline; there is no metrics endpoint, no tracing and no
log shipping. `docker compose logs -f worker` is a second stream worth watching even though nothing
calls it yet: the restart-loop tell above shows up nowhere else. `docker compose logs -f gate` is the
second half of the pipeline proper, and the only place a refused sign-in is recorded at all — the
application no longer sees one. The stems below are for grepping and may drift — the code owns the
wording:

- **One line per HTTP request** from the server's built-in request logger: method, path, status,
  duration. Note that the container healthchecks — the app's own and Caddy's — hit `/healthz` every
  ten seconds, and on an idle instance that is essentially the whole log.
- **One line per refresh the poller actually runs** — stem `Price refresh`. Informational when
  everything priced, a warning when anything came back stale. A tick that runs no refresh writes no
  line at all — [below](#there-is-no-price-line-in-the-log-has-four-causes) lists which silences
  are ordinary.
- **One line per backfill batch a tick ran that attempted or failed something** — stem
  `Price backfill`: instruments attempted, closes written, and how many calls failed. Informational
  when nothing failed, a warning otherwise, and preceded by `Price backfill batch failed` when the
  batch could not go on: at error level, or a warning when the provider was unreachable — grep the
  stem, not the level. **Absent when there was nothing to fill**, the ordinary case on an instance
  whose spine covers everything held — so a silence here is usually not a fault. What each attempt
  came to is a `price_backfill` row and a sentence at Settings → Prices.
- **A provider outage** at error level — stem `Price provider failed` — every selected instrument
  is marked stale and the last known prices are kept. Since the fetch moved behind the worker's
  socket, the same stem is also where an unreachable worker shows up: the text reads `no worker
  listening at /run/price-worker/worker.sock (ENOENT)` for one that is dead, restarting, or never
  started at all; `(ECONNREFUSED)` names a stale socket file with nothing behind it, `(EACCES)` a
  permission slip — and `docker compose ps` shows `worker` unhealthy, restarting, or missing
  outright, the last of those the instance whose `compose.yaml` was never replaced for the release
  that added `worker` ([Upgrading](#upgrading) has that symptom in full). A worker that answers at
  all fails through this same stem differently: rate-limited or a Yahoo error, the response body's
  own text standing in for that sentence, never "no worker listening" — see
  [the worker's own healthcheck](#the-workers-own-healthcheck) for why a worker in that state still
  answers `/healthz` with `200`. Other refresh failures (the pool, the advisory lock, the
  transaction) log `Price refresh failed`, a pressed **Refresh now** included —
  one stem for all of them, the separate `Manual price refresh failed` line having retired with the
  route's own catch. A single symbol refused over its currency logs `Price refused`. None of them
  zeroes anything.
- **Database trouble on the page path** at error level — stems `Database health check failed` and
  `Migration status check failed` — the lines behind a `/healthz` 503.
- **Startup**, in order: the configuration check, one line per migration file (applied or skipped),
  then a `Migrations OK` line. A failure names the offending file and the Postgres error, and the
  server is never started — stem `Migrations`.

`worker`'s own log has one stem, `Price worker` — one line per non-`200` answer over the socket,
naming the endpoint, the status and the reason, and nothing at all for a successful call, so a
healthy worker between restarts is silent. The one line it cannot avoid writing is `Price worker
listening on …`, once at startup — the restart-loop tell from above, if it repeats.

And in `gate`'s log, which is a different program with a different vocabulary:

- **The allowlist, at startup and again on every change it notices** — stem
  `authenticated emails file`. A line after you have edited the file is the gate confirming it
  re-read it; no line is the case [the restart exists for](#revocation-and-the-levers-you-have).
- **A session refused** — stem `Invalid authorization via session` — someone whose address is no
  longer on the list, arriving with a cookie that used to work. Their cookie is cleared as part of
  the refusal.
- **A refusal to start**, which crash-loops the container rather than serving anything: a
  `cookie_secret` of the wrong length is the one to expect, and it names the variable.

### "There is no price line in the log" has four causes

Only the last is a fault:

1. **Nobody has loaded a page since the container started.** The refresh timer is started from the
   first page render, because the app is served by the framework's own server and there is no server
   entry file to hook it to. A booted instance nobody has visited does zero refreshes, forever. The
   container healthcheck does not count — `/healthz` is a resource route and does not run the root
   loader.
2. **The market is closed.** A tick outside market hours asks for no quotes, so it writes no
   `Price refresh` line and no `price_poll` row. It no longer returns before doing anything: it
   still reads the cadence, still asks which spines have a gap, and may write a `Price backfill`
   line and spend a request on one (ADR-0011).
3. **Another refresh was already running or held the lock.** A tick that lands while one is still
   going, or while another process holds the advisory lock, is dropped silently — never queued.
4. **The poller failed to start.** That one *does* log, once, at error level.

A *successful* **Refresh now** press writes no `Price refresh` line: its outcome is reported on the
screen that pressed it. It writes no `Price backfill` line either, though it runs a batch — that
line belongs to the tick. The attempt still lands a `price_poll` row and the batch still lands its
`price_backfill` rows, and a currency refusal along the way still logs `Price refused`.

There is also a quiet period by design: the first tick is one full interval after the first page
view, with no immediate poll, so a freshly recreated container is silent for up to the refresh
cadence even with somebody looking at it. (The timer boots at the seeded 15 minutes and picks up a
different saved cadence on its first in-session tick.)

What to do about any of this is [`runbook.md`](runbook.md).

---

## Backups

**Backups are not a built-in feature and will not become one.** Self-hosters have their own, and a
half-built backup feature is worse than none — it is the one that looks like it is working.

There is exactly one thing to back up for **data**: the cluster at `./volumes/db/data`, through
`pg_dump`.
The application container is stateless — it writes nothing to its own filesystem, and `compose.yaml`
mounts it `read_only: true` so that stays true. Uploaded CSVs are kept in Postgres rather than on
disk (DESIGN.md §5.2) precisely so that this stays a single target. The image is rebuildable and
needs no backup.

**Being able to see the directory does not make copying it a backup.** A file-level copy of a
*running* cluster is a torn one, whatever the tool. Stopped — `docker compose down` first — a copy
of `./volumes/db/data` is a valid snapshot, and restoring one means putting the ownership back
([Where the database lives](#where-the-database-lives)). `pg_dump` stays the documented path because
it is the one that also survives a Postgres major upgrade.

**Budget for the dump growing faster than it used to.** The price observation log is the largest
table on an instance that has been running a while ([Growth and limits](#growth-and-limits)), and it
is mostly archived JSON, which compresses well — so a custom-format dump is far smaller than the
table, and still on a path to gigabytes rather than megabytes. Nothing about the commands below
changes; what changes is how long they take and where you can afford to keep the output. If you keep
a dump per day for a year, size the destination against the table, not against the 11 MB the demo
household weighs.

Dump the database without stopping the instance:

```sh
docker compose exec -T db pg_dump -U portfolio -d portfolio --format=custom \
  > "portfolio-$(date +%F).dump"
```

`pg_dump` runs inside the `db` container, so no Postgres client is needed on the host and the tool
always matches the server version. The custom format is compressed and is what `pg_restore` reads;
for a plain-SQL dump you can read yourself, use `--format=plain` and restore it with `psql`.

**The `>` creates the file whether or not the dump worked.** The shell opens the redirect before
`pg_dump` runs, so a dump that dies halfway leaves a plausible-looking file of plausible size behind,
and an unattended script that ignores the exit status will collect those happily for months. Check
the status, and check the file is readable as an archive:

```sh
set -e
DUMP="portfolio-$(date +%F).dump"

docker compose exec -T db pg_dump -U portfolio -d portfolio --format=custom > "$DUMP"
docker compose exec -T db pg_restore --list < "$DUMP" | head
```

`pg_restore --list` reads the archive's table of contents without touching a database. If it prints
the objects, the file is a real archive; if it errors, you found out today rather than on the night
you needed it.

Automate it with whatever already runs on the host — cron, a systemd timer, your NAS. A daily dump
kept for a few weeks is proportionate for a household.

### The second thing to keep is `.env`, and the third is the allowlist

"Nothing outside Postgres" is true of *data* and false of *configuration*. `.env` and
`allowed-emails.txt` are both gitignored and dockerignored on purpose, so nothing else in the world
has a copy of them — and losing `.env` entirely has a first symptom none of what follows fixes:
`docker compose` will not run a single command, `exec` included, while any required variable is
empty, so getting back in comes before getting back the value that used to be right. What each one
costs to recover, once a command runs again:

- `GATE_CLIENT_ID` and `GATE_CLIENT_SECRET` — recoverable, but only from the Google Cloud console,
  and the secret may have to be regenerated there rather than read back.
- `GATE_COOKIE_SECRET` — recoverable by regenerating it, which signs the household out.
- `POSTGRES_PASSWORD` — recoverable with no outside help at all, and the one most likely to be
  assumed otherwise: `./volumes/db/data` was initialised with the old value, but `db`'s own local
  socket authenticates on `trust`, never on a password, so a freshly generated value written to
  `.env` and matched to the role over `exec` restores service without ever needing to recall what
  the old one was — [`runbook.md`](runbook.md#i-lost-env-and-do-not-know-postgres_password) has the
  walk-through, including the case where the containers themselves are not running either.
- `allowed-emails.txt` — losing it is a locked-out household until you retype it, because the stack
  will not start without the file at all.

Keep them wherever you keep passwords, which is not the directory you keep the dumps in.

> **A backup you have never restored is not a backup.** Rehearse it — the
> [drill below](#rehearse-it-without-an-outage) does that without taking the instance down.

---

## Restoring

Restore into an empty database rather than over a live one, so a partial restore cannot leave a
half-old, half-new schema behind:

```sh
DUMP=portfolio-2026-08-17.dump      # the file you are restoring

docker compose stop app

docker compose exec -T db dropdb   -U portfolio portfolio
docker compose exec -T db createdb -U portfolio -O portfolio portfolio
docker compose exec -T db pg_restore --exit-on-error --single-transaction \
  -U portfolio -d portfolio < "$DUMP"

docker compose start app
```

**`--exit-on-error --single-transaction` is what makes the sentence above true.** Left to itself
`pg_restore` continues past failures and reports a count at the end, which is precisely the
half-old, half-new schema this is trying to avoid. With both flags the restore is one transaction
that either lands whole or leaves the empty database alone.

Stopping `app` first is what keeps it from writing to a database that is being replaced underneath
it — and the price refresh loop inside it is the connection holder that would otherwise make
`dropdb` fail. `caddy` stays up throughout and answers `502` until `app` is back; that is the
restore working, not a second fault.

**`docker compose stop app` survives a reboot.** `stop` records that you wanted it stopped, and
`restart: unless-stopped` honours that across a daemon restart and across a host reboot. A restore
you walked away from half-finished stays half-finished — the site keeps answering 502 and nothing
brings the app back on its own. `docker compose start app` is the only thing that does.

On start `app` applies any migrations the dump predates, so a backup taken from an older version
restores into the current one without a manual step.

### Rehearse it without an outage

Restore into a *separate* database on the same server. Nothing stops, nobody sees a 502, and the
live database is never dropped:

```sh
DUMP=portfolio-2026-08-17.dump

docker compose exec -T db createdb -U portfolio -O portfolio portfolio_drill
docker compose exec -T db pg_restore --exit-on-error --single-transaction \
  -U portfolio -d portfolio_drill < "$DUMP"

docker compose exec -T db psql -U portfolio -d portfolio_drill \
  -c "select count(*) from holding"

docker compose exec -T db dropdb -U portfolio portfolio_drill
```

The count is the point. A truncated archive that still restores cleanly into an *empty* schema is the
failure this catches, and a restore that reports success while producing no rows will not be noticed
any other way. Compare it against the same query on `portfolio` and be suspicious of a large gap.

`portfolio_drill` is never migrated and the app is never pointed at it; it exists for the length of
the drill and is dropped at the end.

### Rebuilding a machine from nothing

Install Docker, clone this repository, restore your `.env` **and your `allowed-emails.txt`** — with
either one missing nothing starts at all — then bring up the database **on its own** before anything
else:

```sh
docker compose up -d db
# then the restore above, minus the `docker compose stop app` line
docker compose up -d
```

A plain `docker compose up -d` here would start `app`, which would create and migrate an empty schema
that you are about to drop, and would hold a connection to the database while you try to drop it.
Bringing up `db` alone avoids both.

---

## Upgrading

```sh
docker compose exec -T db pg_dump -U portfolio -d portfolio --format=custom \
  > "portfolio-pre-upgrade-$(date +%F).dump"
docker compose images app    # write the tag down: it is half of your way back
docker compose up -d
curl -sf http://localhost/healthz
```

**That is the shape of an ordinary upgrade: dump, note the tag, `up -d`, confirm.** It assumes
`compose.yaml` has not itself changed shape, so `exec` and `images` still run against whatever is
already deployed. A release that adds a required variable to `compose.yaml` breaks that assumption
before you have typed anything, because checking out the release's tag already replaces the file on
disk: every verb after that — `exec` included — is interpolated against the whole file before it
runs, and refuses on the first variable `.env` does not yet hold, with the `>` redirect above still
creating a zero-byte file that looks exactly like a dump. **This release does that**, with
`${POSTGRES_PASSWORD:?}` newly on `db`. Its own instructions, further down this section, carry a
backup timed for the moment it can actually run — take that one instead of the block above when
crossing this release.

There is no `git pull` and no build. The `app` service is set `pull_policy: always`, so
`docker compose up -d` fetches whatever the pinned tag currently points at and recreates the
container; with the default floating `APP_VERSION=1` that is the newest `v1.x.y` release. A
checkout of this repository is not needed to run or upgrade an instance — only `compose.yaml`,
`Caddyfile`, `scripts/dump-loop.sh`, your `.env`, your `allowed-emails.txt` and the
`volumes/db/data` and `volumes/dumps` directories beside them.

**A release that adds a service or a volume needs `compose.yaml` replaced too, not just the image
pulled.** The release that added `worker` and the `price-worker-sock` volume was the first to need
this, and every release since has needed it again, this one included: `compose.yaml` is one of the
files above that `pull_policy: always` never touches, so bring the new one in yourself, in this
order — replace `compose.yaml` with this repository's copy at the release's tag (there is no GitHub
Release and no attached file to fetch instead, only the git tag CI built the pushed image tags from,
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml)'s `publish` job) — then confirm the
Engine: `docker version --format '{{.Server.Version}}'` at or above `28.0`. **That floor was
declared at the release that added `worker`, as a warning for a network-lockdown release still to
come — this is that release, so the warning is over: an Engine below 28.0 now lets `up` report
success while the isolation below is silently ignored** ([Installing](#installing) has what each
version short of it does instead). Then `docker compose up -d`; if this is the first time you are
crossing the release that added `worker`, that command is also what recreates `app` for its changed
mounts and brings `worker` up alongside it. Run [the socket check](#verify-it-actually-worked) again
afterwards: a host whose engine or container runtime changed since the old instance was last
verified is exactly the case that check exists to catch, and nothing else here will.

Skip the `compose.yaml` replacement when crossing the release that added `worker`, and nothing will
tell you: `app` still fetched its own prices under the old file, and `worker` simply idled unused.
That grace ended with that release — `app` has dialed `worker` instead of fetching for itself ever
since. Start today's image under a `compose.yaml` from before that point and there is no volume and
no worker: prices go stale while `/healthz` keeps answering green — a missing price provider was
never a health signal — and the only sign in the log is one
`no worker listening at /run/price-worker/worker.sock` line per call site, up to two per tick.

**A changed `driver_opts` line means a new volume name, never `docker compose down -v`.** Compose
reuses a name-matched volume untouched, so editing `price-worker-sock`'s tmpfs options in some
future release would change nothing on an already-running instance until that volume is removed by
hand — the release making the change has to rename the volume instead, the way `db-store` itself was
named to dodge exactly this
([Moving an instance that predates the local path](#moving-an-instance-that-predates-the-local-path)
has that history). `docker compose down -v` is not that removal. It takes `db-store`'s volume
*record* down too — not the database, which lives at `./volumes/db/data` and survives regardless,
same as [above](#what-runs-here) — so it neither renames `price-worker-sock` nor loses anything; it
is simply the wrong command for this.

**An instance that predates the dump service needs three things before its next `up`**: that script
in place, `mkdir -p ./volumes/dumps`, and `DUMP_UID`/`DUMP_GID` in `.env` set to the account that
owns it (`id -u`, `id -g`). Missing any of them stops `docker compose up -d` naming what is
missing — the intended behaviour rather than a failed upgrade, since nothing is recreated until it
can start.

**Stop the dumper across an upgrade that migrates.** `pg_dump` holds `ACCESS SHARE` on every table
for its whole run and a migration's `ACCESS EXCLUSIVE` queues behind it, so a dump that happens to
be running when the new image starts can stall the instance for the length of the dump:

```sh
docker compose stop dump
docker compose up -d db app caddy gate worker
docker compose up -d dump
```

**The last line is `up -d`, never `start`.** `start` resumes the existing container exactly as it
was already created and reads none of `compose.yaml`'s current definition, so it is only safe when
the service it targets has not itself changed — and `dump` has, in this release: a new network,
`PGPASSWORD` newly required, and a rewritten `DATABASE_URL` default. Resumed with `start` it comes
back on whichever network it last held, unable to reach `db` on the new one, and its healthcheck's
`start_period: 15m` leaves `docker compose ps` showing a plausible row for a quarter of an hour
before that would be noticed. `up -d dump` re-converges it against the file on disk instead, which
costs nothing when `dump` has not changed and is the only form still correct when it has. `db` is in
the middle line for the same reason: this release also moves it to a network of its own, where a
plain image-tag bump would not have touched it — check what a given release actually changed rather
than copying this line unchanged next time. `worker` has no `depends_on` tying it to anything else,
so naming it explicitly is what starts it at all: a list that left it off would look exactly like
success, everything named coming up healthy with the missing service an *absent* row in
`docker compose ps` rather than an unhealthy one, which is the row this recipe would otherwise leave
nobody checking for.

**This does not upgrade the gate.** `gate` is pinned to an exact release with no variable in front
of it, so `docker compose up -d` recreates the container on the same image forever. Moving it is
editing the tag in `compose.yaml`, and it is worth doing deliberately when oauth2-proxy publishes a
security release — nothing here will tell you one exists.

**Upgrading across a major means changing `APP_VERSION`.** The floating tag deliberately does not
cross `1` → `2`, because a major is where a breaking change would be. Read the release notes, set
`APP_VERSION=2` in `.env`, then run the same procedure above.

**This release requires `.env` set up before `docker compose up -d` — or any other compose verb —
will do anything, and the last three steps have only one order that works.** The new `compose.yaml` carries
`${POSTGRES_PASSWORD:?}` on `db`, and Compose interpolates the whole model before every command it
runs: `exec`, `ps`, `logs`, `restart` and `down` all refuse identically, not only a shell inside the
running container, so nothing reaches Postgres until `.env` holds something for it. Confirm the
Engine floor in [Installing](#installing) first — `28.0`, load-bearing as of this release; Compose
`2.31.0` is declared there too, but nothing in this release needs it, so it is not a reason to stop
here. Then, in this order:

1. Replace `compose.yaml` with this release's copy.
2. Delete the `DATABASE_URL` line from `.env`, unless you run your own Postgres
   ([Running against your own Postgres](#running-against-your-own-postgres)) — `pg` prefers a URL's
   own password to `PGPASSWORD`, so a leftover line with the old password crash-loops `app` and
   `dump` on `password authentication failed` once step 4 below actually changes the role, instead of
   picking up the new one through `PGPASSWORD` the way it should.
3. Generate the password with `openssl rand -hex 32` and write it to `.env` as
   `POSTGRES_PASSWORD`. Skip this and step 4 refuses by name — the message `compose.yaml` carries
   points back to this section — rather than starting anything half-configured.

**If you run your own Postgres, steps 4 and the backup below are not yours to run as written.**
Both go through `docker compose exec db`, and under
[`compose.external-db.yaml`](#running-against-your-own-postgres) there is no `db` service to enter —
the profile keeps it from starting, so the command either fails outright or, worse, dumps a bundled
container left behind by an earlier release and never touches the database `DATABASE_URL` actually
names. Take the backup with your own Postgres's own tooling, and change the `portfolio` role's
password there, by whatever route that server gives you. Steps 1, 2, 3 and 5 are the same for you as
for anyone; `POSTGRES_PASSWORD` still has to hold something, because `compose.yaml` refuses to
interpolate without it even for a service it will not start.

**Take the pre-upgrade backup here, between steps 3 and 4, not before either of them.** Earlier and
interpolation refuses `exec` exactly as it refuses every other verb, because `.env` does not hold
anything for `POSTGRES_PASSWORD` yet; from this point on it does, and the role has not been touched
yet either, so `db`'s own local `trust` line takes the dump under whatever password is already
running, regardless of what step 3 just wrote:

```sh
docker compose exec -T db pg_dump -U portfolio -d portfolio --format=custom \
  > "portfolio-pre-upgrade-$(date +%F).dump"
docker compose images app    # write the tag down: it is half of your way back
```

4. Change the role, while the old containers are still running on it:
   `docker compose exec db psql -U portfolio -d portfolio -c "alter role portfolio with password
   'the-generated-value'"`. `exec` reaches `db` over the container's own loopback `trust` line,
   which needs no password at all, so this succeeds regardless of what `app` and `dump` currently
   believe the password is — and from the moment it runs, any *new* connection either of them opens
   starts failing on `password authentication failed`, though a connection already held keeps
   working.
5. `docker compose up -d`, which recreates every service that gains a network in this release — `db`,
   `dump`, `app`, `gate` and `caddy` — now reading the password staged in step 3; `worker` alone is
   untouched. `caddy` is one of the five, and it is the one that publishes `80:8080`, so the outage
   this step causes reaches the whole instance for as long as the recreated containers take to
   report healthy again, not only the database-facing services a shorter list might suggest.

Between steps 4 and 5, only new connections from the old containers fail; nothing is lost, and
nothing here needs redoing.

**`docker compose ps` reporting everything healthy afterwards is necessary and not sufficient** — it
is the same row whether the isolation actually took, whether the role's password actually changed,
and whether a stale `DATABASE_URL` is still in `.env` overriding it. Run these three instead, and
read them together rather than stopping at the first one that passes:

```sh
grep -n '^DATABASE_URL=' .env
docker network inspect -f '{{if (index .IPAM.Config 0).Gateway}}{{(index .IPAM.Config 0).Gateway}}{{end}}' portfolio_backend
curl -sf http://localhost/healthz
```

A line printed by the first means step 2 was skipped and `app` is still authenticating with
whatever password that line names rather than the one just staged — delete it and run
`docker compose up -d` again. A gateway address printed by the second means the Engine is below
`28.0` and this release's isolation did not take, silently, whatever `docker compose up` itself
reported — see [Installing](#installing). A `curl` failure with both of those clean points at step 4:
the role never actually changed, or changed to something other than what step 3 wrote — re-run the
`alter role` command there.

The entrypoint validates the configuration, applies any new migrations to completion, and only then
starts serving — so a request is never served against a half-migrated schema. Migrations are
idempotent, so a restart is always safe, and `GET /healthz` returns a non-200 if the image ever
carries a migration the database has not recorded.

### There is no rollback

Migrations are forward-only, and comprehensively so: there are no `down` files, there is no rollback
command, and the ledger records filenames only — no checksums, no content hashes. Two consequences
that bite in opposite directions.

**Editing a migration that has already been applied does nothing, forever.** The ledger matches on
the filename, so the edited file is still recorded as applied and is silently skipped on every future
start. Ship a new file instead.

**An older image against a newer database reports perfect health.** Nothing compares applied
migrations against the ones on disk in that direction, so every check passes while the code queries a
schema it has never seen ([Monitoring](#monitoring)). Setting `APP_VERSION` back to the previous
version is therefore not a rollback — it is an instance that has stopped being able to tell you it
is wrong. Pinning a tag is easy now, which makes this *easier* to do by accident than it used to be,
not harder.

**The only true rollback is the old image *plus* the backup taken before the upgrade.** That is why
the dump and the tag you wrote down are the first two lines above, and why "take a backup before
upgrading" is not a formality here. Pin the old version with `APP_VERSION` in `.env` and restore the
dump; either one alone leaves you worse off than before.

**A pin below this release needs one more step: `docker compose stop worker` too.** `worker` shares
`app`'s tag, and an image from before ticket 04 has no `server/price-worker.ts` for that entrypoint
to run — `restart: unless-stopped` then restarts a `Cannot find module` crash forever, a loop that
never resolves itself. The rollback above is the obvious way into it, but the likelier one is
simpler: an operator who already pins an older `APP_VERSION` and only now adopts this release's
`compose.yaml`, meeting `worker` for the first time as a crash loop rather than as the idle service
this document otherwise describes.

**A pin below *this* release needs `compose.yaml` rolled back with it, not just `APP_VERSION`.** An
old `app` image — one that still fetches prices for itself rather than dialing `worker` — started
under this release's `compose.yaml` finds itself on a network with no route to Yahoo at all: it logs
`Price provider failed` on every tick, forever, with `/healthz` still green, because a missing price
provider has never been a health signal ([Monitoring](#monitoring)). Roll `compose.yaml` back to
match the pinned image, or do not pin below this release at all — re-upgrade instead. This slice adds
no migration and no column, so nothing it wrote to the database is at risk either way; an old image
only loses the worker cutover, never any data.

**Rolling `compose.yaml` itself back needs the generated password carried into a `DATABASE_URL`, in
`.env`: `DATABASE_URL=postgres://portfolio:<the generated password>@db:5432/portfolio`.** That is the
one documented way back, because the old file has no `PGPASSWORD` and reads the password from the URL
the way every release before this one did. **Never reset the role's password itself back to the old
file's hardcoded default** to make the old file work unmodified — that would undo this release's
whole point, which was to get a generated password onto the role once and keep it there rather than
the one every checkout's `.env.example` already carries. The moment that matters here is the password
sitting in a URL again, in `.env`, for as long as the old `compose.yaml` runs; it is not the moment
the password itself goes weak, and a rollback is not the occasion to make it one.

### Moving an instance that predates the local path

An instance first brought up before the database moved into the checkout keeps its cluster in a
Docker-managed volume, `portfolio_db-data`. Nothing reads it any more: the new `db-store` name binds
`./volumes/db/data`, and starting on the new `compose.yaml` initialises an empty cluster there — a
working instance with none of your data, rather than an error. Move it before the first `up` on the
new file.

The volume was left under its old name deliberately, so this is a copy and not a leap: the original
is still there afterwards, and the way back is to stop and delete the new directory.

```sh
docker compose down                       # on the old compose.yaml
mkdir -p ./volumes/db/data
docker run --rm \
  -v portfolio_db-data:/from -v "$PWD/volumes/db/data:/to" \
  postgres:17-alpine cp -a /from/. /to/   # -a keeps uid 70 and the 0700 mode
docker compose up -d                      # on the new one — see the note below first
```

**That last `up -d` refuses on this release until `.env` carries `POSTGRES_PASSWORD`**, and an
instance old enough to still hold `portfolio_db-data` almost certainly has no such line — it was
optional then, and commented out in the example file. The value has to match the password the copied
cluster's `portfolio` role already holds, because nothing re-initialises it: put that in, or, if it
is lost with the rest, do the password cutover in [Upgrading](#upgrading) first and change the role
through `db`'s own local `trust` line once it is up.

Check the instance, not the copy: sign in and open a screen with data on it. Then, once you are
sure, `docker volume rm portfolio_db-data` — the last copy of anything you did not also dump.

If you would rather not copy files at all, the dump-and-restore in
[Restoring](#restoring) does the same job: dump on the old file, `up` on the new one against an
empty directory, restore into it.

### Upgrading Postgres across a major version

`compose.yaml` pins a Postgres major version by tag. Raising it does **not** migrate the data
directory: the new server finds a directory written by the previous major version and refuses to
start, over and over, with `./volumes/db/data` left exactly as it was. Nothing is damaged, and nothing works.

The dump-and-restore procedure above *is* the upgrade path:

1. **Dump on the old version, before you change the tag.** An archive written by a newer `pg_dump`
   cannot be loaded into an older server, so doing this in the wrong order also removes your way
   back to the version that still runs.
2. `docker compose down`, then empty the data directory deliberately — `down -v` will not, and
   `0700` uid 70 means your own account cannot either:
   `docker run --rm -v "$PWD/volumes/db/data:/data" postgres:17-alpine find /data -mindepth 1 -delete`.
3. Change the tag and `docker compose up -d db`, letting it initialise the empty directory.
4. Restore into it, then `docker compose up -d`.

Step 3 is also the one moment `POSTGRES_PASSWORD` is read again, because the data directory is empty
again — so it is the easy time to change it. Nothing else needs to agree with it any more: `app` and
`dump` read the same variable through `PGPASSWORD` rather than carrying their own copy of it in
`DATABASE_URL`.

---

## Growth and limits

Measured against the demo household in [`scripts/seed-demo.ts`](../scripts/seed-demo.ts) — two
people, six accounts, sixteen instruments, three years of statements — the whole database is about
11 MB, of which the daily price history is about 2 MB. That is the largest dataset this has actually
been run against, and it seeds a single trading session's observations rather than years of them, so
it does not measure the term below that actually grows.

Nothing is ever pruned: no code deletes a price, anywhere. Two tables grow, at very different rates.

**The daily spine grows slowly and is not worth thinking about.** `price_daily` gains one row per
priced instrument per trading day, so roughly 250 rows per instrument per year — plus, once, however
many years of history each instrument is held back through, which the backfill fills in at the same
250 rows a year. At the design target
of about a hundred instruments that is on the order of 25,000 rows a year, and low single-digit
megabytes.

**The observation log is the one that costs real disk, and it does so by decision.**
[ADR-0006](adr/0006-intraday-quotes-are-an-observation-log.md) stopped the refresh discarding the
prices it fetches between two closes: every distinct one is now kept forever in `price_observation`,
with the provider's raw entry archived beside it. The arithmetic, at the design target of about a
hundred feed instruments and the seeded fifteen-minute cadence:

| Cadence | Refreshes a session | Rows a year | Roughly |
|---|---|---|---|
| 15 minutes (the default) | ~26 | ~650,000 | half a gigabyte a year |
| 5 minutes | ~78 | ~2,000,000 | one and a half gigabytes a year |
| 1 minute | ~390 | ~10,000,000 | seven or eight gigabytes a year |

Two things make those upper bounds rather than forecasts. A price that has not moved writes nothing —
the log is keyed on the instant the provider stamped, so a mutual fund, which strikes one NAV a day,
contributes one row a day whatever the cadence says. And the payload is the bulk of each row; it is
stored out of line, so a query that reads only prices does not pay for it. A sibling `price_poll`
table adds one row per refresh attempt — about twenty-six a day, which is nothing. `price_backfill`
adds one row per instrument per backfill attempt, at most a handful per refresh and none once every
spine reaches as far back as its holdings do; an instrument the feed can never fill costs one row a
day forever, which is also nothing.

**So: there is still deliberately no retention policy, but it is now a priced choice rather than a
free one.** The premise this section used to rest on — that a household instance grows by a few
megabytes a year — is superseded; the conclusion survives, because the owner would rather spend the
disk than throw away data whose future use is unknown, and because any pruning scheme would cost
more attention than the disk it saved. The dial that sets the price is the refresh cadence at
Settings → Prices, and that screen states the figure where the choice is made. **Check the number
against your own instance rather than against this table** — it is the design target, not a
measurement:

```sh
docker compose exec -T db psql -U portfolio -d portfolio -c \
  "select pg_size_pretty(pg_total_relation_size('price_observation'))"
```

Two more terms used to be unbounded; one still is, and it is the one that is data.

**Retained statement originals.** Every upload keeps its complete CSV in the database, forever, on
purpose — it is what makes an old import auditable. A brokerage CSV is tens of kilobytes and the
design target is a handful of uploads a quarter. Abandoned upload drafts are swept once they are a
day old, but only when the *next* upload starts: there is no scheduler, so an instance nobody uploads
to keeps its last abandoned draft indefinitely.

**Container logs, which is now the one least likely to matter first.** An idle instance still writes
a request line every ten seconds from its own healthcheck, and a second from Caddy's. `compose.yaml`
caps this by explicitly configuring the `json-file` driver for every service with `max-size: "10m"`
and `max-file: "3"`, meaning the logs for each container will not exceed roughly 30 MB on disk.
A per-service `logging` block overrides whatever the operator sets as the daemon default (such as
journald or `local`).

**Almost no resource limits are set** — no CPU limit anywhere, and no memory or process limit on
any service but `worker`, which carries `mem_limit: 256m` and `pids_limit: 64` because it is the
one container the design expects to be compromised. On a machine that runs only this, that is the
right default. On a shared host it means one runaway query can still take the box; the flat
`mem_limit` and `pids_limit` keys `worker` uses are where you would add them, and
`docker compose up` honours those without a swarm.

**The design target is a target, not a measurement.**
[`ARCHITECTURE.md` §10](../ARCHITECTURE.md#10-performance-and-scale-envelope) states it — one
household, two to four people, a dozen accounts, of the order of a hundred instruments, three or four
statement uploads a quarter — and says plainly that almost nothing behind it is benchmarked, the 1D
read being the one exception. If your instance is meaningfully larger than that, §10 is also the
list of which choices break first, in what order.
