/**
 * The only price writer (DESIGN.md §6.2, ADR-0006).
 * `price_daily` is dated by the quote's own instant in the market zone, never today's date,
 * and refused outside ±{@link CLOSE_WINDOW_DAYS}. Backfill inserts-where-absent, never
 * overwrites. No clock read: `now` is always a parameter.
 */
import { sql } from "kysely";

import { addDays } from "./chart-range.ts";
import { getDb, getPool, inTransaction, type Database } from "./db.server.ts";
import { marketDateOf, type IsoDate } from "./market-hours.ts";
import {
  DRIFT_EXTENSION_DAYS,
  ProviderUnreachable,
  TRAILING_WINDOW_DAYS,
  matchKey,
} from "./price-provider.server.ts";
import type {
  HistoryRange,
  PriceProvider,
  ProviderDailyClose,
  ProviderDividends,
  ProviderHistory,
  ProviderQuote,
} from "./price-provider.server.ts";

import type { Kysely } from "kysely";
import type pg from "pg";

/** Arbitrary, must not change — and must not equal the migration runner's `7295380114023641`. */
const ADVISORY_LOCK_KEY = "7295380114023642";

/** The whole of the pacing: nothing queues, and the next tick resumes an unfinished batch. */
const BACKFILL_BATCH_SIZE = 5;

/** Skip window after an attempt: an unfillable gap costs one request a day, not one a tick. */
const BACKFILL_RETRY_INTERVAL = "1 day";

/** Reaches back far enough to find a close to carry forward onto a weekend or holiday date. */
const BACKFILL_RANGE_LEAD_DAYS = 7;

/** How far a quote's market date may sit from `now`'s before {@link writeDailyClose} refuses it. */
const CLOSE_WINDOW_DAYS = 7;

/** The sweep's pacing, as {@link BACKFILL_BATCH_SIZE} is the backfill's: no queue, resumed next tick. */
const DIVIDEND_BATCH_SIZE = 5;

/**
 * Re-measure interval. A day count, not an interval string — the bound is computed here and bound as
 * a `Date`. `0019_trailing_dividend.sql`'s backdated `interval '7 days'` is this same 7, kept in
 * step by hand.
 */
const DIVIDEND_STALE_DAYS = 7;

/**
 * Retry after a failed call, matching {@link BACKFILL_RETRY_INTERVAL}: without it one 429 parks an
 * instrument for a week, and a newly priced one reads $0 for that week.
 */
const DIVIDEND_RETRY_DAYS = 1;

/** `null` if a refresh is already running. Dedicated connection — the lock is the session's. */
export async function withRefreshLock<T>(body: () => Promise<T>): Promise<T | null> {
  // Declared outside the `try` so the `finally` can release it whatever throws.
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
    // A pooled connection keeps its session — returned holding the lock, it blocks every refresh.
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
  observed: number;
  providerFailed: boolean;
};

type FeedInstrument = { id: string; symbol: string };

/** `fixed` = seeded USD row, `manual` = no public ticker (§4.3); `feed` symbols may be null. */
const selectFeedInstruments = (db: Kysely<Database>) =>
  db
    .selectFrom("instrument")
    .select(["id", "symbol"])
    .where("price_source", "=", "feed")
    .where("symbol", "is not", null)
    .orderBy("symbol");

/** Kept in step by hand with `price_backfill_outcome_valid` in `0010_price_backfill.sql`. */
export const BACKFILL_OUTCOMES = {
  filled: "filled",
  nothingToWrite: "nothing_to_write",
  noHistory: "no_history",
  nonUsd: "non_usd",
  splitUnresolved: "split_unresolved",
  providerFailed: "provider_failed",
} as const;

export type BackfillOutcome = (typeof BACKFILL_OUTCOMES)[keyof typeof BACKFILL_OUTCOMES];

/** Kept in step by hand with `quote_trailing_dividend_outcome_valid` in `0019_trailing_dividend.sql`. */
export const DIVIDEND_OUTCOMES = {
  ok: "ok",
  noData: "no_data",
  nonUsd: "non_usd",
  unreadable: "unreadable",
  providerFailed: "provider_failed",
} as const;

export type DividendOutcome = (typeof DIVIDEND_OUTCOMES)[keyof typeof DIVIDEND_OUTCOMES];

/**
 * The coverage gap, stated once for both readers so they cannot drift. A `having` predicate: reads
 * `instrument` and `position_set` from the query it is dropped into, and is first-held only while
 * grouping is one row per instrument. A probe, not a left join — 4ms against 1.4s.
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
  rangeFrom: IsoDate;
};

/** Next batch: instruments whose spine starts after the earliest position set holding them. */
export async function selectBackfillCandidates(
  db: Kysely<Database> = getDb(),
): Promise<BackfillCandidate[]> {
  const rows = await db
    .selectFrom("instrument")
    .innerJoin("holding", "holding.instrument_id", "instrument.id")
    .innerJoin("position_set", "position_set.id", "holding.position_set_id")
    .where("instrument.price_source", "=", "feed")
    .where("instrument.symbol", "is not", null)
    // Retry clock, before the grouping: attempted in the last day is not a candidate.
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
      sql<IsoDate>`min(position_set.as_of_date) - cast(${BACKFILL_RANGE_LEAD_DAYS} as integer)`.as(
        "range_from",
      ),
    ])
    // Deepest gap first, then id, so two ticks agree on "next" rather than racing a tie.
    .orderBy(sql`min(position_set.as_of_date)`)
    .orderBy("instrument.id")
    .limit(BACKFILL_BATCH_SIZE)
    .execute();

  return rows.map((row) => ({
    id: String(row.id),
    // Narrowing only: the query refuses null symbols, which TS cannot see through a `where`.
    symbol: row.symbol as string,
    rangeFrom: row.range_from,
  }));
}

export type BackfillGap = {
  id: string;
  /** Null is itself a reason: a feed instrument nobody has given a ticker. */
  symbol: string | null;
  name: string;
  firstHeld: IsoDate;
  firstClose: IsoDate | null;
  lastAttempt: { at: Date; outcome: string; error: string | null } | null;
  priceSource: string;
  /** `feed` with a symbol. False rows have gaps just as real, which is why they are listed. */
  willTry: boolean;
};

/** Settings → Prices. {@link selectBackfillCandidates}'s predicate without the retry skip or the batch bound. */
export async function backfillGaps(db: Kysely<Database> = getDb()): Promise<BackfillGap[]> {
  const rows = await db
    .selectFrom("instrument")
    .innerJoin("holding", "holding.instrument_id", "instrument.id")
    .innerJoin("position_set", "position_set.id", "holding.position_set_id")
    // One lateral probe of `(instrument_id, started_at)`, not three correlated subqueries.
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

const LEDGER_OUTCOME: Record<Exclude<ProviderHistory["status"], "ok">, BackfillOutcome> = {
  "no-history": BACKFILL_OUTCOMES.noHistory,
  "non-usd": BACKFILL_OUTCOMES.nonUsd,
  "split-unresolved": BACKFILL_OUTCOMES.splitUnresolved,
};

/** Every batch report: {@link settle} turns a throw into one of these with the flag set. */
type BatchReport = { batchFailed: boolean };

/** Carries the counts past the throw: the batch's log line is its only surface. */
class BatchFailed<R extends BatchReport> extends Error {
  readonly report: R;

  constructor(cause: unknown, report: R) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.report = report;
  }
}

class BackfillBatchFailed extends BatchFailed<BackfillReport> {
  override readonly name = "BackfillBatchFailed";
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
 * Fill the spine backwards for a bounded batch (ADR-0011). Sequential — a queue against an
 * unofficial endpoint is how an instance gets rate limited. The range ends at `now`'s market
 * date, exclusive, and every ledger row is stamped `now`. A provider failure is ledgered and the
 * next symbol tried; a database failure is not caught here. `ProviderUnreachable` escapes
 * unledgered, wrapped once (price-worker spec §3.1).
 */
export async function backfillCloses(
  provider: PriceProvider,
  marketTimeZone: string,
  now: Date,
  db: Kysely<Database> = getDb(),
): Promise<BackfillReport> {
  const until = marketDateOf(now, marketTimeZone);
  const candidates = await selectBackfillCandidates(db);

  const report = emptyBackfillReport();

  try {
    for (const candidate of candidates) {
      const range: HistoryRange = { from: candidate.rangeFrom, until };

      let history: ProviderHistory;
      try {
        history = await provider.getDailyCloses(candidate.symbol, range, marketTimeZone);
      } catch (error) {
        // Before anything is ledgered; the outer catch wraps it once.
        if (error instanceof ProviderUnreachable) throw error;

        const outcome = BACKFILL_OUTCOMES.providerFailed;

        await inTransaction(db, (trx) =>
          writeBackfillAttempt(trx, {
            instrumentId: candidate.id,
            startedAt: now,
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
            startedAt: now,
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

      // One transaction: the ledger must not claim a fill that rolled back.
      const written = await inTransaction(db, async (trx) => {
        const count = await writeBackfilledCloses(trx, candidate.id, history.closes);

        await writeBackfillAttempt(trx, {
          instrumentId: candidate.id,
          startedAt: now,
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
    // Wrapped only so the counts reach the composition's log line.
    throw new BackfillBatchFailed(error, report);
  }

  return report;
}

type DividendCandidate = {
  id: string;
  /** As stored. The adapter upper-cases it to send; nothing here rewrites it. */
  symbol: string;
};

/**
 * Next batch: **currently held** feed instruments with a symbol, at a nonzero quantity, whose rate
 * is unmeasured or due. Reads `holding_valued` rather than the `holding`/`position_set` join
 * {@link selectBackfillCandidates} uses — ARCHITECTURE.md §4.2 carries why that read is sanctioned
 * and what it buys.
 *
 * `holding_valued` is one row per account x instrument, so the `groupBy` is what makes `limit` bound
 * instruments: without it an ETF held in three accounts takes three slots and is fetched three
 * times in one tick.
 */
export async function selectDividendCandidates(
  db: Kysely<Database>,
  now: Date,
): Promise<DividendCandidate[]> {
  // Bound as `Date`s, not `${now} - interval '7 days'`: an untyped parameter minus an interval is
  // ambiguous across two Postgres type categories and fails with "operator is not unique".
  const staleBefore = new Date(now.getTime() - DIVIDEND_STALE_DAYS * 86_400_000);
  const failedBefore = new Date(now.getTime() - DIVIDEND_RETRY_DAYS * 86_400_000);

  const rows = await db
    .selectFrom("holding_valued")
    .innerJoin("quote", "quote.instrument_id", "holding_valued.instrument_id")
    .where("holding_valued.price_source", "=", "feed")
    .where("holding_valued.symbol", "is not", null)
    // `!= 0`, never `> 0`: a negative quantity is a liability, which owes a dividend as surely as
    // an asset earns one. Zero is the waste — a turnaround is recorded as zero first
    // (`positions.server.ts`), and the view keeps that row, so "currently held" alone would cost a
    // request a week forever for a position that is gone.
    .where("holding_valued.quantity", "!=", "0")
    // Two tiers: a failed call is retried tomorrow, every answer re-measured in a week. `is
    // distinct from` puts a null outcome — a rate the migration carried over — in the second.
    .where((eb) =>
      eb.or([
        eb("quote.trailing_dividend_as_of", "is", null),
        eb.and([
          eb("quote.trailing_dividend_outcome", "=", DIVIDEND_OUTCOMES.providerFailed),
          eb("quote.trailing_dividend_as_of", "<=", failedBefore),
        ]),
        eb.and([
          eb(
            "quote.trailing_dividend_outcome",
            "is distinct from",
            DIVIDEND_OUTCOMES.providerFailed,
          ),
          eb("quote.trailing_dividend_as_of", "<=", staleBefore),
        ]),
      ]),
    )
    .groupBy([
      "holding_valued.instrument_id",
      "holding_valued.symbol",
      "quote.trailing_dividend_as_of",
    ])
    .select(["holding_valued.instrument_id", "holding_valued.symbol"])
    // Round-robin by oldest stamp, never `(as_of is null) desc, id`: at weekly capacity below the
    // instrument count that never converges — low ids re-stale and are re-picked, high ids never run.
    .orderBy("quote.trailing_dividend_as_of", (ob) => ob.asc().nullsFirst())
    .orderBy("holding_valued.instrument_id")
    .limit(DIVIDEND_BATCH_SIZE)
    .execute();

  return rows.map((row) => ({
    id: String(row.instrument_id),
    // Narrowing only: the query refuses null symbols, which TS cannot see through a `where`.
    symbol: row.symbol as string,
  }));
}

export type DividendReport = {
  attempted: number;
  /** Rates replaced. A refusal is not one: it leaves the last measured rate standing. */
  written: number;
  refused: number;
  /** Calls that failed, which the provider answers for in {@link DIVIDEND_OUTCOMES.providerFailed}. */
  failed: number;
  /** A database error partway through. Always false out of {@link refreshTrailingDividends}. */
  batchFailed: boolean;
};

class DividendBatchFailed extends BatchFailed<DividendReport> {
  override readonly name = "DividendBatchFailed";
}

const emptyDividendReport = (): DividendReport => ({
  attempted: 0,
  written: 0,
  refused: 0,
  failed: 0,
  batchFailed: false,
});

/** {@link ProviderDividends} plus the one outcome only the caller can see: the call threw. */
type DividendResult = ProviderDividends | { status: "provider-failed" };

const OUTCOME_OF_RESULT: Record<Exclude<DividendResult["status"], "ok">, DividendOutcome> = {
  "no-data": DIVIDEND_OUTCOMES.noData,
  "non-usd": DIVIDEND_OUTCOMES.nonUsd,
  unreadable: DIVIDEND_OUTCOMES.unreadable,
  "provider-failed": DIVIDEND_OUTCOMES.providerFailed,
};

/**
 * Measure the trailing year's distributions for a bounded batch. Sequential, as
 * {@link backfillCloses} is: a queue against an unofficial endpoint is how an instance gets rate
 * limited. `ProviderUnreachable` escapes before any write; **every other outcome, a throw included,
 * writes the stamp** — a symbol that throws every tick would otherwise hold the head of a
 * nulls-first queue forever and starve the sweep. A database failure is not caught here.
 */
export async function refreshTrailingDividends(
  provider: PriceProvider,
  marketTimeZone: string,
  now: Date,
  db: Kysely<Database> = getDb(),
): Promise<DividendReport> {
  // The widened bound, so the extension's events reach the parser at all; the parser derives the
  // 365-day core from it and only falls back to the extension when the core is empty.
  const since = addDays(
    marketDateOf(now, marketTimeZone),
    -(TRAILING_WINDOW_DAYS + DRIFT_EXTENSION_DAYS),
  );
  const candidates = await selectDividendCandidates(db, now);

  const report = emptyDividendReport();

  try {
    for (const candidate of candidates) {
      let result: DividendResult;
      try {
        result = await provider.getTrailingDividend(candidate.symbol, since, marketTimeZone);
      } catch (error) {
        // Before anything is written; the outer catch wraps it once.
        if (error instanceof ProviderUnreachable) throw error;

        result = { status: "provider-failed" };
      }

      await writeTrailingDividend(db, candidate.id, result, now);

      report.attempted += 1;
      if (result.status === "ok") report.written += 1;
      else if (result.status === "provider-failed") report.failed += 1;
      else report.refused += 1;
    }
  } catch (error) {
    // Wrapped only so the counts reach the composition's log line.
    throw new DividendBatchFailed(error, report);
  }

  return report;
}

/**
 * One `update` per instrument, never one transaction over the batch: a statement is atomic on its
 * own, and a batch would let one bad row roll back four good ones. A refusal writes the stamp and
 * the outcome only — the last measured rate stands, and the outcome, not the value, is what tells a
 * measured rate from a carried one.
 */
async function writeTrailingDividend(
  db: Kysely<Database>,
  instrumentId: string,
  result: DividendResult,
  now: Date,
): Promise<void> {
  await db
    .updateTable("quote")
    .set(
      result.status === "ok"
        ? {
            trailing_dividend_per_share: result.perShare,
            trailing_dividend_as_of: now,
            trailing_dividend_outcome: DIVIDEND_OUTCOMES.ok,
          }
        : {
            trailing_dividend_as_of: now,
            trailing_dividend_outcome: OUTCOME_OF_RESULT[result.status],
          },
    )
    .where("instrument_id", "=", instrumentId)
    .execute();
}

export type RefreshPricesReport = {
  quotes: RefreshReport | null;
  backfill: BackfillReport;
  /** Null when the sweep did not run, as `quotes` is null when quotes are skipped. */
  dividends: DividendReport | null;
};

/**
 * One step after the quotes, reported rather than thrown: once `refreshQuotes` has committed, "the
 * figures above are unchanged" would be false. A carried report keeps the counts from what the
 * batch did get through; `carrier` is a parameter so they come back typed.
 */
async function settle<R extends BatchReport>(
  label: string,
  carrier: new (cause: unknown, report: R) => BatchFailed<R>,
  empty: R,
  step: () => Promise<R>,
): Promise<R> {
  try {
    return await step();
  } catch (error) {
    const stopped = error instanceof carrier ? error : null;
    const cause = stopped === null ? error : stopped.cause;

    if (cause instanceof ProviderUnreachable) {
      console.warn(`${label} batch failed; the provider was unreachable:`, cause.message);
    } else {
      console.error(`${label} batch failed; the quotes it ran beside are unaffected:`, cause);
    }

    const report = stopped === null ? empty : stopped.report;
    report.batchFailed = true;
    return report;
  }
}

/**
 * One refresh: quotes, then one bounded backfill batch, then one bounded dividend sweep. Does not
 * take the lock — every caller wraps it in {@link withRefreshLock}. Each step after the quotes is
 * {@link settle}d separately, not both under one `try`: one would let a backfill failure skip the
 * sweep and lose which step failed. `dividends` is never defaulted, so a new caller must say
 * whether it waits for the sweep.
 */
export async function refreshPrices(
  provider: PriceProvider,
  marketTimeZone: string,
  now: Date,
  { quotes, dividends }: { quotes: boolean; dividends: boolean },
  db: Kysely<Database> = getDb(),
): Promise<RefreshPricesReport> {
  const quotesReport = quotes ? await refreshQuotes(provider, marketTimeZone, now, db) : null;

  const backfill = await settle("Price backfill", BackfillBatchFailed, emptyBackfillReport(), () =>
    backfillCloses(provider, marketTimeZone, now, db),
  );

  return {
    quotes: quotesReport,
    backfill,
    dividends: dividends
      ? await settle("Price dividends", DividendBatchFailed, emptyDividendReport(), () =>
          refreshTrailingDividends(provider, marketTimeZone, now, db),
        )
      : null,
  };
}

/** A map to a *list*: `instrument.symbol` has no unique constraint (§4.1). */
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
 * Fetch every feed instrument's price and store it. One transaction — not for atomicity against
 * readers (`holding_valued` tolerates a half-priced portfolio) but so a crash midway cannot leave
 * instruments marked stale by a run that never got to unmark them.
 *
 * @param marketTimeZone decides which calendar day a quote's instant belongs to, nothing else.
 */
export async function refreshQuotes(
  provider: PriceProvider,
  marketTimeZone: string,
  now: Date,
  db: Kysely<Database> = getDb(),
): Promise<RefreshReport> {
  const instruments = await selectFeedInstruments(db).execute();

  const feed: FeedInstrument[] = instruments.map((row) => ({
    id: String(row.id),
    // Narrowing only: the query refuses null symbols, which TS cannot see through a `where`.
    symbol: row.symbol as string,
  }));

  const lookup = bySymbol(feed);

  // No early return: ADR-0006 wants a poll row even with nothing to price. A provider throw is
  // caught (§6.1) — propagating leaves `is_stale` as it was, showing old prices as current.
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

  const matched: Array<{ instrumentId: string; quote: ProviderQuote }> = [];
  for (const quote of quotes) {
    for (const instrument of lookup.get(matchKey(quote.symbol)) ?? []) {
      matched.push({ instrumentId: instrument.id, quote });
    }
  }

  return inTransaction(db, async (trx) => {
    const observed = await writeObservations(trx, observationsOf(matched, marketTimeZone));

    const pricedIds = new Set<string>();
    let closes = 0;
    const windowSkipped: string[] = [];

    for (const { instrumentId, quote } of matched) {
      await writeQuote(trx, instrumentId, quote);
      await writeQuoteType(trx, instrumentId, quote);
      const wroteClose = await writeDailyClose(trx, instrumentId, quote, marketTimeZone, now);
      pricedIds.add(instrumentId);
      if (wroteClose) {
        closes += 1;
      } else {
        // Matched form, not the feed's spelling — a symbol with newlines must not break the log.
        windowSkipped.push(matchKey(quote.symbol));
      }
    }

    if (windowSkipped.length > 0) {
      console.warn(
        `Price close skipped, more than ${CLOSE_WINDOW_DAYS} days from today's market date: ${windowSkipped.join(", ")}`,
      );
    }

    // §6.2: the last known price is kept, used and flagged, never zeroed.
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

    await writePoll(trx, now, report);

    return report;
  });
}

/**
 * Intraday tier, overwritten. A successful write is the only thing that clears `is_stale`.
 * The five named columns are load-bearing: a `doUpdateSet(values)` covering every column would
 * reset `trailing_dividend_as_of` on every poll and dismantle the sweep's retry clock.
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
 * Keeps the stocks-versus-funds split (§4.4) true of rows created before the column. An omitted
 * field leaves the stored value alone; `is distinct from`, not `<>`, so a stored null is a change.
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

/** Upsert, so an intraday poll settles on the close. Refuses outside ±{@link CLOSE_WINDOW_DAYS}. */
async function writeDailyClose(
  db: Kysely<Database>,
  instrumentId: string,
  quote: ProviderQuote,
  marketTimeZone: string,
  now: Date,
): Promise<boolean> {
  const date = marketDateOf(quote.asOf, marketTimeZone);
  const today = marketDateOf(now, marketTimeZone);

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

/** `do nothing`, never `do update`: a backfill must not overwrite what was recorded live. */
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

/** Payload cap: one row per distinct instant, so a jittering timestamp archives every tick. */
const ARCHIVE_PAYLOAD_CAP = 32 * 1024;

/**
 * The provider's raw entry as the `jsonb` column's text, or null. A payload that will not serialise
 * is dropped with a log line, never thrown. `Buffer.byteLength`, not `.length` — the cap is bytes.
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

/** Keyed by instrument and instant — an echoed alias would repeat a key in one statement. */
function observationsOf(
  matched: ReadonlyArray<{ instrumentId: string; quote: ProviderQuote }>,
  marketTimeZone: string,
): ObservationRow[] {
  const batch = new Map<string, ObservationRow>();

  for (const { instrumentId, quote } of matched) {
    batch.set(`${instrumentId} at ${quote.asOf.toISOString()}`, {
      instrument_id: instrumentId,
      as_of: quote.asOf,
      market_date: marketDateOf(quote.asOf, marketTimeZone),
      price: quote.price,
      fetched_at: quote.fetchedAt,
      payload: archived(quote.payload, matchKey(quote.symbol)),
    });
  }

  return [...batch.values()];
}

/** One insert per refresh; `do nothing` keeps the log to distinct instants. */
async function writeObservations(db: Kysely<Database>, rows: ObservationRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  // `returning`, not a count: under `do nothing` a row comes back only for a real insert.
  const inserted = await db
    .insertInto("price_observation")
    .values(rows)
    .onConflict((conflict) => conflict.columns(["instrument_id", "as_of"]).doNothing())
    .returning("instrument_id")
    .execute();

  return inserted.length;
}

/** The attempt, written whether or not it priced; shares the prices' transaction. */
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

/** {@link writePoll}, except a provider failure here commits — the retry clock is this table. */
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
