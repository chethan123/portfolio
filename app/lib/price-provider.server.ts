/**
 * Where prices come from, and the one shape the rest of the app knows them in (DESIGN.md §6.1,
 * ADR-0011). Every schema, conversion and refusal a response can produce lives here, behind both
 * implementations: the worker's `yahoo-finance2` calls (`server/price-worker.ts`) and this
 * process's `socketProvider()`. The library is named below only in comments, documenting the
 * payload shape the worker is still expected to hand over. The interface is also the test seam.
 *
 * Everything numeric leaves here as a decimal string — the provider hands back floats (§4.1).
 *
 * Yahoo restates `close` through later splits (`adjclose`, split *and* dividend adjusted, is not
 * read), so {@link toProviderHistory} multiplies each close back by every later split's ratio
 * (ADR-0011). Never verified against a real split — the recipe is in `docs/developing.md`; NVDA
 * closes near $1,200 rather than $120 across 2024-06-10 would mean the arithmetic here is wrong,
 * and a split stamped at UTC midnight rather than the session open files it a day early.
 */
import { z } from "zod";

import { marketDateOf, type IsoDate } from "./market-hours.ts";
import { MONEY_SCALE, divide, render, toUnits } from "./money.ts";
import { matchKey } from "./prices.server.ts";

/**
 * One instrument's price. `price` is required and the rest are not: a missing yield writes null
 * (§8.2), a missing price means the symbol did not resolve and the caller marks it stale (§6.2).
 */
export type ProviderQuote = {
  /** As sent — the caller matches on it to find the instrument again. */
  symbol: string;
  /** Decimal string, scale 4. Never a number. */
  price: string;
  /** The provider's own vocabulary, stored unconstrained (§4.1). */
  quoteType: string | null;
  /** Annual dividend yield as a percentage. Decimal string, scale 6. */
  yieldPct: string | null;
  /** Annual dividend per share. Decimal string, scale 4. */
  annualDividendPerShare: string | null;
  /**
   * The instant the price was struck. Load-bearing: it decides which `price_daily` row this
   * becomes, and which `price_observation` row — one per instrument per instant (ADR-0006).
   */
  asOf: Date;
  /** When we learned the price, as against when it was struck. Archived, computed from by nothing. */
  fetchedAt: Date;
  /**
   * The raw entry, kept opaque — an archive, never an operand (ADR-0006). Present only when the
   * typed parse succeeded, so a shape change stays a refusal rather than a stored surprise.
   */
  payload?: unknown;
};

/** The span a history call asks for. `until` is exclusive. */
export type HistoryRange = { from: IsoDate; until: IsoDate };

/** One finished trading day, already un-adjusted for splits (scale 4); the writer multiplies nothing. */
export type ProviderDailyClose = { date: IsoDate; close: string };

/**
 * What one history call can say. The three refusals map one-to-one onto the ledger's outcome
 * vocabulary (`prices.server.ts`'s `BACKFILL_OUTCOMES`); a call that *fails* throws instead.
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
 * `getQuotes` takes every symbol at once — the batching is why Yahoo was chosen — while a range
 * belongs to one instrument and has no batch form. `getDailyCloses` is required, not optional: an
 * optional method would let the write path skip a batch with nothing saying so.
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
 * No answer to be had — not a rate limit, not a shape change, not an unknown symbol, each of which
 * the caller already has an answer for. `backfillCloses` treats it specially: the worker restarts
 * independently, and ledgering it per candidate would defer a batch's instruments a day each.
 */
export class ProviderUnreachable extends Error {
  override readonly name = "ProviderUnreachable";
}

/**
 * A quote in a currency we cannot hold. Duplicated from §6.1's guard at instrument resolution
 * because the failure it prevents is silent: GBP summed into a USD net worth with no error.
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
 * A provider float as a decimal string. `toFixed`, not a decimal library: the input came through
 * JSON, so there is no precision left to preserve — the job is to stop the float going further.
 */
function decimal(value: unknown, scale: number): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value.toFixed(scale);
}

/** The widest yield `quote.yield_pct` holds — `numeric(10,6)`, 9999.999999%. */
const YIELD_CEILING = 10000;

/** `quote.annual_dividend_per_share` is `numeric(20,4)`. A figure this big is not a rate. */
const RATE_CEILING = 10 ** 16;

/**
 * `price_daily.close` is `numeric(20,4)`. Bounds the un-adjusted *product* too, since that is what
 * reaches the column, and because `toFixed` goes exponential at 1e21 — which `money.ts` cannot read.
 */
const CLOSE_CEILING = 10 ** 16;

/**
 * `quote.price` is `numeric(20,4)`. Dropped, not clamped, so the symbol goes stale as it would
 * with no price at all.
 *
 * It cannot guard the reader's `quantity × price` product: `quantity` is `numeric(20,8)`, so a
 * legal price can still overflow it. `fitsTheMoneyColumn` (`app/lib/positions.server.ts`) guards
 * that where the quantity is written; spec 0018 §8 keeps the gap as a residual.
 */
const PRICE_CEILING = 10 ** 16;

/**
 * A figure the bound `numeric` column can store, or null. Postgres answers an overflow by aborting
 * the statement inside the refresh transaction — one bad symbol would cost the whole household its
 * refresh. Dropped, not clamped: a figure at the ceiling is a wrong number presented as real (§8.2).
 */
function inRange(value: string | null, ceiling: number): string | null {
  if (value === null) return null;
  return Math.abs(Number(value)) < ceiling ? value : null;
}

/**
 * The subset of Yahoo's payload this app reads. Zod rather than the library's types: this states
 * what *we* require, failing at the boundary. Everything but `symbol` is optional — Yahoo omits
 * fields per instrument type.
 */
const yahooQuote = z.object({
  symbol: z.string(),
  currency: z.string().optional(),
  quoteType: z.string().optional(),
  regularMarketPrice: z.number().optional(),
  regularMarketTime: z.union([z.date(), z.number(), z.string()]).optional(),
  /**
   * Percentage — 2.34 meaning 2.34%. NOT `trailingAnnualDividendYield`, the same quantity as a
   * fraction: taking that one is a silent hundredfold error with every figure looking plausible.
   */
  dividendYield: z.number().optional(),
  /** Equities and mutual funds only; an ETF's per-share figure arrives as the field below. */
  dividendRate: z.number().optional(),
  /** The ETF spelling, and unambiguous: an amount of money, no percent-versus-fraction question. */
  trailingAnnualDividendRate: z.number().optional(),
});

type YahooQuote = z.infer<typeof yahooQuote>;

/**
 * `regularMarketTime` as an instant, falling back to fetch time — the lesser error: "now" is at
 * worst hours late and the next poll corrects it, against discarding a real price over metadata.
 */
function instantOf(value: YahooQuote["regularMarketTime"], fetchedAt: Date): Date {
  return parseInstant(value) ?? fetchedAt;
}

/**
 * The three shapes a Yahoo timestamp has taken (`Date`, epoch seconds, string), or null. Separate
 * from {@link instantOf} so the parsing is shared and the fallback is not: a daily bar whose whole
 * meaning is its day is dropped when unreadable, never filed under today.
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
 * Yahoo's payload as a {@link ProviderQuote}, or null. Exported for the tests.
 *
 * @throws {CurrencyRefused} when the quote is not in USD.
 */
export function toProviderQuote(raw: unknown, fetchedAt: Date): ProviderQuote | null {
  const parsed = yahooQuote.safeParse(raw);
  if (!parsed.success) return null;

  const quote = parsed.data;

  // Zero is what the endpoint returns for a symbol it half-knows, and would value the holding at
  // nothing (§6.2); a position's sign lives in its quantity, never its price (§2).
  const quoted =
    typeof quote.regularMarketPrice === "number" && quote.regularMarketPrice > 0
      ? quote.regularMarketPrice
      : undefined;

  // No usable price is not an error — the caller keeps the last price and marks it stale.
  const quotedPrice = decimal(quoted, 4);
  if (quotedPrice === null) return null;

  // Before the ceiling below: a quote can be both foreign and absurd, and dropping it for its size
  // first loses the refusal — `probeVerdicts` reads an absent quote as `unavailable`, which creates
  // the instrument, where `non-usd` refuses it (spec 0018 §1).
  if (quote.currency !== undefined && quote.currency.toUpperCase() !== USD) {
    throw new CurrencyRefused(quote.symbol, quote.currency.toUpperCase());
  }

  // Bounded like the rate and close columns: an unbounded figure aborts the refresh transaction
  // for every instrument, not just this one. Dropped, not clamped.
  const price = inRange(quotedPrice, PRICE_CEILING);
  if (price === null) return null;

  // The equity/mutual-fund spelling first, then the ETF one; both are per share in the quote's
  // currency, so the choice is about which the payload carries, not about units.
  const perShare = quote.dividendRate ?? quote.trailingAnnualDividendRate;

  // Bounded like the yield. It does not bound `quantity × rate`, which is checked where the
  // quantity is chosen (`fitsTheMoneyColumn`). Dropped, not clamped: a null rate reads as $0, a
  // labelled lower bound (§14 limitation 9), where a clamped one would read as real.
  const annualDividendPerShare = inRange(decimal(perShare, 4), RATE_CEILING);

  // The unambiguous field first; else rate over price — two figures in one currency, so the unit
  // cannot be mistaken.
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

    // The entry as it arrived, past every refusal: a payload is stored only for a quote that
    // parsed (ADR-0006).
    payload: raw,
  };
}

/**
 * Yahoo's chart payload, validated for *shape* only. The leaves stay `unknown` on purpose:
 * {@link decimal} and {@link parseInstant} already refuse what they cannot use, and each refusal
 * has its own answer here (a bar skipped, a split making the whole response `split-unresolved`),
 * where typing the leaves would collapse all of them into one whole-payload rejection.
 */
const yahooChart = z.object({
  // `.nullish()` is load-bearing: Zod 4 requires the key to be present even where the value may be
  // anything, and Yahoo omits fields per instrument type. `string`, not `unknown`, so a currency we
  // cannot read refuses the payload rather than passing for an absent one.
  meta: z.object({ currency: z.string().nullish() }).nullish(),
  events: z.unknown().optional(),
  quotes: z.array(z.object({}).passthrough()),
});

/**
 * Its own parse: a chart we cannot read has no closes to offer, while an *events* block we cannot
 * read may be hiding a split — and a close un-adjusted by an unseen split is the wrong figure.
 */
const yahooEvents = z.object({
  splits: z.array(z.object({}).passthrough()).nullish(),
});

/** One split, reduced to what the arithmetic needs. */
type Split = { date: IsoDate; numerator: bigint; denominator: bigint };

/**
 * A split's side as an exact integer, or null. `BigInt` because the products are multiplied across
 * every split in the range and must not round; non-positive is not a ratio.
 */
function positiveInteger(value: unknown): bigint | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  return BigInt(value);
}

/**
 * One close as it stood on its own day, undoing every split after it. Money arithmetic, so on
 * `money.ts` units and never a float (ARCHITECTURE.md §5.6) — one rounding, at the end. A reverse
 * split needs no case of its own: same product, ratio the other way round.
 */
function unadjusted(close: string, date: IsoDate, splits: readonly Split[]): string {
  let numerator = 1n;
  let denominator = 1n;

  for (const split of splits) {
    // Strictly later: a bar on the split's own day already trades at the new price.
    if (split.date > date) {
      numerator *= split.numerator;
      denominator *= split.denominator;
    }
  }

  if (numerator === 1n && denominator === 1n) return close;

  return render(divide(toUnits(close, MONEY_SCALE) * numerator, denominator, 0), MONEY_SCALE);
}

/**
 * Yahoo's chart payload as a {@link ProviderHistory}: one close per trading day, filed under the
 * day inside its own timestamp and un-adjusted for the splits after it. Exported for the tests.
 *
 * Never throws — every refusal is one of the closed statuses, so the caller's ledger has something
 * to record. An unreadable shape answers `no-history`, as a response of nothing but nulls does.
 */
export function toProviderHistory(
  raw: unknown,
  range: HistoryRange,
  marketTimeZone: string,
): ProviderHistory {
  const parsed = yahooChart.safeParse(raw);
  if (!parsed.success) return { status: "no-history" };

  const chart = parsed.data;

  // Before any figure is read. Absent is not a refusal: Yahoo omits it per instrument type.
  const currency = chart.meta?.currency;
  if (typeof currency === "string" && currency.toUpperCase() !== USD) {
    return { status: "non-usd", currency: currency.toUpperCase() };
  }

  // A present but unreadable events block is not "no splits" — it may carry one. `no-history`
  // would be a lie the ledger repeats: there it means an unknown or delisted ticker.
  const events =
    chart.events === undefined || chart.events === null
      ? { splits: null }
      : yahooEvents.safeParse(chart.events).data;

  if (events === undefined) return { status: "split-unresolved" };

  // All or nothing: some rows right and some wrong is the outcome worth refusing, because every
  // figure would look plausible.
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

  // Keyed by trading day: Yahoo inserts extra bars at event times, and the later instant wins.
  const byDate = new Map<IsoDate, { instant: Date; close: string }>();

  for (const bar of chart.quotes) {
    const instant = parseInstant(bar.date);
    if (instant === null) continue;

    const date = marketDateOf(instant, marketTimeZone);

    // `until` is exclusive, and the cut is here rather than on `period2`: the request deliberately
    // fetches past the range.
    if (date >= range.until) continue;

    // The mirror image at the other end. A bar dated 1971 would insert a row that satisfies the
    // gap predicate `NO_CLOSE_BY_FIRST_HELD` (`prices.server.ts`), taking the instrument out of the
    // candidate set for good while the ledger says `filled` — and nothing deletes `price_daily`, so
    // the recovery is `psql`. An honest answer never carries a bar before `period1`.
    if (date < range.from) continue;

    // A non-positive close is not a close, for the reason `toProviderQuote` refuses one.
    const quoted = typeof bar.close === "number" && bar.close > 0 ? bar.close : undefined;
    const close = inRange(decimal(quoted, MONEY_SCALE), CLOSE_CEILING);

    // `> 0` is not enough: anything under half a ten-thousandth renders as "0.0000" and passes the
    // guard above as a string. Here the write is insert-where-absent on a finished day, so a zero
    // close would be permanent and nothing in the app could correct it.
    if (close === null || toUnits(close, MONEY_SCALE) === 0n) continue;

    const held = byDate.get(date);
    if (held !== undefined && held.instant.getTime() > instant.getTime()) continue;

    byDate.set(date, { instant, close });
  }

  const closes: ProviderDailyClose[] = [...byDate.entries()]
    .map(([date, bar]) => ({ date, close: unadjusted(bar.close, date, splits) }))
    // The product can exceed the column where the figure that arrived did not — a penny stock
    // through a century of reverse splits — and an overflow would cost every other close in the batch.
    .filter((close): close is ProviderDailyClose => inRange(close.close, CLOSE_CEILING) !== null)
    .sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0));

  if (closes.length === 0) return { status: "no-history" };

  return { status: "ok", closes };
}

/** What one probe can say — a closed set, because the caller's three answers are fixed by the spec. */
export type SymbolProbe =
  | {
      status: "ok";
      /** Null when omitted — "the provider did not say" is a real answer. */
      quoteType: string | null;
    }
  | { status: "non-usd"; currency: string }
  | { status: "unavailable" };

/** The probe as the resolution step receives it: every symbol at once, keyed by the symbol as asked. */
export type ProbeSymbols = (symbols: string[]) => Promise<Map<string, SymbolProbe>>;

/**
 * Do these symbols quote, and in a currency we can hold? Pure, so `socketProbe` can share it
 * without this module owning the transport. Built on the raw entries and not on `getQuotes`, which
 * collapses a refusal into an absence by design — the probe needs the refusal named.
 *
 * A quote lands on the asked symbol whose {@link matchKey} matches, `refreshQuotes`'s own rule,
 * never on whichever was asked first. A symbol no entry claims is `unavailable`: a provider failure
 * must not block creation, since the next refresh marks the instrument stale anyway.
 */
export function probeVerdicts(
  symbols: string[],
  raw: unknown,
  fetchedAt: Date,
): Map<string, SymbolProbe> {
  // Not-an-array equals empty: Yahoo drops unknown symbols entirely, so absence is the ordinary
  // spelling of "never heard of it".
  const answers: Array<{ key: string; verdict: SymbolProbe }> = [];

  for (const entry of Array.isArray(raw) ? raw : []) {
    try {
      const quote = toProviderQuote(entry, fetchedAt);
      if (quote === null) continue;

      answers.push({
        key: matchKey(quote.symbol),
        verdict: { status: "ok", quoteType: quote.quoteType },
      });
    } catch (error) {
      if (!(error instanceof CurrencyRefused)) throw error;

      answers.push({
        key: matchKey(error.symbol),
        verdict: { status: "non-usd", currency: error.currency },
      });
    }
  }

  // Driven from the asked list, not the answers, so two spellings of one ticker — `vti` and `VTI`
  // — both get the answer the feed gave.
  const verdicts = new Map<string, SymbolProbe>();
  for (const symbol of symbols) {
    const answer = answers.find(({ key }) => key === matchKey(symbol));
    verdicts.set(symbol, answer?.verdict ?? { status: "unavailable" });
  }

  return verdicts;
}

/**
 * The two things Yahoo says when it has no history: an unknown or delisted ticker, and a `period1`
 * before the listing. Matched on the message of any thrown error, never on its class — the class is
 * built from Yahoo's own `code` and only `"Bad Request"` resolves to one the library defines, so
 * `"Not Found"` arrives as a plain `Error`. A stem that stops matching degrades to `provider_failed`
 * with the text, retried daily. Exported for `provider-socket.server.ts`, which runs the identical
 * check against the text the worker passes through untouched.
 */
export function isMissingHistory(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return NO_HISTORY_STEMS.some((stem) => message.includes(stem));
}

/** Stems, not sentences: Yahoo's text carries the symbol and the dates. */
const NO_HISTORY_STEMS = ["No data found", "Data doesn't exist"];
