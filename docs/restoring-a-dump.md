# Restoring from a dump

How to get a household's data back out of one of the archives the `dump` service leaves in
`./volumes/dumps/`. This page is written for whoever self-hosts the instance, and it is the one
procedure: nothing here restates it, and nothing else here is the authority for it.

A **dump** is the archive on this host. A **backup** is a copy your own tool has taken off it
([`CONTEXT.md`](../CONTEXT.md)). This document restores from either, because they are the same file;
where it matters that the file has travelled, it says so.

Every command runs from the repository root, where `compose.yaml` is. Run them as root, or as the
account that owns `./volumes/dumps` — `DUMP_UID` decides what owns the directory, not who types.

Read [Before you start](#before-you-start) and [Every restore starts here](#every-restore-starts-here)
even if you are mid-incident. What follows those is ordered by which situation you are in:

- [The instance is running and you want to step it back](#restoring-in-place) — one outage.
- [The machine is gone and you are rebuilding it](#rebuilding-a-machine-from-nothing) — no outage to
  cause, but three things to put back that no archive carries.
- [Nothing is wrong and you want to prove it works](#the-drill-rehearse-without-an-outage) — no
  outage at all. Do this one quarterly.

Why the stack takes dumps but never backups is
[ADR-0009](adr/0009-the-stack-takes-dumps-not-backups.md). Every `DUMP_*` knob, the schedule
included, is documented beside its default in [`.env.example`](../.env.example); what a collector
has to carry off the host is [`operating.md`](operating.md#backups). What is *in* a dump, table by
table, with queries that read it, is [`data-model.md`](data-model.md). When something is broken and
you want the symptom, that is [`runbook.md`](runbook.md).

## Before you start

**What the dump service leaves on disk.** One run writes two files and rewrites up to three markers:

| File | What it is |
|---|---|
| `portfolio-<YYYYMMDDTHHMMSSZ>.dump` | the archive. `pg_dump` custom format, one database, one instant |
| `portfolio-<stamp>.dump.json` | that archive's `sha256`, byte count, compression, and the Postgres version that wrote it |
| `last-attempt.json` | rewritten first thing by every run: `started`, then `success` or `failure` |
| `last-success.json` | the last verified run — and the baseline the shrink guard compares against |
| `last-error.json` | the last failure, with the `stage` it failed at |

The stamp is UTC whatever `TZ` says. All of them land `0640` owned by `DUMP_UID:DUMP_GID`, in a
`0750` directory that is yours to create. Root reads them regardless; so does that account. **Any
third account gets a permission error on the first `cat`, not a missing file** — and
[When your shell cannot read the archive](#when-your-shell-cannot-read-the-archive) is the way
round it without widening the mode.

**`last-error.json` is never cleared by a later success.** Judge a run by `last-attempt.json`'s
`outcome`, not by whether an error file exists.

**Three things a dump does not carry**, all of which you need before the instance serves anyone:

- **`.env`** — gitignored and dockerignored, so a fresh clone has none. Without it `docker compose`
  refuses every command, `exec` included.
- **`allowed-emails.txt`** — gitignored too, and the stack will not start without the file at all.
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
want. Its `server_version` is the full version of the server that wrote it — `17.11`, not `17` —
and the major in front is the floor. Restoring into that major or a newer one is supported, into an
older one is not, so check what you are restoring *into* before you commit to an archive:

```sh
docker compose run --rm --no-deps --entrypoint postgres db --version
```

On a rebuild you have not created `./volumes/dumps` yet when you first read this, so run Step 1
after the copy in [Rebuilding a machine from nothing](#rebuilding-a-machine-from-nothing); the two
steps are the same either way, only their moment differs.

**An archive you are still deciding about can be pruned out from under you.** Retention deletes by
the stamp in the filename, not by mtime, so copying files around does not buy time. What is safe:

- the newest matching archive, whatever its age — retention never takes it;
- any name that is not exactly `portfolio-<YYYYMMDDTHHMMSSZ>.dump`. Your own
  `portfolio-2026-09-22.dump`, or the same file renamed `keep-…`, is invisible to it.

So if the one you want is neither the newest nor within `DUMP_KEEP_DAYS`, copy it somewhere else or
rename it before you do anything slow — and move the `.dump.json` with it under the matching name,
because retention deletes the sidecar with the archive, and the next step reads the hash out of it.
A sidecar left behind reads as a bad archive rather than as a missing file.

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
same code the nightly run uses before it publishes anything.

**`verify` prints nothing at all, whichever way it goes**, so read `$?` and not the screen: `0` is a
whole archive, `1` is a bad one, and the two look identical. The `Container portfolio-db-1 Healthy`
lines you do see are Compose narrating its own startup, not the check talking. A missing file is
also `1`, so if you get one, check the path before you conclude the archive is bad.

**A missing sidecar reads as a corrupt archive.** With no `.dump.json` beside it, the hash line
feeds `sha256sum -c -` nothing and it exits `1` saying `no properly formatted checksum lines
found`, which is the file's absence and not the archive's condition.

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
not choose — at `DUMP_AT`, at +15, +30 and +60 minutes after a failure that is not a space refusal,
and on container start if no run has succeeded in the last hour — and `pg_dump` holds a lock on
every table for its whole run. A run that lands in the middle of this either makes your `dropdb`
fail or writes an archive of a half-restored database, which then becomes the newest file in the
directory and the one a collector takes. Because the last line starts services by name, leaving
`dump` out of it leaves the dumper stopped indefinitely: `restart: on-failure` does not bring back
a container you stopped on purpose.

`docker compose stop dump` takes the full stop timeout and the container exits `137`. That is its
sleep being killed, not a fault.

**Stop `app` because it writes to the database you are replacing** — on every request and on the
price poller's own schedule, neither of which waits for you. `dropdb` refusing is not what enforces
that. It refuses only while a connection happens to be open, and the pool's idle connections time
out on roughly the same cadence as the healthcheck that reopens them, so whether you are refused is
a coin toss: run three times in a row against a healthy `app`, it refused, refused, then dropped the
live database out from under a running application. Treat a `dropdb` that goes through as proof of
nothing.

**Keep `--exit-on-error --single-transaction`.** Left to itself `pg_restore` continues past
failures and reports a count at the end — `errors ignored on restore: 2` and a half-old, half-new
schema. `--single-transaction` is the one doing the work, wrapping the restore so it either lands
whole or leaves the empty database alone; `--exit-on-error` is belt and braces beside it.

**`worker` may keep running.** It holds no database connection, is not even on the network `db` is
on, and nothing about a restore reaches it. There is no `stop worker` line to add.

**`caddy` stays up, answers `502` for the whole window, and goes `unhealthy` with it.** Its own
healthcheck proxies through to `app`, so a stopped `app` is one fault showing in two rows
([`runbook.md`](runbook.md#the-site-does-not-answer-at-all)). Both clear when you start `app` again.

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

**Prove the instance is serving the data, not merely running.** A restore that lands cleanly into
the wrong database, or an archive of a database that was already empty, reaches this point looking
exactly like a good one. Ask the application, then ask the data:

```sh
docker compose exec -T app node -e \
  "fetch('http://127.0.0.1:3000/healthz').then(async r=>console.log(r.status, await r.text()))"

docker compose exec -T db psql -U portfolio -d portfolio -c "
  select (select count(*) from person)           as people,
         (select count(*) from account)          as accounts,
         (select count(*) from holding)          as holdings,
         (select count(*) from position_set)     as position_sets,
         (select coalesce(sum(value),0)
            from holding_valued)                 as net_worth"
```

`/healthz` answering `200` with `"migrations":"current"` says the schema is whole and the app is
reading it; `"quotes":"not_attempted"` beside it is the price poller not having run yet, not a
restore problem. The counts are the part worth pausing on: compare them against what the household
should have, because nothing above this line would have told you they were zero.

Then prove a page is actually served, which no count does. Ask from inside the container, so the
answer does not depend on your proxy or your DNS being back:

```sh
docker compose exec -T app node -e \
  "fetch('http://127.0.0.1:3000/').then(r=>r.text()).then(t=>console.log(t.length, t.includes('A NAME YOU KNOW')))"
```

**Check the dumper caught up.** `cat volumes/dumps/last-attempt.json`; the freshness checks a
collector runs are [`operating.md`](operating.md#what-to-point-your-collector-at)'s. If you carried
the markers across, the one you are reading predates the restore and the *next* run is the first to
tell you anything; on a directory that had none, the dumper has already run and this marker is that
run.

**If you stepped back to a much smaller database, reset the shrink baseline.** The dumper refuses
any archive less than half the size of the last successful one at the same compression — a
truncation guard that a deliberate restore trips honestly. It fails at stage `shrink`, deletes the
archive it just staged, burns the whole retry ladder at +15, +30 and +60 minutes, and **the
healthcheck stays green throughout**, because a recent file still exists. The markers are the only
signal:

```sh
cat volumes/dumps/last-error.json
# {"failed_at":"…","stage":"shrink","message":"refusing: 846 bytes is less than half the last dump…"}

rm volumes/dumps/last-success.json      # the shrink baseline is the only thing read out of it
docker compose restart dump
```

Nothing else reads that marker, and every fact in it is also in the `.dump.json` beside each
archive, so removing it costs you no record.

Changing `DUMP_COMPRESS` resets the baseline too: a comparison across compression settings is
meaningless, so the guard stands down rather than refusing every run from then on. That one needs
`docker compose up -d dump`, not `restart` — `restart` resumes the container it already built and
reads none of `.env` or `compose.yaml`, which [`operating.md`](operating.md#upgrading) spells out
where it bites hardest.

---

## Rebuilding a machine from nothing

**If this machine ever ran an instance, clear the old volume record before anything else.**
`db-store` is a named volume bound to an absolute path, and the record outlives
`docker compose down`, so a second checkout does not get a cluster of its own. With the old checkout
deleted, `up` fails to mount and says which path it wanted. **With the old checkout still there,
`up` succeeds against it**: the new one comes up serving the old data, its own `volumes/db/data`
stays empty, and the restore you are about to run lands in the directory you were trying to leave.

```sh
docker volume ls | grep db-store        # nothing? skip to the next step

docker compose down -v                  # in the OLD checkout: drops the record, leaves the data
# or, if that directory is gone
docker volume rm portfolio_db-store     # the project is always `portfolio`, whatever you cloned into
```

**`-v` is safe here only because `db-store` is bound to a path in the checkout**, so the record goes
and the directory stays. An instance old enough to still keep its cluster in a Docker-managed
`portfolio_db-data` has no such protection and `-v` would destroy it; that case is
[`operating.md`](operating.md#moving-an-instance-that-predates-the-local-path)'s, and `docker volume
ls` above tells you which you have.

`down -v` discarding the record rather than the directory is
[`operating.md`](operating.md#where-the-database-lives). Moving a cluster you still have, rather
than restoring one, is [`operating.md`](operating.md#moving-an-instance-that-predates-the-local-path).

### Then put back everything the archive does not carry

Install Docker, clone this repository, and work from its root. Three things have to be in place
before a single `docker compose` command will run:

```sh
cp /path/to/your/kept/.env /path/to/your/kept/allowed-emails.txt .   # both at the repo root
chmod 0600 .env                         # POSTGRES_PASSWORD and the gate's secrets live in it

grep PUBLIC_ORIGIN .env                 # is this the hostname THIS machine will serve at?

mkdir -p ./volumes/db/data ./volumes/dumps
cp /path/to/your/archive/portfolio-20260922T021850Z.dump* ./volumes/dumps/

# after the copy, and read out of .env rather than typed, so it cannot disagree with it
chown -R "$(grep '^DUMP_UID=' .env | cut -d= -f2):$(grep '^DUMP_GID=' .env | cut -d= -f2)" ./volumes/dumps
chmod 0750 ./volumes/dumps
```

**Stop on that `grep` if the answer is no.** A different hostname orphans every enrolled passkey and
leaves the instance locked with none that work — read
[`runbook.md`](runbook.md#i-need-to-move-to-another-machine) before you go further, not after.
`./volumes/db/data` needs no ownership of its own; the database container sets it up.

**The trailing `*` on the copy is load-bearing**: the archive and its `.dump.json` travel together,
because [Step 2](#step-2-prove-the-archive-before-you-trust-it) reads the recorded hash out of the
sidecar and `verify` reads the archive at `/dumps/…`, which is this directory seen from inside the
container. An archive parked anywhere else on the host cannot be checked.

**The `.env` you carried already chose `DUMP_UID`; make the directory match it, not the reverse.**
`up` checks only that the pair is *set*, so a value the directory does not honour starts the
container and then kills it — `/dumps is not writable as 4242:4242` — with `restart: on-failure`
turning that into a crash loop whose `start_period` keeps `docker compose ps` looking plausible for
a quarter of an hour. The `chown` above reads the pair out of `.env` for exactly that reason.

Only if `.env` has no pair do you choose one, and then **`id -u` is not the answer when you are
root**: `0` is refused by design (`refusing to run as root`). Any non-root uid will do — `1001` is
as good as any — set in `.env` and owning the directory.

### Then the database on its own, and the restore into it

```sh
docker compose up -d --wait db          # --wait, or the next line races initdb

DUMP=volumes/dumps/portfolio-20260922T021850Z.dump     # your archive, not this stamp

sed -n 's/.*"sha256":"\([0-9a-f]*\)".*/\1/p' "$DUMP.json" | sed "s|\$|  $DUMP|" | sha256sum -c -
docker compose run --rm dump verify "/dumps/$(basename "$DUMP")"

docker compose exec -T db dropdb   -U portfolio portfolio
docker compose exec -T db createdb -U portfolio -O portfolio portfolio
docker compose exec -T db pg_restore --exit-on-error --single-transaction \
  -U portfolio -d portfolio < "$DUMP"

docker compose exec -T db psql -U portfolio -d portfolio \
  -c "select (select count(*) from person) as people, (select count(*) from account) as accounts"

docker compose up -d
docker compose ps
```

**`pg_restore` is silent on success too** — exit `0` and no output. The `psql` line is there because
this is the last moment backing out is free: if those counts are zero you restored an archive of an
empty database, and starting `app` on it only makes that harder to see.

Without `--wait`, `up -d db` returns as soon as the container starts while `initdb` is still
running, and the first `exec` answers
`connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed`.

This is [Restoring in place](#restoring-in-place) without the `stop` and `start` lines, written out
so you can run it rather than assemble it — there is nothing to stop, because nothing is up yet.

A plain `docker compose up -d` at the start would instead bring up `app`, which creates and migrates
an empty schema you are about to drop and holds a connection while you try to drop it. Bringing up
`db` alone avoids both, and leaves `dump` down until the data is in.

On a cluster this fresh, `initdb` has already made an empty `portfolio`, so the `dropdb` and
`createdb` pair is a no-op that costs nothing — running the one procedure is worth more than saving
two lines.

**`last-success.json` will not exist here**, so `cat`ting it in
[Step 1](#step-1-choose-the-archive) fails, and that is expected rather than a missing archive: the
marker stays on the machine that wrote it. Every field you would have read from it — `sha256`,
`bytes`, `compress`, `server_version` — is in the `.dump.json` beside the archive, which travelled.

The closing `docker compose up -d` starts the dumper, which dumps at once on a directory holding no
`last-attempt.json` — the usual case, when you carried one archive across. Carry the whole
`volumes/dumps/` directory instead and you carry both markers: `last-attempt.json`, which holds the
boot dump back for the rest of the hour it records, and `last-success.json`, which arms the shrink
guard against your first run. Neither is a fault; both are worth knowing before you conclude the
dumper is broken. See [After any restore](#after-any-restore).

> **That boot dump puts the archive you just carried here in reach of retention.** Being the newest
> matching archive is the only thing protecting it, and the boot dump takes that from it. The run
> after — tomorrow at `DUMP_AT`, or the next restart — prunes it along with its `.dump.json` if its
> stamp is older than `DUMP_KEEP_DAYS`. Measured: a fourteen-day-old archive beside a fresh one is
> gone in a single pass, sidecar and all. So unless your collector still holds a copy elsewhere,
> **rename it out of the pattern before that `up -d`**, which is what keeps it:
>
> ```sh
> cp volumes/dumps/portfolio-20260922T021850Z.dump ./restored-from.dump
> ```
>
> Any name that is not exactly `portfolio-<YYYYMMDDTHHMMSSZ>.dump` is invisible to retention
> ([Step 1](#step-1-choose-the-archive)).

---

## The drill: rehearse without an outage

**An archive nobody has ever restored is not yet evidence of anything.** Restore into a *separate*
database on the same server: nothing stops, nobody sees a `502`, and the live database is never
dropped.

```sh
DUMP=volumes/dumps/portfolio-20260922T021850Z.dump

docker compose exec -T db createdb -U portfolio -O portfolio portfolio_drill
docker compose exec -T db pg_restore --exit-on-error --single-transaction \
  -U portfolio -d portfolio_drill < "$DUMP"

docker compose exec -T db psql -U portfolio -d portfolio_drill \
  -c "select count(*) from holding"

docker compose exec -T db dropdb -U portfolio portfolio_drill
```

The count is the point, and it is not the truncation check repeated: a truncated archive never gets
this far, because `pg_restore` fails on it and `--single-transaction` lands nothing. What this
catches is an archive that decodes perfectly and carries almost nothing — one taken of a database
that was empty or half-restored when the dumper ran, which every check before this one passes.
Compare the count against the same query on `portfolio` and be suspicious of a large gap. For a
stronger comparison, run the same few aggregates on both — row counts per table and one money
total — rather than a single count.

`portfolio_drill` is never migrated and the app is never pointed at it. It exists for the length of
the drill and is dropped at the end — **do not leave it up**. It doubles the cluster on the disk the
dumper measures, and a dump that runs into the free-space floor refuses at stage `space`, which is
the one failure the retry ladder does not cover.

**Do this quarterly, and after any Postgres major upgrade.** The upgrade is the one that changes
what `pg_restore` is being asked to do rather than merely how long it takes.

---

## Now that it is restored

What each table means, and worked queries for reading a dump without the application in front of it,
is [`data-model.md`](data-model.md#8-extracting-from-a-dump). The instance itself is
[`operating.md`](operating.md). When the dumper stops writing, that is
[`runbook.md`](runbook.md#my-dumps-have-stopped).
