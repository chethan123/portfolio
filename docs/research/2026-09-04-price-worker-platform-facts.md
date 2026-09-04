# Price worker platform facts — 4 September 2026

*The Docker, PostgreSQL 17, `yahoo-finance2`, `pg`, Node 24, oauth2-proxy and Caddy behaviour the
price-worker slice rests on, gathered 2026-09-04 against `5e21ab7`. The design belongs to
[spec 0018](../specs/0018-price-worker.md) and this is the evidence under it — where they disagree
about a decision the spec wins, and where they disagree about what a platform does, this is the
citation.*

## Sourcing, and what "live" means

**Several doc sites are egress-blocked from the sandbox this was researched in** —
`docs.docker.com`, `www.postgresql.org`, `node-postgres.com`, `caddyserver.com`, `vitest.dev`,
`unpkg.com` — so those facts were read from the *source that generates the page* and are cited by
that path. Shorthands: `DOCS/x` = `raw.githubusercontent.com/docker/docs/main/content/x`, `SPEC/x` =
`compose-spec/compose-spec` `main/x`, `MOBY/x` = `moby/moby` `master/x`, `CLI/x` = `docker/cli`
`master/x`. PostgreSQL facts come from `REL_17_STABLE` `doc/src/sgml/**`, the SGML the docs are
built from, plus backend C where it is silent; library facts from the tarballs `package-lock.json`
resolves.

**Live** marks a fact executed here: PostgreSQL **17.10** (`@embedded-postgres/linux-x64`, genuine
server binaries), Node **24.20.0**, `pg` 8.23.0 from this repo's `node_modules`; every SQL probe ran
inside one `BEGIN … ROLLBACK`. **There is no Docker daemon in that sandbox** (§7).

## 1. Docker Engine and Compose

**1.1 `internal: true` is what "no egress" means, and it composes with a second network.** Compose
calls it "an externally isolated network" (`SPEC/06-networks.md:215-218`); Engine's definition is
"no default route is configured and firewall rules are set up to drop all traffic to or from other
networks" (`CLI/…/commandline/network_create.md:189-193`) — a pair of DROP rules per internal bridge
in the `DOCKER-INTERNAL` chain (`MOBY/…/iptabler/network.go`), scoped to that bridge. So a container
on an internal *and* a normal network reaches the internet through the latter, which is the
documented topology (`DOCS/manuals/engine/network/_index.md`).

**1.2 An internal bridge still holds a host address unless the gateway mode says otherwise.** "An
address is normally assigned to the bridge device in an `internal` network. So … containers in the
network can access host services listening on that bridge address, including anything bound to
`0.0.0.0`. No address is assigned to the bridge when the network is created with gateway mode
`isolated`", which requires `internal` (`DOCS/…/network/port-publishing.md:186-192`) — Engine
**28.0.0** (moby#49262), and in compose the `driver_opts` key
`com.docker.network.bridge.gateway_mode_ipv4: isolated`.

**1.3 Engine 28.0 is a hard floor, because 26 ignores that option silently.** At **v26.1.4**
`libnetwork/drivers/bridge/bridge_linux.go` has no `GatewayMode` at all and
`networkConfiguration.fromLabels` is a `switch` with **no `default` branch** — an unknown label is
skipped with no error, leaving a plain internal bridge *with* a host address. 27 refuses it loudly
(`newGwMode` takes only `nat` and `routed`, `:343-351`). **For the smoke test:** on 26 the obvious
assertions (external DNS fails, no default route) still pass, since both follow from `internal`
alone. Only an *effect* assertion separates them — a TCP connect from `app` to the network gateway's
`:80`, which succeeds on 26 and fails on 28.

**1.4 DNS from an internal network fails, and can fail slowly.** The embedded resolver at
`127.0.0.11` "is started with proxyDNS=false if the sandbox does not currently have a gateway", so a
sandbox on internal networks only "will not forward DNS requests to external resolvers"
(`MOBY/daemon/libnetwork/sandbox_dns_unix.go:58-65`). A non-loopback upstream is still tried from
the container's namespace and may time out (`resolver.go:511-526`), answering **SERVFAIL** when
nothing does (`:473-477`) — so bound the assertion: `timeout 5 nslookup example.com`. Not the old
leak: CVE-2024-29018 was fixed in 23.0.11 / 25.0.5 / 26.0.0-rc3, below every version in scope.

**1.5 Cross-network reachability is blocked; the host's published ports are not.** Containers on
different bridge networks "can only communicate with each other using published ports"
(`DOCS/…/network/drivers/bridge.md`). What topology cannot close: any container with a route to the
host reaches Caddy's published `:80`, so the worker always reaches the app *through the gate*.

**1.6 `depends_on: service_healthy` needs no shared network, and does not survive a daemon
restart.** It is evaluated by the Compose CLI over the Docker API — `checkDependencyHealthy` →
`isServiceHealthy` → `ContainerInspect` (`docker/compose` `pkg/compose/service_containers.go`). It
is startup ordering only, and `restart:` applies when containers exit or Docker restarts, so a
daemon restart or crash-loop brings them back **without** honouring it.

**1.7 A healthcheck inherits the container's hardening, and nothing acts on its result.** The probe
runs inside the container as its own user, unprivileged (`MOBY/daemon/health.go:71-86`), so
read-only rootfs, `cap_drop: ALL` and `no-new-privileges` apply and `CMD-SHELL` needs a shell.
**Nothing restarts an unhealthy container** — a `health_status` event is the whole daemon reaction.
busybox in `node:24-alpine` (`FROM alpine:3.23`) carries `stat -c %Y`, `timeout` and `nslookup`
(`alpinelinux/aports` `main/busybox/busyboxconfig`).

**1.8 A compose `entrypoint:` discards the image's CMD.** "If `entrypoint` is non-null, Compose
ignores any default command from the image, for example the `CMD` instruction in the Dockerfile"
(`SPEC/05-services.md:542-546`). That is what lets a second entrypoint on the same image skip
`docker-entrypoint.sh` (config gate, `migrate.ts`) and `react-router-serve`.

**1.9 `${VAR:?message}` fails before anything is created, and names one variable.** It errors during
model loading (`SPEC/12-interpolation.md`) with the text `required variable <NAME> is missing a
value: <message>` (`compose-go` `template/template.go`), which saves only "the first error to be
returned" (`:135-152`) — so an operator missing two new variables is told about one.

**1.10 Docker has no egress allowlist.** No per-host or per-domain egress policy exists in the
network manuals or the 27/28/29 notes; the only operator hook is `DOCKER-USER`: host root, outside
compose, IP-based against a CDN-fronted provider. An allowlist has to be a proxy the worker is
forced through by topology.

## 2. PostgreSQL 17

The role and grant design was executed end to end against 17.10 in one rolled-back transaction:
create the role and the table, grant, run the worker's statements under `SET LOCAL ROLE`, then
attempt everything it must not do.

**2.1 `SELECT` plus five column `UPDATE`s carry the worker, and nothing else is reachable.** Live,
under `set local role portfolio_worker`, the claim `update … set claimed_at = now() where
answered_at is null … returning id, kind, symbol` returned its rows and both answer statements
reported `UPDATE 1`. Each denial was then checked in a savepoint:

```
select 1 from holding_valued;                   ERROR:  permission denied for view holding_valued
select 1 from account / person / holding / position_set / upload_draft / quote / price_daily /
      app_setting / schema_migrations;          ERROR:  permission denied for table <each>
insert / delete / update … set symbol = 'EVIL'; ERROR:  permission denied for table provider_call
```

**UPDATE needs SELECT** on any column read in the expression or condition (`ref/update.sgml:64-71`)
— which is why the worker holds table SELECT at all. The snapshot must ask about columns too: live,
`has_table_privilege('portfolio_worker','provider_call','UPDATE')` is **false** while all five
column grants exist, and `has_column_privilege` is `t` for exactly `claimed_at, answered_at,
outcome, payload, error` — a table-level probe alone records an empty UPDATE set and misses a
widened grant.

**2.2 The leak, if there is ever one, will be a view.** Bar security-invoker views, "all relations
used due to rules get checked against the privileges of the rule owner" (`rules.sgml:2020-2028`).
`holding_valued` is owned by `portfolio` and its `reloptions` are null, so one `GRANT SELECT` on it
would hand over every account, person, holding and position-set row. The snapshot asserts its
absence.

**2.3 The worker can already call the two SQL functions, and that is harmless.** Functions are
`SECURITY INVOKER` by default (`ref/create_function.sgml:410-412`) and PUBLIC holds `EXECUTE` on new
functions by default (`ddl.sgml:2159-2178`), so the call is permitted and the *body* fails. Live:

```
select * from holding_valued_at(current_date);  ERROR:  permission denied for table account
select latest_position_set(1);                  ERROR:  permission denied for table position_set
                                                CONTEXT:  SQL function "latest_position_set"
```

`pg_proc` in `public` shows `prosecdef = f` for both, which is what the snapshot pins — a future
`SECURITY DEFINER` function over those tables reopens the door silently.

**2.4 Snapshot with `has_*_privilege`, never `information_schema`.** `role_table_grants`,
`role_column_grants` and `role_routine_grants` each omit objects "made accessible to the current
user by way of a grant to `PUBLIC`" (`information_schema.sgml:4528-4540` and siblings) — precisely
the leak class the test exists for, where `has_*_privilege` unions direct grants, PUBLIC and role
memberships (`utils/adt/acl.c:1424-1460`). Membership matters on its own — `pg_read_all_data` reads
everything "even without having it explicitly" (`user-manag.sgml:616-633`) — and live
`pg_auth_members` holds **0 rows** for the worker, which is the assertion.

**2.5 Role DDL is transactional, so it belongs in a migration.** `CREATE ROLE` is absent from
`PreventInTransactionBlock`'s list (`tcop/utility.c`). Live: after the probe's `ROLLBACK`, `select
count(*) from pg_roles where rolname='portfolio_worker'` returned `0`. Roles are cluster-global
(`user-manag.sgml:50-54`), which is why they outlive a `dropdb` — and why §2.6 bites.

**2.6 A per-database dump carries the GRANT but not the role, which aborts a fresh-cluster
restore.** `pg_dump` dumps one database and no roles (`ref/pg_dump.sgml:46-51`) but does dump
privileges unless `--no-acl` (`:652-661`), and `pg_restore --single-transaction` implies
`--exit-on-error` (`ref/pg_restore.sgml:614-626`). Live: a `grant` to a missing role → `ERROR: role
"role_that_does_not_exist" does not exist`. So a machine rebuild rolls back the whole restore on
that first `GRANT`, while the rehearsal drill — restoring onto the *same* cluster — passes.

**2.7 What a role with no grants at all can still do — the availability facts.** Each executed with
a bare `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE` role holding zero grants:

- **Advisory locks are unguarded.** Nothing guards them: `catalog/system_functions.sql`, which
  REVOKEs access at initdb time, has no `pg_advisory_*` entry (`func.sgml:30471-30496` documents no
  privilege). Live: the bare role took both keys this app uses (`refresh_key t`, `migrate_key t`);
  after `revoke execute on function pg_advisory_lock(bigint), … (all 16 variants) from public` it is
  denied, superusers unaffected. But `pg_init_privs` holds **no row** for them, so whether the
  REVOKE survives a dump is unproven (§7).
- **TEMP is granted to PUBLIC by default** (`datacl = {=Tc/…}`): the bare role created and filled a
  temp table, and `revoke temporary on database … from public` binds it. **Large-object creation is
  PUBLIC** too: `lo_create(oid)` and `lo_from_bytea(oid,bytea)` are both `t`.
- **Only SUSET settings bind a hostile role.** Live: `set local temp_file_limit = '1GB'` →
  `permission denied to set parameter "temp_file_limit"`, while `set local statement_timeout = 0`
  succeeded — USERSET. A per-role `statement_timeout` is hygiene, not containment.
- **A CHECK binds a non-owner.** Live: an oversize `payload` update was refused by `check
  (pg_column_size(payload) < 1024)`, and `alter table … drop constraint` → `must be owner of table`.
  They bind the worker, never the app, which owns the table.

**2.8 The claim is atomic under READ COMMITTED; the row lock is the mailbox's soft spot.** "The
search condition of the command (the `WHERE` clause) is re-evaluated to see if the updated version
of the row still matches" (`mvcc.sgml:336-352`) — which makes the claim safe against a second
claimer, where REPEATABLE READ raises `could not serialize access` instead. But `SELECT … FOR
UPDATE` needs that UPDATE privilege "on at least one column, in addition to the `SELECT` privilege"
(`ddl.sgml:1960-1965`), which the worker has — so it can lock unanswered rows and hold them, and the
app's sweep needs `lock_timeout` or `skip locked`.

**2.9 Testing the role from a superuser connection.** `SET ROLE` checks permissions as though that
role had logged in, and `SET LOCAL ROLE` reverts at transaction end (`ref/set_role.sgml`), which
suits `withDatabase` (`tests/support/database.ts:92-114`). Two traps: a denied statement poisons the
rest of the transaction (`protocol.sgml:5600-5605`), so each probe needs a savepoint; and `SET ROLE`
"does not process session variables as specified by the role's `ALTER ROLE` settings", so a per-role
timeout needs a real connection as that role.

**2.10 The official image decides where the role cannot be created.** `POSTGRES_PASSWORD` and
`/docker-entrypoint-initdb.d/*.sql` both take effect only on an empty data directory (docker-library
`postgres/README.md`), so a role created there would never exist on an upgraded volume; it belongs
in a migration plus a boot-time provisioning step. The entrypoint appends one line, `host all all
all scram-sha-256` (`docker-entrypoint.sh:284`), *after* initdb's sample `host all all 127.0.0.1/32
trust`, and the first matching record wins with "no fall-through" (`client-auth.sgml:120-130`) — so
loopback inside the `db` container is password-free, which is what makes a `docker compose exec db
psql` password cutover possible.

## 3. yahoo-finance2 4.0.2

**3.1 Every host the library can contact**, grepped across `esm/src/` of the resolved tarball:
`query2.finance.yahoo.com` (the quote and chart paths; overridable via `YF_QUERY_HOST`),
`finance.yahoo.com` (crumb seed page, `getCrumb.js:34`), `query1.finance.yahoo.com`
(`/v1/test/getcrumb`, not subject to `YF_QUERY_HOST`), `guce.yahoo.com` and `consent.yahoo.com`
(consent hops), and `registry.npmjs.org` (§3.2). **`fc.yahoo.com` does not appear in 4.0.2** — the
2.x/3.x cookie host, so an allowlist naming it is stale. Caveat: the consent branch follows whatever
`Location` Yahoo returns, to depth 5. `chart()` needs no crumb and no cookie (`needsCrumb` defaults
false, `yahooFinanceFetch.js:42`), so a history call is a plain GET while `quote` carries `&crumb=`
and the cookie.

**3.2 `versionCheck` is on by default and fetches npm — but only after a failure.** Default `true`
(`lib/options/defaults.js`); the call is `fetch("https://registry.npmjs.org/yahoo-finance2/latest")`
(`lib/versions.js:6`) from one site, `validateAndCoerceTypes.js:210`, inside `if (options.logErrors
=== true)`. The success path makes no npm request. `new YahooFinance({ versionCheck: false })`
removes it — the app passes no options at all today (`app/lib/price-provider.server.ts:619-620`).

**3.3 The library's own result validation is a per-call module option.** `ModuleOptions`
(`moduleCommon.d.ts:16-21`) adds `validateOptions`/`validateResult`. At the default, one drifted
field on one symbol throws `FailedYahooValidationError` for the *whole* call
(`validateAndCoerceTypes.js:188-222`) — under a mailbox, every row answered `failed` and every
instrument stale.

**3.4 A per-call `AbortSignal` is the only timeout there is.** The library has none of its own.
`moduleOptions`, the third argument to `quote()` and `chart()`, is forwarded **unvalidated**
(`moduleExec.js:52-62`) and its `fetchOptions` is spread into the request *and* handed to
`getCrumb`, so `fetchOptions: { signal: AbortSignal.timeout(ms) }` covers the handshake too. Do
**not** put one in the constructor's `fetchOptions` — that is a single signal for the instance's
life. The library calls `moduleOpts.fetch || envFetch || this._opts.fetch || globalThis.fetch`
(`yahooFinanceFetch.js`), so a process-wide proxy setting covers every request it makes, and its
default cookie jar is `tough-cookie`'s in-memory store, so a read-only rootfs is fine.

**3.5 The dependency tree has not moved, so the prune stays.** 4.0.2 is latest (2026-08-09) with the
seven runtime dependencies [the dependency audit](./2026-08-23-dependency-audit.md) §2 measured, and
`scripts/prune-unreachable-deps.mjs` walks **declared** edges from `package.json` (`:67-86`), not
the built bundle — so the package survives the app losing its import site.

## 4. pg 8.23.0

**4.1 `PGPASSWORD` fills a password the URL omits, and a URL password wins.** In source,
`pg/lib/connection-parameters.js` falls back to `process.env.PGPASSWORD`. Live:

```
no PGPASSWORD, URL without password:  FAILED -> SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string
PGPASSWORD set, URL without password:   OK   -> { current_user: 'portfolio' }
URL wrong pw + PGPASSWORD right:      FAILED -> password authentication failed for user "portfolio"
server/db.ts createPool + PGPASSWORD:   OK   -> { current_user: 'portfolio' }
```

`psql` 16.13 behaves identically. The driver reads its own environment — a sentence ARCHITECTURE
§4.2's env-reader row needs.

**4.2 A pooled connection is never reset, so `SET ROLE` leaks.** Neither `pg` nor `pg-pool` issues
`DISCARD ALL` or `RESET ALL` on release (zero hits across `pg/lib/**` and `pg-pool/index.js`);
`release()` returns the socket as-is, so any `SET` outside a transaction reaches the next checkout.
`SET LOCAL` inside a transaction, or a dedicated client, are the safe forms.

**4.3 `ALTER ROLE … PASSWORD` cannot be parameterised, and the escaper is on the prototype.** It is
a utility statement, so `$1` is rejected; `pg.Client.prototype.escapeLiteral` and `escapeIdentifier`
both exist (live: `function`) — what a provisioning step must use rather than interpolating a
secret.

**4.4 Why the mailbox is polled rather than LISTEN/NOTIFY.** A pooled connection cannot hold a
subscription, there is no reconnect after `end()`, and an unhandled `'error'` on an idle client
throws. Server-side, NOTIFY needs no privilege, is "visible to all users" (`ref/notify.sgml:31-38`),
and queues nothing for an absent listener.

## 5. Node 24

**5.1 `engines.node: >=24.12.0` is not arbitrary.** v24.12.0 is exactly where type stripping became
stable ("stable in v25.2.0 and v24.12.0", nodejs.org/api/typescript.html), and strip-only mode
rejects what `erasableSyntaxOnly` forbids: `enum`, parameter property, value `namespace` and `import
x = require()` each raise `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` (verified by running them).

**5.2 Node's `fetch` ignores proxy environment variables unless told not to.** `HTTP_PROXY`,
`HTTPS_PROXY` and `NO_PROXY` are read **only** with `NODE_USE_ENV_PROXY=1` or `--use-env-proxy`,
"added: v24.0.0 … Stability: 1.1 - Active Development" for `fetch`, the flag form at v24.5.0
(`doc/api/cli.md:3898-3908`, v24.x), covering `fetch()` and undici — everything §3.4 routes through.
It is process-wide and bypassable with a raw socket, so an egress bound rests on the network.

**5.3 The worker's other primitives are present.** `AbortSignal.timeout` and `AbortSignal.any` are
both functions on v24.20.0 (live), `--env-file` is non-experimental as of v24.10.0, and
`import.meta.hot` is `undefined` outside Vite rather than an error (live), so a Vite HMR guard loads
under plain `node`.

## 6. oauth2-proxy 7.15.4 and Caddy 2

**6.1 The gate's egress is `www.googleapis.com:443`, and nothing else.** At tag `v7.15.4`,
`OAUTH2_PROXY_PROVIDER: google` selects `NewGoogleProvider`, whose endpoints are hardcoded
(`providers/google.go`): `RedeemURL` `…/oauth2/v3/token` and `ValidateURL` `…/oauth2/v1/tokeninfo`,
both on `www.googleapis.com`. **No OIDC discovery, no JWKS fetch** — the provider decodes the
id_token payload locally, and discovery runs only when an issuer URL is configured, which
`compose.yaml` never does. `accounts.google.com` is a *browser* redirect the gate never contacts.
The residual: `/oauth2/callback` relays attacker-chosen bytes to Google on request.

**6.2 Caddy needs no egress at all.** The Caddyfile declares one site address, bare `:8080` — no
hostname, no IP, no `tls` directive. Automatic HTTPS is prevented by "not providing any hostnames or
IP addresses in the config" (`caddyserver/website` `src/docs/markdown/automatic-https.md`). So no
ACME, neither default CA, and no OCSP — Caddy staples only for certificates it manages.

## 7. What was not verifiable, and why

- **No Docker daemon in the research sandbox**, so nothing in §1 was executed: §1.3's 26-vs-27
  comparison rests on the absence of a `default` branch in one `switch`. The six egress-blocked doc
  sites were read from their generating sources, not the rendered pages.
- **Live PostgreSQL was 17.10 from an npm-packaged build, not `postgres:17-alpine`** — §2.10 is read
  from `docker-entrypoint.sh` and the image README.
- **Whether the advisory-lock REVOKE survives dump and restore is unproven** — `pg_dump` has
  recorded privilege changes on system objects since 9.6, but `pg_init_privs` holds no row for those
  functions. Check with `pg_restore --list | grep advisory` on a real dump; if absent, the runbook
  repeats it.
- **`pg_dump`'s `PGPASSWORD` handling was not exercised** — the only client here is 16.13, which
  refuses the 17.10 server; `psql` was verified, and libpq is shared.
- **That Node's `fetch` ignores `HTTPS_PROXY` without the flag could not be shown here**: the
  sandbox intercepts egress transparently, so `fetch()` succeeded with the flag and without it.
- **No live Yahoo call.** `*.finance.yahoo.com` is refused at CONNECT here — the refusal
  `app/lib/price-provider.server.ts:29-31` already records. So §3.1's crumb finding is source-read,
  and whether the consent redirect fires from a household's IP is unknown.
- **busybox applets were read from Alpine's build config**, not run (§1.7), and `getent` in
  `postgres:17-alpine` was not confirmed at all. **`import.meta.main` was not checked** either,
  though a worker entrypoint's "do not start the loop on import" guard needs it.
