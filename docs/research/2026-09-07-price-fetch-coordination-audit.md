# Price-fetch coordination and containment audit

*Audited 7 September 2026 against `558b918`. This is a static review of the application, price
worker, egress proxy, migrations, tests, deployment, and the pricing design records. It describes
what is shipped, separates defects from accepted limitations, and recommends changes in risk order.*

## Executive answer

The coordination model is intentionally asymmetric. The app owns the database and every pricing
decision; the worker owns only the Yahoo client and outbound calls. They exchange raw provider JSON
over a Unix socket, and the app validates it before storing anything. The worker has no database
credential. Its only route out is a CONNECT proxy on another network, which restricts destinations
to five Yahoo hosts and checks DNS addresses and TLS SNI (`compose.yaml:115-220`,
`app/lib/provider-socket.server.ts:1-10`, `server/price-worker.ts:1-17`).

The architecture is sound and the egress proxy is valuable. It materially limits generic SSRF and
lateral movement after a worker compromise. It does **not** establish that a price is true, prevent
data from being encoded into requests to an allowed Yahoo property, or survive a correlated
compromise of the single image artifact used for the app, worker, and proxy.

The most important defects are in validation, lifecycle, and data monotonicity, not the container
seam:

1. a response with no currency is accepted as USD and can persist a foreign price as dollars;
2. a quote with no provider timestamp can create a daily close on the wrong or a non-trading date;
3. an older provider answer can replace a newer current quote and same-day close;
4. a finite but out-of-range provider timestamp becomes `Invalid Date` and can abort a refresh;
5. the poller starts only after a page load, always starts on 15 minutes rather than the stored
   cadence, and intentionally loses upload requests that race an active refresh;
6. the app accepts feed symbols which its own worker protocol will never accept (an already recorded
   limitation);
7. the proxy's claimed non-public-address guard is a partial denylist, not a complete global-unicast
   test.

The current controls are otherwise unusually deliberate: independent request and response limits,
Zod conversion of untrusted provider bodies, currency and numeric bounds, a cross-process advisory
lock, transactional price writes, insert-only historical closes, retry pacing, socket filesystem
permissions, topology-enforced egress, SNI checking, connection limits, and timeouts.

### Direct answer: can this lose or corrupt data?

Yes. Four confirmed paths can persist wrong pricing data:

- **Missing currency is treated as USD.** Both quote and history conversion refuse a currency only
  when a non-USD string is present. An omitted value passes, so a provider-shape change or hostile
  worker can store a foreign price as dollars (`app/lib/price-provider.server.ts:104-117`,
  `app/lib/price-provider.server.ts:159-164`, `app/lib/price-provider.server.ts:191-198`,
  `app/lib/price-provider.server.ts:242-245`). This directly violates the design rule that every
  quote reports currency before differently denominated values are summed
  (`DESIGN.md:444-446`). Existing tests deliberately accept the unsafe absence
  (`tests/price-provider.test.ts:211`, `tests/price-provider.test.ts:628`).
- **Missing quote time is invented for a durable close.** The converter substitutes fetch time for
  an absent provider timestamp, then `writeDailyClose` files that price under the invented market
  date (`app/lib/price-provider.server.ts:121-124`, `app/lib/prices.server.ts:606-632`). A weekend
  fetch can create a non-trading-day row, and an after-midnight fetch can attribute the prior
  session's price to the next date. That row changes carry-forward valuation and backfill will not
  replace it (`migrations/0003_holding_valued_at.sql:49-58`,
  `app/lib/prices.server.ts:637-655`).
- **Older answers overwrite newer state.** Current quote, quote type, and same-date daily close are
  updated without ordering protection (`app/lib/prices.server.ts:496-520`,
  `app/lib/prices.server.ts:558-632`). This can persistently regress the current quote or
  classification until a later good quote. A regressed same-date close cannot be healed by history
  because backfill is insert-only.
- **A corrected price at the same provider instant is lost from the observation log.** Observation
  identity is only instrument plus `as_of`, and conflicts do nothing. A later corrected price can
  update the current quote and daily close while the observation—and therefore the 1D series—keeps
  the first value (`migrations/0009_price_observation.sql:2-20`,
  `app/lib/prices.server.ts:722-732`, `app/lib/valuation.server.ts:425-469`). The existing
  correction test verifies the daily close but not observation/1D agreement
  (`tests/refresh-quotes.test.ts:209-227`).

The invalid-date bug below does **not** partially corrupt the quote tables: the transaction rolls
back. It loses the refresh attempt and leaves old data in place without the intended stale flags or
poll record. Likewise, lossy upload triggering delays work rather than deleting holdings or prices.

Three deliberate model limitations can also produce plausible but wrong valuations without a code
failure: current-ticker history can be misattributed across a rename or ticker reuse; a compromised
worker can supply a plausible false price; and an incorrect live close is intentionally not healed
by later backfill (`docs/adr/0011-a-backfill-fills-the-spine-but-never-moves-it.md:73-77`,
`docs/adr/0011-a-backfill-fills-the-spine-but-never-moves-it.md:106-109`,
`DESIGN.md:1577-1585`). These are not silent row deletion, but they are data-integrity risks an
operator should know before trusting historical totals.

## 1. Who owns what

### The app is the scheduler and policy engine

The app decides:

- when a scheduled refresh runs and whether market hours permit quotes
  (`app/lib/price-poller.server.ts:51-71`);
- which feed instruments to quote (`app/lib/prices.server.ts:81-88`);
- which history gaps to fill and in what order (`app/lib/prices.server.ts:102-165`);
- how Yahoo JSON becomes domain data (`app/lib/price-provider.server.ts:104-310`);
- every database write (`app/lib/prices.server.ts:458-719`).

The worker is request-driven. It has no cadence, holdings knowledge, market-hours rule, database
client, or database credential. It validates a narrow request, calls `yahoo-finance2`, and answers
with the library's raw JSON (`server/price-worker.ts:7-17`, `server/price-worker.ts:48-58`,
`server/price-worker.ts:234-307`). This is the right seam: a compromise of the internet-facing
adapter does not by itself reveal the household's accounts, quantities, balances, or statements.

### The Unix-socket contract

The app posts to `/quotes` and `/history` over the shared socket; instrument probing reuses quotes.
The worker owns the
socket path and sets its mode to `0660`; the app mounts the containing volume read-only
(`server/price-worker.ts:320-323`, `server/price-worker.ts:390-397`, `compose.yaml:137-139`,
`compose.yaml:174-177`). The volume itself is a 1 MiB tmpfs owned by UID/GID 1000 with mode `0770`
(`compose.yaml:346-352`).

There is no application-level peer identity. Access is the filesystem capability. That is
appropriate for this single-host topology: only app and worker mount the volume, and the read-only
app mount prevents socket replacement or unlinking. A compromised worker can still lie, replace
its own endpoint, or deny pricing; host root can inspect the volume. SELinux, rootless Docker, and
user-namespace remapping remain deployment compatibility questions rather than properties proved
by unit tests.

## 2. How refreshes coordinate

### Scheduled refresh

`app/root.tsx` calls `startPricePoller()` from its root loader. A `globalThis` slot makes repeated
calls idempotent inside one process (`app/root.tsx:177-180`,
`app/lib/price-poller.server.ts:108-135`). Startup arms a 15-minute interval and deliberately does
not fetch immediately.

Each tick:

1. returns if that process already has a tick in flight;
2. checks market hours for quotes;
3. reads the refresh cadence row;
4. re-arms the interval when the value changed;
5. runs the shared refresh operation;
6. logs quote and backfill outcomes (`app/lib/price-poller.server.ts:51-106`).

Market hours gate quotes only. A weekend or overnight tick can still fill history
(`app/lib/prices.server.ts:394-431`). A local `running` bit prevents an interval backlog. Across
processes and refresh origins, `pg_try_advisory_lock` serializes work. It uses a dedicated pooled
session and destroys a connection when failure leaves lock state uncertain
(`app/lib/prices.server.ts:39-65`).

### Refresh now

`POST /refresh` directly calls `runRefresh({ quotes: true })`, so a person pressing the control
forces quotes regardless of market hours and also runs one history batch
(`app/routes/refresh.ts:13-25`). It uses the same provider, advisory lock, and composition as the
poller (`app/lib/refresh.server.ts:54-76`).

The result is `done`, `busy`, or `error`. Provider failure is intentionally a completed refresh:
old values remain, affected rows become stale, and the attempt is recorded. `error` is reserved for
database or lock failure (`app/lib/refresh.server.ts:19-32`, `app/lib/prices.server.ts:482-552`). A
busy press does not queue a follow-up; that is reasonable for a visible control which renders the
outcome.

### Cadence changes

Settings accepts a trimmed whole number from 1 through 1440, while the database repeats the bound
in a CHECK (`app/lib/settings.server.ts:84-110`, `migrations/0008_refresh_cadence.sql:1-5`). Saving
updates only the singleton row. It does not signal the process or call the poller
(`app/lib/settings.server.ts:125-138`, `app/routes/settings/prices.tsx:26-42`).

A poller learns the new value on its next tick at the old cadence and then resets the interval
phase (`app/lib/price-poller.server.ts:37-49`, `app/lib/price-poller.server.ts:63-69`). The UI
accurately discloses this delay (`app/routes/settings/prices.tsx:98-104`). In a multi-process app,
each process eventually observes the row independently and the advisory lock prevents duplicate
work from overlapping.

No app-to-worker cadence message is needed or desirable. The worker has no scheduler. If faster
application is wanted, notification belongs inside the app trust domain: retime the local poller
after a successful save, and use a Postgres notification or bounded configuration poll only if
multiple app processes become supported.

## 3. New symbols and old statements

### A new symbol

Instrument resolution validates submitted fields and probes each distinct new feed symbol before
writing it (`app/lib/instrument-resolution.server.ts:199-446`). A confirmed foreign-currency
instrument is refused. Provider unavailability deliberately does not block a statement upload; a
probe result can therefore be `unavailable`.

Instrument, classification, and alias changes are transactional. Concurrent alias resolution
keeps the existing winner and removes the newly orphaned instrument
(`app/lib/instrument-resolution.server.ts:448-539`). After final statement commit, the upload route
calls `requestRefresh()` without awaiting it (`app/routes/upload/review.tsx:55-71`). No symbol
registration message is sent to the worker: the next quote refresh selects all feed instruments
with a non-null symbol (`app/lib/prices.server.ts:81-88`).

One consequence is that resolving an instrument happens before statement commit. If the draft is
abandoned, the unheld feed instrument remains and periodic quote selection still includes it. It
can consume calls and archive observations indefinitely; history selection does not, because it
joins actual holdings (`app/lib/instrument-resolution.server.ts:494-506`,
`app/lib/prices.server.ts:121-146`).

### An older statement and the price spine

A head gap exists when no `price_daily` close is on or before the earliest position-set date that
holds an instrument. One SQL predicate serves both candidate selection and the Settings display
(`app/lib/prices.server.ts:102-112`). Automatic candidates are feed-priced, have a symbol, and have
not been attempted in the preceding day. The deepest gaps go first, with at most five instruments
per refresh (`app/lib/prices.server.ts:121-166`).

The request begins seven calendar days before first held, allowing a preceding trading close to
carry across a weekend or holiday, and ends at today's market date. Calls are sequential. Normal
outcomes are ledgered, closes and the ledger row commit together, and an existing close is never
overwritten by history (`app/lib/prices.server.ts:287-381`, `app/lib/prices.server.ts:637-659`,
`migrations/0010_price_backfill.sql:1-53`).

The Settings page includes gaps automation cannot fill, such as manual and symbol-less
instruments, and explains why (`app/lib/prices.server.ts:168-245`,
`app/routes/settings/prices.tsx:122-215`).

## 4. Independent validation: neither container is trusted

### The worker distrusts the app

- `/quotes` accepts 1–100 independently validated symbols.
- `/history` accepts one independently validated symbol and a date-shaped string.
- Bodies are capped at 16 KiB before JSON parsing.
- Sliding one-minute limits admit 10 quote and 20 history calls.
- The server permits at most eight connections and one request per socket
  (`server/price-worker.ts:19-26`, `server/price-worker.ts:48-58`,
  `server/price-worker.ts:71-85`, `server/price-worker.ts:139-153`,
  `server/price-worker.ts:350-352`).

These controls protect Yahoo and worker resources from a compromised app. They do not attempt to
authenticate the app beyond possession of the socket mount.

### The app distrusts the worker and provider

- Quote responses have a 15-second budget and 512 KiB cap; history has 35 seconds and 2 MiB.
- The wire result is `unknown`; domain converters parse individual values with Zod.
- Prices and closes must be finite, positive, and fit the database numeric column.
- Non-USD data is refused.
- A history response with an unresolved split is rejected atomically.
- Out-of-range history bars are removed before they can satisfy gap coverage.
- Live daily closes outside a ±7-day market-date window are not stored.
- Archived raw quote JSON must serialize and fit 32 KiB
  (`app/lib/provider-socket.server.ts:31-48`, `app/lib/provider-socket.server.ts:65-180`,
  `app/lib/price-provider.server.ts:80-310`, `app/lib/prices.server.ts:606-719`).

Validation can prove shape and bounded arithmetic inputs. It cannot prove market truth. A worker
which returns a plausible positive USD price can poison valuations; this accepted limitation is
correctly recorded in `DESIGN.md:1577-1583`.

### Database boundaries

Quote, observation, stale-state, and poll-row writes share one transaction
(`app/lib/prices.server.ts:503-555`). Live quotes can converge the current day through upsert;
historical closes insert only where absent (`app/lib/prices.server.ts:558-659`). Backfill outcomes
have database constraints tying outcome, write count, and error presence together
(`migrations/0010_price_backfill.sql:24-48`).

The worker and proxy hold no database secret. The app still uses the database owner/superuser role,
so app compromise retains full database blast radius. Separating runtime and migration roles
remains worthwhile (`DESIGN.md:1594-1597`).

## 5. Findings and recommendations

Severity measures the consequence within the documented single-household deployment, not attacker
intent.

### D1 — High: absent currency can be persisted as USD

Currency is optional in the quote schema and nullish in history metadata. Both converters reject
only an explicit non-USD string (`app/lib/price-provider.server.ts:104-117`,
`app/lib/price-provider.server.ts:159-164`, `app/lib/price-provider.server.ts:191-198`,
`app/lib/price-provider.server.ts:242-245`). Missing currency therefore crosses the trust boundary
and can persist a foreign quote or close as dollars. This is corruption, not staleness: every
downstream total reads a numerically valid value in the wrong unit.

**Change.** Require explicit `USD` for quote and history persistence. Treat missing or unreadable
currency as unavailable/refused. If history needs an operational distinction, add a closed ledger
outcome rather than guessing the unit. Replace the tests which currently pin acceptance of missing
currency with refusal regressions (`tests/price-provider.test.ts:211`,
`tests/price-provider.test.ts:628`).

### D2 — High: fetch time can be persisted as a fabricated market date

Using fetch time as current-quote freshness is a defensible fallback, but using it as daily-close
provenance is not. `instantOf` substitutes `fetchedAt` when Yahoo supplies no time, and the daily
writer derives a date from that substitute (`app/lib/price-provider.server.ts:121-124`,
`app/lib/prices.server.ts:606-632`). It can create a weekend/holiday row despite the schema's
no-non-trading-day model, or file a prior session's value after midnight
(`migrations/0001_initial_schema.sql:135-142`). The valuation query then carries that row forward,
and insert-only backfill cannot repair it (`migrations/0003_holding_valued_at.sql:49-58`,
`app/lib/prices.server.ts:637-655`).

**Change.** Preserve timestamp provenance in `ProviderQuote`. A missing provider instant may still
produce a current quote stamped at fetch time, but it must not produce a daily close. Add weekend
and market-date-boundary regressions.

### D3 — High: same-instant corrections diverge across price stores

`price_observation` is keyed only by instrument and provider instant. Conflict handling always does
nothing, even if price or payload changed (`migrations/0009_price_observation.sql:2-20`,
`app/lib/prices.server.ts:722-732`). In the same refresh, current quote and daily close do update.
The 1D series reads observation prices, so it can permanently disagree with both other stores
(`app/lib/valuation.server.ts:425-469`).

**Change.** Decide the observation contract explicitly. If it means latest provider correction at
an instant, conditionally update the conflicting row. If it is an immutable receipt log, add a
separate identity/version so both receipts survive and define which the 1D series uses. Add one
regression asserting current quote, daily close, observation, and 1D valuation agree after a
same-`asOf` price correction.

### P1 — High: an out-of-range numeric timestamp can abort a whole refresh

`parseInstant` checks that a numeric timestamp is finite, constructs a `Date`, and returns it
without checking `getTime()` (`app/lib/price-provider.server.ts:126-137`). A finite epoch outside
JavaScript's supported date range produces `Invalid Date`. Quote assembly accepts it, then
observation writing calls `toISOString()`, which throws (`app/lib/price-provider.server.ts:178-187`,
`app/lib/prices.server.ts:701-719`).

One malformed quote can roll back every instrument's refresh, including stale marking and the poll
record. The corresponding split-date path has smaller scope: it is caught for that candidate,
ledgered `provider_failed`, and the batch continues
(`app/lib/price-provider.server.ts:258-269`, `app/lib/prices.server.ts:311-334`). The quote failure
still violates the boundary's promise that raw worker data is safely narrowed.

**Change.** Validate `Number.isNaN(date.getTime())` after the numeric conversion, as the string and
`Date` branches already do. Add quote and history regressions using finite, out-of-range epoch
values.

### P2 — High: stale provider answers can move a current quote backwards

The refresh consumes provider answers in response order and writes each match
(`app/lib/prices.server.ts:496-520`). The quote conflict update unconditionally replaces `price`
and `as_of`, and the same-day close update is also unconditional
(`app/lib/prices.server.ts:558-632`). A duplicated response, stale replay, changed provider
ordering, or compromised worker can therefore replace a newer quote with an older one and move the
freshness timestamp backwards.

**Change.** Normalize and deduplicate answers per symbol and market date, retaining the newest valid
instant. Gate the current quote and `quote_type` on that accepted newest answer. Prevent an older
answer from replacing the close for the *same* instrument and market date; do not discard an older
answer for a different date merely because the current quote is newer. Because `price_daily` stores
no source timestamp, robust cross-refresh ordering may require storing one, or a narrower comparison
with `quote.as_of` only when both share the market date. A conditional quote upsert alone is
insufficient if the close and type writes still run. Test both response orders and an older answer
arriving in a later refresh.

### P3 — High: scheduled pricing is coupled to browser traffic

The poller is started only from the root loader and performs no immediate refresh
(`app/root.tsx:177-180`, `app/lib/price-poller.server.ts:108-135`). A healthy deployment which no
one visits has no timer after boot. Quotes and backfill can remain stopped indefinitely, while all
container health checks stay green. The first visit merely starts a 15-minute timer.

This is documented in `docs/operating.md:1156-1164`, but it conflicts with the ordinary meaning of
a scheduled service and makes unattended history repair depend on page views.

**Change.** Start the scheduler from a real server lifecycle hook or an app-trust-domain scheduler
entrypoint. Keep policy out of the worker and retain the database advisory lock so duplicate app
processes remain safe. Do not make readiness depend on Yahoo availability.

### P4 — Medium: every restart initially ignores the stored cadence

Startup always arms the seed value of 15 minutes. The stored row is first read when that timer
fires (`app/lib/price-poller.server.ts:23-24`, `app/lib/price-poller.server.ts:118-130`). A configured
one-minute cadence waits 15 minutes after restart; a configured daily cadence makes an unwanted
attempt after 15 minutes. Repeated restarts can make substantially more calls than the operator's
dial requests.

This is not merely “one old cadence”: a fresh process substitutes a seed for the user's setting.

**Change.** Bootstrap the timer asynchronously from `readRefreshCadence()`, using 15 only when that
read fails. Retain the per-tick read for later changes.

### P5 — Medium, recorded limitation: feed symbols can be saved that the worker will always refuse

Instrument creation accepts any trimmed symbol up to 40 characters
(`app/lib/instrument-resolution.server.ts:225-231`). The worker protocol accepts only the narrower
1–15-character alphabet in `server/symbol-pattern.ts:1-10`. Probe converts a refusal/failure into
`unavailable`, so creation succeeds. Quote refresh later drops the symbol locally, and history is
rejected by the worker (`app/lib/provider-socket.server.ts:191-207`,
`app/lib/provider-socket.server.ts:257-285`).

The result is a feed-priced instrument which can never be automatically priced. The mismatch is
already catalogued at `DESIGN.md:1598-1602`; this review confirms it remains present rather than
claiming a new discovery.

**Change.** Use the shared symbol predicate in feed-instrument form validation and return a field
error. If 40 characters is a real domain requirement, widen the protocol deliberately and test it
instead.

### P6 — Medium: upload-triggered refresh is lossy under ordinary races

After commit, upload calls the non-awaited `requestRefresh()`. `tick()` returns immediately when a
local refresh is active, and a request made before that process's root loader started the poller is
also discarded; neither case is replayed (`app/routes/upload/review.tsx:55-71`,
`app/lib/price-poller.server.ts:51-55`, `app/lib/price-poller.server.ts:137-158`). Tests explicitly
pin both loss cases (`tests/price-poller.test.ts:326-389`).

A scheduled refresh can select its work, then an upload can commit a new symbol or deeper historical
gap, and the requested follow-up can be dropped. At the maximum cadence, expected post-upload work
can wait almost a day.

**Change.** Add a one-bit pending latch. A request received during a run should cause exactly one
forced follow-up when it finishes. Do not queue one refresh per upload. Once scheduler startup is
decoupled from loaders, “not started” should disappear; until then, an awaited direct
`runRefresh({quotes: true})` is safer than fire-and-forget.

### P7 — Medium: the proxy's “non-public” check is incomplete

The proxy comment promises rejection of non-public addresses, but `isPrivateAddress()` is a partial
denylist (`server/egress-proxy.ts:5-6`, `server/egress-proxy.ts:81-105`). It admits special-use
ranges including `192.0.0.0/24`, documentation nets, benchmarking `198.18.0.0/15`, multicast, and
reserved space. The classifier tests do not cover the omitted special-use ranges
(`tests/egress-proxy.test.ts:216-256`, `tests/egress-proxy.test.ts:439-440`).

Most omitted ranges do not yield an immediate useful SSRF target; exploitation requires malicious
DNS plus a usable route to one of them. A security boundary should nevertheless say and enforce the
same thing. A malicious resolver can also map an allowed name to the host's
public address, which a global-unicast classifier alone would still accept.

**Change.** Prefer a positive, well-tested globally routable unicast classifier and explicit tests
for special-use IPv4 ranges. Separately decide whether the host's public addresses must be excluded.
If only RFC1918/LAN containment is intended, narrow the documented guarantee instead.

### P8 — Medium: quote validation does not bound downstream quantity multiplication

Provider conversion bounds a price to the price column, not the later quantity × price product
(`app/lib/price-provider.server.ts:92-101`). Upload validation checks a holding against the quote
known at upload time (`app/lib/uploads.server.ts:705-727`). An unpriced large holding can therefore
be accepted and later receive a valid price which overflows a valuation expression; a sufficiently
large price move can do the same to an existing holding.

**Change.** Before committing a quote, validate the candidate price against relevant stored holding
quantities with the existing exact-decimal bound. Refuse only the affected instrument and mark it
stale. First reproduce the database/view failure in a focused test so the real numeric boundary,
not an assumed one, determines the fix.

### P9 — Medium, needs reproduction: long history ranges meet a fixed response cap

Backfill has no maximum lookback, while the socket adapter refuses a history body over 2 MiB
(`app/lib/prices.server.ts:121-165`, `app/lib/provider-socket.server.ts:40-44`,
`app/lib/provider-socket.server.ts:97-105`). Payload size grows with the requested history, but this
review did not measure a valid range whose ordinary Yahoo response exceeds the cap. The cap is an
important defense against a compromised worker, so removing it is the wrong response if the risk is
reproduced.

**Change.** First prove the threshold with a fixture or captured payload. If reproduced, fetch
bounded date windows, ledger the attempted subrange, preserve insert-only writes, and continue
oldest-first until there is a close on or before first held.

### P10 — Medium: an older upload inherits an unrelated one-day retry delay

Candidate exclusion asks only whether *any* attempt for the instrument began in the preceding day.
It does not compare the newly required `range_from` with what that attempt covered
(`app/lib/prices.server.ts:131-143`). If a user imports an older statement just after a backfill,
the new, deeper gap waits for the old retry clock.

**Change.** Skip only where the latest attempt's range reaches at least as far back as the current
required range, or explicitly let a newly deepened gap bypass the retry interval.

### P11 — Medium: abandoned drafts can create permanent quote traffic

Instrument creation precedes final statement commit, while scheduled quote selection includes every
feed instrument rather than only held instruments (`app/lib/instrument-resolution.server.ts:455-539`,
`app/lib/prices.server.ts:81-88`). An abandoned draft can therefore leave an unused ticker which is
quoted and archived forever.

**Change.** First decide whether keeping unheld instruments warm is desired. If not, either defer
instrument creation to final commit, garbage-collect safely orphaned draft instruments, or select
only instruments referenced by position sets. Do not silently choose “currently held” if historic
instruments are meant to retain current quotes.

### P12 — Low: the worker accepts impossible calendar dates

The history boundary checks only `YYYY-MM-DD` shape, so `2026-99-99` is admitted
(`server/price-worker.ts:55-58`). The honest app produces a valid `IsoDate`; this matters only to the
worker's independent defense against a compromised app.

**Change.** Validate a real calendar date and reasonable lower/upper bounds locally in the worker.

### P13 — Low: refusal paths can flood worker logs without spending provider quota

Rate admission happens only after an endpoint body passes validation. Unknown routes and many
refusals are logged without a log-rate bound (`server/price-worker.ts:193-231`,
`server/price-worker.ts:276-307`). A compromised app can consume log I/O without using Yahoo-facing
quota.

**Change.** Rate-limit or sample refusal logs and periodically report a suppressed count. Continue
to answer refusals; do not hide health checks behind the limiter.

## 6. Deliberate limitations, not bugs

### Interior history holes are not detected

The gap predicate proves only that the spine reaches first held. Once an early close exists, it does
not find missing trading sessions later in the range (`app/lib/prices.server.ts:102-112`). That is
an explicit decision because reliable hole detection needs a trading calendar; calendar-day
inference would invent gaps on weekends and holidays
(`docs/adr/0011-a-backfill-fills-the-spine-but-never-moves-it.md:90-94`).

The Settings empty state saying nothing is missing is broader than the actual guarantee. Prefer
“history reaches every first-held date” unless a trading-session model is added.

### Unfillable history retries forever

Delisted, renamed, and no-history symbols remain head gaps and retry daily. This is intentional:
the provider can change and the application has no terminal proof that a gap can never be filled
(`docs/adr/0011-a-backfill-fills-the-spine-but-never-moves-it.md:117-119`). The one-day ledger pace
bounds the cost.

### Ticker identity is not historical identity

History under today's ticker is assigned to the instrument even across ticker changes or ticker
reuse (`docs/adr/0011-a-backfill-fills-the-spine-but-never-moves-it.md:106-109`). Fixing this needs
instrument-identity history, not a provider parsing tweak.

### Partial portfolio history may look complete

During a multi-refresh backfill, a date can contain prices for only part of the household. Charts
can therefore show a partial total without a coverage warning
(`docs/adr/0011-a-backfill-fills-the-spine-but-never-moves-it.md:96-105`). That is a presentation and
coverage-model limitation worth keeping visible.

## 7. Is the egress proxy worth keeping?

Yes.

The worker joins only the isolated `worker-proxy` network and receives `HTTPS_PROXY`; the proxy is
the only service on that path with ordinary outbound routing (`compose.yaml:162-220`). The proxy:

- permits CONNECT only;
- requires port 443;
- refuses IP literals;
- exact-matches five Yahoo hosts rather than suffix matching;
- resolves the name itself, rejects selected local addresses, and connects to that checked literal;
- reads a bounded first TLS record and requires SNI equal to the CONNECT host;
- caps connections and applies establishment and idle deadlines
  (`server/egress-proxy.ts:28-37`, `server/egress-proxy.ts:115-193`,
  `server/egress-proxy.ts:195-350`, `server/egress-proxy.ts:395-450`,
  `server/egress-proxy.ts:497-540`).

This blocks the high-value generic outcomes of a worker bug or dependency compromise: scanning the
LAN, dialing Postgres, contacting arbitrary command-and-control hosts, or using a DNS rebinding
answer to reach a private address. Exact SNI checking prevents the worker from naming an allowed
CONNECT target and beginning TLS for another host.

It does not inspect encrypted HTTP. A compromised worker can encode data into paths, queries,
headers, or bodies sent to an allowed Yahoo property. SNI says which hostname the client requested,
not whether Yahoo's edge routes the encrypted request exactly as expected. A worker can also occupy
all proxy sockets, flood logs, or make every quote stale.

The largest structural residual is correlated image compromise: app, worker, and proxy use the same
image artifact, although their runtime import closures differ (the proxy imports only Node core).
A `yahoo-finance2` compromise directly reaches the worker, not the proxy merely because the package
is present in the image. The proxy itself has egress, and a compromised app holds the database. A
separate minimal worker/proxy image and a smaller hand-written Yahoo client improve
independence; removing the proxy makes containment strictly worse
(`docs/adr/0010-price-fetching-is-an-egress-isolated-worker-behind-a-unix-socket.md:112-122`).

Isolation also depends on Docker Engine 28's
`com.docker.network.bridge.gateway_mode_ipv4: isolated` behavior (`compose.yaml:354-380`). Older
Engine behavior can invalidate the topology, so the deployment smoke test is part of the control,
not optional documentation (`DESIGN.md:1616-1620`).

## 8. Health and observability

Worker health proves only that its Unix listener exists. Proxy health proves only that its local
HTTP listener exists. The app depends on database health, not Yahoo, worker, or proxy health
(`compose.yaml:123-126`, `compose.yaml:189-231`). This is correct: an external outage should not
cause restart churn.

The cost is that the stack can be green while pricing is unavailable, and the worker check does
not prove the app's read-only socket mount can connect. Stale flags, poll rows, backfill ledger, and
log stems are the operational signals. A pricing-status view could improve diagnosis, but it should
not become app readiness.

### `/healthz` does not report pricing health

The public app endpoint has an intentionally narrow contract: `200` means the database answers and
the shipped migrations are current. It never calls the worker, proxy, or Yahoo
(`app/routes/healthz.ts:3-20`, `app/lib/db.server.ts:60-90`). Therefore all of these can coexist with
a green `/healthz`:

- `worker` stopped, omitted, restarting, or unreachable through the app's socket mount;
- `egress-proxy` stopped, omitted, or unreachable from the worker;
- DNS, allowlist, CONNECT, TLS, or Yahoo failures;
- a poller which has never started because no page loader has run;
- a poller startup failure which was caught to preserve page rendering.

That separation is correct for liveness. The app can still serve last-known values, and making a
third-party outage return `503` would encourage an orchestrator to restart a healthy app without
repairing the dependency (`app/routes/healthz.ts:4-6`). The architectural issue is not that
`/healthz` stays green; it is that no passive, dedicated machine-readable status reports end-to-end
pricing readiness without triggering a refresh.

### What each existing signal can and cannot see

The worker's Docker healthcheck calls its own Unix listener as the worker's UID. For a running
container it detects a wedged or unavailable listener, but not whether the app can cross its
separate read-only mount. An exited, restarting, or omitted worker is visible only through Compose
service/process state, not public `/healthz`; the app has no `depends_on` edge to it
(`compose.yaml:123-139`, `compose.yaml:163-200`).

The proxy's Docker healthcheck calls its own loopback HTTP listener. The worker health endpoint does
not call the proxy. A running proxy with a broken listener becomes unhealthy; an exited, restarting,
or omitted proxy is visible through Compose state. Yahoo can be unreachable while both worker and
proxy remain healthy (`server/price-worker.ts:283-288`,
`server/egress-proxy.ts:487-495`, `compose.yaml:202-231`). This is also intentional: neither local
process should restart merely because an upstream is down.

Once a quote attempt actually runs, visibility is better. Provider failure marks existing quote
rows stale and writes a `price_poll` with requested, priced, and stale counts
(`app/lib/prices.server.ts:482-493`, `app/lib/prices.server.ts:529-552`,
`app/lib/prices.server.ts:737-751`). A manual refresh reports provider failure in the UI, while logs
retain enough error text to distinguish app-to-worker socket errors from proxy/upstream errors
(`app/components/price-freshness.tsx:55-69`, `docs/operating.md:1099-1124`). Backfill failures have
their own ledger (`migrations/0010_price_backfill.sql:1-44`).

These are post-attempt signals, not pipeline readiness. If no page loader starts the scheduler,
there is no attempt, stale transition, poll row, or refresh log. A caught synchronous startup
failure emits only a one-off error log and likewise leaves no durable status. Silence cannot
distinguish a scheduler that was never bootstrapped from a legitimate quiet period. A database
failure during the transaction can also leave no poll row because the attempt record commits with
the price writes
(`migrations/0009_price_observation.sql:33-53`).

Freshness has one more blind spot: stale marking updates existing `quote` rows. A newly held feed
instrument with no quote has no row to mark, and the freshness query inner-joins `quote`, excluding
that instrument from its normal priced/stale summary (`app/lib/prices.server.ts:529-540`,
`app/lib/prices.server.ts:782-805`). A failed manual refresh and the poll ledger expose the failure,
but the ordinary freshness timestamp need not expose the never-priced holding.

### Recommended health split

Keep `/healthz` and the Docker healthchecks narrow. Do not add a live Yahoo request to any of them,
and do not make app readiness depend on pricing: last-known portfolio data is still useful during an
outage.

Add a separate authenticated, read-only pricing-status surface, or a monitoring endpoint explicitly
excluded from restart decisions. Derive it from durable state rather than probing Yahoo on demand:

- latest quote attempt and its age relative to cadence and market hours;
- requested, priced, and stale counts from the latest poll;
- held feed instruments which have no quote row;
- latest backfill failures and remaining head gaps;
- scheduler heartbeat or last tick, including off-hours ticks which attempt no quotes.

The heartbeat closes the most serious monitoring gap: “the pipeline attempted and failed” is
already visible, while “the pipeline was never bootstrapped” has no durable signal. A shared row
persists across restarts and proves at least one scheduler is ticking. If every app process must be
observed independently, the heartbeat needs a process identity or lease; an in-memory flag and one
shared timestamp cannot prove that.

Monitor Compose service presence and each container's local health separately. An optional
app-to-worker socket probe can diagnose mount and permission failures, but it belongs in deployment
monitoring rather than app liveness. This yields three distinct answers instead of one overloaded
green light: app/database readiness, local process topology, and pricing-pipeline freshness.

## 9. Recommended delivery order

Each item should be one independently green pull request.

1. Require explicit USD before persisting quotes or history.
2. Keep undated quotes out of the daily-close table.
3. Resolve same-instant observation corrections and test agreement across all price stores.
4. Reject invalid numeric dates, with quote and split regressions.
5. Make current quote, quote type, and same-date close writes monotonic; deduplicate batch answers.
6. Apply the shared worker symbol rule at feed-instrument creation.
7. Bootstrap scheduling outside the root loader and from the stored cadence.
8. Coalesce upload refresh requests which arrive during a run.
9. Correct the proxy address classifier and its tests.
10. Reproduce and then guard downstream quantity × future-price overflow.
11. Reproduce the long-history response risk, then let deeper new gaps bypass stale retry state.
12. Resolve the product decision for unused draft instruments.
13. Tighten impossible-date admission and refusal-log pacing.

Immediate cadence propagation is optional after scheduler bootstrap. The current delayed behavior is
accurately disclosed and avoids another coordination mechanism. If changed, keep cadence ownership
in the app; never teach the price worker to schedule itself.

## Method and limits

This review traced code, schema, tests, Compose enforcement, and the accepted decisions in ADR-0006,
ADR-0010, and ADR-0011. The pricing-focused test command could not run its database-backed cases
because no Postgres listened at the test URL and Docker is unavailable in this environment. The
worker/proxy-only cases did run within that command. Typecheck and production build completed. No
live Yahoo call was made, which is appropriate for deterministic validation but means provider and
Docker behavior is supported by the repository's prior platform research rather than re-probed here
(`docs/research/2026-09-04-price-worker-platform-facts.md`).

## Addendum — 2026-09-08

Left as a snapshot above rather than rewritten, per `docs/research/README.md`'s convention.

**P3 ("scheduled pricing is coupled to browser traffic") is fixed** — the "Bootstrap scheduling
outside the root loader" recommendation at item 7 of §9. `startPricePoller()` is now called from a
root `middleware`, last in `app/root.tsx`'s exported array, rather than from the root loader
(`docs/specs/price-health/01-arm-the-poller-from-middleware.md`). React Router runs middleware for
every request, including a resource route with no `default`/`ErrorBoundary` such as `/healthz`,
where it does not run a parent loader — so the container's own healthcheck now arms the timer on
boot, and a healthy instance nobody has browsed to no longer sits with scheduled pricing stopped
forever. The §2 "Scheduled refresh" description above (`app/root.tsx` calling `startPricePoller()`
"from its root loader") and §8's "a poller which has never started because no page loader has run"
now describe the pre-fix state; `docs/operating.md` and `ARCHITECTURE.md` carry the corrected claim.

The lazily-built default provider (`provider?: PriceProvider`, resolved as `provider ?? socketProvider()`
inside `startPricePoller`'s own `try`) went with it: the function is now called on every request
rather than every page render, so a throw building the default provider had to stay caught there
rather than escape as an uncaught response.
