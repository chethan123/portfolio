// Claim under test: no amount is on this screen (spec 0007). Whole screens are driven like route tests — real loader
// output into the real component — because a unit test of Amount alone says nothing about the twenty files that must
// route through it. Every screen renders twice, masked and unmasked, so "no amounts" can't pass on a screen that
// rendered nothing at all. Screens: Overview, Holdings, and the upload diff (largest figure set on one page, story 18).
import { afterAll, afterEach, describe, expect, it } from "vitest";

import Holdings, { loader as holdingsLoader } from "../../app/routes/holdings.tsx";
import Overview, { loader as overviewLoader } from "../../app/routes/overview.tsx";
import Review, { loader as reviewLoader } from "../../app/routes/upload/review.tsx";
import { loader as rootLoader } from "../../app/root.tsx";
import { MASKED, MASKING_COOKIE, UNMASKED } from "~/lib/masking";
import { rememberMapping } from "~/lib/uploads.server";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { args, get } from "../support/routes.ts";

import { stopPricePoller } from "~/lib/price-poller.server";

import type { TestContext } from "../support/database.ts";
import type { StatementMapping } from "~/lib/statement";

// getConfig() memoises its first read — set before any loader runs (as root.test.ts, routes/masking.test.ts do).
process.env.DATABASE_URL = TEST_DATABASE_URL;

afterEach(stopPricePoller); // the shell's loader starts the refresh loop; root.test.ts explains.

afterAll(closeTestDatabase);

// Deliberately odd digits so no assertion passes by accident (100 @ 10 would put "1,000" on the page from two directions).
const QUANTITY = "137";
const PRICE = "426.1900";

/** QUANTITY × PRICE, as the view renders it. */
const VALUE = "58,388.03";

// Cost basis below price, so the row carries an unrealized gain — the one figure that keeps something while masked.
const COST_BASIS = "300.0000";

/** The uploaded file's quantity — must differ from QUANTITY or there's no diff. */
const UPLOADED_QUANTITY = "241";

// Every spelling of an amount this app can print. `$`-with-digit is the general case; named strings make a failure legible.
const MONEY_ANYWHERE = /\$\s*[\d(]/;

/** The <svg> a signed figure draws beside itself, or "" — read out of the markup so masked/unmasked compare without naming path data (§12: the arrow is there, not which one). */
function arrowIn(markup: string): string {
  return /<span class="delta[^"]*">(<svg.*?<\/svg>)/s.exec(markup)?.[1] ?? "";
}

// Priced through both a quote and a daily close: the table reads the quote, the chart reads the closes.
async function seedPortfolio(ctx: TestContext) {
  const account = await ctx.seedAccount({ kind: "brokerage", name: "Fidelity Taxable" });
  const vti = await ctx.seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock" });

  await ctx.seedQuote({ instrument: vti, price: PRICE });
  await ctx.seedDailyClose({ instrument: vti, date: "2026-06-30", close: PRICE });
  await ctx.seedPositionSet({
    account,
    asOf: "2026-06-30",
    holdings: [{ instrument: vti, quantity: QUANTITY, costBasisPerShare: COST_BASIS }],
  });

  return { account, vti };
}

describe("a masked screen carries no amount, and an unmasked one carries them all", () => {
  it(
    "Overview — the net worth headline included, which is the largest figure on it",
    withDatabase(async (ctx) => {
      await seedPortfolio(ctx);
      const data = await overviewLoader(args(get("/")));

      const masked = renderRoute(Overview, "/", data, { masked: true });
      const shown = renderRoute(Overview, "/", data, { masked: false });

      // Story 9: the headline is read across a train carriage — masking the table but leaving the KPI would be worse than none.
      expect(shown).toContain(VALUE);
      expect(masked).not.toContain(VALUE);
      expect(masked).not.toMatch(MONEY_ANYWHERE);

      // Story 13: the screen still says what the portfolio is.
      expect(masked).toContain("Fidelity Taxable");
      expect(masked).toContain("Brokerage");
    }),
  );

  it(
    "Overview — the trend line is still drawn and only its axis figures go",
    withDatabase(async (ctx) => {
      await seedPortfolio(ctx);
      const data = await overviewLoader(args(get("/")));

      const masked = renderRoute(Overview, "/", data, { masked: true });

      // Story 10: shape of the year, not its size — asserting only the grid would pass on a chart plotting nothing.
      expect(masked).toContain("chart-grid");
      expect(masked).toContain("chart-line");
      // Story 11: allocation ring keeps its proportions — a share is a ratio, never masked.
      expect(masked).toMatch(/width:\s*[\d.]+%/);
    }),
  );

  it(
    "Holdings — every value, cost basis, gain and share quantity at once",
    withDatabase(async (ctx) => {
      await seedPortfolio(ctx);
      const data = await holdingsLoader(args(get("/holdings")));

      if (data instanceof Response) throw new Error("The loader redirected instead of rendering.");

      const masked = renderRoute(Holdings, "/holdings", data, { masked: true });
      const shown = renderRoute(Holdings, "/holdings", data, { masked: false });

      expect(shown).toContain(VALUE);
      expect(masked).not.toContain(VALUE);
      expect(masked).not.toMatch(MONEY_ANYWHERE);

      // Story 12: quantity carries no currency mark, so a $-only mask would leave it — and a reader with the price could rebuild the value.
      expect(shown).toContain(QUANTITY);
      expect(masked).not.toContain(`>${QUANTITY}<`);

      // Story 13: the row is still findable.
      expect(masked).toContain("Vanguard Total Stock");
      expect(masked).toContain("VTI");
    }),
  );

  it(
    "the upload diff — the largest set of figures the app ever shows at once",
    withDatabase(async (ctx) => {
      const { account, vti } = await seedPortfolio(ctx);
      await ctx.seedInstrumentAlias({ instrument: vti, rawString: "VTI" });

      const draft = await ctx.seedUploadDraft({
        account,
        filename: "Positions.csv",
        // Differs from the quantity on record, so the diff has a row to draw — a match would leave every assertion below passing on nothing.
        bytes: new TextEncoder().encode(`Symbol,Quantity\nVTI,${UPLOADED_QUANTITY}`),
      });

      const mapping: StatementMapping = {
        headerRow: 0,
        delimiter: ",",
        columns: { instrument: "Symbol", quantity: "Quantity" },
        costBasisIs: "per_share",
        owedAsPositive: false,
        combineDuplicateRows: true,
      };

      const outcome = await rememberMapping(draft.id, mapping, ctx.db);
      if ("problems" in outcome) throw new Error("This fixture's mapping does not parse its file.");

      const data = await reviewLoader(args(get(`/upload/${draft.id}/review`), { draftId: draft.id }));
      if (data instanceof Response) throw new Error("The review screen bounced instead.");

      const path = `/upload/${draft.id}/review`;
      const masked = renderRoute(Review, path, data, { masked: true });
      const shown = renderRoute(Review, path, data, { masked: false });

      // Story 18: a step in a flow, easy to forget, printing every position in the file.
      expect(shown).toContain(UPLOADED_QUANTITY);
      expect(masked).not.toMatch(MONEY_ANYWHERE);
      expect(masked).not.toContain(`>${UPLOADED_QUANTITY}<`);
      // The before half too — masking only "becoming" would leak the same figure a day late (§8.2's before → after cell).
      expect(masked).not.toContain(`>${QUANTITY}<`);

      expect(masked).toContain("Vanguard Total Stock");
    }),
  );
});

describe("the first paint", () => {
  it(
    "is already masked when the browser's cookie says so, with no figure anywhere in the markup",
    withDatabase(async (ctx) => {
      await seedPortfolio(ctx);

      // The whole loop: Cookie in, shell loader resolves it, its answer drives the render — unlike every other test here,
      // which hands the flag to renderRoute directly and says nothing about where it came from. Story 30: never briefly visible.
      const root = await rootLoader(args(get("/", `${MASKING_COOKIE}=${MASKED}`)));
      const data = await overviewLoader(args(get("/")));

      expect(root.masked).toBe(true);

      const painted = renderRoute(Overview, "/", data, { masked: root.masked });

      expect(painted).not.toContain(VALUE);
      expect(painted).not.toMatch(MONEY_ANYWHERE);
    }),
  );

  it(
    "shows the figures when the same browser says the opposite",
    withDatabase(async (ctx) => {
      await seedPortfolio(ctx);

      const root = await rootLoader(args(get("/", `${MASKING_COOKIE}=${UNMASKED}`)));
      const data = await overviewLoader(args(get("/")));

      expect(root.masked).toBe(false);
      expect(renderRoute(Overview, "/", data, { masked: root.masked })).toContain(VALUE);
    }),
  );
});

describe("how a masked figure is announced", () => {
  it(
    "says an amount is hidden rather than spelling out a run of bullets",
    withDatabase(async (ctx) => {
      await seedPortfolio(ctx);
      const data = await overviewLoader(args(get("/")));

      const masked = renderRoute(Overview, "/", data, { masked: true });

      // Stories 6/7: dots are decoration, hidden from assistive tech; what's announced is that something is withheld.
      // Pattern, not exact string — the real streaming renderer splits text nodes with an empty comment ($<!-- -->••••••), renderToStaticMarkup doesn't.
      expect(masked).toMatch(
        /<span class="amount-dots" aria-hidden="true">\$(<!-- -->)?•{6}<\/span>/,
      );
      expect(masked).toContain('<span class="visually-hidden">Amount hidden</span>');

      // The chart's label is a string, not a component, so it says this in prose; the date stays visible — a date isn't an amount (spec 0010).
      expect(masked).toContain("at an amount that is hidden");
    }),
  );

  it(
    "keeps a gain's sign and its arrow, and loses only its size",
    withDatabase(async (ctx) => {
      await seedPortfolio(ctx);
      const data = await holdingsLoader(args(get("/holdings")));
      if (data instanceof Response) throw new Error("The loader redirected instead of rendering.");

      const masked = renderRoute(Holdings, "/holdings", data, { masked: true });
      const shown = renderRoute(Holdings, "/holdings", data, { masked: false });

      // Asserted against the unmasked render, not a literal, so a fixture that stopped producing a gain fails here instead of passing vacuously.
      expect(shown).toContain("delta--gain");

      // §12: gain/loss never by colour alone — dropping the sign while masked would leave hue as the only direction channel.
      expect(masked).toContain("delta--gain");
      expect(masked).toMatch(/\+(<!-- -->)?\$(<!-- -->)?•{6}/); // sign kept: +$••••••, never bare $••••••
      // Arrow kept, asserted as the same drawing as the unmasked row rather than literal path data (not pinned to the icon set).
      expect(arrowIn(masked)).toBe(arrowIn(shown));
      expect(arrowIn(masked)).not.toBe("");
      expect(masked).not.toMatch(MONEY_ANYWHERE); // size gone
    }),
  );
});
