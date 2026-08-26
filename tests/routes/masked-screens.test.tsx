/**
 * The claim this feature actually makes: no amount is on this screen
 * (spec 0007).
 *
 * **The render is the seam, and it is deliberately the only one.** A test that
 * rendered the `Amount` component and found dots would prove that dots render;
 * it would say nothing about the twenty other files that have to route through
 * it, which is where this feature actually fails. So whole screens are driven
 * exactly as the route tests drive them — a real loader's output into the real
 * component — and the assertion is made over the markup a person would receive.
 *
 * **Both directions, every time.** A masked render asserting "no amounts" would
 * pass just as happily on a screen that had stopped rendering anything at all,
 * so every screen is rendered twice and the unmasked half asserts the same
 * figures are present. That pairing is what makes the masked half mean
 * something.
 *
 * The three screens are the spec's: Overview, Holdings, and the upload diff —
 * the last because it is the largest set of figures the application ever puts
 * on one page, and therefore the worst one to leak (story 18).
 */
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

// The shell's loader reads the deployment's configuration, and `getConfig()`
// memoises its first read — so this has to be set before any loader here runs,
// exactly as `root.test.ts` and `routes/masking.test.ts` do it.
process.env.DATABASE_URL = TEST_DATABASE_URL;

/** The shell's loader starts the refresh loop; `root.test.ts` explains. */
afterEach(stopPricePoller);

afterAll(closeTestDatabase);

/**
 * Deliberately odd digits, so that an assertion cannot pass by accident.
 *
 * A quantity of 100 at a price of 10 would put "1,000" on the page from two
 * different directions; these do not collide with each other, with a date, or
 * with a percentage.
 */
const QUANTITY = "137";
const PRICE = "426.1900";

/** What those two produce once the view has multiplied them. */
const VALUE = "58,388.03";

/**
 * A cost basis below the price, so the row carries an unrealized *gain* — the
 * one figure that keeps something while masked, and therefore the one whose
 * masked form has to be checked rather than assumed.
 */
const COST_BASIS = "300.0000";

/** What the file being uploaded says, which has to differ or there is no diff. */
const UPLOADED_QUANTITY = "241";

/**
 * Every spelling of an amount this application can print.
 *
 * A masked screen must contain none of them. The `$`-with-a-digit pattern is
 * the general case and would catch a figure this list had never heard of; the
 * named strings are what makes a failure legible when it fires.
 */
const MONEY_ANYWHERE = /\$\s*[\d(]/;

/**
 * The `<svg>` a signed figure draws beside itself, or "" if it drew none.
 *
 * Read out of the first delta cell in the markup, so the assertion can compare
 * a masked render against an unmasked one instead of naming path data — §12's
 * rule is that the arrow is there, not that it is any particular arrow.
 */
function arrowIn(markup: string): string {
  return /<span class="delta[^"]*">(<svg.*?<\/svg>)/s.exec(markup)?.[1] ?? "";
}

/**
 * One brokerage account holding one priced fund.
 *
 * Priced through a quote *and* a daily close, because the two feed different
 * screens — the table reads the quote and the chart reads the closes — and a
 * fixture with only one of them would leave half of this file asserting over
 * an empty page.
 */
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

      // Story 9: the headline is the first thing anyone reads across a train
      // carriage, so a mask that covered the table and left the KPI would be
      // worse than none at all.
      expect(shown).toContain(VALUE);
      expect(masked).not.toContain(VALUE);
      expect(masked).not.toMatch(MONEY_ANYWHERE);

      // Story 13, and the point of the whole feature: the screen still says
      // what the portfolio *is*.
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

      // Story 10: the shape of the year without the size of it. The line and
      // the rules are what make the chart readable as a chart rather than as a
      // smear, and the polyline is the line itself — asserting only on the
      // grid would pass on a chart that had stopped plotting anything.
      expect(masked).toContain("chart-grid");
      expect(masked).toContain("chart-line");
      // Story 11: the allocation ring keeps its proportions, because a share is
      // a ratio and a ratio is never masked.
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

      // Story 12 names the quantity explicitly, and it is the one figure that
      // carries no currency mark — so a mask that only looked for `$` would
      // leave it on the page, and a reader with the price could rebuild the
      // value from it.
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
        // A different quantity from the one on record, so the diff has a row
        // to draw. A file that matched would render an empty table, and every
        // "contains no amount" assertion below would pass on nothing at all.
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

      // Story 18. This screen was the easiest one to forget: it is a step in a
      // flow rather than a dashboard, and it prints every position in the file.
      expect(shown).toContain(UPLOADED_QUANTITY);
      expect(masked).not.toMatch(MONEY_ANYWHERE);
      expect(masked).not.toContain(`>${UPLOADED_QUANTITY}<`);
      // The before half of the change goes too: a diff that hid what a position
      // is becoming and printed what it was would leak the same figure a day
      // late (§8.2's before → after cell).
      expect(masked).not.toContain(`>${QUANTITY}<`);

      // The instrument is still named, so the reader can still check the file
      // is the one they meant to upload.
      expect(masked).toContain("Vanguard Total Stock");
    }),
  );
});

describe("the first paint", () => {
  it(
    "is already masked when the browser's cookie says so, with no figure anywhere in the markup",
    withDatabase(async (ctx) => {
      await seedPortfolio(ctx);

      // The whole loop, in one test: a `Cookie` header goes in, the shell's
      // loader resolves it, and its answer drives the render. Every other test
      // in this file hands the flag to `renderRoute` directly, which proves the
      // screens obey a flag and says nothing about where the flag came from —
      // and the two halves being separately right is exactly how a feature
      // like this ships broken. Story 30: the amounts are never briefly
      // visible, because there is no first paint in which they were there.
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

      // Stories 6 and 7. The dots are decoration and are hidden from assistive
      // technology; what is announced instead is that something is being
      // withheld — which also means a person beside a screen reader user hears
      // nothing about the balances.
      // Matched as a pattern rather than as one exact string: the streaming
      // renderer the server actually uses splits adjacent text nodes with an
      // empty comment (`$<!-- -->••••••`), which `renderToStaticMarkup` here
      // does not. An exact-string assertion would pass in this suite and say
      // nothing about the markup a browser receives.
      expect(masked).toMatch(
        /<span class="amount-dots" aria-hidden="true">\$(<!-- -->)?•{6}<\/span>/,
      );
      expect(masked).toContain('<span class="visually-hidden">Amount hidden</span>');

      // The chart's label is a string rather than a component, so it is the one
      // that has to say this in prose.
      expect(masked).toContain("ending at an amount that is hidden");
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

      // The fixture's cost basis sits below its price, so this row is a gain
      // and every channel below should say so. Asserted against the unmasked
      // render rather than against a literal, so a fixture that stopped
      // producing a gain fails here rather than passing vacuously.
      expect(shown).toContain("delta--gain");

      // §12: gain and loss are never carried by colour alone. Dropping the sign
      // while masked would leave the hue as the only channel saying which way
      // the figure points — so direction survives and magnitude does not.
      expect(masked).toContain("delta--gain");
      // The sign, kept. `+$••••••`, never a bare `$••••••`.
      expect(masked).toMatch(/\+(<!-- -->)?\$(<!-- -->)?•{6}/);
      // The arrow, kept — and asserted as *the same drawing* the unmasked row
      // uses rather than as literal path data, which would pin this test to the
      // icon set rather than to the rule.
      expect(arrowIn(masked)).toBe(arrowIn(shown));
      expect(arrowIn(masked)).not.toBe("");
      // And the size, gone.
      expect(masked).not.toMatch(MONEY_ANYWHERE);
    }),
  );
});
