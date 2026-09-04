# 02 — The mailbox and the worker role

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.2, §3.6)._

**What to build:** Migration `migrations/0012_provider_call.sql` — the `provider_call` table, the
`symbols_wellformed` function, the `portfolio_worker` role, its two grants and its availability
hardening — plus `server/provision-worker-role.ts`, a new entrypoint step after `migrate.ts` that
creates the role if a restore lost it, gives it a login password when `WORKER_DB_PASSWORD` is set,
and re-applies the hardening on every boot. `WORKER_DB_PASSWORD` joins `configSchema` as optional.
Two tests pin the role: a snapshot of its complete ACL, and its statements run under
`SET LOCAL ROLE`.

Its own ticket because the grants become an executable contract before any worker exists — a
later migration that widens them fails the suite by name — and
[03](03-the-price-worker-process.md) builds against a schema already in `database.generated.ts`.
Nothing here changes behaviour: the table is empty and the role cannot log in until the operator
gives it a password.

**Blocked by:** Nothing. Parallel with [01](01-prefactor-the-refresh-and-probe-seams.md).

**Status:** ready-for-agent

**The migration** (`migrations/0012_provider_call.sql`)

- [ ] `0012` is the next free number (`migrations/` runs `0001` to `0011`). A header comment in
      `0010_price_backfill.sql`'s form: what a provider call is, why one row is one library call,
      why the app sweeps and the worker never deletes, and the honest sentence about what the
      CHECKs bind — honest code and a non-owner worker, never the superuser app
- [ ] `symbols_wellformed(text[])`, `language sql immutable strict`, `bool_and(s ~
      '^[A-Za-z0-9.^=-]{1,15}$')` over `unnest`. The same pattern is restated as a regex in
      [03](03-the-price-worker-process.md)'s `server/symbol-pattern.ts`; both name the other as a
      deliberate duplication (`docs/README.md`'s rule)
- [ ] `provider_call` exactly as spec §3.2: an identity key; `kind` in `('quotes', 'history')`;
      `symbols text[]` with cardinality 1..100 and the function; `range_from date` present exactly
      when `kind = 'history'`; `requested_at` defaulting to `now()`; `deadline_at` not null;
      `claimed_at`, `answered_at`; `outcome` in `('ok', 'failed')`; `payload jsonb` with
      `pg_column_size(payload) <= 2097152`; `error text` with `length(error) <= 1000`; a history row
      carries exactly one symbol. Constraints named as `price_backfill_outcome_valid` is
      (`0010:62`). No foreign keys, on purpose: scaffolding, and a test's cleanup is one delete
- [ ] The partial index `provider_call_pending` on `(requested_at) where claimed_at is null and
      answered_at is null`
- [ ] The role in an idempotent `DO` block: create `portfolio_worker nologin nosuperuser nocreatedb
      nocreaterole connection limit 5` when `pg_roles` lacks it; when the current role has neither
      `rolcreaterole` nor `rolsuper`, `raise exception` with a hint naming the fix ("create role
      portfolio_worker nologin as a superuser, then restart") — `docs/operating.md:194` promises
      bring-your-own installs only "can create tables"
- [ ] The two grants of spec §3.6, verbatim, and nothing else — no sequence grant: an identity
      default bypasses the sequence ACL
- [ ] The hardening in a second `DO` block guarded on `rolsuper`, raising a notice naming what it
      skipped otherwise: `execute format('revoke temporary on database %I from portfolio_worker',
      current_database())`; `alter role portfolio_worker set temp_file_limit = '64MB'`; `revoke
      execute … from public` on every function in `pg_proc` whose name starts `pg_advisory` —
      enumerated in the block, not by hand — and on `lo_create`, `lo_creat`, `lo_from_bytea`,
      `lo_import`, `lo_open` and `lowrite`. The header states that a future non-superuser app role
      needs `execute` on the advisory functions granted back
- [ ] Applied against the throwaway Postgres, then `npm run db:types`: `ProviderCall` lands between
      `PricePoll` and `Quote` in `app/lib/database.generated.ts` (`:155`, `:163`), and CI's
      `db:types -- --verify` rejects a skipped regeneration

**Provisioning** (`server/provision-worker-role.ts`, new)

- [ ] `WORKER_DB_PASSWORD` joins `configSchema` (`server/config.ts:35-94`) as
      `z.string().min(1).optional()` and is read through `loadConfig`, so `server/config.ts` stays
      the only reader of `process.env` (ARCHITECTURE.md §4.2, `:345`); `tests/config.test.ts` gains a
      case in the shape of `:9`
- [ ] Connects as `portfolio` on `DATABASE_URL` through `createPool` (`server/db.ts:45`) and runs,
      in order: the role's `DO` block again — a per-database dump carries `GRANT`s naming a role a
      fresh cluster lacks, and `pg_restore --exit-on-error --single-transaction`
      (`docs/operating.md:882-883`) rolls the whole restore back on the first one; the two grants;
      `alter role portfolio_worker login password <literal>` only when the variable is set, the
      literal from `client.escapeLiteral` — `ALTER ROLE` is DDL and takes no `$1`; and the hardening
      block, because database-level ACLs and role settings ride in no per-database dump
- [ ] With the variable unset nothing about login changes, so an existing install boots exactly as
      before [04](04-deploy-the-worker-alongside.md)
- [ ] A failure prints the Postgres error and exits non-zero; `docker-entrypoint.sh:9`'s `set -eu`
      then stops the server — the fail-closed contract the entrypoint already has
- [ ] `docker-entrypoint.sh` runs it after `migrate.ts` (`:12`); the Dockerfile's named copy list
      (`Dockerfile:104-110`) gains the file — an omission dies at boot in production and nowhere else
- [ ] `.env.example` documents the variable in the compose-level section (`:100-104`) as used by no
      service until [04](04-deploy-the-worker-alongside.md), with `openssl rand -hex 32`

**The tests** (`tests/worker-role.test.ts`, new; real Postgres, `afterAll(closeTestDatabase)`)

- [ ] The ACL snapshot, one `withDatabase` body: every relation in `public` × `select, insert,
      update, delete, truncate, references, trigger` through `has_table_privilege('portfolio_worker',
      oid, priv)`; every column × `select, insert, update, references` through
      `has_column_privilege`; every routine in `public` through `has_function_privilege`, with
      `prosecdef` beside it; `has_schema_privilege` for `usage` and `create`;
      `has_database_privilege` for `connect` and `temporary`; `pg_auth_members`; `rolsuper`,
      `rolcreaterole`, `rolcreatedb`, `rolbypassrls`, `rolconnlimit`; `setconfig` from
      `pg_db_role_setting`; and `has_function_privilege` on `pg_advisory_lock(bigint)` and
      `lo_create(oid)`. Asserted with `toEqual` against a literal allowlist so the failure names the
      row: `select` on `provider_call`, `update` on its five columns, `execute` on
      `symbols_wellformed`, `holding_valued_at` and `latest_position_set` (PUBLIC's default —
      expected), `usage` on `public`, `connect`, and nothing else
- [ ] The trap, in a comment: `has_table_privilege(…, 'update')` is *false* while only column grants
      exist — the column query is what catches a widened grant. And why not
      `information_schema.role_*_grants`: they omit what is granted to PUBLIC
- [ ] A stray table in `public` fails the snapshot by appearing; intended — the throwaway database
      is migrations-only
- [ ] The role's statements, a second body: seed two rows, then `set local role portfolio_worker`
      through `sql` (fixture writes after it are denied), then the three shapes of spec §3.5 —
      `select 1 from provider_call limit 0`, the claim `update … returning`, the answer `update …
      where id = $1 and answered_at is null` — then, each under `savepoint` / `rollback to
      savepoint` because a denial aborts the transaction (`tests/refresh-quotes.test.ts:774-778`):
      `select` from `account`, `holding_valued`, `instrument`, `quote`, `price_daily` and
      `app_setting`; `insert` into and `delete` from `provider_call`; `update provider_call set
      symbols`; `select * from holding_valued_at(current_date)` failing on `account`;
      `pg_try_advisory_lock(7295380114023642)` denied; `create temp table` denied; `reset role`
      last. [03](03-the-price-worker-process.md) replaces the literal statements with the worker's
      exported `{ text, values }` through `CompiledQuery.raw` (kysely 0.29.5)
- [ ] Never `SET ROLE` on a pooled client: `pg` issues no `RESET` on release, and the role would
      leak into the next checkout
- [ ] `tests/migrations.test.ts`'s refusals (`:243`) gain the mailbox's, one body per refusal: 101
      symbols, a symbol with a slash, a history row with two symbols, a `quotes` row with a
      `range_from`, a 2 MB + 1 payload, a 1001-character error

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build` green
