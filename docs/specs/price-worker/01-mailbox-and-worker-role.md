# 01 — The mailbox table and the minimal worker role

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.3, §3.5)._

**What to build:** Migration `0012_price_mailbox.sql` — one table, `fetch_request`, with the
constraint set and indexes spec §3.3 gives; the `portfolio_worker` role, whose entire world is that
table; and `server/provision-worker-role.ts`, an entrypoint step that gives the `NOLOGIN` role a
login credential.

The value of doing it before any worker exists: the grants become an executable, pinned contract —
the permission test fails the suite the day anyone widens them — and tickets 02/04 build against a
schema already in `database.generated.ts`.

**Blocked by:** 00.

**Status:** ready-for-agent

**The migration**

- [ ] `0012`, not `0010` — `migrations/0010_price_backfill.sql` and `0011_latest_position_set_cost.sql`
      have landed. (The **ADR** number 0010 is separate and still free.)
- [ ] `symbols_fetchable(text[])`, `immutable`, testing `s is not null and s ~ '^[A-Za-z0-9.^=-]{1,15}$'`
      per element with a `coalesce(…, false)` around `bool_and` — a CHECK may not contain a subquery
      and `unnest` needs one, and `bool_and` ignores NULL rows, so a NULL element would otherwise
      pass. Both traps were hit for real while drafting.
- [ ] `fetch_request` exactly as spec §3.3: `kind`, `symbols text[]`, the two nullable dates,
      `claimed_at`, `payload jsonb`, `error`, `answered_at`, and every named constraint. Use
      `cardinality`, not `array_length` — the latter is NULL for an empty array and a NULL CHECK
      passes.
- [ ] The `range_until <= current_date + 1` ceiling. Without it an unbounded date is ~31 bits handed
      to Yahoo's `period2`; PostgreSQL accepts dates to year 5874897. Confirm the target version
      accepts `current_date` in a CHECK; fall back to a fixed far-future ceiling if not.
- [ ] Both indexes: the partial `where claimed_at is null` one the drain uses, and the
      `requested_at` one the sweep uses (the `upload_draft` precedent comes with an index for the
      same reason)
- [ ] `create role portfolio_worker nologin nosuperuser nocreatedb nocreaterole connection limit 5`
      and its two grants, in a DO block that is **idempotent** (bare `CREATE ROLE` errors on re-run;
      roles are cluster-global while the migration ledger is per-database) **and privilege-guarded**
      — see below
- [ ] `revoke connect on database postgres, template1 from public` — a PUBLIC default the role
      inherits and never needs
- [ ] **Nothing else is granted.** Not `instrument`, `quote`, `price_daily`, `price_observation`,
      `price_poll`, `price_backfill`, `app_setting`, `holding` or `position_set`. No INSERT and no
      DELETE anywhere.
- [ ] Applied against the throwaway Postgres, then `npm run db:types` regenerated and committed
      (CI's `db:types -- --verify` rejects the skip)

**The privilege guard is not optional**

- [ ] `CREATE ROLE` needs `CREATEROLE` or superuser, and migrations run at every container start
      against whatever `DATABASE_URL` names. `docs/operating.md:193` promises external-Postgres
      operators only that "the role needs to be able to create tables", so as written this migration
      fails, `docker-entrypoint.sh:9` is `set -eu`, and the container never starts. Catch
      `insufficient_privilege`, `raise notice` naming the manual step, and let the migration succeed.

**Provisioning**

- [ ] `server/provision-worker-role.ts` reads `WORKER_DB_PASSWORD` through `loadConfig` — the
      variable joins `configSchema` (`server/config.ts:35-94`) as optional, keeping
      ARCHITECTURE.md §4.2's "only `server/config.ts` reads the environment" (`:345`) true
- [ ] **Send a SCRAM verifier, not the password.** Compute
      `SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>` in Node and pass that as the literal;
      PostgreSQL stores it verbatim and the original cleartext still authenticates (verified end to
      end). `ALTER ROLE` takes no bind parameters, and `log_min_error_statement` defaults to `error`
      — so a statement that fails for any reason is logged in full into the `db` container's
      json-file log on the operator's disk. A base64, `$`-delimited literal is injection-proof by
      construction rather than by a regex.
- [ ] Build the statement with `select format('alter role %I login password %L', $1, $2)` and
      execute the result
- [ ] Creates the role if missing before altering it — a dump restored onto a fresh cluster carries
      `schema_migrations` (0012 never re-runs) but no cluster-global role
- [ ] No-ops silently when the variable is unset, so existing installs boot unchanged
- [ ] Runs in `docker-entrypoint.sh` after `migrate.ts` (`:12`); the script joins the Dockerfile's
      copied `server/` file set (the runtime stage ships only named files, `Dockerfile:104-110`)
- [ ] Validates the password against the documented alphabet — now a third line of defence, not the
      first

**The permission pin — and it must not be a grant snapshot**

- [ ] Assert with **`has_table_privilege` and `has_column_privilege`** for the role over every table
      and column in `pg_class`/`pg_attribute`, compared against spec §3.5's exact list. Enumerating
      `information_schema.role_table_grants` is blind to the two most likely widenings, both
      confirmed live: `grant pg_read_all_data to portfolio_worker` and `grant select on account to
      public` each leave the grant rows byte-identical while
      `has_table_privilege('portfolio_worker','account','select')` flips from `f` to `t`.
- [ ] Assert `pg_auth_members` holds no row for the role, and cover
      `information_schema.routine_privileges` — `EXECUTE` also defaults to PUBLIC
- [ ] Under `SET ROLE portfolio_worker`, assert the whole invisible list is denied, plus
      `holding_valued_at(current_date)` and `latest_position_set(1)` failing **on their base
      tables** — the role holds `EXECUTE` on both regardless, so this is what would catch a future
      `SECURITY DEFINER`
- [ ] Each expected denial takes a **savepoint**: a permission error aborts the transaction
      `withDatabase` (`tests/support/database.ts:92`) gives the test body, and every later assertion
      would then fail on `25P02` rather than on the rule — passing for the wrong reason in the one
      test whose purpose is to fail. The house already does this, with its reasoning, at
      `tests/refresh-quotes.test.ts:778-798`.
- [ ] The constraint set is pinned too: a multi-symbol `quotes` row and a single-symbol `history`
      row with a range are accepted; a `history` row without a range, a `quotes` row with one, a
      two-symbol `probe`, a backwards range, a range past tomorrow, an empty array, a NULL element,
      a 16-character ticker, an embedded newline and a URL are each rejected

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build` green
