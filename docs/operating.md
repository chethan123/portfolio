# Operating an instance

Everything a self-hoster needs that is not in the [README](../README.md): putting a reverse proxy
in front, backing the data up, the full list of settings, and why a phone will not install the app
from a LAN address.

- [Reverse proxy and TLS](#reverse-proxy-and-tls)
- [Backups](#backups)
- [Restoring](#restoring)
- [Environment variables](#environment-variables)
- [Upgrading](#upgrading)
- [Installing on a phone](#installing-on-a-phone)

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
  renew a certificate for it automatically.
- Or put your own TLS-terminating proxy in front of this one, pointed at Caddy's port 80.

The app **trusts `X-Forwarded-*`**, and the bundled Caddy sets all three headers itself — nothing to
configure there.

| Header | Effect |
|---|---|
| `X-Forwarded-Proto` | Decides whether the login cookie is issued `Secure`. Behind TLS it is; over plain HTTP it is not, because a `Secure` cookie would be dropped by the browser and nobody could stay logged in. |
| `X-Forwarded-For` | The address a failed login attempt is logged against. Nothing is authorised on it. |

The database is never exposed either: `compose.yaml` publishes no port for it, and the app reaches
it over the compose network.

---

## Backups

**Backups are not a built-in feature and will not become one.** Self-hosters have their own, and a
half-built backup feature is worse than none — it is the one that looks like it is working.

There is exactly one thing to back up: **the `db-data` named volume**, through `pg_dump`. The
application container is stateless — it writes nothing to its own filesystem, and `compose.yaml`
mounts it `read_only: true` so that stays true. Uploaded CSVs are kept in Postgres rather than on
disk (DESIGN.md §5.2) precisely so that this stays a single target. Nothing outside Postgres needs
backing up, including the image, which is rebuildable.

Dump the database without stopping the instance:

```sh
docker compose exec -T db pg_dump -U portfolio -d portfolio --format=custom \
  > "portfolio-$(date +%F).dump"
```

`pg_dump` runs inside the `db` container, so no Postgres client is needed on the host and the tool
always matches the server version. The custom format is compressed and is what `pg_restore` reads;
for a plain-SQL dump you can read yourself, use `--format=plain` and restore it with `psql`.

Automate it with whatever already runs on the host — cron, a systemd timer, your NAS. A daily dump
kept for a few weeks is proportionate for a household.

> **A backup you have never restored is not a backup.** Restore one into a throwaway database and
> confirm the numbers, at least once.

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

On start `app` applies any migrations the dump predates, so a backup taken from an older version
restores into the current one without a manual step.

To rebuild a machine from nothing: install Docker, clone this repository, `docker compose up -d`,
then run the restore above.

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

## Upgrading

```sh
git pull
docker compose up -d --build
```

The entrypoint validates the configuration, applies any new migrations to completion, and only then
starts serving — so a request is never served against a half-migrated schema. Migrations are
idempotent, so a restart is always safe, and `GET /healthz` returns a non-200 if the image ever
carries a migration the database has not recorded.

Take a backup before upgrading. Migrations are not reversible.

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
