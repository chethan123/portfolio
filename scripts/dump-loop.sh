#!/bin/sh
#
# The dump service's whole program — spec docs/specs/dump/01-the-dump-sidecar.md,
# decided in docs/adr/0009-the-stack-takes-dumps-not-backups.md.
#
# Once a day it prunes, checks there is room, dumps the database, proves the
# archive decodes end to end, and renames it into the directory the operator's
# backup tool collects from. It never reaches off this host.
#
# Runs under busybox ash in postgres:17-alpine, which is why the arithmetic is
# all epoch seconds: `date -d yesterday` is not parsed there and `find
# -newermt` does not exist. POSIX sh only — no bashisms.
#
#   dump-loop.sh [loop]            the service's command
#   dump-loop.sh verify <file>     decode an archive whole; the smoke test's
#   dump-loop.sh prune <dir>       apply retention; the smoke test's
#   dump-loop.sh healthcheck       the container's healthcheck
set -eu

# 0640 files in a 0750 directory: the dumps are every balance, every statement
# and every original uploaded CSV in plaintext, and they are readable to the
# account that owns the directory because that is what collects them.
umask 027

DUMP_DIR="${DUMP_DIR:-/dumps}"
DUMP_ENABLED="${DUMP_ENABLED:-true}"
DUMP_AT="${DUMP_AT:-02}"
DUMP_KEEP_DAYS="${DUMP_KEEP_DAYS:-7}"
DUMP_COMPRESS="${DUMP_COMPRESS:-0}"
APP_VERSION="${APP_VERSION:-unknown}"

# Every line greps as `dump:` — docs/operating.md's Logs section points at it.
log() { printf 'dump: %s\n' "$*"; }
die() { printf 'dump: %s\n' "$*" >&2; exit 1; }

# One gibibyte, and then some: the floor below which a dump is refused however
# small the database claims it will be.
FLOOR_BYTES=1073741824
# Retry offsets in seconds after a failed run: 15, 30, 60 minutes, then the
# next window. A free-space refusal never enters this ladder.
RETRIES="900 1800 3600"

now() { date -u +%s; }
stamp() { date -u +%Y%m%dT%H%M%SZ; }

# --- inputs -------------------------------------------------------------------

# Everything here fails closed and names the variable, matching .env.example's
# promise for the application's own settings. DUMP_UID/DUMP_GID are absent on
# purpose: Compose applies them as the container's identity before this script
# exists, so a malformed one fails `up` and never reaches us. What we can check
# is the identity we actually got.
# Checked on its own, before anything else can refuse: turning dumps off has to
# work on an instance whose other inputs are wrong, or the switch is no switch.
validate_enabled() {
  case "$DUMP_ENABLED" in
    true|false) ;;
    *) die "DUMP_ENABLED must be true or false, not '$DUMP_ENABLED'" ;;
  esac
}

validate() {
  case "$DUMP_AT" in
    [0-1][0-9]|2[0-3]) ;;
    *) die "DUMP_AT must be a two-digit UTC hour 00-23, not '$DUMP_AT'" ;;
  esac
  case "$DUMP_KEEP_DAYS" in
    ''|*[!0-9]*) die "DUMP_KEEP_DAYS must be a whole number of days, not '$DUMP_KEEP_DAYS'" ;;
    0) die "DUMP_KEEP_DAYS must be at least 1 — 0 would delete today's dump" ;;
  esac
  case "$DUMP_COMPRESS" in
    [0-9]|none) ;;
    *) die "DUMP_COMPRESS must be 0-9 or none, not '$DUMP_COMPRESS'" ;;
  esac
  [ "$(id -u)" != "0" ] ||
    die "refusing to run as root; set DUMP_UID and DUMP_GID to the account that owns $DUMP_DIR"
  [ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is required"
  # The bundled `db` service is the only database this can dump: an operator
  # running against their own Postgres deletes `db` and this service with it
  # (docs/operating.md, "Running against your own Postgres"), and a dump of a
  # server we cannot reason about is worse than none.
  host=$(printf '%s' "$DATABASE_URL" | sed -n 's|^[a-z+]*://[^@]*@\([^:/?]*\).*|\1|p')
  [ "$host" = "db" ] ||
    die "DATABASE_URL names '$host'; this service only dumps the bundled db service"
  [ -d "$DUMP_DIR" ] || die "$DUMP_DIR does not exist"
  [ -w "$DUMP_DIR" ] || die "$DUMP_DIR is not writable as $(id -u):$(id -g)"
}

# --- markers ------------------------------------------------------------------
#
# Written by us, read by us and by whatever collects the directory. Hand-rolled
# JSON because the image has no jq and these are four flat fields.

marker() { printf '%s/%s' "$DUMP_DIR" "$1"; }

# A field out of one of our own markers; empty when absent.
marker_field() {
  [ -f "$1" ] || return 0
  sed -n 's/.*"'"$2"'"[ ]*:[ ]*"\{0,1\}\([^",}]*\)"\{0,1\}.*/\1/p' "$1" | head -1
}

write_attempt() {
  printf '{"started_at":"%s","outcome":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" \
    > "$(marker last-attempt.json)"
}

write_success() {
  printf '{"finished_at":"%s","file":"%s","bytes":%s,"sha256":"%s","compress":"%s","server_version":"%s","app_version":"%s","seconds":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" "$DUMP_COMPRESS" "$4" "$APP_VERSION" "$5" \
    > "$(marker last-success.json)"
}

write_error() {
  printf '{"failed_at":"%s","stage":"%s","message":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" > "$(marker last-error.json)"
}

# --- retention ----------------------------------------------------------------
#
# Anchored on the name this service writes, so a hand-taken
# `portfolio-2026-08-31.dump` parked in the same directory is not ours to
# delete. Age comes from the name rather than mtime: copying a directory resets
# mtimes and would silently re-age the archive.
is_ours() {
  case "$1" in
    portfolio-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.dump) return 0 ;;
    *) return 1 ;;
  esac
}

# The name's stamp as epoch seconds. Spelled out into the one form busybox
# `date -d` actually parses; it rejects both the compact stamp and anything
# relative.
name_epoch() {
  s=${1#portfolio-}
  s=${s%.dump}
  d=${s%T*}
  t=${s#*T}
  t=${t%Z}
  date -u -d "$(printf '%s' "$d" | cut -c1-4)-$(printf '%s' "$d" | cut -c5-6)-$(printf '%s' "$d" | cut -c7-8) $(printf '%s' "$t" | cut -c1-2):$(printf '%s' "$t" | cut -c3-4):$(printf '%s' "$t" | cut -c5-6)" +%s 2>/dev/null
}

prune() {
  dir="$1"
  cutoff=$(( $(now) - DUMP_KEEP_DAYS * 86400 ))
  newest=""
  for f in "$dir"/portfolio-*.dump; do
    [ -e "$f" ] || continue
    b=$(basename "$f")
    is_ours "$b" || continue
    # Spelled as an `if` rather than `a || b && c`: that form is false when the
    # name is not newer, and a false last command in a loop body is an exit
    # under `set -e`.
    if [ -z "$newest" ] || [ "$b" \> "$newest" ]; then newest="$b"; fi
  done
  for f in "$dir"/portfolio-*.dump; do
    [ -e "$f" ] || continue
    b=$(basename "$f")
    is_ours "$b" || continue
    # The newest dump is never deleted, whatever its age: a stale copy beats an
    # empty directory on the day the collector has been broken for a fortnight.
    [ "$b" != "$newest" ] || continue
    e=$(name_epoch "$b")
    [ -n "$e" ] || continue
    [ "$e" -lt "$cutoff" ] || continue
    rm -f "$f" "$f.json"
    log "pruned $b"
  done
}

# --- verification -------------------------------------------------------------
#
# `pg_restore --list` reads a table of contents written at the FRONT of a
# custom archive, so a dump truncated at five percent lists every object and
# exits 0. Decoding to /dev/null reads every data block instead, needs no
# server, and fails on a short read.
verify() {
  pg_restore -f /dev/null "$1" >/dev/null 2>&1
}

# --- one run ------------------------------------------------------------------

db_query() { psql -d "$DATABASE_URL" -At -q -c "$1"; }

free_bytes() { df -P "$DUMP_DIR" | awk 'NR==2 {print $4 * 1024}'; }

# Bounded from the database rather than from the last archive: a first run has
# no predecessor and a grown database outruns one. Twice its size because an
# uncompressed dump is larger than the pages it came from — jsonb payloads are
# TOAST-compressed in storage and expand on the way out.
room_for_dump() {
  size=$(db_query "select pg_database_size(current_database())") || return 1
  need=$(( size * 2 + FLOOR_BYTES ))
  have=$(free_bytes)
  [ "$have" -ge "$need" ] && return 0
  log "refusing: $DUMP_DIR has $have bytes free, this run needs $need"
  write_error "space" "needs $need bytes, has $have"
  return 1
}

# A dump far smaller than the last is a truncation the decode did not catch —
# but only when both were written at the same compression, since changing that
# setting legitimately changes the size by an order of magnitude.
too_small() {
  last=$(marker last-success.json)
  prev_bytes=$(marker_field "$last" bytes)
  prev_compress=$(marker_field "$last" compress)
  [ -n "$prev_bytes" ] || return 1
  [ "$prev_compress" = "$DUMP_COMPRESS" ] || return 1
  [ "$(( $1 * 2 ))" -lt "$prev_bytes" ]
}

run_once() {
  write_attempt started
  prune "$DUMP_DIR"
  room_for_dump || { write_attempt failure; return 1; }

  s=$(stamp)
  part="$DUMP_DIR/.portfolio-$s.dump.part"
  final="$DUMP_DIR/portfolio-$s.dump"
  started=$(now)

  if ! pg_dump -d "$DATABASE_URL" --format=custom --compress="$DUMP_COMPRESS" -f "$part" 2>/tmp/dump.err; then
    log "pg_dump failed: $(tr -d '\n' < /tmp/dump.err | tail -c 200)"
    write_error "pg_dump" "$(tr -d '\n\"' < /tmp/dump.err | tail -c 200)"
    rm -f "$part"; write_attempt failure; return 1
  fi

  if ! verify "$part"; then
    log "verification failed: the archive does not decode whole"
    write_error "verify" "pg_restore could not decode the archive"
    rm -f "$part"; write_attempt failure; return 1
  fi

  bytes=$(wc -c < "$part" | tr -d ' ')
  if too_small "$bytes"; then
    log "refusing: $bytes bytes is less than half the last dump at the same compression"
    write_error "shrink" "$bytes bytes, less than half the previous dump"
    rm -f "$part"; write_attempt failure; return 1
  fi

  # A rename within one filesystem, which is why the staging file lives here
  # and not on a tmpfs: a cross-device `mv` is a copy, and a collector reading
  # this directory would see a half-written archive.
  mv "$part" "$final"
  sha=$(sha256sum "$final" | cut -d' ' -f1)
  printf '{"sha256":"%s","bytes":%s,"compress":"%s","server_version":"%s","app_version":"%s","seconds":%s}\n' \
    "$sha" "$bytes" "$DUMP_COMPRESS" "$(db_query 'show server_version')" "$APP_VERSION" \
    "$(( $(now) - started ))" > "$final.json"
  write_success "$(basename "$final")" "$bytes" "$sha" "$(db_query 'show server_version')" "$(( $(now) - started ))"
  write_attempt success
  log "wrote $(basename "$final") ($bytes bytes)"
}

# --- the loop -----------------------------------------------------------------

# "08" is not 8 in POSIX arithmetic — it is an invalid octal — and `10#08` is a
# bashism this shell does not have. Strip the zero instead.
strip0() { v=${1#0}; printf '%s\n' "${v:-0}"; }

seconds_until_window() {
  target=$(( $(strip0 "$DUMP_AT") * 3600 ))
  current=$(( $(strip0 "$(date -u +%H)") * 3600 + $(strip0 "$(date -u +%M)") * 60 + $(strip0 "$(date -u +%S)") ))
  d=$(( target - current ))
  [ "$d" -gt 0 ] || d=$(( d + 86400 ))
  printf '%s\n' "$d"
}

# Sleep in chunks so SIGTERM lands promptly rather than after hours. The guard
# is not decoration: a nap that silently became a no-op once turned this loop
# into a dump-as-fast-as-the-database-can-answer, which is the worst thing this
# service could do to the instance it exists to protect.
nap() {
  left="$1"
  case "$left" in
    ''|*[!0-9]*)
      log "internal: refusing to sleep '$left' seconds; waiting an hour instead"
      left=3600
      ;;
  esac
  while [ "$left" -gt 0 ]; do
    [ "$left" -lt 60 ] && { sleep "$left"; return 0; }
    sleep 60
    left=$(( left - 60 ))
  done
}

# Deliberately not "dump on every boot": a crash-looping container would dump
# on each one, which app/lib/price-poller.server.ts:134-136 rejects for the far
# cheaper price fetch. An attempt left `started` is a crash mid-run and resumes
# the ladder; a recent finished attempt waits for the window.
needs_catch_up() {
  a=$(marker last-attempt.json)
  [ -f "$a" ] || return 0
  outcome=$(marker_field "$a" outcome)
  [ "$outcome" != "started" ] || return 0
  started=$(marker_field "$a" started_at)
  epoch=$(date -u -d "$(printf '%s' "$started" | tr 'TZ' ' ')" +%s 2>/dev/null || echo 0)
  [ "$(( $(now) - epoch ))" -gt 3600 ]
}

loop() {
  rm -f "$DUMP_DIR"/.portfolio-*.dump.part
  if needs_catch_up; then
    log "no recent completed attempt; dumping now"
    run_once || retry_ladder
  fi
  while true; do
    nap "$(seconds_until_window)"
    run_once || retry_ladder
  done
}

retry_ladder() {
  # A space refusal is the one failure retrying cannot help and can worsen.
  [ "$(marker_field "$(marker last-error.json)" stage)" != "space" ] || return 0
  for delay in $RETRIES; do
    log "retrying in $delay seconds"
    nap "$delay"
    run_once && return 0
  done
  log "three attempts failed; waiting for the next window"
}

# --- healthcheck --------------------------------------------------------------
#
# Reports on the age of the newest dump, not on the last exit status: a run
# that succeeded three weeks ago exited 0 too. Nothing acts on the result —
# Docker restart policies react to a process exiting, not to health — so this
# is for a human at `docker compose ps`, and the markers are what reach the
# collector.
healthcheck() {
  newest=""
  for f in "$DUMP_DIR"/portfolio-*.dump; do
    [ -e "$f" ] || continue
    b=$(basename "$f")
    is_ours "$b" || continue
    if [ -z "$newest" ] || [ "$b" \> "$newest" ]; then newest="$b"; fi
  done
  [ -n "$newest" ] || { echo "no dump yet"; exit 1; }
  age=$(( $(now) - $(name_epoch "$newest") ))
  # A day, plus six hours of grace for a slow run or a retry ladder.
  [ "$age" -lt 108000 ] || { echo "newest dump is $age seconds old"; exit 1; }
  echo "$newest"
}

# --- entry --------------------------------------------------------------------

case "${1:-loop}" in
  loop)
    validate_enabled
    if [ "$DUMP_ENABLED" = "false" ]; then
      log "dumps are disabled by DUMP_ENABLED=false; exiting"
      exit 0
    fi
    validate
    log "every day at ${DUMP_AT}:00 UTC, keeping ${DUMP_KEEP_DAYS} days in $DUMP_DIR"
    loop
    ;;
  verify)  [ $# -eq 2 ] || die "usage: dump-loop.sh verify <file>"; verify "$2" ;;
  prune)   [ $# -eq 2 ] || die "usage: dump-loop.sh prune <dir>"; prune "$2" ;;
  healthcheck) healthcheck ;;
  *) die "unknown command '$1'" ;;
esac
