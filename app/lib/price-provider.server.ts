/**
 * Where prices come from, and the one shape the rest of the app knows them
 * in. DESIGN.md §6.1 fixes the interface at a single batched method:
 * `yahoo-finance2` is an unofficial client for an unpublished endpoint and
 * can break; what makes that tolerable is that swapping it is a day's work —
 * true only while nothing outside this module imports `yahoo-finance2`. The
 * interface is also the test seam: CI never reaches the network.
 *
 * **Everything numeric leaves here as a decimal string.** The provider hands
 * back floats — exactly what §4.1 refuses near a money column — and the
 * conversion happens once, here, at the boundary.
 */
import { z } from "zod";

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

/**
 * The provider contract, exactly as DESIGN.md §6.1 states it: one method
 * taking every symbol at once — the batching is why Yahoo was chosen: one
 * HTTP call for a hundred symbols, not a hundred calls or a per-symbol bill.
 */
export type PriceProvider = {
  getQuotes(symbols: string[]): Promise<ProviderQuote[]>;
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

  // A non-positive price is not a price: zero is what the endpoint returns
  // for a symbol it half-knows, and storing it would value the holding at
  // nothing (§6.2's "never zero into a sum"); the sign of a position lives in
  // its quantity, never its price (§2).
  const quoted =
    typeof quote.regularMarketPrice === "number" && quote.regularMarketPrice > 0
      ? quote.regularMarketPrice
      : undefined;

  const price = decimal(quoted, 4);

  // No usable price is not an error — Yahoo drops delisted and unknown
  // symbols, and the caller's answer either way is: keep the last price, mark
  // it stale.
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
 * The one `yahoo-finance2` instance this process uses. A fresh instance per
 * call redoes the library's cookie/crumb handshake — `probeSymbol`'s
 * per-symbol loop became a burst of handshakes, exactly what an unofficial
 * endpoint rate-limits — and reset its per-instance "shown once" notices, so
 * the survey banner logged on every tick. Memoized as a promise so two calls
 * racing before the import resolves still share one client.
 */
let client: Promise<{ quote(symbols: string[]): Promise<unknown> }> | undefined;

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
export async function yahooClient(): Promise<{ quote(symbols: string[]): Promise<unknown> }> {
  if (client === undefined) {
    client = import("yahoo-finance2").then(
      ({ default: YahooFinance }) =>
        new YahooFinance() as unknown as { quote(symbols: string[]): Promise<unknown> },
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
  client: typeof yahooClient = yahooClient,
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
export function yahooPriceProvider(): PriceProvider {
  return {
    async getQuotes(symbols: string[]): Promise<ProviderQuote[]> {
      if (symbols.length === 0) return [];

      const client = await yahooClient();
      const fetchedAt = new Date();

      // `unknown[]` because `yahooClient` is typed loosely. Nothing is lost:
      // `yahooQuote` validates every field read — the correct posture towards
      // an unofficial client for an unpublished endpoint (§6.1).
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
