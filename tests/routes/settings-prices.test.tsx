// Settings → Prices: the words the gap list puts on screen (ADR-0011), not the ledger's literals. Rendered through the real
// component with the real loader's output (as masked-screens.test.tsx does) — a hand-built loader fixture could silently drift.
import { afterAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { args, post } from "../support/routes.ts";

process.env.DATABASE_URL = TEST_DATABASE_URL;

const Prices = (await import("../../app/routes/settings/prices.tsx")).default;
const { action, loader } = await import("../../app/routes/settings/prices.tsx");

afterAll(closeTestDatabase);

/** The screen at its own address, with what its loader really returned. */
const render = async () => renderRoute(Prices, "/settings/prices", await loader());

describe("the gap list", () => {
  it(
    "says the spine covers everything when there is nothing missing",
    withDatabase(async () => {
      const markup = await render();

      expect(markup).toContain("Price history reaches back as far as every holding does");
      expect(markup).not.toContain("Held from");
    }),
  );

  it(
    "names the instrument, both dates, and what the last attempt came to",
    withDatabase(async ({ seedAccount, seedInstrument, seedPositionSet, seedBackfillAttempt }) => {
      const account = await seedAccount();
      const instrument = await seedInstrument({
        symbol: "ZM",
        name: "Zoom Communications",
        priceSource: "feed",
      });
      await seedPositionSet({
        account,
        asOf: "2019-06-28",
        holdings: [{ instrument, quantity: "1.00000000" }],
      });
      await seedBackfillAttempt({
        instrument,
        startedAt: new Date("2026-06-03T12:00:00Z"),
        outcome: "no_history",
      });

      const markup = await render();

      expect(markup).toContain("Zoom Communications");
      expect(markup).toContain("ZM");
      expect(markup).toContain("2019-06-28");
      expect(markup).toContain("2026-06-03");
      expect(markup).toContain("the feed has no history for this ticker");
      expect(markup).not.toContain("no_history");
    }),
  );

  it(
    "shows the provider's own text for a request that failed",
    withDatabase(async ({ seedAccount, seedInstrument, seedPositionSet, seedBackfillAttempt }) => {
      const account = await seedAccount();
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedPositionSet({
        account,
        asOf: "2024-03-29",
        holdings: [{ instrument, quantity: "1.00000000" }],
      });
      await seedBackfillAttempt({
        instrument,
        startedAt: new Date("2026-06-03T12:00:00Z"),
        outcome: "provider_failed",
        error: "429 Too Many Requests",
      });

      expect(await render()).toContain("429 Too Many Requests");
    }),
  );

  it(
    "says why instead of an attempt for a row nothing will ever fetch",
    withDatabase(async ({ seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();
      const trust = await seedInstrument({
        symbol: "CIT2045",
        name: "Target 2045 Trust II",
        priceSource: "manual",
      });
      await seedPositionSet({
        account,
        asOf: "2024-03-29",
        holdings: [{ instrument: trust, quantity: "1.00000000" }],
      });

      const markup = await render();

      expect(markup).toContain("priced by hand. Record a price dated on or before the held-from date");
      expect(markup).not.toContain("Not tried yet");
    }),
  );

  it(
    "says there is no price history at all with a dash rather than a date",
    withDatabase(async ({ seedAccount, seedInstrument, seedPositionSet }) => {
      const account = await seedAccount();
      const instrument = await seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await seedPositionSet({
        account,
        asOf: "2024-03-29",
        holdings: [{ instrument, quantity: "1.00000000" }],
      });

      const markup = await render();

      expect(markup).toContain("Priced from");
      expect(markup).toContain("Not tried yet");
      // The cell itself — the notes above the table carry em dashes too, which would pass a bare toContain.
      expect(markup).toContain('<td class="u-data">—</td>');
    }),
  );
});

describe("prices typed by hand", () => {
  it(
    "says nothing is priced by hand, and offers no form, when nothing is",
    withDatabase(async ({ seedInstrument }) => {
      await seedInstrument({ symbol: "VTI", priceSource: "feed" });

      const markup = await render();

      expect(markup).toContain("Nothing here is priced by hand");
      expect(markup).not.toContain("Save price");
    }),
  );

  it(
    "lists a manual instrument nobody has priced yet as never priced",
    withDatabase(async ({ seedInstrument }) => {
      await seedInstrument({ symbol: null, name: "Target 2045 Trust II", priceSource: "manual" });

      const markup = await render();

      expect(markup).toContain("Target 2045 Trust II");
      expect(markup).toContain("never priced");
      expect(markup).toContain("Save price");
    }),
  );

  it(
    "records a typed price and says so, with the table showing it as the latest",
    withDatabase(async ({ seedInstrument }) => {
      const trust = await seedInstrument({
        symbol: null,
        name: "Target 2045 Trust II",
        priceSource: "manual",
      });

      const outcome = await action(
        args(
          post("/settings/prices", {
            intent: "manual-price",
            instrumentId: trust.id,
            price: "$52.41",
            asOf: "2026-08-20",
          }),
        ),
      );
      const markup = renderRoute(Prices, "/settings/prices", await loader(), {
        actionData: outcome,
      });

      expect(outcome).toMatchObject({
        recorded: { instrumentId: trust.id, price: "52.4100", date: "2026-08-20" },
      });
      expect(markup).toContain("Recorded $52.4100 for");
      expect(markup).toContain('<td class="u-data">2026-08-20</td>');
    }),
  );

  it(
    "puts a refusal beside its field and gives back what was typed",
    withDatabase(async ({ seedInstrument }) => {
      const trust = await seedInstrument({ symbol: null, priceSource: "manual" });

      const outcome = await action(
        args(
          post("/settings/prices", {
            intent: "manual-price",
            instrumentId: trust.id,
            price: "0",
            asOf: "2026-08-20",
          }),
        ),
      );
      const markup = renderRoute(Prices, "/settings/prices", await loader(), {
        actionData: outcome,
      });

      expect(outcome).toMatchObject({
        recorded: null,
        errors: { price: expect.stringMatching(/more than zero/) },
      });
      expect(markup).toContain("must be more than zero");
      expect(markup).toMatch(/name="price"[^>]*value="0"/);
      expect(markup).toContain('value="2026-08-20"');
    }),
  );

  it(
    "still saves the refresh cadence under its own intent",
    withDatabase(async () => {
      const outcome = await action(
        args(post("/settings/prices", { intent: "cadence", refreshCadenceMinutes: "30" })),
      );

      expect(outcome).toBeNull();
      expect((await loader()).refreshCadenceMinutes).toBe(30);
    }),
  );
});
