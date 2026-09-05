# 0018 — The price worker: a remote provider behind a unix socket

> Supersedes the unindexed `docs/specs/0015-price-worker.md` (commits `791ea71` and `4bfe44e`),
> deleted with this spec; §2.3 records why its shape no longer fits. Read
> [ADR-0011](../adr/0011-a-backfill-fills-the-spine-but-never-moves-it.md) first: the worker has
> to serve the refresh that ADR shapes, and that shape is what rules the old plan out. §2.5 records
> the owner's decision on the channel between app and worker, taken on 2026-09-04.

**Status:** approved 2026-09-04 (§2.5 decided by the owner; the merge of the rework is the
approval) · **Slice directory:** [`price-worker/`](price-worker/) · **ADR:** 0010 (reserved for
this slice; unwritten — ticket [09](price-worker/09-documents-and-runbooks.md) writes it)

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
between them is a channel, and it is honest to say what kind: one HTTP request one way and one JSON
document the other, validated on read with the schemas the app validates Yahoo's answers with (§3.2).

- **A compromised app, honest worker.** After the slice: no socket to anywhere but the worker's. It
  can hand symbol-shaped strings to an honest worker to send to five Yahoo Finance hosts, at a rate
  the worker caps (§3.5) — the worker re-validates every symbol before it touches a URL, and that
  check is the one that binds, the app's own copy being compromised code's to skip — push arbitrary
  bytes at the worker's `node:http` parser within the bounds §3.5 sets, and relay bytes to Google
  through the gate's OAuth callback. What remains is a channel stated as a rate (§8). It remains the
  superuser; that follow-up is named in §7, not done here.
- **A compromised worker, honest app.** The price feed's input, which the app treats as it treats
  Yahoo: shape-checked, currency-guarded, bounded above, and — new here — unable to write a close
  more than a week from today through the quote path or a bar before the asked range through the
  history path (§3.1); truth is unverifiable, and §8 says what a lying feed can still do. It holds
  no database credential and shares no network with `db`, so it can read nothing there and degrade
  nothing there; what it can withhold is answers. Until ticket 08 it has unrestricted internet *and*
  the household LAN.
- **Both, correlated.** One image and one npm tree serve both ends of the socket, and the symbol
  pattern is compromised code's to ignore at either end — which is why ticket 08 is required, not
  optional. The worker's rate cap binds an honest worker only, so after 08 the proxy's socket cap
  and stage deadlines (§3.7) are the sole bound and the DNS channel is closed, the proxy resolving
  only exact allowlisted names: what leaves is what Yahoo's edge serves under a TLS server name the
  proxy has matched to the `CONNECT` host. Removed only by the decorrelation follow-up (§7).

### 2.2 What exists today (verified against the tree)

One refresh entry point, `refreshPrices(provider, marketTimeZone, { quotes }, db)`
(`app/lib/prices.server.ts:666-703`) — quotes, then one bounded backfill batch whose candidate
selection joins `holding` and `position_set` (`:300-301`) — held under `withRefreshLock` by three
callers: the poller's tick, **Refresh now** and the post-commit request. One provider seam,
`PriceProvider` (`app/lib/price-provider.server.ts:155-162`), that every test fakes; one library
client, taking no options (`:617-624`), at the single import site ARCHITECTURE.md §4.2 records
(`:338`). A serial, defaulted ingest probe. Five services, no custom networks, superuser URLs with a
default password. Each ticket cites the lines it touches: 01–03 the seam's, 04–08 the deployment's,
09 the documents'.

### 2.3 Why the previous plan's shape no longer fits

`docs/specs/0015-price-worker.md` landed in `791ea71` and gained its six tickets in `4bfe44e`;
neither commit touched `docs/specs/README.md`, so it was never indexed, and its number collided with
`0015-chart-series-assembly.md` (`docs/specs/README.md:43`). It is deleted with this spec.

Its shape was that the worker *owns the refresh*: `refreshQuotes` moves into the sidecar, with a
column-level grant list over six price tables. Spec 0017 changed the ground under it: a refresh is
now quotes **and** a backfill batch whose candidate selection joins `holding` and `position_set`
(`prices.server.ts:300-301`) — exactly the tables requirement 3 forbids the worker. A worker that
owns the refresh needs those tables, or a `SECURITY DEFINER` window onto them that leaks first-held
dates; a worker that is only a provider needs none of them. Not a trade, a disqualification, and it
decides a question the old spec left open: **selection of what to fetch — quotes and backfill alike
— is the app's, never the worker's.** Issue #202 (should the poll stop fetching instruments nobody
holds?) is the same rule seen from the other side: its fix reads `holding_valued`, and it stays an
app-side decision under any channel. The old spec's threat model and residuals are the ancestors of
§2.1 and §8, which restore what it dropped or understated.

### 2.4 Decisions this slice reverses, and the invariants it keeps

Reversed, each edited in place by ticket 09 with the reason beside it: DESIGN.md §10's **Job
scheduler** row and §10.1's "the in-process scheduler is why there is no separate worker service" —
security was not an input to that trade and is now the deciding one; the scheduler stays
in-process (§3.1), what moves is the fetch. `compose.yaml`'s header, which argues against a worker
and promises every non-gate setting a default — one more variable now has none. `README.md`'s
"there is no worker container" and the poller's header. ADR-0011's "nothing is shaped for spec
0015's worker" — reversed exactly as it foresaw; it and spec 0017 name "spec 0015" meaning the
deleted proposal, and a one-line banner landed with this spec says so in each.

Preserved, and asserted by the tests this slice adds: **the single sites of ARCHITECTURE.md §4.2**
— pool construction stays `server/db.ts:createPool` (the worker constructs none), the
`yahoo-finance2` import moves once, to `server/yahoo-client.ts`, with exactly one importer at every
commit (§3.5), the price writer stays `app/lib/prices.server.ts`, untouched in what it writes, and
`server/config.ts` stays the only reader of `process.env`, the driver's own `PGPASSWORD` and the
runtime's own `NODE_USE_ENV_PROXY`/`HTTPS_PROXY` stated rather than smuggled; **history is
append-only** — no table, no writer, the worker writes no row and reaches no ledger except through
the seam, which writes what it always wrote; **ADR-0005** — the gate keeps its Google egress and
nothing about authentication changes.

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
as the evidence of what that cost would have been, and its §8 is the evidence under the socket.

## 3. Design

### 3.1 The seam

`PriceProvider` (`app/lib/price-provider.server.ts:155-162`) is already injected into
`refreshPrices`, `refreshQuotes`, `backfillCloses` and the poller, and every test fakes it. The
app-side half of this slice is one more implementation, `socketProvider()`, that asks the worker
instead of the library. Untouched: `refreshQuotes`, every price write, ADR-0011's rules,
`withRefreshLock`, `price_poll` and the observation log — nothing the worker can do reaches them
except through the seam.

Five deliberate touches to the rules, each stated here because "untouched" would otherwise be a
lie. Four harden the app against a hostile provider, which the seam now has to assume; ticket 03
carries their lines and tests:

- **A price ceiling in `toProviderQuote`**, `PRICE_CEILING = 10 ** 16`, a sibling of `RATE_CEILING`
  and `CLOSE_CEILING`: `quote.price` is `numeric(20, 4)`, so a figure of sixteen integer digits
  aborts the statement and with it the whole refresh transaction — every instrument stale for one
  bad symbol. Dropped, not clamped, so the symbol comes back absent and goes stale. The reader's
  `quantity × price` product is §8's residual.
- **The quote path refuses to write a `price_daily` close whose market date is more than seven days
  from today's, either side.** `writeDailyClose` upserts on `(instrument_id, date)` keyed by
  `regularMarketTime`, so a hostile quote rewrites any past day's close and a future one plants a
  close on a day to come — permanent when that day is a weekend or holiday the poller never
  overwrites; ADR-0011's immutability covers only the backfill writer. The quote and the observation
  still land, and the day is left ~~to the backfill, which is ledgered and split-aware~~ **usually
  absent** — **corrected while building [03](price-worker/03-the-three-hardening-rules.md):** a
  skipped *past* day is filled by a later batch only while the instrument is still a candidate (*no
  close at or before first-held*); a skipped *future* day no batch reaches, its range ending today.
  `holding_valued_at` carries the previous close across it, as it does across any non-trading day.
  Seven because that is the lag an honest NAV or holiday quote can carry, and it is
  `BACKFILL_RANGE_LEAD_DAYS`.
  `writeDailyClose` reports whether it wrote, so `RefreshReport.closes` excludes a skipped write.
- **`toProviderHistory` drops a bar dated before `range.from`**, as it drops one at or past
  `range.until` — today the only cut. `writeBackfilledCloses` inserts where absent, so one hostile
  bar dated 1971 lands, and the gap predicate `NO_CLOSE_BY_FIRST_HELD` (`prices.server.ts:280-285`)
  is satisfied by any row at or before first-held: that one row takes the instrument out of the
  candidate set for good while the ledger says `filled`, the real gap is never filled, ADR-0011
  forbids the overwrite, and the recovery is `psql`. An honest answer never carries a bar before
  `period1`, so the cut costs nothing.
- **`archived()` stores nothing over 32 KB.** The observation log keys on `(instrument_id, as_of)`
  and inserts where absent, so a worker varying `regularMarketTime` adds a row per instrument per
  tick, and uncapped each row could carry the whole of the client's body cap. An honest quote entry
  is 2–4 KB; past the cap the payload is `null` — "treated as absent" by the function's own contract
  — with one warn line, and the quote and the observation still land.

One serves the ledger: **`backfillCloses` aborts the batch without ledgering when the provider was
unreachable.** Today a throw from `getDailyCloses` is ledgered `provider_failed` and the loop
continues (`:568-587`), after which the retry clock (`:98`, `:306-316`) skips the instrument for a
day. With a worker that restarts independently of the app, "unreachable at tick time" becomes a
deploy-time event, and ledgering it would defer up to five candidates a day for a worker that was
back a minute later. A named `ProviderUnreachable` (§3.4) escapes the per-candidate catch unchanged;
the existing outer catch (`:630-634`) wraps it once in `BackfillBatchFailed` (`:501-509`) with the
partial report, exactly as for a database error today; the composition's catch (`:688-702`) sees the
cause and the ledger holds nothing for that tick.

### 3.2 The channel

**The volume.** A Compose named volume, `price-worker-sock`, on the local driver as a tmpfs —
`driver_opts: { type: tmpfs, device: tmpfs, o: "size=1m,uid=1000,gid=1000,mode=0770" }` (research
note §8.1: the keys pass through to `mount -t tmpfs`, and the exact string was mounted and read
back) — mounted at `/run/price-worker` in `app` and in `worker`, and nowhere else. Both run as uid
1000, the image's `node` user (research §8.4), so the socket file the worker creates at `0660` in
the `0770` directory is connectable by uid 1000 or gid 1000 — and by root, which `CAP_DAC_OVERRIDE`
admits regardless (research §8.5). The mode is not the fence, the app owning the directory: the
fence is the mount set — only `app` and `worker` mount the volume, `gate` mounts nothing, `dump`
only `./volumes/dumps`, no container shares a network, PID or IPC namespace with the worker — and,
on the host, a data root only root traverses (research §8.5). `driver_opts` are read once, at
creation, and a name-matched volume is reused untouched afterwards (research §8.2): a release that
changes the option string changes the volume's *name*, as ticket 08 does for the network, never
asking for `down -v`, which removes `db-store`'s record with it. Each container's `read_only` root
is untouched; a megabyte holds a socket file with room for nothing worth keeping.

**The socket.** `/run/price-worker/worker.sock`, created by the worker at start: a stale file
unlinked first (`EADDRINUSE` otherwise, research §8.8), then `listen(path)`, then `chmod 0660` —
`listen` creates the file at `0777 & ~umask`, 0755 under the image's 022, and takes no mode
(research §8.6). A failed unlink or listen — `EISDIR` then `EADDRINUSE` on a directory squatting the
path, `ENOSPC` with the volume's inodes spent — is logged with the path and the code and exits
non-zero, so the crash loop under `restart: unless-stopped` is visible in `docker compose logs
worker`; `SIGTERM` closes the server, which removes the file, so a stop is immediate and the app
sees `ENOENT` rather than a stale file's `ECONNREFUSED`. The app never creates the socket, never
reads the volume and never creates a socket of its own there: a missing file is what a dead worker
looks like.

**The protocol.** HTTP/1.1 over the socket, `node:http` on both sides — `server.listen(path)` in the
worker, `http.request({ socketPath, method, path, agent: false })` in the app — with JSON bodies and
one request per connection: `agent: false` because Node 24's global agent keeps sockets alive and
would leave idle app sockets in the worker's eight slots (research §8.9), and `maxRequestsPerSocket
= 1` on the worker, which then answers `Connection: close` itself. Three endpoints, mirroring the
seam exactly:

| Request | Body | Answer |
|---|---|---|
| `POST /quotes` | `{ symbols: string[] }` — one to a hundred, each matching the pattern | `200`, the array the library's `quote()` returned |
| `POST /history` | `{ symbol: string, from: "YYYY-MM-DD" }` | `200`, the object the library's `chart()` returned |
| `GET /healthz` | — | `200 { ok: true }` — no Yahoo call, no database: "the worker accepts requests" |

Every other answer is a refusal carrying `{ error: <text> }`: **`400`** for a body that does not
parse, a symbol outside `^[A-Za-z0-9.^=-]{1,15}$`, a `from` that is not `YYYY-MM-DD`, more or fewer
symbols than the bounds, or a method and path the table lacks; **`429`** when the endpoint's rate
cap is spent (§3.5); **`502`** with the library's message when it threw — the app maps
`isMissingHistory`'s stems to `no-history` and everything else to a provider failure; **`504`** when
the worker's own 30 s watchdog expired. A request body past 16 KB has its socket destroyed under it
with no status at all — the app sees `ECONNRESET`, a provider failure; the honest app never sends
two kilobytes. To the app any status but `200` is a provider failure, Node's own `408`, `431` and
`400` included, the thing Yahoo failing looks like today; a *connect* failure — any request error
whose `syscall` is `connect`: `ENOENT`, no socket file; `ECONNREFUSED`, a file nobody listens on;
`EACCES`, a uid or mode that does not line up; `ENOTDIR` (research §8.8) — is `ProviderUnreachable`,
the batch-abort case of §3.1, and it is immediate.

The symbol pattern lives once, in `server/symbol-pattern.ts` (§3.5): the app checks it before a
call and the worker before a URL. The worker's check is the one that binds (§2.1); the app's saves a
round trip and keeps a stored symbol the app's own rule permits (length ≤ 40, any character,
`instrument-resolution.server.ts:308-312`) from costing a whole call — the offender is dropped with
a log line naming it and comes back absent (§8).

**The answer** is the library's raw result serialised as JSON, validated on read with the schemas
the app has today — `yahooQuote` (`price-provider.server.ts:244-272`) through `toProviderQuote`,
`yahooChart` (`:400-410`) through `toProviderHistory` (`:483`). Both already accept ISO strings for
every instant (`:249`, `:298-310`), so a `Date` that became a string in transit, or an epoch number
the library's best-effort coercion left alone with its validation off (§3.5), parses unchanged. No
schema change; one end-to-end round-trip test is the pin. The worker holds no domain logic:
`matchKey`, `period1`-only, `from`, `until`, the currency guard and the ceilings are all the app's.

### 3.3 The app side: `app/lib/provider-socket.server.ts`

One primitive, `ask(kind, body, { budgetMs })`, the production budgets its defaults so a test passes
two hundred milliseconds instead of sleeping through real ones: one `http.request` over the socket
at `getConfig().PRICE_WORKER_SOCKET` with `agent: false` and `signal: AbortSignal.timeout(budgetMs)`,
the response body read under a per-kind cap — **quotes 512 KB, history 2 MiB** (a hundred quote
entries are about 400 KB, a ten-year chart about 300 KB; the request is destroyed at the cap) —
and JSON-parsed. Its outcomes, in the order they are told apart:

- A connect failure — a request error whose `syscall` is `connect`, whatever its code (§3.2) —
  throws `ProviderUnreachable` ("no worker listening at <path> (<code>)"), at once and every time,
  with no memory between calls. The syscall and not a code list, because a permission fault is
  persistent and is exactly "no worker reachable": as a plain failure it would ledger five
  candidates a day and charge the retry clock for a misconfiguration fixed in a minute.
- The budget expiring throws a plain error saying the worker did not answer within it. Over
  `http.request` the abort arrives as an `AbortError` (`code: "ABORT_ERR"`) whose `cause` is the
  signal's `TimeoutError` (research §8.9), so the branch reads `error.name === "AbortError"` — or
  simply `signal.aborted` — never a top-level `TimeoutError`, which `fetch` raises and
  `http.request` does not. The worker is alive and the provider slow, which is what Yahoo timing out
  looks like today; `refreshQuotes` turns any throw into `providerFailed`
  (`prices.server.ts:792-800`).
- The body cap throws a plain error naming it; any status but `200` throws a plain error carrying
  the answer's `error` text, so the ledger records what Yahoo said, or what the worker refused;
  `200` is the parsed body.

Budgets are per call, by kind — **quotes 15 s, history 35 s, probe 10 s**. History runs past the
worker's 30 s watchdog so the app reads the worker's `504` and its reason rather than its own abort
(the app's signal starts before `connect`, so at 30 s it would always win by transit time); quotes
deliberately abandon at 15 s a call the worker keeps running — and has charged its cap for — since a
slow quote is stale prices either way; probe, because a cold worker's first probe pays a three-fetch
crumb handshake, and the verdict a short budget would lose is `non-usd`, the one a person acts on.
A budget gates how long the app waits and nothing else — never the worker's own fetch (§3.5).
**Stateless**: no handle, no unreachability flag; a dead worker costs one connect attempt and one
log line per call site, milliseconds, never deduplicated — so with the batch abort of §3.1 a tick
against a dead worker costs at most two of each, the quotes' and the first history candidate's,
nothing ledgered either time. Symbols failing the pattern are dropped
before the call with one `console.warn` naming them; more than a hundred are split at the worker's
bound into consecutive asks; an empty list after dropping is an empty answer and no call. The socket
path is configuration, but a development-only knob: `PRICE_WORKER_SOCKET` joins `configSchema`,
optional, defaulting to `/run/price-worker/worker.sock` — `server/config.ts` stays the only reader
of `process.env`. Compose passes it to neither `app` nor `worker` in deployment, so both and the
healthcheck run the fixed default path; a developer's `.env` can point it under `/tmp` (§3.8).

`socketProvider(): PriceProvider` — `getQuotes(symbols)` is `ask("quotes", { symbols })`, then each
entry through `toProviderQuote`, skipping `CurrencyRefused` exactly as the adapter does
(`:719-731`); a body that is not an array is an empty answer, `probeVerdicts`'s rule (`:680`).
`getDailyCloses(symbol, range, tz)` is `ask("history", { symbol: matchKey(symbol), from: range.from
})` — `matchKey` (`:756`) and `period1`-only (`:748-755`) stay app-side because the worker must not
import `app/lib`; a refusal matching `isMissingHistory`'s stems (`:787-793`, made exportable) is
`no-history`; a `200` goes through `toProviderHistory(body, range, tz)`, which applies `from` and
`until` app-side (`:541`).

`socketProbe: ProbeSymbols` is built on `ask`, **not** on `getQuotes`, which cannot say `non-usd`:
`ask("quotes", …)` for the batch, split at a hundred exactly as `getQuotes` splits, then
`probeVerdicts` (§3.4) per symbol — `CurrencyRefused` is `non-usd`, absent is `unavailable`, any
throw is `unavailable` for every symbol. Six new symbols against a dead worker cost one connect
failure, not six; against a worker that is alive but slow, at most the 10 s budget.

The existing `Price provider failed` stem (`prices.server.ts:796`) now carries "no worker listening
at …" for a dead worker, distinct from Yahoo failing, and the composition's batch-failed line
(`:691-694`) is one warning with the same text when the cause is `ProviderUnreachable`. The route's
three outcomes (`app/routes/refresh.ts:21-33`) and the freshness component's sentences
(`app/components/price-freshness.tsx:74-102`) are untouched: the dead-worker distinction is the
operator's, in `docker compose ps` and the worker's log. A JS-off press against an alive-but-slow
worker can block for the sum of the budgets — `⌈feed instruments / 100⌉ × 15 s + 5 × 35 s`, 190 s up
to a hundred feed instruments and more above it as the quotes chunks add up — past the 60 s at which
most house proxies cut a request and show their own `502`/`504` while the refresh completes behind
them (ticket 09's runbook says so); today it is unbounded.

### 3.4 The prefactor (tickets 01–03, on the existing Yahoo adapter)

Make the change easy before making it. Every piece below typechecks and tests against
`yahooPriceProvider()` as it stands, so the cutover (ticket 06) becomes "swap the provider, delete
the client use". Three tickets, blocked by nothing, because the pieces share no line.

- **(01) `runRefresh({ quotes }, provider = yahooPriceProvider())` in a new domain module,
  `app/lib/refresh.server.ts`,** holds the lock, runs `refreshPrices` with the instance it was
  handed, and maps the result to the outcome the control renders, so the route, the poller's tick
  and `requestRefresh()` become thin callers — issue #159's ask, which also moves `RefreshOutcome`
  into the domain; the market-hours gate and the cadence stay the poller's, and
  `PollerState.provider` stays one instance. **`ProviderUnreachable`** is defined beside
  `PriceProvider`; `backfillCloses` lets it escape the per-candidate catch so the outer catch wraps
  it once (§3.1); the composition's log branches on it; the adapter never throws it.
- **(02) `ResolutionDeps.probe` becomes required and batched:** `probe(symbols) →
  Promise<Map<string, SymbolProbe>>` over one library call — over the socket each serial probe
  would be a round trip (issue #205's first item) — and an empty collected list calls nothing at
  all: a manual-only submission stays a submission with no provider call, and a zero-symbol ask is
  a `400` from the worker (§3.2). The default import, the `?? probeSymbol` fallback and
  `resolveAll`'s `deps = {}` default go — with a default kept, "required" would be a type and not a
  fact; the verdict logic becomes a pure exported function both probes use, typed as the
  `ProbeSymbols` the ticket names.
- **(03)** The three hardening rules of §3.1 and the archive cap. The seven-day arithmetic on an
  `IsoDate` uses `addDays`, today private in `app/lib/chart-range.ts:139` and exported rather than
  written a fourth time.

Tests: the seams, the abort without a ledger row, the batched probe, the ceiling, the seven-day
window both ways, the range floor, the archive cap.

### 3.5 The worker: `server/price-worker.ts` (ticket 04)

Same image, overridden entrypoint — the `dump` precedent (`compose.yaml:144-145`); an `entrypoint:`
also drops the image `CMD`, so neither `docker-entrypoint.sh`'s migration nor `react-router-serve`
runs as the worker. Its closure: `server/config.ts` (`loadWorkerConfig`), `server/yahoo-client.ts`,
`server/symbol-pattern.ts`, `yahoo-finance2`, `zod`. No `pg`, no Kysely, no `app/lib` (the
react-router edge at `app/lib/settings.server.ts:27` → `app/lib/masking.ts:14` is never reached, so
the old spec's masking-policy ticket has no reason to exist), and not even a type crosses from
`app/` except by a whole-statement `import type` — under type stripping the inline `{ type X }` form
stays a live import, and `app/` is not in the image (ticket 04 has the trap).

**`loadWorkerConfig(env)`**, exported from `server/config.ts` beside `loadConfig` (`:121`): the same
empty-as-unset treatment over a schema of one setting, `PRICE_WORKER_SOCKET` with the default above.
The worker reads no clock — `period1` is the library's to parse, the answer is raw JSON, and `TZ` is
the runtime's own, `UTC` in the image (`Dockerfile:94-96`) — so its environment is nothing but a
socket path; a `DATABASE_URL` in it is ignored, not validated.

**`server/yahoo-client.ts`**, new, used by the app's adapter from this ticket until the cutover so
there is one client site at every commit: `new YahooFinance({ versionCheck: false })` (the default
fetches `registry.npmjs.org` from the validation-failure path), and every `quote(symbols)` and
`chart(symbol, { period1, interval: "1d", events: "split" })` under a third module-options argument
of `{ validateResult: false, fetchOptions: { signal: AbortSignal.timeout(30_000) } }` — the
library's validation off per call (the constructor refuses the key — research §3.3), so one drifted
field cannot fail a whole `quote()` and the app's Zod is the only gate, and the signal reaching
`fetch` and the crumb handshake, the bound issue #205 asks for. The 30 s is the client's own and
fixed, **never derived from a caller's budget**: the crumb handshake is memoised single-flight under
the *first* caller's `fetchOptions`, so a probe's short budget handed in as a signal could abort a
handshake a quotes call had joined — which is why no budget crosses the socket at all. It exports
the `YahooClient` type the worker, the adapter and every fake share, imports nothing from `app/lib`
(`matchKey` would pull Kysely in), and `ChartRequest` moves with it; ticket 04 carries the library's
`file:line`s.

**The server.** `node:http` on the socket, its bounds a set: unlink a stale file, `listen(path)`,
`chmod 0660`; `maxConnections` 8; `maxRequestsPerSocket` 1; `headersTimeout` and `requestTimeout` 5
s, checked every second — `connectionsCheckingInterval` 1 s, the default being 30 s, and the two
deadlines expire only a connection that has sent a byte (research §8.9); `server.timeout` 35 s for
the silent connection those two never touch, past the 30 s watchdog because a request waiting on
Yahoo is inactive on the socket; a body read to 16 KB and the socket destroyed past it; request
bodies narrowed by Zod schemas in the module, `symbols` element by element against the pattern from
`server/symbol-pattern.ts` before any URL — no imports, the only copy, shared with the app from
ticket 06: the binding check of §2.1 — and `from` against `^\d{4}-\d{2}-\d{2}$`, since `IsoDate`
lives under `app/`. Per-endpoint rate caps — **quotes ten calls a minute, history twenty** — are
answered `429` with one log line, because the worker is the honest component when the app is not
and a runaway app must not earn the household a Yahoo ban; the cap's assumption, stated: a tick
costs ⌈feed instruments / 100⌉ quotes calls and at most five histories, so 300 feed instruments at
the one-minute cadence floor (`REFRESH_CADENCE_BOUNDS`, `app/lib/settings.server.ts:138`) plus a
press approach the quotes cap — honest households are far below. Every library call runs under the
client's fixed 30 s signal, its expiry answered `504`; any other throw is `502` with the message and
its `cause` appended, cut to 1000 characters, since undici says `fetch failed` for every network
failure and keeps the detail there. One log line per non-`200` answer, stem `Price worker`; a
startup line naming the socket path; nothing per successful call; a failed unlink or listen exits
non-zero after one line with the path and the code, and `SIGTERM` closes the server and exits
(§3.2). `startWorker({ socketPath, yahoo, timeouts })` returns the listening server for the tests,
`timeouts` carrying all four numbers, behind an `import.meta.main` guard (Node ≥ 24.2; `undefined`
under vitest — research note §5.3). The container carries daemon-enforced limits (ticket 05):
`pids_limit` 64, 256 MB of memory, a 64 MB `/tmp` — a compromised worker cannot balloon or fork the
host into the OOM killer, whose usual victim is Postgres; the proxy of §3.7 carries the same.

**Health** is the container healthcheck doing `GET /healthz` over the socket with `node -e` and a
5 s timeout: it proves the worker accepts requests and nothing about Yahoo,
`app/routes/healthz.ts:9`'s reason. No timer, no settings, no database: startup needs nothing to
exist but the volume, so the service declares no `depends_on`. Nothing restarts an unhealthy
container (research note §1.7); the check is for `docker compose ps` (ticket 05 has it).

**Tests** need no database and no committing handle — the transport is not the database. Ticket 04
lists the worker's cases and ticket 06 the app side's, both against the real server on a temporary
socket path with a fake Yahoo client (§3.8); the client's own surface gets
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
  app:    { networks: [backend, caddy-app], volumes: [price-worker-sock:/run/price-worker:ro] }   # no route out; :ro — it only connects
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
daemon's default decides. A Compose floor stands beside the Engine floor because the reconciler's
behaviour is load-bearing for ticket 08: Compose recreates a drifted network only when it recorded
a config hash on the live one (research §1.11), which is why 08 introduces a new network name rather
than changing `egress-worker` in place — and the same convention governs the volume: `driver_opts`
are read once and a name-matched volume is reused untouched (research §8.2), so a changed option
string is a new volume name, never `down -v`, which removes `db-store`'s record with it.

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
and to nothing else; the worker needs no database route, holding no credential, and the override
puts `db` and `dump` behind a Compose profile so neither starts — `dump-loop.sh` refuses any host
but `db` and would crash-loop against the operator's own Postgres — making an outside Postgres
backed up by its own operator a fact, not just advice (`docs/operating.md:195-197`). That
mode is a stated relaxation: requirement 1 is **off for `app`**, whose bridge now carries a default
route, and what remains is requirement 3 by construction and requirement 5, `worker` still sharing
no network with `app` or `gate`. Such an install sets
`COMPOSE_FILE=compose.yaml:compose.external-db.yaml` in `.env`, once — the smoke test's own
precedent (`scripts/smoke-test.sh:26`) — rather than `-f` on every command; the override forgotten
has a signature the docs name, `app` crash-looping on `ETIMEDOUT`/`EHOSTUNREACH` to its Postgres.

What isolation does not give: any container with a route to the host reaches the host's *published*
ports, so until ticket 08 the worker reaches Caddy's `:80` through its egress bridge — the app
*through the gate*, never `app:3000` or `gate:4180` — and the gate's OAuth callback relays
attacker-chosen bytes to Google (§8). After ticket 08 that route closes for the worker too. Smoke
asserts effects, not flags, and reads the daemon's own record where the effect cannot be provoked:
under `isolated` no gateway address is allocated at all (research §1.2), so a connect to the empty
IPAM field would fall back to localhost and pass for the wrong reason on the very engines the floor
admits. §5 lists the assertions; tickets 05 and 07 carry the commands and their timeouts.

**Passwords stop travelling in URLs** (ticket 07). Compose sets `PGPASSWORD` per service and the two
`DATABASE_URL` defaults (`compose.yaml:126`, `:204`) carry user and host only: `pg` 8.23, libpq and
`pg_dump` read `PGPASSWORD` when the URL has no password (research §4.1; `scripts/dump-loop.sh:95`
reads a password-less URL), and `config.ts`'s URL check accepts the form. A URL password still wins
over the variable, so `.env.example:23`'s explicit URL line is removed and the upgrade runbook says
"drop your `DATABASE_URL` line" — a stale `.env` would otherwise crash-loop with `password
authentication failed`. Every runbook that introduces a `${VAR:?}` writes `.env` **first**, since
interpolation runs before every compose command, `exec` included (research §1.9). No password
alphabet, no validation code; ARCHITECTURE.md §4.2's env-reader row (`:345`) gains the driver's own
`PGPASSWORD` and the runtime's own `NODE_USE_ENV_PROXY` and `HTTPS_PROXY`; the worker sets none.

### 3.7 The egress allowlist (ticket 08, required)

It is what makes "Yahoo Finance and nothing else" true, and until it lands the worker's egress
bridge also reaches the household LAN — the NAS, the router's admin page, the devices the gate
exists to distrust. `server/egress-proxy.ts` is about a hundred and fifty lines of `node:http`,
`node:net` and `node:dns`, with tests: `CONNECT` only, to exactly the five hosts the pinned library
contacts (research §3.1) — never `*.yahoo.com`, since a mail or login host inside a tunnel is a full
exfiltration channel, and never an IP literal — and only when the TLS ClientHello inside the tunnel
names the same host, because all five resolve to the same two addresses as `mail`, `login` and
`www.yahoo.com` and the edge routes on the server name the *client* sends. The order is the
ticket's one hard sequence, and ticket 08 is its authority: the allowlist (`403`); then resolve,
refuse a loopback, link-local or private answer (a LAN resolver, ADR-0005's adversary) and open the
upstream `net.connect`, each under a 5 s deadline, answering `502`/`504` and logging one line on
failure — so a Yahoo or DNS outage behind a healthy proxy is observable, as `Proxy response (502)`
in the worker's `fetch failed` cause; only then the `200`, since a client sends no byte of its hello
before it; then the hello, seeded from `head`, checked, and a mismatch destroying the socket with
nothing yet sent upstream; then the replay and the pipe. The bound is on **accepted sockets, not
tunnels** — `maxConnections` 8 for a socket's whole lifecycle, 5 s per waiting stage, 60 s idle — so
a hostile worker's denial is of price refresh, and bounded (§8). The list is a module constant, a
fact about the pinned library: the proxy reads no environment, and when Yahoo moves a host the log
names the refused `CONNECT` and the fix is a release.

Same image, another entrypoint, node built-ins only — a payload that is never imported never runs,
so the proxy is the one piece of the shared image the npm tree cannot reach; it carries the worker's
resource limits (§3.5) and the same `SIGTERM` handler. Compose: a **new** internal, isolated
network, `worker-proxy`, replaces `egress-worker` (§3.6 says why a new name); the worker's
`NODE_USE_ENV_PROXY`/`HTTPS_PROXY` pair is the runtime's, and the binding property is the network,
not the flag, which compromised code ignores (§5 lists what smoke proves; the positive fetch through
the proxy is best-effort where CI cannot reach Yahoo). With no non-internal network the worker has
no resolver: hostnames travel inside `CONNECT`, so DNS exfiltration is gone. Docker has no native
egress policy, and a third-party proxy image would add an unaudited supply chain to a slice about
supply chains. A stopped proxy and an unreachable Yahoo each have their own signature (ticket 08).

### 3.8 Image, development, tests

One image, a second and a third entrypoint — the `dump` precedent, and an owner-accepted trade; the
prune script never removes a declared package (`scripts/prune-unreachable-deps.mjs`'s own header),
so there is no prune change, and a worker-only stage is the named follow-up (§7). The runtime stage
copies `server/` files by name (`Dockerfile:104-110`), so the worker, the client, the pattern module
and the proxy are each added explicitly. The compose file is the operator's own copy
(`docs/operating.md:962-965`), so every release that changes it says so in its upgrade note.

Development: `npm run dev` is unchanged; `.env` gains `PRICE_WORKER_SOCKET=/tmp/portfolio-worker.sock`
and a second terminal runs `node --env-file=.env.worker ./server/price-worker.ts` with `.env.worker`
holding that one line — nothing the superuser's `.env` has. Ticket 06 lands the recipe: from it a
checkout without a worker has stored prices only, a refresh that logs "no worker listening at
/tmp/portfolio-worker.sock" once per call site — up to twice, quotes and the batch abort — and
ingest probes `unavailable` at once with the instruments created anyway. **No in-process fallback
mode** — a second code path would keep the Yahoo import reachable from the app and give the
property an off switch.

Tests: nothing in this slice needs a committing handle. The worker's tests and the app side's speak
to a real server on a temporary socket path with a fake client and never touch the database; the
end-to-end JSON round trip through `refreshPrices` runs inside `withDatabase`, so its `price_poll`
row rolls back with everything else. `getConfig()` memoises, so a test that needs the socket path
sets `process.env.PRICE_WORKER_SOCKET` before the first *call* of `getConfig()` — imports are
hoisted, and the precedent (`tests/price-poller.test.ts:37`, for `DATABASE_URL`) works because the
read is lazy, not because of import order.

## 4. Tickets

One ticket is one pull request that typechecks, builds and tests standing alone, and every one
leaves a deployable main: after 05 the worker runs beside the still-fetching app, listening, idle
and healthy; 06 is the single release where the app stops fetching, and 07 the one where it loses
its route. There is no commit from which a deploy has no price refresh.

Every ticket carries `ready-for-agent`, in the vocabulary of `docs/agents/triage-labels.md` (`:9`):
§2.5 is answered and this document is approved by the merge that lands this rework, so every ticket
is ready for an agent to pick up and none waits on a decision any more.

| # | Ticket | Blocked by |
|---|---|---|
| [01](price-worker/01-one-refresh-and-the-batch-abort.md) | `runRefresh` with three thin callers; `ProviderUnreachable` and the batch abort (§3.1, §3.4) | Nothing |
| [02](price-worker/02-the-batched-probe.md) | The required, batched ingest probe, and the `ProbeSymbols` type (§3.4) | Nothing |
| [03](price-worker/03-the-three-hardening-rules.md) | The price ceiling as a write-abort guard, the seven-day window on the quote path, the range floor on the history path, and the 32 KB archive cap (§3.1) | Nothing |
| [04](price-worker/04-the-price-worker-process.md) | `server/yahoo-client.ts` (the app's adapter and the batched probe use it from here), `server/symbol-pattern.ts`, `server/price-worker.ts` — the socket server — and `loadWorkerConfig`; their tests; the Dockerfile copy set; ARCHITECTURE.md §4.2's import-site row (§3.2, §3.5) | 02 |
| [05](price-worker/05-deploy-the-worker-alongside.md) | Deploy alongside: the volume, the `worker` service on `egress-worker` with its limits, `app` mounting the volume, the socket healthcheck, the Engine floor, the dev override, the upgrade note, smoke (§3.6, §3.8) | 04 |
| [06](price-worker/06-the-app-cutover.md) | App cutover: `provider-socket.server.ts`; poller, route and ingest on the socket; the adapter loses its client; round-trip, route and probe tests; the developer's recipe (§3.3, §3.8) | 01, 02, 03, 05 |
| [07](price-worker/07-the-network-lockdown.md) | Lockdown: the full topology and the `compose.external-db.yaml` override, `POSTGRES_PASSWORD` required, `PGPASSWORD` for `app` and `dump`, the upgrade runbook, smoke egress, DNS and isolation assertions (§3.6) | 06 |
| [08](price-worker/08-the-egress-allowlist.md) | The egress allowlist proxy with the SNI check, on a new network (§3.7) | 07 |
| [09](price-worker/09-documents-and-runbooks.md) | The record: DESIGN.md, ARCHITECTURE.md, ADR-0010, CONTEXT.md, the runbooks (§6) | 08 |

01 ∥ 02 ∥ 03; 02 → 04 → 05 → 06 (also needs 01, 03) → 07 → 08 → 09.

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
  No service but `app` and `worker` mounts `price-worker-sock`, and `docker inspect` shows a pids
  limit and a memory limit on `worker` and, after 08, on `egress-proxy`.
- **Refresh now** round-trips through the socket on every screen that carries it, JavaScript off
  included (blocks, then redirects). Against a dead worker it reports `providerFailed`: one connect
  attempt and one "no worker listening" line per call site — quotes, and the batch abort when a
  backfill candidate exists — at most two of each in the one tick, nothing ledgered, each failure
  immediate and never a grace, and `price_backfill` gains no row.
- At ingest a non-USD symbol still refuses with nothing written, an unavailable one is still created
  anyway, and a dead worker costs one connect failure per submission (at most the 10 s budget when
  the worker is alive but slow), not one per symbol — and nothing at all for a manual-only
  submission, which asks no provider call.
- A quoted price at the ceiling is dropped and the instrument goes stale; a quote whose market date
  is eight days old, or eight days ahead, rewrites no close and inserts none — and is not counted in
  the report's `closes` either — while one seven days old does both; a history answer carrying a bar
  dated before the asked range writes no row for it and leaves the gap it would have closed open; an
  observation payload over 32 KB is archived as `null`. A worker asked for its eleventh quotes call
  in a minute answers `429` without a call; a body naming `BRK/B` is answered `400` without a call;
  a library call that outlives the 30 s watchdog is answered `504`.
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
DESIGN.md's scheduler row, services block, environment table, §6.2 and §14 say what shipped;
ARCHITECTURE.md's §2, its §4.2 single-site and env-reader rows, §7 and the appendices do; ADR-0010,
"Price fetching is an egress-isolated worker behind a unix socket", records the decision with §2.5's
list as its cost and §7's rejected alternatives; CONTEXT.md gains **Price worker** and **Worker
socket**, with "queue", "job table", "sidecar API" and "RPC" among the words to avoid;
`docs/operating.md` gains the floors, the bring-your-own mode with `COMPOSE_FILE` and the symptom of
forgetting it, the password rules, the upgrade runbook with its rollback and "replace `compose.yaml`
first" notes, the restore path with the worker running, the from-`app` socket check for hosts smoke
never runs on, and the log signatures of a dead worker, a dead proxy and an unreachable Yahoo under
the `Price provider failed` stem; `docs/runbook.md` and `docs/developing.md` the crash-loop entries,
the `.env.worker` recipe and the without-a-worker behaviour; `README.md`, `server/db.ts`'s pool
comment and the poller's header follow. `docs/data-model.md` is untouched: this slice adds no table.

## 7. Out of scope

- **Worker supply-chain decorrelation** — the named follow-up: a worker-only image stage with its
  own `package.json`, and a hand-rolled fetch of the two endpoints behind the same Zod schemas.
- Moving the app off the `portfolio` superuser — opened by this slice, not done in it.
- A UI state for a dead worker; issue #202's decision; issue #194; a repository `pg_hba.conf` with
  pinned subnets; host `DOCKER-USER` rules; a gVisor runtime; any auth change (ADR-0005 stands); the
  three private copies of `inTransaction` (`prices.server.ts:741`,
  `instrument-resolution.server.ts:237`, `uploads.server.ts:571`) — this slice needs none of them
  and adds no fourth.
- **Rejected, recorded for ADR-0010.** The **mailbox** of §2.5, on the cost §2.5 lists, and with it
  what only made sense for it: `LISTEN/NOTIFY` (no reconnect in `pg`, unqueued, needs a poll anyway),
  RLS for first-write-wins, a per-operation unreachability handle, `pg_dumpall --roles-only` in the
  dump service, and the heartbeat-file healthcheck — `GET /healthz`
  over the socket asks a listener, which proves more than a timestamp. A **TCP listener on an
  internal network** in place of the socket file: reachability on a bridge is symmetric, so the
  worker would reach `app:3000`. A **start-up refusal** in the image against `up -d` under a stale
  `compose.yaml`: it couples the app's start to the deployment's shape; the upgrade note carries the
  case instead. And, unchanged in reason: the worker owning the refresh (§2.3), a worker-unresponsive
  UI state, IP pinning, a separate image now, an in-app fallback mode, a third-party proxy image.

## 8. Residual risks, stated plainly

- **Price poisoning by a compromised worker.** Shape-checked, bounded by the ceiling, the seven-day
  window and the range floor, truth unverifiable. A hostile `symbol` in an answer prices the wrong
  instrument; a hostile `quoteType` rewrites `instrument.quote_type` (`prices.server.ts:909`) and
  with it the stocks-versus-funds split; a `non-usd` verdict for every new symbol blocks feed ingest.
  The ceiling bounds the price, not the product: `quantity` is `numeric(20, 8)`
  (`0001_initial_schema.sql:186`) and `holding_valued` casts `quantity × price` to `numeric(20, 4)`
  (`0006_annual_dividend.sql:149`), so a plausible price against a large quantity still overflows
  the reader — no price ceiling fixes the product; `fitsTheMoneyColumn`
  (`app/lib/positions.server.ts:206`) guards it at the quantity write, and the recovery is `psql`.
- **The observation archive is bounded, not capped by count.** `archived()` stores nothing over
  32 KB and the client's per-kind body caps bound one answer, so a worker varying
  `regularMarketTime` adds at most one 32 KB row per instrument per tick; nothing prunes the log, as
  before (ADR-0006).
- **What the worker and Yahoo learn**: the symbols and the history ranges (about first-held less
  seven days), as today — and nothing else, the worker holding no credential with which to read
  even the shape of the household's data.
- **The channel from a compromised app**, stated as a rate: ten quotes calls a minute × a hundred
  symbols × fifteen bytes, about 15 KB a minute of symbol-shaped text through an honest worker to
  Yahoo's query logs or an on-path observer, plus twenty history calls of one symbol each.
- **Correlated compromise** until decorrelation: the worker's rate cap binds an honest worker only,
  so after ticket 08 the proxy's socket cap and deadlines are the sole bound, bandwidth to Yahoo's
  edge is unbounded within them, and the DNS channel is closed; what leaves is what Yahoo's edge
  serves under a server name the proxy has matched to the `CONNECT` host, readable back only through
  a feature on that property that reflects bytes; an in-TLS `Host:` naming another property under a
  wildcard certificate is the edge's to route, and if the edge ever accepts an encrypted ClientHello
  the check degrades to host-only.
- **The shared tmpfs.** The app and the worker share a 1 MiB tmpfs: ~~a compromised app can unlink
  or replace the socket file, squat the path with a directory or spend the volume's inodes~~ — a
  self-inflicted refresh outage that also stops the worker starting after its next restart
  (`EISDIR`, `EADDRINUSE`, `ENOSPC`; a *data*-full tmpfs does not stop `bind()`), recovered by
  recreating the volume (ticket 09's runbook entry); a compromised worker can do the same from its
  side, denial only. **Corrected 2026-09-05, on building
  [ticket 05](price-worker/05-deploy-the-worker-alongside.md): the app's half of that is gone.**
  The app mounts the volume `:ro`, which makes every one of those three `EROFS` from its side —
  measured through a read-only bind mount, where `chmod`, `unlink` and `bind` are all refused while
  `connect(2)` still works, because the read-only check exempts a socket inode. The worker's side
  stands as written, and it is the side that has to create the socket. A symlink the worker plants
  at the path is followed by the app's `connect()` in the app's own mount namespace, which holds no
  other socket to reach; the app never reads the volume and never creates a socket there.
- **Who reaches the socket.** Host root does; a host uid or gid 1000 cannot traverse the daemon's
  data root (research §8.5). SELinux-enforcing hosts may deny the cross-container connect with the
  mode right; `userns-remap` and rootless Docker are untested — the from-`app` `/healthz` command
  ticket 05 writes is the check on such a host, and the docs point at it.
- **The worker's parser.** A compromised app can push arbitrary bytes at the worker's `node:http`
  parser — body capped at 16 KB, `headersTimeout`/`requestTimeout` 5 s checked every second (they
  expire only a connection that has sent a byte), a silent connection gone at `server.timeout` 35 s,
  one request per connection, eight connections with the ninth accepted and closed at once — the
  trust direction §2.5 accepted. Held to that shape it is a self-inflicted denial: eight silent
  sockets reconnected as each expires starve the worker's own healthcheck (which sees `EPIPE`) and
  the honest refresh, and `docker compose ps` shows `worker` unhealthy for a reason no restart
  fixes; spending the rate caps is the same outage by another route. The egress proxy is the same
  class of target, hence its cap on **accepted sockets, not tunnels** (§3.7) — a denial of price
  refresh, never of household data; and neither can balloon or fork the host into the OOM killer,
  `pids_limit`, a memory limit and a sized `/tmp` being daemon-enforced (tickets 05 and 08).
- **A compromised worker** can poison answers and deny service, as before; the database is out of
  its reach entirely — no credential, no network — so every availability attack a login admitted
  went with it.
- **The app is still the superuser**; nothing in this slice narrows it, and the follow-up is §7's.
- **A worker outage is stale prices**, surfaced in the log and the as-of line, at the per-tick cost
  §3.3 states — a connect failure — and with nothing ledgered, so the retry clock is not charged
  for it.
- **Routes that stay open**: Caddy keeps an unused route; the published `:80` stays reachable
  through the host from the gate's and Caddy's networks, and from the worker until ticket 08; the
  gate's OAuth callback relays bytes to Google.
- **Symbol-length mismatch** — 40 characters app-side, 15 in the pattern: a legitimate stored symbol
  outside the pattern never refreshes and shows stale, with a log line naming it.
- **Engine below 28 is silently weaker**, and the smoke test runs in CI, not on the operator's box.
  **Version skew** across an `up -d` under one floating tag is harmless because the socket plus raw
  JSON is the whole contract — the count, "at most one release", holds only for an operator who
  upgrades every release; and rolling `APP_VERSION` below the 07 or the 08 release under the newer
  compose file has its own symptom, named in each ticket's rollback note.
