#!/usr/bin/env bash
#
# CI-only container smoke test.
#
# It exists for the things a unit or integration test structurally cannot reach:
# that `docker compose up` on an empty volume produces a working instance once
# the gate is configured — and refuses to start at all until it is — that the
# app waits for Postgres rather than racing it, that a restart is safe, that the
# front door is shut, and that the runtime image actually contains what it is
# specified to contain and nothing it is specified not to.
#
# The gate values below are throwaway. oauth2-proxy never contacts Google at
# startup, so the real sidecar boots on fake credentials and everything short of
# the round trip through a real Google account is exercisable here; that last
# leg is an operator's checklist, not CI's.
#
# It is slow and it is deliberately thin. Behaviour gets tested elsewhere.
#
# Run from the repository root:  ./scripts/smoke-test.sh
set -euo pipefail

# compose.yaml pulls the published image. This test exists to exercise the tree
# it was handed, so it layers the development override on top and builds from
# source — otherwise every run would silently certify the *last release* and go
# green no matter what the working tree does to the Dockerfile or the entrypoint.
#
# Set once as COMPOSE_FILE rather than passed as `-f` on each call: there are a
# dozen `docker compose` invocations below and the ones that would break if a
# flag were forgotten are not the ones that would look broken. `ps`, `exec`,
# `logs` and `restart` all resolve by project name and would keep working.
export COMPOSE_FILE="compose.yaml:compose.dev.yaml"

readonly BASE_URL="http://127.0.0.1"
readonly HEALTH_URL="${BASE_URL}/healthz"
readonly TIMEOUT_SECONDS=180
readonly ALLOWLIST="allowed-emails.txt"

log() { printf '\n=== %s\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }

# Set before the trap, because the trap reads it.
allowlist_is_ours=false

cleanup() {
  log "Tearing down"
  docker compose logs --no-color app db caddy gate 2>&1 | tail -80 || true
  docker compose down -v --remove-orphans || true
  # Only the one this script wrote. A developer running this on their own
  # machine has a real allowlist sitting there.
  [[ "$allowlist_is_ours" == true ]] && rm -f "$ALLOWLIST"
  return 0
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

# --- The stack refuses to start half-protected --------------------------------
# Before anything is configured: compose must stop rather than bring up an
# instance with no gate in front of it. `config` rather than `up` because
# interpolation is the first thing `up` does and it needs no daemon; `--env-file
# /dev/null` so a developer's own .env cannot quietly satisfy the variables and
# turn this assertion green for the wrong reason.
log "Checking the stack refuses to start without gate credentials"
if refusal="$(env -u GATE_CLIENT_ID -u GATE_CLIENT_SECRET -u GATE_COOKIE_SECRET \
  -u PUBLIC_ORIGIN docker compose --env-file /dev/null config --quiet 2>&1)"; then
  fail "compose accepted a configuration with no gate credentials"
fi
[[ "$refusal" == *"GATE_CLIENT_ID"* || "$refusal" == *"GATE_CLIENT_SECRET"* ||
   "$refusal" == *"GATE_COOKIE_SECRET"* || "$refusal" == *"PUBLIC_ORIGIN"* ]] ||
  fail "compose refused without naming the missing variable: ${refusal}"
printf 'compose refused: %s\n' "$refusal"

# --- Throwaway gate configuration ---------------------------------------------
# Exported rather than written to .env: the environment wins over .env, so the
# run is identical on a bare CI runner and on a machine with a real instance
# configured beside it.
export GATE_CLIENT_ID="smoke-test.apps.googleusercontent.com"
export GATE_CLIENT_SECRET="smoke-test-client-secret"
# The generation command from .env.example, run rather than quoted: the sidecar
# builds an AES cipher from this and refuses to start unless it decodes to 16,
# 24 or 32 bytes, and a hand-written placeholder of the wrong length would fail
# in a way that reads like a gate bug.
GATE_COOKIE_SECRET="$(openssl rand -base64 32 | tr -- '+/' '-_')"
export GATE_COOKIE_SECRET
export PUBLIC_ORIGIN="https://smoke.example.test"

if [[ ! -e "$ALLOWLIST" ]]; then
  printf 'smoke-test@example.test\n' > "$ALLOWLIST"
  allowlist_is_ours=true
fi

# --- A fresh machine with an empty volume -------------------------------------
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

# The gate believes the X-Forwarded-* headers of whatever reaches it, so a
# published port here would be a way to walk around the gate by asserting your
# own identity to it.
[[ "$(published_ports gate)" != *HostPort* ]] || fail "the gate port is published to the host"
printf 'gate port not published\n'

[[ "$(published_ports caddy)" == *'"HostPort":"80"'* ]] ||
  fail "caddy is not published on port 80"
printf 'caddy published on 80\n'

# --- The stack actually serves a page, not just a health check ----------------
# Everything above proves the container is up. This proves the framework inside
# it is: `react-router-serve` over the real build, the route manifest, and the
# server render. The vitest suite deliberately skips all of that — it loads no
# React Router plugin — so this is the one place it is exercised at all.
#
# Asked of `app` from inside its own container rather than through Caddy,
# because the gate now refuses `/` to anyone without a Google session and this
# assertion is about the renderer, not the front door. `node -e` for the same
# reason the healthcheck uses it: the runtime image carries no curl.
log "Fetching a real page from the app container"

page="$(docker compose exec -T app node -e \
  'fetch("http://127.0.0.1:"+(process.env.PORT||3000)+"/").then(r=>r.text()).then(t=>process.stdout.write(t))' ||
  true)"
[[ "$page" == *'aria-label="Primary"'* ]] || fail "GET / did not render the navigation rail"
[[ "$page" == *"Portfolio"* ]] || fail "GET / did not render the brand"
printf 'GET / rendered a page\n'

# The static assets Vite copies out of `public/` — the PWA manifest, the
# service worker, the icon and the font. They are the one part of the image a
# rendered page cannot vouch for: the markup above carries its `<link>` tags
# whether the files behind them exist or not, which is exactly how an image
# that 404'd all four shipped unnoticed. Asked of `app` directly, like the
# page fetch, and for the same reasons.
log "Fetching the static assets from the app container"

for asset in /manifest.webmanifest /sw.js /icon.svg /fonts/inter-latin-var.woff2; do
  status="$(docker compose exec -T app node -e \
    'fetch("http://127.0.0.1:"+(process.env.PORT||3000)+process.argv[1]).then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(()=>process.exit(1))' \
    "$asset")" || fail "GET ${asset} from the app returned ${status:-nothing}, expected 200"
  printf 'GET %s -> %s\n' "$asset" "$status"
done

# The body, not just the status. `/healthz` is what Compose, the proxy and any
# monitoring read, and "200 with the wrong body" is the failure they cannot see.
health="$(curl -sS --max-time 30 "$HEALTH_URL" || true)"
[[ "$health" == *'"status":"ok"'* ]] || fail "GET /healthz body was not ok: ${health}"
[[ "$health" == *'"migrations":"current"'* ]] ||
  fail "GET /healthz did not report the schema current: ${health}"
printf 'GET /healthz -> %s\n' "$health"

# --- The front door is shut ---------------------------------------------------
# "Every path is behind the gate" is a property of the running stack — of Caddy
# consulting the sidecar — rather than of anything the vitest suite can call, so
# this is the only place it is checked at all. None of it needs a Google account:
# the browser is turned away before Google is ever consulted.
log "Checking the gate refuses an unauthenticated request"

status_of() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "$@"
}

location_of() {
  curl -sS -o /dev/null -D - --max-time 30 "$@" |
    tr -d '\r' | awk 'tolower($1) == "location:" { print $2 }'
}

refused_status="$(status_of "$BASE_URL/")"
[[ "$refused_status" == "302" ]] ||
  fail "GET / through Caddy returned ${refused_status}, expected the gate's 302"

sign_in="$(location_of "$BASE_URL/")"
[[ "$sign_in" == /oauth2/sign_in* ]] ||
  fail "GET / redirected to '${sign_in}', expected the gate's sign-in"
[[ "$sign_in" == *"rd=/"* ]] ||
  fail "the redirect to the gate did not carry where the visitor was going: ${sign_in}"
printf 'GET / -> 302 %s\n' "$sign_in"

# Following that hop proves two things at once: that /oauth2/* is answered by
# the sidecar rather than the app — the app has no such route and would 404 —
# and that skip_provider_button is on, so the next thing a family member sees is
# Google itself rather than an interstitial.
google="$(location_of "$BASE_URL$sign_in")"
[[ "$google" == https://accounts.google.com/o/oauth2/auth\?* ]] ||
  fail "the gate's sign-in went to '${google}', expected Google's authorization endpoint"
[[ "$google" == *"client_id=${GATE_CLIENT_ID}"* ]] ||
  fail "the redirect to Google did not carry the configured client id: ${google}"
# The redirect URI is percent-encoded in the query, but the host survives intact.
[[ "$google" == *"redirect_uri="* && "$google" == *"smoke.example.test"* ]] ||
  fail "the redirect to Google did not carry the configured redirect URL: ${google}"
printf 'GET %s -> 302 Google, carrying the client id\n' "$sign_in"

# The gate's verdict endpoint, which Caddy consults on every request. The app
# would answer 404 here; a 401 can only have come from the sidecar.
auth_status="$(status_of "$BASE_URL/oauth2/auth")"
[[ "$auth_status" == "401" ]] ||
  fail "GET /oauth2/auth returned ${auth_status}, expected the gate's 401"
printf 'GET /oauth2/auth -> %s from the gate\n' "$auth_status"

# And the one exemption still holds. If this ever needs credentials, every
# uptime monitor pointed at this instance goes blind at once.
expect_status 200

log "Smoke test passed"
