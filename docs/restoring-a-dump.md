# Restoring from a dump

How to get a household's data back out of one of the archives the `dump` service leaves in
`./volumes/dumps/`. This page is written for whoever self-hosts the instance, and it is the
procedure — every command below was run end to end against a real stack before it was written down.

A **dump** is the archive on this host. A **backup** is a copy your own tool has taken off it
([`CONTEXT.md`](../CONTEXT.md)). This document restores from either, because they are the same file;
where it matters that the file has travelled, it says so.

Read [Before you start](#before-you-start) and [Every restore starts here](#every-restore-starts-here)
even if you are mid-incident. What follows those is ordered by which situation you are in:

- [The instance is running and you want to step it back](#restoring-in-place) — one outage.
- [The machine is gone and you are rebuilding it](#rebuilding-a-machine-from-nothing) — no outage to
  cause, but two files that are not in the dump.
- [Nothing is wrong and you want to prove it works](#the-drill-rehearse-without-an-outage) — no
  outage at all. Do this one quarterly.

Why the stack takes dumps but never backups is
[ADR-0009](adr/0009-the-stack-takes-dumps-not-backups.md). What the schedule, the retention window
and the knobs are is [`operating.md`](operating.md#backups). What is *in* a dump, table by table,
with queries that read it, is [`data-model.md`](data-model.md). When something is broken and you
want the symptom, that is [`runbook.md`](runbook.md).

## Before you start

**What the dump service leaves on disk.** One run writes two files and rewrites up to three markers:

| File | What it is |
|---|---|
| `portfolio-<YYYYMMDDTHHMMSSZ>.dump` | the archive. `pg_dump` custom format, one database, one instant |
| `portfolio-<stamp>.dump.json` | that archive's `sha256`, byte count, compression, and the Postgres version that wrote it |
| `last-attempt.json` | rewritten first thing by every run: `started`, then `success` or `failure` |
| `last-success.json` | the last verified run — and the baseline the shrink guard compares against |
| `last-error.json` | the last failure, with the `stage` it failed at |

The stamp is UTC whatever `TZ` says. Files land `0640` owned by `DUMP_UID:DUMP_GID`, in a directory
that is yours to create — so a shell running as anyone else cannot read them, which
[When your shell cannot read the archive](#when-your-shell-cannot-read-the-archive) works around.

**`last-error.json` is never cleared by a later success.** Judge a run by `last-attempt.json`'s
`outcome`, not by whether an error file exists.

**Three things a dump does not carry**, all of which you need before the instance serves anyone:

- **`.env`** — gitignored and dockerignored, so a fresh clone has none. Without it `docker compose`
  refuses every command, `exec` included.
- **`allowed-emails.txt`** — likewise, and the stack will not start without the file at all.
- **The hostname.** The lock derives its relying-party id from `PUBLIC_ORIGIN`'s hostname
  ([ADR-0012](adr/0012-a-browser-past-the-gate-is-shown-nothing.md)). Restoring this data
  behind a *different* hostname leaves every enrolled passkey orphaned and the instance locked with
  none that work. [`runbook.md`](runbook.md#i-need-to-move-to-another-machine) has what to do about
  that; do it as part of the move, not afterwards.

What each of those costs to recover is
[`operating.md`](operating.md#the-second-thing-to-keep-is-env-and-the-third-is-the-allowlist).

---

## Every restore starts here

Both steps run whichever of the three situations you are in.

### Step 1: choose the archive

```sh
ls -l volumes/dumps/portfolio-*.dump
cat volumes/dumps/last-success.json
```

`last-success.json` names the newest archive a run actually verified, which is usually the one you
want. Its `server_version` is the Postgres major that wrote it: restoring into that major or a newer
one is supported, into an older one is not.

**An archive you are still deciding about can be pruned out from under you.** Retention deletes by
the stamp in the filename, not by mtime, so copying files around does not buy time. What is safe:

- the newest matching archive, whatever its age — retention never takes it;
- any name that is not exactly `portfolio-<YYYYMMDDTHHMMSSZ>.dump`. Your own
  `portfolio-2026-09-22.dump`, or the same file renamed `keep-…`, is invisible to it.

So if the one you want is neither the newest nor within `DUMP_KEEP_DAYS`, copy it somewhere else or
rename it before you do anything slow. Deleting an archive also deletes its `.dump.json`, and
without that sidecar you have no recorded hash to check the file against.

### Step 2: prove the archive before you trust it

Two checks, and they catch different things. Run both.

```sh
DUMP=volumes/dumps/portfolio-20260922T021850Z.dump     # the file you are restoring

sed -n 's/.*"sha256":"\([0-9a-f]*\)".*/\1/p' "$DUMP.json" | sed "s|\$|  $DUMP|" | sha256sum -c -
docker compose run --rm dump verify "/dumps/$(basename "$DUMP")"
```

The first says the bytes are the bytes the dump service wrote — the check that matters for a file
that has been off this machine and come back. The second decodes every data block in the archive
without restoring it anywhere, which is the check that matters for a file that never left: it is the
same code the nightly run uses before it publishes anything. Both exit non-zero on failure.

**Do not substitute `pg_restore --list`.** It reads only the table of contents at the front of the
archive. An archive truncated to half its length, or to nine tenths, lists everything and exits `0`;
the decode above catches both. `--list` only fails when the truncation is early enough to cut the
table of contents itself.

`verify` is the `dump` service's own subcommand, so it needs no Postgres client on the host and is
always the same version as the server. `docker compose run` starts `db` first because the service
declares it; pass `--no-deps` if you would rather it did not.

---

## Restoring in place

One outage, on a machine that is otherwise working. Restore into an **empty** database rather than
over a live one, so a partial restore cannot leave a half-old, half-new schema behind.

```sh
DUMP=volumes/dumps/portfolio-20260922T021850Z.dump

docker compose stop app dump

docker compose exec -T db dropdb   -U portfolio portfolio
docker compose exec -T db createdb -U portfolio -O portfolio portfolio
docker compose exec -T db pg_restore --exit-on-error --single-transaction \
  -U portfolio -d portfolio < "$DUMP"

docker compose start app dump
```

**Stop `dump` as well as `app`, and start it again by name.** The dumper connects at times you do
not choose — once on container start, once at `DUMP_AT`, and at +15, +30 and +60 minutes after any
failure — and `pg_dump` holds a lock on every table for its whole run. A run that lands in the
middle of this either makes your `dropdb` fail or writes an archive of a half-restored database,
which then becomes the newest file in the directory and the one a collector takes. Because the
last line starts services by name, leaving `dump` out of it leaves the dumper stopped
indefinitely: `restart: on-failure` does not bring back a container you stopped on purpose.

`docker compose stop dump` takes the full stop timeout and the container exits `137`. That is its
sleep being killed, not a fault.

**Stop `app` because it writes to the database you are replacing** — on every request and on the
price poller's own schedule, neither of which waits for you. `dropdb` refusing is not what enforces
that. It refuses only while a connection happens to be open, and the app holds a single pooled one
that it drops and reopens around its own healthcheck: run against a healthy `app` three times in a
row, it refused twice and succeeded once, dropping the live database out from under a running
application. Treat a `dropdb` that goes through as proof of nothing.

**Keep `--exit-on-error --single-transaction`.** Left to itself `pg_restore` continues past
failures and reports a count at the end, which is exactly the half-old, half-new schema this is
avoiding. With both, the restore is one transaction that either lands whole or leaves the empty
database alone.

**`worker` may keep running.** It holds no database connection, is not even on the network `db` is
on, and nothing about a restore reaches it. There is no `stop worker` line to add.

**`caddy` stays up and answers `502` for the whole window.** That is the restore working, not a
second fault.

**`docker compose stop` survives a reboot.** `stop` records that you wanted it stopped, and neither
restart policy in this stack overrides that — not `app`'s `unless-stopped`, not `dump`'s
`on-failure` — across a daemon restart or a host reboot. A restore you walked away from
half-finished stays half-finished: the site keeps answering `502`, nothing has been dumped since,
and only `docker compose start app dump` ends it.

### When your shell cannot read the archive

The archives are `0640` owned by `DUMP_UID`, so `< "$DUMP"` fails with a permission error for
anyone else. Rather than widen the mode, restore through the `dump` service, which already has the
directory mounted at `/dumps`, already runs as that account, carries `DATABASE_URL` and
`PGPASSWORD`, and runs the same image as `db`:

```sh
docker compose run --rm -T --entrypoint sh dump -c \
  'pg_restore --exit-on-error --single-transaction -d "$DATABASE_URL" /dumps/portfolio-20260922T021850Z.dump'
```

This is also the form to reach for when the archive is large: it reads the file straight off the
mount instead of streaming it through `docker compose exec`. It connects over TCP with `PGPASSWORD`
rather than over `db`'s local trust socket, so `POSTGRES_PASSWORD` in `.env` has to be the password
the `portfolio` role actually holds. The `dropdb` and `createdb` either side stay as they are above.

### A compressed archive needs no extra step

An archive taken with `DUMP_COMPRESS` between `1` and `9` is still a custom-format archive, not a
gzipped one, and the sidecar records which setting wrote it. The same `pg_restore` line reads it.
There is nothing to decompress first, and `verify` works on it unchanged. The only thing the setting
changes on the way back in is how long the read takes.

---

## After any restore

**Migrations the dump predates are applied on start.** `app` runs them before it serves, so an
archive from an older release restores into the current one with no manual step. The migration
ledger travels inside the dump, so an archive that is already current applies nothing — the log says
`skip … (already applied)` for every file, and `/healthz` reports `migrations: current`.

**Check the dumper caught up.** The same check its healthcheck runs, which is the age of the newest
archive and nothing else:

```sh
docker compose exec dump sh /usr/local/bin/dump-loop.sh healthcheck
cat volumes/dumps/last-attempt.json
```

**If you stepped back to a much smaller database, reset the shrink baseline.** The dumper refuses
any archive less than half the size of the last successful one at the same compression — a
truncation guard that a deliberate restore trips honestly. It fails at stage `shrink`, deletes the
archive it just staged, burns the whole retry ladder at +15, +30 and +60 minutes, and **the
healthcheck stays green throughout**, because a recent file still exists. The markers are the only
signal:

```sh
cat volumes/dumps/last-error.json
# {"failed_at":"…","stage":"shrink","message":"refusing: 846 bytes is less than half the last dump…"}

rm volumes/dumps/last-success.json      # the baseline, and nothing else, lives in this file
docker compose restart dump
```

Changing `DUMP_COMPRESS` resets the baseline too, for the same reason: a comparison across
compression settings is meaningless, so the guard stands down rather than refusing every run from
then on.

---

## Rebuilding a machine from nothing

Install Docker and clone this repository. Then, before anything else, put back the two files the
dump does not carry and make the directories Compose refuses to create for you:

```sh
cp /path/to/your/kept/.env /path/to/your/kept/allowed-emails.txt .
mkdir -p ./volumes/db/data ./volumes/dumps
chown "$(id -u):$(id -g)" ./volumes/dumps && chmod 0750 ./volumes/dumps
```

`DUMP_UID` and `DUMP_GID` in `.env` have to be that account, or `up` refuses. Then bring up the
database **on its own**, and restore into it:

```sh
docker compose up -d db
# Step 2, then the restore in Restoring in place, minus the stop and start lines
docker compose up -d
```

A plain `docker compose up -d` first would start `app`, which creates and migrates an empty schema
you are about to drop and holds a connection while you try to drop it. Bringing up `db` alone avoids
both. It also leaves `dump` down, which is what you want until the data is in.

On a cluster this fresh, `initdb` has already made an empty `portfolio`, so the `dropdb` and
`createdb` pair is a no-op that costs nothing — running the one procedure is worth more than saving
two lines.

The closing `docker compose up -d` starts the dumper, which takes its first dump within seconds. If
you copied the whole `volumes/dumps/` directory across rather than one archive, that includes
`last-success.json`, and the shrink guard applies to the first run — see
[After any restore](#after-any-restore).

**Restoring into a different directory on the same machine is a different job.** The `db-store`
volume record outlives `docker compose down` and still points at the old checkout, so `up` fails to
mount before it starts anything. `docker compose down -v` in the old directory first, which discards
the record and leaves the data standing, or `docker volume rm portfolio_db-store`. Moving a cluster
rather than restoring one is
[`operating.md`](operating.md#moving-an-instance-that-predates-the-local-path).

---

## The drill: rehearse without an outage

**An archive you have never restored is not a backup.** Restore into a *separate* database on the
same server: nothing stops, nobody sees a `502`, and the live database is never dropped.

```sh
DUMP=volumes/dumps/portfolio-20260922T021850Z.dump

docker compose exec -T db createdb -U portfolio -O portfolio portfolio_drill
docker compose exec -T db pg_restore --exit-on-error --single-transaction \
  -U portfolio -d portfolio_drill < "$DUMP"

docker compose exec -T db psql -U portfolio -d portfolio_drill \
  -c "select count(*) from holding"

docker compose exec -T db dropdb -U portfolio portfolio_drill
```

The count is the point, and truncation is the failure it exists for: an archive that restores
cleanly into an *empty* schema and then produces no rows will not be noticed any other way.
Compare it against the same query on `portfolio` and be suspicious of a large gap. For a stronger
comparison, run the same few aggregates on both — row counts per table and one money total —
rather than a single count.

`portfolio_drill` is never migrated and the app is never pointed at it. It exists for the length of
the drill and is dropped at the end.

**Do this quarterly, and after any Postgres major upgrade.** The upgrade is the one that changes
what `pg_restore` is being asked to do rather than merely how long it takes.

---

## Now that it is restored

What each table means, and worked queries for reading a dump without the application in front of it,
is [`data-model.md`](data-model.md#8-extracting-from-a-dump). The instance itself is
[`operating.md`](operating.md). When the dumper stops writing, that is
[`runbook.md`](runbook.md#my-dumps-have-stopped).
