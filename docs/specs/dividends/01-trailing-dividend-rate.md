# 01 — The annual dividend comes from the distributions actually paid

**Status:** ready-for-agent
**Blocked by:** Nothing.
**Base:** `origin/main` @ dff847b, branch `claude/ttm-dividend-rate`.
**Migration number:** `0019`. PR #359 merged as `0018_account_number_line_breaks.sql`, so 0018 is taken.

## The defect

`app/routes/holdings.tsx` prints a per-holding yield under the annual dividend. For ITOT it prints
`0.7%`; Yahoo's own page prints `0.98%`.

The chain, on `origin/main`:

1. `app/lib/price-provider.server.ts:166` — `const perShare = quote.dividendRate ?? quote.trailingAnnualDividendRate`
2. `migrations/0006_annual_dividend.sql:54` — `annual_dividend = quantity * coalesce(q.annual_dividend_per_share, 0)`
3. `app/lib/holdings-view.ts:600` — `holdingYield = annualDividend / value`, which reduces to `rate / price`

Live Yahoo quote for ITOT, 2026-09-25: `regularMarketPrice 167.73`, `dividendRate` absent (ETFs do
not carry it), `trailingAnnualDividendRate 1.246`, `dividendYield 0.98`. `1.246 / 167.73 = 0.743%`,
which renders `0.7%`. Reproduced exactly.

`trailingAnnualDividendRate` is wrong on its own terms. ITOT's actual trailing-year distributions,
from Yahoo's own `events.dividends`: `0.487 + 0.327 + 0.419 + 0.453 = 1.686`, i.e. `1.01%` of
167.73. The field is ~26% low. Worse cases in the same family:

- **SGOV** (ETF, 3.74% yield) carries *neither* field, so we book **$0** for a fund paying monthly.
- **VTSAX** (mutual fund) reports `dividendRate 0.9845` against `trailingAnnualDividendRate 2.802` —
  the two fields do not mean the same thing across quote types.

The figure feeds Income's totals, `weightedYield` (`app/lib/allocation.ts:134`) and the dividend
breakdowns, so the dollar error propagates well past one cell.

## The fix

Sum the distributions Yahoo reports as having gone ex over the trailing twelve months, and use that
as the per-share rate.

### The glossary

`CONTEXT.md:14-18` defines **Annual dividend** as forward-looking, "from the quantity held and the
instrument's current per-share rate". The figure stays forward-looking and stays `quantity × rate`;
what changes is where the rate comes from. The sentence `CONTEXT.md` gains must say so plainly —
that the rate is **the trailing year's distributions summed, used as the projection for the coming
year** — rather than implying the sum is itself the forward figure. No new term; the avoided words
(`distribution`, `payout`, `projected income`, `dividend income`) stay avoided in identifiers and prose.

### Yahoo behaviour this rests on (verified against the installed v4 library, not recalled)

- `chart()` returns `events.dividends` as an **array**: `node_modules/yahoo-finance2/esm/src/modules/chart.js:277-284`
  runs `Object.values(result.events[event])` on the `return: "array"` default, *outside* validation.
  `validateResult: false` (`server/yahoo-client.ts:59`) does not change it — it only swallows
  validator errors (`esm/src/lib/moduleExec.js:114-130`).
- Each element's `date` is coerced to a `Date`, then **JSON-serialised to an ISO string across the
  worker socket**. Parse it with the existing `parseInstant` (`price-provider.server.ts:127`), which
  handles all three forms. Do not assume a `Date`.
- **Yahoo back-adjusts dividend amounts through later splits.** NVDA's dividends before the 10:1 of
  2024-06-10 come back as `0.004`, not the `0.04` paid. Amounts are already in today's share terms,
  which is the basis `quantity × rate` needs. **Do not apply the `unadjusted()` split arithmetic to
  dividends** — that would be a second, wrong adjustment. A test must pin this.
- **`interval: "3mo"` looks safe and is a trap: Yahoo keys `events.dividends` by bar bucket, not by
  ex-date, so a coarser interval collapses every payment sharing a bucket into one.** A monthly
  payer loses distributions: SGOV, paying monthly, returns 6 events at `3mo` against 12 at `1d`.
  A quarterly payer has one payment per bucket and loses nothing — ITOT returns 4 events either
  way — which is exactly what made `3mo` look correct during design. Use `interval: "1d"`; thirteen
  months of daily bars is well inside the body cap, so the fine grain costs nothing worth trading
  away for a saving that was illusory anyway.
- `events` is a passthrough string option (`chart.schema.js:547-549`).
- `chart()` **throws** before fetching on an unparseable `period1` or `period1 === period2`
  (`chart.js:183-196`). Our `from` is always `YYYY-MM-DD`, so this cannot fire; noted so nobody
  "fixes" it later.
- A genuine non-payer and one nobody has attached dividend history to look identical: BRK-B (pays
  nothing) and VMFXX/SWVXX/VMRXX (money-market funds paying 4-5%, verified live 2026-09-25) all omit
  `events` entirely from a chart that still carries bars. Absence therefore cannot be read as a
  measured zero — only a *present*, readable block, even one listing no dividends, earns one.

### The trailing window, and the drift extension

Two constants, **exported from `app/lib/price-provider.server.ts`**, because that is the module that
applies the bound — `toProviderDividends` derives the core bound itself. Not because of an import
cycle: `price-provider.server.ts` already value-imports `matchKey` from `prices.server.ts`, and
`prices.server.ts` value-imports back from it (`DRIFT_EXTENSION_DAYS`, `ProviderUnreachable`,
`TRAILING_WINDOW_DAYS`) — a cycle both modules already tolerate. Neither imports
`provider-socket.server.ts` at all:

```ts
export const TRAILING_WINDOW_DAYS = 365;
export const DRIFT_EXTENSION_DAYS = 21;
```

A third, `DIVIDEND_FETCH_LEAD_DAYS = 7`, lives in `provider-socket.server.ts` — only
`getTrailingDividend` uses it, to widen `period1`. It is not part of the arithmetic and the sweep
never sees it, so it must NOT be declared a second time in `prices.server.ts`.

**Where each date is computed.** `refreshTrailingDividends` forms the **wider** bound
`since = addDays(marketDateOf(now, tz), -(TRAILING_WINDOW_DAYS + DRIFT_EXTENSION_DAYS))` using the
existing `addDays` (`app/lib/chart-range.ts:94`) — do not hand-roll day arithmetic. It passes `since`
to `getTrailingDividend`, which subtracts `DIVIDEND_FETCH_LEAD_DAYS` to form `period1` before calling
the socket. The wider bound is what crosses the socket deliberately: the parser cannot fall back to
events it never received. `toProviderDividends` then derives the **core** bound from it,
`addDays(since, DRIFT_EXTENSION_DAYS)`, which is `now - 365`. Both bounds are exclusive, and both
compare **market dates** (`marketDateOf`, as `toProviderHistory` dates its bars) rather than raw
instants, so the edge is deterministic rather than a function of time-of-day.

**The rule.**

1. `core` = events dated after `now - TRAILING_WINDOW_DAYS`.
2. `core` non-empty → that is the answer. Sum it. **No further cutoff of any kind.**
3. `core` empty → sum the events dated after `now - (TRAILING_WINDOW_DAYS + DRIFT_EXTENSION_DAYS)`.

So the extension exists to rescue an empty year and for nothing else. An annual payer whose ex-date
has drifted up to 20 days later — Dec 19 one year, Jan 5 the next — reports last year's payment
rather than `$0`; a payer that genuinely stopped still reads `$0`, 386 days after its last payment
instead of 365.

**Why not an anniversary rule.** The rule this replaced kept `date > now - 386`, then dropped every
event dated `<= newest - (365 - 21)` — the newest payment's own year-ago slot, and everything older.
It assumed payments are at least ~28 days apart. Weekly and biweekly distribution funds exist, and
for them the cutoff lands inside the trailing year and deletes real payments:

| frequency | anniversary rule kept | true 365-day count | error |
| --- | --- | --- | --- |
| weekly | 50 | 53 | −5.7% |
| biweekly | 25 | 27 | −7.4% |
| monthly | 12 | 12 | — |
| quarterly | 4 | 4 | — |
| semi-annual | 2 | 2 | — |
| annual | 1 | 1 | — |

That understatement was **permanent** for those funds — every sweep, forever, with nothing to
self-correct. Do not reintroduce the rule, in any form that measures a cutoff from the newest
payment: the cost falls on exactly the payers whose spacing is shorter than the tolerance, and it is
invisible in the output. Simulated across all six frequencies, the replacement returns the true
365-day count for each.

**Residual, for §14** (the accepted artifact, stated this way and not as "irregular payments"):
counting the plain year counts whatever is in it, so a payer whose ex-dates put **five** quarterly
payments inside 365 days reads +25% for those few days, monthly +8%, semi-annual +50%, and an annual
payer whose ex-date drifts *earlier* reads +100% until the older payment ages out. This is the
standard trailing-twelve-month definition every data provider publishes, it is **transient** — a
few days a year, self-correcting with no intervention — and the alternative is the permanent
understatement above. The frequency-change residual the anniversary rule carried is gone: a fund
that switched from annual to quarterly now keeps every payment inside its trailing year.

**Which stopped payers read $0.** A still-trading instrument that stopped paying empties the core
year, falls out of the extension too, and reads `$0` 386 days after its last payment — about three
weeks later than a plain window would. A *delisted* one returns no bars or "No data found", which is
`no-data` — a refusal, so the last measured rate is kept, not zeroed. Those are different outcomes
on purpose.

### Shape

`quote` gains three columns; `holding_valued` reads the new rate only. No new table, no ledger.

**Migration `migrations/0019_trailing_dividend.sql`** — one file, one transaction:

```sql
alter table quote
  add column trailing_dividend_per_share numeric(20, 4),
  add column trailing_dividend_as_of     timestamptz,
  -- Kept in step by hand with DIVIDEND_OUTCOMES (app/lib/prices.server.ts), as 0010 does.
  add column trailing_dividend_outcome   text
    constraint quote_trailing_dividend_outcome_valid
    check (trailing_dividend_outcome in
           ('ok', 'no_data', 'non_usd', 'unreadable', 'provider_failed'));

-- One-time carry-over: the old figure keeps showing until the sweep replaces it, so deploying
-- does not blank every dividend. The stamp is backdated to exactly the staleness bound rather
-- than left null, so every carried row is due immediately BUT still sorts behind a genuinely
-- new instrument, whose stamp is null. A null stamp therefore means "never measured by us",
-- and a null outcome beside a non-null rate means "carried from the provider, not yet measured".
update quote
   set trailing_dividend_per_share = annual_dividend_per_share,
       trailing_dividend_as_of     = now() - interval '7 days'
 where annual_dividend_per_share is not null;

create or replace view holding_valued as
  -- IDENTICAL to migrations/0006_annual_dividend.sql:7-57 except the one expression below.
  -- Column list, order and types unchanged, so holding_valued_at's row-type contract
  -- (docs/adr/0001) is not engaged and the function is deliberately left alone.
  ...
      cast(h.quantity * coalesce(q.trailing_dividend_per_share, 0)
                                               as numeric(20, 4)) as annual_dividend
  ...
```

Then re-issue `comment on view holding_valued` naming the new source.

A single operand: the view never mixes two provenances in one cell. `trailing_dividend_outcome` is
what tells a measured rate from a carried one — a rate refused at every sweep keeps its carried
value indefinitely under a `no_data` or `unreadable` outcome, so the column, not the value, is the
thing to read.

The cost: an instrument first priced *after* the migration reads `$0` until its first sweep. Because
its stamp is null and carried rows are backdated, it sorts ahead of every carried row — though
behind any pre-existing row whose provider rate was null (SGOV and its kind), which the copy leaves
unstamped and which therefore drain first. That is one tick once the initial drain is done. **The initial drain itself is `ceil(candidates / 5)` ticks** —
about 20 hours for 400 instruments at the seeded 15-minute cadence, and far longer at the 1440-minute
maximum. During the drain every holding reads its carried value, which is what it read before the
migration, so nothing regresses; it simply takes that long for every figure to become a measured one.

**`server/yahoo-client.ts`** — `ChartRequest` stays
`{ period1: string; interval: "1d"; events: "split" | "div" }`: both chart routes read at `"1d"`
now, so `interval` gains no second member. Only `events` widens.

**`server/price-worker.ts`** — a fourth route, `POST /dividends`. **Do not copy `handleHistory`.**
It and the new handler differ only by two literals, which is the near-copy `AGENTS.md` names.
Generalise instead:

- one `chartBodySchema` (today's `historyBodySchema`, `:55-58`, unchanged shape)
- a table `const CHART_REQUESTS = { history: { interval: "1d", events: "split" }, dividends: { interval: "1d", events: "div" } } as const`
  — both fine-grained; see the `3mo` trap above
- one `handleChart(req, res, yahoo, admit, endpoint)` replacing `handleHistory`
- `RATE_CAPS.dividends = 20`, a third limiter, threaded through `handle` as the other two are

Update the module header at `server/price-worker.ts:2` and `docs/specs/0018-price-worker.md:263-269,460`,
which both enumerate the routes as a contract.

**`app/lib/price-provider.server.ts`** — `toProviderDividends` must live here: `decimal`, `inRange`
and `RATE_CEILING` (`:81,:90,:99`) are module-private and must stay so.

- `export type ProviderDividends = { status: "ok"; perShare: string } | { status: "no-data" } | { status: "non-usd"; currency: string } | { status: "unreadable" }`
- `PriceProvider` gains `getTrailingDividend(symbol: string, since: IsoDate, marketTimeZone: string): Promise<ProviderDividends>`
- `export function toProviderDividends(raw: unknown, since: IsoDate, marketTimeZone: string): ProviderDividends` — never throws:
  - reuse `yahooChart`; parse failure → `no-data`
  - `meta.currency` present and not USD → `non-usd` (same guard as `toProviderHistory`)
  - `quotes.length === 0` → `no-data`; an empty chart is not evidence of a non-payer
  - `events` absent or null → `no-data`, **not** a measured zero. A money-market fund paying 4-5%
    (VMFXX, SWVXX, VMRXX) omits `events` from its chart exactly as a genuine non-payer (BRK-B) does,
    so absence cannot be read as evidence of zero — it would wipe the yield under an `ok` the outcome
    column then reports as healthy
  - `events` **present but carrying no `dividends` array** — a splits-only block, which is what an
    instrument that split and pays nothing returns → also `{ status: "ok", perShare: "0.0000" }`.
    Deliberate, and not the same as `unreadable`: the block parsed, it simply holds no payments, and
    such an instrument must still be measurable as a real zero rather than keeping a stale rate
  - `events` present but unparseable, or any element with a non-finite `amount` or a `date`
    `parseInstant` refuses → `unreadable`, all-or-nothing, mirroring the split rule: a half-read
    block yields a plausible-looking wrong number
  - each event's `amount` bounded with `inRange(…, RATE_CEILING)` **before** `toUnits` — `toFixed`
    goes exponential past 1e21 and `toUnits` throws a `SyntaxError` on that string, out of a parser
    that never throws; over the ceiling → `unreadable`, same as an unparseable element
  - any event with a **negative** amount → `unreadable`: summed, it would store a negative rate
    against the holding, and refusing only that element would drop the real payments beside it. Zero
    stays — a payment of nothing is data
  - date each event with `marketDateOf`, keep `date > addDays(since, DRIFT_EXTENSION_DAYS)` — the
    core year — and fall back to `date > since` only when that keeps nothing
  - **sum in `money.ts` units first, round once** — `toUnits` each amount at `EVENT_SCALE` (8), accumulate, then one `divide` down to `MONEY_SCALE`,
    accumulate as `bigint`, one `render` at the end. Per-event rounding would round twelve times
    for a monthly payer. `unadjusted()` (`:213-229`) is the precedent.
  - bound the **summed** rate with `inRange(…, RATE_CEILING)` too, separately from the per-event bound
    above; over it → `unreadable`
  - carry a comment on why no split arithmetic is applied, citing the NVDA observation

**`app/lib/provider-socket.server.ts`** — `AskKind` gains `"dividends"` (both `BUDGET_MS` `:31` and
`BODY_CAP_BYTES` `:40` are `Record<AskKind, number>`, so the type must widen first),
`BUDGET_MS.dividends = 35_000`, `BODY_CAP_BYTES.dividends = 512 * 1024`. `getDailyCloses` (`:194-206`) and `getTrailingDividend`
share the `ask` call and the `isMissingHistory` discrimination, so factor a private
`askChart(kind, symbol, from)` rather than writing it twice. `askChart` returns the raw payload or
throws — it must **not** return a status literal, because the two callers map the missing-history
case to different literals (`no-history` and `no-data`). Each `get*` parses and maps its own catch.

**`app/lib/prices.server.ts`**

- `DIVIDEND_BATCH_SIZE = 5`, `DIVIDEND_STALE_DAYS = 7`, `DIVIDEND_RETRY_DAYS = 1`. All numbers of
  days, not interval strings — the bounds are computed in JS and bound as `Date`s.
  `DIVIDEND_FETCH_LEAD_DAYS = 7` (`period1` = `since` less the lead) lives in
  `provider-socket.server.ts`, not here — see above; it is a socket-side widening, not a bound this
  module computes. The migration's `interval '7 days'` is the same 7 and is kept in step by hand.
- `DIVIDEND_OUTCOMES` as a `const` object mirroring `BACKFILL_OUTCOMES` (`:91-98`), kept in step by
  hand with the migration's check constraint
- `selectDividendCandidates(db, now)` — **currently held** feed instruments with a symbol, at a
  nonzero quantity, inner joined to `quote` so the write always lands on a row. The quantity
  predicate is load-bearing: a turnaround is recorded at zero first (`positions.server.ts`) and the
  view keeps that row, so "currently held" alone would spend a request a week forever on a position
  that is gone. Drive it from `holding_valued`: it already
  owns the latest-position-set rule and excludes closed accounts (`0006:56`), so "no longer held"
  and "closed" both fall out for free. Do **not** copy `selectBackfillCandidates`'s joins
  (`prices.server.ts:122-158`) — it joins `holding`/`position_set` with no `account` join at all,
  which is "ever held". A gap-driven backfill drops a filled instrument out of its own candidate
  set; this sweep never does, so "ever held" would cost a request a week forever for a position
  sold in 2019.

  **This is not a layering violation, and there is a model to copy.** `CLAUDE.md` names
  `app/lib/valuation.server.ts` the only *valuation* reader of `holding_valued`; `priceFreshness`
  (`app/lib/prices.server.ts:769-778`) already reads it from this very module, with an `innerJoin`
  on `quote` and `price_source = 'feed'` — the same shape. Follow it.

  **`holding_valued` is one row per account x instrument.** Without a `groupBy`, `limit 5` bounds
  rows rather than instruments, and an ETF held in three accounts takes three slots and is fetched
  three times in one tick. `priceFreshness` meets the same fan-out and answers it with
  `count(distinct holding_valued.instrument_id)` (`:775-778`); the backfill query groups for the
  same reason (`:145`). Group by instrument:

  ```ts
  const staleBefore  = new Date(now.getTime() - DIVIDEND_STALE_DAYS * 86_400_000);
  const failedBefore = new Date(now.getTime() - DIVIDEND_RETRY_DAYS * 86_400_000);

  db.selectFrom("holding_valued")
    .innerJoin("quote", "quote.instrument_id", "holding_valued.instrument_id")
    .where("holding_valued.price_source", "=", "feed")
    .where("holding_valued.symbol", "is not", null)
    // A turnaround is recorded at zero first (positions.server.ts); without this the view keeps
    // spending a request a week forever on a position that is gone.
    .where("holding_valued.quantity", "!=", "0")
    .where((eb) => eb.or([
      eb("quote.trailing_dividend_as_of", "is", null),
      eb.and([
        eb("quote.trailing_dividend_outcome", "=", DIVIDEND_OUTCOMES.providerFailed),
        eb("quote.trailing_dividend_as_of", "<=", failedBefore),
      ]),
      eb.and([
        eb("quote.trailing_dividend_outcome", "is distinct from", DIVIDEND_OUTCOMES.providerFailed),
        eb("quote.trailing_dividend_as_of", "<=", staleBefore),
      ]),
    ]))
    .groupBy(["holding_valued.instrument_id", "holding_valued.symbol", "quote.trailing_dividend_as_of"])
    .select(["holding_valued.instrument_id", "holding_valued.symbol"])
    .orderBy("quote.trailing_dividend_as_of", (ob) => ob.asc().nullsFirst())
    .orderBy("holding_valued.instrument_id")
    .limit(DIVIDEND_BATCH_SIZE)
  ```

  The `select` yields `symbol: string | null`; narrow it with the `as string` idiom and its
  comment at `prices.server.ts:161-163` — the `where` refuses nulls, which TS cannot see through.

  **Bind the bounds as JS `Date`s, computed from the injected `now`.** Do not write
  `${now} - interval '7 days'`: an untyped parameter minus an interval is ambiguous across two
  Postgres type categories and fails with "operator is not unique". Kysely 0.29 spells nulls-first
  through the modifier callback (`dist/parser/order-by-parser.d.ts:8-11`).

  **Order `trailing_dividend_as_of asc nulls first, instrument_id`** — round-robin by oldest stamp.
  `(as_of is null) desc, id` does not converge: at 100 instruments, batch 5 and a 1440-minute
  cadence weekly capacity is 35, so low ids re-stale and are re-picked while high ids never run.

  **Two retry tiers.** `DIVIDEND_STALE_DAYS = 7` is the ordinary re-measure interval;
  `DIVIDEND_RETRY_DAYS = 1` applies to `provider_failed`, matching the backfill's own retry interval
  (`prices.server.ts:31`). Without the second tier one transient failure — a Yahoo 429, the worker's
  30s watchdog, or the 35s budget on a cold crumb handshake — parks an instrument for a week, and a
  newly priced one would read `$0` for that week.

- `refreshTrailingDividends(provider, marketTimeZone, now, db = getDb()): Promise<DividendReport>` —
  per candidate, sequentially. `ProviderUnreachable` rethrows before any write, as `backfillCloses`
  does (`:312-314`). **Every other outcome, including a throw, writes the stamp** — a symbol that
  throws every tick would otherwise sit at the head of a nulls-first queue forever and starve the
  sweep. A throw records `provider_failed`.
- `writeTrailingDividend(db, instrumentId, result, now)` — on `ok` set all three columns; on any
  refusal set the stamp and the outcome only, leaving the last good rate. One `update` per
  instrument: a statement is atomic on its own, and a batch transaction would let one bad row roll
  back four good ones.
- `DividendReport = { attempted, written, refused, failed, batchFailed: boolean }`.
  `RefreshPricesReport` gains `dividends: DividendReport | null` — **`null` when the sweep did not
  run**, mirroring how `quotes` is null when quotes are skipped. `batchFailed` exists because a
  throw mid-batch must still report the counts from the instruments already swept; the backfill
  solves the same problem with `BackfillBatchFailed` carrying a partial report (`:263-271`), so add
  the matching `DividendBatchFailed` carrier rather than losing the counts.
- **The poller log.** `logBackfill` (`price-poller.server.ts:174`) reads `outcomes.provider_failed`;
  `DividendReport` has a different shape, so it needs its own sibling. Stem `Price dividends`,
  registered in `docs/operating.md`'s stem list. Silence rule: log only when
  `attempted > 0 || batchFailed`, so an all-fresh tick says nothing.
- `refreshPrices` gains `dividends: boolean` beside `quotes` in its options — **required, never
  defaulted**, so typecheck names every caller. The poller passes `true`; the manual `/refresh`
  route (`app/routes/refresh.ts:17`) passes `false`. The flag decides who *waits*, not who triggers:
  `requestRefresh()` from an upload commit (`app/routes/upload/review.tsx:142`) goes through the
  poller and does sweep. Two booleans, not an enum — the poller derives `quotes` from the calendar
  and always sends `dividends: true`, so an enum would need three values to encode the same thing. `/refresh` awaits the whole run
  (`app/routes/refresh.ts:17`) and already costs quotes plus up to 5×35s of backfill; adding another
  5×35s would make a person's button press a six-minute POST. A scheduled tick is 15 minutes away.
- the backfill's catch (`:406-423`) would be copied a third time — factor one `settle(step, label)`
  helper, per step. Not one try around both: that would make a backfill failure skip the sweep
  entirely and lose which step failed, discarding `BackfillBatchFailed.report` (`:263-271`).

**The `writeQuote` invariant.** `writeQuote`'s `doUpdateSet` (`:556-563`) names five columns
explicitly, so a quote refresh leaves the trailing columns untouched. The stamp being a reliable
retry clock depends entirely on that. It is currently an accident — the fixture's own
`doUpdateSet(values)` idiom (`tests/support/fixtures.ts:437-440`) is exactly the refactor that would
break it. Put a comment on `writeQuote` saying so, and pin it with a test.

**The overflow guard.** `fitsTheMoneyColumn` guards the product the view computes at every quantity
write. The view's operand is now `trailing_dividend_per_share`, so that is the **one** operand to
check — not both, or a quantity would be refused against a rate the view no longer multiplies by.
Sites: `app/lib/positions.server.ts:43,77,86,108,221` (`CurrentPosition` carries it) and
`app/lib/uploads.server.ts:995,1131,1203,1224,2056` (`FileRow`, the `Omit<FileRow, …>` at `:1131`
that breaks on rename, and the `quote` select). The doc's earlier
citations of `:208`/`:721` were wrong.

**`app/lib/database.generated.ts`** — regenerated by `npm run db:types`, never hand-edited.

**`scripts/seed-demo.ts`** — `WIPE` deletes every non-USD quote (`:678`) and the insert names six
columns (`:893`). Unchanged, the demo and `scripts/capture-screenshots.ts` would show `$0` for every
holding once the view reads only the new column. Seed all three new columns.

**`tests/support/fixtures.ts`** — `seedQuote` (`:99-106`) gains the three options.

### Masking

No new exposure. `annual_dividend` reaches the browser masked — `privateValue` on the row
(`app/lib/holdings-view.ts:550`) and an availability ternary on the total (`:563`); the ratio is
unmasked by rule (`CONTEXT.md`).
`CurrentPosition.trailingDividendPerShare` is server-only, and `FileRow`'s copy never reaches an
upload route.

## Documentation that becomes false

Verified line by line; entries that merely *gain* a row rather than becoming false are marked.

- `DESIGN.md:143` — the `quote` DDL listing gains three columns (*addition*)
- `DESIGN.md:455` — the `PriceProvider` interface gains a method
- `DESIGN.md:507` — the `quote` tuple
- `DESIGN.md:1556-1557` — limitation 9: a swept non-payer is now a real zero; only the unswept and
  refused cases remain. Add the trailing-twelve-month artifact (five quarterly payments in one year)
  here too.
- `docs/data-model.md:121-128` — the ER `quote` block (*addition*)
- `docs/data-model.md:361` — "the forward per-share rate behind the projected annual dividend"
- `docs/data-model.md:647,649` — the `coalesce(annual_dividend_per_share, 0)` sentence and its
  limitation-9 pointer
- `ARCHITECTURE.md:104` — "over two endpoints"; now four ways over three worker routes against
  two Yahoo endpoints, since both chart fetches reach the same Yahoo endpoint
- `ARCHITECTURE.md:700-707` — the ER `QUOTE` entity at `:704` (*addition*)
- `ARCHITECTURE.md:569-570` — the writers table; the sweep is a new `quote` writer beside
  "Refresh quotes"
- `ARCHITECTURE.md:2537` — the migrations table gains an `0019_trailing_dividend.sql` row, as
  dff847b added one for `0018` (*addition*). Every migration here gets a row; do not skip it.
- `ARCHITECTURE.md:1408-1414` — a new paragraph after the §6 backfill sequence diagram, covering the
  dividend sweep; the diagram itself needs no new arrow, since the sweep runs after it under the same
  tick and lock rather than inside it. `:1888-1900` the `PriceProvider` box gains a method (*addition*)
- `docs/operating.md:1192-1195,1200-1203` — the outside-window tick and "Refresh now" paragraphs,
  which enumerate what does and does not run
- `docs/operating.md:1115-1130` — the log-stem list; the sweep needs a stem beside
  `price-poller.server.ts:174`'s `logBackfill`
- `app/routes/holdings.tsx:909` — "`quote` can't tell 'pays nothing' from 'nobody asked'", which the
  outcome column makes false
- `app/lib/allocation.ts:33` and `app/lib/price-provider.server.ts:169` — comments calling a null
  rate the §14 lower bound; the latter now describes a column the view no longer reads
- `server/price-worker.ts:2` and `docs/specs/0018-price-worker.md:263-269,460` — "three endpoints"
- `app/lib/price-poller.server.ts:56-60` — the `refresh` dependency type `{ quotes: boolean }`
- `tests/price-poller.test.ts:124,134,404-413` — `RefreshPricesReport` literals, `refreshCalls`
  typed `{ quotes: boolean }[]`, and a `toEqual([{ quotes: true }])` that is strict on extra keys
- `tests/price-worker.test.ts:192` — `describe("the three endpoints")`
- `docs/specs/0006-dividends.md:20-21` — "taken from the provider's `dividendRate` or its ETF
  spelling `trailingAnnualDividendRate`", corrected in place by banner rather than rewrite
  (`docs/specs/README.md`)
- `docs/specs/0025-the-poller-as-a-built-instance.md` — the log-stem table gains a `Price dividends`
  row beside `Price backfill` (*addition*)

Checked and **not** affected, so leave them alone: `DESIGN.md:795` (§8.4 Prices row) and
`app/routes/settings/prices.tsx:52` — this change adds no Settings UI; `ARCHITECTURE.md:1352` — the
quote refresh still upserts exactly those columns; `docs/data-model.md:360` (`yield_pct` row) and
`:769` ("the price refresh overwrites `quote`", still true); `app/routes/income.tsx:154` — "no
dividend rate on file counts as paying nothing" stays literally true for unswept rows. ADR-0011 is
historical and is not edited.

## Rejected

- **A `dividend_event` table plus a `dividend_sync` ledger.** Nothing reads payment history; a stamp
  plus an outcome on `quote` is a sufficient retry clock. Revisit if Income ever shows payments received.
- **Display `quote.yield_pct` instead.** One line, matches Yahoo's page — but fixes only the
  percentage. The dollar figure Income and `weightedYield` are built from stays wrong, and the two
  cells in one column would disagree.
- **`dividendYield × price / 100` as the rate.** Inherits whatever Yahoo means by `dividendYield` per
  quote type, which VTSAX shows is not one thing.
- **Piggybacking the backfill's chart call.** Gap-driven and one-shot; an instrument is fetched once
  and never again.
- **Fetching every instrument every refresh.** ~100 instruments against a 20/60s cap is minutes per
  tick for a number that changes quarterly.
- **Keeping the three-way `coalesce(trailing, annual, 0)`** (one reviewer argued for it as
  rolling-deploy cover). The one-time migration copy gives the same cover without a permanently
  ambiguous cell, and keeps the overflow guard to a single operand.
- **Collapsing `ProviderDividends` to `ok | refused`** (the other reviewer's simplification). The
  `trailing_dividend_outcome` column reads the distinction, so it buys a diagnosable state rather
  than a log line — the argument ADR-0011 already accepted when Settings → Prices was built.

## Acceptance checklist

**The rate**
- [ ] ITOT's four trailing distributions (0.487, 0.327, 0.419, 0.453) sum to `1.6860`, and one
      share at 167.73 gives `holdingYield` `"0.010052"` — the reproducing test for this bug.
      `holdingYield` returns a `SHARE_SCALE` ratio string; `1.0%` is the route's rendering, so
      assert the ratio here and leave the percent to a route test.
- [ ] An instrument with no `events` key at all refuses as `no-data`, even with bars — a
      money-market fund's chart looks exactly like a non-payer's (VMFXX, SWVXX, VMRXX vs BRK-B)
- [ ] A present but dividend-free block — splits-only, or an empty array — stores `0.0000`
- [ ] An empty chart stores no rate and advances the stamp
- [ ] An event dated exactly `since` is excluded; one a day later is included
- [ ] Five quarterly payments inside 365 days sum to five — the accepted artifact, not four
- [ ] A quarterly payment older than the year is excluded while the four inside it sum
- [ ] Two payments 365 days apart (an annual payer) sum to one
- [ ] An annual payer whose ex-date drifted 14 days **earlier** sums to two, both being inside the
      year — transient, and the artifact above
- [ ] An annual payer that has not yet paid this year, its last payment inside the extension and not
      the year, still reports last year's payment, not $0
- [ ] 53 weekly payments inside the year sum to 53, and 27 biweekly to 27 — the anniversary rule's
      permanent understatement, the regression that must not come back
- [ ] Twelve monthly payments all sum
- [ ] A thirteenth monthly payment, in the extension rather than the year, is ignored
- [ ] A payer whose last distribution was 400 days ago reads `0.0000`
- [ ] A split inside the window changes nothing — no ratio is applied
- [ ] `date` arriving as an ISO string parses (the socket JSON case), not only as a `Date`
- [ ] One unparseable event refuses the whole response rather than summing what parsed
- [ ] A sum over `RATE_CEILING` refuses

**The sweep**
- [ ] A null stamp is picked before any non-null stamp
- [ ] Among non-null stamps the oldest is picked first
- [ ] A stamp inside 7 days is not re-fetched
- [ ] A refusal advances the stamp and outcome, leaving the stored rate
- [ ] **A throw advances the stamp** and records `provider_failed`
- [ ] `ProviderUnreachable` writes nothing and propagates
- [ ] An instrument no longer held is not a candidate
- [ ] An instrument in a closed account is not a candidate
- [ ] **An instrument held in three accounts takes one slot, not three**
- [ ] An instrument with no `quote` row is not a candidate
- [ ] A `provider_failed` stamp is retried after 1 day, not 7
- [ ] A dividend failure never rolls back or fails the quote refresh
- [ ] The manual `/refresh` route runs no sweep; a scheduled tick does

**The worker and the socket**
- [ ] `/dividends` calls `chart` with `interval "1d"` and `events "div"`, and `/history` still calls it with `"1d"`/`"split"`
- [ ] The 21st `/dividends` call inside 60 seconds is refused `429`, and its budget is independent of `/history`'s
- [ ] A "No data found" throw from the provider becomes `no-data`, not a thrown refresh
- [ ] A non-USD chart becomes the `non_usd` outcome

**The view and the columns**
- [ ] `annual_dividend` is `quantity × trailing_dividend_per_share`
- [ ] A swept non-payer reads `$0`
- [ ] The migration's one-time copy leaves every existing holding reading what it read before.
      The suite migrates fully before any row exists, and the tmpdir approach does NOT work: with
      0001-0018 already in the ledger, `applyPendingMigrations` applies nothing. Copy the
      `upgradingOver` pattern instead (`tests/migrations.test.ts:443-465`, and `foldingOver`
      `:525-548`): on the already-migrated pool, `begin`; rewind by running
      `migrations/0006_annual_dividend.sql` wholesale (all `create or replace` + `comment on`, and
      the column list matches, so the view swap is legal) then
      `alter table quote drop column trailing_dividend_per_share, drop column
      trailing_dividend_as_of, drop column trailing_dividend_outcome`; seed a holding and a `quote`
      carrying `annual_dividend_per_share`; run `readFile(migrations/0019_trailing_dividend.sql)`;
      read `holding_valued`; `rollback`
- [ ] **A quote refresh leaves `trailing_dividend_*` untouched**
- [ ] The migration's backdated stamp leaves a newly priced instrument ahead of every carried row —
      test this through `selectDividendCandidates` with a seeded row at
      `as_of = now - 7 days, outcome null`, not by re-running migrations
- [ ] `DIVIDEND_OUTCOMES` and the check constraint agree — every declared outcome is accepted and an
      undeclared one is refused with `/quote_trailing_dividend_outcome_valid/`, mirroring
      `tests/price-backfill.test.ts:366-410`
- [ ] `holding_valued_at(current_date)` still executes after the migration (the ADR-0001 trap)
- [ ] `fitsTheMoneyColumn` refuses a quantity that would overflow against the trailing rate

**Gates**
- [ ] `npm run typecheck`, `npm test`, `npm run build` green
- [ ] `npm run db:types -- --verify` clean

## Verification commands

No `node`/`npm` on the host; everything runs in a throwaway container. The shared
`portfolio-test-db-1` carries migrations from another checkout, so use the dedicated database
already created for this work:

```sh
cd /home/ubuntu/wspace/cld/portfolio-ttm
docker run --rm -v "$(pwd)":/repo -w /repo --network host \
  -e TEST_DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_ttm \
  node:24-slim npm test
```

Baseline measured at 6830d64: 118 files, 2385 tests, all passing. dff847b added test blocks, so
the regression comparison must be made against a baseline re-measured at dff847b, not this number.
