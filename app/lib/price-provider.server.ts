/**
 * Where prices come from, and the one shape the rest of the app knows them in.
 *
 * DESIGN.md §6.1 fixes the interface at a single batched method, and the
 * reasoning is worth restating because it constrains everything below:
 * `yahoo-finance2` is an unofficial client for an endpoint Yahoo never
 * published, with no SLA, and it can break. What makes that tolerable is that
 * swapping it for FMP is a day's work — which is only true while this interface
 * is the sole thing the write path imports. Nothing outside this module may
 * import `yahoo-finance2`.
 *
 * The interface is also the test seam. CI never reaches the network; the
 * refresh tests drive a fake that implements this and nothing else.
 *
 * **Everything numeric leaves here as a decimal string.** The provider hands
 * back JavaScript floats, and a float is exactly what §4.1 refuses to let near
 * a money column. The conversion happens once, here, at the boundary — not in
 * the write path, where it would be one more place to forget.
 */
import { z } from "zod";

/**
 * One instrument's price, as the application understands it.
 *
 * `price` is required and the rest are not, because a provider that cannot say
 * what a fund yields is ordinary and a provider that cannot say what it costs
 * is a failure. A missing yield writes null and the Income page reports its
 * coverage honestly (§8.2); a missing price means the symbol did not resolve at
 * all, and the caller keeps the last known price and marks it stale (§6.2).
 */
export type ProviderQuote = {
  /** As sent. The caller matches on this to find the instrument again. */
  symbol: string;
  /** Decimal string, scale 4. Never a number. */
  price: string;
  /**
   * The provider's own vocabulary — EQUITY | ETF | MUTUALFUND | … Stored on the
   * instrument unconstrained, because it is theirs and not ours (§4.1).
   */
  quoteType: string | null;
  /** Annual dividend yield as a percentage. Decimal string, scale 6. */
  yieldPct: string | null;
  /** Annual dividend per share. Decimal string, scale 4. */
  annualDividendPerShare: string | null;
  /**
   * The instant the provider struck this price — a genuine instant, so a `Date`
   * rather than a string (§4.1 leaves `timestamptz` alone).
   *
   * Load-bearing beyond the audit trail: it decides which `price_daily` row
   * this quote becomes. See `marketDateOf` in `market-hours.ts`.
   */
  asOf: Date;
};

/**
 * The provider contract, exactly as DESIGN.md §6.1 states it.
 *
 * One method taking every symbol at once, because the batching is the reason
 * Yahoo was chosen over Twelve Data and Alpha Vantage: one HTTP call for a
 * hundred symbols rather than a hundred calls or a per-symbol bill.
 */
export type PriceProvider = {
  getQuotes(symbols: string[]): Promise<ProviderQuote[]>;
};

/**
 * A quote the provider returned in a currency we cannot hold.
 *
 * DESIGN.md §6.1 puts this guard at instrument resolution, and that is still
 * where it belongs once the upload flow exists. It is *also* here because
 * resolution is not built yet, so a refresh is currently the only moment a
 * currency is ever observed — and the failure it prevents is the worst kind
 * available: no error anywhere, GBP quietly summed into a USD net worth.
 *
 * Carries the symbol and the currency so the log line names both.
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
 * A float from the provider, as a decimal string at a fixed scale.
 *
 * `toFixed` rather than a decimal library: the input is already a float that
 * has been through JSON, so there is no precision left to preserve — the job is
 * only to stop the float going any further. Rounding half-away-from-zero at
 * scale 4 on a quantity that arrived with at most a few decimal places is not a
 * decision anyone can observe.
 *
 * Returns null for anything that is not a usable finite number, so that a
 * provider sending `null`, `NaN` or a string never reaches a `numeric` column.
 */
function decimal(value: unknown, scale: number): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value.toFixed(scale);
}

/**
 * The subset of Yahoo's quote payload this application reads, validated.
 *
 * Zod rather than the library's own TypeScript types, deliberately. Those types
 * describe what the endpoint returned when they were written; this schema
 * describes what we require, and it fails loudly at the boundary rather than
 * producing `undefined` three layers in. It is also the documentation of
 * exactly how small our dependency on an unofficial API is — six fields.
 *
 * Everything except `symbol` is optional: Yahoo omits fields per instrument
 * type, and a mutual fund with no dividend simply has no dividend fields.
 */
const yahooQuote = z.object({
  symbol: z.string(),
  currency: z.string().optional(),
  quoteType: z.string().optional(),
  regularMarketPrice: z.number().optional(),
  regularMarketTime: z.union([z.date(), z.number(), z.string()]).optional(),
  /**
   * Annual dividend yield as a percentage — 2.34 meaning 2.34%.
   *
   * Note what is *not* read: `trailingAnnualDividendYield`, which carries the
   * same quantity as a fraction (0.0234) while the library's own doc comment
   * calls it a percentage too. Taking the wrong one is a silent hundredfold
   * error landing directly on the Income page's projected dividend, with every
   * figure looking plausible. Only the unambiguous field is read, and where it
   * is absent the yield is derived below from the rate and the price, which
   * cannot be misread in either unit.
   */
  dividendYield: z.number().optional(),
  /** Annual dividend per share, in the quote's currency. */
  dividendRate: z.number().optional(),
});

type YahooQuote = z.infer<typeof yahooQuote>;

/**
 * Yahoo's `regularMarketTime` as an instant.
 *
 * The library hands back a `Date`, but it has shipped epoch seconds in the
 * past and this is an unofficial client for an endpoint that can change under
 * us — so all three plausible shapes are accepted and anything unrecognised
 * falls back to the fetch time. Falling back is safe rather than lossy: the
 * quote is being written *now*, so "now" is at worst a few hours late on a
 * mutual fund NAV, and it never invents a date the market did not trade on.
 */
function instantOf(value: YahooQuote["regularMarketTime"], fetchedAt: Date): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  // Epoch *seconds*, which is what the raw endpoint sends.
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000);

  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return fetchedAt;
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

  // A non-positive price is not a price. Zero is what an unofficial endpoint
  // returns for a symbol it half-knows, and storing it would value the holding
  // at nothing — the exact understatement §6.2 refuses when it says never zero
  // into a sum. Negative is meaningless besides: the sign of a position lives
  // in its quantity, never in its price (§2).
  const quoted =
    typeof quote.regularMarketPrice === "number" && quote.regularMarketPrice > 0
      ? quote.regularMarketPrice
      : undefined;

  const price = decimal(quoted, 4);

  // No usable price is not an error — Yahoo drops delisted and unknown symbols,
  // and the caller's answer to a symbol that did not come back is the same as
  // its answer to one that came back empty: keep the last price, mark it stale.
  if (price === null) return null;

  // Checked only once there is a price to refuse. A currency on a quote with no
  // price would be a refusal with nothing to refuse.
  if (quote.currency !== undefined && quote.currency.toUpperCase() !== USD) {
    throw new CurrencyRefused(quote.symbol, quote.currency.toUpperCase());
  }

  const annualDividendPerShare = decimal(quote.dividendRate, 4);

  // The unambiguous field first; otherwise derive it. Deriving divides two
  // numbers that are both already in the quote's own currency, so the unit
  // cannot be mistaken — which is the entire point of not reading the field
  // that could be either.
  const yieldPct =
    decimal(quote.dividendYield, 6) ??
    (quote.dividendRate !== undefined && quoted !== undefined
      ? decimal((quote.dividendRate / quoted) * 100, 6)
      : null);

  return {
    symbol: quote.symbol,
    price,
    quoteType: quote.quoteType ?? null,
    yieldPct,
    annualDividendPerShare,
    asOf: instantOf(quote.regularMarketTime, fetchedAt),
  };
}

/**
 * The live provider.
 *
 * Constructed rather than exported as a singleton so that nothing imports
 * `yahoo-finance2` by reaching for a module-level value — a caller has to ask
 * for it, and the only caller that does is the refresh path.
 *
 * A non-USD quote is refused per symbol, not per batch: one foreign listing in
 * a household of a hundred holdings must not cost the other ninety-nine their
 * prices. The refusal is returned to the caller as an absent quote, which it
 * already knows how to treat, and logged here where the currency is still known
 * — `ProviderQuote` has nowhere to carry it, on purpose, since §6.1 stores no
 * currency column anywhere.
 */
export function yahooPriceProvider(): PriceProvider {
  return {
    async getQuotes(symbols: string[]): Promise<ProviderQuote[]> {
      if (symbols.length === 0) return [];

      // Imported here rather than at module scope: this keeps an unofficial,
      // network-touching dependency out of the module graph of anything that
      // merely imports the `PriceProvider` type.
      const { default: yahooFinance } = await import("yahoo-finance2");

      const fetchedAt = new Date();

      // Taken as `unknown[]` rather than through the library's own overloads,
      // which resolve ambiguously on an array query and collapse to `never`.
      // Nothing is lost: `yahooQuote` above validates every field this module
      // reads, and validating rather than trusting is the correct posture
      // towards an unofficial client for an unpublished endpoint (§6.1).
      const raw = (await yahooFinance.quote(symbols)) as unknown as unknown[];

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
  };
}
