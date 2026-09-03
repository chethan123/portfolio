# 05 — The record: docs, ADR, and runbooks

_Part of [0018-price-worker.md](../0018-price-worker.md) (§2.3, §6)._

**What to build:** The documentation that makes the slice a recorded decision instead of a surprise —
including the §10 reversal, the new operational procedures, and the runbook steps that keep existing
installs upgradable and restorable.

Every line reference below was verified against the working tree when this ticket was written; check
them again before editing, because these files move.

**Blocked by:** 04.

**Status:** ready-for-agent

**A count that is already wrong, and this ticket makes it worse**

- [ ] ADR-0009 `:81-82` accepted the obligation to turn "all four containers…" into rules per
      `docs/README.md:9-12`, and it was not discharged when `dump` landed. A worker makes the count
      six. Clear it in the passages this ticket already edits: `docs/operating.md:56` ("All four drop
      every Linux capability"), `:206` ("All four services"), `DESIGN.md:905` ("one decision rather
      than four"), `ARCHITECTURE.md:156` and `:173`. Do not leave a second slice's debt to a third.

**DESIGN.md**

- [ ] §6.2 (`:443-502`) gains the mailbox paragraph; the backfill paragraph (`:483-492`) gains its
      worker sentence
- [ ] §10's "Job scheduler" row — **`:826`, in the §10 deployment table, not the §9 stack table** —
      rewritten: worker container, and why the trade flipped (egress isolation and role separation
      outweigh "one process to deploy" now that the threat model includes dependency compromise)
- [ ] §10.1's "no separate worker service" paragraph (`:913-918`) rewritten
- [ ] §10.1's services block (`:876-903`) gains `worker` — **and `dump`, still missing since spec
      0014**
- [ ] §10.1's env table (`:944-951`) gains `WORKER_DB_PASSWORD` and `POSTGRES_PASSWORD` with the
      reasoning. It is the table `docs/developing.md:368` calls authoritative, and it is already six
      `DUMP_*` variables behind — add those while there.
- [ ] `:829`'s Backups row still says backups are "not built in", which `dump` falsified

**ADR-0010 — "Price fetching is an egress-isolated worker"**

- [ ] Context (supply-chain threat), decision (mailbox over API, polling over LISTEN/NOTIFY, role
      over trust, **the app supplying the work so the worker reads no household table**), consequences
      (worker-down UX, covert-channel residuals, correlated compromise until the decorrelation
      follow-up, two required env vars, a refresh now needing two healthy processes)
- [ ] Alternatives rejected: the three in spec §3.7 (column grants on `holding`/`position_set`; a
      view owned by `portfolio`; the app supplying the work — taken), plus in-app fallback mode, an
      HTTP API on the worker, a LISTEN/NOTIFY doorbell, separate images now, a Go/second-language
      worker
- [ ] The named follow-up: worker supply-chain decorrelation (own package.json/image, ~2-package
      tree, hand-rolled Yahoo fetch behind the same Zod schemas)
- [ ] ADR-0009 `:32-46` ("This also reverses 'no separate worker service'") is the template for
      arguing a second container against the three documents that say there is none

**ADR-0011**

- [ ] Its spec-number references (`:11`, `:74-77`, `:114-116`) were already repointed to **0018**
      when the spec was renamed — check they still read correctly, do not redo them
- [ ] `:55-56`'s "**Nothing is shaped for spec 0018's worker**" gets a `Reversed` banner in the form
      `docs/specs/README.md:14-20` describes — corrected beside the argument, not by rewrite. The
      argument it made was right at the time and stays where it was made.

**ARCHITECTURE.md**

- [ ] §3.1's "**No worker container**" (`:161-163`) rewritten; the §3.1 mermaid `class` line (`:156`)
      gains `worker` and `dump`
- [ ] §4.2's yahoo-import row (`:338`) keeps its site, and its `price-provider.server.ts:619`
      reference is **correct — do not "fix" it**. What changes is the reachability note: imported only
      by the worker process.
- [ ] §4.2's env-reader row (`:345`) gains the worker entrypoint and the provision step (both read
      through `loadConfig`). It carries no line reference today and needs none.
- [ ] §11.2's live-debt row (`:1959`) — "In-process poller … A worker container" — is discharged
- [ ] Three genuinely stale refs are in the neighbourhood and cost nothing to fix while here:
      `:346` cites `upload.tsx:48` (actual `:57`), `:355` cites `positions.server.ts:276` (actual
      `:211`), `:399-400` cites `statement.ts:32`/`:608` (actual `:26`/`:561`)

**CONTEXT.md**

- [ ] *price worker*, *mailbox* — and the words to avoid: "queue", "job table" (three request tables,
      not a general queue). They join the existing "How prices stay fresh" section (`:93-120`).
- [ ] *Refresh cadence* (`:95`) and *Poll* (`:108`) both describe the app doing the refreshing; each
      needs one clause. Keep the house form: definition paragraph, then a final `_Avoid_:` line.

**docs/operating.md**

- [ ] The "What runs here" table (`:28-33`) gains `worker` and `dump`; `:31`'s claim that `app` is
      "the application: pages, uploads, and the price refresh loop, in one process" is corrected
- [ ] Docker Engine floor at `:84-92`, which today states only "any v2 is new enough" for Compose and
      no Engine floor at all: **26.0 as a conservative floor, not the vulnerability boundary**
      (CVE-2024-29018 was fixed in 23.0.11 / 25.0.5 / 26.0). The same paragraph enumerates the
      stack's outbound hosts and needs Yahoo's addition.
- [ ] The env table (`:250-257`) — the same six rows as DESIGN.md, same additions
- [ ] Upgrade runbook: the two required env vars; the password alphabet; existing clusters also need
      `ALTER ROLE portfolio PASSWORD …` (the initdb-time password is baked in) — editing `.env` alone
      breaks auth. `:978`'s `docker compose up -d app caddy gate` enumerates services by name and
      needs `worker`.
- [ ] The restore procedure (`:870-904`) stops and restarts **`worker` as well as `app`** — and
      `:893-895` explicitly names the in-app refresh loop as the connection holder that would
      otherwise make `dropdb` fail. That sentence is now about the worker. (`dump` holds connections
      too and was already unaccounted for here, though `:972-980` noticed it for upgrades.)
- [ ] Restore onto a fresh cluster bootstraps `portfolio_worker` *before*
      `pg_restore --exit-on-error` (the dump is per-database — `scripts/dump-loop.sh:262` —
      while roles are cluster-global; the archive's ACL entries name a role that does not exist, and
      the restored `schema_migrations` means migration 0012 never re-runs). Without the bootstrap the
      restore stops at `role "portfolio_worker" does not exist` on the first
      `GRANT SELECT(id) ON TABLE public.instrument`, and `--single-transaction` rolls the whole thing
      back — so the symptom is a restore that appears to do nothing. `:931-945` ("Rebuilding a
      machine from nothing") needs the same step.
- [ ] The rehearsal procedure (`:906-929`) — the drill database inherits the ACL entries; check
      `:921`'s `dropdb` still works
- [ ] The external-Postgres section (`:184-197`) gains the worker mode: which override to apply, and
      exactly which guarantees remain — the worker split, role, and mailbox survive; the
      internal-network guarantee is a bundled-db property. `:193`'s "the role needs to be able to
      create tables" is its only privilege sentence today and now needs a second: the operator
      creates and grants `portfolio_worker` by hand.
- [ ] The symbol-length note: stored symbols up to 40 chars are accepted
      (`instrument-resolution.server.ts:309`); the worker fetches only pattern-conforming ones (≤15),
      so an unusual symbol shows permanently stale

**docs/developing.md**

- [ ] The dev-worker recipe: one-time local provisioning (`provision-worker-role.ts`), an
      `.env.worker` naming `portfolio_worker`, and
      `node --env-file=.env.worker ./server/price-worker.ts` — development exercises the same
      privilege boundary as production, never the superuser (`:57` writes a superuser `DATABASE_URL`
      today)
- [ ] The without-a-worker behaviour stated: stored prices, `worker-unresponsive` on refresh, probes
      `unavailable` after one shared deadline (instruments created anyway, unpriced)
- [ ] `:391-434` ("Exercise a backfill locally") and `:435-474` (the split convention, re-verified
      after a `yahoo-finance2` upgrade) both assume an in-process fetch and need the worker step
- [ ] `:360-373` ("Add a configuration variable") names four places a new variable must appear —
      follow it for `WORKER_DB_PASSWORD` rather than inventing a fifth

**docs/specs/README.md**

- [ ] Index row after `:45`: `| [0018](0018-price-worker.md) | … (ADR-0010) |`, in the established
      form
- [ ] `price-worker/` appended to the ticket-directory list (`:49-54`) as `(0018)`

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build` green (docs-only, but the gates are cheap and
      the spec requires each ticket to stand alone)
