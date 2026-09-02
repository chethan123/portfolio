# Security and privacy audit — 2026-09-02

## Answer first

I found **no evidence of an intentional backdoor, covert analytics, credential theft, or hidden
portfolio export** in the code reviewed. The application has one deliberate third-party data flow:
feed-backed ticker symbols are sent to Yahoo Finance for prices. It does not send quantities,
balances, names, account numbers, statement files, or database credentials in that path.

That is not the same as saying the deployment is safe under every configuration. Before entering
sensitive data, an operator should address or consciously accept these material concerns:

1. pin the application image to a reviewed release instead of the mutable, automatically pulled
   major tag;
2. replace the default database password and isolate Postgres from the ingress containers;
3. use only the complete Compose gate behind TLS, never an exposed `npm run dev` or bare app
   container;
4. encrypt the host and every copy of its database dumps;
5. decide whether disclosing the household's ticker list and request timing to Yahoo is acceptable;
6. require verified TLS if Postgres is moved off this host.

The findings below separate defects from deployment preconditions and deliberate privacy choices.
Severity describes impact if the stated precondition holds; it does not imply malicious intent.

## Scope and method

This was a static, repository-level review of the current `work` branch at commit `7d6ba5d`.

Reviewed surfaces:

- every application route and its loaders/actions;
- database access, migrations, upload/CSV handling, pricing, polling, cookies, redirects, and
  rendered HTML;
- runtime and deployment files: Compose variants, Caddy, Dockerfile, entrypoint, configuration,
  dump script, service worker, and operational guidance;
- package manifest and lockfile, dependency reachability/pruning, CI workflows, tracked artifacts,
  secret-like strings, install hooks, network-call sites, dynamic execution, and child processes;
- recent Git history and repository configuration relevant to unexpected generated or leftover
  files.

The review searched specifically for hidden network destinations, beacons, remote command paths,
unsafe dynamic code, SQL injection, XSS, open redirects, secret logging, unbounded input, missing
authorization boundaries, unsafe cookies, exposed ports, mutable executable inputs, and sensitive
data retained or copied beyond the operator's expectation. Findings were then traced to the code
that supplies the relevant value rather than inferred from names or comments alone.

`npm audit` and package-signature verification could not query the npm audit service: the registry
returned HTTP 403. The lockfile was therefore checked statically, but this audit did not independently
verify registry tarballs or scan remote container layers. Static review also cannot prove the absence
of a vulnerability in dependencies or infrastructure outside this repository.

## Findings

### S1 — High: the default deployment automatically trusts a mutable application image

**Evidence.** The production service defaults to `ghcr.io/chethan123/portfolio-app:1` and sets
`pull_policy: always`. `APP_VERSION` can select a full release, but it is not included in the
operator-facing `.env.example`. The tag named `1` can move without a change to this checkout.

**Risk.** A compromised publisher account, registry, release workflow, or later malicious release
can become code with access to the complete database on the next pull/recreate. This is an ordinary
supply-chain risk, not evidence that the current image is malicious, but automatic uptake makes its
blast radius unusually direct for financial data.

**Avoidance.** Set `APP_VERSION` to a reviewed full semantic version at minimum. Prefer an immutable
image digest and a deliberate update process that reviews release notes, backs up, updates, and
verifies the running digest. Pin the base/infrastructure images by digest as follow-up hardening.

**Evidence locations:** `compose.yaml:186-205`, `.env.example:1-14`.

### S2 — High if bypassed, otherwise accepted design: the application itself has no authorization

**Evidence.** `AUTH_GATE` only controls whether the open-instance warning is rendered. It does not
enforce authentication. Once a request reaches the React Router server, all reads and mutations are
available; routes do not apply an application identity or permission check.

The supplied Compose deployment compensates correctly: only Caddy publishes a port, `/healthz` is
the sole application route exempted from forward authentication, required OAuth values fail closed,
and the email allowlist is mounted read-only. The ungated `/oauth2/*` protocol endpoints route only
to the gate, not the application. This makes the concern conditional on bypass or misdeployment,
not a backdoor.

**Risk.** Publishing the app container, binding the development server to an untrusted network,
misrouting around Caddy, or setting `AUTH_GATE=external` without a real gate exposes the household's
entire portfolio and every write operation. All admitted email addresses are intentionally full
administrators; there is no per-person privacy boundary.

**Avoidance.** Run the complete Compose stack, expose only Caddy to a trusted LAN/VPN or correctly
configured TLS reverse proxy, keep the allowlist narrow, and test both an allowed and refused Google
account before loading real data. Treat `AUTH_GATE=external` as a display assertion, never a security
control. Do not expose `npm run dev`.

**Evidence locations:** `server/config.ts:51-64`, `app/root.tsx:37-45`,
`app/routes/settings/people.tsx:22-39`, `compose.yaml:233-318`, `compose.yaml:320-345`,
`Caddyfile:27-82`.

### S3 — Medium: known database credential and a flat service network widen a container compromise

**Evidence.** Postgres defaults to the username/password `portfolio`/`portfolio`. The app and dump
URLs use the same public default. No Compose networks are declared, so Caddy, the OAuth gate, the
app, dump, and database share the default bridge network.

**Risk.** Postgres is not published to the host, which is a strong control. However, code execution
in the LAN-facing Caddy or OAuth container can connect directly to `db:5432` with the known default
credential and read, alter, or destroy all records. Randomizing the credential alone prevents a
compromised frontend container from guessing it because that secret is supplied only to app/dump/db;
network separation further removes the route.

**Avoidance.** Generate a unique high-entropy `POSTGRES_PASSWORD`, update `DATABASE_URL` to match,
and keep `.env` out of backups/source control. Split Compose into a frontend network for
Caddy/gate/app and a backend network for app/dump/db; do not attach ingress containers to the
database network.

**Evidence locations:** `compose.yaml:46-60`, `compose.yaml:124-126`,
`compose.yaml:203-214`, `compose.yaml:320-345`.

### S4 — Medium: multipart bodies are bounded only after `formData()` buffers them

**Evidence.** Upload handling calls `request.formData()` before checking the resulting `File.size`.
An earlier guard checks a declared `Content-Length`, but a request can omit that header, as with a
chunked multipart upload.

**Risk.** A client that can reach the application can send a large or chunked multipart body and
consume process memory before the default 10 MB file limit rejects it. The OAuth gate reduces the
attacker pool but does not protect against a compromised/admitted client or an accidentally exposed
app. Repeated requests can restart or deny service to the family.

**Avoidance.** Enforce a body-size limit at Caddy and the outer reverse proxy, where the request can
be rejected before application buffering. Also adopt a streaming or framework-level hard limit in
the app so safety does not depend exclusively on deployment.

**Evidence locations:** `app/routes/upload.tsx:52-64`, `app/lib/uploads.server.ts:109-125`,
`app/lib/uploads.server.ts:150-169`.

### S5 — Medium, gate-dependent: mutations have no application-level CSRF check

**Evidence.** State-changing form actions accept POST requests without a CSRF token or validation of
`Origin`, `Referer`, or `Sec-Fetch-Site`. The bundled OAuth gate sets its encrypted cookie to
`SameSite=Lax`, which normally prevents that cookie from accompanying a cross-site form POST.

**Risk.** The bundled gate substantially mitigates classic cross-site POST CSRF. The app does not
enforce that deployment contract, though: replacing the gate with HTTP Basic authentication, a
`SameSite=None`/permissive cookie, or a same-site sibling application can make cross-origin forms
create or rename records, revise known account IDs, or trigger quote refreshes.

**Avoidance.** Keep the bundled cookie settings. Add a shared unsafe-method guard that requires an
allowed `Origin` (or a CSRF token) so alternate deployments fail safely. Do not rely on the refresh
route's `Sec-Fetch-Mode` check as a general CSRF defense; other actions do not share it.

**Evidence locations:** `compose.yaml:272-278`, `app/routes/settings/people.tsx:22-39`,
`app/routes/settings/account.tsx:32-44`, `app/routes/account.tsx:185-205`,
`app/routes/upload/review.tsx:68-96`, `app/routes/refresh.ts:35-46`.

### S6 — Medium when Postgres is remote: the documented external-database path does not require TLS

**Evidence.** The application accepts a PostgreSQL URL without enforcing an SSL mode. The operating
guide permits replacing the bundled database with a reachable PostgreSQL host but does not require
transport encryption or certificate verification.

**Risk.** If that connection crosses machines, VLANs, a data-center network, or the internet without
verified TLS, database credentials and the family's records can traverse the network in plaintext or
be exposed to an active intermediary. This does not affect the default same-host Compose bridge.

**Avoidance.** Keep Postgres local unless there is a reason not to. For a remote server, require TLS
with hostname/certificate verification and a trusted CA, restrict its firewall to the application
host, and confirm the Node `pg` connection is actually encrypted after configuration.

**Evidence locations:** `server/config.ts:37-50`, `.env.example:21-23`,
`docs/operating.md:184-197`.

### S7 — Privacy decision: ticker symbols, timing, and source IP go to Yahoo

**Evidence.** The price refresh selects every feed-backed instrument symbol and passes the symbols
to `yahoo-finance2` in batch quote calls and per-symbol history calls. The in-process poller starts
from the application root and runs periodically.

**Risk.** Yahoo and network intermediaries can observe the instance's source IP, timing, and ticker
set. Tickers alone can reveal investment interests and uncommon holdings. The reviewed path does not
include share quantities, values, people, account names/numbers, CSV content, or database
credentials. `yahoo-finance2` uses an unofficial endpoint and is itself a dependency trust boundary.

**Avoidance.** If this disclosure is unacceptable, do not configure instruments for feed pricing;
use manual/fixed values and block application egress after testing the resulting workflow. A future
privacy mode could disable the poller explicitly. Network controls must account for the fact that
Compose's default bridge permits outbound access; a comment saying a service has “no egress” is not
an enforced policy.

**Evidence locations:** `app/lib/prices.server.ts:768-795`,
`app/lib/price-provider.server.ts:600-604`, `app/lib/price-provider.server.ts:705-760`,
`app/lib/price-poller.server.ts:195-207`, `app/root.tsx:62-67`,
`docs/operating.md:606-613`, `compose.yaml:162`.

### S8 — Privacy decision: original statements and dumps are sensitive plaintext at rest

**Evidence.** A committed upload stores the original filename and raw CSV bytes in `position_set`.
Draft bytes expire after 24 hours only when a later upload invokes the sweep, so an abandoned draft
can remain indefinitely on an otherwise idle instance. Nightly PostgreSQL dumps contain this data
and are written mode `0640`; encryption is delegated to the operator's storage/backup system.

**Risk.** Brokerage exports may contain more PII than the columns the application parses, including
full account numbers. Disk theft, a host account in the dump group, an over-broad backup agent, or a
leaked archive can disclose both parsed finances and original files. This retention is deliberate
for provenance/recovery, not harvesting.

**Avoidance.** Use encrypted host storage and encrypted, access-controlled off-host backups; keep the
dump group narrow and test restore procedures. Inspect statement exports before upload. If original
files are unnecessary after reconciliation, define and implement a retention/deletion policy.

**Evidence locations:** `migrations/0001_initial_schema.sql:154-165`,
`app/lib/uploads.server.ts:1014-1022`, `app/lib/uploads.server.ts:183-214`,
`migrations/0004_upload_draft.sql:27-30`, `scripts/dump-loop.sh:20-23`,
`.env.example:108-112`.

### S9 — Low: browser hardening headers are not enforced here

No application or bundled inner Caddy policy sets CSP/frame protection, HSTS, `nosniff`, or a
referrer policy. HSTS belongs at the TLS terminator, which is intentionally outside this stack, but
frame protection and a CSP would reduce the impact of clickjacking or a future injection. Today an
outer proxy that omits `frame-ancestors`/`X-Frame-Options` can allow an authenticated screen to be
framed and visually disguised.

Add and test the headers at the proxy that owns the relevant boundary. CSP work must account for the
fixed inline service-worker registration and framework scripts rather than adding a policy that
silently breaks the app.

**Evidence locations:** `docs/operating.md:547-555`, `app/root.tsx:253-259`,
`app/routes/settings/account.tsx:123-155`.

### S10 — Low: executable supply-chain inputs are tag-pinned, not digest/SHA-pinned

Postgres and Caddy float on major tags; OAuth2 Proxy uses a full version tag; Node build/runtime
bases also use version tags. GitHub Actions use version tags rather than full commit SHAs, and the
publish job grants package-write permission. The release build disables provenance and SBOM output.

This is common configuration, not malicious code. It leaves upstream tag mutation or compromise able
to change what builds/runs without a repository diff. Pin container images by digest and Actions by
full SHA (with readable version comments), and publish provenance/SBOM artifacts where practical.

**Evidence locations:** `compose.yaml:30-46`, `compose.yaml:233-240`,
`compose.yaml:320-321`, `Dockerfile:25-33`, `Dockerfile:89`,
`.github/workflows/ci.yml:20-27`, `.github/workflows/ci.yml:158-205`.

### S11 — Low hygiene: tracked conflict leftovers expand the review surface

`app/lib/uploads.server.ts.orig`, `tests/commit-upload.test.ts.orig`, and
`test_account_comments.patch` are tracked historical leftovers. The Dockerfile's selective copies do
not make the test/patch files runtime content; the `.orig` application file is copied into the build
context's `app` directory but is not imported. No malicious content was found in them. They should
still be removed if they serve no documented archival purpose, because stale copies confuse searches
and can preserve data or code that a later change intended to remove.

**Evidence locations:** `Dockerfile:38-47`, `app/lib/uploads.server.ts.orig`,
`tests/commit-upload.test.ts.orig`, `test_account_comments.patch`.

## Important controls that are already sound

- Caddy gates every application route except a data-free health response; the ungated OAuth protocol
  paths reach only the gate. OAuth credentials and the email allowlist are required before Compose
  starts.
- App, database, dump, and gate publish no host ports. Only the inner Caddy exposes port 80.
- Runtime containers are predominantly non-root, capability-dropped, read-only, and protected with
  `no-new-privileges`; logs are size-bounded.
- The runtime Docker stage copies a narrow file set and runs the app as an unprivileged user.
- `.env`, the real email allowlist, database volume, and dumps are excluded from Git and the Docker
  build context. No committed real credential was found by the pattern scan.
- The service worker caches no responses or portfolio data; it supplies only a compiled offline page
  for failed navigation requests.
- User text is rendered through React escaping. The one application `dangerouslySetInnerHTML` value
  reviewed is a fixed service-worker registration statement, not user-controlled content.
- Kysely queries and raw SQL sites reviewed parameterize values. No credible SQL injection path was
  found. Redirect targets pass through the same-origin `safeReturn` helper.
- The production dependency tree has no install-script/platform marker according to the lockfile
  invariant enforced in CI. The Docker build removes known unreachable `yahoo-finance2` dependency
  branches before the runtime image is produced.

**Evidence locations:** `Caddyfile:27-82`, `compose.yaml:212-220`,
`compose.yaml:243-310`, `compose.yaml:338-371`, `Dockerfile:98-131`, `.gitignore:1-12`,
`.dockerignore:1-28`, `public/sw.js:1-70`, `app/root.tsx:253-259`,
`app/lib/return-path.ts:1-35`, `.github/workflows/ci.yml:77-115`,
`scripts/prune-unreachable-deps.mjs:1-31`.

## Things investigated and not promoted to vulnerabilities

- **No covert outbound destination:** runtime application egress found in source resolves to the
  Yahoo pricing client. Documentation links and CDN imports in agent-only HTML reports are not loaded
  by the application.
- **No hidden remote execution surface:** no runtime use of `eval`, `new Function`, browser beacons,
  WebSockets, `XMLHttpRequest`, or child-process execution was found. Operational shell execution is
  explicit in entrypoints/scripts.
- **No secret logging path found:** database errors are logged, but intentional printing of request
  bodies, CSV bytes, cookies, OAuth values, or unredacted database URLs was not found in runtime
  code. Demo tooling redacts URL passwords before display.
- **No application XSS found:** React escapes user-controlled names/comments/filenames; fixed inline
  scripts do not interpolate those values.
- **No public offline copy:** the service worker does not use Cache Storage or IndexedDB and does not
  cache authenticated pages.
- **Install hooks:** lockfile inspection found install hooks only in development/optional tooling
  (`esbuild` and `fsevents`), not the production dependency tree. This narrows but does not eliminate
  package-manager supply-chain risk during development.

## Safe-start checklist

- [ ] Set a reviewed full `APP_VERSION` (or digest) and record the running image digest.
- [ ] Generate a unique Postgres password; update both Compose values consistently.
- [ ] Put the host, database volume, and dump destination on encrypted storage.
- [ ] Configure a narrow Google email allowlist and high-entropy OAuth cookie secret.
- [ ] Put TLS at the outer proxy; expose the instance only to the intended LAN/VPN audience.
- [ ] Verify an allowed sign-in, a refused sign-in, and that direct app/database ports are unreachable.
- [ ] Decide whether Yahoo may receive the ticker set; use manual prices if not.
- [ ] Confirm dump ownership/mode, encrypted off-host handling, monitoring, and a restore test.
- [ ] If using remote Postgres, require verified TLS and firewall it to this host.
- [ ] Add proxy request-size limits and browser hardening headers.

## Reproducible checks run

```text
git status --short --branch
git log --oneline --decorate -20
git remote -v
find .. -name AGENTS.md -print
rg --files -g '!node_modules'
rg (targeted security/network/secret/dynamic-execution patterns across tracked source)
git ls-files (secret/conflict-artifact patterns)
node (lockfile host, integrity, lifecycle-script, and production-marker checks)
npm ls --omit=dev --all
npm audit --omit=dev --audit-level=low   # inconclusive: registry HTTP 403
npm audit signatures                    # inconclusive: registry access failure
```
