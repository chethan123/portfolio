/**
 * The only thing in the application that writes a price (DESIGN.md §6.2, ADR-0006):
 *
 *   quote              one row per instrument, overwritten — the intraday tier
 *   price_daily        one row per instrument per trading day — the immutable spine
 *   price_observation  one row per instrument per provider instant — append-only
 *   price_poll         one row per refresh attempt, whether or not it wrote
 *   price_backfill     one row per backfill attempt per instrument (ADR-0011)
 *
 * Two writers share the spine: the quotes' write upserts, the backfill's inserts where absent and
 * never updates — a close recorded live is the record, not the feed's later restatement of it.
 *
 * `price_daily` is dated by the instant inside the quote, in the market's zone, never by today's
 * date: otherwise an afternoon poll of a fund's yesterday NAV fabricates a close for an unfinished
 * day, and a holiday poll a row for a day the market did not trade (§6.2 forbids both). Rewrites
 * are bounded to ±{@link CLOSE_WINDOW_DAYS} of today's market date (spec 0018 §3.1) — further back
 * is a provider claiming a day the poller settled, further ahead plants a close on a day nothing
 * revisits. Outside the window the quote and the observation still land; only the close is skipped.
 *
 * The quotes' writes and the poll row share one transaction — all four tables or none. Three
 * divergences are accepted: a restated instant at a new price (`quote` upserts, the observation
 * keeps the first), a hand-typed manual price, and one symbol returned twice.
 *
 * Every exported query takes an optional `db`; tests pass a transaction they roll back.
 */
import { sql } from "kysely";

import { addDays } from "./chart-range.ts";
import { getDb, getPool, type Database } from "./db.server.ts";
import { marketDateOf, marketStampOf, type IsoDate } from "./market-hours.ts";
import { ProviderUnreachable } from "./price-provider.server.ts";
import type {
  HistoryRange,
  PriceProvider,
  ProviderDailyClose,
  ProviderHistory,
  ProviderQuote,
} from "./price-provider.server.ts";

import type { Kysely } from "kysely";
import type pg from "pg";

/** Arbitrary, must not change — and must not equal the migration runner's `7295380114023641`. */
const ADVISORY_LOCK_KEY = "7295380114023642";

/**
 * The batch bound is the whole of the pacing: nothing queues against the unofficial endpoint, and a
 * batch that cannot finish before the next tick is resumed by it, the candidate read being re-asked
 * every time (ADR-0011).
 */
const BACKFILL_BATCH_SIZE = 5;

/**
 * How recently an attempt must have been made for an instrument to be skipped: an unfillable gap
 * costs one request a day rather than one a tick. Passed as a parameter and cast, never spliced.
 */
const BACKFILL_RETRY_INTERVAL = "1 day";

/**
 * A statement dated on a weekend or holiday has no close of its own, so the range reaches back far
 * enough to find one to carry forward — a week clears the longest US run of non-trading days.
 */
const BACKFILL_RANGE_LEAD_DAYS = 7;

/**
 * How far a quote's own market date may sit from today's, either side, before {@link writeDailyClose}
 * refuses it. A week is the lag an honest NAV or holiday quote can carry; beyond it, it is wrong.
 */
const CLOSE_WINDOW_DAYS = 7;

/**
 * Run a refresh, or decline because one is already running — two browser tabs is the contention
 * that actually happens. Guards the *decision* to spend a request, never the rows.
 *
 * `null` for a refusal, not a throw. A dedicated connection, because an advisory lock belongs to
 * the session that took it; the work itself runs through Kysely on another.
 */
export async function withRefreshLock<T>(body: () => Promise<T>): Promise<T | null> {
  // Declared before the `try`, acquired inside it: a throw from `connect` above the `finally`
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
    // A session-level lock outlives the failed query but not the session, and a pooled connection
    // keeps its session — returned still holding the lock, it blocks every future refresh.
    broken = true;
    throw error;
  } finally {
    client?.release(broken);
  }
}

export type RefreshReport = {
  requested: number;
  priced: number;
  /** Instruments that were asked for and did not come back. */
  stale: number;
  /** `price_daily` rows written or rewritten. Excludes a close {@link CLOSE_WINDOW_DAYS} refused. */
  closes: number;
  /** Observations the log did not already hold — the only field separating learning from re-fetching. */
  observed: number;
  /** A failed call is swallowed, so the aggregates match a provider that answered and knew nothing. */
  providerFailed: boolean;
};

type FeedInstrument = { id: string; symbol: string };

/**
 * Which instruments a refresh may fetch. The two exclusions differ (§4.3): `fixed` is the seeded
 * `USD` row, `manual` a workplace plan with no public ticker. Null symbols are filtered separately
 * because `symbol` is nullable for `feed` too — a ticker can be unknown at creation.
 */
const selectFeedInstruments = (db: Kysely<Database>) =>
  db
    .selectFrom("instrument")
    .select(["id", "symbol"])
    .where("price_source", "=", "feed")
    .where("symbol", "is not", null)
    .orderBy("symbol");

/**
 * What one backfill attempt can have come to. A `const` object, not an enum (`erasableSyntaxOnly`),
 * kept in step by hand with `price_backfill_outcome_valid` in `0010_price_backfill.sql`, which is
 * the authority. Deliberately a second vocabulary to the provider's; the mapping is one object.
 */
export const BACKFILL_OUTCOMES = {
  filled: "filled",
  nothingToWrite: "nothing_to_write",
  noHistory: "no_history",
  nonUsd: "non_usd",
  splitUnresolved: "split_unresolved",
  providerFailed: "provider_failed",
} as const;

export type BackfillOutcome = (typeof BACKFILL_OUTCOMES)[keyof typeof BACKFILL_OUTCOMES];

/**
 * The coverage gap itself, stated once for the two reads that ask it — the batch's
 * {@link selectBackfillCandidates} and the screen's {@link backfillGaps} — so the two cannot drift.
 *
 * A `having` predicate, not a `where`: it reads `instrument` and `position_set` out of whatever
 * query it is dropped into, so both must be joined under those names, and `min(position_set
 * .as_of_date)` means first-held only while the grouping is one row per instrument.
 *
 * A probe, not `docs/importing-history.md`'s left join: that pairs every holding row with every
 * close before aggregating — 35M inner rows and 1.4s against this 4ms, widening as the spine grows.
 */
const NO_CLOSE_BY_FIRST_HELD = sql<boolean>`not exists (
  select 1
  from price_daily
  where price_daily.instrument_id = instrument.id
    and price_daily.date <= min(position_set.as_of_date)
)`;

export type BackfillCandidate = {
  id: string;
  /** As stored. The adapter upper-cases it to send; nothing here rewrites it. */
  symbol: string;
  /** `YYYY-MM-DD`, computed in SQL — no date arithmetic happens in JavaScript. */
  rangeFrom: IsoDate;
};

/**
 * Which instruments a batch should try next. The gap is a property of the positions, not of the
 * instrument: a candidate's spine starts later than the earliest `position_set.as_of_date` of any
 * holding referencing it, or has no row at all. `fixed`, `manual` and null symbols are excluded as
 * {@link selectFeedInstruments} excludes them. Every set ever recorded counts, superseded
 * corrections included. The range's end is the caller's — this read has no clock.
 */
export async function selectBackfillCandidates(
  db: Kysely<Database> = getDb(),
): Promise<BackfillCandidate[]> {
  const rows = await db
    .selectFrom("instrument")
    .innerJoin("holding", "holding.instrument_id", "instrument.id")
    .innerJoin("position_set", "position_set.id", "holding.position_set_id")
    .where("instrument.price_source", "=", "feed")
    .where("instrument.symbol", "is not", null)
    // The retry clock, before the grouping: an instrument attempted in the last day is not a
    // candidate whatever its positions say.
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
    .having(NO_CLOSE_BY_FIRST_HELD)
    .select([
      "instrument.id",
      "instrument.symbol",
      // In SQL, so no date arithmetic in JavaScript and the driver hands back a `YYYY-MM-DD` string.
      sql<IsoDate>`min(position_set.as_of_date) - cast(${BACKFILL_RANGE_LEAD_DAYS} as integer)`.as(
        "range_from",
      ),
    ])
    // Deepest gap first, so a decade is worked from the oldest statement forward; then the id, so
    // two ticks agree on what "next" means rather than racing a tie.
    .orderBy(sql`min(position_set.as_of_date)`)
    .orderBy("instrument.id")
    .limit(BACKFILL_BATCH_SIZE)
    .execute();

  return rows.map((row) => ({
    id: String(row.id),
    // Narrowing only: the query refuses null symbols, which TypeScript cannot see through a `where`.
    symbol: row.symbol as string,
    rangeFrom: row.range_from,
  }));
}

export type BackfillGap = {
  id: string;
  /** Null is itself a reason: a feed instrument nobody has given a ticker. */
  symbol: string | null;
  name: string;
  /** `YYYY-MM-DD`, the earliest position set holding it. */
  firstHeld: IsoDate;
  /** `YYYY-MM-DD`, or null where there is no spine at all yet. */
  firstClose: IsoDate | null;
  lastAttempt: { at: Date; outcome: string; error: string | null } | null;
  /** As stored — half of *why* {@link willTry} is false: a hand-priced trust, or a missing ticker. */
  priceSource: string;
  /** `feed` with a symbol. False rows have gaps just as real, which is why they are listed. */
  willTry: boolean;
};

/**
 * Every instrument still carrying a coverage gap, for Settings → Prices. The same predicate as
 * {@link selectBackfillCandidates}, shared rather than restated, over every instrument whose
 * `price_source` is not `fixed` (the seeded USD row, whose 1970 close covers everything).
 *
 * It answers "why is this date unpriced", not "what will the batch try next": no retry skip, no
 * bound, ordered as the batch works.
 */
export async function backfillGaps(db: Kysely<Database> = getDb()): Promise<BackfillGap[]> {
  const rows = await db
    .selectFrom("instrument")
    .innerJoin("holding", "holding.instrument_id", "instrument.id")
    .innerJoin("position_set", "position_set.id", "holding.position_set_id")
    // One probe of the `(instrument_id, started_at)` index for the latest attempt, rather than
    // three correlated subqueries for its three columns.
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom("price_backfill")
          .select(["price_backfill.started_at", "price_backfill.outcome", "price_backfill.error"])
          .whereRef("price_backfill.instrument_id", "=", "instrument.id")
          .orderBy("price_backfill.started_at", "desc")
          .limit(1)
          .as("attempt"),
      (join) => join.onTrue(),
    )
    .where("instrument.price_source", "!=", "fixed")
    .groupBy([
      "instrument.id",
      "instrument.symbol",
      "instrument.name",
      "instrument.price_source",
      "attempt.started_at",
      "attempt.outcome",
      "attempt.error",
    ])
    .having(NO_CLOSE_BY_FIRST_HELD)
    .select([
      "instrument.id",
      "instrument.symbol",
      "instrument.name",
      sql<IsoDate>`min(position_set.as_of_date)`.as("first_held"),
      // Where the spine does start — the other half of reading a distorted stretch of the chart.
      sql<
        IsoDate | null
      >`(select min(date) from price_daily where price_daily.instrument_id = instrument.id)`.as(
        "first_close",
      ),
      "instrument.price_source",
      "attempt.started_at",
      "attempt.outcome",
      "attempt.error",
      sql<boolean>`instrument.price_source = 'feed' and instrument.symbol is not null`.as(
        "will_try",
      ),
    ])
    .orderBy(sql`min(position_set.as_of_date)`)
    .orderBy("instrument.id")
    .execute();

  return rows.map((row) => ({
    id: String(row.id),
    symbol: row.symbol,
    name: row.name,
    firstHeld: row.first_held,
    firstClose: row.first_close,
    // Both columns come from one lateral row, so either alone answers "was there an attempt";
    // TypeScript cannot see that, so both are checked.
    lastAttempt:
      row.started_at === null || row.outcome === null
        ? null
        : { at: row.started_at, outcome: row.outcome, error: row.error },
    priceSource: row.price_source,
    willTry: row.will_try,
  }));
}

export type BackfillReport = {
  attempted: number;
  /** Closes the spine did not already hold, across the batch. */
  written: number;
  outcomes: Record<BackfillOutcome, number>;
  /** A database error partway through. Always false out of {@link backfillCloses}, which does not catch one. */
  batchFailed: boolean;
};

/** The provider's three refusals as the ledger spells them — this object is the whole mapping. */
const LEDGER_OUTCOME: Record<Exclude<ProviderHistory["status"], "ok">, BackfillOutcome> = {
  "no-history": BACKFILL_OUTCOMES.noHistory,
  "non-usd": BACKFILL_OUTCOMES.nonUsd,
  "split-unresolved": BACKFILL_OUTCOMES.splitUnresolved,
};

/**
 * A batch that stopped partway, carrying what it did before it stopped: the counts must survive
 * the throw, because the batch's log line is the only surface it has. Thrown rather than returned,
 * so the composition still decides what a caller is told.
 */
class BackfillBatchFailed extends Error {
  override readonly name = "BackfillBatchFailed";
  readonly report: BackfillReport;

  constructor(cause: unknown, report: BackfillReport) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.report = report;
  }
}

const emptyBackfillReport = (): BackfillReport => ({
  attempted: 0,
  written: 0,
  outcomes: {
    [BACKFILL_OUTCOMES.filled]: 0,
    [BACKFILL_OUTCOMES.nothingToWrite]: 0,
    [BACKFILL_OUTCOMES.noHistory]: 0,
    [BACKFILL_OUTCOMES.nonUsd]: 0,
    [BACKFILL_OUTCOMES.splitUnresolved]: 0,
    [BACKFILL_OUTCOMES.providerFailed]: 0,
  },
  batchFailed: false,
});

/**
 * Fill the spine backwards for a bounded batch of instruments held further back than it reaches
 * (ADR-0011). Sequential: nothing is queued, because a queue of pending fetches against an
 * unofficial endpoint is how an instance gets rate limited. The range's end is today's market date,
 * exclusive, so today's row stays the poller's provisional one.
 *
 * A provider failure for one instrument is not a failure of the batch — it is ledgered and the next
 * symbol tried. A database failure is, and is deliberately not caught here. `ProviderUnreachable`
 * is a third case: it escapes unledgered, so one dead worker costs no candidate its day-long retry
 * skip and is wrapped once, not twice (price-worker spec §3.1).
 */
export async function backfillCloses(
  provider: PriceProvider,
  marketTimeZone: string,
  db: Kysely<Database> = getDb(),
): Promise<BackfillReport> {
  const until = marketDateOf(new Date(), marketTimeZone);
  const candidates = await selectBackfillCandidates(db);

  const report = emptyBackfillReport();

  try {
    for (const candidate of candidates) {
      const range: HistoryRange = { from: candidate.rangeFrom, until };

      // Before the fetch: the span to the commit is how long the provider took, and an attempt
      // that never commits leaves no row at all.
      const startedAt = new Date();

      let history: ProviderHistory;
      try {
        history = await provider.getDailyCloses(candidate.symbol, range, marketTimeZone);
      } catch (error) {
        // Escapes unchanged, before anything is ledgered: the provider was never reached, and
        // every candidate after this one would fail identically. The outer catch wraps it once —
        // wrapping here too would nest two, and the composition would log the inner wrapper.
        if (error instanceof ProviderUnreachable) throw error;

        const outcome = BACKFILL_OUTCOMES.providerFailed;

        await inTransaction(db, (trx) =>
          writeBackfillAttempt(trx, {
            instrumentId: candidate.id,
            startedAt,
            range,
            written: 0,
            outcome,
            error: error instanceof Error ? error.message : String(error),
          }),
        );

        report.attempted += 1;
        report.outcomes[outcome] += 1;
        continue;
      }

      if (history.status !== "ok") {
        const outcome = LEDGER_OUTCOME[history.status];

        await inTransaction(db, (trx) =>
          writeBackfillAttempt(trx, {
            instrumentId: candidate.id,
            startedAt,
            range,
            written: 0,
            outcome,
            error: null,
          }),
        );

        report.attempted += 1;
        report.outcomes[outcome] += 1;
        continue;
      }

      // The closes and the row describing them in one transaction: the ledger must not claim a
      // fill that rolled back.
      const written = await inTransaction(db, async (trx) => {
        const count = await writeBackfilledCloses(trx, candidate.id, history.closes);

        await writeBackfillAttempt(trx, {
          instrumentId: candidate.id,
          startedAt,
          range,
          written: count,
          outcome: count > 0 ? BACKFILL_OUTCOMES.filled : BACKFILL_OUTCOMES.nothingToWrite,
          error: null,
        });

        return count;
      });

      report.attempted += 1;
      report.written += written;
      report.outcomes[written > 0 ? BACKFILL_OUTCOMES.filled : BACKFILL_OUTCOMES.nothingToWrite] +=
        1;
    }
  } catch (error) {
    // Re-thrown rather than swallowed — the composition decides what a caller is told. Wrapped
    // only so the counts reach its log line.
    throw new BackfillBatchFailed(error, report);
  }

  return report;
}

/** Both halves of a refresh, the quotes' half null when it was not asked for. */
export type RefreshPricesReport = {
  quotes: RefreshReport | null;
  backfill: BackfillReport;
};

/**
 * One refresh: quotes, then one bounded backfill batch — the composition every caller shares. It
 * does not take the lock; every caller wraps it in {@link withRefreshLock}.
 *
 * The batch cannot falsify what the quotes did: a database failure inside it is caught and logged
 * here, because `runRefresh` would turn a throw into "Refresh failed. The figures above are
 * unchanged" — false once `refreshQuotes` has committed. `ProviderUnreachable` is caught too and
 * warned rather than errored, keeping the stem `docs/operating.md` greps for. A call asking for no
 * quotes writes no `price_poll` row: that row is `refreshQuotes`'s.
 */
export async function refreshPrices(
  provider: PriceProvider,
  marketTimeZone: string,
  options: { quotes: true },
  db?: Kysely<Database>,
): Promise<{ quotes: RefreshReport; backfill: BackfillReport }>;
export async function refreshPrices(
  provider: PriceProvider,
  marketTimeZone: string,
  options: { quotes: boolean },
  db?: Kysely<Database>,
): Promise<RefreshPricesReport>;
export async function refreshPrices(
  provider: PriceProvider,
  marketTimeZone: string,
  { quotes }: { quotes: boolean },
  db: Kysely<Database> = getDb(),
): Promise<RefreshPricesReport> {
  const quotesReport = quotes ? await refreshQuotes(provider, marketTimeZone, db) : null;

  try {
    return { quotes: quotesReport, backfill: await backfillCloses(provider, marketTimeZone, db) };
  } catch (error) {
    const stopped = error instanceof BackfillBatchFailed;
    const cause = stopped ? error.cause : undefined;

    if (cause instanceof ProviderUnreachable) {
      // Deliberately not "the quotes it ran beside are unaffected": that is false whenever the
      // quotes call hit the same dead worker.
      console.warn("Price backfill batch failed; the provider was unreachable:", cause.message);
    } else {
      console.error(
        "Price backfill batch failed; the quotes it ran beside are unaffected:",
        stopped ? error.cause : error,
      );
    }

    // The counts of whatever committed before it stopped; only the attempt in flight is lost.
    const report = stopped ? error.report : emptyBackfillReport();

    return { quotes: quotesReport, backfill: { ...report, batchFailed: true } };
  }
}

/**
 * Every instrument the provider will be asked about, by symbol — a map to a *list*: `instrument
 * .symbol` has no unique constraint (§4.1), and one quote must update every row sharing a ticker.
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
 * The form a symbol is matched on: upper-cased, or an instrument stored `vti` never matches the
 * `VTI` that comes back — stale forever with nothing in the log naming it. Matching is the only
 * thing normalised; the stored symbol stays exactly as typed (§4.3). Exported: the backfill's
 * history call sends the same form.
 */
export const matchKey = (symbol: string): string => symbol.trim().toUpperCase();

/**
 * Run `body` in a transaction unless one is already open: Kysely refuses `.transaction()` on a
 * transaction, and the test seam *is* one (`withDatabase`).
 */
function inTransaction<T>(
  db: Kysely<Database>,
  body: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.isTransaction ? body(db) : db.transaction().execute(body);
}

/**
 * Fetch every feed instrument's price and store it. One transaction — not for atomicity against
 * readers (`holding_valued` tolerates a half-priced portfolio) but so a crash midway cannot leave
 * instruments marked stale by a run that never got to unmark them.
 *
 * @param marketTimeZone decides which calendar day a quote's instant belongs to, nothing else.
 */
export async function refreshQuotes(
  provider: PriceProvider,
  marketTimeZone: string,
  db: Kysely<Database> = getDb(),
): Promise<RefreshReport> {
  // Read first: the poll records the span from here to commit, and an attempt that dies before
  // committing leaves no row at all.
  const startedAt = new Date();

  const instruments = await selectFeedInstruments(db).execute();

  const feed: FeedInstrument[] = instruments.map((row) => ({
    id: String(row.id),
    // Narrowing only: the query refuses null symbols; TypeScript cannot see that through a `where`.
    symbol: row.symbol as string,
  }));

  const lookup = bySymbol(feed);

  // No early return: an instance with nothing to price still made an attempt, and ADR-0006 wants
  // the poll row — a silent stretch of log must not read like a stopped server.
  //
  // A provider that throws is caught here (§6.1): left to propagate, every `is_stale` flag would
  // stay as it was and the UI would keep presenting last week's prices as current. An empty batch
  // then takes the same path as a symbol that did not come back — stale, no price, no observation.
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

  // Matched outside the transaction — nothing here writes. A quote for a symbol nobody asked about
  // is not worth failing the run, but it has no instrument to belong to.
  const matched: Array<{ instrumentId: string; quote: ProviderQuote }> = [];
  for (const quote of quotes) {
    for (const instrument of lookup.get(matchKey(quote.symbol)) ?? []) {
      matched.push({ instrumentId: instrument.id, quote });
    }
  }

  return inTransaction(db, async (trx) => {
    // The log first, then the tiers derived from it: the observation records what the provider
    // said; the quote and the close are what we believe because of it.
    const observed = await writeObservations(trx, observationsOf(matched, marketTimeZone));

    const pricedIds = new Set<string>();
    let closes = 0;
    const windowSkipped: string[] = [];

    for (const { instrumentId, quote } of matched) {
      await writeQuote(trx, instrumentId, quote);
      await writeQuoteType(trx, instrumentId, quote);
      const wroteClose = await writeDailyClose(trx, instrumentId, quote, marketTimeZone);
      pricedIds.add(instrumentId);
      if (wroteClose) {
        closes += 1;
      } else {
        // The matched form, not the feed's spelling: a provider answering with newlines around a
        // symbol cannot break an operator's log.
        windowSkipped.push(matchKey(quote.symbol));
      }
    }

    if (windowSkipped.length > 0) {
      console.warn(
        `Price close skipped, more than ${CLOSE_WINDOW_DAYS} days from today's market date: ${windowSkipped.join(", ")}`,
      );
    }

    // Everything asked for that did not come back. §6.2: the last known price is kept, used and
    // flagged, never zeroed. A never-priced instrument has no row to flag.
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
 * The intraday tier: one row per instrument, overwritten. `is_stale` resets to false on every
 * successful write — the only thing that clears it.
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
 * What the provider calls the instrument, kept current — what makes the stocks-versus-funds split
 * (§4.4) true of instruments created before the column existed.
 *
 * Only ever set from something the provider actually said: an omitted field leaves the stored value
 * alone. `is distinct from`, not `<>`: a stored null must count as a change, and `<>` answers null.
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
 * The immutable spine: one row per instrument per trading day, dated by the quote and not the clock
 * (module header). The upsert is what makes an intraday poll safe — the row is rewritten through
 * the session and settles on the close — and a holiday poll harmless.
 *
 * Refuses outside ±{@link CLOSE_WINDOW_DAYS} of today's market date, deciding before the upsert
 * rather than clamping what it writes. Returns whether it wrote, so the caller counts real writes.
 */
async function writeDailyClose(
  db: Kysely<Database>,
  instrumentId: string,
  quote: ProviderQuote,
  marketTimeZone: string,
): Promise<boolean> {
  const date = marketDateOf(quote.asOf, marketTimeZone);
  const today = marketDateOf(new Date(), marketTimeZone);

  if (date < addDays(today, -CLOSE_WINDOW_DAYS) || date > addDays(today, CLOSE_WINDOW_DAYS)) {
    return false;
  }

  await db
    .insertInto("price_daily")
    .values({
      instrument_id: instrumentId,
      date,
      close: quote.price,
    })
    .onConflict((conflict) =>
      conflict
        .columns(["instrument_id", "date"])
        .doUpdateSet({ close: (builder) => builder.ref("excluded.close") }),
    )
    .execute();

  return true;
}

/**
 * The spine's second write path: every trading day the feed returned that the spine does not hold.
 * `do nothing`, never `do update` — a backfill must never overwrite what the running system recorded
 * live (`docs/importing-history.md`), which is why this is a separate statement from
 * {@link writeDailyClose}. Counted from `returning`, so the ledger records rows that were new.
 */
async function writeBackfilledCloses(
  db: Kysely<Database>,
  instrumentId: string,
  closes: readonly ProviderDailyClose[],
): Promise<number> {
  if (closes.length === 0) return 0;

  const inserted = await db
    .insertInto("price_daily")
    .values(
      closes.map((close) => ({
        instrument_id: instrumentId,
        date: close.date,
        close: close.close,
      })),
    )
    .onConflict((conflict) => conflict.columns(["instrument_id", "date"]).doNothing())
    .returning("instrument_id")
    .execute();

  return inserted.length;
}

type ObservationRow = {
  instrument_id: string;
  as_of: Date;
  market_date: string;
  price: string;
  fetched_at: Date;
  payload: string | null;
};

/**
 * Largest serialised payload the log will store. The log inserts one row per instrument per
 * distinct instant, so a worker varying `regularMarketTime` could otherwise carry the client's
 * whole body cap into the cluster on every tick.
 */
const ARCHIVE_PAYLOAD_CAP = 32 * 1024;

/**
 * The provider's raw entry as the text the `jsonb` column will parse, or null. A payload that will
 * not serialise is dropped with a log line, never thrown: failing a refresh to preserve an audit
 * artifact would invert the priority. `null` is treated as absent.
 *
 * Measured with `Buffer.byteLength`, not `.length`: non-ASCII text runs longer in UTF-8 than its
 * UTF-16 code-unit count, and the cap is about bytes on disk. `symbol` is only for the log line.
 */
function archived(payload: unknown, symbol: string): string | null {
  if (payload === undefined || payload === null) return null;

  let json: string | null;
  try {
    json = JSON.stringify(payload) ?? null;
  } catch (error) {
    console.warn("Price payload could not be archived; storing the observation without it:", error);
    return null;
  }

  if (json === null) return null;

  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > ARCHIVE_PAYLOAD_CAP) {
    console.warn(
      `Price payload for ${symbol} is ${bytes} bytes, over the ${ARCHIVE_PAYLOAD_CAP}-byte cap; storing the observation without it`,
    );
    return null;
  }

  return json;
}

/**
 * Keyed by instrument and instant rather than appended: a provider can echo an alias back, and the
 * primary key would then see the same row twice inside one statement.
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
      // The same instant through the same rule that files the close, stamped now so resolving a
      // session later is an indexed date lookup.
      market_date: marketDateOf(quote.asOf, marketTimeZone),
      price: quote.price,
      fetched_at: quote.fetchedAt,
      payload: archived(quote.payload, matchKey(quote.symbol)),
    });
  }

  return [...batch.values()];
}

/**
 * The observation log: one insert for the whole refresh. `do nothing` is the append-only rule in
 * one clause — an unchanged quote writes nothing, keeping the log a record of distinct instants.
 */
async function writeObservations(db: Kysely<Database>, rows: ObservationRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  // `returning`, not a count query: under `do nothing` a row comes back only for a real insert.
  // Deriving it afterwards would scan an append-only table growing ~half a GB a year.
  const inserted = await db
    .insertInto("price_observation")
    .values(rows)
    .onConflict((conflict) => conflict.columns(["instrument_id", "as_of"]).doNothing())
    .returning("instrument_id")
    .execute();

  return inserted.length;
}

/**
 * The attempt itself, recorded whether or not it wrote a price — what makes the log's silences
 * readable. It shares the prices' transaction, so a refresh that could not commit leaves no row.
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

type BackfillAttempt = {
  instrumentId: string;
  startedAt: Date;
  range: HistoryRange;
  written: number;
  outcome: BackfillOutcome;
  error: string | null;
};

/**
 * {@link writePoll}'s reasoning, with one difference: a provider failure here *is* a committed row.
 * The attempt happened, the next reader needs the text, and the retry clock is this table.
 */
async function writeBackfillAttempt(
  db: Kysely<Database>,
  attempt: BackfillAttempt,
): Promise<void> {
  await db
    .insertInto("price_backfill")
    .values({
      instrument_id: attempt.instrumentId,
      started_at: attempt.startedAt,
      range_from: attempt.range.from,
      range_until: attempt.range.until,
      written: attempt.written,
      outcome: attempt.outcome,
      error: attempt.error,
    })
    .execute();
}

/**
 * How fresh the stored prices are, for the "as of" line (§11). The *oldest* `as_of` among priced
 * holdings — the newest would let ninety-nine fresh instruments hide one failing for a week. Scoped
 * through `holding_valued` to open accounts, or an unowned instrument would make it unclearable.
 */
export async function priceFreshness(
  db: Kysely<Database> = getDb(),
): Promise<{ oldest: Date | null; stale: number; priced: number }> {
  const row = await db
    .selectFrom("holding_valued")
    .innerJoin("quote", "quote.instrument_id", "holding_valued.instrument_id")
    // `fixed` (the seeded USD row, `as_of` written once in 0001) would pin `oldest` to the install
    // timestamp forever; `manual` is as fresh as the person who typed it.
    .where("holding_valued.price_source", "=", "feed")
    .select([
      sql<Date | null>`min(quote.as_of)`.as("oldest"),
      // Distinct instruments, not holdings: one fund in three accounts is one stale thing.
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
 * The as-of caption, rendered in one place: every screen asks the same question and must not answer
 * it differently. The market zone is configuration a component has no business reading.
 */
export async function asOfView(
  marketTimeZone: string,
  db: Kysely<Database> = getDb(),
): Promise<{ stamp: string | null; stale: number }> {
  const { oldest, stale } = await priceFreshness(db);

  return { stamp: oldest === null ? null : marketStampOf(oldest, marketTimeZone), stale };
}
