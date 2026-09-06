#!/usr/bin/env bash
# CI-only container smoke test — what unit tests structurally cannot reach: `up` on an empty
# data directory works, the stack refuses to start unconfigured, the front door is shut, and
# the runtime image holds what it is specified to. Gate credentials below are throwaway;
# oauth2-proxy never contacts Google at startup. Run from the repository root.
set -euo pipefail

# Build from the checkout, not the published image compose.yaml pulls — else
# every run silently certifies the *last release*. Exported once, not `-f`
# per call: most of the dozen invocations below (ps, exec, logs, restart)
# resolve by project name and work fine without it anyway.
export COMPOSE_FILE="compose.yaml:compose.dev.yaml"

readonly BASE_URL="http://127.0.0.1"
readonly HEALTH_URL="${BASE_URL}/healthz"
readonly TIMEOUT_SECONDS=180
readonly ALLOWLIST="allowed-emails.txt"
readonly DB_DIR="volumes/db/data"
# The operator's own directory (the dump service runs as their uid) — unlike
# the cluster, CI empties it without borrowing root.
readonly DUMPS_DIR="volumes/dumps"
export DUMP_UID="${DUMP_UID:-$(id -u)}"
export DUMP_GID="${DUMP_GID:-$(id -g)}"

log() { printf '\n=== %s\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }

allowlist_is_ours=false

# `down -v` no longer discards the database (it lives in the checkout) — emptied explicitly, borrowing root from the daemon since Postgres leaves it 0700 uid 70 (docs/operating.md).
empty_db_dir() {
  mkdir -p "$DB_DIR"
  [[ -n "${DB_IMAGE:-}" ]] || return 0
  docker run --rm -v "${PWD}/${DB_DIR}:/data" "$DB_IMAGE" find /data -mindepth 1 -delete
}

# Emptied at both ends: the catch-up dump only fires when the newest dump is
# stale, so a second run on yesterday's file would assert nothing.
empty_dumps_dir() {
  mkdir -p "$DUMPS_DIR"
  rm -f "${DUMPS_DIR:?}"/* "${DUMPS_DIR:?}"/.portfolio-*.part 2>/dev/null || true
}

cleanup() {
  log "Tearing down"
  docker compose logs --no-color app db caddy gate dump worker egress-proxy 2>&1 | tail -80 || true
  docker compose down -v --remove-orphans || true
  empty_db_dir || true
  empty_dumps_dir || true
  [[ "$allowlist_is_ours" == true ]] && rm -f "$ALLOWLIST"
  return 0
}
trap cleanup EXIT

wait_for_healthy() {
  local service="${1:-app}"
  local deadline=$((SECONDS + TIMEOUT_SECONDS))
  while ((SECONDS < deadline)); do
    case "$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q "$service")" 2>/dev/null || true)" in
      healthy) return 0 ;;
      unhealthy) fail "${service} healthcheck reported unhealthy" ;;
    esac
    sleep 3
  done
  fail "${service} did not become healthy within ${TIMEOUT_SECONDS}s"
}

expect_status() {
  local expected="$1" actual
  # `app` healthy doesn't mean `caddy` has bound its own port yet, so retry briefly.
  actual="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
    --retry 10 --retry-connrefused --retry-delay 1 "$HEALTH_URL" || true)"
  [[ "$actual" == "$expected" ]] || fail "GET /healthz returned ${actual}, expected ${expected}"
  printf 'GET /healthz -> %s\n' "$actual"
}

# Checked first: engine 26 silently ignores `gateway_mode_ipv4`, 27 refuses it — only 28 makes the isolated-network checks below reliable.
log "Checking the Docker Engine floor"
engine_version="$(docker version --format '{{.Server.Version}}')" ||
  fail "could not read the Docker Engine version"
engine_major="${engine_version%%.*}"
[[ "$engine_major" =~ ^[0-9]+$ ]] ||
  fail "could not parse a major version from Docker Engine ${engine_version}"
((engine_major >= 28)) || fail "Docker Engine ${engine_version} is below the 28.0 floor"
printf 'Docker Engine %s\n' "$engine_version"

# Exported, not written to .env, ahead of both refusal checks below — compose names whichever missing variable Go map iteration reaches first, so order here is load-bearing.
export GATE_CLIENT_ID="smoke-test.apps.googleusercontent.com"
export GATE_CLIENT_SECRET="smoke-test-client-secret"
# Run, not quoted, from .env.example: the sidecar refuses a value not
# decoding to 16/24/32 bytes, and a wrong-length placeholder would read as a gate bug.
GATE_COOKIE_SECRET="$(openssl rand -base64 32 | tr -- '+/' '-_')"
export GATE_COOKIE_SECRET
export PUBLIC_ORIGIN="https://smoke.example.test"

# compose-go's refusal names whichever missing variable it reaches first (nondeterministic) — isolated here since the gate's four are already real.
log "Checking the stack refuses to start without a database password"
if refusal="$(env -u POSTGRES_PASSWORD docker compose --env-file /dev/null config --quiet 2>&1)"; then
  fail "compose accepted a configuration with no POSTGRES_PASSWORD"
fi
[[ "$refusal" == *"required variable POSTGRES_PASSWORD is missing a value"* ]] ||
  fail "compose refused without the expected message: ${refusal}"
printf 'compose refused: %s\n' "$refusal"

# Exported ahead of the gate check below, so that check isolates only the
# gate variables — otherwise it would fail naming this one instead.
export POSTGRES_PASSWORD="smoke-test-postgres-password"

# `config`, not `up`: needs no daemon. `--env-file /dev/null` so a dev's own .env can't satisfy the variables; `env -u` isolates just the four gate names.
log "Checking the stack refuses to start without gate credentials"
if refusal="$(env -u GATE_CLIENT_ID -u GATE_CLIENT_SECRET -u GATE_COOKIE_SECRET \
  -u PUBLIC_ORIGIN docker compose --env-file /dev/null config --quiet 2>&1)"; then
  fail "compose accepted a configuration with no gate credentials"
fi
[[ "$refusal" == *"GATE_CLIENT_ID"* || "$refusal" == *"GATE_CLIENT_SECRET"* ||
   "$refusal" == *"GATE_COOKIE_SECRET"* || "$refusal" == *"PUBLIC_ORIGIN"* ]] ||
  fail "compose refused without naming the missing variable: ${refusal}"
printf 'compose refused: %s\n' "$refusal"

DB_IMAGE="$(docker compose config --images db)"
readonly DB_IMAGE

if [[ ! -e "$ALLOWLIST" ]]; then
  printf 'smoke-test@example.test\n' > "$ALLOWLIST"
  # On a non-root runner this is exactly the file root can't open without
  # DAC_READ_SEARCH — the read asserted below exercises the cap.
  chmod 600 "$ALLOWLIST"
  allowlist_is_ours=true
fi

# An install on its own Postgres must never depend on the bundled one — with no `bundled-db` profile, db/dump must never be created. `caddy` left out: its `depends_on` on app healthy would hang `up` forever.
log "Checking compose.external-db.yaml starts neither db nor dump"
(
  export COMPOSE_FILE="compose.yaml:compose.external-db.yaml:compose.dev.yaml"
  # Emptied, not left alone: inherited from the caller's env or the project
  # .env, COMPOSE_PROFILES=bundled-db would start db/dump and fail this for the wrong reason.
  export COMPOSE_PROFILES=""
  trap 'docker compose down -v --remove-orphans >/dev/null 2>&1 || true' EXIT
  docker compose up -d --build app worker gate
  # `-a`: containers that exist at all, not just up ones; `--services` since not every Compose version takes a profile-dropped literal name.
  created="$(docker compose ps -a --services)"
  # Positive control: assert the three asked-for services did appear, or the absence check below would test nothing.
  for present in app worker gate; do
    grep -Fxq "$present" <<<"$created" ||
      fail "compose.external-db.yaml: ${present} did not appear in ps -a --services either: ${created}"
  done
  if grep -Fxq db <<<"$created" || grep -Fxq dump <<<"$created"; then
    fail "compose.external-db.yaml created a container for db or dump: ${created}"
  fi
)
printf 'compose.external-db.yaml: db and dump not created\n'

log "Starting from an empty data directory"
docker compose down -v --remove-orphans >/dev/null 2>&1 || true
empty_db_dir
empty_dumps_dir
docker compose up -d --build

log "Waiting for the app healthcheck"
wait_for_healthy
expect_status 200

log "Waiting for the worker healthcheck"
wait_for_healthy worker

# /healthz is non-200 while any migration is unrecorded, so 200 above already proves current — this checks the runner made it so.
log "Checking migrations ran at startup"
# Captured, not piped: `grep -q` exits at first match and the producer's
# SIGPIPE would trip `pipefail`.
app_logs() { docker compose logs --no-color app 2>/dev/null; }

logs="$(app_logs)"
[[ "$logs" == *"Applying migrations from"* ]] || fail "the entrypoint did not run migrations"
[[ "$logs" == *"Migrations OK"* ]] || fail "migrations did not complete"
printf 'migrations applied at startup\n'

# Nothing else would notice db-store quietly reverting to a directory under
# /var/lib/docker, taking the operator's backup target with it.
log "Checking the cluster landed at ./${DB_DIR}"
cluster_dir="$(ls -ldn "$DB_DIR" | awk '{ print $3, $1 }')"
[[ "$cluster_dir" == "70 drwx------"* ]] ||
  fail "${DB_DIR} is '${cluster_dir}', expected Postgres's own 70 drwx------"
printf '%s: %s\n' "$DB_DIR" "$cluster_dir"

log "Restarting the app container"
docker compose restart app
wait_for_healthy
expect_status 200

logs="$(app_logs)"
[[ "$logs" == *"already applied"* ]] ||
  fail "the restarted container did not skip already-applied migrations"
printf 'restart skipped applied migrations\n'

log "Re-running the migration runner inside the container"
migrate_output="$(docker compose exec -T app node ./server/migrate.ts)" ||
  fail "re-running migrations exited non-zero"
printf '%s\n' "$migrate_output"
[[ "$migrate_output" == *"nothing pending"* ]] ||
  fail "re-running migrations was not a no-op"

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

migration_count="$(run_in_image 'ls /app/migrations/*.sql 2>/dev/null | wc -l' | tr -d '[:space:]')"
[[ "$migration_count" -gt 0 ]] || fail "the runtime image contains no migration .sql files"
printf 'migration .sql files in the image: %s\n' "$migration_count"

for path in /app/server/migrate.ts /app/server/yahoo-client.ts \
  /app/server/symbol-pattern.ts /app/server/price-worker.ts; do
  run_in_image "test -f $path" || fail "missing from the runtime image: $path"
done
printf 'migration runner and price-worker modules in the image\n'

for pkg in vitest vite typescript @react-router/dev @types/react; do
  run_in_image "test ! -e /app/node_modules/$pkg" || fail "dev dependency in the runtime image: $pkg"
done
printf 'no dev dependencies\n'

# What yahoo-finance2 declares but the app never loads (scripts/prune-unreachable-deps.mjs) — asserted since nothing else catches the prune silently stopping.
for pkg in @modelcontextprotocol/sdk @deno/shim-deno fetch-mock-cache hono jose cors; do
  run_in_image "test ! -e /app/node_modules/$pkg" ||
    fail "unreachable dependency still in the runtime image: $pkg"
done
printf 'unreachable yahoo-finance2 dependencies pruned\n'

for pkg in yahoo-finance2 tough-cookie tldts express react-router kysely pg zod; do
  run_in_image "test -e /app/node_modules/$pkg" ||
    fail "the prune removed a dependency the app needs: $pkg"
done
printf 'runtime dependencies intact\n'

# CommonJS `require` half of yahoo-finance2's dual build — unreachable from
# this ESM-only image (Dockerfile has the argument).
run_in_image 'test ! -e /app/node_modules/yahoo-finance2/script' ||
  fail "the CommonJS copy of yahoo-finance2 is still in the runtime image"

# Proved, not inferred: it loads via a lazy import() on first call, so a healthy container says nothing about it.
docker compose exec -T worker node -e \
  'import("yahoo-finance2").then(({default:YahooFinance})=>{process.exit(typeof new YahooFinance().quote==="function"?0:1)}).catch(()=>process.exit(1))' ||
  fail "the ESM half of yahoo-finance2 did not import and construct inside the image"
printf 'yahoo-finance2 CommonJS copy removed, ESM half loads\n'

# Grepped against the built output, not source — a stray source comment would trip a source grep, but a hit here is a real import.
log "Checking the app's built bundle carries no trace of yahoo-finance2"
run_in_image '! grep -rq yahoo-finance2 /app/build/server/' ||
  fail "yahoo-finance2 is reachable from the app's own built server bundle"
printf 'app bundle: no yahoo-finance2\n'

for compiler in gcc cc g++ make tsc; do
  run_in_image "! command -v $compiler >/dev/null" || fail "compiler in the runtime image: $compiler"
done
printf 'no compiler\n'

log "Checking published ports"
published_ports() {
  docker inspect --format '{{json .NetworkSettings.Ports}}' "$(docker compose ps -q "$1")"
}

[[ "$(published_ports db)" != *HostPort* ]] || fail "the db port is published to the host"
printf 'db port not published\n'

[[ "$(published_ports app)" != *HostPort* ]] || fail "the app port is published to the host"
printf 'app port not published\n'

[[ "$(published_ports worker)" != *HostPort* ]] || fail "the worker port is published to the host"
printf 'worker port not published\n'

# The proxy is reached only from `worker`, over `worker-proxy` — nothing
# outside this Compose project has any business dialing :8888.
[[ "$(published_ports egress-proxy)" != *HostPort* ]] || fail "the egress-proxy port is published to the host"
printf 'egress-proxy port not published\n'

# The gate trusts X-Forwarded-* from whatever reaches it — a published port here would let a caller walk past it asserting its own identity.
[[ "$(published_ports gate)" != *HostPort* ]] || fail "the gate port is published to the host"
printf 'gate port not published\n'

[[ "$(published_ports caddy)" == *'"HostPort":"80"'* ]] ||
  fail "caddy is not published on port 80"
printf 'caddy published on 80\n'

# The container half of that mapping — fails if the Caddyfile's site address and compose.yaml's ports: drift apart.
[[ "$(published_ports caddy)" == *'"8080/tcp":[{'*'"HostPort":"80"'* ]] ||
  fail "caddy's host port 80 does not map to the container's 8080 listener: $(published_ports caddy)"
printf 'caddy listens on 8080 inside\n'

# Nothing else notices this posture — caps, no-new-privileges and read-only each checked twice: daemon's record and the kernel's own answer.
log "Checking the containers' privileges"

# null and [] both mean none; the daemon's CAP_ prefix is stripped so a
# failure names the exact word an editor would change.
caps_of() {
  local raw
  raw="$(docker inspect --format "{{json .HostConfig.$2}}" "$(docker compose ps -q "$1")")"
  if [[ "$raw" == "null" ]]; then raw='[]'; fi
  raw="$(printf '%s' "$raw" | tr -d '[]"')"
  printf '%s' "${raw//CAP_/}"
}

# $2 is the exact CapAdd set (an unargued-for capability is the thing to catch); $3 is the kernel's own CapEff at PID 1, since the daemon's record alone can miss a silently-ignored option.
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
expect_caps dump "" 0000000000000000
expect_caps worker "" 0000000000000000
expect_caps egress-proxy "" 0000000000000000
# Exec, not binding: /usr/bin/caddy carries file capability
# cap_net_bind_service=ep and the kernel refuses to exec it from an empty
# bounding set — compose.yaml has the transcript.
expect_caps caddy "NET_BIND_SERVICE" 0000000000000400
expect_caps gate "DAC_READ_SEARCH" 0000000000000004

expect_no_new_privileges() {
  local service="$1" declared applied
  declared="$(docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$(docker compose ps -q "$1")")"
  [[ "$declared" == *"no-new-privileges"* ]] ||
    fail "${service} does not set no-new-privileges: ${declared}"
  applied="$(docker compose exec -T "$service" awk '/^NoNewPrivs/ { print $2 }' /proc/1/status |
    tr -d '[:space:]')"
  [[ "$applied" == "1" ]] ||
    fail "${service} PID 1 reports NoNewPrivs '${applied:-nothing}', expected 1"
  printf '%s: no-new-privileges, NoNewPrivs=%s at PID 1\n' "$service" "$applied"
}

for service in app db caddy gate dump worker egress-proxy; do
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
expect_uid worker 1000
expect_uid egress-proxy 1000
expect_uid db 70
expect_uid caddy 65532
expect_uid gate 0
# Not a constant like the others: this service exists to hand files to the
# account that owns its directory, which on a runner is the runner's own.
expect_uid dump "$DUMP_UID"

# Declared read_only, then the kernel's refusal by name — a bare non-zero exit proves nothing, since a non-root uid gets "Permission denied" on a writable rootfs too.
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

for service in app db caddy gate dump worker egress-proxy; do
  expect_read_only_root "$service"
done

# The mount set, not the socket's mode, keeps a compromised sidecar off the worker's socket (research §8.5) — only app and worker may mount it.
log "Checking the price-worker-sock volume fence"
for service in db dump gate caddy egress-proxy; do
  mount_names="$(docker inspect --format '{{range .Mounts}}{{.Name}} {{end}}' \
    "$(docker compose ps -q "$service")")" ||
    fail "could not inspect ${service}'s mounts"
  [[ "$mount_names" != *"price-worker-sock"* ]] ||
    fail "${service} mounts price-worker-sock, which only app and worker may: ${mount_names}"
done
printf 'db, dump, gate, caddy, egress-proxy do not mount price-worker-sock\n'

# The mount set only says who is on the volume, not what they may do — deleting :ro (compose.yaml:288) leaves every check above green.
log "Checking app's price-worker-sock mount is read-only"
app_sock_rw="$(docker inspect --format \
  '{{range .Mounts}}{{if eq .Destination "/run/price-worker"}}{{.RW}}{{end}}{{end}}' \
  "$(docker compose ps -q app)")" || fail "could not inspect app's mounts"
[[ "$app_sock_rw" == "false" ]] ||
  fail "app mounts price-worker-sock read-write (RW=${app_sock_rw:-absent}); it may only connect"
printf 'app: price-worker-sock is read-only\n'

log "Checking resource bounds"
# Exact, not "positive" — a fork bomb or memory balloon still reports positive numbers.
expect_resource_bounds() {
  local service="$1" resource_line pids mem
  resource_line="$(docker inspect --format '{{.HostConfig.PidsLimit}} {{.HostConfig.Memory}}' \
    "$(docker compose ps -q "$service")")" || fail "could not inspect ${service}'s resource limits"
  pids="${resource_line%% *}"
  mem="${resource_line##* }"
  [[ "$pids" == "64" ]] ||
    fail "${service} PidsLimit is '${pids}', expected 64"
  [[ "$mem" == "268435456" ]] ||
    fail "${service} Memory is '${mem}', expected 268435456 (256m)"
  printf '%s: PidsLimit=%s Memory=%s\n' "$service" "$pids" "$mem"
}

for service in worker egress-proxy; do
  expect_resource_bounds "$service"
done

log "Checking the worker carries no DATABASE_URL"
worker_env="$(docker inspect --format '{{json .Config.Env}}' "$(docker compose ps -q worker)")" ||
  fail "could not inspect the worker's environment"
[[ "$worker_env" != *"DATABASE_URL="* ]] ||
  fail "worker's environment carries DATABASE_URL: ${worker_env}"
printf 'worker: no DATABASE_URL\n'

log "Checking app reaches the worker's /healthz over the shared socket"
docker compose exec -T app node -e '
  const http = require("node:http");
  const req = http.request({
    socketPath: "/run/price-worker/worker.sock",
    path: "/healthz",
    method: "GET",
    agent: false,
  }, (res) => { res.resume(); process.exit(res.statusCode === 200 ? 0 : 1); });
  req.on("error", () => process.exit(1));
  req.setTimeout(5000, () => { req.destroy(); process.exit(1); });
  req.end();
' || fail "app could not GET /healthz over /run/price-worker/worker.sock"
printf 'app: GET /healthz over the socket -> 200\n'

log "Checking the worker's mount of /run/price-worker is tmpfs"
mounts_line="$(docker compose exec -T worker grep ' /run/price-worker ' /proc/mounts)" ||
  fail "worker's /proc/mounts has no entry for /run/price-worker"
[[ "$mounts_line" == *" tmpfs "* ]] ||
  fail "/run/price-worker is not tmpfs in worker: ${mounts_line}"
# `" tmpfs "` alone also matches the device column — options matched one at a time since `nr_inodes` can print between them.
for option in mode=770 uid=1000 gid=1000; do
  [[ "$mounts_line" == *"$option"* ]] ||
    fail "/run/price-worker tmpfs is missing ${option}: ${mounts_line}"
done
printf 'worker: %s\n' "$mounts_line"

# All four networks are `internal: true` — no default route at all. Proved twice per service (DNS probe + /proc/net/route) since a resolver can be absent for other reasons.
log "Checking app, db, dump and worker have no route out"

# app probes via its healthcheck fetch; db/dump (no node) use busybox wget — both carry an abort budget since a TCP SYN into a nonexistent route can sit unanswered far longer than a SERVFAIL.
expect_no_egress() {
  local service="$1" default_route status
  # A misspelled service or stopped container must fail loudly here, not read
  # as "no route" the way any other non-zero exit below does.
  [[ -n "$(docker compose ps -q "$service")" ]] ||
    fail "no running container for ${service} — cannot test its egress"

  if [[ "$service" == app ]]; then
    if docker compose exec -T app node -e '
      fetch("http://example.com/", { signal: AbortSignal.timeout(5000) })
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    '; then status=0; else status=$?; fi
  else
    if docker compose exec -T "$service" wget -T 5 -q -O /dev/null http://example.com/; then
      status=0
    else
      status=$?
    fi
  fi
  # 127 is "command not found" — a missing applet must fail loudly too, not
  # pass for having found "no route".
  ((status != 127)) || fail "${service} has nothing to probe HTTP with inside the container (exit 127)"
  ((status != 0)) || fail "${service} reached a public host over HTTP"
  printf '%s: no route to a public host over HTTP\n' "$service"

  if docker compose exec -T "$service" timeout 5 nslookup example.com >/dev/null 2>&1; then
    status=0
  else
    status=$?
  fi
  ((status != 127)) || fail "${service} has no nslookup to probe DNS with inside the container (exit 127)"
  ((status != 0)) || fail "${service} resolved a public hostname"
  printf '%s: cannot resolve a public hostname\n' "$service"

  # `00000000` in the destination column (field 2) is a default route — matched by column, since a direct route can carry it in the gateway column too.
  default_route="$(docker compose exec -T "$service" \
    awk 'NR>1 && $2=="00000000" { print }' /proc/net/route)" ||
    fail "could not read ${service}'s /proc/net/route"
  [[ -z "$default_route" ]] ||
    fail "${service} has a default route: ${default_route}"
  printf '%s: no default route in /proc/net/route\n' "$service"
}

# Worker reaches Yahoo only through egress-proxy's CONNECT tunnel now — the
# proxy resolves, so the worker itself has no resolver and no default route.
for service in app db dump worker; do
  expect_no_egress "$service"
done

# Read from the daemon's IPAM record, not a connect attempt — under `isolated` no gateway is allocated on an engine that honours it.
log "Checking the isolated networks were created with no gateway"
for net in backend caddy-app caddy-gate worker-proxy; do
  gateway="$(docker network inspect \
    -f '{{if (index .IPAM.Config 0).Gateway}}{{(index .IPAM.Config 0).Gateway}}{{end}}' \
    "portfolio_${net}")" || fail "could not inspect the ${net} network"
  [[ -z "$gateway" ]] ||
    fail "${net} has a gateway address (${gateway}) — isolated did not take"
  printf '%s: no gateway allocated\n' "$net"

  # Same fact from the other side: no host bridge carries an address either.
  # `br-<id>` is built from the network's own 12-char id prefix.
  bridge_id="$(docker network inspect -f '{{slice .Id 0 12}}' "portfolio_${net}")" ||
    fail "could not read the ${net} network id"
  bridge_addr="$(ip -4 addr show dev "br-${bridge_id}" 2>&1)" ||
    fail "could not read host bridge br-${bridge_id} for ${net}: ${bridge_addr}"
  [[ "$bridge_addr" != *inet\ * ]] ||
    fail "host bridge br-${bridge_id} (${net}) carries an address: ${bridge_addr}"
  printf '%s: host bridge br-%s carries no address\n' "$net" "$bridge_id"
done

# worker-proxy is worker's only network, shared with none of app/gate/db — every attempt carries its own 3s timeout, never `ping` (NET_RAW dropped).
log "Checking the worker cannot reach app, gate or db"

# Space-separated: {{range}} supplies none, and a multi-network service (spec §3.6) would glue addresses together otherwise.
container_ip() {
  docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' \
    "$(docker compose ps -q "$1")"
}

# ECONNREFUSED proves a route exists (port merely closed) — counts as reached; everything else counts as unreachable.
unreachable_from_worker() {
  local host="$1" port="$2" desc="$3" output
  if output="$(docker compose exec -T worker node -e '
    const net = require("node:net");
    const [host, port] = process.argv.slice(1);
    const socket = net.connect({ host, port: Number(port) });
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      socket.destroy();
      process.exit(code);
    };
    socket.setTimeout(3000);
    socket.once("connect", () => finish(1));
    socket.once("timeout", () => finish(0));
    socket.once("error", (e) => finish(e.code === "ECONNREFUSED" ? 1 : 0));
  ' "$host" "$port" 2>&1)"; then
    printf 'worker cannot reach %s (%s:%s)\n' "$desc" "$host" "$port"
    return 0
  fi
  # Empty output means the script itself exited 1 (reached); anything on stdout/stderr means exec never got that far.
  [[ -z "$output" ]] ||
    fail "could not test whether worker can reach ${desc} (${host}:${port}): ${output}"
  fail "worker reached ${desc} (${host}:${port}) — network isolation broken"
}

probe_all_ips() {
  local service="$1" port="$2" desc="$3" ips ip
  ips="$(container_ip "$service")"
  [[ -n "$ips" ]] || fail "could not resolve a container IP for ${service}"
  for ip in $ips; do
    unreachable_from_worker "$ip" "$port" "${desc} by IP (${ip})"
  done
}

unreachable_from_worker app 3000 "app by name"
probe_all_ips app 3000 "app"
unreachable_from_worker gate 4180 "gate by name"
probe_all_ips gate 4180 "gate"
unreachable_from_worker db 5432 "db by name"
probe_all_ips db 5432 "db"


# Topology above proves the wiring; this proves the proxy forwards traffic — best-effort, skipped without real internet (other cases below don't need it).
log "Checking the worker reaches Yahoo through the proxy"
yahoo_reachable=true
yahoo_fetch_output="$(docker compose exec -T worker node -e '
  fetch("https://query2.finance.yahoo.com/", { signal: AbortSignal.timeout(10000) })
    .then((r) => { console.log(r.status); process.exit(0); })
    .catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
' 2>&1)" || yahoo_reachable=false
if [[ "$yahoo_reachable" == true ]]; then
  printf 'worker: fetch of query2.finance.yahoo.com through the proxy -> HTTP %s\n' "$yahoo_fetch_output"
else
  printf 'SKIPPED (no route to the real internet from this runner): worker fetch of query2.finance.yahoo.com through the proxy — %s\n' "$yahoo_fetch_output"
fi

# Proxy env vars stay set on worker throughout — stopping egress-proxy removes only what they point at, isolating topology from the flag.
log "Checking the fetch fails while egress-proxy is stopped"
docker compose stop egress-proxy >/dev/null || fail "could not stop egress-proxy"
# Exit 1 is the assertion; anything else (127, exec never starting) must not
# satisfy a bare `if` and read as proof, same shape as expect_no_egress above.
stopped_status=0
stopped_output="$(docker compose exec -T worker node -e '
  fetch("https://query2.finance.yahoo.com/", { signal: AbortSignal.timeout(10000) })
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
' 2>&1)" || stopped_status=$?
((stopped_status != 0)) ||
  fail "worker reached Yahoo through the proxy while egress-proxy was stopped: ${stopped_output}"
((stopped_status == 1)) ||
  fail "could not test the stopped proxy from worker (exit ${stopped_status}): ${stopped_output}"
printf 'worker: fetch through the proxy fails while egress-proxy is stopped\n'
docker compose start egress-proxy >/dev/null || fail "could not restart egress-proxy"
wait_for_healthy egress-proxy

log "Checking the proxy refuses a CONNECT to a host off the allowlist"
# mail.yahoo.com shares Yahoo's edge with the allowed hosts (research §3.1) but isn't allowlisted — a 403 proves gating by name, needing no real route.
connect_status="$(docker compose exec -T worker node -e '
  const net = require("node:net");
  const socket = net.connect({ host: "egress-proxy", port: 8888 }, () => {
    socket.write("CONNECT mail.yahoo.com:443 HTTP/1.1\r\nHost: mail.yahoo.com:443\r\n\r\n");
  });
  let buf = "";
  socket.setTimeout(5000, () => { socket.destroy(); process.exit(1); });
  socket.on("data", (d) => {
    buf += d.toString("latin1");
    const m = buf.match(/^HTTP\/\d\.\d (\d+)/);
    if (m) { process.stdout.write(m[1]); socket.destroy(); process.exit(0); }
  });
  socket.on("error", () => process.exit(1));
')" || fail "could not reach the proxy to test a disallowed CONNECT"
[[ "$connect_status" == "403" ]] ||
  fail "CONNECT mail.yahoo.com:443 through the proxy returned '${connect_status}', expected 403"
printf 'proxy: CONNECT to a disallowed host -> %s\n' "$connect_status"

log "Checking the proxy's own /healthz"
healthz_status="$(docker compose exec -T worker node -e '
  const http = require("node:http");
  const req = http.request(
    { host: "egress-proxy", port: 8888, path: "/healthz", method: "GET" },
    (res) => { res.resume(); console.log(res.statusCode); }
  );
  req.setTimeout(5000, () => { req.destroy(); process.exit(1); });
  req.on("error", () => process.exit(1));
  req.end();
')" || fail "could not reach the proxy's /healthz"
[[ "$healthz_status" == "200" ]] ||
  fail "GET /healthz on the proxy returned '${healthz_status}', expected 200"
printf 'proxy: GET /healthz -> %s\n' "$healthz_status"

log "Checking the proxy refuses anything but CONNECT and /healthz"
other_status="$(docker compose exec -T worker node -e '
  const http = require("node:http");
  const req = http.request(
    { host: "egress-proxy", port: 8888, path: "/", method: "GET" },
    (res) => { res.resume(); console.log(res.statusCode); }
  );
  req.setTimeout(5000, () => { req.destroy(); process.exit(1); });
  req.on("error", () => process.exit(1));
  req.end();
')" || fail "could not reach the proxy for the negative-path check"
[[ "$other_status" == "405" ]] ||
  fail "GET / on the proxy returned '${other_status}', expected 405"
printf 'proxy: GET / -> %s\n' "$other_status"

if [[ "$yahoo_reachable" == true ]]; then
  log "Checking a mismatched server name tears down the tunnel, not a 403"
  # server/egress-proxy.ts: the 200 is written before the ClientHello is read, so a mismatch can't be answered 403 — the client sees a TLS failure instead.
  if docker compose exec -T worker node -e '
    const net = require("node:net");
    const tls = require("node:tls");
    const raw = net.connect({ host: "egress-proxy", port: 8888 });
    raw.setTimeout(10000, () => { raw.destroy(); process.exit(1); });
    raw.once("connect", () => {
      raw.write("CONNECT finance.yahoo.com:443 HTTP/1.1\r\nHost: finance.yahoo.com:443\r\n\r\n");
    });
    // A proxy closing before a status must fail this too — `answered` makes that deliberate.
    let answered = false;
    const closedEarly = () => { if (!answered) process.exit(1); };
    raw.once("end", closedEarly);
    raw.once("close", closedEarly);
    raw.once("data", (head) => {
      answered = true;
      if (!/^HTTP\/1\.[01] 200/.test(head.toString("latin1"))) { process.exit(1); return; }
      const tlsSocket = tls.connect({
        socket: raw,
        servername: "mail.yahoo.com",
        rejectUnauthorized: false,
      });
      tlsSocket.setTimeout(5000, () => { tlsSocket.destroy(); process.exit(1); });
      tlsSocket.once("secureConnect", () => { tlsSocket.destroy(); process.exit(1); });
      tlsSocket.once("error", () => process.exit(0));
      tlsSocket.once("close", () => process.exit(0));
    });
    raw.once("error", () => process.exit(1));
  '; then
    printf 'proxy: CONNECT finance.yahoo.com + mismatched server_name -> torn down, not 403\n'
  else
    fail "a CONNECT finance.yahoo.com:443 tunnel with server_name=mail.yahoo.com was not torn down"
  fi
else
  printf 'SKIPPED (no route to the real internet from this runner): server-name mismatch teardown\n'
fi

# The capability's effect, not its declaration — reads the same 0600 file through the sidecar's own uid on a non-root runner.
allowlist_seen="$(docker compose exec -T gate cat /etc/oauth2-proxy/allowed-emails.txt |
  tr -d '[:space:]')" || fail "the gate could not read its allowlist at all"
[[ -n "$allowlist_seen" ]] ||
  fail "the gate read an empty allowlist — nobody could ever sign in"
if [[ "$allowlist_is_ours" == true ]]; then
  [[ "$allowlist_seen" == *"smoke-test@example.test"* ]] ||
    fail "the gate read '${allowlist_seen}', not the allowlist this run wrote"
fi
printf 'gate reads its allowlist through the bind mount\n'

# The catch-up rule makes this cheap: an empty dumps directory at startup means the first dump happens within seconds.
log "Waiting for the first dump"
dump_path=""
deadline=$((SECONDS + 120))
while ((SECONDS < deadline)); do
  dump_path="$(ls "$DUMPS_DIR"/portfolio-*.dump 2>/dev/null | head -1 || true)"
  [[ -n "$dump_path" ]] && break
  sleep 2
done
[[ -n "$dump_path" ]] || fail "no dump appeared in ${DUMPS_DIR} within 120s"
dump_name="$(basename "$dump_path")"
printf 'dump wrote %s\n' "$dump_name"

[[ "$dump_name" =~ ^portfolio-[0-9]{8}T[0-9]{6}Z\.dump$ ]] ||
  fail "dump is named '${dump_name}', not portfolio-YYYYMMDDTHHMMSSZ.dump"

# 0640: the dumps are the household's finances in plaintext, readable only to the account that collects them.
dump_mode="$(stat -c '%a' "$dump_path")"
[[ "$dump_mode" == "640" ]] || fail "dump is mode ${dump_mode}, expected 640"

[[ -f "${DUMPS_DIR}/last-success.json" ]] ||
  fail "the run wrote no success marker"
grep -q "$dump_name" "${DUMPS_DIR}/last-success.json" ||
  fail "the success marker does not name ${dump_name}"
[[ -f "${dump_path}.json" ]] || fail "no sidecar json beside ${dump_name}"

recorded_sha="$(sed -n 's/.*"sha256":"\([0-9a-f]*\)".*/\1/p' "${dump_path}.json")"
actual_sha="$(sha256sum "$dump_path" | cut -d' ' -f1)"
[[ "$recorded_sha" == "$actual_sha" ]] ||
  fail "sidecar json records sha ${recorded_sha}, file hashes to ${actual_sha}"
printf 'sidecar json records the archive it sits beside\n'

# Polled, not sampled — a probe a moment before the rename leaves the service `starting` until the next interval.
dump_health=""
deadline=$((SECONDS + 60))
while ((SECONDS < deadline)); do
  dump_health="$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q dump)" 2>/dev/null || true)"
  [[ "$dump_health" == "healthy" ]] && break
  [[ "$dump_health" == "unhealthy" ]] && fail "the dump container reported unhealthy with a dump on disk"
  sleep 2
done
[[ "$dump_health" == "healthy" ]] ||
  fail "the dump container reports ${dump_health:-nothing}, expected healthy"
printf 'dump healthcheck: %s\n' "$dump_health"

# pg_restore --list reads only the front of the archive and would pass a file missing most of its data.
docker compose run --rm -T dump verify "/dumps/${dump_name}" >/dev/null 2>&1 ||
  fail "the service refused an archive it had just written and verified"

head -c $(( $(stat -c '%s' "$dump_path") / 20 )) "$dump_path" > "${DUMPS_DIR}/truncated.bin"
if docker compose run --rm -T dump verify /dumps/truncated.bin >/dev/null 2>&1; then
  fail "a 5%%-truncated archive passed verification"
fi
printf 'a truncated archive is refused, a whole one is not\n'

# Pre-aged by name rather than by mtime, because that is what retention reads.
touch "${DUMPS_DIR}/portfolio-20200101T000000Z.dump" \
      "${DUMPS_DIR}/portfolio-20200102T000000Z.dump" \
      "${DUMPS_DIR}/portfolio-2020-01-03.dump"
docker compose run --rm -T dump prune /dumps >/dev/null 2>&1 ||
  fail "prune exited non-zero"
[[ ! -e "${DUMPS_DIR}/portfolio-20200101T000000Z.dump" ]] ||
  fail "prune kept a dump older than the retention window"
[[ -e "$dump_path" ]] ||
  fail "prune deleted the newest dump"
# An operator's own `portfolio-$(date +%F).dump` parked here before an upgrade is not this service's to delete.
[[ -e "${DUMPS_DIR}/portfolio-2020-01-03.dump" ]] ||
  fail "prune deleted a file it did not write"
printf 'retention: window applied, newest kept, foreign names untouched\n'
rm -f "${DUMPS_DIR}/truncated.bin" "${DUMPS_DIR}/portfolio-2020-01-03.dump"

# Proves the framework, not just the container — vitest loads no React Router plugin, so this is the one place it's exercised. Asked inside app's container to skip the gate.
log "Fetching a real page from the app container"

page="$(docker compose exec -T app node -e \
  'fetch("http://127.0.0.1:"+(process.env.PORT||3000)+"/").then(r=>r.text()).then(t=>process.stdout.write(t))' ||
  true)"
[[ "$page" == *'aria-label="Primary"'* ]] || fail "GET / did not render the navigation rail"
[[ "$page" == *"Portfolio"* ]] || fail "GET / did not render the brand"
printf 'GET / rendered a page\n'

# The one thing a rendered page can't vouch for: whether its <link> targets actually exist — how a 404'd asset once shipped unnoticed.
log "Fetching the static assets from the app container"

for asset in /manifest.webmanifest /sw.js /icon.svg /fonts/inter-latin-var.woff2; do
  status="$(docker compose exec -T app node -e \
    'fetch("http://127.0.0.1:"+(process.env.PORT||3000)+process.argv[1]).then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(()=>process.exit(1))' \
    "$asset")" || fail "GET ${asset} from the app returned ${status:-nothing}, expected 200"
  printf 'GET %s -> %s\n' "$asset" "$status"
done

# The body, not just the status — "200 with the wrong body" is the failure Compose, the proxy, and monitoring cannot see.
health="$(curl -sS --max-time 30 "$HEALTH_URL" || true)"
[[ "$health" == *'"status":"ok"'* ]] || fail "GET /healthz body was not ok: ${health}"
[[ "$health" == *'"migrations":"current"'* ]] ||
  fail "GET /healthz did not report the schema current: ${health}"
printf 'GET /healthz -> %s\n' "$health"

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

# One hop proves two things: /oauth2/* is answered by the sidecar (app would 404), and skip_provider_button is on — next screen is Google itself.
google="$(location_of "$BASE_URL$sign_in")"
[[ "$google" == https://accounts.google.com/o/oauth2/auth\?* ]] ||
  fail "the gate's sign-in went to '${google}', expected Google's authorization endpoint"
[[ "$google" == *"client_id=${GATE_CLIENT_ID}"* ]] ||
  fail "the redirect to Google did not carry the configured client id: ${google}"
[[ "$google" == *"redirect_uri="* && "$google" == *"smoke.example.test"* ]] ||
  fail "the redirect to Google did not carry the configured redirect URL: ${google}"
printf 'GET %s -> 302 Google, carrying the client id\n' "$sign_in"

# The gate's verdict endpoint, consulted by Caddy on every request — the app would 404 here, so a 401 can only be the sidecar's.
auth_status="$(status_of "$BASE_URL/oauth2/auth")"
[[ "$auth_status" == "401" ]] ||
  fail "GET /oauth2/auth returned ${auth_status}, expected the gate's 401"
printf 'GET /oauth2/auth -> %s from the gate\n' "$auth_status"

# The one exemption still holds — if this ever needs credentials, every uptime monitor pointed here goes blind at once.
expect_status 200

log "Smoke test passed"
