# 08 — The record: documents, ADR-0010, runbooks

_Part of [0018-price-worker.md](../0018-price-worker.md) (§2.4, §6)._

**What to build:** Nothing that runs. Every document that says prices are fetched in-process, that
there is no worker container, that the database has one role, or that `DATABASE_URL` carries a
password is brought level with what shipped; ADR-0010 records the decision and the alternative the
owner may still reverse; the glossary gains the three words this slice introduced; the runbooks
gain the steps that keep an instance upgradable and restorable.

Separate because a prose diff across this many files is reviewed by reading, and because until
[07](07-the-egress-allowlist.md) lands these documents would describe an intention.

**Blocked by:** [07](07-the-egress-allowlist.md).

**Status:** ready-for-agent

**`DESIGN.md`**

- [ ] §10's **Job scheduler** row (`:826`): the scheduler stays in-process and the fetch moves to a
      worker container behind one table; why the trade flipped — egress isolation and role
      separation outweigh "one process to deploy" once the threat model includes dependency
      compromise
- [ ] §10.1: `:913-918`'s "why there is no separate worker service" rewritten; the services block
      (`:874-903`) gains `worker` and `egress-proxy` — and `dump`, missing today; the environment
      table (`:944-951`) gains `WORKER_DB_PASSWORD` and the sentence about `POSTGRES_PASSWORD`; the
      hardening paragraph (`:905-911`) covers the new services
- [ ] §6.2 gains the mailbox paragraph beside the observation log; §6.1's printed interface
      (`:416-419`) is unchanged and gains one sentence: two implementations, one in the app
- [ ] §14 gains the accepted limitations spec §8 names: a worker outage is stale prices; the
      symbol-length mismatch; what a hostile feed can still do; Engine below 28

**`ARCHITECTURE.md`**

- [ ] §2 (`:92-100`): Yahoo is reached from the worker through the proxy; the gate needs
      `www.googleapis.com:443` only; Caddy needs no egress; the context diagram's edge moves
- [ ] §4.2: the pool row (`:337`) names the worker as a second user of the one site; the import row
      (`:338`) already points at `server/yahoo-client.ts`; the writer row (`:339`) says the worker
      writes no price; the env-reader row (`:345`) says the driver reads its own `PGPASSWORD`
- [ ] §7.2 (`:1474`): two refreshes under one lock is unchanged, and the lock client now spans the
      mailbox wait; §7.4 (`:1519`): the `Price worker` and `Egress proxy` stems, the heartbeat's
      meaning, the fifth cause; §7.5 (`:1539`): one seam, two implementations, the raw-JSON contract;
      §7.6 (`:1581`): rows for the networks, the role and the allowlist; §7.7 (`:1631`): one image,
      three entrypoints
- [ ] Appendix A: `provider-mailbox.server.ts`, `refresh.server.ts`, `yahoo-client.ts`,
      `symbol-pattern.ts`, `price-worker.ts`, `egress-proxy.ts`, `provision-worker-role.ts`, the
      migration; Appendix B: **Price worker**, **Mailbox**, **Provider call** in the pricing cluster

**ADR-0010 — "Price fetching is an egress-isolated worker behind one table"**

- [ ] Context: the supply chain and the three adversaries. The structural disqualification of spec
      §2.3 in one sentence — what to fetch is a rule over `holding ⋈ position_set`, so a worker that
      owns the refresh needs the household tables. Decision: remote provider, one table, polling,
      the role, passwords out of URLs. Consequences: the deploy-time batch abort, no new UI state,
      two required variables, a shared image safe to restart independently because the table plus
      raw JSON is the whole contract, and the residuals
- [ ] Alternatives rejected, each with its reason: the worker owning the refresh; an HTTP API on a
      shared internal network (symmetric — the worker would reach `app:3000`); `LISTEN/NOTIFY`; a
      separate image now; an in-app fallback mode; a third-party proxy image; `pg_dumpall
      --roles-only` in the dump service; RLS for first-write-wins; a worker-unresponsive UI state
- [ ] The unix socket of spec §2.6, stated neutrally with its ticket delta, as the alternative
      rejected on requirement 4 alone
- [ ] The named follow-ups: worker supply-chain decorrelation (a worker-only image stage, its own
      `package.json`, a hand-rolled fetch of two endpoints behind the same Zod schemas), and the app
      off the superuser
- [ ] ADR-0011 is left as written: its `:11`, `:55-56` and `:74-77` record what was decided then,
      and `:115-116` already foresaw this

**`CONTEXT.md`** (under "How prices stay fresh", `:93`)

- [ ] **Price worker**: the one process that talks to the price feed, holding no rule about what to
      fetch or what a price means. _Avoid_: sidecar, fetcher, poller (for this). **Mailbox**: the
      table through which the app asks and the worker answers, scaffolding the app sweeps.
      _Avoid_: queue, job table, sidecar API. **Provider call**: one row, one library call, one
      answer. _Avoid_: request, job, task
- [ ] **Refresh cadence** (`:95`) and **Poll** (`:108`) still read true and gain nothing: a poll is
      an attempt at quotes wherever the fetch runs

**`docs/operating.md`**

- [ ] Installing (`:84-92`): the Engine 28.0 floor and its check, landed by
      [06](06-the-network-lockdown.md) and re-read here. Running against your own Postgres
      (`:184-197`): `CREATEROLE` for the migration and a superuser for the hardening, or create the
      role first; the override that mode uses — `worker-db` and `backend` routable, the worker's
      `DATABASE_URL` pointing outward — and exactly which guarantees remain: the worker, the role and
      the mailbox, not the internal-network guarantee
- [ ] Environment variables (`:238`): `WORKER_DB_PASSWORD`; `POSTGRES_PASSWORD` required;
      `PGPASSWORD` and the URL rule; generated passwords mandated, with the reason
- [ ] Monitoring: the worker's healthcheck beside `:710`; Logs (`:717`): the `Price worker` and
      `Egress proxy` stems; "There is no price line in the log" (`:761`): the fifth cause
- [ ] Restoring (`:870`): `docker compose stop app worker` — the worker retries the database forever
      and reconnects the instant `createdb` returns; Rehearse it (`:906`): a variant that drops and
      recreates `portfolio_worker` first, so the missing-role failure is exercised rather than
      hidden; Rebuilding a machine (`:931`): create the role before `pg_restore`, and `pg_restore
      --no-acl` as the escape hatch with its caveat — the restored worker has no privileges until the
      next boot's provisioning re-grants them
- [ ] Security (`:485`): what the worker can and cannot reach, the five hosts, the three adversaries
      in an operator's words

**`docs/runbook.md`**

- [ ] "Prices have stopped updating" (`:270`): first `docker compose ps` — an unhealthy or
      restarting `worker` — then `docker compose logs worker` for `Price worker` lines; the
      `Price provider failed` grep now tells "no worker claimed" from Yahoo
- [ ] "I changed the database password" (`:525`): no URL to edit; "I need to restore" (`:553`): stop
      the worker too; "`docker compose up` refuses to start" (`:49`): the two new variables

**`docs/developing.md`**

- [ ] A recipe under Recipes (`:331`): `.env.worker` with
      `DATABASE_URL=postgres://portfolio_worker@127.0.0.1:55432/portfolio_dev` and `PGPASSWORD=…`;
      the one-time `WORKER_DB_PASSWORD=… node --env-file=.env ./server/provision-worker-role.ts`
      (that `.env` is the superuser, `:56-60`); `node --env-file=.env.worker
      ./server/price-worker.ts` in a second terminal; what happens without it — stored prices, "no
      worker claimed", probes `unavailable` after 5 s, instruments created anyway
- [ ] "Verify the split convention" (`:435`): the call now runs from the worker's environment — say
      where, since the app has no path to Yahoo. The `.env` section (`:564-571`): `.env.worker` is
      read by nothing but the command that names it

**`docs/data-model.md`, `README.md`, code comments, the index**

- [ ] `data-model.md`: `provider_call` beside `upload_draft` (§4.6, `:412`) as the other scaffolding
      table, every column and constraint; §7 (`:564`) gains the sweep as a write that is not
      history; §9 (`:704`): the role before the restore
- [ ] `README.md` "Where prices come from" (`:592-600`): "there is no worker container" is false —
      rewritten in the README's own words; the deployment diagram (`:458`) gains the worker and the
      proxy
- [ ] `server/db.ts:59-61`: the lock client now spans the wait for the worker rather than provider
      network work; the listener it justifies stays. `app/lib/price-poller.server.ts:2-6` and
      `compose.yaml:1-2` no longer argue against a worker — earlier tickets touched them; re-read
- [ ] PR #220, if still open, cites spec 0015 as the designed answer to its S3 and S7 — re-point it
      at 0018 and ADR-0010
- [ ] `docs/specs/README.md` already carries 0018 and `price-worker/`; re-check that the row's
      sentence describes what shipped

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build` green (docs-only, but every ticket stands
      alone)
