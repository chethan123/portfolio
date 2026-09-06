// what a refresh stores and refuses to store — real database, fake provider throughout (DESIGN.md §6.1)
import { sql } from "kysely";
import { afterAll, describe, expect, it, vi } from "vitest";

import { refreshQuotes, priceFreshness } from "~/lib/prices.server";
import type { PriceProvider, ProviderQuote } from "~/lib/price-provider.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";

afterAll(closeTestDatabase);

const NEW_YORK = "America/New_York";

// returns quotes verbatim, unfiltered — a filtering fake once made the unrequested-symbol test unfailable
function fakeProvider(quotes: ProviderQuote[]): PriceProvider & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    async getQuotes(symbols) {
      asked.push([...symbols]);
      return quotes;
    },
    async getDailyCloses() {
      return { status: "no-history" };
    },
  };
}

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

const quote = (overrides: Partial<ProviderQuote> & { symbol: string }): ProviderQuote => ({
  price: "100.0000",
  quoteType: "ETF",
  yieldPct: null,
  annualDividendPerShare: null,
  asOf: new Date("2026-06-05T20:00:00Z"),
  // a few seconds after the instant it struck — why fetchedAt is required, distinct from asOf
  fetchedAt: new Date("2026-06-05T20:00:05Z"),
  ...overrides,
});

// pins today's market date near the fixtures' 2026 dates so the seven-day window doesn't refuse them (price-backfill.test.ts:965-978's shape)
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
      await seedInstrument({ symbol: null, name: "Target 2045 Trust II", priceSource: "manual" });
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
        const first = await refreshQuotes(fakeProvider([quote({ symbol: "VTI" })]), NEW_YORK, db);
        const second = await refreshQuotes(fakeProvider([quote({ symbol: "VTI" })]), NEW_YORK, db);

        expect(first.observed).toBe(1);

        // without `observed`, the second press would claim to update a re-read price
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

      // identical aggregates otherwise — providerFailed is the only thing distinguishing feed-down from wrong-symbol
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

      // 01:30 UTC on the 6th = 21:30 on the 5th NY — filed under the 6th, the real 6th close would overwrite and lose it
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

      // §6.2: an intraday refresh must never corrupt history
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

      // byte-identical: proves the window guard left it alone, not a coincidental matching rewrite
      const close = await db
        .selectFrom("price_daily")
        .select("close")
        .where("instrument_id", "=", vti.id)
        .where("date", "=", "2026-06-07")
        .executeTakeFirstOrThrow();
      expect(close.close).toBe("265.0000");

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
      // without this edge, narrowing the future half to six days would still pass
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
      // 02:00 UTC is the previous evening in NY — both sides must speak the market's calendar or the window slides a day
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      const report = await withClockNear("2026-06-06T02:00:00Z", () =>
        refreshQuotes(
          fakeProvider([quote({ symbol: "VTI", asOf: new Date("2026-05-29T20:00:00Z") })]),
          NEW_YORK,
          db,
        ),
      );

      // market today is 06-05: 05-29 is exactly the past edge; read as UTC today (06-06) it'd be eight days back, refused
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

      // §6.2: never zero, never null into a sum
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

      // no row, not a row claiming zero — holding_valued reports the absence as is_priced=false
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

      // resolves rather than throwing — §6.1 expects provider outages, a poll is background
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
      // Yahoo answers in its own canonical case — stored lowercase would never match, going stale silently forever
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

      // §11: newest reading would call this portfolio current while one holding failed for a week
      expect(freshness.oldest).toEqual(week);
      expect(freshness.stale).toBe(1);
      expect(freshness.priced).toBe(2);
    }),
  );

  it(
    "ignores the USD row, whose timestamp is written once by the migration and never again",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote, usdInstrument }) => {
      // USD's as_of is stamped at install and never updated — counting it would pin the "as of" banner forever
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

      // one stale fund, not two — read as "1 of 1 prices is stale"; holdings aren't prices
      expect(freshness.stale).toBe(1);
      expect(freshness.priced).toBe(1);
    }),
  );

  it(
    "backfills what the provider calls an instrument, and keeps it current",
    withDatabase(async ({ db, seedInstrument }) => {
      // quoteType: null is every instrument created before the column existed
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed", quoteType: null });

      await refreshQuotes(fakeProvider([quote({ symbol: "VTI", quoteType: "ETF" })]), NEW_YORK, db);

      const after = await db
        .selectFrom("instrument")
        .select("quote_type")
        .where("id", "=", vti.id)
        .executeTakeFirstOrThrow();

      // without this backfill, every instrument older than the column would sit in Analysis's catch-all row
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

      // a terse payload is the provider saying less, not the instrument becoming unclassifiable
      expect(after.quote_type).toBe("ETF");
    }),
  );

  it(
    "reports nothing on an instance that holds nothing",
    withDatabase(async ({ db }) => {
      const freshness = await priceFreshness(db);

      // empty instance must not render a figure — zero and absence are different facts, only one is alarming
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

      // same 21:30 NY evening NAV as the daily close — UTC-stamped, it'd land the session on the wrong side of midnight (1D resolves off this column)
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

      // ADR-0006 accepts the divergence rather than reconciling it: quote upserts, the log keeps the first
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

      // ADR-0006 makes price the only column anything may compute from — payload is round-tripped, not derived from
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

      // a fake has no raw entry — absent isn't missing, the observation still stands
      expect(bare.payload).toBeNull();
    }),
  );

  it(
    "writes no observation for a provider that failed, though the price is kept and flagged",
    withDatabase(async ({ db, seedInstrument, seedQuote }) => {
      const vti = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedQuote({ instrument: vti, price: "271.5000", isStale: false });

      await refreshQuotes(brokenProvider(), NEW_YORK, db);

      // the absence is the truth about that instant — a carried-forward price isn't something the feed said
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
      // under a real clock no close would be written at all, so the assertion below would hold regardless of the rollback
      withClockNear("2026-06-05T21:00:00Z", async () => {
      const good = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedInstrument({ symbol: "BAD", priceSource: "feed" });

      // the refusal below aborts the transaction this body runs in — rolling back to a savepoint recovers it
      await sql`savepoint before_refresh`.execute(db);

      await expect(
        refreshQuotes(
          fakeProvider([
            quote({ symbol: "VTI", price: "271.5000" }),
            // yield_pct overflow (numeric(10,6), 5 digits) — the observation log lacks this column, so its insert succeeds first
            quote({ symbol: "BAD", yieldPct: "99999.000000" }),
          ]),
          NEW_YORK,
          db,
        ),
      ).rejects.toThrow();

      await sql`rollback to savepoint before_refresh`.execute(db);

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
      // mirror of the at-cap case — without it any cap up to 33KB would pass "over 32KB"
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
      // rule is "over 32KB" — the cap itself is the last size that still lands
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
        // within the seven-day window, so the only possible warning is the archive cap's, not a window-skip
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

      // "€" is 1 UTF-16 unit but 3 UTF-8 bytes: 15,000 is ~15KB by .length but ~45KB by byteLength — pins the cap to bytes
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

      // nothing asked, but the attempt happened — a quiet hour's log still has a row
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

      // asked/priced/stale together tell a failed provider apart from a quiet market
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

      // an existing attempt before this test's two — pins "appends", not "wrote exactly two"
      await seedPoll({ startedAt: new Date("2026-06-05T16:45:00Z") });

      await refreshQuotes(fakeProvider([quote({ symbol: "VTI", asOf })]), NEW_YORK, db);
      await refreshQuotes(fakeProvider([quote({ symbol: "VTI", asOf })]), NEW_YORK, db);

      // three polls, one observation — dedup shows up as the second refresh writing no observation
      expect(await db.selectFrom("price_poll").selectAll().execute()).toHaveLength(3);
      expect(await db.selectFrom("price_observation").selectAll().execute()).toHaveLength(1);
    }),
  );
});
