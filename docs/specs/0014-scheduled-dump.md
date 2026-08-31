# Scheduled dump — a verified archive on the host, for the operator's backup tool

> Triage label to apply when this is filed: `ready-for-agent`
>
> Covers [ADR-0009](../adr/0009-the-stack-takes-dumps-not-backups.md), which decides the shape and
> reverses two recorded decisions: that backups are not built in, and that there is no separate
> worker service. Read it first — this spec builds what that ADR argues for and does not restate
> the argument.

## Problem Statement

Nothing in this deployment produces a dump unless a person types the command in
[`docs/operating.md`](../operating.md)'s Backups section. That section is careful and correct, and
it is a procedure someone has to remember on a day nothing reminds them.

The recovery goal, stated: survive losing the machine, and be able to step back to a state from
some days ago after a change nobody noticed at the time. A remembered command meets neither.

Three facts about this deployment make the gap narrow and worth closing precisely:

- **There is one data target.** `./volumes/db/data` is every byte of persistent state
  (`ARCHITECTURE.md` §3). Uploaded CSVs are in Postgres rather than on disk specifically to keep it
  that way (DESIGN.md §5.2), and `app`, `gate` and `caddy` are `read_only: true` with nothing but
  tmpfs over what they write.
- **A file-level copy is not a backup.** `docs/operating.md:793` — a copy of a *running* cluster is
  torn, whatever the tool. Something has to run `pg_dump`.
- **The operator already backs this host up** from another machine that mounts the path and holds
  the encryption, the history and the off-site copy. What is missing is a fresh, verified archive
  sitting where that machine can find it.

## Solution

A `dump` service in `compose.yaml`: a shell loop in the database's own image that, once a day,
takes a dump, proves it is readable end to end, and leaves it in `./volumes/dumps/` with a marker
file describing the run. It never reaches off the host.

### The run

1. **Prune, then check for room, then dump.** Expired dumps go first, and the run is refused unless
   free space is at least twice the last successful dump plus a floor. A refusal logs an error,
   writes `last-error.json`, leaves every existing dump alone and lets the healthcheck lapse. This
   ordering is the point: the dumps share a filesystem with the live cluster, Postgres PANICs when
   it cannot write, and `/healthz` stays `200` through a full disk (`docs/operating.md:686`) — so
   the dumper must never be the thing that fills it.
2. **Dump** with `pg_dump -h db --format=custom --compress=0`, connecting with the same credentials
   the application uses, writing to a dotfile in the destination directory.
3. **Verify by decoding all of it**: `pg_restore -f /dev/null` on the staged file, which reads every
   data block and fails on a short read, then a comparison against the previous dump's size that
   refuses a large shrink. `pg_restore --list` is *not* enough — the archive's table of contents is
   written at the front, so a dump truncated at five percent lists every object and passes. This is
   the same failure `docs/operating.md:914`'s row count exists to catch in the restore drill.
4. **Rename into place** — a real rename within one filesystem, so a collector reading the directory
   can never see a partial or unverified file — as `portfolio-YYYYMMDDTHHMMSSZ.dump`, whose lexical
   order is its chronological order.
5. **Describe it**: `<dump>.json` beside it (sha256, `APP_VERSION`, Postgres server version, byte
   count, duration, finish time) and a rewritten `last-success.json`. Only a fully verified run
   writes either.

### Scheduling

Daily at `DUMP_AT` (UTC), computed in epoch arithmetic — busybox `date` has no relative-date
parsing and `find -newermt` does not exist in this image. On start, the loop dumps immediately only
if the last **attempt** is more than an hour old, which is what stops a crash-looping container
dumping on every boot; `app/lib/price-poller.server.ts:133` records the same reasoning for the
price poller, where an immediate poll on boot was deliberately not done.

There is no on-demand trigger. The human on-demand path is the existing
`docker compose exec db pg_dump …` recipe, which is what a pre-upgrade dump uses and stays
documented. A trigger the operator's collector could pull is a later ticket if the day's staleness
ever matters; the seam it would use — a directory and a marker file — is unchanged by adding one.

### Retention

Files older than `DUMP_KEEP_DAYS` are deleted, but only files matching the sidecar's own name
pattern, and never the newest whatever its age. The pattern restriction matters because
`./volumes/dumps/` is exactly where an operator will park the hand-taken dump that
[`docs/runbook.md`](../runbook.md)'s Postgres upgrade tells them to make.

**The local window is a hand-off, not the history.** Stepping back in time is the operator's
collector's job, and `docs/operating.md` must say so where it states the retention this design
assumes on the other side.

### Ownership, and why it is not uid 70

The `db-store` trick does not transfer. A volume takes the *image's* ownership of the directory at
the mount point (`ARCHITECTURE.md` §3, `compose.yaml`'s transcript), and no image path exists for
dumps — a fresh bind source arrives root-owned and a pinned uid cannot write it. The service
therefore runs as `${DUMP_UID:-1000}:${DUMP_GID:-1000}`, the operator's own account: `mkdir -p
./volumes/dumps` stays the whole setup and still wants no root, the files are readable to whatever
reads them over a mount, and CI can delete them without borrowing root from the daemon the way
`scripts/smoke-test.sh` does for the cluster directory.

### Signals

- A healthcheck on the age of the newest dump, for a human at `docker compose ps`. Nothing acts on
  it: Docker restart policies react to a process exiting, not to health.
- `last-success.json` and `last-error.json` on the mount, which is the signal that actually reaches
  the operator's collector — and the reason the failure survives the container, which
  `pull_policy: always` recreates on every upgrade.
- `DUMP_ENABLED=false` exits the container 0 under `restart: on-failure`, so a disabled dumper reads
  `Exited (0)` rather than sitting green among four healthy rows.
- Every knob is validated at start; a bad value exits non-zero, which crash-loops loudly rather than
  scheduling something that never fires. `.env.example` promises exactly this of the app's own
  variables and these must not be the exception.

## What this does not do

Copy anything off the host. Encrypt anything. Keep history beyond the local window. Restore
anything. Rehearse a restore — that stays the human drill in `docs/operating.md`, which gains a
stated cadence (quarterly, and after any Postgres major upgrade) rather than being advice.

## Tickets

- [`dump/01-the-dump-sidecar.md`](dump/01-the-dump-sidecar.md) — the service, the script, the knobs,
  the smoke-test proof.
- [`dump/02-documents-and-vocabulary.md`](dump/02-documents-and-vocabulary.md) — every document
  brought level with what exists, and the dump/backup vocabulary split in `CONTEXT.md` with the
  rename pass it forces.
