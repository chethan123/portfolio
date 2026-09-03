# Would this app be better on Bun?

*Investigated 2026-09-03 against `a405806`, with Bun 1.4.0 (`34cbb9a40`) actually installed and run —
every claim below about this application's behaviour was measured, not read. Postgres 16.13 local,
`react-router` 7.18.2, React 19.2.8, Vite 7.3.6, Vitest 4.1.11, `pg` 8.23.0, Zod 4.4.3.*

The answer is no, and the interesting part is *why* no — because it is not the reason DESIGN.md §9
gave when it first rejected Bun, and it is not the reason most of the internet gives either. The
data layer, which is where this application keeps everything worth being frightened of, turns out to
be the safe part: it behaves identically. The two things that break are in the toolchain.

## The three things worth knowing without reading further

1. **The app does not boot under Bun, and the fix is a file this repo deliberately does not have.**
   React 19's `react-dom/server` exports map has a `bun` condition pointing at `server.bun.js`,
   which exports `renderToReadableStream` and **not** `renderToPipeableStream` — the one React
   Router 7's default Node server entry calls. The built server bundle dies at import with
   `SyntaxError: Export named 'renderToPipeableStream' not found`. The fix is to eject
   `app/entry.server.tsx` and rewrite it against Web streams, which was done and verified here:
   the app then serves, and the same rewritten entry is **neutral on Node** — `npm run typecheck`
   clean, 73 files and 1274 tests still passing. So this is a cost, not a wall.

2. **The test suite is the wall, and it is one upstream bug.** Under `bun --bun vitest run`,
   **60 of 73 test files fail** — every one of them at import, all with the same error:
   `undefined is not an object (evaluating 'z.object')`. Zod imports fine under plain Bun; it
   breaks only through Vite's SSR transform, which is [oven-sh/bun#39866](https://github.com/oven-sh/bun/issues/39866)
   (open, filed 2026-08-21) — Bun's SSR transform drops a module's explicit exports when the module
   also does `export *`. Three config workarounds were tried (`server.deps.inline` for zod,
   `inline` for everything, the SSR dep optimizer); none helps, because inlining pushes *more*
   modules through the broken transform. The 13 files that pass are exactly the pure-logic ones
   with no Zod anywhere in their import graph.

3. **There is no performance case for this application.** Measured on the same build, same
   database, same machine: process boot 543 ms → 370 ms, `/healthz` (one DB round trip)
   4.3 ms → 3.9 ms, the full server-rendered Overview **359 ms → 372 ms — slightly slower**,
   RSS 135 MB → 114 MB. That is the expected shape: the published throughput numbers are about
   `Bun.serve` accepting a socket, and this app would still be an existing Node HTTP app
   (`@react-router/serve`) whose request cost is Postgres round trips and React SSR. Boot time and
   ~20 MB of memory are real; throughput is not on offer.

---

## 1. What was actually run

Bun 1.4.0 installed from the npm registry, against a real Postgres 16.13 with `scram-sha-256`
authentication over TCP — the auth path most likely to expose a socket-handling difference.

| Step | Node | Bun |
|---|---|---|
| `run build` (Vite 7 + React Router 7) | ✅ | ✅ `bun --bun run build`, 76 modules, no errors |
| `server/migrate.ts` on an empty database | ✅ 11 applied | ✅ 11 applied |
| Driver-semantics probe (15 assertions, below) | ✅ 15/15 | ✅ 15/15, byte-identical output |
| Serve the built app | ✅ | ❌ → ✅ only after ejecting `entry.server.tsx` |
| `vitest run` (73 files) | ✅ 1274/1274 | ❌ 60 files fail to collect |
| `bun test` (73 files) | n/a | ❌ 614 of 1312 fail |

**One caveat on the baseline.** This container runs Node **22.22.2**, not the Node 24.12+ that
`package.json` `engines` requires. Everything passed anyway — type stripping, migrations, the whole
suite — but the Node column above is a Node 22 baseline, not the shipped one. It does not affect
any Bun-vs-Node comparison, since both columns ran the same workload on the same machine.

## 2. The data layer is not the risk

This was the surprise. `server/db.ts`'s global `pg.types.setTypeParser` registration is the single
most load-bearing coupling in the repository — every money value, every id and every calendar date
depends on it — and the expectation going in was that a runtime swap would be where it quietly
broke. It does not. A probe exercising the things this app actually relies on returned identical
results on both runtimes:

- `numeric` → string, `int8` → string, `date` → `"YYYY-MM-DD"` string, `timestamptz` → `Date`
- `numeric(19,4)` keeps its trailing zeros (`"250.0000"`) — the money-assertion contract
- `bytea` round-trips through a real `Buffer`, and `Buffer.prototype.equals` works
- `pg_try_advisory_lock` on a checked-out client, and `client.release(true)` to destroy it
- `pool.on("acquire")` / `pool.on("release")` each fire exactly once — the wiring `server/db.ts`
  depends on and `tests/pool-resilience.test.ts` guards
- Kysely over the same pool reads the migration ledger
- `AsyncLocalStorage` survives an await boundary — the seam `withDatabase` is built on
- `node:crypto` `createHash("sha256")` produces the same digest

Migrations exercise more of the same surface and pass: `scram-sha-256` auth, session advisory locks,
explicit `begin`/`commit`, and the simple-protocol multi-statement queries `server/migrations.ts`
relies on. Bun's Node-compat page lists `node:fs`, `node:net` and `node:stream` as fully
implemented, and `AsyncLocalStorage` as implemented (its `createHook` is a stub — irrelevant here,
as nothing uses it).

**`Bun.SQL` is not on the table and should not be**, which is what DESIGN.md §9 already said. Beyond
the lock-in argument it makes, `Bun.SQL` carries open and closed defects in exactly this
application's risk area — a prepared-statement cache that could return wrong rows for same-arity
different-type parameters ([#30494](https://github.com/oven-sh/bun/issues/30494), closed as not
planned), and a closed `numeric(p,s)` scale-formatting bug. Staying on `pg` + Kysely's
`PostgresDialect` is what makes the migration thinkable at all.

## 3. Blocker one: the server entry

`react-dom@19.2.8`'s `exports["./server"]` resolves the `bun` condition to `./server.bun.js`, whose
entire export list is `renderToReadableStream`, `renderToStaticMarkup`, `renderToString`, `resume`,
`version`. React Router's default Node entry — which this repo uses, having deliberately never
ejected one — calls `renderToPipeableStream`, and the built bundle references it twice.

Ejecting `app/entry.server.tsx` (via `react-router reveal`) and rewriting it against
`renderToReadableStream` fixes it. Verified after the rewrite:

- `/healthz` 200 with `{"status":"ok","database":true,"migrations":"current"}`
- `/` renders the Overview server-side (`<title>Overview · Portfolio</title>`, "Net worth" in body)
- `/settings/people`, `/settings/prices` 200; `/manifest.webmanifest` served from `build/client`

The cost is not the forty lines. It is that this repo currently owns **no** server entry, and
ejecting one means owning the streaming, bot-detection and abort-timeout logic that React Router
otherwise upgrades for you — permanently, on every future React Router major. That is a real
maintenance liability for a solo-maintained project, and it is the sort of thing DESIGN.md §9's
"fewer surprises" argument was about.

Worth separating clearly: **this change is independently safe.** It typechecks and the full suite
passes on Node with it in place. If it were ever wanted for another reason, it does not need Bun.

## 4. Blocker two: the tests, and there is no way around them

60 of 73 files fail to collect under `bun --bun vitest run`. One root cause, upstream, open,
[#39866](https://github.com/oven-sh/bun/issues/39866). Not fixable from this repository:

| Attempt | Result |
|---|---|
| `server.deps.inline: ["zod"]` | still fails |
| `server.deps.inline: [/.*/]` | still fails |
| `deps.optimizer.ssr` with zod included | still fails |

The failure is at *import*, so it is all-or-nothing per file — no partial suite, no useful signal.
And it is not a coincidence that it hits so hard here: Zod at the domain boundary is a house rule
(CLAUDE.md), so almost every module that matters has Zod in its import graph.

**`bun test` is not the escape hatch.** It runs all 73 files, and 614 of 1312 tests fail:

- **565 × `driver has already been destroyed`** — `bun test` ignores `vitest.config.ts` entirely, so
  `fileParallelism: false` does not apply. Files run against each other, and the first
  `afterAll(closeTestDatabase)` destroys the memoized Kysely instance the others are still using.
  The `test.env.DATABASE_URL` block is ignored too.
- **1 × `it.for is not a function`** — Bun's Vitest shim is missing API the suite uses. It is not
  the only gap; a missing export is a load-time failure, not a skipped test.
- It also took **246 s** against Vitest-on-Node's 50–63 s, because the parallelism it forces on a
  single shared Postgres is contention, not speed.

Porting to `bun test` therefore means redesigning the database isolation model that
`tests/support/database.ts` implements — the thing that makes 43 files able to share one Postgres —
and re-verifying 1274 assertions against a runner that silently ignores the config file. Also note
`@vitest/coverage-v8` cannot work on Bun at all (Bun is JavaScriptCore, not V8); `npm run
test:coverage` would have to move to the `istanbul` provider.

## 5. What else the migration would touch

Not blockers, but the honest size of the job:

- **`Dockerfile`.** New base image, and the three-stage prune logic is Node/npm-shaped:
  `npm prune --omit=dev`, the `node_modules/typescript` removal, and
  `scripts/prune-unreachable-deps.mjs` all assume an npm tree. `oven/bun:alpine` is ~40 MB against
  `node:24-alpine`'s ~56 MB — about 15 MB, which is not a reason to do anything.
- **The CI audit job.** `.github/workflows/ci.yml` enforces the Dockerfile's pure-JavaScript
  invariant by reading `hasInstallScript`/`os`/`cpu` out of `package-lock.json`, and separately runs
  `npm audit signatures`. Switching the package manager to `bun install` (a `bun.lock`) breaks both.
  Runtime and package manager are separable — keeping npm for installs is the sane choice — but
  then most of the advertised install-speed win is declined too.
- **`--env-file`.** Bun auto-loads `.env` and `.env.local`, so `docs/developing.md`'s documented
  trap disappears. That is a genuine small win, with a sharp edge attached: `.env.local` is skipped
  when `NODE_ENV=test`, and auto-loading interacts with Vite's own `.env.{mode}` resolution. A trap
  traded for a subtler trap.
- **`erasableSyntaxOnly`.** Bun transpiles rather than strips, so `enum`, `namespace` and parameter
  properties would work. This repo bans them (CLAUDE.md) and would go on banning them, so the
  constraint being liftable buys nothing.
- **`engines`, `HEALTHCHECK`'s `node -e`, `docker-entrypoint.sh`, README, developing.md, DESIGN.md
  §9 and §10.1** all state Node explicitly and would need rewriting.

## 6. The recommendation

**Stay on Node.** DESIGN.md §9's original reasoning — "Node is the fewer-surprises target for
software other people deploy" — survives contact with the evidence, and is now better supported
than when it was written:

- The migration's only measured *technical* wins are 170 ms of boot time and 20 MB of RSS on a
  service that one household uses. Throughput, the headline claim, is not available to this
  architecture and measured very slightly negative.
- The price is a permanently-owned `entry.server.tsx`, a test suite that cannot run until an
  upstream bug is fixed by someone else, coverage moved to a slower provider, and a rewritten
  container and CI pipeline.
- Bun 1.4.0 is itself three weeks old and, per its own README, the product of a core rewrite from
  Zig to Rust. That is not an argument that it is bad; it is an argument that this is the worst
  possible month to be an early adopter of it under a family's financial records.

**What would change the answer.** [#39866](https://github.com/oven-sh/bun/issues/39866) closing is
the single gate — with Vitest working, the remaining cost is the server entry plus container and CI
work, which is a bounded day or two rather than an open-ended one. If that lands, the honest
question to ask again is not "can we" but "for what": at that point the case would still rest on
170 ms and 20 MB.

**One thing worth stealing regardless.** Nothing here argues for ejecting `entry.server.tsx`, and
this document is not proposing it. But it is now a verified-safe change on Node if some future
requirement wants one.

## Unverified

Stated so no one treats them as checked:

- Whether `@react-router/serve` is *supported* on Bun. React Router documents Node and Cloudflare
  Workers, publishes no Bun template or adapter, and makes no statement either way. It is observed
  to work here; that is not the same as supported.
- Bun's own 1.4 release notes and first-party benchmark numbers (blocked from this session; the
  Zig→Rust claim is corroborated by the repo README, the numbers are not).
- `oven/bun:alpine`'s musl support status.
- Whether `pg`'s TLS-upgrade path trips [#32239](https://github.com/oven-sh/bun/issues/32239).
  Irrelevant to this deployment, which reaches Postgres over the compose network with no SSL
  configured anywhere, but it would matter to a self-hoster pointing `DATABASE_URL` at a managed
  database.
- [#27002](https://github.com/oven-sh/bun/issues/27002) — Vitest worker timeouts at ~60% in
  containerised CI, reported against Bun 1.3.8. Not reached here, because the suite never got far
  enough to exercise it.
