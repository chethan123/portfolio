/**
 * Where prices come from, and the one shape the rest of the app knows them
 * in. DESIGN.md §6.1 fixed the interface at a single batched method;
 * ADR-0011 adds a second, and the reasoning that chose the first still holds:
 * `yahoo-finance2` is an unofficial client for an unpublished endpoint and
 * can break; what makes that tolerable is that swapping it is a day's work —
 * true only while nothing outside this module imports `yahoo-finance2`. The
 * interface is also the test seam: CI never reaches the network.
 *
 *   getQuotes        every symbol at once — the batching is why Yahoo was chosen
 *   getDailyCloses   one symbol, one range — history is per instrument, and the
 *                    endpoint offers no batch for it
 *
 * **Everything numeric leaves here as a decimal string.** The provider hands
 * back floats — exactly what §4.1 refuses near a money column — and the
 * conversion happens once, here, at the boundary.
 *
 * **The split convention the history method rests on, and what was checked.**
 * Yahoo's chart endpoint restates `close` through later splits — `adjclose` is
 * the split *and* dividend adjusted figure, and is not read. Statements record
 * shares as held on the day, so a pre-split close taken as stored would value a
 * position at a fraction of its worth, by exactly the split factor, with every
 * figure looking plausible. {@link toProviderHistory} therefore multiplies each
 * close back by the ratio of every split later than it (ADR-0011).
 *
 * That convention is stated nowhere in yahoo-finance2 4.0.2 — the installed
 * package documents adjustment on exactly one field, `historical.d.ts:89-92`'s
 * `adjClose` ("accounts for splits/dividends"), and says nothing about `close`.
 * ADR-0011 requires it be observed once against a real split, and **that check
 * has not been run**: the environment this landed in refuses every
 * `*.finance.yahoo.com` host at CONNECT, so no figure here was read from Yahoo.
 * It ships unverified as a signed-off decision rather than an oversight; the
 * recipe ticket 05 adds to `docs/developing.md` is where the next person runs
 * it. It is one call — `NVDA` over a range spanning 2024-06-10 with
 * `events: "split"` — and **three** things to record:
 *
 *  1. `events.splits` carries a 10:1 dated 2024-06-10. If it does not, the
 *     symbol or the range is wrong and nothing below was tested.
 *  2. The closes for the week before sit near $120 (adjusted) rather than near
 *     $1,200 (as struck). **Near $1,200 means the arithmetic below is wrong**,
 *     and the fallback ADR-0011 fixes applies: answer `split-unresolved` for
 *     any response carrying a split inside the range, emit the rest as
 *     received, and say so here.
 *  3. The raw instant on that split event — `events.splits[0].date` before any
 *     formatting. {@link toProviderHistory} files a split under
 *     `marketDateOf(split.date, zone)` on the assumption that Yahoo stamps it
 *     at the session open, as it stamps a daily bar. A split stamped at UTC
 *     midnight instead resolves to the *previous* New York date, and the bar
 *     genuinely on the split's own day would then be multiplied when it should
 *     not be — some rows right and some wrong, which is the outcome this
 *     module otherwise refuses outright. Nothing here detects that; only the
 *     recorded instant can settle it.
 *
 * The error class an unknown symbol throws was read out of the installed
 * package rather than observed, for the same reason. `yahooFinanceFetch.js:131-133`
 * builds the class name from Yahoo's own `code` with the spaces removed, looks
 * it up among the five classes `lib/errors.js:78-84` registers, and falls back
 * to a plain `Error` — of which only `"Bad Request"` ever resolves, so the
 * `"Not Found"` a delisted or unknown symbol answers is a plain `Error`. That
 * is why {@link isMissingHistory} matches the message and never the class.
 */
import { z } from "zod";

import { marketDateOf, type IsoDate } from "./market-hours.ts";
import { MONEY_SCALE, divide, render, toUnits } from "./money.ts";
import { matchKey } from "./prices.server.ts";

/**
 * One instrument's price, as the application understands it. `price` is
 * required and the rest are not: a provider that cannot say what a fund
 * yields is ordinary, one that cannot say what it costs is a failure — a
 * missing yield writes null (§8.2); a missing price means the symbol did not
 * resolve, and the caller keeps the last known price and marks it stale (§6.2).
 */
export type ProviderQuote = {
  /** As sent. The caller matches on this to find the instrument again. */
  symbol: string;
  /** Decimal string, scale 4. Never a number. */
  price: string;
  /** The provider's own vocabulary, stored unconstrained — theirs, not ours (§4.1). */
  quoteType: string | null;
  /** Annual dividend yield as a percentage. Decimal string, scale 6. */
  yieldPct: string | null;
  /** Annual dividend per share. Decimal string, scale 4. */
  annualDividendPerShare: string | null;
  /**
   * The instant the provider struck this price — a genuine instant, so a
   * `Date` (§4.1 leaves `timestamptz` alone). Load-bearing: it decides which
   * `price_daily` row this quote becomes, and which `price_observation` row —
   * one per instrument per instant, what makes an unchanged quote write
   * nothing (`marketDateOf`, ADR-0006).
   */
  asOf: Date;
  /**
   * When we learned this price, as distinct from when it was struck. Required,
   * unlike `payload`, because it is a fact about *us* — every implementation
   * and fake knows what time it asked. Archived, computed from by nothing.
   */
  fetchedAt: Date;
  /**
   * The provider's raw entry, kept opaque. Optional because it is a fact
   * about the *provider* — a fake has none to hand over. Present only when
   * the typed parse succeeded, so a shape change stays a refusal rather than
   * a stored surprise. `unknown` on purpose (ADR-0006): an archive, never an
   * operand — nothing may compute from it, so nothing may need its type.
   */
  payload?: unknown;
};

/** The span a history call asks for. `until` is exclusive. */
export type HistoryRange = { from: IsoDate; until: IsoDate };

/**
 * One finished trading day, ready for the spine. `close` is **already
 * un-adjusted for splits** — the figure the shares were actually worth on the
 * day, scale 4. The arithmetic happens here, in {@link toProviderHistory}, on
 * `money.ts`'s units; the writer inserts what it is handed and multiplies
 * nothing.
 */
export type ProviderDailyClose = { date: IsoDate; close: string };

/**
 * What one history call can say — a closed set in the shape {@link SymbolProbe}
 * already uses, because the caller's answers are fixed: write the closes, or
 * record one of three reasons there are none. A call that *fails* throws
 * instead, and the caller records the text.
 *
 * The three refusals map one-to-one onto the ledger's outcome vocabulary
 * (`prices.server.ts`'s `BACKFILL_OUTCOMES`). That is a deliberate duplication:
 * one is the provider's answer in this module's own shape, the other is a
 * `check` constraint's literals, and the mapping between them is one object in
 * the batch rather than a vocabulary shared across the boundary.
 */
export type ProviderHistory =
  | {
      status: "ok";
      /** At least one. A response with none is `no-history`, not an empty `ok`. */
      closes: ProviderDailyClose[];
    }
  | { status: "no-history" }
  | { status: "non-usd"; currency: string }
  | { status: "split-unresolved" };

/**
 * The provider contract. Two methods, and the asymmetry is the endpoint's:
 * `getQuotes` takes every symbol at once — the batching is why Yahoo was
 * chosen, one HTTP call for a hundred symbols rather than a hundred calls or a
 * per-symbol bill — while a range is a property of one instrument and there is
 * no batch form for it, so history is one symbol per call.
 *
 * `getDailyCloses` is required, not optional: a provider that cannot answer
 * history is not this application's provider, and an optional method would let
 * the write path skip a batch with nothing saying so.
 */
export type PriceProvider = {
  getQuotes(symbols: string[]): Promise<ProviderQuote[]>;
  getDailyCloses(
    symbol: string,
    range: HistoryRange,
    marketTimeZone: string,
  ): Promise<ProviderHistory>;
};

/**
 * A quote in a currency we cannot hold. §6.1 puts this guard at instrument
 * resolution; it is enforced here too because the failure it prevents is the
 * worst available — no error anywhere, GBP quietly summed into a USD net
 * worth. Carries symbol and currency so the log line names both.
 */
export class CurrencyRefused extends Error {
  override readonly name = "CurrencyRefused";
  readonly symbol: string;
  readonly currency: string;

  constructor(symbol: string, currency: string) {
    super(
      `${symbol} is quoted in ${currency}. This instance holds USD only, so the price was not stored.`,
    );
    this.symbol = symbol;
    this.currency = currency;
  }
}

/** The only currency this application can store. There is no currency column. */
const USD = "USD";

/**
 * A float from the provider as a decimal string. `toFixed`, not a decimal
 * library: the input is already a float through JSON, so there is no
 * precision left to preserve — the job is only to stop the float going any
 * further. Null for anything not a usable finite number, so `null`, `NaN` or
 * a string never reaches a `numeric` column.
 */
function decimal(value: unknown, scale: number): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value.toFixed(scale);
}

/** The widest yield `quote.yield_pct` holds — `numeric(10,6)`, 9999.999999%. */
const YIELD_CEILING = 10000;

/**
 * The widest rate `quote.annual_dividend_per_share` holds — `numeric(20, 4)`,
 * sixteen integer digits. No security pays near it, which is the point: a
 * figure this big is not a rate, and the ceiling exists so one such figure
 * cannot abort a refresh — not to express a view about dividends.
 */
const RATE_CEILING = 10 ** 16;

/**
 * The widest close `price_daily.close` holds — `numeric(20, 4)`, the same
 * sixteen integer digits, and the same reasoning as {@link RATE_CEILING}: a
 * figure this big is not a price, and an overflow would abort the transaction a
 * whole batch of backfilled closes is committing in. It bounds the un-adjusted
 * *product* as well as the figure that arrived, because the product is what
 * reaches the column — and because `toFixed` switches to exponential notation
 * at 1e21, which `money.ts`'s digit parser cannot read.
 */
const CLOSE_CEILING = 10 ** 16;

/**
 * The widest price `quote.price` holds — `numeric(20, 4)`, the same sixteen
 * integer digits as {@link RATE_CEILING} and {@link CLOSE_CEILING}, and the
 * same reasoning: a figure this big is not a price, and Postgres answers the
 * overflow by aborting the statement inside the refresh transaction — every
 * instrument stale for one bad symbol, not just the one that carried the
 * figure. Dropped, not clamped, so the quote itself is absent and the symbol
 * goes stale exactly as it does when no price arrives at all.
 *
 * What this does not guard, and cannot: the reader's `quantity × price`
 * product (`0006_annual_dividend.sql:149`). `quantity` is `numeric(20, 8)`
 * (`0001_initial_schema.sql:186`), so a legal price under this ceiling can
 * still overflow the product against the widest legal quantity;
 * `fitsTheMoneyColumn` (`app/lib/positions.server.ts:206`) guards that product
 * where the quantity is written, and spec 0018 §8 keeps the gap as a residual
 * rather than a bug this ceiling could close.
 */
const PRICE_CEILING = 10 ** 16;

/**
 * A figure the bound `numeric` column can actually store, or null. A
 * distressed instrument — a $0.02 price still carrying a $2.50 rate —
 * derives a 12500% yield, and Postgres answers overflow by aborting the
 * statement inside the refresh transaction: one bad symbol would cost the
 * whole household its refresh, the outcome the per-symbol currency guard
 * exists to prevent. Dropped, not clamped: a yield at the ceiling is a wrong
 * number presented as real, and §8.2's rule is to report the unknown as
 * unknown.
 */
function inRange(value: string | null, ceiling: number): string | null {
  if (value === null) return null;
  return Math.abs(Number(value)) < ceiling ? value : null;
}

/**
 * The subset of Yahoo's payload this application reads, validated. Zod rather
 * than the library's own types: those describe what the endpoint returned
 * when they were written; this describes what we require, failing loudly at
 * the boundary instead of producing `undefined` three layers in — and it
 * documents how small the dependency on an unofficial API is. Everything but
 * `symbol` is optional: Yahoo omits fields per instrument type.
 */
const yahooQuote = z.object({
  symbol: z.string(),
  currency: z.string().optional(),
  quoteType: z.string().optional(),
  regularMarketPrice: z.number().optional(),
  regularMarketTime: z.union([z.date(), z.number(), z.string()]).optional(),
  /**
   * Annual dividend yield as a percentage — 2.34 meaning 2.34%. What is *not*
   * read: `trailingAnnualDividendYield`, the same quantity as a fraction
   * (0.0234) though the library's doc calls it a percentage too — taking the
   * wrong one is a silent hundredfold error on the Income page with every
   * figure looking plausible. Where this is absent the yield is derived below
   * from rate over price, which cannot be misread in either unit.
   */
  dividendYield: z.number().optional(),
  /**
   * Annual dividend per share, declared on equities and mutual funds. An ETF
   * carries no `dividendRate` at all — its per-share figure arrives as
   * `trailingAnnualDividendRate` — so reading only this one would leave the
   * column null for every ETF a household holds.
   */
  dividendRate: z.number().optional(),
  /**
   * The ETF spelling of the field above, and unambiguous where its `…Yield`
   * sibling is not: an amount of money, no percent-versus-fraction question.
   */
  trailingAnnualDividendRate: z.number().optional(),
});

type YahooQuote = z.infer<typeof yahooQuote>;

/**
 * Yahoo's `regularMarketTime` as an instant. The library hands back a `Date`
 * but has shipped epoch seconds before, so all three plausible shapes are
 * accepted; anything unrecognised falls back to fetch time — the lesser
 * error, not a safe one: "now" is at worst hours late on a NAV (the next poll
 * corrects it), and can file a close against a non-trading day when
 * `isMarketOpen` wrongly called it open — a spurious row rather than a wrong
 * price, versus discarding a real price over missing metadata.
 */
function instantOf(value: YahooQuote["regularMarketTime"], fetchedAt: Date): Date {
  return parseInstant(value) ?? fetchedAt;
}

/**
 * The three plausible shapes of a Yahoo timestamp, or null. The library hands
 * back a `Date` and the raw endpoint sends epoch seconds; both have shipped.
 *
 * Separate from {@link instantOf} so the *parsing* is shared and the fallback
 * is not. A quote with an unreadable timestamp falls back to fetch time,
 * because the price is real and the day is at worst hours late. A daily bar
 * cannot: its whole meaning is which day it is, so an unreadable one is dropped
 * rather than filed under today.
 */
function parseInstant(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  // Epoch *seconds*, which is what the raw endpoint sends.
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000);

  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return null;
}

/**
 * Yahoo's payload as a {@link ProviderQuote}, or a refusal.
 *
 * Exported for the tests, which need to assert the unit handling and the
 * currency guard without a network round trip.
 *
 * @throws {CurrencyRefused} when the quote is not in USD.
 */
export function toProviderQuote(raw: unknown, fetchedAt: Date): ProviderQuote | null {
  const parsed = yahooQuote.safeParse(raw);
  if (!parsed.success) return null;

  const quote = parsed.data;

  // A non-positive price is not a price: zero is what the endpoint returns
  // for a symbol it half-knows, and storing it would value the holding at
  // nothing (§6.2's "never zero into a sum"); the sign of a position lives in
  // its quantity, never its price (§2).
  const quoted =
    typeof quote.regularMarketPrice === "number" && quote.regularMarketPrice > 0
      ? quote.regularMarketPrice
      : undefined;

  // Bounded like the rate and the close columns, and for the identical
  // reason: `quote.price` is `numeric(20, 4)`, so an unbounded figure aborts
  // the refresh transaction for every instrument, not just this one.
  const price = inRange(decimal(quoted, 4), PRICE_CEILING);

  // No usable price is not an error — Yahoo drops delisted and unknown
  // symbols, and a ceiling-dropped figure is treated the same way. Either way
  // the caller's answer is: keep the last price, mark it stale.
  if (price === null) return null;

  // Checked only once there is a price to refuse.
  if (quote.currency !== undefined && quote.currency.toUpperCase() !== USD) {
    throw new CurrencyRefused(quote.symbol, quote.currency.toUpperCase());
  }

  // The equity/mutual-fund spelling first, then the ETF one — both amounts
  // per share in the quote's currency, so preferring either is a matter of
  // which the payload carries, not of units.
  const perShare = quote.dividendRate ?? quote.trailingAnnualDividendRate;

  // Bounded like the yield, same reason: written to `numeric(20, 4)` inside
  // the refresh transaction, and a not-a-rate figure would abort it for
  // everyone. What this does NOT bound is the product: quantity reaches
  // 10^12, so `quantity × rate` can still pass the view's cast — that product
  // is checked where the quantity is chosen (`fitsTheMoneyColumn`). Dropped,
  // not clamped: a null rate coalesces to $0 in the view (§14 limitation 9, a
  // labelled lower bound), where a clamped rate would read as real.
  const annualDividendPerShare = inRange(decimal(perShare, 4), RATE_CEILING);

  // The unambiguous field first; otherwise derived — rate over price divides
  // two numbers in the same currency, so the unit cannot be mistaken.
  const yieldPct =
    inRange(decimal(quote.dividendYield, 6), YIELD_CEILING) ??
    (perShare !== undefined && quoted !== undefined
      ? inRange(decimal((perShare / quoted) * 100, 6), YIELD_CEILING)
      : null);

  return {
    symbol: quote.symbol,
    price,
    quoteType: quote.quoteType ?? null,
    yieldPct,
    annualDividendPerShare,
    asOf: instantOf(quote.regularMarketTime, fetchedAt),
    fetchedAt,

    // The entry as it arrived, not the parsed narrowing: the archive's point
    // is everything this module does not read. Attached past every refusal,
    // so a payload is only stored for a quote that parsed — ADR-0006.
    payload: raw,
  };
}

/**
 * The subset of Yahoo's chart payload this application reads, validated for
 * *shape*: `quotes` is an array of things, `events.splits` is an array of
 * things, `meta` is an object. The leaves stay `unknown` on purpose — the two
 * narrowings that matter, {@link decimal} for a figure and {@link parseInstant}
 * for an instant, already refuse anything they cannot use, and each refusal has
 * a defined answer here (a bar is skipped, a split makes the whole response
 * `split-unresolved`). Typing the leaves in Zod would collapse all of those
 * into one whole-payload rejection.
 *
 * The library validates the response against its own schema first and throws
 * `FailedYahooValidationError` if it fails, so a real shape change arrives as a
 * throw and is ledgered with its text. This is the second line: what *we*
 * require, in a shape the library's own types are not a promise about.
 */
const yahooChart = z.object({
  // `.nullish()` is load-bearing: Zod 4 requires the *key* to be present even
  // where the value may be anything (Zod 3 treated `unknown` as implicitly
  // optional), and Yahoo omits fields per instrument type. `string` rather than
  // `unknown` so a currency we cannot read refuses the payload rather than
  // being taken for an absent one — the quote path's `z.string().optional()`
  // has exactly that effect, and this is the guard where guessing is worst.
  meta: z.object({ currency: z.string().nullish() }).nullish(),
  events: z.unknown().optional(),
  quotes: z.array(z.object({}).passthrough()),
});

/**
 * The events block, read separately from the payload around it. Its own parse
 * because the two failures mean different things: a chart we cannot read at all
 * has no closes to offer, while an *events* block we cannot read may be hiding
 * a split — and a close un-adjusted by a split nobody saw is the wrong figure
 * this module exists to prevent.
 */
const yahooEvents = z.object({
  splits: z.array(z.object({}).passthrough()).nullish(),
});

/** One split, reduced to what the arithmetic needs. */
type Split = { date: IsoDate; numerator: bigint; denominator: bigint };

/**
 * A split's side as an exact integer, or null. `BigInt` because the products
 * below are multiplied across every split in the range and must not round;
 * positive because a zero or negative side is not a ratio, and dividing by one
 * would be the silent wrong answer the refusal exists to avoid.
 */
function positiveInteger(value: unknown): bigint | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  return BigInt(value);
}

/**
 * One close as it stood on its own day, undoing every split that came after it.
 *
 * This is money arithmetic, so it happens on `money.ts`'s units and never as a
 * float (ARCHITECTURE.md §5.6): the scale-4 string becomes `BigInt` counts of
 * its last place, is multiplied by the cumulative numerator, divided by the
 * cumulative denominator half away from zero, and reassembled — one rounding,
 * at the end.
 *
 * A reverse split needs no case of its own: it is the same product with the
 * ratio the other way round.
 */
function unadjusted(close: string, date: IsoDate, splits: readonly Split[]): string {
  let numerator = 1n;
  let denominator = 1n;

  for (const split of splits) {
    // Strictly later: a bar on the split's own day already trades at the new
    // price, so it is the first row the split does not touch.
    if (split.date > date) {
      numerator *= split.numerator;
      denominator *= split.denominator;
    }
  }

  if (numerator === 1n && denominator === 1n) return close;

  return render(divide(toUnits(close, MONEY_SCALE) * numerator, denominator, 0), MONEY_SCALE);
}

/**
 * Yahoo's chart payload as a {@link ProviderHistory}: one close per trading day
 * the response carried, each filed under the day inside its own timestamp and
 * each un-adjusted for the splits after it.
 *
 * Exported for the tests, which need to assert the arithmetic and the date rule
 * against a hand-written payload — hand-written rather than captured, because
 * the point is the arithmetic and a captured payload would make the test depend
 * on what Yahoo said one afternoon.
 *
 * Never throws: every refusal is one of the closed statuses, so the caller's
 * ledger has something to record. A payload whose shape is not the one above
 * answers `no-history`, which is also what a response of nothing but nulls
 * answers — from the caller's side those are the same fact, that there are no
 * closes to write and the instrument is worth one more try tomorrow.
 */
export function toProviderHistory(
  raw: unknown,
  range: HistoryRange,
  marketTimeZone: string,
): ProviderHistory {
  const parsed = yahooChart.safeParse(raw);
  if (!parsed.success) return { status: "no-history" };

  const chart = parsed.data;

  // Before a figure is read, as the quote path checks it before refusing a
  // price. Absent is not a refusal: Yahoo omits it per instrument type, and the
  // quote path proceeds on the same reasoning.
  const currency = chart.meta?.currency;
  if (typeof currency === "string" && currency.toUpperCase() !== USD) {
    return { status: "non-usd", currency: currency.toUpperCase() };
  }

  // An events block that is present and unreadable is not "no splits": it may
  // carry one, and a close un-adjusted by a split nobody saw is the silent
  // wrong figure. `no-history` would also be a lie the ledger repeats — its
  // meaning there is an unknown or delisted ticker.
  const events =
    chart.events === undefined || chart.events === null
      ? { splits: null }
      : yahooEvents.safeParse(chart.events).data;

  if (events === undefined) return { status: "split-unresolved" };

  // All or nothing: some rows right and some wrong is the outcome worth
  // refusing, because every figure would look plausible.
  const splits: Split[] = [];
  for (const split of events.splits ?? []) {
    const instant = parseInstant(split.date);
    const numerator = positiveInteger(split.numerator);
    const denominator = positiveInteger(split.denominator);

    if (instant === null || numerator === null || denominator === null) {
      return { status: "split-unresolved" };
    }

    splits.push({ date: marketDateOf(instant, marketTimeZone), numerator, denominator });
  }

  // Keyed by trading day: the library notes Yahoo inserts extra bars at event
  // times, and two bars under one day are one day — the later instant wins,
  // being the nearer thing to a close.
  const byDate = new Map<IsoDate, { instant: Date; close: string }>();

  for (const bar of chart.quotes) {
    const instant = parseInstant(bar.date);
    if (instant === null) continue;

    const date = marketDateOf(instant, marketTimeZone);

    // `until` is exclusive, and the cut is here rather than on `period2` for
    // the reason the adapter gives for leaving `period2` absent: the request
    // deliberately fetches past the range, and this is the rule.
    if (date >= range.until) continue;

    // The mirror image at the other end. `writeBackfilledCloses` inserts
    // where absent, so a hostile or merely wrong bar dated 1971 would land as
    // a row — and the gap predicate `NO_CLOSE_BY_FIRST_HELD`
    // (`prices.server.ts:276-281`) is satisfied by any row at or before
    // first-held, so that one row would take the instrument out of the
    // candidate set for good while the ledger says `filled`: the real gap,
    // first-held back to the spine's true start, is never filled. ADR-0011
    // forbids overwriting a close and nothing in the app deletes
    // `price_daily`, so the recovery would be `psql`. An honest answer never
    // carries a bar before `period1`, which is `from`, so the cut costs
    // nothing.
    if (date < range.from) continue;

    // A non-positive close is not a close, for the reason `toProviderQuote`
    // refuses one: zero is what the endpoint returns for a symbol it half
    // knows, and storing it would value the holding at nothing.
    const quoted = typeof bar.close === "number" && bar.close > 0 ? bar.close : undefined;
    const close = inRange(decimal(quoted, MONEY_SCALE), CLOSE_CEILING);

    // `> 0` is not enough on its own: anything under half a ten-thousandth
    // renders as `"0.0000"` and passes the guard above as a string. On the
    // quote path that row is rewritten by the next tick; here the write is
    // insert-where-absent on a finished day, so a zero close would be
    // permanent and nothing in the application could correct it.
    if (close === null || toUnits(close, MONEY_SCALE) === 0n) continue;

    const held = byDate.get(date);
    if (held !== undefined && held.instant.getTime() > instant.getTime()) continue;

    byDate.set(date, { instant, close });
  }

  const closes: ProviderDailyClose[] = [...byDate.entries()]
    .map(([date, bar]) => ({ date, close: unadjusted(bar.close, date, splits) }))
    // The product can exceed what the column holds where the figure that
    // arrived did not — a penny stock through a century of reverse splits —
    // and an overflow inside the batch's transaction would cost every other
    // close in it.
    .filter((close): close is ProviderDailyClose => inRange(close.close, CLOSE_CEILING) !== null)
    // Ascending, so the insert reads in the order the days happened rather than
    // in whatever order the response listed them.
    .sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0));

  if (closes.length === 0) return { status: "no-history" };

  return { status: "ok", closes };
}

/**
 * The one `yahoo-finance2` instance this process uses. A fresh instance per
 * call redoes the library's cookie/crumb handshake — `probeSymbol`'s
 * per-symbol loop became a burst of handshakes, exactly what an unofficial
 * endpoint rate-limits — and reset its per-instance "shown once" notices, so
 * the survey banner logged on every tick. Memoized as a promise so two calls
 * racing before the import resolves still share one client.
 */
let client: Promise<YahooClient> | undefined;

/** The options one history call sends. Named so a fake can state what it saw. */
export type ChartRequest = {
  /** The range's start. A `YYYY-MM-DD` string; the library parses it to UTC midnight. */
  period1: IsoDate;
  interval: "1d";
  /**
   * `"split"` alone. The library's default is `"div|split|earn"`, and dividends
   * and earnings are neither read nor wanted on this path.
   */
  events: "split";
};

/** What this module uses the library for, and nothing else. */
type QuoteClient = { quote(symbols: string[]): Promise<unknown> };
type YahooClient = QuoteClient & {
  chart(symbol: string, options: ChartRequest): Promise<unknown>;
};

/**
 * The shared `yahoo-finance2` client. **The default export is a class, not a
 * client**: every method also exists on the class as a static that throws (a
 * v2-to-v4 upgrade guard), so calling `quote(...)` on the export type-checks
 * and fails at runtime on every tick, swallowed by the poller's catch — which
 * no fake-driven test would notice, hence `tests/price-provider.test.ts`
 * asserts the shape directly. Imported dynamically so the network-touching
 * dependency stays out of the module graph of anything importing only the
 * `PriceProvider` type. Typed as "an object with a callable `quote`" because
 * the library's own overloads do not resolve on an array query.
 */
export async function yahooClient(): Promise<YahooClient> {
  if (client === undefined) {
    client = import("yahoo-finance2").then(
      ({ default: YahooFinance }) => new YahooFinance() as unknown as YahooClient,
    );
  }
  return client;
}

/**
 * What one probe can say — a closed set, because the caller's three answers
 * are fixed by the spec: create, refuse naming the currency, or create anyway
 * and let the next refresh mark it stale.
 */
export type SymbolProbe =
  | {
      status: "ok";
      /**
       * What the provider calls the thing, carried out rather than discarded:
       * the moment a symbol is confirmed to quote is the one moment the app
       * has this fact and a row to put it on. Null when omitted — "the
       * provider did not say" is a real answer.
       */
      quoteType: string | null;
    }
  | { status: "non-usd"; currency: string }
  | { status: "unavailable" };

/**
 * The probe as the resolution step receives it — just the symbol, so a test
 * stub is one async arrow. The client parameter is this module's business.
 */
export type ProbeSymbol = (symbol: string) => Promise<SymbolProbe>;

/**
 * Does this symbol quote, and in a currency we can hold? The creation-time
 * half of the guard (§6.1 puts it at instrument resolution). `getQuotes`
 * cannot serve it: there a refusal becomes an absent quote, since a refresh
 * must not lose ninety-nine prices over one foreign listing — but here the
 * caller is a person creating one instrument, and "absent" would collapse the
 * distinction they can act on (a refused currency) into the one they cannot
 * (a provider's bad day). So non-USD comes back named; everything else —
 * unknown symbol, thrown client, malformed payload — is one answer,
 * `unavailable`, never a throw: a provider failure must not block creation,
 * because the next refresh marks the instrument stale anyway. The currency
 * rule lives in {@link toProviderQuote}; the probe only translates its
 * verdict. `client` is injectable: no test touches the network.
 */
export async function probeSymbol(
  symbol: string,
  // The quote half only, so a stub stays one async arrow returning one method.
  client: () => Promise<QuoteClient> = yahooClient,
): Promise<SymbolProbe> {
  try {
    const provider = await client();
    const fetchedAt = new Date();
    const raw = await provider.quote([symbol]);

    // Not-an-array equals empty: Yahoo drops unknown symbols entirely, so
    // absence is the ordinary spelling of "never heard of it".
    for (const entry of Array.isArray(raw) ? raw : []) {
      try {
        const quote = toProviderQuote(entry, fetchedAt);
        if (quote !== null) return { status: "ok", quoteType: quote.quoteType };
      } catch (error) {
        if (error instanceof CurrencyRefused) {
          return { status: "non-usd", currency: error.currency };
        }
        throw error;
      }
    }
  } catch {
    // Deliberately everything: whatever the provider did, the caller's
    // actionable answer is the same — create the instrument.
  }

  return { status: "unavailable" };
}

/**
 * The live provider. Constructed, not a singleton, so nothing imports
 * `yahoo-finance2` by reaching for a module-level value — the only caller
 * that asks is the refresh path. A non-USD quote is refused per symbol, not
 * per batch (one foreign listing must not cost ninety-nine prices), returned
 * as an absent quote and logged here where the currency is still known —
 * `ProviderQuote` has nowhere to carry it, on purpose (§6.1 stores no
 * currency column).
 */
export function yahooPriceProvider(client: typeof yahooClient = yahooClient): PriceProvider {
  return {
    async getQuotes(symbols: string[]): Promise<ProviderQuote[]> {
      if (symbols.length === 0) return [];

      const provider = await client();
      const fetchedAt = new Date();

      // `unknown[]` because `yahooClient` is typed loosely. Nothing is lost:
      // `yahooQuote` validates every field read — the correct posture towards
      // an unofficial client for an unpublished endpoint (§6.1).
      const raw = (await provider.quote(symbols)) as unknown[];

      const quotes: ProviderQuote[] = [];
      for (const entry of raw) {
        try {
          const quote = toProviderQuote(entry, fetchedAt);
          if (quote !== null) quotes.push(quote);
        } catch (error) {
          if (error instanceof CurrencyRefused) {
            console.warn(`Price refused: ${error.message}`);
            continue;
          }
          throw error;
        }
      }

      return quotes;
    },

    async getDailyCloses(
      symbol: string,
      range: HistoryRange,
      marketTimeZone: string,
    ): Promise<ProviderHistory> {
      try {
        const provider = await client();

        // One symbol per call. `matchKey` because that is the form the quote
        // path sends and the endpoint answers in; the stored symbol is
        // untouched, and nothing here matches one back — one call is one
        // instrument.
        //
        // **`period2` is absent on purpose, and must stay absent.** The
        // library defaults it to the instant of the call, which fetches more
        // than the range needs — and that surplus is what makes the un-adjust
        // complete. Yahoo restates closes through *every* split up to today, so
        // bounding the request at `range.until` would drop the splits between
        // `until` and now out of `events.splits` while leaving every close in
        // the range adjusted for them: silently wrong by the whole factor. The
        // range's real end is enforced on each bar's market date instead.
        const raw = await provider.chart(matchKey(symbol), {
          period1: range.from,
          interval: "1d",
          events: "split",
        });

        return toProviderHistory(raw, range, marketTimeZone);
      } catch (error) {
        if (isMissingHistory(error)) return { status: "no-history" };

        // Everything else propagates: the caller's ledger wants the text.
        throw error;
      }
    },
  };
}

/**
 * The two things Yahoo says when it has no history to give: an unknown or
 * delisted ticker ("No data found, symbol may be delisted") and a `period1`
 * before the listing ("Data doesn't exist for startDate = …").
 *
 * Matched on the message of *any* thrown error, never on its class — the class
 * is chosen from Yahoo's own error `code` with the spaces removed, and only
 * `"Bad Request"` resolves to one the library defines, so the `"Not Found"`
 * these answer arrives as a plain `Error` (module header). The library's own
 * documented example matches the same way (`chart.d.ts:112`).
 *
 * A stem that stops matching degrades gracefully rather than lying: the ledger
 * records `provider_failed` with the text, and the instrument is retried daily.
 */
function isMissingHistory(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return NO_HISTORY_STEMS.some((stem) => message.includes(stem));
}

/** Stems, not sentences: Yahoo's text carries the symbol and the dates. */
const NO_HISTORY_STEMS = ["No data found", "Data doesn't exist"];
