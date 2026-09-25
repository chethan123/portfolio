// POST /refresh — what the route owns, apart from runRefresh's done/busy/error rules (tests/refresh.test.ts). runRefresh's
// default provider is socketProvider() now, so every case here dials the real socket. Only "the round trip" describe below
// starts a worker on it — elsewhere the unreachable socket surfaces as an ordinary providerFailed, never runRefresh's own error.
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { withDb } from "~/lib/db.server";
import { refreshPrices } from "~/lib/prices.server";
import { socketProvider } from "~/lib/provider-socket.server";

import { createPool } from "../../server/db.ts";
import { startWorker } from "../../server/price-worker.ts";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import { args, post, redirectTo } from "../support/routes.ts";

import type { YahooClient } from "../../server/yahoo-client.ts";

// DATABASE_URL/PRICE_WORKER_SOCKET set before any test: getConfig() memoises its first read (tests/price-poller.test.ts:37).
// One fixed socket path file-wide; only "the round trip" describe starts a worker on it.
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

        // No worker listening: getQuotes fails to connect, refreshQuotes catches it as an ordinary provider failure —
        // proof the action actually reaches runRefresh/outcomeOf rather than something that only looks like it.
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

      // Sec-Fetch-Mode is browser-set, unspoofable by the page; a document POST has no fetcher waiting to render the outcome, so the route redirects.
      const request = post("/refresh", { redirectTo: "/holdings?group=account" });
      request.headers.set("Sec-Fetch-Mode", "navigate");

      try {
        const location = await redirectTo(() => withDb(db, () => action(args(request)), pool));

        // safeReturn's own rule is refresh-control.test.ts's; this only proves the route calls it with the form's value.
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
      // 13:30Z is session open (as tests/price-provider.test.ts's bar() stamps it) — clear of any UTC/NY day boundary.
      const now = new Date("2026-06-15T13:30:00Z");

      const account = await seedAccount();
      const instrument = await seedInstrument({ symbol: "NVDA", priceSource: "feed" });
      await seedPositionSet({
        account,
        asOf: "2026-05-26",
        holdings: [{ instrument, quantity: "10.00000000" }],
      });

      // Every instant a plain JS Date, as the library hands back — pins the JSON round trip through the worker, not the
      // arithmetic alone (already pinned against a hand-written payload by price-provider/price-backfill tests).
      const yahoo: YahooClient = {
        quote: async () => [
          { symbol: "NVDA", regularMarketPrice: 65.5, currency: "USD", regularMarketTime: now },
        ],
        chart: async () => ({
          meta: { currency: "USD" },
          // 2-for-1 split on 06-05: the 06-01 bar precedes it (must come back un-adjusted ×2); the 06-10 bar follows (already post-split).
          events: {
            splits: [{ date: new Date("2026-06-05T13:30:00Z"), numerator: 2, denominator: 1 }],
          },
          quotes: [
            { date: new Date("2026-06-01T13:30:00Z"), close: 100 },
            { date: new Date("2026-06-10T13:30:00Z"), close: 60 },
          ],
        }),
      };
      const worker = await startWorker({ socketPath: process.env.PRICE_WORKER_SOCKET!, yahoo });

      // No committing handle needed: the lock is runRefresh's, not refreshPrices' own, so this calls it directly against the rolled-back transaction.
      try {
        const report = await refreshPrices(socketProvider(), NEW_YORK, now, { quotes: true }, db);

        expect(report.quotes).toMatchObject({ requested: 1, priced: 1, providerFailed: false });
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

      expect(closeOn.get("2026-06-15")).toBe("65.5000"); // the quote's own write
      // Backfilled: pre-split bar un-adjusted by the 2:1 split, post-split bar untouched — toProviderHistory's arithmetic, over the socket (ticket 06).
      expect(closeOn.get("2026-06-01")).toBe("200.0000");
      expect(closeOn.get("2026-06-10")).toBe("60.0000");
    }),
  );
});
