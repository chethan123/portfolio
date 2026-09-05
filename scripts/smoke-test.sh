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
# Where the dump service writes. Unlike the cluster this is the *operator's*
# directory — the whole point of the service running as their uid — so CI
# empties it without borrowing root, and sets that uid to its own.
readonly DUMPS_DIR="volumes/dumps"
export DUMP_UID="${DUMP_UID:-$(id -u)}"
export DUMP_GID="${DUMP_GID:-$(id -g)}"

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

# The files here belong to the runner, so no root is borrowed. Emptied at both
# ends for the same reason as the cluster: the catch-up dump only fires when
# the newest dump is stale, so a second run on yesterday's file would assert
# nothing.
empty_dumps_dir() {
  mkdir -p "$DUMPS_DIR"
  rm -f "${DUMPS_DIR:?}"/* "${DUMPS_DIR:?}"/.portfolio-*.part 2>/dev/null || true
}

cleanup() {
  log "Tearing down"
  docker compose logs --no-color app db caddy gate dump worker 2>&1 | tail -80 || true
  docker compose down -v --remove-orphans || true
  empty_db_dir || true
  empty_dumps_dir || true
  # Only the one this script wrote — a developer may have a real allowlist here.
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
  # `app` healthy does not mean the separate `caddy` container has bound its
  # own port yet, so retry briefly.
  actual="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
    --retry 10 --retry-connrefused --retry-delay 1 "$HEALTH_URL" || true)"
  [[ "$actual" == "$expected" ]] || fail "GET /healthz returned ${actual}, expected ${expected}"
  printf 'GET /healthz -> %s\n' "$actual"
}

# --- The Docker Engine floor ---------------------------------------------------
# First, before anything else touches Compose: 07's isolated networks are what
# make 28.0 load-bearing (26 ignores `gateway_mode_ipv4` silently and keeps a
# host address on the bridge, 27 refuses it), but the floor is declared here,
# one release earlier, so an operator meets the check before that matters. A
# CI runner-image regression (`.github/workflows/ci.yml:142-149`) then reads
# as "engine too old", not as a topology bug several checks downstream.
log "Checking the Docker Engine floor"
engine_version="$(docker version --format '{{.Server.Version}}')" ||
  fail "could not read the Docker Engine version"
engine_major="${engine_version%%.*}"
[[ "$engine_major" =~ ^[0-9]+$ ]] ||
  fail "could not parse a major version from Docker Engine ${engine_version}"
((engine_major >= 28)) || fail "Docker Engine ${engine_version} is below the 28.0 floor"
printf 'Docker Engine %s\n' "$engine_version"

# --- The stack refuses to start without a database password -------------------
# Same fail-closed contract as the gate credentials below, now for `db`'s
# `${POSTGRES_PASSWORD:?}` — checked first and on purpose: `db` sits earlier
# in the file than `gate`, and Compose reports only the first missing
# variable it hits while interpolating. The gate's four are equally unset at
# this point too — the throwaway ones below are exported only after this
# check — so a refusal naming `POSTGRES_PASSWORD` rather than one of them is
# what proves that file order, not merely assumes it.
log "Checking the stack refuses to start without a database password"
if refusal="$(env -u POSTGRES_PASSWORD docker compose --env-file /dev/null config --quiet 2>&1)"; then
  fail "compose accepted a configuration with no POSTGRES_PASSWORD"
fi
[[ "$refusal" == *"POSTGRES_PASSWORD"* ]] ||
  fail "compose refused without naming POSTGRES_PASSWORD: ${refusal}"
printf 'compose refused: %s\n' "$refusal"

# Exported here, ahead of the gate check below, so that check tests only what
# it means to: unexported, `db`'s own `${POSTGRES_PASSWORD:?}` would be the
# first thing missing (the same file-order fact proved above) and the gate
# check would fail naming this variable instead of any gate one. Real for
# the rest of the run — the bundled `db` boots on it like any other password.
export POSTGRES_PASSWORD="smoke-test-postgres-password"

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

# --- compose.external-db.yaml starts neither db nor dump -----------------------
# The override's entire point: an install pointing at its own Postgres must
# never depend on the bundled one coming up healthy — `dump-loop.sh` refuses
# any host but `db` and would crash-loop against someone else's Postgres — so
# with the override loaded and no profile naming `bundled-db`, `db` and
# `dump` must never be created at all, not merely fail to reach healthy. Its
# own short-lived project: `compose.dev.yaml` stays in the mix so this still
# builds from the checkout rather than pulling a release, and the trap tears
# everything down again before the real stack below starts, success or fail.
#
# `app worker gate` named explicitly, `caddy` left out on purpose: `app` has
# no real Postgres to reach under this override in CI and its healthcheck
# will never turn healthy, and `caddy`'s `depends_on: app: condition:
# service_healthy` would make `up` sit and wait on exactly that before this
# check ever got to run. Nothing named here waits on anything: `app`'s own
# `db` dependency is `required: false` precisely for this override, and
# `worker` and `gate` depend on nothing at all.
log "Checking compose.external-db.yaml starts neither db nor dump"
(
  export COMPOSE_FILE="compose.yaml:compose.external-db.yaml:compose.dev.yaml"
  trap 'docker compose down -v --remove-orphans >/dev/null 2>&1 || true' EXIT
  docker compose up -d --build app worker gate
  # Containers that exist at all, running or not — `-a` is what makes this
  # "created", not merely "currently up". `--services`, not `ps db dump`: a
  # service Compose dropped for the active profile set is not a name it is
  # willing to take as an argument on every Compose version, and the thing
  # under test is what has a container, not what a literal name resolves to.
  created="$(docker compose ps -a --services)"
  if grep -Fxq db <<<"$created" || grep -Fxq dump <<<"$created"; then
    fail "compose.external-db.yaml created a container for db or dump: ${created}"
  fi
)
printf 'compose.external-db.yaml: db and dump not created\n'

# --- A fresh machine with an empty data directory ------------------------------
log "Starting from an empty data directory"
docker compose down -v --remove-orphans >/dev/null 2>&1 || true
empty_db_dir
empty_dumps_dir
docker compose up -d --build

log "Waiting for the app healthcheck"
wait_for_healthy
expect_status 200

# Proves the worker listens *in the built image*: an incomplete Dockerfile
# copy set (server/yahoo-client.ts, server/symbol-pattern.ts,
# server/price-worker.ts) dies on first import, and nothing else would catch
# it. `worker` has no `depends_on` and starts with the same `up -d --build`.
log "Waiting for the worker healthcheck"
wait_for_healthy worker

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

# The migration runner and the three modules 04 added for the price-worker
# process — the same "did the Dockerfile copy set make the cut" question,
# asked per file rather than inferred from the worker healthcheck alone.
for path in /app/server/migrate.ts /app/server/yahoo-client.ts \
  /app/server/symbol-pattern.ts /app/server/price-worker.ts; do
  run_in_image "test -f $path" || fail "missing from the runtime image: $path"
done
printf 'migration runner and price-worker modules in the image\n'

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

# And the half something reaches, proved rather than inferred: the package
# loads through a lazy `import()` on the first call, not at boot, so a healthy
# container says nothing about it. Since 06's cutover the app reaches it on no
# path at all — this is the worker's path, and the same image serves both, so
# either container proves the package is loadable where the worker will want it.
docker compose exec -T worker node -e \
  'import("yahoo-finance2").then(({default:YahooFinance})=>{process.exit(typeof new YahooFinance().quote==="function"?0:1)}).catch(()=>process.exit(1))' ||
  fail "the ESM half of yahoo-finance2 did not import and construct inside the image"
printf 'yahoo-finance2 CommonJS copy removed, ESM half loads\n'

# 06's cutover, proved at the source level a container check cannot reach: the
# app's own module graph no longer imports server/yahoo-client.ts, so its
# built server bundle should carry no trace of the package that wraps. Grepped
# against the *built* output rather than the source tree because a comment
# naming the package (price-provider.server.ts's header keeps it in prose
# only) is stripped by the build — a source grep would trip on that; a hit
# surviving into the bundle is a real import.
log "Checking the app's built bundle carries no trace of yahoo-finance2"
run_in_image '! grep -rq yahoo-finance2 /app/build/server/' ||
  fail "yahoo-finance2 is reachable from the app's own built server bundle"
printf 'app bundle: no yahoo-finance2\n'

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

# The worker has no TCP listener to publish — only the socket.
[[ "$(published_ports worker)" != *HostPort* ]] || fail "the worker port is published to the host"
printf 'worker port not published\n'

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
expect_caps dump "" 0000000000000000
expect_caps worker "" 0000000000000000
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

for service in app db caddy gate dump worker; do
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
expect_uid db 70
expect_uid caddy 65532
expect_uid gate 0
# Not a constant like the others: this service exists to hand files to the
# account that owns its directory, which on a runner is the runner's own.
expect_uid dump "$DUMP_UID"

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

for service in app db caddy gate dump worker; do
  expect_read_only_root "$service"
done

# --- The worker's volume fence, bounds and socket ------------------------------
# What proves the fence design (research note §8.5): the mount set, not the
# socket's mode, is what keeps a compromised sidecar from touching the
# worker's socket — only app and worker may mount price-worker-sock at all.
log "Checking the price-worker-sock volume fence"
for service in db dump gate caddy; do
  mount_names="$(docker inspect --format '{{range .Mounts}}{{.Name}} {{end}}' \
    "$(docker compose ps -q "$service")")" ||
    fail "could not inspect ${service}'s mounts"
  [[ "$mount_names" != *"price-worker-sock"* ]] ||
    fail "${service} mounts price-worker-sock, which only app and worker may: ${mount_names}"
done
printf 'db, dump, gate, caddy do not mount price-worker-sock\n'

# The mount set only says who is on the volume, not what they may do with it.
# `app` mounts it `:ro` (compose.yaml:267) — deleting those two characters
# leaves every check above green, because nothing until now reads app's own
# mount. `.RW` is Docker's own name for the field; false is a read-only mount.
log "Checking app's price-worker-sock mount is read-only"
app_sock_rw="$(docker inspect --format \
  '{{range .Mounts}}{{if eq .Destination "/run/price-worker"}}{{.RW}}{{end}}{{end}}' \
  "$(docker compose ps -q app)")" || fail "could not inspect app's mounts"
[[ "$app_sock_rw" == "false" ]] ||
  fail "app mounts price-worker-sock read-write (RW=${app_sock_rw:-absent}); it may only connect"
printf 'app: price-worker-sock is read-only\n'

log "Checking the worker's resource bounds"
resource_line="$(docker inspect --format '{{.HostConfig.PidsLimit}} {{.HostConfig.Memory}}' \
  "$(docker compose ps -q worker)")" || fail "could not inspect the worker's resource limits"
worker_pids="${resource_line%% *}"
worker_mem="${resource_line##* }"
# Exact, not "positive": compose.yaml sets pids_limit: 64 and mem_limit: 256m
# (268435456 bytes) precisely to stop a fork bomb or a memory balloon, and
# both of those still report as positive numbers.
[[ "$worker_pids" == "64" ]] ||
  fail "worker PidsLimit is '${worker_pids}', expected 64"
[[ "$worker_mem" == "268435456" ]] ||
  fail "worker Memory is '${worker_mem}', expected 268435456 (256m)"
printf 'worker: PidsLimit=%s Memory=%s\n' "$worker_pids" "$worker_mem"

# compose.yaml:310-315 spends six lines arguing the worker gets no
# `environment:` at all — no DATABASE_URL, no PGPASSWORD — because the
# network fence below does not cover an external Postgres reachable over the
# open internet. Asserted here so adding DATABASE_URL "for convenience" fails
# loudly instead of only ever passing.
log "Checking the worker carries no DATABASE_URL"
worker_env="$(docker inspect --format '{{json .Config.Env}}' "$(docker compose ps -q worker)")" ||
  fail "could not inspect the worker's environment"
[[ "$worker_env" != *"DATABASE_URL="* ]] ||
  fail "worker's environment carries DATABASE_URL: ${worker_env}"
printf 'worker: no DATABASE_URL\n'

# The one positive assertion the channel allows: from app, over the shared
# socket, at the mount path both sides agree on — the proof that the volume,
# the uids and the mode line up, not just that each holds in isolation.
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

# A bind mount does not change the fstype reported for the underlying
# filesystem, so tmpfs survives into the container's own /proc/mounts.
log "Checking the worker's mount of /run/price-worker is tmpfs"
mounts_line="$(docker compose exec -T worker grep ' /run/price-worker ' /proc/mounts)" ||
  fail "worker's /proc/mounts has no entry for /run/price-worker"
[[ "$mounts_line" == *" tmpfs "* ]] ||
  fail "/run/price-worker is not tmpfs in worker: ${mounts_line}"
# `*" tmpfs "*` alone also matches the device column: delete the volume's
# `o:` string (compose.yaml's price-worker-sock driver_opts) and you get a
# root-owned 1777 tmpfs of half of RAM that still binds and still passes that
# check. The kernel shows tmpfs options in a fixed order — size, mode, uid,
# gid — reproduced here with a throwaway mount:
# `tmpfs /tmp/x tmpfs rw,relatime,size=1024k,mode=770,uid=1000,gid=1000 0 0`.
# Matched one option at a time rather than as one run: the three are adjacent
# only while nothing between them is set, and `nr_inodes` prints in that gap.
for option in mode=770 uid=1000 gid=1000; do
  [[ "$mounts_line" == *"$option"* ]] ||
    fail "/run/price-worker tmpfs is missing ${option}: ${mounts_line}"
done
printf 'worker: %s\n' "$mounts_line"

# --- app, db and dump have no route out ----------------------------------------
# `backend`, `caddy-app` and `caddy-gate` are `internal: true`: no default
# route at all, so none of these three can reach the internet by any path,
# not merely a blocked one. `dump` is not a smaller case of `app` and `db` to
# skip over — it holds the whole household's history in every archive it
# writes, requirement 1 names it beside them, and it runs the identical
# `postgres:17-alpine` image as `db` (both `image: *postgres-image`), so the
# same three commands against a third service cost nothing extra to run.
log "Checking app, db and dump have no route out"

# `db` and `dump` share an image with no node, so their request is busybox's
# own `wget`; `app` has node but no `wget`, so its request goes through the
# same `fetch` its own healthcheck uses, under a 5s abort. Both forms take
# the full budget on a container with no route: the embedded resolver
# answers SERVFAIL only after it has tried, and failed, to forward the
# query upstream — never an immediate refusal.
expect_no_egress() {
  local service="$1" default_route
  if [[ "$service" == app ]]; then
    if docker compose exec -T app node -e '
      fetch("http://example.com/", { signal: AbortSignal.timeout(5000) })
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    '; then
      fail "${service} reached a public host over HTTP"
    fi
  else
    if docker compose exec -T "$service" wget -T 5 -q -O /dev/null http://example.com/; then
      fail "${service} reached a public host over HTTP"
    fi
  fi
  printf '%s: no route to a public host over HTTP\n' "$service"

  if docker compose exec -T "$service" timeout 5 nslookup example.com >/dev/null 2>&1; then
    fail "${service} resolved a public hostname"
  fi
  printf '%s: cannot resolve a public hostname\n' "$service"

  # `internal: true` drops the default route along with forwarding; a
  # `00000000` *destination* (field 2) in /proc/net/route is the kernel's own
  # record of a default route — read with awk rather than `ip route`, an
  # applet neither image needs to carry for this, and matched by column
  # rather than by substring: a direct route to the container's own subnet
  # legitimately carries `00000000` too, as its *gateway* (field 3), and a
  # plain substring match would call that a default route by mistake.
  default_route="$(docker compose exec -T "$service" \
    awk 'NR>1 && $2=="00000000" { print }' /proc/net/route)" ||
    fail "could not read ${service}'s /proc/net/route"
  [[ -z "$default_route" ]] ||
    fail "${service} has a default route: ${default_route}"
  printf '%s: no default route in /proc/net/route\n' "$service"
}

for service in app db dump; do
  expect_no_egress "$service"
done

# --- The isolation is read from the daemon's record, never provoked -----------
# `backend`, `caddy-app` and `caddy-gate` share the property under test, so
# one loop, not three copy-pasted checks. A connect would only prove the
# negative for the address it happened to pick, and would fall back to
# localhost and pass for the wrong reason if the engine ignored `isolated`
# and allocated a gateway anyway — the case this exists to catch. Read
# instead from the daemon's own IPAM record: under `isolated`, no gateway
# address is allocated *at all*, so the field is empty on an engine that
# honours it, and populated on one that silently ignores it (Engine 26, the
# floor above).
log "Checking the isolated networks were created with no gateway"
for net in backend caddy-app caddy-gate; do
  gateway="$(docker network inspect \
    -f '{{if (index .IPAM.Config 0).Gateway}}{{(index .IPAM.Config 0).Gateway}}{{end}}' \
    "portfolio_${net}")" || fail "could not inspect the ${net} network"
  [[ -z "$gateway" ]] ||
    fail "${net} has a gateway address (${gateway}) — isolated did not take"
  printf '%s: no gateway allocated\n' "$net"

  # The same fact from the other side: no bridge interface on the host
  # carries an address for this network either. `docker network inspect`'s
  # own 12-character id prefix is what `br-<id>` is built from.
  bridge_id="$(docker network inspect -f '{{slice .Id 0 12}}' "portfolio_${net}")" ||
    fail "could not read the ${net} network id"
  bridge_addr="$(ip -4 addr show dev "br-${bridge_id}" 2>&1)" ||
    fail "could not read host bridge br-${bridge_id} for ${net}: ${bridge_addr}"
  [[ "$bridge_addr" != *inet\ * ]] ||
    fail "host bridge br-${bridge_id} (${net}) carries an address: ${bridge_addr}"
  printf '%s: host bridge br-%s carries no address\n' "$net" "$bridge_id"
done

# --- The worker shares no network with app, gate or db ------------------------
# egress-worker is worker's only network; app is on backend and caddy-app,
# gate is on caddy-gate and egress-gate, db is on backend alone — none of
# them egress-worker. A connect to an unroutable address waits on the
# kernel's default (minutes), so every attempt carries its own 3s timeout —
# and never `ping`, since NET_RAW is dropped (cap_drop: ALL).
log "Checking the worker cannot reach app, gate or db"

# Space-separated, not concatenated: `{{range}}` supplies no separator of its
# own, and a service on more than one network (spec §3.6, at ticket 07 —
# the release this assertion exists for) would glue two addresses into one
# string. That string still passes the `-n` guard below and reports
# "unreachable" when probed, for the wrong reason, so every address the
# service holds gets its own probe rather than one joined string.
container_ip() {
  docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' \
    "$(docker compose ps -q "$1")"
}

# ECONNREFUSED proves a route exists to that host — the port is merely
# closed there — so it counts as reached, not unreachable. Everything else
# (no route, unresolvable name, a real timeout) counts as unreachable.
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
  # Empty output means the node script itself exited 1 (reached). Anything on
  # stdout/stderr means `docker compose exec` never got that far — a missing
  # container or a compose error should not read as a broken-isolation finding.
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

# DNS still works — until 08's allowlist.
docker compose exec -T worker timeout 5 nslookup example.com >/dev/null ||
  fail "worker cannot resolve DNS (nslookup example.com)"
printf 'worker: DNS still resolves\n'

# The residual, asserted rather than left implicit: `egress-worker` is a plain
# bridge, so unlike the three isolated networks above it *does* get a gateway,
# and that address is the host — through which `worker` reaches every host
# service bound on `0.0.0.0`, `caddy`'s published `:80` among them (research
# §1.5). That is the one path out of the fence this release does not close,
# and 08's allowlist is what closes it. Asserting it *succeeds* is what makes
# 08's own assertion mean something: without this, the check that flips to
# "refused" could pass on a release where the path never existed, and nobody
# would learn that 08 had done anything.
gateway="$(docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' portfolio_egress-worker)" ||
  fail "could not read the egress-worker gateway"
[[ -n "$gateway" ]] ||
  fail "egress-worker has no gateway — this network is meant to be a plain bridge"
if docker compose exec -T worker node -e '
  const net = require("node:net");
  const [host] = process.argv.slice(1);
  const socket = net.connect({ host, port: 80 });
  let done = false;
  const finish = (code) => {
    if (done) return;
    done = true;
    socket.destroy();
    process.exit(code);
  };
  socket.setTimeout(3000);
  socket.once("connect", () => finish(0));
  socket.once("timeout", () => finish(1));
  socket.once("error", () => finish(1));
' "$gateway"; then
  printf 'worker: reaches the egress-worker gateway on :80 (%s) — the residual, until 08\n' "$gateway"
else
  fail "worker cannot reach the egress-worker gateway ${gateway}:80 — this release does not close that path, so something else changed"
fi

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

# --- The dump service produces a verified dump --------------------------------
# The catch-up rule is what makes this cheap: an empty dumps directory at
# startup means the first dump happens within seconds of `up`, so nothing here
# waits on a schedule.
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

# The name is the contract the collector orders by, so it is asserted rather
# than eyeballed.
[[ "$dump_name" =~ ^portfolio-[0-9]{8}T[0-9]{6}Z\.dump$ ]] ||
  fail "dump is named '${dump_name}', not portfolio-YYYYMMDDTHHMMSSZ.dump"

# 0640: the dumps are the household's finances in plaintext, readable to the
# account that collects them and to nobody else.
dump_mode="$(stat -c '%a' "$dump_path")"
[[ "$dump_mode" == "640" ]] || fail "dump is mode ${dump_mode}, expected 640"

# Written only by a verified run — so its presence is the claim under test.
[[ -f "${DUMPS_DIR}/last-success.json" ]] ||
  fail "the run wrote no success marker"
grep -q "$dump_name" "${DUMPS_DIR}/last-success.json" ||
  fail "the success marker does not name ${dump_name}"
[[ -f "${dump_path}.json" ]] || fail "no sidecar json beside ${dump_name}"

# The one fact no consumer can derive, checked against the file it describes.
recorded_sha="$(sed -n 's/.*"sha256":"\([0-9a-f]*\)".*/\1/p' "${dump_path}.json")"
actual_sha="$(sha256sum "$dump_path" | cut -d' ' -f1)"
[[ "$recorded_sha" == "$actual_sha" ]] ||
  fail "sidecar json records sha ${recorded_sha}, file hashes to ${actual_sha}"
printf 'sidecar json records the archive it sits beside\n'

# The container's own view of freshness. Nothing acts on it, which is why it is
# asserted here rather than trusted to wake anyone.
# Polled, not sampled: a `no dump yet` probe that ran a moment before the
# archive was renamed leaves the service `starting` until the next interval.
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

# --- A truncated archive is refused -------------------------------------------
# The failure the whole verification step exists for: `pg_restore --list` reads
# a table of contents written at the front of the archive and passes a file
# missing almost all of its data, so the service decodes the whole thing.
docker compose run --rm -T dump verify "/dumps/${dump_name}" >/dev/null 2>&1 ||
  fail "the service refused an archive it had just written and verified"

head -c $(( $(stat -c '%s' "$dump_path") / 20 )) "$dump_path" > "${DUMPS_DIR}/truncated.bin"
if docker compose run --rm -T dump verify /dumps/truncated.bin >/dev/null 2>&1; then
  fail "a 5%%-truncated archive passed verification"
fi
printf 'a truncated archive is refused, a whole one is not\n'

# --- Retention keeps the newest and only touches its own ----------------------
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
# An operator's own `portfolio-$(date +%F).dump`, parked here before an upgrade:
# not this service's to delete.
[[ -e "${DUMPS_DIR}/portfolio-2020-01-03.dump" ]] ||
  fail "prune deleted a file it did not write"
printf 'retention: window applied, newest kept, foreign names untouched\n'
rm -f "${DUMPS_DIR}/truncated.bin" "${DUMPS_DIR}/portfolio-2020-01-03.dump"

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
