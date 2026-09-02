# 06 — The record: docs, ADR, and runbooks

_Part of [0015-price-worker.md](../0015-price-worker.md) (§2.3, §6)._

**What to build:** The documentation that makes the slice a recorded decision instead of a
surprise — including the §10 reversal, the new operational procedures, and the runbook steps
that keep existing installs upgradable and restorable.

**Blocked by:** 05.

**Status:** ready-for-agent

**DESIGN.md**

- [ ] §6.2 gains the mailbox paragraph
- [ ] §10's "Job scheduler" row (line 810) rewritten: worker container, and why the trade
      flipped — egress isolation and role separation outweigh "one process to deploy" now that
      the threat model includes dependency compromise
- [ ] §10.1's services block gains `worker` — and `dump`, currently missing from it
- [ ] §10.1's env table gains `WORKER_DB_PASSWORD` and the worker's vars, with the reasoning

**ADR-0010 — "Price fetching is an egress-isolated worker"**

- [ ] Context (supply-chain threat), decision (mailbox over API, polling over LISTEN/NOTIFY,
      role over trust), consequences (worker-down UX, covert-channel residuals, correlated
      compromise until the decorrelation follow-up, two required env vars)
- [ ] Alternatives rejected: in-app fallback mode, HTTP API on the worker, LISTEN/NOTIFY
      doorbell, separate images now, a Go/second-language worker
- [ ] The named follow-up: worker supply-chain decorrelation (own package.json/image,
      ~2-package tree, hand-rolled Yahoo fetch behind the same Zod schemas)

**ARCHITECTURE.md §4.2**

- [ ] The yahoo-import row (`:337`) keeps its site, reachability note updated (worker-only);
      fix the stale `:388` ref (the import is at `:285`)
- [ ] The env-reader row (`:344`) gains the worker entrypoint and provision step (both read
      through `loadConfig`); fix the stale `priceFreshness:633` ref (`:511`)

**CONTEXT.md**

- [ ] *price worker*, *mailbox* — and the words to avoid: "queue", "job table" (two request
      tables, not a general queue)

**docs/operating.md**

- [ ] Docker Engine floor: 26.0 as a conservative floor, not the vulnerability boundary
      (CVE-2024-29018 was fixed in 23.0.11 / 25.0.5 / 26.0)
- [ ] Upgrade runbook: the two required env vars; the password alphabet; existing clusters
      also need `ALTER ROLE portfolio PASSWORD …` (the initdb-time password is baked in) —
      editing `.env` alone breaks auth
- [ ] Restore and rehearsal procedures stop **and restart the worker as well as the app** —
      the worker's pooled, lock, and healthcheck sessions would otherwise make `dropdb` refuse
- [ ] Restore onto a fresh cluster bootstraps `portfolio_worker` *before*
      `pg_restore --exit-on-error` (dumps are per-database, roles are cluster-global; the
      archive's ACL entries name a role that does not exist, and the restored
      `schema_migrations` means migration 0010 never re-runs)
- [ ] The external-Postgres section ("Running against your own Postgres") gains the worker
      mode: which override to apply, and exactly which guarantees remain — the worker split,
      role, and mailbox survive; the internal-network guarantee is a bundled-db property
- [ ] The symbol-length note: stored symbols up to 40 chars are accepted; the worker fetches
      only pattern-conforming ones (≤15), so an unusual symbol shows permanently stale

**docs/developing.md**

- [ ] The dev-worker recipe: one-time local provisioning (`provision-worker-role.ts`), an
      `.env.worker` naming `portfolio_worker`, and
      `node --env-file=.env.worker ./server/price-worker.ts` — development exercises the same
      privilege boundary as production, never the superuser
- [ ] The without-a-worker behaviour stated: stored prices, `worker-unresponsive` on refresh,
      probes `unavailable` after one shared deadline (instruments created anyway, unpriced)

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build` green (docs-only, but the gates are
      cheap and the spec requires each ticket to stand alone)
