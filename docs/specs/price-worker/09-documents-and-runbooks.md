# 09 — The record: documents, ADR-0010, runbooks

_Part of [0018-price-worker.md](../0018-price-worker.md) (§2.4, §6)._

**What to build:** Nothing that runs. Every document that says prices are fetched in-process, that
there is no worker container, or that `DATABASE_URL` carries a password is brought level with what
shipped; ADR-0010 records the decision and the alternative it was taken over; the glossary gains
two words; the runbooks gain what keeps an instance upgradable and restorable.

Separate because a prose diff across this many files is reviewed by reading, and because until
[08](08-the-egress-allowlist.md) lands these documents would describe an intention. The lines
earlier tickets landed because they could not wait — [06](06-the-app-cutover.md)'s recipe and fifth
cause, the upgrade notes of [05](05-deploy-the-worker-alongside.md),
[07](07-the-network-lockdown.md) and [08](08-the-egress-allowlist.md) — are re-read here as one
story, not rewritten.

**Blocked by:** [08](08-the-egress-allowlist.md).

**Status:** ready-for-agent

**`DESIGN.md`, `ARCHITECTURE.md`**

- [ ] DESIGN §10's **Job scheduler** row (`:826`): the scheduler stays in-process and the fetch
      moves to a worker container behind a unix socket; why the trade flipped (spec §2.4). §10.1:
      `:913-918` rewritten; the services block (`:874-903`) gains `worker` and `egress-proxy` — and
      `dump`, missing today — and the shared volume; the environment table (`:944-951`) gains
      `PRICE_WORKER_SOCKET`, marked development only, and the hardening paragraph (`:905-911`) the
      new services. §6.2 gains the socket paragraph beside the observation log: what crosses it,
      and that the worker holds no rule; §6.1 (`:416-419`) gains one sentence: two implementations,
      one in the app. §14 gains the
      accepted limitations spec §8 names
- [ ] ARCHITECTURE §2 (`:92-100`): Yahoo is reached from the worker through the proxy; the gate
      needs `www.googleapis.com:443` only; Caddy needs no egress; the context diagram's edge moves.
      §4.2: rows `:337-339` — the import site already moved to `server/yahoo-client.ts`, the pool
      row noting that the worker constructs none, and no price written by the worker; the
      env-reader row (`:345`) says the driver reads its own `PGPASSWORD` and the runtime its own
      `NODE_USE_ENV_PROXY` and `HTTPS_PROXY` — neither `config.ts` nor any application code reads
      them
- [ ] §7.2 (`:1474`): the lock client now spans the socket round trip to the worker; §7.4 (`:1519`):
      the `Price worker` and `Egress proxy` stems, what each healthcheck proves, the fifth and sixth
      causes; §7.5 (`:1539`): one seam, two implementations, the raw-JSON contract over the socket;
      §7.6 (`:1581`): rows for the networks, the shared volume and the allowlist; §7.7 (`:1631`):
      one image, three entrypoints. Appendix A gains the six new modules (`refresh.server.ts`,
      `provider-socket.server.ts`, `yahoo-client.ts`, `symbol-pattern.ts`, `price-worker.ts`,
      `egress-proxy.ts`); Appendix B the two terms

**ADR-0010 — "Price fetching is an egress-isolated worker behind a unix socket"**

- [ ] Context: the supply chain and the three adversaries; spec §2.3's disqualification in one
      sentence. Decision: remote provider; a unix socket in a tmpfs volume the two containers
      share; HTTP/1.1 over it with the library's raw JSON as the whole contract; the worker holding
      no database credential and no TCP listener; passwords out of URLs. Consequences: the batch
      abort become a deploy-time event (§3.1); no new UI state (§7); one required variable,
      `POSTGRES_PASSWORD` (§5); one image either side of which restarts independently, the socket
      plus raw JSON being the whole contract (§8)
- [ ] Alternatives rejected, each with its reason — spec §7's list, the mailbox first and at length:
      what it was, and the machinery it needed (spec §2.5's list) as the cost the decision was taken
      on; the heartbeat-file healthcheck it took with it; RLS, `LISTEN/NOTIFY` and the per-operation
      handle as things that only made sense for it; the TCP listener, the start-up refusal, IP
      pinning, the third-party proxy image, `pg_dumpall`, the worker owning the refresh, the
      separate image, the in-app fallback, the worker-unresponsive UI state
- [ ] The named follow-ups: worker supply-chain decorrelation (spec §7), and the app off the
      superuser. ADR-0011 and spec 0017 already carry the one-line banner landed with spec 0018 —
      "spec 0015" there is the deleted worker proposal; re-read it, rewrite nothing else in them

**`CONTEXT.md`** (under "How prices stay fresh", `:93`)

- [ ] **Price worker**: the one process that talks to the price feed, holding no rule about what to
      fetch or what a price means, and no database credential. _Avoid_: sidecar, fetcher, poller
      (for this). **Worker socket**: the unix socket in the shared volume through which the app asks
      and the worker answers — a request and a raw answer, nothing kept. _Avoid_: queue, job table,
      sidecar API, RPC. **Refresh cadence** (`:95`) and **Poll** (`:108`) still read true

**`docs/operating.md`**

- [ ] What runs here (`:28-33`, the services table; `:35-37`, "only `caddy` is reachable from your
      LAN; `app`, `db` and `gate`…"; `:56-59`, "All four drop… Three run as…"; and the verify
      step's "All four services `running` and `healthy`", `:206`): seven services — `db`, `dump`,
      `app`, `gate`, `caddy`, `worker` and `egress-proxy` — the table gaining a `dump` row missing
      today alongside the worker's and the proxy's, every "four" corrected to seven, and the shared
      volume named beside the table
- [ ] Installing (`:84-92`): the Engine 28.0 and Compose floors with their checks, landed by
      [05](05-deploy-the-worker-alongside.md) and [07](07-the-network-lockdown.md), and 05's
      sentence for the hosts smoke never runs on — SELinux-enforcing, `userns-remap`, rootless
      Docker — pointing at the from-`app` socket check as the one command to run by hand. Running
      against your own Postgres (`:184-197`): `compose.external-db.yaml` — defined and shipped by
      [07](07-the-network-lockdown.md), written up here and not redefined:
      `COMPOSE_FILE=compose.yaml:compose.external-db.yaml` in `.env`, once, `db` and `dump` behind
      the `bundled-db` profile so neither starts and backups become the operator's own Postgres's
      job in fact; the symptom of forgetting the override — `app` crash-looping on
      `ETIMEDOUT`/`EHOSTUNREACH` to its Postgres, with no message naming it; and exactly which
      guarantees remain in that mode: the worker still holds no credential and shares no network
      with `app` or `gate`; **not** `app`'s no-egress guarantee, that bridge carrying a default
      route. Nothing about roles: the worker needs none, and "can create tables" stays the whole of
      what the app's role needs
- [ ] Environment variables (`:238`): `POSTGRES_PASSWORD` required; `PGPASSWORD` and the URL rule;
      generated passwords mandated; `.env` before any compose command; `PRICE_WORKER_SOCKET` marked
      development only, re-read. Monitoring: the worker's and the proxy's healthchecks beside
      `:710`, what each proves; Logs (`:717`): the `Price worker` and `Egress proxy` stems, and
      under the `Price provider failed` bullet (`:738`) the three signatures a dead worker, a dead
      proxy and an unreachable Yahoo leave every tick — landed by [06](06-the-app-cutover.md) and
      [08](08-the-egress-allowlist.md), re-read as one. "There is no price line in the log"
      (`:761`) keeps its four causes: they are about a refresh that never ran, and a dead worker or
      proxy is a refresh that ran and failed
- [ ] Restoring (`:870`): `docker compose stop app` stays the first line, and the reason at `:894`
      stays true of `app` alone; one sentence beside it: **the worker may keep running** — it holds
      no database connection and nothing about the restore reaches it, so `stop app` alone is what
      to type. The dump's contents are unchanged by this slice — no grant, no role, no catalog
      `REVOKE` — so a restore onto a fresh cluster (`:931-941`) and the drill (`:906`) need nothing
      new
- [ ] Upgrading (`:949`): "replace `compose.yaml` with the release's copy before `up -d`" and its
      symptom (a new image under an old file runs with no volume and no worker: stale prices, health
      green, one "no worker listening" line per call site, up to two per tick), and the rollback
      note with `DATABASE_URL` back in `.env` — landed by [05](05-deploy-the-worker-alongside.md),
      [07](07-the-network-lockdown.md) and [08](08-the-egress-allowlist.md), and 05's volume
      convention — a changed option string is a new volume name, never `down -v`. Security (`:485`): what the worker can and cannot reach — no
      database, no `app`, no `gate`; the socket and the proxy only — the five hosts and the
      server-name rule, the three adversaries in an operator's words

**`docs/runbook.md`, `docs/developing.md`**

- [ ] "Prices have stopped updating" (`:270`): first `docker compose ps` for `app`, `worker` and
      `egress-proxy`; the `Price provider failed` grep now tells "no worker listening" from Yahoo,
      `fetch failed` with one cause on every `Price worker` line tells the proxy from Yahoo, and
      `Proxy response (502)` in that cause tells Yahoo or the resolver down behind a healthy proxy
      from an SNI teardown. A new entry, **"`worker` is restarting with `EADDRINUSE`, `ENOSPC` or
      `EISDIR` at `/run/price-worker/worker.sock`"**: the volume is polluted — a directory squatting
      the path or its inodes spent, by a compromised or mishandled `app` — and no restart of
      `worker` ends it; `docker compose rm -sf app worker` (stop *and* remove — a stopped container
      still references the volume, and `docker volume rm` refuses one in use), `docker volume rm
      portfolio_price-worker-sock`, `docker compose up -d`; the cluster and the dumps are untouched,
      being directories in the checkout. Beside **Refresh now**: with JavaScript off against a slow
      worker the press can block up to `⌈feed instruments / 100⌉ × 15 s + 5 × 35 s` — 190 s up to a
      hundred feed instruments, more above it — and a house proxy that cuts at 60 s shows its own
      `502`/`504` while the refresh completes behind it — reload rather than press again. "I changed
      the database password" (`:525`): `.env` first, no URL to edit; "I need to restore" (`:553`):
      stop `app` only — the worker may keep running; "`docker compose up` refuses to start" (`:49`):
      `POSTGRES_PASSWORD`, and that `ps`, `logs` and `down` refuse too
- [ ] The `.env.worker` recipe [06](06-the-app-cutover.md) landed under Recipes
      (`developing.md:331`), re-read. "Verify the split convention" (`:435`): the call now runs
      through `server/yahoo-client.ts`, from the worker's environment. `:564-571`: `.env.worker` is
      read by nothing but the command that names it

**`README.md`, code comments, the index**

- [ ] `README.md` "Where prices come from" (`:592-600`): "there is no worker container" is false,
      and the only importer of `yahoo-finance2` is `server/yahoo-client.ts`; the deployment diagram
      (`:458`) gains the worker and the proxy, with the socket edge between `app` and `worker`
- [ ] `server/db.ts:59-61`: the lock client now spans the socket round trip to the worker rather
      than the app's own provider network work. `app/lib/price-poller.server.ts:2-6` and
      `compose.yaml:1-2` no longer argue against a worker; re-read. PR #220, if still open, is
      re-pointed from spec 0015 to 0018 and ADR-0010. `docs/specs/README.md`: re-check that the
      0018 row describes what shipped. `docs/data-model.md` gains no table and no write path — its
      sole-importer sentence was already brought level with `server/yahoo-client.ts` in
      [06](06-the-app-cutover.md)

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build` green (docs-only, but every ticket stands
      alone)
