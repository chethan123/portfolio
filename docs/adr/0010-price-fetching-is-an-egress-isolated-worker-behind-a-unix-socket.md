# Price fetching is an egress-isolated worker behind a unix socket

The process that fetched prices was, until this slice, the same process that holds the household's
every balance: it called `yahoo-finance2` directly — the one dependency in the production tree that
talks to the internet, and the largest share of that tree by itself — and it connected to Postgres
as the initdb superuser, whose password had a default and travelled inside connection URLs. Nothing
stopped that process opening a socket to anywhere, and nothing stopped whatever compromised it from
reading every account, holding and position the household has. The concern is three adversaries,
judged separately because the guarantee needed differs for each: a compromised app should have no
network path out; a compromised feed should be unable to read what the household holds; and the two
compromised together — one image, one npm tree, serving both ends of whatever crosses between them —
should still be bounded by something other than code review.

A prior plan (the unindexed `docs/specs/0015-price-worker.md`, deleted with this slice; see
[ADR-0011](0011-a-backfill-fills-the-spine-but-never-moves-it.md)'s superseded-in-part note) had the
worker *own* the refresh, under a column-level grant onto six price tables. Spec 0018 §2.3
disqualifies that shape rather than merely losing to a better trade: a refresh is now quotes and a
backfill batch whose candidate selection joins `holding` and `position_set` — exactly the tables a
price-only worker must never read — so a worker that owns the refresh needs those tables, or a
`SECURITY DEFINER` window onto them that leaks first-held dates. Selection of what to fetch, quotes
and backfill alike, stays the app's under any channel.

## The decision

The worker is a second implementation of the provider seam the app already had
(`app/lib/price-provider.server.ts`), not a new privilege granted to something else: the app
keeps every price rule, every price write and the scheduler, and calls the worker exactly as it
called the library before, across a channel rather than a function call.

- **A remote provider.** `server/price-worker.ts` runs `yahoo-finance2` behind an HTTP server; the
  app's `socketProvider()` asks it instead of importing the library. What to fetch stays the app's
  decision; the worker holds no domain rule about what a price means.
- **A unix socket in a tmpfs volume the two containers share.** The named volume `price-worker-sock`
  is mounted at `/run/price-worker` in `app` and in `worker`, and nowhere else. The worker shares no
  PID or IPC namespace with anything, and exactly one network — `worker-proxy`, with `egress-proxy`
  and nothing else on it — so the volume is its only link to the rest of the stack and that network
  is its only way out. Two links, each with one thing on the far side, is the whole topology.
- **HTTP/1.1 over it, the library's raw JSON as the whole contract.** `node:http` on both ends, one
  request per connection; the answer is the library's own `quote()`/`chart()` result, validated on
  read with the same schemas the app already validates Yahoo's answers with. No envelope of its own,
  no second schema to keep in step with the first.
- **The worker holds no database credential and no TCP listener.** No `pg`, no Kysely, nothing under
  `app/lib`; a socket file is reachable only from a process sharing the app's mount namespace, so the
  two things this design has to guarantee — no route from the worker to the database, no route from
  the worker to the app's own screens — hold by construction rather than by a rule to keep.
- **Passwords stop travelling in connection URLs.** `POSTGRES_PASSWORD` loses its default and is
  required to start the stack at all (`compose.yaml:106`); `pg`, libpq and `pg_dump` all read
  `PGPASSWORD` when the URL carries none, and `DATABASE_URL`'s defaults name a user and a host and
  nothing else. A database unreachable from the internet but guessable from its own network was
  isolated in name only.

## Considered options

**The mailbox**, first and at length, because it is the alternative this decision was taken over.
Round-one review put it beside the socket: a Postgres table through which the app writes a request
row and the worker, logged in under a minimal role of its own, claims and answers it. It read "no
listening socket" as "no API at all," and the machinery it needed existed for one purpose — making a
database login safe to hand to the internet-facing container:

- a migration for the request table, its `CHECK`s and a partial index;
- a role, its two grants, a provisioning step run at every boot, and an ACL snapshot test;
- availability hardening the login demanded of the whole cluster — `REVOKE`s on the advisory-lock and
  large-object families, `TEMP` revoked from `PUBLIC`, `temp_file_limit` — and a second test running
  the worker's statements under `SET LOCAL ROLE`;
- a sweep, row deadlines, a claimer with a liveness column and two lanes, and polling on both sides;
- `WORKER_DB_PASSWORD`, a restore-time role bootstrap ahead of `pg_restore`, and `CREATEROLE` on a
  bring-your-own Postgres.

The socket removes the login, and five more things go with it, each of which existed only because
the mailbox had one: **`LISTEN`/`NOTIFY`** — `pg` has no reconnect logic for a dropped `LISTEN` and a
notification is unqueued, so a poll was still needed regardless of it; **RLS**, to keep
first-write-wins honest between two logged-in writers; **a per-operation unreachability handle**, to
remember a claim across polls; **`pg_dumpall --roles-only` in the dump service**, needed only because
the mailbox added a role for the dump to carry forward; and **the heartbeat-file healthcheck**, where
a timestamp on a file proves only that a process last woke up — `GET /healthz` over the socket asks a
listener to answer, which proves more.

Rejected on their own terms, unchanged from that same round of review:

- **A TCP listener on an internal network**, in place of the socket file — reachability on a bridge
  is symmetric, so the same listener that lets `app` reach `worker` lets `worker` reach `app:3000`.
- **A start-up refusal** in the image against `up -d` under a stale `compose.yaml` — it couples the
  app's start to the deployment's shape; the upgrade runbook carries the case instead.
- **IP pinning** on the worker's egress — the five hosts the library contacts resolve to the same two
  addresses as Yahoo's mail and login hosts, so an address is not what tells them apart; the hostname
  the TLS handshake itself names is, and that check is the egress proxy's.
- **A third-party proxy image** for the egress allowlist — Docker has no native egress policy, and an
  unaudited image would add a second supply chain to a slice about supply chains.
- **The worker owning the refresh** — the prior plan's shape, disqualified above rather than costed
  here as merely a worse trade.
- **A separate image now** — the worker and the proxy ship as two more entrypoints on the one image
  `app` and `dump` already build. True decorrelation is the named follow-up below, not a cost this
  slice pays twice.
- **An in-app fallback mode** — a second code path back to the library would keep the import reachable
  from the app and hand the property an off switch.
- **A worker-unresponsive UI state** — the same reasoning as no new UI state below: the distinction is
  the operator's to read, not the household's to be shown.

## Consequences

- **The batch abort becomes a deploy-time event.** A worker that restarts independently of the app
  turns "unreachable at tick time" into `ProviderUnreachable`, which aborts the refresh's backfill
  batch without ledgering it, rather than the per-candidate `provider_failed` row a throw from the
  library got before — a worker back a minute later no longer costs candidates off the retry clock.
- **No new UI state.** The freshness component and the refresh route's outcomes are untouched; the
  dead-worker distinction — a connect failure versus Yahoo failing versus a slow answer — is the
  operator's, read in `docker compose ps` and the worker's own log line, never the household's.
- **One new required variable.** `POSTGRES_PASSWORD` is the only setting this decision adds to those
  a fresh `docker compose up` fails closed without — it joins six that were already there, the gate's
  three, `PUBLIC_ORIGIN`, and the dump sidecar's two. `PRICE_WORKER_SOCKET` keeps a
  development-only default and is not set in deployment.
- **One image, entrypoints either side of which restart independently.** `worker` and `egress-proxy`
  are two more entrypoints on `app`'s own image — three services from one build, `dump` being a
  Postgres image and no relation — and the socket plus the
  library's raw JSON is the whole contract between them: an `up -d` that lands one side of a version
  bump before the other is harmless exactly because nothing but that contract crosses.
- **Worker supply-chain decorrelation is named, not done here.** A worker-only image stage with its
  own `package.json` and a hand-rolled fetch of the two endpoints behind the same Zod schemas would
  stop one npm tree from serving both ends of the socket; spec 0018 §7 opens it as a follow-up.
- **The app is still the superuser.** This slice narrows what a compromised app can reach over the
  network; it does not narrow what the app's own database role can do once connected. Opened by this
  slice, not done in it.
