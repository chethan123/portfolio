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

readonly BASE_URL="http://127.0.0.1"
readonly HEALTH_URL="${BASE_URL}/healthz"
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

# --- The stack actually serves a page, not just a health check ----------------
# Everything above proves the container is up. This proves the framework inside
# it is: `react-router-serve` over the real build, the route manifest, and the
# server render. The vitest suite deliberately skips all of that — it loads no
# React Router plugin — so this is the one place it is exercised at all.
log "Fetching a real page"

page="$(curl -sS --max-time 30 --retry 10 --retry-connrefused --retry-delay 1 "$BASE_URL/" || true)"
[[ "$page" == *'aria-label="Primary"'* ]] || fail "GET / did not render the navigation rail"
[[ "$page" == *"Portfolio"* ]] || fail "GET / did not render the brand"
printf 'GET / rendered a page\n'

# The body, not just the status. `/healthz` is what Compose, the proxy and any
# monitoring read, and "200 with the wrong body" is the failure they cannot see.
health="$(curl -sS --max-time 30 "$HEALTH_URL" || true)"
[[ "$health" == *'"status":"ok"'* ]] || fail "GET /healthz body was not ok: ${health}"
[[ "$health" == *'"migrations":"current"'* ]] ||
  fail "GET /healthz did not report the schema current: ${health}"
printf 'GET /healthz -> %s\n' "$health"

# --- The login gate, end to end -----------------------------------------------
# The gate is one middleware on the root route, so "every page is behind it" is
# a property of the whole running stack rather than of the middleware function
# that `auth.test.ts` and `root-gate.test.ts` call directly. Turning it on means
# recreating the app container, which is why this runs last.
log "Turning the login gate on"
readonly TEST_PASSWORD="correct horse battery staple"
AUTH_PASSWORD="$TEST_PASSWORD" SESSION_SECRET="smoke-test-signing-key" \
  docker compose up -d --wait app
wait_for_healthy

# `/healthz` must stay reachable with no credentials, or monitoring goes blind
# the moment an operator sets a password.
expect_status 200

status_of() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "$@"
}

gated="$(status_of "$BASE_URL/holdings")"
[[ "$gated" == "302" ]] || fail "with a password set, GET /holdings returned ${gated}, expected 302"

location="$(curl -sS -o /dev/null -D - --max-time 30 "$BASE_URL/holdings" |
  tr -d '\r' | awk 'tolower($1) == "location:" { print $2 }')"
[[ "$location" == /login* ]] || fail "GET /holdings redirected to '${location}', expected /login"
[[ "$location" == *"next=%2Fholdings"* || "$location" == *"next=/holdings" ]] ||
  fail "the redirect to /login did not carry where the visitor was going: ${location}"
printf 'GET /holdings -> 302 %s\n' "$location"

readonly COOKIE_JAR="$(mktemp)"
signed_in="$(status_of -c "$COOKIE_JAR" --data-urlencode "password=${TEST_PASSWORD}" \
  --data-urlencode "next=/holdings" "$BASE_URL/login")"
[[ "$signed_in" == "302" ]] || fail "POST /login with the right password returned ${signed_in}"
# curl writes an HttpOnly cookie with a `#HttpOnly_` prefix, so the jar is also
# where that flag can be checked — and a session cookie readable from JavaScript
# would be the whole point of the gate given away.
grep -qi "__portfolio_session" "$COOKIE_JAR" || fail "POST /login issued no session cookie"
grep -qi "^#HttpOnly_.*__portfolio_session" "$COOKIE_JAR" ||
  fail "the session cookie was not issued HttpOnly"
printf 'POST /login -> 302 with an HttpOnly session cookie\n'

after="$(status_of -b "$COOKIE_JAR" "$BASE_URL/holdings")"
[[ "$after" == "200" ]] || fail "with the session cookie, GET /holdings returned ${after}"
printf 'GET /holdings with the cookie -> 200\n'

# A wrong password must not issue one. Same page, no cookie, no redirect.
readonly REFUSED_JAR="$(mktemp)"
refused="$(status_of -c "$REFUSED_JAR" --data-urlencode "password=not the password" \
  "$BASE_URL/login")"
[[ "$refused" == "200" ]] || fail "POST /login with a wrong password returned ${refused}"
grep -qi "__portfolio_session" "$REFUSED_JAR" &&
  fail "POST /login issued a session cookie for a wrong password"
printf 'POST /login with a wrong password -> 200, no cookie\n'

log "Smoke test passed"
