/**
 * The only thing in the application that writes a price.
 *
 * DESIGN.md §6.2 splits price storage in two, and the split is the reason this
 * module is careful rather than short:
 *
 *   quote        one row per instrument, overwritten in place — the intraday tier
 *   price_daily  one row per instrument per trading day — the immutable spine
 *
 * A refresh writes both. What keeps the second one honest is which date it
 * writes under: **the date inside the quote's own timestamp, in the market's
 * zone — never today's date.** Two failures follow from getting that wrong, and
 * both are silent:
 *
 *   * A mutual fund strikes one NAV after the close (§6.2). An afternoon poll
 *     sees yesterday's NAV still standing; filed under today, it becomes a
 *     fabricated close for a day that has not finished, and tomorrow's poll
 *     files the real one a day late, permanently.
 *   * A poll on a market holiday sees Friday's quote. Filed under the holiday,
 *     it manufactures a row for a day the market did not trade — which §6.2
 *     forbids outright, because history queries carry the last close forward
 *     and a real row and an absent one mean different things.
 *
 * Keyed on the quote's own instant, both cases collapse into rewriting the row
 * that quote already owns. That is also why the market calendar is allowed to
 * be approximate: it decides whether to spend a request, never what to store.
 *
 * Today's row is provisional and converges on the close as the session runs.
 *
 * A past date's row *can* be rewritten, and deliberately so: an afternoon poll
 * returning yesterday's NAV, and a holiday poll returning Friday's, are exactly
 * the two cases above, and both rewrite a past row with the same price it
 * already holds. What §6.2's "an intraday refresh can never corrupt history"
 * amounts to here is narrower than "past rows are immutable": a row is only
 * ever rewritten with the provider's own price for the day that provider says
 * it belongs to, so a rewrite is idempotent unless the provider itself revises
 * a close — which is a correction, not corruption.
 */
import { sql } from "kysely";

import { getDb, type Database } from "./db.server.ts";
import { marketDateOf } from "./market-hours.ts";
import type { PriceProvider, ProviderQuote } from "./price-provider.server.ts";

import type { Kysely } from "kysely";

/** What a refresh did, for the log line and for the tests. */
export type RefreshReport = {
  /** Instruments that were eligible to be fetched. */
  requested: number;
  /** Instruments whose price was updated from a quote. */
  priced: number;
  /** Instruments that were asked for and did not come back. */
  stale: number;
  /** `price_daily` rows written or rewritten. */
  closes: number;
};

/** An instrument the provider can be asked about. */
type FeedInstrument = { id: string; symbol: string };

/**
 * Which instruments a refresh is allowed to fetch.
 *
 * `price_source = 'feed'` and a symbol that exists. The two exclusions are not
 * the same exclusion (§4.3):
 *
 *   * `fixed` is the seeded `USD` row, priced at 1.00 since 1970. Asking Yahoo
 *     what a dollar costs would overwrite the constant that cash and every
 *     liability are valued against.
 *   * `manual` is a collective investment trust in a workplace plan — no public
 *     ticker, no quote on any retail API. Its price is typed in by hand and
 *     carried forward, and a fetch would only ever fail.
 *
 * A null symbol is filtered separately from `manual` even though today every
 * manual instrument has one, because `symbol` is nullable for `feed` too: an
 * instrument can be created before anyone knows its ticker.
 */
const selectFeedInstruments = (db: Kysely<Database>) =>
  db
    .selectFrom("instrument")
    .select(["id", "symbol"])
    .where("price_source", "=", "feed")
    .where("symbol", "is not", null)
    .orderBy("symbol");

/**
 * Every instrument the provider will be asked about, by symbol.
 *
 * A map to a *list*, not to one instrument. `instrument.symbol` carries no
 * unique constraint (§4.1), so two rows can legitimately share a ticker — the
 * same fund held under two classifications, or a duplicate created before an
 * alias was repointed. One quote must update all of them, and a `Map<string,
 * Instrument>` would silently price whichever row happened to come last.
 */
function bySymbol(instruments: FeedInstrument[]): Map<string, FeedInstrument[]> {
  const map = new Map<string, FeedInstrument[]>();
  for (const instrument of instruments) {
    const key = matchKey(instrument.symbol);
    const existing = map.get(key);
    if (existing === undefined) map.set(key, [instrument]);
    else existing.push(instrument);
  }
  return map;
}

/**
 * The form a symbol is matched on.
 *
 * Upper-cased, because the provider answers in its own canonical case and an
 * instrument stored as `vti` would otherwise never match the `VTI` that comes
 * back — marking itself stale on every run, permanently, with nothing in the
 * log naming it. Matching is deliberately the *only* thing this normalises: the
 * stored symbol is left exactly as typed, since §4.3 makes it a mutable
 * attribute a person edits rather than a key the app owns.
 */
const matchKey = (symbol: string): string => symbol.trim().toUpperCase();

/**
 * Run `body` in a transaction, unless one is already open.
 *
 * Kysely refuses `.transaction()` on a handle that is already a transaction,
 * and the repository's test isolation *is* a transaction — `withDatabase` opens
 * one, hands it to the test, and rolls it back so nothing survives. Without
 * this, the write path would be untestable through the seam every other module
 * is tested through.
 *
 * Joining the caller's transaction rather than opening a second one is also the
 * right behaviour in production, where it means a future caller can wrap a
 * refresh in a larger unit of work and have it roll back with everything else.
 */
function inTransaction<T>(
  db: Kysely<Database>,
  body: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.isTransaction ? body(db) : db.transaction().execute(body);
}

/**
 * Fetch every feed instrument's price and store it.
 *
 * The whole write runs in one transaction. Not for atomicity against a reader —
 * `holding_valued` tolerates a half-priced portfolio by design — but so that a
 * crash midway cannot leave some instruments marked stale by a run that then
 * never got to unmark them.
 *
 * @param provider the price source. Injected rather than constructed, because
 *                 this is the seam DESIGN.md §6.1 exists for: tests pass a fake
 *                 and CI never reaches the network.
 * @param marketTimeZone `MARKET_TIMEZONE`. Decides which calendar day a quote's
 *                 instant belongs to, and nothing else.
 * @param db a handle to write through. Defaults to the process-wide one; tests
 *           pass a transaction they roll back.
 */
export async function refreshQuotes(
  provider: PriceProvider,
  marketTimeZone: string,
  db: Kysely<Database> = getDb(),
): Promise<RefreshReport> {
  const instruments = await selectFeedInstruments(db).execute();

  const feed: FeedInstrument[] = instruments.map((row) => ({
    id: String(row.id),
    // Narrowing only. The query already refuses null symbols; TypeScript cannot
    // see that through a `where`.
    symbol: row.symbol as string,
  }));

  if (feed.length === 0) return { requested: 0, priced: 0, stale: 0, closes: 0 };

  const lookup = bySymbol(feed);

  // A provider that throws — a network failure, a rate limit, the unofficial
  // endpoint changing shape — is the case §6.1 says to expect. Left to
  // propagate, the run would end here with every `is_stale` flag exactly as it
  // was, so the UI would keep presenting last week's prices as current: the
  // §11 failure this slice exists to prevent. An empty batch instead falls
  // through to the same path a symbol that did not come back takes, which marks
  // every selected instrument stale and writes no price.
  let quotes: ProviderQuote[];
  try {
    quotes = await provider.getQuotes([...lookup.keys()]);
  } catch (error) {
    console.error("Price provider failed; marking every selected instrument stale:", error);
    quotes = [];
  }

  return inTransaction(db, async (trx) => {
    const pricedIds = new Set<string>();
    let closes = 0;

    for (const quote of quotes) {
      const matches = lookup.get(matchKey(quote.symbol));

      // A quote for something we did not ask about. Not an error worth failing
      // the run for — a provider is entitled to normalise a symbol — but it has
      // no instrument to belong to, so there is nothing to write.
      if (matches === undefined) continue;

      for (const instrument of matches) {
        await writeQuote(trx, instrument.id, quote);
        await writeDailyClose(trx, instrument.id, quote, marketTimeZone);
        pricedIds.add(instrument.id);
        closes += 1;
      }
    }

    // Everything asked for that did not come back. §6.2: the last known price is
    // kept and used, and the row is flagged — never zeroed, never nulled into a
    // sum. An instrument that has never been priced has no row to flag, and
    // `holding_valued` already reports it as `is_priced = false`, so the absence
    // needs no special case here.
    const missing = feed.filter((instrument) => !pricedIds.has(instrument.id));
    if (missing.length > 0) {
      await trx
        .updateTable("quote")
        .set({ is_stale: true })
        .where(
          "instrument_id",
          "in",
          missing.map((instrument) => instrument.id),
        )
        .execute();
    }

    return {
      requested: feed.length,
      priced: pricedIds.size,
      stale: missing.length,
      closes,
    };
  });
}

/**
 * The intraday tier: one row per instrument, overwritten.
 *
 * `is_stale` is reset to false on every successful write, which is the only
 * thing that ever clears it. A price that was stale an hour ago and fetched
 * cleanly now is not stale, and leaving the flag set would train a reader to
 * ignore it.
 */
async function writeQuote(
  db: Kysely<Database>,
  instrumentId: string,
  quote: ProviderQuote,
): Promise<void> {
  await db
    .insertInto("quote")
    .values({
      instrument_id: instrumentId,
      price: quote.price,
      yield_pct: quote.yieldPct,
      annual_dividend_per_share: quote.annualDividendPerShare,
      as_of: quote.asOf,
      is_stale: false,
    })
    .onConflict((conflict) =>
      conflict.column("instrument_id").doUpdateSet({
        price: (builder) => builder.ref("excluded.price"),
        yield_pct: (builder) => builder.ref("excluded.yield_pct"),
        annual_dividend_per_share: (builder) =>
          builder.ref("excluded.annual_dividend_per_share"),
        as_of: (builder) => builder.ref("excluded.as_of"),
        is_stale: (builder) => builder.ref("excluded.is_stale"),
      }),
    )
    .execute();
}

/**
 * The immutable spine: one row per instrument per trading day.
 *
 * The date comes from the quote, not the clock — see the module comment for the
 * two silent failures that decision prevents.
 *
 * The upsert is what makes an intraday poll safe: during the session the row is
 * rewritten every fifteen minutes and settles on the day's last price, which is
 * the close. It is also what makes a holiday poll harmless, since the quote it
 * receives still carries the previous trading day and simply rewrites that day
 * with the value already there.
 */
async function writeDailyClose(
  db: Kysely<Database>,
  instrumentId: string,
  quote: ProviderQuote,
  marketTimeZone: string,
): Promise<void> {
  await db
    .insertInto("price_daily")
    .values({
      instrument_id: instrumentId,
      date: marketDateOf(quote.asOf, marketTimeZone),
      close: quote.price,
    })
    .onConflict((conflict) =>
      conflict
        .columns(["instrument_id", "date"])
        .doUpdateSet({ close: (builder) => builder.ref("excluded.close") }),
    )
    .execute();
}

/**
 * How fresh the stored prices are, for the "as of" line §11 calls
 * non-negotiable.
 *
 * Returns the *oldest* `as_of` among priced holdings rather than the newest,
 * and the stale count beside it. A newest-first reading is the dangerous one:
 * a portfolio where ninety-nine instruments updated a second ago and one has
 * been failing for a week would report itself current, which is exactly the
 * "silently showing yesterday's net worth as though it were live" failure §11
 * names as the worst available in a finance app.
 *
 * Scoped to instruments actually held in an open account, through
 * `holding_valued`. An instrument nobody owns going stale is not a fact about
 * anyone's net worth, and reporting it would make the banner unclearable.
 */
export async function priceFreshness(
  db: Kysely<Database> = getDb(),
): Promise<{ oldest: Date | null; stale: number; priced: number }> {
  const row = await db
    .selectFrom("holding_valued")
    .innerJoin("quote", "quote.instrument_id", "holding_valued.instrument_id")
    // `fixed` is the seeded `USD` row, whose `as_of` is written once by the
    // initial migration and never again. Every bank and loan account holds one,
    // so without this filter `oldest` is pinned to the install timestamp for the
    // life of the instance — an "as of" line that never moves, which is a worse
    // lie than no line at all. `manual` is excluded for the same reason from the
    // other direction: a hand-typed price is as fresh as the person who typed
    // it, and a refresh loop has no claim on it.
    .where("holding_valued.price_source", "=", "feed")
    .select([
      sql<Date | null>`min(quote.as_of)`.as("oldest"),
      // Distinct instruments, not holdings. One fund held in three accounts is
      // three rows of `holding_valued` and one thing that is stale, and the
      // count is going to be read as "3 of 40 prices are stale".
      sql<string>`count(distinct holding_valued.instrument_id) filter (where holding_valued.is_stale)`.as(
        "stale",
      ),
      sql<string>`count(distinct holding_valued.instrument_id)`.as("priced"),
    ])
    .executeTakeFirst();

  return {
    oldest: row?.oldest ?? null,
    // Cardinalities of held instruments, not money — `Number` is safe here in a
    // way it never is on a `numeric` column.
    stale: Number(row?.stale ?? 0),
    priced: Number(row?.priced ?? 0),
  };
}
