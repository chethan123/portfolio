// Where the two net worth series meet (DESIGN.md §7). manualNetWorth returns rows raw and unmerged — "computed wins on
// overlapping dates" is a chart-level statement this loader alone writes, as one filter over two comparisons. Getting it
// wrong draws a lie that never throws: a blended hand-typed dot reads as a real daily curve, a duplicate date draws a
// cliff. Also: junk ?range fallback, and (through the one render) allocation bars measuring against the gross positive
// total so a mortgage bigger than the portfolio draws no negative bar.
import { afterAll, describe, expect, it } from "vitest";

import Overview, { loader, middleware } from "../../app/routes/overview.tsx";

import { RANGE_COOKIE } from "~/lib/chart-range";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { args, get, ownerParam, redirectTo, servedThrough } from "../support/routes.ts";

import type { TestContext } from "../support/database.ts";

// getConfig() validates the whole environment on first read (overview.tsx reads MARKET_TIMEZONE through it) — set before any loader runs.
process.env.DATABASE_URL = TEST_DATABASE_URL;

afterAll(closeTestDatabase);

const DAY_MS = 86_400_000;

// In UTC, the only zone where "today" is the same day for the test and the sampler.
const daysAgo = (days: number): string =>
  new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);

// `asOf` is day zero for the instance — everything before it is the stretch the manual series exists to cover.
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

// Three owners (not two, else "both" is the household and the all-owners collapse would bounce it away), each priced so
// headlines differ and sum to a fourth. Alice's day zero (`hers`) differs from Bob/Carol's (`his`) so a narrowed chart's
// reach is a distinct date. Alice: 100 VTI@100.0000. Bob: 40 BND@50.0000. Carol: 25 VXUS@20.0000.
async function seedTwoOwners(
  ctx: Pick<
    TestContext,
    | "seedPerson"
    | "seedAccount"
    | "seedInstrument"
    | "seedPositionSet"
    | "seedQuote"
    | "seedDailyClose"
  >,
  { hers, his }: { hers: string; his: string },
) {
  const alice = await ctx.seedPerson({ name: "Alice" });
  const bob = await ctx.seedPerson({ name: "Bob" });
  const carol = await ctx.seedPerson({ name: "Carol" });

  const vti = await ctx.seedInstrument({ symbol: "VTI", priceSource: "feed" });
  const bnd = await ctx.seedInstrument({ symbol: "BND", priceSource: "feed" });
  const vxus = await ctx.seedInstrument({ symbol: "VXUS", priceSource: "feed" });
  await ctx.seedQuote({ instrument: vti, price: "100.0000" });
  await ctx.seedQuote({ instrument: bnd, price: "50.0000" });
  await ctx.seedQuote({ instrument: vxus, price: "20.0000" });
  await ctx.seedDailyClose({ instrument: vti, date: hers, close: "100.0000" });
  await ctx.seedDailyClose({ instrument: bnd, date: his, close: "50.0000" });
  await ctx.seedDailyClose({ instrument: vxus, date: his, close: "20.0000" });

  const hersAccount = await ctx.seedAccount({
    kind: "brokerage",
    name: "Alice Brokerage",
    owner: alice,
  });
  const hisAccount = await ctx.seedAccount({ kind: "ira", name: "Bob Roth", owner: bob });
  const theirs = await ctx.seedAccount({ kind: "bank", name: "Carol Bank", owner: carol });

  await ctx.seedPositionSet({
    account: hersAccount,
    asOf: hers,
    holdings: [{ instrument: vti, quantity: "100" }],
  });
  await ctx.seedPositionSet({
    account: hisAccount,
    asOf: his,
    holdings: [{ instrument: bnd, quantity: "40" }],
  });
  await ctx.seedPositionSet({
    account: theirs,
    asOf: his,
    holdings: [{ instrument: vxus, quantity: "25" }],
  });

  return { alice, bob, carol, vti };
}

// The middleware around the loader itself, not a stand-in — servedThrough's stand-in Response can't see a loader-thrown redirect, which is what this file needs.
async function servedAround(path: string): Promise<Response> {
  const request = get(path);
  const run = middleware[0] as unknown as (
    context: { request: Request },
    next: () => Promise<unknown>,
  ) => Promise<Response>;

  return run({ request }, async () => {
    try {
      await loader(args(request));

      return new Response("the page");
    } catch (thrown) {
      if (thrown instanceof Response) return thrown;

      throw thrown;
    }
  });
}

describe("the Overview read as an owner", () => {
  it(
    "narrows the headline, the rollup, the allocation and the line itself",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx, { hers: daysAgo(200), his: daysAgo(200) });
      const at = (search: string) => loader(args(get(`/${search}`)));

      const hers = await at(`?owner=${alice.id}`);
      expect(hers.change.current).toBe("10000.0000");
      expect(hers.accounts.map((account) => [account.accountName, account.amount])).toEqual([
        ["Alice Brokerage", "10000.0000"],
      ]);
      expect(hers.holdingCount).toBe(1);
      expect(hers.computed.at(-1)?.amount).toBe("10000.0000"); // the line itself, not just the headline above it

      expect(renderRoute(Overview, "/", hers)).toContain("Showing <b>Alice</b> only."); // ADR-0008: filter surviving navigation

      const his = await at(`?owner=${bob.id}`);
      expect(his.change.current).toBe("2000.0000");

      // Called through loader directly, not redirectTo — the address must already be canonical (toOwnerParam's repeated key), or this throws the bounce instead of the data.
      const two = await at(`?${ownerParam(alice.id, bob.id)}`);
      expect(two.change.current).toBe("12000.0000");
      expect(two.computed.at(-1)?.amount).toBe("12000.0000");

      expect((await at("")).change.current).toBe("12500.0000");
    }),
  );

  it(
    "does not draw the hand-typed history while narrowed, and says why",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx, { hers: daysAgo(100), his: daysAgo(100) });

      // Alice's account is older than its first upload (empty then, positions later) — history begins at 700 days, line at 100, and
      // the gap between is where a hand-typed point could wrongly land under "Alice".
      const older = await ctx.seedAccount({ kind: "bank", name: "Alice Savings", owner: alice });
      await ctx.seedPositionSet({ account: older, asOf: daysAgo(700), holdings: [] });
      await ctx.seedManualNetWorth({ date: daysAgo(400), amount: "5000.00" });

      // Unfiltered: prefix fills the gap ahead of the computed line (DESIGN.md §7 rule 2).
      const household = await loader(args(get("/?range=all")));
      expect(household.manual.map((point) => point.date)).toEqual([daysAgo(400)]);

      // Narrowed, not drawn — this net worth predates any account to attribute it to, no honest owner to invent (§7 rule 3).
      const hers = await loader(args(get(`/?owner=${alice.id}&range=all`)));
      expect(hers.manual).toEqual([]);

      expect(renderRoute(Overview, "/", hers)).toContain(
        "hand-typed history before this instance existed",
      );
      expect(renderRoute(Overview, "/", household)).not.toContain(
        "hand-typed history before this instance existed",
      );
    }),
  );

  it(
    "shortens the reachable past to the selected owners' own history",
    withDatabase(async (ctx) => {
      // Bob's history is eight months old, Alice's three weeks — household reaches back to Bob's, narrowed-to-Alice cannot.
      const { alice } = await seedTwoOwners(ctx, { hers: daysAgo(21), his: daysAgo(240) });
      // Earlier than every position set — a filtered screen that kept reading it would keep reaching back through it.
      await ctx.seedManualNetWorth({ date: daysAgo(900), amount: "1000.00" });
      const disabled = (data: Awaited<ReturnType<typeof loader>>, key: string) =>
        data.rangeOptions.find((option) => option.key === key)?.disabled;

      const household = await loader(args(get("/")));
      expect(disabled(household, "3m")).toBe(false);

      const hers = await loader(args(get(`/?owner=${alice.id}`)));
      expect(disabled(hers, "3m")).toBe(true);
      expect(hers.customMin).toBe(daysAgo(21));

      // Disabled, drawn as a span rather than a link the loader would only fall back from.
      const markup = renderRoute(Overview, "/", hers);
      expect(markup).not.toContain("range=3m");
      expect(markup).toMatch(/<span[^>]*aria-disabled="true"[^>]*>3M</);
    }),
  );

  it(
    "keeps a stale id's owner out of the chart and the delta, not only out of the sentence",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx, { hers: daysAgo(200), his: daysAgo(200) });

      // Bob's accounts all close (off the roster), but holding_valued_at still reads a closed account for dates before its
      // closure, so his past is reachable by id — a stale bookmark naming him must not sneak into "Showing Alice only" (§14).
      await ctx.db
        .updateTable("account")
        .set({ closed_at: new Date() })
        .where("name", "=", "Bob Roth")
        .execute();

      const hers = await loader(args(get(`/?owner=${alice.id}&range=all`)));
      // Through loader directly, so this must already be the address ownerReading accepts unchanged (toOwnerParam's repeated key).
      const stale = await loader(args(get(`/?${ownerParam(alice.id, bob.id)}&range=all`)));

      expect(stale.unknownOwner).toBe(true);
      expect(renderRoute(Overview, "/", stale)).toContain("Showing <b>Alice</b> only.");
      // Same figures as the sentence claims — the address that never named Bob.
      expect(stale.computed).toEqual(hers.computed);
      expect(stale.change).toEqual(hers.change);
      expect(stale.customMin).toBe(hers.customMin);
    }),
  );

  it(
    "does not blame the filter for a hand-typed point the range would omit anyway",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx, { hers: daysAgo(200), his: daysAgo(200) });
      await ctx.seedManualNetWorth({ date: daysAgo(900), amount: "5000.00" });

      // 1M omits a 900-day-old point unfiltered too — naming the filter as cause would be the same wrong sentence 1D already refuses.
      const month = await loader(args(get(`/?owner=${alice.id}&range=1m`)));
      expect(month.manualWithheld).toBe(false);
      expect(renderRoute(Overview, "/", month)).not.toContain(
        "hand-typed history before this instance existed",
      );

      // All reaches back through every hand-typed point unfiltered, so here the omission is genuinely the filter's.
      const all = await loader(args(get(`/?owner=${alice.id}&range=all`)));
      expect(all.manualWithheld).toBe(true);
    }),
  );

  it(
    "keeps the filter across a range click and the range across an owner apply",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx, { hers: daysAgo(200), his: daysAgo(200) });
      const search = `?owner=${alice.id}&range=1m`;
      const data = await loader(args(get(`/${search}`)));
      const markup = renderRoute(Overview, `/${search}`, data);

      expect(markup).toContain(`href="/?owner=${alice.id}&amp;range=1w"`); // the bug ticket 00 fixed
      expect(markup).toContain('type="hidden" name="range" value="1m"'); // applying an owner mustn't throw away a chosen span
    }),
  );

  it(
    "redirects a non-canonical owner parameter, and stamps no cookie on the bounce",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx, { hers: daysAgo(200), his: daysAgo(200) });
      const ids = [alice.id, bob.id].sort((a, b) => Number(a) - Number(b));
      const messy = `/?owner=${ids[1]},${ids[0]}&range=1m`;

      expect(await redirectTo(() => loader(args(get(messy))))).toBe(
        `/?${ownerParam(...ids)}&range=1m`,
      );

      // First thrown redirect, running inside the range middleware — a header on a bounce nobody reads is wasted, and the range is still explicit in the address followed to.
      expect((await servedAround(messy)).headers.get("Set-Cookie")).toBeNull();

      // Still written for the page itself, or this fix would have quietly removed the feature it was ordering against.
      const settled = await servedAround(`/?${ownerParam(...ids)}&range=1m`);
      expect(settled.headers.get("Set-Cookie")).toContain(RANGE_COOKIE);
    }),
  );

  it(
    "collapses a selection naming everybody, which here would cost the pre-app history",
    withDatabase(async (ctx) => {
      const { alice, bob, carol } = await seedTwoOwners(ctx, {
        hers: daysAgo(200),
        his: daysAgo(200),
      });
      await ctx.seedManualNetWorth({ date: daysAgo(900), amount: "5000.00" });
      // Already canonical (repeated key, sorted) — isolates the everyone-collapse bounce from the respelling bounce.
      const everyone = ownerParam(alice.id, bob.id, carol.id);

      // Not merely a second URL for one view (as on other screens): a narrowed chart drops pre-app history, so ticking every box would silently cost every year before the first upload.
      expect(await redirectTo(() => loader(args(get(`/?${everyone}&range=all`))))).toBe(
        "/?range=all",
      );
    }),
  );

  it(
    "explains the missing pre-app line only on an instance that has one",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx, { hers: daysAgo(200), his: daysAgo(200) });

      // No hand-typed rows — a note naming a cause the instance doesn't have is how notes stop being read. Under All
      // deliberately: the one range where an existing point's omission is always the filter's, never the window's.
      const quiet = await loader(args(get(`/?owner=${alice.id}&range=all`)));
      expect(quiet.manualWithheld).toBe(false);
      expect(renderRoute(Overview, "/", quiet)).not.toContain(
        "hand-typed history before this instance existed",
      );

      await ctx.seedManualNetWorth({ date: daysAgo(900), amount: "5000.00" });
      const withheld = await loader(args(get(`/?owner=${alice.id}&range=all`)));
      expect(withheld.manualWithheld).toBe(true);
      expect(renderRoute(Overview, "/", withheld)).toContain(
        "hand-typed history before this instance existed",
      );
    }),
  );

  it(
    "draws no control for a household with one owner",
    withDatabase(async (ctx) => {
      await seedDayZero(ctx, daysAgo(30));
      const data = await loader(args(get("/")));

      expect(data.roster).toHaveLength(1);
      const markup = renderRoute(Overview, "/", data);
      expect(markup).not.toContain('aria-label="Filter by owner"');
      expect(markup).not.toContain("page-header--bare"); // no empty-row strip above a headline that's already the page's title
    }),
  );
});

describe("what a filtered address must not lose", () => {
  it(
    "keeps the chosen range when the owner is changed from an emptied screen",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx, { hers: daysAgo(200), his: daysAgo(200) });

      // An emptied screen used to emit no hidden fields at all, so widening also threw away the chosen span.
      const data = await loader(args(get(`/?owner=999999999&range=3m`)));
      const markup = renderRoute(Overview, "/", data);

      expect(markup).toContain('name="range"');
      expect(markup).toContain('value="3m"');
      expect(data.showEveryone).toContain("range=3m");
      expect(alice.id).toBeDefined();
    }),
  );

  it(
    "carries the filter into an account and the account carries it back",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx, { hers: daysAgo(200), his: daysAgo(200) });

      // Spec 0013's account exemption: the account page ignores the filter, so without a return address the round trip silently lands on the whole household.
      const data = await loader(args(get(`/?owner=${alice.id}`)));
      const markup = renderRoute(Overview, "/", data);

      expect(markup).toContain(`/accounts/`);
      expect(markup).toContain(`owner=${alice.id}`);
    }),
  );

  it(
    "does not blame the filter for the pre-app history 1D never draws",
    withDatabase(async (ctx) => {
      const { alice, vti } = await seedTwoOwners(ctx, { hers: daysAgo(200), his: daysAgo(200) });
      await ctx.seedManualNetWorth({ date: daysAgo(900), amount: "100000.00" });

      const dated = await loader(args(get(`/?owner=${alice.id}&range=all`)));
      expect(dated.manualWithheld).toBe(true);

      // A session to plot, or 1D falls back and there's nothing to assert.
      const today = new Date().toISOString().slice(0, 10);
      for (const minute of ["14:30", "15:30", "20:00"]) {
        await ctx.seedObservation({
          instrument: vti,
          asOf: `${today}T${minute}:00Z`,
          marketDate: today,
          price: "100.0000",
        });
      }

      // Under 1D the note would wrongly blame the filter for the range's own omission, and misstate where the line begins.
      const session = await loader(args(get(`/?owner=${alice.id}&range=1d`)));
      expect(session.session).not.toBeNull();
      expect(session.manualWithheld).toBe(false);
    }),
  );

  it(
    "keeps a page heading on a household with one owner",
    withDatabase(async (ctx) => {
      await seedDayZero(ctx, daysAgo(30));
      const data = await loader(args(get("/")));
      const markup = renderRoute(Overview, "/", data);

      expect(data.roster).toHaveLength(1);
      // The strip is suppressed, but the heading is the page's, not the strip's — a screen with no h1 can't be navigated by heading.
      expect(markup).not.toContain("page-header--bare");
      expect(markup).toContain("<h1");
      expect(markup).toContain("Overview</h1>");
    }),
  );
});

describe("the Overview's three empty states", () => {
  it(
    "says nothing has been uploaded only when nothing has",
    withDatabase(async (ctx) => {
      await ctx.seedPerson({ name: "Alice" });
      const data = await loader(args(get("/")));
      const markup = renderRoute(Overview, "/", data);

      expect(markup).toContain("Nothing has been uploaded to this instance yet");
      expect(markup).toContain('<h1 class="page-title">Overview</h1>'); // no headline below, so this is the one state where the title is drawn
    }),
  );

  it(
    "says nothing has been uploaded even when the address carries an owner filter",
    withDatabase(async (ctx) => {
      // A bookmarked owner param against a fresh instance is filtered *and* empty — branching on the filter alone wrongly
      // said "can no longer be read as", sending the reader hunting for a roster on a database that has none.
      await ctx.seedPerson({ name: "Alice" });
      const data = await loader(args(get("/?owner=999999999")));

      const markup = renderRoute(Overview, "/", data);
      expect(markup).toContain("Nothing has been uploaded to this instance yet");
      expect(markup).not.toContain("no longer be read as");
    }),
  );

  it(
    "tells an unreadable owner apart from an owner holding nothing, and keeps the control",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx, { hers: daysAgo(200), his: daysAgo(200) });

      const unknown = await loader(args(get("/?owner=999999999")));
      expect(unknown.unknownOwner).toBe(true);
      const unknownMarkup = renderRoute(Overview, "/", unknown);
      expect(unknownMarkup).not.toContain("There is no data yet");
      expect(unknownMarkup).toContain("no longer be read as");
      expect(unknownMarkup).toContain('aria-label="Filter by owner"');

      // Alice keeps an open, empty account — still in the roster, not an error.
      const empty = await ctx.seedAccount({ name: "Alice Cash", owner: alice, kind: "bank" });
      await ctx.seedPositionSet({ account: empty, asOf: daysAgo(1), holdings: [] });
      await ctx.db
        .updateTable("account")
        .set({ closed_at: new Date() })
        .where("name", "=", "Alice Brokerage")
        .execute();

      const nothing = await loader(args(get(`/?owner=${alice.id}`)));
      expect(nothing.unknownOwner).toBe(false);
      const nothingMarkup = renderRoute(Overview, "/", nothing);
      expect(nothingMarkup).not.toContain("There is no data yet");
      expect(nothingMarkup).toContain("Alice holds nothing that has been recorded here");
      expect(nothingMarkup).toContain('aria-label="Filter by owner"');
    }),
  );

  it(
    "keeps a way to clear the filter when only one owner can be offered",
    withDatabase(async (ctx) => {
      const alice = await ctx.seedPerson({ name: "Alice" });
      await ctx.seedPerson({ name: "Dana" });
      const vti = await ctx.seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await ctx.seedQuote({ instrument: vti, price: "100.0000" });
      const account = await ctx.seedAccount({
        kind: "brokerage",
        name: "Alice Brokerage",
        owner: alice,
      });
      await ctx.seedPositionSet({
        account,
        asOf: daysAgo(30),
        holdings: [{ instrument: vti, quantity: "10" }],
      });

      // Dana owns no open account, so ?owner= naming Alice doesn't cover everybody and can't collapse — but the roster
      // offers one name, which used to mean no control at all, stranding the filter with no way to clear it.
      const data = await loader(args(get(`/?owner=${alice.id}`)));
      const markup = renderRoute(Overview, "/", data);
      expect(markup).toContain('aria-label="Filter by owner"');
      expect(markup).toContain("Show everyone");

      expect(renderRoute(Overview, "/", await loader(args(get("/"))))).not.toContain(
        'aria-label="Filter by owner"',
      );
    }),
  );
});

describe("the two series on one chart", () => {
  it(
    "drops a hand-typed point on a date the computed series already covers, so the two are never blended",
    withDatabase(async (ctx) => {
      await seedDayZero(ctx, daysAgo(60));

      // Today is always covered once anything's uploaded, a date the computed line already speaks for — with a figure nothing agrees with.
      await ctx.seedManualNetWorth({ date: daysAgo(0), amount: "999999.0000" });
      await ctx.seedManualNetWorth({ date: daysAgo(75), amount: "50000.0000" }); // ahead of day zero, inside the window — the gap the manual series exists for

      const data = await loader(args(get("/?range=3m")));

      expect(data.manual).toEqual([{ date: daysAgo(75), amount: "50000.0000" }]);
      expect(data.computed.map((point) => point.date)).toContain(daysAgo(0));

      // No x carries a point from both series, whatever the sampler chose.
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

      // A 7-month-old point on a month-long chart would squeeze the asked-for month into the last few pixels of its own axis.
      expect(data.manual).toEqual([{ date: daysAgo(20), amount: "50000.0000" }]);
    }),
  );
});

describe("the range in the query string", () => {
  it(
    "falls back to the default year when the range is not one the page offers",
    withDatabase(async () => {
      // 6m was never one of the offered presets, before or after spec 0008 widened them from four — unlike ytd, which spec 0008 made real.
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
        // `in` walks the prototype chain — each of these passed requested in RANGES, read undefined days, and threw isoDate(NaN): an unauthenticated 500.
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

      // Not just the loader's field — the two date inputs the reader actually sees must carry the same bounds, or the picker could let through a date the loader then rejects.
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

  it(
    "names the form the Custom chip opens, so the chip cannot silently go dead",
    withDatabase(async (ctx) => {
      await seedDayZero(ctx, daysAgo(200));

      const markup = renderRoute(Overview, "/", await loader(args(get("/"))));

      // Native popover: the form the chip names is what the browser lifts into the top layer, escaping the phone strip's overflow.
      const [, id] = markup.match(/<button[^>]*\bpopovertarget="([^"]+)"/i) ?? [];
      expect(id).toBeDefined();
      const [form] = markup.match(/<form[^>]*\bpopover="auto"[^>]*>/) ?? [];
      expect(form).toContain(`id="${id}"`);
    }),
  );
});

describe("a preset before this household's earliest data", () => {
  it(
    "renders disabled, with no working link, rather than silently acting like All",
    withDatabase(async (ctx) => {
      // Eight months of history: 5Y and All measure the same window — 5Y must say so, not let a click do nothing.
      await seedDayZero(ctx, daysAgo(240));

      const data = await loader(args(get("/")));
      expect(data.rangeOptions.find((option) => option.key === "5y")?.disabled).toBe(true);

      const markup = renderRoute(Overview, "/", data);
      // On the resolved href, not the relative `to` — a <Link> renders the resolved address.
      expect(markup).not.toContain("range=5y");
      expect(markup).toMatch(/<span[^>]*aria-disabled="true"[^>]*>5Y</);
    }),
  );

  it(
    "does not disable a preset whose start lands exactly on the earliest date",
    withDatabase(async (ctx) => {
      // 1W's own boundary is exactly seven days ago — lands the two on the same date rather than one before the other.
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

      // Mortgage bigger than the portfolio: net worth -$40,000, and a share of *that* is where the arithmetic breaks (10,000/-40,000 = -25% bar, or NaN if they cancel exactly).
      const usd = await ctx.usdInstrument();
      const mortgage = await ctx.seedAccount({ kind: "liability", name: "Mortgage" });
      await ctx.seedPositionSet({
        account: mortgage,
        asOf: daysAgo(30),
        holdings: [{ instrument: usd, quantity: "-50000" }],
      });

      const data = await loader(args(get("/")));

      // The one rule here living in the component, not the loader — the one that pays for a render. Rendered unmasked.
      const markup = renderRoute(Overview, "/", data);

      expect(markup).toContain("width:100.0%"); // one bar, whole track — the only account holding anything
      expect(markup).not.toMatch(/width:\s*-/);
      expect(markup).not.toContain("NaN");
      // Debt isn't silently missing — it's in the accounts list at its own sign (real minus, U+2212, formatMoney), with a note explaining no share.
      expect(markup).toContain("−$50,000.00");
      expect(markup).toContain("has no bar.");
    }),
  );
});

describe("the number tail on the account rows", () => {
  it(
    "rides beside the name in the rollup and the allocation, hidden from a reader and said as words",
    withDatabase(async (ctx) => {
      const owner = await ctx.seedPerson({ name: "Alice" });
      const usd = await ctx.usdInstrument();

      // Free-form column: tail is the last four characters, not digits.
      const numbered = await ctx.seedAccount({
        name: "Fidelity Taxable",
        owner,
        externalAccountNumber: "X47-283910",
      });
      const bare = await ctx.seedAccount({ name: "Checking", owner, kind: "bank" });

      await ctx.seedPositionSet({
        account: numbered,
        asOf: daysAgo(10),
        holdings: [{ instrument: usd, quantity: "3000.00000000" }],
      });
      await ctx.seedPositionSet({
        account: bare,
        asOf: daysAgo(10),
        holdings: [{ instrument: usd, quantity: "1000.00000000" }],
      });

      const markup = renderRoute(Overview, "/", await loader(args(get("/"))));

      expect(markup).toContain('<span class="number-tail" aria-hidden="true">····3910</span>');
      expect(markup).toContain('<span class="visually-hidden">ending in 3910</span>');

      // Allocation bar carries the same arrangement, wrapped in one span so the flex row keeps label and figure apart.
      expect(markup).toContain(
        '<div class="alloc-label"><span>Fidelity Taxable <span class="number-tail" aria-hidden="true">····3910</span>',
      );

      expect(markup).toContain("Checking"); // no recorded number, no dots standing in for one
      expect(markup).not.toContain("Checking ·");
    }),
  );
});

describe("the 1D range on the Overview", () => {
  // Day zero, plus a session of observations. Daily close the day before is what an unobserved instant carries forward
  // from; the quote is what the headline reads — both written the way one refresh writes them (story 8).
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

      // Story 8: the refresh writes quote and observation in one transaction so the screen never shows two disagreeing totals.
      expect(data.computed.at(-1)?.amount).toBe(data.change.current);
    }),
  );

  it(
    "measures the change from the close of the session before the one it plots",
    withDatabase(async (ctx) => {
      await seedSession(ctx, daysAgo(1), daysAgo(2));

      const data = await loader(args(get("/?range=1d")));

      // Yesterday's close was $100/share, session ended at $110 — "today's change" a brokerage's sense; the session's own provisional close would read zero.
      expect(data.change.previous).toBe("10000.0000");
      expect(data.change.difference).toBe("1000.0000");
    }),
  );

  it(
    "tells the chart it is drawing a session, and tells it nothing of the sort otherwise",
    withDatabase(async (ctx) => {
      await seedSession(ctx, daysAgo(1), daysAgo(2));

      // The market's zone, never the reader's — the axis must say the same thing server-side and after hydration.
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

      // §7's series predates day zero — dropping last year's point onto this morning's instants would claim a session that never happened.
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

      // Reported back as what was actually drawn (as an undrawable custom span already is) — never caption 1D over a session that never existed.
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
      expect((await loader(args(get("/", `${RANGE_COOKIE}=1d`)))).range).toBe("1d"); // story 11: app reopens on the view in use
    }),
  );

  it(
    "leaves every other range drawing exactly what it drew before",
    withDatabase(async (ctx) => {
      await seedDayZero(ctx, daysAgo(60));
      const before = await loader(args(get("/?range=1m")));

      // Observations only — no new close, no new position set — so the new tier is the only thing that changed.
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

      // Story 19: a new tier must change nothing about a line already history — the day series reads price_daily alone.
      expect(after.computed).toEqual(before.computed);
      expect(after.change).toEqual(before.change);
    }),
  );
});
