# Dependency and CVE audit — 23 October 2026

## Decision brief

**Take a security patch update and verify the deployed Node runtime.** The committed dependency
tree has **10 distinct published CVEs** in **5 underlying packages**, shown by npm audit as
**7 package entries**. Per package entry, npm rates them 2 high and 5 moderate. Per CVE, GitHub
rates them 2 high, 7 moderate and 1 low. None is critical. Neither count is a count of
independently exploitable application vulnerabilities.

- Update Vite **7.3.6 → 7.3.7**, Vitest and its coverage provider **4.1.11 → 4.1.12**,
  and the affected transitive packages listed below. These fixes do not require a major migration.
- The production-only lockfile scan reports **2 moderate entries**, Hono and ip-address.
  Both are under Yahoo Finance's MCP SDK dependency. The Docker build explicitly cuts that
  dependency, so both are expected to be absent from the published runtime image. That is a
  source/graph assessment; an actual deployed image was not available to inspect.
- Confirm that app, worker and egress-proxy run **Node 24.22.1 or a later patched 24.x release**.
  The Node security release (published 20 October, announced 21 October) fixes issues including possible remote code execution
  through malformed Brotli data. This update is outside `npm audit`'s coverage.
  [Node 24.22.1 release](https://nodejs.org/en/blog/release/v24.22.1)
- Confirm the running authentication gate is **OAuth2 Proxy 7.15.5**, as configured.
  Releases up to 7.15.4 have two critical authentication bypasses (published 1 October);
  see [deployment components](#existing-controls-and-remaining-coverage-gaps).
- Routine updates are also available for React, Kysely, Yahoo Finance, Zod, Playwright and Node
  types. React Router 8, Vite 8, Vitest 5 and TypeScript 7 are separate migration decisions.

No dependencies, application code, deployment settings or lockfile were changed by this audit.

## Scope and evidence

Snapshot: **2026-10-23 UTC**, repository commit
`488bbecac30591d19d9fd1caeeffc03edcc5f985`.

The authorities are [package.json](../../package.json),
[package-lock.json](../../package-lock.json), the current npm registry, GitHub's reviewed
advisories, upstream advisories/release notes, and OSV's current API responses.
Earlier research reports describe their own dates and were not treated as current scan results.

There are **12 direct production dependencies**, **12 direct development dependencies**, and
**458 resolved lockfile package entries**, representing **437 distinct name/version pairs**.
The lockfile is version 3. npm classified 210 entries as production and 248 as development;
these classifications include platform/optional entries and are not a deployed image inventory.

Checks performed:

1. Full `npm audit --package-lock-only --json` against `https://registry.npmjs.org/`.
2. Production `npm audit --package-lock-only --omit=dev --json` against the same registry.
3. OSV batch queries for all 437 unique locked name/version pairs. OSV returned the same
   **10 GHSA advisories affecting 5 underlying packages** as npm's direct advisory records.
   npm adds Vitest and its coverage provider as affected dependents, producing its 7 entries.
4. GitHub advisory API verification of each CVE alias, affected range, patched version,
   publication date and exploit conditions. All ten have CVE identifiers; none were withdrawn
   in the retrieved records.
5. Current npm metadata for every direct dependency and each security patch target. Compatible
   update targets were calculated against each manifest range using npm's `semver` implementation.
6. Current registry version metadata for all 437 locked name/version pairs: **no deprecation
   notices**, and no metadata lookup failures. This is a maintenance signal, not proof of safety.
7. Source review of Docker pruning, dependency paths, application imports, test/dev settings,
   Compose images and CI's audit policy.

This checkout has **no `node_modules`**. No deployed instance was inspected.
Its audit tools were Node **22.22.1** and npm **9.2.0**. Node 22 does not meet this
project's declared `>=24.12.0` engine requirement. The checks read lockfiles and remote metadata;
they did not execute application dependencies or prove the deployed runtime version.
Docker client/daemon **29.9.2** were available; the local image inventory contained a PostgreSQL
image and no portfolio application image. No production container contents were verified.

`npm outdated --package-lock-only` lacked installed `current` values and did not provide a complete
development inventory in this environment. The inventory below instead uses locked versions plus
registry metadata and explicit semver range resolution. A manifest's minimum is not necessarily
the version running: for example, React is already locked at 19.3.0 despite a `^19.2.8` declaration.

Method references: [npm audit](https://docs.npmjs.com/cli/commands/npm-audit/),
[GitHub global advisories API](https://docs.github.com/en/rest/security-advisories/global-advisories),
[OSV batch API](https://google.github.io/osv.dev/post-v1-querybatch/).

## What the production findings mean here

The locked paths are:

```text
yahoo-finance2@4.0.2
└─ @modelcontextprotocol/sdk@1.32.1
   ├─ hono@4.13.8
   └─ express-rate-limit@8.7.0
      └─ ip-address@10.7.2
```

[Dockerfile:34](../../Dockerfile#L34) first prunes development dependencies.
[Dockerfile:45](../../Dockerfile#L45) then runs the existing
[pruning script](../../scripts/prune-unreachable-deps.mjs#L28), which cuts the MCP SDK,
the Deno shim and the fetch mocker's edges from Yahoo Finance and removes newly orphaned packages.
Traversing this lockfile's declared production dependency edges with those cuts removes both
flagged packages. [The smoke script](../../scripts/smoke-test.sh#L238) explicitly checks that
Hono and the MCP SDK are absent. It does not name ip-address or express-rate-limit in that check.
Those smoke assertions were read, not run during this audit.

[server/yahoo-client.ts:48](../../server/yahoo-client.ts#L48) imports Yahoo Finance's ordinary
client; its wrapper exposes `quote()` and `chart()`, not the MCP server.
The application runs through React Router's server, not Hono's static-file middleware.

Consequences:

- A plain production npm installation includes the two flagged packages. The custom Docker
  runtime is expected to omit them. `--omit=dev` alone does not model the custom pruning step.
- There is no demonstrated Hono static-file bypass or attacker-controlled Address6 parsing path
  in the application code reviewed. Package presence alone does not establish those conditions.
- Refresh the lockfile anyway: developer installations, build stages and any deployment that
  skips custom pruning retain this dependency tree. Recheck pruning after a Yahoo Finance update.
- Do not call the deployed image CVE-free: Node, Alpine and other containers need separate checks.

## Published npm CVEs affecting this lockfile

GitHub calls the middle severity `medium`; npm calls it `moderate`. The labels below use npm's
terminology. Missing/zero numeric CVSS fields in npm output were not interpreted as zero risk.

### Vite 7.3.6 — five CVEs; highest severity high

Direct dev dependency, also used by React Router's development/build tooling.
For **all five**, the affected Vite 7 range is **`>=7.0.0 <=7.3.6`** and the fixed release
is **7.3.7**. The current `^7.3.6` range allows that patch.

- **CVE-2026-112942 — high**, published 20 October.
  A Windows filename/existence-check bypass can combine with command escaping weaknesses to
  reach command injection without first creating the expected malicious file.
  [GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm)
- **CVE-2026-112943 — moderate**, published 20 October.
  Windows command invocation fails to escape percent signs. Exploitation involves controlled
  filenames and environment-variable content or alternate data streams; the preceding bypass
  changes the file-existence precondition.
  [GHSA-698v-4r3x-3vcv](https://github.com/advisories/GHSA-698v-4r3x-3vcv)
- **CVE-2026-112944 — moderate**, published 20 October.
  Editor arguments can become editor commands. For Vite users, the advisory requires WSL,
  a susceptible configured editor and a crafted filesystem entry.
  [GHSA-r825-w8mm-5pxw](https://github.com/advisories/GHSA-r825-w8mm-5pxw)
- **CVE-2026-112945 — low**, published 21 October.
  Malicious-origin JavaScript can execute in the dev-server origin under a particular custom
  HTML-transform setup: unchanged request URL passed to `transformIndexHtml`, inline module
  script, and sensitive state/actions available on that origin.
  [GHSA-9jrq-w75r-8gcw](https://github.com/advisories/GHSA-9jrq-w75r-8gcw)
- **CVE-2026-112946 — moderate**, published 21 October.
  On non-Windows systems, certain imported project paths can allow reading host files outside
  `server.fs.allow`. The advisory requires network exposure, a matching imported path and a
  target not blocked by `server.fs.deny`.
  [GHSA-rq7h-c2jc-7f22](https://github.com/advisories/GHSA-rq7h-c2jc-7f22)

**Repository assessment:** [vite.config.ts](../../vite.config.ts) registers React Router's plugin
and a path alias; it does not explicitly expose the server or configure custom HTML middleware.
`npm run dev` invokes framework development tooling. Plugin behavior and invocation flags can
still affect preconditions; no live exploitation test was performed.
The three Windows/editor CVEs (112942–112944) sit in Vite's **vendored copy of launch-editor**:
2.14.1 is bundled inside `dist/node/chunks/config.js`, with no lockfile entry of its own.
Vite 7.3.7 bundles 2.14.2. The advisories name Vite's ranges explicitly, so the scanners do catch
this vendored copy. The production image prunes
Vite and [its smoke assertions](../../scripts/smoke-test.sh#L232) require Vite's absence.
Patch for developer-machine security even if production does not carry it.

### source-map-js 1.2.1 — high

**CVE-2026-93749**, published 18 September. A crafted indexed source map with excessive section
offsets can block the JavaScript event loop. Affected **`>=1.0.0 <1.2.2`**;
fixed **1.2.2**. [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)

Transitive development dependency through PostCSS and Magicast. The production-only scan does
not report it. Practical exposure needs tooling to consume a malicious source map; this is a
build/development availability concern, with no reviewed portfolio HTTP route accepting source maps.
Existing parent ranges allow 1.2.2; refresh the transitive resolution.

**Bundled-copy caveat:** independent inspection of the exact locked
[Magicast 0.5.5 tarball](https://registry.npmjs.org/magicast/-/magicast-0.5.5.tgz) found an embedded
copy labeled source-map-js 1.2.1 in `dist/builders-CDdrUKLb.js`, including the unbounded indexed-map
and SourceNode code. Magicast is used by coverage tooling. Updating the separately resolved
source-map-js package does **not** rewrite these bundled bytes. This is an additional copy of the
same affected code, not another CVE or npm package flag. Reachability through Magicast's public API
or this project's coverage command was not demonstrated. Check a replacement Magicast/coverage
bundle before declaring this code fully removed. **No fixed Magicast exists yet:** 0.5.5 is the
registry's latest, and its bundled copy lacks the `isValidOffset` check that 1.2.2 adds.
Track this until upstream re-bundles. It stays a development-only concern either way.

### @vitest/mocker 4.1.11 — two moderate CVEs

- **CVE-2026-112949**, published 21 October. Unauthenticated manual mock registration can inject
  JavaScript into modules served by a Vite development server using the public mocker/interceptor
  plugins. Affected 4.x line **`>=2.1.0-beta.7 <4.1.12`**; fixed **4.1.12**.
  [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8)
- **CVE-2026-112950**, published 21 October. Windows backslash traversal bypasses the earlier
  redirect allowlist fix, permitting reads outside the allowed root through those public plugins.
  Affected 4.x release **4.1.11**; fixed **4.1.12**.
  [GHSA-xp26-3454-mjgp](https://github.com/advisories/GHSA-xp26-3454-mjgp)

Both advisories also describe affected 5.x prereleases/releases; this repo uses 4.x.
The advisory text distinguishes public plugin handlers from ordinary Node test runs; the second
also says Vitest Browser Mode does not register the vulnerable WebSocket handlers.

**Repository assessment:** [vitest.config.ts](../../vitest.config.ts) uses `environment: "node"`;
the reviewed configs do not register the public mocker/interceptor plugins. Thus the installed
version is affected, but the reported attack surface is not established for the checked-in test
setup. Upgrade **vitest and @vitest/coverage-v8 together to 4.1.12**, verifying the resolved mocker
also moves. `vitest` has a compatible caret range; **coverage is pinned to 4.1.11** and needs an
explicit manifest edit. The pins form a chain:
- Vitest 4.1.11 requires `@vitest/mocker` at exactly 4.1.11.
- Coverage 4.1.11 requires Vitest at exactly 4.1.11.

So no lockfile refresh can move the mocker until the coverage pin changes. Those dependent package
flags are not additional CVEs.

### Hono 4.13.8 — moderate, production lockfile only

**CVE-2026-111757**, published 20 October. Double decoding in `serveStatic` can serve a protected
static path without running middleware attached to that path's prefix. It stays within the
configured root; it is not an arbitrary filesystem traversal. Affected **`>=4.12.4 <4.13.11`**;
fixed **4.13.11**, latest **4.13.13**.
[GHSA-5r4p-p66f-jhc7](https://github.com/advisories/GHSA-5r4p-p66f-jhc7)

The parent SDK permits `^4.11.4`, so a patched Hono fits. No application Hono middleware/static
server was found, and custom image pruning is expected to remove it. Refresh the lockfile;
verify actual image absence if relying on pruning as the deployed disposition.

### ip-address 10.7.2 — moderate, production lockfile only

**CVE-2026-111997**, published 22 October. Some Address6 validation calls take quadratic time
on a long zone identifier containing percent signs followed by a line terminator. Parsing is
synchronous and can stall the process. Affected **`<=10.7.3`**; fixed/latest **10.7.4**.
[GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5)

The path here is MCP SDK → express-rate-limit → ip-address, not a SOCKS client.
The parent allows `^10.2.0`, so the fix fits. No direct application Address6 usage was found.
Large arbitrary input reaching an affected parser remains an exploit prerequisite; dependency
presence is insufficient. This package is also expected to disappear when the MCP subtree is cut.

## Node runtime security: outside the npm package scan

The [21 October security advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
and [24.22.1 release notes](https://nodejs.org/en/blog/release/v24.22.1) identify these Node 24 fixes:

- **High:** CVE-2026-111497, Brotli memory corruption with possible code execution when processing
  malicious compressed data; CVE-2026-105482, NUL-containing DNS input bypass;
  CVE-2026-105483 and CVE-2026-106069, TLS hostname verification failures.
- **Medium:** CVE-2026-105481, HTTP keep-alive response confusion;
  CVE-2026-106072, certificate validation for unusual IPv4 spellings;
  CVE-2026-106074, repeated crypto randomness when using startup snapshots.
- **Low:** CVE-2026-106073, permission-model `realpathSync` bypass.

Patch target: **24.22.1** on this project's Node 24 line. For the audit machine's Node 22 line,
the corresponding security release is **22.23.4**, but this project requires Node 24 or newer.
Not every listed Node 24 CVE affects Node 22.

`node:24-slim` build stages and `node:24-alpine` runtime are floating tags
([Dockerfile:10](../../Dockerfile#L10), [Dockerfile:55](../../Dockerfile#L55)). They do not show
which patch is inside an existing built image. Rebuilding with a freshly pulled base and deploying
that artifact is needed to update it. Pulling a newer application image only helps if it was rebuilt
with the patched base. These are potential runtime exposures pending image/version verification;
this audit did not demonstrate an exploitable request path for a Node CVE.

## Direct dependency inventory and available updates

All versions below were checked against npm registry metadata on the audit date. `Compatible`
means the highest published version satisfying the existing manifest range; `latest` means the
registry's stable `latest` tag, which can be a different major. Sources are each package's current
[npm registry metadata](https://registry.npmjs.org/) and the committed lockfile.

### Production dependencies

- [`@react-router/node`](https://registry.npmjs.org/%40react-router%2Fnode): locked **7.18.4**; compatible **7.18.4**; latest **8.5.0**.
- [`@react-router/serve`](https://registry.npmjs.org/%40react-router%2Fserve): locked **7.18.4**; compatible **7.18.4**; latest **8.5.0**.
- [`@simplewebauthn/browser`](https://registry.npmjs.org/%40simplewebauthn%2Fbrowser): locked **14.0.0**; compatible **14.0.0**; latest **14.0.0**.
- [`@simplewebauthn/server`](https://registry.npmjs.org/%40simplewebauthn%2Fserver): locked **14.0.3**; compatible **14.0.3**; latest **14.0.3**.
- [`isbot`](https://registry.npmjs.org/isbot): locked **5.2.2**; compatible **5.2.2**; latest **5.2.2**.
- [`kysely`](https://registry.npmjs.org/kysely): locked **0.29.6**; compatible **0.29.7**; latest **0.29.7**.
- [`pg`](https://registry.npmjs.org/pg): locked **8.23.1**; compatible **8.23.1**; latest **8.23.1**.
- [`react`](https://registry.npmjs.org/react): locked **19.3.0**; compatible **19.3.1**; latest **19.3.1**.
- [`react-dom`](https://registry.npmjs.org/react-dom): locked **19.3.0**; compatible **19.3.1**; latest **19.3.1**.
- [`react-router`](https://registry.npmjs.org/react-router): locked **7.18.4**; compatible **7.18.4**; latest **8.5.0**.
- [`yahoo-finance2`](https://registry.npmjs.org/yahoo-finance2): locked **4.0.2**; compatible **4.0.5**; latest **4.0.5**.
- [`zod`](https://registry.npmjs.org/zod): locked **4.6.5**; compatible **4.6.7**; latest **4.6.7**.

### Development dependencies

- [`@react-router/dev`](https://registry.npmjs.org/%40react-router%2Fdev): locked **7.18.4**; compatible **7.18.4**; latest **8.5.0**.
- [`@types/node`](https://registry.npmjs.org/%40types%2Fnode): locked **24.13.6**; compatible **24.19.2**; latest **26.6.5**.
- [`@types/pg`](https://registry.npmjs.org/%40types%2Fpg): locked **8.23.1**; compatible **8.23.1**; latest **8.23.1**.
- [`@types/react`](https://registry.npmjs.org/%40types%2Freact): locked **19.3.0**; compatible **19.3.0**; latest **19.3.0**.
- [`@types/react-dom`](https://registry.npmjs.org/%40types%2Freact-dom): locked **19.3.0**; compatible **19.3.0**; latest **19.3.0**.
- [`@vitest/coverage-v8`](https://registry.npmjs.org/%40vitest%2Fcoverage-v8): locked **4.1.11**; compatible **4.1.11**; latest **5.0.5**.
- [`kysely-codegen`](https://registry.npmjs.org/kysely-codegen): locked **0.20.0**; compatible **0.20.0**; latest **0.20.0**.
- [`playwright`](https://registry.npmjs.org/playwright): locked **1.63.0**; compatible **1.64.1**; latest **1.64.1**.
- [`sharp`](https://registry.npmjs.org/sharp): locked **0.35.5**; compatible **0.35.5**; latest **0.35.5**.
- [`typescript`](https://registry.npmjs.org/typescript): locked **5.9.3**; compatible **5.9.3**; latest **7.0.2**.
- [`vite`](https://registry.npmjs.org/vite): locked **7.3.6**; compatible **7.3.7**; latest **8.3.5**.
- [`vitest`](https://registry.npmjs.org/vitest): locked **4.1.11**; compatible **4.1.12**; latest **5.0.5**.

## Recommended work, in priority order

### 1. Verify and patch Node in deployed artifacts

Check app, worker and egress-proxy individually. All use the same application image in
[compose.yaml](../../compose.yaml), but a partial rollout can leave different running artifacts.
If any uses a Node 24 version older than 24.22.1, rebuild with a freshly pulled patched base,
publish the application image and roll out all three services. Keep the normal backup and smoke
checks in the existing [operations guide](../operating.md).

### 2. Apply the security patches without adopting new majors

One coherent security patch change should:

- Raise Vite's declared minimum to **7.3.7** and resolve that patch.
- Raise Vitest's declared minimum to **4.1.12** and change the coverage provider's exact pin
  to **4.1.12**. Keep their versions aligned and check the resolved `@vitest/mocker` version.
- Refresh **source-map-js to 1.2.2**, **ip-address to 10.7.4**, and **Hono to at least 4.13.11**
  (the current latest 4.13.13 fits its parent's range).
- Check coverage tooling's **bundled source-map-js copy in Magicast**, described above.
  A clean package-level scan will not demonstrate that this copy was replaced.
- Review the actual lockfile diff. Existing ranges permit these transitive fixes; a new direct
  dependency or override should not be necessary unless fresh resolution shows a constraint.
- Rerun both vulnerability scans. All ten current CVEs have patched npm releases;
  a clean result is a verification target, not a result demonstrated by this audit.
- Run `npm run typecheck`, `npm run build`, and the relevant test suite under supported Node 24
  with its test database. Run the existing container smoke workflow to exercise custom pruning
  and the Yahoo client after rebuilding.

Avoid using a forced blanket upgrade to combine remediation with framework/compiler migrations.
The pinned coverage provider means a range-preserving update alone cannot finish this patch set.

### 3. Take routine compatible updates separately

- **React and React DOM 19.3.0 → 19.3.1:** update together; verify SSR/hydration and passkey flows.
- **Kysely 0.29.6 → 0.29.7:** exercise database-backed tests, especially money/quantity queries.
- **Yahoo Finance 4.0.2 → 4.0.5:** verify `quote()` and `chart()` behavior and the existing pruning
  assumption; the provider boundary consumes externally supplied financial data.
- **Zod 4.6.5 → 4.6.7:** exercise ingest/validation boundaries.
- **Playwright 1.63.0 → 1.64.1:** update its browser installation consistently on machines used
  for capture/smoke work.
- **@types/node 24.13.6 → 24.19.2:** stay on the Node 24 type line for this deployment, even
  though the registry's latest is 26.6.5. Type declarations do not patch the Node runtime.

The scanner results establish no additional security requirement for these routine updates.
Compatibility and application behavior were not tested against the proposed newer versions.

**Zod supply-chain notice:** the maintainers' 4.6.6 notes disclose malicious source commits pushed
with a compromised Git credential, then removed. They state that those commits were **never
published to npm**. That statement is attributable to the maintainers; this audit did not independently
prove the absence of compromise. It is not evidence that this lockfile's npm release is malicious.
The same release moves array/set/map size checks ahead of element parsing, relevant to validation
costs. [Zod 4.6.6 release notes](https://github.com/colinhacks/zod/releases/tag/v4.6.6)

### 4. Treat major upgrades as separate maintenance decisions

- **React Router 7.18.4 → 8.5.0:** all four direct Router packages are already at the latest
  compatible 7.x version, and upstream still security-supports 7.x. Keep them aligned when
  evaluating a major migration.
  [Router security policy](https://github.com/remix-run/react-router/security/policy)
- **Vite 7 → 8** and **Vitest 4 → 5:** the listed security fixes have backports on the current
  majors, so neither migration is needed to remove these findings. Router 7.18.4 and Vitest 4.1.11
  already accept Vite 8 in their peer ranges; no mandatory combined Router migration is established.
  [Router dev metadata](https://registry.npmjs.org/@react-router%2fdev/7.18.4),
  [Vitest metadata](https://registry.npmjs.org/vitest/4.1.11)
- **TypeScript 5.9.3 → 7.0.2:** outside the declared range; evaluate compiler/tooling compatibility
  independently of this security patch. Router 7.18.4's TypeScript peer ranges accept 5/6, not 7,
  and this repo's [`baseUrl`](../../tsconfig.json#L16) option is removed in TypeScript 7.
  TypeScript 6 is an intermediate migration option.
  [Router dev metadata](https://registry.npmjs.org/@react-router%2fdev/7.18.4),
  [TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)

Router 8 needs particular care around request URLs: this repo's root loader checks a raw pathname
for `/unlock`, and Caddy's upload body limit names particular `.data` paths. The versioned migration
guide changes request pass-through and trailing-slash data URL behavior, so verify both the unlock
loader and upload size matcher when adopting it.
[Router 8.5.0 migration guide](https://github.com/remix-run/react-router/blob/react-router%408.5.0/docs/upgrading/v7.md),
[root loader](../../app/root.tsx#L206), [Caddy matcher](../../Caddyfile#L23)

Version availability is established by registry metadata, not a claim that any major migration
is drop-in compatible. Read the selected version's current upstream migration/release notes
before implementation.

## Existing controls and remaining coverage gaps

[CI's audit job](../../.github/workflows/ci.yml#L63) already installs with scripts disabled,
checks registry signatures, and enforces a pure-JavaScript production tree. These are useful
supply-chain controls, but they answer different questions from exploitability or runtime patching.

- The blocking command is `npm audit --omit=dev --audit-level=high`
  ([ci.yml:85](../../.github/workflows/ci.yml#L85)). The current two production findings are
  moderate, so they do not fail that gate.
- The full audit is explicitly informational: `npm audit || true`
  ([ci.yml:110](../../.github/workflows/ci.yml#L110)). The high Vite/source-map-js flags therefore
  do not fail that step. Decide whether high development advisories deserve their own blocking
  policy or a tracked, time-limited exception after assessing actual attack surfaces.
- No Dependabot/Renovate configuration or scheduled audit trigger was found under `.github`.
  Consider a scheduled dependency check: most of these advisories were published in the last
  few days and can appear while application code is unchanged. GitHub-hosted security/Dependabot
  settings were not inspected; absence of configuration does not establish that alerts are disabled.
- No container vulnerability scanner was found in the reviewed workflows. The image publishing
  step explicitly has `sbom: false` ([ci.yml:182](../../.github/workflows/ci.yml#L182)).
  A digest-specific image inventory/scan would cover a different layer from this lockfile audit.

Additional deployment components from [compose.yaml](../../compose.yaml):

- PostgreSQL and the dump client: **`postgres:17-alpine`**, a floating minor/OS image tag.
- Authentication gate: **`quay.io/oauth2-proxy/oauth2-proxy:v7.15.5-alpine`**.
- TLS/reverse proxy: **`caddy:2.11.7-alpine`**.
- App/worker/egress proxy: **`ghcr.io/chethan123/portfolio-app:${APP_VERSION:-1}`**.

These images, their operating-system packages, bundled Go/OpenSSL/Brotli libraries and the host
are not covered by the npm advisory counts. Tags alone do not identify running digests, and
source inspection cannot establish their installed CVE status. An image scan and actual deployed
version inventory remain separate verification work; no clean bill of health is implied here.

The retrieved upstream releases already match configured **OAuth2 Proxy 7.15.5** and
**Caddy 2.11.7**; no newer application release was identified for either. That does not establish
which image digest is running or whether bundled OS/Go components have outstanding advisories.
[OAuth2 Proxy release](https://github.com/oauth2-proxy/oauth2-proxy/releases/tag/v7.15.5),
[Caddy release](https://github.com/caddyserver/caddy/releases/tag/v2.11.7)

**The gate's version matters more than any npm finding here.** On 1 October OAuth2 Proxy
published three advisories, all fixed after 7.15.4:
- [GHSA-63jm-59jj-478j](https://github.com/oauth2-proxy/oauth2-proxy/security/advisories/GHSA-63jm-59jj-478j)
  (critical): authentication bypass through inconsistent skip-auth path interpretation.
- [GHSA-wr5q-7wxw-x568](https://github.com/oauth2-proxy/oauth2-proxy/security/advisories/GHSA-wr5q-7wxw-x568)
  (critical): authentication bypass through spoofed client-IP headers.
- [GHSA-hhqp-vx7f-5c6m](https://github.com/oauth2-proxy/oauth2-proxy/security/advisories/GHSA-hhqp-vx7f-5c6m)
  (medium): credential disclosure in OAuth callback error logs.

The configured 7.15.5 is patched. Any running gate still on 7.15.4 or older sits in front of the
whole app with two critical bypasses, so check the running container, not just compose.yaml.
Caddy's newest advisories
([GHSA-8qx7-j2v2-x6q5](https://github.com/caddyserver/caddy/security/advisories/GHSA-8qx7-j2v2-x6q5),
[GHSA-6365-7ppr-5r92](https://github.com/caddyserver/caddy/security/advisories/GHSA-6365-7ppr-5r92))
are fixed in 2.11.5, below the configured 2.11.7.

**PostgreSQL maintenance baseline:** current PostgreSQL 17 is **17.11**. Its security fixes include
**CVE-2026-16239** (portal row-type mismatch with possible memory disclosure/code execution),
**CVE-2026-14669** (`to_char` buffer overrun), and **CVE-2026-15741** (SQL injection through
deparsed `EXTRACT` expressions), among other issues. These are conditional checks against the
deployed database version, not findings that the current database is vulnerable. Review the full
release notes for applicable follow-up configuration/data cleanup when upgrading older instances.
[PostgreSQL 17.11 notes](https://www.postgresql.org/docs/17/release-17-11.html),
[supported versions](https://www.postgresql.org/support/versioning/)

Database and dump services share the Postgres image tag and do not set `pull_policy: always`;
an already cached tag is not guaranteed to refresh on an ordinary app upgrade. Plan their image
refresh together under the existing backup/restart procedure. Changing to Postgres 18 is a separate
data/image-layout migration, not the patch needed to stay current on 17.
[Compose pull policy](https://docs.docker.com/reference/compose-file/services/#pull_policy),
[Postgres image guidance](https://github.com/docker-library/docs/blob/master/postgres/README.md#pgdata)

CI also uses **checkout@v5** and **setup-node@v5**, while retrieved latest upstream releases are
**checkout 7.0.1** and **setup-node 7.1.0**. Review those action migrations separately; no specific
unfixed CVE in the selected floating v5 refs was established. Their maintenance differs:
- Checkout's v5 line still receives patches (v5.1.0, 20 July 2026).
- Setup-node's v5 line has had no release since v5.0.0 (September 2025), so it is effectively
  unmaintained.

Move setup-node first. Docker action refs are already on
their latest retrieved major lines. None of the eight referenced actions has a GitHub advisory.
Actions and browser binaries need maintenance beyond npm.
[Checkout releases](https://github.com/actions/checkout/releases),
[Setup-node releases](https://github.com/actions/setup-node/releases),
[workflow](../../.github/workflows/ci.yml)

### Dependencies outside package.json and compose.yaml

These are easy to miss in an npm-plus-production-compose review. None carries a known advisory
today; they are listed so the inventory is complete.

- **Base-image tags already point at patched builds.** Today, `node:24-slim` and `node:24-alpine`
  resolve to **24.22.1**, and `postgres:17-alpine` resolves to **17.11** (rebuilt 22 October).
  The work is therefore a `--pull` rebuild and image refresh, not a Dockerfile edit.
- **The BuildKit frontend `docker/dockerfile:1`** ([Dockerfile:1](../../Dockerfile#L1)) is a
  floating image tag fetched at build time.
- **A second `node:24-alpine`** is hardcoded as a test stub in
  [caddy-body-cap-test.sh:9](../../scripts/caddy-body-cap-test.sh#L9). It runs in CI through
  the smoke script and is not tied to the Dockerfile. It is test-only.
- **CI's test database** comes from [compose.test.yaml](../../compose.test.yaml)
  (`postgres:17-alpine`), not from a workflow `services:` block, so the workflow file never names it.
- **The backup container's `pg_dump`/`psql`** ([dump-loop.sh](../../scripts/dump-loop.sh)) are
  the Postgres image's own clients. They follow whatever the `17-alpine` tag resolved to when cached.
- **Playwright's Chromium** is a separate download, not an npm package. The locked Playwright
  1.63.0 expects Chromium revision 1243; 1.64.1 expects 1248. It is fetched by hand
  ([developing.md](../developing.md)) or overridden by `CHROMIUM_EXECUTABLE`, and is not run in CI.
  This machine's cache also holds a stale revision 1234, which older research harnesses hardcode.
- **Host tools** assumed unpinned on developer machines and CI runners: Docker with compose and
  buildx, `curl`, `openssl`, `bash`, `awk`, and the `ubuntu-latest` runner image.
- **No OS packages are installed** by the Dockerfile: it has no `apk` or `apt-get` step, so the
  image's OS surface is exactly that of its base images.

## Withdrawn advisories touching locked versions

The older dependency report included **braces CVE-2026-93687 / GHSA-vfj7-8cjw-p6xm**.
It reaches braces 3.0.3 as a development dependency, through kysely-codegen → micromatch.
Its current GitHub record was withdrawn on **23 October 2026** because the reported scenario was
not practically exploitable. It is absent from today's matching scanner results and excluded from
the ten active npm CVEs above. Do not introduce a downgrade or override to repair that withdrawn
finding. [Withdrawn advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)

**ip-address GHSA-p3hm-x653-5rc6** was withdrawn on 22 October as a duplicate of the
GHSA-rxp7-6hxx-x8q5 already counted above. It is not an additional finding.

## Reproduce the checks

These commands inspect the committed tree without changing its dependency files:

```sh
git rev-parse HEAD
node --version
npm --version
npm audit --package-lock-only --include=dev --json
npm audit --package-lock-only --omit=dev --json
npm outdated --package-lock-only --include=dev --json
npm view vite@7.3.7 version
npm view vitest@4.1.12 version
npm view @vitest/coverage-v8@4.1.12 version
npm view hono@4.13.11 version
npm view ip-address@10.7.4 version
npm view source-map-js@1.2.2 version
```

`npm audit` exits 1 when it finds vulnerabilities; `npm outdated` also uses a nonzero exit status
for outdated dependencies. Inspect their JSON instead of treating those exits as transport failure.
Use a supported Node 24 toolchain for subsequent implementation and validation.

For a live deployment, these read-only checks identify runtime versions:

```sh
docker compose exec -T app node --version
docker compose exec -T worker node --version
docker compose exec -T egress-proxy node --version
docker compose exec -T db postgres --version
docker compose exec -T dump pg_dump --version
docker compose images
```

Inspect the resolved app image's filesystem for Hono, ip-address and development tooling if
confirming the custom-pruning disposition. Run the established smoke script only in its intended
test deployment: it restarts services and exercises the stack, so it is not a read-only scanner.

## Limits of this result

This is a dated dependency/advisory assessment, not a penetration test, a proof of compromise,
or proof that all vulnerabilities have been discovered. npm and OSV largely share upstream
advisory data; their agreement is a useful cross-check, not independent vulnerability discovery.
The absence of findings for another package means no matching advisory was returned by these
sources for its locked version at the audit time. It does not guarantee that package is safe.

No new versions were installed, no compatibility tests were run, no application or container was
built, and registry signature verification was not rerun without an installed tree. Actual runtime
contents, installed browser binaries, image digests and OS CVEs remain unverified.

## Independent review

Separate research checked advisories/reachability and updates/runtime scope. Adversarial grounding
review corrected the direct dependency count and Docker-availability statement; both findings were
accepted. Follow-up review verified the corrections and bundled-code caveat. A final review of the
additional maintenance and supply-chain findings returned no material findings. No review findings
were rejected.

**Second independent review, same day.** Three reviewers were given the repository, not this
report's conclusions:
- **A from-scratch rescan** (npm audit and OSV over all 437 pairs, GitHub advisory records, tarball
  inspection) reproduced the same 10 CVEs. It added the vendored launch-editor note, the exact-pin
  chain behind the mocker fix, Magicast having no fixed release, and the duplicate ip-address
  withdrawal.
- **A grounding pass** found nothing materially wrong. All 24 direct-dependency rows,
  advisory metadata and external facts matched. It corrected three off-by-one line anchors,
  the Node release date and an ambiguous severity tally.
- **A non-npm dependency sweep** added the OAuth2 Proxy and Caddy advisory context, setup-node's
  unmaintained v5 line, and the section on dependencies outside package.json and compose.yaml.

All findings were accepted. "No deprecation notices" across all 437 pairs was not rerun.
