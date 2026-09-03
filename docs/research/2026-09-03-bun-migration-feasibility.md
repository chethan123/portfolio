# Would this app be better on Bun?

*Investigated 2026-09-03 against `a405806`, with Bun 1.4.0 (`34cbb9a40`) installed and run — the
behaviour claims in §1–§4 and §6 are measurements, reproducible from
[`harness/`](./2026-09-03-bun-migration-feasibility/harness/); §5 and the rest of §6 are read from
this repository's own files. `react-router` 7.18.2, React 19.2.8, Vite 7.3.6, Vitest 4.1.11, `pg`
8.23.0, Zod 4.4.3, against a local PostgreSQL 16.13.*

The answer is no, and the interesting part is *why* no — because it is not the reason DESIGN.md §9
gave when it first rejected Bun. §9 argued from deployment temperament and from `Bun.SQL` locking
the data layer to the runtime, and granted in passing that Bun is "faster". The data layer, which is
where this application keeps everything worth being frightened of, turns out to be the safe part:
it behaves identically, because nothing here would go near `Bun.SQL`. What breaks is the toolchain,
and the "faster" is not there either. §9's conclusion survives; two of its three premises do not.

## The three things worth knowing without reading further

1. **The app does not boot under Bun, and the fix is a file this repo deliberately does not have.**
   React 19's `react-dom/server` exports map has a `bun` condition pointing at `server.bun.js`,
   which exports `renderToReadableStream` and **not** `renderToPipeableStream` — the one React
   Router 7's default Node server entry calls. The built server bundle dies at import with
   `SyntaxError: Export named 'renderToPipeableStream' not found`. The fix is to eject
   `app/entry.server.tsx` and rewrite it against Web streams
   ([`harness/entry.server.web-streams.tsx`](./2026-09-03-bun-migration-feasibility/harness/entry.server.web-streams.tsx)),
   which was done and verified: the app then serves, and the same rewritten entry is **neutral on
   Node** — `npm run typecheck` clean, and the whole suite still passing. A cost, not a wall.

2. **The test suite is the wall, and it is one upstream bug.** Under `bun --bun vitest run`, every
   test file with Zod anywhere in its import graph fails to collect — 60 of the 73 files present at
   `a405806`. Each dies on whichever Zod member it touches first (`z.object` in most,
   `z.string` in `tests/config.test.ts`), because `z` itself is undefined. Zod imports fine under
   plain Bun; it breaks only through Vite's SSR transform. Three config workarounds were tried
   (`server.deps.inline` for zod, `inline` for everything, the SSR dep optimizer); none helps,
   because inlining pushes *more* modules through the broken transform. The 13 files that pass are
   exactly the pure-logic ones that never reach Zod. Since Zod at the domain boundary is a house
   rule (CLAUDE.md), that split is not luck — it is the architecture.

3. **There is no performance case for this application.** Measured on the same build, same
   database, same machine: process boot 543 ms → 370 ms, `/healthz` (one DB round trip)
   4.3 ms → 3.9 ms, the full server-rendered Overview **359 ms → 372 ms — slightly slower**,
   RSS 135 MB → 114 MB. This app's request cost is Postgres round trips and React SSR, and under
   Bun it would still be an existing Node HTTP app behind `@react-router/serve` rather than a
   rewrite onto `Bun.serve`. Boot time and ~20 MB of memory are real; throughput is not on offer.

---

## 1. What was actually run

Bun 1.4.0 installed from the npm registry, against a real Postgres with `scram-sha-256`
authentication over TCP — the auth path most likely to expose a socket-handling difference.

| Step | Node | Bun |
|---|---|---|
| `run build` (Vite 7 + React Router 7) | ✅ | ✅ `bun --bun run build`, no errors |
| `server/migrate.ts` on an empty database | ✅ | ✅ same migrations applied |
| Driver-semantics probe (§2) | ✅ all pass | ✅ all pass, identical per-assertion output |
| Serve the built app | ✅ | ❌ → ✅ only after ejecting `entry.server.tsx` |
| `vitest run` | ✅ every file, every case | ❌ 60 of 73 files fail to collect |
| `bun test` | n/a | ❌ roughly half of all cases fail |

**Two caveats on the baseline, because neither is the environment this ships to.**

- This container runs Node **22.22.2**, not the Node 24.12+ that `package.json` `engines` requires.
  Everything passed anyway — type stripping, migrations, the whole suite.
- Postgres here is **16.13**, where `compose.test.yaml` and `compose.yaml` both pin
  `postgres:17-alpine`. So §2's driver probe — the entire basis for "the data layer is not the
  risk" — ran one major version behind what CI tests and what the deployment runs.

Neither weakens a Bun-vs-Node *comparison*, since both columns ran the same workload on the same
machine. Both would matter if anything here were read as a statement about the shipped stack.

## 2. The data layer is not the risk

This was the surprise. `server/db.ts`'s global `pg.types.setTypeParser` registration is the single
most load-bearing coupling in the repository — every money value, every id and every calendar date
depends on it — and the expectation going in was that a runtime swap would be where it quietly
broke. It does not. The probe exercises what this app actually relies on and returns identical
results on both runtimes:

- `numeric` → string, `int8` → string, `date` → `"YYYY-MM-DD"` string, `timestamptz` → `Date`
- `numeric(19,4)` keeps its trailing zeros — the money-assertion contract
- `bytea` round-trips through a real `Buffer`, and `Buffer.prototype.equals` works
- `pg_try_advisory_lock` on a checked-out client, and `client.release(true)` to destroy it
- `pool.on("acquire")` and `pool.on("release")` each fire — the wiring `server/db.ts` installs its
  per-client error listener through
- Kysely over the same pool reads the migration ledger
- `AsyncLocalStorage` survives an await boundary — the seam `withDatabase` is built on
- `node:crypto` `createHash("sha256")` produces the same digest

Migrations exercise more of the same surface and pass: `scram-sha-256` auth, session advisory locks,
explicit `begin`/`commit`, and the simple-protocol multi-statement queries `server/migrations.ts`
relies on. Bun's Node-compatibility page lists `node:fs`, `node:net` and `node:stream` as fully
implemented, and `AsyncLocalStorage` as implemented — its `createHook` is a stub, which is
irrelevant here because nothing uses it.

**`Bun.SQL` is not on the table and should not be**, which is what DESIGN.md §9 already said. Beyond
the lock-in argument it makes, `Bun.SQL` carries reported defects in exactly this application's risk
area — a prepared-statement cache that could return wrong rows for same-arity different-type
parameters ([#30494](https://github.com/oven-sh/bun/issues/30494)), and a `numeric(p,s)`
scale-formatting bug ([#29772](https://github.com/oven-sh/bun/issues/29772)). Staying on `pg` and
Kysely's `PostgresDialect` is what makes the migration thinkable at all, and it is why §2 and the
`Bun.SQL` warning are not in tension: they are different components, and only one of them would
ever be loaded.

## 3. Blocker one: the server entry

`react-dom@19.2.8`'s `exports["./server"]` resolves the `bun` condition to `./server.bun.js`, whose
entire export list is `version`, `renderToReadableStream`, `resume`, `renderToString`,
`renderToStaticMarkup`. React Router's default Node entry — which this repo uses, having
deliberately never ejected one — calls `renderToPipeableStream`, and the built bundle references it.

Ejecting `app/entry.server.tsx` (via `react-router reveal`) and rewriting it against
`renderToReadableStream` fixes it. Verified after the rewrite: `/healthz` 200 with a well-formed
body, `/` server-rendering the Overview, `/settings/people` and `/settings/prices` 200, and
`build/client`'s static assets served.

The cost is not the forty lines. It is that this repo currently owns **no** server entry, and
ejecting one means owning the streaming, bot-detection and abort-timeout logic that React Router
otherwise upgrades for you — permanently, on every future React Router major. That is a real
maintenance liability for a solo-maintained project, and it is the sort of thing DESIGN.md §9's
"fewer surprises" argument was about.

Worth separating clearly: **this change is independently safe.** It typechecks and the full suite
passes on Node with it in place. If it were ever wanted for another reason, it does not need Bun.

## 4. Blocker two: the tests, and there is no way around them

One root cause, upstream, not fixable from this repository:
[oven-sh/bun#39866](https://github.com/oven-sh/bun/issues/39866). Zod's entry point is a star
re-export plus an explicit named export — `export * from "./v4/classic/external.js"; export { z }` —
and it is precisely `z` that comes back undefined through Bun's Vite SSR transform.

| Attempt | Result |
|---|---|
| `server.deps.inline: ["zod"]` | still fails |
| `server.deps.inline: [/.*/]` | still fails |
| `deps.optimizer.ssr` with zod included | still fails |

The failure is at *import*, so it is all-or-nothing per file — no partial suite, no useful signal.

**`bun test` is not the escape hatch.** It runs every file and roughly half the cases fail. The
dominant cause, 565 of them, is `driver has already been destroyed`: `bun test` ignores
`vitest.config.ts` entirely, so `fileParallelism: false` never applies, files run against each
other, and the first `afterAll(closeTestDatabase)` destroys the memoized Kysely instance the others
are still using. `test.env.DATABASE_URL` is ignored too. The rest are a mix of assertion failures
and API gaps — `it.for` is not implemented, and a missing member is a load-time failure rather than
a skipped test. The run also took **246 s** against Vitest-on-Node's 50–63 s, because the
parallelism it forces on a single shared Postgres is contention, not speed. The two runners do not
report the same case count, so the totals are not directly comparable and no delta is claimed here.

Porting to `bun test` therefore means redesigning the database isolation model that
`tests/support/database.ts` implements — the thing that lets every database test file share one
Postgres — and re-verifying the whole suite against a runner that silently ignores the config file.
Separately, `@vitest/coverage-v8` cannot work on Bun at all, since Bun is JavaScriptCore rather than
V8; `npm run test:coverage` would have to move to the `istanbul` provider.

## 5. What else the migration would touch

Read from the repository rather than measured. Not blockers, but the honest size of the job:

- **`Dockerfile`.** New base image, and the three-stage prune logic is Node/npm-shaped:
  `npm prune --omit=dev`, the `node_modules/typescript` removal, and
  `scripts/prune-unreachable-deps.mjs` all assume an npm tree. Docker Hub's compressed amd64 sizes
  put `oven/bun:alpine` at about 40 MB against `node:24-alpine`'s 56 MB — around 15 MB, which is
  not a reason to do anything, and see the Unverified note on musl before believing the alpine tag
  is the right comparison at all.
- **The CI audit job.** `.github/workflows/ci.yml` enforces the Dockerfile's pure-JavaScript
  invariant by reading `hasInstallScript`/`os`/`cpu` out of `package-lock.json`, and separately runs
  `npm audit signatures`. Switching the package manager to `bun install` (a `bun.lock`) breaks both.
  Runtime and package manager are separable — keeping npm for installs is the sane choice — but
  then most of the advertised install-speed win is declined too.
- **`--env-file`.** Bun auto-loads `.env` and `.env.local`, so `docs/developing.md`'s documented
  trap disappears. That is a genuine small win, with a sharp edge attached: `.env.local` is skipped
  when `NODE_ENV=test`, and auto-loading interacts with Vite's own `.env.{mode}` resolution. Both
  behaviours were confirmed by running them. A trap traded for a subtler trap.
- **`erasableSyntaxOnly`.** Bun transpiles rather than strips, so `enum`, `namespace` and parameter
  properties would work. This repo bans them (CLAUDE.md) and would go on banning them, so the
  constraint being liftable buys nothing.
- **`engines`, `HEALTHCHECK`'s `node -e`, `docker-entrypoint.sh`, README, developing.md, DESIGN.md
  §9 and §10.1** all state Node explicitly and would need rewriting.

## 6. The recommendation

**Stay on Node.** DESIGN.md §9's conclusion — "Node is the fewer-surprises target for software other
people deploy" — survives contact with the evidence, though its supporting sentence that Bun is
"faster" does not survive §6's measurements and should be read as unproven for this workload:

- The only measured wins are 170 ms of boot time and 20 MB of RSS on a service one household uses.
  Throughput is not available to this architecture and measured very slightly negative.
- The price is a permanently-owned `entry.server.tsx`, a test suite that cannot run until an
  upstream bug is fixed by someone else, coverage moved to a slower provider, and a rewritten
  container and CI pipeline.
- Bun 1.4.0 is two weeks old at the time of writing. That is not an argument that it is bad; it is
  an argument against being an early adopter of a two-week-old runtime under a family's financial
  records, when the upside is 170 ms and 20 MB.

**What would change the answer.** [#39866](https://github.com/oven-sh/bun/issues/39866) closing is
the single gate — with Vitest working, the remaining cost is the server entry plus container and CI
work, which is a bounded day or two rather than an open-ended one. If that lands, the honest
question to ask again is not "can we" but "for what": the case would still rest on 170 ms and 20 MB.

**One thing worth stealing regardless.** Nothing here argues for ejecting `entry.server.tsx`, and
this document does not propose it. But it is a verified-safe change on Node, and it is kept in
[`harness/`](./2026-09-03-bun-migration-feasibility/harness/) so a future requirement that wants a
server entry does not start from scratch.

## Unverified

Stated so no one treats them as checked:

- **The GitHub issues cited above were read during a research pass, not re-read while this document
  was written**, and github.com was unreachable from the session that reviewed it. Numbers, states
  and titles should be re-checked before anyone acts on them. #39866's *effect* is not in doubt —
  it was reproduced here directly, and the mechanism was confirmed against Zod's own entry point —
  but its number and status are second-hand.
- Whether `@react-router/serve` is *supported* on Bun. React Router documents Node and Cloudflare
  Workers, publishes no Bun template or adapter, and makes no statement either way. It is observed
  to work here; that is not the same as supported.
- Bun's own release notes and first-party benchmark numbers, which were unreachable. §6's claim
  about throughput is grounded in the measurements taken here and in this app's architecture, not
  in a comparison against any published figure.
- `oven/bun:alpine`'s musl support status, and therefore whether the ~15 MB image comparison in §5
  is between like and like.
- Whether `pg`'s TLS-upgrade path trips [#32239](https://github.com/oven-sh/bun/issues/32239).
  Irrelevant to this deployment, which reaches Postgres over the compose network with no SSL
  configured anywhere, but it would matter to a self-hoster pointing `DATABASE_URL` at a managed
  database.
- [#27002](https://github.com/oven-sh/bun/issues/27002) — Vitest worker timeouts in containerised
  CI. Not reached here, because the suite never got far enough to exercise it.
