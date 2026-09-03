# 01 — The mailbox tables and the minimal worker role

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.3, §3.5)._

**What to build:** Migration `0012_price_mailbox.sql` — the three mailbox tables
(`refresh_request`, `backfill_candidate`, `probe_request`) and the `portfolio_worker` role with its
complete grant list, exactly as §3.5 of the spec states it. Plus `server/provision-worker-role.ts`,
a new entrypoint step after `migrate.ts` that turns the `NOLOGIN` role into a login role with the
operator's password.

The value of doing it before any worker exists: the grants become an executable, pinned contract —
the permission test fails the suite the day anyone widens them — and tickets 02/04 build against a
schema that is already in `database.generated.ts`.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**The migration**

- [ ] `0012`, not `0010` — `migrations/0010_price_backfill.sql` and `0011_latest_position_set_cost.sql`
      have landed. (The **ADR** number 0010 is separate and still free.)
- [ ] `refresh_request`, `backfill_candidate` and `probe_request` as spec §3.3: identity ids,
      `status` as text + CHECK (no enums — `erasableSyntaxOnly`), `claimed_at` lease columns, the
      `quotes` boolean the app writes and the worker does not re-decide, and outcome columns for
      **both** halves of a refresh (`RefreshPricesReport`, `prices.server.ts:640-643` — the quotes
      report *and* `backfill_attempted` / `backfill_written` / `backfill_batch_failed`)
- [ ] The symbol pattern `^[A-Za-z0-9.^=-]{1,15}$` as a CHECK on `probe_request.symbol`, and
      `range_until > range_from` plus a `range_from` floor as CHECKs on `backfill_candidate` — the
      covert-channel caps that bind even the superuser app
- [ ] `backfill_candidate` references `refresh_request(id) on delete cascade`, so the app's sweep
      takes the work list with the request
- [ ] `create role portfolio_worker nologin nosuperuser nocreatedb nocreaterole connection
      limit 10` inside an idempotent DO block (bare CREATE ROLE errors on re-run; roles are
      cluster-global while the migration ledger is per-database)
- [ ] The grant list verbatim from spec §3.5. Three SELECTs are needed for reasons the statements
      do not show: `instrument.quote_type` because `writeQuoteType`'s WHERE reads it
      (`prices.server.ts:916-921`); `quote`'s five updated columns and `price_daily.close` because
      `ON CONFLICT DO UPDATE` reads them through `excluded.*` (`:871-891`, `:937-949`); and
      `price_observation.instrument_id` / `price_daily.instrument_id` because `RETURNING` returns
      them (`:1069-1074`, `:979-990`)
- [ ] `grant insert on price_backfill` — the attempt ledger, INSERT-only: the worker records
      attempts, the *app* reads them (the retry clock at `prices.server.ts:306-318` and the Settings
      gap list at `:392-462`)
- [ ] **No grant on `holding`, `position_set` or `app_setting`** — the app supplies the backfill's
      candidates (spec §2.4, §3.7), which is the whole reason those stay invisible. Nothing on
      `account`, `person`, `upload_draft`, `column_mapping`, `classification`, `instrument_alias`,
      `manual_networth`, `holding_valued`, or `instrument.name` / `instrument.classification_id`
      either. No DELETE anywhere.
- [ ] `grant select on schema_migrations` — note it is created by the migration *runner*
      (`server/migrations.ts:14`), not by a migration file, so it already exists when 0012 runs
- [ ] Applied against the throwaway Postgres, then `npm run db:types` regenerated and committed
      (CI's `db:types -- --verify` rejects the skip)

**Provisioning**

- [ ] `server/provision-worker-role.ts` reads `WORKER_DB_PASSWORD` through `loadConfig` — the
      variable joins `configSchema` (`server/config.ts:35-94`) as optional, keeping
      ARCHITECTURE.md §4.2's "only `server/config.ts` reads the environment" (`:345`) true
- [ ] Creates the role if missing before altering it — a dump restored onto a fresh cluster carries
      `schema_migrations` (0012 never re-runs) but no cluster-global role
- [ ] No-ops silently when the variable is unset, so existing installs boot unchanged
- [ ] Runs in `docker-entrypoint.sh` after `migrate.ts` (`:12`); the script joins the Dockerfile's
      copied `server/` file set (the runtime stage ships only named files, `Dockerfile:104-110`)
- [ ] Validates the password against the documented URL-safe alphabet and refuses with a message
      naming the constraint — a raw password is interpolated into a `DATABASE_URL` and breaks on
      `/`, `?`, `#`

**The permission pin**

- [ ] Against real Postgres under `withDatabase`: `SET ROLE portfolio_worker`, seeded fixtures, and a
      full refresh — quotes **and** a candidate-driven backfill batch — completes. Every statement in
      the refresh path runs under the grants, including the backfill's `price_daily` read-back and
      its ledger insert.
- [ ] The role's complete ACL is snapshot-asserted via the catalog against the spec's exact
      allowlist: every row of `information_schema.role_table_grants`, plus every row of
      `information_schema.role_column_grants` **not already implied by a table grant** (otherwise
      each table grant expands into one row per column and the snapshot is unreadable). A later
      migration granting `person`, a private `instrument` column, or any DELETE fails by name.
- [ ] Each expected-denial assertion is wrapped in a **savepoint**, not left to run last: a
      permission error aborts the transaction `withDatabase` (`tests/support/database.ts:92`) gives
      the whole test body, but `savepoint s; …; rollback to s;` leaves it usable — verified against
      PostgreSQL, and Kysely 0.29.5 exposes `trx.savepoint(name)`. Cover the whole invisible list in
      one test: `holding`, `position_set`, `app_setting`, `instrument.name`,
      `instrument.classification_id`, `account`, `person`, `upload_draft`, `holding_valued`, and at
      least one DELETE.
- [ ] `holding_valued_at(d)` and `latest_position_set(…)` are asserted denied too: both are
      `SECURITY INVOKER`, so they fail on their base tables rather than leaking — worth pinning, since
      a future `SECURITY DEFINER` function would silently open a hole this list would not otherwise
      notice

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build` green
