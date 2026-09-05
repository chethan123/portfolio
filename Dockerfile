# syntax=docker/dockerfile:1

# Three stages (DESIGN.md §10.1):
#   deps    npm ci from the lockfile alone — dependency layers cache
#           independently of source.
#   build   client + server bundles, then dev dependencies pruned away.
#   runtime node:24-alpine with production deps and build output only — no
#           compiler, no source tree, non-root.
#
# `deps` and `build` pin $BUILDPLATFORM to run natively; only `runtime` varies
# per target, and it only COPYs and chmods — what makes the arm64 image nearly
# free. Unpinned, that leg runs npm ci and the Vite build under QEMU: slow,
# and prone to intermittent V8 faults on the release path nobody watches.
#
# THE INVARIANT THIS RESTS ON: nothing in the production tree has a native
# binary or platform-specific install script, so a tree installed on one
# architecture runs on the other — and a tree installed on the glibc build
# stages runs on the musl runtime below. Holds today (no non-dev package in
# package-lock.json declares `hasInstallScript`, `os` or `cpu`), and CI's
# audit job fails the moment one does. A production dependency breaking this
# breaks it *silently* — the image builds, then fails at runtime on the box
# that pulled it. If that happens, build each platform natively without the
# two pins, and give `runtime` the build stages' own base back.

FROM --platform=$BUILDPLATFORM node:24-slim AS deps
WORKDIR /app

# Lockfile and manifest only: invalidated by a dependency change, nothing else.
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
# Vite copies `public/` verbatim into build/client, and `react-router-serve`
# serves it from there — the PWA manifest, service worker, icon and font have
# no other way into the image. Every COPY here is deliberate and selective, so
# leaving this one out broke nothing at build time and 404'd all four paths in
# production, which is why the smoke test now fetches them.
COPY public ./public

RUN npm run build

# Prune here rather than a second `npm ci`: keeps three stages, and the
# production tree stays a subset of the one the build was verified against.
RUN npm prune --omit=dev

# `typescript` is an *optional peer* of @react-router/node and /express (for
# their types); npm installs optional peers and prune keeps them, so `tsc`
# would ride into an image specified to contain no compiler. Nothing in either
# package's `dist/` references it at runtime, so it goes.
RUN rm -rf node_modules/typescript node_modules/.bin/tsc node_modules/.bin/tsserver

# `yahoo-finance2` declares the MCP server SDK, a Deno shim and a fetch-mocker
# among its *runtime* deps, for a subpath and two CLI bins never touched here
# (DESIGN.md §6.1 buys `quote()` and nothing else) — dragging in a second
# Express plus Hono, jose, cors, ajv and fifty more packages nothing can load.
# The script's header explains why cutting exactly those edges is safe.
COPY scripts/prune-unreachable-deps.mjs ./scripts/
RUN node ./scripts/prune-unreachable-deps.mjs && rm -rf ./scripts

# `yahoo-finance2` ships its compiled output twice over: `esm/`, the target of
# its exports map's `import` condition, and `script/`, a CommonJS copy behind
# `require`. Everything that runs here is ESM — the app, the server bundle, the
# operational scripts — and no other package in the production tree depends on
# `yahoo-finance2`, so nothing can `require()` it and the copy is 2.7 MB
# nothing can load. The provider reaches the package through a lazy `import()`
# on the first quote refresh rather than at boot, so a healthy container proves
# nothing here: the smoke test imports the package inside the running container
# and asserts `script/` is gone.
RUN rm -rf node_modules/yahoo-finance2/script


# Alpine rather than the build stages' Debian slim: the published stage needs
# node, a POSIX sh for the entrypoint, and nothing else. Slim was carrying a
# second, larger userland — perl, bash, apt and dpkg included — into the
# container that holds the family's finances, and a quarter of every pull with
# it. The build stages stay on slim on purpose: they never ship, and their
# caches are warm. Node on musl is what the invariant above protects — pure
# JavaScript runs identically, and a native dependency is the moment to
# reassess this base.
FROM node:24-alpine AS runtime
WORKDIR /app

# UTC clock + UTC storage (DESIGN.md §10) is what keeps timestamps
# unambiguous. Overridable via TZ.
ENV NODE_ENV=production \
    TZ=UTC \
    PORT=3000

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/package.json ./package.json

# Operational scripts run under Node's type stripping, no build step
# (DESIGN.md §9): config gate, the shared pool construction site, migrations,
# and the price worker's own closure (spec 0018 §3.5) — no `app/` reaches it.
COPY --chown=node:node \
  server/config.ts \
  server/validate-config.ts \
  server/db.ts \
  server/migrations.ts \
  server/migrate.ts \
  server/yahoo-client.ts \
  server/symbol-pattern.ts \
  server/price-worker.ts \
  ./server/

# The `.sql` files ship with the image and the entrypoint applies them —
# without this the container starts against whatever schema happens to be
# there. The smoke test asserts they are present.
COPY --chown=node:node migrations ./migrations

COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Stateless: writes nothing to its own filesystem — destroy and recreate
# freely; Postgres is the only backup target.
USER node

EXPOSE 3000

# Also declared in compose.yaml (where it gates `depends_on`); repeated here
# so a plain `docker run` gets it too.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node_modules/.bin/react-router-serve", "./build/server/index.js"]
