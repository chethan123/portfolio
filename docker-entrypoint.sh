#!/bin/sh
# Validate, migrate, serve — in that order, each to completion (DESIGN.md §10.1).
# `set -e` is what makes the ordering load-bearing: no request ever meets a
# half-migrated schema.
set -eu

node ./server/validate-config.ts
node ./server/migrate.ts

exec "$@"
