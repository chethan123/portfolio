/**
 * The only thing in the application that writes a price. DESIGN.md §6.2
 * splits storage in two; ADR-0006 added a third tier and a sibling that is
 * not a price tier at all:
 *
 *   quote              one row per instrument, overwritten — the intraday tier
 *   price_daily        one row per instrument per trading day — the immutable spine
 *   price_observation  one row per instrument per provider instant — append-only
 *   price_poll         one row per refresh attempt, whether or not it wrote
 *   price_backfill     one row per backfill attempt per instrument (ADR-0011)
 *
 * **Two writers share the spine, and only one of them may rewrite a row.** The
 * quotes' write upserts, deliberately (see below). The backfill's write inserts
 * where absent and never updates: a close the poller recorded live is the
 * record, and the feed's later restatement of it is a revision nobody asked
 * for. That rule is the only thing that lets both write `price_daily` without
 * one silently owning the other's rows.
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
 * The log and the poll record share the quotes' transaction, so a committed
 * fetch lands in all four of those tables or none — what makes the 1D chart's last
 * point and the headline agree on the normal path. Three divergences remain,
 * narrow and deliberate, named so nobody looks for a fourth: a provider
 * re-stating an instant at a different price (`quote` upserts; the deduped
 * observation keeps the first — ADR-0006 accepts it); a hand-typed manual
 * price, once the form exists (a quote with no observation, so the headline
 * moves and the 1D line does not); a provider returning one symbol twice
 * (both become observations; `quote` keeps whichever came last). A refresh
 * whose *quote* writes fail commits nothing, poll row included — an attempt
 * that dies leaves no trace of having been made. The batch that follows is one
 * transaction per instrument rather than one for the batch, so a batch that
 * dies keeps everything its earlier attempts committed.
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
import type {
  HistoryRange,
  PriceProvider,
  ProviderDailyClose,
  ProviderHistory,
  ProviderQuote,
} from "./price-provider.server.ts";

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

/**
 * **The coverage gap itself**, stated once for the two reads that ask it: the
 * batch's {@link selectBackfillCandidates} and the screen's
 * {@link backfillGaps}. A household seeing one list and the batch working from
 * another is the drift worth spending a shared fragment on.
 *
 * Stated the way `holding_valued_at` asks the question — is there a close at or
 * before the day this was first held? `docs/importing-history.md`'s recipe says
 * the same thing as `min(price_daily.date) is null or > min(as_of_date)` over a
 * left join, which is equivalent and ruinous here: that join pairs every
 * holding row with every close of its instrument before the aggregate, which at
 * a hundred instruments over seven years is ~35M inner rows and about 1.4s
 * against ~4ms for this probe — and it grows without bound as the spine this
 * slice exists to fill grows. ARCHITECTURE §10 records the same shape as a bug
 * this repository has fixed once already. The recipe runs by hand; this runs on
 * every tick.
 *
 * It reads `instrument` and `position_set` from whichever query it is dropped
 * into, so both must join those under those names.
 */
const NO_CLOSE_BY_FIRST_HELD = sql<boolean>`not exists (
  select 1
  from price_daily
  where price_daily.instrument_id = instrument.id
    and price_daily.date <= min(position_set.as_of_date)
)`;

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
 * can fill, bounded, and re-shaped for a query that runs on every tick rather
 * than by hand (see the `having` below).
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
    .having(NO_CLOSE_BY_FIRST_HELD)
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

/** One instrument whose spine does not reach as far back as it is held. */
export type BackfillGap = {
  id: string;
  /** Null is itself a reason: a feed instrument nobody has given a ticker. */
  symbol: string | null;
  name: string;
  /** `YYYY-MM-DD`, the earliest position set holding it. */
  firstHeld: IsoDate;
  /** `YYYY-MM-DD`, or null where there is no spine at all yet. */
  firstClose: IsoDate | null;
  /** The most recent attempt, or null where the batch has never tried. */
  lastAttempt: { at: Date; outcome: string; error: string | null } | null;
  /**
   * `feed` or `manual`. Carried because {@link willTry} says *that* the batch
   * will never try a row and this says *why* — a hand-priced trust and a feed
   * instrument nobody has given a ticker are two different things to do about.
   */
  priceSource: string;
  /**
   * Will a batch ever try it? `feed` with a symbol. False for a hand-priced
   * trust and for a feed instrument with no ticker — whose gaps are just as
   * real, which is why they are on the list at all.
   */
  willTry: boolean;
};

/**
 * Every instrument still carrying a coverage gap, for Settings → Prices.
 *
 * The same predicate as {@link selectBackfillCandidates} — shared, not
 * restated — over a wider set: every instrument whose `price_source` is not
 * `fixed`, which is the recipe's own predicate
 * (`docs/importing-history.md:235`). A `manual` instrument and a symbol-less
 * `feed` one have a gap just as real, and this screen is where a person learns
 * the batch will never fill it; the Settings → Instruments form is the answer
 * for those. `fixed` is the seeded USD row, whose 1970 close covers everything.
 *
 * **This answers "why is this date unpriced", not "what will the batch try
 * next".** So no retry skip and no bound: it is the whole list. Ordered as the
 * batch works, so the top of it is what the next refresh picks up.
 *
 * The outcome crosses as the string the ledger stores. The words a person reads
 * for it are the component's business — rendering, not a rule.
 */
export async function backfillGaps(db: Kysely<Database> = getDb()): Promise<BackfillGap[]> {
  const rows = await db
    .selectFrom("instrument")
    .innerJoin("holding", "holding.instrument_id", "instrument.id")
    .innerJoin("position_set", "position_set.id", "holding.position_set_id")
    // One probe of the `(instrument_id, started_at)` index per instrument for
    // the latest attempt, rather than three correlated subqueries for its three
    // columns.
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
      // Where the spine does start, which is the other half of what a person
      // needs to read a distorted stretch of the chart.
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
    // Both columns come from one row of the lateral, so either is the test for
    // "there was an attempt"; TypeScript cannot see that, and reading the one
    // the component needs is the honest narrowing.
    lastAttempt:
      row.started_at === null || row.outcome === null
        ? null
        : { at: row.started_at, outcome: row.outcome, error: row.error },
    priceSource: row.price_source,
    willTry: row.will_try,
  }));
}

/** What one backfill batch did, for the log line and for the tests. */
export type BackfillReport = {
  /** Instruments a history was asked for. */
  attempted: number;
  /** Closes the spine did not already hold, across the batch. */
  written: number;
  /** How many attempts ended each way. */
  outcomes: Record<BackfillOutcome, number>;
  /**
   * Did the batch itself fail — a database error partway through? Always false
   * out of {@link backfillCloses}, which does not catch one; set by
   * {@link refreshPrices}, which does.
   */
  batchFailed: boolean;
};

/**
 * The provider's three refusals, as the ledger spells them. The duplication is
 * deliberate and named where each vocabulary is declared: one is the adapter's
 * answer in the shape `SymbolProbe` uses, the other a `check` constraint's
 * literals. This object is the whole of the mapping.
 */
const LEDGER_OUTCOME: Record<Exclude<ProviderHistory["status"], "ok">, BackfillOutcome> = {
  "no-history": BACKFILL_OUTCOMES.noHistory,
  "non-usd": BACKFILL_OUTCOMES.nonUsd,
  "split-unresolved": BACKFILL_OUTCOMES.splitUnresolved,
};

/**
 * A batch that stopped partway, carrying what it did before it stopped.
 *
 * The counts have to survive the throw, because the batch's log line is the
 * only surface it has: a batch that filled three instruments and then met an
 * unreachable database must not report having done nothing. Thrown rather than
 * returned, so the composition still decides what a caller is told — which is
 * the whole reason the batch does not catch this itself.
 */
class BackfillBatchFailed extends Error {
  override readonly name = "BackfillBatchFailed";
  readonly report: BackfillReport;

  constructor(cause: unknown, report: BackfillReport) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.report = report;
  }
}

/** A batch that has done nothing yet. */
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
 * Fill the spine backwards for a bounded batch of instruments whose position
 * history reaches back behind it (ADR-0011).
 *
 * Sequential, one instrument at a time, awaiting each call before the next:
 * nothing is issued in parallel and nothing is queued, because a queue of
 * pending fetches against an unofficial endpoint is how an instance gets rate
 * limited. The batch bound is the whole of the pacing, and a batch that cannot
 * finish before the next tick is simply resumed by it — the candidate read is
 * re-asked every time and answers with whatever is still open.
 *
 * **A provider failure for one instrument is not a failure of the batch**: it
 * is ledgered with its text and the next symbol is tried, because the next
 * symbol may be fine. **A database failure is**, and is deliberately not caught
 * here — the instrument being written is what would fail again, and the
 * composition above catches it so the batch cannot falsify what the quotes
 * already committed.
 *
 * The range's end is today's market date and is exclusive — the adapter drops
 * every bar filed on or after it, so today's row stays the poller's
 * provisional one. This writer stores what it is handed and checks no date.
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

      // Before the fetch, `refreshQuotes`'s reasoning: the span to the commit is
      // how long the provider took, and an attempt that never commits leaves no
      // row at all.
      const startedAt = new Date();

      let history: ProviderHistory;
      try {
        history = await provider.getDailyCloses(candidate.symbol, range, marketTimeZone);
      } catch (error) {
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

      // The closes and the row describing them, in one transaction: the ledger
      // must not claim a fill that rolled back.
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
    // Re-thrown rather than swallowed: the composition decides what a caller is
    // told. Wrapped only so the counts reach its log line.
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
 * One refresh: quotes, then one bounded backfill batch — the composition every
 * caller shares (the poller's tick, **Refresh now**, and the request an upload
 * fires once it has committed).
 *
 * It does not take the lock: every caller wraps it in {@link withRefreshLock}
 * exactly as they wrapped `refreshQuotes`, so the test seam stays a transaction
 * and the lock stays the caller's decision.
 *
 * **The batch cannot falsify what the quotes did.** A database failure inside
 * the batch is caught and logged here rather than propagated, because
 * `app/routes/refresh.ts` turns anything thrown out of the lock into an error
 * outcome, which the control renders as "Refresh failed. The figures above are
 * unchanged." — false the moment `refreshQuotes` has committed its closes. So a
 * press reports its quotes, a tick logs its quotes' line, and the batch's
 * trouble is the batch's own line. The counts are lost with the throw; the
 * ledger holds what each completed attempt did.
 *
 * A call that asks for no quotes writes no `price_poll` row, by construction:
 * that row is `refreshQuotes`'s, and a poll is an attempt at quotes.
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

    console.error(
      "Price backfill batch failed; the quotes it ran beside are unaffected:",
      stopped ? error.cause : error,
    );

    // The counts of whatever committed before it stopped, so the batch's log
    // line describes what happened rather than reporting a batch that did
    // nothing. Only the attempt it was in the middle of is lost.
    const report = stopped ? error.report : emptyBackfillReport();

    return { quotes: quotesReport, backfill: { ...report, batchFailed: true } };
  }
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
 *
 * Exported rather than moved: the backfill's history call sends the same form
 * (`price-provider.server.ts`), and the rule belongs beside the matcher that
 * states it.
 */
export const matchKey = (symbol: string): string => symbol.trim().toUpperCase();

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

/**
 * The spine's second write path: every trading day the feed returned that the
 * spine does not already hold.
 *
 * `do nothing`, never `do update`, and the invariant is
 * `docs/importing-history.md:283`'s: **a backfill must never overwrite what the
 * running system recorded live.** A separate statement from
 * {@link writeDailyClose}, which must go on upserting for the poller's own
 * writes — the two rules are opposite and both are right.
 *
 * One insert for the whole series, counted from `returning`, so the ledger
 * records how many rows were *new* rather than how many were offered —
 * {@link writeObservations} is the pattern and the reasoning.
 *
 * Nothing is fabricated: only days the provider returned are written, so a
 * weekend or a holiday stays the absence carry-forward already answers
 * honestly. The close is the string the adapter handed over, cast to `numeric`
 * and nothing more — the un-adjust for splits happened there, on `money.ts`'s
 * units, and this multiplies nothing.
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

/** One row bound for the backfill ledger. */
type BackfillAttempt = {
  instrumentId: string;
  startedAt: Date;
  range: HistoryRange;
  written: number;
  outcome: BackfillOutcome;
  error: string | null;
};

/**
 * The attempt itself, recorded whether or not it wrote — {@link writePoll}'s
 * reasoning, with one difference worth naming: **a provider failure here *is* a
 * committed row.** The attempt happened, the next reader needs the text, and
 * the retry clock is this table. Only a database failure leaves nothing, and
 * that attempt is simply next time's candidate.
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
