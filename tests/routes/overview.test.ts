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
import { args, get, outcomeOf, redirectTo, servedThrough } from "../support/routes.ts";

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

/**
 * Three owners, each with one account, priced so their headlines differ and
 * sum to a fourth — and with a different day zero for Alice, so a narrowed
 * chart's reach is a different date rather than the household's seen twice.
 *
 * Alice: 100 VTI at 100.0000 from `hers` days ago. Bob: 40 BND at 50.0000 and
 * Carol: 25 VXUS at 20.0000, both from `his`. Three rather than two, because
 * with two "both owners" is the household — every assertion about a multi-owner
 * filter would pass against a screen ignoring it, and the all-owners collapse
 * would bounce the URL away besides.
 */
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

/**
 * The middleware around the loader itself, rather than around a stand-in.
 *
 * `servedThrough` runs the chain over `new Response("the page")`, which is the
 * right shape for asking what the middleware does with a page — and cannot see
 * a redirect the loader threw, which is the only thing this file needs it for.
 */
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
      // The line, not only the figure above it. A headline that narrowed over a
      // household line is the exact failure this screen is worst at showing,
      // and nothing else here would catch it.
      expect(hers.computed.at(-1)?.amount).toBe("10000.0000");

      // Named beside the figure, in words. ADR-0008 attaches that condition to
      // the filter surviving navigation, and deleting the sentence broke no
      // other assertion.
      expect(renderRoute(Overview, "/", hers)).toContain("Showing <b>Alice</b> only.");

      const his = await at(`?owner=${bob.id}`);
      expect(his.change.current).toBe("2000.0000");

      // Two of three, loaded together: exact decimal strings at the stored
      // scale, and the parts adding to the whole is the only check that catches
      // a predicate narrowing one reader and not another.
      const two = await at(`?owner=${[alice.id, bob.id].sort((a, b) => Number(a) - Number(b)).join(",")}`);
      expect(two.change.current).toBe("12000.0000");
      expect(two.computed.at(-1)?.amount).toBe("12000.0000");

      expect((await at("")).change.current).toBe("12500.0000");
    }),
  );

  it(
    "does not draw the hand-typed history while narrowed, and says why",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx, { hers: daysAgo(100), his: daysAgo(100) });

      // Alice's account was created long before its first upload — an empty
      // statement then, real positions later. So her history *begins* at 700
      // days and her line only *starts* at 100, and the gap between them is
      // where a hand-typed point can land. Without the rule below it would be
      // drawn: the household's pre-app net worth, on a line labelled Alice.
      const older = await ctx.seedAccount({ kind: "bank", name: "Alice Savings", owner: alice });
      await ctx.seedPositionSet({ account: older, asOf: daysAgo(700), holdings: [] });
      await ctx.seedManualNetWorth({ date: daysAgo(400), amount: "5000.00" });

      // Unfiltered, exactly what it is today: the prefix fills the gap ahead of
      // the computed line, which is DESIGN.md §7 rule 2.
      const household = await loader(args(get("/?range=all")));
      expect(household.manual.map((point) => point.date)).toEqual([daysAgo(400)]);

      // Narrowed, not drawn. The series is the household's net worth from
      // before there were accounts to attribute it to; there is no owner on it
      // and no honest way to invent one (§7 rule 3).
      const hers = await loader(args(get(`/?owner=${alice.id}&range=all`)));
      expect(hers.manual).toEqual([]);

      // And said, rather than left as a line that starts suspiciously late.
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
      // Bob's history is eight months old; Alice's is three weeks. The
      // household reaches back to Bob's, and a chart narrowed to Alice cannot.
      const { alice } = await seedTwoOwners(ctx, { hers: daysAgo(21), his: daysAgo(240) });
      // Earlier than every position set, so it moves the household's reach —
      // and so a filtered screen that kept reading it would keep reaching back
      // through it, which is the regression this test exists for.
      await ctx.seedManualNetWorth({ date: daysAgo(900), amount: "1000.00" });
      const disabled = (data: Awaited<ReturnType<typeof loader>>, key: string) =>
        data.rangeOptions.find((option) => option.key === key)?.disabled;

      const household = await loader(args(get("/")));
      expect(disabled(household, "3m")).toBe(false);

      const hers = await loader(args(get(`/?owner=${alice.id}`)));
      expect(disabled(hers, "3m")).toBe(true);
      expect(hers.customMin).toBe(daysAgo(21));

      // Disabled, and drawn as a span rather than as a link the loader would
      // only fall back from.
      const markup = renderRoute(Overview, "/", hers);
      expect(markup).not.toContain("range=3m");
      expect(markup).toMatch(/<span[^>]*aria-disabled="true"[^>]*>3M</);
    }),
  );

  it(
    "keeps the filter across a range click and the range across an owner apply",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx, { hers: daysAgo(200), his: daysAgo(200) });
      const search = `?owner=${alice.id}&range=1m`;
      const data = await loader(args(get(`/${search}`)));
      const markup = renderRoute(Overview, `/${search}`, data);

      // The range links carry the owner param — the bug ticket 00 fixed, seen
      // from the side it was fixed for.
      expect(markup).toContain(`href="/?owner=${alice.id}&amp;range=1w"`);
      // And the control carries the range back, as a hidden field, so applying
      // an owner does not throw away a chosen span.
      expect(markup).toContain('type="hidden" name="range" value="1m"');
    }),
  );

  it(
    "redirects a non-canonical owner parameter, and stamps no cookie on the bounce",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx, { hers: daysAgo(200), his: daysAgo(200) });
      const ids = [alice.id, bob.id].sort((a, b) => Number(a) - Number(b));
      const messy = `/?owner=${ids[1]},${ids[0]}&range=1m`;

      expect(await redirectTo(() => loader(args(get(messy))))).toBe(
        `/?owner=${ids.join(",")}&range=1m`,
      );

      // This screen's first thrown redirect, and it runs inside the range
      // middleware. Remembering a choice on a response that is not the page is
      // a header on a bounce nobody reads; the browser follows it and the range
      // is still explicit in the address it follows to.
      expect((await servedAround(messy)).headers.get("Set-Cookie")).toBeNull();

      // The cookie is still written for the page itself, or this would be a
      // fix that quietly removed the feature it was ordering itself against.
      const settled = await servedAround(`/?owner=${ids.join(",")}&range=1m`);
      expect(settled.headers.get("Set-Cookie")).toContain(RANGE_COOKIE);
    }),
  );

  it(
    "redirects the percent-encoded spelling of a separator, so one view has one URL",
    withDatabase(async () => {
      // The address `canonicalOwnerSearch`'s docstring names: a comparison
      // blind to encoding would report `?owner=1%2C3` canonical, and the view
      // would keep two URLs — the one this application's links spell, and the
      // one any transport that round-trips the query through `URLSearchParams`
      // spells. Nothing is seeded, because respelling a separator is decided
      // from the address alone, before any database work.
      expect(await redirectTo(() => loader(args(get("/?owner=1%2C3&range=1m"))))).toBe(
        "/?owner=1,3&range=1m",
      );
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
      const everyone = [alice.id, bob.id, carol.id].sort((a, b) => Number(a) - Number(b)).join(",");

      // Not merely a second URL for one view, which is what it is on the other
      // screens: a narrowed chart drops the pre-app history, so ticking every
      // box would have quietly cost the reader every year before the first
      // upload while the headline stayed identical.
      expect(await redirectTo(() => loader(args(get(`/?owner=${everyone}&range=all`))))).toBe(
        "/?range=all",
      );
    }),
  );

  it(
    "explains the missing pre-app line only on an instance that has one",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx, { hers: daysAgo(200), his: daysAgo(200) });

      // No hand-typed rows: nothing is being withheld, and a note naming a
      // cause the instance does not have is how a note stops being read — the
      // rule the allocation panel's own notes keep two panels down.
      const quiet = await loader(args(get(`/?owner=${alice.id}`)));
      expect(quiet.manualWithheld).toBe(false);
      expect(renderRoute(Overview, "/", quiet)).not.toContain(
        "hand-typed history before this instance existed",
      );

      await ctx.seedManualNetWorth({ date: daysAgo(900), amount: "5000.00" });
      const withheld = await loader(args(get(`/?owner=${alice.id}`)));
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
      // And no header strip either, which would otherwise be an empty row with
      // its own gap above a headline that is already the page's title.
      expect(markup).not.toContain("page-header--bare");
    }),
  );
});

describe("what a filtered address must not lose", () => {
  // Terminates, rather than bounces exactly once: an address legitimately takes
  // two hops — spelling, then the all-owners collapse — and what must never
  // happen is a third that is the second again. `holdings.test.ts` carries the
  // reasoning: two serialisers spell `'` and `,` differently, so an address can
  // differ from its own canonical form forever and the screen answers every
  // request with another redirect until the browser gives up.
  const settles = async (search: string): Promise<void> => {
    let where = `/${search}`;
    const seen: string[] = [];

    for (let hop = 0; hop < 4; hop += 1) {
      const outcome = await outcomeOf(() => loader(args(get(where))));
      if (!(outcome instanceof Response)) return;

      seen.push(where);
      where = outcome.headers.get("Location") ?? "";
      expect({ search, revisited: seen.includes(where) }).toEqual({ search, revisited: false });
    }

    expect({ search, settled: false }).toEqual({ search, settled: true });
  };

  it(
    "settles the canonical redirect, whatever spelled the address",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx, { hers: daysAgo(200), his: daysAgo(200) });
      const both = [alice.id, bob.id].sort((a, b) => Number(a) - Number(b)).join(",");

      for (const search of [
        "",
        `?owner=${alice.id}`,
        `?owner=${both}`,
        `?owner=${both.replace(",", "%2C")}`,
        "?owner=o%27brien",
        "?owner=o'brien",
        `?owner=${bob.id},${alice.id}`,
        `?owner=${alice.id}&range=3m`,
        "?owner=",
      ]) {
        await settles(search);
      }
    }),
  );

  it(
    "keeps the chosen range when the owner is changed from an emptied screen",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx, { hers: daysAgo(200), his: daysAgo(200) });

      // An emptied screen is exactly where a reader changes owner, and the
      // control there emitted no hidden fields at all — so widening also threw
      // away the span they had chosen.
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

      // Spec 0013 names this round trip as the price of the account exemption:
      // the account page ignores the filter, so without a return address
      // Overview → a row → back lands on the whole household silently.
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

      // Under every other range the note is the whole point.
      const dated = await loader(args(get(`/?owner=${alice.id}&range=all`)));
      expect(dated.manualWithheld).toBe(true);

      // A session to plot, or 1D falls back and there is nothing to assert.
      const today = new Date().toISOString().slice(0, 10);
      for (const minute of ["14:30", "15:30", "20:00"]) {
        await ctx.seedObservation({
          instrument: vti,
          asOf: `${today}T${minute}:00Z`,
          marketDate: today,
          price: "100.0000",
        });
      }

      // Under 1D the note would name the filter as the cause of an omission the
      // range imposes, and say the line begins at first recorded holdings where
      // a session begins at its first observed instant. Both wrong at once.
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
      // The strip is suppressed — an empty row with its own gap above a
      // headline that is already the page's title — but the heading is the
      // page's, not the strip's, and a screen with no `h1` cannot be navigated
      // by heading.
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
      // With nothing below it there is no headline to be the page's name, so
      // this is the one state where the title is drawn.
      expect(markup).toContain('<h1 class="page-title">Overview</h1>');
    }),
  );

  it(
    "says nothing has been uploaded even when the address carries an owner filter",
    withDatabase(async (ctx) => {
      // A bookmarked `/?owner=1` opened against a fresh instance is a filtered
      // address *and* an empty instance. Branching on the filter alone answered
      // it with "set to an owner the household can no longer be read as", which
      // sends the reader hunting for a roster on a database that has none.
      await ctx.seedPerson({ name: "Alice" });
      const data = await loader(args(get("/?owner=999999999")));

      expect(data.hasHoldings).toBe(false);
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

      // Alice keeps an open account holding nothing: still in the roster, so
      // this is a fact about the household rather than an error.
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
});

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
