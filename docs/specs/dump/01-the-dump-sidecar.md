# 01 — The dump sidecar

_Part of [0014-scheduled-dump.md](../0014-scheduled-dump.md)._

**What to build:** A `dump` service in `compose.yaml` running a shell script from the checkout —
`scripts/dump-loop.sh` — in the database's own image. Once a day it prunes, checks for room, dumps,
proves the archive decodes end to end, renames it into `./volumes/dumps/`, and writes the files that
say what happened. It never reaches off the host and it holds no credential the stack does not
already have.

Doing it as its own ticket keeps the diff to one container, one script and its proof: the documents
that describe it are [02](02-documents-and-vocabulary.md), and they are prose across nine files,
which is a different kind of review.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**The service**

- [ ] `compose.yaml` gains `dump`, sharing the `db` image through a YAML anchor so a Postgres major
      upgrade cannot bump one and leave the other dumping against a newer server — which `pg_dump`
      refuses, nightly, silently, forever
- [ ] `depends_on: {db: {condition: service_healthy}}`, or a cold boot races `initdb`
- [ ] `cap_drop: ALL`, `no-new-privileges: true`, `read_only: true`, a small `tmpfs` for `/tmp`
- [ ] `TZ: UTC` pinned on the service rather than inherited, so `DUMP_AT` means what it says
- [ ] `user: "${DUMP_UID:-1000}:${DUMP_GID:-1000}"` — not 70:70; the `db-store` ownership trick does
      not transfer to a mount point the image does not have
- [ ] `restart: on-failure`, not `unless-stopped`, so a disabled dumper reads `Exited (0)`
- [ ] `./volumes/dumps` bound in; `mkdir -p` remains the whole setup and still wants no root
- [ ] No published port, no egress, no new secret: the connection comes from the same
      `DATABASE_URL` the application uses

**Knobs, in `.env.example` with the others**

- [ ] `DUMP_ENABLED` (default true), `DUMP_AT` (hour, UTC, default 02), `DUMP_KEEP_DAYS` (7),
      `DUMP_COMPRESS` (0), `DUMP_UID` / `DUMP_GID`
- [ ] Every one validated at start; a bad value exits non-zero rather than scheduling a run that
      never fires. `DUMP_KEEP_DAYS=` empty must not become a delete rule with a hole in it
- [ ] `DUMP_ENABLED=false` exits 0 immediately with one line saying dumps are disabled

**One run, in order**

- [ ] Sweep stale staging dotfiles left by a crash
- [ ] Delete expired dumps **before** dumping, not after
- [ ] Refuse to dump unless free space is at least twice the last successful dump plus a floor; on
      refusal log an error, write `last-error.json`, delete nothing, and let the healthcheck lapse
- [ ] `pg_dump -h db --format=custom --compress=${DUMP_COMPRESS}` to a dotfile **inside**
      `./volumes/dumps/` — never a tmpfs, because a cross-filesystem `mv` is a copy and a reader of
      the directory would see a partial file
- [ ] Verify with `pg_restore -f /dev/null` on the staged file, which decodes every data block;
      `pg_restore --list` passes a truncated archive and must not be the check
- [ ] Refuse a dump substantially smaller than the last successful one
- [ ] Rename into place as `portfolio-YYYYMMDDTHHMMSSZ.dump` — lexical order is chronological order,
      so a collector can ask "anything newer than the file I took?" without trusting a clock
- [ ] Write `<dump>.json`: sha256, `APP_VERSION`, Postgres server version, byte count, duration,
      finish time
- [ ] Rewrite `last-success.json` only on a fully verified run
- [ ] Files `0640`, directory `0750`

**Scheduling and failure**

- [ ] Daily at `DUMP_AT`, computed in epoch arithmetic — busybox `date` has no relative-date parsing
      and this image has no `find -newermt`
- [ ] On start, dump immediately only if the last **attempt** is more than an hour old; every
      attempt is recorded, not only successes
- [ ] A failed run retries at +15, +30 and +60 minutes, then waits for the next window — except a
      free-space refusal, which never retries
- [ ] Retention deletes only files matching the sidecar's own name pattern, and never the newest one
      whatever its age

**The healthcheck**

- [ ] Unhealthy when the newest dump is older than the interval plus a grace period. A disabled
      dumper has no health state at all — it exited — which is the point of exiting rather than
      idling green
- [ ] The script's own log lines carry a stem worth grepping for

**Proof, in `scripts/smoke-test.sh`**

- [ ] Its cleanup and its per-service enumerations (capabilities, `no-new-privileges`, uid,
      read-only root, the log dump on failure) all gain the new service
- [ ] The dumps directory is emptied at both ends of the run, like the cluster directory, so a
      second run cannot pass on yesterday's file
- [ ] A verified dump, its `.json` and `last-success.json` appear within seconds of `up` on an empty
      directory — assert on a **new** filename, not on the presence of any
- [ ] A deliberately truncated archive is rejected: the marker is not rewritten and the bad file
      does not land in the directory
- [ ] Retention keeps the newest dump when every file is older than the window, and leaves a file
      that does not match the name pattern alone
- [ ] The new container holds only the privileges it claims
