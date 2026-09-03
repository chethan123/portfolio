# 05 — The record: docs, ADR, and runbooks

_Part of [0018-price-worker.md](../0018-price-worker.md) (§2.3, §6)._

**What to build:** The documentation that makes the slice a recorded decision instead of a surprise —
including the §10 reversal, the new operational procedures, and the runbook steps that keep existing
installs upgradable and restorable.

Every line reference below was verified against the working tree when this ticket was written; check
them again before editing, because these files move.

**Blocked by:** 05.

**Status:** ready-for-agent

**A count that is already wrong, and this ticket makes it worse**

- [ ] ADR-0009 `:81-82` accepted the obligation to turn "all four containers…" into rules per
      `docs/README.md:9-12`, and it was not discharged when `dump` landed. A worker makes the count
      six. Clear it in the passages this ticket already edits: `docs/operating.md:56` ("All four drop
      every Linux capability"), `:206` ("All four services"), `DESIGN.md:905` ("one decision rather
      than four"), `ARCHITECTURE.md:156` (the mermaid `class` line), `:179` ("**All four containers
      are `read_only: true`**") and `:186` ("Alongside it, on all four"). Note `:173` is *not* one of
      them — it is the stale "exactly one backup target" claim, worth fixing but a different error.
      Do not leave a second slice's debt to a third.

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

- [ ] Context (supply-chain threat), decision (**a fetch proxy, not a second writer** — the worker
      runs the provider and the app keeps every price-writing rule; mailbox over API; polling over
      LISTEN/NOTIFY; role over trust), consequences (worker-down UX, covert-channel residuals stated
      with real numbers, correlated compromise until the decorrelation follow-up, two required env
      vars, a refresh now needing two healthy processes and one more round trip per provider call)
- [ ] Alternatives rejected, from spec §3.7: the worker running `refreshPrices` with the app
      supplying backfill candidates (the first repair, taken apart on review); the same with column
      grants on `holding`/`position_set`; a plain view owned by `portfolio`. Plus in-app fallback
      mode, an HTTP API on the worker, a LISTEN/NOTIFY doorbell, separate images now, and a
      Go/second-language worker.
- [ ] Record why the seam landed on `PriceProvider`: it already existed, the app already injected
      it, and substituting an implementation left `prices.server.ts` and its tests untouched. That is
      the ADR's most useful sentence for whoever reads it next.
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
- [ ] §11.2's row (`:1959`) — "In-process poller … A worker container" — is **not** discharged. The
      poller stays in-process (spec §2.4) and its missed-poll-on-restart limit stays true. Only its
      third column, which prices the fix at "two images, two deployments, two log streams", becomes
      historical. Note `:1959` sits in §11.2 "Structural limits accepted on purpose", not the
      live-debt section, which starts at `:1961`.
- [ ] The `server/` → `app/lib` import direction is new in this tree (nothing in `server/` imports
      `app/` today; the edge runs the other way at `app/lib/db.server.ts:16-18`). Record it as a
      rule: the worker entrypoint may import pure leaves and the provider, never a `.server` module
      that writes.
- [ ] Three genuinely stale refs are in the neighbourhood and cost nothing to fix while here:
      `:346` cites `upload.tsx:48` (actual `:57`), `:355` cites `positions.server.ts:276` (actual
      `:211`), `:399-400` cites `statement.ts:32`/`:608` (actual `:26`/`:561`)

**CONTEXT.md**

- [ ] *price worker*, *mailbox* — and the words to avoid: "queue", "job table" (one table of fetch
      requests, not a general queue; the worker answers calls, it does not run jobs). They join the
      existing "How prices stay fresh" section (`:93-120`).
- [ ] *Refresh cadence* (`:95`) and *Poll* (`:108`) both describe the app doing the refreshing; each
      needs one clause. Keep the house form: definition paragraph, then a final `_Avoid_:` line.

**docs/runbook.md**

- [ ] A "prices are not refreshing" entry: the symptom (an ageing as-of line, a refresh reporting the
      feed unreachable), the worker container and the mailbox backlog to check, and the log stem to
      grep. This is where "worker down" is distinguished from "Yahoo down", because the app
      deliberately does not distinguish them for the household (spec §3.4).
- [ ] A "restore did nothing" entry — the role bootstrap below, whose symptom is a silent rollback.
- [ ] **Some log lines move containers.** `console.warn("Price refused: …")`
      (`price-provider.server.ts:725`) and every provider-side message now write to the *worker's*
      stream, not the app's. `docs/operating.md:761-791` ("There is no price line in the log" has
      four causes) is written on the assumption there is one stream; it gains a fifth cause and a
      second `docker compose logs` target.

**docs/operating.md**

- [ ] The "What runs here" table (`:28-33`) gains `worker` and `dump`; `:31`'s claim that `app` is
      "the application: pages, uploads, and the price refresh loop, in one process" is corrected
- [ ] Docker Engine floor at `:84-92`, which today states no Engine floor at all: **≥ 29.5.1**, and
      say which property depends on it. Not 26.0 — that sits inside the affected range of
      CVE-2024-41110 (AuthZ bypass, CVSS 9.9, ≤ 26.1.4), and more to the point CVE-2025-54410
      ("firewalld reload removes bridge network isolation", fixed 28.0.0) removes exactly the
      cross-bridge isolation this slice asserts between `worker` and `gate`, since both egress
      networks are non-internal. CVE-2024-29018 stays as the *illustration* of why internal networks
      need a patched engine, with its real scope stated: it leaks only where the host's
      `resolv.conf` names a loopback forwarding resolver. Carry the advisory's own workaround for
      operators who cannot upgrade — an explicit `dns:` on the internal-only services.
- [ ] The same paragraph enumerates the stack's outbound hosts (`ghcr.io`, `quay.io`) and needs
      Yahoo's — which is **four hosts**, not one: `query2.finance.yahoo.com` for quotes and charts,
      `finance.yahoo.com` and a hardcoded `query1.finance.yahoo.com` for the cookie/crumb bootstrap,
      and `guce.yahoo.com`/`consent.yahoo.com` for the EU consent chain. Anyone writing an egress
      allowlist from a one-host list gets a stack that fails on its first fetch.
- [ ] The env table (`:250-257`) — the same six rows as DESIGN.md, same additions
- [ ] Upgrade runbook: tickets 00 and 03 documented their own variables where they landed; check
      those sections read as one story rather than two. The
      password alphabet, with the reason per character rather than the label — `/`, `?` and `#`
      truncate or reparse the authority, `@` re-splits the userinfo, and `%` is percent-**decoded**
      by `pg-connection-string`, so `abc%41def` connects as `abcAdef`; existing clusters also need
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
      creates and grants `portfolio_worker` by hand (migration 0012 skips it rather than failing,
      per ticket 01), and **roles are cluster-global while these databases are not** — two instances
      on one cluster share one `portfolio_worker`, and each one's provision step rotates the other's
      credential on every boot.
- [ ] The symbol-length note: stored symbols up to 40 chars are accepted
      (`instrument-resolution.server.ts:309`); the mailbox accepts only pattern-conforming ones
      (≤15), so an unusual symbol shows permanently stale
- [ ] The password's visibility: it is in `docker inspect`, `docker compose config` and
      `/proc/1/environ`, and it sits in the **app's** environment as well as the worker's. Harmless
      — the app is already the superuser — but an operator should read it here rather than discover
      it.

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
