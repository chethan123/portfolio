# 04 — The mailbox and the worker role

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.2, §3.6)._

**What to build:** Migration `migrations/0012_provider_call.sql` — the table, its named constraints
and its partial index, nothing else — and `server/provision-worker-role.ts`, the one site that
defines `portfolio_worker`: an idempotent `provisionWorkerRole(client, { password })` — the role,
two grants, a login password when `WORKER_DB_PASSWORD` is set, the availability hardening — run by
the entrypoint after `migrate.ts` on every boot and by the test suite after migrations.
`WORKER_DB_PASSWORD` joins `configSchema` as optional. Two tests pin the role: the complete ACL
provisioning produces, and the worker's statements under `SET LOCAL ROLE`.

Its own ticket because the grants become an executable contract before any worker exists — a later
grant that widens them fails the suite by name — and [05](05-the-price-worker-process.md) builds
against a schema already in `database.generated.ts`.

**Blocked by:** Nothing. Parallel with [01](01-one-refresh-and-the-batch-abort.md),
[02](02-the-batched-probe.md) and [03](03-the-two-hardening-rules.md).

**Status:** ready-for-agent

**The migration** (`migrations/0012_provider_call.sql`)

- [ ] `0012` is the next free number (`migrations/` runs `0001` to `0011`); a header in
      `0010_price_backfill.sql`'s form carrying spec §3.2's argument and why the role is *not* here
      (§3.6). `provider_call` exactly as spec §3.2 — every constraint named in
      `price_backfill_outcome_valid`'s form (`0010:62`), the null check `array_position(symbols,
      null) is null` (`bool_and` over `unnest` would skip a null), the partial index
      `provider_call_pending`; no symbol pattern in SQL, which lives once in
      [05](05-the-price-worker-process.md)'s `server/symbol-pattern.ts`
- [ ] Applied against the throwaway Postgres, then `npm run db:types`: `ProviderCall` lands between
      `PricePoll` and `Quote` in `app/lib/database.generated.ts` (`:155`, `:163`); CI's `db:types --
      --verify` rejects a skipped regeneration

**Provisioning** (`server/provision-worker-role.ts`, new — the one site for role, grants and
hardening; spec §3.6 has the argument, the header restates it)

- [ ] `provisionWorkerRole(client, { password })` — `client` a checked-out `pg` `Client`, since
      `escapeLiteral` is `Client`-only and a `Pool` has none — each statement idempotent, in order:
      `create role portfolio_worker nologin nosuperuser nocreatedb nocreaterole connection limit 5`
      when `pg_roles` lacks it; `grant select on provider_call to portfolio_worker`; `grant update
      (claimed_at, answered_at, outcome, payload, error) on provider_call to portfolio_worker` —
      nothing else, no sequence grant; `alter role portfolio_worker login password <literal>` only
      when `password` is given, the literal from `client.escapeLiteral` (DDL takes no `$1`); then
      the hardening. Additive: it re-adds a missing grant and never revokes one it did not make —
      the ACL test below is what catches a widening
- [ ] The hardening: `execute format('revoke temporary on database %I from public',
      current_database())` — **from PUBLIC**, since `TEMP` is PUBLIC's and revoking it from the role
      revokes nothing (exercised in review); `alter role portfolio_worker set temp_file_limit =
      '64MB'`; `revoke execute … from public` on every `pg_proc` function where `proname like
      '%advisory%'` — twenty-one on 17.10, both families; a "starts with `pg_advisory`" match misses
      `pg_try_advisory_lock`, `withRefreshLock`'s own call (`prices.server.ts:131`) — and on
      `lo_create`, `lo_creat`, `lo_from_bytea`, `lo_import`, `lo_open` and `lowrite`.
- [ ] First `select rolsuper from pg_roles where rolname = current_user`. The superuser-only
      statements — the `pg_catalog` revokes on the advisory and large-object families, `revoke
      temporary … from public`, `alter role … set temp_file_limit` — run only when it is `true`;
      otherwise each is **logged to the console as skipped, by name** — never `raise notice` (`pg`
      delivers notices only to a `notice` listener, and neither `server/migrations.ts` nor the
      entrypoint attaches one), and never inferred from the absence of an exception: a
      non-superuser's `REVOKE` on an unowned `pg_catalog` function is `WARNING: no privileges could
      be revoked` and *success* (exercised on 17.10). A `42501` on any remaining statement —
      `create role`, either grant, the password — is logged with the statement and the role it ran
      as, and is never fatal: an app must not go down for a role nothing uses until
      [07](07-the-app-cutover.md), where the refusal surfaces as "no worker claimed". Any other
      failure exits non-zero and `docker-entrypoint.sh:9`'s `set -eu` stops the server
- [ ] `docker-entrypoint.sh` runs it after `migrate.ts` (`:12`): the module runs as a script behind
      `if (import.meta.main)`, connecting as `portfolio` through a `pool.connect()` checkout of
      `createPool` (`server/db.ts:45`), released after, with `getConfig().WORKER_DB_PASSWORD`;
      `Dockerfile:104-110`'s copy list gains the file. With the variable unset nothing about login
      changes
- [ ] `tests/support/database.ts:40-51` — `testDatabase()`, which applies the migrations once per
      file and memoises; the suite has no vitest `globalSetup` and needs none — runs
      `provisionWorkerRole(client, {})` on a `pool.connect()` checkout right after
      `applyPendingMigrations` (`:42`), released after, so every test file sees the state production
      has
- [ ] `WORKER_DB_PASSWORD` joins `configSchema` (`server/config.ts:35-94`) as
      `z.string().min(1).optional()`, read through `loadConfig`, so `server/config.ts` stays the
      only reader of `process.env` (ARCHITECTURE.md §4.2, `:345`). No new `tests/config.test.ts`
      case (`loadConfig:122-128` already reads empty as unset). `.env.example` documents the
      variable in the compose-level section (`:100-104`), generated with `openssl rand -hex 32`
- [ ] `server/migrations.ts:105`: the lock is taken as `begin; set local lock_timeout = '30s';
      select pg_advisory_lock(…); commit` — the session lock survives the commit and the timeout
      does not, so nothing leaks into the pool the client returns to (in tests, the pool every file
      shares) — and a held migration key fails loudly, naming the key, instead of hanging the boot

**The runbook lines that cannot wait for [10](10-documents-and-runbooks.md)**

- [ ] Rebuilding a machine (`docs/operating.md:931-941`) and "I need to restore"
      (`docs/runbook.md:553`): `docker compose exec -T db psql -U portfolio -c "create role
      portfolio_worker nologin"` between `up -d db` and `pg_restore` — every dump now carries `GRANT
      … TO portfolio_worker`, provisioning has not yet run on a fresh cluster, and `pg_restore
      --exit-on-error --single-transaction` (`:882-883`) rolls the whole restore back on the first
      one (the bundled `db` starts with `POSTGRES_USER=portfolio`, so the owner role exists and only
      the worker's is missing)
- [ ] Running against your own Postgres (`:184-197`): `create role` needs `CREATEROLE` or superuser,
      and since PG 16 a `CREATEROLE` role may `alter role … password` only on a role it holds `ADMIN
      OPTION` for, automatic for one it created and absent for one a superuser pre-created; so
      pre-create with `create role portfolio_worker nologin admin <app role>`, or the password step
      is refused the moment `WORKER_DB_PASSWORD` is set. Without `CREATEROLE` the refusal is logged
      and the app serves, but the worker cannot log in at all; without superuser the availability
      hardening is skipped and logged. [10](10-documents-and-runbooks.md) states what such an
      install loses

**The tests** (`tests/worker-role.test.ts`, new; real Postgres, `afterAll(closeTestDatabase)`)

- [ ] The ACL snapshot asserts what provisioning applied, one `withDatabase` body: every relation in
      `public` × the seven table privileges through `has_table_privilege('portfolio_worker', oid,
      priv)`; every column × `select, insert, update, references` through `has_column_privilege`;
      every routine in `public` through `has_function_privilege`, with `prosecdef` beside it;
      `has_schema_privilege` for `usage` and `create`; `has_database_privilege` for `connect` and
      `temporary`; `pg_auth_members` **where `member = 'portfolio_worker'::regrole`** (a
      creator-side `ADMIN OPTION` row is legitimate on a bring-your-own install); the role
      attributes; `setconfig`; `has_function_privilege` on `pg_advisory_lock(bigint)`,
      `pg_try_advisory_lock(bigint)`, `pg_try_advisory_xact_lock(bigint)`, `lo_create(oid)` and
      `lo_put(oid, bigint, bytea)`. The literal allowlist, so the failure names the row: `select` on
      `provider_call`, `update` on its five columns, `execute` on `holding_valued_at` and
      `latest_position_set` and on `lo_put` (all three expected), `usage` on `public`, `connect`,
      and nothing else. A comment says why `has_column_privilege` (the table-level `UPDATE` probe is
      *false* under column grants) and why not `information_schema` (it omits PUBLIC's grants); a
      stray table in `public` fails the snapshot by appearing, intended
- [ ] The role's statements, a second body: seed two rows, then `set local role portfolio_worker`
      through `sql` (seed first — writes after it are denied), then the three shapes of spec §3.5 —
      the probe, the claim `update … returning` (the guard in its outer `where` too), the answer
      `update … where id = $1 and answered_at is null` — then, each under a savepoint (a denial
      aborts the transaction, `tests/refresh-quotes.test.ts:774-778`): `select` from `account`,
      `holding_valued`, `instrument`, `quote`, `price_daily` and `app_setting`; `insert` into and
      `delete` from `provider_call`; `update provider_call set symbols`;
      `holding_valued_at(current_date)` failing on `account`;
      `pg_try_advisory_lock(7295380114023642)`, `create temp table` and `lo_create(0)` denied;
      `reset role` last. [05](05-the-price-worker-process.md) swaps in the worker's exported
      `{ text, values }`
- [ ] `tests/migrations.test.ts`'s refusals (`:243`) gain the mailbox's, one body per refusal: 101
      symbols, an empty array, `array['VTI', null]`, a history row with two symbols, a `quotes` row
      with a `range_from`, a history row without one, a 2 MB + 1 payload of compressible text
      (measured before compression), a 1001-character error

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build` green
