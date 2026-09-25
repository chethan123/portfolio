// The trailing-dividend sweep (docs/specs/dividends/01): which instruments it picks, in what order,
// what one answer writes, and what a dashboard then reads. Real Postgres, fake provider — the risk is
// the candidate query and the retry clock the stamp is, both of which disappear under a mock.
import { afterAll, describe, expect, it, vi } from "vitest";

import { ProviderUnreachable, toProviderDividends } from "~/lib/price-provider.server";
import {
  DIVIDEND_OUTCOMES,
  refreshPrices,
  refreshQuotes,
  refreshTrailingDividends,
  selectDividendCandidates,
  type DividendOutcome,
} from "~/lib/prices.server";
import { currentHoldings } from "~/lib/valuation.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";
import { ALL_OWNERS } from "../app/lib/owner-filter.ts";

import type { TestContext } from "./support/database.ts";
import type { SeededInstrument } from "./support/fixtures.ts";
import type { Kysely } from "kysely";
import type { Database } from "~/lib/db.server";
import type { PriceProvider, ProviderDividends, ProviderQuote } from "~/lib/price-provider.server";

afterAll(closeTestDatabase);

const NEW_YORK = "America/New_York";

// the instant a sweep runs at unless a case states its own
const NOW = new Date("2026-09-25T20:00:00Z");

// what refreshTrailingDividends asks for: the market date less (365 + 21) days
const SINCE = "2025-09-04";

const daysBefore = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);

type Asked = { symbol: string; since: string };

// answers verbatim, unfiltered (cf. price-backfill.test.ts): a tidying fake cannot test a bad answer
function fakeProvider(
  answer: (symbol: string) => ProviderDividends,
  quotes: ProviderQuote[] = [],
): PriceProvider & { asked: Asked[] } {
  const asked: Asked[] = [];

  return {
    asked,
    async getQuotes() {
      return quotes;
    },
    async getDailyCloses() {
      return { status: "no-history" };
    },
    async getTrailingDividend(symbol, since) {
      asked.push({ symbol, since });
      return answer(symbol);
    },
  };
}

const providerQuote = (overrides: Partial<ProviderQuote> & { symbol: string }): ProviderQuote => ({
  price: "100.0000",
  quoteType: "ETF",
  yieldPct: null,
  annualDividendPerShare: null,
  asOf: new Date("2026-09-25T20:00:00Z"),
  fetchedAt: new Date("2026-09-25T20:00:05Z"),
  ...overrides,
});

/** One held instrument with a quote row, stating only the sweep columns a case turns on. */
async function heldWithQuote(
  context: TestContext,
  {
    symbol,
    stampedAt,
    outcome,
    rate,
  }: { symbol: string; stampedAt?: Date; outcome?: DividendOutcome; rate?: string },
): Promise<SeededInstrument> {
  const instrument = await context.seedInstrument({ symbol, priceSource: "feed" });
  const account = await context.seedAccount();

  await context.seedPositionSet({
    account,
    asOf: "2026-09-25",
    holdings: [{ instrument, quantity: "10.00000000" }],
  });
  await context.seedQuote({
    instrument,
    price: "100.0000",
    trailingDividendPerShare: rate,
    trailingDividendAsOf: stampedAt,
    trailingDividendOutcome: outcome,
  });

  return instrument;
}

const sweepColumnsOf = (db: Kysely<Database>, instrumentId: string) =>
  db
    .selectFrom("quote")
    .select([
      "trailing_dividend_per_share",
      "trailing_dividend_as_of",
      "trailing_dividend_outcome",
    ])
    .where("instrument_id", "=", instrumentId)
    .executeTakeFirst();

describe("which instruments a tick measures", () => {
  it(
    "puts a never-measured instrument ahead of a carried row, and an older stamp ahead of a newer",
    withDatabase(async (context) => {
      const unmeasured = await heldWithQuote(context, { symbol: "AAA" });
      const oldest = await heldWithQuote(context, {
        symbol: "BBB",
        stampedAt: daysBefore(30),
        outcome: DIVIDEND_OUTCOMES.ok,
        rate: "1.0000",
      });
      // What the migration left behind: stamped exactly the staleness bound, no outcome beside it.
      const carried = await heldWithQuote(context, {
        symbol: "CCC",
        stampedAt: daysBefore(7),
        rate: "1.2460",
      });

      const candidates = await selectDividendCandidates(context.db, NOW);

      // Round-robin by oldest stamp: `(as_of is null) desc, id` never converges below weekly capacity.
      expect(candidates.map((candidate) => candidate.id)).toEqual([
        unmeasured.id,
        oldest.id,
        carried.id,
      ]);
      expect(candidates.map((candidate) => candidate.symbol)).toEqual(["AAA", "BBB", "CCC"]);
    }),
  );

  it(
    "leaves a stamp inside the week alone",
    withDatabase(async (context) => {
      await heldWithQuote(context, {
        symbol: "SCHD",
        stampedAt: daysBefore(6),
        outcome: DIVIDEND_OUTCOMES.ok,
        rate: "1.0000",
      });

      expect(await selectDividendCandidates(context.db, NOW)).toEqual([]);
    }),
  );

  it(
    "retries a failed call the next day, where a measured rate waits the week",
    withDatabase(async (context) => {
      // without the second tier one 429 parks an instrument for a week, reading $0 all of it
      const failed = await heldWithQuote(context, {
        symbol: "FAILED",
        stampedAt: daysBefore(2),
        outcome: DIVIDEND_OUTCOMES.providerFailed,
      });
      await heldWithQuote(context, {
        symbol: "MEASURED",
        stampedAt: daysBefore(2),
        outcome: DIVIDEND_OUTCOMES.ok,
        rate: "1.0000",
      });

      const candidates = await selectDividendCandidates(context.db, NOW);

      expect(candidates.map((candidate) => candidate.id)).toEqual([failed.id]);
    }),
  );

  it(
    "counts an instrument held in three accounts as one slot",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      // holding_valued is one row per account x instrument: ungrouped, limit 5 would fetch this
      // ETF three times in one tick
      const etf = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedQuote({ instrument: etf, price: "271.5000" });

      for (const name of ["Taxable", "Roth", "401k"]) {
        const account = await seedAccount({ name: `${name} account` });
        await seedPositionSet({
          account,
          asOf: "2026-09-25",
          holdings: [{ instrument: etf, quantity: "10.00000000" }],
        });
      }

      const candidates = await selectDividendCandidates(db, NOW);

      expect(candidates.map((candidate) => candidate.id)).toEqual([etf.id]);
    }),
  );

  it(
    "drops an instrument the latest position set no longer holds",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      // "ever held" would cost a request a week forever for a position sold in 2019
      const sold = await seedInstrument({ symbol: "SOLD", priceSource: "feed" });
      await seedQuote({ instrument: sold, price: "100.0000" });
      const account = await seedAccount();

      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: sold, quantity: "10.00000000" }],
      });
      await seedPositionSet({ account, asOf: "2026-02-28", holdings: [] });

      expect(await selectDividendCandidates(db, NOW)).toEqual([]);
    }),
  );

  it(
    "drops a position recorded at zero, and keeps one recorded negative, which still owes a dividend",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      // A turnaround is recorded as zero first (`positions.server.ts`) and the view keeps that row,
      // so without the quantity filter a zeroed position costs a request every week forever — the
      // same waste "ever held" was rejected for.
      const zeroed = await seedInstrument({ symbol: "ZEROED", priceSource: "feed" });
      await seedQuote({ instrument: zeroed, price: "100.0000" });
      const owed = await seedInstrument({ symbol: "OWED", priceSource: "feed" });
      await seedQuote({ instrument: owed, price: "100.0000" });
      const account = await seedAccount();

      await seedPositionSet({
        account,
        asOf: "2026-09-25",
        holdings: [
          { instrument: zeroed, quantity: "0.00000000" },
          { instrument: owed, quantity: "-2.00000000" },
        ],
      });

      const candidates = await selectDividendCandidates(db, NOW);

      expect(candidates.map((candidate) => candidate.symbol)).toEqual(["OWED"]);
    }),
  );

  it(
    "drops an instrument held only in a closed account",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      const instrument = await seedInstrument({ symbol: "RETIRED", priceSource: "feed" });
      await seedQuote({ instrument, price: "100.0000" });
      const account = await seedAccount({ closedAt: new Date("2026-06-30T00:00:00Z") });

      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [{ instrument, quantity: "10.00000000" }],
      });

      expect(await selectDividendCandidates(db, NOW)).toEqual([]);
    }),
  );

  it(
    "skips an instrument with no quote row for the write to land on",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const instrument = await seedInstrument({ symbol: "NEW", priceSource: "feed" });
      const account = await seedAccount();

      await seedPositionSet({
        account,
        asOf: "2026-09-25",
        holdings: [{ instrument, quantity: "10.00000000" }],
      });

      expect(await selectDividendCandidates(db, NOW)).toEqual([]);
    }),
  );
});

describe("what one answer writes", () => {
  it(
    "stores the measured rate, the stamp and the ok outcome, asked over the widened window",
    withDatabase(async (context) => {
      const instrument = await heldWithQuote(context, { symbol: "ITOT", rate: "1.2460" });
      const provider = fakeProvider(() => ({ status: "ok", perShare: "1.6860" }));

      const report = await refreshTrailingDividends(provider, NEW_YORK, NOW, context.db);

      expect(provider.asked).toEqual([{ symbol: "ITOT", since: SINCE }]);
      expect(report).toEqual({
        attempted: 1,
        written: 1,
        refused: 0,
        failed: 0,
        batchFailed: false,
      });
      expect(await sweepColumnsOf(context.db, instrument.id)).toEqual({
        trailing_dividend_per_share: "1.6860",
        trailing_dividend_as_of: NOW,
        trailing_dividend_outcome: DIVIDEND_OUTCOMES.ok,
      });
    }),
  );

  const REFUSALS = [
    ["no-data", DIVIDEND_OUTCOMES.noData],
    ["non-usd", DIVIDEND_OUTCOMES.nonUsd],
    ["unreadable", DIVIDEND_OUTCOMES.unreadable],
  ] as const;

  for (const [status, outcome] of REFUSALS) {
    it(
      `advances the stamp to ${outcome} for a provider that answered ${status}, leaving the rate standing`,
      withDatabase(async (context) => {
        const instrument = await heldWithQuote(context, { symbol: "GONE", rate: "1.2460" });
        const provider = fakeProvider(() =>
          status === "non-usd" ? { status, currency: "GBP" } : { status },
        );

        const report = await refreshTrailingDividends(provider, NEW_YORK, NOW, context.db);

        expect(report).toMatchObject({ attempted: 1, written: 0, refused: 1, failed: 0 });
        // The outcome, not the value, is what tells a measured rate from a carried one.
        expect(await sweepColumnsOf(context.db, instrument.id)).toEqual({
          trailing_dividend_per_share: "1.2460",
          trailing_dividend_as_of: NOW,
          trailing_dividend_outcome: outcome,
        });
      }),
    );
  }

  it(
    "advances the stamp for a call that threw, recording provider_failed",
    withDatabase(async (context) => {
      // otherwise a symbol that throws every tick holds the head of a nulls-first queue forever
      const instrument = await heldWithQuote(context, { symbol: "BROKEN", rate: "1.2460" });
      const provider = fakeProvider(() => {
        throw new Error("429 Too Many Requests");
      });

      const report = await refreshTrailingDividends(provider, NEW_YORK, NOW, context.db);

      expect(report).toMatchObject({ attempted: 1, written: 0, refused: 0, failed: 1 });
      expect(await sweepColumnsOf(context.db, instrument.id)).toEqual({
        trailing_dividend_per_share: "1.2460",
        trailing_dividend_as_of: NOW,
        trailing_dividend_outcome: DIVIDEND_OUTCOMES.providerFailed,
      });
    }),
  );

  it(
    "writes nothing and propagates when the provider is unreachable",
    withDatabase(async (context) => {
      const instrument = await heldWithQuote(context, {
        symbol: "ITOT",
        stampedAt: daysBefore(30),
        outcome: DIVIDEND_OUTCOMES.ok,
        rate: "1.2460",
      });
      const provider = fakeProvider(() => {
        throw new ProviderUnreachable("connect ECONNREFUSED");
      });

      const failure = await refreshTrailingDividends(provider, NEW_YORK, NOW, context.db).then(
        () => null,
        (error: unknown) => error,
      );

      // Carried, so the counts reach the composition's log line; the cause is the one that escapes.
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).cause).toBeInstanceOf(ProviderUnreachable);
      // Not stamped: nothing was learned, and the batch is retried whole next tick.
      expect(await sweepColumnsOf(context.db, instrument.id)).toEqual({
        trailing_dividend_per_share: "1.2460",
        trailing_dividend_as_of: daysBefore(30),
        trailing_dividend_outcome: DIVIDEND_OUTCOMES.ok,
      });
    }),
  );

  it(
    "leaves the trailing columns untouched when a quote refresh overwrites the price",
    withDatabase(async (context) => {
      // writeQuote names five columns explicitly; a doUpdateSet(values) over every column would
      // reset the stamp on every poll and dismantle the retry clock the sweep is paced by
      const instrument = await heldWithQuote(context, {
        symbol: "ITOT",
        stampedAt: daysBefore(3),
        outcome: DIVIDEND_OUTCOMES.ok,
        rate: "1.6860",
      });
      const provider = fakeProvider(
        () => ({ status: "no-data" }),
        [providerQuote({ symbol: "ITOT", price: "170.0000" })],
      );

      await refreshQuotes(provider, NEW_YORK, NOW, context.db);

      const stored = await context.db
        .selectFrom("quote")
        .select("price")
        .where("instrument_id", "=", instrument.id)
        .executeTakeFirst();

      expect(stored?.price).toBe("170.0000");
      expect(await sweepColumnsOf(context.db, instrument.id)).toEqual({
        trailing_dividend_per_share: "1.6860",
        trailing_dividend_as_of: daysBefore(3),
        trailing_dividend_outcome: DIVIDEND_OUTCOMES.ok,
      });
    }),
  );
});

describe("the sweep's place in a refresh", () => {
  it(
    "runs no sweep at all when the caller says it does not wait for one",
    withDatabase(async (context) => {
      // the manual /refresh route: quotes plus five backfills already, and a person's button press
      // must not also cost 5 x 35s of charts
      await heldWithQuote(context, { symbol: "ITOT" });
      const provider = fakeProvider(() => ({ status: "ok", perShare: "1.6860" }));

      const report = await refreshPrices(
        provider,
        NEW_YORK,
        NOW,
        { quotes: false, dividends: false },
        context.db,
      );

      expect(report.dividends).toBeNull();
      expect(provider.asked).toEqual([]);
    }),
  );

  it(
    "reports a sweep that stopped partway without disturbing the quotes beside it",
    withDatabase(async (context) => {
      const measured = await heldWithQuote(context, { symbol: "AAA" });
      await heldWithQuote(context, { symbol: "ZZZ" });
      const provider = fakeProvider(
        (symbol) => {
          if (symbol === "ZZZ") throw new ProviderUnreachable("connect ECONNREFUSED");
          return { status: "ok", perShare: "1.6860" };
        },
        [providerQuote({ symbol: "AAA", price: "170.0000" })],
      );

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const report = await refreshPrices(
          provider,
          NEW_YORK,
          NOW,
          { quotes: true, dividends: true },
          context.db,
        );

        // the counts from the instruments already swept survive the carrier
        expect(report.dividends).toEqual({
          attempted: 1,
          written: 1,
          refused: 0,
          failed: 0,
          batchFailed: true,
        });
        expect(report.quotes).toMatchObject({ requested: 2, priced: 1 });
        expect(await sweepColumnsOf(context.db, measured.id)).toMatchObject({
          trailing_dividend_per_share: "1.6860",
        });
        expect(String(warn.mock.calls.at(-1)?.join(" "))).toContain("connect ECONNREFUSED");
      } finally {
        warn.mockRestore();
      }
    }),
  );
});

describe("what the quote column will and will not record", () => {
  it(
    "accepts every outcome the vocabulary declares",
    withDatabase(async ({ db, seedInstrument, seedQuote }) => {
      // iterated over the exported object — catches a literal added to DIVIDEND_OUTCOMES but not
      // to the check constraint
      const outcomes = Object.values(DIVIDEND_OUTCOMES);

      for (const outcome of outcomes) {
        const instrument = await seedInstrument({ symbol: `S-${outcome}`, priceSource: "feed" });
        await seedQuote({
          instrument,
          price: "100.0000",
          trailingDividendAsOf: NOW,
          trailingDividendOutcome: outcome,
        });
      }

      const rows = await db
        .selectFrom("quote")
        .select("trailing_dividend_outcome")
        .where("trailing_dividend_outcome", "is not", null)
        .execute();

      expect(rows.map((row) => row.trailing_dividend_outcome).sort()).toEqual([...outcomes].sort());
    }),
  );

  it(
    "refuses an outcome the vocabulary does not know",
    withDatabase(async ({ seedInstrument, seedQuote }) => {
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      await expect(
        seedQuote({
          instrument,
          price: "100.0000",
          trailingDividendAsOf: NOW,
          // the fixture takes a plain string, so the check constraint is the only gate on this
          trailingDividendOutcome: "measured",
        }),
      ).rejects.toThrow(/quote_trailing_dividend_outcome_valid/);
    }),
  );
});

describe("the rate a sweep writes, read back as a dividend", () => {
  it(
    "projects one share's annual dividend from the four distributions the sweep measured",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      // The two halves joined: nothing else runs a sweep and then reads holding_valued, so a write
      // landing in a column the view does not read would pass every other case in this file.
      const itot = await seedInstrument({
        symbol: "ITOT",
        name: "iShares Core S&P Total US Stock Market ETF",
        priceSource: "feed",
      });
      await seedQuote({ instrument: itot, price: "167.7300" });
      const account = await seedAccount();
      await seedPositionSet({
        account,
        asOf: "2026-09-25",
        holdings: [{ instrument: itot, quantity: "1.00000000" }],
      });

      // The distributions Yahoo's own events.dividends carried on 2026-09-25, through the parser
      // the adapter uses: 0.487 + 0.327 + 0.419 + 0.453.
      const provider = fakeProvider(() =>
        toProviderDividends(
          {
            meta: { currency: "USD" },
            events: {
              dividends: [
                { date: new Date("2025-12-22T13:30:00Z"), amount: 0.487 },
                { date: new Date("2026-03-23T13:30:00Z"), amount: 0.327 },
                { date: new Date("2026-06-22T13:30:00Z"), amount: 0.419 },
                { date: new Date("2026-09-22T13:30:00Z"), amount: 0.453 },
              ],
            },
            quotes: [{ date: new Date("2026-09-22T13:30:00Z"), close: 167.73 }],
          },
          SINCE,
          NEW_YORK,
        ),
      );

      const report = await refreshTrailingDividends(provider, NEW_YORK, NOW, db);

      expect(report).toMatchObject({ attempted: 1, written: 1, refused: 0, failed: 0 });

      const [holding] = await currentHoldings(ALL_OWNERS, db);
      if (holding === undefined) throw new Error("the seeded holding did not come back");

      expect(holding).toMatchObject({ value: "167.7300", annualDividend: "1.6860" });
    }),
  );
});
