# 01 — One refresh, and the batch abort

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.1, §3.4)._

**What to build:** `runRefresh({ quotes }, provider)` in a new `app/lib/refresh.server.ts` that owns
the lock, runs `refreshPrices` with the provider it was handed and maps the result to the outcome
the control renders, so the route, the poller's tick and `requestRefresh` become thin callers (issue
#159); and a named `ProviderUnreachable` beside `PriceProvider` that `backfillCloses` treats as a
batch abort with nothing ledgered. Both against the existing Yahoo adapter, which never throws it.

Its own ticket because three callers hold the lock and build the provider today, and the cutover
([06](06-the-app-cutover.md)) has to change one default in one place; the batch abort is the ledger
rule that cutover relies on, and a fake provider tests it now. The prefactor was cut into three
([02](02-the-batched-probe.md), [03](03-the-three-hardening-rules.md)) because the pieces share no
line and each is reviewed alone.

**Blocked by:** Nothing. Parallel with [02](02-the-batched-probe.md),
[03](03-the-three-hardening-rules.md) and [04](04-the-price-worker-process.md).

**Status:** ready-for-agent

**`runRefresh`** (`app/lib/refresh.server.ts`, new)

- [ ] `runRefresh({ quotes }, provider = yahooPriceProvider()): Promise<RefreshRun>` wraps
      `withRefreshLock(() => refreshPrices(provider, getConfig().MARKET_TIMEZONE, { quotes },
      getDb()))`: `null` is `{ status: "busy" }`, a throw is logged as `Price refresh failed; last known
      prices are kept:`, the poller's stem (`price-poller.server.ts:149`, `docs/operating.md:740`), and becomes `{ status: "error" }`, a report is `{ status:
      "done", report }` with `report: RefreshPricesReport` (`prices.server.ts:640`).
      The route's `Manual …` line (`refresh.ts:83`) retires with the route's catch;
      `operating.md:741`'s sentence about it goes with [09](09-documents-and-runbooks.md).
      `outcomeOf(run): RefreshOutcome` projects `report.quotes` as the route does now (`:74-81`).
      The default provider is `yahooPriceProvider()`, in this one place; [06](06-the-app-cutover.md)
      changes it. An instance, not a factory: with no per-operation state to reset there is nothing
      a factory would buy, and the batch abort below is what keeps a dead worker's cost bounded
- [ ] The route (`refresh.ts:58-86`) becomes `outcomeOf(await runRefresh({ quotes: true }))`; the
      redirect rule at `:45-47` is untouched. `RefreshOutcome` (`:21-33`) moves to the new module
      and `app/components/price-freshness.tsx:16` imports the type from there, as `import type` —
      the one `lib → routes` import in the tree, gone, and the `.server.ts` boundary kept
- [ ] The poller's tick (`app/lib/price-poller.server.ts:127-147`) and `requestRefresh` (`:245-259`)
      call `runRefresh(…, state.provider)`; `PollerState.provider` (`:59-72`) and the
      `startPricePoller(provider = …)` default (`:193`) stay exactly as they are; the market-hours
      decision (`:114`) and the cadence read (`:119-123`) stay the poller's — #159's constraint —
      and its two log lines (`:139-146`) are written from the run's report exactly as today. Neither
      caller constructs a provider afterwards; `tests/price-poller.test.ts` is untouched

**`ProviderUnreachable` and the batch abort**

- [ ] `export class ProviderUnreachable extends Error` beside `PriceProvider`
      (`price-provider.server.ts:155-162`), its message operator-facing; the Yahoo adapter never
      throws it
- [ ] `backfillCloses` (`prices.server.ts:548`): the per-candidate catch (`:568-587`) rethrows a
      `ProviderUnreachable` **unchanged** instead of ledgering it; the existing outer catch
      (`:630-634`) then wraps it once in `BackfillBatchFailed` (`:501-509`) with the partial report,
      exactly as it does for a database error today. Not wrapped inside the loop — that would nest
      two `BackfillBatchFailed`s and the composition would log the inner wrapper, not the cause. The
      attempt in flight and every candidate after it get no ledger row, so the retry clock
      (`:306-316`) is not charged for a dead worker
- [ ] The composition's catch (`:688-702`) branches on `error.cause instanceof ProviderUnreachable`:
      one `console.warn` carrying the cause's text, and *not* "the quotes it ran beside are
      unaffected" — false whenever the quotes call hit the same dead worker: one connect attempt and
      one log line per call site, quotes and the batch abort, at most two of each in one tick for
      the one underlying event, never deduplicated. Every other cause logs as today

**Tests**

- [ ] `tests/refresh.test.ts` (new): `process.env.DATABASE_URL = TEST_DATABASE_URL` **before** any
      import that reaches `getConfig()` (`tests/price-poller.test.ts:37` is the precedent — it
      memoises, and `withRefreshLock` reaches the process-wide pool). `runRefresh` with a fake
      provider answers `done` with the quotes' counts; `busy` while a second `pg` client
      (`createPool(TEST_DATABASE_URL)`, the pattern `tests/price-poller.test.ts:104` builds on)
      holds the advisory lock on its own session — `withDatabase`'s transaction is not one; and
      `error` when the **database or the lock** fails — a closed pool, or `withRefreshLock` stubbed
      to throw — since `runRefresh`'s catch only ever sees what escapes `refreshPrices`
- [ ] A separate case pins what `error` is *not*: a fake whose `getQuotes` throws answers `done`
      with `report.quotes.providerFailed` true, because `refreshQuotes` catches the throw and marks
      every selected instrument stale (`prices.server.ts:795-798`); a backfill throw is ledgered per
      candidate or arrives as `batchFailed`. No provider fault reaches `error`, which is why the
      dead-worker path of [06](06-the-app-cutover.md) reports `providerFailed` and not a failure of
      the run. The route's own test comes with [06](06-the-app-cutover.md)
- [ ] `tests/price-backfill.test.ts`: a fake throwing `ProviderUnreachable` on the second of three
      candidates leaves the first's ledger row, none for the other two, and `refreshPrices`
      reporting `batchFailed: true` with one attempt counted; the log line is the single warning

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build` green
