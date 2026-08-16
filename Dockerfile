# syntax=docker/dockerfile:1

# Three stages, per DESIGN.md §10.1.
#
#   deps    npm ci against the lockfile alone, so dependency layers cache
#           independently of source: changing a route does not reinstall.
#   build   client and server bundles, then the dev dependencies pruned away.
#   runtime node:24-slim with production dependencies and build output only —
#           no compiler, no dev dependencies, no source tree, non-root.

# ---------------------------------------------------------------- deps --------
FROM node:24-slim AS deps
WORKDIR /app

# Only the lockfile and manifest, so this layer is invalidated by a dependency
# change and by nothing else.
COPY package.json package-lock.json ./
RUN npm ci --include=dev


# --------------------------------------------------------------- build --------
FROM node:24-slim AS build
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


# ------------------------------------------------------------- runtime --------
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
# (DESIGN.md §9). This is the config gate; the migration runner joins it here.
COPY --chown=node:node server/config.ts server/validate-config.ts ./server/
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
