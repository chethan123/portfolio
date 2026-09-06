/**
 * A backfill exists because a statement describes its own date: an instrument new to the
 * system predates its own first close, so `holding_valued_at` finds nothing to price it with
 * before the instance was installed (ADR-0011). Which instruments are in that state is a query,
 * testable only against real Postgres — same reason the ledger's `check` constraints are here.
 */
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  BACKFILL_OUTCOMES,
  backfillCloses,
  backfillGaps,
  refreshPrices,
  selectBackfillCandidates,
  type BackfillOutcome,
} from "~/lib/prices.server";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "./support/database.ts";
import { makeFixtures } from "./support/fixtures.ts";

import { createDatabase } from "~/lib/db.server";
import { ProviderUnreachable } from "~/lib/price-provider.server";

import { socketProvider } from "~/lib/provider-socket.server";
import { startWorker } from "../server/price-worker.ts";

import type { Kysely, KyselyPlugin } from "kysely";
import type { TestContext } from "./support/database.ts";
import type { Database } from "~/lib/db.server";
import type { HistoryRange, PriceProvider, ProviderHistory, ProviderQuote } from "~/lib/price-provider.server";
import type { YahooClient } from "../server/yahoo-client.ts";

// socketProvider() reads the socket path through getConfig(), which memoises its first read —
// set before any test can reach it (tests/price-poller.test.ts:37's precedent for DATABASE_URL)
process.env.PRICE_WORKER_SOCKET = join(tmpdir(), `pb-${randomBytes(4).toString("hex")}.sock`);

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
        // poller started here — a year after the statement it is asked about
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
      // asking a feed what a dollar costs would overwrite the constant cash/liabilities are valued against
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
      // created at resolution, before any position set exists — why "new instrument" is the wrong trigger
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      expect(await selectBackfillCandidates(db)).toEqual([]);
    }),
  );

  it(
    "starts the range exactly seven days before the earliest position set",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      // a Saturday — the lead is what finds a close to carry forward onto it
      await seedPositionSet({
        account,
        asOf: "2024-03-30",
        holdings: [{ instrument, quantity: "10.00000000" }],
      });
      // a later set must not move the range's start
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
      // sorted by symbol these come back the other way round — what makes the assertion mean something
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

      // enough sharing one date that output is hash order not scan order — with two, id order proves nothing
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

      // more than any plausible bound — fixes that the bound holds and cuts the tail, not the exact number
      const ordered: string[] = [];
      for (let index = 0; index < 12; index += 1) {
        const instrument = await seedInstrument({
          symbol: `SYM${index}`,
          priceSource: "feed",
        });
        await seedPositionSet({
          account,
          // ascending, so the seeding order is the batch order
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
        // the assertion: an attempt is a fact about one instrument, not a suppressor of the whole batch
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

        // an hour either side of the day pins the interval to a day, not a looser "long ago" — ADR-0011
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

      // iterated over the exported object — catches a literal added to BACKFILL_OUTCOMES but not the check constraint
      const outcomes = Object.values(BACKFILL_OUTCOMES);

      for (const outcome of outcomes) {
        await seedBackfillAttempt({
          instrument,
          startedAt: LONG_AGO,
          outcome,
          // the two constraints tying a row's counts to its outcome; a new literal writing neither is the ordinary case
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
          // cast is the point: TypeScript refuses this too; asserts the constraint refuses it independently
          outcome: "backfilled" as BackfillOutcome,
        }),
      ).rejects.toThrow(/price_backfill_outcome_valid/);
    }),
  );

  // one withDatabase body per refusal — a constraint refusal aborts its transaction, so a
  // second refusal in the same body fails on the aborted transaction, not the rule stated
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

type Asked = { symbol: string; range: HistoryRange };

// answers verbatim and corrects nothing (refresh-quotes.test.ts:25-31's reasoning) — a fake
// that tidies the fixture can't test what the caller does with a bad one
function fakeProvider(
  answer: (symbol: string) => ProviderHistory,
  quotes: ProviderQuote[] = [],
): PriceProvider & { asked: Asked[]; concurrency: { peak: number } } {
  const asked: Asked[] = [];

  // how many history calls were ever open at once — a parallel-dispatching caller would reach
  // the candidate count here, which recording call order alone couldn't tell apart
  const concurrency = { peak: 0 };
  let open = 0;

  return {
    asked,
    concurrency,
    async getQuotes() {
      return quotes;
    },
    async getDailyCloses(symbol, range) {
      asked.push({ symbol, range });

      open += 1;
      concurrency.peak = Math.max(concurrency.peak, open);
      // a turn of the loop, so overlapping callers actually overlap here
      await Promise.resolve();
      open -= 1;

      return answer(symbol);
    },
  };
}

const history = (closes: Array<[string, string]>): ProviderHistory => ({
  status: "ok",
  closes: closes.map(([date, close]) => ({ date, close })),
});

/**
 * A Kysely plugin, not a Proxy (breaks on private fields); throws in JS rather than via a
 * constraint, since a Postgres refusal here would abort the whole withDatabase transaction and
 * hide everything after it (refresh-quotes.test.ts:1022-1049's precedent).
 */
function refusingInsertInto(
  db: Kysely<Database>,
  table: string,
  { after = 0 }: { after?: number } = {},
): Kysely<Database> {
  let seen = 0;

  const plugin: KyselyPlugin = {
    transformQuery({ node }) {
      if (
        node.kind === "InsertQueryNode" &&
        "into" in node &&
        node.into?.table.identifier.name === table
      ) {
        // `after` lets some attempts commit before one fails, to check what the report says about them
        seen += 1;
        if (seen > after) throw new Error(`the database refused an insert into ${table}`);
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };

  return db.withPlugin(plugin);
}

// one instrument, held from `asOf`, priced from the feed
async function heldFrom(
  { seedAccount, seedInstrument, seedPositionSet }: TestContext,
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

      // un-adjust is the adapter's job, not repeated here — asserts the writer stores what it's handed, unmultiplied
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

      // poller's own row for a finished day — a backfill must never overwrite live-recorded data
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

      // counted from the insert's own `returning` — rows new, not rows offered
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

      // an outage cost the 11th — a hole is never a trigger on its own, only filled as a side
      // effect of fetching the instrument for its head gap (0002's surviving half)
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

      // 8th/9th are a weekend the fake didn't return — a row for either would state a close
      // that never happened, where carry-forward already answers those dates honestly
      expect(rows.map((row) => row.date)).toEqual(["2024-06-10", "2024-06-11", "2024-06-12"]);
    }),
  );

  it(
    "drops a lone bar dated before range.from rather than letting it close the gap for good",
    withDatabase(async (context) => {
      const { db } = context;
      const instrument = await heldFrom(context, { symbol: "OLDCO", asOf: "2024-06-14" });

      // real adapter, not the fake above: the floor lives in toProviderHistory, which only the
      // real adapter runs; socketProvider() never takes an injected client, so this drives a
      // real worker on a real socket (mirrors price-provider.test.ts's own shape)
      const yahoo: YahooClient = {
        quote: async () => [],
        chart: async () => ({
          meta: { currency: "USD" },
          quotes: [{ date: new Date("1971-01-01T13:30:00Z"), close: 1 }],
        }),
      };
      const worker = await startWorker({ socketPath: process.env.PRICE_WORKER_SOCKET!, yahoo });

      let report: Awaited<ReturnType<typeof backfillCloses>>;
      try {
        report = await backfillCloses(socketProvider(), NEW_YORK, db);
      } finally {
        await new Promise<void>((resolve) => worker.close(() => resolve()));
      }

      // "no-history" exactly as an empty chart would answer — a pre-range-only response is indistinguishable from none
      expect(
        await db.selectFrom("price_daily").selectAll().where("instrument_id", "=", instrument.id).execute(),
      ).toEqual([]);
      expect(report.outcomes.no_history).toBe(1);

      // ledger says no_history but the gap is real and never closes — stays on Settings → Prices
      const gaps = await backfillGaps(db);
      expect(gaps.map((gap) => gap.id)).toContain(instrument.id);
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

      // deeper gap first, so the failure is worked before the one that answers
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

      // the batch is bounded and the next symbol may be fine
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

      // the ledger is the retry clock — an unfillable gap costs one request a day, not one every tick
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

      // range's end is today's market date; 02:00 UTC is still the previous evening in NY —
      // the case a UTC truncation gets wrong, why the end goes through marketDateOf. Only
      // fakes Date: pg times connects with setTimeout on this real connection (price-poller.test.ts:156-163)
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-06-05T02:00:00Z") });
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
  it(
    "opens one history call at a time, so nothing queues against the endpoint",
    withDatabase(async (context) => {
      const { db, seedAccount, seedInstrument, seedPositionSet } = context;
      const account = await seedAccount();

      for (let index = 0; index < 3; index += 1) {
        const instrument = await seedInstrument({ symbol: `SYM${index}`, priceSource: "feed" });
        await seedPositionSet({
          account,
          asOf: `2024-0${index + 1}-15`,
          holdings: [{ instrument, quantity: "1.00000000" }],
        });
      }

      const provider = fakeProvider(() => ({ status: "no-history" }));

      await backfillCloses(provider, NEW_YORK, db);

      expect(provider.asked).toHaveLength(3);
      // the batch bound is the pacing — not the library's request queue, not the endpoint's patience
      expect(provider.concurrency.peak).toBe(1);
    }),
  );

  it(
    "stamps the attempt when the fetch began, not when it answered",
    withDatabase(async (context) => {
      const { db } = context;
      const instrument = await heldFrom(context, { symbol: "VTI", asOf: "2024-06-01" });

      const began = new Date("2026-06-05T14:00:00Z");

      // span between the two is how long the provider took — why the earlier one is recorded (price_poll's reasoning)
      const provider = fakeProvider(() => {
        vi.setSystemTime(new Date("2026-06-05T14:00:30Z"));
        return history([["2024-06-10", "250.0000"]]);
      });

      vi.useFakeTimers({ toFake: ["Date"], now: began });
      try {
        await backfillCloses(provider, NEW_YORK, db);
      } finally {
        vi.useRealTimers();
      }

      const row = await db
        .selectFrom("price_backfill")
        .select("started_at")
        .where("instrument_id", "=", instrument.id)
        .executeTakeFirstOrThrow();

      expect(row.started_at).toEqual(began);
    }),
  );
});

describe("the boundary each attempt commits in", () => {
  it("commits an attempt's closes with its ledger row, or neither", async () => {
    // can't run inside withDatabase: inTransaction joins a caller's transaction rather than
    // nesting, so there's no per-attempt boundary to observe. Drives a real handle instead,
    // production's shape, and cleans up after itself (price-poller.test.ts does this too).
    const committing = createDatabase(TEST_DATABASE_URL);
    const fixtures = makeFixtures(committing);

    let planted:
      | {
          personId: string;
          accountId: string;
          classificationId: string;
          instrumentId: string;
          positionSetId: string;
        }
      | undefined;

    try {
      const person = await fixtures.seedPerson();
      const account = await fixtures.seedAccount({ owner: person });
      const classification = await fixtures.seedClassification();
      const instrument = await fixtures.seedInstrument({
        symbol: "ATOMIC",
        priceSource: "feed",
        classification,
      });
      const set = await fixtures.seedPositionSet({
        account,
        asOf: "2024-06-01",
        holdings: [{ instrument, quantity: "1.00000000" }],
      });

      planted = {
        personId: person.id,
        accountId: account.id,
        classificationId: classification.id,
        instrumentId: instrument.id,
        positionSetId: set.id,
      };

      const provider = fakeProvider(() => history([["2024-06-10", "250.0000"]]));

      await expect(
        backfillCloses(provider, NEW_YORK, refusingInsertInto(committing, "price_backfill")),
      ).rejects.toThrow(/refused an insert/);

      // the ledger row is what failed — its closes must go with it, or spine and ledger disagree forever
      const closes = await committing
        .selectFrom("price_daily")
        .select("date")
        .where("instrument_id", "=", instrument.id)
        .execute();

      expect(closes).toEqual([]);
    } finally {
      if (planted !== undefined) {
        // reverse dependency order; holding/price tables go with their parent by cascade
        await committing
          .deleteFrom("position_set")
          .where("id", "=", planted.positionSetId)
          .execute();
        await committing.deleteFrom("account").where("id", "=", planted.accountId).execute();
        await committing.deleteFrom("person").where("id", "=", planted.personId).execute();
        await committing.deleteFrom("instrument").where("id", "=", planted.instrumentId).execute();
        await committing
          .deleteFrom("classification")
          .where("id", "=", planted.classificationId)
          .execute();
      }
      await committing.destroy();
    }
  });
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

      // a poll is an attempt at quotes, and this attempted none
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
    "reports what the batch did commit before it stopped",
    withDatabase(async (context) => {
      const { db, seedAccount, seedInstrument, seedPositionSet } = context;
      const account = await seedAccount();
      const first = await seedInstrument({ symbol: "FIRST", priceSource: "feed" });
      const second = await seedInstrument({ symbol: "SECOND", priceSource: "feed" });

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

      const provider = fakeProvider(() => history([["2024-03-25", "10.0000"]]));

      const report = await refreshPrices(
        provider,
        NEW_YORK,
        { quotes: false },
        // first attempt commits; the second's ledger row is refused
        refusingInsertInto(db, "price_backfill", { after: 1 }),
      );

      // a batch that filled one instrument then met an unreachable database must not report doing nothing
      expect(report.backfill.batchFailed).toBe(true);
      expect(report.backfill.attempted).toBe(1);
      expect(report.backfill.written).toBe(1);
      expect(report.backfill.outcomes.filled).toBe(1);
    }),
  );

  it(
    "reports the quotes it committed when the batch fails against the database",
    withDatabase(async (context) => {
      const { db } = context;
      const instrument = await heldFrom(context, { symbol: "VTI", asOf: "2024-06-01" });

      const provider = fakeProvider(() => history([["2024-06-10", "250.0000"]]), [quote("VTI")]);

      // within the seven-day window of the quote's own asOf, else today's real clock refuses it
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-06-05T21:00:00Z") });
      let report;
      try {
        report = await refreshPrices(
          provider,
          NEW_YORK,
          { quotes: true },
          refusingInsertInto(db, "price_backfill"),
        );
      } finally {
        vi.useRealTimers();
      }

      // quotes committed before the batch ran — the button's "figures above are unchanged" would be false otherwise
      expect(report.quotes.priced).toBe(1);
      expect(report.backfill.batchFailed).toBe(true);

      const quoted = await db
        .selectFrom("quote")
        .select("price")
        .where("instrument_id", "=", instrument.id)
        .executeTakeFirst();
      expect(quoted?.price).toBe("100.0000");

      // quote's own close for today, written before the batch ran; the batch's partial write is
      // visible only here because withDatabase's transaction has no rollback boundary inside it —
      // in production inTransaction opens a real one and closes+ledger commit together or not at all
      const closes = await db
        .selectFrom("price_daily")
        .select("date")
        .where("instrument_id", "=", instrument.id)
        .execute();
      expect(closes.map((row) => row.date)).toContain("2026-06-05");

      // the interrupted attempt leaves no ledger row — simply next time's candidate
      expect(await db.selectFrom("price_backfill").selectAll().execute()).toEqual([]);
    }),
  );

  it(
    "aborts the batch without ledgering anything for or after the unreachable candidate, and warns once",
    withDatabase(async (context) => {
      const { db, seedAccount, seedInstrument, seedPositionSet } = context;
      const account = await seedAccount();
      const first = await seedInstrument({ symbol: "FIRST", priceSource: "feed" });
      const second = await seedInstrument({ symbol: "SECOND", priceSource: "feed" });
      const third = await seedInstrument({ symbol: "THIRD", priceSource: "feed" });

      // deepest gap first, so the batch works them in this order and the provider dies in the middle
      await seedPositionSet({
        account,
        asOf: "2024-01-31",
        holdings: [{ instrument: first, quantity: "1.00000000" }],
      });
      await seedPositionSet({
        account,
        asOf: "2024-02-29",
        holdings: [{ instrument: second, quantity: "1.00000000" }],
      });
      await seedPositionSet({
        account,
        asOf: "2024-03-29",
        holdings: [{ instrument: third, quantity: "1.00000000" }],
      });

      const provider = fakeProvider((symbol) => {
        if (symbol === "SECOND") throw new ProviderUnreachable("connect ECONNREFUSED");
        return history([["2024-01-25", "10.0000"]]);
      });

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const report = await refreshPrices(provider, NEW_YORK, { quotes: false }, db);

        // batch stopped on the second candidate — the retry clock isn't charged for the third, never asked
        expect(report.backfill.batchFailed).toBe(true);
        expect(report.backfill.attempted).toBe(1);
        expect(report.backfill.outcomes.filled).toBe(1);
        expect(provider.asked.map((asked) => asked.symbol)).toEqual(["FIRST", "SECOND"]);

        const ledger = await db.selectFrom("price_backfill").select("instrument_id").execute();
        expect(ledger).toEqual([{ instrument_id: first.id }]);

        // one warning naming the cause, not the ordinary "quotes unaffected" line — false here
        expect(error).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.join(" "))).toContain("connect ECONNREFUSED");
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }
    }),
  );
});

describe("the whole list of gaps, for the person reading Settings", () => {
  it(
    "lists an instrument the batch will never try, and says it will not",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();
      const trust = await seedInstrument({
        symbol: "CIT2045",
        name: "Target 2045 Trust II",
        priceSource: "manual",
      });
      const unnamed = await seedInstrument({ symbol: null, name: "Unknown", priceSource: "feed" });

      await seedPositionSet({
        account,
        asOf: "2024-03-29",
        holdings: [
          { instrument: trust, quantity: "1.00000000" },
          { instrument: unnamed, quantity: "1.00000000" },
        ],
      });

      const gaps = await backfillGaps(db);

      // their gaps are just as real — the screen is where a person learns Settings → Instruments is the answer
      expect(gaps.map((gap) => ({ id: gap.id, willTry: gap.willTry }))).toEqual([
        { id: trust.id, willTry: false },
        { id: unnamed.id, willTry: false },
      ]);
    }),
  );

  it(
    "never lists a fixed instrument, even one that would otherwise be a gap",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, usdInstrument }) => {
      const account = await seedAccount();

      // the seeded USD row alone proves nothing (its 1970 close covers every date); this one has
      // no close at all, so only the fixed-source filter keeps it off
      const fixed = await seedInstrument({ symbol: "CASHLIKE", priceSource: "fixed" });
      const usd = await usdInstrument();

      await seedPositionSet({
        account,
        asOf: "2024-03-29",
        holdings: [
          { instrument: fixed, quantity: "1000.00000000" },
          { instrument: usd, quantity: "1000.00000000" },
        ],
      });

      expect(await backfillGaps(db)).toEqual([]);
    }),
  );

  it(
    "has no bound, because it is the whole list rather than the next batch",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();

      // comfortably more than the batch bound — a person asking why a date is unpriced must not be paginated
      const wanted = 12;
      for (let index = 0; index < wanted; index += 1) {
        const instrument = await seedInstrument({ symbol: `SYM${index}`, priceSource: "feed" });
        await seedPositionSet({
          account,
          asOf: "2024-03-29",
          holdings: [{ instrument, quantity: "1.00000000" }],
        });
      }

      expect(await backfillGaps(db)).toHaveLength(wanted);
    }),
  );

  it(
    "reports the earliest date an instrument was held, not the latest",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      // held in several sets — the ordinary case after a few uploads, and tells min from max
      await seedPositionSet({
        account,
        asOf: "2024-06-28",
        holdings: [{ instrument, quantity: "2.00000000" }],
      });
      await seedPositionSet({
        account,
        asOf: "2024-03-29",
        holdings: [{ instrument, quantity: "1.00000000" }],
      });

      const [gap] = await backfillGaps(db);

      expect(gap?.firstHeld).toBe("2024-03-29");
    }),
  );

  it(
    "reports the latest attempt, not the first",
    withDatabase(
      async ({ db, seedAccount, seedInstrument, seedPositionSet, seedBackfillAttempt }) => {
        const account = await seedAccount();
        const instrument = await seedInstrument({ symbol: "GONE", priceSource: "feed" });
        await seedPositionSet({
          account,
          asOf: "2024-03-29",
          holdings: [{ instrument, quantity: "1.00000000" }],
        });

        await seedBackfillAttempt({
          instrument,
          startedAt: new Date("2026-06-01T12:00:00Z"),
          outcome: "provider_failed",
          error: "429 Too Many Requests",
        });
        await seedBackfillAttempt({
          instrument,
          startedAt: new Date("2026-06-03T12:00:00Z"),
          outcome: "no_history",
        });

        const [gap] = await backfillGaps(db);

        expect(gap?.lastAttempt).toEqual({
          at: new Date("2026-06-03T12:00:00Z"),
          outcome: "no_history",
          error: null,
        });
      },
    ),
  );

  it(
    "reports no attempt at all where the batch has never tried",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedPositionSet({
        account,
        asOf: "2024-03-29",
        holdings: [{ instrument, quantity: "1.00000000" }],
      });

      const [gap] = await backfillGaps(db);

      expect(gap?.lastAttempt).toBeNull();
      expect(gap?.willTry).toBe(true);
    }),
  );

  it(
    "says where the spine does start, and where there is none at all",
    withDatabase(
      async ({ db, seedAccount, seedInstrument, seedPositionSet, seedDailyClose }) => {
        const account = await seedAccount();
        const late = await seedInstrument({ symbol: "LATE", priceSource: "feed" });
        const never = await seedInstrument({ symbol: "NEVER", priceSource: "feed" });

        await seedPositionSet({
          account,
          asOf: "2024-03-29",
          holdings: [
            { instrument: late, quantity: "1.00000000" },
            { instrument: never, quantity: "1.00000000" },
          ],
        });
        await seedDailyClose({ instrument: late, date: "2025-04-01", close: "250.0000" });

        const gaps = await backfillGaps(db);

        expect(
          gaps.map((gap) => ({ id: gap.id, firstHeld: gap.firstHeld, firstClose: gap.firstClose })),
        ).toEqual([
          { id: late.id, firstHeld: "2024-03-29", firstClose: "2025-04-01" },
          { id: never.id, firstHeld: "2024-03-29", firstClose: null },
        ]);
      },
    ),
  );

  it(
    "is ordered as the batch works, so the top of it is what the next refresh takes",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();
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

      expect((await backfillGaps(db)).map((gap) => gap.symbol)).toEqual(["ZM", "AAPL"]);
    }),
  );

  it(
    "shares its gap predicate with the batch, so a person and a tick see one answer",
    withDatabase(
      async ({
        db,
        seedAccount,
        seedInstrument,
        seedPositionSet,
        seedDailyClose,
        seedBackfillAttempt,
      }) => {
        const account = await seedAccount();
        const covered = await seedInstrument({ symbol: "COVERED", priceSource: "feed" });
        const open = await seedInstrument({ symbol: "OPEN", priceSource: "feed" });
        const attempted = await seedInstrument({ symbol: "ATTEMPTED", priceSource: "feed" });

        await seedPositionSet({
          account,
          asOf: "2024-03-29",
          holdings: [
            { instrument: covered, quantity: "1.00000000" },
            { instrument: open, quantity: "1.00000000" },
            { instrument: attempted, quantity: "1.00000000" },
          ],
        });
        await seedDailyClose({ instrument: covered, date: "2024-03-28", close: "10.0000" });
        await seedBackfillAttempt({
          instrument: attempted,
          startedAt: new Date(),
          outcome: "no_history",
        });

        // screen is the whole list, batch is the next few — they must agree on which have a
        // gap at all; the retry skip and the bound are the batch's alone
        expect((await backfillGaps(db)).map((gap) => gap.symbol)).toEqual(["OPEN", "ATTEMPTED"]);
        expect((await selectBackfillCandidates(db)).map((row) => row.symbol)).toEqual(["OPEN"]);
      },
    ),
  );
});
