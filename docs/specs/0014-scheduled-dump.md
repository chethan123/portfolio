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
- **A file-level copy is not a backup.** `docs/operating.md`, Backups — a copy of a *running*
  cluster is torn, whatever the tool. Something has to run `pg_dump`.
- **The operator already backs this host up** from another machine that mounts the path and holds
  the encryption, the history and the off-site copy. What is missing is a fresh, verified archive
  sitting where that machine can find it.

## Solution

A `dump` service in `compose.yaml`: a shell loop in the database's own image that, once a day,
takes a dump, proves it is readable end to end, and leaves it in `./volumes/dumps/` with files
describing the run. It never reaches off the host, and it holds no credential the stack does not
already have.

### The run

1. **Prune, then check for room, then dump.** Expired dumps go first, and the run is refused unless
   there is room for the dump *about to be written* — bounded from `pg_database_size()` rather than
   from the last archive, which says nothing about a database that has grown or a first run that has
   no predecessor. A refusal logs an error,
   writes the failure marker, deletes nothing further and lets the healthcheck lapse. The ordering
   is the point: the dumps share a filesystem with the live cluster, Postgres PANICs when it cannot
   write, and until it does `/healthz` goes on answering `200` — the probe is `select 1`, and
   `docs/operating.md`'s "What `/healthz` does not catch" says a full disk leaves that succeeding.
   The dumper must never be the thing that fills it.
2. **Dump** with `pg_dump -d "$DATABASE_URL" --format=custom --compress="$DUMP_COMPRESS"`, writing
   to a staging dotfile in the destination directory. Taking the whole connection from the URL the
   application already uses is what makes the dump be *of the database the app writes to*, rather
   than of whatever happens to answer on the compose network.
3. **Verify by decoding all of it**: `pg_restore -f /dev/null` on the staged file, which reads every
   data block and fails on a short read, then a comparison against the previous dump's size that
   refuses a large shrink — against a baseline recorded with the compression setting that produced
   it, since changing that setting legitimately changes the size by an order of magnitude. `pg_restore --list` is *not* enough — the archive's table of contents is
   written at the front, so a dump truncated at five percent lists every object and exits 0. That is
   the failure the restore drill's row count exists to catch, and it is why the operator-facing
   instruction to check a dump with `--list` changes too (ticket 02).
4. **Rename into place** — a real rename within one filesystem, so a reader of the directory can
   never see a partial or unverified file — as `portfolio-YYYYMMDDTHHMMSSZ.dump`. The name is the
   producer's clock written down, which makes the directory readable to a human and orders it
   without a collector having to `stat` anything; it is not a cursor. A collector takes **what it
   has not already taken**, by name, because a host clock corrected backwards produces a genuine
   dump whose name sorts before one already collected.
5. **Describe it**: a sidecar JSON beside the dump (sha256, `APP_VERSION`, Postgres server version,
   byte count, duration, finish time) and a rewritten success marker. Only a fully verified run
   writes either.

### Scheduling and failure

Daily at `DUMP_AT` (UTC), computed in epoch arithmetic — busybox `date` has no relative-date
parsing and this image has no `find -newermt`. On start the loop dumps immediately only if the last
**attempt** is more than an hour old; `app/lib/price-poller.server.ts:134-136` records the same
reasoning for the price poller, where an immediate poll on boot was deliberately not done because a
crash-looping container would fetch on every one.

A failed run retries at +15, +30 and +60 minutes and then waits for the next window — except a
free-space refusal, which never retries, because the one thing that cannot help is attempting the
same large write twice more. The ladder lives in the process: a restart resets it, and the boot rule
above is what covers that case.

There is no on-demand trigger, and the service exposes no subcommand a running deployment invokes.
The human on-demand path is the existing `docker compose exec db pg_dump …` recipe, which is what a
pre-upgrade dump uses. A trigger the operator's collector could pull is a later ticket if the day's
staleness ever matters; the seam it would use — a directory and a marker file — is unchanged by
adding one.

### Retention

Files older than `DUMP_KEEP_DAYS` are deleted, but only those matching the sidecar's own anchored
name pattern, and never the newest one whatever its age. The pattern restriction is what lets a
hand-taken dump sit in the same directory and survive; `portfolio-2026-08-31.dump` from the
operator's own recipe does not match `portfolio-YYYYMMDDTHHMMSSZ.dump`.

**The local window is a hand-off, not the history.** Stepping back in time is the collecting tool's
job, and `docs/operating.md` must say so where it states the retention this design assumes on the
other side.

### Ownership, and why the service does not run as uid 70

A missing bind source is created root-owned whatever uid the container runs as, so no choice of uid
makes an absent directory writable. What makes this work is the operator creating it — and then the
service must run as *them*, because the whole point of the directory is that something outside the
stack reads it. So: `create_host_path: false` on the mount, the way the allowlist bind already does
it, so a missing directory stops `up` with a message naming it rather than producing a root-owned
junk dir and a crash-looping container; and `DUMP_UID`/`DUMP_GID` required rather than defaulted,
validated at start like every other input.

That deliberately shares a uid with the operator's account. `compose.yaml`'s caddy comment warns
that "shared uids share bind-mount rights" — true, and the reasoning does not carry here: this
service's whole contract is to hand files to that account.

### Signals

- A healthcheck on the age of the newest dump, for a human at `docker compose ps`. Nothing acts on
  it: Docker restart policies react to a process exiting, not to health.
- The success and failure markers on the mount, which are the signal that actually reaches the
  collector, and the reason a failure's cause survives the container.
- `DUMP_ENABLED=false` exits the container 0. Note what that does and does not buy: a disabled
  dumper is *absent* from `docker compose ps`, and shows as `Exited (0)` only under `ps -a` — so the
  operator-facing verification recipe has to name `-a`, or turning dumps off looks identical to
  never having had them.
- Every knob is validated at start; a bad value exits non-zero, which crash-loops loudly rather than
  scheduling something that never fires. `.env.example` promises exactly this of the app's own
  variables and these must not be the exception.

### Posture

`cap_drop: ALL`, `no-new-privileges`, `read_only: true` with a small tmpfs for `/tmp`, no published
port, and `TZ: UTC` pinned rather than inherited from the operator's `TZ`, so `DUMP_AT` means what
it says. The same rules every other service here obeys, asserted the same way in the smoke test.

## Out of Scope

Copying anything off the host. Encrypting anything. Keeping history beyond the local window.
Restoring anything. Rehearsing a restore — that stays the human drill in `docs/operating.md`, which
gains a stated cadence (quarterly, and after any Postgres major upgrade) rather than being advice.

An instance whose `DATABASE_URL` points at an external Postgres, which `docs/operating.md` supports
by telling the operator to delete the `db` service. This service goes with it — its `depends_on`
would otherwise name a service that is no longer there, and Compose rejects that before any script
of ours can refuse anything. The existing sentence that backups are then that server's problem
stands, and ticket 02 adds the deletion to that section.

## Testing

The proof is in `scripts/smoke-test.sh` and nowhere else, which is a deliberate exception to this
repository's testing discipline and the reason to say so here. The suite runs vitest against a real
Postgres; this ships a shell script that runs under busybox `ash` inside a container as a specific
uid against a live database, and every property worth asserting — that a verified dump lands, that a
truncated one is refused, that retention keeps the newest, that the container holds only the
privileges it claims — is a property of that arrangement rather than of a function. A host-side
vitest test would exercise a different shell, a different uid and a different filesystem, and would
prove none of them.

What makes that testable rather than aspirational is that the script is the service's *entrypoint*
and takes a subcommand: `loop` is the configured command, and `verify <file>` and `prune <dir>` are
the same code paths the loop uses. A one-off `docker compose run` replaces the command rather than
appending to it, which is exactly why the script must be the entrypoint — otherwise the image would
try to execute `verify` itself. No running deployment invokes them.

## Tickets

- [`dump/01-the-dump-sidecar.md`](dump/01-the-dump-sidecar.md) — the service, the script, the knobs,
  the smoke-test proof.
- [`dump/02-documents-and-vocabulary.md`](dump/02-documents-and-vocabulary.md) — every document
  brought level with what exists, and the dump/backup vocabulary split in `CONTEXT.md` with the
  rename pass it forces.
