# 01 — The dump sidecar

_Part of [0014-scheduled-dump.md](../0014-scheduled-dump.md)._

**What to build:** A `dump` service in `compose.yaml` running `scripts/dump-loop.sh` in the
database's own image. Once a day it prunes, checks for room, dumps, proves the archive decodes end
to end, renames it into `./volumes/dumps/`, and writes the files that say what happened. It never
reaches off the host and holds no credential the stack does not already have.

Its own ticket because the diff is one container, one script and its proof; the documents that
describe it are [02](02-documents-and-vocabulary.md), which is prose across a long list of files and
is reviewed by reading rather than by running.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**The service**

- [ ] Shares the `db` image through a YAML anchor, so a Postgres major upgrade cannot bump one tag
      and leave the other dumping against a newer server — which `pg_dump` refuses with
      `aborting because of server version mismatch`, loudly but nightly, with nothing connecting it
      to a tag changed last month
- [ ] `depends_on: {db: {condition: service_healthy}}`, or a cold boot races `initdb`
- [ ] `cap_drop: ALL`, `no-new-privileges: true`, `read_only: true`, `tmpfs: /tmp`, no ports
- [ ] `TZ: UTC` pinned on the service rather than `${TZ:-UTC}` inherited, so `DUMP_AT` is UTC as
      documented; `db` pins it the same way and for the same kind of reason
- [ ] `user: "${DUMP_UID}:${DUMP_GID}"` — required, not defaulted. Nothing makes an absent bind
      source writable, so the directory is the operator's to create and the service runs as them
- [ ] Both binds use the long syntax with `create_host_path: false`, as the allowlist bind does, so
      a missing `./volumes/dumps` or missing script stops `up` with a message naming the path
- [ ] `./scripts/dump-loop.sh` bound read-only at `/usr/local/bin/dump-loop.sh`, invoked as
      `command: ["sh", "/usr/local/bin/dump-loop.sh"]` so a lost executable bit cannot break it
- [ ] `./volumes/dumps` bound at `/dumps`
- [ ] `environment:` carries `DATABASE_URL`, `APP_VERSION`, and the `DUMP_*` knobs; no new secret
- [ ] `restart: on-failure` — a validation failure or a crash restarts, a deliberate disable does not

**Knobs, documented in `.env.example` with the others**

- [ ] `DUMP_ENABLED` (`true`/`false`, default `true`), `DUMP_AT` (`00`–`23`, default `02`),
      `DUMP_KEEP_DAYS` (positive integer, default `7`), `DUMP_COMPRESS` (`0`–`9` or `none`, default
      `0`), `DUMP_UID` and `DUMP_GID` (required, no default)
- [ ] Validated at start against exactly those forms: unset takes the default, empty or malformed
      exits non-zero naming the variable. `DUMP_ENABLED=FALSE` is a bad value, not a disable
- [ ] `DUMP_ENABLED=false` exits 0 immediately, after one log line saying dumps are disabled
- [ ] A `DATABASE_URL` whose host is not the `db` service exits non-zero naming the reason: an
      external Postgres is out of scope for this service

**One run, in order**

- [ ] Delete any staging dotfile left by a crash — there is one writer, so any `.part` is stale
- [ ] Prune (below) **before** dumping, not after
- [ ] Refuse unless free space is at least twice the last successful dump plus 1 GiB; with no
      previous success recorded, require the 1 GiB floor alone and say in the log that it could not
      size itself. A refusal logs an error, writes the failure marker, deletes nothing further
- [ ] `pg_dump -d "$DATABASE_URL" --format=custom --compress="$DUMP_COMPRESS"` to
      `/dumps/.portfolio-<stamp>.dump.part` — never a tmpfs, because a cross-filesystem `mv` is a
      copy and a reader of the directory would see a partial file
- [ ] Verify with `pg_restore -f /dev/null` on the staged file, which decodes every data block;
      `pg_restore --list` passes a truncated archive and must not be the check
- [ ] Refuse a dump under half the size of the last successful one
- [ ] `mv` into place as `portfolio-<stamp>.dump`, `<stamp>` being `YYYYMMDDTHHMMSSZ`
- [ ] Write `portfolio-<stamp>.dump.json`: sha256, `APP_VERSION`, Postgres server version, byte
      count, duration, finish time. It and the success marker are written only by a verified run
- [ ] Files land `0640` and the service never chmods the directory it was given

**Scheduling and failure**

- [ ] Daily at `DUMP_AT`, in epoch arithmetic — busybox `date` has no relative-date parsing and this
      image has no `find -newermt`
- [ ] Every run rewrites an attempt marker before doing anything else, success or not, including a
      free-space refusal
- [ ] On start, dump immediately if the attempt marker is missing or more than an hour old
- [ ] A failure retries at +15, +30, +60 minutes, then waits for the next window — except a
      free-space refusal, which waits. The ladder is in-process and a restart resets it
- [ ] The failure marker records what failed and when, so the reason outlives the container
- [ ] Every log line carries one grep-able stem

**Retention**

- [ ] Deletes only names matching `portfolio-YYYYMMDDTHHMMSSZ.dump` exactly — anchored, so the
      operator's own `portfolio-2026-08-31.dump` is untouched — together with that file's `.json`
- [ ] Age comes from the name's stamp, not from mtime, so copying a directory does not reset it
- [ ] Never deletes the newest matching dump, whatever its age

**The healthcheck**

- [ ] Unhealthy when the newest dump is older than 24 hours plus a 6-hour grace; `start_period`
      long enough that a first run on an empty directory is not born unhealthy
- [ ] Nothing acts on it — it is for a human at `docker compose ps`

**Subcommands, for the test and nothing else**

- [ ] `dump-loop.sh verify <file>` and `dump-loop.sh prune <dir>` run the same code paths the loop
      uses. The default argument is the loop. No running deployment invokes them

**Proof, in `scripts/smoke-test.sh`**

- [ ] `DUMP_UID`/`DUMP_GID` set from the runner's own `id -u`/`id -g`, so CI reads and deletes what
      the container wrote without borrowing root
- [ ] Its cleanup, its log capture and its per-service enumerations (capabilities,
      `no-new-privileges`, uid, read-only root) all gain the new service
- [ ] The dumps directory is created before `up` and emptied at both ends of the run, so a second
      run cannot pass on yesterday's file
- [ ] A verified dump, its `.json` and the success marker appear within seconds of `up` on an empty
      directory — asserted on a **new** name, not on the presence of any
- [ ] `run --rm dump verify` on a deliberately truncated copy of that dump exits non-zero
- [ ] `run --rm dump prune` on a directory of pre-aged files keeps the newest, and leaves a file
      that does not match the pattern alone
- [ ] The new container holds only the privileges it claims
