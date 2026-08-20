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

**The app serves plain HTTP and never manages certificates.** TLS termination is your reverse
proxy's job — your certs, your renewal, your external hostname. The app has no TLS configuration
because it has no TLS.

The app **trusts `X-Forwarded-*`**. Set the three headers below and the app sees the request as the
browser made it: `https` where the browser used `https`, and the visitor's address rather than the
proxy's.

nginx:

```nginx
server {
    listen 443 ssl;
    server_name portfolio.example.com;

    # your certificate directives here

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    }
}
```

Caddy sets all three itself, so the whole configuration is:

```caddy
portfolio.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

### Do not expose the app port directly

Trusting forwarded headers means trusting whoever can connect. Anything that can reach the app port
can claim any scheme and any client address, so **the app port belongs on the proxy's network and
nowhere else**.

What that trust can actually be abused for is small — a forged `X-Forwarded-Proto` changes only the
`Secure` attribute on the sender's own session cookie, and grants no access to anything — but the
fix is one line, so take it. `compose.yaml` publishes the app port on all interfaces, which is right
for a LAN instance with no proxy. When a proxy runs on the same host, bind it to loopback in a
`compose.override.yaml`:

```yaml
services:
  app:
    ports:
      - "127.0.0.1:3000:3000"
```

### What the app does with the headers

| Header | Effect |
|---|---|
| `X-Forwarded-Proto` | Decides whether the login cookie is issued `Secure`. Behind TLS it is; on a plain-HTTP LAN instance it is not, because a `Secure` cookie would be dropped by the browser and nobody could stay logged in. |
| `X-Forwarded-For` | The address a failed login attempt is logged against. Nothing is authorised on it. |

The database is never exposed: `compose.yaml` publishes no port for it, and the app reaches it over
the Compose network.

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
docker compose stop app

docker compose exec -T db dropdb   -U portfolio portfolio
docker compose exec -T db createdb -U portfolio -O portfolio portfolio
docker compose exec -T db pg_restore -U portfolio -d portfolio < portfolio-2026-08-17.dump

docker compose start app
```

Stopping `app` first is what keeps it from writing to a database that is being replaced underneath
it. On start it applies any migrations the dump predates, so a backup taken from an older version
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
| `PORT` | No | `3000` | HTTP listen port. Under Compose it is also the published host port, so changing it moves both. |
| `PRICE_POLL_INTERVAL_MINUTES` | No | `15` | Quote refresh cadence, 1–1440. The refresh runs in the app process and only while the market is open. |
| `MARKET_TIMEZONE` | No | `America/New_York` | IANA zone for deciding whether the market is open, and for reading which trading day a quote belongs to — so it picks the date a daily close is filed under. No effect on how timestamps are stored, which is UTC. |
| `TZ` | No | `UTC` | Container clock. The database stores UTC whatever this says, so this only affects how the app's own log lines read. Leaving it at `UTC` is recommended. |

`POSTGRES_PASSWORD` also appears in `.env.example`. It configures `compose.yaml` rather than the
app, which is why it is not in the table above; if you change it, change the password in
`DATABASE_URL` to match.

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

**An instance served over plain HTTP at a LAN address cannot be installed as an app on a phone.**

Service workers require a secure context — HTTPS, with `localhost` as the only exception — and
without one the browser will not install the app or cache anything for offline reading. Visiting
`http://192.168.1.20:3000` will work as an ordinary page and will simply not offer to install.

This is a browser rule and a deployment constraint, not something the app can work around. To
install it on a phone, put it behind a proxy with a real certificate, as
[above](#reverse-proxy-and-tls).
