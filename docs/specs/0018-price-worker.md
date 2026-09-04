# 0018 — The price worker: a remote provider behind one table

> Supersedes the unindexed `docs/specs/0015-price-worker.md` (commits `791ea71` and `4bfe44e`),
> deleted with this spec; §2.3 records why its shape no longer fits. Read
> [ADR-0011](../adr/0011-a-backfill-fills-the-spine-but-never-moves-it.md) first: the worker has
> to serve the refresh that ADR shapes, and that shape is what rules the old plan out. §2.6 is the
> one question the owner has to answer before the triage label goes on.

**Status:** proposed · **Slice directory:** [`price-worker/`](price-worker/) · **ADR:** 0010
(reserved for this slice; unwritten — ticket [08](price-worker/08-documents-and-runbooks.md)
writes it)

---

## 1. Intention

A supply-chain compromise of the app's npm tree — or anything else that comes to run inside the
`app` container — must have no network path out, and the code that does talk to the internet must
be unable to read the household's financial data. Today both are false at once: the process that
fetches prices is the process that holds the family's every balance, it connects as the database
superuser, and nothing stops it opening a socket to anywhere.

The design in one sentence: **the worker is `yahoo-finance2` running in a container with internet
access and one database table; the app keeps every price rule, every price write and the
scheduler, and reaches the worker through that table exactly as it reaches the provider seam
today.** The worker holds no domain logic — transport plus the library — so what crosses the table
is a request the app already knows how to make and an answer it already knows how to read. After
the slice the internet-facing code sees ticker symbols and public prices; the process that sees
the money cannot resolve a hostname.

Six requirements, each made testable below: (1) `app`, `db` and `dump` have no internet route,
enforced by Docker networking and asserted by the smoke test — outbound TCP fails *and* external
name resolution fails; (2) exactly one component fetches prices, the `worker` container — the gate
keeps its Google egress (ADR-0005 untouched) and Caddy the published port; (3) the worker's role
can read what it is asked and write what it answers, and cannot read any account, holding, person,
position set or upload — enforced by grants and pinned by a test that snapshot-asserts the whole
ACL; (4) the worker is not addressable by the app — no listening port, no API, coordination through
rows — taken as stated, with §2.6 surfacing the one alternative that would relax it; (5) the worker
cannot reach `app:3000` (every screen is served unauthenticated behind the gate) or `gate:4180`
(the Google client secret); (6) the superuser password stops having a default, because a minimal
role means nothing while it is guessable.

What the household sees does not change: the cadence at Settings → Prices, quotes only while the
market is open, the bounded backfill batch on every refresh (ADR-0011), **Refresh now** with
JavaScript off included, the USD probe at ingest — a non-USD symbol still refuses with nothing
written, an unavailable one is still created — and the gap list. Nor do the rules the repository is
built on: append-only history, the single-site invariants of ARCHITECTURE.md §4.2, thin routes, Zod
in the domain module only, no enums, money and dates as strings across the driver, tests against
real Postgres.

## 2. Background and context

### 2.1 Threat model

The concern is npm supply-chain compromise: a poisoned package in the production tree, running
with whatever the process has. This app's production tree is 117 packages, 76 of them reachable
only through `yahoo-finance2` (`docs/research/2026-08-23-dependency-audit.md` §1) — the one
dependency that talks to the internet is also the largest share of the surface. The containers are
hardened already (`cap_drop: ALL`, `no-new-privileges`, read-only root, unprivileged uids —
`compose.yaml:22-26`), CI audits signatures (`.github/workflows/ci.yml:66`) and the image prunes
what the library declares but never loads (`Dockerfile:66-67`). What is missing is **egress
control** — every service rides the default bridge with a route out; `compose.yaml` has no
`networks:` key — and **role separation**: the app, the migration runner and the dump sidecar all
connect as `portfolio`, the initdb superuser, whose password defaults to `portfolio`
(`compose.yaml:59`, `.env.example:104`) and travels inside two connection URLs (`:126`, `:204`).

Three adversaries, judged separately throughout, because the guarantees differ for each:

- **A compromised app, honest worker.** After the slice: no socket to anywhere. It can place
  symbol-shaped strings in rows for an honest worker to send to five Yahoo Finance hosts, and relay
  bytes to Google through the gate's OAuth callback (§8). It remains the superuser; that follow-up
  is named in §7, not done here.
- **A compromised worker, honest app.** The price feed's input: it can lie about prices within the
  shape and bounds the app checks (§3.1), read table sizes and column names but no contents, and
  degrade the database's availability within the bounds §3.6 states. Until ticket 07 it has
  unrestricted internet *and* the household LAN.
- **Both, correlated.** One image and one npm tree serve both ends of the table. Bounded after
  ticket 07 to bytes a Yahoo Finance host will accept; removed only by the decorrelation follow-up
  (§7).

### 2.2 What exists today (verified against the tree)

- **One refresh entry point.** `refreshPrices(provider, marketTimeZone, { quotes }, db)`
  (`app/lib/prices.server.ts:666-706`) runs `refreshQuotes` (`:759`) then one bounded backfill
  batch (`backfillCloses`, `:548`); three callers wrap it in `withRefreshLock` (`:120-149`): the
  poller's tick (`app/lib/price-poller.server.ts:127-133`), **Refresh now**
  (`app/routes/refresh.ts:66-68`) and the post-commit request (`requestRefresh`,
  `price-poller.server.ts:245-259`). The root loader starts the poller (`app/root.tsx:67`).
- **Candidate selection reads household tables.** `selectBackfillCandidates` (`:295-336`)
  inner-joins `holding` and `position_set` (`:300-301`) under the shared gap predicate
  (`:253-258`), skips anything attempted within `BACKFILL_RETRY_INTERVAL` (`"1 day"`, `:98`;
  predicate `:306-316`) and takes `BACKFILL_BATCH_SIZE` (`5`, `:87`). A provider throw is ledgered
  `provider_failed` per candidate and the loop continues (`:567-587`).
- **The provider seam.** `PriceProvider` is `getQuotes` and `getDailyCloses`
  (`app/lib/price-provider.server.ts:155-162`). The adapter (`:705`) collapses a `CurrencyRefused`
  into an absent quote (`:719-731`), sends `matchKey(symbol)` with `period1` only (`:748-760`) and
  maps two message stems to `no-history` (`:787-793`). The client takes no options (`:617-624`) —
  no `versionCheck: false`, no signal, no timeout — and the `import("yahoo-finance2")` at `:619`
  is the single site ARCHITECTURE.md §4.2 records (`:338`). Every test fakes the seam.
- **The ingest probe.** `ResolutionDeps.probe` (`app/lib/instrument-resolution.server.ts:212-216`)
  defaults to the live `probeSymbol` (`:20`, `:499`), called serially per created feed symbol
  (`:502-525`); `non-usd` refuses (`:515-524`), `unavailable` creates anyway. The one production
  caller passes no deps (`app/routes/upload/instruments.tsx:104-106`); two route tests call
  `resolveAll` with none (`tests/routes/upload-instruments.test.ts:84`, `:162`), safe only because
  their fixtures are `manual`. `probeSymbol` (`:665-694`) never throws.
- **The deployment.** Five services, no custom networks; only `caddy` publishes a port
  (`compose.yaml:344-345`). The header argues against a worker (`:1-2`) and promises every non-gate
  setting a default (`:20`). The runtime stage copies five named `server/` files
  (`Dockerfile:104-110`); the entrypoint validates, migrates, serves (`docker-entrypoint.sh:11-14`).
  Only `DATABASE_URL` is required (`server/config.ts:35-94`); `getConfig` is the one `process.env`
  read (`:150-153`). `createPool` pins no `max` (`server/db.ts:45-53`); its comment at `:59-61`
  says the poller holds a client across provider network work.
- **Backups.** `pg_dump` runs without `--no-acl` (`scripts/dump-loop.sh:262`); the restore is
  `pg_restore --exit-on-error --single-transaction` (`docs/operating.md:882-883`) after stopping
  only `app`, named as the connection holder (`:894`).
- **Tests and smoke.** `withDatabase` is one rolled-back transaction that `getDb()` resolves to at
  any depth (`tests/support/database.ts:92-115`); one test drives a committing handle because a
  per-attempt boundary cannot be seen from inside a transaction
  (`tests/price-backfill.test.ts:955-1035`); the poller tests patch a real pool
  (`tests/price-poller.test.ts:104`). No test asserts a role, grant or ACL; none exercises
  `app/routes/refresh.ts`. The smoke test hard-codes five service lists
  (`scripts/smoke-test.sh:71`, `:342-350`, `:365-367`, `:379-385`, `:401-403`), expects the first
  missing variable to be the gate's (`:108-116`), and imports `yahoo-finance2` inside `app`
  (`:265-268`).

### 2.3 Why the previous plan's shape no longer fits

`docs/specs/0015-price-worker.md` landed in `791ea71` and gained its six tickets in `4bfe44e`;
neither commit touched `docs/specs/README.md`, so it was never indexed, and its number collided
with `0015-chart-series-assembly.md` (`docs/specs/README.md:43`). It is deleted with this spec.

Its shape was that the worker *owns the refresh*: `refreshQuotes` moves into the sidecar, with a
column-level grant list over `instrument`, `quote`, `price_daily`, `price_observation`,
`price_poll` and `app_setting`. Spec 0017 changed the ground under it: a refresh is now quotes
**and** a backfill batch whose candidate selection joins `holding` and `position_set`
(`prices.server.ts:300-301`) — exactly the tables requirement 3 forbids the worker. A worker that
owns the refresh needs those tables, or a `SECURITY DEFINER` window onto them that leaks first-held
dates; a worker that is only a provider needs one table. That is not a trade, it is a
disqualification, and it decides a question the old spec left open: **selection of what to fetch —
quotes and backfill alike — is the app's, never the worker's.** Issue #202, which asks whether the
poll should stop fetching instruments nobody holds, is the same rule seen from the other side: its
fix reads `holding_valued`, and it stays an app-side decision whatever the owner decides.

The old spec's honesty survives where it was right. Its threat model, its "what no API really
means" and its residuals are the ancestors of §2.1, §2.5 and §8; its residuals were reviewed
against this design one by one, and the ones it dropped or understated are restored here.

### 2.4 Decisions this slice reverses, and the invariants it keeps

Reversed, each edited in place by ticket 08 with the reason beside it:

- `DESIGN.md:826`, the **Job scheduler** row — "In-process, inside the app container. One process
  to deploy, one place to read logs" — and `:913-918`, "The in-process scheduler (§10) is why there
  is no separate worker service." Security was not an input to that trade; it is now the deciding
  one. The scheduler itself stays in-process (§3.1): what moves is the fetch.
- `compose.yaml:1-2`, "no worker for it: two images, two deployments, two logs", and `:20`, which
  promises every non-gate setting a default. After this slice two more variables have none.
- `README.md:594-595`, "there is no worker container, which DESIGN.md §10 chose deliberately", and
  the poller's header (`app/lib/price-poller.server.ts:2-6`), which restates §10's choice.
- ADR-0011's "In-process … nothing is shaped for spec 0015's worker" (`docs/adr/0011-…md:55-56`)
  and its rejected option "Mailbox-shaped, for the worker" (`:74-77`) — reversed exactly as it
  foresaw at `:115-116` ("Spec 0015, if built, inherits a second call to move"), and as spec 0017
  said at `docs/specs/0017-price-backfill.md:366-368`.

Preserved, and asserted by the tests this slice adds:

- **The single sites of ARCHITECTURE.md §4.2.** Pool construction stays `server/db.ts:createPool`
  (the worker uses it). The `yahoo-finance2` import moves once, to `server/yahoo-client.ts`, and
  at every commit there is exactly one importer (§3.5). The price writer stays
  `app/lib/prices.server.ts`, untouched in what it writes. `server/config.ts` stays the only
  reader of `process.env`; the driver reading its own `PGPASSWORD` is stated, not smuggled.
- **History is append-only.** The mailbox is scaffolding — the `upload_draft` precedent — not
  history: rows are swept by the app, and nothing the worker can do touches `price_observation`,
  `position_set` or any ledger.
- **ADR-0005.** The gate keeps its Google egress and nothing about authentication changes.

### 2.5 What "no API" really means

A table is a channel, and it is honest to say what kind. The app→worker surface is three columns
and an id: `kind`, a `text[]` of symbols, a `date`. The worker→app surface is one `jsonb` document
the app validates on read with the Zod schemas it validates Yahoo's own answers with today.

For a **compromised app** the property is real and narrow: no socket; it can place symbol-shaped
strings in rows, and an honest worker sends only those, only to Yahoo Finance hosts, only at the
honest app's request rate (one quotes call per refresh, at most five histories, one probe per
ingest submission). The CHECK binds honest code and a non-owner worker, not the superuser app,
which can drop any constraint; the check that binds here is the worker's own re-validation of every
symbol before it touches a URL (§3.5). What remains is about a hundred bits per symbol slot,
readable by Yahoo or an on-path observer, plus the gate's OAuth callback (§8).

For a **compromised worker** the table is the price feed's input, which the app treats as it treats
Yahoo: shape-checked, currency-guarded, bounded above, and — new here — unable to rewrite a close
older than a week through the quote path (§3.1). Truth is unverifiable; §8 says what a lying feed
can still do.

For **both**, the CHECK and the pattern are compromised code's to ignore, and until ticket 07 the
worker's egress bridge reaches everything. Ticket 07 is therefore *required*: with it the worker has
no resolver at all and can send bytes only to five named hosts through a proxy whose closure is
`node:http` and `node:net` — a payload that is never imported never runs, so the proxy is the one
piece of the shared image the npm tree cannot reach.

### 2.6 The owner's decision

Round-one review proposed an alternative that meets requirements 1, 2, 5 and 6, meets the strongest
reading of 3, and breaks the letter of 4: **a unix socket on a shared tmpfs volume.** Both
containers mount one small tmpfs; the worker listens on a socket file; the app's provider calls it
with `fetch` over the socket under `AbortSignal.timeout`; the worker holds **no database credential
at all**. No TCP port, no shared network, so requirement 5 holds by construction.

What it removes from this spec: migration 0012, the role, the grants, the availability hardening
of §3.6 (which exists only because the worker holds a credential), the provisioning step, both role
tests, the sweep, the deadlines, the polling on both sides, and `WORKER_DB_PASSWORD` — roughly half
of tickets 02–05. What replaces them: `ECONNREFUSED`/`ENOENT` *is* "worker dead", the timeout *is*
"provider slow", and the healthcheck is one request over the socket.

What it costs: the worker becomes addressable by the app, and its input surface is `node:http`'s
request parser rather than three typed columns — the same trust direction as the mailbox (the
worker parses the app's request either way; the app parses the worker's JSON through Zod either
way), and a real relaxation of "no listening socket, no API". It also assumes both containers share
a host, which compose already does.

This spec is written to requirement 4 as stated. ADR-0010 records the socket as the alternative
rejected on that requirement alone, with the ticket delta above, so that a single decision reverses
it. **The question for the owner is whether the purpose behind requirement 4 was "no port, no API"
or "the worker cannot reach the app and the app cannot be tricked into reaching the internet through
it" — the socket meets the second with less.**

## 3. Design

### 3.1 The seam

`PriceProvider` (`app/lib/price-provider.server.ts:155-162`) is already injected into
`refreshPrices`, `refreshQuotes`, `backfillCloses` and the poller, and every test fakes it. The
app-side half of this slice is one more implementation, `mailboxProvider(handle)`, that asks the
worker instead of the library. Untouched: `refreshQuotes`, every price write, ADR-0011's rules,
`withRefreshLock`, `price_poll` and the observation log — nothing the worker can do reaches them
except through the seam.

Three deliberate touches to the rules, each stated here because "untouched" would otherwise be a
lie. Two harden the app against a hostile provider, which the seam now has to assume:

- **A price ceiling in `toProviderQuote`.** Yield and rate are bounded today (`:200-231`) and
  history closes are (`CLOSE_CEILING`, `:219`); `price` is not. A quoted `1e15` fits
  `numeric(20, 4)`, commits, and overflows `holding_valued`'s `cast(h.quantity * q.price as
  numeric(20, 4))` (`migrations/0006_annual_dividend.sql:149`) in the *reader* — the migration's
  own header (`:53-61`) says what follows: every screen throws on every request, and the position
  editor is behind one of them. Dropped, not clamped, so the symbol comes back "not in the answer"
  and goes stale — `inRange`'s reasoning (`:231`).
- **The quote path refuses to write a `price_daily` close whose market date is more than seven
  days before today's.** `writeDailyClose` upserts `do update set close` on `(instrument_id,
  date)` (`prices.server.ts:944-947`) keyed by `regularMarketTime`, so a hostile quote rewrites any
  past day's close; ADR-0011's immutability covers only the backfill writer. The quote and the
  observation still land — the observation is the archive and the quote is the current answer —
  and the day is left to the backfill, which is ledgered and split-aware. Seven, because that is
  the window an honest NAV or a holiday quote can lag by, and because it is `BACKFILL_RANGE_LEAD_DAYS`
  (`:106`) — a week clears the longest run of non-trading days.

One serves the ledger: **`backfillCloses` aborts the batch without ledgering when the provider
was unreachable.** Today a throw from `getDailyCloses` is ledgered `provider_failed` and the loop
continues (`:567-587`), after which the retry clock (`:98`, `:306-316`) skips the instrument for a
day. With a worker that restarts independently of the app, "unreachable at tick time" becomes a
deploy-time event, and ledgering it would defer up to five candidates a day for a worker that was
back a minute later. A named `ProviderUnreachable` (§3.4) is rethrown as a batch abort through the
existing `BackfillBatchFailed` (`:501-509`); the composition's catch (`:684-703`) logs it with the
cause and the ledger holds nothing for that tick.

### 3.2 The mailbox: `provider_call` (migration `0012_provider_call.sql`)

One row per library call — one `quote()` or one `chart()` — not one per symbol and not one per
refresh. Per-symbol rows would make the worker split Yahoo's batched answer by symbol, which is
`matchKey`'s job in the app (`prices.server.ts:733`, applied at `:805-809`) and the one rule the
worker must not hold; per-refresh coalescing is a vestige of the old shape, because the app already
serialises refreshes under `withRefreshLock` and the only concurrent requests are probes.

```sql
create function symbols_wellformed(symbols text[]) returns boolean
  language sql immutable strict
  as $$ select bool_and(s ~ '^[A-Za-z0-9.^=-]{1,15}$') from unnest(symbols) as s $$;

create table provider_call (
  id            bigint generated always as identity primary key,
  kind          text not null check (kind in ('quotes', 'history')),
  symbols       text[] not null
                check (cardinality(symbols) between 1 and 100 and symbols_wellformed(symbols)),
  range_from    date check ((kind = 'history') = (range_from is not null)),
  requested_at  timestamptz not null default now(),
  deadline_at   timestamptz not null,   -- the requester's budget; never claimed past it
  claimed_at    timestamptz,            -- set by the worker's claimer: the liveness signal
  answered_at   timestamptz,
  outcome       text check (outcome in ('ok', 'failed')),
  payload       jsonb check (pg_column_size(payload) <= 2097152),
  error         text check (length(error) <= 1000),
  check (kind = 'quotes' or cardinality(symbols) = 1)   -- history: exactly one symbol
);

create index provider_call_pending on provider_call (requested_at)
  where claimed_at is null and answered_at is null;
```

The pattern is Yahoo's own symbol alphabet — dots, carets, dashes, `=X` currency pairs — and
excludes everything a URL path or query could abuse. `symbols_wellformed` is an `immutable` SQL
function because a CHECK cannot take a subquery; it runs under PUBLIC `EXECUTE`, which the ACL
snapshot lists as expected (§3.6). The honest statement about every CHECK here: the app is a
superuser and can drop any of them; they bind honest app code and a *non-owner* worker, whose
`UPDATE`s re-evaluate them. The check that binds in the compromised-app case is the worker's own
(§3.5). The two size bounds — two megabytes of payload, a thousand characters of error — are what
keeps a hostile worker from filling the disk one answer at a time; a ten-year chart answer is
around 300 KB.

`payload` is the library's raw answer serialised as JSON — the array `quote()` returns, the object
`chart()` returns. The app validates it on read with the schemas it has today: `yahooQuote`
(`price-provider.server.ts:244-272`) through `toProviderQuote` (`:320`), `yahooChart`
(`:400-410`) through `toProviderHistory` (`:483`). Both already accept ISO strings for every
instant — `regularMarketTime` is `z.union([z.date(), z.number(), z.string()])` (`:249`) and every
bar and split goes through `parseInstant` (`:298-310`) — so a `Date` that became a string in
`jsonb` parses unchanged. No schema change; one end-to-end round-trip test is the pin.

Scaffolding, not history (`upload_draft` is the precedent): the app sweeps answered rows older than
an hour and any row an hour past its deadline, before each insert. The worker never inserts and
never deletes. `provider_call` has no foreign keys, so a test's cleanup is one delete by id.

### 3.3 The app side: `app/lib/provider-mailbox.server.ts`

One primitive, `ask(kind, symbols, rangeFrom)`, per **handle** — the object carrying one
operation's state. `ask` sweeps and inserts in one short transaction under `set local lock_timeout`
(a hostile worker holding `FOR UPDATE` on unanswered rows — it needs only the column `UPDATE` it
has — must not hang the app inside the refresh lock), computes `deadline_at` on the app's clock,
then polls its own row every 100 ms through the same `getDb()` every read uses:

- `claimed_at` still null after a **3 s grace**: throw `ProviderUnreachable` ("no worker claimed
  the request within 3 s") and flip the handle, so every later `ask` on it throws at once — a
  refresh against a dead worker costs one grace, not one per backfill candidate.
- Claimed but unanswered at the deadline: throw a plain error saying so — the worker is alive and
  the provider slow, which is what Yahoo timing out looks like today; `refreshQuotes` turns any
  throw into `providerFailed` (`prices.server.ts:792-800`).
- A `failed` row: throw the library's error text, so the ledger records what Yahoo said.

Budgets are per call, by kind — **quotes 15 s, history 30 s** (the worker's watchdog), **probe
5 s** — and the handle carries the unreachability flag across them. Symbols are checked against the
pattern *before* the insert: the CHECK would otherwise refuse a whole call over one stored symbol
the app's own rule permits (length ≤ 40, any character, `instrument-resolution.server.ts:308-312`).
An offender is dropped with a log line naming it, comes back absent, and goes stale — the residual
§8 states. A call of more than a hundred symbols is split at the CHECK's bound into consecutive asks.

`mailboxProvider(handle): PriceProvider` — `getQuotes(symbols)` is `ask("quotes", symbols)`, then
each payload entry through `toProviderQuote`, skipping `CurrencyRefused` exactly as the adapter
does (`:719-731`); a payload that is not an array is an empty answer, `probeSymbol`'s rule
(`:677`). `getDailyCloses(symbol, range, tz)` is `ask("history", [matchKey(symbol)], range.from)`
— the adapter applies `matchKey` at `:756` and sends `period1` only (`:748-755`), both app-side
because the worker must not import `app/lib`; a `failed` row whose error matches
`isMissingHistory`'s stems (`:787-793`, made exportable) is `no-history`; an `ok` row goes
through `toProviderHistory(payload, range, tz)`, which applies `until` app-side (`:541`), so there
is no `range_until` column.

`mailboxProbe(handle): ProbeSymbols` is built on `ask`, **not** on `getQuotes`, which cannot say
`non-usd`: one `ask("quotes", symbols)` for the whole batch, then `probeSymbol`'s body
(`:665-694`) per symbol — `CurrencyRefused` is `non-usd`, absent is `unavailable`, any throw is
`unavailable` for every symbol. One handle per ingest request: six new symbols against a dead
worker cost one 5 s budget, not six.

Handles are per operation — `runRefresh` makes one per refresh, the ingest action one per request.
The existing `Price provider failed` stem (`prices.server.ts:796`) now carries "no worker
claimed…" for a dead worker, distinct from Yahoo failing. The route keeps its three outcomes
(`app/routes/refresh.ts:21-33`): `providerFailed` is true from the app's viewpoint either way, and
the distinction is the operator's — `docker compose ps` and the worker's log — not a fourth
sentence in `app/components/price-freshness.tsx:74-102`. A JS-off press against an alive-but-slow
worker can block for the sum of the budgets, 15 s plus five times 30 s; today it is unbounded.

### 3.4 The prefactor (ticket 01, on the existing Yahoo adapter)

Make the change easy before making it. Every piece below typechecks and tests against
`yahooPriceProvider()` as it stands, so the cutover (ticket 05) becomes "swap the provider, delete
the client use, move the client-facing tests".

- **(a) `runRefresh({ quotes }, makeProvider)` in a new domain module, `app/lib/refresh.server.ts`,**
  holds the lock, builds one provider per refresh from the factory, runs `refreshPrices`, and maps
  the result to the outcome the control renders. The route (`app/routes/refresh.ts:58-86`), the
  poller's tick (`price-poller.server.ts:127-133`) and `requestRefresh()` (`:245-259`) become thin
  callers — issue #159's ask, and it fixes the one `lib → routes` import in the tree
  (`app/components/price-freshness.tsx:16`) by moving `RefreshOutcome` into the domain. The
  market-hours gate and the cadence stay the poller's, as #159 requires.
- **(b) `PollerState.provider` becomes a factory called per tick.** Today one instance lives for
  the process (`price-poller.server.ts:59-72`, defaulted at `:193`); a per-handle unreachability
  flag on it would flip once and never recover — a five-minute worker outage would become a
  permanent one until the container restarted. `startPricePoller(() => fake)` in the tests.
- **(c) `ResolutionDeps.probe` becomes required and batched:** `probe(symbols) → Promise<Map<string,
  SymbolProbe>>` over one library call. The loop at `instrument-resolution.server.ts:502-525`
  probes serially, and under the mailbox each call would be a round trip — issue #205's first
  item. The default import (`:20`) and `?? probeSymbol` (`:499`) go; the verdict logic — parse each
  entry, `CurrencyRefused` is `non-usd`, absent is `unavailable`, never throw — becomes a pure
  exported function so the Yahoo batch probe now and the mailbox probe later share it;
  `app/routes/upload/instruments.tsx:104-106` passes the Yahoo batch probe for now;
  `tests/routes/upload-instruments.test.ts:84` and `:162` get a stub.
- **(d) `ProviderUnreachable`** is defined beside `PriceProvider`; `backfillCloses` rethrows it as
  a batch abort with nothing ledgered (§3.1); the Yahoo adapter never throws it.
- **(e)** The two hardening rules of §3.1.

Tests: the seams, the ceiling, the seven-day rule, the abort without a ledger row.

### 3.5 The worker: `server/price-worker.ts` (ticket 03)

Same image, overridden entrypoint — the `dump` precedent (`compose.yaml:144-145`); an
`entrypoint:` also drops the image `CMD`, so neither `docker-entrypoint.sh`'s migration nor
`react-router-serve` runs as the worker. Its closure: `server/config.ts` (only `DATABASE_URL`
required), `server/db.ts` (`createPool` gains an options argument to pin `max` — 3 for the worker —
the same edit issue #208 needs for its statement bound), `server/yahoo-client.ts`,
`server/symbol-pattern.ts`, `pg`, `zod`, `yahoo-finance2`. No Kysely, no `app/lib`: the
react-router edge at `app/lib/settings.server.ts:27` → `app/lib/masking.ts:14` is never reached,
so the old spec's masking-policy ticket has no reason to exist.

**`server/yahoo-client.ts`**, new, used by the app's adapter from this ticket until the cutover so
there is one client site at every commit: `new YahooFinance({ versionCheck: false })` — the
default is `true` and fetches `registry.npmjs.org` from the validation-failure path
(`esm/src/lib/options/defaults.js:25`, `esm/src/lib/versions.js:6` in 4.0.2); the library's own
result validation off, so one drifted field cannot fail a whole `quote()` when the app validates
with its own schemas (builder verifies the option name in the pinned source; `moduleCommon.d.ts`
declares a per-call `validateResult`); and `quote(symbols)` and `chart(symbol, { period1,
interval: "1d", events: "split" })` each under `fetchOptions.signal = AbortSignal.timeout(min(30 s,
deadline − now))` as the third module-options argument, which the library forwards to `fetch`
unvalidated and which covers the crumb handshake — the bound issue #205 asks for, extended to
`chart`, so the app's own Yahoo calls are bounded at 30 s from this ticket on. The client imports
nothing from `app/lib` (`matchKey` would pull Kysely in); `ChartRequest`
(`price-provider.server.ts:589-598`) moves with it.

**The loop.** A claimer every 250 ms:

```sql
update provider_call set claimed_at = now()
 where id in (select id from provider_call
               where claimed_at is null and answered_at is null and deadline_at > now()
               order by requested_at limit 50)
returning id, kind, symbols, range_from, deadline_at
```

feeds two in-process lanes, quotes and history, each making its calls one at a time, so
`claimed_at` is a true liveness signal and a probe never waits behind a chart call. The
`UPDATE … RETURNING` is atomic under read committed — a second worker's re-evaluated `WHERE` sees
the row claimed and returns nothing — so there is no `FOR UPDATE SKIP LOCKED`. A claimed row whose
deadline passes before its call starts is answered `failed` / `expired` without a fetch, which also
bounds a burst after an outage. The answer is `update … set answered_at = now(), outcome, payload,
error where id = $1 and answered_at is null` — first write wins. No lease, no reclaim: a row nobody
answers is abandoned at its deadline by the requester and swept later. Every symbol is re-validated
against the pattern before any URL — the binding check of §2.5 — from `server/symbol-pattern.ts`,
a module with no imports the app shares from ticket 05; the migration's SQL function restates the
pattern, a deliberate duplication named in both places.

**Startup** is `select 1 from provider_call limit 0`, retried with backoff forever: no ledger
check, no migration. Under `restart: unless-stopped` a daemon restart ignores `depends_on`, and an
authentication failure or `NOLOGIN` refusal (provisioning not yet run) is retryable, not fatal — a
naive "auth failure is fatal" crash-loops in a way that reads like a wrong password.

**Health** is a heartbeat file in tmpfs, touched after every successful claim poll, empty ones
included; the healthcheck asserts its age is under 60 s with busybox `stat -c %Y`, which
`node:24-alpine` carries. No database session, no port, no provider reachability —
`app/routes/healthz.ts:9`'s reason. Nothing restarts an unhealthy container
(`docs/operating.md:710`); the check is for `docker compose ps` and `depends_on`, and "unhealthy"
means the loop has not completed a poll in a minute — never "Yahoo is failing".

The statements are exported as `{ text, values }` so the role test runs the real ones
(`CompiledQuery.raw(text, values)` on the test's transaction, kysely 0.29.5); an `import.meta.main`
guard (Node ≥ 24.2 — `true` for the entry file, `false` when imported) keeps the loop from starting
on import so vitest can import `drainOnce`. Logs: one line per failed drain, stem `Price worker`,
naming the row ids and the cause.

**Tests** run on a committing handle (`tests/price-backfill.test.ts:955-1035` is the precedent):
`withDatabase`'s rolled-back transaction is invisible to the worker's own connection. Claim order
and the cap; expired rows answered `failed`; watchdog expiry answered `failed`; a pattern violation
answered `failed` with no call; first write wins. The client-facing tests in
`tests/price-provider.test.ts` — the probe's client half (`:291`), the chart request shape (`:704`)
and the library's shape (`:788-818`) — move here with the client.

### 3.6 The role: `portfolio_worker` (ticket 02)

Created in migration 0012 inside an idempotent `DO` block — roles are cluster-global and a bare
`CREATE ROLE` errors on re-run; role DDL is transactional, so the runner's per-file transaction
covers it — that raises a clear hint when the migrating role lacks `CREATEROLE`: bring-your-own
Postgres is promised only "can create tables" (`docs/operating.md:194`), and the docs gain the
requirement. `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 5`, the limit above the
pinned pool `max` plus reconnect churn — defence in depth, never the boundary. The grants, complete:

```sql
grant select on provider_call to portfolio_worker;
grant update (claimed_at, answered_at, outcome, payload, error) on provider_call to portfolio_worker;
```

Postgres is default-deny, so that is the whole of what the worker may do. `symbols_wellformed` and
`pg_column_size` run inside the CHECKs on its `UPDATE`s under PUBLIC `EXECUTE` — expected, and in
the snapshot. Nothing on `instrument`, `quote`, `price_daily`, `price_observation`, `app_setting`
or `schema_migrations`: the worker reads no setting and writes no price. The identity column needs
no sequence grant (an identity default bypasses the sequence ACL, unlike `serial`).

**Availability hardening**, because a role that can read nothing can still take the database down;
each item was exercised against Postgres 17 during review. `revoke temporary on database … from
portfolio_worker` (a `TEMP` table over `generate_series` is a disk fill); `alter role
portfolio_worker set temp_file_limit = '64MB'` (`SUSET`, so the role cannot clear it); `revoke
execute` from PUBLIC on the `pg_advisory_*` family — a bare role can take `7295380114023642` and
freeze every refresh silently (`withRefreshLock` returns `null` with no log line), or
`7295380114023641` and hang the migration runner at `server/migrations.ts:105` forever, so the next
`app` restart never becomes healthy and `caddy` never starts; superusers are unaffected, and a
future non-superuser app role would need a grant — and on the large-object creation functions;
plus the two size CHECKs of §3.2. These need a superuser, which the bundled `portfolio` is, so they
run in a `DO` block that skips with a notice naming what it skipped when the migrating role is not
one. Residual, stated: CPU and memory per statement are unbounded (`work_mem`, `statement_timeout`
are `USERSET`); row counts and column names are readable by any role; the worker may attempt
`portfolio` logins unthrottled (`pg_hba` is `scram-sha-256` for the network), which is why
generated passwords (`openssl rand -hex 32`) are mandated in the runbook rather than suggested.

**The ACL test** enumerates every relation and routine in `public` with the `has_*_privilege`
functions and asserts the exact allowlist — never `information_schema.role_*_grants`, which omit
what is granted to PUBLIC, the leak class the test exists to catch. `has_column_privilege` is
necessary, not optional: the table-level `UPDATE` probe answers *false* while only column grants
exist, so a table-level snapshot would never notice a widened column grant. Also asserted: no
`SECURITY DEFINER` function in `public`; `holding_valued` denied — a view runs with its owner's
privileges, the superuser's, so one grant on it would hand over every account, person and holding
with no table grant to show for it; `holding_valued_at(d)` executable yet failing on `account`
(`SECURITY INVOKER` reads the base tables); no row in `pg_auth_members`; the role attributes; and
`temp_file_limit` read from `pg_db_role_setting`, since `SET ROLE` does not apply a role's
settings. A second test runs the worker's real statements under `SET LOCAL ROLE portfolio_worker`
inside `withDatabase` — never `SET ROLE` on a pooled client: `pg` issues no `RESET` on release and
the role would leak into the next checkout — each denied probe under a savepoint, because a denial
aborts the transaction (`tests/refresh-quotes.test.ts:774-778`).

**The credential.** `server/provision-worker-role.ts` is an entrypoint step after `migrate.ts`
that runs at every boot as `portfolio`: create the role if missing — a per-database dump carries
ACLs naming a role a fresh cluster lacks, and the rebuild runbook's `pg_restore --exit-on-error
--single-transaction` (`docs/operating.md:882-883`) would roll back the whole restore on the first
`GRANT`; `alter role … login password …` when `WORKER_DB_PASSWORD` is set, quoted with
`client.escapeLiteral` because DDL takes no `$1`; and re-apply the hardening, since database-level
ACLs and role settings are not in a per-database dump either. `WORKER_DB_PASSWORD` is optional in
`configSchema` (so `server/config.ts` stays the only env reader) and sits in the `app` service's
environment — it adds nothing to a compromised app, already the superuser that created the role;
provisioning on every boot is what makes rotation a `.env` edit.

**Passwords stop travelling in URLs.** Compose sets `PGPASSWORD` per service and the three
`DATABASE_URL` defaults carry user and host only: `pg` 8.23 and libpq read `PGPASSWORD` when the
URL has no password (verified live in review), and `config.ts`'s URL check accepts the form. A URL
password still wins over the variable, so `.env.example:23`'s explicit URL line is removed and the
upgrade runbook says "drop your `DATABASE_URL` line" — a stale `.env` would otherwise crash-loop
with `password authentication failed` after doing everything the runbook said. No password
alphabet, no validation code. ARCHITECTURE.md §4.2's env-reader row (`:345`) gains the sentence
that the driver reads its own `PGPASSWORD`.

### 3.7 Topology (tickets 04 and 06)

```yaml
networks:
  backend:    { internal: true, driver_opts: { com.docker.network.bridge.gateway_mode_ipv4: isolated } }
  worker-db:  { internal: true, driver_opts: { com.docker.network.bridge.gateway_mode_ipv4: isolated } }
  caddy-app:  { internal: true, driver_opts: { com.docker.network.bridge.gateway_mode_ipv4: isolated } }
  caddy-gate: { internal: true, driver_opts: { com.docker.network.bridge.gateway_mode_ipv4: isolated } }
  egress-worker: {}    # after ticket 07: internal + isolated, shared with the proxy only
  egress-gate: {}
  ingress: {}

services:
  db:     { networks: [backend, worker-db] }
  dump:   { networks: [backend] }
  app:    { networks: [backend, caddy-app] }          # no route out
  worker: { networks: [worker-db, egress-worker] }    # sees Postgres and the internet, nothing else
  gate:   { networks: [caddy-gate, egress-gate] }
  caddy:  { networks: [caddy-app, caddy-gate, ingress] }
```

`internal: true` removes the default route and drops forwarded traffic to and from other networks;
a per-service `networks:` list detaches the service from the implicit `default` bridge.
`gateway_mode_ipv4: isolated` closes the escape an internal bridge otherwise keeps — an address on
the host, through which a container reaches every host service bound on `0.0.0.0`: a house-wide
reverse proxy, SSH, a resolver on `:53`. **Engine floor 28.0, hard:** 26 has no such option and its
label parser has no default branch, so the option is *silently ignored* and the hole stays open
with every other assertion passing; 27 refuses it loudly. The compose header and `operating.md`
name the floor and the check (`docker info --format '{{.ServerVersion}}'`). IPv6 is not enabled on
these networks, stated rather than left to a daemon-wide default.

`caddy-app` and `caddy-gate` are kept apart so that `compose.yaml:257-260`'s invariant — the
sidecar believes `X-Forwarded-*` from whatever reaches it, so "only Caddy can" has to hold — becomes
true for the container the slice distrusts most; on today's default bridge `app` reaches
`gate:4180` directly. `worker` shares no network with `app` or `gate` — requirement 5 by
construction, asserted by name *and by IP*: a name failure proves only DNS scoping, and Engine 28's
block on direct routed access to unpublished ports is what the IP test proves.

What isolation does not give: any container with a route to the host reaches the host's
*published* ports, so until ticket 07 the worker reaches Caddy's `:80` through its egress bridge —
the app *through the gate*, never `app:3000` or `gate:4180`. The gate's OAuth callback relays
attacker-chosen bytes to Google from `caddy:8080/oauth2/callback`; the old spec named it and §8
keeps it. After ticket 07 the worker has no non-internal network and that route closes for it too.

Smoke asserts effects, not flags: from `app` and `db`, `fetch` to a public host fails, `timeout 5
nslookup example.com` fails (an external lookup from an internal-only container ends in `SERVFAIL`,
possibly slowly), and a TCP connect to the internal network's IPAM gateway address on `:80` fails;
from the worker, `app` and `gate` are unreachable by name and by IP, `db:5432` connects, and until
ticket 07 a public host resolves. `depends_on: condition: service_healthy` is evaluated by the
Compose CLI over the Docker API, so it needs no shared network. External-Postgres installs keep the
worker, the role and the mailbox but not the internal-network guarantee; ticket 08 states the
override.

### 3.8 The egress allowlist (ticket 07, required)

It is what makes "Yahoo Finance and nothing else" true, and until it lands the worker's egress
bridge also reaches the household LAN — the NAS, the router's admin page, the devices the gate
exists to distrust. `server/egress-proxy.ts` is about eighty lines of `node:http` plus `node:net`:
`CONNECT` only, to exactly the hosts the pinned library contacts — `query1.finance.yahoo.com`,
`query2.finance.yahoo.com`, `finance.yahoo.com`, `guce.yahoo.com`, `consent.yahoo.com` — and not
`*.yahoo.com`, because a mail or login host inside a `CONNECT` tunnel is a full exfiltration
channel. `fc.yahoo.com`, which older plans named, is not in 4.0.2. The list is a module constant:
it is a fact about the library version the image ships, not operator configuration, so the proxy
reads no environment and the env-reader invariant is untouched; when Yahoo moves a consent host the
proxy log names the refused `CONNECT`, quotes fail, `chart()` — which needs no crumb — keeps
working, and the fix is a release.

Same image, another entrypoint, node built-ins only: its closure is decorrelated from the npm tree.
Compose: `egress-worker` becomes internal and isolated (worker, proxy); the proxy alone sits on a
plain bridge; the worker sets `NODE_USE_ENV_PROXY=1` and `HTTPS_PROXY=http://egress-proxy:8888` —
Node 24's `fetch` honours it, and the library uses global `fetch`. The binding property is the
network, not the environment flag, which compromised code ignores: smoke stops the proxy and asserts
the worker's fetch then fails, and asserts a non-allowlisted host is refused through it. With no
non-internal network the worker also has no resolver: hostnames travel inside `CONNECT` and the
proxy resolves them, so DNS exfiltration from the worker is gone. Docker has no native egress
policy; a third-party proxy image would add an unaudited supply chain to a slice about supply chains.

### 3.9 Image, development, tests

One image, a second and a third entrypoint — the `dump` precedent, and an owner-accepted trade.
The prune script walks *declared* dependencies from `package.json` and can never remove
`yahoo-finance2` while it is declared (`scripts/prune-unreachable-deps.mjs`'s own header: "cannot
remove a package anything still reachable declares"), so there is no prune change and the smoke
kept-list stays valid. The named follow-up, not done here: a worker-only stage pruned to the
worker's closure. The runtime stage copies `server/` files by name (`Dockerfile:104-110`), so the
worker, the client, the pattern module, the proxy and the provisioning step are each added
explicitly — an omission dies on first import in production and only the smoke test would notice.

Development: `npm run dev` is unchanged; a second terminal runs
`node --env-file=.env.worker ./server/price-worker.ts` as the worker role, with `.env.worker`
naming `portfolio_worker` and carrying `PGPASSWORD`, after running `provision-worker-role.ts` once
against the local database with `WORKER_DB_PASSWORD` set — development exercises the same
privilege boundary as production, never the superuser (`docs/developing.md:56-60`'s `.env` is the
superuser). Without a worker: stored prices, a refresh that logs "no worker claimed", ingest probes
`unavailable` after one 5 s budget with the instruments created anyway. **No in-process fallback
mode** — a second code path would keep the Yahoo import reachable from the app and give the
property an off switch.

Tests: app-side tests simulate the worker inside the same `withDatabase` transaction — a helper
answers the pending row through the test's own handle while `ask` polls, so the answer is visible
and nothing commits. Worker tests and the end-to-end JSON round trip — `mailboxProvider`, a real
drain and a fake client, through `refreshPrices`, writing a quote and a close — run on a committing
handle. One trap for both: `now()` is frozen at transaction start inside `withDatabase`, so a row
meant to be "an hour past its deadline" sets `deadline_at` explicitly.

## 4. Tickets

One ticket is one pull request that typechecks, builds and tests standing alone, and every one
leaves a deployable main: after 04 the worker runs beside the still-fetching app with the advisory
lock arbitrating the two, 05 is the single release where the app stops fetching, and 06 the one
where it loses its route. There is no commit from which a deploy has no price refresh.

| # | Ticket | Blocked by |
|---|---|---|
| [01](price-worker/01-prefactor-the-refresh-and-probe-seams.md) | The prefactor on the Yahoo adapter: `runRefresh` with three thin callers, the poller's provider factory, the required batched probe, `ProviderUnreachable` and the batch abort, the price ceiling and the seven-day rule (§3.1, §3.4) | Nothing |
| [02](price-worker/02-the-mailbox-and-the-worker-role.md) | Migration `0012_provider_call.sql`: the mailbox, the role, its grants and hardening; the provisioning step; `WORKER_DB_PASSWORD` in `configSchema`; the regenerated types; the ACL snapshot and `SET LOCAL ROLE` tests (§3.2, §3.6) | Nothing |
| [03](price-worker/03-the-price-worker-process.md) | `server/yahoo-client.ts` (the app's adapter uses it from here), `server/symbol-pattern.ts`, `server/price-worker.ts` and its tests; the Dockerfile copy set; ARCHITECTURE.md §4.2's import-site row (§3.5) | 02 |
| [04](price-worker/04-deploy-the-worker-alongside.md) | Deploy alongside: the `worker` service, its two networks, `db` on `worker-db`, the dev override, `.env.example` and the upgrade note, smoke (§3.7) | 03 |
| [05](price-worker/05-the-app-cutover.md) | App cutover: `provider-mailbox.server.ts`; poller, route and ingest on the mailbox; the adapter loses its client; round-trip, route and probe tests (§3.3) | 01, 04 |
| [06](price-worker/06-the-network-lockdown.md) | Lockdown: the full topology and the engine floor, `POSTGRES_PASSWORD` required, `PGPASSWORD` everywhere, the upgrade runbook, smoke egress and DNS assertions (§3.6, §3.7) | 05 |
| [07](price-worker/07-the-egress-allowlist.md) | The egress allowlist proxy (§3.8) | 06 |
| [08](price-worker/08-documents-and-runbooks.md) | The record: DESIGN.md, ARCHITECTURE.md, ADR-0010, CONTEXT.md, the runbooks (§6) | 07 |

01 ∥ 02; 03 → 04 → 05 (needs 01) → 06 → 07 → 08.

## 5. Acceptance (slice level)

- From `app` and `db`: an outbound `fetch` to a public host fails; `timeout 5 nslookup example.com`
  fails; a TCP connect to the internal network's gateway address on `:80` fails. From `worker`:
  `app:3000` and `gate:4180` are unreachable by name and by IP; `db:5432` connects; a public host
  resolves until ticket 07, and after it the worker's fetch fails with the proxy stopped and a
  non-allowlisted host is refused through it.
- The worker container reaches its claimer loop *in the built image*: its heartbeat healthcheck
  reports healthy under `docker compose ps`.
- **Refresh now** round-trips through the mailbox on every screen that carries it, JavaScript off
  included (blocks, then redirects). Against a dead worker it reports `providerFailed`, the log
  carries the "no worker claimed" text, the press costs one 3 s grace, and `price_backfill` gains
  no row.
- At ingest a non-USD symbol still refuses with nothing written, an unavailable one is still created
  anyway, and a dead worker costs one 5 s budget per submission, not one per symbol.
- The ACL snapshot fails the suite by name when any grant to `portfolio_worker` widens, when
  `holding_valued` is granted, when a `SECURITY DEFINER` function appears in `public`, or when an
  advisory-lock function regains PUBLIC `EXECUTE`; the worker's real statements pass under
  `SET LOCAL ROLE portfolio_worker`.
- A quoted price of `1e15` is dropped and the instrument goes stale; a quote whose market date is
  eight days old rewrites no close and inserts none, while one seven days old does.
- A fresh `docker compose up` with `POSTGRES_PASSWORD` and `WORKER_DB_PASSWORD` set — including via
  the documented `cp .env.example .env` — comes up healthy end to end; without either it fails at
  interpolation naming the variable and pointing at `operating.md`.
- A restore onto a fresh cluster succeeds with the role created before `pg_restore`, and the
  rehearsal drill exercises the missing-role case rather than hiding it.
- `npm run typecheck`, `npm test`, `npm run build` and `scripts/smoke-test.sh` green.

## 6. Documentation deltas

Ticket [08](price-worker/08-documents-and-runbooks.md) carries the line-level list; the promise:

- **`DESIGN.md`** — §10's Job-scheduler row (`:826`) and §10.1's prose (`:913-918`) rewritten with
  why the trade flipped; the services block (`:874-903`) gains `worker` and `egress-proxy` — and
  `dump`, missing today; the environment table (`:944-951`) gains `WORKER_DB_PASSWORD`; §6.2 gains
  the mailbox paragraph; §14 gains the accepted limitations §8 names.
- **`ARCHITECTURE.md`** — §2's external dependencies (`:92-100`; the gate needs
  `www.googleapis.com:443` only, Caddy needs no egress); §4.2's rows at `:337-339` and `:345`;
  §7.2, §7.4 (the `Price worker` stem, the heartbeat), §7.5 (two implementations of one seam),
  §7.6 (the network rows), §7.7 (an image with three entrypoints); Appendix A and B.
- **ADR-0010**, "Price fetching is an egress-isolated worker behind one table": context; the
  structural disqualification of §2.3, stated in one sentence; decision (remote provider, one
  table, polling, the role, passwords out of URLs); consequences (the deploy-time batch abort, no
  new UI state, two required variables, a shared image safe to restart independently because the
  table plus raw JSON is the whole contract); alternatives rejected — the worker owning the refresh,
  an HTTP API on a shared internal network (symmetric: the worker would reach `app:3000`),
  `LISTEN/NOTIFY` (no reconnect, unqueued, needs a poll anyway), a separate image now, an in-app
  fallback mode, a third-party proxy image, `pg_dumpall --roles-only` in the dump service, RLS for
  first-write-wins, a worker-unresponsive UI state; and the socket of §2.6 with its ticket delta.
- **`CONTEXT.md`** — **Price worker**, **Mailbox** and **Provider call**, new terms this spec
  introduces, with "queue", "job table" and "sidecar API" among the words to avoid.
- **`docs/operating.md`** — the Engine 28 floor and its check; `CREATEROLE` (and superuser for the
  hardening) for bring-your-own Postgres, with the override that mode uses; generated passwords
  mandated; `PGPASSWORD` and the URL rule; the numbered upgrade runbook and the rollback note; the
  restore path (create the role first; `--no-acl`'s caveat; the drill variant; stop the worker
  too); the fifth cause of a missing price line (`:761`); the healthcheck's meaning beside `:710`.
- **`docs/runbook.md`** — `:270` starts with `docker compose ps` for an unhealthy worker; `:525`
  loses the URL half of its recipe; `:553` stops the worker.
- **`docs/developing.md`** — the `.env.worker` recipe; the without-a-worker behaviour; where the
  split verification (`:435`) now runs.
- **`docs/data-model.md`**, **`README.md`** (`:458`, `:592-600`), `server/db.ts:59-61`, and
  `docs/specs/README.md` — landed with this spec.

## 7. Out of scope

- **Worker supply-chain decorrelation** — the named follow-up: a worker-only image stage with its
  own `package.json`, and a hand-rolled fetch of the two endpoints behind the same Zod schemas.
- Moving the app off the `portfolio` superuser — opened by this slice, not done in it.
- A UI state for a dead worker; issue #202's decision; issue #194; row-level security on
  `provider_call`; a repository `pg_hba.conf` with pinned subnets; a cap on `archived()` entries;
  host `DOCKER-USER` rules; a gVisor runtime; any auth change (ADR-0005 stands).

## 8. Residual risks, stated plainly

- **Price poisoning by a compromised worker.** Shape-checked, bounded by the ceiling and the
  seven-day rule, truth unverifiable. A hostile `symbol` in an answer prices the wrong instrument;
  a hostile `quoteType` rewrites `instrument.quote_type` (`prices.server.ts:909`) and with it the
  stocks-versus-funds split; a `non-usd` verdict for every new symbol blocks feed ingest; a
  plausible price against a large quantity can still overflow the reader's product, and the
  recovery is `psql`.
- **The observation archive.** The payload CHECK bounds one row, not the archive: a worker varying
  `regularMarketTime` archives up to 2 MB per instrument per refresh forever through `archived()`
  (`prices.server.ts:1015`). A cap there is the cheap follow-up, named and not done.
- **What the worker and Yahoo learn**: the symbols and the history ranges (about first-held less
  seven days), as today; and, for the role, row counts and column names — the shape and size of
  the household's data, never its contents.
- **Correlated compromise** until decorrelation: bounded by ticket 07 to bytes a Yahoo Finance host
  accepts, readable back only through a feature on those hosts that reflects them.
- **The app is still the superuser**; the CHECKs bind only honest code.
- **Availability against a hostile worker**: CPU and memory per statement are unbounded; `portfolio`
  logins can be attempted unthrottled, which generated passwords answer.
- **A worker outage is stale prices**, surfaced in the log and the as-of line; a dead worker at tick
  time aborts the batch with nothing ledgered, so the retry clock is not charged for it.
- **Routes that stay open**: Caddy keeps an unused route; the published `:80` stays reachable
  through the host from the gate's and Caddy's networks, and from the worker until ticket 07; the
  gate's OAuth callback relays bytes to Google.
- **Symbol-length mismatch** — 40 characters app-side, 15 in the pattern: a legitimate stored symbol
  outside the pattern never refreshes and shows stale, with a log line naming it.
- **Engine below 28 is silently weaker**, and the smoke test runs in CI, not on the operator's box;
  **version skew** across an `up -d` under one floating tag is at most one release, and harmless
  because the table plus raw JSON is the whole contract.
