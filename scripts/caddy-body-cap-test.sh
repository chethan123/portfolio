#!/usr/bin/env bash
# The Caddyfile's request body caps, against stub `app` and `gate` upstreams that read every byte.
# The real stack can't show them: an unauthenticated POST is redirected before its body is read.
# Needs docker and curl. Run from the repository root; smoke-test.sh runs it in CI.
set -euo pipefail

readonly RUN="caddy-body-cap-$$"
readonly CADDY_IMAGE="$(awk '$1 == "image:" && $2 ~ /^caddy:/ { print $2; exit }' compose.yaml)"
readonly STUB_IMAGE="node:24-alpine"
readonly MIB=$((1024 * 1024))

fail() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }

[[ -n "$CADDY_IMAGE" ]] || fail "no caddy image found in compose.yaml"

cleanup() {
  docker rm -f "${RUN}-caddy" "${RUN}-stub" >/dev/null 2>&1 || true
  docker network rm "$RUN" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$RUN" >/dev/null

# Both upstreams in one container: reads the whole body, answers with its length. 200 to
# forward_auth's /oauth2/auth too, so every request is admitted.
docker run -d --name "${RUN}-stub" --network "$RUN" --network-alias app --network-alias gate \
  "$STUB_IMAGE" node -e '
    const serve = (req, res) => {
      let bytes = 0;
      req.on("data", (chunk) => (bytes += chunk.length));
      req.on("end", () => res.end(String(bytes)));
      req.on("error", () => {});
    };
    for (const port of [3000, 4180]) require("http").createServer(serve).listen(port);
  ' >/dev/null

docker run -d --name "${RUN}-caddy" --network "$RUN" -p 127.0.0.1::8080 \
  -v "${PWD}/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" >/dev/null

base="http://$(docker port "${RUN}-caddy" 8080/tcp | head -n1)"
for _ in $(seq 60); do
  [[ "$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "$base/healthz" || true)" == 200 ]] && break
  sleep 0.5
done
[[ "$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "$base/healthz" || true)" == 200 ]] ||
  { docker logs "${RUN}-caddy" 2>&1 | tail -20; fail "caddy did not come up in front of the stub"; }

# expect <status> <declared|chunked> <bytes> <path>; on 200 the stub must have read every byte
expect() {
  local status="$1" framing="$2" bytes="$3" path="$4" out
  if [[ "$framing" == chunked ]]; then
    out="$(head -c "$bytes" /dev/zero | curl -sS --max-time 60 -X POST -T - -w '\n%{http_code}' "$base$path" || true)"
  else
    out="$(head -c "$bytes" /dev/zero | curl -sS --max-time 60 -X POST --data-binary @- -w '\n%{http_code}' "$base$path" || true)"
  fi
  local got="${out##*$'\n'}" read="${out%$'\n'*}"
  [[ "$got" == "$status" ]] ||
    fail "POST ${path}, ${bytes} bytes ${framing}: got ${got}, expected ${status}"
  [[ "$status" != 200 || "$read" == "$bytes" ]] ||
    fail "POST ${path}, ${bytes} bytes ${framing}: the app read ${read} bytes"
  printf 'POST %s, %s KiB %s -> %s\n' "$path" "$((bytes / 1024))" "$framing" "$got"
}

expect 200 chunked $((12 * MIB)) /upload.data
expect 200 declared $((12 * MIB)) /upload
expect 200 declared $((12 * MIB)) /upload/
expect 200 declared $((12 * MIB)) /UPLOAD
expect 413 chunked $((17 * MIB)) /upload.data
expect 413 declared $((17 * MIB)) /upload
expect 413 chunked $((2 * MIB)) /upload/1/columns.data
expect 200 chunked $((MIB / 2)) /settings/tax.data
expect 413 chunked $((2 * MIB)) /settings/tax.data
expect 413 chunked $((2 * MIB)) /uploads
expect 413 chunked $((2 * MIB)) /oauth2/sign_in
expect 413 chunked $((2 * MIB)) /healthz

printf 'Caddy caps request bodies\n'
