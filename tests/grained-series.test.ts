// readGrainedSeries (spec 0022, ticket 02): the instants x holdings shape spec 0016 retired for
// 1D, bounded by the grain rather than the cadence. Every window below is fixed to
// America/New_York, and every seedObservation passes marketDate explicitly (tests/support/fixtures.ts).
import { afterAll, describe, expect, it } from "vitest";

import {
  accountGrainedSeries,
  netWorthAt,
  netWorthGrainedSeries,
} from "~/lib/valuation.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";
import { ALL_OWNERS } from "../app/lib/owner-filter.ts";

afterAll(closeTestDatabase);

const NY = "America/New_York";

describe("the grained series", () => {
  it(
    "values a step's point at each holding's latest observation, and an instrument unobserved that day at its close strictly before the day",
    withDatabase(async (ctx) => {
      const account = await ctx.seedAccount();
      const observed = await ctx.seedInstrument({ symbol: "OBS" });
      const quiet = await ctx.seedInstrument({ symbol: "QUIET" });
      await ctx.seedPositionSet({
        account,
        asOf: "2026-06-04",
        holdings: [
          { instrument: observed, quantity: "10.00000000" },
          { instrument: quiet, quantity: "5.00000000" },
        ],
      });
      await ctx.seedDailyClose({ instrument: quiet, date: "2026-06-04", close: "50.0000" });
      await ctx.seedObservation({
        instrument: observed,
        asOf: "2026-06-05T14:00:00Z",
        price: "120.0000",
        marketDate: "2026-06-05",
      });

      const series = await netWorthGrainedSeries(
        ALL_OWNERS,
        { dates: ["2026-06-04", "2026-06-05"], grainMinutes: 60, timeZone: NY },
        ctx.db,
      );

      expect(series.find((point) => !point.dated)).toEqual({
        at: "2026-06-05T14:00:00.000Z",
        amount: "1450.0000",
        coverage: { known: 2, total: 2 },
      });
    }),
  );

  it(
    "reports the window's first day as its close alone, even with observations that day, agreeing with netWorthAt to the character",
    withDatabase(async (ctx) => {
      const account = await ctx.seedAccount();
      const instrument = await ctx.seedInstrument({ symbol: "VTI" });
      await ctx.seedPositionSet({
        account,
        asOf: "2026-06-04",
        holdings: [{ instrument, quantity: "7.00000000" }],
      });
      await ctx.seedDailyClose({ instrument, date: "2026-06-04", close: "30.0000" });
      // Observed the same day — must not leak into the dated point.
      await ctx.seedObservation({
        instrument,
        asOf: "2026-06-04T14:00:00Z",
        price: "999.0000",
        marketDate: "2026-06-04",
      });

      const [point] = await netWorthGrainedSeries(
        ALL_OWNERS,
        { dates: ["2026-06-04"], grainMinutes: 60, timeZone: NY },
        ctx.db,
      );
      const reference = await netWorthAt(ALL_OWNERS, "2026-06-04", ctx.db);

      expect(point).toEqual({
        at: "2026-06-04",
        amount: reference.amount,
        coverage: reference.coverage,
        dated: true,
      });
      expect(point?.amount).toBe("210.0000");
    }),
  );

  it(
    "reports a Saturday and a Sunday as dated points carrying Friday's close",
    withDatabase(async (ctx) => {
      const account = await ctx.seedAccount();
      const instrument = await ctx.seedInstrument({ symbol: "BND" });
      await ctx.seedPositionSet({
        account,
        asOf: "2026-06-04",
        holdings: [{ instrument, quantity: "2.00000000" }],
      });
      await ctx.seedDailyClose({ instrument, date: "2026-06-05", close: "10.0000" });

      const series = await netWorthGrainedSeries(
        ALL_OWNERS,
        {
          dates: ["2026-06-04", "2026-06-05", "2026-06-06", "2026-06-07"],
          grainMinutes: 60,
          timeZone: NY,
        },
        ctx.db,
      );

      expect(series.find((point) => point.at === "2026-06-06")).toEqual({
        at: "2026-06-06",
        amount: "20.0000",
        coverage: { known: 1, total: 1 },
        dated: true,
      });
      expect(series.find((point) => point.at === "2026-06-07")).toEqual({
        at: "2026-06-07",
        amount: "20.0000",
        coverage: { known: 1, total: 1 },
        dated: true,
      });
    }),
  );

  it(
    "contributes nothing for a step with no observation, so an outage inside a session leaves no point between the one before and the one after",
    withDatabase(async (ctx) => {
      const account = await ctx.seedAccount();
      const instrument = await ctx.seedInstrument({ symbol: "Z" });
      await ctx.seedPositionSet({
        account,
        asOf: "2026-06-04",
        holdings: [{ instrument, quantity: "1.00000000" }],
      });
      // 10:00 and 13:00 New York — a two-hour outage between them, at an hour's grain.
      await ctx.seedObservation({
        instrument,
        asOf: "2026-06-05T14:00:00Z",
        price: "100.0000",
        marketDate: "2026-06-05",
      });
      await ctx.seedObservation({
        instrument,
        asOf: "2026-06-05T17:00:00Z",
        price: "110.0000",
        marketDate: "2026-06-05",
      });

      const series = await netWorthGrainedSeries(
        ALL_OWNERS,
        { dates: ["2026-06-04", "2026-06-05"], grainMinutes: 60, timeZone: NY },
        ctx.db,
      );

      expect(series.filter((point) => !point.dated).map((point) => [point.at, point.amount])).toEqual([
        ["2026-06-05T14:00:00.000Z", "100.0000"],
        ["2026-06-05T17:00:00.000Z", "110.0000"],
      ]);
    }),
  );

  it(
    "plots one point, at the NAV's instant, for a day whose only observation is an evening NAV",
    withDatabase(async (ctx) => {
      const account = await ctx.seedAccount();
      const fund = await ctx.seedInstrument({ symbol: "FUND", quoteType: "MUTUALFUND" });
      await ctx.seedPositionSet({
        account,
        asOf: "2026-06-04",
        holdings: [{ instrument: fund, quantity: "100.00000000" }],
      });
      // Struck 21:15 New York, fetched the next morning: UTC day would misdate it without marketDate.
      await ctx.seedObservation({
        instrument: fund,
        asOf: "2026-06-06T01:15:00Z",
        price: "12.3400",
        marketDate: "2026-06-05",
      });

      const series = await netWorthGrainedSeries(
        ALL_OWNERS,
        { dates: ["2026-06-04", "2026-06-05"], grainMinutes: 180, timeZone: NY },
        ctx.db,
      );

      expect(series.filter((point) => !point.dated)).toEqual([
        {
          at: "2026-06-06T01:15:00.000Z",
          amount: "1234.0000",
          coverage: { known: 1, total: 1 },
        },
      ]);
    }),
  );

  it(
    "prices the point before an evening NAV off yesterday's NAV and the NAV's own point off today's, without counting a holding twice",
    withDatabase(async (ctx) => {
      const account = await ctx.seedAccount();
      const e1 = await ctx.seedInstrument({ symbol: "E1" });
      const e2 = await ctx.seedInstrument({ symbol: "E2" });
      const fund = await ctx.seedInstrument({ symbol: "FUND", quoteType: "MUTUALFUND" });
      await ctx.seedPositionSet({
        account,
        asOf: "2026-06-04",
        holdings: [
          { instrument: e1, quantity: "1.00000000" },
          { instrument: e2, quantity: "1.00000000" },
          { instrument: fund, quantity: "1.00000000" },
        ],
      });
      // Yesterday's NAV.
      await ctx.seedObservation({
        instrument: fund,
        asOf: "2026-06-04T22:00:00Z",
        price: "10.0000",
        marketDate: "2026-06-04",
      });
      // Two equities through the day, before the fund's NAV.
      await ctx.seedObservation({
        instrument: e1,
        asOf: "2026-06-05T19:05:00Z",
        price: "50.0000",
        marketDate: "2026-06-05",
      });
      await ctx.seedObservation({
        instrument: e2,
        asOf: "2026-06-05T19:10:00Z",
        price: "60.0000",
        marketDate: "2026-06-05",
      });
      // Today's NAV, at 18:00 New York.
      await ctx.seedObservation({
        instrument: fund,
        asOf: "2026-06-05T22:00:00Z",
        price: "12.0000",
        marketDate: "2026-06-05",
      });

      const series = await netWorthGrainedSeries(
        ALL_OWNERS,
        { dates: ["2026-06-04", "2026-06-05"], grainMinutes: 180, timeZone: NY },
        ctx.db,
      );

      expect(series.filter((point) => !point.dated)).toEqual([
        {
          at: "2026-06-05T19:10:00.000Z",
          amount: "120.0000", // 50 + 60 + yesterday's 10
          coverage: { known: 3, total: 3 },
        },
        {
          at: "2026-06-05T22:00:00.000Z",
          amount: "122.0000", // 50 + 60 (carried) + today's 12
          coverage: { known: 3, total: 3 },
        },
      ]);
    }),
  );

  it(
    "orders a full window's points across a session, a weekend and the next session, dated days among instants",
    withDatabase(async (ctx) => {
      const account = await ctx.seedAccount();
      const instrument = await ctx.seedInstrument({ symbol: "M" });
      await ctx.seedPositionSet({
        account,
        asOf: "2026-06-04",
        holdings: [{ instrument, quantity: "1.00000000" }],
      });
      await ctx.seedDailyClose({ instrument, date: "2026-06-04", close: "100.0000" });
      // Friday's finished-day close differs from its last observed price — the weekend carries
      // the close, never the last quote.
      await ctx.seedDailyClose({ instrument, date: "2026-06-05", close: "103.0000" });
      await ctx.seedObservation({
        instrument,
        asOf: "2026-06-05T14:00:00Z",
        price: "101.0000",
        marketDate: "2026-06-05",
      });
      await ctx.seedObservation({
        instrument,
        asOf: "2026-06-05T17:00:00Z",
        price: "102.0000",
        marketDate: "2026-06-05",
      });
      await ctx.seedObservation({
        instrument,
        asOf: "2026-06-08T14:00:00Z",
        price: "110.0000",
        marketDate: "2026-06-08",
      });

      const series = await netWorthGrainedSeries(
        ALL_OWNERS,
        {
          dates: ["2026-06-04", "2026-06-05", "2026-06-06", "2026-06-07", "2026-06-08"],
          grainMinutes: 60,
          timeZone: NY,
        },
        ctx.db,
      );

      expect(series).toEqual([
        { at: "2026-06-04", amount: "100.0000", coverage: { known: 1, total: 1 }, dated: true },
        {
          at: "2026-06-05T14:00:00.000Z",
          amount: "101.0000",
          coverage: { known: 1, total: 1 },
        },
        {
          at: "2026-06-05T17:00:00.000Z",
          amount: "102.0000",
          coverage: { known: 1, total: 1 },
        },
        { at: "2026-06-06", amount: "103.0000", coverage: { known: 1, total: 1 }, dated: true },
        { at: "2026-06-07", amount: "103.0000", coverage: { known: 1, total: 1 }, dated: true },
        {
          at: "2026-06-08T14:00:00.000Z",
          amount: "110.0000",
          coverage: { known: 1, total: 1 },
        },
      ]);
    }),
  );

  it(
    "still yields a point on a day observed only for an instrument nobody holds, each held instrument priced off its own latest observation or, failing that, its close strictly before the day",
    withDatabase(async (ctx) => {
      const account = await ctx.seedAccount();
      const held = await ctx.seedInstrument({ symbol: "HELD" });
      const unheld = await ctx.seedInstrument({ symbol: "UNHELD" });
      await ctx.seedPositionSet({
        account,
        asOf: "2026-06-04",
        holdings: [{ instrument: held, quantity: "3.00000000" }],
      });
      // held is never observed — only a close, strictly before the day.
      await ctx.seedDailyClose({ instrument: held, date: "2026-06-04", close: "20.0000" });
      await ctx.seedObservation({
        instrument: unheld,
        asOf: "2026-06-05T15:00:00Z",
        price: "1.0000",
        marketDate: "2026-06-05",
      });

      const series = await netWorthGrainedSeries(
        ALL_OWNERS,
        { dates: ["2026-06-04", "2026-06-05"], grainMinutes: 180, timeZone: NY },
        ctx.db,
      );

      expect(series.filter((point) => !point.dated)).toEqual([
        {
          at: "2026-06-05T15:00:00.000Z",
          amount: "60.0000",
          coverage: { known: 1, total: 1 },
        },
      ]);
    }),
  );

  it(
    "uses the position set in force on the point's day, changing quantities from that day's points on and not before",
    withDatabase(async (ctx) => {
      const account = await ctx.seedAccount();
      const instrument = await ctx.seedInstrument({ symbol: "I" });
      await ctx.seedPositionSet({
        account,
        asOf: "2026-06-04",
        holdings: [{ instrument, quantity: "5.00000000" }],
      });
      // Restated Monday — Friday's points must still read the original quantity.
      await ctx.seedPositionSet({
        account,
        asOf: "2026-06-08",
        holdings: [{ instrument, quantity: "8.00000000" }],
      });
      await ctx.seedObservation({
        instrument,
        asOf: "2026-06-05T15:00:00Z",
        price: "10.0000",
        marketDate: "2026-06-05",
      });
      await ctx.seedObservation({
        instrument,
        asOf: "2026-06-08T15:00:00Z",
        price: "10.0000",
        marketDate: "2026-06-08",
      });

      const series = await netWorthGrainedSeries(
        ALL_OWNERS,
        { dates: ["2026-06-04", "2026-06-05", "2026-06-08"], grainMinutes: 180, timeZone: NY },
        ctx.db,
      );

      expect(series.find((point) => point.at === "2026-06-05T15:00:00.000Z")?.amount).toBe(
        "50.0000",
      );
      expect(series.find((point) => point.at === "2026-06-08T15:00:00.000Z")?.amount).toBe(
        "80.0000",
      );
    }),
  );

  it(
    "counts an account closed inside the window only on the days it was open",
    withDatabase(async (ctx) => {
      // Closed at Monday's own midnight (UTC) — open through Friday, not on Monday itself.
      const account = await ctx.seedAccount({ closedAt: "2026-06-08T00:00:00Z" });
      const instrument = await ctx.seedInstrument({ symbol: "I2" });
      await ctx.seedPositionSet({
        account,
        asOf: "2026-06-04",
        holdings: [{ instrument, quantity: "4.00000000" }],
      });
      await ctx.seedObservation({
        instrument,
        asOf: "2026-06-05T15:00:00Z",
        price: "25.0000",
        marketDate: "2026-06-05",
      });
      await ctx.seedObservation({
        instrument,
        asOf: "2026-06-08T15:00:00Z",
        price: "25.0000",
        marketDate: "2026-06-08",
      });

      const series = await netWorthGrainedSeries(
        ALL_OWNERS,
        { dates: ["2026-06-04", "2026-06-05", "2026-06-08"], grainMinutes: 180, timeZone: NY },
        ctx.db,
      );

      expect(series.find((point) => point.at === "2026-06-05T15:00:00.000Z")).toMatchObject({
        amount: "100.0000",
        coverage: { known: 1, total: 1 },
      });
      expect(series.find((point) => point.at === "2026-06-08T15:00:00.000Z")).toMatchObject({
        amount: "0.0000",
        coverage: { known: 0, total: 0 },
      });
    }),
  );

  describe("grouping steps by the grain", () => {
    it(
      "groups 10:58 and 10:59 into one point and 10:59 and 11:01 into two, at an hour",
      withDatabase(async (ctx) => {
        const instrument = await ctx.seedInstrument({ symbol: "G60" });
        await ctx.seedObservation({
          instrument,
          asOf: "2026-06-05T14:58:00Z",
          price: "1.0000",
          marketDate: "2026-06-05",
        });
        await ctx.seedObservation({
          instrument,
          asOf: "2026-06-05T14:59:00Z",
          price: "1.0000",
          marketDate: "2026-06-05",
        });
        await ctx.seedObservation({
          instrument,
          asOf: "2026-06-05T15:01:00Z",
          price: "1.0000",
          marketDate: "2026-06-05",
        });

        const series = await netWorthGrainedSeries(
          ALL_OWNERS,
          { dates: ["2026-06-04", "2026-06-05"], grainMinutes: 60, timeZone: NY },
          ctx.db,
        );

        expect(series.filter((point) => !point.dated).map((point) => point.at)).toEqual([
          "2026-06-05T14:59:00.000Z",
          "2026-06-05T15:01:00.000Z",
        ]);
      }),
    );

    it(
      "groups 09:31 and 11:59 into one point, at three hours",
      withDatabase(async (ctx) => {
        const instrument = await ctx.seedInstrument({ symbol: "G180" });
        await ctx.seedObservation({
          instrument,
          asOf: "2026-06-08T13:31:00Z",
          price: "1.0000",
          marketDate: "2026-06-08",
        });
        await ctx.seedObservation({
          instrument,
          asOf: "2026-06-08T15:59:00Z",
          price: "1.0000",
          marketDate: "2026-06-08",
        });

        const series = await netWorthGrainedSeries(
          ALL_OWNERS,
          { dates: ["2026-06-07", "2026-06-08"], grainMinutes: 180, timeZone: NY },
          ctx.db,
        );

        expect(series.filter((point) => !point.dated).map((point) => point.at)).toEqual([
          "2026-06-08T15:59:00.000Z",
        ]);
      }),
    );

    it(
      "groups 27 observations fifteen minutes apart into 27 points, at fifteen minutes",
      withDatabase(async (ctx) => {
        const instrument = await ctx.seedInstrument({ symbol: "G15" });
        const start = Date.parse("2026-06-09T13:30:00.000Z");
        const times = Array.from({ length: 27 }, (_, n) =>
          new Date(start + n * 15 * 60_000).toISOString(),
        );
        for (const at of times) {
          await ctx.seedObservation({
            instrument,
            asOf: at,
            price: "1.0000",
            marketDate: "2026-06-09",
          });
        }

        const series = await netWorthGrainedSeries(
          ALL_OWNERS,
          { dates: ["2026-06-08", "2026-06-09"], grainMinutes: 15, timeZone: NY },
          ctx.db,
        );

        expect(series.filter((point) => !point.dated).map((point) => point.at)).toEqual(times);
      }),
    );
  });

  it(
    "lays step boundaries on the market clock, so the same wall-clock pair groups the same way in July and in January",
    withDatabase(async (ctx) => {
      const july = await ctx.seedInstrument({ symbol: "JUL" });
      await ctx.seedObservation({
        instrument: july,
        asOf: "2026-07-06T14:59:00Z", // 10:59 EDT
        price: "1.0000",
        marketDate: "2026-07-06",
      });
      await ctx.seedObservation({
        instrument: july,
        asOf: "2026-07-06T15:01:00Z", // 11:01 EDT
        price: "1.0000",
        marketDate: "2026-07-06",
      });

      const julySeries = await netWorthGrainedSeries(
        ALL_OWNERS,
        { dates: ["2026-07-05", "2026-07-06"], grainMinutes: 60, timeZone: NY },
        ctx.db,
      );

      expect(julySeries.filter((point) => !point.dated).map((point) => point.at)).toEqual([
        "2026-07-06T14:59:00.000Z",
        "2026-07-06T15:01:00.000Z",
      ]);

      const january = await ctx.seedInstrument({ symbol: "JAN" });
      await ctx.seedObservation({
        instrument: january,
        asOf: "2026-01-05T15:59:00Z", // 10:59 EST
        price: "1.0000",
        marketDate: "2026-01-05",
      });
      await ctx.seedObservation({
        instrument: january,
        asOf: "2026-01-05T16:01:00Z", // 11:01 EST
        price: "1.0000",
        marketDate: "2026-01-05",
      });

      const januarySeries = await netWorthGrainedSeries(
        ALL_OWNERS,
        { dates: ["2026-01-04", "2026-01-05"], grainMinutes: 60, timeZone: NY },
        ctx.db,
      );

      expect(januarySeries.filter((point) => !point.dated).map((point) => point.at)).toEqual([
        "2026-01-05T15:59:00.000Z",
        "2026-01-05T16:01:00.000Z",
      ]);
    }),
  );

  it(
    "scores total: 0 for a day before the first position set, on both the dated and the instant branch",
    withDatabase(async (ctx) => {
      await ctx.seedAccount(); // no position set at all
      const instrument = await ctx.seedInstrument({ symbol: "NEW" });
      await ctx.seedObservation({
        instrument,
        asOf: "2026-06-05T15:00:00Z",
        price: "1.0000",
        marketDate: "2026-06-05",
      });

      const series = await netWorthGrainedSeries(
        ALL_OWNERS,
        { dates: ["2026-06-04", "2026-06-05"], grainMinutes: 180, timeZone: NY },
        ctx.db,
      );

      expect(series.find((point) => point.dated)).toEqual({
        at: "2026-06-04",
        amount: "0.0000",
        coverage: { known: 0, total: 0 },
        dated: true,
      });
      for (const point of series.filter((point) => !point.dated)) {
        expect(point.coverage.total).toBe(0);
      }
    }),
  );

  it(
    "narrows both branches by owner, and by account, at an instant and at a dated point",
    withDatabase(async (ctx) => {
      const alice = await ctx.seedPerson({ name: "Alice" });
      const bob = await ctx.seedPerson({ name: "Bob" });
      const aliceAccount = await ctx.seedAccount({ owner: alice });
      const bobAccount = await ctx.seedAccount({ owner: bob });
      const instrument = await ctx.seedInstrument({ symbol: "SHARED" });

      await ctx.seedPositionSet({
        account: aliceAccount,
        asOf: "2026-06-04",
        holdings: [{ instrument, quantity: "10.00000000" }],
      });
      await ctx.seedPositionSet({
        account: bobAccount,
        asOf: "2026-06-04",
        holdings: [{ instrument, quantity: "3.00000000" }],
      });
      await ctx.seedDailyClose({ instrument, date: "2026-06-04", close: "90.0000" });
      await ctx.seedObservation({
        instrument,
        asOf: "2026-06-05T15:00:00Z",
        price: "100.0000",
        marketDate: "2026-06-05",
      });

      const window = { dates: ["2026-06-04", "2026-06-05"], grainMinutes: 180, timeZone: NY };

      const household = await netWorthGrainedSeries(ALL_OWNERS, window, ctx.db);
      expect(household.find((point) => point.dated)?.amount).toBe("1170.0000");
      expect(household.find((point) => !point.dated)?.amount).toBe("1300.0000");

      const aliceOnly = await netWorthGrainedSeries([alice.id], window, ctx.db);
      expect(aliceOnly.find((point) => point.dated)).toEqual({
        at: "2026-06-04",
        amount: "900.0000",
        coverage: { known: 1, total: 1 },
        dated: true,
      });
      expect(aliceOnly.find((point) => !point.dated)).toEqual({
        at: "2026-06-05T15:00:00.000Z",
        amount: "1000.0000",
        coverage: { known: 1, total: 1 },
      });

      const bobsAccount = await accountGrainedSeries(bobAccount.id, window, ctx.db);
      expect(bobsAccount.find((point) => point.dated)).toEqual({
        at: "2026-06-04",
        amount: "270.0000",
        coverage: { known: 1, total: 1 },
        dated: true,
      });
      expect(bobsAccount.find((point) => !point.dated)).toEqual({
        at: "2026-06-05T15:00:00.000Z",
        amount: "300.0000",
        coverage: { known: 1, total: 1 },
      });
    }),
  );

  it(
    "returns [] for an empty window without querying",
    withDatabase(async (ctx) => {
      const window = { dates: [], grainMinutes: 60, timeZone: NY };

      expect(await netWorthGrainedSeries(ALL_OWNERS, window, ctx.db)).toEqual([]);
      expect(await accountGrainedSeries("1", window, ctx.db)).toEqual([]);
    }),
  );
});
