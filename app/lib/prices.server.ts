/**
 * The only thing in the application that writes a price.
 *
 * DESIGN.md §6.2 splits price storage in two, and the split is the reason this
 * module is careful rather than short:
 *
 *   quote        one row per instrument, overwritten in place — the intraday tier
 *   price_daily  one row per instrument per trading day — the immutable spine
 *
 * ADR-0006 added a third, and a sibling that is not a price tier at all:
 *
 *   price_observation  one row per instrument per provider instant — append-only
 *   price_poll         one row per refresh attempt, whether or not it wrote anything
 *
 * A refresh writes both tiers. What keeps the second one honest is which date it
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
 * The observation log and the poll record are written in that same transaction,
 * so no two of the four tables can ever disagree about one fetch — and, in the
 * other direction, so the 1D chart's last point and the headline above it agree
 * by construction rather than by luck.
 *
 * A past date's row *can* be rewritten, and deliberately so: an afternoon poll
 * returning yesterday's NAV, and a holiday poll returning Friday's, are exactly
 * the two cases above, and both rewrite a past row with the same price it
 * already holds. What §6.2's "an intraday refresh can never corrupt history"
 * amounts to here is narrower than "past rows are immutable": a row is only
 * ever rewritten with the provider's own price for the day that provider says
 * it belongs to, so a rewrite is idempotent unless the provider itself revises
 * a close — which is a correction, not corruption.
 *
 * Every exported query takes an optional `db` handle: it defaults to the
 * process-wide one, and tests pass a transaction they roll back.
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
 */
export async function refreshQuotes(
  provider: PriceProvider,
  marketTimeZone: string,
  db: Kysely<Database> = getDb(),
): Promise<RefreshReport> {
  // Read before anything else, because this is the figure the poll record is
  // for: the span from here to the commit is how long the attempt took, and an
  // attempt that dies before committing leaves no row at all.
  const startedAt = new Date();

  const instruments = await selectFeedInstruments(db).execute();

  const feed: FeedInstrument[] = instruments.map((row) => ({
    id: String(row.id),
    // Narrowing only. The query already refuses null symbols; TypeScript cannot
    // see that through a `where`.
    symbol: row.symbol as string,
  }));

  const lookup = bySymbol(feed);

  // An instance with nothing to price still made an attempt, and ADR-0006 wants
  // the attempt recorded: without it, a stretch of silence in the observation
  // log cannot be told apart from a stretch when nothing was running. So this
  // no longer returns early — it skips the provider (there is nothing to ask
  // about) and falls through to the transaction, which writes the poll row and
  // nothing else.
  //
  // A provider that throws — a network failure, a rate limit, the unofficial
  // endpoint changing shape — is the case §6.1 says to expect. Left to
  // propagate, the run would end here with every `is_stale` flag exactly as it
  // was, so the UI would keep presenting last week's prices as current: the
  // §11 failure this slice exists to prevent. An empty batch instead falls
  // through to the same path a symbol that did not come back takes, which marks
  // every selected instrument stale and writes no price — and, because the
  // absence of a price is the truth about that instant, no observation either.
  let quotes: ProviderQuote[] = [];
  if (feed.length > 0) {
    try {
      quotes = await provider.getQuotes([...lookup.keys()]);
    } catch (error) {
      console.error("Price provider failed; marking every selected instrument stale:", error);
      quotes = [];
    }
  }

  // Matched outside the transaction, because nothing here writes: a quote for a
  // symbol nobody asked about is not an error worth failing the run for — a
  // provider is entitled to normalise a symbol — but it has no instrument to
  // belong to, so there is nothing to do with it.
  const matched: Array<{ instrumentId: string; quote: ProviderQuote }> = [];
  for (const quote of quotes) {
    for (const instrument of lookup.get(matchKey(quote.symbol)) ?? []) {
      matched.push({ instrumentId: instrument.id, quote });
    }
  }

  return inTransaction(db, async (trx) => {
    // The log first, then the tiers derived from it. Order inside a transaction
    // changes nothing about what survives, but it is the order the facts are in:
    // the observation records what the provider said, and the quote and the
    // close are what we now believe because of it.
    await writeObservations(trx, observationsOf(matched, marketTimeZone));

    const pricedIds = new Set<string>();
    let closes = 0;

    for (const { instrumentId, quote } of matched) {
      await writeQuote(trx, instrumentId, quote);
      await writeQuoteType(trx, instrumentId, quote);
      await writeDailyClose(trx, instrumentId, quote, marketTimeZone);
      pricedIds.add(instrumentId);
      closes += 1;
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

    const report = {
      requested: feed.length,
      priced: pricedIds.size,
      stale: missing.length,
      closes,
    };

    await writePoll(trx, startedAt, report);

    return report;
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
 * What the provider calls the instrument, kept current on the instrument row.
 *
 * The column is written at creation (`instrument-resolution.server.ts`) and
 * refreshed here, which is what makes it true of instruments created before it
 * was written at all: every feed instrument passes through this loop on the
 * next poll. Without that, the Analysis screen's stocks-versus-funds split
 * (§4.4) would be right only for instruments added after the column started
 * being filled in, and every older holding would sit in the catch-all row
 * looking like a fault in the panel rather than an empty column.
 *
 * **Only ever set from something the provider actually said.** A quote that
 * omits the field leaves the stored value alone rather than nulling it: an
 * absent field is the provider being terse, not the instrument changing into
 * something unclassifiable. A changed value is written, because that is the
 * provider correcting itself — a fund reclassified, a ticker reused — and the
 * column is its vocabulary to define.
 *
 * `is distinct from` rather than `<>`: a stored null must count as a change, and
 * `<>` answers null to that comparison, which updates nothing.
 */
async function writeQuoteType(
  db: Kysely<Database>,
  instrumentId: string,
  quote: ProviderQuote,
): Promise<void> {
  if (quote.quoteType === null) return;

  await db
    .updateTable("instrument")
    .set({ quote_type: quote.quoteType })
    .where("id", "=", instrumentId)
    .where(sql<boolean>`quote_type is distinct from ${quote.quoteType}`)
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

/** One row bound for the observation log. */
type ObservationRow = {
  instrument_id: string;
  as_of: Date;
  market_date: string;
  price: string;
  fetched_at: Date;
  payload: string | null;
};

/**
 * The provider's raw entry as the text the `jsonb` column will parse, or null.
 *
 * Serialised rather than handed over as an object so that the value crossing the
 * driver is unambiguously the JSON document the column holds. TypeScript reads
 * the result as a JSON *string* — `Json` admits one — while Postgres parses it
 * into a document, and the two readings differ only in a type the write path
 * never reads back. ADR-0006 makes `price` the only column here anything may
 * compute from, so nothing depends on which reading is right.
 *
 * A payload that will not serialise is dropped, with a line in the log, rather
 * than thrown. It is an archive: failing an entire refresh — every instrument's
 * price, and the record that the refresh happened — to preserve an audit
 * artifact would invert the priority the artifact exists under. `null` is
 * treated as absent for the same reason a fake's missing payload is: a stored
 * `jsonb` null and a stored nothing would be two spellings of one fact.
 */
function archived(payload: unknown): string | null {
  if (payload === undefined || payload === null) return null;

  try {
    return JSON.stringify(payload) ?? null;
  } catch (error) {
    console.warn("Price payload could not be archived; storing the observation without it:", error);
    return null;
  }
}

/**
 * The batch of observations one refresh writes.
 *
 * Keyed by instrument and instant rather than appended, because two entries in
 * one provider response can name the same symbol — a provider is entitled to
 * echo an alias back — and the primary key would then see the same row twice
 * inside one statement. `on conflict do nothing` would absorb that; deduping
 * here means the batch says what it means before Postgres has to decide.
 */
function observationsOf(
  matched: ReadonlyArray<{ instrumentId: string; quote: ProviderQuote }>,
  marketTimeZone: string,
): ObservationRow[] {
  const batch = new Map<string, ObservationRow>();

  for (const { instrumentId, quote } of matched) {
    batch.set(`${instrumentId} at ${quote.asOf.toISOString()}`, {
      instrument_id: instrumentId,
      as_of: quote.asOf,
      // The same instant run through the same rule that files the close,
      // stamped now so that resolving a session later is an indexed date lookup
      // rather than a timezone computation, and so the instant-to-day rule keeps
      // living in exactly one place.
      market_date: marketDateOf(quote.asOf, marketTimeZone),
      price: quote.price,
      fetched_at: quote.fetchedAt,
      payload: archived(quote.payload),
    });
  }

  return [...batch.values()];
}

/**
 * The observation log: one insert for the whole refresh.
 *
 * `do nothing` rather than `do update` is the append-only rule in one clause. An
 * unchanged quote — the common case, since most instruments are re-fetched long
 * before they re-price — writes nothing at all, which is what keeps the log a
 * record of distinct instants rather than of polls. The poll table records the
 * polls.
 *
 * The first of the header's three divergences happens in this clause: a
 * provider re-stating an instant it has already given us with a different price
 * loses the second price here, while `quote` upserts to it.
 */
async function writeObservations(db: Kysely<Database>, rows: ObservationRow[]): Promise<void> {
  if (rows.length === 0) return;

  await db
    .insertInto("price_observation")
    .values(rows)
    .onConflict((conflict) => conflict.columns(["instrument_id", "as_of"]).doNothing())
    .execute();
}

/**
 * The attempt itself, recorded whether or not it wrote a price.
 *
 * This is what makes the log's silences readable. Dedup means an hour with no
 * observations can mean a quiet market, a provider that failed, or a server that
 * was not running, and only the last of those is a fact about the deployment.
 * With a poll row per attempt the three come apart.
 *
 * With one gap, stated rather than hidden: this row is written in the same
 * transaction as the prices it describes, so a refresh that ran and could not
 * commit leaves no row either. Writing it on a second connection would buy that
 * case and cost the property the rest of this module is built on — one fetch,
 * one unit of work — so the case is documented instead.
 *
 * The report's `closes` is deliberately not stored: it counts writes to another
 * tier rather than describing this attempt, and `priced` already says how many
 * instruments answered.
 */
async function writePoll(
  db: Kysely<Database>,
  startedAt: Date,
  report: RefreshReport,
): Promise<void> {
  await db
    .insertInto("price_poll")
    .values({
      started_at: startedAt,
      requested: report.requested,
      priced: report.priced,
      stale: report.stale,
    })
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
