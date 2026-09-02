/**
 * The only thing in the application that writes a price. DESIGN.md §6.2
 * splits storage in two; ADR-0006 added a third tier and a sibling that is
 * not a price tier at all:
 *
 *   quote              one row per instrument, overwritten — the intraday tier
 *   price_daily        one row per instrument per trading day — the immutable spine
 *   price_observation  one row per instrument per provider instant — append-only
 *   price_poll         one row per refresh attempt, whether or not it wrote
 *
 * What keeps `price_daily` honest is which date it writes under: **the date
 * inside the quote's own timestamp, in the market's zone — never today's.**
 * Two silent failures follow from getting that wrong: an afternoon poll sees
 * a mutual fund's yesterday NAV still standing — filed under today it is a
 * fabricated close for an unfinished day, and the real one lands a day late,
 * permanently; a holiday poll sees Friday's quote — filed under the holiday
 * it manufactures a row for a day the market did not trade, which §6.2
 * forbids since carry-forward reads a real row and an absent one differently.
 * Keyed on the quote's own instant, both collapse into rewriting the row that
 * quote already owns — also why the market calendar may be approximate: it
 * decides whether to spend a request, never what to store. Today's row is
 * provisional and converges on the close as the session runs.
 *
 * The log and the poll record share the same transaction, so a committed
 * fetch lands in all four tables or none — what makes the 1D chart's last
 * point and the headline agree on the normal path. Three divergences remain,
 * narrow and deliberate, named so nobody looks for a fourth: a provider
 * re-stating an instant at a different price (`quote` upserts; the deduped
 * observation keeps the first — ADR-0006 accepts it); a hand-typed manual
 * price, once the form exists (a quote with no observation, so the headline
 * moves and the 1D line does not); a provider returning one symbol twice
 * (both become observations; `quote` keeps whichever came last). A refresh
 * whose writes fail commits nothing, poll row included — an attempt that dies
 * leaves no trace of having been made.
 *
 * A past date's row *can* be rewritten, deliberately — only ever with the
 * provider's own price for the day the provider says it belongs to, so a
 * rewrite is idempotent unless the provider itself revises a close: a
 * correction, not corruption.
 *
 * Every exported query takes an optional `db`; tests pass a transaction they
 * roll back.
 */
import { sql } from "kysely";

import { getDb, getPool, type Database } from "./db.server.ts";
import { marketDateOf, marketStampOf, type IsoDate } from "./market-hours.ts";
import type { PriceProvider, ProviderQuote } from "./price-provider.server.ts";

import type { Kysely } from "kysely";
import type pg from "pg";

/**
 * The lock a refresh contends for. Arbitrary, must not change — and must not
 * equal the migration runner's `7295380114023641`, or a cold start would have
 * a poll and a migration blocking each other for no reason.
 */
const ADVISORY_LOCK_KEY = "7295380114023642";

/**
 * How many instruments one refresh may attempt to backfill. Small on purpose:
 * the batch is the whole of the pacing — nothing queues against the unofficial
 * endpoint, and a batch that cannot finish before the next tick is simply
 * resumed by it, because the candidate read is re-asked every time and answers
 * with whatever is still open (ADR-0011). A household loading a decade of
 * statements is filled over a handful of refreshes.
 *
 * A module constant rather than a setting: the household has no reason to turn
 * it, and a wrong value is a request-rate problem rather than a preference.
 */
const BACKFILL_BATCH_SIZE = 5;

/**
 * How recently an attempt must have been made for an instrument to be skipped.
 * An unfillable gap — a delisted ticker whose history the feed has dropped —
 * then costs one request a day rather than one every tick, which is the price
 * of not asking a person to mark it.
 *
 * A string handed to the query as a parameter and cast there, never spliced
 * into the statement's text.
 */
const BACKFILL_RETRY_INTERVAL = "1 day";

/**
 * How far before an instrument's earliest position set the range starts. A
 * statement dated on a weekend or a market holiday has no close of its own, so
 * the range has to reach back past it far enough to find one to carry forward;
 * a week clears the longest run of non-trading days a US market has.
 */
const BACKFILL_RANGE_LEAD_DAYS = 7;

/**
 * Run a refresh, or decline because one is already running. Beside the
 * refresh rather than in the poller because the poller stopped being the only
 * caller when a person could press a button — two browser tabs is the
 * contention that actually happens. Guards the *decision* to spend a request,
 * never the rows (convergent upserts either way).
 *
 * `null` for a refusal, not a throw: another caller is doing the work and the
 * prices will be fresh either way. A dedicated connection, because an
 * advisory lock belongs to the session that took it; the work itself goes
 * through Kysely on a different connection.
 */
export async function withRefreshLock<T>(body: () => Promise<T>): Promise<T | null> {
  // Declared before the `try`, acquired inside it: a briefly unreachable
  // database is ordinary, and a throw from `connect` above the `finally`
  // would leak the client.
  let client: pg.PoolClient | undefined;
  let broken = false;

  try {
    client = await getPool().connect();

    const held = await client.query<{ locked: boolean }>(
      `select pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) as locked`,
    );

    if (!held.rows[0]?.locked) return null;

    try {
      return await body();
    } finally {
      await client.query(`select pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
    }
  } catch (error) {
    // A session-level lock outlives the failed query but not the session, and
    // a pooled connection keeps its session — returned still holding the
    // lock, it would block every future refresh forever. Destroyed, not reused.
    broken = true;
    throw error;
  } finally {
    client?.release(broken);
  }
}

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
  /**
   * Observations the log did not already hold — the only field separating a
   * refresh that learned something from one that re-fetched what it had. On a
   * Saturday evening every other count reads the same as mid-session; this
   * one says nought, the truth the person pressing the button asked for.
   */
  observed: number;
  /**
   * Did the provider call itself fail? A failed call is swallowed (see the
   * catch), so the aggregates look exactly like a provider that answered and
   * knew nothing. The two want different sentences — feed down versus wrong
   * symbols — and this is the only thing that can tell them apart.
   */
  providerFailed: boolean;
};

/** An instrument the provider can be asked about. */
type FeedInstrument = { id: string; symbol: string };

/**
 * Which instruments a refresh may fetch: `price_source = 'feed'` with a
 * symbol. The two exclusions are not the same exclusion (§4.3): `fixed` is
 * the seeded `USD` row — asking Yahoo what a dollar costs would overwrite the
 * constant cash and every liability are valued against; `manual` is a
 * workplace-plan trust with no public ticker — a fetch would only ever fail.
 * A null symbol is filtered separately because `symbol` is nullable for
 * `feed` too: an instrument can be created before anyone knows its ticker.
 */
const selectFeedInstruments = (db: Kysely<Database>) =>
  db
    .selectFrom("instrument")
    .select(["id", "symbol"])
    .where("price_source", "=", "feed")
    .where("symbol", "is not", null)
    .orderBy("symbol");

/**
 * What one backfill attempt can have come to. A `const` object rather than an
 * enum — `tsconfig` sets `erasableSyntaxOnly`, and `server/*.ts` runs under
 * Node's type stripping. Kept in step with `price_backfill_outcome_valid` in
 * `0010_price_backfill.sql` by hand, the arrangement `account-options.ts` has
 * with the schema's other vocabularies: the migration is the authority and this
 * is the spelling the code uses.
 *
 * Deliberately a second vocabulary rather than the provider's: the adapter
 * answers in the closed set `SymbolProbe` uses, and these are a `check`
 * constraint's literals. The mapping between them is one object in the batch.
 */
export const BACKFILL_OUTCOMES = {
  /** Closes were written. The only outcome with `written > 0`. */
  filled: "filled",
  /** The feed answered and the spine already held every day it returned. */
  nothingToWrite: "nothing_to_write",
  /** The feed has no history for the symbol — unknown, delisted or renamed. */
  noHistory: "no_history",
  /** The history is quoted in a currency this instance cannot hold. */
  nonUsd: "non_usd",
  /** A split event in the response could not be applied; nothing written. */
  splitUnresolved: "split_unresolved",
  /** The call itself failed; the ledger's `error` carries the text. */
  providerFailed: "provider_failed",
} as const;

export type BackfillOutcome = (typeof BACKFILL_OUTCOMES)[keyof typeof BACKFILL_OUTCOMES];

/** One instrument a batch should try, and where its range starts. */
export type BackfillCandidate = {
  id: string;
  /** As stored. The adapter upper-cases it to send; nothing here rewrites it. */
  symbol: string;
  /** `YYYY-MM-DD`, computed in SQL — no date arithmetic happens in JavaScript. */
  rangeFrom: IsoDate;
};

/**
 * Which instruments a batch should try next: the coverage gap of
 * `docs/importing-history.md` §5 made a domain read, narrowed to what a feed
 * can fill, and bounded.
 *
 * **The gap is a property of the positions, not of the instrument.** An
 * instrument is a candidate when its spine starts later than the earliest
 * `position_set.as_of_date` of any holding referencing it, or has no row at
 * all — not because it is new (instruments are created at resolution, before
 * any position set exists) and not because a person asked (history already
 * uploaded is already a gap).
 *
 * `fixed` and `manual` are excluded for the reasons {@link selectFeedInstruments}
 * gives, and a null symbol separately because `feed` allows one. Those three
 * have gaps just as real; Settings → Prices is where a person learns the batch
 * will never fill them.
 *
 * One inherited caveat, stated rather than resolved: every set ever recorded
 * counts, superseded same-date corrections included, so an instrument held only
 * in a superseded set keeps a gap no valuation reads
 * (`docs/importing-history.md:243-246`).
 *
 * The range's end is the caller's, because it is today's market date and this
 * read has no clock.
 */
export async function selectBackfillCandidates(
  db: Kysely<Database> = getDb(),
): Promise<BackfillCandidate[]> {
  const rows = await db
    .selectFrom("instrument")
    .innerJoin("holding", "holding.instrument_id", "instrument.id")
    .innerJoin("position_set", "position_set.id", "holding.position_set_id")
    .leftJoin("price_daily", "price_daily.instrument_id", "instrument.id")
    .where("instrument.price_source", "=", "feed")
    .where("instrument.symbol", "is not", null)
    // The retry clock. Before the grouping on purpose: an instrument attempted
    // in the last day is not a candidate whatever its positions say.
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("price_backfill")
            .select("price_backfill.id")
            .whereRef("price_backfill.instrument_id", "=", "instrument.id")
            .where(
              sql<boolean>`price_backfill.started_at > now() - cast(${BACKFILL_RETRY_INTERVAL} as interval)`,
            ),
        ),
      ),
    )
    .groupBy(["instrument.id", "instrument.symbol"])
    .having(
      sql<boolean>`min(price_daily.date) is null or min(price_daily.date) > min(position_set.as_of_date)`,
    )
    .select([
      "instrument.id",
      "instrument.symbol",
      // In SQL, so no date arithmetic happens in JavaScript and the driver
      // hands the result back as the `YYYY-MM-DD` string a `date` crosses as.
      sql<IsoDate>`min(position_set.as_of_date) - cast(${BACKFILL_RANGE_LEAD_DAYS} as integer)`.as(
        "range_from",
      ),
    ])
    // The deepest gap first, so a household loading a decade is worked from the
    // oldest statement forward; then the id, so two ticks agree on what "next"
    // means rather than racing a tie.
    .orderBy(sql`min(position_set.as_of_date)`)
    .orderBy("instrument.id")
    .limit(BACKFILL_BATCH_SIZE)
    .execute();

  return rows.map((row) => ({
    id: String(row.id),
    // Narrowing only: the query refuses null symbols, which TypeScript cannot
    // see through a `where` — `refreshQuotes`'s narrowing, same reason.
    symbol: row.symbol as string,
    rangeFrom: row.range_from,
  }));
}

/**
 * Every instrument the provider will be asked about, by symbol — a map to a
 * *list*, not one instrument: `instrument.symbol` has no unique constraint
 * (§4.1), so two rows can share a ticker, one quote must update all of them,
 * and a `Map<string, Instrument>` would silently price whichever came last.
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
 * The form a symbol is matched on: upper-cased, or an instrument stored `vti`
 * never matches the `VTI` that comes back — stale on every run, permanently,
 * with nothing in the log naming it. Matching is the *only* thing normalised:
 * the stored symbol stays exactly as typed (§4.3 makes it a mutable attribute
 * a person edits, not a key the app owns).
 */
const matchKey = (symbol: string): string => symbol.trim().toUpperCase();

/**
 * Run `body` in a transaction unless one is already open: Kysely refuses
 * `.transaction()` on a transaction, and the test seam *is* one
 * (`withDatabase`). Joining the caller's is also right in production — a
 * future caller can wrap a refresh in a larger unit of work.
 */
function inTransaction<T>(
  db: Kysely<Database>,
  body: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.isTransaction ? body(db) : db.transaction().execute(body);
}

/**
 * Fetch every feed instrument's price and store it. One transaction — not for
 * atomicity against readers (`holding_valued` tolerates a half-priced
 * portfolio by design) but so a crash midway cannot leave instruments marked
 * stale by a run that never got to unmark them.
 *
 * @param provider injected, the seam DESIGN.md §6.1 exists for: tests pass a
 *                 fake and CI never reaches the network.
 * @param marketTimeZone decides which calendar day a quote's instant belongs
 *                 to, and nothing else.
 */
export async function refreshQuotes(
  provider: PriceProvider,
  marketTimeZone: string,
  db: Kysely<Database> = getDb(),
): Promise<RefreshReport> {
  // Read first: the poll records the span from here to commit, and an attempt
  // that dies before committing leaves no row at all.
  const startedAt = new Date();

  const instruments = await selectFeedInstruments(db).execute();

  const feed: FeedInstrument[] = instruments.map((row) => ({
    id: String(row.id),
    // Narrowing only: the query refuses null symbols; TypeScript cannot see
    // that through a `where`.
    symbol: row.symbol as string,
  }));

  const lookup = bySymbol(feed);

  // An instance with nothing to price still made an attempt, and ADR-0006
  // wants it recorded — else a silent stretch in the log cannot be told from
  // a server that was not running. So no early return: skip the provider,
  // fall through to the transaction, write the poll row and nothing else.
  //
  // A provider that throws is the case §6.1 says to expect. Left to
  // propagate, every `is_stale` flag stays as it was and the UI keeps
  // presenting last week's prices as current — the §11 failure this slice
  // exists to prevent. An empty batch instead takes the same path as a symbol
  // that did not come back: everything selected marked stale, no price
  // written, and — the absence being the truth — no observation either.
  let quotes: ProviderQuote[] = [];
  let providerFailed = false;
  if (feed.length > 0) {
    try {
      quotes = await provider.getQuotes([...lookup.keys()]);
    } catch (error) {
      console.error("Price provider failed; marking every selected instrument stale:", error);
      quotes = [];
      providerFailed = true;
    }
  }

  // Matched outside the transaction — nothing here writes. A quote for a
  // symbol nobody asked about is not worth failing the run (a provider may
  // normalise a symbol), but it has no instrument to belong to.
  const matched: Array<{ instrumentId: string; quote: ProviderQuote }> = [];
  for (const quote of quotes) {
    for (const instrument of lookup.get(matchKey(quote.symbol)) ?? []) {
      matched.push({ instrumentId: instrument.id, quote });
    }
  }

  return inTransaction(db, async (trx) => {
    // The log first, then the tiers derived from it — the order the facts are
    // in: the observation records what the provider said; the quote and the
    // close are what we now believe because of it.
    const observed = await writeObservations(trx, observationsOf(matched, marketTimeZone));

    const pricedIds = new Set<string>();
    let closes = 0;

    for (const { instrumentId, quote } of matched) {
      await writeQuote(trx, instrumentId, quote);
      await writeQuoteType(trx, instrumentId, quote);
      await writeDailyClose(trx, instrumentId, quote, marketTimeZone);
      pricedIds.add(instrumentId);
      closes += 1;
    }

    // Everything asked for that did not come back. §6.2: the last known price
    // is kept, used, and flagged — never zeroed. A never-priced instrument
    // has no row to flag; `holding_valued` already reports it unpriced.
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
      observed,
      providerFailed,
    };

    await writePoll(trx, startedAt, report);

    return report;
  });
}

/**
 * The intraday tier: one row per instrument, overwritten. `is_stale` resets
 * to false on every successful write — the only thing that ever clears it: a
 * price fetched cleanly now is not stale, and a lingering flag trains the
 * reader to ignore it.
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
 * What the provider calls the instrument, kept current on the row. Written at
 * creation (`instrument-resolution.server.ts`) and refreshed here — what
 * makes it true of instruments created before the column existed; without
 * that, the stocks-versus-funds split (§4.4) would be right only for newer
 * instruments, every older holding sitting in the catch-all row looking like
 * a panel fault.
 *
 * **Only ever set from something the provider actually said**: an omitted
 * field leaves the stored value alone (the provider being terse, not the
 * instrument turning unclassifiable); a changed value is written (the
 * provider correcting itself — the column is its vocabulary). `is distinct
 * from`, not `<>`: a stored null must count as a change, and `<>` answers
 * null, updating nothing.
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
 * The immutable spine: one row per instrument per trading day, dated by the
 * quote, not the clock (see the module header). The upsert is what makes an
 * intraday poll safe — the row is rewritten through the session and settles
 * on the close — and a holiday poll harmless: its quote still carries the
 * previous trading day and rewrites it with the value already there.
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
 * The provider's raw entry as the text the `jsonb` column will parse, or
 * null. Serialised so the value crossing the driver is unambiguously the
 * stored document; ADR-0006 makes `price` the only column anything may
 * compute from, so nothing depends on the type reading. A payload that will
 * not serialise is dropped with a log line, never thrown: failing a whole
 * refresh to preserve an audit artifact would invert the priority. `null` is
 * treated as absent — a stored `jsonb` null and a stored nothing would be two
 * spellings of one fact.
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
 * One refresh's observation batch, keyed by instrument and instant rather
 * than appended: a provider can echo an alias back, and the primary key would
 * then see the same row twice inside one statement. Deduping here means the
 * batch says what it means before Postgres has to decide.
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
      // The same instant through the same rule that files the close, stamped
      // now so resolving a session later is an indexed date lookup — and the
      // instant-to-day rule lives in exactly one place.
      market_date: marketDateOf(quote.asOf, marketTimeZone),
      price: quote.price,
      fetched_at: quote.fetchedAt,
      payload: archived(quote.payload),
    });
  }

  return [...batch.values()];
}

/**
 * The observation log: one insert for the whole refresh. `do nothing` is the
 * append-only rule in one clause — an unchanged quote (the common case)
 * writes nothing, keeping the log a record of distinct instants rather than
 * of polls. The header's first divergence happens here: a re-stated instant
 * at a different price loses the second price, while `quote` upserts to it.
 */
async function writeObservations(db: Kysely<Database>, rows: ObservationRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  // `returning`, not a count query: under `do nothing` a row comes back only
  // for a real insert, so the length is the number of new instants — counted
  // where it is known. Deriving it afterwards would scan an append-only table
  // growing ~half a GB a year with no index a time-bounded scan could use.
  const inserted = await db
    .insertInto("price_observation")
    .values(rows)
    .onConflict((conflict) => conflict.columns(["instrument_id", "as_of"]).doNothing())
    .returning("instrument_id")
    .execute();

  return inserted.length;
}

/**
 * The attempt itself, recorded whether or not it wrote a price — what makes
 * the log's silences readable: with a poll row per attempt, a quiet market, a
 * failed provider and a stopped server come apart. One stated gap: this row
 * shares the prices' transaction, so a refresh that ran and could not commit
 * leaves no row either — a second connection would buy that case and cost
 * "one fetch, one unit of work". `closes` is deliberately not stored: it
 * counts another tier's writes, and `priced` already says how many answered.
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
 * non-negotiable. Returns the *oldest* `as_of` among priced holdings — the
 * newest would let ninety-nine fresh instruments hide one failing for a week:
 * §11's "silently showing yesterday's net worth as though it were live".
 * Scoped through `holding_valued` to instruments held in open accounts: an
 * unowned instrument going stale is not a fact about anyone's net worth, and
 * reporting it would make the banner unclearable.
 */
export async function priceFreshness(
  db: Kysely<Database> = getDb(),
): Promise<{ oldest: Date | null; stale: number; priced: number }> {
  const row = await db
    .selectFrom("holding_valued")
    .innerJoin("quote", "quote.instrument_id", "holding_valued.instrument_id")
    // `fixed` (the seeded USD row, `as_of` written once in 0001) would pin
    // `oldest` to the install timestamp for the life of the instance — an "as
    // of" line that never moves is a worse lie than none. `manual` is
    // excluded from the other direction: a hand-typed price is as fresh as
    // the person who typed it.
    .where("holding_valued.price_source", "=", "feed")
    .select([
      sql<Date | null>`min(quote.as_of)`.as("oldest"),
      // Distinct instruments, not holdings: one fund in three accounts is one
      // stale thing, and the count reads "3 of 40 prices are stale".
      sql<string>`count(distinct holding_valued.instrument_id) filter (where holding_valued.is_stale)`.as(
        "stale",
      ),
      sql<string>`count(distinct holding_valued.instrument_id)`.as("priced"),
    ])
    .executeTakeFirst();

  return {
    oldest: row?.oldest ?? null,
    // Cardinalities, not money — `Number` is safe here.
    stale: Number(row?.stale ?? 0),
    priced: Number(row?.priced ?? 0),
  };
}

/**
 * The as-of caption, rendered in one place rather than five: every screen
 * asks the same question and must not answer it differently. Formatted here
 * because the market zone is configuration a component has no business
 * reading, and these pages render on the server, where the reader's clock
 * does not exist. Inherits what `priceFreshness` counts: a household of cash
 * and a hand-priced trust is fully valued and still says "no prices yet" —
 * the truth, if a blunt one.
 */
export async function asOfView(
  marketTimeZone: string,
  db: Kysely<Database> = getDb(),
): Promise<{ stamp: string | null; stale: number }> {
  const { oldest, stale } = await priceFreshness(db);

  return { stamp: oldest === null ? null : marketStampOf(oldest, marketTimeZone), stale };
}
