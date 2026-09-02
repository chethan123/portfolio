# 02 — The mailbox tables and the minimal worker role

_Part of [0015-price-worker.md](../0015-price-worker.md) (§3.3, §3.5)._

**What to build:** Migration `0010_price_mailbox.sql` — the two request tables
(`refresh_request`, `probe_request`) and the `portfolio_worker` role with its complete grant
list, exactly as §3.5 of the spec states it (including the two subtleties a first draft missed:
`select (quote_type)` on `instrument` for `writeQuoteType`'s WHERE, and
`select (instrument_id, as_of)` on `price_observation` for the ON CONFLICT arbiter and
RETURNING). Plus `server/provision-worker-role.ts`, a new entrypoint step after `migrate.ts`
that turns the `NOLOGIN` role into a login role with the operator's password.

The value of doing it before any worker exists: the grants become an executable, pinned contract
— the permission test fails the suite the day anyone widens them — and tickets 03/05 build
against a schema that is already in `database.generated.ts`.

**Blocked by:** Nothing. (Parallel with 01.)

**Status:** ready-for-agent

**The migration**

- [ ] `refresh_request` and `probe_request` as §3.3: identity ids, `status` as text + CHECK (no
      enums — `erasableSyntaxOnly`), `claimed_at` lease columns, and the symbol pattern
      `^[A-Za-z0-9.^=-]{1,15}$` as a CHECK constraint on `probe_request.symbol` — the
      covert-channel cap that binds even the superuser app
- [ ] `create role portfolio_worker nologin nosuperuser nocreatedb nocreaterole connection
      limit 10` inside an idempotent DO block (bare CREATE ROLE errors on re-run; roles are
      cluster-global while the migration ledger is per-database)
- [ ] The grant list verbatim from spec §3.5 — column grants on `instrument` and `app_setting`,
      no DELETE anywhere, nothing at all on `account`, `person`, `holding`, `position_set`,
      `holding_valued`, `manual_networth`, `upload_draft`, `column_mapping`, `classification`,
      `instrument_alias`
- [ ] Applied against the throwaway Postgres, then `npm run db:types` regenerated and committed
      (CI's `db:types -- --verify` rejects the skip)

**Provisioning**

- [ ] `server/provision-worker-role.ts` reads `WORKER_DB_PASSWORD` through `loadConfig` — the
      variable joins `configSchema` as optional, keeping ARCHITECTURE.md §4.2's "only
      `server/config.ts` reads the environment" true
- [ ] Creates the role if missing before altering it — a dump restored onto a fresh cluster
      carries `schema_migrations` (0010 never re-runs) but no cluster-global role
- [ ] No-ops silently when the variable is unset, so existing installs boot unchanged
- [ ] Runs in `docker-entrypoint.sh` after `migrate.ts`; the script joins the Dockerfile's
      copied `server/` file set (the runtime stage ships only named files, `Dockerfile:104-110`)
- [ ] Validates the password against the documented URL-safe alphabet and refuses with a
      message naming the constraint

**The permission pin**

- [ ] Against real Postgres under `withDatabase`: `SET ROLE portfolio_worker`, seeded fixtures,
      `refreshQuotes` completes — every statement in the refresh path runs under the grants
- [ ] The role's complete ACL is snapshot-asserted via the catalog
      (`has_table_privilege` / `information_schema.role_*_grants`) against the spec's exact
      allowlist — a later migration granting `person`, a private `instrument` column, or any
      DELETE fails by name; the permission-denied assertion runs last in its transaction
      (it aborts the transaction)

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build` green
