// A typed price for an instrument no feed quotes (spec 0031): both tiers written, history kept, and
// every refusal leaving nothing behind.
import { afterAll, describe, expect, it } from "vitest";

import { ALL_OWNERS } from "~/lib/owner-filter";
import { manualPrices, recordManualPrice, refreshQuotes } from "~/lib/prices.server";
import { currentHoldings, holdingsAt, netWorth } from "~/lib/valuation.server";
import type { Database } from "~/lib/db.server";
import type { PriceProvider } from "~/lib/price-provider.server";
import type { Kysely } from "kysely";

import { closeTestDatabase, withDatabase } from "./support/database.ts";
import { refusalOf } from "./support/refusal.ts";

afterAll(closeTestDatabase);

const NOW = new Date("2026-06-05T21:00:00Z");
const TRUST = "Vanguard Target Retirement 2045 Trust II";

describe("a manual price", () => {
  it(
    "prices a never-priced manual holding on every current figure at once",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, usdInstrument }) => {
      const account = await seedAccount();
      const usd = await usdInstrument();
      const trust = await seedInstrument({ symbol: null, name: TRUST, priceSource: "manual" });
      await seedPositionSet({
        account,
        asOf: "2026-05-29",
        holdings: [
          { instrument: trust, quantity: "50.00000000" },
          { instrument: usd, quantity: "100.00000000" },
        ],
      });

      await recordManualPrice({ instrumentId: trust.id, price: "52.41", asOf: "2026-05-29" }, NOW, db);

      const held = (await currentHoldings(ALL_OWNERS, db)).find((h) => h.instrumentId === trust.id);
      expect(held).toMatchObject({ price: "52.4100", value: "2620.5000", isPriced: true });
      expect(await netWorth(ALL_OWNERS, db)).toEqual({
        amount: "2720.5000",
        coverage: { known: 2, total: 2 },
      });
    }),
  );

  it(
    "carries forward to later dates and leaves earlier ones unpriced",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();
      const trust = await seedInstrument({ symbol: null, priceSource: "manual" });
      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: trust, quantity: "10.00000000" }],
      });

      await recordManualPrice({ instrumentId: trust.id, price: "20", asOf: "2026-03-31" }, NOW, db);

      const [before] = await holdingsAt(ALL_OWNERS, "2026-03-30", db);
      const [after] = await holdingsAt(ALL_OWNERS, "2026-05-15", db);
      expect(before).toMatchObject({ isPriced: false, value: null });
      expect(after).toMatchObject({ isPriced: true, price: "20.0000", value: "200.0000" });
    }),
  );

  it(
    "fills history from a back-dated price without moving the current price off the later one",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();
      const trust = await seedInstrument({ symbol: null, priceSource: "manual" });
      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: trust, quantity: "10.00000000" }],
      });

      await recordManualPrice({ instrumentId: trust.id, price: "25", asOf: "2026-05-29" }, NOW, db);
      await recordManualPrice({ instrumentId: trust.id, price: "20", asOf: "2026-01-31" }, NOW, db);

      const [then] = await holdingsAt(ALL_OWNERS, "2026-02-27", db);
      const [now] = await currentHoldings(ALL_OWNERS, db);
      expect(then).toMatchObject({ price: "20.0000" });
      expect(now).toMatchObject({ price: "25.0000" });
      expect(await manualPrices(db)).toMatchObject([
        { id: trust.id, latest: { date: "2026-05-29", price: "25.0000" } },
      ]);
    }),
  );

  it(
    "corrects only its own date when that date is recorded again",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();
      const trust = await seedInstrument({ symbol: null, priceSource: "manual" });
      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: trust, quantity: "10.00000000" }],
      });

      await recordManualPrice({ instrumentId: trust.id, price: "20", asOf: "2026-01-31" }, NOW, db);
      await recordManualPrice({ instrumentId: trust.id, price: "25", asOf: "2026-04-30" }, NOW, db);
      await recordManualPrice({ instrumentId: trust.id, price: "26", asOf: "2026-04-30" }, NOW, db);

      const closes = await db
        .selectFrom("price_daily")
        .select(["date", "close"])
        .where("instrument_id", "=", trust.id)
        .orderBy("date")
        .execute();
      expect(closes).toEqual([
        { date: "2026-01-31", close: "20.0000" },
        { date: "2026-04-30", close: "26.0000" },
      ]);
      const [now] = await currentHoldings(ALL_OWNERS, db);
      expect(now).toMatchObject({ price: "26.0000" });
    }),
  );

  it(
    "is left alone by a refresh, which neither asks about it nor marks it stale",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet, seedQuote }) => {
      const account = await seedAccount();
      const trust = await seedInstrument({ symbol: null, priceSource: "manual" });
      // A held feed instrument the provider fails to answer, so the stale marking actually runs.
      const vti = await seedInstrument({ symbol: "VTI" });
      await seedQuote({ instrument: vti, price: "250.0000" });
      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [
          { instrument: trust, quantity: "10.00000000" },
          { instrument: vti, quantity: "1.00000000" },
        ],
      });
      await recordManualPrice({ instrumentId: trust.id, price: "20", asOf: "2026-01-31" }, NOW, db);

      const asked: string[][] = [];
      const provider: PriceProvider = {
        async getQuotes(symbols) {
          asked.push([...symbols]);
          return [];
        },
        async getDailyCloses() {
          return { status: "no-history" };
        },
        async getTrailingDividend() {
          return { status: "no-data" };
        },
        async probe() {
          throw new Error("This provider is never asked to probe.");
        },
      };
      await refreshQuotes(provider, "America/New_York", NOW, db);

      expect(asked.flat()).toEqual(["VTI"]);
      const held = await currentHoldings(ALL_OWNERS, db);
      expect(held.find((h) => h.instrumentId === vti.id)).toMatchObject({ isStale: true });
      expect(held.find((h) => h.instrumentId === trust.id)).toMatchObject({
        price: "20.0000",
        isPriced: true,
        isStale: false,
      });
    }),
  );
});

describe("a refused manual price", () => {
  async function pricesOf(db: Kysely<Database>) {
    const [daily, quotes] = await Promise.all([
      db.selectFrom("price_daily").select("instrument_id").execute(),
      db.selectFrom("quote").select("instrument_id").execute(),
    ]);
    return { daily: daily.length, quotes: quotes.length };
  }

  it(
    "refuses an instrument priced from the feed, writing nothing",
    withDatabase(async ({ db, seedInstrument }) => {
      const vti = await seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market ETF" });
      const before = await pricesOf(db);

      const refusal = await refusalOf(() =>
        recordManualPrice({ instrumentId: vti.id, price: "250", asOf: "2026-05-29" }, NOW, db),
      );

      expect(refusal.fieldErrors.form).toMatch(/priced from the feed/);
      expect(await pricesOf(db)).toEqual(before);
    }),
  );

  it(
    "refuses an instrument that does not exist, or none chosen, or one with a fixed price",
    withDatabase(async ({ db, usdInstrument }) => {
      const usd = await usdInstrument();
      const refuse = (instrumentId: string) =>
        refusalOf(() => recordManualPrice({ instrumentId, price: "1", asOf: "2026-05-29" }, NOW, db));

      expect((await refuse("999999999")).fieldErrors.form).toMatch(/no longer exists/);
      expect((await refuse("")).fieldErrors.instrumentId).toMatch(/Choose an instrument/);
      expect((await refuse(usd.id)).fieldErrors.form).toMatch(/fixed price/);
    }),
  );

  it(
    "refuses a blank, zero, a minus sign, a fifth decimal place and a future date, each on its field",
    withDatabase(async ({ db, seedInstrument }) => {
      const trust = await seedInstrument({ symbol: null, priceSource: "manual" });
      const before = await pricesOf(db);
      const refuse = (price: string, asOf = "2026-05-29") =>
        refusalOf(() => recordManualPrice({ instrumentId: trust.id, price, asOf }, NOW, db));

      expect((await refuse("0.0000")).fieldErrors.price).toMatch(/more than zero/);
      expect((await refuse("-5")).fieldErrors.price).toMatch(/never negative/);
      expect((await refuse("5.00001")).fieldErrors.price).toMatch(/4 decimal places/);
      expect((await refuse("", "2026-05-29")).fieldErrors.price).toMatch(/required/);
      expect((await refuse("5", "2126-01-01")).fieldErrors.asOf).toMatch(/in the future/);
      expect(await pricesOf(db)).toEqual(before);
    }),
  );

  it(
    "refuses a price whose value at a quantity ever held overflows the money column",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();
      const trust = await seedInstrument({ symbol: null, priceSource: "manual" });
      // An older set, so the guard has to look past the latest one.
      await seedPositionSet({
        account,
        asOf: "2026-01-31",
        holdings: [{ instrument: trust, quantity: "100000000000.00000000" }],
      });
      await seedPositionSet({
        account,
        asOf: "2026-04-30",
        holdings: [{ instrument: trust, quantity: "1.00000000" }],
      });
      const before = await pricesOf(db);

      const refusal = await refusalOf(() =>
        recordManualPrice(
          { instrumentId: trust.id, price: "100000000", asOf: "2026-01-31" },
          NOW,
          db,
        ),
      );

      expect(refusal.fieldErrors.price).toMatch(/larger than this application can store/);
      expect(await pricesOf(db)).toEqual(before);
    }),
  );
});
