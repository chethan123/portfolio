# 0018 — The price worker: egress-isolated fetching with a minimal database role

**Status:** proposed · **Slice directory:** `docs/specs/price-worker/` · **ADR:** 0010 (new, reserved
for this spec by `docs/adr/0011-a-backfill-fills-the-spine-but-never-moves-it.md:11`)

> **Renumbered and re-grounded.** This spec was drafted as `0015` before specs 0015-0017 took that
> number, and before ADR-0011's backfill landed. It is now `0018`, and the design is rewritten
> against the tree as it stands. §2.4 records what changed and why the slice got smaller twice.
> Line references were re-verified file by file; the grant list, the constraints and the restore
> failure were executed against a live PostgreSQL cluster rather than reasoned about.

---

## 1. Intention

Remove every internet route from the `app` and `db` containers, so that a compromised
application — a trojaned npm dependency, a supply-chain payload of the TeamPCP kind — has no
network path out. The only code that talks to the internet, the Yahoo price fetch, moves into a
dedicated sidecar container (`worker`) that:

- has **no listening port and no API** — the app never addresses it; all coordination goes
  through Postgres rows,
- connects to Postgres as a **new minimal-privilege role** whose entire world is one mailbox
  table — it cannot read or write an instrument, a price, an account, a person, a holding, an
  upload, or any amount of money,
- is the **only** container on an egress-capable network besides the auth gate (which must
  reach Google) and Caddy (which owns the published port).

Each of those is narrower than the stack has today and none of them is absolute; §2.5 and §8 say
where each one stops.

The inversion this buys: today the internet-facing code (`yahoo-finance2`, the app's riskiest
dependency — the Dockerfile already amputates part of it, `Dockerfile:78`) runs inside the process
that holds full database access. After this slice, the internet-facing code is handed a list of
ticker symbols and hands back quotes — public market data, in and out — and the process that sees
the family's money cannot open a socket to anywhere.

**Be clear about what this does not contain.** `yahoo-finance2` — the dependency §2.1 names as the
riskiest — ends up in the container that *has* the socket, and until the decorrelation follow-up
(§7) app and worker share one npm tree. For the rest of the tree the slice buys real containment;
for that one dependency it buys "loses the database, keeps the socket". That is still the trade
worth making, because the socket without the database is public market data, but §1 should not be
read as more.

**The worker fetches and does not write.** It runs the existing provider module against Yahoo and
returns that module's own typed answer through a mailbox row; every price that reaches the database
is still written by `app/lib/prices.server.ts`, in the app, under the rules and tests it has today.
That is what keeps this slice small: `refreshPrices`, `refreshQuotes`, `backfillCloses`,
`selectBackfillCandidates`, `withRefreshLock`, the poller and the refresh route are **unchanged**.
The one app-side substitution is which `PriceProvider` they are handed (§3.4).

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
  what is left for ticket 06 is the *argument*.) The in-process bullet at `:55-56` — "Nothing is
  shaped for spec 0018's worker" — gets the `Reversed` banner treatment
  `docs/specs/README.md:14-20` describes: corrected beside the argument, not by rewrite. Note what
  it means concretely: this slice does **not** reshape the backfill as a request row in the sense
  ADR-0011 rejected. The batch keeps running as one bounded composition; only the socket moves, and
  the candidate list crosses as data (§3.7).
- **`matchKey`'s header argues against being moved, and this slice moves it.**
  `prices.server.ts:729-731` says "**Exported rather than moved**: the backfill's history call sends
  the same form (`price-provider.server.ts`), and the rule belongs beside the matcher that states
  it." That was right while both callers were one process. It stops being right when
  `price-provider.server.ts` must load in a process that may not reach the price writer at all
  (§3.2). The docstring moves with the function and states the new reason, or the file argues
  against its own shape.
- **`server/` gains its first import from `app/`.** No `server/*.ts` imports `app/` today; the edge
  runs the other way (`app/lib/db.server.ts:16-18`). `server/price-worker.ts` inverts it. Nothing in
  CLAUDE.md's layering forbids it and the rule is narrow — the worker may import pure leaves and the
  provider, never a `.server` module that writes — but it is a structural fact ARCHITECTURE.md
  should carry rather than a Dockerfile line.
- **ADR-0005** (auth is a forward-auth gate) is untouched: the gate keeps its Google egress; nothing
  about authentication changes.
- The three-tier single-site invariants (ARCHITECTURE.md §4.2) are *preserved*: the provider import
  site, the price-writer site, and the pool-construction site do not move.

### 2.4 What the re-grounding changed, twice

The first draft assumed a refresh was one function (`refreshQuotes`) over public market data. It is
not. Three consequences:

1. **The backfill's candidate query reads `holding` and `position_set`** — two tables the draft
   listed as invisible to the worker. A worker running `refreshPrices` under the drafted grants
   would have failed with a permission error on its first tick.
2. **`price_backfill` did not exist** when the grants were written, so nothing was granted on it.
3. **`PriceProvider` grew a second method**, so the outcome columns, the deadline watchdog and the
   validating wrapper all had to account for two calls rather than one.

The first repair was to have the app compute the backfill's candidates and hand them to the worker,
leaving the worker to run `refreshPrices`. Adversarial review took that apart, and the objections
all had one root: **a worker that runs the domain's composition has to re-implement it.** Six
separate findings were the same finding — `refreshPrices` would need its signature changed and its
call sites with it; `BackfillBatchFailed` is module-private (`prices.server.ts:501-509`) so a worker
composing the halves itself cannot recover the partial counts the ledger line is built from;
`BackfillReport.outcomes` (six counters, `:465-478`) had no mailbox column, so `logBackfill`
(`price-poller.server.ts:171`) could not be written; the candidate table lacked `symbol`
(`BackfillCandidate` is `{ id, symbol, rangeFrom }`, `:261-267`) and carried a dead `range_until`,
since `backfillCloses` computes one shared `until` for the whole batch (`:553`); the poller's five
`startPricePoller(provider)` test sites and its log-line suite would need rewriting rather than
re-wiring; and two claimed rows disagreeing about `quotes` had no defined behaviour.

**So the worker stops running the composition.** It runs the *provider* — the one module the seam
was built around — and the app keeps everything else:

- `PriceProvider` (`price-provider.server.ts:155-162`) is already a two-method async interface, and
  the app already injects it everywhere. A mailbox-backed implementation substitutes with **no
  change to `prices.server.ts` at all**: no signature change, no re-composition, no report columns,
  no candidate table.
- `backfillCloses`'s documented pacing — "Sequential, one instrument at a time, awaiting each call
  before the next: nothing is issued in parallel and nothing is queued" (`:527-533`) — survives
  unchanged, because each await simply becomes an await on a mailbox row.
- Its failure rule — "A provider failure for one instrument is not a failure of the batch"
  (`:537-540`) — is exactly what a dead worker should look like. A mailbox call that times out
  throws, and the existing per-instrument `providerFailed` path ledgers it and moves on. There is
  nothing new to specify.
- The poller and the route change by one expression each: `yahooPriceProvider()` becomes
  `mailboxPriceProvider(...)`. `app/root.tsx:67` is untouched. The poller's tests, which already
  drive it through a fake provider, are untouched.

The security property improves at the same time. The worker no longer needs `instrument`, `quote`,
`price_daily`, `price_observation`, `price_poll`, `price_backfill`, `holding`, `position_set` or
`app_setting`. **Its whole grant is one mailbox table** (§3.5), which is the strongest form of §1's
claim rather than a restatement of it.

Two tickets dissolved on the way. The original ticket 01 extracted `masking-policy.ts` to keep
`react-router` out of the worker's import closure; the worker no longer imports
`settings.server.ts`, so there is no edge to cut and the extraction is out of scope (§7). The
candidate-passing refactor of `backfillCloses` is likewise gone. What replaced them is smaller: one
pure function, `matchKey`, moves to a leaf so the worker's closure stops at the provider (§3.2).

### 2.5 What "no API on the worker" really means

A mailbox in Postgres is still a channel — but a constrained one. Honest statement of the property:
a compromised app can no longer open a socket to anywhere; the most it can do is put ticker-shaped
strings and a date range into a row, and an honest worker turns those into Yahoo requests and
nothing else. Exfiltration shrinks from "arbitrary HTTPS to anywhere" to "symbols and dates in Yahoo
query strings, readable only by Yahoo or an on-path observer."

**The CHECK constraint does not bind a compromised app, and an earlier draft of this spec was wrong
to say it did.** The app connects as `portfolio`, which owns the table; `alter table fetch_request
drop constraint fetch_request_symbols_fetchable` followed by an arbitrary insert was executed as the
app's own role and both statements succeeded. Moving the app off the superuser role is what would
fix that, and §7 defers it. What the constraint actually buys is worth keeping and worth naming
correctly: it stops an *honest* app's bug from reaching a URL — a `BRK/B` or a 16-character ticker
becomes a clean refusal rather than a malformed request — and it binds the compromised-app case only
so long as the attacker does not think to drop it.

Be precise about the bandwidth too, because the first draft was out by an order of magnitude. The
alphabet is 66 characters, so 15 characters is ~91 bits — **about 11 bytes per symbol** — and a
`quotes` row carries up to 500 of them, so **~5.6 KB per row**, with nothing capping rows. A history
row adds two dates; bounding `range_until` (§3.3) holds those to a few bits each instead of the ~31
bits an unbounded date range gives. So the honest sentence is: exfiltration through the mailbox is
throttled by Yahoo's own rate limiting and the drain interval, not by a constraint, and what the
constraint enforces is *shape* — no URLs, no hostnames, no newlines, no base64 with `/` or `+`, and
no way to name a host. That is a real narrowing and it is not secrecy. §8 has the rest.

## 3. Design

### 3.1 Topology: seven networks, one new service

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
  caddy-app:          # Caddy to app. No route out, and no gate on it.
    internal: true
  caddy-gate:         # Caddy to gate. No route out, and no app on it.
    internal: true
  egress-worker: {}   # The worker's internet path — shared with nothing.
  egress-gate: {}     # The gate's internet path — shared with nothing.
  ingress: {}         # Caddy's published port lives here.

services:
  db:     { networks: [backend, worker-db] }
  dump:   { networks: [backend] }
  app:    { networks: [backend, caddy-app] }       # ← no internet route, no gate peer
  worker: { networks: [worker-db, egress-worker] } # ← cannot reach app:3000 or gate
  gate:   { networks: [caddy-gate, egress-gate] }
  caddy:  { networks: [caddy-app, caddy-gate, ingress] }
```

Verified against the Compose specification rather than assumed: declaring any per-service
`networks:` key detaches that service from the implicit `default` network (`06-networks.md:62-82`,
whose own worked example has to re-list `default` to keep it); `internal: true` "allows you to
create an externally isolated network" (`:215-218`); and `depends_on` conditions are startup
ordering evaluated by the daemon, so `worker` may depend on `app` being healthy while sharing no
network with it (`05-services.md:367-421`).

- **The worker and the app share no network.** The app serves every screen and action
  **unauthenticated** on `:3000` — the gate lives at Caddy, and `AUTH_GATE=external` only controls
  a banner (`app/root.tsx:37-46`, decided at `:92`) — so an egress-capable worker that could reach
  `app:3000` would read the family's money over HTTP and no database role would matter. Hence the
  dedicated `worker-db` network. The same logic splits the egress side: `egress-worker` and
  `egress-gate` are separate bridges, or the worker could reach `gate:4180`, the sidecar holding the
  Google client secret. The smoke test asserts both.
- **`app` and `gate` do not share one either, and an earlier draft had them both on one `frontend`.**
  That was the plan handing the container it exists to contain the exact path it refuses the worker:
  from a shared network the app can POST `/oauth2/callback?code=<bytes>` straight to `gate:4180`,
  and the gate relays those bytes to Google's token endpoint over `egress-gate` — an
  application-layer egress proxy with a kilobyte-scale budget, not the same class of channel as an
  11-byte ticker. Caddy is the only service that needs either as a peer, and both connections are
  inbound to them, so splitting into `caddy-app` and `caddy-gate` costs one network and removes the
  relay. Having paid for six on this argument, the seventh is not optional.
- **What the worker can still reach, stated because "the internet, nothing else" is not true.**
  `egress-worker` is an ordinary bridge, so the worker has a default route through the Docker host.
  That reaches every port published on the host — including Caddy on `:80`, and through it the
  gate's ungated `/oauth2/*` handler (`Caddyfile:39-46`) — and the operator's LAN, because the host
  forwards and masquerades. Note also `Caddyfile:19` trusts `X-Forwarded-*` from `private_ranges`,
  and the worker's address on the host bridge is one. The gate's forward-auth still refuses `/`, so
  this is "the worker reaches the auth surface and the LAN", not "the worker reads the money" — but
  the honest sentence is **Postgres, the internet, the Docker host, and the LAN**. Constraining that
  further is `DOCKER-USER` work, out of scope here for the same reason it is out of scope for Caddy
  (§8). Ticket 04 asserts the `gate:4180` and `app:3000` paths are gone *and* records the
  host-gateway path that is not.
- **`internal: true` is enforced by iptables, not by config validation.** For an internal network
  the daemon installs `DROP` rules in a `DOCKER-INTERNAL` filter chain for traffic whose source or
  destination is outside the network's subnet. Nothing rejects a published port on an internal
  network at parse time; the packets are simply dropped. That chain hangs off `FORWARD` only, so it
  does not cover host-local (`OUTPUT`-path) traffic — which is why `caddy` sits on a non-internal
  `ingress` rather than relying on the drop.
- **Docker Engine floor: ≥ 29.5.1, and the isolation this slice draws depends on it.** The floor is
  not about one CVE:
  - CVE-2024-29018 — the embedded DNS server forwarding external lookups *from internal networks*,
    an exfiltration channel a TCP-only test never sees. Fixed in 23.0.11 / 25.0.5 / 26.0.0-rc3.
    This is the illustration of why internal networks need a patched engine; it is not the floor.
  - **CVE-2025-54410 — a firewalld reload removes bridge network isolation**, after which
    "containers have access to any port, on any container, in any non-internal bridge network,"
    until the daemon restarts. Fixed in 28.0.0 (backported to 25.0.13). `egress-worker`,
    `egress-gate` and `ingress` are all non-internal, so on an affected engine this is precisely
    the worker→`gate:4180` path §3.1 exists to forbid. `internal` networks are unaffected, so
    `backend`, `worker-db`, `caddy-app` and `caddy-gate` hold regardless.
  - CVE-2024-41110 (AuthZ bypass, CVSS 9.9) affects ≤ 26.1.4, so the earlier draft's "26.0 floor"
    sat inside a critical range.
  - CVE-2026-41567 and CVE-2026-42306 (container-to-host escapes) are fixed in 29.5.1.

  `docs/operating.md:84-92` states no Engine floor today, only "any v2 is new enough" about Compose.
  Ticket 06 adds the floor there and says which property depends on it, and the smoke test asserts
  external *name resolution* fails from `app`, not just that `fetch` does (§5).

  **The DNS assertion can be vacuously green, so say what it proves.** CVE-2024-29018 leaks only
  when the host's `resolv.conf` names a *loopback* forwarding resolver (systemd-resolved on
  127.0.0.53, dnsmasq on 127.0.0.1); dockerd then resolves from the host namespace and bypasses the
  internal network. On a host whose resolver is a normal address, external DNS from an internal
  network fails on every engine version — so a green assertion on a CI runner says nothing about an
  operator's systemd-resolved box on an old engine. The advisory's own workaround is worth carrying
  in the runbook rather than relying on the floor alone: give the internal-only services an explicit
  upstream `dns:` address, which forces resolution from the container's own namespace. It also gives
  operators on distro-packaged engines something to do besides upgrade.
- Reachability walk (all verified against `Caddyfile`): browser→caddy (`ingress`), caddy→app
  (`caddy-app`) and
  caddy→gate including `/oauth2/*` (`caddy-gate`), app→db and dump→db (`backend`), worker→db
  (`worker-db`), worker→Yahoo (`egress-worker`), gate→Google (`egress-gate`). The worker is
  reachable from nothing: no port, no shared network except with `db` and the internet.
- **Yahoo is four hosts, not one.** `yahoo-finance2` 4.0.2 reaches `query2.finance.yahoo.com` for
  quotes and charts, `finance.yahoo.com` and a hardcoded `query1.finance.yahoo.com` for the
  cookie/crumb bootstrap, and `guce.yahoo.com`/`consent.yahoo.com` for the EU consent redirect
  chain. `egress-worker` is unrestricted so nothing breaks today, but any future egress allowlist —
  and any smoke assertion phrased as "Yahoo resolves" — must name all four or it fails on the first
  fetch.
- All existing hardening (`cap_drop: ALL`, `no-new-privileges`, `read_only`, tmpfs, non-root) is
  copied onto `worker` unchanged, plus `restart: unless-stopped` and `logging: *container-logging`
  — every service in `compose.yaml` carries the logging anchor (`:38-42`), and a worker left stopped
  after a daemon restart is the sole price-fetch process silently gone.
- **External-Postgres installs** (`docs/operating.md:184-197`) keep the worker split, the minimal
  role, and the mailbox — but not the internal-network guarantee as drawn: a container that must
  reach a database outside Docker cannot sit on an `internal` network. Ticket 06's operating.md
  section defines that mode's override and states exactly which guarantees remain. See §3.5 for the
  migration's behaviour there, which is a hard failure unless it is written for it.

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

The worker's whole job is **one unclaimed row at a time: read it, make the provider call it names,
write the answer back.** It holds no timer, no calendar, no lock, no domain rule, and no opinion
about what should be fetched.

1. **Validate config** by reusing `loadConfig` (`server/config.ts` — every var it doesn't set has a
   default, so the existing schema serves as-is; no second config module).
2. **Verify the schema ledger:** every `.sql` filename the image ships under `migrations/` is
   present in `schema_migrations` (read via the SELECT-only `pendingMigrations`,
   `server/migrations.ts:65-75`; belt on top of `depends_on`). It waits; it does not migrate,
   because its role cannot.
3. **Drain by polling.** No LISTEN/NOTIFY, and all three of the reasons were checked against the
   installed `pg` 8.23.0 rather than recalled: there is no reconnect logic anywhere in `pg/lib`
   (the docs make re-connection the caller's problem); `Client` emits `'error'` unconditionally on a
   dead socket (`lib/client.js:416-422`) and an unhandled `'error'` on an `EventEmitter` takes the
   process down; and a notification is delivered only to sessions *currently* listening, which is
   PostgreSQL's rule, not `pg`'s. A doorbell needing its own reconnect machinery plus a fallback
   poll is three mechanisms where one suffices.
4. **Fulfil, then answer.** Claim one *unexpired* row (`claimed_at = now()` guarded on
   `claimed_at is null and expires_at > now()`) —
   the expiry check is what stops an abandoned row becoming a Yahoo request nobody is waiting for.
   Then dispatch on `kind` to `getQuotes` / `getDailyCloses` / `probeSymbol`, and write either
   `payload` or `error` with `answered_at`. Writes are guarded on the claim, so an overlapping second worker
   cannot overwrite a landed answer — first write wins, and a rare duplicate Yahoo call is the
   accepted cost. Claims carry a lease: a claimed row whose lease expired is claimable again, so a
   crash between claim and answer strands nothing.
5. **No advisory lock.** `withRefreshLock` (`prices.server.ts:120-150`) stays exactly where it is,
   in the app, taken by the app's callers as it is today. The worker serves calls; it does not
   decide that a refresh is happening, so it has nothing to serialise. This also keeps a connection
   out of the role's budget.
6. **The provider call is bounded.** Every call gets a deadline, and the mechanism has to be named
   rather than gestured at: `yahooClient` awaits the library with no signal of its own
   (`price-provider.server.ts:617-624`), so a deadline here is `Promise.race`, which **abandons
   rather than cancels**. Two consequences the implementation must handle, or the cure is worse
   than the disease. The losing promise rejecting after the race has settled is an unhandled
   rejection, and `price-poller.server.ts:232-236` already records that Node exits the process on
   one — so the loser gets a `.catch(() => {})`. And the abandoned fetch is still in flight, so the
   worker takes no new row until it settles or the process restarts; without that guard, "nothing
   is issued in parallel and nothing is queued" (`prices.server.ts:530-533`) stops being true at
   exactly the moment Yahoo is unhappy. If `yahoo-finance2` 4.x accepts a real `AbortSignal` through
   its fetch options, thread it and delete this paragraph's second half; ticket 02 checks and says
   which.
7. **Provider hygiene:** the Yahoo client is constructed `new YahooFinance({ versionCheck: false })`
   — and this is an edit to `price-provider.server.ts:620` itself, not something the worker can pass
   in. The client is memoized inside that module (`:617-624`); `yahooPriceProvider` takes a client
   factory (`:705`), but any factory the worker supplied would have to `import("yahoo-finance2")`
   itself, making a second importer and breaking the §4.2 invariant this slice says it preserves.
   One line in the owning module is the honest answer.
   Verified against the published 4.0.2 tarball: `versionCheck` is a top-level constructor option
   (`esm/src/lib/options/options.d.ts:44`) defaulting to `true` (`defaults.js:25`), and on a result
   validation failure the library fetches `https://registry.npmjs.org/yahoo-finance2/latest`
   (`esm/src/lib/versions.js:6`) — the one non-Yahoo call it makes, and the one thing that would
   falsify "an honest worker contacts only Yahoo." `price-provider.server.ts:620` passes no options
   at all today. Pinned by a worker test.

**What crosses the mailbox is the provider's own answer, not Yahoo's.** The worker runs
`yahooPriceProvider`, so Yahoo's payload is Zod-validated and converted next to the call, where
`price-provider.server.ts`'s header argues it belongs, and ARCHITECTURE.md §4.2's "one importer of
`yahoo-finance2`" stays literally one module.

**The wire format is not the interface, and three fields make the difference.** The types that
cross are `ProviderQuote[]`, `ProviderHistory` and `SymbolProbe`:

- **Money is already a decimal string** at scale 4 (`ProviderDailyClose = { date, close: string }`,
  `price-provider.server.ts:113-120`), so the JSON round trip carries strings, never numbers, and
  CLAUDE.md's rule survives. This is the field the design worried about and the one that was already
  safe.
- **`ProviderQuote.asOf` and `.fetchedAt` are `Date` objects** (`:88-98`), and JSON turns them into
  strings. `prices.server.ts:1039` calls `quote.asOf.toISOString()` and `:941`/`:1045` hand it to
  `marketDateOf(instant: Date, …)` (`market-hours.ts:98`), so a schema written from the type without
  `z.coerce.date()` typechecks and then throws `asOf.toISOString is not a function` inside
  `refreshQuotes` — swallowed by the poller's catch into a bland "provider failed". This is the
  break the boundary makes and the reason the schema is not optional.
- **`ProviderQuote.payload` is an *optional* `unknown`** (`:107`), and `JSON.stringify` drops the
  key when it is `undefined`, so a re-parse schema must mark it optional — this module already
  records the trap in its own words at `:401-406`: Zod 4 requires the *key* to be present even where
  the value may be anything, where Zod 3 treated `unknown` as implicitly optional. It is also
  Yahoo's raw entry (`:381`), which the app writes
  verbatim into `price_observation.payload`, a table `migrations/0009_price_observation.sql:134`
  calls append-only and never pruned. A compromised worker with no grant of its own can therefore
  write unbounded permanent JSON into the household's database *through the app*. Bound its size at
  the boundary, or drop it there: the archive's value is "what Yahoo said", and once the answer is
  proxied that is no longer what it holds. §8 carries the residual either way.

**The app does not trust the payload,** and the schemas that check it have to live somewhere the app
may import. The existing Zod schemas in `price-provider.server.ts` (`:244`, `:400`, `:419`) describe
*Yahoo's* wire shape, not the provider's three answer types, which are plain TypeScript with no
runtime schema — and after ticket 04 the app may not value-import that module at all. So ticket 02
extracts `app/lib/provider-types.ts`: the three schemas, with the types derived by `z.infer` rather
than hand-written a second time (AGENTS.md), imported by `price-provider.server.ts`,
`price-mailbox.server.ts`, and `prices.server.ts` as types exactly as today. A compromised worker is
then as trusted as Yahoo is — the honest bar, since the schemas exist because Yahoo is not trusted
either.

**The worker's import closure** is `server/price-worker.ts` → `price-provider.server.ts` → `zod`,
`market-hours.ts`, `money.ts`, `provider-types.ts`, and the new `matchKey` leaf, plus a pool for the
mailbox. One edge spoils it today: `price-provider.server.ts:66` value-imports `matchKey` from
`prices.server.ts`, which drags `prices.server.ts` and `db.server.ts` — the price-*writing* module —
into a process that must not write prices. `matchKey` (`prices.server.ts:733`) is a pure string
function, so it moves (§2.3 records that its header argues otherwise, and why that changed). Those
two leaf extractions are the whole of the app-source refactor this slice needs; if a third appears,
the seam is in the wrong place.

**`scripts/smoke-test.sh:219-221` asserts `/app/app` does not exist**, under the banner "source
tree leaked into the runtime image", and CI runs it (`ci.yml:138`). Copying any `app/lib` module
into the runtime stage fails that assertion, hard — so ticket 02 must replace the blanket check with
an allowlist of exactly the worker's closure. That is a better assertion than the one it replaces:
it fails when a module is added to the image *and* when one is missing, which is the copy set's real
risk. Ticket 02 carries `scripts/smoke-test.sh` in its gates for this reason.

**The published image must learn to carry the worker.** The runtime stage ships no `app/` source at
all — `Dockerfile:104-110` copies exactly five `server/` files plus `build/`, `node_modules`, and
`migrations/`. Ticket 01 adds `server/provision-worker-role.ts`; ticket 02 adds
`server/price-worker.ts` and the closure above, preserving `/app/app/lib/` and `/app/server/` as
siblings because `db.server.ts:16-18` reaches `../../server/*.ts`. The worker entrypoint must live
under `server/`: `.dockerignore:13` excludes `scripts/` from the build context (re-including only
`prune-unreachable-deps.mjs` at `:14-15`), so a `COPY scripts/…` would fail. Node 24 requires the
explicit `.ts` extensions the closure already uses — mandatory, not optional — and type stripping is
stable and needs no flag.

**The image is shared in this slice, and that is a recorded trade.** One artifact to build, scan,
and version (the dump precedent); the app container has no egress after ticket 04 regardless — the
guarantee is the network and the grant, not the file's absence. The residual: app and worker share
one npm dependency tree, so a single poisoned package can own both ends of the mailbox (§8). The
remedy is a **named follow-up slice — worker supply-chain decorrelation**: the worker gets its own
`package.json` and image stage with a ~2-package tree (`pg`, `zod`), and `yahoo-finance2` (~40
transitive packages) is replaced by a hand-rolled fetch of the endpoints the provider uses, behind
the same Zod schemas. A Go worker was considered for full ecosystem disjointness and rejected: it
duplicates the provider's parsing and its tests in a second language and adds a second toolchain to
CI. ADR-0010 records both.

### 3.3 The mailbox: one table

Migration `0012_price_mailbox.sql`. (Not `0010`: `migrations/0010_price_backfill.sql` and
`0011_latest_position_set_cost.sql` have landed. The **ADR** number 0010 is unaffected and still
free.)

One table serves all three calls, because all three are the same transaction — *here are symbols,
give me what the feed says*:

```sql
-- Every element must look like a ticker. Written as an immutable function because a CHECK
-- may not contain a subquery, and `unnest` needs one.
create function symbols_fetchable(symbols text[]) returns boolean
  language sql immutable parallel safe strict as $$
    -- `bool_and` ignores NULL rows, so a NULL element would otherwise pass.
    select coalesce(bool_and(s is not null and s ~ '^[A-Za-z0-9.^=-]{1,15}$'), false)
    from unnest(symbols) s
  $$;

create table fetch_request (
  id           bigint generated always as identity primary key,
  kind         text not null check (kind in ('quotes', 'history', 'probe')),
  symbols      text[] not null,
  range_from   date,
  range_until  date,
  -- `getDailyCloses(symbol, range, marketTimeZone)` takes the zone, and it is load-bearing:
  -- it dates every bar and every split, and the split date decides which closes are
  -- un-adjusted. Letting the worker substitute its own `MARKET_TIMEZONE` would make a
  -- divergence between two separately interpolated environment variables a silent
  -- wrong-day error, which is the class of bug ADR-0011 exists to prevent.
  market_timezone text,
  requested_at timestamptz not null default now(),
  -- The app's own deadline, written from the same budget it will wait on. An answer nobody
  -- is waiting for is a wasted Yahoo request, so the drain skips expired rows rather than
  -- fetching them: this is what keeps "nothing is queued" true when the app times out.
  expires_at   timestamptz not null,
  claimed_at   timestamptz,                        -- the lease (§3.2 step 4)
  attempts     integer not null default 0,         -- a request that kills the worker must not
                                                   -- be reclaimed for ever by the restarted one
  payload      jsonb,                              -- ProviderQuote[] | ProviderHistory | SymbolProbe
  error        text,
  answered_at  timestamptz,

  -- `array_length` is NULL for an empty array and a NULL CHECK passes; `cardinality` is 0.
  constraint fetch_request_symbols_bounded  check (cardinality(symbols) between 1 and 500),
  constraint fetch_request_symbols_fetchable check (symbols_fetchable(symbols)),
  constraint fetch_request_one_symbol       check (kind = 'quotes' or cardinality(symbols) = 1),
  constraint fetch_request_range            check (
    (kind = 'history') = (range_from is not null and range_until is not null
                          and market_timezone is not null)),
  constraint fetch_request_range_order      check (range_until is null or range_until > range_from),
  constraint fetch_request_range_floor      check (range_from is null or range_from >= date '1970-01-01'),
  -- Bounded at both ends: an unbounded `range_until` is ~31 bits of attacker-chosen data
  -- handed straight to Yahoo's `period2`. PostgreSQL accepts dates to year 5874897.
  constraint fetch_request_range_ceiling    check (range_until is null or range_until <= current_date + 1),
  constraint fetch_request_answer           check (
    answered_at is null or (payload is not null) <> (error is not null))
);

-- The drain's query is "unclaimed, unexpired, not exhausted", and the reclaim's is
-- "claimed, lease expired" — two different predicates, so two partial indexes. A single
-- `where claimed_at is null` index cannot serve the reclaim path at all.
create index fetch_request_claimable_idx on fetch_request (expires_at, id)
  where claimed_at is null and answered_at is null;
create index fetch_request_reclaim_idx   on fetch_request (claimed_at)
  where claimed_at is not null and answered_at is null;
create index fetch_request_sweep_idx     on fetch_request (requested_at);
```

`current_date` is stable rather than immutable, so the ceiling has to be a CHECK the writer
evaluates at insert (which is what it is) and not an index predicate; ticket 01 confirms the
migration accepts it on the target version, and falls back to a fixed far-future ceiling if not.

The whole constraint set was executed against PostgreSQL and each case checked: a multi-symbol
`quotes` row and a single-symbol `history` row with a range are accepted; a `history` row without a
range, a `quotes` row *with* one, a two-symbol `probe`, a backwards range, an empty array, a NULL
element, a 16-character ticker, an embedded newline, a URL, and an unknown `kind` are all rejected
by name. What they do **not** do is bind a compromised app, which owns the table and can drop them
(§2.5) — they are the honest-app guard rail and the shape of the channel, not a lock. The two indexes are the ones the drain and the sweep use; the first is partial, so it stays
the size of the backlog rather than the table.

- **App side:** insert a row, poll it to a deadline, read `payload` or raise on `error`. Rows are
  swept opportunistically before inserting, on the `upload_draft` precedent — scaffolding, not
  history (`uploads.server.ts:207-210` is the 24h shape to copy, and it comes with an index for the
  same reason). The sweep removes answered rows older than 24h **and unanswered ones**, so a dead
  worker cannot make the table grow without bound.
- **Worker side:** claim, fulfil, answer. It never inserts and never deletes.
- **The lease is one number and the spec has to pick it**, because both directions hurt: shorter
  than a slow Yahoo call and two workers double-fetch; longer than the app's budget and every worker
  restart guarantees a timeout. Take the provider watchdog (~30 s) plus one drain interval, and say
  so in ticket 01 rather than leaving an implementer to reason it out from scratch.
- **`attempts` bounds the poison pill.** A request that kills the worker — an OOM on an enormous
  chart response — is reclaimed on lease expiry by the restarted worker and kills it again, and
  `restart: unless-stopped` makes that a loop. The reclaim increments; past a small bound the row is
  answered `error` instead of retried. `upload_draft` needs no equivalent because nothing retries
  it.
- **Why not three tables:** the three kinds differ by two nullable date columns and a cardinality
  rule, all expressible as CHECKs. Three tables would be three drains, three claim paths and three
  grants for one transaction shape.
- **Why the `probe` kind cannot fold into a one-symbol `quotes` request:** `getQuotes` drops a
  non-USD symbol per symbol (`price-provider.server.ts:723-729`), so a single-symbol answer of `[]`
  collapses "quoted in GBP" into "never heard of it" — precisely the distinction `probeSymbol`
  exists to preserve (`:660-670`), and the one ingest refuses on. The third kind is structural, not
  convenience. (Dropping the creation-time probe altogether is a different question, and a real
  one — it is the only place ingest waits on a third party, and this slice makes that wait longer.
  It changes a product rule, so §7 records it rather than deciding it here.)

### 3.4 What changes in the app

Very little, which is the point.

- **New module `app/lib/price-mailbox.server.ts`.** It exports `mailboxPriceProvider(budget)`
  returning a `PriceProvider`, and `mailboxProbeSymbol(budget)` returning a `ProbeSymbol`
  (`price-provider.server.ts:649`). Each call inserts a row, polls it, and returns the parsed
  payload — or throws, for `getQuotes`/`getDailyCloses`, and returns `{ status: "unavailable" }`
  for the probe, whose contract is never to throw (`:688-693`).
- **One shared deadline budget per invocation, not per call.** A refresh makes up to six provider
  calls (one `getQuotes`, up to `BACKFILL_BATCH_SIZE` = 5 `getDailyCloses`, `prices.server.ts:87`)
  and ingest probes sequentially (`instrument-resolution.server.ts:502-511`). Per-call deadlines
  would stack: against a dead worker one press would cost six timeouts and six new symbols would
  cost six more. The budget is created once per `refreshPrices` invocation and once per `resolveAll`
  invocation; when it is spent, later calls fail immediately. This is one helper serving both, not
  two poll loops.
- **A dead worker needs no new outcome.** `backfillCloses` already ledgers a per-instrument provider
  throw as `providerFailed` and continues (`:537-540`); `refreshQuotes` already maps a provider
  throw to `RefreshReport.providerFailed`. So the route's existing outcome union
  (`refresh.ts:21-33`) and its renderer (`app/components/price-freshness.tsx:71`) are **unchanged**,
  and the household sees "the feed could not be reached", which is true. Distinguishing "worker
  down" from "Yahoo down" is an operator question, not a household one: it goes in the log line and
  in a `docs/runbook.md` entry (ticket 06), and a distinct outcome variant remains additive later if
  it is ever wanted.
- **Two call sites swap a provider, and the poller's seam has to change shape.**
  `refresh.ts:14`/`:67` constructs a provider per press, so it substitutes directly.
  `startPricePoller(provider: PriceProvider = yahooPriceProvider())` (`price-poller.server.ts:193`)
  does not: it stores the provider once in `PollerState` and every tick reuses it (`:129`), so a
  `mailboxPriceProvider(budget)` there would hold **one budget for the life of the process** — the
  first worker outage spends it and every later tick fails immediately, for ever, against a healthy
  worker. The parameter becomes a factory,
  `startPricePoller(makeProvider: () => PriceProvider = () => mailboxPriceProvider(newBudget()))`,
  and `tick` calls it. That is a one-line change at each of the five poller test sites
  (`tests/price-poller.test.ts:160`, `:290`, `:369`, `:402`, `:444`) — `startPricePoller(() =>
  provider)` — and it is the only place ticket 04 touches an existing test. `app/root.tsx:67`,
  `requestRefresh` (`:245-258`) and its upload caller (`app/routes/upload/review.tsx:83`) are
  untouched.
- **`getQuotes` is unbounded and the table caps `symbols` at 500.** `refreshQuotes` sends every feed
  instrument in one call, so a household past that cap would see every refresh fail permanently on a
  constraint violation dressed up as `providerFailed`. `mailboxPriceProvider` chunks into rows of
  ≤500 and concatenates — the batched call was always an optimisation, not a contract — or the cap
  is documented as a hard limit that fails loudly. Chunking is the smaller surprise.
- **The sweep runs once per budget, not once per call.** `createDraft`'s precedent
  (`uploads.server.ts:206-209`) sweeps on a rare human action; sweeping before every provider call
  means up to six DELETEs per tick. It belongs in the shared helper that creates the budget.
- **The in-process probe default goes away.** Ticket 04 makes `ResolutionDeps.probe` **required**
  and deletes the `probeSymbol` import and `?? probeSymbol` fallback from
  `instrument-resolution.server.ts:20,499` — otherwise the in-process Yahoo path stays in the app's
  module graph as a silent default for any future caller, exactly the off switch §3.6 refuses. The
  one production call site passes the mailbox probe
  (`app/routes/upload/instruments.tsx:104`); `tests/routes/upload-instruments.test.ts:84,162` call
  `resolveAll` with no deps and need a stub.
- After ticket 04 nothing in the app's module graph value-imports `price-provider.server.ts` (types
  cross freely).
- **Symbol validation sits in two places, and only one of them is a security control.** The mailbox
  module rejects a pattern-violating symbol before insert and returns `unavailable` for a probe —
  app-side validation is trim-and-length-only (`instrument-resolution.server.ts:308-312`), so
  "BRK/B" or a 16-character ticker would otherwise turn the insert into a constraint error where
  today's probe returns a clean create-anyway verdict. That is ergonomics. The CHECK constraint is
  the control, because it binds when the app is the attacker.
- **Latency, stated rather than discovered.** Each provider call is now a round trip: app insert →
  worker notices (≤ drain interval) → Yahoo → app notices (≤ poll interval). At a 250 ms drain and
  a 100 ms poll that is ~0.35 s of overhead per call, so a full refresh with a five-instrument
  batch adds ~2 s to a press that already spends seconds in Yahoo. Those intervals, not one second,
  are what the arithmetic requires; four polls a second against one partial index on an otherwise
  idle household database is not a load, and ticket 02 measures rather than assumes it.

### 3.5 The `portfolio_worker` role

Postgres is default-deny: a fresh role can connect and see the catalog, and nothing else (PG15+ even
revoked `CREATE` on `public`). The role's entire world is the mailbox:

```sql
-- 0012_price_mailbox.sql, guarded per §3.5's external-Postgres note below
create role portfolio_worker nologin
  nosuperuser nocreatedb nocreaterole connection limit 5;

grant select on schema_migrations to portfolio_worker;
grant select, update (claimed_at, payload, error, answered_at)
  on fetch_request to portfolio_worker;

-- Not grants: PUBLIC defaults the role inherits whether or not anyone grants it anything.
revoke connect on database postgres, template1 from public;
```

That is the whole grant list. Not `instrument`, not `quote`, not `price_daily`, not
`price_observation`, not `price_poll`, not `price_backfill`, not `app_setting`, and — the two the
first repair could not avoid — not `holding` and not `position_set`.

- **No INSERT and no DELETE anywhere.** The worker cannot create work for itself, cannot erase the
  mailbox, and cannot touch a price or a position.
- **Verified, not reasoned.** An earlier and much wider grant list was executed statement by
  statement under `SET ROLE portfolio_worker` against a cluster carrying this repository's whole
  migration set; every table on the invisible list raised `permission denied`, including through
  `holding_valued_at(d)` and `latest_position_set(…)`, which are plain `language sql` functions with
  no `SECURITY DEFINER` (`latest_position_set` at `migrations/0002_holding_valued.sql:46-49`;
  `holding_valued_at` defined in `0003_holding_valued_at.sql` and replaced at
  `0006_annual_dividend.sql:178-182`) and so fail on their base tables rather than leaking. This
  design strictly narrows that list, and ticket 01 re-runs the check against what actually ships.
- `schema_migrations` is created by the migration *runner* (`server/migrations.ts:14`), not by a
  migration file, so it already exists by the time 0012 runs and the grant lands.
- Identity-column sequences need no separate grant — verified empirically, and it is a property of
  this schema rather than a general rule: every surrogate key in `migrations/` is `generated always
  as identity`, and the same insert against a `serial` column fails with `permission denied for
  sequence`.
- `connection limit 5` is generous for a process holding one small pool and answering a healthcheck.
  It is defence-in-depth against a runaway, never the boundary, and must never be what fails a
  healthy refresh.
- **"Defined by what it is granted" is not quite true, and the gap is where the attacks are.** A
  role also carries every PUBLIC default, and three of them were confirmed live against this schema
  under exactly the grants above. `CONNECT` on the `postgres` and `template1` databases is PUBLIC
  (revoked above; nothing of the household's is there, but the role should not have reach it never
  needs). `EXECUTE` on functions is PUBLIC, so
  `has_function_privilege('portfolio_worker','holding_valued_at(date)','EXECUTE')` is true — harmless
  only because the function is `SECURITY INVOKER` and fails on its base tables, which is a property
  worth a test rather than an assumption. And **large-object creation is gated by nothing at all**:
  `select lo_from_bytea(0, …)` as the worker wrote 98 kB into `pg_largeobject` with no table grant
  involved. No `REVOKE` closes that one — it is a residual (§8), not a fix, and the same is true of
  `CREATE TEMP TABLE`, which PUBLIC also holds.
- **The worker pool's `max` must be pinned, and there is only one place to do it.** `createPool`
  (`server/db.ts:45-53`) takes a connection string and no options, and it is the enforced single
  construction site — the one that registers the `numeric`/`int8`/`date` parsers
  (ARCHITECTURE.md:337). Ticket 02 widens *that* signature. A second `new pg.Pool` in
  `price-worker.ts` would be the exact failure the invariant exists to prevent.

**Migration 0012 must not hard-fail on an external Postgres.** `docs/operating.md:193` states the
only privilege requirement for that mode — "the role needs to be able to create tables" — and
migrations run at every container start against whatever `DATABASE_URL` names. `CREATE ROLE` needs
`CREATEROLE` or superuser, so an operator following the documented external-Postgres instructions
would have the entrypoint fail (`docker-entrypoint.sh:9` is `set -eu`) and the container never
start. The role creation and its grants therefore sit in a DO block that catches
`insufficient_privilege`, raises a notice naming the manual step, and lets the migration succeed;
ticket 06 documents the manual step in the external-Postgres section, whose only privilege sentence
today is `:193`. Related and also unstated today: **roles are cluster-global while this app's
databases are not.** Two instances on one cluster — a staging database beside production, which the
external-Postgres mode invites — share one `portfolio_worker`, and each instance's provision step
silently rotates the other's credential on every boot. Ticket 06 says so; making the role name
instance-specific is a larger change than this slice needs.

**The role means nothing while the superuser password is a default.** `compose.yaml:59` falls back
to `POSTGRES_PASSWORD:-portfolio`. This slice puts a low-trust, egress-capable container on the same
Postgres as the household's data; a compromised worker would simply reconnect as
`portfolio`/`portfolio` and read everything. **That fix is ticket 00, and it lands first** — it is
independent of everything else here, it is worth doing whether or not the rest is ever built, and
the alternative is a window (from ticket 03's deploy to ticket 04's cutover) in which the new
container is attached to `db` while the guessable password still works.

Ticket 00 makes `POSTGRES_PASSWORD` required (`:?`), which forces re-deriving the two `DATABASE_URL`
defaults that embed `portfolio:portfolio` (`compose.yaml:126`, `:204`; the coupling `:56-57` warns
about) to `postgres://portfolio:${POSTGRES_PASSWORD}@db:5432/portfolio`, and updating
`.env.example:23` and its commented `#POSTGRES_PASSWORD=portfolio` at `:104`, or the documented
`cp .env.example .env` flow overrides the re-derived default. Two traps it must not walk into:

- **`smoke-test.sh:109-116` will invert.** It runs `docker compose --env-file /dev/null config` with
  only the four gate variables unset and asserts the refusal names one of them. `db`
  (`compose.yaml:45`) precedes `gate` (`:233`), so a newly required `POSTGRES_PASSWORD` at `:59` is
  what Compose reports first.
- **Interpolating a raw password into a URL breaks on URL delimiters** (`/`, `?`, `#`), and
  percent-encoding the shared variable breaks the `ALTER ROLE`, which would store the encoded text
  literally. Hence a documented URL-safe alphabet, validated where the password is used.

**Credential provisioning.** The role and its grants are schema history and live in the migration.
The *login credential* is operator config: `server/provision-worker-role.ts`, running as `portfolio`
after `migrate.ts` in `docker-entrypoint.sh:12`, sets the password when `WORKER_DB_PASSWORD` is
present — and **creates the role first if it is missing**, because a restore is exactly where it
will be. The dump is per-database (`scripts/dump-loop.sh:262` runs
`pg_dump -d "$DATABASE_URL" --format=custom`, no `--create`, no roles) while roles are
cluster-global, so a dump restored onto a fresh cluster carries `schema_migrations` (migration 0012
will never re-run) and ACL entries naming a role that does not exist. **Verified, not reasoned:**
restoring such an archive onto a cluster without the role stops at the first ACL entry —
`pg_restore: error: … role "portfolio_worker" does not exist` — and with `--single-transaction` the
whole restore rolls back, so the symptom is a restore that appears to do nothing. The restore
runbook (ticket 06) therefore bootstraps the role *before* `pg_restore --exit-on-error`.

**`ALTER ROLE … PASSWORD` takes no bind parameters, so do not send the password at all.** Compute
the SCRAM verifier in Node — `SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>` — and pass *that*
as the literal; PostgreSQL stores it verbatim and the original still authenticates. This was
verified end to end: `alter role … password '<verifier>'` followed by a successful login with the
cleartext. Three things fall out of it. The cleartext never crosses the wire. The literal is base64
and `$`-delimited, so it is injection-proof by construction rather than by a regex. And it stays out
of the database log — which matters, because `log_min_error_statement` defaults to `error`, so a
statement that fails for *any* reason is logged in full, and the `db` container's log is 30 MB of
json-file on the operator's disk (`compose.yaml:38-42`). Build the statement with
`select format('alter role %I login password %L', $1, $2)` and execute the result; the validated
alphabet is then a third line of defence, not the first.

The alphabet restriction still earns its place on the URL side, and the runbook should say why per
character rather than "URL-safe": `/`, `?` and `#` truncate or reparse the authority; `@` re-splits
the userinfo; and `%` is percent-*decoded* by `pg-connection-string`, so `abc%41def` in `.env`
provisions the literal text and connects as `abcAdef` — a silent mismatch that reads to an operator
as a wrong password. Worth stating too: the value is visible in `docker inspect`,
`docker compose config` and `/proc/1/environ`, and it sits in the **app's** environment as well as
the worker's. That is harmless — the app is already the superuser — but an operator should read it
here rather than discover it. Config surface: `app` gains optional
`WORKER_DB_PASSWORD` in `configSchema` (`server/config.ts:35-94`) so the step reads it through
`loadConfig` — ARCHITECTURE.md §4.2's rule that `server/config.ts` is the only reader of
`process.env` (`:345`) survives intact.

### 3.6 Development and tests

- **`npm run dev` has no worker.** The dev story is one extra command:
  `node --env-file=.env.worker ./server/price-worker.ts` in a second terminal when live prices are
  wanted — with its own env file, because `.env`'s `DATABASE_URL` is the `portfolio` superuser
  (`docs/developing.md:57`) and running the internet-facing worker with full database access in
  development would skip the very privilege boundary this slice exists for. `docs/developing.md`
  gains the recipe, and the two existing recipes that assume an in-process fetch (`:391-434`
  "Exercise a backfill locally", `:435-474` the split convention) are updated with it. Without a
  worker: screens serve stored prices, a refresh reports `providerFailed` after one shared budget,
  and ingest probes come back `unavailable` — instruments **created anyway**, unpriced, which is the
  existing contract (`instrument-resolution.server.ts:513-515`); only `non-usd` refuses.
  **Deliberately no `PRICE_FETCH=in-process` fallback mode:** a second code path would keep the
  yahoo import reachable from the app and give the security property an off switch. (Assumption to
  confirm with the owner; reversing it later is additive.)
- **Almost every existing test is untouched**, which is the strongest evidence the seam is in the
  right place. `refreshQuotes`, `backfillCloses`, `refreshPrices`, `price-provider` and the poller
  suites all drive a fake `PriceProvider` already; none of them knows or cares that production now
  passes a different implementation. The only existing tests that change are
  `tests/routes/upload-instruments.test.ts:84,162`, which get a probe stub.
- New tests, real Postgres per house style:
  - the mailbox provider round-trips each of the three kinds, shares one budget across a
    `refreshPrices` invocation, and surfaces a spent budget as a throw (and as `unavailable` for the
    probe);
  - a payload whose money arrived as a JSON number is refused rather than coerced;
  - worker fulfilment: a claimed row is answered; an expired lease is reclaimed; a landed answer
    survives a second write; a pattern-violating symbol never reaches the provider;
  - **the permission pin, and it must not be a grant snapshot.** Enumerating
    `information_schema.role_table_grants` is blind to the two most likely widenings, both confirmed
    live: `grant pg_read_all_data to portfolio_worker` and `grant select on account to public` each
    leave the grant rows byte-identical while the role gains `account`. The grant views exclude
    PUBLIC by definition, and role membership lives in `pg_auth_members`. So the pin asks the
    question that resolves both: **`has_table_privilege` and `has_column_privilege` for the role
    over every table and column in `pg_class`/`pg_attribute`**, compared against §3.5's exact list —
    `has_table_privilege('portfolio_worker','account','select')` is `f` today and flips to `t` under
    either widening. Add an emptiness assertion on `pg_auth_members` for the role, and cover
    `information_schema.routine_privileges` too, since `EXECUTE` also defaults to PUBLIC.
  - the two SQL functions are asserted to *fail on their base tables* under `SET ROLE`, which is the
    property that matters — the role holds `EXECUTE` on them either way, so a future
    `SECURITY DEFINER` is the regression this catches.
  - A permission error aborts the transaction `withDatabase` (`tests/support/database.ts:92`) gives
    the test body, so each denial takes a savepoint — the pattern the house already uses, with its
    reasoning, at `tests/refresh-quotes.test.ts:778-798`.

### 3.7 Alternatives considered

- **The worker runs `refreshPrices`; the app supplies the backfill's candidates.** The first repair
  after the drift was found. Rejected on review: it makes the worker re-implement a composition
  whose failure rule depends on a module-private class, needs `refreshPrices` and `backfillCloses`
  re-signed, needs nine mailbox outcome columns mirroring a type that has already churned once,
  needs a candidate table that turned out to lack `symbol` and carry a dead `range_until`, and
  rewrites the poller's test suite. §2.4 has the full list. Every one of those costs is paid to move
  code that did not need to move.
- **The worker runs `refreshPrices` and reads `holding(instrument_id, position_set_id)` and
  `position_set(id, as_of_date)` directly.** The smallest possible change to the first draft — two
  column grants. What it actually discloses is narrow: which instruments appear in which position
  sets and those sets' dates, with no amounts, no accounts and no people, and a position set cannot
  be tied to an account. It was tempting to reject this as "spending the headline property", but
  that reason is vanity — §8 already accepts that the worker learns which symbols the household
  tracks. The real reason is the one above: it keeps the worker running the domain, and the
  household read is the least of what that costs. There is a genuine difference in exposure, worth
  stating: the mailbox discloses the symbols under fetch while a request is open; the grant
  discloses the whole holdings graph, continuously.
- **A view owned by `portfolio`, granted to the worker.** Would return candidates without exposing
  the base tables: a plain `CREATE VIEW` already runs with the owner's privileges (`security_invoker`
  is a view *reloption*, spelled with an underscore, and `false` is the default since PostgreSQL 15
  — the earlier draft's `SECURITY INVOKER = false` is not valid syntax). Rejected for the same root
  reason, and the count the earlier draft gave against it was wrong anyway: the predicate is one
  shared `sql` fragment today, `NO_CLOSE_BY_FIRST_HELD` at `prices.server.ts:253-258`, used by both
  `selectBackfillCandidates:320` and `backfillGaps:421`. Consolidating those onto one view is a
  plausible future refactor and is not a security change.
- **An HTTP API on the worker**, a **LISTEN/NOTIFY doorbell**, **separate images now**, and a
  **Go worker** are recorded in ADR-0010 with their arguments.

## 4. Tickets

Shape per `docs/specs/README.md`; one ticket = one PR that typechecks, builds, tests green standing
alone.

| # | Ticket | Blocked by |
|---|--------|------------|
| 00 | **Require `POSTGRES_PASSWORD`**: `:?` at `compose.yaml:59`, the app/dump `DATABASE_URL` defaults re-derived (`:126`, `:204`), `.env.example:23` and `:104`, the compose header's "every other setting has a working default" (`:20`), the documented URL-safe alphabet, `smoke-test.sh:109-116` fixed and a new assertion that the variable is required by name | Nothing |
| 01 | Migration `0012_price_mailbox.sql`: `symbols_fetchable`, `fetch_request` with its constraint set and three indexes, `portfolio_worker` + its two grants and the PUBLIC revokes, inside a privilege-guarded DO block; `server/provision-worker-role.ts` (SCRAM verifier) + entrypoint step + Dockerfile COPY; optional `WORKER_DB_PASSWORD` in `configSchema`; regenerate `database.generated.ts`; the `has_table_privilege`-based ACL pin and the denial list | Nothing |
| 02 | `matchKey` and `provider-types.ts` to leaf modules; `server/price-worker.ts` — config reuse, ledger check, claim/fulfil/answer drain, lease reclaim, guarded answers, the bounded provider with its abandoned-promise guard, `versionCheck: false`; `createPool` gains a pool-size option; Dockerfile carries the worker entry and its closure; fulfilment tests | 01 |
| 03 | **Deploy the worker alongside** the still-fetching app: compose `worker` service, `worker-db` + `egress-worker` networks, `compose.dev.yaml` override, `smoke-test.sh` service lists, a seeded `fetch_request` the worker must answer in the built image — **and its own operator note**, because `WORKER_DB_PASSWORD:?` aborts interpolation for the whole project | 00, 02 |
| 04 | **App cutover**: `app/lib/price-mailbox.server.ts` (provider + probe, one shared budget, chunking, the wire-format schemas), the two provider swaps with the poller's factory seam, `ResolutionDeps.probe` made required | 03 |
| 05 | **Network lockdown**: the full seven-network topology (`app` and `gate` split apart), and the total egress/DNS/`Internal` assertion set | 04 |
| 06 | Docs: DESIGN.md, ARCHITECTURE.md, ADR-0010, ADR-0011's banner, CONTEXT.md, `docs/operating.md` (Engine floor, service table, restore and rehearsal, upgrade, external Postgres), `docs/runbook.md`, `docs/developing.md`, `docs/specs/README.md` | 05 |

**00 and 01 are both free to start**; 02 needs 01's schema, and 03 needs 00's required password
because it is the release that attaches an egress-capable container to `db`. After that it is a
chain. Ticket 00 is the one with standing value if the slice is never finished.

04 and 05 are split because they are independently deployable and independently revertable: after
04 the app fetches through the mailbox but still has an unused egress route, which is harmless. One
PR that rewrites three app modules *and* redraws the network is not a diff anyone can hold in their
head.

**Deploy coupling: none — every ticket leaves a deployable main.** After 03 the worker runs beside
the still-fetching app, draining a mailbox nothing writes to; 04 is the single release where the app
stops fetching and loses its internet route. There is no commit from which a deploy has no price
refresh.

## 5. Acceptance (slice level)

- **The egress assertion set is total, not partial.** Outbound TCP and external DNS resolution both
  fail from `app`, `db` **and `dump`** — `dump` holds the whole household's finances in plaintext on
  a bind mount and is the highest-value container to attach to an egress network by accident, and no
  earlier draft asserted anything about it. `worker`, `gate` and `caddy` are asserted to *have* the
  route, so the set says something about every service rather than about three of them.
- `docker network inspect` reports `"Internal": true` for `backend`, `worker-db`, `caddy-app` and
  `caddy-gate` — one line that names the property directly, rather than inferring it from a failed
  `fetch`.
- The positive control does not depend on Yahoo. Asserting "from `worker`, Yahoo resolves" couples
  CI to a third party's uptime and rate limits, and the day it flakes someone relaxes it and the
  negative assertions stop being falsifiable. Use any DNS name and a TCP connect.
- From `worker`: `app:3000` and `gate:4180` are **unreachable**, and the worker answers a seeded
  `fetch_request` *in the built image*, not merely starts a process. The seeded row is a `probe` for
  a symbol that does not exist, and an unreachable feed still writes `error` and `answered_at` — so
  the assertion proves the loop and the Dockerfile copy set, and deliberately proves nothing about
  egress. Ticket 04's assertions do that.
- "Refresh now" round-trips through the mailbox on all five screens; JS-off behaviour unchanged
  (blocks, then redirects).
- A refresh still backfills end to end, with the worker holding no grant on any table but
  `fetch_request`.
- Ingest probes resolve through the mailbox; a non-USD symbol still refuses cleanly with nothing
  written; a dead worker costs one shared budget, not one wait per symbol.
- The permission pin fails if anyone widens the worker's grants.
- A fresh `docker compose up` with the two required env vars comes up healthy end to end, including
  via the documented `cp .env.example .env` flow; without them it fails fast, naming the variable.
- `npm run typecheck`, `npm test`, `npm run build`, and `scripts/smoke-test.sh` green.

## 6. Documentation deltas (detail for ticket 06)

- **DESIGN.md**: §6.2 (`:443-502`) gains the mailbox paragraph; §10's "Job scheduler" row — `:826`,
  in the §10 deployment table, not the §9 stack table — rewritten with *why the trade flipped*;
  §10.1's "no separate worker service" (`:913-918`); the services block (`:876-903`) gains `worker`
  **and `dump`, still missing since spec 0014**; the env table (`:944-951`) gains
  `WORKER_DB_PASSWORD` and `POSTGRES_PASSWORD`, and the six `DUMP_*` variables it is already behind;
  `:956-957`'s "the gate's are the only settings anywhere with no default" becomes false with ticket
  00 and must move with it.
- **ADR-0010** "Price fetching is an egress-isolated worker": context, decision (**a fetch proxy,
  not a second writer**; mailbox over API; polling over LISTEN/NOTIFY; role over trust),
  consequences, and the alternatives in §3.7 plus those recorded there. ADR-0009 `:32-46` is the
  template for arguing a second container against the three documents that say there is none.
- **ADR-0011**: its spec-number references were repointed to 0018 with the rename. What is owed is
  `:55-56`'s "Nothing is shaped for spec 0018's worker", which gets a `Reversed` banner in the form
  `docs/specs/README.md:14-20` describes. Note what is true: this slice does **not** reshape the
  backfill as a request row in the sense ADR-0011 rejected — `backfillCloses` is not touched.
- **ARCHITECTURE.md**: §3.1's "**No worker container**" (`:161-163`) and its mermaid `class` line
  (`:156`); §4.2's yahoo-import row (`:338`) keeps its site and its `:619` reference — **both are
  correct today, do not "fix" them** — and gains a reachability note; the env-reader row (`:345`)
  gains the worker entrypoint and provision step; the pool row (`:337`) gains the pool-size option.
  §11.2's in-process-poller row (`:1959`) is **not** discharged: the poller stays in-process and its
  missed-poll limit stays true. Only its third column, which costs the fix at "two images, two
  deployments, two log streams", becomes historical. Three genuinely stale refs nearby cost nothing
  to fix while there: `:346` cites `upload.tsx:48` (actual `:57`), `:355` cites
  `positions.server.ts:276` (actual `:211`), `:399-400` cites `statement.ts:32`/`:608` (actual
  `:26`/`:561`).
- **CONTEXT.md**: *price worker*, *mailbox* — words to avoid: "queue", "job table". They join "How
  prices stay fresh" (`:93-120`), whose *Refresh cadence* (`:95`) and *Poll* (`:108`) entries still
  read as though one process does everything.
- **docs/operating.md**: the "What runs here" table (`:28-33`) gains `worker` and `dump`, and
  `:31`'s "the price refresh loop, in one process" is corrected; the Engine floor at `:84-92`, which
  states none today, with the property that depends on it; the env table (`:250-257`); the upgrade
  runbook (`:978` enumerates services by name) and the `ALTER ROLE portfolio PASSWORD` step existing
  clusters need; the restore procedure (`:870-904`), whose `:893-895` names the in-app refresh loop
  as the connection holder that would make `dropdb` fail; the rehearsal (`:906-929`); rebuilding
  from nothing (`:931-945`); the external-Postgres section (`:184-197`).
- **docs/runbook.md**: a "prices are not refreshing" entry — the worker down, the mailbox backing
  up, the log stem to grep.
- **The counts.** ADR-0009 `:81-82` accepted the obligation to turn "all four containers…" into
  rules per `docs/README.md:9-12` and it was not discharged when `dump` landed; a worker makes it
  six. Clear it in the passages ticket 06 already edits: `docs/operating.md:56`, `:206`,
  `DESIGN.md:905`, `ARCHITECTURE.md:156`, `:179`, `:186`.

## 7. Out of scope

- gVisor/runsc runtime overlay (companion change, separate compose override file).
- Pinned items from the earlier hardening list (`.npmrc` ignore-scripts, Dockerfile
  `--ignore-scripts`, SHA-pinned Actions, Renovate, digest-pinned images).
- **Worker supply-chain decorrelation** — the named follow-up slice (§3.2).
- **Dropping the creation-time USD probe** (§3.3) — it would delete the mailbox's third kind and the
  only place ingest waits on a third party, but it changes a product rule.
- Consolidating `selectBackfillCandidates` and `backfillGaps` onto one SQL view (§3.7).
- Extracting `masking-policy.ts` from `masking.ts` — no longer needed by this slice (§2.4).
- Moving the *app* off the `portfolio` superuser role — opened by ticket 00, not done in it.
- Any auth change (ADR-0005 stands).

## 8. Residual risks, stated plainly

- **Price lying.** The worker cannot write a price, but it can answer a fetch with fabricated
  figures, and the app will believe a well-formed payload exactly as it believes Yahoo. What the
  role change buys is that the lie is confined to what a refresh would have written anyway. It is
  worth being concrete about what that excludes, because an earlier draft granted the worker the
  price tables and each of these was reachable with one `UPDATE`: it cannot set `quote.price` to
  `'NaN'` (a valid `numeric(20,4)` that makes `money.ts:47` throw `Cannot convert NaN0000 to a
  BigInt`, so every screen 500s and the as-of line never renders); it cannot rewrite the `USD`
  instrument's `1.00` seed (`0001_initial_schema.sql:265-284`) and rescale every cash balance across
  all of history; it cannot reclassify holdings through `instrument.quote_type`
  (`allocation.ts:355-380`); and it cannot insert `price_backfill` rows, which are not a record but
  the app's **retry clock** (`prices.server.ts:306-318`) — one forged row per instrument per interval
  would have suppressed every future backfill while `backfillGaps` showed a recent, successful-looking
  attempt. Under the design taken, all of those need a grant the worker does not have. What survives:
  a lie in a payload, which the app's schema bounds to well-formed decimals — and that schema
  rejecting non-finite values is a test, not an assumption.
- **Covert exfiltration channels that remain:** ticker-shaped strings and bounded date ranges to
  Yahoo, at roughly 11 bytes per symbol and up to ~5.6 KB per row with rows uncapped (§2.5),
  throttled by Yahoo's rate limiting rather than by a constraint. Splitting `caddy-app` from
  `caddy-gate` removes the app's direct path to the gate's token relay, which was the larger channel
  and was not the same class. What remains of that one is the browser-mediated OAuth flow itself,
  which is the gate working. Accepted.
- **The worker's reach is wider than "Postgres and the internet."** `egress-worker` is a normal
  bridge, so the host and the operator's LAN are reachable, including Caddy's published `:80` and
  through it the gate's ungated `/oauth2/*` (§3.1). Constraining that needs `DOCKER-USER` rules,
  out of scope for the same reason as Caddy's own unused route. Named rather than asserted away.
- **Correlated compromise (until the follow-up slice):** app and worker share one npm tree, so one
  poisoned package can sit on both ends of the mailbox and coordinate. In that case the worker-side
  pattern check is compromised code, the app can drop the CHECK constraints outright (§2.5), and the
  `egress-worker` network is unrestricted internet — nothing but code pins the worker to Yahoo. The
  surviving bound is the worker role's read set, which is one table of ticker symbols.
- **This slice bounds exfiltration, not damage.** A compromised app still connects as the superuser,
  and `COPY … FROM PROGRAM` as that role is arbitrary command execution inside the `db` container,
  including its bind-mounted PGDATA. After lockdown `db` has no route out, so it is not an exfil
  path — but nobody should read §1 as saying a compromised app is contained. Moving the app off the
  superuser role is the fix, and §7 defers it.
- **A compromised worker can stall refreshes, and the app should not hang.** `LOCK TABLE
  fetch_request IN ACCESS EXCLUSIVE MODE` needs only the `UPDATE` the role holds, and the cluster
  sets no `statement_timeout`, `lock_timeout` or `idle_in_transaction_session_timeout`
  (`compose.yaml:64-69` sets only timezone). Under an earlier draft the same statement against
  `quote` would have hung *every screen* indefinitely while the healthcheck stayed green; here the
  blast radius is the mailbox, so a refresh stalls and the screens keep serving stored prices. Set
  `lock_timeout` and `statement_timeout` on the **app's** pool anyway, so a stall is a visible error
  rather than a hang. A role-level `ALTER ROLE … SET` does not bind — those GUCs are `USERSET` and
  the worker can reset them.
- **`ProviderQuote.payload` is a write channel through the app.** The app archives it verbatim into
  `price_observation.payload`, which is append-only and never pruned, so a compromised worker can
  put unbounded permanent JSON into the household's database without holding a grant on anything.
  Bounding or dropping it at the boundary (§3.2) is the mitigation; whichever ticket 04 takes, this
  is the residual it leaves.
- **Large objects and temp tables are an unbounded disk-write channel no grant covers.** Confirmed
  live under exactly §3.5's grants: `lo_from_bytea` wrote 98 kB into `pg_largeobject`, and
  `CREATE TEMP TABLE` succeeded — both PUBLIC defaults with no `REVOKE` that closes them. A filled
  disk also trips `scripts/dump-loop.sh:212`'s `room_for_dump` guard, so it takes the nightly dump
  with it. Accepted, and named here because it is invisible to anything the grant list says.
- **Symbol-length mismatch:** the app accepts stored symbols up to 40 characters
  (`instrument-resolution.server.ts:309`); the mailbox accepts ≤15 with no slashes, so an
  unusual-but-legitimate stored symbol never refreshes and shows as permanently stale. That is the
  *intended* outcome and it depends entirely on the mailbox module filtering the batch rather than
  refusing the call (§3.4) — get that backwards and the same symbol makes the whole household's
  refresh fail instead of one instrument. Documented in ticket 06; tightening the app-side rule to
  match is a small follow-up.
- **Every fetch is now a round trip**, adding roughly two seconds to a full refresh (§3.4). A press
  that already spends seconds in Yahoo absorbs it; a slower drain interval would not.
- **A refresh needs two healthy processes.** The app decides and the worker fetches, so an app
  outage stops price refresh as well as the screens that would show it — no loss in practice. The
  missed-poll-on-restart limitation DESIGN.md §10 accepted is *kept*, not fixed: the poller stays
  in-process, and ARCHITECTURE.md §11.2's row stays true.
- **Ticker-list disclosure:** the worker and Yahoo necessarily learn which symbols the household
  tracks, and from history ranges roughly how far back it has held them. True of Yahoo today.
  Accepted.
- **Engine floor:** the worker↔gate isolation depends on a Docker Engine that does not lose bridge
  isolation on a firewalld reload (§3.1). Below 28.0 that property is not there to assert; the docs
  state ≥ 29.5.1 and the smoke test catches the symptom, not the cause.
- **Worker outage = stale prices:** surfaced honestly, as a provider failure and an ageing as-of
  line. `price_poll.started_at` is a coarse and incomplete heartbeat — rows appear only on committed
  runs, and since ADR-0011 a quotes-less weekend refresh writes none at all. The runbook entry
  (ticket 06) is the operator's signal instead. Accepted at this household's stakes.
- **Caddy retains an unused internet route** (published-port constraint). It makes no outbound calls
  and fronts everything anyway; constraining it further (DOCKER-USER rules) is out of scope.
