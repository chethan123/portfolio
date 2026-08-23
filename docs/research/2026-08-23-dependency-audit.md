# Dependency audit

*Audited 2026-08-23 against `2cea455`. Ten runtime dependencies, ten development ones, 251 packages
installed from a 386-entry lockfile.*

Four questions, asked of every package in `package-lock.json`: is it used, is it maintained, does it
carry a known vulnerability, and is there any sign of tampering. The short version is that the
dependency *choices* are sound — nothing is unused, nothing is abandoned, nothing has an advisory —
and the one real finding is about a dependency's own dependencies rather than about anything this
repository picked.

## The three things worth knowing without reading further

1. **`yahoo-finance2` was 65% of the production tree, and none of it ran.** Version 4 declares the
   MCP server SDK, a Deno shim and a fetch-mocking library among its *runtime* dependencies, for a
   subpath and two CLI bins this application never touches. They brought a second copy of Express,
   plus Hono, jose, cors, ajv, express-rate-limit and 53 more packages into the container. Fixed:
   [§2](#2-unused-and-redundant).

2. **No vulnerabilities, and that answer is trustworthy.** `npm audit` reports zero across all 251
   installed packages, and the advisory endpoint it queries was confirmed live during the audit rather than
   assumed ([§4](#4-vulnerabilities)). Every tarball in the lockfile resolves to `registry.npmjs.org`,
   carries a `sha512` integrity hash, and has a registry signature.

3. **One deprecated package, now gone.** `tsconfck@3.1.6`, marked `unmaintained` upstream, arrived
   via `vite-tsconfig-paths` — three packages and a tsconfig parser to keep one path alias in sync.
   The alias is now written out in the two Vite configs and the plugin is removed
   ([§3](#3-deprecated-and-unmaintained)).

## Method and its limits

- Every declared dependency was traced to its import sites, then checked against the *built* server
  bundle rather than against `grep` alone — which is what saved `isbot` and `@react-router/node`
  from being called unused ([§2](#2-unused-and-redundant)).
- Reachability inside `yahoo-finance2` was established three ways: a static crawl of its ESM graph, a
  `node:module` resolution hook over a real `quote()` call, and a boot of the pruned tree serving
  live routes. All three agree.
- Registry metadata (deprecation, publish dates, maintainers, signatures) was pulled for all 338
  distinct package names directly from `registry.npmjs.org`.
- **Two checks could not run here and were moved into CI instead.** `npm audit signatures` needs
  Sigstore's TUF metadata, and `api.osv.dev` — the intended second opinion on advisories — is
  blocked by this environment's network policy. So the CVE result rests on one source
  ([§4](#4-vulnerabilities)), and signature verification is now a CI step rather than a finding.
- Postgres 16 stood in for the CI image's Postgres 17 when running the suite. Docker was
  unavailable, so the container smoke test was not run; the runtime was verified by booting the
  pruned production tree directly ([§2](#2-unused-and-redundant)).

## 1. What is here

| | Packages | Notes |
| --- | --- | --- |
| Declared runtime | 10 | all used, all current |
| Declared development | 10 → 9 | `vite-tsconfig-paths` removed |
| Installed tree | 251 | distinct `name@version`, development and production |
| Lockfile | 386 | entries, including 54 platform variants not installed here |
| Production subtree | 117 → 58 | distinct `name@version`; 183 → 124 directories on disk |

`react-router` and its three sibling packages account for the bulk of what is left, which is what a
framework costs. `pg`, `kysely` and `zod` are one package each with no transitive dependencies at
all — three of the four things the write path depends on cost nothing beyond themselves.

## 2. Unused and redundant

**No declared dependency is unused.** Two look unused and are not, which is worth recording because
the next reader will reach for `depcheck` and get the wrong answer:

- `isbot` and `@react-router/node` are imported by nothing in `app/` or `server/`. They are imported
  by the *default server entry* React Router injects when an application has no
  `app/entry.server.tsx` — this one does not. Both appear as external imports in
  `build/server/index.js`, alongside `kysely`, `pg`, `react`, `react-dom/server`, `react-router` and
  `zod`. Removing either breaks the build output, not the source tree.
- `@react-router/serve` has no import site anywhere. It is the production server binary, named in
  `package.json:11` and in the Dockerfile's `CMD`.

### The finding: `yahoo-finance2`'s dependency tree

DESIGN.md §6.1 buys one thing from `yahoo-finance2`: `quote()`, behind a deliberately narrow
interface so the library can be swapped in a day. Version 4 charges 76 of the production tree's 117
packages for it. Sixty-two of those come from a single edge:

```
yahoo-finance2@4.0.2
└─ @modelcontextprotocol/sdk@1.30.0     ← express@5, hono, jose, cors, ajv,
   ├─ express@5.2.1                        express-rate-limit, eventsource, …
   ├─ hono@4.13.3
   ├─ jose@6.2.9
   └─ express-rate-limit@8.6.2
```

The package ships an MCP server (`yahoo-finance2/mcp`) and two CLI bins alongside the library, and
declares their dependencies as hard runtime `dependencies` rather than optional peers. Three of its
seven are unreachable for a caller that only imports the library:

| Dependency | Imported only by | Verified |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | `esm/src/mcp/**`, `esm/bin/yahoo-finance-mcp.js` | static crawl + resolution hook |
| `@deno/shim-deno` | `esm/deps/jsr.io/**`, reached only from the two bins | static crawl + resolution hook |
| `fetch-mock-cache` | nothing — it appears solely inside `esm/deno.js`, a Deno import-map manifest | grep over `esm/` and `script/` |

A `node:module` resolution hook over a real `quote()` call — which got as far as Yahoo's cookie
handshake before failing on this network — resolved exactly three bare specifiers: `yahoo-finance2`,
`tough-cookie` and `tldts`. Nothing else in the subtree is ever loaded.

**This is not an exploitable vulnerability, and the report should not be read as one.** None of
these packages has an advisory, none has an install script, and none is loaded at runtime. What they
cost is a container full of dormant HTTP-server code sitting next to financial data, and a standing
triage tax: the next advisory in Express, `qs` or `ajv` lands on this project's `npm audit` even
though the code cannot run.

**Resolution.** `scripts/prune-unreachable-deps.mjs`, run in the Dockerfile's build stage after
`npm prune --omit=dev`. It marks the physical tree twice — once with those three edges intact, once
with them cut — and deletes only the difference, so it cannot remove anything still reachable
however the tree is hoisted, and removes nothing at all if a future `yahoo-finance2` starts
importing them from a path this application uses. It is not a general garbage collector: whatever
else npm leaves behind is left behind.

It removes **59 packages, 9.6 MB of files** (~18 MB of allocated blocks), plus four `node_modules/.bin`
links: one left dangling by the removal, and the three `yahoo-finance*` commands whose imports the cut
takes away. With the existing TypeScript removal that takes the image's `node_modules` from 83 MB to
42 MB. Re-running it is a no-op.

Verified by building the production tree, pruning it, and booting `react-router-serve` against a
real Postgres: `/healthz` returns `{"status":"ok","database":true,"migrations":"current"}`, and `/`,
`/holdings`, `/analysis`, `/income`, `/upload`, `/settings` and `/settings/people` all render
server-side, with `/login` redirecting as it should with the gate off. Importing `yahoo-finance2`
from the pruned tree and calling `quote()` fails at exactly the same point it does in the unpruned
tree — Yahoo's cookie handshake, which this network breaks — and not with a missing module.

`scripts/smoke-test.sh` now asserts both halves in the real image: that the six pruned packages are
absent, and that the eight the app needs are present. That is what stops the prune from silently
ceasing to fire.

**The upstream fix** is for `yahoo-finance2` to declare these as optional peer dependencies. No
issue exists for it on `gadicc/yahoo-finance2`; one is worth opening, and would make this script
deletable.

### Also redundant: `vite-tsconfig-paths`

Three packages, one of them deprecated, to read a single alias (`~/*` → `./app/*`) out of
`tsconfig.json`. It is now written out in `vite.config.ts` and `vitest.config.ts`. The mapping lives
in two places instead of one, which is the cost; see [§3](#3-deprecated-and-unmaintained) for why it
is worth paying.

## 3. Deprecated and unmaintained

One deprecated package in the whole tree:

- **`tsconfck@3.1.6`** — deprecation notice `unmaintained`, and its last release (2025-05-20) is
  also the latest, so there is no fixed version to move to. It reached the tree through
  `vite-tsconfig-paths@6.1.1`. **Removed** by dropping the plugin. A fresh `npm ci` now emits no
  deprecation warnings at all.

Nothing else is abandoned. Every direct dependency has published within the last seven months, and
the oldest packages in the tree — `ee-first`, `unpipe`, `escape-html`, a decade untouched — are the
finished single-purpose utilities under Express 4, not neglected ones.

**Versions behind.** `@types/pg` and `vitest` were behind within their own ranges and have been
refreshed (8.21.0 → 8.23.1, 4.1.10 → 4.1.11); `@types/pg` had drifted two minors behind the `pg` it
describes. Four majors are available and none is taken here:

| Package | Now | Latest | Why not now |
| --- | --- | --- | --- |
| `react-router` + siblings | 7.18.2 | 8.3.0 | A real migration. v7 still receives security patches, so this is roadmap work, not remediation. Worth noting v8 moves `@react-router/serve` onto Express 5, which would retire the Express 4 copy this project ships. |
| `vite` | 7.3.6 | 8.2.2 | `@react-router/dev@7` peers on `vite@^7`; it moves with the framework. |
| `typescript` | 5.9.3 | 7.0.2 | Independent, but a compiler major deserves its own change. |
| `@types/node` | 24.13.3 | 26.2.0 | Should track the runtime, and `engines` pins Node 24. Correct as it stands. |

## 4. Vulnerabilities

**Zero advisories across all 251 installed packages**, production and development, at every severity.

That result was checked rather than taken on faith: the same endpoint `npm audit` uses
(`registry.npmjs.org/-/npm/v1/security/advisories/bulk`) was queried directly with three known-bad
versions — `minimist@1.2.0`, `lodash@4.17.11`, `express@4.17.1` — and returned their advisories.
The endpoint is live and the zero is real, not an offline artefact.

**The one caveat.** `api.osv.dev` is blocked by this environment's network policy, so the intended
second opinion — OSV aggregates sources GitHub's database does not — could not run. Worth doing once
from an unrestricted network.

Two things that are *not* advisories but shape exposure:

- **Express 4 is shipped, twice over.** `@react-router/serve@7` pins `express@^4.19.2`, and the MCP
  subtree brought `express@5.2.1` (now pruned). Express 4 is maintained — 4.22.2 is recent — but 5
  is where the work happens, and React Router 8 is the way onto it.
- **`debug@2.6.9`, from 2017**, sits under Express 4's `send`, `body-parser`, `finalhandler`,
  `morgan` and `compression`. No advisory, and not something this project can move independently.

## 5. Supply chain

No sign of tampering, on any check available here.

**Lockfile integrity.** All 386 entries resolve to `https://registry.npmjs.org/`; all 386 carry a
`sha512` integrity hash; none is missing, none is a `file:`/`git:`/`link:` entry, and no entry
resolves to an alternate registry or a tarball URL. There is no `.npmrc` in the repository, so
nothing redirects the registry at install time.

**Install scripts.** Exactly two packages run one: `esbuild` and `fsevents`. Both are development
dependencies, both are expected (native binary selection), and neither reaches the production image.
Nothing in the production tree executes code at install time.

**Signatures and provenance.** All 369 resolved versions carry an npm registry signature. 138 also
carry a build provenance attestation, including every `@react-router/*` package, `react`,
`react-dom`, `kysely`, `zod`, `vite`, `vitest` and `yahoo-finance2`. `npm audit signatures`, which
verifies those signatures rather than merely noting their presence, needs Sigstore TUF metadata that
this environment blocks — so it is now a CI step ([§6](#6-what-changed)).

**Known campaigns.** The tree was cross-referenced against the compromised package sets from the
2025–2026 npm attacks — Shai-Hulud and its CHAINDROP and Mini-Shai-Hulud waves, the `chalk`/`debug`
maintainer phish, `axios`, `node-ipc`, `@redhat-cloud-services`, AsyncAPI, `keyv`/`cacheable`, and
the `eslint-config-prettier` wave. Eight names from the `chalk`/`debug` family are present; **none is
at a poisoned version**, and all but one are build-time only:

| Package | Installed | Poisoned | |
| --- | --- | --- | --- |
| `chalk` | 4.1.2 | 5.6.1 | dev |
| `debug` | 2.6.9, 4.4.3 | 4.4.2 | prod (Express 4) |
| `ansi-styles` | 4.3.0 | 6.2.2 | dev |
| `color-convert` | 2.0.1 | 3.1.1 | dev |
| `color-name` | 1.1.4 | 2.0.1 | dev |
| `supports-color` | 7.2.0 | 10.2.1 | dev |
| `error-ex` | 1.3.4 | 1.3.3 | dev |
| `is-arrayish` | 0.2.1 | 0.3.3 | dev |

**One thing that looks alarming and is not.** `lodash@4.18.1` — a version above the `4.17.21` that
stood unchanged for years — is a genuine 2026-04-01 release by `jdalton`, the package's long-standing
maintainer. It is a development dependency of `@react-router/dev`.

**Structural exposure.** 169 of 338 packages have a single npm maintainer, which is ordinary for
this ecosystem and is the shape most of these campaigns exploit: one phished account, one
republished version. The controls that matter against it are a committed lockfile (present),
signature verification (now in CI) and keeping the tree small — which is the second reason
[§2](#2-unused-and-redundant)'s prune is worth having.

## 6. What changed

| Change | Why |
| --- | --- |
| `vite-tsconfig-paths` removed; alias inlined in `vite.config.ts` and `vitest.config.ts` | Retires the tree's only deprecated package |
| `@types/pg` → 8.23.1, `vitest` → 4.1.11 | In-range drift; the types lagged `pg` by two minors |
| `scripts/prune-unreachable-deps.mjs`, run from the Dockerfile build stage | 59 unreachable packages out of the runtime image |
| `scripts/smoke-test.sh` asserts the prune both ways | The prune cannot silently stop working |
| CI `audit` job: `npm audit signatures`, production advisories at `--audit-level=high`, deprecations reported | Nothing checked dependencies continuously |

Verified after every step: `npm run typecheck` clean, `npm run build` clean, `npm test` 639 passing,
`npm audit` zero.

## 7. Recommended, not done

- **Open an upstream issue** on `gadicc/yahoo-finance2` asking for `@modelcontextprotocol/sdk`,
  `@deno/shim-deno` and `fetch-mock-cache` to become optional peer dependencies. That deletes
  `scripts/prune-unreachable-deps.mjs`.
- **Re-run the advisory check against OSV** from an unrestricted network, once.
- **Dependabot or Renovate**, weekly and grouped. Deliberately not added here: it changes how pull
  requests arrive in this repository, which is the owner's call rather than an audit's.
- **React Router 8** when there is appetite for it. It is the route off Express 4 and onto a tree
  with fewer moving parts.
