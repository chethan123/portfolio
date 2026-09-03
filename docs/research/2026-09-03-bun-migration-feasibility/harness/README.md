# Reproducing the Bun findings

Evidence for [the report](../../2026-09-03-bun-migration-feasibility.md). Nothing here is a
dependency of the application — a harness is evidence, never something the app runs.

Bun is not a dependency of this repository and must not become one. Install it somewhere else:

```sh
mkdir /tmp/bun && cd /tmp/bun && npm init -y && npm i bun
export PATH="/tmp/bun/node_modules/.bin:$PATH"
bun --revision            # the report was produced against 1.4.0+34cbb9a40
```

Everything below assumes a migrated throwaway database and is run from the repository root:

```sh
docker compose -f compose.test.yaml up -d --wait
export DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_test
npm run migrate
```

## `probe-driver.ts` — the driver-semantics comparison (§2)

Fifteen assertions covering what `server/db.ts` and the domain modules actually depend on: the
`numeric`/`int8`/`date` string parsers, `numeric(19,4)` scale, `bytea` through a `Buffer`, session
advisory locks, `client.release(true)`, the pool's `acquire`/`release` wiring, Kysely over the same
pool, `AsyncLocalStorage` across an await, and `node:crypto`'s sha256.

```sh
node ./docs/research/2026-09-03-bun-migration-feasibility/harness/probe-driver.ts
bun  ./docs/research/2026-09-03-bun-migration-feasibility/harness/probe-driver.ts
```

Both printed `ALL PASS` with identical per-assertion output. One of the fifteen
(`release(true) did not throw`) asserts only that the call returned.

## `load.mjs` — the latency numbers (§6)

Ten warm-up requests, then N timed sequential requests, mean reported. Run it under Node against
both servers so the generator is not itself part of the comparison.

```sh
npm run build
PORT=3121 node ./node_modules/.bin/react-router-serve ./build/server/index.js &
node ./docs/research/.../harness/load.mjs http://127.0.0.1:3121 /healthz 150
node ./docs/research/.../harness/load.mjs http://127.0.0.1:3121 / 40
```

For the Bun side, apply `entry.server.web-streams.tsx` first (below), rebuild with
`bun --bun run build`, and serve with `bun --bun ./node_modules/.bin/react-router-serve`.

## `entry.server.web-streams.tsx` — blocker one's fix (§3)

```sh
npx react-router reveal          # writes app/entry.server.tsx and app/entry.client.tsx
cp ./docs/research/.../harness/entry.server.web-streams.tsx app/entry.server.tsx
```

Without it, a Bun-served bundle dies at import on `renderToPipeableStream`. With it the app serves
under both runtimes; `npm run typecheck` and the whole suite stay green on Node. Delete both
generated files afterwards — this repository deliberately owns no server entry.

## Blocker two (§4) needs no harness

```sh
bun --bun ./node_modules/vitest/vitest.mjs run     # collection fails in every zod-reachable file
bun test tests/                                    # runs, but ignores vitest.config.ts
```
