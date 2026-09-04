# 0018 — The price worker: a remote provider behind one table

> Supersedes the unindexed `docs/specs/0015-price-worker.md` (commits `791ea71` and `4bfe44e`),
> deleted with this spec; §2.3 records why its shape no longer fits. Read
> [ADR-0011](../adr/0011-a-backfill-fills-the-spine-but-never-moves-it.md) first: the worker has
> to serve the refresh that ADR shapes, and that shape is what rules the old plan out. §2.6 is the
> one question the owner has to answer before the triage label goes on.

**Status:** proposed · **Slice directory:** [`price-worker/`](price-worker/) · **ADR:** 0010
(reserved for this slice; unwritten — ticket [10](price-worker/10-documents-and-runbooks.md) writes
it)

---

## 1. Intention

A supply-chain compromise of the app's npm tree — or anything else that comes to run inside the
`app` container — must have no network path out, and the code that does talk to the internet must be
unable to read the household's financial data. Today both are false at once: the process that
fetches prices is the process that holds the family's every balance, it connects as the database
superuser, and nothing stops it opening a socket to anywhere.

The design in one sentence: **the worker is `yahoo-finance2` running in a container with internet
access and one database table; the app keeps every price rule, every price write and the scheduler,
and reaches the worker through that table exactly as it reaches the provider seam today.** The
worker holds no domain logic — transport plus the library — so what crosses the table is a request
the app already knows how to make and an answer it already knows how to read. After the slice the
internet-facing code sees ticker symbols and public prices; the process that sees the money cannot
resolve a hostname.

Six requirements, each made testable below: (1) `app`, `db` and `dump` have no internet route,
enforced by Docker networking and asserted by the smoke test — outbound TCP fails *and* external
name resolution fails; (2) exactly one component fetches prices, the `worker` container — the gate
keeps its Google egress (ADR-0005 untouched) and Caddy the published port; (3) the worker's role can
read what it is asked and write what it answers, and cannot read any account, holding, person,
position set or upload — enforced by grants and pinned by a test that snapshot-asserts the whole
ACL; (4) the worker is not addressable by the app — no listening port, no API, coordination through
rows — taken as stated, with §2.6 surfacing the one alternative that would relax it; (5) the worker
cannot reach `app:3000` (every screen is served unauthenticated behind the gate) or `gate:4180` (the
Google client secret); (6) the superuser password stops having a default, because a minimal role
means nothing while it is guessable.

What the household sees does not change: the cadence at Settings → Prices, quotes only while the
market is open, the bounded backfill batch on every refresh (ADR-0011), **Refresh now** with
JavaScript off included, the USD probe at ingest — a non-USD symbol still refuses with nothing
written, an unavailable one is still created — and the gap list. Nor do the rules the repository is
built on: append-only history, the single-site invariants of ARCHITECTURE.md §4.2, thin routes, Zod
in the domain module only, no enums, money and dates as strings across the driver, tests against
real Postgres.

## 2. Background and context

### 2.1 Threat model

The concern is npm supply-chain compromise: a poisoned package in the production tree, running with
whatever the process has. This app's production tree is 117 packages, 76 of them reachable only
through `yahoo-finance2` (`docs/research/2026-08-23-dependency-audit.md` §1) — the one dependency
that talks to the internet is also the largest share of the surface. The containers are hardened
already (`cap_drop: ALL`, `no-new-privileges`, read-only root, unprivileged uids —
`compose.yaml:22-26`), CI audits signatures (`.github/workflows/ci.yml:66`) and the image prunes
what the library declares but never loads (`Dockerfile:66-67`). What is missing is **egress
control** — every service rides the default bridge with a route out; `compose.yaml` has no
`networks:` key — and **role separation**: the app, the migration runner and the dump sidecar all
connect as `portfolio`, the initdb superuser, whose password defaults to `portfolio`
(`compose.yaml:59`, `.env.example:104`) and travels inside two connection URLs (`:126`, `:204`).

Three adversaries, judged separately throughout, because the guarantees differ for each:

- **A compromised app, honest worker.** After the slice: no socket to anywhere. It can place
  symbol-shaped strings in rows for an honest worker to send to five Yahoo Finance hosts, at a rate
  the worker caps (§2.5), and relay bytes to Google through the gate's OAuth callback (§8). It
  remains the superuser; that follow-up is named in §7, not done here.
- **A compromised worker, honest app.** The price feed's input: it can lie about prices within the
  shape and bounds the app checks (§3.1), read table sizes and column names but no contents, and
  degrade the database's availability within the bounds §3.6 states. Until ticket 09 it has
  unrestricted internet *and* the household LAN.
- **Both, correlated.** One image and one npm tree serve both ends of the table. Bounded after
  ticket 09 to what Yahoo's edge serves under a TLS server name the proxy has matched to the
  `CONNECT` host (§3.8); removed only by the decorrelation follow-up (§7).

### 2.2 What exists today (verified against the tree)

- **One refresh entry point.** `refreshPrices(provider, marketTimeZone, { quotes }, db)`
  (`app/lib/prices.server.ts:666-703`) runs `refreshQuotes` (`:759`) then one bounded backfill batch
  (`backfillCloses`, `:548`); three callers wrap it in `withRefreshLock` (`:120-149`): the poller's
  tick (`app/lib/price-poller.server.ts:127-133`), **Refresh now** (`app/routes/refresh.ts:66-68`)
  and the post-commit request (`requestRefresh`, `price-poller.server.ts:245-259`). The root loader
  starts the poller (`app/root.tsx:67`).
- **Candidate selection reads household tables.** `selectBackfillCandidates` (`:295-336`)
  inner-joins `holding` and `position_set` (`:300-301`) under the shared gap predicate (`:253-258`),
  skips anything attempted within `BACKFILL_RETRY_INTERVAL` (`"1 day"`, `:98`; predicate `:306-316`)
  and takes `BACKFILL_BATCH_SIZE` (`5`, `:87`). A provider throw is ledgered `provider_failed` per
  candidate and the loop continues (`:567-587`).
- **The provider seam.** `PriceProvider` is `getQuotes` and `getDailyCloses`
  (`app/lib/price-provider.server.ts:155-162`). The adapter (`:705`) collapses a `CurrencyRefused`
  into an absent quote (`:719-731`), sends `matchKey(symbol)` with `period1` only (`:748-760`) and
  maps two message stems to `no-history` (`:787-793`). The client takes no options (`:617-624`) — no
  `versionCheck: false`, no signal, no timeout — and the `import("yahoo-finance2")` at `:619` is the
  single site ARCHITECTURE.md §4.2 records (`:338`). Every test fakes the seam.
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
  read (`:150-153`). `createPool` pins no `max` (`server/db.ts:45-53`); its comment at `:59-61` says
  the poller holds a client across provider network work.
- **Backups.** `pg_dump` runs without `--no-acl` (`scripts/dump-loop.sh:262`); the restore is
  `pg_restore --exit-on-error --single-transaction` (`docs/operating.md:882-883`) after stopping
  only `app`, named as the connection holder (`:894`).
- **Tests and smoke.** `withDatabase` is one rolled-back transaction that `getDb()` resolves to at
  any depth (`tests/support/database.ts:92-115`); migrations are applied once per file by
  `testDatabase()` (`:40-51`) — there is no vitest `globalSetup`; one test drives a committing
  handle because a per-attempt boundary cannot be seen from inside a transaction
  (`tests/price-backfill.test.ts:955-1035`); the poller tests patch a real pool
  (`tests/price-poller.test.ts:104`). No test asserts a role, grant or ACL; none exercises
  `app/routes/refresh.ts`. The smoke test hard-codes five service lists (`scripts/smoke-test.sh:71`,
  `:342-350`, `:365-367`, `:379-385`, `:401-403`), waits on `app` alone (`wait_for_healthy`, `:82`,
  takes no argument), expects the first missing variable to be the gate's (`:108-116`), and imports
  `yahoo-finance2` inside `app` (`:265-268`).

### 2.3 Why the previous plan's shape no longer fits

`docs/specs/0015-price-worker.md` landed in `791ea71` and gained its six tickets in `4bfe44e`;
neither commit touched `docs/specs/README.md`, so it was never indexed, and its number collided with
`0015-chart-series-assembly.md` (`docs/specs/README.md:43`). It is deleted with this spec.

Its shape was that the worker *owns the refresh*: `refreshQuotes` moves into the sidecar, with a
column-level grant list over `instrument`, `quote`, `price_daily`, `price_observation`, `price_poll`
and `app_setting`. Spec 0017 changed the ground under it: a refresh is now quotes **and** a backfill
batch whose candidate selection joins `holding` and `position_set` (`prices.server.ts:300-301`) —
exactly the tables requirement 3 forbids the worker. A worker that owns the refresh needs those
tables, or a `SECURITY DEFINER` window onto them that leaks first-held dates; a worker that is only
a provider needs one table. That is not a trade, it is a disqualification, and it decides a question
the old spec left open: **selection of what to fetch — quotes and backfill alike — is the app's,
never the worker's.** Issue #202, which asks whether the poll should stop fetching instruments
nobody holds, is the same rule seen from the other side: its fix reads `holding_valued`, and it
stays an app-side decision whatever the owner decides.

The old spec's honesty survives where it was right. Its threat model, its "what no API really means"
and its residuals are the ancestors of §2.1, §2.5 and §8; its residuals were reviewed against this
design one by one, and the ones it dropped or understated are restored here.

### 2.4 Decisions this slice reverses, and the invariants it keeps

Reversed, each edited in place by ticket 10 with the reason beside it:

- `DESIGN.md:826`, the **Job scheduler** row — "In-process, inside the app container. One process to
  deploy, one place to read logs" — and `:913-918`, "The in-process scheduler (§10) is why there is
  no separate worker service." Security was not an input to that trade; it is now the deciding one.
  The scheduler itself stays in-process (§3.1): what moves is the fetch.
- `compose.yaml:1-2`, "no worker for it: two images, two deployments, two logs", and `:20`, which
  promises every non-gate setting a default. After this slice two more variables have none.
- `README.md:594-595`, "there is no worker container, which DESIGN.md §10 chose deliberately", and
  the poller's header (`app/lib/price-poller.server.ts:2-6`), which restates §10's choice.
- ADR-0011's "In-process … nothing is shaped for spec 0015's worker" (`docs/adr/0011-…md:55-56`) and
  its rejected option "Mailbox-shaped, for the worker" (`:74-77`) — reversed exactly as it foresaw
  at `:115-116` ("Spec 0015, if built, inherits a second call to move"), and as spec 0017 said at
  `docs/specs/0017-price-backfill.md:366-368`. Both name "spec 0015" meaning the deleted worker
  proposal; a one-line banner landed with this spec says so in each, and nothing else in them is
  rewritten.

Preserved, and asserted by the tests this slice adds:

- **The single sites of ARCHITECTURE.md §4.2.** Pool construction stays `server/db.ts:createPool`
  (the worker uses it). The `yahoo-finance2` import moves once, to `server/yahoo-client.ts`, and at
  every commit there is exactly one importer (§3.5). The price writer stays
  `app/lib/prices.server.ts`, untouched in what it writes. `server/config.ts` stays the only reader
  of `process.env`; the driver reading its own `PGPASSWORD` and the Node runtime reading
  `NODE_USE_ENV_PROXY` and `HTTPS_PROXY` are stated, not smuggled — no application code reads them.
- **History is append-only.** The mailbox is scaffolding — the `upload_draft` precedent — not
  history: rows are swept by the app, and nothing the worker can do touches `price_observation`,
  `position_set` or any ledger.
- **ADR-0005.** The gate keeps its Google egress and nothing about authentication changes.

### 2.5 What "no API" really means

A table is a channel, and it is honest to say what kind. The app→worker surface is three columns and
an id: `kind`, a `text[]` of symbols, a `date`. The worker→app surface is one `jsonb` document the
app validates on read with the Zod schemas it validates Yahoo's own answers with today.

For a **compromised app** the property is real and narrow: no socket; it can place symbol-shaped
strings in rows, and an honest worker sends only those, only to Yahoo Finance hosts, and only at the
rate the worker itself caps — ten quotes calls and twenty history calls a minute (§3.5), against an
honest need of one quotes call and at most five histories per tick plus a probe per ingest
submission. The CHECKs bind honest code and a non-owner worker, not the superuser app, which can
drop any constraint or insert rows directly; the check that binds here is the worker's own
re-validation of every symbol before it touches a URL (§3.5). What remains is a channel stated as a
rate: ten calls a minute × at most a hundred symbols × fifteen characters, about 11 KB a minute of
symbol-shaped text readable by Yahoo or an on-path observer, plus the gate's OAuth callback (§8).

For a **compromised worker** the table is the price feed's input, which the app treats as it treats
Yahoo: shape-checked, currency-guarded, bounded above, and — new here — unable to write a close more
than a week from today through the quote path (§3.1). Truth is unverifiable; §8 says what a lying
feed can still do.

For **both**, the CHECK and the pattern are compromised code's to ignore, and until ticket 09 the
worker's egress bridge reaches everything. Ticket 09 is therefore *required*: with it the worker has
no resolver at all and can send bytes only through a proxy whose closure is `node:http`, `node:net`
and `node:dns` — a payload that is never imported never runs, so the proxy is the one piece of the
shared image the npm tree cannot reach — and the proxy admits a tunnel only to five named hosts,
only when the TLS ClientHello inside it names the same host, and never to a private address.

### 2.6 The owner's decision

Round-one review proposed an alternative that meets requirements 1, 2, 5 and 6, meets the strongest
reading of 3, and breaks the letter of 4: **a unix socket on a shared tmpfs volume.** Both
containers mount one small tmpfs; the worker listens on a socket file; the app's provider calls it
with `fetch` over the socket under `AbortSignal.timeout`; the worker holds **no database credential
at all**. No TCP port, no shared network, so requirement 5 holds by construction.

What it removes from this spec: migration 0012, the role, the grants, the availability hardening of
§3.6 (which exists only because the worker holds a credential), the provisioning step, both role
tests, the sweep, the deadline column, the polling on both sides, and `WORKER_DB_PASSWORD` — ticket
04 entire, the password-and-role half of 06, and 07's module shrinking to a socket client of some
forty lines. What replaces them: `ECONNREFUSED`/`ENOENT` *is* "worker dead", the timeout *is*
"provider slow". What does **not** change: tickets 01–03 entire; 05's client, watchdog, rate caps
and symbol check; 08, 09 and 10 in substance; the per-call budgets (they become the
`AbortSignal.timeout` on each socket call — only the column goes); the JSON round trip through the
app's schemas. Its own residuals, judged harmless in review and stated so the comparison is even: a
compromised worker can unlink or replace the socket file — denial only, since the app's mount
namespace holds nothing else to redirect it to — and fill the tmpfs to its size cap.

What it costs: the worker becomes addressable by the app, and its input surface is `node:http`'s
request parser rather than three typed columns — the same trust direction as the mailbox (the worker
parses the app's request either way; the app parses the worker's JSON through Zod either way), and a
real relaxation of "no listening socket, no API".

This spec is written to requirement 4 as stated. ADR-0010 records the socket as the alternative
rejected on that requirement alone, with the ticket delta above, so that a single decision reverses
it. **The question for the owner is whether the purpose behind requirement 4 was "no port, no API"
or "the worker cannot reach the app and the app cannot be tricked into reaching the internet through
it" — the socket meets the second with less.**

## 3. Design

### 3.1 The seam

`PriceProvider` (`app/lib/price-provider.server.ts:155-162`) is already injected into
`refreshPrices`, `refreshQuotes`, `backfillCloses` and the poller, and every test fakes it. The
app-side half of this slice is one more implementation, `mailboxProvider()`, that asks the worker
instead of the library. Untouched: `refreshQuotes`, every price write, ADR-0011's rules,
`withRefreshLock`, `price_poll` and the observation log — nothing the worker can do reaches them
except through the seam.

Three deliberate touches to the rules, each stated here because "untouched" would otherwise be a
lie. Two harden the app against a hostile provider, which the seam now has to assume:

- **A price ceiling in `toProviderQuote`.** Rate and close are bounded today — `RATE_CEILING`
  (`:208`) and `CLOSE_CEILING` (`:219`), both `10 ** 16` — and `price` is not, though `quote.price`
  is the same `numeric(20, 4)` (`migrations/0001_initial_schema.sql:219`). A quoted figure at or
  over sixteen integer digits does not commit: Postgres answers overflow by aborting the statement,
  and with it the whole refresh transaction, so one such figure costs every instrument its refresh —
  the reasoning `inRange`'s docstring (`:221-230`) already gives for yields. `PRICE_CEILING = 10 **
  16`, a third sibling with the same reasoning; dropped, not clamped, so the symbol comes back "not
  in the answer" and goes stale (`:231-234`). The reader's `quantity × price` product is §8's
  residual.
- **The quote path refuses to write a `price_daily` close whose market date is more than seven days
  from today's, either side.** `writeDailyClose` upserts `do update set close` on `(instrument_id,
  date)` (`prices.server.ts:944-947`) keyed by `regularMarketTime`, so a hostile quote rewrites any
  past day's close, and a future `regularMarketTime` plants a close on a day to come — permanent
  when that day is a weekend or holiday the poller never overwrites; ADR-0011's immutability covers
  only the backfill writer. The quote and the observation still land — the observation is the
  archive and the quote is the current answer — and the day is left to the backfill, which is
  ledgered and split-aware. Seven, because that is the window an honest NAV or a holiday quote can
  lag by, and because it is `BACKFILL_RANGE_LEAD_DAYS` (`:106`) — a week clears the longest run of
  non-trading days.

One serves the ledger: **`backfillCloses` aborts the batch without ledgering when the provider was
unreachable.** Today a throw from `getDailyCloses` is ledgered `provider_failed` and the loop
continues (`:567-587`), after which the retry clock (`:98`, `:306-316`) skips the instrument for a
day. With a worker that restarts independently of the app, "unreachable at tick time" becomes a
deploy-time event, and ledgering it would defer up to five candidates a day for a worker that was
back a minute later. A named `ProviderUnreachable` (§3.4) escapes the per-candidate catch unchanged;
the existing outer catch (`:630-634`) wraps it once in `BackfillBatchFailed` (`:501-509`) with the
partial report, exactly as it does for a database error today; the composition's catch (`:688-702`)
sees the cause and the ledger holds nothing for that tick.

### 3.2 The mailbox: `provider_call` (migration `0012_provider_call.sql`)

One row per library call — one `quote()` or one `chart()` — not one per symbol and not one per
refresh. Per-symbol rows would make the worker split Yahoo's batched answer by symbol, which is
`matchKey`'s job in the app (`prices.server.ts:733`, applied at `:805-809`) and the one rule the
worker must not hold; per-refresh coalescing is a vestige of the old shape, because the app already
serialises refreshes under `withRefreshLock` and the only concurrent requests are probes.

```sql
create table provider_call (
  id            bigint generated always as identity primary key,
  kind          text not null,
  symbols       text[] not null,
  range_from    date,
  requested_at  timestamptz not null default now(),
  deadline_at   timestamptz not null,   -- the requester's budget; never claimed past it
  claimed_at    timestamptz,            -- set by the worker's claimer: the liveness signal
  answered_at   timestamptz,
  outcome       text,
  payload       jsonb,
  error         text,
  constraint provider_call_kind_valid     check (kind in ('quotes', 'history')),
  constraint provider_call_symbols_bounded check (cardinality(symbols) between 1 and 100),
  constraint provider_call_symbols_no_null check (array_position(symbols, null) is null),
  constraint provider_call_history_one_symbol check (kind = 'quotes' or cardinality(symbols) = 1),
  constraint provider_call_range_matches_kind check ((kind = 'history') = (range_from is not null)),
  constraint provider_call_outcome_valid  check (outcome in ('ok', 'failed')),
  constraint provider_call_payload_bounded check (pg_column_size(payload) <= 2097152),
  constraint provider_call_error_bounded   check (length(error) <= 1000)
);

create index provider_call_pending on provider_call (requested_at)
  where claimed_at is null and answered_at is null;
```

The migration holds the table, its constraints and the index, and nothing about the role (§3.6). The
symbol pattern is not in the schema: it lives once, in `server/symbol-pattern.ts` (§3.5), checked by
the app before it inserts and by the worker before it touches a URL. The honest statement about
every CHECK here: the app is a superuser and can drop any of them; they bind honest app code and a
*non-owner* worker, whose `UPDATE`s re-evaluate them, and the worker never writes `symbols`. What
SQL can say without a function it says: between one and a hundred symbols, none of them null
(`bool_and` over `unnest` would have skipped a null element; `array_position` does not). The two
size bounds — two megabytes of payload, a thousand characters of error — are what keeps a hostile
worker from filling the disk one answer at a time (`pg_column_size` in a CHECK sees the uncompressed
datum — exercised); a ten-year chart answer is around 300 KB.

`payload` is the library's raw answer serialised as JSON — the array `quote()` returns, the object
`chart()` returns. The app validates it on read with the schemas it has today: `yahooQuote`
(`price-provider.server.ts:244-272`) through `toProviderQuote` (`:320`), `yahooChart` (`:400-410`)
through `toProviderHistory` (`:483`). Both already accept ISO strings for every instant —
`regularMarketTime` is `z.union([z.date(), z.number(), z.string()])` (`:249`) and every bar and
split goes through `parseInstant` (`:298-310`) — so a `Date` that became a string in `jsonb`, or an
epoch number the library's best-effort coercion left alone with its own validation off (§3.5),
parses unchanged. No schema change; one end-to-end round-trip test is the pin.

Scaffolding, not history (`upload_draft` is the precedent): the app sweeps answered rows older than
an hour and any row an hour past its deadline, before each insert. The worker never inserts and
never deletes. `provider_call` has no foreign keys, so a test's cleanup is one delete by id.

### 3.3 The app side: `app/lib/provider-mailbox.server.ts`

One primitive, `ask(kind, symbols, rangeFrom, { graceMs, budgetMs })`, the production constants its
defaults so a test passes two hundred milliseconds instead of sleeping through real budgets. `ask`
first sweeps, as its own statement outside any transaction, under `set local lock_timeout = '2s'`: a
hostile worker holding `FOR UPDATE` on unanswered rows — it needs only the column `UPDATE` it has —
must not hang the app inside the refresh lock, and a sweep that times out is logged (stem `Provider
mailbox`) and never fails the ask, because housekeeping must not be what costs an honest refresh
(`createDraft`'s sweep, `app/lib/uploads.server.ts:184-210`, is the fire-and-forget precedent). Then
the insert, which never waits on a row lock, with `deadline_at` computed on the app's clock; then a
poll of its own row every 100 ms through the same `getDb()` every read uses:

- `claimed_at` still null after a **3 s grace**: throw `ProviderUnreachable` ("no worker claimed the
  request within 3 s") — every time, with no memory between calls.
- Claimed but unanswered at the deadline: throw a plain error saying so — the worker is alive and
  the provider slow, which is what Yahoo timing out looks like today; `refreshQuotes` turns any
  throw into `providerFailed` (`prices.server.ts:792-800`).
- A `failed` row: throw the library's error text, so the ledger records what Yahoo said.

Budgets are per call, by kind — **quotes 15 s, history 30 s** (the worker's watchdog), **probe 10
s** (a cold worker's first probe pays the claim latency plus a three-fetch crumb handshake, and the
verdict a short budget would lose is `non-usd`, the one a person acts on). The requester's deadline
gates two things only: whether the worker will still claim the row, and how long the app waits —
never the worker's own fetch (§3.5). No handle and no unreachability flag: the batch abort of §3.1
already makes a dead worker cost one grace per kind rather than one per candidate. The cost, stated:
inside market hours a dead worker costs a tick about 6 s inside the lock — the quotes' grace, then
the first history candidate's, which aborts the batch — and 3 s outside them. Symbols are checked
against the pattern *before* the insert: the app's own rule permits what the pattern does not
(length ≤ 40, any character, `instrument-resolution.server.ts:308-312`), and one such stored symbol
would otherwise cost a whole call. An offender is dropped with a log line naming it, comes back
absent, and goes stale — the residual §8 states. A call of more than a hundred symbols is split at
the CHECK's bound into consecutive asks.

`mailboxProvider(): PriceProvider` — `getQuotes(symbols)` is `ask("quotes", symbols)`, then each
payload entry through `toProviderQuote`, skipping `CurrencyRefused` exactly as the adapter does
(`:719-731`); a payload that is not an array is an empty answer, `probeSymbol`'s rule (`:677`).
`getDailyCloses(symbol, range, tz)` is `ask("history", [matchKey(symbol)], range.from)` — the
adapter applies `matchKey` at `:756` and sends `period1` only (`:748-755`), both app-side because
the worker must not import `app/lib`; a `failed` row whose error matches `isMissingHistory`'s stems
(`:787-793`, made exportable) is `no-history`; an `ok` row goes through `toProviderHistory(payload,
range, tz)`, which applies `until` app-side (`:541`), so there is no `range_until` column.

`mailboxProbe: ProbeSymbols` is built on `ask`, **not** on `getQuotes`, which cannot say `non-usd`:
one `ask("quotes", symbols)` for the whole batch, then `probeSymbol`'s body (`:665-694`) per symbol
— `CurrencyRefused` is `non-usd`, absent is `unavailable`, any throw is `unavailable` for every
symbol. Six new symbols against a dead worker cost one 3 s grace, not six; against a worker that is
alive but slow, at most the 10 s budget.

The existing `Price provider failed` stem (`prices.server.ts:796`) now carries "no worker claimed…"
for a dead worker, distinct from Yahoo failing, and the composition's batch-failed line (`:691-694`)
is a single warning with the same text when the cause is `ProviderUnreachable` — not "the quotes it
ran beside are unaffected" a second after the quotes failed on the same cause. The route keeps its
three outcomes (`app/routes/refresh.ts:21-33`); the dead-worker distinction is the operator's
(`docker compose ps`, the worker's log), not a fourth sentence in
`app/components/price-freshness.tsx:74-102`. A JS-off press against an alive-but-slow worker can
block for the sum of the budgets, 15 s plus five times 30 s; today it is unbounded.

### 3.4 The prefactor (tickets 01–03, on the existing Yahoo adapter)

Make the change easy before making it. Every piece below typechecks and tests against
`yahooPriceProvider()` as it stands, so the cutover (ticket 07) becomes "swap the provider, delete
the client use". Three tickets, blocked by nothing, because the pieces share no line.

- **(01) `runRefresh({ quotes }, provider = liveProvider())` in a new domain module,
  `app/lib/refresh.server.ts`,** holds the lock, runs `refreshPrices` with the instance it was
  handed, and maps the result to the outcome the control renders. The route
  (`app/routes/refresh.ts:58-86`), the poller's tick (`price-poller.server.ts:127-133`) and
  `requestRefresh()` (`:245-259`) become thin callers — issue #159's ask, and it fixes the one `lib
  → routes` import in the tree (`app/components/price-freshness.tsx:16`) by moving `RefreshOutcome`
  into the domain. The market-hours gate and the cadence stay the poller's, as #159 requires;
  `PollerState.provider` stays the one instance it is today (`price-poller.server.ts:59-72`,
  defaulted at `:193`) — with no flag to reset, nothing needs a factory. **`ProviderUnreachable`**
  is defined beside `PriceProvider`; `backfillCloses` lets it escape the per-candidate catch
  unchanged so the outer catch wraps it once (§3.1); the composition's log line branches on it; the
  Yahoo adapter never throws it.
- **(02) `ResolutionDeps.probe` becomes required and batched:** `probe(symbols) →
  Promise<Map<string, SymbolProbe>>` over one library call. The loop at
  `instrument-resolution.server.ts:502-525` probes serially, and under the mailbox each call would
  be a round trip — issue #205's first item. The default import (`:20`), `?? probeSymbol` (`:499`)
  and `resolveAll`'s `deps = {}` default (`:270`) go — with the default kept, "required" would be a
  type and not a fact; the verdict logic — parse each entry, `CurrencyRefused` is `non-usd`, absent
  is `unavailable`, never throw — becomes a pure exported function so the Yahoo batch probe now and
  the mailbox probe later share it; `app/routes/upload/instruments.tsx:104-106` passes the Yahoo
  batch probe for now; `tests/routes/upload-instruments.test.ts:84` and `:162` get a stub.
- **(03)** The two hardening rules of §3.1. The seven-day arithmetic on an `IsoDate` uses `addDays`,
  today private in `app/lib/chart-range.ts:139` and exported rather than written a fourth time.

Tests: the seams, the abort without a ledger row, the batched probe, the ceiling, the seven-day
window both ways.

### 3.5 The worker: `server/price-worker.ts` (ticket 05)

Same image, overridden entrypoint — the `dump` precedent (`compose.yaml:144-145`); an `entrypoint:`
also drops the image `CMD`, so neither `docker-entrypoint.sh`'s migration nor `react-router-serve`
runs as the worker. Its closure: `server/config.ts` (only `DATABASE_URL` required), `server/db.ts`
(`createPool` gains an optional options argument to pin `max` — 3 for the worker; the same edit
issue #208 needs), `server/yahoo-client.ts`, `server/symbol-pattern.ts`, `pg`, `zod`,
`yahoo-finance2`. No Kysely, no `app/lib`: the react-router edge at `app/lib/settings.server.ts:27`
→ `app/lib/masking.ts:14` is never reached, so the old spec's masking-policy ticket has no reason to
exist.

**`server/yahoo-client.ts`**, new, used by the app's adapter from this ticket until the cutover so
there is one client site at every commit: `new YahooFinance({ versionCheck: false })` — the default
is `true` and fetches `registry.npmjs.org` from the validation-failure path
(`esm/src/lib/options/defaults.js:25`, `esm/src/lib/versions.js:6` in 4.0.2); every `quote(symbols)`
and `chart(symbol, { period1, interval: "1d", events: "split" })` under a third module-options
argument of `{ validateResult: false, fetchOptions: { signal: AbortSignal.timeout(30_000) } }`.
`validateResult: false` is the per-call setting that turns the library's own result validation off
(`moduleExec.js:89-91` reads it, `:127-130` skips the throw; the constructor refuses the same key —
research §3.3, exercised with a hand-broken payload), so one drifted field cannot fail a whole
`quote()` and the app's Zod is the only gate (§3.2 says why the best-effort coercion that follows is
harmless). The signal is forwarded to `fetch` (`moduleExec.js:82`) and covers the crumb handshake —
the bound issue #205 asks for, extended to `chart`, so the app's own Yahoo calls are bounded at 30 s
from this ticket on. The watchdog is the client's own and fixed, **never derived from the
requester's deadline**: the crumb handshake is memoised single-flight and runs under the *first*
caller's `fetchOptions` (`yahooFinanceFetch.js:74`), so a probe's short budget handed in as a signal
could abort the handshake a quotes call had joined and fail both. The client imports nothing from
`app/lib` (`matchKey` would pull Kysely in); `ChartRequest` (`price-provider.server.ts:589-598`)
moves with it.

**The loop.** A claimer every 250 ms when idle, again at once after a round that claimed something:

```sql
update provider_call set claimed_at = now()
 where id in (select id from provider_call
               where claimed_at is null and answered_at is null and deadline_at > now()
               order by requested_at limit 50)
returning id, kind, symbols, range_from, deadline_at
```

feeds two in-process lanes, quotes and history, each making its calls one at a time, so `claimed_at`
is a true liveness signal and a history call in flight never delays a quotes call or a probe (a
probe can wait behind one quotes call, at most). The `UPDATE … RETURNING` is atomic under read
committed — a second worker's re-evaluated `WHERE` sees the row claimed and returns nothing — so
there is no `FOR UPDATE SKIP LOCKED`. Before each call, in order: a row whose deadline has passed is
answered `failed` / `expired` without a fetch; a symbol that is not a string matching the pattern —
`RegExp.test(null)` matches the text `"null"` — is answered `failed` without a fetch, from
`server/symbol-pattern.ts`, a module with no imports the app shares from ticket 07 and the only copy
of the pattern: the binding check of §2.5; a row beyond the lane's cap — **quotes ten calls a
minute, history twenty** — is answered `failed` / `rate limited` with one log line — the worker is
the honest component when the app is not (§2.5), and a runaway app must not earn the household a
Yahoo ban. The answer is `update … set answered_at = now(), outcome, payload, error where id = $1
and answered_at is null` — first write wins; `error` is the throw's message with its `cause`
appended, since undici says `fetch failed` for every network failure and keeps the detail in
`cause`. No lease, no reclaim: a row nobody answers is abandoned at its deadline by the requester
and swept later.

**Startup** is `select 1 from provider_call limit 0`, retried forever with a backoff from 250 ms to
a 5 s cap, logging on the transition into and out of failure rather than per attempt: no ledger
check, no migration. Under `restart: unless-stopped` a daemon restart ignores `depends_on`, and an
authentication failure or `NOLOGIN` refusal (provisioning not yet run) is retryable, not fatal — a
naive "auth failure is fatal" crash-loops in a way that reads like a wrong password. The same
backoff governs a claimer whose database has gone: a restore's `dropdb` must not fill the log at
four lines a second.

**Health** is a heartbeat file in tmpfs, touched after every successful claim poll, empty ones
included and failed ones never; the healthcheck asserts its age is under 60 s with busybox `stat -c
%Y`, which `node:24-alpine` carries. No database session, no port, no provider reachability —
`app/routes/healthz.ts:9`'s reason. Nothing restarts an unhealthy container
(`docs/operating.md:710`); the check is for `docker compose ps` and `depends_on`, and "unhealthy"
means the loop has not completed a poll in a minute — never "Yahoo is failing".

The statements are exported as `{ text, values }` so the role test runs the real ones
(`CompiledQuery.raw(text, values)` on the test's transaction, kysely 0.29.5); an `import.meta.main`
guard (Node ≥ 24.2; `true` for the entry file, `false` when imported, `undefined` under vitest —
research §5.3) keeps the loop from starting on import so vitest can import `drainOnce`. Logs: one
line per failed drain, stem `Price worker`, naming the row ids and the cause.

**Tests** run on a committing handle (`tests/price-backfill.test.ts:955-1035` is the precedent):
`withDatabase`'s rolled-back transaction is invisible to the worker's own connection. A row past
`deadline_at` is never claimed; expired rows answered `failed`; the watchdog's `TimeoutError`
answered `failed` with its text; a pattern violation and a null element answered `failed` with no
call; a row over the lane's cap likewise; first write wins; the heartbeat path is a parameter so the
test writes under its scratch directory. The client's own surface — the request shape, the library's
shape (`tests/price-provider.test.ts:788-818`), the timeout — gets `tests/yahoo-client.test.ts`; the
adapter's cases stay until ticket 07 deletes the adapter.

### 3.6 The role: `portfolio_worker` (ticket 04)

**One site defines the role, its grants and its hardening:** `server/provision-worker-role.ts`
exports an idempotent `provisionWorkerRole(client, { password? })`, run at every boot by the
entrypoint after `migrate.ts` and by the test suite right after `applyPendingMigrations` in
`testDatabase()` (`tests/support/database.ts:40-51` — once per file, memoised; the suite has no
vitest `globalSetup` and needs none). Migration 0012 holds the table and nothing about the role. Why
one site, and why this one: a per-database dump carries the table grants but not the role, the
database ACLs or the role settings, so boot-time re-application is the mechanism that survives a
restore — and a role spelled in a migration as well would be a second copy inviting drift, with the
migration's copy the one that never runs again. The rule in the module header: the worker's ACL
lives in provisioning and never in a migration; migrations run before provisioning on a fresh
cluster, so a future `grant … to portfolio_worker` in a migration would fail there.

What it applies, in order, each statement idempotent: `create role portfolio_worker nologin
nosuperuser nocreatedb nocreaterole connection limit 5` when `pg_roles` lacks it — the limit above
the pinned pool `max` plus reconnect churn, defence in depth, never the boundary; the grants,
complete —

```sql
grant select on provider_call to portfolio_worker;
grant update (claimed_at, answered_at, outcome, payload, error) on provider_call to portfolio_worker;
```

— Postgres is default-deny, so that is the whole of what the worker may do: nothing on `instrument`,
`quote`, `price_daily`, `price_observation`, `app_setting` or `schema_migrations`, and no sequence
grant (an identity default bypasses the sequence ACL, unlike `serial`); `alter role … login password
…` when `WORKER_DB_PASSWORD` is set, quoted with `client.escapeLiteral` because DDL takes no `$1`;
and the hardening below. `WORKER_DB_PASSWORD` is optional in `configSchema` (so `server/config.ts`
stays the only env reader) and sits in the `app` service's environment — it adds nothing to a
compromised app, already the superuser that created the role; provisioning on every boot is what
makes rotation a `.env` edit.

**Availability hardening**, because a role that can read nothing can still take the database down;
each exercised against Postgres 17 in review. `revoke temporary on database … from public` — `TEMP`
is PUBLIC's by default (`datacl = {=Tc/…}`), so revoking it *from the role* revokes nothing and the
worker keeps `create temp table` over `generate_series`, a disk fill; the superuser keeps the
privilege, and a future non-superuser app role would need `grant temporary` back. `alter role
portfolio_worker set temp_file_limit = '64MB'` (`SUSET`, so the role cannot clear it). `revoke
execute … from public` on every function in `pg_proc` where `proname like '%advisory%'` — twenty-one
on 17.10, the `pg_advisory_*` and the `pg_try_advisory_*` families, enumerated in the statement
rather than by hand: a "starts with `pg_advisory`" enumeration leaves every `pg_try_advisory_*`
executable, and `pg_try_advisory_lock(bigint)` is `withRefreshLock`'s own call
(`prices.server.ts:131`), with which a bare role takes `7295380114023642` and freezes every refresh
silently, or `7295380114023641` and hangs the migration runner at `server/migrations.ts:105` so the
next `app` restart never becomes healthy; superusers are unaffected, and a future non-superuser app
role would need a grant. The same on the large-object creation functions (`lo_put` stays executable
and is harmless without a creatable large object — listed as expected). Plus the two size CHECKs of
§3.2, and one belt in `migrate.ts`: a `lock_timeout` before its `pg_advisory_lock`, so a held
migration key fails loudly, naming the key, instead of hanging.

The hardening needs a superuser, which the bundled `portfolio` is. When the provisioning role is not
one — bring-your-own Postgres — provisioning applies what it can and **logs to the console exactly
which statements it could not** (a `raise notice` would be invisible: `pg` delivers notices only to
a `notice` listener, and nothing here attaches one). The consequence is stated where that mode is
documented: such an install keeps the role and the mailbox but neither the internal-network
guarantee nor the availability hardening — a compromised worker there can freeze refreshes or fill
temp. `create role` itself needs `CREATEROLE` or superuser, which `docs/operating.md:184-197` ("can
create tables") does not promise, so the docs gain the requirement with the role ticket, with the PG
16+ detail: a `CREATEROLE` role may `alter role … password` only on roles it holds `ADMIN OPTION`
for, automatic for a role it created and absent for one a superuser pre-created, so the remedy is
`create role portfolio_worker nologin admin <app role>` (or `grant … with admin option`), or the
password step fails the moment `WORKER_DB_PASSWORD` is set. Residual, stated: CPU and memory per
statement are unbounded (`work_mem`, `statement_timeout` are `USERSET`); row counts and column names
are readable by any role; the worker may attempt `portfolio` logins unthrottled (`pg_hba` is
`scram-sha-256` for the network), which is why generated passwords (`openssl rand -hex 32`) are
mandated in the runbook rather than suggested; and pre-authentication connection slots, §8.

**The ACL test** asserts the state provisioning produces — which is the state production has — by
enumerating every relation and routine in `public` with the `has_*_privilege` functions against an
exact allowlist; never `information_schema.role_*_grants`, which omit what is granted to PUBLIC, the
leak class the test exists to catch. `has_column_privilege` is necessary: the table-level `UPDATE`
probe answers *false* while only column grants exist. Also asserted: no `SECURITY DEFINER` function
in `public`; `holding_valued` denied — a view runs with its owner's privileges, the superuser's, so
one grant on it would hand over every account, person and holding with no table grant to show for
it; `holding_valued_at(d)` executable yet failing on `account` (`SECURITY INVOKER` reads the base
tables); `has_database_privilege(…, 'temporary')` false and `connect` true;
`pg_advisory_lock(bigint)`, `pg_try_advisory_lock(bigint)` and `pg_try_advisory_xact_lock(bigint)`
denied; no row in `pg_auth_members` **where `member` is the worker** (a row where it is the
*granted* role is legitimate: PG 17 grants a new role to its `CREATEROLE` creator `WITH ADMIN
OPTION`); the role attributes; and `temp_file_limit` read from `pg_db_role_setting`, since `SET
ROLE` does not apply a role's settings. A second test runs the worker's real statements under `SET
LOCAL ROLE portfolio_worker` inside `withDatabase` — never `SET ROLE` on a pooled client: `pg`
issues no `RESET` on release and the role would leak into the next checkout — each denied probe
under a savepoint, because a denial aborts the transaction (`tests/refresh-quotes.test.ts:774-778`).

**Passwords stop travelling in URLs.** Compose sets `PGPASSWORD` per service and the three
`DATABASE_URL` defaults carry user and host only: `pg` 8.23, libpq and `pg_dump` read `PGPASSWORD`
when the URL has no password (research §4.1, `pg_dump` included; `scripts/dump-loop.sh:95`'s host
extraction reads a password-less URL), and `config.ts`'s URL check accepts the form. A URL password
still wins over the variable, so `.env.example:23`'s explicit URL line is removed and the upgrade
runbook says "drop your `DATABASE_URL` line" — a stale `.env` would otherwise crash-loop with
`password authentication failed` after doing everything the runbook said. Every runbook that
introduces a `${VAR:?}` writes `.env` **first**: interpolation runs before every compose command,
`exec`, `ps`, `logs` and `down` included (research §1.9), so the `alter role` step through `docker
compose exec db psql` is reachable only once the variable exists. No password alphabet, no
validation code. ARCHITECTURE.md §4.2's env-reader row (`:345`) gains the sentence that the driver
reads its own `PGPASSWORD` and the runtime its own `NODE_USE_ENV_PROXY` and `HTTPS_PROXY`.

### 3.7 Topology (tickets 06 and 08)

```yaml
networks:
  backend:    { internal: true, enable_ipv6: false, driver_opts: { com.docker.network.bridge.gateway_mode_ipv4: isolated } }
  worker-db:  { internal: true, enable_ipv6: false, driver_opts: { com.docker.network.bridge.gateway_mode_ipv4: isolated } }
  caddy-app:  { internal: true, enable_ipv6: false, driver_opts: { com.docker.network.bridge.gateway_mode_ipv4: isolated } }
  caddy-gate: { internal: true, enable_ipv6: false, driver_opts: { com.docker.network.bridge.gateway_mode_ipv4: isolated } }
  egress-worker: { enable_ipv6: false }   # until ticket 09, which replaces it with worker-proxy (internal + isolated)
  egress-gate:   { enable_ipv6: false }
  ingress:       { enable_ipv6: false }

services:
  db:     { networks: [backend, worker-db] }
  dump:   { networks: [backend] }
  app:    { networks: [backend, caddy-app] }          # no route out
  worker: { networks: [worker-db, egress-worker] }    # sees Postgres and the internet, nothing else
  gate:   { networks: [caddy-gate, egress-gate] }
  caddy:  { networks: [caddy-app, caddy-gate, ingress] }
```

`internal: true` removes the default route and drops forwarded traffic to and from other networks; a
per-service `networks:` list detaches the service from the implicit `default` bridge.
`gateway_mode_ipv4: isolated` closes the escape an internal bridge otherwise keeps — an address on
the host, through which a container reaches every host service bound on `0.0.0.0`: a house-wide
reverse proxy, SSH, a resolver on `:53`. **Engine floor 28.0, hard, and first needed at ticket 06**
(where `worker-db` is already isolated): 26 has no such option and its label parser has no default
branch, so the option is *silently ignored* and the hole stays open with every other assertion
passing; 27 refuses it loudly. The compose header and `operating.md` name the floor and the check
(`docker version --format '{{.Server.Version}}'`). `enable_ipv6: false` is written on every network:
unset, Compose sends a nil and the daemon's default decides. A Compose floor stands beside the
Engine floor, because the reconciler's behaviour is load-bearing for ticket 09: Compose recreates a
network whose definition drifted only when it recorded a config hash on the live network, and leaves
one with no recorded hash untouched (research §1.11) — which is why 09 introduces a new network name
rather than changing `egress-worker` in place.

`caddy-app` and `caddy-gate` are kept apart so that `compose.yaml:257-260`'s invariant — the sidecar
believes `X-Forwarded-*` from whatever reaches it, so "only Caddy can" has to hold — becomes true
for the container the slice distrusts most; on today's default bridge `app` reaches `gate:4180`
directly. `worker` shares no network with `app` or `gate` — requirement 5 by construction, asserted
by name *and by IP*: a name failure proves only DNS scoping, and Engine 28's block on direct routed
access to unpublished ports is what the IP test proves.

What isolation does not give: any container with a route to the host reaches the host's *published*
ports, so until ticket 09 the worker reaches Caddy's `:80` through its egress bridge — the app
*through the gate*, never `app:3000` or `gate:4180`. The gate's OAuth callback relays
attacker-chosen bytes to Google from `caddy:8080/oauth2/callback`; the old spec named it and §8
keeps it. After ticket 09 the worker has no non-internal network and that route closes for it too.

Smoke asserts effects, not flags — and the daemon's own record where the effect cannot be provoked.
From `app` and `db`: a bounded `fetch` (`AbortSignal.timeout`) or `wget -T 5` to a public host
fails; `timeout 5 nslookup example.com` fails (an external lookup from an internal-only container
ends in `SERVFAIL`, possibly slowly); `/proc/net/route` holds no `00000000` destination. The
isolation itself is read from `docker network inspect`: the IPAM `Gateway` field is **empty** for
each isolated network and the host's `br-…` device carries no `inet` — never a connect to the
gateway, because under `isolated` the daemon allocates no gateway address at all (research §1.2), so
a connect to the empty field falls back to localhost and passes for the wrong reason on the very
engines the floor admits. The script fails with the floor when the engine is below 28. Every
"connect fails" assertion carries an explicit timeout (`nc -z -w 3`, a socket timeout under `node
-e`), since a connect to an unassigned address otherwise waits on the kernel's default; never `ping`
— `NET_RAW` is dropped. From the worker, `app` and `gate` are unreachable by name and by IP,
`db:5432` connects, and until ticket 09 a public host resolves. `depends_on: condition:
service_healthy` is evaluated by the Compose CLI over the Docker API, so it needs no shared network.
External-Postgres installs keep the worker, the role and the mailbox but neither the
internal-network guarantee nor the availability hardening (§3.6); ticket 10 states the override.

### 3.8 The egress allowlist (ticket 09, required)

It is what makes "Yahoo Finance and nothing else" true, and until it lands the worker's egress
bridge also reaches the household LAN — the NAS, the router's admin page, the devices the gate
exists to distrust. `server/egress-proxy.ts` is about a hundred and fifty lines of `node:http`,
`node:net` and `node:dns`, with tests: `CONNECT` only, to exactly the hosts the pinned library
contacts — `query1.finance.yahoo.com`, `query2.finance.yahoo.com`, `finance.yahoo.com`,
`guce.yahoo.com`, `consent.yahoo.com` — and not `*.yahoo.com`, because a mail or login host inside a
`CONNECT` tunnel is a full exfiltration channel. The host in the `CONNECT` line is not enough on its
own: every one of those five resolves to the same two addresses as `mail`, `login` and
`www.yahoo.com` (research §3.1), and the edge routes on the TLS server name the *client* sends, so a
tunnel opened to `finance.yahoo.com` carrying a ClientHello for `login.yahoo.com` reaches the login
property through an allowlisted tunnel. The proxy therefore reads the first TLS record on the client
side before piping, parses the ClientHello's `server_name`, and tears the tunnel down when it is
absent or differs from the `CONNECT` host, logging both names; and it refuses a destination that
resolves to a loopback, link-local or private address, so a LAN resolver — ADR-0005's adversary —
pointing `finance.yahoo.com` at a LAN box cannot make the proxy a pivot for a worker that skips
certificate checks. The list is a module constant — a fact about the pinned library, not operator
configuration, so the proxy reads no environment; when Yahoo moves a consent host the proxy log
names the refused `CONNECT` and the fix is a release.

Same image, another entrypoint, node built-ins only: its closure is decorrelated from the npm tree.
Compose: a **new** internal, isolated network, `worker-proxy` (worker, proxy) replaces
`egress-worker`, which is removed — a new name is created fresh on every Compose version, where a
changed definition under the old name is recreated only by a Compose that recorded a hash on it
(§3.7); the proxy alone sits on a plain bridge; the worker sets `NODE_USE_ENV_PROXY=1` and
`HTTPS_PROXY=http://egress-proxy:8888` — Node 24's `fetch` honours the pair only with the flag
(research §5.2, exercised: without it the fetch goes direct), the library uses global `fetch`, and
both variables are the runtime's, not `config.ts`'s. The binding property is the network, not the
environment flag, which compromised code ignores: smoke stops the proxy and asserts the worker's
fetch then fails, asserts a non-allowlisted host is refused through it, and asserts a tunnel to an
allowlisted host whose ClientHello names `mail.yahoo.com` is torn down. With no non-internal network
the worker also has no resolver: hostnames travel inside `CONNECT` and the proxy resolves them, so
DNS exfiltration from the worker is gone. The bound after 09, stated exactly: a compromised worker
can send bytes only to what Yahoo's edge serves under a server name the proxy has matched to the
`CONNECT` host; if that edge ever accepts an encrypted ClientHello the check degrades to host-only,
and an in-TLS `Host:` naming another property under a wildcard certificate is the edge's to route —
both in §8. Docker has no native egress policy; a third-party proxy image would add an unaudited
supply chain to a slice about supply chains. A stopped proxy has its own signature (ticket 09):
`docker compose ps egress-proxy` unhealthy, every worker failure of that minute carrying `fetch
failed` with one cause.

### 3.9 Image, development, tests

One image, a second and a third entrypoint — the `dump` precedent, and an owner-accepted trade. The
prune script walks *declared* dependencies from `package.json` and can never remove `yahoo-finance2`
while it is declared (`scripts/prune-unreachable-deps.mjs`'s own header: "cannot remove a package
anything still reachable declares"), so there is no prune change and the smoke kept-list stays
valid. The named follow-up, not done here: a worker-only stage pruned to the worker's closure. The
runtime stage copies `server/` files by name (`Dockerfile:104-110`), so the worker, the client, the
pattern module, the proxy and the provisioning step are each added explicitly. The compose file is
the operator's own copy (`docs/operating.md:962-965`), so every release that changes it says so in
its upgrade note, with the symptom of forgetting (§6).

Development: `npm run dev` is unchanged; a second terminal runs `node --env-file=.env.worker
./server/price-worker.ts` as the worker role, with `.env.worker` naming `portfolio_worker` and
carrying `PGPASSWORD`, after running `provision-worker-role.ts` once against the local database with
`WORKER_DB_PASSWORD` set — development exercises the same privilege boundary as production, never
the superuser (`docs/developing.md:56-60`'s `.env` is the superuser). Without a worker: stored
prices, a refresh that logs "no worker claimed", ingest probes `unavailable` after one 3 s grace
with the instruments created anyway. **No in-process fallback mode** — a second code path would keep
the Yahoo import reachable from the app and give the property an off switch.

Tests: app-side tests simulate the worker inside the same `withDatabase` transaction — a helper
answers the pending row through the test's own handle while `ask` polls, so the answer is visible
and nothing commits — with the grace and budgets injected small. Worker tests and the end-to-end
JSON round trip — `mailboxProvider`, a real drain and a fake client, through `refreshPrices`,
writing a quote and a close — run on a committing handle, which means they clean up what
`refreshPrices` commits beside the price rows: the `price_poll` row it writes (`:854`), which no
cascade reaches and which four other files count. One trap for both: `now()` is frozen at
transaction start inside `withDatabase`, so a row meant to be "an hour past its deadline" sets
`deadline_at` explicitly.

## 4. Tickets

One ticket is one pull request that typechecks, builds and tests standing alone, and every one
leaves a deployable main: after 06 the worker runs beside the still-fetching app with the advisory
lock arbitrating the two, 07 is the single release where the app stops fetching, and 08 the one
where it loses its route. There is no commit from which a deploy has no price refresh.

| # | Ticket | Blocked by |
|---|---|---|
| [01](price-worker/01-one-refresh-and-the-batch-abort.md) | `runRefresh` with three thin callers; `ProviderUnreachable` and the batch abort (§3.1, §3.4) | Nothing |
| [02](price-worker/02-the-batched-probe.md) | The required, batched ingest probe (§3.4) | Nothing |
| [03](price-worker/03-the-two-hardening-rules.md) | The price ceiling as a write-abort guard and the seven-day window on the quote path (§3.1) | Nothing |
| [04](price-worker/04-the-mailbox-and-the-worker-role.md) | Migration `0012_provider_call.sql` (the table only); `provision-worker-role.ts` — role, grants, hardening, credential — run by the entrypoint and the test suite; `WORKER_DB_PASSWORD` in `configSchema`; the regenerated types; the ACL snapshot and `SET LOCAL ROLE` tests; the restore and bring-your-own-Postgres lines that must land with the role (§3.2, §3.6) | Nothing |
| [05](price-worker/05-the-price-worker-process.md) | `server/yahoo-client.ts` (the app's adapter uses it from here), `server/symbol-pattern.ts`, `server/price-worker.ts` and its tests; the Dockerfile copy set; ARCHITECTURE.md §4.2's import-site row (§3.5) | 04 |
| [06](price-worker/06-deploy-the-worker-alongside.md) | Deploy alongside: the `worker` service, its two networks, `db` on `worker-db`, the Engine floor, the dev override, `.env.example` and the upgrade note, smoke (§3.7) | 05 |
| [07](price-worker/07-the-app-cutover.md) | App cutover: `provider-mailbox.server.ts`; poller, route and ingest on the mailbox; the adapter loses its client; round-trip, route and probe tests (§3.3) | 01, 02, 03, 06 |
| [08](price-worker/08-the-network-lockdown.md) | Lockdown: the full topology, `POSTGRES_PASSWORD` required, `PGPASSWORD` everywhere, the upgrade runbook, smoke egress, DNS and isolation assertions (§3.6, §3.7) | 07 |
| [09](price-worker/09-the-egress-allowlist.md) | The egress allowlist proxy with the SNI check, on a new network (§3.8) | 08 |
| [10](price-worker/10-documents-and-runbooks.md) | The record: DESIGN.md, ARCHITECTURE.md, ADR-0010, CONTEXT.md, the runbooks (§6) | 09 |

01 ∥ 02 ∥ 03 ∥ 04; 04 → 05 → 06 → 07 (needs 01, 02, 03) → 08 → 09 → 10.

## 5. Acceptance (slice level)

- From `app` and `db`: a bounded outbound `fetch` to a public host fails; `timeout 5 nslookup
  example.com` fails; `/proc/net/route` holds no default route; each isolated network shows an empty
  IPAM `Gateway` in `docker network inspect` and no `inet` on its host bridge; the smoke script
  refuses to run on an Engine below 28. From `worker`: `app:3000` and `gate:4180` are unreachable by
  name and by IP; `db:5432` connects; a public host resolves until ticket 09, and after it the
  worker's fetch fails with the proxy stopped, a non-allowlisted host is refused through it, and an
  allowlisted tunnel whose ClientHello names another host is torn down.
- The worker container reaches its claimer loop *in the built image*: its heartbeat healthcheck
  reports healthy under `docker compose ps`.
- **Refresh now** round-trips through the mailbox on every screen that carries it, JavaScript off
  included (blocks, then redirects). Against a dead worker it reports `providerFailed`, the log
  carries the "no worker claimed" text once, the press costs at most two 3 s graces — the quotes'
  and the first history candidate's, which aborts the batch — and `price_backfill` gains no row.
- At ingest a non-USD symbol still refuses with nothing written, an unavailable one is still created
  anyway, and a dead worker costs one 3 s grace per submission (at most the 10 s budget when the
  worker is alive but slow), not one per symbol.
- The ACL snapshot fails the suite by name when any grant to `portfolio_worker` widens, when
  `holding_valued` is granted, when a `SECURITY DEFINER` function appears in `public`, when
  `pg_advisory_lock`, `pg_try_advisory_lock` or `pg_try_advisory_xact_lock` regains PUBLIC
  `EXECUTE`, or when the database's `temporary` privilege is back; the worker's real statements pass
  under `SET LOCAL ROLE portfolio_worker`.
- A quoted price at the ceiling is dropped and the instrument goes stale; a quote whose market date
  is eight days old, or eight days ahead, rewrites no close and inserts none, while one seven days
  old does. A worker fed eleven quotes rows in a minute answers the eleventh `failed` / `rate
  limited` without a call.
- A fresh `docker compose up` with `POSTGRES_PASSWORD` and `WORKER_DB_PASSWORD` set — including via
  the documented `cp .env.example .env` — comes up healthy end to end; without either it fails at
  interpolation naming the variable and pointing at `operating.md`.
- A restore onto a fresh cluster succeeds with the role created before `pg_restore`; the
  missing-role case is rehearsed in a throwaway `postgres:17-alpine` container, never against the
  live cluster; the worker is stopped before any restore.
- `npm run typecheck`, `npm test`, `npm run build` and `scripts/smoke-test.sh` green.

## 6. Documentation deltas

Ticket [10](price-worker/10-documents-and-runbooks.md) carries the line-level list; the promise:

- **`DESIGN.md`** — §10's Job-scheduler row (`:826`) and §10.1's prose (`:913-918`) rewritten with
  why the trade flipped; the services block (`:874-903`) gains `worker` and `egress-proxy` — and
  `dump`, missing today; the environment table (`:944-951`) gains `WORKER_DB_PASSWORD`; §6.2 gains
  the mailbox paragraph; §14 gains the accepted limitations §8 names.
- **`ARCHITECTURE.md`** — §2's external dependencies (`:92-100`; the gate needs
  `www.googleapis.com:443` only, Caddy needs no egress); §4.2's rows at `:337-339` and `:345`
  (`PGPASSWORD`, `NODE_USE_ENV_PROXY`, `HTTPS_PROXY` — read by the driver and the runtime, never by
  application code); §7.2, §7.4 (the `Price worker` and `Egress proxy` stems, the heartbeat), §7.5
  (two implementations of one seam), §7.6 (the network rows), §7.7 (an image with three
  entrypoints); Appendix A and B.
- **ADR-0010**, "Price fetching is an egress-isolated worker behind one table": context; the
  structural disqualification of §2.3, stated in one sentence; decision (remote provider, one table,
  polling, the role provisioned at boot, passwords out of URLs); consequences (the deploy-time batch
  abort, no new UI state, two required variables, a shared image safe to restart independently
  because the table plus raw JSON is the whole contract); alternatives rejected — the worker owning
  the refresh, an HTTP API on a shared internal network (symmetric: the worker would reach
  `app:3000`), `LISTEN/NOTIFY` (no reconnect, unqueued, needs a poll anyway), a separate image now,
  an in-app fallback mode, a third-party proxy image, `pg_dumpall --roles-only` in the dump service,
  RLS for first-write-wins, a worker-unresponsive UI state, a per-operation unreachability handle,
  the role in a migration, a start-up refusal on a missing `WORKER_DB_PASSWORD` (§7); and the socket
  of §2.6 with its ticket delta.
- **ADR-0011 and spec 0017** — the one-line banner saying "spec 0015" there is the deleted worker
  proposal, now this spec: landed with this document, re-read by ticket 10, nothing else rewritten.
- **`CONTEXT.md`** — **Price worker**, **Mailbox** and **Provider call**, new terms this spec
  introduces, with "queue", "job table" and "sidecar API" among the words to avoid.
- **`docs/operating.md`** — the Engine 28 floor and the Compose floor with their checks;
  `CREATEROLE` and `ADMIN OPTION` for bring-your-own Postgres (landed by ticket 04), with the
  override that mode uses and both guarantees it loses; generated passwords mandated; `PGPASSWORD`
  and the URL rule; `.env` before any compose command; the numbered upgrade runbook and the rollback
  note (`DATABASE_URL` with the generated password back in `.env` under an old compose file);
  "replace `compose.yaml` with the release's copy before `up -d`" and the symptom of forgetting; the
  restore path (stop the worker first; the role before `pg_restore`, landed by ticket 04; a bundled
  dump carries catalog `REVOKE`s only a superuser can replay, so a non-superuser destination needs
  `pg_restore -L` to drop them or `--no-acl` plus a provisioning re-run; the drill in a throwaway
  container); the fifth and sixth causes of a missing price line (`:761`: worker dead or
  unprovisioned; proxy down); the healthcheck's meaning beside `:710`.
- **`docs/runbook.md`** — `:49` gains that `ps`, `logs` and `down` refuse too until the variable
  exists; `:270` starts with `docker compose ps` for both containers; `:525` loses the URL half of
  its recipe; `:553` stops the worker first.
- **`docs/developing.md`** — the `.env.worker` recipe; the without-a-worker behaviour; where the
  split verification (`:435`) now runs.
- **`docs/data-model.md`**, **`README.md`** (`:458`, `:592-600`), `server/db.ts:59-61`, and
  `docs/specs/README.md` — landed with this spec.

## 7. Out of scope

- **Worker supply-chain decorrelation** — the named follow-up: a worker-only image stage with its
  own `package.json`, and a hand-rolled fetch of the two endpoints behind the same Zod schemas.
- Moving the app off the `portfolio` superuser — opened by this slice, not done in it; when it is
  done, `reserved_connections` has to be budgeted for the app's role (§8).
- A UI state for a dead worker; issue #202's decision; issue #194; row-level security on
  `provider_call`; a repository `pg_hba.conf` with pinned subnets; a cap on `archived()` entries;
  host `DOCKER-USER` rules; a gVisor runtime; any auth change (ADR-0005 stands); the three private
  copies of `inTransaction` (`prices.server.ts:741`, `instrument-resolution.server.ts:237`,
  `uploads.server.ts:571`) — ticket 07 exports the first and adds no fourth.
- **Rejected, recorded for ADR-0010:** a start-up refusal in the image when `AUTH_GATE=external` and
  `WORKER_DB_PASSWORD` is unset, proposed as a guard against `up -d` under a stale `compose.yaml` —
  it couples the app's start to a variable it uses only for provisioning; the upgrade note carries
  the case instead.

## 8. Residual risks, stated plainly

- **Price poisoning by a compromised worker.** Shape-checked, bounded by the ceiling and the
  seven-day window, truth unverifiable. A hostile `symbol` in an answer prices the wrong instrument;
  a hostile `quoteType` rewrites `instrument.quote_type` (`prices.server.ts:909`) and with it the
  stocks-versus-funds split; a `non-usd` verdict for every new symbol blocks feed ingest. The
  ceiling bounds the price, not the product: `quantity` is `numeric(20, 8)`
  (`0001_initial_schema.sql:186`) and `holding_valued` casts `quantity × price` to `numeric(20, 4)`
  (`0006_annual_dividend.sql:149`), so a plausible price against a large quantity still overflows
  the reader — no price ceiling fixes the product; `fitsTheMoneyColumn`
  (`app/lib/positions.server.ts:206`) guards it at the quantity write, and the recovery is `psql`.
- **The observation archive.** The payload CHECK bounds one row, not the archive: a worker varying
  `regularMarketTime` archives up to 2 MB per instrument per refresh forever through `archived()`
  (`prices.server.ts:1015`). A cap there is the cheap follow-up, named and not done.
- **What the worker and Yahoo learn**: the symbols and the history ranges (about first-held less
  seven days), as today; and, for the role, row counts and column names — the shape and size of the
  household's data, never its contents.
- **The channel from a compromised app**, stated as a rate: ten quotes calls a minute × a hundred
  symbols × fifteen characters, about 11 KB a minute of symbol-shaped text through an honest worker
  to Yahoo's query logs or an on-path observer.
- **Correlated compromise** until decorrelation: bounded by ticket 09 to what Yahoo's edge serves
  under a server name the proxy has matched to the `CONNECT` host, readable back only through a
  feature on that property that reflects bytes; an in-TLS `Host:` naming another property under a
  wildcard certificate is the edge's to route, and if the edge ever accepts an encrypted ClientHello
  the check degrades to host-only.
- **The app is still the superuser**; the CHECKs bind only honest code.
- **Availability against a hostile worker**: CPU and memory per statement are unbounded; `portfolio`
  logins can be attempted unthrottled, which generated passwords answer; and `pg_hba` admits a TCP
  connection from the worker's network before any password is checked, so a client that sends a
  startup packet and stalls holds a backend for `authentication_timeout` — a hostile worker can hold
  most of `max_connections` open with no credential at all, and the app survives on the three
  `superuser_reserved_connections` only because it *is* the superuser.
- **A hostile worker can un-claim and un-answer rows** — column `UPDATE` is not row-scoped — so a
  healthy hostile worker can make the app log "no worker claimed" and send the operator chasing a
  dead one; no trigger guards it, because a worker that will not answer is the same outage by
  another route.
- **A worker outage is stale prices**, surfaced in the log and the as-of line; a dead worker at tick
  time costs about 6 s inside the lock and aborts the batch with nothing ledgered, so the retry
  clock is not charged for it.
- **Routes that stay open**: Caddy keeps an unused route; the published `:80` stays reachable
  through the host from the gate's and Caddy's networks, and from the worker until ticket 09; the
  gate's OAuth callback relays bytes to Google.
- **Symbol-length mismatch** — 40 characters app-side, 15 in the pattern: a legitimate stored symbol
  outside the pattern never refreshes and shows stale, with a log line naming it.
- **Engine below 28 is silently weaker**, and the smoke test runs in CI, not on the operator's box;
  a Compose that recorded no network hash leaves a drifted network alone, which the new name in 09
  sidesteps; **version skew** across an `up -d` under one floating tag is at most one release, and
  harmless because the table plus raw JSON is the whole contract.
