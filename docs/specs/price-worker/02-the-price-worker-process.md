# 02 — The price-worker process

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.2)._

**What to build:** `server/price-worker.ts` — the standalone Node process that will become the only
internet-touching code in the stack — and the Dockerfile additions that let the published image run
it.

**What it is not.** It runs no domain rule. It does not compose a refresh, does not decide what to
fetch, does not take the advisory lock, and cannot write a price if it wanted to. It reads one row,
makes the provider call that row names, writes the answer back. Everything else stays in the app,
unchanged — which is why this ticket touches `app/lib` only to lift two leaves out of it.

**Blocked by:** 01 (the table and the role).

**Status:** ready-for-agent

**Two leaf extractions, and no more**

- [ ] `matchKey` (`prices.server.ts:733`) moves to a leaf module both sides import.
      `price-provider.server.ts:66` value-imports it today, which would drag `prices.server.ts` and
      `db.server.ts` — the price-*writing* module — into a process that must not write prices.
- [ ] **Its docstring moves with it and states the new reason.** `prices.server.ts:729-731` currently
      argues the opposite — "*Exported rather than moved*… the rule belongs beside the matcher that
      states it" — which was right while both callers were one process. Leaving that text behind
      makes the file argue against its own shape.
- [ ] `app/lib/provider-types.ts`: Zod schemas for `ProviderQuote`, `ProviderHistory` and
      `SymbolProbe`, with the types derived by `z.infer` rather than hand-written twice.
      `price-provider.server.ts` imports them; ticket 04's mailbox module needs them and may not
      value-import `price-provider.server.ts`. Note `asOf` and `fetchedAt` are `Date` and need
      `z.coerce.date()` — see ticket 04.
- [ ] That is the whole of the app-source refactor this slice needs. A third extraction means the
      seam is in the wrong place; stop and say so.

**Startup**

- [ ] Config through the existing `loadConfig` — no second config module; `DATABASE_URL` is the
      worker role's URL, `MARKET_TIMEZONE` is read (the provider's history call takes it), every
      other var defaults
- [ ] Schema-ledger check: every `.sql` the image ships is present in `schema_migrations` (via the
      SELECT-only `pendingMigrations`, `server/migrations.ts:65-75`); waits, does not migrate — the
      role cannot, by design
- [ ] **The pool's `max` is pinned by widening `createPool`, not by a second pool.**
      `server/db.ts:45-53` takes a connection string and no options, and it is the enforced single
      construction site — the one registering the `numeric`/`int8`/`date` parsers
      (ARCHITECTURE.md:337). Add an options parameter there. A `new pg.Pool` in `price-worker.ts` is
      the exact failure that invariant exists to prevent.

**The drain**

- [ ] Polls `fetch_request` for a claimable row — **unclaimed, unexpired, and under the attempt
      bound** (`claimed_at is null and expires_at > now()`), which is what stops an abandoned row
      becoming a Yahoo request nobody is waiting for. Claims it, dispatches on `kind` to `getQuotes`
      / `getDailyCloses` / `probeSymbol`, writes `payload` or `error` with `answered_at`.
- [ ] Reclaim increments `attempts`; past a small bound the row is answered `error` rather than
      retried, so a request that OOMs the worker cannot loop against `restart: unless-stopped`
- [ ] **Say whether the worker talks to Postgres through Kysely or raw `pg`.** The copy set above
      omits `db.server.ts` and `database.generated.ts`, which implies raw `pg` — in which case add
      `database.generated.ts` as a type-only import and to the copy set, so the row types are derived
      rather than hand-written (AGENTS.md).
- [ ] No LISTEN/NOTIFY. Checked against the installed `pg` 8.23.0 rather than recalled: no reconnect
      logic anywhere in `pg/lib`; `Client` emits `'error'` unconditionally on a dead socket
      (`lib/client.js:416-422`) and an unhandled `'error'` takes the process down; and a
      notification reaches only sessions *currently* listening, which is PostgreSQL's rule.
- [ ] No `withRefreshLock`. It stays in the app, taken by the app's callers as today. The worker
      serves calls; it does not decide a refresh is happening.
- [ ] Answers are guarded on the claim, so an overlapping second worker cannot overwrite a landed
      answer — first write wins. A claimed row whose lease expired is claimable again, so a crash
      between claim and answer strands nothing.
- [ ] The drain interval is ~250 ms, not one second: every provider call is now a round trip and a
      refresh makes up to six, so the interval is the latency budget (spec §3.4 has the arithmetic).
      Measure the resulting query rate against the partial index rather than assuming it.

**The bounded provider**

- [ ] **Name the mechanism.** There is no `AbortSignal` anywhere in this tree today, and
      `yahooClient` awaits the library with no signal (`price-provider.server.ts:617-624`), so a
      deadline is `Promise.race` — which **abandons rather than cancels**. First check whether
      `yahoo-finance2` 4.x accepts a real signal through its fetch options; if it does, thread it and
      skip the next two boxes.
- [ ] The losing promise gets `.catch(() => {})`. Rejecting after the race has settled is an
      unhandled rejection, and `price-poller.server.ts:232-236` already records that Node exits the
      process on one — a stalled Yahoo call would kill the worker rather than time out.
- [ ] A re-entrancy guard: no new row is claimed while an abandoned fetch is still in flight, or
      "nothing is issued in parallel and nothing is queued" (`prices.server.ts:530-533`) stops being
      true exactly when Yahoo is unhappy.
- [ ] `new YahooFinance({ versionCheck: false })` — **an edit to `price-provider.server.ts:620`
      itself**, not an option the worker passes in. The client is memoized inside that module
      (`:617-624`); `yahooPriceProvider` takes a client factory (`:705`), but a worker-supplied
      factory would have to `import("yahoo-finance2")` itself, making a second importer and breaking
      the ARCHITECTURE.md §4.2 invariant this slice claims to preserve. One line in the owning module
      is the honest answer, and it means this ticket touches three `app/lib` files, not two.
      Verified against the published 4.0.2 tarball:
      `versionCheck` is a top-level constructor option (`esm/src/lib/options/options.d.ts:44`)
      defaulting to `true` (`defaults.js:25`), and on a result-validation failure the library
      fetches `registry.npmjs.org/yahoo-finance2/latest` (`esm/src/lib/versions.js:6`) — the one
      non-Yahoo call it makes. `price-provider.server.ts:620` passes no options at all today. A test
      pins the option.
- [ ] Symbols are validated against the pattern before they reach a URL, even though the table
      constrains them — the constraint does not bind a compromised app (spec §2.5)

**The image**

- [ ] The runtime stage copies `server/price-worker.ts` and its closure: `price-provider.server.ts`,
      `market-hours.ts`, `money.ts`, `provider-types.ts` and the new `matchKey` module. `server/config.ts`, `server/db.ts`
      and `server/migrations.ts` already ship.
- [ ] The layout preserves `/app/app/lib/` and `/app/server/` as siblings, because the copied
      `app/lib` modules resolve `../../server/*.ts` relatively
- [ ] **`scripts/smoke-test.sh:219-221` will fail.** It asserts `test ! -e /app/app` under "source
      tree leaked into the runtime image", and `ci.yml:138` runs it. Replace the blanket check with
      an allowlist of exactly the worker's closure — a better assertion, because it then fails both
      when a module is added to the image and when one is missing, which is the copy set's real
      risk.
- [ ] The entrypoint lives under `server/`, not `scripts/` — `.dockerignore:13` excludes `scripts/`
      from the build context, re-including only `prune-unreachable-deps.mjs` at `:14-15`
- [ ] A `node --experimental-strip-types`-free plain `node -e "import('./server/price-worker.ts')"`
      from the checkout proves the closure loads before smoke does. Node 24 needs no flag, and the
      explicit `.ts` extensions the closure already uses are **mandatory**, not optional.

**Tests** (real Postgres, `withDatabase`, fake provider through the `PriceProvider` seam)

- [ ] Each `kind` round-trips: a claimed row is answered with a payload; a provider throw becomes
      `error`
- [ ] An expired lease is reclaimed; a landed answer survives a second write attempt
- [ ] A pattern-violating symbol never reaches the provider
- [ ] Note the test shape: `withDatabase` (`tests/support/database.ts:92`) gives one rolled-back
      transaction and therefore no second session, so these tests interleave a fake worker's `UPDATE`
      inside the same transaction rather than spawning a process. Workable, and worth saying so
      before someone tries.
- [ ] A provider deadline expiry writes `error` and does not leave the loop wedged
- [ ] `versionCheck: false` is pinned

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build`, **`scripts/smoke-test.sh`** green — this
      ticket changes what the runtime image contains, so smoke is a gate here even though it is not
      for a pure `app/lib` change
