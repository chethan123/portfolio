# Incident runbook

[`operating.md`](operating.md) is organised by topic and is written to be read when nothing is
wrong. This file is organised by symptom and is written to be read at 2am. It carries no
explanation on purpose: every entry is the symptom, how to confirm it, what to do, and a link to
the section of `operating.md` that says why. When you want the reasoning, follow the link — it is
not repeated here, so it cannot drift from here.

Start here whatever the symptom is:

```sh
docker compose ps
curl -s localhost/healthz
docker compose logs --tail=100 app
```

Every command below runs from the repository root, where `compose.yaml` is.

---

## The site does not answer at all

**Confirm.** `docker compose ps` names which container is missing.

- No `caddy` — nothing is listening on port 80, and the browser reports a refused connection.
- `caddy` up, `app` down or unhealthy — the browser gets `502`. Caddy is fine; its upstream is not.
- `502` that clears on its own — `app` was still starting, or a restore was in progress.

**Do.**

```sh
docker compose logs --tail=100 caddy
docker compose logs --tail=200 app
docker compose up -d
```

If `app` is the one missing, go to the next entry. If `caddy` is the one missing, check nothing
else on the host has taken port 80.

Why: [Reverse proxy and TLS](operating.md#reverse-proxy-and-tls),
[Installing](operating.md#installing).

---

## The app container keeps restarting

Configuration and migrations both refuse before the server starts, so the log tells you which.

**Confirm.**

```sh
docker compose logs --tail=200 app
```

- Configuration: the log opens `Invalid configuration. The following environment variables are
  wrong or missing:` and lists them.
- Migrations: the log says `Migrations failed. The server will not be started.` — go to
  [A migration failed](#a-migration-failed).
- Neither: the process is crashing later. Read the stack.

**Do.** Fix `.env`, then re-check without starting anything. `--entrypoint` is what keeps this from
also running migrations:

```sh
docker compose run --rm --no-deps \
  --entrypoint "node ./server/validate-config.ts" app
docker compose up -d app
```

Two things about the validator:

- It reports **every** problem it can see in one pass, so fix the whole list before retrying.
- The `AUTH_PASSWORD` / `SESSION_SECRET` rule is a cross-field check that runs only after the rest
  parses. An instance with a bad `PORT` *and* a missing `SESSION_SECRET` reports the port first and
  the secret only on the next attempt. A second refusal is not a new fault.
- An empty value is treated as unset. `AUTH_PASSWORD=` is not an error and leaves the instance
  open.

Why: [Environment variables](operating.md#environment-variables), [Security](operating.md#security).

---

## `/healthz` returns 503

The body says which fault it is. Read `database` first — `migrations` still reads `"current"` when
the database is unreachable.

**Confirm.**

```sh
curl -s localhost/healthz
```

Database unreachable:

```json
{"status":"unhealthy","database":false,"migrations":"current","pendingMigrations":[]}
```

Migrations pending — it names the files:

```json
{"status":"unhealthy","database":true,"migrations":"pending","pendingMigrations":["0004_upload_draft.sql","0005_app_setting.sql"]}
```

And the trap: the ledger read itself threw. This body is the healthy body except for `status`.

```json
{"status":"unhealthy","database":true,"migrations":"current","pendingMigrations":[]}
```

**Do.**

- `database: false` — check `db`, then the credentials.

  ```sh
  docker compose ps db
  docker compose logs --tail=100 db
  docker compose exec db pg_isready -U portfolio -d portfolio
  ```

  `password authentication failed` in the `app` log is
  [I changed the database password and nothing connects](#i-changed-the-database-password-and-nothing-connects).

- `migrations: "pending"` — the running container is serving against a schema older than its code.
  Restart it so the entrypoint applies them, then re-read the body.

  ```sh
  docker compose restart app
  ```

- The third body — the error is in the `app` log, from the migration-status read rather than from a
  query. Read it, then restart `app`.

Note that `/healthz` requires no credentials and is served with `Cache-Control: no-store`, so a
monitor needs no configuration and a stale answer is not a thing that happens.

Why: [Monitoring](operating.md#monitoring).

---

## The app is healthy but pages are failing

`/healthz` proves the database answers `select 1` and that no shipped migration is unapplied. Two
real faults sit outside both.

**Confirm — writes failing while reads succeed.** Uploads and edits 500 while every read-only page
loads. A full disk or a revoked grant does this.

```sh
df -h
docker system df -v | grep -i portfolio_db-data
docker compose exec db psql -U portfolio -d portfolio -c "select pg_size_pretty(pg_database_size('portfolio'))"
docker compose logs --tail=200 app | grep -i "error"
```

**Confirm — the database is ahead of the code.** Individual pages 500 at random while `/healthz`
answers `200` and `"current"`. Pending migrations are the files on disk minus the ledger rows, so a
ledger row the image does not ship is invisible to it. Compare the two:

```sh
docker compose exec db psql -U portfolio -d portfolio \
  -c "select filename from schema_migrations order by filename"
docker compose exec app ls migrations
```

A row in the ledger with no matching file is the fault.

**Do.** For writes failing: free disk, or restore the grant, then retry the failing action — nothing
was partly recorded. For a database ahead of the code, go to the next entry.

Why: [Monitoring](operating.md#monitoring), [Growth](operating.md#growth-and-limits).

---

## I rolled the image back and now pages break

There is no schema-version guard in this direction. `/healthz` answers `200` and `"current"` while
the code runs against a schema it was never typed against, so it presents as random 500s on
individual pages rather than as an unhealthy instance.

**Confirm.** The ledger/disk comparison in the entry above: a `schema_migrations` row whose file the
running image does not carry.

**Do.** One of two, and only these two:

- Go forward again to the image whose migrations match the ledger.
- Restore the backup taken before the upgrade, on the older image. See
  [I need to restore from a backup](#i-need-to-restore-from-a-backup).

Editing the ledger is not a third option.

Why: [Upgrading](operating.md#upgrading), [Restoring](operating.md#restoring).

---

## Prices have stopped updating

Rule out these before suspecting the provider.

**Confirm.**

```sh
docker compose logs --tail=500 app | grep "Price refresh"
```

One line per tick, always — a `Price refresh:` line with a count of what was priced and what was
left stale. So:

- **No lines at all, and the market is closed.** The tick returns before it logs anything outside
  market hours. Expected.
- **No lines at all since the last restart, and the market is open.** The poller starts from a page
  render, not from boot — `/healthz` does not start it. Load any page in a browser, then wait one
  full `PRICE_POLL_INTERVAL_MINUTES`; there is deliberately no immediate first tick.
- **The poller failed to start.** Grep for the stem `Price poller did not start`. Restart `app`.

  ```sh
  docker compose logs --tail=500 app | grep -i "Price poller did not start"
  ```

- **The provider is unreachable.** Grep for the stem `Price refresh failed`, or for `Price refresh`
  lines reporting stale instruments. Last-known prices are kept and marked stale — never zeroed —
  and `/healthz` deliberately stays `200`, because a third-party outage must not make Compose
  restart a healthy app. Nothing to do but check egress.

**Do.** Nothing destructive is ever warranted here. `docker compose restart app` is the only action,
and it needs a page render afterwards to start the loop again.

Why: [Monitoring](operating.md#monitoring).

---

## An upload is refused as too large

**Confirm.** The refusal names the limit and it is 10 MB.

**Do.** Under the bundled `compose.yaml` the cap is **not settable**: `MAX_UPLOAD_MB` is validated
and read by the application but is absent from the `app` service's `environment:` block, so setting
it in `.env` changes nothing. Add it to that block first — the snippet is in `operating.md`.

Two things that look like bugs and are not:

- The pre-read check reads `Content-Length`, which measures the **whole multipart body** — the file
  plus the form fields plus the part boundaries. A file a little under the cap can still be refused.
- A request carrying no `Content-Length` is refused later instead, on the file's own size, against
  the same cap.

Why: [Environment variables](operating.md#environment-variables).

---

## Everything is slow, or requests hang

**Confirm.** Look at what the database is actually doing.

```sh
docker compose exec db psql -U portfolio -d portfolio -c \
  "select pid, state, wait_event_type, wait_event, now()-query_start as runtime, left(query,80) \
   from pg_stat_activity where datname='portfolio' order by runtime desc nulls last"

docker compose exec db psql -U portfolio -d portfolio -c \
  "select count(*), state from pg_stat_activity where datname='portfolio' group by state"
```

- Connections at the pool's ceiling with requests queueing behind them: pool exhaustion. New work
  waits for a connection rather than failing.
- A long-running query in `active` with nothing waiting on it: there is **no statement timeout**, so
  it will not be cut off. It has to be ended or waited out.
- Requests failing after about five seconds rather than hanging: that is the pool's connect timeout,
  which means the database is unreachable, not slow. Go to
  [`/healthz` returns 503](#healthz-returns-503).

**Do.**

```sh
docker compose restart app
```

That drops the pool and every connection in it. To end one query without restarting anything,
cancel it by pid:

```sh
docker compose exec db psql -U portfolio -d portfolio -c "select pg_cancel_backend(<pid>)"
```

Why: [Monitoring](operating.md#monitoring), [Growth](operating.md#growth-and-limits).

---

## Nobody can log in, or I need to lock everyone out

There is no password reset flow, no account recovery, and no sign-out control anywhere in the app.

**Confirm.** `AUTH_PASSWORD` and `SESSION_SECRET` in `.env` are what the instance is using.

**Do.** Changing either one is the only revocation there is, and it takes effect on the next start:

```sh
# In .env — set a long random value, not a memorable one.
#   AUTH_PASSWORD=...
#   SESSION_SECRET=$(openssl rand -hex 32)
docker compose up -d app
```

- Changing **either** logs everyone out immediately. There is no rotation grace period, so nobody
  keeps a session across the change.
- The session cookie has no server-side expiry. A captured cookie stays valid until the password or
  the secret changes — this is the revocation for that too.
- Removing `AUTH_PASSWORD`, or setting it to an empty value, turns the gate **off** and serves the
  instance open. That is not a way to let someone in.

Why: [Security](operating.md#security).

---

## I changed the database password and nothing connects

**Confirm.** `app` crash-looping, with `password authentication failed for user "portfolio"` in its
log.

**Do.** `POSTGRES_PASSWORD` is read by Postgres only when it first initialises an empty data
directory, and never again. On an instance that has already run, changing it in `.env` does nothing
to the role. Change the role itself, then make `DATABASE_URL` match:

```sh
docker compose exec db psql -U portfolio -d portfolio \
  -c "alter role portfolio with password 'the-new-one'"
```

```sh
# In .env, both of them, to the same new value:
#   POSTGRES_PASSWORD=the-new-one
#   DATABASE_URL=postgres://portfolio:the-new-one@db:5432/portfolio
docker compose up -d app
```

The user and database names are hardcoded literals in `compose.yaml`, not variables. Only the
password is substituted.

Why: [Environment variables](operating.md#environment-variables).

---

## I need to restore from a backup

The procedure is in [Restoring](operating.md#restoring). Run it from there rather than from here —
this entry lists only what people get wrong.

- **Stop `app` first.** The in-process price poller holds a connection, and `dropdb` fails while it
  does.
- **Keep `--exit-on-error --single-transaction` on `pg_restore`.** Without both, it continues past
  failures and leaves a half-old, half-new schema, which is the thing the restore is avoiding.
- **The site answers `502` for the whole window.** `caddy` stays up and retries its upstream. That
  is the restore working, not a second fault.
- **Check the dump before you trust it.** `pg_dump ... > file` creates the file even when it fails,
  so a truncated dump looks exactly like a backup. Check the exit status, and:

  ```sh
  pg_restore --list portfolio-2026-08-23.dump | head
  ```

- **On a fresh machine, bring up `db` alone first** — `docker compose up -d db` — so `app` does not
  create and migrate an empty schema you are about to drop.
- **A dump from an older release is fine.** On start, `app` applies the migrations the dump predates.

Why: [Restoring](operating.md#restoring), [Backups](operating.md#backups).

---

## I need to move to another machine

**Do.** Carry both of these, not just the first:

- The `pg_dump` file. It is the whole of the data, including the original uploaded CSVs, the
  migration ledger and the settings row.
- **`.env`.** It is gitignored and dockerignored, so a fresh clone does not have it. It holds
  `DATABASE_URL`, `AUTH_PASSWORD` and `SESSION_SECRET`. A regenerated `SESSION_SECRET` logs everyone
  out and is recoverable; a lost `AUTH_PASSWORD` means choosing a new one and telling the household.

The image is rebuildable and is not worth carrying.

Then: install Docker, clone, copy `.env` into place, `docker compose up -d db`, restore, start the
rest.

Why: [Installing](operating.md#installing), [Backups](operating.md#backups).

---

## I need to upgrade Postgres to a new major version

**Confirm.** The `db` image tag is pinned to a major version in `compose.yaml`. A newer major refuses
to start on a data directory written by an older one, and says so in the `db` log.

**Do.** Dump on the **old** version first — a dump taken after the tag has been changed is a dump
that never runs.

```sh
docker compose stop app
docker compose exec -T db pg_dump -U portfolio -d portfolio --format=custom \
  > "portfolio-pre-pg-upgrade-$(date +%F).dump"
```

Verify that file, then — **this deletes the data volume, and the dump you just verified is the only
copy**:

```sh
docker compose down -v
```

Change the image tag in `compose.yaml`, bring up `db` alone, and restore into it:

```sh
docker compose up -d db
```

Then follow [Restoring](operating.md#restoring), and start the rest.

Why: [Upgrading](operating.md#upgrading), [Restoring](operating.md#restoring).

---

## I think I have lost data

**Confirm.** What is and is not at risk:

- Every recorded statement, correction and balance is written in a transaction. A failed request
  records nothing at all — there is no partly-recorded state to find.
- Migrations fail closed: a failure rolls that file back whole and the server refuses to start, so a
  half-applied schema is not a thing that exists.
- Nothing in the application deletes anything. An account is closed rather than deleted; a
  correction is a new record rather than an overwrite. What looks like missing data is usually a
  screen filtered to a date or an account.
- An in-progress upload draft is not data. Drafts are swept after 24 hours, and only when the next
  upload starts.

**The one real destroyer is `docker compose down -v`**, which deletes the `db-data` volume — every
statement, every original CSV, every price. There is no undo and no confirmation prompt. Same for
`scripts/smoke-test.sh`, which runs it.

**Do.** If the volume is gone, restore the most recent dump:
[I need to restore from a backup](#i-need-to-restore-from-a-backup). If it is not gone, nothing here
needs a repair — find the filter.

```sh
docker volume ls | grep db-data
```

Why: [Backups](operating.md#backups), [Restoring](operating.md#restoring).

---

## A migration failed

**Confirm.**

```sh
docker compose logs --tail=100 app
```

The refusal names the file and the underlying cause:

```
Migrations failed. The server will not be started.
Error: Migration 0004_upload_draft.sql failed and was rolled back.
  [cause]: error: relation "upload_draft" already exists
```

Nothing is half-applied. Each file is one transaction — the file and its ledger row commit together
or roll back together — and the entrypoint stops before the server, so the instance refused to serve
rather than serving something wrong.

**Do.** Fix the cause, then restart; the run is idempotent and retries from a clean state.

```sh
docker compose up -d app
```

The bookkeeping caveat is the one that catches people: idempotency holds only while
`schema_migrations` agrees with the actual schema. If the ledger is missing a row for an object that
does exist — most often from restoring schema and data separately — the re-run fails naming that
object, exactly as above. The repair is to make the ledger agree, or to restore a dump that carries
both together. There is no down path, no rollback command, and no checksums: editing an
already-applied `.sql` file is a silent no-op forever.

Why: [Upgrading](operating.md#upgrading), [Restoring](operating.md#restoring).

---

## Things that are safe

- `docker compose restart app` — the fix for a wedged-but-alive app. An unhealthy container is not
  restarted for you: `restart: unless-stopped` fires on process exit, not on a failing healthcheck.
- `docker compose down` — **without** `-v`. Stops and removes the containers and keeps `db-data`.
- `docker compose up -d --build` — rebuilds and recreates. Note that Caddy's `/data` is not on a
  volume, so a recreate discards any certificates it has issued.
- Re-running migrations, by restarting `app`. They are idempotent.
- `curl -s localhost/healthz` — no credentials, no side effects.
- Reading anything in `pg_stat_activity`.

## Things that are not

- `docker compose down -v` — **deletes the `db-data` volume.** Every statement, every original CSV,
  every price. No confirmation, no undo.
- `scripts/smoke-test.sh` — a CI tool. It runs `docker compose down -v` at the start *and* from an
  exit trap. Never run it against a real instance.
- `dropdb`, in isolation. It is safe only as the first half of the restore procedure, with a
  verified dump in hand.
- Editing `schema_migrations` to make a symptom go away.
- Editing an already-applied migration file. Only filenames are recorded, so the change never runs.
- Publishing the `app` or `db` port. The app trusts `X-Forwarded-*` unconditionally, which is sound
  only while nothing but the proxy can reach it.

---

For why any of this is the way it is — installing, security, monitoring, backups, restoring,
upgrading and growth, each as its own section — see [`operating.md`](operating.md).
