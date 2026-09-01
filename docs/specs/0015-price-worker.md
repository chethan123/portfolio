# 0015 — The price worker: egress-isolated fetching with a minimal database role

**Status:** proposed · **Slice directory:** `docs/specs/price-worker/` · **ADR:** 0010 (new)

---

## 1. Intention

Remove every internet route from the `app` and `db` containers, so that a compromised
application — a trojaned npm dependency, a supply-chain payload of the TeamPCP kind — has no
network path out. The only code that talks to the internet, the `yahoo-finance2` price
fetch, moves into a dedicated sidecar container (`worker`) that:

- has **no listening port and no API** — the app never addresses it; all coordination goes
  through Postgres rows,
- connects to Postgres as a **new minimal-privilege role** that can read ticker symbols and
  write prices but cannot read a single account, holding, person, or upload,
- is the **only** container on an egress-capable network besides the auth gate (which must
  reach Google) and Caddy (which owns the published port).

The inversion this buys: today the internet-facing code (`yahoo-finance2`, the app's
riskiest dependency — the Dockerfile already amputates parts of it) runs inside the process
that holds full database access. After this slice, the internet-facing code sees ticker
symbols and prices — public market data — and the process that sees the family's money
cannot open a socket to anywhere.

## 2. Background and context

### 2.1 Threat model

The concern is npm supply-chain compromise (e.g. the 2026 TeamPCP campaign: poisoned
packages, credential theft, CI compromise). This app holds a family's complete financial
position. The app already has strong container hardening (all caps dropped,
`no-new-privileges`, read-only rootfs, non-root) and CI supply-chain checks
(`npm audit signatures`, a pure-JS production-tree gate, `ci.yml:66-136`). What it lacks is
**egress control**: any code in the app container can open an outbound connection, and the
app's Postgres role is the bootstrap superuser (`compose.yaml:48`, `:192` — same
`portfolio` user everywhere, with a **defaulted password**, `compose.yaml:49`; §3.5 closes
that too, because a minimal role means nothing while the superuser password is guessable).

### 2.2 What exists today (verified against the tree)

- **Three internet touchpoints, all in the app process:**
  1. The refresh loop: `app/lib/price-poller.server.ts`, started from the root loader
     (`app/root.tsx:67`), cadence read from `app_setting.refresh_cadence_minutes`
     (`0008_refresh_cadence.sql`, read at `app/lib/settings.server.ts:180`).
  2. "Refresh now": `app/routes/refresh.ts` calls
     `refreshQuotes(yahooPriceProvider(), …)` inline in the action.
  3. The USD probe at ingest: `app/lib/instrument-resolution.server.ts:500`
     (`const probe = deps.probe ?? probeSymbol`) — a synchronous guard so "a non-USD
     refusal must leave nothing behind."
- **The provider seam already exists.** `yahoo-finance2` is imported in exactly one place
  (`app/lib/price-provider.server.ts:285`, dynamic import), prices are written in exactly
  one module (`app/lib/prices.server.ts`), and the probe already has an injection seam
  (`ResolutionDeps.probe`, `instrument-resolution.server.ts:212-216`), which production
  leaves defaulted (`app/routes/upload/instruments.tsx:111` — the only production caller).
- **`refreshQuotes` needs no private data.** It selects feed instruments
  (`instrument.id, symbol` where `price_source = 'feed'`, `prices.server.ts:142-148`),
  writes `quote` (stale-marking update at `:276`, upsert at `:313-331` — including
  `annual_dividend_per_share`), `instrument.quote_type` (`:357-362`), `price_daily`
  (upsert, `:379`), `price_observation` (`:467-474`), and `price_poll` (`:492`). Its
  `RefreshReport.stale` is computed internally (feed instruments that got no quote,
  `:273`, `:289`) — it never reads `holding_valued`. `priceFreshness`/`asOfView`
  (`:511`, `:551`), which do read `holding_valued`, are UI-facing and stay in the app.
- **Compose has no custom networks** — all five services (`db`, `dump`, `app`, `gate`,
  `caddy`) ride the default bridge; only `caddy` publishes a port (`compose.yaml:330`).
- **One role.** The app, the migration runner, and the dump sidecar all connect as
  `portfolio`, the initdb superuser. There is no `/docker-entrypoint-initdb.d` mount and
  no second role anywhere.
- **The image starts via `docker-entrypoint.sh`:** validate config → migrate → exec CMD.
  The app's healthcheck probes the served port, so `service_healthy` implies migrations
  completed.
- **Sidecar precedent:** the dump service (`docs/specs/dump/01-the-dump-sidecar.md`) —
  same image-plus-narrow-job shape this slice copies; it writes to a bind mount
  (ADR-0009) and needs no network beyond `db`.

### 2.3 Decisions this slice reverses or extends (to be recorded, not slipped past)

- **DESIGN.md §10, "Job scheduler" row (line 810)** chose in-process polling: "one process
  to deploy, one place to read logs," accepting a missed poll on restart. The security
  argument — egress isolation and role separation — was not an input to that trade-off.
  This slice reverses the row and says why; ADR-0010 carries the full argument.
- **DESIGN.md §10.1 (lines 897-902)** states there is no separate worker service. Same
  edit.
- **ADR-0005** (auth is a forward-auth gate) is untouched: the gate keeps its Google
  egress; nothing about authentication changes.
- The three-tier single-site invariants (ARCHITECTURE.md §4.2) are *preserved*: the
  provider import site, the price-writer site, and the pool-construction site do not move.

### 2.4 What "no API on the worker" really means

A mailbox in Postgres is still a channel — but a constrained one. Honest statement of the
property: a compromised app can no longer open a socket to anywhere; the most it can do is
place symbol-shaped strings into rows, and an honest worker fetches only Yahoo's
endpoints — a code-level property; the `egress` network itself is unrestricted (§8).
Exfiltration shrinks from "arbitrary HTTPS to anywhere" to "a low-bandwidth covert channel
via Yahoo query strings, readable only by Yahoo or an on-path observer." The worker
validates every symbol against a strict pattern before it touches a URL (§3.4) to narrow
even that. The residual channels — including the auth gate's OAuth callback, which relays
attacker-chosen bytes to Google's token endpoint from the shared `frontend` network — are
listed in §8.

## 3. Design

### 3.1 Topology: five networks, one new service

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
# compose.yaml (sketch — real change in ticket 05)
networks:
  backend:            # Postgres and its trusted clients. No route out.
    internal: true
  worker-db:          # The worker's ONLY path to Postgres. No route out.
    internal: true
  frontend:           # Caddy to app and gate. No route out.
    internal: true
  egress: {}          # The only path to the internet: worker and gate.
  ingress: {}         # Caddy's published port lives here.

services:
  db:     { networks: [backend, worker-db] }
  dump:   { networks: [backend] }
  app:    { networks: [backend, frontend] }     # ← no internet route
  worker: { networks: [worker-db, egress] }     # ← cannot reach app:3000
  gate:   { networks: [frontend, egress] }
  caddy:  { networks: [frontend, ingress] }
```

- `internal: true` removes external routing; declaring per-service `networks:` also
  detaches the implicit default bridge (compose spec, verified) — `app`, `db`, and `dump`
  end with no path to the internet, enforced by Docker networking, not code review.
- **The worker and the app share no network.** The app serves every screen and action
  **unauthenticated** on `:3000` — the gate lives at Caddy, and `AUTH_GATE=external`
  only controls a banner (`app/root.tsx:37-46`) — so an egress-capable worker that could
  reach `app:3000` would read the family's money over HTTP and no database role would
  matter. Hence the dedicated `worker-db` network: the worker sees Postgres and the
  internet, nothing else, and the smoke test asserts `app:3000` is unreachable from it
  (§5).
- **Docker Engine floor:** CVE-2024-29018 (the embedded DNS forwarding external lookups
  even on internal networks — an exfiltration channel a TCP-only test never sees) was
  patched in 23.0.11, 25.0.5, and 26.0. The operating docs state **26.0 as a
  conservative floor, not as the vulnerability boundary**, and the smoke test asserts
  external *name resolution* fails from `app`, not just that `fetch` does (§5).
- Reachability walk (all verified against `Caddyfile`): browser→caddy (`ingress`),
  caddy→app and caddy→gate including `/oauth2/*` (`frontend`), app→db and dump→db
  (`backend`), worker→db (`worker-db`), worker→Yahoo and gate→Google (`egress`). The
  worker is reachable from nothing: no port, no shared network except with `db` and the
  internet.
- All existing hardening (cap_drop, read-only, tmpfs, no-new-privileges) is copied onto
  `worker` unchanged.

### 3.2 The worker process

A new entrypoint `server/price-worker.ts`, run as the same container image with an
overridden entrypoint (the standard one would run migrations as a role that cannot):

```yaml
  worker:
    image: ghcr.io/chethan123/portfolio-app:${APP_VERSION:-1}
    entrypoint: ["node", "./server/price-worker.ts"]
    depends_on:
      app: { condition: service_healthy }   # app healthy ⇒ migrations applied
    environment:
      DATABASE_URL: postgres://portfolio_worker:${WORKER_DB_PASSWORD:?see operating.md}@db:5432/portfolio
      MARKET_TIMEZONE: …
      TZ: UTC
    healthcheck: …   # a DB-connect probe only — deliberately NOT provider reachability,
                     # for app/routes/healthz.ts:9's reason: a Yahoo outage must not
                     # have Compose restart a healthy worker
```

The worker process:

1. Validates config by reusing `loadConfig` (`server/config.ts` — every var it doesn't
   set has a default, so the existing schema serves as-is; no second config module).
2. Verifies the schema ledger: every `.sql` filename the image ships under `migrations/`
   is present in `schema_migrations` (read via the SELECT-only `pendingMigrations`,
   `server/migrations.ts:65-75`; belt on top of `depends_on`).
3. Runs the cadence loop **through the same executor as the mailbox** (step 5). The
   poller's scheduling logic is reused — market-hours gate, cadence re-read and re-arm
   (`price-poller.server.ts:8-23`: a Settings save still takes effect within one old
   cadence, no restart) — but a tick no longer fires `refreshQuotes` on its own: it
   *submits a run to the executor*. Reusing the module verbatim would put two
   independent `withRefreshLock` takers in one process; a cadence tick holding the lock
   would then bounce the drain's claimed rows and turn a healthy "Refresh now" into a
   spurious deadline miss.
4. **Drains the mailbox by polling, every ~1-2 seconds, off the pool.** No
   LISTEN/NOTIFY: a dedicated LISTEN client has no auto-reconnect in `pg` v8, its
   `error` event is a process-crash hazard, and notifications are not queued for absent
   listeners — a doorbell that needs its own reconnect machinery plus a fallback poll is
   three mechanisms where one suffices. Two tiny indexed tables polled at 1-2s on an
   otherwise idle household database is negligible load and sits comfortably under both
   app-side deadlines (§3.4).
5. **One serialised executor — the only `withRefreshLock` taker in the process.**
   Cadence ticks and mailbox drains both submit to it; at the start of each run it
   claims every `pending` refresh row (`status = 'running'`), executes `refreshQuotes`
   once, and writes the same report to every claimed row — N pending requests are one
   Yahoo fetch, never N (the poller's own rationale: a queue of fetches against an
   unofficial API is how an instance gets rate-limited, `price-poller.server.ts:21-23`).
   A request row arriving mid-run is claimed by the next run — worst case one run
   duration plus one drain interval, comfortably inside the 8s deadline.
   `withRefreshLock` stays as the cross-process belt (a second replica, an operator
   running the worker by hand); a lock refusal reverts claimed rows to `pending` for
   the next drain. Probe requests don't involve the refresh lock at all: probe →
   verdict UPDATE, independent of any refresh.

Connection budget: the drain loop's pooled reads, `withRefreshLock`'s dedicated lock
client, the Kysely connection doing the refresh work (`prices.server.ts:67-70` runs them
on different connections by design), pool clients idling out their 10s
`idleTimeoutMillis`, **and the container healthcheck's own session** all count against
the role concurrently — and `server/db.ts:45` pins no pool `max`, so the `pg` default of
10 applies. Ticket 03 sets the worker pool's `max` explicitly, and the role carries
`connection limit 10` (§3.5): the limit is defence-in-depth against a runaway, not the
security boundary, and must never be what fails a healthy refresh or flips the
healthcheck.

Import-closure prerequisite (ticket 01): `settings.server.ts:27` value-imports
`maskingPolicyValues` from `masking.ts`, and `masking.ts:14` value-imports `react-router` —
the only edge dragging the UI framework (react-router, and with it React) into the worker's
runtime. The masking-policy *values* move to a new plain module
(`app/lib/masking-policy.ts`) that both `masking.ts` and `settings.server.ts` import.
The honest justification is surface, not necessarily breakage: react-router may well load
under plain Node, but a fetch worker whose module graph includes the SSR framework is
attack surface and bloat for nothing. Ticket 01 *proves* executability either way with a
`node --env-file=.env` smoke invocation, and amends `masking.ts`'s header (`:1-13`), which
currently argues its four pieces must never be split — the values move for a reason that
header must now state, or the file argues against its own shape (the drift ADR-0002
fears).

After that cut, the whole closure (`price-poller.server.ts` →
`prices.server.ts`/`price-provider.server.ts`/`market-hours.ts`/`settings.server.ts`/
`db.server.ts` → `server/*`, plus `settings.server.ts`'s value imports
`input.server.ts` → `money.ts` and the new `masking-policy.ts`) is kysely/pg/zod/node
with relative `.ts` specifiers —
compatible with Node 24 type stripping (`tsconfig.json:28` `erasableSyntaxOnly`);
`import.meta.hot` in the poller is `undefined` outside Vite and guarded already.

**The published image must learn to carry the worker.** The runtime stage ships no
`app/` source at all — `Dockerfile:104-110` copies exactly five `server/` files plus
`build/`, `node_modules`, and `migrations/` — so as the Dockerfile stands, the worker
entrypoint would die on its first import in production and only run from a checkout.
Ticket 02 adds `server/provision-worker-role.ts` to the copied set (its entrypoint step
runs in-image); ticket 03 adds `server/price-worker.ts` plus **every module of** the
`app/lib` closure it imports — `input.server.ts`, `money.ts`, and the new
`masking-policy.ts` are the easy ones to miss, and only ticket 05's smoke test would
catch an incomplete copy set, because
ticket 03's vitest runs from the checkout; and ticket 05's smoke test asserts the
worker container reaches its polling loop *in the published image*, not merely that a
process started.

**The image is shared in this slice, and that is a recorded trade, not an oversight.**
One artifact to build, scan, and version (the dump precedent); `yahoo-finance2` remains on
the app container's disk but is unreachable from app code after ticket 04, and the app
container has no egress regardless — the guarantee is the network, not the file's absence.
The residual this accepts: app and worker share one npm dependency tree, so a single
poisoned package can own both ends of the mailbox at once (§8 "correlated compromise").
The remedy is a **named follow-up slice — worker supply-chain decorrelation**: the worker
gets its own `package.json` and image stage with a ~2-package tree (`pg`, `zod`), and the
`yahoo-finance2` client (~40 transitive packages, most of the worker's surface) is
replaced by a hand-rolled fetch of the two Yahoo endpoints the provider actually uses,
parsed by the same Zod schemas that guard it today. That keeps one language, one
implementation of the price-writing rules, and one test suite. A Go (or other-language)
worker was considered for full ecosystem disjointness and rejected: it duplicates the
price-writing rules and their tests in a second language and adds a second toolchain to
CI — cost out of proportion to what the tiny-tree variant already removes. ADR-0010
records both alternatives.

### 3.3 The mailbox: two tables, no deletes by the worker

Migration `0010_price_mailbox.sql`:

```sql
create table refresh_request (
  id            bigint generated always as identity primary key,
  requested_at  timestamptz not null default now(),
  status        text not null default 'pending'
                check (status in ('pending', 'running', 'done', 'error')),
  -- outcome, written by the worker from RefreshReport:
  requested     integer,
  priced        integer,
  stale         integer,
  closes        integer,
  observed      integer,
  provider_failed boolean,
  completed_at  timestamptz
);

create table probe_request (
  id            bigint generated always as identity primary key,
  -- the covert-channel cap enforced where the app cannot bypass it (§2.4):
  symbol        text not null check (symbol ~ '^[A-Za-z0-9.^=-]{1,15}$'),
  requested_at  timestamptz not null default now(),
  -- verdict, written by the worker (SymbolProbe shape, price-provider.server.ts:298):
  status        text check (status in ('ok', 'non-usd', 'unavailable')),
  quote_type    text,
  currency      text,
  answered_at   timestamptz
);
```

- **App side:** INSERT a row, then poll its own row (`completed_at` / `answered_at`)
  with a short deadline. The app sweeps old rows opportunistically before inserting
  (the `upload_draft` precedent — scaffolding, not history, so deletes are allowed and
  belong to the app).
- **Worker side:** SELECT pending rows, UPDATE the outcome/verdict columns. Never
  INSERTs requests, never DELETEs anything.
- These are scaffolding tables like `upload_draft`, not history: the append-only rule
  (`position_set`, prices) is untouched; `price_observation` and `price_poll` remain the
  durable record of what was fetched.

### 3.4 Route and ingest changes

- **A domain module owns the mailbox, routes stay thin.** New
  `app/lib/refresh-mailbox.server.ts` owns sweep, dedupe, insert, and the poll-to-
  deadline; `app/routes/refresh.ts` keeps its current shape — one call, render the
  outcome (`run()`, `refresh.ts:57`) — because a route that grows SQL and a "busy" rule
  has taken what the domain owns (CLAUDE.md). Dedupe: an open `pending`/`running` row
  younger than the deadline means `{ status: "busy" }` — the same meaning the held lock
  has today. A row the worker marked `running` keeps the caller polling to the deadline
  and typically resolves within it (one run satisfies all open rows, §3.2). On deadline:
  a new outcome variant `{ status: "worker-unresponsive" }`, rendered distinctly from
  `providerFailed` (Yahoo down, worker fine) and `error` (database down).
- **The JS-off path waits the same way.** Today's document POST runs the refresh
  *before* redirecting (`refresh.ts:37`, `:44-46`) — the reloaded page shows fresh
  prices because the POST blocked on them. Under the mailbox it blocks the same ≤8s
  then redirects; on a worker-unresponsive deadline the reload's unchanged as-of line is
  the honest signal, and that behaviour is stated in the control's copy, not left to be
  discovered.
- **The probe becomes a factory with one shared deadline.** New
  `app/lib/probe-mailbox.server.ts` exports a factory returning a `ProbeSymbol`-shaped
  function whose deadline is shared across one `resolveAll` invocation: the resolution
  loop probes sequentially (`instrument-resolution.server.ts:503-512`), so per-call
  deadlines would stack — six new symbols against a dead worker must cost one ~5s wait,
  not six. After the shared deadline expires, remaining calls return
  `{ status: "unavailable" }` immediately, preserving the never-throws contract
  (`price-provider.server.ts:354-357`). Note the existing `unavailable` contract:
  it does *not* block — the instrument is created anyway and the next refresh marks it
  stale (`instrument-resolution.server.ts:514-516`); only `non-usd` refuses. The
  factory also **pre-validates each symbol against the §3.3 pattern before inserting**
  and returns `unavailable` for offenders without touching the mailbox: app-side symbol
  validation is trim-and-length-only (`instrument-resolution.server.ts:309-311`), so
  "BRK/B" or a 16-character ticker would otherwise turn the INSERT into a
  CHECK-constraint error where today's probe returns a clean `unavailable`
  (create-anyway).
- **The in-process probe default goes away.** Ticket 04 makes `ResolutionDeps.probe`
  **required** and deletes the `probeSymbol` import and `?? probeSymbol` fallback from
  `instrument-resolution.server.ts:19,500` — otherwise the in-process Yahoo path stays
  in the app's module graph as a silent default for any future caller, exactly the off
  switch §3.6 refuses. The one production call site passes the mailbox probe
  (`app/routes/upload/instruments.tsx:111`); tests already inject fakes.
- **`app/root.tsx:67`** stops calling `startPricePoller()`; the import at `:29` goes.
  After ticket 04, the app's module graph value-imports nothing from
  `price-provider.server.ts` (types cross freely) and the refresh path in the app is
  mailbox-only.
- **Symbol validation, enforced at three sites:** the probe factory returns
  `unavailable` for pattern-violating symbols before they reach the mailbox (above);
  the worker checks every symbol against `^[A-Za-z0-9.^=-]{1,15}$` before it reaches a
  URL — for probes directly, and for the refresh path via a validating wrapper around
  the `PriceProvider` (since `refreshQuotes` itself stays untouched), where an excluded
  `instrument.symbol` is simply not fetched and surfaces as `stale` in the report; and
  the `probe_request` table carries the same pattern as a CHECK constraint (§3.3), so
  even a compromised app cannot place an arbitrary payload in the mailbox. (Yahoo's own
  symbol alphabet: dots, carets, dashes, `=X` currency pairs.)

### 3.5 The `portfolio_worker` role

Postgres is default-deny: a fresh role can connect and see the catalog, and nothing else
(PG15+ even revoked `CREATE` on `public`). So the role is defined by what it is *granted*,
which is exactly this — every statement `refreshQuotes` executes was run under these
grants against a live database during review, including the two WHERE/ON CONFLICT/
RETURNING subtleties that the first draft missed:

```sql
-- 0010_price_mailbox.sql (same migration; idempotent DO block around CREATE ROLE)
create role portfolio_worker nologin
  nosuperuser nocreatedb nocreaterole connection limit 10;

-- select(quote_type): writeQuoteType's WHERE reads it (prices.server.ts:361);
-- UPDATE requires SELECT on columns the condition reads.
grant select (id, symbol, price_source, quote_type), update (quote_type)
  on instrument to portfolio_worker;
grant select, insert, update on quote        to portfolio_worker;  -- upsert
grant select, insert, update on price_daily  to portfolio_worker;  -- upsert
-- select(instrument_id, as_of): the ON CONFLICT arbiter and RETURNING clause
-- (prices.server.ts:467-474) both require SELECT.
grant select (instrument_id, as_of), insert on price_observation to portfolio_worker;
grant insert on price_poll                   to portfolio_worker;
grant select (refresh_cadence_minutes) on app_setting to portfolio_worker;
grant select on schema_migrations            to portfolio_worker;
grant select, update (status, requested, priced, stale, closes, observed,
                      provider_failed, completed_at) on refresh_request to portfolio_worker;
grant select, update (status, quote_type, currency, answered_at) on probe_request to portfolio_worker;
```

- **Column grants where a table mixes public and private:** `instrument` (the worker sees
  id/symbol/source/quote-type, not names or classifications) and `app_setting` (the
  cadence, not `capital_gains_rate` or `masking_policy`).
- **No DELETE anywhere.** A compromised worker can poison prices (it is the price writer;
  §8) but cannot erase the append-only `price_observation` forensics or touch position
  history.
- **Invisible entirely:** `account`, `person`, `holding`, `position_set`,
  `holding_valued`, `manual_networth`, `upload_draft`, `column_mapping`,
  `classification`, `instrument_alias`. A `SELECT` on any of them is a permission error.
- Identity-column sequences need no separate grant — verified empirically (every id in
  this schema is `generated always as identity`; an INSERT under these exact grants
  succeeded with no sequence privileges). `LISTEN`-free design needs no notification
  grants; advisory locks require none; `withRefreshLock`'s session-lock discipline
  (`prices.server.ts:72-102`) works unchanged.
- `connection limit 10` matches the worker's real budget (§3.2: pooled reads, idle
  clients, lock client, refresh connection, healthcheck session, with the pool's `max`
  pinned in ticket 03) — defence-in-depth against a runaway, never the boundary.

**The role means nothing while the superuser password is a default.** `compose.yaml:49`
falls back to `POSTGRES_PASSWORD:-portfolio` — written when every container on the
network was trusted. This slice puts the low-trust, egress-capable container on the same
network as `db`; a compromised worker would simply reconnect as `portfolio`/`portfolio`
and read everything. Ticket 05 makes `POSTGRES_PASSWORD` required (`:?`) — which also
forces re-deriving the two `DATABASE_URL` defaults that embed `portfolio:portfolio`
today (`compose.yaml:115`, `:192`; the coupling `compose.yaml:47`'s own comment warns
about) to `postgres://portfolio:${POSTGRES_PASSWORD}@db:5432/portfolio`, or app and
dump crash-loop on first start with a non-default password. The runbook (ticket 06)
states the upgrade steps for existing installs: the initdb-time password is baked into
the cluster, so operators must also `ALTER ROLE portfolio PASSWORD …`, not just edit
`.env`, and passwords with URL-special characters need encoding in the URL.

**Credential provisioning.** The grants and the `NOLOGIN` role are schema history and live
in the migration. The *login credential* is operator config: a new entrypoint step
(`server/provision-worker-role.ts`, running as `portfolio` after `migrate.ts` in
`docker-entrypoint.sh`) executes `ALTER ROLE portfolio_worker LOGIN PASSWORD $WORKER_DB_PASSWORD`
when the variable is present. The app holding this credential grants it nothing — it
already connects as the superuser that created the role. Config surface: `app` gains
optional `WORKER_DB_PASSWORD`, **added to `configSchema`** (`server/config.ts:35-94`) so
the provision step reads it through `loadConfig` — ARCHITECTURE.md §4.2's rule that
`server/config.ts` is the only reader of `process.env` (`:344`) survives intact;
`worker` reuses the same schema with its own `DATABASE_URL`. DESIGN.md §10.1's env table (lines 927-934) gains the rows and the
reasoning; the compose header's "every other setting has a working default" contract
(`compose.yaml:20`) is amended, because after this slice two additional variables are
deliberately without defaults.

### 3.6 Development and tests

- **`npm run dev` has no worker.** The dev story is one extra command:
  `node --env-file=.env ./server/price-worker.ts` in a second terminal when live prices
  are wanted; without it, screens serve stored prices, "Refresh now" reports
  worker-unresponsive, and feed-symbol ingest probes come back `unavailable` after one
  shared ~5s deadline — the instruments are **created anyway**, unpriced until a worker
  runs (the existing `unavailable` contract; only `non-usd` refuses). Documented in
  `docs/developing.md`. **Deliberately no `PRICE_FETCH=in-process`
  fallback mode:** a second code path would keep the yahoo import reachable from the app
  and give the security property an off switch. (Assumption to confirm with the owner;
  reversing it later is additive.)
- **Tests keep running through the app-side fixtures.** `refreshQuotes`,
  `price-provider`, and poller tests are untouched (the modules don't move; only who
  calls them does). New tests, all against real Postgres per house style:
  - the mailbox probe returns each `SymbolProbe` verdict, shares one deadline across a
    batch, and maps expiry to `unavailable`;
  - the refresh mailbox module dedupes onto an open request and reports
    `worker-unresponsive` on deadline;
  - worker drain: N pending refresh rows satisfied by one report; probe fulfilment
    writes the verdict columns;
  - **the permission pin:** with `SET ROLE portfolio_worker`, `refreshQuotes` completes
    against seeded fixtures, and a `select` on `account` raises a Postgres permission
    error. This is the test that makes the security property a regression failure
    instead of a convention.

## 4. Tickets

Shape per `docs/specs/README.md`; one ticket = one PR that typechecks, builds, tests green
standing alone.

| # | Ticket | Blocked by |
|---|--------|------------|
| 01 | Extract `masking-policy.ts` values module; amend `masking.ts`'s header to name why the values moved; prove the worker closure runs under plain `node --env-file` | Nothing |
| 02 | Migration `0010_price_mailbox.sql`: mailbox tables (symbol CHECK), `portfolio_worker` role + grants (as §3.5, including the two SELECT subtleties); `server/provision-worker-role.ts` + entrypoint step + its Dockerfile COPY; optional `WORKER_DB_PASSWORD` in `configSchema`; regenerate `database.generated.ts`; permission-pin test | Nothing |
| 03 | `server/price-worker.ts`: config reuse, ledger check, cadence scheduling through the serialised executor (§3.2), 1-2s pool-based drain loop (one report satisfies all claimed rows), symbol validation, pinned pool `max`; Dockerfile carries the worker entry + its `app/lib` closure; worker-side fulfilment tests | 01, 02 |
| 04 | App-side switch: `refresh-mailbox.server.ts` + thin `refresh.ts` + `probe-mailbox.server.ts` factory (shared deadline, pattern pre-validation) + make `ResolutionDeps.probe` required (delete the `probeSymbol` default, `instrument-resolution.server.ts:19,500`; also fix `tests/routes/upload-instruments.test.ts:84,162`, which call `resolveAll` with no deps) + `instruments.tsx` wiring + remove `startPricePoller` from `root.tsx`; route tests | 02 |
| 05 | Compose: five networks (§3.1, including the app/worker split), `worker` service (hardening + DB-connect healthcheck), `POSTGRES_PASSWORD` and `WORKER_DB_PASSWORD` required with the app/dump `DATABASE_URL` defaults re-derived from `POSTGRES_PASSWORD` (`compose.yaml:115`, `:192`), header prose; `smoke-test.sh`: extend the three service lists (`:71`, `:365`, `:401`), the per-service published-ports block (`:281-289`), `expect_caps`/`expect_uid` for worker, re-point the in-container yahoo-import check (`:265`) at worker, add egress + DNS + worker-isolation + worker-polling assertions (§5) | 03, 04 |
| 06 | Docs: DESIGN.md §6.2 + §10 row 810 + §10.1 services/env blocks (also add the missing `dump` entry while in there); ARCHITECTURE.md §4.2 rows `:337` + `:344` (and fix the stale `:388`/`priceFreshness:633` refs); ADR-0010; CONTEXT.md entries (*price worker*, *mailbox*); `docs/operating.md`: engine ≥ 26.0 floor, upgrade runbook (two new required env vars, `ALTER ROLE portfolio` on existing clusters), dev-worker recipe in `docs/developing.md` | 05 |

Tickets 01, 02 are parallel; 03 and 04 are parallel after their blockers.

**Deploy coupling:** 04 removes the app's own fetching, so between 04 and 05 landing,
a deployed instance would have no price refresh. Land 04 and 05 in the same release
(separate PRs, one tag), or accept a stale-prices window — the operator runbook note goes
in ticket 06.

## 5. Acceptance (slice level)

- From `app` and `db`: outbound TCP fails (`fetch('https://example.com')` errors) **and
  external DNS resolution fails** (the unpatched-engine exfil channel, asserted
  separately). From `worker`, Yahoo resolves and the app's screens show fresh prices.
  These become smoke-test assertions in ticket 05.
- From `worker`: `app:3000` is **unreachable** (the gate-bypass a shared network would
  open — the app serves unauthenticated HTTP), and the worker container reaches its
  polling loop *in the published image*, not merely process start.
- "Refresh now" round-trips through the mailbox within the deadline on all five screens;
  JS-off behavior unchanged (blocks ≤ deadline, then redirects).
- Feed-symbol ingest probes resolve through the mailbox; a non-USD symbol still refuses
  cleanly with nothing written; a dead worker costs one shared deadline, not one per
  symbol.
- The permission-pin test fails if anyone widens the worker's grants or reads a private
  table through the worker role.
- A fresh `docker compose up` with the two required env vars set (`WORKER_DB_PASSWORD`
  new, `POSTGRES_PASSWORD` newly required) comes up healthy end to end;
  the same command without them fails fast at interpolation with a message pointing at
  the runbook.
- `npm run typecheck`, `npm test`, `npm run build`, and `scripts/smoke-test.sh` green.

## 6. Documentation deltas (detail for ticket 06)

- DESIGN.md: §6.2 gains the mailbox paragraph; §10 row 810 rewritten (worker container,
  and *why the trade flipped*: egress isolation + role separation outweigh "one process to
  deploy" now that the threat model includes dependency compromise); §10.1 services block
  gains `worker` (and `dump`, currently missing); env table gains `WORKER_DB_PASSWORD`
  and the worker's vars.
- ADR-0010 "Price fetching is an egress-isolated worker": context (supply-chain),
  decision (mailbox over API, polling over LISTEN/NOTIFY, role over trust), consequences
  (worker-down UX state, covert-channel residuals, correlated compromise until the
  follow-up slice, deploy coupling, two required env vars), alternatives rejected
  (in-app fallback mode, HTTP API on the worker, LISTEN/NOTIFY doorbell, separate
  images now, a Go/second-language worker), and the named follow-up (worker
  supply-chain decorrelation).
- ARCHITECTURE.md §4.2: the yahoo-import row keeps its site but the *reachability* note
  changes (imported only by the worker process); the env-reader row (`:344`) gains the
  worker entrypoint; fix the stale `:388` and `priceFreshness` line refs.
- CONTEXT.md: *price worker*, *mailbox* (and the words to avoid: "queue", "job table" —
  it is two request tables, not a general queue).

## 7. Out of scope

- gVisor/runsc runtime overlay (companion change, separate compose override file).
- Pinned items from the earlier hardening list (`.npmrc` ignore-scripts, Dockerfile
  `--ignore-scripts`, SHA-pinned Actions, Renovate, digest-pinned images).
- **Worker supply-chain decorrelation** — the named follow-up slice (§3.2): worker-own
  `package.json`/image stage, ~2-package tree, hand-rolled Yahoo fetch + the existing Zod
  schemas replacing `yahoo-finance2`. A Go worker was considered and rejected there.
- Moving the *app* off the `portfolio` superuser role — opened by this slice (and made
  meaningful by the required-password change), not done in it.
- Any auth change (ADR-0005 stands).

## 8. Residual risks, stated plainly

- **Price poisoning:** the worker is the price writer by design; a compromised worker can
  skew valuations. Mitigations: no DELETE (forensics survive in `price_observation`),
  Zod validation of provider payloads stays with the provider code, and the household
  sees the as-of line. Not eliminable without removing the feature.
- **Covert exfiltration channels that remain:** symbol strings to Yahoo (bounded by the
  validation pattern; readable only by Yahoo or an on-path observer), and the gate's
  OAuth callback (`/oauth2/callback?code=…` relays attacker-chosen bytes to Google's
  token endpoint from `frontend`). Same class, same observer constraint. Accepted.
- **Correlated compromise (until the follow-up slice):** app and worker share one npm
  tree, so one poisoned package can sit on both ends of the mailbox and coordinate. Be
  precise about what survives that case: the worker-side pattern check is then
  compromised code, the app (still the `portfolio` superuser) can stage bytes in any
  worker-readable column (`instrument.symbol` is unconstrained `text` in the schema —
  the 40-char cap is app code), and the `egress` network is unrestricted internet —
  nothing but code pins the worker to Yahoo. The surviving bound is the worker role's
  *read set* plus arbitrary egress; the CHECK constraint bites only in the
  compromised-app/honest-worker case. The decorrelation slice (§7) shrinks the worker's
  tree to ~2 packages and removes the shared provider dependency entirely.
- **Symbol-length mismatch:** the app accepts stored symbols up to 40 characters
  (`instrument-resolution.server.ts:310`); the worker fetches only pattern-conforming
  symbols (≤15, no slashes), so an unusual-but-legitimate stored symbol would never
  refresh and would show as permanently stale. Documented in ticket 06; tightening the
  app-side symbol rule to match is a small follow-up decision.
- **Ticker-list disclosure:** the worker (and Yahoo) necessarily learn which symbols the
  family tracks — true today as well. Accepted.
- **Engine floor:** unpatched engines leak DNS from internal networks (CVE-2024-29018,
  fixed in 23.0.11 / 25.0.5 / 26.0). The docs state 26.0 as a conservative floor — not
  the vulnerability boundary — and the smoke test catches the symptom.
- **Worker outage = stale prices:** surfaced honestly (as-of line, worker-unresponsive
  outcome, `price_poll.started_at` as a coarse heartbeat with its known caveats — rows
  appear only on committed runs and only during market hours). Accepted at this
  household's stakes.
- **Caddy retains an unused internet route** (published-port constraint). It makes no
  outbound calls and fronts everything anyway; constraining it further (DOCKER-USER
  rules) is out of scope.
