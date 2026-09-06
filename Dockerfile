# syntax=docker/dockerfile:1

# Three stages — DESIGN.md §10.1. `deps` and `build` pin $BUILDPLATFORM so they
# run natively; only `runtime` varies per target, which is what makes the arm64
# image nearly free. Rests on nothing in the production tree having a native
# binary or install script — CI's audit job fails the moment that stops holding,
# and a breach is otherwise silent: the image builds, then fails on the box that
# pulled it. Then build each platform natively, without the pins.

FROM --platform=$BUILDPLATFORM node:24-slim AS deps
WORKDIR /app

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
# Vite copies `public/` verbatim into build/client; the PWA manifest, service
# worker, icon and font have no other way in. Leaving it out 404'd all four.
COPY public ./public

RUN npm run build

# Prune, not a second `npm ci`: the production tree stays a subset of the
# one the build was verified against.
RUN npm prune --omit=dev

# `typescript` is an *optional peer* of @react-router/node and /express; npm
# installs optional peers and prune keeps them, so `tsc` would ride into an image
# specified to contain no compiler.
RUN rm -rf node_modules/typescript node_modules/.bin/tsc node_modules/.bin/tsserver

# `yahoo-finance2` declares the MCP server SDK, a Deno shim and a fetch-mocker
# among its *runtime* deps, for subpaths never touched here. The script's header
# argues why cutting exactly those edges is safe.
COPY scripts/prune-unreachable-deps.mjs ./scripts/
RUN node ./scripts/prune-unreachable-deps.mjs && rm -rf ./scripts

# `yahoo-finance2`'s CommonJS copy: everything here is ESM, so 2.7 MB nothing can
# load. Smoke asserts it is gone — the lazy import means a healthy container does not.
RUN rm -rf node_modules/yahoo-finance2/script


# Alpine, not the build stages' Debian slim: the published stage needs node and a
# POSIX sh, not a second userland of perl, bash, apt and dpkg. Node on musl is
# what the invariant above protects.
FROM node:24-alpine AS runtime
WORKDIR /app

# UTC clock + UTC storage — DESIGN.md §10.
ENV NODE_ENV=production \
    TZ=UTC \
    PORT=3000

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/package.json ./package.json

# Run under Node's type stripping, no build step (DESIGN.md §9). No `app/` here.
COPY --chown=node:node \
  server/config.ts \
  server/validate-config.ts \
  server/db.ts \
  server/migrations.ts \
  server/migrate.ts \
  server/yahoo-client.ts \
  server/symbol-pattern.ts \
  server/price-worker.ts \
  server/egress-proxy.ts \
  ./server/

# The entrypoint applies these; without them the container starts against
# whatever schema happens to be there.
COPY --chown=node:node migrations ./migrations

COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER node

EXPOSE 3000

# Also in compose.yaml, where it gates `depends_on`; here for plain `docker run`.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node_modules/.bin/react-router-serve", "./build/server/index.js"]
