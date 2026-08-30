#!/bin/sh
# Startup sequence (DESIGN.md §10.1), each step to completion before the next:
#   1. Validate the environment — fail now, naming the variable.
#   2. Migrate — no request ever meets a half-migrated schema; idempotent, so
#      restarts are safe.
#   3. Serve.
# `set -e` makes the ordering load-bearing: a non-zero step stops here and the
# server is never reached.
set -eu

node ./server/validate-config.ts
node ./server/migrate.ts

exec "$@"
