/**
 * Provider interface + Yahoo parsers (DESIGN.md §6.1, ADR-0011). Numeric leaves as decimal string.
 * Yahoo restates `close` through later splits, so {@link toProviderHistory} multiplies each back by
 * every later split's ratio. Never verified against a real split (`docs/developing.md`) — NVDA
 * closes near $1,200 rather than $120 across 2024-06-10 means the arithmetic here is wrong.
 */
import { z } from "zod";

import { marketDateOf, type IsoDate } from "./market-hours.ts";
import { MONEY_SCALE, divide, render, toUnits } from "./money.ts";
import { matchKey } from "./prices.server.ts";

/** One instrument's price. Only `price` is required; missing means the symbol did not resolve (§6.2). */
export type ProviderQuote = {
  symbol: string;
  price: string;
  /** The provider's own vocabulary, stored unconstrained (§4.1). */
  quoteType: string | null;
  /** Annual dividend yield as a percentage. Decimal string, scale 6. */
  yieldPct: string | null;
  /** Annual dividend per share. Decimal string, scale 4. */
  annualDividendPerShare: string | null;
  /** Instant the price was struck — decides its `price_daily` and `price_observation` row (ADR-0006). */
  asOf: Date;
  /** When we learned the price, as against when it was struck. Archived, computed from by nothing. */
  fetchedAt: Date;
  /** Raw archive, never an operand (ADR-0006). Present only when the typed parse succeeded. */
  payload?: unknown;
};

export type HistoryRange = { from: IsoDate; until: IsoDate };

/** One finished trading day, already un-adjusted for splits (scale 4); the writer multiplies nothing. */
export type ProviderDailyClose = { date: IsoDate; close: string };

/** Refusals map one-to-one onto `BACKFILL_OUTCOMES`; a call that *fails* throws instead. */
export type ProviderHistory =
  | {
      status: "ok";
      /** At least one. A response with none is `no-history`, not an empty `ok`. */
      closes: ProviderDailyClose[];
    }
  | { status: "no-history" }
  | { status: "non-usd"; currency: string }
  | { status: "split-unresolved" };

/** `getQuotes` batches — why Yahoo was chosen. History has no batch form: one symbol per call. */
export type PriceProvider = {
  getQuotes(symbols: string[]): Promise<ProviderQuote[]>;
  getDailyCloses(
    symbol: string,
    range: HistoryRange,
    marketTimeZone: string,
  ): Promise<ProviderHistory>;
};

/** No answer to be had. `backfillCloses` skips the ledger: ledgering would defer a batch a day each. */
export class ProviderUnreachable extends Error {
  override readonly name = "ProviderUnreachable";
}

/** Duplicates §6.1's resolution guard: the failure is silent — GBP summed into a USD net worth. */
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

/** `toFixed`, not a decimal library: JSON already lost the precision. Job is to stop the float here. */
function decimal(value: unknown, scale: number): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value.toFixed(scale);
}

/** `quote.yield_pct` is `numeric(10,6)` — 9999.999999%. */
const YIELD_CEILING = 10000;

/** `quote.annual_dividend_per_share` is `numeric(20,4)`. A figure this big is not a rate. */
const RATE_CEILING = 10 ** 16;

/** `price_daily.close` is `numeric(20,4)`. Bounds the product too; `toFixed` goes exponential at 1e21. */
const CLOSE_CEILING = 10 ** 16;

/** `quote.price` is `numeric(20,4)`. The `quantity × price` product is guarded in `positions.server.ts`. */
const PRICE_CEILING = 10 ** 16;

/** Overflow aborts the refresh transaction — one bad symbol would cost the household its refresh. */
function inRange(value: string | null, ceiling: number): string | null {
  if (value === null) return null;
  return Math.abs(Number(value)) < ceiling ? value : null;
}

/** What *we* require, not the library's types. All but `symbol` optional: Yahoo omits fields per type. */
const yahooQuote = z.object({
  symbol: z.string(),
  currency: z.string().optional(),
  quoteType: z.string().optional(),
  regularMarketPrice: z.number().optional(),
  regularMarketTime: z.union([z.date(), z.number(), z.string()]).optional(),
  /** Percentage, 2.34 = 2.34%. NOT `trailingAnnualDividendYield`, a fraction — silent 100x error. */
  dividendYield: z.number().optional(),
  /** Equities and mutual funds only; an ETF's per-share figure arrives as the field below. */
  dividendRate: z.number().optional(),
  /** The ETF spelling, and unambiguous: an amount of money, no percent-versus-fraction question. */
  trailingAnnualDividendRate: z.number().optional(),
});

type YahooQuote = z.infer<typeof yahooQuote>;

/** Falls back to fetch time: hours late and corrected next poll beats discarding a real price. */
function instantOf(value: YahooQuote["regularMarketTime"], fetchedAt: Date): Date {
  return parseInstant(value) ?? fetchedAt;
}

/** The three shapes a Yahoo timestamp takes, or null. No fallback: a daily bar is never filed under today. */
function parseInstant(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000);

  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return null;
}

/** Yahoo's payload as a {@link ProviderQuote}, or null. @throws {CurrencyRefused} when not in USD. */
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

  const quotedPrice = decimal(quoted, 4);
  if (quotedPrice === null) return null;

  // Before the ceiling below: a quote can be both foreign and absurd, and dropping it for its size
  // first loses the refusal `probeVerdicts` needs — an absent quote creates the instrument (spec 0018 §1).
  if (quote.currency !== undefined && quote.currency.toUpperCase() !== USD) {
    throw new CurrencyRefused(quote.symbol, quote.currency.toUpperCase());
  }

  const price = inRange(quotedPrice, PRICE_CEILING);
  if (price === null) return null;

  const perShare = quote.dividendRate ?? quote.trailingAnnualDividendRate;

  // Bounded like the yield; `quantity × rate` is checked where the quantity is chosen. A null rate
  // reads as $0, a labelled lower bound (§14 limitation 9), where a clamped one would read as real.
  const annualDividendPerShare = inRange(decimal(perShare, 4), RATE_CEILING);

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
    payload: raw,
  };
}

/** Shape only. Leaves stay `unknown` so each refusal keeps its own answer, not one whole-payload one. */
const yahooChart = z.object({
  // `.nullish()` is load-bearing: Zod 4 requires the key to be present even where the value may be
  // anything, and Yahoo omits fields per instrument type. `string`, not `unknown`, so a currency we
  // cannot read refuses the payload rather than passing for an absent one.
  meta: z.object({ currency: z.string().nullish() }).nullish(),
  events: z.unknown().optional(),
  quotes: z.array(z.object({}).passthrough()),
});

/** Own parse: an unreadable events block may hide a split, and an unadjusted close is the wrong figure. */
const yahooEvents = z.object({
  splits: z.array(z.object({}).passthrough()).nullish(),
});

type Split = { date: IsoDate; numerator: bigint; denominator: bigint };

/** `BigInt`: the products multiply across every split in the range and must not round. */
function positiveInteger(value: unknown): bigint | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  return BigInt(value);
}

/** One close as it stood on its own day. `money.ts` units, one rounding at the end (ARCHITECTURE.md §5.6). */
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

/** One close per trading day, un-adjusted. Never throws: every refusal is a status the ledger records. */
export function toProviderHistory(
  raw: unknown,
  range: HistoryRange,
  marketTimeZone: string,
): ProviderHistory {
  const parsed = yahooChart.safeParse(raw);
  if (!parsed.success) return { status: "no-history" };

  const chart = parsed.data;

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

  const byDate = new Map<IsoDate, { instant: Date; close: string }>();

  for (const bar of chart.quotes) {
    const instant = parseInstant(bar.date);
    if (instant === null) continue;

    const date = marketDateOf(instant, marketTimeZone);

    // `until` is exclusive, and the cut is here rather than on `period2`: the request deliberately
    // fetches past the range.
    if (date >= range.until) continue;

    // The mirror image at the other end. A bar dated 1971 would insert a row satisfying the gap
    // predicate `NO_CLOSE_BY_FIRST_HELD` (`prices.server.ts`), dropping the instrument from the
    // candidate set for good while the ledger says `filled`, with `psql` the only recovery.
    if (date < range.from) continue;

    const quoted = typeof bar.close === "number" && bar.close > 0 ? bar.close : undefined;
    const close = inRange(decimal(quoted, MONEY_SCALE), CLOSE_CEILING);

    // `> 0` is not enough: under half a ten-thousandth renders as "0.0000" and passes as a string.
    // The write is insert-where-absent on a finished day, so a zero close would be permanent.
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
      quoteType: string | null;
    }
  | { status: "non-usd"; currency: string }
  | { status: "unavailable" };

export type ProbeSymbols = (symbols: string[]) => Promise<Map<string, SymbolProbe>>;

/** On raw entries, not `getQuotes`, which collapses a refusal into an absence — the probe needs it named. */
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

/** Matched on message, never class: only `"Bad Request"` resolves to a class the library defines. */
export function isMissingHistory(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return NO_HISTORY_STEMS.some((stem) => message.includes(stem));
}

/** Stems, not sentences: Yahoo's text carries the symbol and the dates. */
const NO_HISTORY_STEMS = ["No data found", "Data doesn't exist"];
