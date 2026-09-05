/**
 * `POST /refresh` — what the route itself owns, apart from `runRefresh`'s own
 * rules. The `done`/`busy`/`error` decisions are `runRefresh`'s own tests
 * (`tests/refresh.test.ts`); this file exists because no route test covered
 * this action before the price-worker cutover gave it a real default
 * provider to run — the route never names one of its own (`app/routes/refresh.ts`).
 *
 * `runRefresh`'s default parameter is `socketProvider()` from this ticket on,
 * so every case below that runs a real refresh dials the socket for real.
 * `SOCKET_PATH` never has a worker behind it except in "the round trip"
 * describe at the bottom: an ordinary case sees `ProviderUnreachable` the
 * same way a deploy without the worker mounted would, and `refreshQuotes`
 * catches that as an ordinary provider failure (`providerFailed: true`) —
 * never as `runRefresh`'s own `error`, which is the database or the lock and
 * nothing else.
 */
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { withDb } from "~/lib/db.server";
import { marketDateOf } from "~/lib/market-hours.ts";
import { refreshPrices } from "~/lib/prices.server";
import { socketProvider } from "~/lib/provider-socket.server";

import { createPool } from "../../server/db.ts";
import { startWorker } from "../../server/price-worker.ts";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import { args, post, redirectTo } from "../support/routes.ts";

import type { YahooClient } from "../../server/yahoo-client.ts";

/**
 * `runRefresh` reads its own configuration (`getConfig().MARKET_TIMEZONE`,
 * and now `PRICE_WORKER_SOCKET` through `socketProvider()`) and
 * `withRefreshLock` reaches the process-wide pool, so both are set before any
 * test runs — `tests/price-poller.test.ts:37`'s precedent: `getConfig()`
 * memoises its first read. One fixed socket path for the whole file: only
 * "the round trip" describe below ever starts a worker on it.
 */
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PRICE_WORKER_SOCKET = join(tmpdir(), `rr-${randomBytes(4).toString("hex")}.sock`);

const { action } = await import("../../app/routes/refresh.ts");

const NEW_YORK = "America/New_York";

afterAll(closeTestDatabase);

describe("what the route owns, apart from runRefresh's own rules", () => {
  it(
    "runs a real refresh through the default provider and returns the outcome as plain data",
    withDatabase(async ({ db, seedInstrument }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const pool = createPool(TEST_DATABASE_URL);

      try {
        const outcome = await withDb(db, () => action(args(post("/refresh", {}))), pool);

        // No worker at `PRICE_WORKER_SOCKET`: `socketProvider()`'s `getQuotes`
        // fails to connect, `refreshQuotes` catches it as an ordinary
        // provider failure, and this is the route's own projection of that
        // `done` report — proof the action actually reaches `runRefresh` and
        // `outcomeOf` rather than something that only looks like it.
        expect(outcome).toEqual({
          status: "done",
          requested: 1,
          priced: 0,
          stale: 1,
          observed: 0,
          providerFailed: true,
        });
      } finally {
        await pool.end();
      }
    }),
  );

  it(
    "redirects back to the given page when the request is a document navigation",
    withDatabase(async ({ db, seedInstrument }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      const pool = createPool(TEST_DATABASE_URL);

      // `post()` takes no headers (`tests/support/routes.ts`) — set directly
      // on the request it returns, the way `withCookie` sets `Cookie`
      // (`tests/support/routes.ts:31-34`). `Sec-Fetch-Mode` is browser-set and
      // unspoofable by the page; a document POST is the one case with no
      // fetcher waiting to render the outcome, so the route redirects instead.
      const request = post("/refresh", { redirectTo: "/holdings?group=account" });
      request.headers.set("Sec-Fetch-Mode", "navigate");

      try {
        const location = await redirectTo(() => withDb(db, () => action(args(request)), pool));

        // `safeReturn` itself is `tests/refresh-control.test.ts`'s to pin;
        // this only proves the route calls it with what the form carried.
        expect(location).toBe("/holdings?group=account");
      } finally {
        await pool.end();
      }
    }),
  );
});

describe("the round trip a worker actually answers", () => {
  it(
    "writes the quote, the closes and a backfilled figure the split un-adjusted, all through one refreshPrices call",
    withDatabase(async ({ db, seedAccount, seedInstrument, seedPositionSet }) => {
      // Real calendar days, not fixed historical ones: `backfillCloses`'s own
      // `until` is `marketDateOf(new Date(), marketTimeZone)`, so a fixture
      // fixed in the past would fall outside the range as soon as the fixture
      // aged past it. 13:30Z is the session open, as `bar()` stamps it
      // elsewhere (`tests/price-provider.test.ts`) — comfortably mid-morning
      // Eastern either side of DST, so it never crosses a UTC/NY day boundary.
      const now = new Date();
      const isoDaysAgo = (n: number) =>
        new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const barAt = (n: number) => new Date(`${isoDaysAgo(n)}T13:30:00Z`);

      const account = await seedAccount();
      const instrument = await seedInstrument({ symbol: "NVDA", priceSource: "feed" });
      await seedPositionSet({
        account,
        asOf: isoDaysAgo(20),
        holdings: [{ instrument, quantity: "10.00000000" }],
      });

      // A quote entry with a `Date` `regularMarketTime`, and a chart with
      // `Date` bars and one `Date`-stamped split — every instant a plain JS
      // `Date`, exactly as the library would hand one back, so the JSON round
      // trip through the worker is what this pins, not the arithmetic alone
      // (`tests/price-provider.test.ts` and `tests/price-backfill.test.ts`
      // already pin the arithmetic itself against a hand-written payload).
      const yahoo: YahooClient = {
        quote: async () => [
          { symbol: "NVDA", regularMarketPrice: 65.5, currency: "USD", regularMarketTime: now },
        ],
        chart: async () => ({
          meta: { currency: "USD" },
          // A 2-for-1 split ten days ago: the fifteen-day-old bar precedes it
          // and must come back un-adjusted (multiplied by 2); the five-day-old
          // bar follows it and is already at the post-split price.
          events: { splits: [{ date: barAt(10), numerator: 2, denominator: 1 }] },
          quotes: [
            { date: barAt(15), close: 100 },
            { date: barAt(5), close: 60 },
          ],
        }),
      };
      const worker = await startWorker({ socketPath: process.env.PRICE_WORKER_SOCKET!, yahoo });

      // No committing handle: the lock is `runRefresh`'s, never
      // `refreshPrices`'s own, so this calls it directly against the test's
      // rolled-back transaction — the shape `tests/price-backfill.test.ts`'s
      // "writes no poll row when no quotes were asked for" case copies.
      try {
        const report = await refreshPrices(socketProvider(), NEW_YORK, { quotes: true }, db);

        expect(report.quotes.requested).toBe(1);
        expect(report.quotes.priced).toBe(1);
        expect(report.quotes.providerFailed).toBe(false);
        expect(report.backfill.written).toBe(2);
      } finally {
        await new Promise<void>((resolve) => worker.close(() => resolve()));
      }

      const quoteRow = await db
        .selectFrom("quote")
        .select("price")
        .where("instrument_id", "=", instrument.id)
        .executeTakeFirst();
      expect(quoteRow?.price).toBe("65.5000");

      const closes = await db
        .selectFrom("price_daily")
        .select(["date", "close"])
        .where("instrument_id", "=", instrument.id)
        .execute();
      const closeOn = new Map(closes.map((row) => [row.date, row.close]));

      // The quote's own write, upserted for today's market date.
      expect(closeOn.get(marketDateOf(now, NEW_YORK))).toBe("65.5000");
      // The backfilled series — the pre-split bar un-adjusted by the 2:1
      // split between it and today, the post-split bar untouched. The exact
      // arithmetic `toProviderHistory` runs, over the socket, JSON round trip
      // and all — the assumption ticket 06 was built on.
      expect(closeOn.get(isoDaysAgo(15))).toBe("200.0000");
      expect(closeOn.get(isoDaysAgo(5))).toBe("60.0000");

      // The price_poll row this wrote rolls back with the transaction —
      // nothing here to delete.
    }),
  );
});
