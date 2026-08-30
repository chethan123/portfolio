/**
 * Where the two net worth series meet (DESIGN.md §7).
 *
 * The computed series and the hand-typed one are read by two query functions
 * that know nothing about each other — `manualNetWorth` deliberately returns
 * its rows raw and unmerged, because "computed wins on overlapping dates" is a
 * statement about a chart rather than a fact about either series. This loader
 * is the only place that statement is written down, and it is written as one
 * `filter` over two comparisons.
 *
 * Getting it wrong draws a lie in the shape of a fact. A hand-typed annual dot
 * blended into the computed line reads as a real daily curve through a period
 * where nothing was recorded; a duplicate date puts two points at one x and
 * draws a vertical cliff between them. Neither throws, neither looks broken,
 * and the figure someone reads off the chart is their household's net worth.
 *
 * The other rules here are the loader's own contribution and nothing else's:
 * what a junk `?range` falls back to, and — through the one render below — that
 * the allocation bars are measured against the gross positive total, so a
 * household with a mortgage bigger than its portfolio gets no negative bar.
 */
import { afterAll, describe, expect, it } from "vitest";

import Overview, { loader, middleware } from "../../app/routes/overview.tsx";

import { RANGE_COOKIE } from "~/lib/chart-range";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { args, get, servedThrough } from "../support/routes.ts";

import type { TestContext } from "../support/database.ts";

/**
 * Set before any loader runs: `overview.tsx` reads `MARKET_TIMEZONE` through
 * `getConfig()` to tell the chart which clock a session's instants are read on,
 * and `getConfig()` validates the whole environment when it is first asked.
 * `MARKET_TIMEZONE` itself defaults; the database URL is the one variable with
 * no default, and it is the same one the harness already connects with.
 */
process.env.DATABASE_URL = TEST_DATABASE_URL;

afterAll(closeTestDatabase);

const DAY_MS = 86_400_000;

/**
 * A date `days` before today, in UTC — the zone the loader samples in, and the
 * only one in which "today" is the same day for the test and for the sampler.
 */
const daysAgo = (days: number): string =>
  new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);

/**
 * One brokerage account holding one priced fund, as of `asOf`.
 *
 * That date is day zero for the instance: every sample from it forward is
 * covered, and everything before it is the stretch the manual series exists to
 * cover.
 */
async function seedDayZero(
  ctx: Pick<
    TestContext,
    "seedAccount" | "seedInstrument" | "seedPositionSet" | "seedQuote" | "seedDailyClose"
  >,
  asOf: string,
): Promise<void> {
  const account = await ctx.seedAccount({ kind: "brokerage", name: "Fidelity Taxable" });
  const vti = await ctx.seedInstrument({ symbol: "VTI", priceSource: "feed" });

  await ctx.seedQuote({ instrument: vti, price: "100.0000" });
  await ctx.seedDailyClose({ instrument: vti, date: asOf, close: "100.0000" });
  await ctx.seedPositionSet({
    account,
    asOf,
    holdings: [{ instrument: vti, quantity: "100" }],
  });
}

describe("the two series on one chart", () => {
  it(
    "drops a hand-typed point on a date the computed series already covers, so the two are never blended",
    withDatabase(async (ctx) => {
      await seedDayZero(ctx, daysAgo(60));

      // Today is always the last sample and is always covered once anything
      // has been uploaded, so this is a date the computed line already speaks
      // for — with a figure nothing in the database agrees with.
      await ctx.seedManualNetWorth({ date: daysAgo(0), amount: "999999.0000" });
      // Ahead of day zero and inside the window: the gap the manual series is
      // the whole reason for.
      await ctx.seedManualNetWorth({ date: daysAgo(75), amount: "50000.0000" });

      const data = await loader(args(get("/?range=3m")));

      expect(data.manual).toEqual([{ date: daysAgo(75), amount: "50000.0000" }]);
      expect(data.computed.map((point) => point.date)).toContain(daysAgo(0));

      // The rule stated as the chart reads it: no x carries a point from both
      // series, whatever the sampler chose.
      const computed = new Set(data.computed.map((point) => point.date));
      expect(data.manual.filter((point) => computed.has(point.date))).toEqual([]);
    }),
  );

  it(
    "drops a hand-typed point older than the window that was asked for",
    withDatabase(async (ctx) => {
      await seedDayZero(ctx, daysAgo(10));

      await ctx.seedManualNetWorth({ date: daysAgo(20), amount: "50000.0000" });
      await ctx.seedManualNetWorth({ date: daysAgo(200), amount: "10000.0000" });

      const data = await loader(args(get("/?range=1m")));

      // A month-long chart carrying a point from seven months ago would squeeze
      // the month it was asked for into the last few pixels of its own axis.
      expect(data.manual).toEqual([{ date: daysAgo(20), amount: "50000.0000" }]);
    }),
  );
});

describe("the range in the query string", () => {
  it(
    "falls back to the default year when the range is not one the page offers",
    withDatabase(async () => {
      // Reached by a hand-edited URL or a stale bookmark. `6m` was never one
      // of the eight the control offers, before or after spec 0008 widened it
      // from four — unlike `ytd`, which spec 0008 turned from an unrecognised
      // key into a real preset.
      expect((await loader(args(get("/?range=6m")))).range).toBe("1y");
      expect((await loader(args(get("/?range=")))).range).toBe("1y");
      expect((await loader(args(get("/?range=1m")))).range).toBe("1m");
      expect((await loader(args(get("/?range=ytd")))).range).toBe("ytd");
    }),
  );

  it.each(["toString", "constructor", "valueOf", "hasOwnProperty"])(
    "does not mistake %s for a range, however much it looks like a key",
    (inherited) =>
      withDatabase(async () => {
        // The gate was `requested in RANGES`, and `in` walks the prototype
        // chain — so every one of these passed it, `RANGES[requested].days`
        // read `undefined`, and the window arithmetic reached
        // `isoDate(NaN)` and threw. A 500 on the home page, from a query
        // string, with no authentication needed to send it.
        expect((await loader(args(get(`/?range=${inherited}`)))).range).toBe("1y");
      })(),
  );
});

describe("the persistence cookie (spec 0008)", () => {
  it(
    "lets an explicit ?range= win over a cookie naming a different range",
    withDatabase(async () => {
      const data = await loader(args(get("/?range=5y", `${RANGE_COOKIE}=1m`)));
      expect(data.range).toBe("5y");
    }),
  );

  it(
    "uses the cookie's stored range when the URL carries none",
    withDatabase(async () => {
      const data = await loader(args(get("/", `${RANGE_COOKIE}=5y`)));
      expect(data.range).toBe("5y");
    }),
  );

  it(
    "falls back to the hardcoded 1Y default when neither the URL nor a cookie says anything",
    withDatabase(async () => {
      expect((await loader(args(get("/")))).range).toBe("1y");
    }),
  );

  it(
    "sets the cookie whenever the request carried an explicit range",
    withDatabase(async () => {
      const response = await servedThrough(middleware, get("/?range=5y"));
      expect(response.headers.get("Set-Cookie")).toContain(`${RANGE_COOKIE}=5y`);
    }),
  );

  it(
    "sets the cookie for an applied custom span, not for one that falls back",
    withDatabase(async () => {
      const applied = await servedThrough(middleware, get("/?range=custom&start=2026-01-01&end=2026-03-01"));
      expect(applied.headers.get("Set-Cookie")).toContain(
        `${RANGE_COOKIE}=custom%3A2026-01-01%3A2026-03-01`,
      );
    }),
  );

  it(
    "writes nothing when the request named no explicit range",
    withDatabase(async () => {
      expect((await servedThrough(middleware, get("/"))).headers.get("Set-Cookie")).toBeNull();
      expect((await servedThrough(middleware, get("/", `${RANGE_COOKIE}=5y`))).headers.get("Set-Cookie")).toBeNull();
    }),
  );
});

describe("a custom range", () => {
  it(
    "resolves to exactly the span asked for and reports it back for the control to show",
    withDatabase(async (ctx) => {
      await seedDayZero(ctx, daysAgo(200));

      const data = await loader(args(get(`/?range=custom&start=${daysAgo(100)}&end=${daysAgo(10)}`)));

      expect(data.range).toBe("custom");
      expect(data.custom).toEqual({ start: daysAgo(100), end: daysAgo(10) });
    }),
  );

  it(
    "falls back to the default rather than erroring on an incomplete pair",
    withDatabase(async () => {
      const data = await loader(args(get("/?range=custom&start=2026-01-01")));
      expect(data.range).toBe("1y");
      expect(data.custom).toBeUndefined();
    }),
  );

  it(
    "falls back to the default rather than erroring on a span reaching before this household's earliest data",
    withDatabase(async (ctx) => {
      await seedDayZero(ctx, daysAgo(30));

      const data = await loader(args(get(`/?range=custom&start=2000-01-01&end=${daysAgo(0)}`)));

      expect(data.range).toBe("1y");
    }),
  );

  it(
    "gives the custom form the household's own earliest date as its minimum, and today as its maximum",
    withDatabase(async (ctx) => {
      await seedDayZero(ctx, daysAgo(200));

      const data = await loader(args(get("/")));

      expect(data.customMin).toBe(daysAgo(200));
      expect(data.customMax).toBe(daysAgo(0));

      // Not just the loader's own field — the two date inputs the reader
      // actually sees have to carry the same bounds, or a picker that let
      // through a date the loader would then reject.
      const markup = renderRoute(Overview, "/", data);
      expect(markup).toContain(`min="${daysAgo(200)}" max="${daysAgo(0)}" name="start"`);
      expect(markup).toContain(`min="${daysAgo(200)}" max="${daysAgo(0)}" name="end"`);
    }),
  );

  it(
    "reaches into the household's hand-typed pre-app history for its minimum, when that is earlier",
    withDatabase(async (ctx) => {
      await seedDayZero(ctx, daysAgo(60));
      await ctx.seedManualNetWorth({ date: daysAgo(400), amount: "10000.0000" });

      expect((await loader(args(get("/")))).customMin).toBe(daysAgo(400));
    }),
  );

  it(
    "renders the applied span instead of the word Custom, once one is applied",
    withDatabase(async (ctx) => {
      await seedDayZero(ctx, daysAgo(200));

      const data = await loader(args(get(`/?range=custom&start=${daysAgo(100)}&end=${daysAgo(10)}`)));
      const markup = renderRoute(Overview, "/", data);

      expect(markup).toContain(`${daysAgo(100)} – ${daysAgo(10)}`);
      expect(markup).not.toMatch(/>Custom</);
    }),
  );
});

describe("a preset before this household's earliest data", () => {
  it(
    "renders disabled, with no working link, rather than silently acting like All",
    withDatabase(async (ctx) => {
      // Eight months of history: 5Y and All measure the same window, and 5Y
      // must say so rather than let a click do nothing and leave the reader
      // guessing why.
      await seedDayZero(ctx, daysAgo(240));

      const data = await loader(args(get("/")));
      expect(data.rangeOptions.find((option) => option.key === "5y")?.disabled).toBe(true);

      const markup = renderRoute(Overview, "/", data);
      // On the resolved href, not on the relative `to`: a `<Link>` renders
      // the address it resolves to, so the old assertion against `href="?…"`
      // could never have failed whether the preset linked or not.
      expect(markup).not.toContain("range=5y");
      expect(markup).toMatch(/<span[^>]*aria-disabled="true"[^>]*>5Y</);
    }),
  );

  it(
    "does not disable a preset whose start lands exactly on the earliest date",
    withDatabase(async (ctx) => {
      // 1W's own boundary is exactly seven days ago; seeding day zero there
      // makes the two land on the same date rather than one falling before
      // the other.
      await seedDayZero(ctx, daysAgo(7));

      const data = await loader(args(get("/")));
      expect(data.rangeOptions.find((option) => option.key === "1w")?.disabled).toBe(false);
    }),
  );
});

describe("the allocation bars", () => {
  it(
    "measures a share against the gross positive total, so a household in net debt has no negative bar",
    withDatabase(async (ctx) => {
      await seedDayZero(ctx, daysAgo(30));

      // A mortgage larger than the portfolio it sits beside. Net worth is
      // -$40,000, and a share of *that* is where the arithmetic goes wrong:
      // 10,000 / -40,000 is a bar drawn at -25% of its track, or NaN once the
      // two cancel exactly.
      const usd = await ctx.usdInstrument();
      const mortgage = await ctx.seedAccount({ kind: "liability", name: "Mortgage" });
      await ctx.seedPositionSet({
        account: mortgage,
        asOf: daysAgo(30),
        holdings: [{ instrument: usd, quantity: "-50000" }],
      });

      const data = await loader(args(get("/")));

      // The one rule in this file that lives in the component rather than the
      // loader, so it is the one that pays for a render.
      // Through the shared helper, which puts a root route above the page
      // carrying the masking state every amount reads (spec 0007). Rendered
      // unmasked, because the figures below are what this test is about.
      const markup = renderRoute(Overview, "/", data);

      // One bar, the whole track wide: the only account that holds anything.
      expect(markup).toContain("width:100.0%");
      expect(markup).not.toMatch(/width:\s*-/);
      expect(markup).not.toContain("NaN");
      // The debt is not silently missing — it is in the accounts list at its
      // own sign (a real minus, U+2212, which is what `formatMoney` writes),
      // with the note beside the bars saying why it has no share.
      expect(markup).toContain("−$50,000.00");
      expect(markup).toContain("has no bar.");
    }),
  );
});

describe("the 1D range on the Overview", () => {
  /**
   * Day zero, plus a session of observations on `session`.
   *
   * The daily close on the day before is what an unobserved instant carries
   * forward from, and the quote is what the headline reads — both written the
   * way one refresh writes them, which is the path story 8 is about.
   */
  async function seedSession(ctx: TestContext, session: string, previous: string): Promise<void> {
    const account = await ctx.seedAccount({ kind: "brokerage", name: "Fidelity Taxable" });
    const vti = await ctx.seedInstrument({ symbol: "VTI", priceSource: "feed" });

    await ctx.seedPositionSet({
      account,
      asOf: previous,
      holdings: [{ instrument: vti, quantity: "100" }],
    });
    await ctx.seedDailyClose({ instrument: vti, date: previous, close: "100.0000" });

    for (const [minute, price] of [
      ["13:30", "101.0000"],
      ["17:00", "104.0000"],
      ["20:00", "110.0000"],
    ]) {
      await ctx.seedObservation({
        instrument: vti,
        asOf: `${session}T${minute}:00Z`,
        marketDate: session,
        price: price as string,
      });
    }

    await ctx.seedQuote({ instrument: vti, price: "110.0000" });
    await ctx.seedDailyClose({ instrument: vti, date: session, close: "110.0000" });
  }

  it(
    "plots the latest observed session, one point per observation, when 1D is asked for",
    withDatabase(async (ctx) => {
      await seedSession(ctx, daysAgo(1), daysAgo(2));

      const data = await loader(args(get("/?range=1d")));

      expect(data.range).toBe("1d");
      expect(data.computed.map((point) => [point.date, point.amount])).toEqual([
        [`${daysAgo(1)}T13:30:00.000Z`, "10100.0000"],
        [`${daysAgo(1)}T17:00:00.000Z`, "10400.0000"],
        [`${daysAgo(1)}T20:00:00.000Z`, "11000.0000"],
      ]);
    }),
  );

  it(
    "ends the line at the figure the headline states",
    withDatabase(async (ctx) => {
      await seedSession(ctx, daysAgo(1), daysAgo(2));

      const data = await loader(args(get("/?range=1d")));

      // Story 8, and the reason the refresh writes the quote and the
      // observation in one transaction: the screen never shows two totals that
      // disagree.
      expect(data.computed.at(-1)?.amount).toBe(data.change.current);
    }),
  );

  it(
    "measures the change from the close of the session before the one it plots",
    withDatabase(async (ctx) => {
      await seedSession(ctx, daysAgo(1), daysAgo(2));

      const data = await loader(args(get("/?range=1d")));

      // Yesterday's close was $100 a share, and the session ended at $110 —
      // "today's change" in the sense a brokerage means it. Measured against
      // the session's own provisional close it would read zero.
      expect(data.change.previous).toBe("10000.0000");
      expect(data.change.difference).toBe("1000.0000");
    }),
  );

  it(
    "tells the chart it is drawing a session, and tells it nothing of the sort otherwise",
    withDatabase(async (ctx) => {
      await seedSession(ctx, daysAgo(1), daysAgo(2));

      // The market's zone, never the reader's: the axis has to say the same
      // thing on the server and in the browser after hydration.
      expect((await loader(args(get("/?range=1d")))).session).toEqual({
        timeZone: "America/New_York",
      });
      expect((await loader(args(get("/?range=1m")))).session).toBeNull();
    }),
  );

  it(
    "keeps the hand-typed prefix off a session's line",
    withDatabase(async (ctx) => {
      await seedSession(ctx, daysAgo(1), daysAgo(2));
      await ctx.seedManualNetWorth({ date: daysAgo(400), amount: "50000.0000" });

      // §7's series is the household's net worth before day zero. Dropping a
      // point from last year onto a line of this morning's instants would claim
      // a session that never happened.
      expect((await loader(args(get("/?range=1d")))).manual).toEqual([]);
      expect((await loader(args(get("/?range=all")))).manual).not.toEqual([]);
    }),
  );

  it(
    "offers the 1D chip once anything has been observed and disables it before that",
    withDatabase(async (ctx) => {
      await seedDayZero(ctx, daysAgo(10));

      const before = await loader(args(get("/")));
      expect(before.rangeOptions.find((option) => option.key === "1d")?.disabled).toBe(true);

      await seedSession(ctx, daysAgo(1), daysAgo(2));

      const after = await loader(args(get("/")));
      expect(after.rangeOptions.find((option) => option.key === "1d")?.disabled).toBe(false);
    }),
  );

  it(
    "falls back to the default preset when 1D is asked for and nothing has been observed",
    withDatabase(async (ctx) => {
      await seedDayZero(ctx, daysAgo(400));

      const data = await loader(args(get("/?range=1d")));

      // Reported back as what was actually drawn, the way an undrawable custom
      // span already is — a chart captioned 1D from a session that never
      // existed is the thing being refused.
      expect(data.range).toBe("1y");
      expect(data.session).toBeNull();
    }),
  );

  it(
    "remembers 1D the way it remembers every other range",
    withDatabase(async (ctx) => {
      await seedSession(ctx, daysAgo(1), daysAgo(2));

      const response = await servedThrough(middleware, get("/?range=1d"));
      expect(response.headers.get("Set-Cookie")).toContain(`${RANGE_COOKIE}=1d`);

      // Story 11: the app reopens on the view in use.
      expect((await loader(args(get("/", `${RANGE_COOKIE}=1d`)))).range).toBe("1d");
    }),
  );

  it(
    "leaves every other range drawing exactly what it drew before",
    withDatabase(async (ctx) => {
      await seedDayZero(ctx, daysAgo(60));
      const before = await loader(args(get("/?range=1m")));

      // Observations and nothing else — no new close, no new position set — so
      // the only thing that changed between the two reads is the new tier.
      const vti = await ctx.seedInstrument({ symbol: "VTI", priceSource: "feed" });
      for (const minute of ["13:30", "17:00", "20:00"]) {
        await ctx.seedObservation({
          instrument: vti,
          asOf: `${daysAgo(1)}T${minute}:00Z`,
          marketDate: daysAgo(1),
          price: "999.0000",
        });
      }

      const after = await loader(args(get("/?range=1m")));

      // Story 19. A new tier under the chart must change nothing about a line
      // that is already history — the day series reads `price_daily` alone.
      expect(after.computed).toEqual(before.computed);
      expect(after.change).toEqual(before.change);
    }),
  );
});
