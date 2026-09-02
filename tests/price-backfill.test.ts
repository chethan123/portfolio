/**
 * The coverage gap, as a question about rows.
 *
 * A backfill exists because a statement describes its own date: the first
 * upload of any instrument new to the system predates that instrument's first
 * close, so `holding_valued_at` finds nothing to price it with and the chart
 * draws cash minus loans for the whole era before the instance was installed
 * (ADR-0011). What decides which instruments are in that state is a query, and
 * a query is only testable against a real database — which is where the risk
 * is, in the `numeric` and `date` handling a mock would erase.
 *
 * The ledger's `check` constraints are tested the same way and for the same
 * reason: they are the only thing that stops a count and an outcome disagreeing
 * years later, and TypeScript cannot enforce a rule Postgres holds.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  BACKFILL_OUTCOMES,
  backfillCloses,
  refreshPrices,
  selectBackfillCandidates,
  type BackfillOutcome,
} from "~/lib/prices.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";

import type { Kysely, KyselyPlugin } from "kysely";
import type { Database } from "~/lib/db.server";
import type {
  HistoryRange,
  PriceProvider,
  ProviderHistory,
  ProviderQuote,
} from "~/lib/price-provider.server";

afterAll(closeTestDatabase);

/** Two days ago — older than the retry interval, whatever the clock says. */
const LONG_AGO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

describe("which instruments carry a coverage gap", () => {
  it(
    "names an instrument that is held and has no close at all",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedPositionSet({
        account,
        asOf: "2024-03-29",
        holdings: [{ instrument, quantity: "10.00000000" }],
      });

      const candidates = await selectBackfillCandidates(db);

      expect(candidates.map((candidate) => candidate.id)).toEqual([instrument.id]);
    }),
  );

  it(
    "names an instrument whose spine starts later than its position history does",
    withDatabase(
      async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose }) => {
        const account = await seedAccount();
        const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
        await seedPositionSet({
          account,
          asOf: "2024-03-29",
          holdings: [{ instrument, quantity: "10.00000000" }],
        });
        // The poller started here — a year after the statement it is asked about.
        await seedDailyClose({ instrument, date: "2025-04-01", close: "250.0000" });

        const candidates = await selectBackfillCandidates(db);

        expect(candidates.map((candidate) => candidate.id)).toEqual([instrument.id]);
      },
    ),
  );

  it(
    "leaves alone an instrument whose spine already reaches its first-held date",
    withDatabase(
      async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose }) => {
        const account = await seedAccount();
        const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
        await seedPositionSet({
          account,
          asOf: "2024-03-29",
          holdings: [{ instrument, quantity: "10.00000000" }],
        });
        await seedDailyClose({ instrument, date: "2024-03-28", close: "250.0000" });

        expect(await selectBackfillCandidates(db)).toEqual([]);
      },
    ),
  );

  it(
    "leaves alone an instrument whose earliest close falls on its first-held date",
    withDatabase(
      async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose }) => {
        const account = await seedAccount();
        const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
        await seedPositionSet({
          account,
          asOf: "2024-03-29",
          holdings: [{ instrument, quantity: "10.00000000" }],
        });
        await seedDailyClose({ instrument, date: "2024-03-29", close: "250.0000" });

        expect(await selectBackfillCandidates(db)).toEqual([]);
      },
    ),
  );

  it(
    "never names a fixed, a manual, or a symbol-less instrument, whatever their positions",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, usdInstrument }) => {
      const account = await seedAccount();
      // The seeded USD row: asking a feed what a dollar costs would overwrite
      // the constant cash and every liability are valued against.
      const usd = await usdInstrument();
      const trust = await seedInstrument({
        symbol: "CIT2045",
        name: "Target 2045 Trust II",
        priceSource: "manual",
      });
      const unnamed = await seedInstrument({ symbol: null, priceSource: "feed" });

      await seedPositionSet({
        account,
        asOf: "2024-03-29",
        holdings: [
          { instrument: usd, quantity: "1000.00000000" },
          { instrument: trust, quantity: "10.00000000" },
          { instrument: unnamed, quantity: "10.00000000" },
        ],
      });

      expect(await selectBackfillCandidates(db)).toEqual([]);
    }),
  );

  it(
    "never names an instrument nobody holds, because a gap is a property of the positions",
    withDatabase(async ({ db, seedInstrument }) => {
      // Created at resolution, before any position set exists — which is why
      // "new instrument" is the wrong trigger.
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      expect(await selectBackfillCandidates(db)).toEqual([]);
    }),
  );

  it(
    "starts the range exactly seven days before the earliest position set",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      // A Saturday. The lead is what finds a close to carry forward onto it.
      await seedPositionSet({
        account,
        asOf: "2024-03-30",
        holdings: [{ instrument, quantity: "10.00000000" }],
      });
      // A later set must not move the range's start.
      await seedPositionSet({
        account,
        asOf: "2024-06-28",
        holdings: [{ instrument, quantity: "12.00000000" }],
      });

      const candidates = await selectBackfillCandidates(db);

      expect(candidates[0]?.rangeFrom).toBe("2024-03-23");
    }),
  );

  it(
    "hands back the symbol as stored, uncorrected",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();
      const instrument = await seedInstrument({ symbol: "vti", priceSource: "feed" });
      await seedPositionSet({
        account,
        asOf: "2024-03-29",
        holdings: [{ instrument, quantity: "10.00000000" }],
      });

      const candidates = await selectBackfillCandidates(db);

      expect(candidates[0]?.symbol).toBe("vti");
    }),
  );
});

describe("the order a batch works in", () => {
  it(
    "puts the deepest gap first, not the first symbol alphabetically",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();
      // Sorted by symbol these come back the other way round, which is what
      // makes the assertion mean something.
      const shallow = await seedInstrument({ symbol: "AAPL", priceSource: "feed" });
      const deep = await seedInstrument({ symbol: "ZM", priceSource: "feed" });

      await seedPositionSet({
        account,
        asOf: "2025-01-31",
        holdings: [{ instrument: shallow, quantity: "1.00000000" }],
      });
      await seedPositionSet({
        account,
        asOf: "2019-06-28",
        holdings: [{ instrument: deep, quantity: "1.00000000" }],
      });

      const candidates = await selectBackfillCandidates(db);

      expect(candidates.map((candidate) => candidate.symbol)).toEqual(["ZM", "AAPL"]);
    }),
  );

  it(
    "breaks a tie on id, so two ticks agree on what next means",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();

      // Enough instruments sharing one date that the grouping's own output
      // order is a hash order rather than the scan order: with two, Postgres
      // happens to emit them by id and the tie-break asserts nothing.
      const instruments = [];
      for (let index = 0; index < 12; index += 1) {
        instruments.push(await seedInstrument({ symbol: `TIE${index}`, priceSource: "feed" }));
      }

      await seedPositionSet({
        account,
        asOf: "2024-03-29",
        holdings: instruments.map((instrument) => ({
          instrument,
          quantity: "1.00000000",
        })),
      });

      const candidates = await selectBackfillCandidates(db);
      const ids = instruments.map((instrument) => instrument.id);

      expect(candidates.map((candidate) => candidate.id)).toEqual(ids.slice(0, candidates.length));
    }),
  );

  it(
    "returns no more than the batch bound, and returns the first in that order",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();

      // More than any plausible bound, so the assertion never names its value:
      // what is fixed is that the bound holds and that it cuts the tail, not
      // the number a module constant happens to carry.
      const ordered: string[] = [];
      for (let index = 0; index < 12; index += 1) {
        const instrument = await seedInstrument({
          symbol: `SYM${index}`,
          priceSource: "feed",
        });
        await seedPositionSet({
          account,
          // Ascending, so the seeding order is the batch order.
          asOf: `2024-0${1 + Math.floor(index / 6)}-${String(1 + (index % 6)).padStart(2, "0")}`,
          holdings: [{ instrument, quantity: "1.00000000" }],
        });
        ordered.push(instrument.id);
      }

      const candidates = await selectBackfillCandidates(db);

      expect(candidates.length).toBeLessThan(ordered.length);
      expect(candidates.map((candidate) => candidate.id)).toEqual(
        ordered.slice(0, candidates.length),
      );
    }),
  );
});

describe("the daily retry clock", () => {
  it(
    "drops the instrument that was attempted and keeps the one that was not",
    withDatabase(
      async ({ db, seedAccount, seedInstrument, seedPositionSet, seedBackfillAttempt }) => {
        const account = await seedAccount();
        const attempted = await seedInstrument({ symbol: "DELISTED", priceSource: "feed" });
        // The second instrument is the assertion: an attempt is a fact about
        // one instrument, and a skip that did not correlate would suppress the
        // whole batch on one delisted ticker.
        const untouched = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

        await seedPositionSet({
          account,
          asOf: "2024-03-29",
          holdings: [
            { instrument: attempted, quantity: "10.00000000" },
            { instrument: untouched, quantity: "10.00000000" },
          ],
        });
        await seedBackfillAttempt({
          instrument: attempted,
          startedAt: new Date(),
          outcome: "no_history",
        });

        const candidates = await selectBackfillCandidates(db);

        expect(candidates.map((candidate) => candidate.id)).toEqual([untouched.id]);
      },
    ),
  );

  it(
    "measures the interval in days, so an unfillable gap costs one request a day",
    withDatabase(
      async ({ db, seedAccount, seedInstrument, seedPositionSet, seedBackfillAttempt }) => {
        const account = await seedAccount();
        const justInside = await seedInstrument({ symbol: "INSIDE", priceSource: "feed" });
        const justOutside = await seedInstrument({ symbol: "OUTSIDE", priceSource: "feed" });

        await seedPositionSet({
          account,
          asOf: "2024-03-29",
          holdings: [
            { instrument: justInside, quantity: "1.00000000" },
            { instrument: justOutside, quantity: "1.00000000" },
          ],
        });

        // An hour either side of the day, which is what pins the interval to a
        // day rather than to any value that merely separates "now" from "long
        // ago" — ADR-0011 promises one request a day for a gap that cannot be
        // filled, and nothing else here asserts the number.
        await seedBackfillAttempt({
          instrument: justInside,
          startedAt: new Date(Date.now() - 23 * 60 * 60 * 1000),
          outcome: "no_history",
        });
        await seedBackfillAttempt({
          instrument: justOutside,
          startedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
          outcome: "no_history",
        });

        const candidates = await selectBackfillCandidates(db);

        expect(candidates.map((candidate) => candidate.id)).toEqual([justOutside.id]);
      },
    ),
  );

  it(
    "keeps an instrument whose last attempt is older than that",
    withDatabase(
      async ({ db, seedAccount, seedInstrument, seedPositionSet, seedBackfillAttempt }) => {
        const account = await seedAccount();
        const instrument = await seedInstrument({ symbol: "DELISTED", priceSource: "feed" });
        await seedPositionSet({
          account,
          asOf: "2024-03-29",
          holdings: [{ instrument, quantity: "10.00000000" }],
        });
        await seedBackfillAttempt({
          instrument,
          startedAt: LONG_AGO,
          outcome: "no_history",
        });

        const candidates = await selectBackfillCandidates(db);

        expect(candidates.map((candidate) => candidate.id)).toEqual([instrument.id]);
      },
    ),
  );
});

describe("what the ledger will and will not record", () => {
  it(
    "accepts every outcome the vocabulary declares",
    withDatabase(async ({ db, seedInstrument, seedBackfillAttempt }) => {
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      // Iterated over the exported object rather than written out, which is
      // what makes this catch drift in the direction that actually happens: a
      // literal added to `BACKFILL_OUTCOMES` and not to the migration's
      // `check`. The two are kept in step by hand, and this is what notices.
      const outcomes = Object.values(BACKFILL_OUTCOMES);

      for (const outcome of outcomes) {
        await seedBackfillAttempt({
          instrument,
          startedAt: LONG_AGO,
          outcome,
          // The two constraints that tie a row's counts to its outcome; a new
          // literal writing neither is the ordinary case.
          written: outcome === BACKFILL_OUTCOMES.filled ? 3 : 0,
          error:
            outcome === BACKFILL_OUTCOMES.providerFailed ? "429 Too Many Requests" : undefined,
        });
      }

      const rows = await db
        .selectFrom("price_backfill")
        .select("outcome")
        .where("instrument_id", "=", instrument.id)
        .execute();

      expect(rows.map((row) => row.outcome).sort()).toEqual([...outcomes].sort());
    }),
  );

  it(
    "refuses an outcome the vocabulary does not know",
    withDatabase(async ({ seedInstrument, seedBackfillAttempt }) => {
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      await expect(
        seedBackfillAttempt({
          instrument,
          startedAt: LONG_AGO,
          // The cast is the point: TypeScript refuses this too, and the
          // assertion is that the constraint refuses it independently — the
          // vocabularies are kept in step by hand, and this is what notices.
          outcome: "backfilled" as BackfillOutcome,
        }),
      ).rejects.toThrow(/price_backfill_outcome_valid/);
    }),
  );

  // One `withDatabase` body per refusal: a constraint refusal aborts the
  // transaction the body runs in, so a second refusal in the same body would
  // fail on the aborted transaction rather than on the rule it states.
  it(
    "refuses a filled attempt that wrote nothing",
    withDatabase(async ({ seedInstrument, seedBackfillAttempt }) => {
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      await expect(
        seedBackfillAttempt({ instrument, startedAt: LONG_AGO, outcome: "filled", written: 0 }),
      ).rejects.toThrow(/price_backfill_filled_wrote/);
    }),
  );

  it(
    "refuses an attempt that wrote something and says it had nothing to write",
    withDatabase(async ({ seedInstrument, seedBackfillAttempt }) => {
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      await expect(
        seedBackfillAttempt({
          instrument,
          startedAt: LONG_AGO,
          outcome: "nothing_to_write",
          written: 1,
        }),
      ).rejects.toThrow(/price_backfill_filled_wrote/);
    }),
  );

  it(
    "refuses a provider failure with no text to read",
    withDatabase(async ({ seedInstrument, seedBackfillAttempt }) => {
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      await expect(
        seedBackfillAttempt({ instrument, startedAt: LONG_AGO, outcome: "provider_failed" }),
      ).rejects.toThrow(/price_backfill_error_reported/);
    }),
  );

  it(
    "refuses error text on an attempt that did not fail",
    withDatabase(async ({ seedInstrument, seedBackfillAttempt }) => {
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      await expect(
        seedBackfillAttempt({
          instrument,
          startedAt: LONG_AGO,
          outcome: "no_history",
          error: "nothing failed",
        }),
      ).rejects.toThrow(/price_backfill_error_reported/);
    }),
  );
});

const NEW_YORK = "America/New_York";

/** What one call to the fake was asked. */
type Asked = { symbol: string; range: HistoryRange };

/**
 * A provider whose history answer each test states, and which records what it
 * was asked.
 *
 * It answers verbatim and corrects nothing — `refresh-quotes.test.ts:25-31`'s
 * reasoning, which holds for history as it does for quotes: a fake that tidies
 * up the test's fixture cannot test what the caller does with a bad one. In
 * particular it returns closes outside the range if a test states them.
 */
function fakeProvider(
  answer: (symbol: string) => ProviderHistory,
  quotes: ProviderQuote[] = [],
): PriceProvider & { asked: Asked[] } {
  const asked: Asked[] = [];

  return {
    asked,
    async getQuotes() {
      return quotes;
    },
    async getDailyCloses(symbol, range) {
      asked.push({ symbol, range });
      return answer(symbol);
    },
  };
}

/** A history of closes, in the shape the adapter hands one over. */
const history = (closes: Array<[string, string]>): ProviderHistory => ({
  status: "ok",
  closes: closes.map(([date, close]) => ({ date, close })),
});

/**
 * A handle whose insert into one table throws before it reaches SQL.
 *
 * A Kysely plugin rather than a Proxy over the instance, which breaks on its
 * private fields; and a JavaScript throw rather than a row the constraint
 * refuses, because under `withDatabase` the test body is one transaction that
 * `inTransaction` joins — a Postgres refusal would abort it and nothing after
 * could be observed (`refresh-quotes.test.ts:765-769` is the precedent).
 *
 * `price_backfill` is the intercept point because only the batch inserts one:
 * `refreshQuotes` writes `price_daily` through the same handle, so a wrapper
 * failing that would fail the quotes step first and the test would never reach
 * the rule it states.
 */
function refusingInsertInto(db: Kysely<Database>, table: string): Kysely<Database> {
  const plugin: KyselyPlugin = {
    transformQuery({ node }) {
      if (
        node.kind === "InsertQueryNode" &&
        "into" in node &&
        node.into?.table.identifier.name === table
      ) {
        throw new Error(`the database refused an insert into ${table}`);
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };

  return db.withPlugin(plugin);
}

/** One instrument, held from `asOf`, priced from the feed. */
async function heldFrom(
  { seedAccount, seedInstrument, seedPositionSet }: Parameters<Parameters<typeof withDatabase>[0]>[0],
  { symbol, asOf }: { symbol: string; asOf: string },
) {
  const account = await seedAccount();
  const instrument = await seedInstrument({ symbol, priceSource: "feed" });
  await seedPositionSet({
    account,
    asOf,
    holdings: [{ instrument, quantity: "10.00000000" }],
  });
  return instrument;
}

describe("what a batch writes to the spine", () => {
  it(
    "writes every trading day the feed returned, at exactly the figure it gave",
    withDatabase(async (context) => {
      const { db } = context;
      const instrument = await heldFrom(context, { symbol: "NVDA", asOf: "2024-06-14" });

      // The un-adjust is the adapter's and is not repeated here: what this
      // asserts is that the writer stores what it was handed, unmultiplied.
      const provider = fakeProvider(() =>
        history([
          ["2024-06-07", "1200.0000"],
          ["2024-06-10", "120.0000"],
        ]),
      );

      const report = await backfillCloses(provider, NEW_YORK, db);

      const rows = await db
        .selectFrom("price_daily")
        .select(["date", "close"])
        .where("instrument_id", "=", instrument.id)
        .orderBy("date")
        .execute();

      expect(rows).toEqual([
        { date: "2024-06-07", close: "1200.0000" },
        { date: "2024-06-10", close: "120.0000" },
      ]);
      expect(report.written).toBe(2);
      expect(report.outcomes.filled).toBe(1);
    }),
  );

  it(
    "leaves a close the running system recorded exactly as it was",
    withDatabase(async (context) => {
      const { db, seedDailyClose } = context;
      const instrument = await heldFrom(context, { symbol: "VTI", asOf: "2024-06-01" });

      // The poller's own row for a finished day. A backfill must never
      // overwrite what the running system recorded live — the feed's later
      // restatement of a close is a revision nobody asked for.
      await seedDailyClose({ instrument, date: "2024-06-10", close: "250.0000" });

      const provider = fakeProvider(() =>
        history([
          ["2024-06-07", "248.0000"],
          ["2024-06-10", "999.9999"],
        ]),
      );

      const report = await backfillCloses(provider, NEW_YORK, db);

      const rows = await db
        .selectFrom("price_daily")
        .select(["date", "close"])
        .where("instrument_id", "=", instrument.id)
        .orderBy("date")
        .execute();

      expect(rows).toEqual([
        { date: "2024-06-07", close: "248.0000" },
        { date: "2024-06-10", close: "250.0000" },
      ]);

      // Counted from the insert's own `returning`: how many rows were new, not
      // how many were offered.
      expect(report.written).toBe(1);

      const ledger = await db
        .selectFrom("price_backfill")
        .select(["written", "outcome"])
        .where("instrument_id", "=", instrument.id)
        .execute();

      expect(ledger).toEqual([{ written: 1, outcome: "filled" }]);
    }),
  );

  it(
    "fills a hole inside an existing series and fabricates nothing around it",
    withDatabase(async (context) => {
      const { db, seedDailyClose } = context;
      const instrument = await heldFrom(context, { symbol: "VTI", asOf: "2024-06-03" });

      // An outage cost the 11th. A hole is never a trigger on its own — it is
      // filled as a side effect of the instrument being fetched for its head
      // gap, which is the half of 0002's reasoning that survives.
      await seedDailyClose({ instrument, date: "2024-06-10", close: "250.0000" });
      await seedDailyClose({ instrument, date: "2024-06-12", close: "252.0000" });

      const provider = fakeProvider(() =>
        history([
          ["2024-06-10", "250.0000"],
          ["2024-06-11", "251.0000"],
          ["2024-06-12", "252.0000"],
        ]),
      );

      await backfillCloses(provider, NEW_YORK, db);

      const rows = await db
        .selectFrom("price_daily")
        .select("date")
        .where("instrument_id", "=", instrument.id)
        .orderBy("date")
        .execute();

      // The 8th and 9th are a weekend the fake did not return: a row for one
      // would state a close that never happened, where carry-forward already
      // answers those dates honestly.
      expect(rows.map((row) => row.date)).toEqual(["2024-06-10", "2024-06-11", "2024-06-12"]);
    }),
  );
});

describe("what a batch records", () => {
  const REFUSALS = [
    ["no-history", "no_history"],
    ["non-usd", "non_usd"],
    ["split-unresolved", "split_unresolved"],
  ] as const;

  for (const [status, outcome] of REFUSALS) {
    it(
      `records ${outcome} for a provider that answered ${status}, and writes no close`,
      withDatabase(async (context) => {
        const { db } = context;
        const instrument = await heldFrom(context, { symbol: "GONE", asOf: "2024-06-01" });

        const provider = fakeProvider(() =>
          status === "non-usd" ? { status, currency: "GBP" } : { status },
        );

        const report = await backfillCloses(provider, NEW_YORK, db);

        const ledger = await db
          .selectFrom("price_backfill")
          .select(["written", "outcome", "error"])
          .where("instrument_id", "=", instrument.id)
          .execute();

        expect(ledger).toEqual([{ written: 0, outcome, error: null }]);
        expect(report.outcomes[outcome]).toBe(1);

        const closes = await db
          .selectFrom("price_daily")
          .select("date")
          .where("instrument_id", "=", instrument.id)
          .execute();
        expect(closes).toEqual([]);
      }),
    );
  }

  it(
    "records a provider failure with its text, and carries on to the next instrument",
    withDatabase(async (context) => {
      const { db, seedAccount, seedInstrument, seedPositionSet } = context;
      const account = await seedAccount();
      const first = await seedInstrument({ symbol: "BROKEN", priceSource: "feed" });
      const second = await seedInstrument({ symbol: "FINE", priceSource: "feed" });

      // Deeper gap first, so the failure is worked before the one that answers.
      await seedPositionSet({
        account,
        asOf: "2024-01-31",
        holdings: [{ instrument: first, quantity: "1.00000000" }],
      });
      await seedPositionSet({
        account,
        asOf: "2024-03-29",
        holdings: [{ instrument: second, quantity: "1.00000000" }],
      });

      const provider = fakeProvider((symbol) => {
        if (symbol === "BROKEN") throw new Error("429 Too Many Requests");
        return history([["2024-03-25", "10.0000"]]);
      });

      const report = await backfillCloses(provider, NEW_YORK, db);

      const ledger = await db
        .selectFrom("price_backfill")
        .select(["instrument_id", "outcome", "written", "error"])
        .orderBy("id")
        .execute();

      expect(ledger).toEqual([
        {
          instrument_id: first.id,
          outcome: "provider_failed",
          written: 0,
          error: "429 Too Many Requests",
        },
        { instrument_id: second.id, outcome: "filled", written: 1, error: null },
      ]);

      // The batch is bounded and the next symbol may be fine.
      expect(report.attempted).toBe(2);
      expect(report.outcomes.provider_failed).toBe(1);
      expect(report.outcomes.filled).toBe(1);
    }),
  );

  it(
    "records nothing_to_write when the spine already held every day the feed returned",
    withDatabase(async (context) => {
      const { db, seedDailyClose } = context;
      const instrument = await heldFrom(context, { symbol: "VTI", asOf: "2024-06-01" });
      await seedDailyClose({ instrument, date: "2024-06-10", close: "250.0000" });

      const provider = fakeProvider(() => history([["2024-06-10", "250.0000"]]));

      const report = await backfillCloses(provider, NEW_YORK, db);

      const ledger = await db
        .selectFrom("price_backfill")
        .select(["written", "outcome"])
        .where("instrument_id", "=", instrument.id)
        .execute();

      expect(ledger).toEqual([{ written: 0, outcome: "nothing_to_write" }]);
      expect(report.written).toBe(0);
    }),
  );

  it(
    "does not offer the instruments it just attempted to the next batch",
    withDatabase(async (context) => {
      const { db } = context;
      await heldFrom(context, { symbol: "VTI", asOf: "2024-06-01" });

      const provider = fakeProvider(() => ({ status: "no-history" }));
      await backfillCloses(provider, NEW_YORK, db);

      // The ledger is the retry clock: an unfillable gap costs one request a
      // day rather than one every tick.
      expect(await selectBackfillCandidates(db)).toEqual([]);
    }),
  );
});

describe("what a batch asks for", () => {
  it(
    "asks one symbol per call, deepest gap first, over a range ending today",
    withDatabase(async (context) => {
      const { db, seedAccount, seedInstrument, seedPositionSet } = context;
      const account = await seedAccount();
      const deep = await seedInstrument({ symbol: "ZM", priceSource: "feed" });
      const shallow = await seedInstrument({ symbol: "AAPL", priceSource: "feed" });

      await seedPositionSet({
        account,
        asOf: "2019-06-28",
        holdings: [{ instrument: deep, quantity: "1.00000000" }],
      });
      await seedPositionSet({
        account,
        asOf: "2024-03-29",
        holdings: [{ instrument: shallow, quantity: "1.00000000" }],
      });

      const provider = fakeProvider(() => ({ status: "no-history" }));

      // The batch takes no clock of its own; the range's end is today's market
      // date, so the test states what today is. 02:00 UTC is still the previous
      // evening in New York — the case a UTC truncation would get wrong, and
      // the reason the end goes through `marketDateOf` rather than `toISOString`.
      vi.useFakeTimers({ now: new Date("2026-06-05T02:00:00Z") });
      try {
        await backfillCloses(provider, NEW_YORK, db);
      } finally {
        vi.useRealTimers();
      }

      expect(provider.asked).toEqual([
        { symbol: "ZM", range: { from: "2019-06-21", until: "2026-06-04" } },
        { symbol: "AAPL", range: { from: "2024-03-22", until: "2026-06-04" } },
      ]);
    }),
  );
});

describe("a refresh, which is quotes and then one batch", () => {
  const quote = (symbol: string): ProviderQuote => ({
    symbol,
    price: "100.0000",
    quoteType: "ETF",
    yieldPct: null,
    annualDividendPerShare: null,
    asOf: new Date("2026-06-05T20:00:00Z"),
    fetchedAt: new Date("2026-06-05T20:00:05Z"),
  });

  it(
    "writes no poll row when no quotes were asked for, and still runs the batch",
    withDatabase(async (context) => {
      const { db } = context;
      const instrument = await heldFrom(context, { symbol: "VTI", asOf: "2024-06-01" });

      const provider = fakeProvider(() => history([["2024-06-10", "250.0000"]]));

      const report = await refreshPrices(provider, NEW_YORK, { quotes: false }, db);

      // A poll is an attempt at quotes, and this attempted none.
      expect(await db.selectFrom("price_poll").selectAll().execute()).toEqual([]);
      expect(report.quotes).toBeNull();
      expect(report.backfill.written).toBe(1);

      const closes = await db
        .selectFrom("price_daily")
        .select("date")
        .where("instrument_id", "=", instrument.id)
        .execute();
      expect(closes).toEqual([{ date: "2024-06-10" }]);
    }),
  );

  it(
    "writes a poll row when quotes were asked for, and runs the batch beside them",
    withDatabase(async (context) => {
      const { db } = context;
      await heldFrom(context, { symbol: "VTI", asOf: "2024-06-01" });

      const provider = fakeProvider(() => history([["2024-06-10", "250.0000"]]), [quote("VTI")]);

      const report = await refreshPrices(provider, NEW_YORK, { quotes: true }, db);

      expect(await db.selectFrom("price_poll").selectAll().execute()).toHaveLength(1);
      expect(report.quotes.priced).toBe(1);
      expect(report.backfill.written).toBe(1);
    }),
  );

  it(
    "reports the quotes it committed when the batch fails against the database",
    withDatabase(async (context) => {
      const { db } = context;
      const instrument = await heldFrom(context, { symbol: "VTI", asOf: "2024-06-01" });

      const provider = fakeProvider(() => history([["2024-06-10", "250.0000"]]), [quote("VTI")]);

      const report = await refreshPrices(
        provider,
        NEW_YORK,
        { quotes: true },
        refusingInsertInto(db, "price_backfill"),
      );

      // The quotes committed before the batch ran, and the button renders an
      // error as "the figures above are unchanged" — which would be false.
      expect(report.quotes.priced).toBe(1);
      expect(report.backfill.batchFailed).toBe(true);

      const quoted = await db
        .selectFrom("quote")
        .select("price")
        .where("instrument_id", "=", instrument.id)
        .executeTakeFirst();
      expect(quoted?.price).toBe("100.0000");

      // The quote's own close for today, written by the step that committed
      // before the batch ran. The batch's own partial write is visible here
      // too, and only here: `withDatabase` hands the body one transaction and
      // `inTransaction` joins it rather than nesting, so there is no rollback
      // boundary inside the batch to observe. In production the handle is not a
      // transaction, `inTransaction` opens a real one, and the attempt's closes
      // and its ledger row commit together or not at all.
      const closes = await db
        .selectFrom("price_daily")
        .select("date")
        .where("instrument_id", "=", instrument.id)
        .execute();
      expect(closes.map((row) => row.date)).toContain("2026-06-05");

      // The attempt that was interrupted leaves no ledger row and is simply
      // next time's candidate.
      expect(await db.selectFrom("price_backfill").selectAll().execute()).toEqual([]);
    }),
  );
});
