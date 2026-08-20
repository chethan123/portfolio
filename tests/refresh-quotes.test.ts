/**
 * What a refresh stores, and what it refuses to store.
 *
 * These run against the real database because the decisions being protected are
 * about rows: which `price_daily` date a quote becomes, that a past date is
 * never rewritten, that a failed symbol keeps its price and gains a flag.
 *
 * The provider is a fake throughout. That is the point of the interface
 * DESIGN.md §6.1 mandates — CI never reaches the network, and every awkward
 * response a real provider could give can be stated in one line here.
 */
import { afterAll, describe, expect, it } from "vitest";

import { refreshQuotes, priceFreshness } from "~/lib/prices.server";
import type { PriceProvider, ProviderQuote } from "~/lib/price-provider.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";

afterAll(closeTestDatabase);

const NEW_YORK = "America/New_York";

/** A provider that returns exactly what a test says, and records what it was asked. */
function fakeProvider(quotes: ProviderQuote[]): PriceProvider & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    async getQuotes(symbols) {
      asked.push([...symbols]);
      // Only answer for symbols actually requested, as a real batch endpoint does.
      return quotes.filter((quote) => symbols.includes(quote.symbol));
    },
  };
}

/** A quote, with the boring fields filled in. */
const quote = (overrides: Partial<ProviderQuote> & { symbol: string }): ProviderQuote => ({
  price: "100.0000",
  quoteType: "ETF",
  yieldPct: null,
  annualDividendPerShare: null,
  asOf: new Date("2026-06-05T20:00:00Z"),
  ...overrides,
});

describe("choosing what to fetch", () => {
  it(
    "asks only about instruments priced from a feed",
    withDatabase(async ({ db, seedInstrument, usdInstrument }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      // A collective investment trust: no public ticker, priced by hand.
      await seedInstrument({ symbol: null, name: "Target 2045 Trust II", priceSource: "manual" });
      // The seeded USD row, fixed at 1.00 since 1970.
      await usdInstrument();

      const provider = fakeProvider([]);
      await refreshQuotes(provider, NEW_YORK, db);

      expect(provider.asked).toEqual([["VTI"]]);
    }),
  );

  it(
    "never asks about the USD instrument, whose price is the constant cash is valued against",
    withDatabase(async ({ db, usdInstrument }) => {
      const usd = await usdInstrument();

      const provider = fakeProvider([quote({ symbol: "USD", price: "0.9000" })]);
      await refreshQuotes(provider, NEW_YORK, db);

      const stored = await db
        .selectFrom("quote")
        .select("price")
        .where("instrument_id", "=", usd.id)
        .executeTakeFirst();

      expect(stored?.price).toBe("1.0000");
    }),
  );

  it(
    "skips a feed instrument that has no symbol yet",
    withDatabase(async ({ db, seedInstrument }) => {
      await seedInstrument({ symbol: null, priceSource: "feed" });

      const provider = fakeProvider([]);
      const report = await refreshQuotes(provider, NEW_YORK, db);

      expect(provider.asked).toEqual([]);
      expect(report.requested).toBe(0);
    }),
  );
});

describe("storing a price", () => {
  it(
    "writes the intraday quote and the daily close together",
    withDatabase(async ({ db, seedInstrument }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      await refreshQuotes(
        fakeProvider([
          quote({ symbol: "VTI", price: "271.5000", yieldPct: "1.250000", annualDividendPerShare: "3.3900" }),
        ]),
        NEW_YORK,
        db,
      );

      const stored = await db
        .selectFrom("quote")
        .selectAll()
        .where("instrument_id", "=", vti.id)
        .executeTakeFirstOrThrow();

      expect(stored.price).toBe("271.5000");
      expect(stored.yield_pct).toBe("1.250000");
      expect(stored.annual_dividend_per_share).toBe("3.3900");
      expect(stored.is_stale).toBe(false);

      const close = await db
        .selectFrom("price_daily")
        .selectAll()
        .where("instrument_id", "=", vti.id)
        .executeTakeFirstOrThrow();

      expect(close.close).toBe("271.5000");
    }),
  );

  it(
    "files the close under the market date inside the quote, not under today",
    withDatabase(async ({ db, seedInstrument }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      // 01:30 UTC on the 6th is 21:30 on the 5th in New York — an evening
      // mutual fund NAV. Filed under the 6th it would be overwritten by the
      // 6th's real close and lost.
      await refreshQuotes(
        fakeProvider([quote({ symbol: "VTI", asOf: new Date("2026-06-06T01:30:00Z") })]),
        NEW_YORK,
        db,
      );

      const dates = await db
        .selectFrom("price_daily")
        .select("date")
        .where("instrument_id", "=", vti.id)
        .execute();

      expect(dates.map((row) => row.date)).toEqual(["2026-06-05"]);
    }),
  );

  it(
    "rewrites today's provisional close as the session runs, converging on the last price",
    withDatabase(async ({ db, seedInstrument }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const asOf = new Date("2026-06-05T17:00:00Z");

      await refreshQuotes(fakeProvider([quote({ symbol: "VTI", price: "270.0000", asOf })]), NEW_YORK, db);
      await refreshQuotes(fakeProvider([quote({ symbol: "VTI", price: "271.5000", asOf })]), NEW_YORK, db);

      const rows = await db
        .selectFrom("price_daily")
        .selectAll()
        .where("instrument_id", "=", vti.id)
        .execute();

      // One row, not two — and it holds the later price.
      expect(rows.map((row) => row.close)).toEqual(["271.5000"]);
    }),
  );

  it(
    "leaves an earlier day's close untouched",
    withDatabase(async ({ db, seedInstrument, seedDailyClose }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedDailyClose({ instrument: vti, date: "2026-06-04", close: "265.0000" });

      await refreshQuotes(
        fakeProvider([quote({ symbol: "VTI", price: "271.5000", asOf: new Date("2026-06-05T20:00:00Z") })]),
        NEW_YORK,
        db,
      );

      const rows = await db
        .selectFrom("price_daily")
        .select(["date", "close"])
        .where("instrument_id", "=", vti.id)
        .orderBy("date")
        .execute();

      // §6.2: an intraday refresh can never corrupt history.
      expect(rows).toEqual([
        { date: "2026-06-04", close: "265.0000" },
        { date: "2026-06-05", close: "271.5000" },
      ]);
    }),
  );

  it(
    "prices every instrument sharing a symbol, since the column carries no unique constraint",
    withDatabase(async ({ db, seedInstrument }) => {
      const first = await seedInstrument({ symbol: "VTI", name: "Total Market", priceSource: "feed" });
      const second = await seedInstrument({ symbol: "VTI", name: "Total Market (dup)", priceSource: "feed" });

      const provider = fakeProvider([quote({ symbol: "VTI", price: "271.5000" })]);
      const report = await refreshQuotes(provider, NEW_YORK, db);

      // Asked once, stored twice.
      expect(provider.asked).toEqual([["VTI"]]);
      expect(report.priced).toBe(2);

      const prices = await db
        .selectFrom("quote")
        .select("price")
        .where("instrument_id", "in", [first.id, second.id])
        .execute();

      expect(prices.map((row) => row.price)).toEqual(["271.5000", "271.5000"]);
    }),
  );
});

describe("a symbol that does not come back", () => {
  it(
    "keeps the last known price and marks it stale, never zeroing it",
    withDatabase(async ({ db, seedInstrument, seedQuote }) => {
      const gone = await seedInstrument({ symbol: "GONE", priceSource: "feed" });
      await seedQuote({ instrument: gone, price: "42.0000", isStale: false });

      // The provider answers about nothing.
      const report = await refreshQuotes(fakeProvider([]), NEW_YORK, db);

      const stored = await db
        .selectFrom("quote")
        .selectAll()
        .where("instrument_id", "=", gone.id)
        .executeTakeFirstOrThrow();

      // §6.2: never zero, never null into a sum.
      expect(stored.price).toBe("42.0000");
      expect(stored.is_stale).toBe(true);
      expect(report.stale).toBe(1);
    }),
  );

  it(
    "leaves an instrument that has never been priced without a quote row at all",
    withDatabase(async ({ db, seedInstrument }) => {
      const fresh = await seedInstrument({ symbol: "NEVER", priceSource: "feed" });

      await refreshQuotes(fakeProvider([]), NEW_YORK, db);

      const stored = await db
        .selectFrom("quote")
        .selectAll()
        .where("instrument_id", "=", fresh.id)
        .executeTakeFirst();

      // No row, rather than a row claiming a price of zero. `holding_valued`
      // reports the absence honestly as `is_priced = false`.
      expect(stored).toBeUndefined();
    }),
  );

  it(
    "clears the stale flag once a price comes back",
    withDatabase(async ({ db, seedInstrument, seedQuote }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedQuote({ instrument: vti, price: "42.0000", isStale: true });

      await refreshQuotes(fakeProvider([quote({ symbol: "VTI", price: "271.5000" })]), NEW_YORK, db);

      const stored = await db
        .selectFrom("quote")
        .selectAll()
        .where("instrument_id", "=", vti.id)
        .executeTakeFirstOrThrow();

      expect(stored.price).toBe("271.5000");
      expect(stored.is_stale).toBe(false);
    }),
  );

  it(
    "ignores a quote for a symbol nobody asked about",
    withDatabase(async ({ db, seedInstrument }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      const report = await refreshQuotes(
        fakeProvider([quote({ symbol: "VTI" }), quote({ symbol: "SURPRISE" })]),
        NEW_YORK,
        db,
      );

      expect(report.priced).toBe(1);
      const rows = await db.selectFrom("price_daily").selectAll().execute();
      // The USD seed row plus the one instrument we hold.
      expect(rows.filter((row) => row.close === "100.0000")).toHaveLength(1);
    }),
  );
});

describe("how fresh the prices are", () => {
  it(
    "reports the oldest price among held instruments, not the newest",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      const account = await seedAccount({ kind: "brokerage" });
      const fresh = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const lagging = await seedInstrument({ symbol: "OLD", priceSource: "feed" });

      const week = new Date("2026-06-01T20:00:00Z");
      await seedQuote({ instrument: fresh, price: "271.5000", asOf: new Date("2026-06-05T20:00:00Z") });
      await seedQuote({ instrument: lagging, price: "10.0000", asOf: week, isStale: true });

      await seedPositionSet({
        account,
        asOf: "2026-06-05",
        holdings: [
          { instrument: fresh, quantity: "10" },
          { instrument: lagging, quantity: "5" },
        ],
      });

      const freshness = await priceFreshness(db);

      // The newest reading would call this portfolio current while one holding
      // has been failing for a week — §11's dangerous failure exactly.
      expect(freshness.oldest).toEqual(week);
      expect(freshness.stale).toBe(1);
      expect(freshness.priced).toBe(2);
    }),
  );

  it(
    "reports nothing on an instance that holds nothing",
    withDatabase(async ({ db }) => {
      const freshness = await priceFreshness(db);

      // An empty instance must not render a figure — a zero and an absence are
      // different facts, and only one of them is alarming.
      expect(freshness.oldest).toBeNull();
      expect(freshness.priced).toBe(0);
    }),
  );
});
