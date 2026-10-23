# 0031 — Manual prices: typed, dated, kept, and asked for when the instrument is made

_Closes [#292](https://github.com/chethan123/portfolio/issues/292) (QA-05 of
[the 2026-09-13 product QA audit](../research/2026-09-13-product-qa-audit.md)). Line numbers were
read at `488bbec`._

**What to build:** The manual-price path DESIGN.md §6.2 promised and nothing built. An instrument
with `price_source = 'manual'` (a workplace plan's collective investment trust: no ticker, no feed)
can be created at the instruments step today, and then nothing in the app can price it. It reads
"never priced" on every screen and is left out of every total, indefinitely.

1. **One writer.** `prices.server.ts` gains the manual write: a dated `price_daily` row, and the
   `quote` row recomputed from the latest of them — both tiers, as
   [spec 0002](0002-pricing.md#manual-prices-write-both-tiers) decided and nobody built.
2. **Asked at creation.** Choosing **Manual price** for a new instrument at the instruments step
   now requires a price and its date, written in the same transaction that creates the
   instrument. A manual instrument can no longer be made unpriced.
3. **Updated afterwards.** Settings → Prices gains a **Prices typed by hand** panel: every
   manual instrument with its latest price and date, and a form that records the next one.

Worth doing as one change: the writer has no caller without one of the two forms, and the
instruments step's copy is a false promise until the writer exists. Neither form is large.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**Out of scope:**
- Age-based staleness for manual prices (the 30-day "stale manual prices" panel of
  `docs/design/pricing-ui-brief.md` §6.1, [pricing/05](pricing/05-pricing-ui.md)). The panel here
  shows the date, which is the input to that rule; the rule is its own change.
- Editing an instrument's symbol, price source or classification — the rest of Settings →
  Instruments.
- A price column role in the statement mapping. The person types the price from the statement;
  reading it from the file is a later convenience, not the fix.
- 1D. `readSessionSeries` opens on the last close strictly before the session
  (`valuation.server.ts:449-461`), so a manual price dated today shows on 1D from a later session.
  "Today" is a UTC date (`chart-range.ts:90`, as `account.tsx:79`), so on a US evening that is the
  next market day's session and the lag is two sessions. True of every instrument without
  observations, and unchanged here.
- **The cost this leaves open.** Before this change a manual holding read "never priced" and was
  plainly missing. After it, a months-old typed price feeds every total with no as-of signal on
  Holdings: `priceFreshness` is feed-only (`price-freshness.server.ts:20`) and `holdingNote` says
  nothing for a priced manual holding (`holdings-view.ts:591-592`). The date is on Settings → Prices;
  surfacing its age on the screens that read it is the staleness rule above.
- Deleting a recorded manual price. A wrong one is corrected by recording that date again.
- **The overflow gap this makes easier to reach.** The upload guard checks quantity × `quote.price`
  only (`uploads.server.ts:1158, 1976`), and `revisePosition` the same (`positions.server.ts:214`),
  while `holding_valued_at` values a back-dated set at the close carried to its date. A large
  back-dated typed close, then a later upload of a big quantity dated before the latest close, can
  overflow history. Pre-existing for feed closes; one guard over closes belongs to those writers.

## 1. The writer

In `app/lib/prices.server.ts`, the only price writer (ARCHITECTURE.md §4.2):

```ts
export type ManualPrice = { instrumentId: string; date: IsoDate; price: string };

/** Both tiers: a dated close, then the quote re-read from the latest close. */
export async function writeManualPrice(
  trx: Kysely<Database>, entry: ManualPrice, now: Date,
): Promise<{ name: string; symbol: string | null; price: string }>   // the stored close, for a receipt
```

Inside one transaction (`inTransaction`), in order:

1. `select name, price_source from instrument where id = $1 for update`. The row lock serialises
   two writes for one instrument, so the quote step below cannot read a snapshot missing the
   other's close and leave the quote on the older date. A row that is gone, or no longer `manual`,
   is a form-level refusal (§2), checked here under the lock rather than before it.
2. **The overflow guard.** `quantity × price` is cast to `numeric(20,4)` by both views
   (`0019_trailing_dividend.sql`'s `money` lateral, `0006_annual_dividend.sql:121`), and an
   overflow there raises on every later read of every screen, not just this form
   (`positions.server.ts:124-127`). Every person-typed write that sets one side of the product checks it
   with `fitsTheMoneyColumn` (`positions.server.ts:128`, `uploads.server.ts:1966-1994`). This one
   reads `max(abs(quantity))` over **every** `holding` row of the instrument, in every set — a
   back-dated close values older sets too — and refuses on the `price` field when
   `fitsTheMoneyColumn(that, price)` fails; no holdings (a null max) skips it. `FOR UPDATE` (not `FOR NO KEY UPDATE`) conflicts with
   the `FOR KEY SHARE` a concurrent `holding` insert takes on the instrument row, so a holding
   committed before the lock is seen. The race left: an upload commit that read the old quote
   before this lock, guarded against that old price. Narrow, and the same window revisePosition
   leaves; accepted.
3. `insert into price_daily (instrument_id, date, close) … on conflict (instrument_id, date) do
   update set close = excluded.close`. One close per instrument per day is the table's grain;
   recording a date again corrects that date. Every other date's close stays: that is the history
   `holding_valued_at` carries forward. Re-recording a date restates every figure from it to the
   next close, with no trace kept — ARCHITECTURE.md §4.5's write-paths table says so in its
   "Append-only?" column for this row.
4. `insert into quote (instrument_id, price, as_of, is_stale) select instrument_id, close, $now,
   false from price_daily where instrument_id = $1 order by date desc limit 1 on conflict
   (instrument_id) do update set price = excluded.price, as_of = excluded.as_of, is_stale = false`.
   The **latest-dated** close, not the one just typed: a back-dated entry fills history without
   moving today's figure backwards. The column list is named for `writeQuote`'s reason
   (`prices.server.ts:791-817`): `trailing_dividend_*` are not this writer's.

`as_of` is the moment of entry, as spec 0002 decided; nothing reads it for a manual instrument
(`priceFreshness` is feed-only, `price-freshness.server.ts:20`). `now` is a parameter, the file's
rule (`prices.server.ts:1-6`).

**Why the feed writers cannot collide with this one.** Every feed path selects
`price_source = 'feed'` (`selectFeedInstruments` `:104-110`, backfill candidates `:162`, the
dividend sweep `:449`), so the rows this writer upserts are rows no feed path touches. ARCHITECTURE.md
§4.2's "only one may rewrite a row" holds per instrument: a feed close is rewritten only by the
provider's own price, a manual close only by a person. No advisory lock is taken.

`writeManualPrice` is exported and has two callers:

```ts
/** Settings → Prices. Validates, refuses as data, then writeManualPrice in its own transaction. */
export async function recordManualPrice(
  raw: Record<string, string>, now: Date, db?: Kysely<Database>,
): Promise<RecordedManualPrice>   // { instrumentId, name, symbol, price, date }
```

and the instruments step (§3), inside the transaction that creates the instrument. Step 1's
refusals cannot fire there (the row was just inserted as `manual` in the same transaction), nor
step 2's (a new instrument has no holdings yet; the commit's own guard checks the statement's
quantities against `quote.price`, `uploads.server.ts:1158, 1976`).

## 2. Validation

A schema in `prices.server.ts`, parsed with `parseInput` (`input.server.ts:70-84`):

```ts
const manualPriceInput = z.object({
  instrumentId: z.string().trim().refine(couldBeId, "Choose an instrument priced by hand."),
  price: unitPrice("The price"),
  asOf: recordedDate("The date"),
});
```

- **`unitPrice(label)`**, new in `input.server.ts` beside `perShareAmount` (`:195-199`), over a
  new `unitPriceRule(label)` in `decimal-input.ts` beside `perShareAmountRule` (`:189-208`):
  required, unsigned, 4 decimal places (`numeric(20,4)`), 16 integer digits, and **zero refused**
  ("The price must be more than zero — a holding worth nothing is sold, not priced at nothing.").
  Its own rule rather than `perShareAmountRule`, whose sign message says "what one share cost".
  Zero is refused **in the rule**: `DecimalInputOptions` gains `positive?: boolean` and
  `DecimalInputReason` gains `"zero"`, so the browser's live note and the server refuse the same
  string (`decimal-input.ts:1-2`, `input.server.ts:107-108`). Both forms render the field as
  `<InterpretedNumberInput rule={unitPriceRule(…)} shape="money">`, as every typed decimal box
  does (`account.tsx:554`, `settings/tax.tsx:78`).
- **`recordedDate`** (`input.server.ts:147-181`) as it is, with one message generalised: "is in the
  future, and a balance can only be recorded once it is true" becomes "is in the future, and only
  what is already true can be recorded". The three assertions matching `/in the future/`
  (`balance-input.test.ts:162,170`, `set-balance.test.ts:412`) still pass.
- **Field refusal under the lock:** the overflow guard of §1 step 2, on `price`: "The price times
  the {quantity} units held is larger than this application can store."
- **Form-level refusals** (`ValidationError.form`), read under the lock in §1 step 1: the
  instrument does not exist ("That instrument no longer exists."), or is not `manual` ("{name} is
  priced from the feed, so a typed price would be overwritten by the next refresh." for `feed`;
  "{name} has a fixed price." for `fixed`).

The instruments step validates the same two fields with the same `unitPrice`/`recordedDate`, in
its own hand-written style: `unitPrice("The price").safeParse(fields.price)`, and on failure
`refuse(index, "price", error.issues[0].message)`; likewise `priceAsOf`.

## 3. The instruments step

`app/lib/instrument-resolution.server.ts`:

- `ResolutionFields` (`:152-164`) and `RESOLUTION_FIELDS` (`:166-175`) gain `price` and `priceAsOf`.
- In `resolveAll`'s validation loop (`:283-299`), when `priceSource === "manual"`, the two fields
  are parsed (§2) and refused per field when wrong. They are ignored for `feed`, as the unchosen
  branch's fields already are.
- `CreatePlan` (`:206-215`) becomes a union on `priceSource`: `feed` with `manualPrice: null`,
  `manual` with `manualPrice: { price; date }`, so a manual plan without a price cannot be built.
- `ResolutionDeps` (`:201-204`) gains `now?: Date`, read as `deps.now ?? new Date()`. Optional
  because `now` is not a network reach (the reason `probe` is required), and a required one would
  touch 36 `resolveAll` calls across six test files for nothing. The route passes `new Date()`.
- In the write transaction, **straight after the instrument insert** (`:543-557`), a plan with a
  `manualPrice` gets `writeManualPrice(trx, …, now)`. Before the alias step, not after it: an
  instrument that loses its string to a concurrent submit is deleted at `:589-591`, and
  `price_daily`/`quote` are `on delete cascade` (`0001_initial_schema.sql:137-138, 146-147`), so
  the loser's price goes with it. Written after the delete, step 1 would refuse a row that is gone
  and turn an idempotent double submit into a form error.

`app/routes/upload/instruments.tsx`:

- Two fields in the **This is new** branch, after the price source fieldset, in the existing
  "used only when" style of the new-classification pair (`:297-330`):
  **Price per unit** (`price-N`, `InterpretedNumberInput` over `unitPriceRule`) and **Priced on**
  (`priceAsOf-N`, `type="date"`, `min`/`max` from `earliestRecordableDate`/`latestRecordableDate`),
  with a field note: "Used only for a manual price: the unit price the statement shows, and the
  statement's date."
- **Priced on** defaults to the date the file states, and is otherwise blank. `statedStatementDate`
  returns null rather than throwing on `statementGroups`' unreachable branch
  (`uploads.server.ts:1357`), which the instruments loader would otherwise turn into a 500. The rule is the
  domain's: `statementGroups` (`uploads.server.ts:1338-1359`) already folds a chosen account and a
  routed file into groups carrying `asOfDate`; its parse parameter widens to the `instruments` step
  too (both arms carry `parsed` and `routed`, `:467-482`), and a new exported
  `statedStatementDate(draft, parse)` beside it returns the one date every group states, or null.
  Blank rather than today when the file states none (the date is asked at review, after this
  step, `:1399-1401`): a price dated today would leave the holding unpriced in history from the
  statement date until today, list it under missing price history, and let `readChange`
  (`valuation.server.ts:808-820`) count the whole holding as a gain over any range starting
  earlier. Blank makes the person type the statement's date. Review itself pre-fills today when the
  file states none (`uploads.server.ts:1040-1044`); this step does not follow it, because a wrong
  date here misprices history where review's is shown back beside the figures. Settings → Prices
  does default to today (§4): a price typed there is usually the one just read, and the table
  beside it shows each instrument's date.
- The false note (`:269-272`) becomes: "A manual price is typed from the statement below. It
  carries forward until a later one is recorded under Settings → Prices."
- The refused-message text at `instrument-resolution.server.ts:289` ("a manual price typed from
  the statement") stays true.

## 4. Settings → Prices

**Reader.** `manualPrices(db)` in `app/lib/prices.server.ts`, beside `backfillGaps` (`:215`), the
other reader this route already imports from there: every `price_source = 'manual'` instrument,
held or not, by name, with its latest `price_daily` row (`date`, `close`) or nulls. A lateral
`order by date desc limit 1`, the shape `holding_valued_at` uses. Not `price-freshness.server.ts`,
whose charter is the as-of line read from `holding_valued` (`:1-4`); not `valuation.server.ts`,
since it reads prices rather than holdings, as `backfillGaps` does.

**Route** (`app/routes/settings/prices.tsx`):

- Loader adds `manualPrices()` and `today`/`earliestAsOf`/`latestAsOf` (the `account.tsx:151-153`
  trio).
- The action dispatches on a hidden `intent`: `cadence` (today's body) and `manual-price` (calls
  `recordManualPrice(values, new Date())`), an unknown one a `400`, as
  `settings/people.tsx:18-46`. Each returns `{ intent, … }` so a refusal renders under its own
  form; a recorded price returns `{ intent: "manual-price", recorded }`.
- A **Prices typed by hand** panel between the cadence and the gaps:
  - No manual instrument: an `empty-note`, "Nothing here is priced by hand. An instrument created
    with a manual price at upload appears here." No form.
  - Otherwise a table, **Instrument · Latest price · Priced on**, "never priced" in the date cell
    (and `—` from `Amount` in the price cell) where never priced, then a
    form: **Instrument** (`<select>` of these instruments), **Price per unit**, **Priced on**
    (default today), and **Save price**. After a write, a `form-note` with `role="status"` above the
    form, as `account.tsx`'s receipt: "Recorded $52.4100 for
    {instrument} as of 2026-08-20." The table, re-read by the loader, is the rest of the receipt.
- The page's header comment (`:11-16`) and subtitle (`:53-56`) name the typed prices too.
- The gap list's manual wording (`:169-171`) points at the panel: "Never fetched — priced by hand.
  Record a price dated on or before the held-from date above to cover it."

`app/routes/settings/index.tsx:74-79` stops listing manual-price management as future work.

## 5. Tests

Domain, `tests/manual-prices.test.ts` (new; `withDatabase`, fixtures only):

- A recorded price makes a never-priced manual holding priced in `currentHoldings`, with its value
  exact (`"2620.5000"` for 50 × 52.4100), and counted in `netWorth`'s total and coverage.
- It carries forward: `holdingsAt` a later date is priced at it; a date before it is unpriced.
- A back-dated price fills `holdingsAt` at its date and leaves the current price on the later one.
- Recording a date again replaces that date's close and keeps every other date's.
- Refusals write nothing: a `feed` instrument, a missing one, zero, a negative price, five decimal
  places, a future date — each its own message on its own field or the form.
- A refresh leaves a manual quote alone: `refreshQuotes`, with a held feed instrument beside it so
  the stale marking actually runs, and a stub provider that answers nothing, marks the feed one
  stale and not the manual one.
- The overflow guard: an older set holding a larger quantity than the latest, and a back-dated
  price that overflows only against the older one, refused on `price`, nothing written.

`tests/instrument-resolution.test.ts`:

- Creating a manual instrument without a price refuses `price-0`, and without a date `priceAsOf-0`,
  and creates nothing.
- Creating one with both writes its `price_daily` close and its quote; the holding is priced.
- A feed creation ignores stray price fields.
- The existing manual-creation cases (`:371, :595-610` (`answerFor("manual")`), `:636, :762, :827,
  :920`) gain the two fields.

Routes:

- `tests/routes/settings-prices.test.tsx`: the panel lists a never-priced manual instrument with
  `—`; posting `intent=manual-price` records it and renders the confirmation; a refusal renders
  beside its field with the typed values back; posting `intent=cadence` still saves the cadence; the
  empty state renders without a form.
- `tests/routes/upload-instruments.test.ts`: `createAnswer` (`:53-65`) and the direct
  `resolveAll` call at `:136-150` gain the price fields; the default **Priced on** is the file's
  date when it states one and blank when it does not.
- `tests/routes/settings-prices.test.tsx:98`'s assertion of the old gap wording follows §4.

The journeys that create a manual instrument (`tests/journeys/statement-to-portfolio.test.ts`)
gain the fields, and one asserts the committed holding is priced.

## 6. Documentation this change moves

- DESIGN.md §6.2 (`:560-562`): the form exists, on Settings → Prices, and writes both tiers.
  §8.4's table (`:796`) moves "Set manual prices" from Instruments to Prices, and the Instruments
  paragraph (`:837-842`) keeps the staleness question, now answerable from Prices' dates.
- ARCHITECTURE.md: §4.2's "Writing a price" row and §4.5's write-paths table gain the manual
  writer; the "only one may rewrite a row" lines (`:393`, `:1846-1851`) say per instrument.
- `docs/data-model.md` §4.4 (`:382-388`) and §7 (`:776-779`): the third writer, and why it shares
  the table with the other two; and that a typed close can be dated any calendar day (a weekend,
  today, tomorrow in UTC), where the feed's are finished trading days only — the
  `0009_price_observation.sql:58` comment, ARCHITECTURE.md `:910, :1432, :2623` and ADR-0006 say
  "one row per finished trading day" of the feed.
- ARCHITECTURE.md's valuation exceptions (`:424-436`): the guard's direct `holding` read in
  `prices.server.ts`, beside the `backfillGaps` bullet.
- `docs/guide/upload.md:163-165`, `docs/guide/prices.md:25`, `docs/guide/settings.md:15-16, 97-98`,
  `README.md:274-278`: the editor exists.
- `docs/specs/README.md`: the 0031 row, and the `pricing/` note that manual entry landed here.
- Banners, per `docs/specs/README.md`'s rule for a claim that moved: `pricing/05-pricing-ui.md:43-44`
  (the manual-price item, delivered here on Prices), `0002-pricing.md:359-361` ("the Instruments
  tab derives it"), and `docs/design/pricing-ui-brief.md` §6.1/§6.4 (the entry form placed on
  Instruments).

## Acceptance

- [ ] A manual instrument cannot be created without a price and its date
- [ ] A recorded manual price writes a dated `price_daily` close and the quote from the latest close
- [ ] Current screens value the holding at once; history carries each close forward to its next
- [ ] Earlier prices survive a later one; re-recording a date corrects only that date
- [ ] Settings → Prices lists every manual instrument with its latest price and date, and records
      the next one
- [ ] The instruments step no longer promises a price nobody can type
- [ ] A price whose product with any held quantity overflows the money column is refused
- [ ] Refusals are data, per field, and write nothing
- [ ] `npm run typecheck`, `npm run build`, `npm test` green

## Review rounds

Two adversarial grounding rounds. Round 1 (three material): no overflow guard on the typed price;
the instruments step writing the price after the alias race, where a deleted loser would turn a
double submit into a refusal; zero refused outside the shared decimal rule. All three folded in,
with the minor ones (reader placement, the date default as a domain rule, line citations). Round 2
found the overflow test missing from §5 and nine minor points, folded in above. A code review of
the built change then moved the commit's overflow refusal to name a typed price, made the plan a
union, and asked one journey to assert the created holding is valued.

Rejected:
- **`compact` on the instruments step's price box**, to avoid repeating the format hint on every
  row. The hint is what the interpreted input is for; a statement with several new trusts is rare.
- **Defaulting Settings → Prices' date to blank too**, for symmetry with the upload step. Argued
  in §3: the two risks differ.
