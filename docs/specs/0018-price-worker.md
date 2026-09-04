# 0018 — The price worker: a remote provider behind a unix socket

> Supersedes the unindexed `docs/specs/0015-price-worker.md` (commits `791ea71` and `4bfe44e`),
> deleted with this spec; §2.3 records why its shape no longer fits. Read
> [ADR-0011](../adr/0011-a-backfill-fills-the-spine-but-never-moves-it.md) first: the worker has
> to serve the refresh that ADR shapes, and that shape is what rules the old plan out. §2.5 records
> the owner's decision on the channel between app and worker, taken on 2026-09-04.

**Status:** proposed · **Slice directory:** [`price-worker/`](price-worker/) · **ADR:** 0010
(reserved for this slice; unwritten — ticket [09](price-worker/09-documents-and-runbooks.md) writes
it)

---

## 1. Intention

A supply-chain compromise of the app's npm tree — or anything else that comes to run inside the
`app` container — must have no network path out, and the code that does talk to the internet must be
unable to read the household's financial data. Today both are false at once: the process that
fetches prices is the process that holds the family's every balance, it connects as the database
superuser, and nothing stops it opening a socket to anywhere.

The design in one sentence: **the worker is `yahoo-finance2` behind a unix socket in a volume the
app and the worker share; the app keeps every price rule, every price write and the scheduler, and
calls the worker through that socket exactly as it calls the provider seam today.** The worker has
no database credential, no database network and no TCP listener. It holds no domain logic —
transport plus the library — so what crosses the socket is a request the app already knows how to
make and an answer it already knows how to read. After the slice the internet-facing code sees
ticker symbols and public prices; the process that sees the money cannot resolve a hostname.

Six requirements, each made testable below: (1) `app`, `db` and `dump` have no internet route,
enforced by Docker networking and asserted by the smoke test — outbound TCP fails *and* external
name resolution fails; (2) exactly one component fetches prices, the `worker` container — the gate
keeps its Google egress (ADR-0005 untouched) and Caddy the published port; (3) the worker cannot
read any account, holding, person, position set or upload — it holds no database credential and
shares no network with `db`, so there is no grant to get wrong, and the smoke test asserts the
network half; (4) **the worker has no network listener and is addressable only by the app, over a
local socket** — §2.5 records how that reading was reached; (5) the worker cannot reach `app:3000`
(every screen is served unauthenticated behind the gate) or `gate:4180` (the Google client secret);
(6) the superuser password stops having a default and stops travelling inside connection URLs,
because a database cut off from the internet but guessable from its own network is isolated in name
only.

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

Three adversaries, judged separately throughout, because the guarantees differ for each. The socket
between them is a channel, and it is honest to say what kind: one HTTP request one way — a path
naming the kind, then a list of symbols, or one symbol and a date — and one JSON document the
other, validated on read with the Zod schemas the app validates Yahoo's own answers with today
(§3.2).

- **A compromised app, honest worker.** After the slice: no socket to anywhere but the worker's. It
  can hand symbol-shaped strings to an honest worker to send to five Yahoo Finance hosts, at a rate
  the worker caps (§3.5) — the worker re-validates every symbol before it touches a URL, and that
  check is the one that binds, the app's own copy being compromised code's to skip — push arbitrary
  bytes at the worker's `node:http` parser within the bounds §3.5 sets, and relay bytes to Google
  through the gate's OAuth callback. What remains is a channel stated as a rate (§8). It remains the
  superuser; that follow-up is named in §7, not done here.
- **A compromised worker, honest app.** The price feed's input, which the app treats as it treats
  Yahoo: shape-checked, currency-guarded, bounded above, and — new here — unable to write a close
  more than a week from today through the quote path (§3.1); truth is unverifiable, and §8 says
  what a lying feed can still do. It holds no database credential and shares no network with `db`,
  so it can read nothing there and degrade nothing there; what it can withhold is answers. Until
  ticket 08 it has unrestricted internet *and* the household LAN.
- **Both, correlated.** One image and one npm tree serve both ends of the socket, and the symbol
  pattern is compromised code's to ignore at either end — which is why ticket 08 is required, not
  optional. Bounded after it to what Yahoo's edge serves under a TLS server name the proxy has
  matched to the `CONNECT` host (§3.7); removed only by the decorrelation follow-up (§7).

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
  candidate and the loop continues (`:568-587`).
- **The provider seam.** `PriceProvider` is `getQuotes` and `getDailyCloses`
  (`app/lib/price-provider.server.ts:155-162`). The adapter (`:705`) collapses a `CurrencyRefused`
  into an absent quote (`:719-731`), sends `matchKey(symbol)` with `period1` only (`:748-760`) and
  maps two message stems to `no-history` (`:787-793`). The client takes no options (`:617-624`) — no
  `versionCheck: false`, no signal, no timeout — and the `import("yahoo-finance2")` at `:619` is the
  single site ARCHITECTURE.md §4.2 records (`:338`). Every test fakes the seam.
- **The ingest probe.** `ResolutionDeps.probe` (`app/lib/instrument-resolution.server.ts:212-216`)
  defaults to the live `probeSymbol`, called serially per created feed symbol; `non-usd` refuses
  (`:515-524`), `unavailable` creates anyway. The production caller and two route tests pass no
  deps, the tests safe only because their fixtures are `manual` (ticket 02 cites the sites).
- **The deployment.** Five services, no custom networks, only `caddy` publishing a port
  (`compose.yaml:344-345`); the entrypoint validates, migrates, serves
  (`docker-entrypoint.sh:11-14`); `getConfig` is the one `process.env` read
  (`server/config.ts:150-153`). §3.6, §3.8 and ticket 09 have the rest.
- **Backups.** The restore is `pg_restore --exit-on-error --single-transaction`
  (`docs/operating.md:882-883`) after stopping only `app`, named as the connection holder (`:894`).
- **Tests and smoke.** No test exercises `app/routes/refresh.ts`; the smoke test hard-codes five
  service lists, waits on `app` alone (`wait_for_healthy`, `scripts/smoke-test.sh:81`, takes no
  argument) and imports `yahoo-finance2` inside `app` (`:265-268`). §3.8 and tickets 05–07 cite the
  rest.

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
a provider needs none of them. That is not a trade, it is a disqualification, and it decides a
question the old spec left open: **selection of what to fetch — quotes and backfill alike — is the
app's, never the worker's.** Issue #202, which asks whether the poll should stop fetching
instruments nobody holds, is the same rule seen from the other side: its fix reads `holding_valued`,
and it stays an app-side decision under any channel.

The old spec's honesty survives where it was right: its threat model, its "what no API really means"
and its residuals are the ancestors of §2.1 and §8, and the residuals it dropped or understated are
restored there.

### 2.4 Decisions this slice reverses, and the invariants it keeps

Reversed, each edited in place by ticket 09 with the reason beside it (ticket 09 has the lines):
DESIGN.md §10's **Job scheduler** row and §10.1's "the in-process scheduler is why there is no
separate worker service" — security was not an input to that trade and is now the deciding one; the
scheduler itself stays in-process (§3.1), what moves is the fetch. `compose.yaml`'s header, which
argues against a worker and promises every non-gate setting a default — after this slice one more
variable has none. `README.md`'s "there is no worker container" and the poller's header, which
restate §10's choice. ADR-0011's "nothing is shaped for spec 0015's worker" and the option it
rejected for that worker's sake — reversed exactly as it foresaw ("inherits a second call to move"),
and as spec 0017 said. Both name "spec 0015" meaning the deleted worker proposal; a one-line banner
landed with this spec says so in each, and nothing else in them is rewritten.

Preserved, and asserted by the tests this slice adds:

- **The single sites of ARCHITECTURE.md §4.2.** Pool construction stays `server/db.ts:createPool`
  (the worker constructs none: it has no database). The `yahoo-finance2` import moves once, to
  `server/yahoo-client.ts`, and at every commit there is exactly one importer (§3.5). The price
  writer stays `app/lib/prices.server.ts`, untouched in what it writes. `server/config.ts` stays the
  only reader of `process.env`; the driver reading its own `PGPASSWORD` and the Node runtime reading
  `NODE_USE_ENV_PROXY` and `HTTPS_PROXY` are stated, not smuggled — no application code reads them.
- **History is append-only.** This slice adds no table and no writer: the worker writes no row, and
  nothing it can do reaches `price_observation`, `position_set` or any ledger except through the
  seam, which writes what it always wrote.
- **ADR-0005.** The gate keeps its Google egress and nothing about authentication changes.

### 2.5 The owner's decision

Round-one review put two channels on the table, and the owner chose on 2026-09-04: **the app calls
the worker over a unix socket in a shared tmpfs volume.** The worker listens on a socket file, the
app's provider calls it under `AbortSignal.timeout`, and the worker holds no database credential —
no TCP port, no shared network, so requirements 3 and 5 hold by construction. Requirement 4 is read
as §1 now states it: the purpose behind "no listening socket, no API" was that the worker cannot
reach the app and the app cannot be tricked into reaching the internet through it, and a socket
file addressable only from the app's mount namespace meets that purpose with less. The alternative,
rejected on cost, was a **mailbox** — a Postgres table through which the app asks and the worker
answers, the worker logging in under a minimal role of its own. It read requirement 4 as "no API
at all", and every piece of machinery it needed existed to make a database login safe for the
internet-facing container:

- a migration for the table, its CHECKs and a partial index;
- a role, its two grants, a provisioning step run at every boot, and an ACL snapshot test;
- the availability hardening — `REVOKE`s on the advisory-lock and large-object families, `TEMP`
  revoked from PUBLIC, `temp_file_limit` — and a second test running the worker's statements under
  `SET LOCAL ROLE`;
- a sweep, row deadlines, a claimer with a liveness column and two lanes, and polling on both
  sides;
- `WORKER_DB_PASSWORD`, a restore-time role bootstrap before `pg_restore`, and `CREATEROLE` on
  bring-your-own Postgres.

The socket removes the login, and with it the list. What it costs is carried in §8: the worker
becomes addressable by the app, its input surface `node:http`'s request parser rather than typed
columns — the same trust direction, since each side parses the other's bytes either way — and the
two share a one-megabyte tmpfs. ADR-0010 records the decision with the list above as the cost it
was taken on; `docs/research/2026-09-04-price-worker-platform-facts.md`'s PostgreSQL section stays
as the evidence of what that cost would have been.

## 3. Design

### 3.1 The seam

`PriceProvider` (`app/lib/price-provider.server.ts:155-162`) is already injected into
`refreshPrices`, `refreshQuotes`, `backfillCloses` and the poller, and every test fakes it. The
app-side half of this slice is one more implementation, `socketProvider()`, that asks the worker
instead of the library. Untouched: `refreshQuotes`, every price write, ADR-0011's rules,
`withRefreshLock`, `price_poll` and the observation log — nothing the worker can do reaches them
except through the seam.

Three deliberate touches to the rules, each stated here because "untouched" would otherwise be a
lie. Two harden the app against a hostile provider, which the seam now has to assume:

- **A price ceiling in `toProviderQuote`.** Rate and close are bounded today — `RATE_CEILING`
  (`:208`) and `CLOSE_CEILING` (`:219`), both `10 ** 16` — and `price` is not, though `quote.price`
  is the same `numeric(20, 4)` (`migrations/0001_initial_schema.sql:219`): a figure of sixteen
  integer digits aborts the statement and with it the whole refresh transaction, so one such figure
  costs every instrument its refresh — `inRange`'s docstring (`:221-230`) gives the reasoning for
  yields. `PRICE_CEILING = 10 ** 16`, a third sibling; dropped, not clamped, so the symbol comes
  back absent and goes stale (`:231-234`). The reader's `quantity × price` product is §8's residual.
- **The quote path refuses to write a `price_daily` close whose market date is more than seven days
  from today's, either side.** `writeDailyClose` upserts `do update set close` on `(instrument_id,
  date)` (`prices.server.ts:944-947`) keyed by `regularMarketTime`, so a hostile quote rewrites any
  past day's close, and a future `regularMarketTime` plants a close on a day to come — permanent
  when that day is a weekend or holiday the poller never overwrites; ADR-0011's immutability covers
  only the backfill writer. The quote and the observation still land, and the day is left to the
  backfill, which is ledgered and split-aware. Seven, because that is the window an honest NAV or a
  holiday quote can lag by, and because it is `BACKFILL_RANGE_LEAD_DAYS` (`:106`) — a week clears
  the longest run of non-trading days. `refreshQuotes` counts a close unconditionally after the call
  (`:824-826`), so `writeDailyClose` reports whether it wrote and the loop increments only then:
  `RefreshReport.closes` (`:161`) and the log line built from it exclude a skipped write.

One serves the ledger: **`backfillCloses` aborts the batch without ledgering when the provider was
unreachable.** Today a throw from `getDailyCloses` is ledgered `provider_failed` and the loop
continues (`:568-587`), after which the retry clock (`:98`, `:306-316`) skips the instrument for a
day. With a worker that restarts independently of the app, "unreachable at tick time" becomes a
deploy-time event, and ledgering it would defer up to five candidates a day for a worker that was
back a minute later. A named `ProviderUnreachable` (§3.4) escapes the per-candidate catch unchanged;
the existing outer catch (`:630-634`) wraps it once in `BackfillBatchFailed` (`:501-509`) with the
partial report, exactly as it does for a database error today; the composition's catch (`:688-702`)
sees the cause and the ledger holds nothing for that tick.

### 3.2 The channel

**The volume.** A Compose named volume, `price-worker-sock`, on the local driver as a tmpfs —
`driver_opts: { type: tmpfs, device: tmpfs, o: "size=1m,uid=1000,gid=1000,mode=0770" }` (builder
verifies the option string against the compose spec and the local volume driver docs) — mounted at
`/run/price-worker` in `app` and in `worker`, and nowhere else. Both run as uid 1000, the image's
`node` user, so the socket file the worker creates is connectable by the app and by nothing else on
the host; the `read_only` root filesystem of each is untouched, the volume being the one writable
path this needs, and a megabyte holds a socket file with room for nothing worth keeping.

**The socket.** `/run/price-worker/worker.sock`, created by the worker at start — a file left by a
previous process is unlinked first, `EADDRINUSE` otherwise — with mode `0660`. The app never
creates it: a missing file is what a dead worker looks like.

**The protocol.** HTTP/1.1 over the socket, `node:http` on both sides — `server.listen(path)` in the
worker, `http.request({ socketPath, method, path })` in the app — with JSON bodies, one request per
call and no keep-alive. Three endpoints, mirroring the seam exactly:

| Request | Body | Answer |
|---|---|---|
| `POST /quotes` | `{ symbols: string[] }` — one to a hundred, each matching the pattern | `200`, the array the library's `quote()` returned |
| `POST /history` | `{ symbol: string, from: IsoDate }` | `200`, the object the library's `chart()` returned |
| `GET /healthz` | — | `200 { ok: true }` — no Yahoo call, no database: "the worker accepts requests" |

Every other answer is a refusal carrying `{ error: <text> }`: **`400`** for a body that does not
parse, a symbol outside `^[A-Za-z0-9.^=-]{1,15}$`, more or fewer symbols than the bounds, a body
over 16 KB, or a method and path the table lacks; **`429`** when the endpoint's rate cap is spent
(§3.5); **`502`** with the library's message when it threw — the app maps `isMissingHistory`'s
stems to `no-history` and everything else to a provider failure; **`504`** when the worker's own
30 s watchdog expired. To the app any status but `200` is a provider failure, the thing Yahoo
failing looks like today; a *connect* failure — `ENOENT`, no socket file; `ECONNREFUSED`, a file
nobody listens on — is `ProviderUnreachable`, the batch-abort case of §3.1, and it is immediate.

The symbol pattern lives once, in `server/symbol-pattern.ts` (§3.5): the app checks it before a
call and the worker before a URL. The worker's check is the one that binds (§2.1); the app's saves
a round trip and keeps a stored symbol the app's own rule permits (length ≤ 40, any character,
`instrument-resolution.server.ts:308-312`) from costing a whole call — the offender is dropped with
a log line naming it and comes back absent (§8).

**The answer** is the library's raw result serialised as JSON — the array `quote()` returns, the
object `chart()` returns — and the app validates it on read with the schemas it has today:
`yahooQuote` (`price-provider.server.ts:244-272`) through `toProviderQuote` (`:320`), `yahooChart`
(`:400-410`) through `toProviderHistory` (`:483`). Both already accept ISO strings for every instant
— `regularMarketTime` is `z.union([z.date(), z.number(), z.string()])` (`:249`) and every bar and
split goes through `parseInstant` (`:298-310`) — so a `Date` that became a string in transit, or an
epoch number the library's best-effort coercion left alone with its own validation off (§3.5),
parses unchanged. No schema change; one end-to-end round-trip test is the pin. The worker holds no
domain logic: `matchKey`, `period1`-only, `until`, the currency guard and the ceilings are all the
app's, on its side of the call.

### 3.3 The app side: `app/lib/provider-socket.server.ts`

One primitive, `ask(kind, body, { budgetMs })`, the production budgets its defaults so a test passes
two hundred milliseconds instead of sleeping through real ones: one `http.request` over the socket
at `getConfig().PRICE_WORKER_SOCKET` with `signal: AbortSignal.timeout(budgetMs)`, the response body
read under a 2 MiB cap (a ten-year chart answer is around 300 KB; the request is destroyed at the
cap), JSON-parsed, and handed to `toProviderQuote` or `toProviderHistory`. Its outcomes, in the
order they are told apart:

- A connect failure — `ENOENT`, `ECONNREFUSED` — throws `ProviderUnreachable` ("no worker listening
  at <path>"), at once and every time, with no memory between calls.
- The budget expiring — the `TimeoutError` the signal raises — throws a plain error saying the worker
  did not answer within it: the worker is alive and the provider slow, which is what Yahoo timing
  out looks like today; `refreshQuotes` turns any throw into `providerFailed`
  (`prices.server.ts:792-800`).
- Any status but `200` throws a plain error carrying the answer's `error` text, so the ledger
  records what Yahoo said, or what the worker refused.
- `200`: the parsed body.

Budgets are per call, by kind — **quotes 15 s, history 30 s** (the worker's watchdog), **probe 10
s** (a cold worker's first probe pays a three-fetch crumb handshake, and the verdict a short budget
would lose is `non-usd`, the one a person acts on). A budget gates how long the app waits and
nothing else — never the worker's own fetch (§3.5). **Stateless**: no handle, no unreachability
flag. A dead worker costs one connect failure per call site, and a connect failure is milliseconds,
not a grace; with the batch abort of §3.1 a tick against a dead worker costs the quotes' failure and
the first history candidate's, which aborts the batch, and nothing is ledgered. Symbols are checked
against the pattern *before* the call and offenders dropped with one `console.warn` naming them; a
call of more than a hundred symbols is split at the worker's bound into consecutive asks with the
answers concatenated; an empty list after dropping is an empty answer and no call.

The socket path is configuration: `PRICE_WORKER_SOCKET` joins `configSchema`, optional, defaulting
to `/run/price-worker/worker.sock` — `server/config.ts` stays the only reader of `process.env`, and
a developer's `.env` can point it at a path under `/tmp` (§3.8).

`socketProvider(): PriceProvider` — `getQuotes(symbols)` is `ask("quotes", { symbols })`, then each
entry through `toProviderQuote`, skipping `CurrencyRefused` exactly as the adapter does
(`:719-731`); a body that is not an array is an empty answer, `probeSymbol`'s rule (`:677`).
`getDailyCloses(symbol, range, tz)` is `ask("history", { symbol: matchKey(symbol), from: range.from
})` — the adapter applies `matchKey` at `:756` and sends `period1` only (`:748-755`), both app-side
because the worker must not import `app/lib`; a refusal whose text matches `isMissingHistory`'s
stems (`:787-793`, made exportable) is `no-history`; a `200` goes through `toProviderHistory(body,
range, tz)`, which applies `until` app-side (`:541`), so nothing about `until` crosses the socket.

`socketProbe: ProbeSymbols` is built on `ask`, **not** on `getQuotes`, which cannot say `non-usd`:
one `ask("quotes", …)` for the whole batch, then `probeVerdicts` (§3.4) per symbol —
`CurrencyRefused` is `non-usd`, absent is `unavailable`, any throw is `unavailable` for every
symbol. Six new symbols against a dead worker cost one connect failure, not six; against a worker
that is alive but slow, at most the 10 s budget.

The existing `Price provider failed` stem (`prices.server.ts:796`) now carries "no worker listening
at …" for a dead worker, distinct from Yahoo failing, and the composition's batch-failed line
(`:691-694`) is one warning with the same text when the cause is `ProviderUnreachable`. The route's
three outcomes (`app/routes/refresh.ts:21-33`) and the freshness component's sentences
(`app/components/price-freshness.tsx:74-102`) are untouched: the dead-worker distinction is the
operator's, in `docker compose ps` and the worker's log. A JS-off press against an alive-but-slow
worker can block for the sum of the budgets, 15 s plus five times 30 s; today it is unbounded.

### 3.4 The prefactor (tickets 01–03, on the existing Yahoo adapter)

Make the change easy before making it. Every piece below typechecks and tests against
`yahooPriceProvider()` as it stands, so the cutover (ticket 06) becomes "swap the provider, delete
the client use". Three tickets, blocked by nothing, because the pieces share no line.

- **(01) `runRefresh({ quotes }, provider = yahooPriceProvider())` in a new domain module,
  `app/lib/refresh.server.ts`,** holds the lock, runs `refreshPrices` with the instance it was
  handed, and maps the result to the outcome the control renders, so the route, the poller's tick
  and `requestRefresh()` become thin callers — issue #159's ask, which also moves `RefreshOutcome`
  into the domain and with it the one `lib → routes` import in the tree. The market-hours gate and
  the cadence stay the poller's, as #159 requires; `PollerState.provider` stays one instance — with
  no flag to reset, nothing needs a factory. **`ProviderUnreachable`** is defined beside
  `PriceProvider`; `backfillCloses` lets it escape the per-candidate catch unchanged so the outer
  catch wraps it once (§3.1); the composition's log branches on it; the adapter never throws it.
- **(02) `ResolutionDeps.probe` becomes required and batched:** `probe(symbols) →
  Promise<Map<string, SymbolProbe>>` over one library call — over the socket each serial probe
  would be a round trip (issue #205's first item), and an empty collected list calls nothing at all,
  as the serial loop does not today — a manual-only submission must stay a submission with no
  provider call, and a zero-symbol ask is a `400` from the worker (§3.2). The default import, the
  `?? probeSymbol` fallback and `resolveAll`'s `deps = {}` default go — with a default kept,
  "required" would be a type and not a fact; the verdict logic becomes a pure exported function the
  Yahoo batch probe uses now and the socket probe later; the ingest route passes the Yahoo batch
  probe for now.
- **(03)** The two hardening rules of §3.1. The seven-day arithmetic on an `IsoDate` uses `addDays`,
  today private in `app/lib/chart-range.ts:139` and exported rather than written a fourth time.

Tests: the seams, the abort without a ledger row, the batched probe, the ceiling, the seven-day
window both ways.

### 3.5 The worker: `server/price-worker.ts` (ticket 04)

Same image, overridden entrypoint — the `dump` precedent (`compose.yaml:144-145`); an `entrypoint:`
also drops the image `CMD`, so neither `docker-entrypoint.sh`'s migration nor `react-router-serve`
runs as the worker. Its closure: `server/config.ts` (`loadWorkerConfig`), `server/yahoo-client.ts`,
`server/symbol-pattern.ts`, `yahoo-finance2`, `zod`. No `pg`, no Kysely, no `app/lib`, no
`DATABASE_URL` — the worker never sees one; the react-router edge at `app/lib/settings.server.ts:27`
→ `app/lib/masking.ts:14` is never reached, so the old spec's masking-policy ticket has no reason to
exist.

**`loadWorkerConfig(env)`**, exported from `server/config.ts` beside `loadConfig` (`:121`): the same
empty-as-unset treatment over a schema of two settings, `PRICE_WORKER_SOCKET` with the default above
and `TZ`. The worker's environment is nothing but a socket path; a `DATABASE_URL` in it is ignored,
not validated, because the worker has nothing to do with one.

**`server/yahoo-client.ts`**, new, used by the app's adapter from this ticket until the cutover so
there is one client site at every commit: `new YahooFinance({ versionCheck: false })` — the default
fetches `registry.npmjs.org` from the validation-failure path; every `quote(symbols)` and
`chart(symbol, { period1, interval: "1d", events: "split" })` under a third module-options argument
of `{ validateResult: false, fetchOptions: { signal: AbortSignal.timeout(30_000) } }`. The per-call
`validateResult: false` turns the library's own result validation off (the constructor refuses the
same key — research §3.3, exercised with a hand-broken payload), so one drifted field cannot fail a
whole `quote()` and the app's Zod is the only gate (§3.2 says why the best-effort coercion that
follows is harmless); the signal reaches `fetch` and covers the crumb handshake — the bound issue
#205 asks for, extended to `chart`, so the app's own Yahoo calls are bounded at 30 s from this
ticket on. The watchdog is the client's own and fixed, **never derived from a caller's budget**:
the crumb handshake is memoised single-flight under the *first* caller's `fetchOptions`, so a
probe's short budget handed in as a signal could abort a handshake a quotes call had joined and
fail both — which is why no budget crosses the socket at all. The client imports nothing from
`app/lib` (`matchKey` would pull Kysely in); `ChartRequest` moves with it. Ticket 04 carries the
library's `file:line`s.

**The server.** `node:http` on the socket: unlink a stale file, `listen(path)`, `chmod 0660`;
`maxConnections` 8; `requestTimeout` and `headersTimeout` 5 s; a body read to 16 KB and the socket
destroyed past it; request bodies narrowed by Zod schemas in the module, with `symbols` checked
element by element against the pattern from `server/symbol-pattern.ts` before any URL — no imports,
the only copy, shared with the app from ticket 06: the binding check of §2.1. Per-endpoint rate
caps — **quotes ten calls a minute, history twenty** — are answered `429` with one log line, because
the worker is the honest component when the app is not and a runaway app must not earn the
household a Yahoo ban. The cap's assumption, stated: a tick costs ⌈feed instruments / 100⌉ quotes
calls and at most five histories, so 300 feed instruments at the one-minute cadence floor
(`REFRESH_CADENCE_BOUNDS`, `app/lib/settings.server.ts:138`) plus a press approach the quotes cap —
honest households are far below. Every library call runs under the client's fixed 30 s signal, and
its expiry is answered `504`; any other throw is answered `502` with the message and its `cause`
appended (`${message}: ${cause?.code ?? cause?.message}`, cut to 1000 characters), since undici
says `fetch failed` for every network failure and keeps the detail there. One log line per
non-`200` answer with the reason, stem `Price worker`; a startup line naming the socket path;
nothing per successful call. `startWorker({ socketPath, yahoo })` returns the listening server for
the tests, and an `import.meta.main` guard keeps it from starting on import (Node ≥ 24.2;
`undefined` under vitest — research note §5.3).

**Health** is the container healthcheck doing `GET /healthz` over the socket with `node -e` and a
5 s timeout: it proves the worker accepts requests — a listener now exists to ask — and nothing
about Yahoo, `app/routes/healthz.ts:9`'s reason. No timer, no settings, no database: startup needs
nothing to exist but the volume, so the service declares no `depends_on`. Nothing restarts an
unhealthy container (research note §1.7); the check is for `docker compose ps` (ticket 05 has it).

**Tests** need no database and no committing handle — the transport is not the database. They start
the real server on a temporary socket path with a fake Yahoo client and speak to it: each status
mapping, the connect failure → `ProviderUnreachable`, the body cap, the rate cap, the watchdog →
`504`, a pattern violation → `400` with no library call, chunking over a hundred, and the probe
verdicts; the round trip `refreshPrices(socketProvider(), …)` runs inside `withDatabase`. Ticket 04
lists the worker's cases and ticket 06 the app side's; the client's own surface gets
`tests/yahoo-client.test.ts`, and the adapter's cases stay until ticket 06 deletes the adapter.

### 3.6 Topology (tickets 05 and 07)

```yaml
networks:
  backend:    { internal: true, enable_ipv6: false, driver_opts: { com.docker.network.bridge.gateway_mode_ipv4: isolated } }
  caddy-app:  { internal: true, enable_ipv6: false, driver_opts: { com.docker.network.bridge.gateway_mode_ipv4: isolated } }
  caddy-gate: { internal: true, enable_ipv6: false, driver_opts: { com.docker.network.bridge.gateway_mode_ipv4: isolated } }
  egress-worker: { enable_ipv6: false }   # until ticket 08, which replaces it with worker-proxy (internal + isolated)
  egress-gate:   { enable_ipv6: false }
  ingress:       { enable_ipv6: false }

volumes:
  price-worker-sock: { driver: local, driver_opts: { type: tmpfs, device: tmpfs, o: "size=1m,uid=1000,gid=1000,mode=0770" } }

services:
  db:     { networks: [backend] }
  dump:   { networks: [backend] }
  app:    { networks: [backend, caddy-app], volumes: [price-worker-sock:/run/price-worker] }   # no route out
  worker: { networks: [egress-worker],     volumes: [price-worker-sock:/run/price-worker] }   # the internet and the socket, nothing else
  gate:   { networks: [caddy-gate, egress-gate] }
  caddy:  { networks: [caddy-app, caddy-gate, ingress] }
```

`internal: true` removes the default route and drops forwarded traffic to and from other networks; a
per-service `networks:` list detaches the service from the implicit `default` bridge.
`gateway_mode_ipv4: isolated` closes the escape an internal bridge otherwise keeps — an address on
the host, through which a container reaches every host service bound on `0.0.0.0`: a house-wide
reverse proxy, SSH, a resolver on `:53`. **Engine floor 28.0, hard — declared at ticket 05, where
the worker arrives, and load-bearing from ticket 07, where the first isolated network does**: 26
has no such option and its label parser has no default branch, so the option is *silently ignored*
and the hole stays open with every other assertion passing; 27 refuses it loudly (ticket 05 names
the check). `enable_ipv6: false` is written on every network: unset, Compose sends a nil and the
daemon's default decides. A Compose floor stands beside the Engine floor, because the reconciler's
behaviour is load-bearing for ticket 08: Compose recreates a network whose definition drifted only
when it recorded a config hash on the live network, and leaves one with no recorded hash untouched
(research §1.11) — which is why 08 introduces a new network name rather than changing
`egress-worker` in place.

`caddy-app` and `caddy-gate` are kept apart so that `compose.yaml:257-260`'s invariant — the sidecar
believes `X-Forwarded-*` from whatever reaches it, so "only Caddy can" has to hold — becomes true
for the container the slice distrusts most; on today's default bridge `app` reaches `gate:4180`
directly. `worker` shares no network with `app`, `gate` or `db` — requirements 3 and 5 by
construction, asserted by name *and by IP*: a name failure proves only DNS scoping, and Engine 28's
block on direct routed access to unpublished ports is what the IP test proves. The volume is the
worker's only link to the stack, and a volume carries no route.

One install does not fit the lists: `DATABASE_URL` may name a LAN or remote Postgres, and `app` on
internal networks only has no route to it, so the release that lands the topology also lands
`compose.external-db.yaml` (ticket 07) — a single plain bridge, `external-db`, attached to `app`
and to nothing else; the worker needs no database route, holding no credential, and `dump` stays
off it, an outside Postgres being backed up by its own operator (`docs/operating.md:195-197`). That
mode is a stated relaxation, not a variant of the same guarantee: requirement 1 is **off for
`app`**, whose bridge now carries a default route, and what remains is requirement 3 by
construction and requirement 5, `worker` still sharing no network with `app` or `gate`. Its upgrade
note is `-f compose.external-db.yaml` before `up -d`, on every compose command after it.

What isolation does not give: any container with a route to the host reaches the host's *published*
ports, so until ticket 08 the worker reaches Caddy's `:80` through its egress bridge — the app
*through the gate*, never `app:3000` or `gate:4180` — and the gate's OAuth callback relays
attacker-chosen bytes to Google (§8). After ticket 08 that route closes for the worker too.

Smoke asserts effects, not flags, and reads the daemon's own record where the effect cannot be
provoked: under `isolated` no gateway address is allocated at all (research §1.2), so a connect to
the empty IPAM field would fall back to localhost and pass for the wrong reason on the very engines
the floor admits. From `app` it makes the one positive assertion the channel allows — `GET
/healthz` over `/run/price-worker/worker.sock` answers `200` — which proves the volume, the uids
and the mode line up in the built image. §5 lists the assertions; tickets 05 and 07 carry the
commands, their timeouts, and the `depends_on` fact (evaluated by the Compose CLI over the Docker
API, so no shared network).

**Passwords stop travelling in URLs** (ticket 07). Compose sets `PGPASSWORD` per service and the two
`DATABASE_URL` defaults (`compose.yaml:126`, `:204`) carry user and host only: `pg` 8.23, libpq and
`pg_dump` read `PGPASSWORD` when the URL has no password (research §4.1, `pg_dump` included;
`scripts/dump-loop.sh:95`'s host extraction reads a password-less URL), and `config.ts`'s URL check
accepts the form. A URL password still wins over the variable, so `.env.example:23`'s explicit URL
line is removed and the upgrade runbook says "drop your `DATABASE_URL` line" — a stale `.env` would
otherwise crash-loop with `password authentication failed` after doing everything the runbook said.
Every runbook that introduces a `${VAR:?}` writes `.env` **first**: interpolation runs before every
compose command, `exec`, `ps`, `logs` and `down` included (research §1.9), so the `alter role` step
through `docker compose exec db psql` is reachable only once the variable exists. No password
alphabet, no validation code; ARCHITECTURE.md §4.2's env-reader row (`:345`) gains the driver's own
`PGPASSWORD` and the runtime's own `NODE_USE_ENV_PROXY` and `HTTPS_PROXY`. The worker sets none of
them: it has no database, and the proxy pair is ticket 08's.

### 3.7 The egress allowlist (ticket 08, required)

It is what makes "Yahoo Finance and nothing else" true, and until it lands the worker's egress
bridge also reaches the household LAN — the NAS, the router's admin page, the devices the gate
exists to distrust. `server/egress-proxy.ts` is about a hundred and fifty lines of `node:http`,
`node:net` and `node:dns`, with tests: `CONNECT` only, to exactly the hosts the pinned library
contacts — `query1.finance.yahoo.com`, `query2.finance.yahoo.com`, `finance.yahoo.com`,
`guce.yahoo.com`, `consent.yahoo.com` — never `*.yahoo.com`, because a mail or login host inside a
`CONNECT` tunnel is a full exfiltration channel, and never an IP literal. The host in the `CONNECT`
line is not enough on its own: every one of those five resolves to the same two addresses as `mail`,
`login` and `www.yahoo.com` (research §3.1), and the edge routes on the TLS server name the *client*
sends, so a tunnel opened to `finance.yahoo.com` carrying a ClientHello for `login.yahoo.com`
reaches the login property through an allowlisted tunnel. The proxy therefore checks the `CONNECT`
host against the allowlist first and answers a host not on it `403`; otherwise it writes the `200`,
*then* reads the ClientHello, and fails closed on anything but one well-formed hello carrying
exactly one `server_name` equal to the `CONNECT` host, logging both names. The order is not a
preference: probed on Node 24.20 under `NODE_USE_ENV_PROXY=1`, the client sends no bytes whatever
before the `200` — the `'connect'` event's `head` is empty — and the hello's first byte (`0x16`)
follows it, so a proxy that waits for a hello before answering deadlocks every honest tunnel. Two
facts decide whether the rest flakes: a client that *does* pipeline after the `CONNECT` line leaves
those bytes in `head`, so the record buffer is seeded from `head` and filled from the socket after
(a handler reading either alone fails, open or shut); and a hello can span segments, so the proxy
buffers to the record header's declared length, capped at 16 KB, and tears down on end-of-stream or
the cap. A refusal on the hello destroys the socket rather than answering — the `200` is written by
then — so the worker sees a TLS failure and never a `403`. It refuses a destination that resolves to
a loopback, link-local or private address, the guard written family-agnostic (`::1`, `fe80::/10`,
`fc00::/7` too) although the lookup asks for IPv4 only, the bridges having IPv6 disabled — so a LAN
resolver, ADR-0005's adversary, pointing `finance.yahoo.com` at a LAN box cannot make the proxy a
pivot for a worker that skips certificate checks. The concurrency bound is on **accepted sockets,
not tunnels** — a socket that never sends a valid hello never becomes one — so it is
`server.maxConnections = 8` for a socket's whole lifecycle, with a 5 s deadline on each stage that
waits on the peer (request line and headers, the ClientHello read, the DNS lookup) and the 60 s idle
teardown on an established tunnel: a hostile worker's denial is of price refresh, and bounded (§8).
The list is a module constant — a fact about the pinned library, not operator configuration, so the
proxy reads no environment; when Yahoo moves a consent host the proxy log names the refused
`CONNECT` and the fix is a release.

Same image, another entrypoint, node built-ins only: a payload that is never imported never runs, so
the proxy is the one piece of the shared image the npm tree cannot reach. Compose: a **new**
internal, isolated network, `worker-proxy`, replaces `egress-worker` (§3.6 says why a new name;
ticket 08 has the service and the worker's `NODE_USE_ENV_PROXY`/`HTTPS_PROXY` pair). The binding
property is the network, not the environment flag, which compromised code ignores: smoke stops the
proxy and asserts the worker's fetch then fails, asserts a non-allowlisted host is refused through
it, and asserts a tunnel to an allowlisted host whose ClientHello names `mail.yahoo.com` is torn
down; the positive fetch through the proxy is best-effort, skipped where the CI host cannot reach
Yahoo. With no non-internal network the worker also has no resolver: hostnames travel inside
`CONNECT` and the proxy resolves them, so DNS exfiltration from the worker is gone; §8 states the
bound after 08. Docker has no native egress policy, and a third-party proxy image would add an
unaudited supply chain to a slice about supply chains. A stopped proxy has its own signature (ticket
08): `docker compose ps egress-proxy` unhealthy, every worker failure of that minute carrying `fetch
failed` with one cause.

### 3.8 Image, development, tests

One image, a second and a third entrypoint — the `dump` precedent, and an owner-accepted trade; the
prune script never removes a declared package (`scripts/prune-unreachable-deps.mjs`'s own header),
so there is no prune change, and a worker-only stage pruned to the worker's closure is the named
follow-up, not done here. The runtime stage copies `server/` files by name (`Dockerfile:104-110`),
so the worker, the client, the pattern module and the proxy are each added explicitly. The compose
file is the operator's own copy (`docs/operating.md:962-965`), so every release that changes it
says so in its upgrade note, with the symptom of forgetting (§6).

Development: `npm run dev` is unchanged; `.env` gains `PRICE_WORKER_SOCKET=/tmp/portfolio-worker.sock`
(Vite reads `.env`, `docs/developing.md:564-571`), and a second terminal runs `node
--env-file=.env.worker ./server/price-worker.ts` with `.env.worker` holding that one line — no
database URL, no password, nothing the superuser's `.env` (`:56-60`) has, because the worker needs
none of it. Ticket 06 lands the recipe, because from it a checkout without a worker has stored
prices only, a refresh that logs "no worker listening at /tmp/portfolio-worker.sock", and ingest
probes `unavailable` at once with the instruments created anyway. **No in-process fallback mode** —
a second code path would keep the Yahoo import reachable from the app and give the property an off
switch.

Tests: nothing in this slice needs a committing handle. The worker's tests and the app side's speak
to a real server on a temporary socket path with a fake client and never touch the database; the
end-to-end JSON round trip through `refreshPrices` runs inside `withDatabase`, so its `price_poll`
row rolls back with everything else and no cleanup counts rows. The one process-wide read to mind:
`getConfig()` memoises, so a test that needs the socket path sets `process.env.PRICE_WORKER_SOCKET`
before the first import that reaches it (`tests/price-poller.test.ts:37` is the precedent, for
`DATABASE_URL`).

## 4. Tickets

One ticket is one pull request that typechecks, builds and tests standing alone, and every one
leaves a deployable main: after 05 the worker runs beside the still-fetching app, listening, idle
and healthy; 06 is the single release where the app stops fetching, and 07 the one where it loses
its route. There is no commit from which a deploy has no price refresh.

Every ticket carries `ready-for-agent`, in the vocabulary of `docs/agents/triage-labels.md` (`:9`):
§2.5 is answered, so no ticket waits on a decision any more. The spec's own status stays `proposed`
until the owner approves this rewrite.

| # | Ticket | Blocked by |
|---|---|---|
| [01](price-worker/01-one-refresh-and-the-batch-abort.md) | `runRefresh` with three thin callers; `ProviderUnreachable` and the batch abort (§3.1, §3.4) | Nothing |
| [02](price-worker/02-the-batched-probe.md) | The required, batched ingest probe (§3.4) | Nothing |
| [03](price-worker/03-the-two-hardening-rules.md) | The price ceiling as a write-abort guard and the seven-day window on the quote path (§3.1) | Nothing |
| [04](price-worker/04-the-price-worker-process.md) | `server/yahoo-client.ts` (the app's adapter uses it from here), `server/symbol-pattern.ts`, `server/price-worker.ts` — the socket server — and `loadWorkerConfig`; their tests; the Dockerfile copy set; ARCHITECTURE.md §4.2's import-site row (§3.2, §3.5) | Nothing |
| [05](price-worker/05-deploy-the-worker-alongside.md) | Deploy alongside: the volume, the `worker` service on `egress-worker`, `app` mounting the volume, the socket healthcheck, the Engine floor, the dev override, the upgrade note, smoke (§3.6, §3.8) | 04 |
| [06](price-worker/06-the-app-cutover.md) | App cutover: `provider-socket.server.ts`; poller, route and ingest on the socket; the adapter loses its client; round-trip, route and probe tests; the developer's recipe (§3.3, §3.8) | 01, 02, 03, 05 |
| [07](price-worker/07-the-network-lockdown.md) | Lockdown: the full topology and the `compose.external-db.yaml` override, `POSTGRES_PASSWORD` required, `PGPASSWORD` for `app` and `dump`, the upgrade runbook, smoke egress, DNS and isolation assertions (§3.6) | 06 |
| [08](price-worker/08-the-egress-allowlist.md) | The egress allowlist proxy with the SNI check, on a new network (§3.7) | 07 |
| [09](price-worker/09-documents-and-runbooks.md) | The record: DESIGN.md, ARCHITECTURE.md, ADR-0010, CONTEXT.md, the runbooks (§6) | 08 |

01 ∥ 02 ∥ 03 ∥ 04; 04 → 05 → 06 (needs 01, 02, 03) → 07 → 08 → 09.

## 5. Acceptance (slice level)

- From `app`, `db` and `dump`: a bounded outbound `fetch` to a public host fails; `timeout 5
  nslookup example.com` fails; `/proc/net/route` holds no default route; each isolated network shows
  an empty IPAM `Gateway` in `docker network inspect` and no `inet` on its host bridge; the smoke
  script refuses to run on an Engine below 28. From `worker`: `app:3000`, `gate:4180` and `db:5432`
  are unreachable by name and by IP; a public host resolves until ticket 08, and after it the
  worker's fetch fails with the proxy stopped, a non-allowlisted host is refused through it, and an
  allowlisted tunnel whose ClientHello names another host is torn down.
- From `app`, `GET /healthz` over `/run/price-worker/worker.sock` answers `200`: the worker accepts
  requests *in the built image*, and its own healthcheck reports healthy under `docker compose ps`.
- **Refresh now** round-trips through the socket on every screen that carries it, JavaScript off
  included (blocks, then redirects). Against a dead worker it reports `providerFailed`, the log
  carries the "no worker listening" text once, the press costs a connect failure — immediate, never
  a grace — and `price_backfill` gains no row.
- At ingest a non-USD symbol still refuses with nothing written, an unavailable one is still created
  anyway, and a dead worker costs one connect failure per submission (at most the 10 s budget when
  the worker is alive but slow), not one per symbol — and nothing at all for a manual-only
  submission, which asks no provider call.
- A quoted price at the ceiling is dropped and the instrument goes stale; a quote whose market date
  is eight days old, or eight days ahead, rewrites no close and inserts none — and is not counted in
  the report's `closes` either — while one seven days old does both. A worker asked for its
  eleventh quotes call in a minute answers `429` without a call; a body naming `BRK/B` is answered
  `400` without a call; a library call that outlives the 30 s watchdog is answered `504`.
- The worker's closure holds no `pg` and nothing under `app/`, and `grep` over `/app/build/server/`
  in the image finds no `yahoo-finance2`.
- A fresh `docker compose up` with `POSTGRES_PASSWORD` set — including via the documented `cp
  .env.example .env` — comes up healthy end to end; without it it fails at interpolation naming the
  variable and pointing at `operating.md`. No other new variable is required of the operator.
- A restore onto a fresh cluster needs nothing this slice added — no role, no grant, no bootstrap —
  and the worker may keep running through it.
- `npm run typecheck`, `npm test`, `npm run build` and `scripts/smoke-test.sh` green.

## 6. Documentation deltas

Ticket [09](price-worker/09-documents-and-runbooks.md) carries the line-level list; the promise:

- **`DESIGN.md`** — the Job-scheduler row and §10.1 rewritten with why the trade flipped; the
  services block gains `worker` and `egress-proxy` (and `dump`, missing today) and the volume; the
  environment table (`PRICE_WORKER_SOCKET`), §6.2 (the socket: what crosses it, and that the worker
  holds no rule) and §14 (the limitations §8 names).
- **`ARCHITECTURE.md`** — §2's external dependencies (the gate needs `www.googleapis.com:443` only,
  Caddy no egress); §4.2's single-site rows (the import site in `server/yahoo-client.ts`; no second
  pool, the worker having none) and the env-reader row (`PGPASSWORD`, `NODE_USE_ENV_PROXY`,
  `HTTPS_PROXY` — the driver's and the runtime's, never application code's); §7's stems, what each
  healthcheck proves, the seam with two implementations, the networks, the volume and the
  three-entrypoint image; the appendices.
- **ADR-0010**, "Price fetching is an egress-isolated worker behind a unix socket": context; §2.3's
  disqualification in one sentence; decision (remote provider; a socket in a shared tmpfs; HTTP/1.1
  over it with the library's raw JSON as the whole contract; no credential, no TCP listener;
  passwords out of URLs); consequences (the deploy-time batch abort, no new UI state, one required
  variable, a shared image safe to restart independently because the socket plus raw JSON is the
  whole contract); alternatives rejected — §7's list, the mailbox of §2.5 first and with its cost.
  **ADR-0011 and spec 0017** keep the "spec 0015" banner landed with this document, re-read, nothing
  else rewritten.
- **`CONTEXT.md`** — **Price worker** and **Worker socket**, with "queue", "job table", "sidecar
  API" and "RPC" among the words to avoid.
- **`docs/operating.md`** — the Engine and Compose floors with their checks; bring-your-own Postgres
  (`compose.external-db.yaml` for `app` and exactly what that mode loses, landed by ticket 07;
  nothing about roles — the worker needs none); generated passwords mandated; `PGPASSWORD` and the
  URL rule; `.env` before any compose command; the numbered upgrade runbook, the rollback note, and
  "replace `compose.yaml` before `up -d`" with the symptom of forgetting; the restore path — `stop
  app` stays the first line, and the worker may keep running, since it holds no connection; the
  fifth and sixth causes of a missing price line; what each healthcheck proves.
- **`docs/runbook.md`** and **`docs/developing.md`** — the `up` refusal covers `ps`, `logs` and
  `down`; "prices have stopped" starts with `docker compose ps` for three containers; the rotation
  recipe loses its URL half; the restore entry says the worker may keep running; the `.env.worker`
  recipe (landed by ticket 06), the without-a-worker behaviour, and where the split verification now
  runs.
- **`README.md`**, `server/db.ts`'s pool comment and the poller's header — ticket 09's;
  `docs/specs/README.md`'s row landed with this spec and is re-checked there. `docs/data-model.md`
  is untouched: this slice adds no table.

## 7. Out of scope

- **Worker supply-chain decorrelation** — the named follow-up: a worker-only image stage with its
  own `package.json`, and a hand-rolled fetch of the two endpoints behind the same Zod schemas.
- Moving the app off the `portfolio` superuser — opened by this slice, not done in it.
- A UI state for a dead worker; issue #202's decision; issue #194; a repository `pg_hba.conf` with
  pinned subnets; a cap on `archived()` entries; host `DOCKER-USER` rules; a gVisor runtime; any
  auth change (ADR-0005 stands); the three private copies of `inTransaction`
  (`prices.server.ts:741`, `instrument-resolution.server.ts:237`, `uploads.server.ts:571`) — this
  slice needs none of them and adds no fourth.
- **Rejected, recorded for ADR-0010.** The **mailbox** of §2.5 — a Postgres table as the channel,
  the worker logging in under a minimal role — on cost: every item in §2.5's list existed to make a
  database login safe for the internet-facing container, and the socket removes the login. With it
  go the things that only made sense for it: `LISTEN/NOTIFY` (no reconnect in `pg`, unqueued, needs
  a poll anyway), RLS for first-write-wins, a per-operation unreachability handle, `pg_dumpall
  --roles-only` in the dump service. The **heartbeat-file healthcheck** — a file the loop touched,
  its age asserted by busybox — superseded by `GET /healthz` over the socket: there is a listener
  now, and asking it proves more than a timestamp does. A **TCP listener on an internal network**
  in place of the socket file: reachability on a bridge is symmetric, so the worker would reach
  `app:3000`. A **start-up refusal** in the image against `up -d` under a stale `compose.yaml` — it
  couples the app's start to the deployment's shape; the upgrade note carries the case instead.
  And, unchanged in reason: the worker owning the refresh (§2.3), a worker-unresponsive UI state, IP
  pinning, a separate image now, an in-app fallback mode, a third-party proxy image.

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
- **The observation archive.** The app's 2 MiB body cap bounds one answer, not the archive: a worker
  varying `regularMarketTime` archives up to 2 MB per instrument per refresh forever through
  `archived()` (`prices.server.ts:1015`). A cap there is the cheap follow-up, named and not done.
- **What the worker and Yahoo learn**: the symbols and the history ranges (about first-held less
  seven days), as today — and nothing else, the worker holding no credential with which to read
  even the shape of the household's data.
- **The channel from a compromised app**, stated as a rate: ten quotes calls a minute × a hundred
  symbols × fifteen bytes, about 15 KB a minute of symbol-shaped text through an honest worker to
  Yahoo's query logs or an on-path observer, plus twenty history calls of one symbol each.
- **Correlated compromise** until decorrelation: bounded by ticket 08 to what Yahoo's edge serves
  under a server name the proxy has matched to the `CONNECT` host, readable back only through a
  feature on that property that reflects bytes; an in-TLS `Host:` naming another property under a
  wildcard certificate is the edge's to route, and if the edge ever accepts an encrypted ClientHello
  the check degrades to host-only.
- **The shared tmpfs.** The app and the worker share a 1 MiB tmpfs: a compromised app can unlink or
  replace the socket file, or fill the volume — a self-inflicted refresh outage, nothing more; a
  compromised worker can do the same from its side, denial only, the app's mount namespace holding
  nothing else to redirect it to.
- **The worker's parser.** A compromised app can push arbitrary bytes at the worker's `node:http`
  parser — body capped at 16 KB, connections capped at 8, 5 s to send a request — the trust
  direction §2.5 accepted; and it can spend the rate caps, a self-inflicted stale-prices
  outage. The egress proxy is the same class of target, which is why its cap counts
  **accepted sockets, not tunnels**: a worker leaking sockets degrades it up to the per-stage
  deadlines, the idle timeout and that cap (§3.7) — a denial of price refresh, never of household
  data.
- **A compromised worker can poison answers and deny service**, exactly as before; it can no longer
  touch the database at all — the advisory-lock freeze, the temp-file and large-object fills,
  connection-slot exhaustion, un-claiming, metadata reads and password brute-force that a
  credential admitted are gone with it.
- **The app is still the superuser**; nothing in this slice narrows it, and the follow-up is §7's.
- **A worker outage is stale prices**, surfaced in the log and the as-of line, at the per-tick cost
  §3.3 states — a connect failure — and with nothing ledgered, so the retry clock is not charged
  for it.
- **Routes that stay open**: Caddy keeps an unused route; the published `:80` stays reachable
  through the host from the gate's and Caddy's networks, and from the worker until ticket 08; the
  gate's OAuth callback relays bytes to Google.
- **Symbol-length mismatch** — 40 characters app-side, 15 in the pattern: a legitimate stored symbol
  outside the pattern never refreshes and shows stale, with a log line naming it.
- **Engine below 28 is silently weaker**, and the smoke test runs in CI, not on the operator's box;
  **version skew** across an `up -d` under one floating tag is at most one release, and harmless
  because the socket plus raw JSON is the whole contract.
