#!/bin/sh
# Startup sequence, per DESIGN.md §10.1. Each step runs to completion before the
# next begins — never concurrently, and never as a separate one-shot service.
#
#   1. Validate the environment, so a misconfigured instance fails immediately
#      and names the offending variable rather than failing hours later.
#   2. Run migrations to completion, so no request is ever served against a
#      half-migrated schema. Migrations are idempotent, so a restart is safe.
#   3. Serve.
#
# `set -e` is what makes the ordering load-bearing: either step exiting non-zero
# stops the script here, and the server is never reached.
set -eu

node ./server/validate-config.ts
node ./server/migrate.ts

exec "$@"
