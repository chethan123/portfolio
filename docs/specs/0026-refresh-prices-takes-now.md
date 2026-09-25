# 0026 — `refreshPrices` drops the mode flag's overloads and takes `now`

_Candidate 2.4 of [the second architecture review](../research/2026-09-24-architecture-review.md)
(card 4 of its [visual companion](../research/2026-09-24-architecture-review/report.html)).
Line numbers below were read at `231a92b`, after 0025 landed._

**What to build:** `refreshPrices(provider, marketTimeZone, { quotes }, db)` in
`app/lib/prices.server.ts` selects between two behaviours with a boolean: quotes then one backfill
batch, or the batch alone. To spare `outcomeOf` a null branch, that one distinction is restated as
two overload signatures on `refreshPrices` (`:394-405`), two on `runRefresh`
(`app/lib/refresh.server.ts:54-61`) and `RunWithQuotes` (`:41-44`), a hand-narrowed copy of
`RefreshRun` whose only difference is a non-null `report.quotes`. Separately, "today" is read off the
wall clock inside the writer four times (§3), so `tests/refresh-quotes.test.ts` wraps twenty cases in
`withClockNear`, `tests/price-backfill.test.ts` fakes `Date` three times plus a `setSystemTime`, and
`tests/routes/refresh.test.ts:86-91` computes its fixtures from the real `now` because "a fixed-past
fixture would age out of range".

Delete the overloads and `RunWithQuotes`; keep one `refreshPrices` whose result already names the
null case (`RefreshPricesReport.quotes: RefreshReport | null`), with `outcomeOf` owning that case
explicitly. Make `now: Date` a parameter of `refreshPrices`, `refreshQuotes`, `backfillCloses`,
`writeDailyClose` and `runRefresh`, never defaulted in the writer, the way `pricingHealth` already
takes it (`app/lib/price-health.ts:82-86`, `now: Date`, no default).

Worth doing on its own because what a refresh writes for a given instant does not change. Four
declarations become one, and the writer's tests state their instant through the interface instead
of faking the global clock. It touches two domain modules, one route line, the poller's refresh seam,
four test files, and three documentation lines (`docs/data-model.md:435`, `ARCHITECTURE.md:416` and
`:716`).

**Blocked by:** Nothing. 0025 (candidate 2.3) landed in #386; the poller's injected clock is threaded
here (§4).

**Status:** ready-for-agent

**Out of scope:** the poller as a built instance (2.3, landed) beyond its refresh seam (§4); the
`matchKey` cycle, the probe and the freshness readers (2.12; `priceFreshness` and `asOfView` stay
where they are); any change to what a refresh writes, when a backfill runs, the seven-day window,
`withRefreshLock`, `runRefresh`'s never-throws contract, a log line, or the **Refresh now** outcome
text; the retry clock's Postgres `now()` (`prices.server.ts:140`), which decides when a backfill runs
and is a database read, not the writer's; `seedQuote`'s `asOf` default and `LONG_AGO` in
`tests/price-backfill.test.ts`, which plant rows outside the writer; the tracked `.orig` files;
historical specs that quote the old signatures (0017, 0018, 0025, `price-backfill/03`,
`price-worker/01`, `/03`, `/06`), which record what was agreed then (`docs/specs/README.md`);
ARCHITECTURE.md references this change does not move; any drive-by.

## 1. The shape: one entry, the null case named

One `refreshPrices`, not two named entries. The poller decides `quotes` per tick at runtime
(`isScheduledQuoteWindow(now, …)`, `price-poller.server.ts:113`) and already handles a null quotes
report (`:131`). Two entries would move that choice into the poller or back into a boolean on
`runRefresh`, and would copy the lock-and-catch composition. The nullable result exists today in
`RefreshPricesReport`; only the overload layer on top of it is deleted.

After the change (`db` keeps its `getDb()` default, a connection, not a clock):

```ts
// app/lib/prices.server.ts
export async function refreshPrices(
  provider: PriceProvider,
  marketTimeZone: string,
  now: Date,
  { quotes }: { quotes: boolean },
  db: Kysely<Database> = getDb(),
): Promise<RefreshPricesReport>;

export async function refreshQuotes(
  provider: PriceProvider,
  marketTimeZone: string,
  now: Date,
  db: Kysely<Database> = getDb(),
): Promise<RefreshReport>;

export async function backfillCloses(
  provider: PriceProvider,
  marketTimeZone: string,
  now: Date,
  db: Kysely<Database> = getDb(),
): Promise<BackfillReport>;

async function writeDailyClose(
  db: Kysely<Database>,
  instrumentId: string,
  quote: ProviderQuote,
  marketTimeZone: string,
  now: Date,
): Promise<boolean>;

// app/lib/refresh.server.ts
export async function runRefresh(
  { quotes }: { quotes: boolean },
  now: Date,
  provider: PriceProvider = socketProvider(),
): Promise<RefreshRun>;

export function outcomeOf(run: RefreshRun): RefreshOutcome;
```

`now` sits after `marketTimeZone` in the writer, as card 4 draws it. On `runRefresh` it sits before
the defaulted `provider`, so the route omits the provider without passing `undefined`.

**Deleted:** the two overload signatures on `refreshPrices`; the two on `runRefresh`;
`RunWithQuotes`, and with it the `type BackfillReport` and `type RefreshReport` imports in
`refresh.server.ts` (`:12`, `:14`), which only it uses. **Kept, unchanged in shape:** `RefreshRun`, which becomes the one result type,
plus `RefreshPricesReport`, `RefreshReport`, `BackfillReport` and `RefreshOutcome`.

## 2. `outcomeOf`'s null case

```ts
export function outcomeOf(run: RefreshRun): RefreshOutcome {
  if (run.status !== "done") return run;

  const { quotes } = run.report;
  if (quotes === null) return { status: "error" };

  return { status: "done", requested: quotes.requested, … };
}
```

A `done` run with no quotes report has no counts to show. `error` is the one variant that invents
none: `busy` would claim a lock that was free, and a `done` with zeros would render "Checked 0
prices". The docstring says so, and `RefreshOutcome`'s `error` comment gains that source.

**Unreachable from the route.** `app/routes/refresh.ts:17` calls `runRefresh({ quotes: true }, …)`.
With `quotes: true`, `refreshPrices` awaits `refreshQuotes` outside its `try` (`prices.server.ts:412`).
`refreshQuotes` either returns a `RefreshReport` or throws. A throw propagates to `runRefresh`'s
`catch` (`refresh.server.ts:73`) and becomes `{ status: "error" }` before `outcomeOf` sees a `done`.
So every `done` the route sees carries a non-null `quotes`, and the control renders nothing new
for any `RefreshOutcome` variant (`app/components/price-freshness.tsx:48-87`, unchanged). One test
pins the null case through a real `runRefresh({ quotes: false }, …)` run (§5.3).

## 3. The four clock reads, and what replaces each

| Line (`prices.server.ts`) | Read | Feeds | Replaced by |
|---|---|---|---|
| `:298` | `marketDateOf(new Date(), marketTimeZone)` | the batch's `until` (exclusive), every `HistoryRange` and `price_backfill.range_until` | `marketDateOf(now, marketTimeZone)` |
| `:309` | `const startedAt = new Date()`, per candidate | `price_backfill.started_at`, via `writeBackfillAttempt` | `now` (the local goes) |
| `:462` | `const startedAt = new Date()` | `price_poll.started_at`, via `writePoll` | `now` (the local goes) |
| `:606` | `marketDateOf(new Date(), marketTimeZone)` | the ±`CLOSE_WINDOW_DAYS` window's "today" | `marketDateOf(now, marketTimeZone)` |

`refresh.server.ts` has no `new Date()` today and gains none: the caller reads the clock.
Afterwards `grep -n 'new Date()' app/lib/prices.server.ts app/lib/refresh.server.ts` is empty.

The provider's own instants are not the clock and stay as they are: `marketDateOf(quote.asOf, …)`
at `:605` (the claimed close date) and `:704` (`price_observation.market_date`), `quote.asOf` into
`quote.as_of` and `price_observation.as_of`, and `quote.fetchedAt` into `fetched_at`.
`writePoll(trx, startedAt, report)` and `BackfillAttempt.startedAt` keep their names and are handed
`now`.

**The seven-day window is unchanged.** The same comparison (`date < addDays(today, -7) || date >
addDays(today, 7)` refuses), on market dates, inclusive at ±7, with `today` now
`marketDateOf(now, marketTimeZone)`. The skip still writes the quote and the observation, still
leaves `closes` uncounted, and still logs `Price close skipped, more than 7 days from today's
market date: …` word for word (spec 0018 §3.1; ARCHITECTURE.md §7.3).

**What `started_at` means afterwards (owner decision, 2026-09-25).** Every `started_at` a refresh
writes is that refresh's `now`. Given the same instant, the rows are identical. With a real clock,
two stamps move earlier:

- `price_poll.started_at`, by milliseconds: the press or tick instant, taken before the lock,
  instead of `refreshQuotes`' start.
- `price_backfill.started_at` for candidates two to five of a batch, by the preceding fetches: the
  refresh's instant instead of each fetch's own start.

Their only readers are the one-day retry clock (it shifts by those seconds) and Settings → Prices,
which shows the date alone (`app/routes/settings/prices.tsx:191`). The stamp is still taken before
any fetch and is never the answer or the commit, so `tests/price-backfill.test.ts:879`'s rule
survives, restated (§5.2). `docs/data-model.md:435` is updated (§6). `0010_price_backfill.sql:9`
("Fetch start, not commit") stays, because an applied migration is history; its point, not the
commit, still holds.

## 4. Callers, and what each passes

| Caller | Today | After |
|---|---|---|
| `app/routes/refresh.ts:17` | `runRefresh({ quotes: true })` | `runRefresh({ quotes: true }, new Date())` |
| `app/lib/price-poller.server.ts:127` (the tick) | `refresh({ quotes }, provider)` | `refresh({ quotes }, now, provider)` |
| `app/lib/price-poller.server.ts:56` (the seam's type) | `(options: { quotes: boolean }, provider: PriceProvider) => Promise<RefreshRun>` | `(options: { quotes: boolean }, now: Date, provider: PriceProvider) => Promise<RefreshRun>` |
| `app/lib/refresh.server.ts:68` | `refreshPrices(provider, tz, { quotes }, getDb())` | `refreshPrices(provider, tz, now, { quotes }, getDb())` |
| `refreshPrices` → `refreshQuotes`, `backfillCloses` (`:412`, `:415`) | `(provider, tz, db)` | `(provider, tz, now, db)` |
| `refreshQuotes` → `writeDailyClose` (`:505`) | `(trx, id, quote, tz)` | `(trx, id, quote, tz, now)` |

`scripts/` calls none of the writer's functions (`seed-demo.ts` plants `price_poll` rows with its own
SQL).

**The poller.** `createPricePoller` exists on `main`, so the poller passes its injected clock: the
`now` it reads once per tick (`const now = clock()`, `:107`), the same instant it checks the quote
window against. The quote-window decision and the writer's "today" come from one read. That takes
two hunks in `price-poller.server.ts`, the seam's type and the call (_amended 2026-09-25: the
type, one line in the plan, is 101 columns with `now` in it and wraps to one parameter per line,
still one hunk_). One hunk is not enough, because TypeScript refuses a third argument to a two-parameter dependency. The alternative,
`refresh: (o, p) => runRefresh(o, new Date(), p)` in `startPricePoller`, is one line but a second
wall-clock read instead of the injected one. `startPricePoller`'s `refresh: runRefresh` (`:240`)
stays assignable. So do `tests/price-poller.test.ts`'s `pollerWith` fake (`async (options) => …`,
`:141`) and its three `refresh: runRefresh` cases (`:161`, `:185`, `:217`). That file does not change.
Those three now hand `TRADING_HOUR`/`WEEKEND` to the writer. None of them asserts on a date: the weekend
case's candidate range (`2024-03-22` to `2026-06-07`) is valid, and its assertions are
`asked`/`askedHistory`/`releases`/`price_poll`.

## 5. The test plan

No case in these four files fakes the global clock afterwards:
`grep -n 'useFakeTimers\|setSystemTime\|withClockNear' tests/refresh-quotes.test.ts
tests/price-backfill.test.ts tests/refresh.test.ts tests/routes/refresh.test.ts` is empty.

### 5.1 `tests/refresh-quotes.test.ts`

- Delete `withClockNear` and its comment (`:51-59`). `vi` stays imported: `vi.spyOn(console, "warn")`
  is used at `:354`, `:382`, `:476` and `:1028`.
- Add `const NOW = new Date("2026-06-05T21:00:00Z");` beside `NEW_YORK`, commented as the instant a
  case runs at unless it states its own: the default quote's session, after its close.
- Each of the twenty `withClockNear(X, async () => { … })` bodies is unwrapped (keeping `withDatabase`
  around it), and its `refreshQuotes` calls pass `X` as `now`. Cases whose instant is their subject
  pass it inline as `new Date("…")`. Every other case passes `NOW`:

  | Case (line) | `now` |
  |---|---|
  | :109, :149, :230, :378, :554, :942, :980, :1002, :1024, :1063, :1086 | `NOW` (all faked `2026-06-05T21:00:00Z` today) |
  | :185 "files the close under the market date inside the quote, not under today" | `new Date("2026-06-06T12:00:00Z")` |
  | :209 "rewrites today's provisional close…" | `new Date("2026-06-05T18:00:00Z")` |
  | :283, :326, :349, :398, :449, :472 (the window's edges and its warning) | `new Date("2026-06-15T12:00:00Z")` |
  | :423 "measures the window against the market's own date, not the runtime's" | `new Date("2026-06-06T02:00:00Z")` |

- :942's comment "under a real clock no close would be written at all…" (`:945`) is restated
  against `NOW`. :1024's "within the seven-day window…" (`:1031`) never named the clock and stays as
  it is, true under `NOW` (_amended 2026-09-25_).
- "records the attempt with the report the refresh assembled" (`:1128`) also asserts
  `started_at` equals `NOW`, so the poll stamp is pinned the way :879 pins the ledger's
  (_amended 2026-09-25, from code review_).
- Every call not under `withClockNear` today (`:70`, `:82`, `:100`, `:133-134`, `:266`, `:502`,
  `:522`, `:541`, `:581`, `:602`, `:622`, `:729`, `:747`, `:782`, `:809`, `:831-832`, `:859`, `:864`,
  `:887`, `:926`, `:1120`, `:1136`, `:1160`, `:1181-1182`) passes `NOW`. Their assertions are
  date-independent. Under `NOW` their 2026-06-05 closes are admitted instead of refused by today's
  real date, which silences the stray `Price close skipped` warnings they emit today. Any assertion
  that turns out to have depended on the real date is reported, not quietly re-pinned.

**The seven-day edges.** They are pinned already, at both edges, by `:449` (seven before,
admitted), `:398` (seven after, admitted), `:283` (eight before, refused) and `:326` (eight after,
refused), with `:423` for the market date against the UTC date. After this change each states its
instant through `now`. A fifth case restating the same four would be the near-copy AGENTS.md warns
against, so none is added.

### 5.2 `tests/price-backfill.test.ts`

- Remove the three `useFakeTimers`/`useRealTimers` pairs (`:842`, `:893`, `:1077`) and the
  `setSystemTime` (`:889`). `vi` stays imported: `vi.spyOn` at `:1144-1145` uses it.
- Add `const NOW = new Date("2026-06-05T21:00:00Z");`. It is later than every fixture's first-held
  date, so `range_from < range_until` holds.
- :820 "asks one symbol per call, deepest gap first, over a range ending today" passes
  `new Date("2026-06-05T02:00:00Z")` and still asserts `until: "2026-06-04"`. Its comment about 02:00
  UTC being the previous evening in New York stays.
- :879 becomes "stamps every attempt in a batch with the refresh's instant, never when the provider
  answered". A second candidate is seeded beside the first,
  `heldFrom(context, { symbol: "BND", asOf: "2024-06-01" })`. The call passes `now = began`
  (`2026-06-05T14:00:00Z`) and the provider no longer calls `setSystemTime`. Both ledger rows'
  `started_at` equal `began`. The `:886` comment about the span goes. A writer that read the wall clock would stamp
  2026-09 or later and fail.
- :1068 passes `new Date("2026-06-05T21:00:00Z")` (or `NOW`) to `refreshPrices(provider, NEW_YORK,
  now, { quotes: true }, …)`. `:1076`'s comment is restated against `now`.
- :805 "does not offer the instruments it just attempted to the next batch" (its call at `:812`) passes `new Date()`,
  commented: the retry skip compares the stamp with Postgres `now()`, so the stamp must be the real
  instant. This is the one real-clock read left in the file's writer calls, and it is the database's
  clock, out of scope.
- Every other `backfillCloses`/`refreshPrices` call passes `NOW`. A case whose assertions turn out to
  read the retry skip passes `new Date()` with the same comment.
- `refreshPrices(…, { quotes: true }, …)` results are read without a type narrowing, for example
  `expect(report.quotes).toMatchObject({ … })` or `expect(report.quotes?.priced).toBe(…)`, never
  `!`.

### 5.3 `tests/refresh.test.ts`

- Add `const NOW = new Date("2026-06-05T21:00:00Z");` beside `QUOTED_AT`. Every
  `runRefresh({ quotes: true }, provider)` becomes `runRefresh({ quotes: true }, NOW, provider)`
  (`:79`, `:117`, `:149`, `:175`, `:197`, `:219`).
- The reads through the deleted `{ quotes: true }` overload (`run.report.quotes.requested/.priced/.observed`
  at `:84-86`, `.providerFailed/.stale` at `:178-179`) become non-narrowing, as in §5.2; after the change
  `run.report.quotes` is `RefreshReport | null` and they would not typecheck.
- New case in the "a run that takes the lock" describe (`:69`, where the two projection cases live),
  shaped as `:93`'s case (`createPool(TEST_DATABASE_URL)`, `withDb(db, …, pool)`, `pool.end()` in a
  `finally`), since `runRefresh` takes the advisory lock through `getPool()`: "answers error for a done run that carried no quotes
  report, rather than inventing counts". `outcomeOf(await runRefresh({ quotes: false }, NOW,
  fakeProvider()))` equals `{ status: "error" }`, with the run itself asserted `done` and
  `report.quotes` `null`.

### 5.4 `tests/routes/refresh.test.ts`

- :84's case uses fixed dates: `const now = new Date("2026-06-15T13:30:00Z")`, keeping the case's own
  local name (_amended 2026-09-25_; 13:30Z is session open,
  clear of any New York day boundary). The first-held date is `2026-05-26` (twenty days before). The
  split is `2026-06-05T13:30:00Z`, with bars at `2026-06-01T13:30:00Z` and `2026-06-10T13:30:00Z` (both weekdays).
  The call is `refreshPrices(socketProvider(), NEW_YORK, now, { quotes: true }, db)`. The assertions
  name the literal dates: the quote's close on `2026-06-15` is `65.5000`, `2026-06-01` is `200.0000`,
  `2026-06-10` is `60.0000`, and `written` is 2. The "Real calendar days… would age out of range"
  comment (`:86-87`) goes. `isoDaysAgo`/`barAt`/`marketDateOf` go if nothing else uses them.
- `report.quotes.x` reads become non-narrowing, as in §5.2.
- The two route cases (`:35`, `:60`) go through the action, which passes `new Date()`. Their
  assertions do not depend on the date, so they are unchanged.

## 6. Documentation this change moves

- `app/lib/prices.server.ts`:
  - The header gains "No clock read: `now` is always a parameter".
  - `CLOSE_WINDOW_DAYS`'s comment (`:36`) says "`now`'s market date" where it says today's. The
    header's "never today's date" (`:3`) is the other sense (which date a close is filed under) and
    stays, as does the `:517` log line.
  - `backfillCloses`' docstring: the range ends at `now`'s market date, exclusive, and every ledger
    row of the batch is stamped `now`.
  - The comment at `:307-308` about the span to the commit goes with the local.
  - `refreshPrices`' docstring is otherwise kept.
- `app/lib/refresh.server.ts`:
  - `RefreshRun`'s docstring drops the overload clause.
  - `RunWithQuotes` and its docstring go.
  - `outcomeOf`'s docstring states the null case (§2).
  - `RefreshOutcome`'s `error` comment names that second source.
  - `runRefresh`'s docstring is kept: never throws, what `busy` and `error` mean, the provider
    default.
- `docs/data-model.md:435`, `price_backfill.started_at`: "when the refresh that attempted it began,
  never when the provider answered or the row committed". `ARCHITECTURE.md:716`, the ER diagram's
  `started_at` note, carries the same sentence and gets the same restatement. `data-model.md:417`
  (`price_poll`, "when the attempt began") stays true.
- `ARCHITECTURE.md:416` cites `prices.server.ts:775` for `priceFreshness`. The overloads' removal
  moves that line, so the reference is re-derived. No Appendix A row describes the overloads or a
  clock. `refresh.server.ts`'s row names the provider default, which stays. Nothing else in
  ARCHITECTURE.md moves beyond `:416` and `:716`.
- `docs/specs/README.md` gains this spec's row.

## 7. Differential validation

A refresh must write exactly what it wrote before, for the same instant. Run one script against a
checkout of `origin/main` and against this branch, then diff the output.

**Setup.**

1. `git worktree add <scratchpad>/main origin/main`, then symlink this checkout's `node_modules`
   into it (the lockfile is shared).
2. Postgres from `compose.test.yaml`. Each side runs inside `withDatabase`, which rolls back, and
   the sides run one after the other.
3. Two files go into `tests/` of each checkout for the run and are deleted after:
   - `tests/zz-differential.test.ts`, identical on both sides.
   - `tests/zz-differential-call.ts`, one per side, exporting
     `refreshAt(provider, now, quotes, db): Promise<RefreshPricesReport>`:
     - main: `vi.useFakeTimers({ toFake: ["Date"], now })`, then
       `refreshPrices(provider, NEW_YORK, { quotes }, db)`, then `vi.useRealTimers()` in a
       `finally`. This is exactly what `withClockNear` does.
     - branch: `refreshPrices(provider, NEW_YORK, now, { quotes }, db)`.

**Seed** (fixtures, identical both sides):

- Feed instruments `VTI`, `BND`, `NVDA` and `VXUS`.
- One account holding all four from `2026-05-01`, so all four are backfill candidates from
  `2026-04-24`.
- No closes.

Call 1 fills `VTI`, `BND` and `NVDA`, whose first close then sits at or before first-held, so they
stop being candidates (`NO_CLOSE_BY_FIRST_HELD`, `prices.server.ts:107-112`). `VXUS`'s history is
always empty (`no_history`, nothing written), so it remains the one candidate on every later call.
That is what gives calls 2–9 a batch, a `range_until` from each `now`, and a ledger stamp to compare.

**Scripted `PriceProvider`**, whose state is switched between calls:

- `getQuotes(symbols)` answers the call's scripted quotes: `price` `"100.0000"` (call 2:
  `"101.2500"`, so the settling close is visible), `quoteType` `"ETF"`, `yieldPct` and
  `annualDividendPerShare` `null`, `asOf` as the table says, and `fetchedAt` five seconds after
  `asOf`. Or it throws `new Error("429 Too Many Requests")` when scripted to fail.
- `getDailyCloses(symbol, range, tz)` returns `toProviderHistory(chartFor(symbol), range, tz)`
  (`app/lib/price-provider.server.ts:232`), so the adapter's own `until` cut and split handling
  run against the writer's range.
  - `chartFor` answers `{ meta: { currency: "USD" }, events: { splits }, quotes }` with one bar per
    weekday at 13:30Z from `2026-04-20` to `2026-06-30`, each `close: 100`. For `VXUS` it answers
    `{ meta: { currency: "USD" }, quotes: [] }`.
  - `NVDA` carries a 2-for-1 split at `2026-05-15T13:30:00Z`.
  - The raw shape is whatever `yahooChart` in that file parses; `tests/price-provider.test.ts`'s
    `bar()` shows one.
- When scripted, `getDailyCloses` throws `new Error("chart 500")`, or instead
  `new ProviderUnreachable("socket refused")`.

**Calls, in order**, each on its own fixed `now` with `NEW_YORK`:

| # | `now` | `quotes` | Provider | Covers |
|---|---|---|---|---|
| 1 | `2026-06-04T15:00:00Z` (Thu 11:00 EDT) | true | `VTI`, `BND`, `NVDA`, `asOf` `2026-06-04T14:59:00Z` (`VXUS` unquoted, so stale) | inside the scheduled quote window; the fill, the split |
| 2 | `2026-06-04T23:00:00Z` (Thu 19:00 EDT) | true | the same three, `asOf` `2026-06-04T20:00:00Z` | outside it; today's close settles |
| 3 | `2026-06-06T15:00:00Z` (Sat) | false | — | backfill-only; no `price_poll` row |
| 4 | `2026-06-08T15:00:00Z` | true | quotes throw; history throws `Error` | provider failure; a `provider_failed` ledger row stamped `now` |
| 5 | `2026-06-08T16:00:00Z` | true | quotes throw; history throws `ProviderUnreachable` | the batch-failed path and its warning |
| 6 | `2026-06-15T12:00:00Z` | true | `VTI` only, `asOf` `2026-06-08T20:00:00Z` | seven days before: admitted |
| 7 | `2026-06-15T12:00:00Z` | true | `VTI` only, `asOf` `2026-06-22T20:00:00Z` | seven after: admitted |
| 8 | `2026-06-15T12:00:00Z` | true | `VTI` only, `asOf` `2026-06-07T20:00:00Z` | eight before: refused |
| 9 | `2026-06-15T12:00:00Z` | true | `VTI` only, `asOf` `2026-06-23T20:00:00Z` | eight after: refused |

Calls 2–9 have `VXUS` as their only backfill candidate. The retry clock compares June stamps with
the real Postgres `now()`, so it re-offers `VXUS` every call, identically on both sides.

**After each call, record:**

- the returned report;
- every `console.info`/`warn`/`error` line: `vi.spyOn(console, level).mockImplementation(() => {})`
  around each call, restored after, recording `[level, String(args[0]), args[1] instanceof Error ?
  args[1].message : null]`;
- `quote`, `price_daily`, `price_observation`, `price_poll` and `price_backfill`, plus
  `instrument.quote_type`:
  - every `instrument_id` replaced by the instrument's symbol, because identity sequences survive
    the rollback and differ between runs;
  - the `id`s of `price_poll` and `price_backfill` dropped;
  - timestamps as `toISOString()`, `started_at` and `as_of` included;
  - rows ordered by every remaining column.

The test writes it all as JSON with `writeFileSync(process.env.DIFF_OUT, …)`. Per side:
`cd <checkout> && DIFF_OUT=<scratchpad>/<side>.json npx vitest run tests/zz-differential.test.ts`
(the include is `tests/**/*.test.ts`, so the call module is not collected). Then `diff` main's file
against the branch's. Any difference
is a defect. None is predicted. In particular, `started_at` is the call's `now` on both sides,
because on main the faked clock holds still for the whole call.

**In the running app.** Run `npm run dev` on `seed-demo` data with the real `socketProvider()`,
without the worker. Unreachable is a valid state, and on `main` the same state is used for
comparison. Check that:

- A **Refresh now** press renders the same outcome text as a press on `main`.
- It logs the same lines.
- `/healthz`'s `pricing.quotes` reads the same.
- An upload commit's post-commit refresh (`requestRefresh()`, `app/routes/upload/review.tsx:141`)
  logs once. Use `tests/fixtures/statements/schwab.csv` into a seeded account.

Capture the outcome, the log excerpt and the `/healthz` body on both sides. `scripts/smoke-test.sh`
does not apply: it is the CI smoke test over the compose stack (`:2-5`).

## Acceptance

**The interface**

- [ ] `refreshPrices`, `refreshQuotes`, `backfillCloses`, `writeDailyClose`, `runRefresh` and
      `outcomeOf` have exactly §1's signatures. `now: Date` is required everywhere and defaulted
      nowhere.
- [ ] Both overload sets and `RunWithQuotes` are gone. `RefreshRun` is the only run type.
- [ ] `outcomeOf` answers `{ status: "error" }` for a `done` run with a null quotes report, and its
      docstring says why the route never reaches it.

**The clock**

- [ ] `grep -n 'new Date()' app/lib/prices.server.ts app/lib/refresh.server.ts` is empty
- [ ] `app/routes/refresh.ts` passes `new Date()`. The poller passes the tick's `now`, in two
      hunks (the seam's type and the call) and nowhere else in that file.
- [ ] `marketDateOf(quote.asOf, …)` reads, the window comparison, `CLOSE_WINDOW_DAYS` and every log
      line are unchanged

**The tests**

- [ ] No `useFakeTimers`, `setSystemTime` or `withClockNear` remains in the four files of §5
- [ ] The window's four edges state their instant through `now`. :879 restates the stamp rule over
      two candidates. The null-case test exists.
- [ ] `tests/routes/refresh.test.ts` uses fixed dates. Its "would age out of range" comment is gone.
- [ ] `tests/price-poller.test.ts` is unchanged
- [ ] `npm run typecheck`, `npm test` and `npm run build` pass

**The docs and the proof**

- [ ] §6's edits are made, and no others
- [ ] §7's differential shows no difference, and the running-app checks hold

## Review findings rejected

Grounding review, round 1 (fourteen findings; twelve folded in, including both material ones: the
differential's calls 4–5 reached no history path until `VXUS` was added, and §5.3 missed the two
reads through the deleted overload):

- **Pin the null case with a literal `outcomeOf({ status: "done", report: { quotes: null, backfill } })`,
  no database.** Rejected. Every case in `tests/refresh.test.ts` goes through `runRefresh` under
  `withDb`. A literal would restate `BackfillReport`'s eight fields a second time: `emptyBackfillReport`
  is unexported, and `tests/price-poller.test.ts`'s `backfill()` already restates them (spec 0025 §7).
  The real run also pins the chain a caller depends on, from `{ quotes: false }` to `error`.
- **This container runs Node 22.** An environment note, not a finding about the plan. Every command
  here runs under Node 24.21.

Grounding review, round 2: nothing material. Its ten minor findings (line numbers; the two imports
`RunWithQuotes` strands; `vi` staying in `price-backfill`; how :879's second candidate and the
null-case test are seeded; the differential's values, output, console capture, upload fixture, and
the smoke test not applying) are folded in. Grounding stopped here.

Code review (2026-09-25), two reviewers, correctness and standards: nothing material. Taken: the
poll stamp is pinned (§5.1); :209's instant, repeated inline, becomes one local; §5.1, §5.4 and §6
wording matches the code. Mutation runs by the correctness reviewer confirmed the tests bite:
`CLOSE_WINDOW_DAYS = 6`, a wall-clock ledger stamp, a wall-clock `until`, a wall-clock window
"today" and `outcomeOf`'s null case answering `busy` each fail at least one test. No finding was
rejected.
