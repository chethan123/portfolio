/**
 * The account drill-down's three guards (DESIGN.md §13).
 *
 * Every figure on this page comes out of `valuation.server.ts` and
 * `uploads.server.ts` already tested; what is only here is what the route does
 * with the *URL* — the id in the path and the two receipt parameters hung off
 * it. All three are reachable by hand, by a stale bookmark, or by a crawler,
 * and each has a way of failing that leaves no mark on the screen.
 *
 * The gate first: `accountTotal` answers null for an id naming no account, for
 * one that is not an id at all, and for a closed account. All three have to be
 * a 404, because a closed account is excluded from `holding_valued` and would
 * otherwise render as a header of blanks with nothing anywhere saying why.
 *
 * Then the receipts, which are the reason this file matters more than its size
 * suggests. `?uploaded=` and `?recorded=` say *which* set or date was written
 * and nothing about what is in it, and the confirmation beside them is read
 * back out of the database. Only the route enforces that. A receipt that
 * believed its own URL would tell someone their statement had been recorded
 * when nothing had been written at all — a false confirmation on the one screen
 * whose job is to confirm, and one that leaves no trace to find later.
 */
import { afterAll, describe, expect, it } from "vitest";

import Account, { action, loader, middleware } from "../../app/routes/account.tsx";
import { RANGE_COOKIE } from "~/lib/chart-range";
import { earliestRecordableDate, latestRecordableDate } from "~/lib/input.server";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { args, get, post, redirectTo, responseOf, servedThrough } from "../support/routes.ts";

import type { TestContext } from "../support/database.ts";

/**
 * Set before any loader runs: `account.tsx` reads `MARKET_TIMEZONE` through
 * `getConfig()` to tell the chart which clock a session's instants are read on,
 * and `getConfig()` validates the whole environment when it is first asked.
 * `MARKET_TIMEZONE` itself defaults; the database URL is the one variable with
 * no default, and it is the same one the harness already connects with.
 */
process.env.DATABASE_URL = TEST_DATABASE_URL;

afterAll(closeTestDatabase);

const DAY_MS = 86_400_000;

/** Today in UTC, the way the route computes the end of its window. */
const today = (): string => new Date().toISOString().slice(0, 10);

/** A date `days` before today, in UTC — the zone the loader samples in. */
const daysAgo = (days: number): string =>
  new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);

/**
 * An account with two statements behind it — a January one and the February
 * one that superseded it, so "the set the account is reading" is a fact with a
 * wrong answer available.
 */
async function seedTwoStatements(
  ctx: Pick<
    TestContext,
    "seedPerson" | "seedAccount" | "seedInstrument" | "seedPositionSet" | "seedQuote"
  >,
) {
  const owner = await ctx.seedPerson({ name: "Alice" });
  const account = await ctx.seedAccount({ name: "Fidelity Taxable", owner, kind: "brokerage" });

  const vti = await ctx.seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
  const vxus = await ctx.seedInstrument({ symbol: "VXUS", name: "Vanguard Total International" });
  await ctx.seedQuote({ instrument: vti, price: "250.0000" });
  await ctx.seedQuote({ instrument: vxus, price: "60.0000" });

  const january = await ctx.seedPositionSet({
    account,
    asOf: "2026-01-31",
    sourceFilename: "January.csv",
    holdings: [{ instrument: vti, quantity: "100.00000000" }],
  });
  const february = await ctx.seedPositionSet({
    account,
    asOf: "2026-02-28",
    sourceFilename: "February.csv",
    holdings: [
      { instrument: vti, quantity: "120.00000000" },
      { instrument: vxus, quantity: "50.00000000" },
    ],
  });

  return { account, january, february };
}

describe("the 404 gate", () => {
  it(
    "answers 404 for an account id that names no row and for one that is not an id at all",
    withDatabase(async () => {
      // The first is a bookmark to an instance that was reset; the second is
      // what a crawler or a truncated link produces. Neither may reach a query
      // that casts to `bigint`, where `'lookup'::bigint` is a driver error and
      // reaches the reader as a 500 rather than as "no such account".
      //
      // The third is all digits and so passed the guard on shape, then
      // overflowed `bigint` inside Postgres — the same 500 by a longer route.
      // The magnitude bound in `couldBeId` is what turns it back into "no such
      // account", and the fourth pins the boundary itself: one past the largest
      // `bigint` is refused here rather than by the driver.
      for (const accountId of [
        "999999999",
        "lookup",
        "99999999999999999999999",
        "9223372036854775808",
      ]) {
        const response = await responseOf(() =>
          loader(args(get(`/accounts/${accountId}`), { accountId })),
        );

        expect(response.status).toBe(404);
      }
    }),
  );

  it(
    "still resolves an account whose id is written with leading zeros",
    withDatabase(async (ctx) => {
      // The other half of the same bound. `0000000000000000001` is nineteen
      // characters and is account 1: a guard counting characters rather than
      // reading the value would 404 a row that exists, which is the opposite
      // failure and the harder one to notice.
      const { account } = await seedTwoStatements(ctx);
      const padded = account.id.padStart(19, "0");

      const data = await loader(args(get(`/accounts/${padded}`), { accountId: padded }));

      expect(data.total.accountId).toBe(account.id);
    }),
  );
});

describe("the date control's boundaries", () => {
  it(
    "hands the picker the same two dates the validator refuses by",
    withDatabase(async (ctx) => {
      // The picker's `min`/`max` and the refusal behind them are one rule stated
      // once, so a control that silently disagreed with the validator — offering
      // a date the write then rejects, or hiding one it would accept — cannot
      // happen. Read from the validator here for the same reason the loader
      // reads it rather than hard-coding: a literal in this test would be a
      // second copy free to drift.
      const { account } = await seedTwoStatements(ctx);
      const data = await loader(
        args(get(`/accounts/${account.id}`), { accountId: account.id }),
      );

      expect(data.earliestAsOf).toBe(earliestRecordableDate());
      expect(data.latestAsOf).toBe(latestRecordableDate());
      // Not a tautology: pin the floor's actual value, which is load-bearing —
      // it is the date `0001_initial_schema.sql` seeds USD a close on.
      expect(data.earliestAsOf).toBe("1970-01-01");
      expect(data.earliestAsOf < data.latestAsOf).toBe(true);
    }),
  );
});

describe("the receipts", () => {
  it(
    "confirms an upload only for the set the account is actually reading",
    withDatabase(async (ctx) => {
      const { account, january, february } = await seedTwoStatements(ctx);
      const at = (search: string) =>
        loader(args(get(`/accounts/${account.id}${search}`), { accountId: account.id }));

      // The parameter the upload flow really redirects with. Every figure in
      // the sentence is counted off the stored rows, so it describes the
      // holdings printed beneath it or it does not appear.
      const real = await at(`?uploaded=${february.id}`);
      expect(real.receipt).toMatchObject({
        setId: february.id,
        asOf: "2026-02-28",
        filename: "February.csv",
        holdingCount: 2,
      });

      // Hand-typed: a set this account really owns, but not the one it is
      // reading. A receipt taken from the URL would announce that January's
      // statement had just been recorded while the page beneath it prints
      // February's — and would do the same for a set belonging to somebody
      // else's account entirely.
      expect((await at(`?uploaded=${january.id}`)).receipt).toBeNull();
      expect((await at("?uploaded=999999999")).receipt).toBeNull();
      expect((await at("?uploaded=%20or%201=1")).receipt).toBeNull();
    }),
  );

  it(
    "confirms a recorded balance only against the date the account is reading",
    withDatabase(async (ctx) => {
      const { account, february } = await seedTwoStatements(ctx);
      const at = (search: string) =>
        loader(args(get(`/accounts/${account.id}${search}`), { accountId: account.id }));

      // The redirect after `setBalance` says which date it wrote, and the
      // loader checks that against what the account now reads rather than
      // trusting it.
      expect((await at(`?recorded=${february.asOf}`)).justRecorded).toBe(true);

      // January is a date this account genuinely carries — it is simply not
      // the current one. Nothing was recorded for it just now, so nothing
      // confirms it; the same goes for a date invented outright.
      expect((await at("?recorded=2026-01-31")).justRecorded).toBe(false);
      expect((await at("?recorded=2026-07-04")).justRecorded).toBe(false);
      expect((await at("?recorded=whenever")).justRecorded).toBe(false);
    }),
  );
});

describe("the way into the upload flow", () => {
  it(
    "links the action row and the empty state's sentence to the upload screen naming this account",
    withDatabase(async (ctx) => {
      // A statement-kind account with nothing recorded yet: the one state that
      // renders both ways in at once. The action row is unconditional, and an
      // empty non-balance account is exactly who the empty state tells to
      // upload.
      const account = await ctx.seedAccount({ kind: "brokerage", name: "Fidelity Taxable" });

      const data = await loader(args(get(`/accounts/${account.id}`), { accountId: account.id }));
      const markup = renderRoute(Account, `/accounts/${account.id}`, data);

      // Destination and label are the contract; the icon inside the button
      // and the sentence around the phrase are free to change. The address is
      // named without the owner filter: the upload flow has no owner concept,
      // so unlike the breadcrumb there is nothing to hand it.
      const upload = `href="/upload?account=${account.id}"`;
      expect(markup.split(upload).length - 1).toBe(2);
      expect(markup).toContain("Upload statement</a>");
      expect(markup).toContain(">upload a statement</a>");
    }),
  );
});

describe("the chart's range", () => {
  it(
    "falls back to the default window for a value it does not offer, rather than to an empty one",
    withDatabase(async (ctx) => {
      const owner = await ctx.seedPerson({ name: "Alice" });
      const account = await ctx.seedAccount({ name: "Checking", owner, kind: "bank" });
      const usd = await ctx.usdInstrument();

      await ctx.seedPositionSet({
        account,
        asOf: today(),
        holdings: [{ instrument: usd, quantity: "12500.00000000" }],
      });

      const at = (search: string) =>
        loader(args(get(`/accounts/${account.id}${search}`), { accountId: account.id }));

      // The window is a day count that becomes twenty-five `toISOString` calls.
      // A range key the table does not hold must resolve to a real one before
      // it gets there: an undefined day count makes every sample an invalid
      // date, which is a 500 on the whole page rather than a chart with an odd
      // span.
      const guessed = await at("?range=6m");
      const defaulted = await at("");

      expect(guessed.range).toBe("1y");
      expect(guessed.computed).toEqual(defaulted.computed);
      // And the fallback really draws: a window that silently collapsed would
      // pass a `range` assertion while leaving the reader an empty panel.
      expect(guessed.computed.at(-1)).toEqual({ date: today(), amount: "12500.0000" });
    }),
  );

  it.each(["toString", "constructor", "valueOf", "hasOwnProperty"])(
    "does not mistake %s for a range, however much it looks like a key",
    (inherited) =>
      withDatabase(async (ctx) => {
        // The gate was `requested in RANGES`, and `in` walks the prototype
        // chain — so each of these passed it, `RANGES[requested].days` read
        // `undefined`, and `sampleDates` reached `isoDate(NaN)` and threw.
        // A 500 on the account page from a query string alone.
        const { account } = await seedTwoStatements(ctx);

        const data = await loader(
          args(get(`/accounts/${account.id}?range=${inherited}`), { accountId: account.id }),
        );

        expect(data.range).toBe("1y");
      })(),
  );
});

/** One bank account holding one balance, as of `asOf` — this account's own day zero. */
async function seedAccountDayZero(
  ctx: Pick<TestContext, "seedPerson" | "seedAccount" | "seedPositionSet" | "usdInstrument">,
  asOf: string,
) {
  const owner = await ctx.seedPerson({ name: "Alice" });
  const account = await ctx.seedAccount({ name: "Checking", owner, kind: "bank" });
  const usd = await ctx.usdInstrument();

  await ctx.seedPositionSet({
    account,
    asOf,
    holdings: [{ instrument: usd, quantity: "12500.00000000" }],
  });

  return account;
}

describe("the persistence cookie (spec 0008)", () => {
  it(
    "lets an explicit ?range= win over a cookie naming a different range",
    withDatabase(async (ctx) => {
      const account = await seedAccountDayZero(ctx, daysAgo(400));
      const data = await loader(
        args(get(`/accounts/${account.id}?range=5y`, `${RANGE_COOKIE}=1m`), { accountId: account.id }),
      );

      expect(data.range).toBe("5y");
    }),
  );

  it(
    "uses the cookie's stored range when the URL carries none",
    withDatabase(async (ctx) => {
      const account = await seedAccountDayZero(ctx, daysAgo(400));
      const data = await loader(
        args(get(`/accounts/${account.id}`, `${RANGE_COOKIE}=5y`), { accountId: account.id }),
      );

      expect(data.range).toBe("5y");
    }),
  );

  it(
    "sets the cookie whenever the request carried an explicit range",
    withDatabase(async (ctx) => {
      const account = await seedAccountDayZero(ctx, daysAgo(400));
      const response = await servedThrough(middleware, get(`/accounts/${account.id}?range=5y`), {
        accountId: account.id,
      });

      expect(response.headers.get("Set-Cookie")).toContain(`${RANGE_COOKIE}=5y`);
    }),
  );

  it(
    "writes nothing when the request named no explicit range",
    withDatabase(async (ctx) => {
      const account = await seedAccountDayZero(ctx, daysAgo(400));
      const response = await servedThrough(middleware, get(`/accounts/${account.id}`), {
        accountId: account.id,
      });

      expect(response.headers.get("Set-Cookie")).toBeNull();
    }),
  );
});

describe("a custom range", () => {
  it(
    "resolves to exactly the span asked for and reports it back for the control to show",
    withDatabase(async (ctx) => {
      const account = await seedAccountDayZero(ctx, daysAgo(200));
      const data = await loader(
        args(
          get(`/accounts/${account.id}?range=custom&start=${daysAgo(100)}&end=${daysAgo(10)}`),
          { accountId: account.id },
        ),
      );

      expect(data.range).toBe("custom");
      expect(data.custom).toEqual({ start: daysAgo(100), end: daysAgo(10) });
    }),
  );

  it(
    "falls back to the default rather than erroring on an incomplete pair",
    withDatabase(async (ctx) => {
      const account = await seedAccountDayZero(ctx, daysAgo(200));
      const data = await loader(
        args(get(`/accounts/${account.id}?range=custom&start=2026-01-01`), { accountId: account.id }),
      );

      expect(data.range).toBe("1y");
      expect(data.custom).toBeUndefined();
    }),
  );

  it(
    "falls back to the default rather than erroring on a span reaching before this account's own earliest data",
    withDatabase(async (ctx) => {
      const account = await seedAccountDayZero(ctx, daysAgo(30));
      const data = await loader(
        args(get(`/accounts/${account.id}?range=custom&start=2000-01-01&end=${daysAgo(0)}`), {
          accountId: account.id,
        }),
      );

      expect(data.range).toBe("1y");
    }),
  );

  it(
    "gives the custom form this account's own earliest date as its minimum, never the household's",
    withDatabase(async (ctx) => {
      // The household's earliest statement (an older, unrelated account)
      // predates this account's own — the account-scoped query, not
      // `firstRecordedDate`, must decide the minimum spec 0008 adds.
      const owner = await ctx.seedPerson();
      const older = await ctx.seedAccount({ name: "Older", owner });
      await ctx.seedPositionSet({ account: older, asOf: daysAgo(900), holdings: [] });

      const account = await seedAccountDayZero(ctx, daysAgo(200));
      const data = await loader(args(get(`/accounts/${account.id}`), { accountId: account.id }));

      expect(data.customMin).toBe(daysAgo(200));
      expect(data.customMax).toBe(daysAgo(0));

      // Not just the loader's own field — the two date inputs the reader
      // actually sees have to carry the same bounds.
      const markup = renderRoute(Account, `/accounts/${account.id}`, data);
      expect(markup).toContain(`min="${daysAgo(200)}" max="${daysAgo(0)}" name="start"`);
      expect(markup).toContain(`min="${daysAgo(200)}" max="${daysAgo(0)}" name="end"`);
    }),
  );

  it(
    "renders the applied span instead of the word Custom, once one is applied",
    withDatabase(async (ctx) => {
      const account = await seedAccountDayZero(ctx, daysAgo(200));
      const data = await loader(
        args(
          get(`/accounts/${account.id}?range=custom&start=${daysAgo(100)}&end=${daysAgo(10)}`),
          { accountId: account.id },
        ),
      );
      const markup = renderRoute(Account, `/accounts/${account.id}`, data);

      expect(markup).toContain(`${daysAgo(100)} – ${daysAgo(10)}`);
      expect(markup).not.toMatch(/>Custom</);
    }),
  );
});

/**
 * Where the segmented control's `key` preset actually points — the resolved
 * href a reader would follow, with the ampersands a multi-param query needs
 * decoded back out of the markup.
 *
 * Found by parsing each candidate's query rather than by matching the string,
 * so the assertion below is about which range the link names and not about
 * where in the query it happens to sit.
 */
function presetHref(markup: string, key: string): string {
  const href = [...markup.matchAll(/href="([^"]*)"/g)]
    .map(([, candidate]) => (candidate ?? "").replaceAll("&amp;", "&"))
    .find((candidate) => new URL(candidate, "http://portfolio.local").searchParams.get("range") === key);

  if (href === undefined) throw new Error(`No ${key} preset link in:\n${markup}`);

  return href;
}

describe("the range links and the rest of the query", () => {
  it(
    "keeps the upload receipt when a preset is followed, rather than replacing the whole query",
    withDatabase(async (ctx) => {
      const { account, february } = await seedTwoStatements(ctx);
      const at = (path: string) => loader(args(get(path), { accountId: account.id }));

      const path = `/accounts/${account.id}?uploaded=${february.id}`;
      const markup = renderRoute(Account, path, await at(path));

      // The bug: `to="?range=1m"` is a *whole* query string, and React Router
      // resolves it as one. Upload a statement, read the confirmation, click
      // 1M, and the sentence you were reading is gone — with nothing on screen
      // to say it ever existed.
      const href = presetHref(markup, "1m");
      expect(href).toBe(`/accounts/${account.id}?uploaded=${february.id}&range=1m`);

      // Followed, not merely asserted on: the receipt has to survive the click
      // itself, which is the thing a reader actually does.
      const clicked = await at(href);
      expect(clicked.range).toBe("1m");
      expect(clicked.receipt).toMatchObject({ setId: february.id, filename: "February.csv" });
      expect(renderRoute(Account, href, clicked)).toContain("February.csv");
    }),
  );

  it(
    "keeps the balance receipt too, and carries it through the custom form's hidden fields",
    withDatabase(async (ctx) => {
      // Read once: five `daysAgo(400)` calls could straddle UTC midnight, and
      // the failure would be a flake nobody could reproduce.
      const recorded = daysAgo(400);
      const account = await seedAccountDayZero(ctx, recorded);
      const at = (path: string) => loader(args(get(path), { accountId: account.id }));

      const path = `/accounts/${account.id}?recorded=${recorded}`;
      const data = await at(path);
      expect(data.justRecorded).toBe(true);

      const markup = renderRoute(Account, path, data);
      const href = presetHref(markup, "1m");
      expect(href).toBe(`/accounts/${account.id}?recorded=${recorded}&range=1m`);
      expect((await at(href)).justRecorded).toBe(true);

      // A GET form submits its own fields and nothing else, so Custom drops
      // whatever the address held unless it re-emits it as a hidden field.
      expect(markup).toContain(`type="hidden" name="recorded" value="${recorded}"`);
    }),
  );

  it(
    "clears the custom span when moving off it, so a preset never leaves one in the address",
    withDatabase(async (ctx) => {
      const account = await seedAccountDayZero(ctx, daysAgo(200));
      const path = `/accounts/${account.id}?range=custom&start=${daysAgo(100)}&end=${daysAgo(10)}`;

      const data = await loader(args(get(path), { accountId: account.id }));
      const markup = renderRoute(Account, path, data);

      // `range`, `start` and `end` are the control's own vocabulary: a preset
      // rewrites them rather than carrying them, or the address advertises a
      // span nothing draws.
      expect(presetHref(markup, "1m")).toBe(`/accounts/${account.id}?range=1m`);
    }),
  );

  it(
    "still names its own range and nothing else on a screen carrying no other params",
    withDatabase(async (ctx) => {
      const account = await seedAccountDayZero(ctx, daysAgo(400));
      const path = `/accounts/${account.id}`;
      const markup = renderRoute(Account, path, await loader(args(get(path), { accountId: account.id })));

      expect(presetHref(markup, "1m")).toBe(`${path}?range=1m`);
      // Including the default preset, which links to its own key rather than
      // to `.` so an explicit choice beats the persistence cookie.
      expect(presetHref(markup, "1y")).toBe(`${path}?range=1y`);
    }),
  );
});

describe("a preset before this account's own earliest data", () => {
  it(
    "renders disabled, with no working link, using the account-scoped earliest date rather than the household's",
    withDatabase(async (ctx) => {
      // The household has older data (a different account); this account is
      // eight months old. Before spec 0008's account-scoped query, "All" and
      // the disabled rule both fell back to the household-wide earliest date
      // and would have missed this.
      const owner = await ctx.seedPerson();
      const older = await ctx.seedAccount({ name: "Older", owner });
      await ctx.seedPositionSet({ account: older, asOf: daysAgo(900), holdings: [] });

      const account = await seedAccountDayZero(ctx, daysAgo(240));
      const data = await loader(args(get(`/accounts/${account.id}`), { accountId: account.id }));

      expect(data.rangeOptions.find((option) => option.key === "5y")?.disabled).toBe(true);

      const markup = renderRoute(Account, `/accounts/${account.id}`, data);
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
      const account = await seedAccountDayZero(ctx, daysAgo(7));
      const data = await loader(args(get(`/accounts/${account.id}`), { accountId: account.id }));

      expect(data.rangeOptions.find((option) => option.key === "1w")?.disabled).toBe(false);
    }),
  );
});

describe("the 1D range on an account", () => {
  it(
    "draws this account's own session line, at the whole log's instants",
    withDatabase(async (ctx) => {
      const account = await seedAccountDayZero(ctx, daysAgo(2));
      const vti = await ctx.seedInstrument({ symbol: "VTI", priceSource: "feed" });
      await ctx.seedDailyClose({ instrument: vti, date: daysAgo(2), close: "200.0000" });

      for (const [minute, price] of [
        ["13:30", "210.0000"],
        ["20:00", "220.0000"],
      ]) {
        await ctx.seedObservation({
          instrument: vti,
          asOf: `${daysAgo(1)}T${minute}:00Z`,
          marketDate: daysAgo(1),
          price: price as string,
        });
      }

      const data = await loader(
        args(get(`/accounts/${account.id}?range=1d`), { accountId: account.id }),
      );

      // Story 10: this account holds cash and nothing else, so nothing the feed
      // reported all session touches it. Its answer is that it did not move —
      // drawn, at the same moments the household's line is drawn at, rather
      // than left blank.
      expect(data.range).toBe("1d");
      expect(data.session).toEqual({ timeZone: "America/New_York" });
      expect(data.computed.map((point) => [point.date, point.amount])).toEqual([
        [`${daysAgo(1)}T13:30:00.000Z`, "12500.0000"],
        [`${daysAgo(1)}T20:00:00.000Z`, "12500.0000"],
      ]);
    }),
  );

  it(
    "disables the 1D chip on an instance whose observation log is empty",
    withDatabase(async (ctx) => {
      const account = await seedAccountDayZero(ctx, daysAgo(400));

      const data = await loader(
        args(get(`/accounts/${account.id}`), { accountId: account.id }),
      );

      expect(data.rangeOptions.find((option) => option.key === "1d")?.disabled).toBe(true);
      // And asking for it anyway falls back to the default preset rather than
      // captioning a chart 1D over a session that never existed.
      const asked = await loader(
        args(get(`/accounts/${account.id}?range=1d`), { accountId: account.id }),
      );
      expect(asked.range).toBe("1y");
      expect(asked.session).toBeNull();
    }),
  );
});

describe("the receipt a balance write redirects to", () => {
  it(
    "keeps what the submitting page was reading",
    withDatabase(async (ctx) => {
      const account = await ctx.seedAccount({ kind: "bank", name: "Chase Checking" });

      // `chartRangeMiddleware` writes no cookie onto a redirect, so a target
      // that dropped `range` would leave the followed GET with nothing explicit
      // to read — and send it to whatever the cookie last held, which another
      // tab may have moved. The receipt names the range, which is what makes
      // the middleware's rule safe.
      const to = await redirectTo(() =>
        action(
          args(
            post(`/accounts/${account.id}?range=1m&owner=7`, { amount: "1250.00", asOf: "2026-02-28" }),
            { accountId: account.id },
          ),
        ),
      );

      expect(to).toContain("range=1m");
      // And the owner filter, so a write does not end a reading either.
      expect(to).toContain("owner=7");
      expect(to).toContain("recorded=");
    }),
  );

  it(
    "does not stack a second receipt on the first",
    withDatabase(async (ctx) => {
      const account = await ctx.seedAccount({ kind: "bank", name: "Chase Checking" });

      const to = await redirectTo(() =>
        action(
          args(
            post(`/accounts/${account.id}?recorded=2026-01-31`, { amount: "10.00", asOf: "2026-02-28" }),
            { accountId: account.id },
          ),
        ),
      );

      expect(to.match(/recorded=/g)).toHaveLength(1);
      expect(to).not.toContain("recorded=2026-01-31");
    }),
  );
});
