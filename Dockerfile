# Three stages (DESIGN.md §10.1):
#   deps    npm ci from the lockfile alone — dependency layers cache
#           independently of source.
#   build   client + server bundles, then dev dependencies pruned away.
#   runtime node:24-alpine with production deps and build output only — no
#           compiler, no package manager, no source tree, non-root.
#
# No `# syntax=` directive, on purpose: this file uses only what the engine's
# built-in frontend has parsed for years (`--platform`, `--from`, `--chown`),
# so the one build input BuildKit would download *and execute* by floating
# tag is never fetched. The first `--mount` or heredoc brings the directive
# back — pinned to a minor, not `:1`.
#
# The base images float on their `24` tags, also on purpose: a release is
# built once, and what it picks up is the current patched Node and Alpine.
# A digest pin would hold OpenSSL and busybox at whatever they were the day
# it was written, and nothing in this repository bumps pins.
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
# `--ignore-scripts`, for the reason CI's audit job gives: nothing here needs
# an install hook, and a release build is the last place to run a
# dependency's postinstall. The only hook in the lockfile is esbuild's, which
# hard-links its native binary over a CLI shim Vite never calls — the JS API
# resolves `@esbuild/<platform>` itself — so the output is byte-identical
# either way. Sound while the production tree stays pure JavaScript — the
# invariant above, which CI's audit job enforces by name.
RUN npm ci --include=dev --ignore-scripts


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
#
# Beside it, the files the cut edges above existed for: the two CLIs, the MCP
# transport, the Deno standard library the CLIs vendored, and an agent skill
# file — inert once their imports are gone, and dead weight in an image whose
# posture is one way in. `esm/deno.js` stays: the package's own manifest, read
# at runtime for its version string. Then the build's own scratch — npm's
# install-time inventory, written before the removals above and describing
# packages that are no longer there; Vite's temp directory; and the scope
# directories pruning emptied, which read as decoys (`@modelcontextprotocol`,
# with nothing in it) to anyone listing the image.
RUN rm -rf node_modules/yahoo-finance2/script \
      node_modules/yahoo-finance2/esm/bin \
      node_modules/yahoo-finance2/esm/src/mcp \
      node_modules/yahoo-finance2/esm/deps \
      node_modules/yahoo-finance2/skills \
      node_modules/.package-lock.json \
      node_modules/.vite-temp \
  && find node_modules -mindepth 1 -maxdepth 1 -type d -empty -delete

# The runtime reads `"type": "module"` from package.json and nothing else. The
# `scripts` block (carrying the test database's throwaway URL) and
# `devDependencies` are the development toolchain's inventory, which a public
# image has no reason to publish. Last, because `npm prune` above needs the
# dev list to know what to cut.
RUN node -e 'const fs = require("node:fs"); \
  const p = JSON.parse(fs.readFileSync("package.json", "utf8")); \
  delete p.scripts; delete p.devDependencies; \
  fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");'


# Alpine rather than the build stages' Debian slim: the published stage needs
# node and a POSIX sh for the entrypoint — busybox's, with the applets that
# come with it — and the base image's own package managers go below. Slim was
# carrying a second, larger userland — perl, bash, apt and dpkg included —
# into the container that holds the family's finances, and a quarter of every
# pull with it. The build stages stay on slim on purpose: they never ship, and
# their caches are warm. Node on musl is what the invariant above protects —
# pure JavaScript runs identically, and a native dependency is the moment to
# reassess this base.
FROM node:24-alpine AS runtime
WORKDIR /app

# UTC clock + UTC storage (DESIGN.md §10) is what keeps timestamps
# unambiguous. Overridable via TZ.
ENV NODE_ENV=production \
    TZ=UTC \
    PORT=3000

# node:24-alpine also ships npm, npx, corepack and yarn, Node's C++ headers
# and its docs. Nothing here runs any of them — the entrypoint, the CMD and
# the healthcheck are plain `node` — and a package manager beside an egress
# is a one-command loader for arbitrary published code, for whoever gets code
# execution as the app's uid. Removed for that reason and that reason only:
# this layer is a whiteout over base layers that still ship, so the pull is
# not a byte smaller. What remains is node, busybox (the `sh` the entrypoint
# and the healthcheck need) and Node's LICENSE, which travels with the
# binary. Paths spelled out: busybox's sh has no brace expansion, and
# `rm -rf` on a literal `{a,b}` removes nothing and exits 0.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /opt/yarn-v* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg \
      /usr/local/include/node /usr/local/share/doc /usr/local/share/man \
      /usr/local/bin/docker-entrypoint.sh

# Root-owned and world-readable, deliberately not `--chown=node:node`: the
# process runs as `node` and has to read its code, never rewrite it. Owned by
# the runtime uid, `/app` would turn one code-execution bug into persistence
# — a planted `migrations/9999_*.sql` runs verbatim on the next start,
# because the runner records filenames, not contents. compose.yaml's
# `read_only` closes that for the documented deployment; the ownership closes
# it for a plain `docker run` too. Nothing at runtime writes under /app.
# (`/home/node` stays the base image's, uid-1000-owned and inert: nothing
# executes from `$HOME`, and with npm gone nothing reads it.)
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./package.json

# Operational scripts run under Node's type stripping, no build step
# (DESIGN.md §9): config gate, the shared pool construction site, migrations.
COPY \
  server/config.ts \
  server/validate-config.ts \
  server/db.ts \
  server/migrations.ts \
  server/migrate.ts \
  ./server/

# The `.sql` files ship with the image and the entrypoint applies them —
# without this the container starts against whatever schema happens to be
# there. The smoke test asserts they are present.
COPY migrations ./migrations

COPY docker-entrypoint.sh ./docker-entrypoint.sh
# A no-op on a checkout that kept the file's mode, and the guard for one that
# did not (`core.fileMode=false`, a Windows clone): the bit comes from here,
# never from ownership.
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
