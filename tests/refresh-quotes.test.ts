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
import { sql } from "kysely";
import { afterAll, describe, expect, it, vi } from "vitest";

import { refreshQuotes, priceFreshness } from "~/lib/prices.server";
import type { PriceProvider, ProviderQuote } from "~/lib/price-provider.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";

afterAll(closeTestDatabase);

const NEW_YORK = "America/New_York";

/**
 * A provider that returns exactly what a test says, and records what it was asked.
 *
 * Returns the quotes verbatim rather than filtering them to the requested
 * symbols. An earlier version filtered — which quietly made the
 * unrequested-symbol test unfailable, because the surprise quote never reached
 * the code that is supposed to ignore it. A fake that corrects the test's
 * fixture cannot test what the caller does with a bad one.
 */
function fakeProvider(quotes: ProviderQuote[]): PriceProvider & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    async getQuotes(symbols) {
      asked.push([...symbols]);
      return quotes;
    },
    // Nothing in this file backfills; the method exists because the interface
    // requires it, and a provider that cannot answer history is not this
    // application's provider.
    async getDailyCloses() {
      return { status: "no-history" };
    },
  };
}

/** A provider that fails the way a rate limit or a shape change fails. */
function brokenProvider(message = "429 Too Many Requests"): PriceProvider {
  return {
    async getQuotes() {
      throw new Error(message);
    },
    async getDailyCloses(): Promise<never> {
      throw new Error(message);
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
  // A few seconds after the instant it says it struck — a fake knows what time
  // it answered, which is why `fetchedAt` is required and `payload` is not.
  fetchedAt: new Date("2026-06-05T20:00:05Z"),
  ...overrides,
});

/**
 * Runs `body` with today's market date pinned near the fixtures' own 2026
 * dates, so the seven-day window (module header) does not refuse the closes
 * these tests are actually about. The shape `tests/price-backfill.test.ts:
 * 965-978` uses.
 */
async function withClockNear<T>(now: string, body: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(now) });
  try {
    return await body();
  } finally {
    vi.useRealTimers();
  }
}

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

describe("what a refresh learned", () => {
  it(
    "counts only the instants the log did not already hold",
    withDatabase(async ({ db, seedInstrument }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      await withClockNear("2026-06-05T21:00:00Z", async () => {
        // Twice, with the provider re-stating the same instant both times —
        // which is exactly what a weekend press gets: Friday's close, again.
        const first = await refreshQuotes(fakeProvider([quote({ symbol: "VTI" })]), NEW_YORK, db);
        const second = await refreshQuotes(fakeProvider([quote({ symbol: "VTI" })]), NEW_YORK, db);

        expect(first.observed).toBe(1);

        // Every other count is identical between the two, which is the reason
        // this field exists: without it the second press claims to have
        // updated a price it merely re-read.
        expect(second.priced).toBe(1);
        expect(second.closes).toBe(1);
        expect(second.observed).toBe(0);
      });
    }),
  );

  it(
    "reports a provider that threw apart from one that knew nothing",
    withDatabase(async ({ db, seedInstrument }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      const outage = await refreshQuotes(brokenProvider(), NEW_YORK, db);
      const ignorance = await refreshQuotes(fakeProvider([]), NEW_YORK, db);

      // Identical aggregates. The feed being down and the symbol being wrong
      // need different sentences on screen, and this is the only thing that
      // tells them apart.
      expect(outage.priced).toBe(0);
      expect(ignorance.priced).toBe(0);
      expect(outage.stale).toBe(1);
      expect(ignorance.stale).toBe(1);

      expect(outage.providerFailed).toBe(true);
      expect(ignorance.providerFailed).toBe(false);
    }),
  );
});

describe("storing a price", () => {
  it(
    "writes the intraday quote and the daily close together",
    withDatabase(async ({ db, seedInstrument }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      await withClockNear("2026-06-05T21:00:00Z", async () => {
        await refreshQuotes(
          fakeProvider([
            quote({ symbol: "VTI", price: "271.5000", yieldPct: "1.250000", annualDividendPerShare: "3.3900" }),
          ]),
          NEW_YORK,
          db,
        );
      });

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
      await withClockNear("2026-06-06T12:00:00Z", () =>
        refreshQuotes(
          fakeProvider([quote({ symbol: "VTI", asOf: new Date("2026-06-06T01:30:00Z") })]),
          NEW_YORK,
          db,
        ),
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

      await withClockNear("2026-06-05T18:00:00Z", async () => {
        await refreshQuotes(fakeProvider([quote({ symbol: "VTI", price: "270.0000", asOf })]), NEW_YORK, db);
        await refreshQuotes(fakeProvider([quote({ symbol: "VTI", price: "271.5000", asOf })]), NEW_YORK, db);
      });

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

      await withClockNear("2026-06-05T21:00:00Z", () =>
        refreshQuotes(
          fakeProvider([quote({ symbol: "VTI", price: "271.5000", asOf: new Date("2026-06-05T20:00:00Z") })]),
          NEW_YORK,
          db,
        ),
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

describe("the seven-day window", () => {
  it(
    "writes the quote and the observation but no close for a quote eight days before today",
    withDatabase(async ({ db, seedInstrument, seedDailyClose }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      // The row a live poller would already have settled for that day.
      await seedDailyClose({ instrument: vti, date: "2026-06-07", close: "265.0000" });

      const report = await withClockNear("2026-06-15T12:00:00Z", () =>
        refreshQuotes(
          fakeProvider([
            quote({ symbol: "VTI", price: "999.0000", asOf: new Date("2026-06-07T20:00:00Z") }),
          ]),
          NEW_YORK,
          db,
        ),
      );

      expect(report.closes).toBe(0);

      // Byte-identical: the window guard, not a rewrite that happened to
      // match, is what left it alone.
      const close = await db
        .selectFrom("price_daily")
        .select("close")
        .where("instrument_id", "=", vti.id)
        .where("date", "=", "2026-06-07")
        .executeTakeFirstOrThrow();
      expect(close.close).toBe("265.0000");

      // The quote and the observation still land — only the close is refused.
      const quoteRow = await db
        .selectFrom("quote")
        .select("price")
        .where("instrument_id", "=", vti.id)
        .executeTakeFirstOrThrow();
      expect(quoteRow.price).toBe("999.0000");

      const observations = await db
        .selectFrom("price_observation")
        .selectAll()
        .where("instrument_id", "=", vti.id)
        .execute();
      expect(observations).toHaveLength(1);
    }),
  );

  it(
    "writes no close for a quote eight days ahead of today either",
    withDatabase(async ({ db, seedInstrument }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      const report = await withClockNear("2026-06-15T12:00:00Z", () =>
        refreshQuotes(
          fakeProvider([quote({ symbol: "VTI", asOf: new Date("2026-06-23T20:00:00Z") })]),
          NEW_YORK,
          db,
        ),
      );

      expect(report.closes).toBe(0);
      const closes = await db
        .selectFrom("price_daily")
        .selectAll()
        .where("instrument_id", "=", vti.id)
        .execute();
      expect(closes).toEqual([]);
    }),
  );

  it(
    "warns once for the whole refresh, naming every instrument whose close was skipped",
    withDatabase(async ({ db, seedInstrument }) => {
      // Three words of the rule, each its own way to get it wrong: *one* line
      // (not one per instrument), *per refresh* (not on a refresh that skipped
      // nothing), naming *the instruments* (not just the first).
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedInstrument({ symbol: "VXUS", priceSource: "feed" });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        await withClockNear("2026-06-15T12:00:00Z", () =>
          refreshQuotes(
            fakeProvider([
              quote({ symbol: "VTI", asOf: new Date("2026-06-01T20:00:00Z") }),
              quote({ symbol: "VXUS", asOf: new Date("2026-06-01T20:00:00Z") }),
            ]),
            NEW_YORK,
            db,
          ),
        );

        const skipped = warn.mock.calls.filter((call) => String(call[0]).includes("close skipped"));
        expect(skipped).toHaveLength(1);
        expect(String(skipped[0]?.[0])).toContain("VTI");
        expect(String(skipped[0]?.[0])).toContain("VXUS");
      } finally {
        warn.mockRestore();
      }
    }),
  );

  it(
    "says nothing about skipped closes on a refresh that skipped none",
    withDatabase(async ({ db, seedInstrument }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        await withClockNear("2026-06-05T21:00:00Z", () =>
          refreshQuotes(fakeProvider([quote({ symbol: "VTI" })]), NEW_YORK, db),
        );

        expect(warn.mock.calls.filter((call) => String(call[0]).includes("close skipped"))).toEqual(
          [],
        );
      } finally {
        warn.mockRestore();
      }
    }),
  );

  it(
    "writes the close for a quote exactly seven days ahead of today, the other edge",
    withDatabase(async ({ db, seedInstrument }) => {
      // The spec calls the window symmetric, so both edges are rules. Without
      // this the future half is pinned only by an eight-days-ahead case, and
      // narrowing it to six would pass.
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      const report = await withClockNear("2026-06-15T12:00:00Z", () =>
        refreshQuotes(
          fakeProvider([quote({ symbol: "VTI", asOf: new Date("2026-06-22T20:00:00Z") })]),
          NEW_YORK,
          db,
        ),
      );

      expect(report.closes).toBe(1);

      const closes = await db
        .selectFrom("price_daily")
        .select("date")
        .where("instrument_id", "=", vti.id)
        .execute();
      expect(closes).toEqual([{ date: "2026-06-22" }]);
    }),
  );

  it(
    "measures the window against the market's own date, not the runtime's",
    withDatabase(async ({ db, seedInstrument }) => {
      // 02:00 UTC is the previous evening in New York, so the market date and
      // the UTC date are different days. Both sides of the comparison have to
      // be spoken in the market's calendar or the whole window slides a day
      // for every tick in that band.
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      const report = await withClockNear("2026-06-06T02:00:00Z", () =>
        refreshQuotes(
          fakeProvider([quote({ symbol: "VTI", asOf: new Date("2026-05-29T20:00:00Z") })]),
          NEW_YORK,
          db,
        ),
      );

      // Market today is 2026-06-05, so 2026-05-29 is exactly the past edge and
      // writes. Read in UTC, today would be 2026-06-06 and this would be eight
      // days back — refused.
      expect(report.closes).toBe(1);

      const closes = await db
        .selectFrom("price_daily")
        .select("date")
        .where("instrument_id", "=", vti.id)
        .execute();
      expect(closes).toEqual([{ date: "2026-05-29" }]);
    }),
  );

  it(
    "writes the close for a quote exactly seven days before today, the window's own edge",
    withDatabase(async ({ db, seedInstrument }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      const report = await withClockNear("2026-06-15T12:00:00Z", () =>
        refreshQuotes(
          fakeProvider([quote({ symbol: "VTI", asOf: new Date("2026-06-08T20:00:00Z") })]),
          NEW_YORK,
          db,
        ),
      );

      expect(report.closes).toBe(1);
      const closes = await db
        .selectFrom("price_daily")
        .select("date")
        .where("instrument_id", "=", vti.id)
        .execute();
      expect(closes.map((row) => row.date)).toEqual(["2026-06-08"]);
    }),
  );

  it(
    "warns naming the symbol whose close the window refused",
    withDatabase(async ({ db, seedInstrument }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        await withClockNear("2026-06-15T12:00:00Z", () =>
          refreshQuotes(
            fakeProvider([quote({ symbol: "VTI", asOf: new Date("2026-06-23T20:00:00Z") })]),
            NEW_YORK,
            db,
          ),
        );

        expect(warn.mock.calls.some((call) => String(call[0]).includes("VTI"))).toBe(true);
      } finally {
        warn.mockRestore();
      }
    }),
  );
});

describe("a symbol that does not come back", () => {
  it(
    "keeps the last known price and marks it stale, never zeroing it",
    withDatabase(async ({ db, seedInstrument, seedQuote }) => {
      const gone = await seedInstrument({ symbol: "GONE", priceSource: "feed" });
      await seedQuote({ instrument: gone, price: "42.0000", isStale: false });

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

      const report = await withClockNear("2026-06-05T21:00:00Z", () =>
        refreshQuotes(
          fakeProvider([quote({ symbol: "VTI" }), quote({ symbol: "SURPRISE" })]),
          NEW_YORK,
          db,
        ),
      );

      // The fake hands back both; only the requested one has an instrument to
      // belong to, so only it is written.
      expect(report.priced).toBe(1);
      const rows = await db.selectFrom("price_daily").selectAll().execute();
      expect(rows.filter((row) => row.close === "100.0000")).toHaveLength(1);
    }),
  );
});

describe("a provider that fails outright", () => {
  it(
    "marks every selected instrument stale rather than leaving yesterday's prices looking current",
    withDatabase(async ({ db, seedInstrument, seedQuote }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedQuote({ instrument: vti, price: "271.5000", isStale: false });

      const report = await refreshQuotes(brokenProvider(), NEW_YORK, db);

      const stored = await db
        .selectFrom("quote")
        .selectAll()
        .where("instrument_id", "=", vti.id)
        .executeTakeFirstOrThrow();

      // The price is kept and used; the flag is what changes. That this
      // resolves at all is the other half: a poll is a background concern and
      // a provider outage is the expected case §6.1 plans for, so the report
      // comes back rather than the failure reaching a caller with no catch.
      expect(stored.price).toBe("271.5000");
      expect(stored.is_stale).toBe(true);
      expect(report.stale).toBe(1);
      expect(report.priced).toBe(0);
    }),
  );

  it(
    "writes no price when the provider fails",
    withDatabase(async ({ db, seedInstrument }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      await refreshQuotes(brokenProvider(), NEW_YORK, db);

      const closes = await db
        .selectFrom("price_daily")
        .selectAll()
        .where("instrument_id", "=", vti.id)
        .execute();

      expect(closes).toEqual([]);
    }),
  );
});

describe("matching a quote to an instrument", () => {
  it(
    "matches regardless of the case the symbol was typed in",
    withDatabase(async ({ db, seedInstrument }) => {
      // Yahoo answers in its own canonical case. An instrument stored as `vti`
      // would otherwise never match, and would mark itself stale on every run
      // forever with nothing in the log naming it.
      const lower = await seedInstrument({ symbol: "vti", priceSource: "feed" });

      const report = await refreshQuotes(
        fakeProvider([quote({ symbol: "VTI", price: "271.5000" })]),
        NEW_YORK,
        db,
      );

      expect(report.priced).toBe(1);
      const stored = await db
        .selectFrom("quote")
        .select("price")
        .where("instrument_id", "=", lower.id)
        .executeTakeFirstOrThrow();
      expect(stored.price).toBe("271.5000");
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
    "ignores the USD row, whose timestamp is written once by the migration and never again",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote, usdInstrument }) => {
      // Every bank and loan account holds a USD position, and the seeded USD
      // quote's `as_of` is stamped at install and never updated. Counting it
      // would pin the "as of" line to the install date for the life of the
      // instance — a banner that never moves is worse than no banner.
      const usd = await usdInstrument();
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      const priced = new Date("2030-06-05T20:00:00Z");
      await seedQuote({ instrument: vti, price: "271.5000", asOf: priced });

      const bank = await seedAccount({ kind: "bank" });
      await seedPositionSet({
        account: bank,
        asOf: "2030-06-05",
        holdings: [{ instrument: usd, quantity: "5000" }],
      });

      const brokerage = await seedAccount({ kind: "brokerage" });
      await seedPositionSet({
        account: brokerage,
        asOf: "2030-06-05",
        holdings: [{ instrument: vti, quantity: "10" }],
      });

      const freshness = await priceFreshness(db);

      expect(freshness.oldest).toEqual(priced);
      expect(freshness.priced).toBe(1);
    }),
  );

  it(
    "counts an instrument once however many accounts hold it",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedQuote({ instrument: vti, price: "271.5000", isStale: true });

      for (const kind of ["brokerage", "ira"] as const) {
        const account = await seedAccount({ kind });
        await seedPositionSet({
          account,
          asOf: "2030-06-05",
          holdings: [{ instrument: vti, quantity: "10" }],
        });
      }

      const freshness = await priceFreshness(db);

      // One fund that is stale, not two — the figure is read as "1 of 1 prices
      // is stale", and holdings are not prices.
      expect(freshness.stale).toBe(1);
      expect(freshness.priced).toBe(1);
    }),
  );

  it(
    "backfills what the provider calls an instrument, and keeps it current",
    withDatabase(async ({ db, seedInstrument }) => {
      // Created before the column was written at all, which is every
      // instrument on an instance older than the gains panel.
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed", quoteType: null });

      await refreshQuotes(fakeProvider([quote({ symbol: "VTI", quoteType: "ETF" })]), NEW_YORK, db);

      const after = await db
        .selectFrom("instrument")
        .select("quote_type")
        .where("id", "=", vti.id)
        .executeTakeFirstOrThrow();

      // Without this the Analysis split would be right only for instruments
      // added after the column started being filled in, and every older
      // holding would sit in the catch-all row.
      expect(after.quote_type).toBe("ETF");
    }),
  );

  it(
    "leaves the stored type alone when the provider does not say",
    withDatabase(async ({ db, seedInstrument }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed", quoteType: "ETF" });

      await refreshQuotes(
        fakeProvider([quote({ symbol: "VTI", quoteType: null })]),
        NEW_YORK,
        db,
      );

      const after = await db
        .selectFrom("instrument")
        .select("quote_type")
        .where("id", "=", vti.id)
        .executeTakeFirstOrThrow();

      // A terse payload is the provider saying less, not the instrument
      // becoming unclassifiable.
      expect(after.quote_type).toBe("ETF");
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

describe("the observation log", () => {
  it(
    "writes one observation per provider instant, beside the quote and the close",
    withDatabase(async ({ db, seedInstrument }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      await refreshQuotes(
        fakeProvider([
          quote({ symbol: "VTI", price: "271.5000", asOf: new Date("2026-06-05T17:00:00Z") }),
        ]),
        NEW_YORK,
        db,
      );

      const rows = await db
        .selectFrom("price_observation")
        .selectAll()
        .where("instrument_id", "=", vti.id)
        .execute();

      expect(rows).toHaveLength(1);
      expect(rows[0]?.price).toBe("271.5000");
      expect(rows[0]?.as_of).toEqual(new Date("2026-06-05T17:00:00Z"));
      expect(rows[0]?.fetched_at).toEqual(new Date("2026-06-05T20:00:05Z"));
    }),
  );

  it(
    "files the observation under the market date inside the instant, not under the day it arrived",
    withDatabase(async ({ db, seedInstrument }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      // The same 21:30 New York evening NAV the daily close is filed by. An
      // observation stamped with the UTC day would land the whole session on
      // the wrong side of midnight, and 1D resolves its session off this
      // column.
      await refreshQuotes(
        fakeProvider([quote({ symbol: "VTI", asOf: new Date("2026-06-06T01:30:00Z") })]),
        NEW_YORK,
        db,
      );

      const rows = await db
        .selectFrom("price_observation")
        .select("market_date")
        .where("instrument_id", "=", vti.id)
        .execute();

      expect(rows.map((row) => row.market_date)).toEqual(["2026-06-05"]);
    }),
  );

  it(
    "writes nothing for an instant it already holds, keeping the price it first recorded",
    withDatabase(async ({ db, seedInstrument }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const asOf = new Date("2026-06-05T17:00:00Z");

      await refreshQuotes(fakeProvider([quote({ symbol: "VTI", price: "270.0000", asOf })]), NEW_YORK, db);
      await refreshQuotes(fakeProvider([quote({ symbol: "VTI", price: "271.5000", asOf })]), NEW_YORK, db);

      const rows = await db
        .selectFrom("price_observation")
        .selectAll()
        .where("instrument_id", "=", vti.id)
        .execute();

      // One instant, one row. The second price is the divergence ADR-0006
      // accepts rather than reconciles: `quote` upserts to it and the log
      // keeps the first.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.price).toBe("270.0000");

      const current = await db
        .selectFrom("quote")
        .select("price")
        .where("instrument_id", "=", vti.id)
        .executeTakeFirstOrThrow();

      expect(current.price).toBe("271.5000");
    }),
  );

  it(
    "appends a second row when the provider states a new instant",
    withDatabase(async ({ db, seedInstrument }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      await refreshQuotes(
        fakeProvider([quote({ symbol: "VTI", price: "270.0000", asOf: new Date("2026-06-05T17:00:00Z") })]),
        NEW_YORK,
        db,
      );
      await refreshQuotes(
        fakeProvider([quote({ symbol: "VTI", price: "271.5000", asOf: new Date("2026-06-05T17:15:00Z") })]),
        NEW_YORK,
        db,
      );

      const rows = await db
        .selectFrom("price_observation")
        .select(["as_of", "price"])
        .where("instrument_id", "=", vti.id)
        .orderBy("as_of")
        .execute();

      expect(rows.map((row) => row.price)).toEqual(["270.0000", "271.5000"]);
    }),
  );

  it(
    "archives the provider's raw entry when it is offered, and stores null when it is not",
    withDatabase(async ({ db, seedInstrument }) => {
      const withRaw = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const withoutRaw = await seedInstrument({ symbol: "BND", priceSource: "feed" });

      await refreshQuotes(
        fakeProvider([
          quote({ symbol: "VTI", payload: { symbol: "VTI", regularMarketPrice: 271.5, marketState: "REGULAR" } }),
          quote({ symbol: "BND" }),
        ]),
        NEW_YORK,
        db,
      );

      const archived = await db
        .selectFrom("price_observation")
        .select("payload")
        .where("instrument_id", "=", withRaw.id)
        .executeTakeFirstOrThrow();

      // Round-tripped as jsonb, and read back only to assert it survived —
      // ADR-0006 makes `price` the only column anything may compute from.
      expect(archived.payload).toEqual({
        symbol: "VTI",
        regularMarketPrice: 271.5,
        marketState: "REGULAR",
      });

      const bare = await db
        .selectFrom("price_observation")
        .select("payload")
        .where("instrument_id", "=", withoutRaw.id)
        .executeTakeFirstOrThrow();

      // A fake has no raw entry to hand over, and one absent is not one
      // missing: the observation is still an observation.
      expect(bare.payload).toBeNull();
    }),
  );

  it(
    "writes no observation for a provider that failed, though the price is kept and flagged",
    withDatabase(async ({ db, seedInstrument, seedQuote }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedQuote({ instrument: vti, price: "271.5000", isStale: false });

      await refreshQuotes(brokenProvider(), NEW_YORK, db);

      // The absence is the truth about that instant. A carried-forward price is
      // the current answer, not something the feed said.
      const rows = await db.selectFrom("price_observation").selectAll().execute();
      expect(rows).toEqual([]);

      const stored = await db
        .selectFrom("quote")
        .select("is_stale")
        .where("instrument_id", "=", vti.id)
        .executeTakeFirstOrThrow();

      expect(stored.is_stale).toBe(true);
    }),
  );

  it(
    "rolls back with the quote and the close when a later write in the same refresh fails",
    withDatabase(async ({ db, seedInstrument }) =>
      // The clock matters here even though the window is not the subject: the
      // fixtures are struck in June, so under a real clock no close would be
      // written at all and the `price_daily` assertion below would hold
      // whether or not the transaction rolled back.
      withClockNear("2026-06-05T21:00:00Z", async () => {
      const good = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedInstrument({ symbol: "BAD", priceSource: "feed" });

      // A savepoint, because the refusal below aborts the transaction this test
      // body runs in, and every assertion after it would then fail on that
      // rather than on the rule. Rolling back to the savepoint recovers the
      // transaction and leaves exactly the question worth asking: what survived?
      await sql`savepoint before_refresh`.execute(db);

      await expect(
        refreshQuotes(
          fakeProvider([
            quote({ symbol: "VTI", price: "271.5000" }),
            // Five integer digits into `quote.yield_pct`, which is
            // numeric(10, 6) and holds four. Chosen because it is a column the
            // *quote* tier has and the observation log does not: the batched
            // observation insert runs first and succeeds, so both instruments'
            // observations are on disk when this refusal lands. Anything the
            // observation insert itself rejected would make the assertions below
            // true for a refresh that never wrote an observation at all.
            quote({ symbol: "BAD", yieldPct: "99999.000000" }),
          ]),
          NEW_YORK,
          db,
        ),
      ).rejects.toThrow();

      await sql`rollback to savepoint before_refresh`.execute(db);

      // All three tiers, or none. Writing them in one transaction is what makes
      // an observation without the quote it was written beside impossible.
      expect(await db.selectFrom("price_observation").selectAll().execute()).toEqual([]);
      expect(
        await db.selectFrom("quote").select("instrument_id").where("instrument_id", "=", good.id).execute(),
      ).toEqual([]);
      expect(
        await db.selectFrom("price_daily").select("instrument_id").where("instrument_id", "=", good.id).execute(),
      ).toEqual([]);
      }),
    ),
  );
});

describe("the archive cap", () => {
  it(
    "drops a payload one byte over the cap",
    withDatabase(async ({ db, seedInstrument }) => {
      // The mirror of the at-cap case. Without it any cap up to the 33 KB the
      // oversize case uses would pass, and "over 32 KB" would be untrue across
      // a whole kilobyte.
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const envelope = JSON.stringify({ symbol: "VTI", note: "" }).length;
      const payload = { symbol: "VTI", note: "x".repeat(32 * 1024 - envelope + 1) };
      expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBe(32 * 1024 + 1);

      await withClockNear("2026-06-05T21:00:00Z", () =>
        refreshQuotes(fakeProvider([quote({ symbol: "VTI", payload })]), NEW_YORK, db),
      );

      const observation = await db
        .selectFrom("price_observation")
        .select("payload")
        .where("instrument_id", "=", vti.id)
        .executeTakeFirstOrThrow();
      expect(observation.payload).toBeNull();
    }),
  );

  it(
    "archives a payload of exactly the cap, which is not over it",
    withDatabase(async ({ db, seedInstrument }) => {
      // The rule is "over 32 KB", so the cap itself is the last size that
      // still lands. Without this, tightening the comparison to `>=` would
      // silently drop a payload the contract keeps.
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const envelope = JSON.stringify({ symbol: "VTI", note: "" }).length;
      const payload = { symbol: "VTI", note: "x".repeat(32 * 1024 - envelope) };
      expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBe(32 * 1024);

      await withClockNear("2026-06-05T21:00:00Z", () =>
        refreshQuotes(fakeProvider([quote({ symbol: "VTI", payload })]), NEW_YORK, db),
      );

      const observation = await db
        .selectFrom("price_observation")
        .select("payload")
        .where("instrument_id", "=", vti.id)
        .executeTakeFirstOrThrow();
      expect(observation.payload).not.toBeNull();
    }),
  );

  it(
    "drops a payload over 32 KB, warning with the symbol, while the quote row still lands",
    withDatabase(async ({ db, seedInstrument }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        // Within the seven-day window, so the only warning possible is the
        // archive cap's — a stray window-skip warning naming the same symbol
        // would let this assertion pass for the wrong reason.
        await withClockNear("2026-06-05T21:00:00Z", () =>
          refreshQuotes(
            fakeProvider([
              quote({ symbol: "VTI", payload: { symbol: "VTI", note: "x".repeat(33 * 1024) } }),
            ]),
            NEW_YORK,
            db,
          ),
        );

        const observation = await db
          .selectFrom("price_observation")
          .select("payload")
          .where("instrument_id", "=", vti.id)
          .executeTakeFirstOrThrow();
        expect(observation.payload).toBeNull();

        const stored = await db
          .selectFrom("quote")
          .select("price")
          .where("instrument_id", "=", vti.id)
          .executeTakeFirstOrThrow();
        expect(stored.price).toBe("100.0000");

        expect(warn.mock.calls.some((call) => String(call[0]).includes("VTI"))).toBe(true);
      } finally {
        warn.mockRestore();
      }
    }),
  );

  it(
    "archives a payload comfortably under the cap",
    withDatabase(async ({ db, seedInstrument }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      await withClockNear("2026-06-05T21:00:00Z", () =>
        refreshQuotes(
          fakeProvider([quote({ symbol: "VTI", payload: { symbol: "VTI", note: "x".repeat(4000) } })]),
          NEW_YORK,
          db,
        ),
      );

      const observation = await db
        .selectFrom("price_observation")
        .select("payload")
        .where("instrument_id", "=", vti.id)
        .executeTakeFirstOrThrow();

      expect(observation.payload).toEqual({ symbol: "VTI", note: "x".repeat(4000) });
    }),
  );

  it(
    "drops a multibyte payload whose UTF-16 length sits under the cap but whose UTF-8 bytes sit over it",
    withDatabase(async ({ db, seedInstrument }) => {
      const vti = await seedInstrument({ symbol: "FX", priceSource: "feed" });

      // "€" is one UTF-16 code unit (`.length` counts it as 1) and three UTF-8
      // bytes. 15,000 of them is ~15 KB by `.length` — comfortably under the
      // 32 KB cap — but ~45 KB by `Buffer.byteLength`, well over it: the case
      // that pins the cap to bytes rather than the string's own `.length`.
      const companyName = "€".repeat(15000);
      const payload = { symbol: "FX", companyName };
      expect(JSON.stringify(payload).length).toBeLessThan(32 * 1024);
      expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeGreaterThan(32 * 1024);

      await withClockNear("2026-06-05T21:00:00Z", () =>
        refreshQuotes(fakeProvider([quote({ symbol: "FX", payload })]), NEW_YORK, db),
      );

      const observation = await db
        .selectFrom("price_observation")
        .select("payload")
        .where("instrument_id", "=", vti.id)
        .executeTakeFirstOrThrow();

      expect(observation.payload).toBeNull();
    }),
  );
});

describe("the poll record", () => {
  it(
    "records the attempt with the report the refresh assembled",
    withDatabase(async ({ db, seedInstrument, seedQuote }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const gone = await seedInstrument({ symbol: "GONE", priceSource: "feed" });
      await seedQuote({ instrument: gone, price: "42.0000" });

      await refreshQuotes(fakeProvider([quote({ symbol: "VTI" })]), NEW_YORK, db);

      const polls = await db.selectFrom("price_poll").selectAll().execute();

      expect(polls).toHaveLength(1);
      expect(polls[0]?.requested).toBe(2);
      expect(polls[0]?.priced).toBe(1);
      expect(polls[0]?.stale).toBe(1);
    }),
  );

  it(
    "records the attempt that found nothing to ask about, without asking",
    withDatabase(async ({ db }) => {
      const provider = fakeProvider([]);

      const report = await refreshQuotes(provider, NEW_YORK, db);

      // Nothing to price, so nothing is asked — but the attempt happened, and a
      // log with no observations for an hour has to be able to say why.
      expect(provider.asked).toEqual([]);
      expect(report).toEqual({
        requested: 0,
        priced: 0,
        stale: 0,
        closes: 0,
        observed: 0,
        providerFailed: false,
      });

      const polls = await db.selectFrom("price_poll").selectAll().execute();
      expect(polls).toHaveLength(1);
      expect(polls[0]?.requested).toBe(0);
    }),
  );

  it(
    "records the attempt whose provider threw",
    withDatabase(async ({ db, seedInstrument }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      await refreshQuotes(brokenProvider(), NEW_YORK, db);

      const polls = await db.selectFrom("price_poll").selectAll().execute();

      // The row that tells a failed provider apart from a quiet market: one
      // instrument asked about, none priced, one stale.
      expect(polls).toHaveLength(1);
      expect(polls[0]?.requested).toBe(1);
      expect(polls[0]?.priced).toBe(0);
      expect(polls[0]?.stale).toBe(1);
    }),
  );

  it(
    "writes one row per attempt, so two quiet refreshes are two rows",
    withDatabase(async ({ db, seedInstrument, seedPoll }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const asOf = new Date("2026-06-05T17:00:00Z");

      // An attempt from before this test's two, so that "appends" is what is
      // being read rather than "wrote exactly two".
      await seedPoll({ startedAt: new Date("2026-06-05T16:45:00Z") });

      await refreshQuotes(fakeProvider([quote({ symbol: "VTI", asOf })]), NEW_YORK, db);
      await refreshQuotes(fakeProvider([quote({ symbol: "VTI", asOf })]), NEW_YORK, db);

      // Dedup means the second refresh wrote no observation at all. Three polls
      // and one observation is exactly the shape that makes the log's silences
      // readable.
      expect(await db.selectFrom("price_poll").selectAll().execute()).toHaveLength(3);
      expect(await db.selectFrom("price_observation").selectAll().execute()).toHaveLength(1);
    }),
  );
});
