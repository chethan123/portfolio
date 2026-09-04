# 10 — The record: documents, ADR-0010, runbooks

_Part of [0018-price-worker.md](../0018-price-worker.md) (§2.4, §6)._

**What to build:** Nothing that runs. Every document that says prices are fetched in-process, that
there is no worker container, or that `DATABASE_URL` carries a password is brought level with what
shipped; ADR-0010 records the decision and the alternative the owner may still reverse; the glossary
gains three words; the runbooks gain what keeps an instance upgradable and restorable.

Separate because a prose diff across this many files is reviewed by reading, and because until
[09](09-the-egress-allowlist.md) lands these documents would describe an intention. The lines
earlier tickets landed because they could not wait — 04's restore and bring-your-own paragraphs,
07's recipe, the upgrade notes of 06, 08 and 09 — are re-read here as one story, not rewritten.

**Blocked by:** [09](09-the-egress-allowlist.md).

**Status:** ready-for-agent

**`DESIGN.md`, `ARCHITECTURE.md`**

- [ ] DESIGN §10's **Job scheduler** row (`:826`): the scheduler stays in-process and the fetch
      moves to a worker container behind one table; why the trade flipped (spec §2.4). §10.1:
      `:913-918` rewritten; the services block (`:874-903`) gains `worker` and `egress-proxy` — and
      `dump`, missing today; the environment table (`:944-951`) and the hardening paragraph
      (`:905-911`) gain the new variables and services. §6.2 gains the mailbox paragraph beside the
      observation log; §6.1 (`:416-419`) gains one sentence: two implementations, one in the app.
      §14 gains the accepted limitations spec §8 names
- [ ] ARCHITECTURE §2 (`:92-100`): Yahoo is reached from the worker through the proxy; the gate
      needs `www.googleapis.com:443` only; Caddy needs no egress; the context diagram's edge moves.
      §4.2: rows `:337-339` name the worker as a second pool user, the import site already moved,
      and no price written by the worker; the env-reader row (`:345`) says the driver reads its own
      `PGPASSWORD` and the runtime its own `NODE_USE_ENV_PROXY` and `HTTPS_PROXY` — neither
      `config.ts` nor any application code reads them
- [ ] §7.2 (`:1474`): the lock client now spans the mailbox wait; §7.4 (`:1519`): the `Price worker`
      and `Egress proxy` stems, the heartbeat's meaning, the fifth and sixth causes; §7.5 (`:1539`):
      one seam, two implementations, the raw-JSON contract; §7.6 (`:1581`): rows for the networks,
      the role — provisioned at boot, never by a migration — and the allowlist; §7.7 (`:1631`): one
      image, three entrypoints. Appendix A gains the seven new modules and the migration; Appendix B
      the three terms

**ADR-0010 — "Price fetching is an egress-isolated worker behind one table"**

- [ ] Context: the supply chain and the three adversaries; spec §2.3's disqualification in one
      sentence. Decision: remote provider, one table, polling, the role provisioned at boot,
      passwords out of URLs. Consequences: spec §6's list
- [ ] Alternatives rejected, each with its reason — spec §6's list, RLS carrying the un-claim
      consequence spec §8 names and the start-up refusal its reason from spec §7. The unix socket of
      spec §2.5, stated neutrally with its ticket delta and its own residuals, as the alternative
      rejected on requirement 4 alone
- [ ] The named follow-ups: worker supply-chain decorrelation (spec §7), and the app off the
      superuser — which must budget `reserved_connections` for the app's role. ADR-0011 and spec
      0017 already carry the one-line banner landed with spec 0018 — "spec 0015" there is the
      deleted worker proposal; re-read it, rewrite nothing else in them

**`CONTEXT.md`** (under "How prices stay fresh", `:93`)

- [ ] **Price worker**: the one process that talks to the price feed, holding no rule about what to
      fetch or what a price means. _Avoid_: sidecar, fetcher, poller (for this). **Mailbox**: the
      table through which the app asks and the worker answers, scaffolding the app sweeps. _Avoid_:
      queue, job table, sidecar API. **Provider call**: one row, one library call, one answer.
      _Avoid_: request, job, task. **Refresh cadence** (`:95`) and **Poll** (`:108`) still read true

**`docs/operating.md`**

- [ ] Installing (`:84-92`): the Engine 28.0 and Compose floors with their checks, landed by
      [06](06-deploy-the-worker-alongside.md) and [08](08-the-network-lockdown.md). Running against
      your own Postgres (`:184-197`): [04](04-the-mailbox-and-the-worker-role.md)'s
      `CREATEROLE`/`ADMIN OPTION` paragraph, the override that mode uses, and exactly which
      guarantees remain: the worker, the role and the mailbox; **not** the internal-network
      guarantee, and **not** the availability hardening, which needs a superuser and is logged as
      skipped — a compromised worker there can freeze refreshes or fill temp; and without
      `CREATEROLE` no worker login at all, the refusal logged while the app serves
- [ ] Environment variables (`:238`): `WORKER_DB_PASSWORD`; `POSTGRES_PASSWORD` required;
      `PGPASSWORD` and the URL rule; generated passwords mandated; `.env` before any compose
      command. Monitoring: the worker's healthcheck beside `:710`; Logs (`:717`): the `Price worker`
      and `Egress proxy` stems; "There is no price line in the log" (`:761`): now six causes —
      worker dead or unprovisioned, proxy down — with their signatures
- [ ] Restoring (`:870`): **`docker compose stop app worker` is the first line**, not advice (its
      pool is never idle, so `dropdb` fails while it runs, and it reconnects the instant `createdb`
      returns); `stop worker` survives a reboot as `stop app` does (`:896-900`). The dump's new
      contents — the worker's grants and the catalog `REVOKE`s of research note §2.6 — and the
      non-superuser restore: the `REVOKE`s warn and pass; what aborts under `--exit-on-error` is
      `ALTER … OWNER TO portfolio` and a `GRANT` to a missing role, so the runbook is `--no-owner`
      with both roles pre-created, which succeeds and keeps the worker's grants; `--no-acl` (only
      when a role cannot be created) also exits 0 but drops those grants, so provisioning must
      re-run — the next boot does
- [ ] Rehearse it (`:906`): the same-cluster drill cannot exercise the missing-role case and no
      variant drops the live role; the case is rehearsed in a throwaway container started as
      production's shape — `docker run --rm -d -e POSTGRES_USER=portfolio -e POSTGRES_PASSWORD=x
      postgres:17-alpine`, since under the image's default `postgres` superuser the first abort is
      `ALTER … OWNER TO portfolio`, not the worker role: `pg_restore` into it, expect the `role
      "portfolio_worker" does not exist` abort on the first `GRANT`, `create role portfolio_worker
      nologin`, restore again. Rebuilding a machine (`:931`):
      [04](04-the-mailbox-and-the-worker-role.md)'s line, re-read
- [ ] Upgrading (`:949`): "replace `compose.yaml` with the release's copy before `up -d`" and its
      symptom (a new image under an old file runs with no worker: stale prices, health green, one
      log line per tick), and the rollback note with `DATABASE_URL` back in `.env` — landed by
      [06](06-deploy-the-worker-alongside.md) and [08](08-the-network-lockdown.md). Security
      (`:485`): what the worker can and cannot reach, the five hosts and the server-name rule, the
      three adversaries in an operator's words

**`docs/runbook.md`, `docs/developing.md`**

- [ ] "Prices have stopped updating" (`:270`): first `docker compose ps` for both containers, the
      `Price provider failed` grep now tells "no worker claimed" from Yahoo, and `fetch failed` with
      one cause on every row tells the proxy from Yahoo. "I changed the database password" (`:525`):
      `.env` first, no URL to edit; "I need to restore" (`:553`): stop the worker first, then
      [04](04-the-mailbox-and-the-worker-role.md)'s role line; "`docker compose up` refuses to
      start" (`:49`): the two new variables, and that `ps`, `logs` and `down` refuse too
- [ ] The `.env.worker` recipe [07](07-the-app-cutover.md) landed under Recipes
      (`developing.md:331`), re-read. "Verify the split convention" (`:435`): the call now runs
      from the worker's environment. `:564-571`: `.env.worker` is read by nothing but the command
      that names it

**`docs/data-model.md`, `README.md`, code comments, the index**

- [ ] `data-model.md`: `provider_call` beside `upload_draft` (§4.6, `:412`) as the other scaffolding
      table; §7 (`:564`) gains the sweep as a write that is not history; §9 (`:704`): the role
      before the restore. `README.md` "Where prices come from" (`:592-600`): "there is no worker
      container" is false; the deployment diagram (`:458`) gains the worker and the proxy
- [ ] `server/db.ts:59-61`: the lock client now spans the wait for the worker rather than provider
      network work. `app/lib/price-poller.server.ts:2-6` and `compose.yaml:1-2` no longer argue
      against a worker; re-read. PR #220, if still open, is re-pointed from spec 0015 to 0018 and
      ADR-0010. `docs/specs/README.md`: re-check that the 0018 row describes what shipped

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build` green (docs-only, but every ticket stands
      alone)
