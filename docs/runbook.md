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
docker compose logs --tail=100 gate
```

Every command below runs from the repository root, where `compose.yaml` is.

---

## The site does not answer at all

**Confirm.** `docker compose ps` names which container is missing.

- No `caddy` — nothing is listening on port 80, and the browser reports a refused connection.
- `caddy` up, `app` down or unhealthy — the browser gets `502`. Caddy is fine; its upstream is not,
  and because Caddy's own healthcheck proxies through to `app` it reports unhealthy too. One fault.
- `caddy` up, `gate` down or unhealthy — `/healthz` still answers `200`, everything else `502`. Go
  to [Nobody can sign in](#nobody-can-sign-in).
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

## `docker compose up` refuses to start anything

**Confirm.** No container is created and the message names one variable or one file.

- A `GATE_CLIENT_ID`, `GATE_CLIENT_SECRET`, `GATE_COOKIE_SECRET` or `PUBLIC_ORIGIN` named in the
  refusal — it is unset or empty in `.env`. `docker compose config --quiet` reproduces this without
  starting anything, and reports the first one it hits.
- A bind-mount complaint naming `./allowed-emails.txt` — the file is not there. This one surfaces at
  `up`, not at `config`.

```sh
docker compose config --quiet
ls -l .env allowed-emails.txt
```

**Do.**

```sh
cp .env.example .env                              # if there is no .env at all
cp allowed-emails.example.txt allowed-emails.txt  # if the allowlist is missing
$EDITOR .env
docker compose up -d
```

This refusal is the design, not a fault: there is no configuration in which this stack boots without
the gate.

Why: [Installing](operating.md#installing),
[Environment variables](operating.md#environment-variables).

---

## The app container keeps restarting

Configuration and migrations both refuse before the server starts, so the log tells you which.

**Confirm.**

```sh
docker compose logs --tail=200 app
```

- Configuration: the log opens with a refusal at the stem `Invalid configuration`, naming every
  wrong or missing variable.
- Migrations: a line at the stem `Migrations failed` — go to
  [A migration failed](#a-migration-failed).
- Neither: the process is crashing later. Read the stack.

**Do.** Fix `.env`, then re-check without starting anything. `--entrypoint` is what keeps this from
also running migrations:

```sh
docker compose run --rm --no-deps \
  --entrypoint "node ./server/validate-config.ts" app
docker compose up -d app
```

About the validator:

- It reports **every** problem it can see in one pass, so fix the whole list before retrying.
- An empty value is treated as unset and falls back to the default. The gate's own credentials are
  not its business at all — those stop Compose before a container exists
  ([`docker compose up` refuses to start anything](#docker-compose-up-refuses-to-start-anything)).
- **`PUBLIC_ORIGIN` is the one most likely to name itself here.** The app checks it as strictly as
  a passkey check needs — an IP-address host, a path or query string, or merely a differently
  spelled version of the same origin (a trailing slash, a different case, an explicit `:443`) are
  each refused by name, even though the value is not empty and clears Compose's own check. Copying
  the address straight out of a browser's own bar is the usual way a trailing slash gets in. See
  [Environment variables](operating.md#environment-variables) for the exact shape it wants.

If it is `gate` rather than `app` that is restarting, its log names the reason and `cookie_secret`
is the usual one — the value must decode to 16, 24 or 32 bytes:

```sh
docker compose logs --tail=100 gate
```

Why: [Environment variables](operating.md#environment-variables), [Security](operating.md#security),
[The lock](operating.md#the-lock).

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

## The monitor says the instance is down but the app works

`/healthz` is the one path Caddy does not put to the gate. Everything else answers a redirect to
Google, which a monitor reads as an outage.

**Confirm.** Compare the two:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost/healthz
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' http://localhost/
```

- `200` and `302` — the stack is fine and the monitor is pointed at a gated path.
- `302` on `/healthz` too — the exemption has regressed. The `handle /healthz` block must come
  before the catch-all `handle` in the `Caddyfile`.

```sh
docker compose exec caddy cat /etc/caddy/Caddyfile
docker compose logs --tail=100 caddy
```

**Do.** Point the monitor at `/healthz` and nothing else. If the exemption regressed, restore that
block and reload:

```sh
docker compose restart caddy
```

Why: [Monitoring](operating.md#monitoring), [Security](operating.md#security).

---

## The app is healthy but pages are failing

`/healthz` proves the database answers `select 1` and that no shipped migration is unapplied. Two
real faults sit outside both.

**Confirm — writes failing while reads succeed.** Uploads and edits 500 while every read-only page
loads. A full disk or a revoked grant does this.

```sh
df -h
du -sh volumes/db 2>/dev/null || docker compose exec db du -sh /var/lib/postgresql/data
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

One line per refresh the poller actually runs — a `Price refresh` line with a count of what was
priced and what was left stale. A tick that runs nothing writes nothing: the market closed, a tick
landing while one still runs, or the advisory lock held by another process are all silent and all
ordinary. So:

- **No lines at all, and the market is closed.** A tick outside market hours asks for no quotes, so
  it writes no `Price refresh` line. Expected. It is not idle, though: it still runs the backfill
  batch, so a `Price backfill` line at three in the morning is also expected (ADR-0011).
- **No lines at all since the last restart, and the market is open.** The poller starts from a page
  render, not from boot — `/healthz` does not start it. Load any page in a browser, then wait one
  full refresh cadence (Settings → Prices; seeded to 15 minutes); there is deliberately no
  immediate first tick.
- **The poller failed to start.** Grep for the stem `Price poller did not start`. Restart `app`.

  ```sh
  docker compose logs --tail=500 app | grep -i "Price poller did not start"
  ```

- **The provider is unreachable, or `worker` is.** Grep for the stem `Price provider failed`, or for
  `Price refresh` lines reporting stale instruments. Last-known prices are kept and marked stale —
  never zeroed — and `/healthz` deliberately stays `200`, because a third-party outage must not make
  Compose restart a healthy app. `app` has no egress of its own by construction — every fetch
  crosses the shared socket to `worker` instead — so this stem now covers a dead, restarting or
  never-started `worker` too, and reads `no worker listening at /run/price-worker/worker.sock
  (ENOENT)` for that case rather than naming a provider. Check `docker compose ps` for `worker`
  before anything else, and [the worker's own healthcheck](operating.md#the-workers-own-healthcheck)
  for what its states mean: giving `app` a network back does not fix a dead worker, and undoes this
  release's isolation for nothing.

**Do.** Press **Refresh now** on any figure screen first — it spends a provider request
immediately, works outside market hours, and needs no restart. The line it prints under the button
is the confirmation: how many prices it fetched, or that there was nothing new. (With JavaScript
off there is no line — the page simply reloads, and the stamp is all there is.) The as-of stamp
alone is not a verdict: it is the *oldest* fetched quote, so a press that worked can leave it
still, and outside market hours it usually will. Beyond that, nothing destructive is ever
warranted here: `docker compose restart app` is the remaining action, and it needs a page render
afterwards to start the loop again.

Why: [Monitoring](operating.md#monitoring).

---

## A holding is unpriced on a past date

The chart runs low through a stretch and then steps up, or a past date's coverage sentence counts
fewer holdings than today's. The data is not wrong; the price history does not reach back that far
yet.

**Confirm.** Open **Settings → Prices**. Every holding whose price history starts later than it is
held appears there, with the date it is held from, the date its prices start, and what the last
attempt to fill it came to. An empty list means this is not your problem.

**Do.** It depends on what the row says.

- **Nothing yet, or a recent `filled`.** Wait. A refresh fills a few instruments at a time, so a
  household that has just loaded years of statements works through them over a handful of refreshes.
  Pressing **Refresh now** spends one immediately.
- **`no_history`.** Nothing to do. The feed has no history for that ticker and will keep answering
  so, at one request a day.
- **`non_usd`.** Nothing to do here; the instrument should not have been created against that
  ticker.
- **`split_unresolved`.** The one outcome that suggests a code or library problem. Run
  [`developing.md`](developing.md)'s split-convention check.
- **`provider_failed`.** The row carries the provider's own text. Retried once a day; a rate limit
  or an outage clears itself.
- **"Never".** Nothing can fetch it. [`importing-history.md`](importing-history.md) step 5 has the
  `psql` for entering closes by hand.

One thing this screen cannot tell you: whether an instrument has *changed symbols*, in which case it
is filled with the wrong company's closes and every figure looks plausible. Spot-check a figure
against a statement of the era for anything you know has changed.

Why: [ADR-0011](adr/0011-a-backfill-fills-the-spine-but-never-moves-it.md), and
[DESIGN.md §14](../DESIGN.md) limitation 14 for the symbol change.

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

## A family member's phone is lost or stolen

**Confirm.** Which address that person signs in with, and that it is in the allowlist.

```sh
cat allowed-emails.txt
```

**Do.** Remove their line, then restart the gate:

```sh
$EDITOR allowed-emails.txt
docker compose restart gate
```

- The removal alone signs that person out **everywhere**, on their next request, on every device:
  the gate re-checks each request's address against the file and watches the file for changes.
- The restart is insurance, not the mechanism. A single-file bind mount can stop following a file an
  editor replaces by rename, and there is no signal when it does.
- Nobody else is affected. Their sessions continue.

If you cannot be sure which account or which device, use the wider lever — it signs out everyone, on
every device, at once:

```sh
# In .env: GATE_COOKIE_SECRET=$(openssl rand -base64 32 | tr -- '+/' '-_')
docker compose up -d gate
```

Then tell the household to sign in again. There is no per-device revocation between these two.

Why: [Security](operating.md#security).

---

## Nobody can sign in

Three suspects: Google, the `gate` container, the allowlist file. Existing sessions keep working
through a Google outage, so "everyone at once, including people who were already in" points away
from Google.

**Confirm — the container.**

```sh
docker compose ps gate
docker compose logs --tail=100 gate
```

Not `healthy`, or crash-looping, is the whole answer. `cookie_secret` in the log means
`GATE_COOKIE_SECRET` does not decode to 16, 24 or 32 bytes.

**Confirm — the front door still challenges correctly.**

```sh
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' http://localhost/
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost/oauth2/auth
```

A `302` to `/oauth2/sign_in` and a `401` are both correct. Anything else is Caddy or the gate, not
Google.

**Confirm — the allowlist.**

```sh
docker compose exec gate cat /etc/oauth2-proxy/allowed-emails.txt
docker compose logs gate | grep -i "authenticated emails file"
docker compose logs gate | grep -i "invalid authorization via session"
```

Read the file **inside the container**: an empty or truncated file there, or one that does not match
what is on the host, is the fault. Addresses are matched whole and case-insensitively; a typo admits
nobody.

**Confirm — Google.** Only if the container is healthy and the file is right. People who were
already signed in are unaffected; new sign-ins fail at Google's own pages, or come back to an error
from the gate.

- The consent screen was unpublished, or the OAuth client deleted or its secret rotated.
- `PUBLIC_ORIGIN` changed and the registered redirect URI did not, or the reverse. It must be
  `PUBLIC_ORIGIN` + `/oauth2/callback`, character for character.
- Google itself is down. Wait; sessions in flight are not affected.

**Do.**

```sh
docker compose restart gate     # after any allowlist edit, and worth trying first
docker compose up -d gate       # after changing anything in .env
```

There is no break-glass account and no second sign-in path. Repairing the gate is the only way in.

Why: [Security](operating.md#security),
[Environment variables](operating.md#environment-variables),
[Setting up Google sign-in](google-sign-in.md#when-it-does-not-work) for what each of Google's own
refusals means.

---

## Every browser is locked and no passkey can be reached

**Confirm.** Every browser shows the unlock screen — including ones that were already signed in
through Google — and nobody in the household can complete a passkey check: every device that held
one is lost, broken, or otherwise out of reach.

```sh
docker compose exec db psql -U portfolio -d portfolio \
  -c "select credential_id, label, enrolled_at, last_used_at from passkey order by enrolled_at"
```

**If you removed the bundled `db` service and point at your own Postgres**
([Running against your own Postgres](operating.md#running-against-your-own-postgres)), there is no
`db` container to exec into — run the identical SQL through your own database's own administrative
connection instead. `DATABASE_URL` lives in `.env`, which Compose reads and the invoking shell does
not (docs/developing.md's "Which files Vite reads") — `psql "$DATABASE_URL"` typed as-is reaches an
empty string and connects nowhere. From the repository root, on the host running Compose, read it
out of `.env` directly:

```sh
psql "$(grep '^DATABASE_URL=' .env | cut -d= -f2-)" \
  -c "select credential_id, label, enrolled_at, last_used_at from passkey order by enrolled_at"
```

Running this from somewhere else entirely — a laptop that is not the Compose host — has no `.env` to
read; paste the same connection string you set as `DATABASE_URL` there in its place instead.

One row per enrolled passkey, either way. An empty result means the instance is not actually locked
at all — go to [Nobody can sign in](#nobody-can-sign-in) instead.

**Do.** Stop `app`, delete every row, then start `app` again — in that order, because the order is
the point. There is no token, no recovery code and no second path in through the front door — this is
the one way back, and it returns the instance to the same state a fresh install starts in: unlocked,
with anyone the gate admits free to enrol a passkey again.

```sh
docker compose stop app

docker compose exec db psql -U portfolio -d portfolio -c "delete from passkey"
# or, against your own Postgres:
psql "$(grep '^DATABASE_URL=' .env | cut -d= -f2-)" -c "delete from passkey"

docker compose start app
```

`unlock_grant.passkey_id` references `passkey` `on delete cascade`, so the delete also removes every
browser's current grant along with the passkey that minted it — nothing is left half-cleared. Every
browser still holds a cookie naming one of those deleted rows; it names nothing now, and is cleared
on that browser's first refusal once somebody enrols again.

Why, including why the order above is stop-delete-start and not delete-then-restart:
[The lock](operating.md#the-lock).

---

## A second device offers no way to use another device on the unlock screen

**Confirm.** A browser that holds no passkey shows the unlock screen, and pressing **Unlock** offers
only this device's own provider — no code to scan, no prompt arriving on a phone that does hold one.
Another browser on the same device behaves the same way.

**Do.** From a browser that is still unlocked — usually the one that enrolled the household's first
passkey — enrol a second passkey using a different provider, then press **Unlock** on the affected
device again. If no browser is still unlocked, unlock one on a device that can reach a passkey the
household has enrolled, and enrol from there. If no enrolled passkey can be reached at all, or the
second passkey changes nothing, this is
[Every browser is locked and no passkey can be reached](#every-browser-is-locked-and-no-passkey-can-be-reached)
above instead.

Why: [Before the household's first passkey](operating.md#before-the-households-first-passkey).

---

## Somebody wants to sign out

**Do.** Send them to `PUBLIC_ORIGIN` + `/oauth2/sign_out` in the browser they want cleared.

- It clears the gate's cookie in **that browser only**. The Google session on the device is
  untouched.
- The next visit bounces out to Google and back and is re-admitted without anyone typing anything.
  On a device signed into one Google account, no screen is shown at all.
- So it is not revocation. For that, see
  [A family member's phone is lost or stolen](#a-family-members-phone-is-lost-or-stolen).

There is no sign-out control in the UI; it is deferred and tracked as
[issue #89](https://github.com/chethan123/portfolio/issues/89), and these limits are the argument
for it.

Why: [Security](operating.md#security).

---

## I changed the database password and nothing connects

**Confirm.** `app` (and `dump`, if it is enabled) crash-looping, with `password authentication
failed for user "portfolio"` in the log.

**Do.** Check `.env` for a leftover `DATABASE_URL` line first:

```sh
grep -n '^DATABASE_URL=' .env
```

`pg` prefers a URL's own password to `PGPASSWORD`, so a line left over from before the release that
took the password out of `DATABASE_URL` keeps authenticating with whatever that line names, however
correctly the role and `POSTGRES_PASSWORD` already agree — delete it and run `docker compose up -d`
again, and this is fixed. (Unless you run your own Postgres —
[Running against your own Postgres](operating.md#running-against-your-own-postgres) — where this
entry does not apply at all: your `DATABASE_URL` is meant to carry the password there.)

If that line was never there, the role itself has not been changed to match. `POSTGRES_PASSWORD` is
read by Postgres only when it first initialises an empty data directory, and never again, so editing
it in `.env` alone does nothing to a role that already exists. Write the new value to `.env` first,
then change the role to match, then recreate the containers that still hold the old one:

```sh
# In .env: POSTGRES_PASSWORD=the-new-one
docker compose exec db psql -U portfolio -d portfolio \
  -c "alter role portfolio with password 'the-new-one'"
docker compose up -d
```

`app` and `dump` both read the password through `PGPASSWORD`, set from this same variable — once the
leftover `DATABASE_URL` above is gone, there is nothing left to keep in sync with it. The user and
database names are hardcoded literals in `compose.yaml`, not variables; only the password is
substituted.

Why: [Environment variables](operating.md#environment-variables).

---

## I lost `.env` and do not know `POSTGRES_PASSWORD`

**Confirm.** Every `docker compose` command — `up`, `ps`, `logs`, `exec`, all of them — refuses
immediately, naming one required variable before any container is touched. It will not necessarily
be `POSTGRES_PASSWORD`: interpolation has no fixed order, so a `.env` missing everything could just
as easily be refused by one of the gate's own variables first.

**Do.** You do not need to recover the value that was lost. `db`'s own local socket authenticates on
`trust`, never on a password, so a shell inside the container can set the role to whatever you like
without knowing what it used to be — the same [rotation](operating.md#environment-variables) an
operator who still has the old password uses on purpose. Rebuild `.env` from
[`.env.example`](../.env.example) far enough to clear the refusal: `GATE_CLIENT_ID` and
`GATE_CLIENT_SECRET` come back from the Google Cloud console, `GATE_COOKIE_SECRET` is simply
regenerated (this signs the household out — the one real cost here), `PUBLIC_ORIGIN` is whatever
hostname your house proxy already serves this at, `DUMP_UID`/`DUMP_GID` are `id -u`/`id -g` for the
account `./volumes/dumps` belongs to, and `POSTGRES_PASSWORD` is any freshly generated value —
`openssl rand -hex 32` is fine, because nothing has checked it against the running role yet. Once
every required variable holds something:

```sh
docker compose up -d db
docker compose exec db psql -U portfolio -d portfolio \
  -c "alter role portfolio with password 'the-value-you-just-generated'"
docker compose up -d
```

`db` first, and on its own: `exec` enters a *running* container, and if the host rebooted while
`.env` was unusable there is nothing to enter — every compose verb was refusing, so nothing came
back up. It starts cleanly on the placeholder because Postgres reads `POSTGRES_PASSWORD` only once,
to initialise an empty data directory, and this one is not empty: the value only has to match what
you put in `.env`, never what it originally was.

Why: [Environment variables](operating.md#environment-variables), [Backups](operating.md#backups).

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
  docker compose exec -T db pg_restore --list < portfolio-2026-08-23.dump | head
  ```

- **On a fresh machine, bring up `db` alone first** — `docker compose up -d db` — so `app` does not
  create and migrate an empty schema you are about to drop.
- **A dump from an older release is fine.** On start, `app` applies the migrations the dump predates.

Why: [Restoring](operating.md#restoring), [Backups](operating.md#backups).

---

## I need to move to another machine

**Do.** Carry all three of these, not just the first:

- The `pg_dump` file. It is the whole of the data, including the original uploaded CSVs, the
  migration ledger and the settings row.
- **`.env`.** It is gitignored and dockerignored, so a fresh clone does not have it. It holds
  `POSTGRES_PASSWORD` and the gate's four — plus `DATABASE_URL`, if you set one to run against your
  own Postgres. A regenerated `GATE_COOKIE_SECRET` signs everyone out and is recoverable; the client
  id and secret come back only from the Google Cloud console.
- **`allowed-emails.txt`.** Also gitignored. Without it nothing starts at all.

The image is rebuildable and is not worth carrying.

Then: install Docker, clone, copy `.env` and `allowed-emails.txt` into place,
`docker compose up -d db`, restore, start the rest.

If the public origin changes with the machine, `PUBLIC_ORIGIN` and the redirect URI registered on
the Google OAuth client both have to change with it, or nobody can sign in.

**If the household holds any passkeys, a hostname change locks the instance with none that work.**
Delete every passkey as part of the move (the command is in
[Every browser is locked and no passkey can be reached](#every-browser-is-locked-and-no-passkey-can-be-reached)),
before or right after you bring the new machine up, and have the household enrol again once it is
serving the new hostname. Moving without doing that does not merely orphan the old passkeys — it
leaves the new instance locked, with nothing that can unlock it.

Why: [Installing](operating.md#installing), [Backups](operating.md#backups),
[The lock](operating.md#the-lock).

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

Verify that file, then — **this empties the data directory, and the dump you just verified is the
only copy**:

```sh
docker compose down
docker run --rm -v "$PWD/volumes/db/data:/data" postgres:17-alpine find /data -mindepth 1 -delete
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
- Almost nothing in the application deletes anything: an account is closed rather than deleted, and
  a correction is a new record rather than an overwrite. The real deletes are removing a person who
  owns no accounts, and removing a passkey — including every one at once, [above](#every-browser-is-locked-and-no-passkey-can-be-reached).
  What looks like missing data is usually a screen filtered to a date or an account.
- An in-progress upload draft is not data. Drafts are swept after 24 hours, and only when the next
  upload starts.

**The one real destroyer is deleting `./volumes/db/data`** — every statement, every original CSV,
every price. There is no undo and no confirmation prompt. `docker compose down -v` is no longer that
command: it drops the volume record and leaves the directory standing. `scripts/smoke-test.sh` still
is one — it empties that directory itself, at both ends of a run.

**Do.** If the cluster is gone, restore the most recent dump:
[I need to restore from a backup](#i-need-to-restore-from-a-backup). If it is not gone, nothing here
needs a repair — find the filter. The directory is `0700` uid 70, so ask Postgres what is in it
rather than your own shell:

```sh
ls -ld volumes/db/data
docker compose exec db ls /var/lib/postgresql/data | head
```

Why: [Backups](operating.md#backups), [Restoring](operating.md#restoring).

---

## A migration failed

**Confirm.**

```sh
docker compose logs --tail=100 app
```

The refusal names the file and the underlying cause: one line at the stem `Migrations failed`,
then an error naming the migration file that `failed and was rolled back`, with the Postgres error
beneath it as its `[cause]`.

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
- `docker compose restart gate` — a few seconds in which everything but `/healthz` answers `502`.
  Nobody is signed out: sessions are cookies in browsers, and the gate keeps nothing.
- Editing `allowed-emails.txt`. Adding a line admits that person; removing one signs them out
  everywhere.
- `docker compose down`, with or without `-v`. Stops and removes the containers;
  `./volumes/db/data` outlives both, and `-v` now discards only the volume record pointing at it.
- `docker compose up -d` — pulls the tag `APP_VERSION` points at and recreates. Note that Caddy's
  `/data` is a tmpfs, so a recreate discards any certificates it has issued. It needs to reach
  `ghcr.io`: with no network this fails rather than falling back to what is already here.
- Re-running migrations, by restarting `app`. They are idempotent.
- `curl -s localhost/healthz` — no credentials, no side effects.
- Reading anything in `pg_stat_activity`.

## Things that are not

- Deleting `./volumes/db/data` — **that is the database.** Every statement, every original CSV,
  every price. No confirmation, no undo, and it takes root, because Postgres owns the directory.
- `scripts/smoke-test.sh` — a CI tool. It empties `./volumes/db/data` at the start *and* from an
  exit trap. Never run it against a real instance.
- `dropdb`, in isolation. It is safe only as the first half of the restore procedure, with a
  verified dump in hand.
- Editing `schema_migrations` to make a symptom go away.
- Editing an already-applied migration file. Only filenames are recorded, so the change never runs.
- Publishing the `app`, `db` or `gate` port. Publishing `app` walks straight around the gate;
  publishing `gate` lets a LAN device assert its own forwarded headers to it. Both are sound only
  while nothing but `caddy` can reach them.
- Loosening the `forward_auth` block or the `trusted_proxies` line in the `Caddyfile` to make a
  symptom go away. That block is the gate.
- Rotating `GATE_COOKIE_SECRET` casually. It signs out the whole household with no warning.

---

For why any of this is the way it is — installing, security, monitoring, backups, restoring,
upgrading and growth, each as its own section — see [`operating.md`](operating.md).
