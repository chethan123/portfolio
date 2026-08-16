# 02 — Migration runner and the domain schema

_Part of [0001-foundation-day-zero.md](../0001-foundation-day-zero.md)._

**What to build:** A self-hoster starting from an empty volume gets the full domain schema created
automatically, and restarting the container is always safe. The app never serves a request against a
half-migrated database, and `/healthz` tells the truth about whether the schema is current. This is
where the design's model — positions, instruments, aliases, classifications, quotes and daily
closes — becomes real, including the seed rows that let cash and debt travel the same path as a
share position.

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] A fresh volume brought up produces the complete schema from DESIGN.md §4.1 with no manual step
- [ ] Migrations are plain `.sql` files applied in filename order, each inside a transaction
- [ ] Applied filenames are recorded in a `schema_migrations` table, so re-running skips completed
      ones and a restart is always safe
- [ ] The runner is a standalone TypeScript file executed directly under Node's type stripping, with
      no build step, and exits non-zero on failure
- [ ] The entrypoint runs migrations to completion and only then starts the server — not
      concurrently, and not as a separate one-shot service
- [ ] The whole day-zero schema lands in one initial migration
- [ ] Enumerated columns use check constraints rather than `CREATE TYPE` enums: account kind,
      account tax treatment, instrument price source, classification asset class
- [ ] Tax treatment is the three-way `taxable | tax_deferred | tax_free`, not a boolean
- [ ] Classification name is unique
- [ ] Instrument has a surrogate primary key; its symbol is nullable and mutable
- [ ] Instrument alias is keyed on the raw string, matched case-sensitively as stored, global rather
      than scoped per institution
- [ ] Holding is unique on position set and instrument together
- [ ] Account closed-at is a nullable timestamp; the retained CSV on a position set is nullable; a
      holding's cost basis per share is nullable with no default
- [ ] Deleting a person who owns accounts is refused by a restricting foreign key
- [ ] Quantity is `numeric(20,8)`; prices and money are `numeric(20,4)`
- [ ] The same migration seeds a `Cash` classification with asset class `cash`, a `USD` instrument
      with a fixed price source classified as `Cash`, a `USD` quote at 1.00, and a `USD` daily close
      at 1970-01-01 at 1.00
- [ ] Database types are generated from the live database including views, committed to the repo,
      with the regeneration step documented
- [ ] `/healthz` returns a non-200 when any migration present on disk is not recorded as applied
- [ ] The container smoke test grows a case that restarts the app container and confirms it comes
      back healthy, proving migration idempotency and that the runtime image contains the `.sql`
      files
