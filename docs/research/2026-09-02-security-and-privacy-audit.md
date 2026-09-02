# Security and privacy audit

*Audited 2026-09-02 against `7d6ba5d` (`main`). A static review of the repository and its bundled
deployment, first issued as pull request #219 and corrected in review; thirteen findings, eleven
from the first draft and two the review added (S12, S13).*

None of the findings is a backdoor. The application has two deliberate third-party flows —
feed-backed symbols to Yahoo for prices, and the signing-in address to Google through the gate —
and one incidental flow inside the pricing client that the first draft missed. It sends quantities,
balances, names, account numbers, statement files and database credentials nowhere.

## The three things worth knowing without reading further

1. **No evidence of an intentional backdoor, covert analytics, credential theft or hidden portfolio
   export.** Runtime egress in application code resolves to the Yahoo pricing client; there is no
   dynamic execution, no child process, no XSS, and every SQL value is bound (§"Controls verified").
   The one code defect found is a dot-segment bypass in `safeReturn` that yields a protocol-relative
   redirect (S12): low impact behind the gate, a two-line fix.

2. **Most of the risk is deployment posture, and most of that is already a recorded decision.** No
   authorisation inside the app (ADR-0005), plaintext dumps (ADR-0009), a floating image tag
   (`DESIGN.md:870-872`), symbols to Yahoo (`docs/operating.md:606-613`). This audit does not
   overturn those decisions. It states what each costs and where the operator's compensating
   control has to sit, and where it disagrees it cites the record it disagrees with.

3. **Three things are cheap and not done.** A unique database password on a split network (designed
   already in spec 0015, S3); `sslmode=verify-full` in the one documented remote-Postgres recipe
   (S6); and `versionCheck: false` on the pricing client, so a malformed Yahoo response cannot
   reach the npm registry (S7).

Before entering sensitive data, an operator should address or consciously accept:

1. pin `APP_VERSION` to a reviewed full version or digest instead of the floating major (S1);
2. replace the default database password — with `alter role` on an instance that has already
   started — and split Compose into a frontend and a backend network (S3);
3. run only the complete Compose stack behind TLS, never an exposed `npm run dev` or a bare `app`
   container (S2);
4. put the host and every copy of its dumps on encrypted storage (S8);
5. decide whether the household's ticker set may go to Yahoo, and its sign-in identity to Google
   (S7, S13);
6. require verified TLS if Postgres is moved off this host (S6).

Severity describes impact if the stated precondition holds; it does not imply intent.

## Scope and method

Static, repository-level review of `main` at `7d6ba5d`.

Reviewed surfaces:

- every application route and its loaders and actions;
- database access, migrations, upload and CSV handling, pricing, polling, cookies, redirects, and
  rendered HTML;
- runtime and deployment files: the Compose variants, the Caddyfile, the Dockerfile, the entrypoint,
  configuration, the dump script, the service worker, and the operating guide;
- the package manifest and lockfile, dependency reachability and pruning, CI workflows, tracked
  artefacts, secret-like strings, install hooks, network-call sites, dynamic execution, and child
  processes;
- recent history and repository configuration relevant to generated or leftover files.

The review searched specifically for hidden network destinations, beacons, remote command paths,
unsafe dynamic code, SQL injection, XSS, open redirects, secret logging, unbounded input, missing
authorisation boundaries, unsafe cookies, exposed ports, mutable executable inputs, and sensitive
data retained or copied beyond the operator's expectation. Each finding was traced to the code that
supplies the relevant value rather than inferred from a name or a comment.

Limits. `npm audit` and `npm audit signatures` could not run from the sandbox that produced the
first draft (the registry answered HTTP 403). CI runs both on every push and pull request
(`.github/workflows/ci.yml:84-90`), `publish` needs that job to pass (`:155`), and the job was green
on the commit audited, so the tree's advisory state is known; what the sandbox could not do was
reproduce it. The test suite was not run for this document either: it needs the throwaway Postgres
from `compose.test.yaml`, and neither environment that produced the document had a Docker daemon.
Nothing below rests on a test result. Library behaviour (React Router 7.18.2, `yahoo-finance2`
4.0.2) was read from the packages `npm ci` installs from the lockfile, not recalled. A static review
cannot prove the absence of a vulnerability in dependencies or infrastructure outside this
repository, and this one did not scan remote container layers.

## Findings

### S1 — Medium: the default deployment automatically trusts a mutable application image

**Evidence.** `app` defaults to `ghcr.io/chethan123/portfolio-app:1` with `pull_policy: always`
(`compose.yaml:192,196`), so every `up` or recreate takes whatever the `1` tag points at.
`APP_VERSION` is documented, commented out, in `.env.example:146-150` with the pinning recipe, and
in `docs/operating.md:283-290` and `:959-964`; the floating default is a recorded decision
(`DESIGN.md:870-872`).

**Risk.** A compromised publisher account, registry or release workflow, or a later bad release,
becomes code with the whole database on the next pull. This is ordinary supply-chain risk, not
evidence about the current image; automatic uptake is what makes the blast radius direct. Two things
bound it: `publish` runs only on a tag and only after every other CI job passes
(`ci.yml:150-156`), and the pin is one variable away.

**Avoidance.** Set `APP_VERSION` to a reviewed full version. A digest works with no compose change:
`compose.yaml:192` interpolates after the colon, so `APP_VERSION=1.0.3@sha256:<digest>` is a valid
reference. Nothing documents that; one line in `operating.md` is the whole fix. The dump sidecar
already records `APP_VERSION` beside every dump (`compose.yaml:127-129`,
`scripts/dump-loop.sh:129-131`), which is the tag half of "record the running image"; the digest
half is `docker image inspect`.

Rated Medium, not High as first drafted: a documented default with a documented pin sits one rung
below S3, where the credential is known and no pin exists.

### S2 — High if bypassed, otherwise recorded design: the application itself has no authorisation

**Evidence.** `AUTH_GATE` decides only whether the open-instance warning is drawn
(`server/config.ts:51-64`, `app/root.tsx:37-46`); it enforces nothing, and no route reads an
identity header or checks a permission (`app/routes/settings/people.tsx:22-39` is typical). This is
the recorded design: ADR-0005, `DESIGN.md:832-850` and `:947`, `ARCHITECTURE.md` §7.6 (`:1589-1604`)
and "What this posture is not" (`:1621-1629`), `CONTEXT.md:124-138`.

The bundled Compose deployment compensates correctly. Only `caddy` publishes a port
(`compose.yaml:344-345`); `/healthz` is the sole exemption from forward auth (`Caddyfile:31-33`);
the `/oauth2/*` endpoints reach only the gate (`:39-46`); every gate credential is a `${VAR:?}` that
stops startup when missing (`compose.yaml:248-254`); the allowlist mounts read-only (`:285-290`).
The smoke test asserts the redirect and the 401 (`scripts/smoke-test.sh:559-587`).

**Risk.** Publishing the `app` container, binding the dev server to an untrusted network, routing
around Caddy, or setting `AUTH_GATE=external` without a gate exposes the household's whole portfolio
and every write. Every admitted address can read and write everything: the verified email is
attribution, never permission (`CONTEXT.md:136-138`), so there is no per-person boundary and none
was intended.

**Avoidance.** Run the complete stack. Expose only Caddy, to a trusted LAN or VPN or a correctly
configured TLS proxy. Keep the allowlist narrow, and test an allowed and a refused account before
loading real data. Treat `AUTH_GATE=external` as a display assertion. Do not expose `npm run dev`.

### S3 — Medium: a known database credential on a flat service network widens a container compromise

**Evidence.** Postgres initialises with `portfolio`/`portfolio` (`compose.yaml:58-59`); the app and
dump URLs carry the same default (`:126`, `:204`); `.env.example:23` ships that `DATABASE_URL`
uncommented while `POSTGRES_PASSWORD` stays commented (`:100-104`). No `networks:` key exists in any
compose file, so `caddy`, `gate`, `app`, `dump` and `db` share the default bridge.

**Risk.** Postgres publishes no host port, which is a strong control. Code execution inside the
LAN-facing `caddy` or `gate` container can still dial `db:5432` with the known credential and read,
alter or destroy everything. The credential is supplied only to `app`, `dump` and `db`, so a random
one alone stops a compromised frontend container guessing it; a network split removes the route. One
more exposure of the same secret: `scripts/dump-loop.sh:204,262` pass the URL, password included, as
an argument to `psql` and `pg_dump`, so it is readable in `/proc/*/cmdline` by any host account for
the duration of each nightly run.

**Avoidance.** Generate a high-entropy `POSTGRES_PASSWORD`. On a fresh instance, set it before the
first `up`. On an instance that has already initialised its data directory, Postgres never reads the
variable again: change the password inside the database first (`alter role portfolio with password
…`, `docs/operating.md:311-319`), then update `DATABASE_URL`. Changing both variables alone leaves
`app` and `dump` unable to authenticate and crash-looping while the old password stays live. Keep
`.env` where passwords are kept, not in the dump directory: it holds the only copy of this and of
the gate's secrets, and `operating.md:849-863` is right that it must survive a rebuild. Split
Compose into a frontend network for `caddy`, `gate` and `app` and a backend one for `app`, `dump`
and `db`. That topology, and a required `POSTGRES_PASSWORD`, are already designed in spec 0015
(`docs/specs/0015-price-worker.md` §3.1; ticket
`docs/specs/price-worker/05-app-cutover-and-lockdown.md:47`), so this is a case for landing that
slice, not a new proposal. Pass the dump credential through `PGPASSWORD` or the split `PG*`
variables rather than argv.

### S4 — Medium: request bodies are bounded only after they are buffered

**Evidence.** The upload route refuses a declared-oversize `Content-Length` before reading
(`app/lib/uploads.server.ts:109-125`, called at `app/routes/upload.tsx:57`), then calls
`request.formData()` (`:59`) and checks the resulting `File.size` (`uploads.server.ts:157`). A
request without `Content-Length` — a chunked multipart body — passes the first guard, and only the
part named `file` is measured, so a valid 10 MB file plus arbitrary other parts passes both. React
Router 7.18.2 has no built-in multipart limit; the buffering is undici's `formData()`, unbounded.
The upload route is the only action with a pre-buffer guard: thirteen other actions call
`request.formData()` with none (every `settings/*` action, `masking.ts:28`, `refresh.ts:36`,
`account.tsx:186`, `holdings.tsx:241`, and the three `upload/*` steps). The Caddyfile has no
`request_body` limit (`Caddyfile:1-83`), and `MAX_UPLOAD_MB` is not wired through `compose.yaml`
(`docs/operating.md:298-306`), so the bundled cap is fixed at 10 MB and applies to one part of one
route. Recorded as SEC-7 in `docs/research/2026-08-24-exploratory-test-report.md:2313-2327`.

**Risk.** A client that can reach the application can consume process memory with one large or
chunked body, or with many. The gate narrows the attacker pool to admitted browsers and does nothing
for an exposed app. Repeated requests deny service to the family.

**Avoidance.** A body-size limit at Caddy (`request_body { max_size }`) and at the outer proxy,
where a request is refused before buffering. In the app, `v8_middleware` is on
(`react-router.config.ts:13`) and already used (`app/lib/chart-range.ts:643`); a root middleware
that refuses an unsafe-method request whose `Content-Length` exceeds the limit, or that has none, is
the small change that makes safety independent of deployment.

### S5 — Informational: cross-site mutations are refused twice, by controls outside the routes

**Evidence.** No action carries a CSRF token or checks `Origin`, `Referer` or `Sec-Fetch-Site`
itself. Two controls outside the routes do the work. React Router 7.18.2 rejects a mutation whose
`Origin` host differs from the request host with 400 before the action runs —
`throwIfPotentialCSRFAttack`, called from `handleDocumentRequest` for every mutation method and from
`singleFetchAction` for every `.data` POST — measured on the running app in
`docs/research/2026-08-24-exploratory-test-report.md:2502-2512`. And the gate's cookie is
`SameSite=Lax` and `Secure` (`compose.yaml:277-278`), recorded as the instance's CSRF posture in
ADR-0005:35-36. No loader writes — a GET at most sets the `chart_range` preference cookie
(`app/lib/chart-range.ts:655-659`) — so the Lax carve-out for top-level GETs reaches no mutation.

**Residual.** A request with no `Origin` header passes the framework check. Browsers always send
`Origin` on a cross-site POST, so that is not a CSRF vector; it is a non-browser client, which
carries no ambient cookie. Replacing the gate with one whose cookie is `SameSite=None` leaves the
framework check standing alone, which is enough for a browser. The `Sec-Fetch-Mode` check in
`app/routes/refresh.ts:40-47` chooses the response shape (a redirect for a no-JS form, JSON for a
fetcher) and is not a CSRF control. One stale sentence in the record: "the app carries no cookie of
its own" (`compose.yaml:273`, `docs/operating.md:548`, `ARCHITECTURE.md` §7.6) predates the `masked`
(`app/lib/masking.ts:114-119`) and `chart_range` (`chart-range.ts:424-425`) cookies. Both are Lax,
neither is a secret, and the conclusion stands.

**Avoidance.** Keep the bundled cookie settings. Nothing further is needed for the bundled
deployment. Correct the "no cookie" sentence where it is recorded.

### S6 — Medium when Postgres is remote: the documented external-database path does not require TLS

**Evidence.** `DATABASE_URL` is checked for a `postgres:` scheme and nothing else
(`server/config.ts:37-49`); `server/db.ts:45-53` hands the string to `pg.Pool` with no `ssl`
option. `docs/operating.md:184-197` permits a reachable Postgres host and says nothing about
transport. `dump` refuses any host other than `db` (`scripts/dump-loop.sh:91-105`), so the remote
path is the app's alone.

**Risk.** Off this host, without verified TLS, the credential and every record cross the network in
plaintext or to an active intermediary. The default same-host bridge is unaffected.

**Avoidance.** Keep Postgres local unless there is a reason not to. The fix for the remote case is
one documented line, not code: with the pinned `pg` 8.23 and `pg-connection-string` 2.14,
`?sslmode=verify-full` (plus `sslrootcert=/path` for a private CA) verifies chain and hostname
against the system store, and `config.ts` passes query parameters through.
`uselibpqcompat=true&sslmode=require` does not verify; say so in the same line. Firewall the server
to this host and confirm the connection is encrypted after configuring it.

### S7 — Privacy decision: symbols, timing and source address go to Yahoo, and on a bad day to npm

**Evidence.** Every refresh selects the feed-backed instruments (`app/lib/prices.server.ts:182-194`,
`:768-795`) and passes their symbols to `yahoo-finance2` in one batch quote call and per-symbol
history calls (`app/lib/price-provider.server.ts:716`, `:756-760`). Two more paths send symbols:
`probeSymbol` (`:665-673`) sends the symbol a person typed into the instrument form at creation,
before any row exists (`app/lib/instrument-resolution.server.ts:308`, `:499-511`); and Refresh-now
(`app/routes/refresh.ts:66-67`) and the post-upload refresh (`app/routes/upload/review.tsx:83`) fire
on user action, so request timing correlates with uploads and presence, not only the cadence. The
poller starts from the root loader (`app/root.tsx:62-67`, `app/lib/price-poller.server.ts:195-207`);
no configuration turns it off (`server/config.ts:72-74`,
`migrations/0008_refresh_cadence.sql:24-27`).

On the wire: `query2.finance.yahoo.com` for quotes and charts; `finance.yahoo.com/quote/AAPL` for
the crumb handshake, hard-coded, so every instance fetches AAPL
(`yahoo-finance2/esm/src/lib/getCrumb.js:34`); `query1.finance.yahoo.com/v1/test/getcrumb`; and
`guce.yahoo.com` and `consent.yahoo.com` for the EU consent flow. One destination is not Yahoo. The
library ships with `versionCheck: true` and `validation.logErrors: true`
(`options/defaults.js:18-25`), the app constructs it with no options
(`price-provider.server.ts:620`), and a response that fails schema validation triggers
`fetch("https://registry.npmjs.org/yahoo-finance2/latest")` (`validateAndCoerceTypes.js:210-217`,
`versions.js:6`). The `dump` service's "no egress" comment (`compose.yaml:162`) describes intent; no
network isolates anything.

Symbols also reach the logs. On any non-2xx the library prints the full request URL, the whole
`symbols=` list (`yahooFinanceFetch.js:139`), and on a validation failure it dumps the entire result
(`validateAndCoerceTypes.js:188-209`); app-side, `Price refused: <SYMBOL> …` names one
(`price-provider.server.ts:177,725`). `react-router-serve` logs every request line with its query
string (`morgan("tiny")`). `docs/operating.md:727-743` lists the log stems without saying so.

**Risk.** Yahoo, npm on a validation failure, and any on-path observer see the instance's address,
timing and ticker set; tickers alone reveal interests and uncommon holdings. The path carries no
quantities, values, people, account names or numbers, CSV content or credentials. `yahoo-finance2`
uses an unofficial endpoint and is itself a trust boundary. The disclosure is recorded as accepted
residual risk in spec 0015 (`docs/specs/0015-price-worker.md:615-618`) and stated to the operator at
`docs/operating.md:606-613`.

**Avoidance.** Pass `versionCheck: false` where the client is constructed: one line, and the npm
destination is gone. If disclosing symbols to Yahoo is unacceptable, the shipped answer is thin.
`manual` pricing at import only records `price_source` and leaves the holding unpriced, and the
instrument and manual-price screens are later slices (`app/routes/settings/index.tsx:64-67`,
`DESIGN.md:740-741`); blocking egress at the network after testing is the effective control today,
and spec 0015's egress-isolated worker is the designed one. Treat container logs as household data
when choosing where they go.

### S8 — Privacy decision: original statements and dumps are sensitive plaintext at rest

**Evidence.** A committed upload stores the original filename and raw bytes on `position_set`
(`migrations/0001_initial_schema.sql:155,161`; written at `app/lib/uploads.server.ts:1020-1021`),
and a draft holds the same bytes on `upload_draft` (`migrations/0004_upload_draft.sql:36`). Draft
rows older than 24 hours are deleted only when a later upload calls the sweep
(`uploads.server.ts:207-210`, the sole caller), so an abandoned draft on an idle instance stays, and
stays resumable: the read path has no age filter (`:290-298`). Nightly dumps are custom-format,
uncompressed by default (`scripts/dump-loop.sh:33,262`), mode `0640` (`:20-23`), kept seven days
with the newest never pruned (`compose.yaml:135`, `dump-loop.sh:164-190`); encryption is the
collector's job (`.env.example:108-112`). All of this is recorded: originals are kept indefinitely
on purpose (`DESIGN.md:298-306`; "still deliberately no retention policy",
`docs/operating.md:1105-1109`), and plaintext dumps are "an acceptance, not an oversight"
(ADR-0009:69-73).

**Risk.** Brokerage exports carry more than the columns parsed, and the account number is parsed as
well, into `account.external_account_number` (`uploads.server.ts:272,279`). Disk theft, a host
account in the dump group, an over-broad backup agent, or a leaked archive discloses parsed
finances, original files, and every raw Yahoo response, which `price_observation.payload` archives
without pruning (`migrations/0009_price_observation.sql:29-41`,
`app/lib/prices.server.ts:1015-1024`). An operator who mistakes `./volumes/dumps` for history loses
anything older than a week.

**Avoidance.** Encrypted host storage; encrypted, access-controlled off-host collection; a narrow
dump group; a tested restore. Inspect an export before uploading it. `operating.md` tells the
operator none of the encryption half today and should. The retention decision is not contested
here; anyone who wants to revisit it should argue with `DESIGN.md:298-306`. The sweep could run from
the poller tick as well as from the next upload without touching that decision.

### S9 — Low: browser hardening headers are not enforced here

No response from the app or the bundled Caddy sets CSP, frame protection, HSTS, `nosniff`, a
referrer policy, or — the one the app itself should own — `Cache-Control` on HTML and data
responses; the only `no-store` is on `/healthz` (`app/routes/healthz.ts:26`). Recorded at
`docs/operating.md:547-555` and measured in the exploratory report (`:2514-2521`). HSTS belongs at
the TLS terminator, deliberately outside this stack. Frame protection and a CSP would bound
clickjacking and a future injection; an outer proxy that omits `frame-ancestors` lets an
authenticated screen be framed. `Cache-Control: no-store` matters only if something between Caddy
and the browser caches, which the documented topology has none of.

Add and test headers at the proxy that owns each boundary. A CSP must allow the fixed inline
service-worker registration (`app/root.tsx:253-260`; `docs/specs/0012-installable-pwa.md:133`)
rather than silently breaking the app.

### S10 — Low: executable supply-chain inputs are tag-pinned, not digest-pinned

Postgres and Caddy float on major tags (`compose.yaml:33,46,105,321`); the gate is exact-pinned and
deliberately never updated (`:240`, `docs/operating.md:982-985`); the Node build and runtime bases
use version tags (`Dockerfile:25,33,89`); `# syntax=docker/dockerfile:1` (`Dockerfile:1`) is a
fourth floating input, the BuildKit frontend. Only `app` has `pull_policy: always`
(`compose.yaml:196`); `db`, `dump` and `caddy` default to `missing`, so their risk is staleness
rather than tag mutation. GitHub Actions are version-tagged, not SHA-pinned
(`.github/workflows/ci.yml:20-27,168-190`); `publish` holds `packages: write` (`:162`), and the
other jobs inherit the repository default because no workflow-level `permissions:` block narrows
them. `provenance` and `sbom` are off for a stated reason: GHCR renders the attestation manifests as
`unknown/unknown` (`:202-205`).

Common configuration, not malicious code; it lets upstream tag mutation change what builds or runs
without a repository diff. Digest-pinned images, SHA-pinned Actions with version comments, and a
workflow-level `permissions: contents: read` are the fixes. Spec 0015 lists the first two as
deferred hardening (`:600-601`), and the dependency audit records why Renovate was not added
(`2026-08-23-dependency-audit.md:254-255`).

### S11 — Low hygiene: tracked conflict leftovers expand the review surface

`app/lib/uploads.server.ts.orig`, `tests/commit-upload.test.ts.orig` and
`test_account_comments.patch` are tracked; all three arrived in one bot commit on `main` (`4f9e1cb`,
"Apply code review feedback on PR #204"). Neither `.gitignore` nor `.dockerignore` has a `*.orig`
rule. Reach: the app-side `.orig` enters the `build` stage via `COPY app ./app` (`Dockerfile:40`)
and is absent from `runtime` (`:98-117`); the tests copy never enters the context
(`.dockerignore:12`); the patch enters the context and nothing copies it. No malicious content in
any of them. Remove them, and add `*.orig` and `*.rej` to `.gitignore` so the next tool that leaves
them cannot commit them.

### S12 — Low: `safeReturn` can be made to emit a protocol-relative redirect

**Evidence.** `app/lib/return-path.ts:16-32` resolves a posted return path against a throwaway
origin, demands that origin back (`:29`), and returns `pathname + search` (`:31`). Dot-segment
removal can leave a pathname that begins with `//`:

```text
safeReturn("/..//evil.test")        -> "//evil.test"
safeReturn("/.//evil.test")         -> "//evil.test"
safeReturn("/x/..//evil.test")      -> "//evil.test"
safeReturn("/%2e%2e//evil.test")    -> "//evil.test"
safeReturn("/..//evil.test/s?x=1")  -> "//evil.test/s?x=1"
```

`redirect()` then sends `Location: //evil.test`, which a browser resolves to `https://evil.test/`.
Reached from `app/routes/masking.ts:38` and `app/routes/refresh.ts:46` (with
`Sec-Fetch-Mode: navigate`). The tests cover `//`, `/\` and absolute URLs
(`tests/refresh-control.test.ts:45-51`), not dot segments. `ARCHITECTURE.md` §7.6's "Redirect
targets" row and the helper's own header describe the origin check as the whole check.

**Risk.** Behind the bundled gate the POST must carry the Lax cookie and a matching `Origin` (S5),
so it needs a same-site page: low. With the gate absent or replaced it is an open redirect from an
auto-submitted cross-site form.

**Avoidance.** After the origin check, re-parse the returned string against the base and demand the
origin again, or refuse a pathname that starts with `//`; add the five cases above to the test. Its
own pull request.

### S13 — Privacy decision: the gate tells Google who signs in, and when

The bundled gate is oauth2-proxy with Google as the provider (`compose.yaml:243-254`). Sign-in
redirects the browser to Google, and the gate makes one server-to-server call to exchange the code
and read the address (`docs/google-sign-in.md:28-29`, `:52-54`). Google therefore observes which
accounts use this instance, from which addresses, and when; the operator's Cloud project is the
record. The app never sees a token, and the gate calls no Google API after sign-in. This is the
design in ADR-0005; it is stated here so a privacy reader counts two third parties, not one. Not
eliminable without a different identity provider.

## Controls verified

`ARCHITECTURE.md` §7.6 (`:1589-1604`) is the record of this stack's controls, and
`docs/operating.md:487-488` declines to repeat it; this section does not either. Every row of that
table was read against the tree. Two are corrected above: "Redirect targets" is S12, and "Upload
bounds" is one part of one route (S4). "Session revocation" is the gate's documented behaviour and
was not re-tested; "Error disclosure" was measured in the exploratory report
(`2026-08-24-exploratory-test-report.md:2523`). The rest hold as written. Checked beyond the table:

- Runtime containers are non-root, capability-dropped, read-only and `no-new-privileges`
  (`compose.yaml:74-80,163-167,215-219,297-308,348-359`), with the two documented exceptions
  (`gate` as uid 0 with `DAC_READ_SEARCH`; `caddy` with `NET_BIND_SERVICE`); logs are size-bounded
  on every service; the smoke test asserts all of it (`scripts/smoke-test.sh:275-300,342-402`).
- The runtime image copies a narrow set and runs unprivileged (`Dockerfile:98-122`). `.env` and
  `volumes/` are excluded from Git and from the build context. The real allowlist is gitignored
  (`.gitignore:15`) **but not dockerignored** — `.dockerignore:1-28` has no rule for it — so it is
  sent to the daemon on a local or remote build and stays out of the image only because no `COPY`
  names it. `docs/operating.md:851-852` says otherwise and is wrong on that half. No committed
  credential was found.
- `dump` refuses any `DATABASE_URL` whose host is not `db`, or that carries `host=` or `hostaddr=`
  (`scripts/dump-loop.sh:91-105`), so the bundled credential cannot be pointed at a stranger through
  the dump path.
- The service worker uses no Cache Storage or IndexedDB and passes every fetch through
  (`public/sw.js:1-71`); it serves one compiled offline page for a failed navigation (ADR-0007).
- One `dangerouslySetInnerHTML` in the app, a fixed service-worker registration string
  (`app/root.tsx:256-260`). User text is React-escaped everywhere.
- Kysely binds every value; the raw `sql` sites interpolate only bound values with `::` casts and
  compile-time literal identifiers, the one `sql.ref` takes a code literal
  (`app/lib/valuation.server.ts:391`), and externally supplied ids pass `couldBeId` first.
- `/healthz` is exempt from the gate and answers database reachability plus the filenames of
  pending migrations (`app/routes/healthz.ts:17-28`): a version fingerprint, acknowledged at
  `docs/operating.md:508-511`, running two queries per unauthenticated hit (`:533-538`). Acceptable;
  not data-free.
- The lockfile invariant in CI (`ci.yml:99-115`) holds: the production tree has no install script or
  platform marker. The Docker build prunes the unreachable `yahoo-finance2` branches
  (`scripts/prune-unreachable-deps.mjs`, `Dockerfile:66-67`).

## Investigated and not promoted

- **No covert outbound destination in application code.** Every `fetch`, `http`, `WebSocket`,
  `sendBeacon` and `XMLHttpRequest` site across `app/`, `server/`, `public/` and `scripts/` is the
  service worker's pass-through, the fixed `import("yahoo-finance2")`, or a loopback health probe.
  The conditional npm-registry call lives inside the library (S7).
- **No dynamic execution.** No `eval`, `new Function`, `vm` or child process in runtime code; shell
  runs only in the entrypoint and in scripts the image does not carry (`Dockerfile:67`).
- **No secret logging.** Every `console.*` site prints fixed wording plus an error or a path;
  `ConfigError` names variables, never values (`server/config.ts:133-139`); the demo seed redacts
  URL passwords. Symbols and query strings do reach the logs (S7), and the dump credential reaches
  argv (S3).
- **No application XSS.** React escaping; the one inline script interpolates nothing.
- **No debug, demo or seed route.** `app/routes.ts` has twenty entries, no splat, nothing dev-only.
- **Install hooks.** Only `esbuild` and `fsevents` declare one, both dev-only
  (`package-lock.json`). "Development only" understates where they run: `npm ci` executes them
  wherever `--ignore-scripts` is absent, which is the CI `check` job (`ci.yml:27`) and the Docker
  `deps` stage (`Dockerfile:30`, `npm ci --include=dev`) — the release path through `smoke` and
  `publish`. Only `audit` ignores scripts (`:79`). A compromised hook could alter release output;
  pruning the runtime tree afterwards does not change that.
- **Forwarded headers from the LAN** are forgeable (`Caddyfile:19` trusts `private_ranges`; the port
  is on all interfaces). The app reads none, the gate's redirect is pinned and its `rd` must be
  relative (`Caddyfile:64-67`), and the record says exactly this (`ARCHITECTURE.md:1606-1614`,
  `docs/operating.md:453-458`).
- **Gate cookie contents.** `OAUTH2_PROXY_SESSION_COOKIE_MINIMAL` is unset, so the browser cookie
  carries Google access, ID and refresh tokens, encrypted, that a forward-auth-only deployment never
  uses. Minor hardening.
- **No resource limits** on any service (`docs/operating.md:1134-1136` acknowledges).

## What to do before loading real data

`docs/operating.md:625-639` is the operator's checklist and stays the record. The items below are
only what this audit adds to it.

- [ ] Pin `APP_VERSION` to a reviewed full version or a `tag@sha256:…` digest, and note the digest
      from `docker image inspect` (S1).
- [ ] Generate a unique Postgres password. Fresh instance: set it before the first `up`. Existing
      instance: `alter role` first, then `DATABASE_URL` (S3).
- [ ] Put the host, the database volume and the dump destination on encrypted storage; collect
      dumps off-host, encrypted; know that the local directory holds seven days (S8).
- [ ] Verify an allowed sign-in, a refused sign-in, and that the `app` and `db` ports are
      unreachable from the LAN (S2).
- [ ] Decide whether Yahoo may receive the ticker set and Google the household's sign-in identity.
      If not, block egress after testing, because manual pricing is not yet a workflow (S7, S13).
- [ ] Remote Postgres only with `sslmode=verify-full` and a firewall (S6).
- [ ] Request-size limits and hardening headers at the proxy (S4, S9).
- [ ] Land the code fixes: `safeReturn` (S12); `versionCheck: false` (S7); `*.orig` in
      `.gitignore` and the three leftovers removed (S11); `allowed-emails.txt` in `.dockerignore`;
      the dump credential out of argv (S3).

## Reproducible checks run

```text
git rev-parse HEAD                                   # 7d6ba5d
git ls-files | grep -E '\.(orig|rej|patch|bak)$'     # S11
git log --oneline -1 -- app/lib/uploads.server.ts.orig
rg -n 'request\.formData\(\)' app                    # S4: fifteen sites, one guarded
rg -n 'fetch\(|http\.request|WebSocket|sendBeacon|XMLHttpRequest' app server public scripts
rg -n 'eval\(|new Function|child_process' app server public scripts
rg -n 'dangerouslySetInnerHTML|sql\.raw|sql\.lit|sql\.ref' app
npm ci --ignore-scripts                              # to read the pinned packages, not to run them
rg -n 'throwIfPotentialCSRFAttack' node_modules/react-router/dist/production
rg -n 'versionCheck|registry.npmjs.org' node_modules/yahoo-finance2/esm/src/lib
node --experimental-strip-types <a script calling safeReturn on the S12 inputs>
npm audit --omit=dev; npm audit signatures   # not run: registry 403 in the first sandbox;
                                             # CI's audit job was green on 7d6ba5d
npm test                                     # not run: no Docker daemon for compose.test.yaml
```
