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

readonly PORT="${PORT:-3000}"
readonly HEALTH_URL="http://127.0.0.1:${PORT}/healthz"
readonly TIMEOUT_SECONDS=180

log() { printf '\n=== %s\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }

cleanup() {
  log "Tearing down"
  docker compose logs --no-color app db 2>&1 | tail -80 || true
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
  actual="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "$HEALTH_URL" || true)"
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

# --- A restart is always safe -------------------------------------------------
log "Restarting the app container"
docker compose restart app
wait_for_healthy
expect_status 200

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

for pkg in vitest vite typescript @react-router/dev @types/react; do
  run_in_image "test ! -e /app/node_modules/$pkg" || fail "dev dependency in the runtime image: $pkg"
done
printf 'no dev dependencies\n'

for compiler in gcc cc g++ make tsc; do
  run_in_image "! command -v $compiler >/dev/null" || fail "compiler in the runtime image: $compiler"
done
printf 'no compiler\n'

# --- Exactly one published port, and it is not the database's -----------------
log "Checking published ports"
published_ports() {
  docker inspect --format '{{json .NetworkSettings.Ports}}' "$(docker compose ps -q "$1")"
}

[[ "$(published_ports db)" != *HostPort* ]] || fail "the db port is published to the host"
printf 'db port not published\n'

[[ "$(published_ports app)" == *"\"HostPort\":\"${PORT}\""* ]] ||
  fail "the app is not published on port ${PORT}"
printf 'app published on %s\n' "$PORT"

log "Smoke test passed"
