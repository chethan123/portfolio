#!/bin/sh
# Startup sequence, per DESIGN.md §10.1. Each step runs to completion before the
# next begins — never concurrently, and never as a separate one-shot service.
#
#   1. Validate the environment, so a misconfigured instance fails immediately
#      and names the offending variable rather than failing hours later.
#   2. (added by the migrations slice) Run migrations to completion, so no
#      request is ever served against a half-migrated schema.
#   3. Serve.
set -eu

node ./server/validate-config.ts

exec "$@"
