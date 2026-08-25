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
 * where it belongs. It is enforced here too because the failure it prevents is
 * the worst kind available: no error anywhere, GBP quietly summed into a USD
 * net worth.
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
 * The widest yield `quote.yield_pct` can hold — `numeric(10,6)`.
 *
 * Four integer digits, so 9999.999999%.
 */
const YIELD_CEILING = 10000;

/**
 * The widest rate `quote.annual_dividend_per_share` can hold —
 * `numeric(20, 4)`.
 *
 * Sixteen integer digits. No security pays anything near it, which is the
 * point: a figure this big is not a rate at all, and the ceiling exists so that
 * one such figure cannot abort a refresh rather than to express a view about
 * dividends.
 */
const RATE_CEILING = 10 ** 16;

/**
 * A figure the `numeric` column it is bound for can actually store, or null.
 *
 * A distressed or mispriced instrument — a $0.02 price still carrying a $2.50
 * rate — derives a 12500% yield, and Postgres answers a `numeric` overflow by
 * aborting the statement. That statement is inside the refresh transaction, so
 * one bad symbol would roll back every other instrument's price *and* the
 * stale-marking beside it: the whole household loses its refresh over one
 * listing. The same outcome the per-symbol currency guard exists to prevent.
 *
 * Dropped rather than clamped. A yield at the ceiling is a wrong number
 * presented as a real one, and §8.2's rule throughout this codebase is to
 * report what is not known as unknown rather than to substitute a plausible
 * figure.
 *
 * Two ceilings, one reading. The yield was the only figure that needed it while
 * the per-share rate beside it was merely stored and never read;
 * {@link RATE_CEILING} is here because that rate goes into a `numeric` column
 * inside the same transaction, and an unguarded one loses the refresh in
 * exactly the way described above.
 */
function inRange(value: string | null, ceiling: number): string | null {
  if (value === null) return null;
  return Math.abs(Number(value)) < ceiling ? value : null;
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
  /**
   * Annual dividend per share, in the quote's currency.
   *
   * Declared on equities and mutual funds. An ETF's payload carries no
   * `dividendRate` at all — the per-share figure arrives as
   * `trailingAnnualDividendRate` on the common base — so reading only this one
   * leaves `annual_dividend_per_share` null for every ETF a household holds,
   * which is most of a taxable brokerage account.
   */
  dividendRate: z.number().optional(),
  /**
   * Trailing twelve-month dividend per share. The ETF spelling of the field
   * above, and unambiguous in a way its `…Yield` sibling is not: this is an
   * amount of money, not a ratio, so there is no percent-versus-fraction
   * question to get wrong.
   */
  trailingAnnualDividendRate: z.number().optional(),
});

type YahooQuote = z.infer<typeof yahooQuote>;

/**
 * Yahoo's `regularMarketTime` as an instant.
 *
 * The library hands back a `Date`, but it has shipped epoch seconds in the
 * past and this is an unofficial client for an endpoint that can change under
 * us — so all three plausible shapes are accepted and anything unrecognised
 * falls back to the fetch time.
 *
 * Falling back is the lesser of the two available errors rather than a safe
 * one. "Now" is at worst a few hours late on a mutual fund NAV, which the next
 * poll corrects. It can also file a close against a non-trading day, if the
 * timestamp is missing on a day `isMarketOpen` wrongly called open — an
 * unlisted closure, or any date after the holiday table runs out. That is a
 * spurious row rather than a wrong price, and the alternative is discarding a
 * real price over a missing metadata field.
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

  // The equity/mutual-fund spelling first, then the ETF one. Both are amounts
  // per share in the quote's own currency, so preferring either is a matter of
  // which the payload carries rather than of units.
  const perShare = quote.dividendRate ?? quote.trailingAnnualDividendRate;

  // Bounded like the yield beside it, and for the identical reason: this is
  // written to `numeric(20, 4)` inside the refresh transaction, so a provider
  // sending a figure that is not a rate at all would abort that statement and
  // roll back every other instrument's price with it. The rate went unguarded
  // while nothing read it — an absurd one sat in the column doing no harm — and
  // migration 0006 ended that: `holding_valued` now multiplies it by a quantity
  // on every read.
  //
  // What this ceiling does not do is bound that product. It bounds the rate to
  // what the rate's own column holds, 10^16, while `quantity` is
  // `numeric(20, 8)` and reaches 10^12 — so a rate comfortably inside this can
  // still carry `quantity × rate` past the view's cast. That product is checked
  // where the quantity is chosen rather than here, by `fitsTheMoneyColumn` in
  // `positions.server.ts`, which `revisePosition` and `commitUpload` both call.
  //
  // Dropped rather than clamped, for the reason `inRange` gives. A null rate is
  // coalesced to $0 by the view — DESIGN.md §14's accepted limitation 9, a
  // lower bound the screens already label as one — where a clamped rate would
  // be a projected payout a household could read as real.
  const annualDividendPerShare = inRange(decimal(perShare, 4), RATE_CEILING);

  // The unambiguous field first; otherwise derive it. Deriving divides two
  // numbers that are both already in the quote's own currency, so the unit
  // cannot be mistaken — which is the entire point of not reading the field
  // that could be either.
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
  };
}

/**
 * An instantiated `yahoo-finance2` client.
 *
 * **The default export is a class, not a ready-made client.** Every module name
 * is also installed on the class as a static that throws
 * `Call \`const yahooFinance = new YahooFinance()\` first` — a v2-to-v4 upgrade
 * guard. Calling `yahooFinance.quote(...)` on the export therefore type-checks
 * as a function and fails at runtime on the first tick, forever, with the
 * failure swallowed by the poller's catch. Nothing in a fake-driven test suite
 * would ever notice, which is why `tests/price-provider.test.ts` asserts this
 * shape directly rather than trusting it.
 *
 * Imported dynamically rather than at module scope so that an unofficial,
 * network-touching dependency stays out of the module graph of anything that
 * merely imports the `PriceProvider` type.
 *
 * Typed as "an object with a callable `quote`" rather than through the
 * library's own overloads, which do not resolve on an array query. Exported for
 * the contract test.
 */
export async function yahooClient(): Promise<{ quote(symbols: string[]): Promise<unknown> }> {
  const { default: YahooFinance } = await import("yahoo-finance2");
  return new YahooFinance() as unknown as { quote(symbols: string[]): Promise<unknown> };
}

/**
 * What one probe of one symbol can say. A closed set, because the caller's
 * three answers are fixed by the spec: create, refuse naming the currency, or
 * create anyway and let the next refresh mark it stale.
 */
export type SymbolProbe =
  | {
      status: "ok";
      /**
       * What the provider calls the thing — `EQUITY`, `ETF`, `MUTUALFUND` —
       * carried out of the probe rather than discarded, because the moment a
       * symbol is confirmed to quote is the one moment the application has this
       * fact and an instrument row to put it on. Null when the payload omitted
       * it, which is honest: this column is the provider's vocabulary, and
       * "the provider did not say" is a real answer.
       */
      quoteType: string | null;
    }
  | { status: "non-usd"; currency: string }
  | { status: "unavailable" };

/**
 * The probe as the upload flow's resolution step receives it — just the
 * symbol, so a test stub is one async arrow and nothing else. `probeSymbol`
 * satisfies it; the client parameter is this module's private business.
 */
export type ProbeSymbol = (symbol: string) => Promise<SymbolProbe>;

/**
 * Does this symbol quote, and in a currency we can hold?
 *
 * The creation-time half of the guard `CurrencyRefused` anticipates above:
 * §6.1 puts this guard at instrument resolution, and that is still where it
 * belongs — this is that moment finally existing. `getQuotes` cannot serve it,
 * deliberately: there a refusal becomes an absent quote, because a refresh
 * must not lose ninety-nine prices over one foreign listing. Here the caller
 * is a person creating one instrument, and "absent" would collapse the one
 * distinction they can act on — a currency we refuse — into the one they
 * cannot — a provider having a bad day.
 *
 * So a non-USD quote comes back named, carrying the provider's currency for a
 * refusal in the refresh guard's own words, while everything else that can go
 * wrong — unknown symbol, thrown client, malformed payload — is one answer,
 * `unavailable`, and never a throw. The spec's reason: a provider failure must
 * not block creation, because the next refresh marks the instrument stale
 * exactly as it does today for any symbol that stops quoting.
 *
 * The currency rule itself lives in {@link toProviderQuote} and is not
 * restated here; the probe only translates its verdict.
 *
 * `client` is injectable for the same reason the interface exists: no test
 * touches the network.
 */
export async function probeSymbol(
  symbol: string,
  client: typeof yahooClient = yahooClient,
): Promise<SymbolProbe> {
  try {
    const provider = await client();
    const fetchedAt = new Date();
    const raw = await provider.quote([symbol]);

    // Not an array is the same answer as an empty one: Yahoo drops unknown
    // symbols from the response entirely, so absence is the ordinary spelling
    // of "never heard of it".
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
    // Deliberately everything. Whatever the provider did, the answer the
    // caller is allowed to act on is the same: create the instrument.
  }

  return { status: "unavailable" };
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

      const client = await yahooClient();
      const fetchedAt = new Date();

      // `unknown[]` because `yahooClient` is typed loosely — see there. Nothing
      // is lost: `yahooQuote` above validates every field this module reads,
      // and validating rather than trusting is the correct posture towards an
      // unofficial client for an unpublished endpoint (§6.1).
      const raw = (await client.quote(symbols)) as unknown[];

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
