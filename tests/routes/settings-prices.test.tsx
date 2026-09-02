/**
 * Settings → Prices: the sentences the gap list actually puts on the screen.
 *
 * The list is the household's answer to "why is this still unpriced in March"
 * and the operator's list of tickers to check against a statement (ADR-0011),
 * so what matters is that a row says which instrument, how far back it is held,
 * where its price history starts, and what the last attempt came to — in words,
 * not in the ledger's literals.
 *
 * Rendered through the real component with the real loader's output, the way
 * `masked-screens.test.tsx` renders a screen: a fixture of the loader's shape
 * would be a second copy free to drift from it, and the drift looks exactly
 * like a passing test.
 */
import { afterAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";

process.env.DATABASE_URL = TEST_DATABASE_URL;

const Prices = (await import("../../app/routes/settings/prices.tsx")).default;
const { loader } = await import("../../app/routes/settings/prices.tsx");

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
      // The ledger's literal is not what a person reads.
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

      expect(markup).toContain("priced by hand, so there is no feed history to fetch");
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
      // The cell itself, not any em dash on the page: the notes above the table
      // carry them too, and a bare `toContain` would pass on those alone.
      expect(markup).toContain('<td class="u-data">—</td>');
    }),
  );
});
