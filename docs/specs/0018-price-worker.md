# 0018 — The price worker: egress-isolated fetching with a minimal database role

**Status:** proposed · **Slice directory:** `docs/specs/price-worker/` · **ADR:** 0010 (new, reserved
for this spec by `docs/adr/0011-a-backfill-fills-the-spine-but-never-moves-it.md:11`)

> **Renumbered and re-grounded.** This spec was drafted as `0015` before specs 0015-0017 took that
> number, and before ADR-0011's backfill landed. It is now `0018`, and §2.2, §3.2, §3.3, §3.5 and §4
> are rewritten against the tree as it stands. §2.4 records what the re-grounding changed and why one
> ticket disappeared. Line references below were re-verified file by file.

---

## 1. Intention

Remove every internet route from the `app` and `db` containers, so that a compromised
application — a trojaned npm dependency, a supply-chain payload of the TeamPCP kind — has no
network path out. The only code that talks to the internet, the Yahoo price fetch, moves into a
dedicated sidecar container (`worker`) that:

- has **no listening port and no API** — the app never addresses it; all coordination goes
  through Postgres rows,
- connects to Postgres as a **new minimal-privilege role** that can read ticker symbols and
  write prices, and cannot read an account, a person, a holding, an upload, or any amount of
  money,
- is the **only** container on an egress-capable network besides the auth gate (which must
  reach Google) and Caddy (which owns the published port).

The inversion this buys: today the internet-facing code (`yahoo-finance2`, the app's riskiest
dependency — the Dockerfile already amputates part of it, `Dockerfile:78`) runs inside the process
that holds full database access. After this slice, the internet-facing code sees ticker symbols and
prices — public market data — and the process that sees the family's money cannot open a socket to
anywhere.

## 2. Background and context

### 2.1 Threat model

The concern is npm supply-chain compromise (e.g. the 2026 TeamPCP campaign: poisoned packages,
credential theft, CI compromise). This app holds a family's complete financial position. The app
already has strong container hardening (all caps dropped, `no-new-privileges`, read-only rootfs,
non-root, `compose.yaml:215-221`) and CI supply-chain checks (`npm audit signatures`, a pure-JS
production-tree gate, `ci.yml:66-136`). What it lacks is **egress control**: any code in the app
container can open an outbound connection, and the app's Postgres role is the bootstrap superuser
(`compose.yaml:58`, `:204` — the same `portfolio` user everywhere, with a **defaulted password**,
`compose.yaml:59`; §3.5 closes that too, because a minimal role means nothing while the superuser
password is guessable).

ADR-0009 already stated the honest version of the property the stack holds today
(`docs/adr/0009-the-stack-takes-dumps-not-backups.md:26-30`): the stack is not egress-free and never
has been — the gate's token exchange with Google and the app's fetch from Yahoo are both outbound,
both named in one place each, and neither carries a credential to the household's data. This slice
does not add a property; it moves the second of those two out of the process that holds everything.

### 2.2 What exists today (verified against the tree)

**A refresh is two fetches, not one.** ADR-0011 landed after this spec's first draft. The unit every
caller runs is `refreshPrices` (`app/lib/prices.server.ts:666-703`): `refreshQuotes` when quotes are
wanted, then **one bounded backfill batch** (`backfillCloses`, `:548-637`) always, inside a
`try`/`catch` that keeps a batch failure from falsifying what the quotes did (`:686-702`). No
production caller invokes `refreshQuotes` any more — only tests do.

- **Three internet touchpoints, all in the app process:**
  1. The refresh loop: `app/lib/price-poller.server.ts`, started from the root loader
     (`app/root.tsx:67`), cadence read from `app_setting.refresh_cadence_minutes`
     (`0008_refresh_cadence.sql`, via `readRefreshCadence`, `app/lib/settings.server.ts:182-189`).
  2. "Refresh now": `app/routes/refresh.ts:66-68` calls
     `withRefreshLock(() => refreshPrices(yahooPriceProvider(), …))` inline in the action. An upload
     fires the same path once it has committed (`app/routes/upload/review.tsx:83`, via
     `requestRefresh`, `price-poller.server.ts:245-258`).
  3. The USD probe at ingest: `app/lib/instrument-resolution.server.ts:499`
     (`const probe = deps.probe ?? probeSymbol`) — a synchronous guard so "a non-USD refusal must
     leave nothing behind."
- **The provider seam already exists, and now carries two methods.** `yahoo-finance2` is imported
  in exactly one place (`app/lib/price-provider.server.ts:619`, dynamic import, client constructed
  at `:620`); `PriceProvider` (`:155-162`) declares `getQuotes` (Yahoo's `quote` endpoint, one
  batched call, `:716`) and `getDailyCloses` (Yahoo's `chart` endpoint, one call per symbol,
  `:756-760`). Prices are written in exactly one module (`app/lib/prices.server.ts`), and the probe
  has an injection seam (`ResolutionDeps.probe`, `instrument-resolution.server.ts:212-216`) that
  production leaves defaulted (`app/routes/upload/instruments.tsx:104` — the only production
  caller).
- **The refresh path reads private tables.** This is the fact that reshapes the spec.
  `selectBackfillCandidates` (`prices.server.ts:295-345`) inner-joins `holding` and `position_set`
  to find instruments whose position history reaches back behind their price spine, and reads
  `price_backfill` for the one-attempt-per-day retry clock (`:306-318`). The quotes half needs no
  private data; the batch half does.
- **A tick runs at any hour.** Since ADR-0011 the market-hours check decides only whether *quotes*
  are asked for, not whether the tick runs (`price-poller.server.ts:108-114`), because a statement
  uploaded on a Saturday should be valued by Monday's open. A quotes-less refresh writes no
  `price_poll` row by construction (`prices.server.ts:663-664`) — so `price_poll` is not a
  liveness signal outside market hours.
- **Compose has no networks at all** — no top-level `networks:` block and no per-service
  `networks:` key. All five services (`db`, `dump`, `app`, `gate`, `caddy`) ride the default bridge;
  only `caddy` publishes a port (`compose.yaml:344-345`).
- **One role.** The app, the migration runner, and the dump sidecar all connect as `portfolio`, the
  initdb superuser. There is no `/docker-entrypoint-initdb.d` mount and no second role anywhere.
  ADR-0009 recorded this as an accepted weakness (`:74-76`): the dump service *holds* rights it must
  never use, and that it never uses them is a property of a script under review, not of a grant.
- **The image starts via `docker-entrypoint.sh`:** validate config (`:11`) → migrate (`:12`) →
  `exec "$@"` (`:14`). The app's healthcheck probes the served port, so `service_healthy` implies
  migrations completed.
- **The runtime image ships no `app/` source at all.** `Dockerfile:104-110` copies exactly five
  named `server/` files, plus `build/`, `node_modules` and `migrations/`. `.dockerignore:13`
  excludes `scripts/` from the build context entirely.
- **Sidecar precedent:** the dump service (`docs/specs/dump/01-the-dump-sidecar.md`,
  `compose.yaml:102`) — same image-plus-narrow-job shape; ADR-0009 `:32-46` is the template for
  arguing a second container against three documents that say there is none.

### 2.3 Decisions this slice reverses or extends (to be recorded, not slipped past)

- **DESIGN.md §10's "Job scheduler" row (`DESIGN.md:826`)** chose in-process polling: "one process
  to deploy, one place to read logs," accepting a missed poll on restart. The security argument —
  egress isolation and role separation — was not an input to that trade-off. This slice reverses the
  row and says why; ADR-0010 carries the full argument.
- **DESIGN.md §10.1 (`:913-918`)** and **ARCHITECTURE.md §3.1 (`:161-163`)** both state there is no
  separate worker service. Same edit, and ADR-0009 `:32-46` already opened that door once.
- **ADR-0011 pre-authorised this slice and named its debt.** `:74-77` rejected shaping the backfill
  as a mailbox request "for now… If 0018 is built, it moves this method with the other," and
  `:114-116` records that the outbound surface grew by one endpoint which "spec 0018, if built,
  inherits." (Those five spec-number references were repointed from 0015 to 0018 with the rename;
  what is left for ticket 05 is the *argument*.) The in-process bullet at `:55-56` — "Nothing is
  shaped for spec 0018's worker" — gets the `Reversed` banner treatment
  `docs/specs/README.md:14-20` describes: corrected beside the argument, not by rewrite. Note what
  it means concretely: this slice does **not** reshape the backfill as a request row in the sense
  ADR-0011 rejected. The batch keeps running as one bounded composition; only the socket moves, and
  the candidate list crosses as data (§3.7).
- **ADR-0005** (auth is a forward-auth gate) is untouched: the gate keeps its Google egress; nothing
  about authentication changes.
- The three-tier single-site invariants (ARCHITECTURE.md §4.2) are *preserved*: the provider import
  site, the price-writer site, and the pool-construction site do not move.

### 2.4 What the re-grounding changed

The first draft assumed a refresh was one function (`refreshQuotes`) over public market data. It is
not. Three consequences, and the design answer this spec now takes:

1. **The backfill's candidate query reads `holding` and `position_set`** — two tables §3.5's first
   draft listed as *invisible to the worker*. A worker that ran `refreshPrices` under the drafted
   grants would fail with a permission error on its first tick.
2. **`price_backfill` did not exist** when the grants were written, so nothing was granted on it.
3. **`PriceProvider` grew a second method**, so the outcome columns, the deadline watchdog and the
   validating wrapper all had to account for two calls rather than one.

The answer taken here is **the app supplies the work; the worker only fetches** (§3.2, alternatives
in §3.7). The app already holds the cadence timer and the database access to decide *what* needs
fetching; the worker holds the socket. Splitting on that line keeps the security claim in §1 literally
true — the worker reads no household table — and it collapses a large part of the original design:

- The worker no longer needs a cadence loop, the market-hours calendar, or `app_setting`, so
  **`app/lib/settings.server.ts` leaves its import closure** — and with it `masking.ts` and the
  `react-router` edge. **The original ticket 01 (extract `masking-policy.ts`) is deleted**: it
  existed only to cut that edge, and there is no longer an edge to cut. Its removal is the clearest
  evidence the split is on the right line; the extraction remains a reasonable tidy-up on its own
  merits, and is not this slice's business.
- The worker is no longer two independent submitters racing for one advisory lock, so the
  "serialised executor" and its `withRefreshLock`-bouncing hazard disappear. The worker drains,
  fetches, writes, reports.
- `app/root.tsx:67` **keeps** `startPricePoller()`. What changes inside the poller is the call it
  makes: the mailbox instead of the provider. The app's module graph still ends up value-importing
  nothing from `price-provider.server.ts`, which is the property that matters.

### 2.5 What "no API on the worker" really means

A mailbox in Postgres is still a channel — but a constrained one. Honest statement of the property:
a compromised app can no longer open a socket to anywhere; the most it can do is name instruments
that already exist and date ranges to fetch them over, and an honest worker fetches only Yahoo's two
endpoints — a code-level property; the `egress-worker` network itself is unrestricted (§8).
Exfiltration shrinks from "arbitrary HTTPS to anywhere" to "a low-bandwidth covert channel via Yahoo
query strings, readable only by Yahoo or an on-path observer." The worker validates every symbol
against a strict pattern before it touches a URL (§3.4), the `probe_request` table carries that
pattern as a CHECK constraint, and `backfill_candidate` carries date bounds as CHECK constraints, to
narrow even that. The residual channels — including the auth gate's OAuth callback, which relays
attacker-chosen bytes to Google's token endpoint from the shared `frontend` network — are listed in
§8.

## 3. Design

### 3.1 Topology: six networks, one new service

Who gets internet access, decided per service:

| Service  | Internet | Why |
|----------|----------|-----|
| `db`     | **no**   | speaks only to its clients |
| `dump`   | **no**   | writes dumps to a bind mount (ADR-0009); reads only `db` |
| `app`    | **no**   | the point of the slice |
| `worker` | yes      | Yahoo — the one legitimate fetch |
| `gate`   | yes      | Google OAuth (DESIGN.md §14, limitation 11) |
| `caddy`  | route exists, unused | a published port cannot live on an `internal` network; Caddy makes no outbound calls by design (residual, §8) |

```yaml
# compose.yaml (sketch — realised across tickets 03 and 04)
networks:
  backend:            # Postgres and its trusted clients. No route out.
    internal: true
  worker-db:          # The worker's ONLY path to Postgres. No route out.
    internal: true
  frontend:           # Caddy to app and gate. No route out.
    internal: true
  egress-worker: {}   # The worker's internet path — shared with nothing.
  egress-gate: {}     # The gate's internet path — shared with nothing.
  ingress: {}         # Caddy's published port lives here.

services:
  db:     { networks: [backend, worker-db] }
  dump:   { networks: [backend] }
  app:    { networks: [backend, frontend] }        # ← no internet route
  worker: { networks: [worker-db, egress-worker] } # ← cannot reach app:3000 or gate
  gate:   { networks: [frontend, egress-gate] }
  caddy:  { networks: [frontend, ingress] }
```

- `internal: true` removes external routing; declaring per-service `networks:` also detaches the
  implicit default bridge (compose spec) — `app`, `db`, and `dump` end with no path to the internet,
  enforced by Docker networking, not code review.
- **The worker and the app share no network.** The app serves every screen and action
  **unauthenticated** on `:3000` — the gate lives at Caddy, and `AUTH_GATE=external` only controls
  a banner (`app/root.tsx:37-46`, decided at `:92`) — so an egress-capable worker that could reach
  `app:3000` would read the family's money over HTTP and no database role would matter. Hence the
  dedicated `worker-db` network: the worker sees Postgres and the internet, nothing else, and the
  smoke test asserts `app:3000` is unreachable from it (§5). The same logic splits the egress side:
  `egress-worker` and `egress-gate` are separate bridges, or the worker could reach `gate:4180` —
  the sidecar holding the Google client secret — and "Postgres and the internet, nothing else"
  would be false. The smoke test asserts the gate is unreachable from the worker too.
- **Docker Engine floor:** CVE-2024-29018 (the embedded DNS forwarding external lookups even on
  internal networks — an exfiltration channel a TCP-only test never sees) was patched in 23.0.11,
  25.0.5, and 26.0. `docs/operating.md:84-92` currently states only "any v2 is new enough" for
  Compose and no Engine floor at all; ticket 05 adds **26.0 as a conservative floor, not as the
  vulnerability boundary**, and the smoke test asserts external *name resolution* fails from `app`,
  not just that `fetch` does (§5).
- Reachability walk (all verified against `Caddyfile`): browser→caddy (`ingress`), caddy→app and
  caddy→gate including `/oauth2/*` (`frontend`), app→db and dump→db (`backend`), worker→db
  (`worker-db`), worker→Yahoo (`egress-worker`), gate→Google (`egress-gate`). The worker is
  reachable from nothing: no port, no shared network except with `db` and the internet.
- All existing hardening (`cap_drop: ALL`, `no-new-privileges`, `read_only`, tmpfs, non-root) is
  copied onto `worker` unchanged, plus `restart: unless-stopped` and `logging: *container-logging`
  — every service in `compose.yaml` carries the logging anchor (`:38-42`, added under issue #192),
  and a worker left stopped after a daemon restart is the sole price-fetch process silently gone.
- **External-Postgres installs** (`docs/operating.md:184-197`, "Running against your own Postgres")
  keep the worker split, the minimal role, and the mailbox — but not the internal-network guarantee
  as drawn: a container that must reach a database outside Docker cannot sit on an `internal`
  network. Ticket 05's operating.md section defines that mode's override (worker `DATABASE_URL`
  pointing at the external host, `worker-db`/`backend` made routable), states exactly which
  guarantees remain, and says that the operator must create and grant `portfolio_worker` by hand —
  that section's only privilege sentence today is `:193`'s "the role needs to be able to create
  tables". The bundled-db topology is the one this spec's assertions certify.

### 3.2 The worker process

A new entrypoint `server/price-worker.ts`, run as the same container image with an overridden
entrypoint (the standard one would run migrations as a role that cannot):

```yaml
  worker:
    image: ghcr.io/chethan123/portfolio-app:${APP_VERSION:-1}
    entrypoint: ["node", "./server/price-worker.ts"]
    restart: unless-stopped
    logging: *container-logging
    depends_on:
      app: { condition: service_healthy }   # app healthy ⇒ migrations applied
    environment:
      DATABASE_URL: postgres://portfolio_worker:${WORKER_DB_PASSWORD:?see operating.md}@db:5432/portfolio
      MARKET_TIMEZONE: ${MARKET_TIMEZONE:-America/New_York}
      TZ: ${TZ:-UTC}
    healthcheck: …   # a DB-connect probe only — deliberately NOT provider reachability,
                     # for app/routes/healthz.ts:9's reason: a Yahoo outage must not
                     # have Compose restart a healthy worker
```

The worker is a **pure fetcher**. It holds no timer, no calendar, and no opinion about what should
be fetched. Its whole loop:

1. **Validate config** by reusing `loadConfig` (`server/config.ts` — every var it doesn't set has a
   default, so the existing schema serves as-is; no second config module).
2. **Verify the schema ledger:** every `.sql` filename the image ships under `migrations/` is
   present in `schema_migrations` (read via the SELECT-only `pendingMigrations`,
   `server/migrations.ts:65-75`; belt on top of `depends_on`). It waits; it does not migrate,
   because its role cannot.
3. **Drain the mailbox by polling, every ~1-2 seconds, off the pool.** No LISTEN/NOTIFY: a
   dedicated LISTEN client has no auto-reconnect in `pg` v8, its `error` event is a process-crash
   hazard, and notifications are not queued for absent listeners — a doorbell that needs its own
   reconnect machinery plus a fallback poll is three mechanisms where one suffices. Three small
   indexed tables polled at 1-2s on an otherwise idle household database is negligible load and sits
   comfortably under both app-side deadlines (§3.4).
4. **One refresh run at a time.** A run claims every `pending` refresh row (`status = 'running'`,
   `claimed_at = now()`), executes one refresh, and writes the same report to every claimed row — N
   pending requests are one Yahoo fetch, never N (the poller's own rationale: a queue of fetches
   against an unofficial API is how an instance gets rate-limited,
   `price-poller.server.ts:29-31`). A request row arriving mid-run is claimed by the next run —
   worst case one run duration plus one drain interval, comfortably inside the 8s deadline.
   `withRefreshLock` (`prices.server.ts:120-150`) stays as the cross-process belt (a second replica,
   an operator running the worker by hand); a lock refusal reverts claimed rows to `pending` for the
   next drain. Because the app no longer fetches, the worker is the only taker in normal operation —
   the lock is a guard, not a coordination mechanism.
5. **The work it runs.** For a claimed request the worker calls `refreshQuotes` when the row says
   `quotes` (the app decided that from the market calendar), and `backfillCloses` **with the
   candidate rows the app supplied**, read from `backfill_candidate` (§3.3). This needs one small,
   honest change to `prices.server.ts`: `backfillCloses` currently calls `selectBackfillCandidates`
   itself (`:554`); the candidate list becomes a parameter, and `selectBackfillCandidates` stays
   app-side where it can see `holding`. Nothing else about either function moves, so the price
   rules and their tests stay exactly where ARCHITECTURE.md §4.2 says they live.
6. **Probe fulfilment,** independent of any refresh and of the lock: validate the symbol, probe,
   write the verdict columns.
7. **A bounded provider, and recovery from its failures.** Every provider call runs under a deadline
   (`AbortSignal.timeout`-style watchdog, ~30s) — both methods, since `getDailyCloses` is a separate
   per-symbol call: `yahooClient` awaits the library with no abort of its own
   (`price-provider.server.ts:617-624`), and a stalled Yahoo call would otherwise hold the run and
   the advisory lock forever while the DB-only healthcheck kept reporting healthy. Expiry counts as
   `providerFailed` for quotes and as the batch's own failure for backfill. Claims carry a lease:
   claimed rows record `claimed_at`, and a drain treats `running` rows whose lease has expired as
   claimable again, so a worker crash between claim and report strands nothing. Verdict and report
   writes are guarded (`… where status = 'running'` / `status is null`), so an overlapping second
   worker cannot overwrite a landed verdict — first write wins, and a rare duplicate Yahoo call is
   the accepted cost.
8. **Provider hygiene:** the Yahoo client is constructed with `versionCheck: false`.
   `price-provider.server.ts:620` passes **no options object at all** today, and `yahoo-finance2`
   4.0.2 defaults `versionCheck` to true, then fetches `registry.npmjs.org/yahoo-finance2/latest`
   when response validation fails — which would make "an honest worker contacts only Yahoo" false.
   Pinned by a worker test.

Connection budget: the drain loop's pooled reads, `withRefreshLock`'s dedicated lock client, the
Kysely connection doing the refresh work (`prices.server.ts:116-118` runs them on different
connections by design), pool clients idling out their 10s `idleTimeoutMillis`, **and the container
healthcheck's own session** all count against the role concurrently — and `server/db.ts:45` pins no
pool `max`, so the `pg` default of 10 applies. Note also that `backfillCloses` opens **one
transaction per instrument** (`prices.server.ts:573`, `:592`, `:610`) rather than one for the batch.
Ticket 02 sets the worker pool's `max` explicitly, and the role carries `connection limit 10`
(§3.5): the limit is defence-in-depth against a runaway, not the security boundary, and must never
be what fails a healthy refresh or flips the healthcheck.

**The worker's import closure** (enumerated by a `module.register` load hook, not by reading):
`server/price-worker.ts` → `prices.server.ts`, `price-provider.server.ts`, `db.server.ts`,
`market-hours.ts`, `money.ts`, `server/config.ts`, `server/db.ts`, `server/migrations.ts`. That is
kysely/pg/zod/node with relative `.ts` specifiers throughout — compatible with Node 24 type
stripping (`tsconfig.json:28` `erasableSyntaxOnly`), with no `enum`, `namespace` or parameter
property anywhere in it, and no Vite-only construct. **`settings.server.ts` is not in it**, which is
why the `react-router` edge (`settings.server.ts:27` → `masking.ts:14`) never arises (§2.4).

**The published image must learn to carry the worker.** The runtime stage ships no `app/` source at
all — `Dockerfile:104-110` copies exactly five `server/` files plus `build/`, `node_modules`, and
`migrations/` — so as the Dockerfile stands, the worker entrypoint would die on its first import in
production and only run from a checkout. Ticket 01 adds `server/provision-worker-role.ts` to the
copied set (its entrypoint step runs in-image); ticket 02 adds `server/price-worker.ts` plus **every
module of** the closure above, preserving `/app/app/lib/` and `/app/server/` as siblings because
`db.server.ts:16-18` reaches `../../server/*.ts`. `money.ts` is the easy one to miss. The worker
entrypoint must not live under `scripts/` — `.dockerignore:13` excludes that directory from the
build context. Only ticket 03's smoke test would catch an incomplete copy set, because ticket 02's
vitest runs from the checkout; hence ticket 03 asserts the worker container reaches its polling loop
*in the built image*, not merely that a process started.

**The image is shared in this slice, and that is a recorded trade, not an oversight.** One artifact
to build, scan, and version (the dump precedent); `yahoo-finance2` remains on the app container's
disk but is unreachable from app code after ticket 04, and the app container has no egress
regardless — the guarantee is the network, not the file's absence. The residual this accepts: app
and worker share one npm dependency tree, so a single poisoned package can own both ends of the
mailbox at once (§8, "correlated compromise"). The remedy is a **named follow-up slice — worker
supply-chain decorrelation**: the worker gets its own `package.json` and image stage with a
~2-package tree (`pg`, `zod`), and the `yahoo-finance2` client (~40 transitive packages, most of the
worker's surface) is replaced by a hand-rolled fetch of the two Yahoo endpoints the provider actually
uses, parsed by the same Zod schemas that guard it today. That keeps one language, one implementation
of the price-writing rules, and one test suite. A Go (or other-language) worker was considered for
full ecosystem disjointness and rejected: it duplicates the price-writing rules and their tests in a
second language and adds a second toolchain to CI — cost out of proportion to what the tiny-tree
variant already removes. ADR-0010 records both alternatives.

### 3.3 The mailbox: three tables, no deletes by the worker

Migration `0012_price_mailbox.sql`. (Not `0010`: `migrations/0010_price_backfill.sql` and
`0011_latest_position_set_cost.sql` have landed. The **ADR** number 0010 is unaffected and still
free.)

```sql
create table refresh_request (
  id            bigint generated always as identity primary key,
  requested_at  timestamptz not null default now(),
  -- what the app decided from the market calendar; the worker does not re-decide:
  quotes        boolean not null,
  status        text not null default 'pending'
                check (status in ('pending', 'running', 'done', 'error')),
  claimed_at    timestamptz,   -- the lease (§3.2 step 7)
  -- outcome, written by the worker from RefreshPricesReport (prices.server.ts:640-643):
  requested     integer,
  priced        integer,
  stale         integer,
  closes        integer,
  observed      integer,
  provider_failed boolean,
  backfill_attempted   integer,
  backfill_written     integer,
  backfill_batch_failed boolean,
  completed_at  timestamptz
);

-- The work the app supplies with a refresh: which instruments need history, over what span.
-- Written by the app from selectBackfillCandidates (prices.server.ts:295-345); read-only to
-- the worker. This is why the worker needs no grant on `holding` or `position_set`.
create table backfill_candidate (
  refresh_request_id bigint not null references refresh_request(id) on delete cascade,
  instrument_id      bigint not null references instrument(id),
  range_from         date not null,
  range_until        date not null,
  primary key (refresh_request_id, instrument_id),
  check (range_until > range_from),
  check (range_from >= date '1970-01-01')
);

create table probe_request (
  id            bigint generated always as identity primary key,
  -- the covert-channel cap enforced where the app cannot bypass it (§2.5):
  symbol        text not null check (symbol ~ '^[A-Za-z0-9.^=-]{1,15}$'),
  requested_at  timestamptz not null default now(),
  claimed_at    timestamptz,   -- the lease (§3.2 step 7)
  -- verdict, written by the worker (SymbolProbe shape, price-provider.server.ts:631-643):
  status        text check (status in ('ok', 'non-usd', 'unavailable')),
  quote_type    text,
  currency      text,
  answered_at   timestamptz
);
```

- **App side:** compute candidates, INSERT a request row and its candidate rows in one transaction,
  then poll its own row (`completed_at` / `answered_at`) with a short deadline. The app sweeps old
  rows opportunistically before inserting (the `upload_draft` precedent — scaffolding, not history,
  so deletes are allowed and belong to the app); `on delete cascade` takes the candidate rows with
  the request.
- **Worker side:** claim atomically (`update … set claimed_at = now() where … and status is null`-
  shaped, or `status = 'pending'` for refreshes), read the candidate rows for the claimed request,
  UPDATE the outcome/verdict columns guarded on the claim. Never INSERTs requests, never DELETEs
  anything.
- **The candidate rows are also the retry pacing.** `selectBackfillCandidates` excludes instruments
  with a `price_backfill` row younger than `BACKFILL_RETRY_INTERVAL` (`prices.server.ts:98`,
  `:306-318`), and the worker writes those ledger rows. Between enqueue and completion the ledger
  has not moved, so a second enqueue would re-pick the same instruments — which is exactly what
  §3.4's dedupe rule prevents: while an open request exists the app does not enqueue another. The
  bound (`BACKFILL_BATCH_SIZE`, `:87`) is applied app-side, where the query already applies it.
- These are scaffolding tables like `upload_draft`, not history: the append-only rule
  (`position_set`, prices) is untouched; `price_observation`, `price_poll` and `price_backfill`
  remain the durable record of what was fetched.

### 3.4 Route and ingest changes

- **A domain module owns the mailbox, routes stay thin.** New `app/lib/refresh-mailbox.server.ts`
  owns sweep, candidate selection, dedupe, insert, and the poll-to-deadline;
  `app/routes/refresh.ts` keeps its current shape — one call, render the outcome (`run()`,
  `refresh.ts:58`) — because a route that grows SQL and a "busy" rule has taken what the domain
  owns (CLAUDE.md). Dedupe: an open `pending`/`running` row younger than the deadline means
  `{ status: "busy" }` — the same meaning the held lock has today (`refresh.ts:72`). A row the
  worker marked `running` keeps the caller polling to the deadline and typically resolves within it
  (one run satisfies all open rows, §3.2). On deadline: a new outcome variant
  `{ status: "worker-unresponsive" }`, rendered distinctly from `providerFailed` (Yahoo down, worker
  fine) and `error` (database down). The route's `done` variant keeps reporting the quotes half only
  (`refresh.ts:74-81`, by design at `:61-65`); the backfill counts land in the request row and the
  log line, as they do today.
- **The poller stays in the app and stops fetching.** `price-poller.server.ts` keeps its cadence
  re-read and re-arm (`:8-11` — a Settings save still takes effect within one old cadence, no
  restart), its market-hours decision about `quotes` (`:108-114`), and its `logBackfill` line
  (`:146`). What changes is one call: `withRefreshLock(() => refreshPrices(provider, …))` becomes an
  enqueue-and-await through the mailbox module, and the imports of `yahooPriceProvider`
  (`:41`) and `withRefreshLock` go with it. `app/root.tsx:67` is untouched.
- **The JS-off path waits the same way.** Today's document POST runs the refresh *before*
  redirecting (`refresh.ts:38`, `:45-47`) — the reloaded page shows fresh prices because the POST
  blocked on them. Under the mailbox it blocks the same ≤8s then redirects; on a worker-unresponsive
  deadline the reload's unchanged as-of line is the honest signal, and that behaviour is stated in
  the control's copy, not left to be discovered.
- **The probe becomes a factory with one shared deadline.** New `app/lib/probe-mailbox.server.ts`
  exports a factory returning a `ProbeSymbol`-shaped function (`price-provider.server.ts:649`) whose
  deadline is shared across one `resolveAll` invocation: the resolution loop probes sequentially
  (`instrument-resolution.server.ts:502-511`), so per-call deadlines would stack — six new symbols
  against a dead worker must cost one ~5s wait, not six. After the shared deadline expires,
  remaining calls return `{ status: "unavailable" }` immediately, preserving the never-throws
  contract (`price-provider.server.ts:688-693`). Note the existing `unavailable` contract: it does
  *not* block — the instrument is created anyway and the next refresh marks it stale
  (`instrument-resolution.server.ts:513-515`); only `non-usd` refuses. The factory also
  **pre-validates each symbol against the §3.3 pattern before inserting** and returns `unavailable`
  for offenders without touching the mailbox: app-side symbol validation is trim-and-length-only
  (`instrument-resolution.server.ts:308-312`), so "BRK/B" or a 16-character ticker would otherwise
  turn the INSERT into a CHECK-constraint error where today's probe returns a clean `unavailable`
  (create-anyway).
- **The in-process probe default goes away.** Ticket 04 makes `ResolutionDeps.probe` **required**
  and deletes the `probeSymbol` import and `?? probeSymbol` fallback from
  `instrument-resolution.server.ts:20,499` — otherwise the in-process Yahoo path stays in the app's
  module graph as a silent default for any future caller, exactly the off switch §3.6 refuses. The
  one production call site passes the mailbox probe (`app/routes/upload/instruments.tsx:104`); tests
  already inject fakes, except `tests/routes/upload-instruments.test.ts:84,162`, which call
  `resolveAll` with no deps and need a stub.
- After ticket 04 the app's module graph value-imports nothing from `price-provider.server.ts`
  (types cross freely) and the refresh path in the app is mailbox-only.
- **Symbol validation, enforced at three sites:** the probe factory returns `unavailable` for
  pattern-violating symbols before they reach the mailbox (above); the worker checks every symbol
  against `^[A-Za-z0-9.^=-]{1,15}$` before it reaches a URL — for probes directly, and for the
  refresh path via a validating wrapper around the two-method `PriceProvider` (since `refreshQuotes`
  and `backfillCloses` stay untouched), where an excluded `instrument.symbol` is simply not fetched
  and surfaces as `stale` in the quotes report or an unwritten candidate in the batch; and the
  `probe_request` table carries the same pattern as a CHECK constraint (§3.3), so even a compromised
  app cannot place an arbitrary payload in the mailbox. (Yahoo's own symbol alphabet: dots, carets,
  dashes, `=X` currency pairs. The pattern was exercised against real and hostile inputs on
  PostgreSQL: `BRK-B`, `^GSPC`, `EURUSD=X` and `0P0000XYZ1.TO` pass; `BRK/B`, a 16-character
  ticker, an embedded newline, a URL and a quoted string all fail. `$` in a POSIX regex anchors at
  end-of-string, not before a trailing newline.)

### 3.5 The `portfolio_worker` role

Postgres is default-deny: a fresh role can connect and see the catalog, and nothing else (PG15+ even
revoked `CREATE` on `public`). So the role is defined by what it is *granted*, which is exactly
this. **Every statement below was executed under `SET ROLE portfolio_worker` against a live cluster
carrying this repository's full migration set**, and every table in the "invisible" list was
confirmed to raise `permission denied`:

```sql
-- 0012_price_mailbox.sql (same migration; idempotent DO block around CREATE ROLE)
create role portfolio_worker nologin
  nosuperuser nocreatedb nocreaterole connection limit 10;

-- select(quote_type): writeQuoteType's WHERE reads it (prices.server.ts:916-921);
-- UPDATE requires SELECT on columns the condition reads.
grant select (id, symbol, price_source, quote_type), update (quote_type)
  on instrument to portfolio_worker;
grant select, insert, update on quote              to portfolio_worker;  -- upsert (:871-891)
grant select, insert, update on price_daily        to portfolio_worker;  -- upsert (:937-949)
                                                                         -- + backfill (:979-990)
grant select, insert on price_observation          to portfolio_worker;  -- arbiter + RETURNING
grant insert on price_poll                         to portfolio_worker;
grant insert on price_backfill                     to portfolio_worker;  -- the attempt ledger
grant select on schema_migrations                  to portfolio_worker;
grant select, update (status, claimed_at, requested, priced, stale, closes, observed,
                      provider_failed, backfill_attempted, backfill_written,
                      backfill_batch_failed, completed_at)
  on refresh_request to portfolio_worker;
grant select on backfill_candidate                 to portfolio_worker;
grant select, update (status, claimed_at, quote_type, currency, answered_at)
  on probe_request to portfolio_worker;
```

- **Column grants where a table mixes public and private:** `instrument` only. The worker sees
  id/symbol/source/quote-type, not `name` or `classification_id`. Everywhere else the whole table is
  public market data or a mailbox row, and a whole-table grant is the honest shape.
- **The three SELECT subtleties**, each of which a first draft missed and a live run caught. An
  `UPDATE … WHERE` requires SELECT on the columns the condition reads (`instrument.quote_type`); an
  `ON CONFLICT DO UPDATE` requires SELECT on every column its expressions read via `excluded.*`
  (`quote`'s five, `price_daily.close`); a `RETURNING` clause requires SELECT on what it returns
  (`price_observation.instrument_id`, `price_daily.instrument_id`).
- **No DELETE anywhere.** A compromised worker can poison prices (it is the price writer; §8) but
  cannot erase the append-only `price_observation` / `price_backfill` forensics or touch position
  history.
- **`price_backfill` is INSERT-only for the worker.** The ledger's *reader* is the app —
  `selectBackfillCandidates`'s retry clock and the Settings gap list (`backfillGaps`,
  `prices.server.ts:392-462`, read at `app/routes/settings/prices.tsx:29`). The worker records
  attempts and never consults them.
- **Invisible entirely, verified by a permission error on each:** `account`, `person`, `holding`,
  `position_set`, `holding_valued`, `manual_networth`, `upload_draft`, `column_mapping`,
  `classification`, `instrument_alias`, `app_setting`, and `instrument.name` /
  `instrument.classification_id`. `holding_valued_at(d)` and `latest_position_set(…)` are both
  `SECURITY INVOKER` (the default), so calling them raises `permission denied for table
  position_set` rather than leaking through — checked, not assumed.
- `schema_migrations` is created by the migration *runner* (`server/migrations.ts:14`), not by a
  migration file, so it already exists by the time 0012 runs and the grant lands.
- Identity-column sequences need no separate grant — verified empirically (every id in this schema
  is `generated always as identity`; inserts into `price_poll`, `price_backfill` and
  `price_observation` succeeded under these exact grants with no sequence privileges).
  `LISTEN`-free design needs no notification grants; advisory locks require none;
  `withRefreshLock`'s session-lock discipline (`prices.server.ts:120-150`) works unchanged.
- `connection limit 10` matches the worker's real budget (§3.2, with the pool's `max` pinned in
  ticket 02) — defence-in-depth against a runaway, never the boundary.

**The role means nothing while the superuser password is a default.** `compose.yaml:59` falls back
to `POSTGRES_PASSWORD:-portfolio` — written when every container on the network was trusted. This
slice puts the low-trust, egress-capable container on the same network as `db`; a compromised worker
would simply reconnect as `portfolio`/`portfolio` and read everything. Ticket 04 makes
`POSTGRES_PASSWORD` required (`:?`) — which also forces re-deriving the two `DATABASE_URL` defaults
that embed `portfolio:portfolio` today (`compose.yaml:126`, `:204`; the coupling `compose.yaml:56-57`
warns about) to `postgres://portfolio:${POSTGRES_PASSWORD}@db:5432/portfolio`, or app and dump
crash-loop on first start with a non-default password — and the **checked-in `.env.example:23`**,
whose explicit `DATABASE_URL=postgres://portfolio:portfolio@…` would override the re-derived default
for anyone following the documented `cp .env.example .env` flow, is updated in the same ticket, along
with the commented `#POSTGRES_PASSWORD=portfolio` at `:104`.

Two traps ticket 04 must not walk into:

- **`smoke-test.sh:108-116` asserts that a bare `up` names one of the four gate variables.** It runs
  with `--env-file /dev/null` and no `POSTGRES_PASSWORD` exported, and `compose.yaml:59` sits in the
  *first* service in the file, ahead of the gate's `:?`s at `:248-254`. If Compose reports only the
  first missing variable, that assertion inverts. It must be updated deliberately, not discovered.
- **Interpolating a raw password into a URL breaks on URL delimiters** (`/`, `?`, `#` — and
  percent-encoding the shared variable breaks provisioning, which would store the encoded text
  literally), so the documented password alphabet is restricted to URL-safe characters and the
  provision step validates it.

The runbook (ticket 05) states the upgrade steps for existing installs: the initdb-time password is
baked into the cluster, so operators must also `ALTER ROLE portfolio PASSWORD …`, not just edit
`.env`.

**Credential provisioning.** The grants and the `NOLOGIN` role are schema history and live in the
migration. The *login credential* is operator config: a new entrypoint step
(`server/provision-worker-role.ts`, running as `portfolio` after `migrate.ts` in
`docker-entrypoint.sh:12`) executes `ALTER ROLE portfolio_worker LOGIN PASSWORD $WORKER_DB_PASSWORD`
when the variable is present — and **creates the role first if it is missing**, because a restore is
exactly where it will be: the dump is per-database (`scripts/dump-loop.sh:262` runs
`pg_dump -d "$DATABASE_URL" --format=custom`, no `--create`, no roles) while roles are
cluster-global, so a dump restored onto a fresh cluster carries `schema_migrations` (migration 0012
will never re-run) and ACL entries naming a role that does not exist. **Verified, not reasoned:**
restoring such an archive onto a cluster without the role stops at the first ACL entry —
`pg_restore: error: … role "portfolio_worker" does not exist / Command was: GRANT SELECT(id) ON
TABLE public.instrument TO portfolio_worker` — and with `--single-transaction` the whole restore
rolls back. The restore runbook (ticket 05) therefore bootstraps the role *before*
`pg_restore --exit-on-error`. The app holding this credential grants it nothing — it already connects as the
superuser that created the role. Config surface: `app` gains optional `WORKER_DB_PASSWORD`, **added
to `configSchema`** (`server/config.ts:35-94`) so the provision step reads it through `loadConfig` —
ARCHITECTURE.md §4.2's rule that `server/config.ts` is the only reader of `process.env`
(`ARCHITECTURE.md:345`) survives intact; `worker` reuses the same schema with its own
`DATABASE_URL`. DESIGN.md §10.1's env table (`:944-951`) gains the rows and the reasoning; the
compose header's "every other setting has a working default" contract (`compose.yaml:20`) is
amended, because after this slice two additional variables are deliberately without defaults.

### 3.6 Development and tests

- **`npm run dev` has no worker.** The dev story is one extra command:
  `node --env-file=.env.worker ./server/price-worker.ts` in a second terminal when live prices are
  wanted — with its own env file, because `.env`'s `DATABASE_URL` is the `portfolio` superuser
  (`docs/developing.md:57`) and running the internet-facing worker with full database access in
  development would skip the very privilege boundary this slice exists for. `docs/developing.md`
  gains the recipe: a one-time local provisioning command (the same `provision-worker-role.ts`) plus
  an `.env.worker` whose `DATABASE_URL` names `portfolio_worker`. Without a worker running, screens
  serve stored prices, "Refresh now" reports worker-unresponsive, and feed-symbol ingest probes come
  back `unavailable` after one shared ~5s deadline — the instruments are **created anyway**, unpriced
  until a worker runs (the existing `unavailable` contract; only `non-usd` refuses). The two
  existing recipes that assume an in-process fetch — `docs/developing.md:391-434` ("Exercise a
  backfill locally") and `:435-474` (the split convention) — are updated in the same ticket.
  **Deliberately no `PRICE_FETCH=in-process` fallback mode:** a second code path would keep the
  yahoo import reachable from the app and give the security property an off switch. (Assumption to
  confirm with the owner; reversing it later is additive.)
- **Tests keep running through the app-side fixtures.** `refreshQuotes`, `backfillCloses`,
  `price-provider`, and poller tests are untouched in substance (the modules don't move; only who
  calls them does, plus `backfillCloses`'s candidate parameter). New tests, all against real
  Postgres per house style:
  - the mailbox probe returns each `SymbolProbe` verdict, shares one deadline across a batch, and
    maps expiry to `unavailable`;
  - the refresh mailbox module writes candidate rows from `selectBackfillCandidates`, dedupes onto
    an open request, and reports `worker-unresponsive` on deadline;
  - worker drain: N pending refresh rows satisfied by one report; a request with candidate rows
    backfills exactly those instruments; probe fulfilment writes the verdict columns;
  - **the permission pin:** with `SET ROLE portfolio_worker`, a full `refreshPrices`-equivalent run
    (quotes plus a candidate-driven batch) completes against seeded fixtures — and the role's
    **complete ACL is snapshot-asserted**, not spot-checked. The test enumerates every table
    privilege from `information_schema.role_table_grants` and every column privilege from
    `information_schema.role_column_grants` *not already implied by a table grant*, and compares
    both against the exact §3.5 allowlist, so a later migration that grants `person`, a private
    `instrument` column, or any DELETE fails the suite by name. A single `select account throws`
    assertion would stay green through exactly the widening it exists to catch.

  A permission error aborts the enclosing transaction, and `withDatabase`
  (`tests/support/database.ts:92`) gives the whole test body one. Wrap each expected-denial
  assertion in a **savepoint** rather than settling for one denial per test — verified on
  PostgreSQL: `savepoint s; select … from holding; rollback to s;` leaves the transaction usable,
  so one test can assert the whole invisible list and then keep going. Kysely 0.29.5 exposes
  `trx.savepoint(name)`.

### 3.7 Alternatives considered for the backfill's private reads

The backfill's candidate query is the only part of a refresh that needs household data (§2.4).
Three ways to keep it away from the worker; the third is what §3.2 takes.

- **Grant the worker `holding(instrument_id, position_set_id)` and
  `position_set(id, as_of_date)`.** Smallest possible change — two column grants, no new table, the
  worker keeps its own cadence loop. Rejected because it falsifies §1's claim in its own first
  paragraph: the worker would read the household's holdings table. The disclosure is genuinely
  small (which instruments appear in which position sets, and those sets' dates — no amounts, no
  accounts, no people, and the set cannot be tied to an account) and it would have been defensible
  with the claim restated. It was rejected on the principle that a security slice should not spend
  its headline property to save a table.
- **A view owned by `portfolio`, granted to the worker.** A `SECURITY INVOKER = false` view returns
  candidates without exposing the base tables — Postgres's own mechanism, and consistent with this
  repo putting valuation rules in SQL. Rejected because the rule would then exist a fourth time:
  `selectBackfillCandidates`, `backfillGaps`, their pinned tests, and now SQL. Commit `dd68e49`
  fought precisely that duplication. Consolidating all of them onto one view is a plausible future
  refactor and is not this slice's business.
- **The app supplies the work; the worker only fetches.** Taken. Costs one more mailbox table and
  leaves the cadence timer in the app; buys the literal §1 claim, deletes a ticket, deletes the
  serialised executor, and removes `app_setting` from the grant list.

## 4. Tickets

Shape per `docs/specs/README.md`; one ticket = one PR that typechecks, builds, tests green standing
alone.

| # | Ticket | Blocked by |
|---|--------|------------|
| 01 | Migration `0012_price_mailbox.sql`: the three mailbox tables (symbol and date-range CHECKs), `portfolio_worker` role + grants (as §3.5, including the three SELECT subtleties); `server/provision-worker-role.ts` + entrypoint step + its Dockerfile COPY; optional `WORKER_DB_PASSWORD` in `configSchema`; regenerate `database.generated.ts`; the ACL snapshot permission-pin test | Nothing |
| 02 | `server/price-worker.ts`: config reuse, ledger check, 1-2s pool-based drain loop (one report satisfies all claimed rows), lease claims + guarded writes, provider deadline watchdog on both methods, `versionCheck: false`, symbol validation, pinned pool `max`; `backfillCloses` takes its candidates as a parameter; Dockerfile carries the worker entry + its closure; worker-side fulfilment tests | 01 |
| 03 | **Deploy the worker alongside** (app untouched and still fetching): compose `worker` service (hardening, logging anchor, `restart: unless-stopped`, DB-connect healthcheck, `WORKER_DB_PASSWORD`), `worker-db` + `egress-worker` networks with `db` attached to `worker-db` (everything else stays on the default network for now); `compose.dev.yaml` worker override reusing the locally built `portfolio-app:dev` image so smoke certifies the checkout, not a GHCR release; `smoke-test.sh` service lists (`:71`, `:342-350`, `:365`, `:379-385`, `:401`), published-port assertion, and a seeded mailbox row the worker must fulfil in the built image | 02 |
| 04 | **App cutover and lockdown**: `refresh-mailbox.server.ts` + thin `refresh.ts` + the poller's enqueue + `probe-mailbox.server.ts` factory (shared deadline, pattern pre-validation) + make `ResolutionDeps.probe` required (delete the `probeSymbol` default, `instrument-resolution.server.ts:20,499`; fix `tests/routes/upload-instruments.test.ts:84,162`) + `instruments.tsx:104` wiring; the full six-network topology (§3.1); `POSTGRES_PASSWORD` required with the app/dump `DATABASE_URL` defaults re-derived (`compose.yaml:126`, `:204`), `.env.example:23` and `:104` updated, and `smoke-test.sh:108-116`'s missing-variable assertion updated; compose header prose (`:1-26`); smoke: egress + DNS + app-unreachable-from-worker + gate-unreachable-from-worker, re-point the in-container yahoo-import check (`:265-268`) at `worker`; route tests | 03 |
| 05 | Docs: DESIGN.md §6.2 (`:443-502`) + §10 row `:826` + §10.1 services block `:876-903` and env table `:944-951`; ARCHITECTURE.md §3.1 `:161-163`, §4.2 rows `:338`/`:345`, §11.2 `:1959`; ADR-0010; ADR-0011's banner and renumbered references; CONTEXT.md entries; `docs/operating.md`: engine floor at `:84-92`, the service table `:28-33`, upgrade runbook, restore `:870-904` and rehearsal `:906-929`, external Postgres `:184-197`; `docs/developing.md` dev-worker recipe and the two stale recipes; `docs/specs/README.md` index row and ticket-directory line | 04 |

Everything is a chain (01 → 02 → 03 → 04 → 05). The original ticket 01 (masking-policy extraction)
is deleted — see §2.4.

**Deploy coupling: none — every ticket leaves a deployable main.** After 03 the worker runs alongside
the still-fetching app, draining a mailbox the app does not yet write to; 04 is the single release
where the app stops fetching and loses its internet route. There is no commit from which a deploy has
no price refresh.

## 5. Acceptance (slice level)

- From `app` and `db`: outbound TCP fails (`fetch('https://example.com')` errors) **and external DNS
  resolution fails** (the unpatched-engine exfil channel, asserted separately). From `worker`, Yahoo
  resolves and the app's screens show fresh prices. These become smoke-test assertions in tickets
  03-04.
- From `worker`: `app:3000` and `gate:4180` are **unreachable** (the gate-bypass and the auth
  sidecar's client secret a shared network would expose), and the worker container fulfils a seeded
  mailbox row *in the built image*, not merely starts a process.
- "Refresh now" round-trips through the mailbox within the deadline on all five screens; JS-off
  behaviour unchanged (blocks ≤ deadline, then redirects).
- A refresh still backfills: an instrument whose position history predates its spine gets its closes,
  and its `price_backfill` ledger row, through the mailbox — with the worker holding no grant on
  `holding` or `position_set`.
- Feed-symbol ingest probes resolve through the mailbox; a non-USD symbol still refuses cleanly with
  nothing written; a dead worker costs one shared deadline, not one per symbol.
- The permission-pin test fails if anyone widens the worker's grants or reads a private table through
  the worker role.
- A fresh `docker compose up` with the two required env vars set (`WORKER_DB_PASSWORD` new,
  `POSTGRES_PASSWORD` newly required), including via the documented `cp .env.example .env` flow,
  comes up healthy end to end; the same command without them fails fast at interpolation with a
  message pointing at the runbook.
- `npm run typecheck`, `npm test`, `npm run build`, and `scripts/smoke-test.sh` green.

## 6. Documentation deltas (detail for ticket 05)

- **DESIGN.md**: §6.2 (`:443-502`) gains the mailbox paragraph and the backfill paragraph
  (`:483-492`) gains its worker sentence; §10's Job scheduler row (`:826`) rewritten (worker
  container, and *why the trade flipped*: egress isolation + role separation outweigh "one process to
  deploy" now that the threat model includes dependency compromise); §10.1's services block
  (`:876-903`) gains `worker` **and `dump`, which is still missing**, and the "one decision rather
  than four" count at `:905` becomes a rule; env table (`:944-951`) gains `WORKER_DB_PASSWORD`,
  `POSTGRES_PASSWORD` and the worker's vars — that table is already six `DUMP_*` variables behind.
- **ADR-0010 "Price fetching is an egress-isolated worker"**: context (supply-chain), decision
  (mailbox over API, polling over LISTEN/NOTIFY, role over trust, the app supplying the work),
  consequences (worker-down UX state, covert-channel residuals, correlated compromise until the
  follow-up slice, deploy coupling, two required env vars), alternatives rejected (the three in
  §3.7, plus in-app fallback mode, an HTTP API on the worker, a LISTEN/NOTIFY doorbell, separate
  images now, a Go/second-language worker), and the named follow-up (worker supply-chain
  decorrelation). ADR-0009 `:32-46` is the template for the "this reverses 'no separate worker
  service'" section.
- **ADR-0011**: its spec-number references were already repointed to 0018 with the rename; what is
  owed is `:55-56`'s "Nothing is shaped for spec 0018's worker", which gets a `Reversed` banner in
  the form `docs/specs/README.md:14-20` describes.
- **ARCHITECTURE.md**: §3.1's "**No worker container**" (`:161-163`) rewritten; §4.2's yahoo-import
  row (`:338`) keeps its site and its `:619` reference — **both are correct today, contrary to what
  the first draft claimed** — but its reachability note changes (imported only by the worker
  process); the env-reader row (`:345`) gains the worker entrypoint and provision step; §11.2's
  in-process-poller debt row (`:1959`) is discharged.
- **CONTEXT.md**: *price worker*, *mailbox* — and the words to avoid: "queue", "job table" (three
  request tables, not a general queue). They join the existing "How prices stay fresh" section
  (`:93-120`), whose *Refresh cadence* (`:95`) and *Poll* (`:108`) entries both describe the app
  refreshing and need one clause each.
- **docs/operating.md**: the "What runs here" table (`:28-33`) gains `worker` and `dump`, and `:31`'s
  claim that the refresh loop runs in `app` "in one process" is corrected; the Engine floor at
  `:84-92`; the env table (`:250-257`); the restore procedure (`:870-904`) — `:893-895` names the
  in-app refresh loop as the connection holder that would make `dropdb` fail, which becomes the
  worker and the dump; the rehearsal (`:906-929`); `:978`'s service list; the external-Postgres
  section (`:184-197`).
- **docs/README.md's "state rules, not counts" rule** (`:9-12`) is what all of the above turns on.
  ADR-0009 `:81-82` accepted the obligation to convert the "four services" counts to rules and it was
  not discharged; a worker makes the count six. Ticket 05 clears it in the passages it is already
  editing, rather than leaving a second slice's debt to a third.

## 7. Out of scope

- gVisor/runsc runtime overlay (companion change, separate compose override file).
- Pinned items from the earlier hardening list (`.npmrc` ignore-scripts, Dockerfile
  `--ignore-scripts`, SHA-pinned Actions, Renovate, digest-pinned images).
- **Worker supply-chain decorrelation** — the named follow-up slice (§3.2): worker-own
  `package.json`/image stage, ~2-package tree, hand-rolled Yahoo fetch + the existing Zod schemas
  replacing `yahoo-finance2`. A Go worker was considered and rejected there.
- **Consolidating `selectBackfillCandidates` and `backfillGaps` onto one SQL view** (§3.7's second
  alternative) — a plausible refactor, not a security change.
- Extracting `masking-policy.ts` from `masking.ts` — no longer needed by this slice (§2.4), still a
  reasonable tidy-up on its own.
- Moving the *app* off the `portfolio` superuser role — opened by this slice (and made meaningful by
  the required-password change), not done in it.
- Any auth change (ADR-0005 stands).

## 8. Residual risks, stated plainly

- **Price poisoning:** the worker is the price writer by design; a compromised worker can skew
  valuations. Mitigations: no DELETE (forensics survive in `price_observation` and `price_backfill`),
  Zod validation of provider payloads stays with the provider code, and the household sees the as-of
  line. Not eliminable without removing the feature.
- **Covert exfiltration channels that remain:** symbol strings to Yahoo (bounded by the validation
  pattern; readable only by Yahoo or an on-path observer), the date ranges on candidate rows (bounded
  by CHECK constraints, a few bits each), and the gate's OAuth callback
  (`/oauth2/callback?code=…` relays attacker-chosen bytes to Google's token endpoint from
  `frontend`). Same class, same observer constraint. Accepted.
- **Correlated compromise (until the follow-up slice):** app and worker share one npm tree, so one
  poisoned package can sit on both ends of the mailbox and coordinate. Be precise about what survives
  that case: the worker-side pattern check is then compromised code, the app (still the `portfolio`
  superuser) can stage bytes in any worker-readable column (`instrument.symbol` is unconstrained
  `text` in the schema — the 40-char cap is app code at
  `instrument-resolution.server.ts:309`), and the `egress-worker` network is unrestricted internet —
  nothing but code pins the worker to Yahoo. The surviving bound is the worker role's *read set* plus
  arbitrary egress; the CHECK constraints bite only in the compromised-app/honest-worker case. The
  decorrelation slice (§7) shrinks the worker's tree to ~2 packages and removes the shared provider
  dependency entirely.
- **Symbol-length mismatch:** the app accepts stored symbols up to 40 characters
  (`instrument-resolution.server.ts:309`); the worker fetches only pattern-conforming symbols
  (≤15, no slashes), so an unusual-but-legitimate stored symbol would never refresh and would show as
  permanently stale. Documented in ticket 05; tightening the app-side symbol rule to match is a small
  follow-up decision.
- **A refresh now needs two healthy processes.** The app decides and the worker fetches, so an app
  outage stops price refresh as well as the screens that would show it — no loss in practice, since
  prices are only read through the app. The missed-poll-on-restart limitation DESIGN.md §10 accepted
  is *kept*, not fixed: it was never this slice's to fix.
- **Ticker-list disclosure:** the worker (and Yahoo) necessarily learn which symbols the family
  tracks, and — through candidate rows — roughly how far back it has held them. True of Yahoo today
  as well. Accepted.
- **Engine floor:** unpatched engines leak DNS from internal networks (CVE-2024-29018, fixed in
  23.0.11 / 25.0.5 / 26.0). The docs state 26.0 as a conservative floor — not the vulnerability
  boundary — and the smoke test catches the symptom.
- **Worker outage = stale prices:** surfaced honestly (as-of line, worker-unresponsive outcome).
  `price_poll.started_at` is a *coarse and incomplete* heartbeat: rows appear only on committed runs,
  and since ADR-0011 a quotes-less weekend refresh writes none at all. Accepted at this household's
  stakes.
- **Caddy retains an unused internet route** (published-port constraint). It makes no outbound calls
  and fronts everything anyway; constraining it further (DOCKER-USER rules) is out of scope.
