# syntax=docker/dockerfile:1

# Three stages, per DESIGN.md §10.1.
#
#   deps    npm ci against the lockfile alone, so dependency layers cache
#           independently of source: changing a route does not reinstall.
#   build   client and server bundles, then the dev dependencies pruned away.
#   runtime node:24-slim with production dependencies and build output only —
#           no compiler, no dev dependencies, no source tree, non-root.
#
# `deps` and `build` are pinned to $BUILDPLATFORM, so they run natively on the
# builder's own architecture instead of under emulation. Only `runtime` varies
# per target platform, and all it does is COPY and chmod. That is what makes the
# linux/arm64 image nearly free to produce: without the pins, the arm64 leg runs
# `npm ci` and the Vite build under QEMU, which is both slow and prone to
# intermittent V8 faults on the release path where nobody is watching.
#
# THE INVARIANT THIS RESTS ON: nothing in the production dependency tree has a
# native binary or a platform-specific install script, so a tree installed on
# one architecture runs on the other. That holds today — no non-dev package in
# package-lock.json declares `hasInstallScript`, `os` or `cpu`. A production
# dependency that does breaks it, and breaks it *silently*: the arm64 image
# builds and then fails at runtime on the box that pulled it. If that happens,
# drop these two pins and build each platform natively instead.

FROM --platform=$BUILDPLATFORM node:24-slim AS deps
WORKDIR /app

# Only the lockfile and manifest, so this layer is invalidated by a dependency
# change and by nothing else.
COPY package.json package-lock.json ./
RUN npm ci --include=dev


FROM --platform=$BUILDPLATFORM node:24-slim AS build
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY react-router.config.ts vite.config.ts tsconfig.json ./
COPY app ./app
COPY server ./server

RUN npm run build

# Leave behind exactly the tree the runtime stage needs. Doing it here rather
# than with a second `npm ci` keeps the stage count at three and guarantees the
# production tree is a subset of the one the build was verified against.
RUN npm prune --omit=dev

# `typescript` is an *optional peer* dependency of @react-router/node and
# @react-router/express, declared for the types they ship. npm installs optional
# peers, and `npm prune --omit=dev` keeps them, so `tsc` would otherwise ride
# into the runtime image. Nothing in either package's `dist/` references it at
# runtime. The runtime stage is specified to contain no compiler, so it goes.
RUN rm -rf node_modules/typescript node_modules/.bin/tsc node_modules/.bin/tsserver

# `yahoo-finance2` declares the MCP server SDK, a Deno shim and a fetch-mocking
# library among its runtime dependencies, for a subpath and two CLI bins this
# application never touches: DESIGN.md §6.1 buys `quote()` and nothing else.
# Between them they drag a second copy of Express, plus Hono, jose, cors, ajv
# and fifty more packages into the image, where nothing can load them. The
# script's header explains why cutting exactly those three edges is safe, and
# why it cannot remove anything that is still reachable.
COPY scripts/prune-unreachable-deps.mjs ./scripts/
RUN node ./scripts/prune-unreachable-deps.mjs && rm -rf ./scripts


FROM node:24-slim AS runtime
WORKDIR /app

# Timestamps are unambiguous because the clock is UTC and the database stores
# UTC regardless (DESIGN.md §10). Overridable via the TZ environment variable.
ENV NODE_ENV=production \
    TZ=UTC \
    PORT=3000

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/package.json ./package.json

# Operational scripts run under Node's type stripping — no build step for them
# (DESIGN.md §9): the config gate, the pool construction site they share with
# the app, and the migration runner.
COPY --chown=node:node \
  server/config.ts \
  server/validate-config.ts \
  server/db.ts \
  server/migrations.ts \
  server/migrate.ts \
  ./server/

# The database is the source of truth, so the `.sql` files ship with the image
# and the entrypoint applies them. Without this the container starts against
# whatever schema happens to be there; the smoke test asserts they are present.
COPY --chown=node:node migrations ./migrations

COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# The container is stateless: it writes nothing to its own filesystem, so it can
# be destroyed and recreated freely and Postgres is the only backup target.
USER node

EXPOSE 3000

# The healthcheck is also declared in compose.yaml, where Compose uses it to
# gate `depends_on`. Repeating it here means a plain `docker run` gets it too.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node_modules/.bin/react-router-serve", "./build/server/index.js"]
