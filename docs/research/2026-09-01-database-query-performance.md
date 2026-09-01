# Database query performance — 1 September 2026

An investigation of the application's database reads, writes, indexes and caching options against
the current tree. This is a recommendation and an evidence plan, not an approved implementation
slice. The design envelope is a self-hosted household with roughly 100 priced instruments, not a
multi-tenant service (`DESIGN.md:784-792`; `ARCHITECTURE.md:1789-1797`).

**Deliberate duplication:** the architecture, migrations and ADRs remain the sources to believe for
the shipped scale envelope, storage estimates, index rationale and cache/security decisions. This
report restates those facts only where they are premises for comparing performance options.

## Answer

**Do not add Redis, a materialized valuation view, generic query caching or speculative indexes.**
The schema already has indexes aligned to its important lookups, while the repository has no
production-shaped query plans or latency baseline. Adding another stateful service or another large
observation index before measuring would buy an unproved benefit and create a real correctness or
write-cost liability.

There is one concrete optimization worth building after a baseline: **batch the price refresh's
per-instrument writes**. A refresh currently issues up to three awaited statements for each match,
in sequence, inside one transaction (`app/lib/prices.server.ts:253-268`); a null provider quote type
skips one of them (`app/lib/prices.server.ts:350-356`). At 100 unique matches that is roughly
200–300 client/database statement exchanges per poll; duplicate provider results can produce more
matches. The application permits a one-minute refresh cadence
(`migrations/0008_refresh_cadence.sql:24-27`). The observations writer
already demonstrates the bulk-insert shape (`app/lib/prices.server.ts:460-472`). Batching the other
three tiers removes round trips without changing freshness, invalidation or valuation semantics.

The main read-side risk is the 1-day session series. It resolves each current holding at every
distinct observed instant, with backward probes into both observation and daily-price history
(`app/lib/valuation.server.ts:689-743`). It should be benchmarked at the one-minute envelope before
being rewritten. The architecture predicts hundreds of milliseconds at 390 instants but also says
the largest exercised data set is only the demo household (`ARCHITECTURE.md:1795-1805`): it is a
risk, not yet a measured bottleneck.

## What exists today

### Indexes match the intended access paths

The valuation and pricing paths audited are not missing an obvious lookup index:

* latest-position resolution has `(account_id, as_of_date desc, created_at desc, id desc)`
  (`migrations/0001_initial_schema.sql:168-170`);
* holdings are unique by position set and instrument, with a reverse instrument index
  (`migrations/0001_initial_schema.sql:193-200`);
* the daily-price primary key is `(instrument_id, date)`, matching the carry-forward lookup
  (`migrations/0001_initial_schema.sql:206-212`);
* the observation primary key is `(instrument_id, as_of)`, and `(market_date, as_of)` finds a
  session and its instants (`migrations/0009_price_observation.sql:42-67,86-96`).

Those paths are deliberately documented as stop-at-first-row scans
(`ARCHITECTURE.md:1810-1825`). Static inspection therefore does not justify another index.
This is not a claim that every foreign key is indexed: `upload_draft.account_id` is not
(`migrations/0004_upload_draft.sql:33-43`), but drafts are few and are read by their primary key
(`ARCHITECTURE.md:1807`; `app/lib/uploads.server.ts:246-262`), so indexing it is not a useful
performance recommendation.

### Reads avoid network N+1, but some repeat database work

Historical chart dates are evaluated in one database statement, not one application round trip per
date (`app/lib/valuation.server.ts:535-581`). The database still repeats the as-of work for each
sample, so the all-history range is a benchmark target rather than a free operation.

Several loaders issue independent valuation reads concurrently. Analysis requests both detailed
current holdings and the current total (`app/routes/analysis.tsx:165-178`). Overview requests its
rollup, change, chart and freshness together (`app/routes/overview.tsx:130-144`). This reduces
latency waves but does not reduce query count and can consume several pool clients per request. The
pool has no application-specific size tuning (`server/db.ts:45-53`). Consolidation or pool tuning
should follow traces and a concurrency test, not precede them.

### The observation log is the scaling boundary

The observation log is retained forever and is expected to grow by about 0.5 GB per year at the
default cadence, roughly fifteen times faster at one minute
(`migrations/0009_price_observation.sql:35-41`). Its heap is already tuned to keep archived JSON
payloads out of price scans (`migrations/0009_price_observation.sql:68-84`).

The 1-day query first derives session instants, then performs a latest-observation lookup and a
daily-close fallback for every current holding at every instant
(`app/lib/valuation.server.ts:696-731`). That multiplication makes it the strongest read-side
candidate for measurement. A covering index might avoid heap reads, but it would duplicate a large,
write-hot key and amplify every poll. A set-based interval query might remove repeated probes, but
it would put the carry-forward and coverage rules at greater regression risk. Neither is yet the
recommendation.

## Recommendations and theses

### 1. Establish a repeatable baseline first

**Thesis:** query plans and latency at the supported envelope distinguish a scaling problem from a
query that merely looks elaborate. The repository currently documents intended access paths but
keeps no benchmark or `EXPLAIN` evidence.

Split the evidence into small pieces rather than building one performance framework:

1. reuse or extend the domain seed builders in `tests/support/fixtures.ts` from a separately invoked
   refresh harness, recording elapsed time and WAL at 0, 1, 100 and 1,000 matches; keep only
   correctness and deterministic statement-count assertions in Vitest, never timing thresholds;
2. reuse the existing valuation integration-test shapes from a separate read harness with
   deterministic supported-envelope data, including 100 instruments, 180 historical samples and a
   full 390-instant one-minute session;
3. add route/concurrency tracing only after query baselines identify a pool or loader question.

For the current valuation, all-history series and 1-day series, capture:

* `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)` plans where applicable;
* elapsed p50/p95 over repeated warm runs;
* statement count, rows, shared-buffer hits/reads and temporary I/O;
* query latency and plan shape across the supported fixture sizes.

Keep the harness under `docs/research/database-query-performance/harness/`; it is evidence, never an
application dependency, per `docs/README.md:50-51`. Reuse application test fixtures rather than
creating a second generic seed system. Make `pg_stat_statements` an optional production
cross-check rather than a dependency: a self-hoster may not enable extensions. Record machine,
PostgreSQL image, fixture shape and commands beside results so later runs are comparable.

Use repeated warm runs for comparisons. Do not label a run “cold” unless its procedure controls and
records both PostgreSQL and operating-system cache state; reconnecting or restarting a container is
not enough to establish that.

Do not invent a latency target from this static audit. Run the baseline, inspect the user-visible
latency distribution, then record a budget that separates noise from a meaningful regression.

### 2. Batch the refresh writer

**Thesis:** replacing per-instrument statement exchanges with a constant number of set-based writes
reduces transaction duration and database protocol overhead without introducing a cache or changing
the domain answer.

In one independently green ticket, retain the existing transaction and replace the refresh loop's
per-row calls with:

1. one bulk quote upsert;
2. one bulk daily-close upsert;
3. one set-based `quote_type` update that preserves the existing value for a null provider type.

Keep the already-batched observation insert and the single stale-marking update. Acceptance should
prove duplicate symbols still update every matching instrument, null quote types preserve stored
values, missing instruments become stale, observation deduplication is unchanged, and a failure
rolls the whole refresh back. Each bulk input must first be normalized by its own conflict key:
latest provider row wins for a quote, latest row on the same instrument/market date wins for a daily
close, and latest non-null provider type wins for the instrument. Those are the current sequential
loop's order semantics; PostgreSQL cannot upsert the same conflict key twice in one statement. Add
explicit duplicate-provider-row and same-market-date cases. Compare query count, elapsed time and
WAL at all four fixture sizes; require fewer statements and no material write amplification.

**Blocked by:** the refresh fixture/query-count benchmark only, so the change carries before/after
evidence without waiting for unrelated route tracing.

### 3. Optimize the 1-day query only if the baseline misses its budget

**Thesis:** this is the read whose work grows as session instants × holdings, but its current indexes
may keep it comfortably inside the household envelope. A conditional ticket avoids paying complexity
for a theoretical problem.

If the measured plan shows repeated probes dominate, benchmark two alternatives against the current
query:

* a set-based interval form that turns each instrument's observations into effective ranges and
  joins session instants to those ranges, with one daily-close fallback per instrument; and
* only if heap reads dominate, an index shaped for the chosen query, potentially including `price`.

Choose the smallest option that meets the recorded budget. Measure index bytes, refresh WAL and
write latency as well as read latency. Preserve tests for an instant before an instrument's first
observation, a cash-only portfolio, owner/account filtering, missing-price coverage, daily-close
fallback and the current-holdings definition.

**Blocked by:** the Read-query baseline. The index experiment is also blocked by selection of the
query shape it is meant to support.

### 4. Consolidate page reads only when traces show a material share

**Thesis:** repeated scans of `holding_valued` are plausible waste, but one purpose-built query per
page increases coupling between list and aggregate semantics. The trade is justified only if traces
show those scans materially affect page latency or pool wait.

Start with Analysis because its detail and total reads visibly share a filter and source. Prefer a
single SQL statement with window aggregates or a shared CTE result over summing decimal strings in
JavaScript. Treat Overview separately; its present total, historical change, chart and freshness are
different answers, not duplicates merely because they concern valuation. Do not increase the pool
size to mask query fan-out until concurrency measurements show database headroom and pool wait as the
actual constraint.

**Blocked by:** route/query tracing from the baseline work.

### 5. Revisit caching only after SQL work, at a measured trigger

**Thesis:** a cache is justified when repeat computation remains a measured constraint and its
invalidation set is smaller and safer than the work it saves. Neither condition is established.

Re-open caching only if supported-envelope page budgets remain missed after the relevant query and
index work, or if deployment changes from one app process to several. A future proposal must name
every writer, key, invalidation event, stale-result behavior, decimal serialization contract,
eviction behavior and cache-outage behavior before implementation.

If that gate is ever crossed, the narrowest candidate is a server-side cache of old historical
series keyed by owner filter and range. Even that is not immutable: backdated uploads, account
closure/metadata changes and corrections to daily prices can alter it. Current valuation and the
in-session series should not be TTL-cached because a successful price refresh is expected to become
visible immediately.

## Options rejected now

### Redis or another external cache

Redis adds a service, deployment/backup/failure behavior and cross-process invalidation to a
single-process household application whose database is already local. Uploads, position revisions,
account edits and closure, classifications, price refreshes and settings all affect some visible
answer. No measured latency problem offsets that correctness surface. Rejected until recommendation
5's trigger is met.

### Materializing `holding_valued`

The migration already considered and rejected materialization: uploads are infrequent, portfolios
are small, and a missed refresh would silently serve stale totals
(`migrations/0002_holding_valued.sql:60-71`). Quotes now refresh as often as every minute, making the
refresh boundary wider, not narrower. Rejected.

### Browser, service-worker or shared HTTP caching of financial responses

The service worker deliberately stores no server data because balances must not persist outside the
authentication gate (`docs/adr/0007-the-service-worker-stores-nothing.md:1-20,42-54`). Financial
responses also change after writes and background refreshes. Rejected on security and correctness
grounds, independently of database performance.

### Generic in-process TTL caching

This avoids a new service but not invalidation. It also creates process/HMR/test boundaries and can
return stale figures after a write. Singleton settings and first-run checks are too small to justify
that machinery (`app/lib/first-run.server.ts:22-36`; `app/lib/settings.server.ts:90-108`). Rejected.

### Adding a covering or BRIN index immediately

The existing btree keys match the equality/range/order predicates. A covering observation index may
help only if heap access dominates; BRIN does not replace the exact per-instrument/session lookups.
Both add storage and poll-time write work to the fastest-growing table. Benchmark candidates, not
recommendations.

## Delivery plan

Each step is one independently testable pull request; later steps remain conditional rather than
turning this investigation into a pre-approved slice.

1. **Refresh-write benchmark.** Build a separately invoked harness that reuses existing seed builders
   to record statement count, elapsed time and WAL for the current loop. **Blocked by: Nothing.**
2. **Batched price persistence.** Replace per-match writes and publish before/after evidence.
   **Blocked by: Refresh-write benchmark.**
3. **Read-query baseline.** Capture reproducible plans and timings for current, historical and
   session valuation at supported-envelope sizes. **Blocked by: Nothing.**
4. **1-day series optimization, if required.** Compare query rewrite and index variants, land only a
   measured winner. **Blocked by: Read-query baseline.**
5. **Route/pool trace, then page consolidation if required.** Trace only the loader shown material
   by query evidence; preserve SQL decimal aggregation. **Blocked by: Read-query baseline.**
6. **Caching decision, only at the trigger.** Write a new research/ADR proposal before adding stateful
   infrastructure. **Blocked by: measured budget misses remaining after the applicable SQL work, or
   a multi-process deployment requirement.**

## Adversarial review record

The first independent grounding pass found seven material issues. The plan was narrowed to the
audited index paths; corrected from three statements per instrument to up to three per match; made
bulk-write conflict normalization explicit; split an over-broad baseline into independently useful
work; reused existing test seed builders without making timing a test assertion; removed an
undefined “cold” benchmark; acknowledged the
architecture's existing latency forecast; and named its deliberate duplication of design sources.
