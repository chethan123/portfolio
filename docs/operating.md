# Operating an instance

Everything a self-hoster needs that is not in the [README](../README.md): what the three containers
are, what to put in `.env`, putting a reverse proxy in front, the security decisions that are yours
rather than the code's, what to watch, backing the data up, restoring it, and upgrading.

When something is already broken and you want a procedure, that is [`runbook.md`](runbook.md). This
file is how the instance is meant to be run.

- [What runs here](#what-runs-here)
- [Installing](#installing)
- [Environment variables](#environment-variables)
- [Reverse proxy and TLS](#reverse-proxy-and-tls)
- [Installing on a phone](#installing-on-a-phone)
- [Security](#security)
- [Monitoring](#monitoring)
- [Backups](#backups)
- [Restoring](#restoring)
- [Upgrading](#upgrading)
- [Growth and limits](#growth-and-limits)

---

## What runs here

Three services, defined in [`compose.yaml`](../compose.yaml) under the project name `portfolio`.

| Service | What it is | Published port |
|---|---|---|
| `db` | Postgres. All persistent state, in the named volume `db-data` | none |
| `app` | The application: pages, uploads, and the price refresh loop, in one process | none |
| `caddy` | The ingress front door | **`80:80`, on every interface** |

A request goes browser → `caddy` → `app` → `db`. Only `caddy` is reachable from your LAN; `app` and
`db` are reachable only on the compose network. That is not a hardening extra — it is the assumption
the app's trust of `X-Forwarded-*` rests on, and [Security](#security) says what breaks if you
publish the app's port yourself.

They start in dependency order: `app` waits for `db` to report healthy, `caddy` waits for `app`.

**`app` is stateless and enforced as such.** It is built from the [`Dockerfile`](../Dockerfile) in
this repository — there is no published image — runs as a non-root user, and is mounted `read_only`
with a tmpfs `/tmp`. It writes nothing to its own filesystem, so it can be destroyed and recreated
freely, and every upgrade does exactly that.

**`db-data` is the only named volume, and it is everything.** Every statement, every stored original
CSV, every price. `docker compose down` leaves it alone; `docker compose down -v` deletes it.

---

## Installing

**Host requirements.** Docker Engine with the Compose v2 plugin — `docker compose`, two words, not
the older `docker-compose` script. Port 80 free. Enough memory to run a Node build inside Docker,
because the `app` image is built on the host rather than pulled; on a small NAS or VPS that is the
step that will hurt, and building elsewhere and shipping the image is the alternative. Node itself
is a requirement for *working on* this, not for running it.

**Bringing it up is one command, and it belongs to the README:**
[Running an instance](../README.md#running-an-instance). It is deliberately not repeated here — that
reader has installed nothing and needs the whole shape; you are at a terminal and need what comes
after.

### What to put in `.env`

Nothing, for a first look: every setting has a working default except `DATABASE_URL`, which Compose
supplies. `.env` exists to change something. For an instance that is going to be used, three are
worth deciding before the first `up`:

- `AUTH_PASSWORD` and `SESSION_SECRET` — the login gate. Read [Security](#security) before deciding
  to leave the password unset, including on a LAN you trust.
- `POSTGRES_PASSWORD` — because it is read only when the data directory is first created. Setting it
  later is a different, more annoying operation ([Environment variables](#environment-variables)).

The full surface, with defaults, is the table in [Environment variables](#environment-variables).

### Running against your own Postgres

Set `DATABASE_URL` in `.env` to point at it. Four things that catch people:

- The connection is made from inside a container, so `localhost` in that URL means the *app
  container*, not your host. Use a hostname or address the container can actually reach.
- The bundled `db` service still starts, still creates `db-data`, and `app` still waits for it to
  report healthy. Setting `DATABASE_URL` does not remove it — delete the `db` service and `app`'s
  `depends_on` block if you do not want it running.
- Migrations run at every container start, against whatever `DATABASE_URL` names, so the role needs
  to be able to create tables. There is no separate migrate step to run.
- Every `pg_dump` command below runs *inside* the bundled `db` container. On your own Postgres,
  backups become your Postgres's problem, and [Backups](#backups) is then about `.env` only.

### Verify it actually worked

```sh
docker compose ps
curl -i http://localhost/healthz
```

All three services `running`, with `db` and `app` also `healthy` — `caddy` declares no healthcheck
in `compose.yaml`, so `running` is all you get about it. And `/healthz` answering `200` with exactly:

```json
{"status":"ok","database":true,"migrations":"current","pendingMigrations":[]}
```

Any other body on that endpoint means something, and [Monitoring](#monitoring) says what.

> **`scripts/smoke-test.sh` is a CI tool and it destroys data.** It runs `docker compose down -v`
> before it starts and again from an exit trap, which deletes the `db-data` volume — every
> statement, every stored original, every price. It exists to prove a *fresh* machine comes up with
> no manual steps. Never point it at an instance you care about.

---

## Environment variables

The complete configuration surface. Every setting is an environment variable — nothing is
configured in a file, a database row or a UI toggle — and [`.env.example`](../.env.example) is this
same table with the reasoning attached. Copy it to `.env` only to change something.

All of them are validated once at startup. A missing or malformed value stops the container
immediately with a message naming the variable, rather than failing hours later on the request that
happens to need it.

| Variable | Required | Default | What it does |
|---|---|---|---|
| `DATABASE_URL` | **Yes** | — | Postgres connection string. Compose supplies one pointing at its own `db` service, so you only set this to run against your own Postgres. |
| `AUTH_PASSWORD` | No | unset | Setting it turns on the login gate: one password, one cookie, one login page. Unset means the instance is open to anyone who can reach it, and the UI shows a permanent warning banner saying so. |
| `SESSION_SECRET` | **When `AUTH_PASSWORD` is set** | — | Signs the login cookie. Startup fails naming this variable if you set a password without it. Use a long random string: `openssl rand -hex 32`. |
| `PORT` | No | `3000` | The port the app listens on *inside* the compose network, and the port Caddy proxies to. It is **not** the published host port: that is the fixed `80:80` in [`compose.yaml`](../compose.yaml), and moving it means editing that line. |
| `PRICE_POLL_INTERVAL_MINUTES` | No | `15` | Quote refresh cadence, 1–1440. The refresh runs in the app process and only while the market is open. |
| `MAX_UPLOAD_MB` | No | `10` | The most a statement upload may carry, in whole mebibytes, minimum 1. A brokerage CSV is tens of kilobytes, so the cap bounds an accident, not real use. **Not wired through `compose.yaml`** — see below. |
| `MARKET_TIMEZONE` | No | `America/New_York` | IANA zone for deciding whether the market is open, and for reading which trading day a quote belongs to — so it picks the date a daily close is filed under. No effect on how timestamps are stored, which is UTC. |
| `TZ` | No | `UTC` | Container clock. The database stores UTC whatever this says, so this only affects how the app's own log lines read. Leaving it at `UTC` is recommended. |

**An empty value reads as unset, not as "configured to empty".** `AUTH_PASSWORD=` in `.env`, or a
Compose variable that never got substituted, leaves the gate *off* — with no startup error, because
nothing is malformed. [Security](#security) says why that particular one matters.

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

**It only takes effect on an empty volume.** Postgres reads it when it first initialises its data
directory and never again. On an instance that has already run, changing `POSTGRES_PASSWORD` and
`DATABASE_URL` together does not rotate the password — it leaves the app unable to authenticate and
crash-looping. Change it inside the database instead, then update `DATABASE_URL` to match:

```sh
docker compose exec db psql -U portfolio -d portfolio \
  -c "alter role portfolio with password 'the-new-one'"
```

---

## Reverse proxy and TLS

**Ingress runs through a bundled `caddy` container.** `compose.yaml` includes a `caddy` service, and
it is the only container that publishes a port — `app` and `db` are reachable only on the compose
network, which is what keeps the app port off the network in the first place rather than relying on
you to bind it to loopback. Caddy's configuration lives in [`Caddyfile`](../Caddyfile) at the
repository root.

**TLS is not configured yet.** Caddy currently proxies plain HTTP on port 80 straight through to the
app, so this alone does not make the instance safe to expose to the internet. Two ways to add TLS
later, without ever having to publish the app's own port:

- Give the site block in `Caddyfile` a real hostname instead of `:80` and Caddy will request and
  renew a certificate for it automatically. Publish `443:443` alongside the existing `80:80` — Caddy
  serves HTTPS on 443 and keeps 80 for the redirect and the HTTP challenge.
- Or put your own TLS-terminating proxy in front of this one, pointed at Caddy's port 80.

### Before you enable TLS, give Caddy a volume

`compose.yaml` mounts the Caddyfile and nothing else, so Caddy's `/data` is the container's own
filesystem. `/data` is where it keeps the ACME account key and every certificate it has ever
issued. Recreating the container throws all of it away — and recreating the container is exactly
what the `docker compose up -d --build` in [Upgrading](#upgrading) does, every time. The next start
asks the certificate authority for everything again from scratch. Enough of those in a week and
Let's Encrypt's rate limit refuses, which leaves the site with no certificate at all and a wait
before it can have one.

Add the volumes *before* the first certificate is issued:

```yaml
  caddy:
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  db-data:
  caddy_data:
  caddy_config:
```

`caddy_data` is the one that matters. `caddy_config` only saves re-deriving the autosaved config,
and costs nothing to add at the same time.

### Forwarded headers

The app **trusts `X-Forwarded-*`**, and the bundled Caddy sets all three headers itself — nothing to
configure there.

| Header | Effect |
|---|---|
| `X-Forwarded-Proto` | Decides whether the login cookie is issued `Secure`. Behind TLS it is; over plain HTTP it is not, because a `Secure` cookie would be dropped by the browser and nobody could stay logged in. |
| `X-Forwarded-For` | The address a failed login attempt is logged against. Nothing is authorised on it. |

The database is never exposed either: `compose.yaml` publishes no port for it, and the app reaches
it over the compose network.

---

## Installing on a phone

**No instance can be installed as an app on a phone, on any scheme.** The application ships no web
app manifest and no service worker, so there is nothing for a browser to install. Visiting it on a
phone works as an ordinary page, and adding it to the home screen makes an ordinary bookmark.

Serving it over HTTPS does not change this. A secure context is a *precondition* for installing —
service workers require one, with `localhost` as the only exception — but it is not sufficient on
its own, and a LAN address over plain HTTP is not what is standing in the way here.

If installability is wanted later it is a change to the application, not to the deployment: a
manifest, a service worker, and the offline caching `DESIGN.md` §11 sketches. Putting the instance
behind a proxy with a real certificate is worth doing [for its own reasons](#reverse-proxy-and-tls).

---

## Security

[`ARCHITECTURE.md` §7.6](../ARCHITECTURE.md#76-security-posture) holds the control table — what each
mechanism is and why it was built that way. **That table is deliberately not repeated here.** This
section is the other half: the decisions that are yours, and the consequences you inherit whether or
not you make them.

### What an attacker on your LAN can reach

**With `AUTH_PASSWORD` unset**, anyone who can open port 80 on the host has the whole instance:
every balance, every account, every uploaded statement, and every screen that writes. There is no
read-only mode. The UI carries a permanent banner while that is true, and the banner is the reliable
signal — not the contents of `.env`.

**With it set**, exactly two paths answer without a session: the login page and `/healthz`.
Everything else is refused, including routes that do not exist yet, because the gate is a
deny-by-default middleware on the root route rather than a list of protected paths. Static assets —
the JavaScript bundles, the CSS, the font — are served ahead of the router and are *not* gated. No
household data is in them.

### Five things the code does not do, that you may assume it does

**There is no login rate limiting or lockout of any kind.** A wrong password logs a warning and
returns. No delay, no attempt counter, no lockout, no ban list, and nothing in the Caddyfile either
— it is a bare `reverse_proxy`. Anyone who can reach the login page can guess as fast as the network
allows. The length and randomness of the password is the entire defence.

**There is no CSRF token anywhere.** `SameSite=Lax` on the session cookie is the whole of it. Against
a logged-in household that covers the ordinary cross-site form post. What it does not cover is the
*open* instance: with no password there is no cookie at all, so `SameSite` has nothing to protect,
and any page anybody in the house happens to open can POST to your instance and be obeyed. **That is
a concrete reason to set `AUTH_PASSWORD` even on a LAN you completely trust** — the password is not
only about who can look.

**No security headers are set at all.** No CSP, no HSTS, no `X-Frame-Options`, no
`X-Content-Type-Options`: the app sets none and the Caddyfile sets none. If you want them, a `header`
block in the Caddyfile is where they go. Nothing in the app depends on their absence, but nothing has
been run behind a strict CSP either, so test it rather than assuming.

**The session cookie is signed, not encrypted.** Anyone holding the cookie can decode its contents.
What is in it is a plain, unsalted SHA-256 of `AUTH_PASSWORD` and nothing else — so a memorable
password is recoverable from a captured cookie by running a wordlist offline, with no rate limit and
nothing watching. **Use a long random password**, generated the same way as the session secret:
`openssl rand -hex 32`. It is typed once per device per month.

**The cookie has no server-side expiry.** Its month-long lifetime is an instruction to the browser
and nothing more; there is no session table to revoke against. A cookie that leaks stays valid until
the password or the secret changes.

### Revocation, and the two silent settings

**Changing `AUTH_PASSWORD` or `SESSION_SECRET` is the only revocation there is, and it logs everybody
out at once.** Sessions are pinned to the password that issued them, and the cookie is signed with a
single secret rather than a rotation list — so there is no grace period, no overlap window, and no
way to sign out one lost phone without signing out the household. Plan it for an evening, not for a
Monday morning.

**`AUTH_PASSWORD=` with nothing after it reads as unset.** An empty string is treated as not
configured, so an empty assignment in `.env` — or a Compose variable that silently failed to
substitute — serves the instance wide open, with no error at startup, because nothing about it is
malformed. Check the banner in the UI, never the file.

**`/healthz` never requires credentials** — that is deliberate, so monitoring needs no secret — and
it names the *filenames* of any migration the image carries that the database has not applied. That
is a version fingerprint available to anyone who can reach the port.

### One thing that leaves the house

The app makes outbound requests to exactly one destination: the price provider. What goes out is the
list of ticker symbols being priced, plus your public IP. Quantities, balances, account names, people
and filenames do not. There is no analytics or error-reporting SDK anywhere in the image. It is still
worth knowing that the symbol list reveals *what* is held, if not how much — an operator who objects
can price instruments manually or block egress and accept permanently stale prices. The app degrades
to the last known price, never to zeros.

### Can I put this on the internet?

Honestly: it was not built for that. The threat model written into the design is a household LAN, and
[`ARCHITECTURE.md` §7.6](../ARCHITECTURE.md#76-security-posture) says so rather than implying more.
Nothing here forbids exposing it — but every gap above becomes yours to compensate for, in front of
the app, because none of them is going to be fixed behind it.

If you are going to do it anyway:

- [ ] TLS terminated in front, with a real certificate, and Caddy's `/data`
      [on a volume](#before-you-enable-tls-give-caddy-a-volume) so it survives an upgrade.
- [ ] `AUTH_PASSWORD` set to a long random string — and *verified* set, by the banner being gone.
- [ ] `SESSION_SECRET` from `openssl rand -hex 32`, not reused from anything else.
- [ ] Rate limiting on the login path, added in front. The stock `caddy:2-alpine` image has no
      rate-limiting module, so this means a custom Caddy build or a different proxy.
- [ ] Accept that a stolen cookie is valid until you change the password, and that changing the
      password signs out the whole household with no warning.
- [ ] Accept that you are now responsible for patching an internet-facing surface on whatever
      schedule the internet decides.

One addition to §7.6's error-disclosure row, because it is a deployment fact rather than a code fact:
in a production build React Router replaces a thrown error's message with a generic one before it
reaches the page, so a Postgres error does not leak from the shipped image. That is a mitigation for
the deployed case only. It is not true under `react-router dev`, which should never face anything.

**The recommendation is the option not on that list:** a VPN or a mesh network onto the LAN gives the
household exactly the same access and leaves the threat model the one this was designed against.

---

## Monitoring

[`ARCHITECTURE.md` §7.4](../ARCHITECTURE.md#74-observability) lists the signals and where each one
comes from. **That table is not repeated here.** This section is what the answers mean, and — more
usefully — what they do not.

### `/healthz`

No credentials, `Cache-Control: no-store`, `200` or `503`. The response body is an API contract
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

**Disk, memory, and Caddy.** Nothing here watches any of them, and `caddy` has no healthcheck at all.

One shape worth being able to recognise: if the ledger read itself throws, the body comes back
`"database":true` and `"migrations":"current"` with `"status":"unhealthy"` — the healthy body with a
single field changed. Another reason to alert on `status` rather than on the fields.

### An unhealthy container is not restarted

`restart: unless-stopped` fires when the process **exits**, not when the healthcheck fails. An app
that is wedged but still running stays unhealthy, stays in service, and stays that way indefinitely.
`docker compose restart app` is a manual step. Whatever you point at `/healthz` therefore has to be
able to *act*, not only to alert — or you have to be the one who acts.

### Logs

`docker compose logs -f app` is the entire pipeline; there is no metrics endpoint, no tracing and no
log shipping. Five kinds of line are in there. The stems below are for grepping and may drift —
the code owns the wording:

- **One line per HTTP request** from the server's built-in request logger: method, path, status,
  duration. Note that the container healthcheck hits `/healthz` every ten seconds, and on an idle
  instance that is essentially the whole log.
- **One line per price refresh attempt, always** — stem `Price refresh`. Informational when
  everything priced, a warning when anything came back stale. It is emitted on every tick precisely
  so that "prices stopped updating" is answerable from the log alone.
- **Refresh and provider failures** at error level — stem `Price refresh failed` — stating that the
  last known prices are kept. A failed refresh never zeroes anything.
- **Failed logins** at warning level, one per attempt, with the forwarded address — stem
  `Failed login`. This is the only intrusion signal the instance produces, and nothing counts or
  correlates them for you.
- **Startup**, in order: the configuration check, one line per migration file (applied or skipped),
  then a `Migrations OK` line. A failure names the offending file and the Postgres error, and the
  server is never started — stem `Migrations`.

### "There is no price line in the log" has three causes

Only one of them is a fault:

1. **Nobody has loaded a page since the container started.** The refresh timer is started from the
   first page render, because the app is served by the framework's own server and there is no server
   entry file to hook it to. A booted instance nobody has visited does zero refreshes, forever. The
   container healthcheck does not count — `/healthz` is a resource route and does not run the root
   loader.
2. **The market is closed.** A tick outside market hours returns without spending a request and
   without logging anything.
3. **The poller failed to start.** That one *does* log, once, at error level.

There is also a quiet period by design: the first tick is one full interval after the first page
view, with no immediate poll, so a freshly recreated container is silent for up to
`PRICE_POLL_INTERVAL_MINUTES` even with somebody looking at it.

What to do about any of this is [`runbook.md`](runbook.md).

---

## Backups

**Backups are not a built-in feature and will not become one.** Self-hosters have their own, and a
half-built backup feature is worse than none — it is the one that looks like it is working.

There is exactly one thing to back up for **data**: the `db-data` named volume, through `pg_dump`.
The application container is stateless — it writes nothing to its own filesystem, and `compose.yaml`
mounts it `read_only: true` so that stays true. Uploaded CSVs are kept in Postgres rather than on
disk (DESIGN.md §5.2) precisely so that this stays a single target. The image is rebuildable and
needs no backup.

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

### The second thing to keep is `.env`

"Nothing outside Postgres" is true of *data* and false of *configuration*. `.env` is gitignored and
dockerignored on purpose, so nothing else in the world has a copy of it, and it holds the three
values that are not recoverable from anywhere:

- `SESSION_SECRET` — regenerating it logs the household out. Recoverable, and annoying.
- `AUTH_PASSWORD` — the household needs to be told a new one.
- `POSTGRES_PASSWORD` — the worst of the three, because the `db-data` directory was initialised with
  it and still expects it. A restored dump does not help; see [`runbook.md`](runbook.md).

Keep it wherever you keep passwords, which is not the directory you keep the dumps in.

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

Install Docker, clone this repository, restore your `.env`, then bring up the database **on its own**
before anything else:

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
git rev-parse HEAD          # write this down: it is half of your way back
git pull
docker compose up -d --build
curl -sf http://localhost/healthz
```

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
schema it has never seen ([Monitoring](#monitoring)). `docker compose up -d` on an older tag is
therefore not a rollback — it is an instance that has stopped being able to tell you it is wrong.

**The only true rollback is the old image *plus* the backup taken before the upgrade.** That is why
the dump and the `git rev-parse` are the first two lines above, and why "take a backup before
upgrading" is not a formality here.

### Upgrading Postgres across a major version

`compose.yaml` pins a Postgres major version by tag. Raising it does **not** migrate the data
directory: the new server finds a directory written by the previous major version and refuses to
start, over and over, with `db-data` left exactly as it was. Nothing is damaged, and nothing works.

The dump-and-restore procedure above *is* the upgrade path:

1. **Dump on the old version, before you change the tag.** An archive written by a newer `pg_dump`
   cannot be loaded into an older server, so doing this in the wrong order also removes your way
   back to the version that still runs.
2. `docker compose down` (no `-v`), then remove the volume deliberately:
   `docker volume rm portfolio_db-data`.
3. Change the tag and `docker compose up -d db`, letting it initialise an empty directory.
4. Restore into it, then `docker compose up -d`.

Step 3 is also the one moment `POSTGRES_PASSWORD` is read again, because the data directory is empty
again — so it is the easy time to change it, and the time to make sure `DATABASE_URL` agrees.

---

## Growth and limits

Measured against the demo household in [`scripts/seed-demo.ts`](../scripts/seed-demo.ts) — two
people, six accounts, sixteen instruments, three years of statements — the whole database is about
11 MB, of which the daily price history is about 2 MB. That is the largest dataset this has actually
been run against.

Nothing is ever pruned: no code deletes daily prices, anywhere. The table gains one row per priced
instrument per trading day, so roughly 250 rows per instrument per year. At the design target of
about a hundred instruments that is on the order of 25,000 rows a year, and low single-digit
megabytes.

**So: disk is not worth engineering for at household scale, and there is deliberately no retention
policy.** A household instance grows by a few megabytes a year. Any pruning scheme would cost more
attention than the disk it saved, and would trade away the one thing the history is for. That is the
whole of the capacity planning.

Two terms really are unbounded, and only one of them is data.

**Retained statement originals.** Every upload keeps its complete CSV in the database, forever, on
purpose — it is what makes an old import auditable. A brokerage CSV is tens of kilobytes and the
design target is a handful of uploads a quarter. Abandoned upload drafts are swept once they are a
day old, but only when the *next* upload starts: there is no scheduler, so an instance nobody uploads
to keeps its last abandoned draft indefinitely.

**Container logs, which is the one likely to matter first.** `compose.yaml` has no `logging:` block,
so every service uses Docker's default `json-file` driver with no size limit and no rotation. An idle
instance still writes a request line every ten seconds from its own healthcheck. Cap it per service:

```yaml
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

or set the same options once as the daemon default in `/etc/docker/daemon.json`, which covers
everything on the host rather than only this.

**No resource limits are set on any service** — no memory limit, no CPU limit, no `pids_limit`. On a
machine that runs only this, that is the right default. On a shared host it means one runaway query
can take the box; `deploy.resources.limits` is where you would add them.

**The design target is a target, not a measurement.**
[`ARCHITECTURE.md` §10](../ARCHITECTURE.md#10-performance-and-scale-envelope) states it — one
household, two to four people, a dozen accounts, of the order of a hundred instruments, three or four
statement uploads a quarter — and says plainly that there is no benchmark behind it. If your instance
is meaningfully larger than that, §10 is also the list of which choices break first, in what order.
