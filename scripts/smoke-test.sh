#!/usr/bin/env bash
#
# CI-only container smoke test — the things a unit or integration test
# structurally cannot reach: `docker compose up` on an empty data directory
# produces a working instance once the gate is configured (and refuses to start
# until it is), the app waits for Postgres, a restart is safe, the front door is
# shut, and the runtime image contains what it is specified to and nothing it is
# not.
#
# The gate values below are throwaway: oauth2-proxy never contacts Google at
# startup, so the real sidecar boots on fake credentials — everything short of
# a real Google round trip is exercisable; that last leg is the operator's
# checklist, not CI's.
#
# Slow and deliberately thin. Behaviour gets tested elsewhere.
#
# Run from the repository root:  ./scripts/smoke-test.sh
set -euo pipefail

# compose.yaml pulls the published image; this test exercises the tree it was
# handed, so layer the dev override on top and build from source — otherwise
# every run silently certifies the *last release*. COMPOSE_FILE once, not `-f`
# per call: of the dozen invocations below, the ones that would break with a
# forgotten flag are not the ones that would look broken (`ps`, `exec`,
# `logs`, `restart` resolve by project name and keep working).
export COMPOSE_FILE="compose.yaml:compose.dev.yaml"

readonly BASE_URL="http://127.0.0.1"
readonly HEALTH_URL="${BASE_URL}/healthz"
readonly TIMEOUT_SECONDS=180
readonly ALLOWLIST="allowed-emails.txt"
# Where compose.yaml's `db-store` puts the cluster. Every run starts from an
# empty one, and leaves it empty.
readonly DB_DIR="volumes/db/data"

log() { printf '\n=== %s\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }

# Set before the trap, because the trap reads it.
allowlist_is_ours=false

# `down -v` no longer discards the database: the cluster lives in the checkout
# now, and outliving the volume record is the point of that. So the directory is
# emptied explicitly, at both ends of the run. It is 0700 uid 70 by the time
# Postgres has touched it — unreadable to the host user on a non-root runner —
# so the emptying borrows root from the daemon, exactly as the operator's
# restore does (docs/operating.md).
empty_db_dir() {
  mkdir -p "$DB_DIR"
  [[ -n "${DB_IMAGE:-}" ]] || return 0
  docker run --rm -v "${PWD}/${DB_DIR}:/data" "$DB_IMAGE" find /data -mindepth 1 -delete
}

cleanup() {
  log "Tearing down"
  docker compose logs --no-color app db caddy gate 2>&1 | tail -80 || true
  docker compose down -v --remove-orphans || true
  empty_db_dir || true
  # Only the one this script wrote — a developer may have a real allowlist here.
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
  # `app` healthy does not mean the separate `caddy` container has bound its
  # own port yet, so retry briefly.
  actual="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
    --retry 10 --retry-connrefused --retry-delay 1 "$HEALTH_URL" || true)"
  [[ "$actual" == "$expected" ]] || fail "GET /healthz returned ${actual}, expected ${expected}"
  printf 'GET /healthz -> %s\n' "$actual"
}

# --- The stack refuses to start half-protected --------------------------------
# Unconfigured, compose must stop rather than bring up an ungated instance.
# `config`, not `up`: interpolation is `up`'s first step and needs no daemon.
# `--env-file /dev/null` so a developer's own .env cannot quietly satisfy the
# variables and green this assertion for the wrong reason.
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
# Exported, not written to .env: the environment wins over .env, so the run is
# identical on a bare CI runner and beside a real configured instance.
export GATE_CLIENT_ID="smoke-test.apps.googleusercontent.com"
export GATE_CLIENT_SECRET="smoke-test-client-secret"
# The generation command from .env.example, run rather than quoted: the
# sidecar refuses a value not decoding to 16/24/32 bytes, and a wrong-length
# placeholder would fail in a way that reads like a gate bug.
GATE_COOKIE_SECRET="$(openssl rand -base64 32 | tr -- '+/' '-_')"
export GATE_COOKIE_SECRET
export PUBLIC_ORIGIN="https://smoke.example.test"

# Asked of compose rather than repeated here: the image `empty_db_dir` borrows a
# root `find` from. Resolvable only now — `config` interpolates the whole file,
# gate variables included.
DB_IMAGE="$(docker compose config --images db)"
readonly DB_IMAGE

if [[ ! -e "$ALLOWLIST" ]]; then
  printf 'smoke-test@example.test\n' > "$ALLOWLIST"
  # 0600, only on the file this script owns: on a non-root runner this is
  # exactly the file root cannot open without DAC_READ_SEARCH — the read
  # asserted below exercises the cap. On a root runner it changes nothing.
  chmod 600 "$ALLOWLIST"
  allowlist_is_ours=true
fi

# --- A fresh machine with an empty data directory ------------------------------
log "Starting from an empty data directory"
docker compose down -v --remove-orphans >/dev/null 2>&1 || true
empty_db_dir
docker compose up -d --build

log "Waiting for the app healthcheck"
wait_for_healthy
expect_status 200

# --- Migrations ran before the server started ---------------------------------
# /healthz is non-200 while any on-disk migration is unrecorded, so the 200
# above already proves the schema current. This checks the other half: the
# runner made it so, not an app started against whatever happened to be there.
log "Checking migrations ran at startup"
# Captured, not piped: `grep -q` exits at first match and the producer's
# SIGPIPE would trip `pipefail`.
app_logs() { docker compose logs --no-color app 2>/dev/null; }

logs="$(app_logs)"
[[ "$logs" == *"Applying migrations from"* ]] || fail "the entrypoint did not run migrations"
[[ "$logs" == *"Migrations OK"* ]] || fail "migrations did not complete"
printf 'migrations applied at startup\n'

# --- The cluster is in the checkout, not a Docker-managed volume ---------------
# `db-store` binds a name to ./volumes/db/data; nothing else would notice it
# quietly reverting to a directory under /var/lib/docker, taking the operator's
# backup target with it. Read as ownership and mode of the directory itself —
# 0700 uid 70 is initdb's own doing, and its contents are unreadable to the host
# user this may be running as.
log "Checking the cluster landed at ./${DB_DIR}"
cluster_dir="$(ls -ldn "$DB_DIR" | awk '{ print $3, $1 }')"
[[ "$cluster_dir" == "70 drwx------"* ]] ||
  fail "${DB_DIR} is '${cluster_dir}', expected Postgres's own 70 drwx------"
printf '%s: %s\n' "$DB_DIR" "$cluster_dir"

# --- A restart is always safe -------------------------------------------------
# What proves migrations idempotent: the second boot re-runs the runner
# against an already-migrated database; a non-zero exit would never reach
# healthy.
log "Restarting the app container"
docker compose restart app
wait_for_healthy
expect_status 200

logs="$(app_logs)"
[[ "$logs" == *"already applied"* ]] ||
  fail "the restarted container did not skip already-applied migrations"
printf 'restart skipped applied migrations\n'

# A third run, inside the real image against the real database: exit 0, apply nothing.
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

# The .sql files are part of the image — without them a fresh volume comes up
# with no schema at all.
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

# What `yahoo-finance2` declares but the app never loads (see
# scripts/prune-unreachable-deps.mjs). Asserted here because nothing else can
# catch the prune silently ceasing to fire.
for pkg in @modelcontextprotocol/sdk @deno/shim-deno fetch-mock-cache hono jose cors; do
  run_in_image "test ! -e /app/node_modules/$pkg" ||
    fail "unreachable dependency still in the runtime image: $pkg"
done
printf 'unreachable yahoo-finance2 dependencies pruned\n'

# The other half: the prune must not have overshot into what the app needs.
for pkg in yahoo-finance2 tough-cookie tldts express react-router kysely pg zod; do
  run_in_image "test -e /app/node_modules/$pkg" ||
    fail "the prune removed a dependency the app needs: $pkg"
done
printf 'runtime dependencies intact\n'

# The CommonJS copy of `yahoo-finance2` — the `require` half of its dual build,
# which nothing in this ESM-only image can reach; the Dockerfile carries the
# argument.
run_in_image 'test ! -e /app/node_modules/yahoo-finance2/script' ||
  fail "the CommonJS copy of yahoo-finance2 is still in the runtime image"

# And the half the app does reach, proved rather than inferred: the provider
# loads the package through a lazy `import()` on the first quote refresh, not
# at boot, so a healthy container says nothing about it. This is the exact path
# app/lib/price-provider.server.ts takes.
docker compose exec -T app node -e \
  'import("yahoo-finance2").then(({default:YahooFinance})=>{process.exit(typeof new YahooFinance().quote==="function"?0:1)}).catch(()=>process.exit(1))' ||
  fail "the ESM half of yahoo-finance2 did not import and construct inside the image"
printf 'yahoo-finance2 CommonJS copy removed, ESM half loads\n'

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

# The gate believes X-Forwarded-* from whatever reaches it, so a published
# port here would let a caller walk past the gate asserting its own identity.
[[ "$(published_ports gate)" != *HostPort* ]] || fail "the gate port is published to the host"
printf 'gate port not published\n'

[[ "$(published_ports caddy)" == *'"HostPort":"80"'* ]] ||
  fail "caddy is not published on port 80"
printf 'caddy published on 80\n'

# The container half of that mapping, tied to the host half: host 80 must land
# on the 8080 listener specifically, so this fails if the Caddyfile's site
# address and compose.yaml's `ports:` drift apart.
[[ "$(published_ports caddy)" == *'"8080/tcp":[{'*'"HostPort":"80"'* ]] ||
  fail "caddy's host port 80 does not map to the container's 8080 listener: $(published_ports caddy)"
printf 'caddy listens on 8080 inside\n'

# --- Every container holds only the privileges it was proved to need ----------
# Nothing else can notice this posture: a container that regained root, a
# capability, or a writable rootfs serves every request exactly as before.
# Caps, no-new-privileges and read-only are each checked twice — the daemon's
# record and the kernel's answer from inside — because the two disagree in
# exactly the interesting cases. compose.yaml carries the argument for each
# surviving capability.
log "Checking the containers' privileges"

# Capability names in compose.yaml's spelling: null and [] both mean none,
# and the daemon's CAP_ prefix is stripped so a failure names the exact word
# an editor would change.
caps_of() {
  local raw
  raw="$(docker inspect --format "{{json .HostConfig.$2}}" "$(docker compose ps -q "$1")")"
  if [[ "$raw" == "null" ]]; then raw='[]'; fi
  raw="$(printf '%s' "$raw" | tr -d '[]"')"
  printf '%s' "${raw//CAP_/}"
}

# $2 is the exact expected CapAdd set (comma-separated, empty for none) — not
# a "contains": a capability nobody argued for is the thing to catch. $3 is
# the CapEff the kernel must report at PID 1 — the daemon's record alone would
# miss a runtime that accepted the option and ignored it.
expect_caps() {
  local service="$1" expected="$2" want_eff="$3" dropped added eff
  dropped="$(caps_of "$service" CapDrop)"
  [[ "$dropped" == "ALL" ]] ||
    fail "${service} drops '${dropped}', expected ALL"
  added="$(caps_of "$service" CapAdd)"
  [[ "$added" == "$expected" ]] ||
    fail "${service} adds '${added}', expected '${expected}'"
  eff="$(docker compose exec -T "$service" awk '/^CapEff/ { print $2 }' /proc/1/status |
    tr -d '[:space:]')"
  [[ "$eff" == "$want_eff" ]] ||
    fail "${service} PID 1 holds CapEff ${eff}, expected ${want_eff}"
  printf '%s: dropped ALL, added %s (CapEff %s)\n' "$service" "${added:-nothing}" "$eff"
}

expect_caps app "" 0000000000000000
expect_caps db "" 0000000000000000
# Exec, not binding: /usr/bin/caddy carries file capability
# cap_net_bind_service=ep and the kernel refuses to exec it from an empty
# bounding set — compose.yaml has the transcript.
expect_caps caddy "NET_BIND_SERVICE" 0000000000000400
# Root cannot open a file it does not own without this.
expect_caps gate "DAC_READ_SEARCH" 0000000000000004

expect_no_new_privileges() {
  local service="$1" declared applied
  declared="$(docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$(docker compose ps -q "$1")")"
  [[ "$declared" == *"no-new-privileges"* ]] ||
    fail "${service} does not set no-new-privileges: ${declared}"
  # The kernel's answer at PID 1 — no setuid binary can hand anything back.
  applied="$(docker compose exec -T "$service" awk '/^NoNewPrivs/ { print $2 }' /proc/1/status |
    tr -d '[:space:]')"
  [[ "$applied" == "1" ]] ||
    fail "${service} PID 1 reports NoNewPrivs '${applied:-nothing}', expected 1"
  printf '%s: no-new-privileges, NoNewPrivs=%s at PID 1\n' "$service" "$applied"
}

for service in app db caddy gate; do
  expect_no_new_privileges "$service"
done

# gate's root is the documented decision — asserted, so pinning a uid there is
# a failing test and a conversation, not a sidecar that stops reading its file.
expect_uid() {
  local service="$1" expected="$2" actual
  actual="$(docker compose exec -T "$service" id -u | tr -d '[:space:]')"
  [[ "$actual" == "$expected" ]] ||
    fail "${service} runs as uid ${actual}, expected ${expected}"
  printf '%s runs as uid %s\n' "$service" "$actual"
}

expect_uid app 1000
expect_uid db 70
expect_uid caddy 65532
expect_uid gate 0

# Declared read_only, then the kernel's refusal — which must be EROFS by name:
# a bare non-zero exit proves nothing, because / is root-owned 0755 and a
# non-root uid gets "Permission denied" on a writable rootfs too.
expect_read_only_root() {
  local service="$1" declared refusal
  declared="$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$(docker compose ps -q "$service")")"
  [[ "$declared" == "true" ]] ||
    fail "${service} is not mounted with a read-only root filesystem"
  refusal="$(docker compose exec -T "$service" sh -c 'touch /smoke-test-write 2>&1' || true)"
  [[ "$refusal" == *"Read-only file system"* ]] ||
    fail "${service} write to / was not refused by the mount: ${refusal:-write succeeded}"
  printf '%s: / is read-only\n' "$service"
}

for service in app db caddy gate; do
  expect_read_only_root "$service"
done

# The capability's effect, not its declaration: read as the sidecar's own uid
# from the same ro bind mount — on a non-root runner, the 0600 file above.
allowlist_seen="$(docker compose exec -T gate cat /etc/oauth2-proxy/allowed-emails.txt |
  tr -d '[:space:]')" || fail "the gate could not read its allowlist at all"
[[ -n "$allowlist_seen" ]] ||
  fail "the gate read an empty allowlist — nobody could ever sign in"
if [[ "$allowlist_is_ours" == true ]]; then
  [[ "$allowlist_seen" == *"smoke-test@example.test"* ]] ||
    fail "the gate read '${allowlist_seen}', not the allowlist this run wrote"
fi
printf 'gate reads its allowlist through the bind mount\n'

# --- The stack actually serves a page, not just a health check ----------------
# Everything above proves the container is up; this proves the framework in it
# is: `react-router-serve` over the real build, the route manifest, the server
# render. The vitest suite loads no React Router plugin, so this is the one
# place any of that is exercised. Asked of `app` inside its own container —
# the gate refuses `/` without a Google session and this is about the
# renderer, not the front door. `node -e` because the image carries no curl.
log "Fetching a real page from the app container"

page="$(docker compose exec -T app node -e \
  'fetch("http://127.0.0.1:"+(process.env.PORT||3000)+"/").then(r=>r.text()).then(t=>process.stdout.write(t))' ||
  true)"
[[ "$page" == *'aria-label="Primary"'* ]] || fail "GET / did not render the navigation rail"
[[ "$page" == *"Portfolio"* ]] || fail "GET / did not render the brand"
printf 'GET / rendered a page\n'

# The static assets Vite copies out of `public/` — the PWA manifest, the
# service worker, the icon and the font. The one part of the image a rendered
# page cannot vouch for: the markup above carries its `<link>` tags whether
# the files behind them exist or not — exactly how an image that 404'd all
# four shipped unnoticed. Asked of `app` directly, like the page fetch, for
# the same reasons.
log "Fetching the static assets from the app container"

for asset in /manifest.webmanifest /sw.js /icon.svg /fonts/inter-latin-var.woff2; do
  status="$(docker compose exec -T app node -e \
    'fetch("http://127.0.0.1:"+(process.env.PORT||3000)+process.argv[1]).then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(()=>process.exit(1))' \
    "$asset")" || fail "GET ${asset} from the app returned ${status:-nothing}, expected 200"
  printf 'GET %s -> %s\n' "$asset" "$status"
done

# The body, not just the status: "200 with the wrong body" is the failure
# Compose, the proxy and monitoring cannot see.
health="$(curl -sS --max-time 30 "$HEALTH_URL" || true)"
[[ "$health" == *'"status":"ok"'* ]] || fail "GET /healthz body was not ok: ${health}"
[[ "$health" == *'"migrations":"current"'* ]] ||
  fail "GET /healthz did not report the schema current: ${health}"
printf 'GET /healthz -> %s\n' "$health"

# --- The front door is shut ---------------------------------------------------
# "Every path is behind the gate" is a property of the running stack — Caddy
# consulting the sidecar — so this is the only place it is checked. No Google
# account needed: the browser is turned away before Google is consulted.
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

# One hop proves two things: /oauth2/* is answered by the sidecar (the app has
# no such route and would 404), and skip_provider_button is on — the next
# screen is Google itself, not an interstitial.
google="$(location_of "$BASE_URL$sign_in")"
[[ "$google" == https://accounts.google.com/o/oauth2/auth\?* ]] ||
  fail "the gate's sign-in went to '${google}', expected Google's authorization endpoint"
[[ "$google" == *"client_id=${GATE_CLIENT_ID}"* ]] ||
  fail "the redirect to Google did not carry the configured client id: ${google}"
# The redirect URI is percent-encoded in the query, but the host survives intact.
[[ "$google" == *"redirect_uri="* && "$google" == *"smoke.example.test"* ]] ||
  fail "the redirect to Google did not carry the configured redirect URL: ${google}"
printf 'GET %s -> 302 Google, carrying the client id\n' "$sign_in"

# The gate's verdict endpoint, consulted by Caddy on every request. The app
# would 404 here; a 401 can only be the sidecar's.
auth_status="$(status_of "$BASE_URL/oauth2/auth")"
[[ "$auth_status" == "401" ]] ||
  fail "GET /oauth2/auth returned ${auth_status}, expected the gate's 401"
printf 'GET /oauth2/auth -> %s from the gate\n' "$auth_status"

# The one exemption still holds — if this ever needs credentials, every uptime
# monitor pointed here goes blind at once.
expect_status 200

log "Smoke test passed"
