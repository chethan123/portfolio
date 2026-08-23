#!/usr/bin/env bash
#
# CI-only container smoke test.
#
# It exists for the things a unit or integration test structurally cannot reach:
# that `docker compose up` on an empty volume produces a working instance with
# no manual steps, that the app waits for Postgres rather than racing it, that a
# restart is safe, and that the runtime image actually contains what it is
# specified to contain and nothing it is specified not to.
#
# It is slow and it is deliberately thin. Behaviour gets tested elsewhere.
#
# Run from the repository root:  ./scripts/smoke-test.sh
set -euo pipefail

readonly HEALTH_URL="http://127.0.0.1/healthz"
readonly TIMEOUT_SECONDS=180

log() { printf '\n=== %s\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }

cleanup() {
  log "Tearing down"
  docker compose logs --no-color app db caddy 2>&1 | tail -80 || true
  docker compose down -v --remove-orphans || true
}
trap cleanup EXIT

wait_for_healthy() {
  local deadline=$((SECONDS + TIMEOUT_SECONDS))
  while ((SECONDS < deadline)); do
    case "$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q app)" 2>/dev/null || true)" in
      healthy) return 0 ;;
      unhealthy) fail "app healthcheck reported unhealthy" ;;
    esac
    sleep 3
  done
  fail "app did not become healthy within ${TIMEOUT_SECONDS}s"
}

expect_status() {
  local expected="$1" actual
  # `app` reporting healthy only guarantees the app is up, not that the separate
  # `caddy` container has finished starting and bound its own port yet, so this
  # retries briefly rather than assuming the first connection lands.
  actual="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
    --retry 10 --retry-connrefused --retry-delay 1 "$HEALTH_URL" || true)"
  [[ "$actual" == "$expected" ]] || fail "GET /healthz returned ${actual}, expected ${expected}"
  printf 'GET /healthz -> %s\n' "$actual"
}

# --- A fresh machine with an empty volume, and no manual steps ----------------
log "Starting from an empty volume"
docker compose down -v --remove-orphans >/dev/null 2>&1 || true
docker compose up -d --build

log "Waiting for the app healthcheck"
wait_for_healthy
expect_status 200

# --- Migrations ran before the server started ---------------------------------
# The instance is healthy, and /healthz is a non-200 while any migration on disk
# is unrecorded — so a 200 above is already proof the schema is current. This
# checks the other half: that the runner is what made it so, rather than the app
# having started against whatever happened to be there.
log "Checking migrations ran at startup"
# Captured into a variable rather than piped: `grep -q` exits at the first match
# and the SIGPIPE that gives the producer would trip `pipefail`.
app_logs() { docker compose logs --no-color app 2>/dev/null; }

logs="$(app_logs)"
[[ "$logs" == *"Applying migrations from"* ]] || fail "the entrypoint did not run migrations"
[[ "$logs" == *"Migrations OK"* ]] || fail "migrations did not complete"
printf 'migrations applied at startup\n'

# --- A restart is always safe -------------------------------------------------
# This is what proves migrations are idempotent: the second boot re-runs the
# runner against a database that already has the schema, and a non-zero exit
# there would stop the server and never reach healthy.
log "Restarting the app container"
docker compose restart app
wait_for_healthy
expect_status 200

logs="$(app_logs)"
[[ "$logs" == *"already applied"* ]] ||
  fail "the restarted container did not skip already-applied migrations"
printf 'restart skipped applied migrations\n'

# Running the runner a third time, inside the real image against the real
# database, must exit 0 and apply nothing.
log "Re-running the migration runner inside the container"
migrate_output="$(docker compose exec -T app node ./server/migrate.ts)" ||
  fail "re-running migrations exited non-zero"
printf '%s\n' "$migrate_output"
[[ "$migrate_output" == *"nothing pending"* ]] ||
  fail "re-running migrations was not a no-op"

# --- The image is what it is specified to be ----------------------------------
log "Inspecting the runtime image"
readonly IMAGE="$(docker compose images -q app | head -1)"
[[ -n "$IMAGE" ]] || fail "could not resolve the app image id"

run_in_image() { docker run --rm --entrypoint sh "$IMAGE" -c "$1"; }

user="$(run_in_image 'whoami')"
[[ "$user" != "root" ]] || fail "the runtime image runs as root"
printf 'runs as: %s\n' "$user"

clock="$(run_in_image 'date +%Z')"
[[ "$clock" == "UTC" ]] || fail "container clock is ${clock}, expected UTC"
printf 'container clock: %s\n' "$clock"

for path in /app/app /app/tests /app/vite.config.ts /app/react-router.config.ts; do
  run_in_image "test ! -e $path" || fail "source tree leaked into the runtime image: $path"
done
printf 'no source tree\n'

# The database is the source of truth, so the .sql files are part of the image.
# Without them a fresh volume would come up with no schema at all.
migration_count="$(run_in_image 'ls /app/migrations/*.sql 2>/dev/null | wc -l' | tr -d '[:space:]')"
[[ "$migration_count" -gt 0 ]] || fail "the runtime image contains no migration .sql files"
printf 'migration .sql files in the image: %s\n' "$migration_count"

run_in_image 'test -f /app/server/migrate.ts' ||
  fail "the migration runner is missing from the runtime image"
printf 'migration runner in the image\n'

for pkg in vitest vite typescript @react-router/dev @types/react; do
  run_in_image "test ! -e /app/node_modules/$pkg" || fail "dev dependency in the runtime image: $pkg"
done
printf 'no dev dependencies\n'

# The MCP server SDK and friends that `yahoo-finance2` declares but this
# application never loads (see scripts/prune-unreachable-deps.mjs). Asserted
# here because nothing else can catch the prune silently ceasing to fire.
for pkg in @modelcontextprotocol/sdk @deno/shim-deno fetch-mock-cache hono jose cors; do
  run_in_image "test ! -e /app/node_modules/$pkg" ||
    fail "unreachable dependency still in the runtime image: $pkg"
done
printf 'unreachable yahoo-finance2 dependencies pruned\n'

# The other half of the same check: the prune must not have overshot into what
# the price provider actually needs.
for pkg in yahoo-finance2 tough-cookie tldts express react-router kysely pg zod; do
  run_in_image "test -e /app/node_modules/$pkg" ||
    fail "the prune removed a dependency the app needs: $pkg"
done
printf 'runtime dependencies intact\n'

for compiler in gcc cc g++ make tsc; do
  run_in_image "! command -v $compiler >/dev/null" || fail "compiler in the runtime image: $compiler"
done
printf 'no compiler\n'

# --- Exactly one published port, and it belongs to caddy, not app or db -------
log "Checking published ports"
published_ports() {
  docker inspect --format '{{json .NetworkSettings.Ports}}' "$(docker compose ps -q "$1")"
}

[[ "$(published_ports db)" != *HostPort* ]] || fail "the db port is published to the host"
printf 'db port not published\n'

[[ "$(published_ports app)" != *HostPort* ]] || fail "the app port is published to the host"
printf 'app port not published\n'

[[ "$(published_ports caddy)" == *'"HostPort":"80"'* ]] ||
  fail "caddy is not published on port 80"
printf 'caddy published on 80\n'

log "Smoke test passed"
