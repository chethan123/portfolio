/**
 * The Holdings URL, which is the whole of that screen's state (DESIGN.md §8.1).
 *
 * What the table *contains* belongs to `holdings-view.ts` and is tested against
 * its own rules in `holdings-view.test.ts` — `parseQuery`, `toSearch`,
 * `sortHoldings`, `parseRowKey`. What lives only here is the route's use of
 * them: the bounce to a canonical address, the two row parameters deliberately
 * kept outside `HoldingsQuery`, and the one write.
 *
 * The bounce is why this file exists. Every control on this screen is a link or
 * a GET form, and a GET form submits the six selects nobody touched — so the
 * address a person actually arrives at is `?owner=1&account=&institution=&…`
 * and the loader redirects it to the readable spelling before drawing anything.
 * A redirect target that is not itself canonical is not a cosmetic fault: it is
 * the application's busiest table answering every request with another redirect
 * until the browser gives up, with no error page and no way back. So the target
 * is fed straight back into the loader below rather than merely read.
 *
 * The write's guard is the other half of the same idea. Which row a correction
 * applies to comes from `?edit=` and from nowhere else — there is no hidden
 * field that could disagree with the page — so a POST that names no row has no
 * row to write, and must refuse rather than choose one.
 */
import { afterAll, describe, expect, it } from "vitest";

import Holdings, { action, loader } from "../../app/routes/holdings.tsx";
import { currentPosition } from "~/lib/positions.server";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { args, get, post, redirectTo, responseOf } from "../support/routes.ts";

import type { TestContext } from "../support/database.ts";

afterAll(closeTestDatabase);

/** One priced position, which is the smallest thing this screen can draw. */
async function seedOnePosition(
  ctx: Pick<
    TestContext,
    "seedPerson" | "seedAccount" | "seedInstrument" | "seedPositionSet" | "seedQuote"
  >,
) {
  const owner = await ctx.seedPerson({ name: "Alice" });
  const account = await ctx.seedAccount({ name: "Fidelity Taxable", owner, kind: "brokerage" });
  const vti = await ctx.seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });

  await ctx.seedQuote({ instrument: vti, price: "250.0000" });
  await ctx.seedPositionSet({
    account,
    asOf: "2026-01-31",
    holdings: [{ instrument: vti, quantity: "100.00000000", costBasisPerShare: "180.0000" }],
  });

  return { owner, account, instrument: vti, rowKey: `${account.id}.${vti.id}` };
}

describe("the canonical bounce", () => {
  it(
    "sends a GET form's empty parameters to a readable address that does not itself redirect",
    withDatabase(async (ctx) => {
      const { owner } = await seedOnePosition(ctx);

      // Exactly what pressing Apply with one select touched puts in the address
      // bar: seven parameters, six of them meaning "all".
      const submitted =
        `/holdings?owner=${owner.id}` +
        "&account=&institution=&kind=&tax=&classification=&assetClass=";

      const destination = await redirectTo(() => loader(args(get(submitted))));
      expect(destination).toBe(`/holdings?owner=${owner.id}`);

      // The assertion this file is really for. Anything that makes the target
      // of the bounce disagree with `toSearch` — a parameter written in a
      // different order, a default spelled out, a filter dropped and re-added —
      // turns this screen into a redirect loop, and the loop is invisible in a
      // test that only looks at the first hop.
      const settled = await loader(args(get(destination)));
      expect(settled.view).toBe(`?owner=${owner.id}`);
    }),
  );

  it(
    "drops a sort by the column the grouping has already taken off the screen",
    withDatabase(async (ctx) => {
      await seedOnePosition(ctx);

      // Grouping by owner puts the name in the heading and removes the column,
      // so `sort=owner` would leave the table ordered by a heading with no
      // caret, no `aria-sort` and no control to reverse it — and the URL would
      // go on claiming a sort nobody can see or undo.
      expect(await redirectTo(() => loader(args(get("/holdings?group=owner&sort=owner&dir=asc"))))).toBe(
        "/holdings?group=owner",
      );

      const fallen = await loader(args(get("/holdings?group=owner")));
      expect([fallen.sort, fallen.direction]).toEqual(["value", "desc"]);

      // A sort the grouping does *not* hide is left exactly as asked, so the
      // fallback is a repair of one case and not a blanket reset.
      const kept = await loader(args(get("/holdings?group=owner&sort=quantity")));
      expect([kept.sort, kept.direction]).toEqual(["quantity", "desc"]);
    }),
  );

  it(
    "re-serialises the row parameters, and lets a receipt supersede an open editor",
    withDatabase(async (ctx) => {
      const { rowKey } = await seedOnePosition(ctx);

      // `edit` and `saved` are re-serialised from the pair they parse to rather
      // than echoed, so a spelling `rowKey` would never produce cannot survive.
      // `0001.0002` names the same row as `1.2` and would otherwise sit in a
      // URL claiming an open editor beside a table where no row's key matches.
      expect(await redirectTo(() => loader(args(get("/holdings?edit=0001.0002"))))).toBe("/holdings");

      // A receipt is where the write redirects to and the row it names has just
      // been closed, so the two never share an address.
      expect(await redirectTo(() => loader(args(get(`/holdings?edit=${rowKey}&saved=${rowKey}`))))).toBe(
        `/holdings?saved=${rowKey}`,
      );

      // And a well-formed pair on its own is already canonical — otherwise
      // opening an editor would bounce, and bounce back.
      const open = await loader(args(get(`/holdings?edit=${rowKey}`)));
      expect(open.editing).toBe(rowKey);
    }),
  );
});

/**
 * Two owners, one priced position each, and one instrument only Bob holds —
 * so a dimension value can be present in the household and absent from the
 * narrowed set, which is what the facet rule is about.
 */
async function seedTwoOwners(
  ctx: Pick<
    TestContext,
    "seedPerson" | "seedAccount" | "seedInstrument" | "seedPositionSet" | "seedQuote"
  >,
) {
  const alice = await ctx.seedPerson({ name: "Alice" });
  const bob = await ctx.seedPerson({ name: "Bob" });

  const vti = await ctx.seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
  const bnd = await ctx.seedInstrument({ symbol: "BND", name: "Vanguard Total Bond" });
  await ctx.seedQuote({ instrument: vti, price: "250.0000" });
  await ctx.seedQuote({ instrument: bnd, price: "70.0000" });

  const hers = await ctx.seedAccount({ name: "Alice Brokerage", owner: alice, kind: "brokerage" });
  const his = await ctx.seedAccount({ name: "Bob Roth", owner: bob, kind: "ira" });

  await ctx.seedPositionSet({
    account: hers,
    asOf: "2026-01-31",
    holdings: [{ instrument: vti, quantity: "100.00000000" }],
  });
  await ctx.seedPositionSet({
    account: his,
    asOf: "2026-01-31",
    holdings: [{ instrument: bnd, quantity: "40.00000000" }],
  });

  return { alice, bob, hers, his };
}

describe("reading the table as an owner", () => {
  it(
    "narrows to one owner, and to two, exactly as the old Owner select did",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx);
      const at = (search: string) => loader(args(get(`/holdings${search}`)));

      const hers = await at(`?owner=${alice.id}`);
      expect(hers.rows?.map((row) => row.instrumentName)).toEqual([
        "Vanguard Total Stock Market",
      ]);
      expect(hers.total.value).toBe("25000.0000");

      const both = await at(`?owner=${[alice.id, bob.id].sort((a, b) => Number(a) - Number(b)).join(",")}`);
      expect(both.rows).toHaveLength(2);
      expect(both.total.value).toBe("27800.0000");

      expect((await at("")).total.value).toBe("27800.0000");
    }),
  );

  it(
    "says it is filtered when nothing but the owner filter is on",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx);

      // The reproducing case. `filtered` used to count `query.filters`, which
      // is now zero for an owner-only narrowing — and without the notice a
      // filtered table looks like the whole portfolio to anyone who did not
      // set the filter, including you a day later following your own bookmark.
      const data = await loader(args(get(`/holdings?owner=${alice.id}`)));

      expect(data.active).toEqual([]);
      // N is the household's, not the narrowed set's: the same number has to
      // mean one thing whichever control you touched.
      expect(data.totalHoldings).toBe(2);

      const markup = renderRoute(Holdings, "/holdings", data);
      expect(markup).toContain("filtered from 2");
      expect(markup).toContain("Showing <b>Alice</b> only.");
    }),
  );

  it(
    "builds the filter selects from every holding, not from the owner's",
    withDatabase(async (ctx) => {
      const { alice, hers, his } = await seedTwoOwners(ctx);

      // Bob's account has to stay on offer while the table is
      // narrowed to Alice: options that vanished as you narrowed would leave
      // no way to widen again.
      const data = await loader(args(get(`/holdings?owner=${alice.id}`)));
      const accounts = data.filters.find((filter) => filter.id === "account");

      expect(accounts?.options.map((option) => option.value)).toEqual([
        String(hers.id),
        String(his.id),
      ]);
    }),
  );

  it(
    "keeps the owner filter on every link and control this screen draws",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx);
      const filtered = `?owner=${alice.id}`;
      const data = await loader(args(get(`/holdings${filtered}&group=kind&sort=quantity`)));

      // The canonical view every Cancel and every control is built from.
      expect(data.view).toBe(`${filtered}&group=kind&sort=quantity`);

      const markup = renderRoute(Holdings, "/holdings", data);
      // A column header, a group chip, and the filter bar's hidden field.
      expect(markup).toContain(
        `href="/holdings?owner=${alice.id}&amp;group=kind&amp;sort=asset&amp;dir=asc"`,
      );
      expect(markup).toContain(`href="/holdings?owner=${alice.id}&amp;sort=quantity"`);
      expect(markup).toContain(`type="hidden" name="owner" value="${alice.id}"`);
      // And Show everyone drops it while keeping the rest, which is the one
      // link on the screen that should.
      expect(markup).toContain('href="/holdings?group=kind&amp;sort=quantity"');
    }),
  );

  it(
    "leaves the owner filter alone when this screen's own filters are cleared",
    withDatabase(async (ctx) => {
      const { alice, hers } = await seedTwoOwners(ctx);
      const search = `?owner=${alice.id}&account=${hers.id}`;
      const data = await loader(args(get(`/holdings${search}`)));

      // Clear filters is a screen-local control and the owner filter is
      // household-wide: clearing it from here would reach out and change what
      // Overview shows next.
      const markup = renderRoute(Holdings, "/holdings", data);
      expect(markup).toContain(`href="/holdings?owner=${alice.id}"`);
      expect(markup).not.toContain('href="/holdings"');
    }),
  );

  it(
    "still groups by owner, still drops the column, and does it under a filter naming two",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx);
      const both = [alice.id, bob.id].sort((a, b) => Number(a) - Number(b)).join(",");
      const data = await loader(args(get(`/holdings?owner=${both}&group=owner`)));

      expect(data.groups?.map((group) => group.label)).toEqual(["Alice", "Bob"]);

      const markup = renderRoute(Holdings, "/holdings", data);
      // Grouping by owner puts the name in the heading, so repeating it on
      // every row beneath says nothing and costs the Asset column its width.
      // Asserted on the header's sort link rather than on the word, which the
      // control's own legend also carries.
      expect(markup).not.toContain("sort=owner");
    }),
  );

  it(
    "returns a correction to the narrowed view, reading the filter off the request URL",
    withDatabase(async (ctx) => {
      const { alice, hers } = await seedTwoOwners(ctx);
      const holdings = await loader(args(get(`/holdings?owner=${alice.id}`)));
      const row = holdings.rows?.[0];
      const key = `${hers.id}.${row?.instrumentId ?? ""}`;

      const destination = await redirectTo(() =>
        action(args(post(`/holdings?owner=${alice.id}&edit=${key}`, { quantity: "120" }))),
      );

      // No hidden field carries it: the form posts back to the address that
      // opened it, so the filter travels the way the row's identity does.
      expect(destination).toBe(`/holdings?owner=${alice.id}&saved=${key}`);
    }),
  );
});

describe("the three empty states", () => {
  it(
    "says nothing has been uploaded only when nothing has",
    withDatabase(async (ctx) => {
      await ctx.seedPerson({ name: "Alice" });
      const data = await loader(args(get("/holdings")));

      expect(data.hasHoldings).toBe(false);
      expect(renderRoute(Holdings, "/holdings", data)).toContain(
        "Nothing has been uploaded to this instance yet",
      );
    }),
  );

  it(
    "says the filter names an owner it cannot read as, and keeps the control on screen",
    withDatabase(async (ctx) => {
      await seedTwoOwners(ctx);

      // An id naming nobody, and an owner whose accounts have all been closed,
      // are the same sentence and the same fix to a reader.
      const data = await loader(args(get("/holdings?owner=999999999")));

      expect(data.unknownOwner).toBe(true);
      const markup = renderRoute(Holdings, "/holdings", data);
      // "There is no data yet" is a false claim here — the instance is full of
      // it — so this state goes through the panel's own empty note rather than
      // through `EmptyState`, which is the distinction `holdings.tsx` has
      // always drawn for a question with no answer.
      expect(markup).not.toContain("There is no data yet");
      expect(markup).toContain("no longer be read as");
      expect(markup).toContain(">2</span> holdings are recorded in all");
      // Two ways out, and the filter can be cleared from the screen it emptied.
      expect(markup).toContain('aria-label="Filter by owner"');
      expect(markup).toContain("Show everyone");
    }),
  );

  it(
    "says an owner holds nothing without sounding like an error, and keeps the control",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx);
      // Alice opens a second account and her first is closed out from under
      // her: she is still in the roster, and holds nothing.
      const empty = await ctx.seedAccount({ name: "Alice Cash", owner: alice, kind: "bank" });
      await ctx.seedPositionSet({ account: empty, asOf: "2026-02-28", holdings: [] });
      await ctx.db
        .updateTable("account")
        .set({ closed_at: new Date() })
        .where("name", "=", "Alice Brokerage")
        .execute();

      const data = await loader(args(get(`/holdings?owner=${alice.id}`)));

      expect(data.ownersHoldNothing).toBe(true);
      expect(data.unknownOwner).toBe(false);
      const markup = renderRoute(Holdings, "/holdings", data);
      expect(markup).not.toContain("There is no data yet");
      // Names her, because this is not an error and must not read as one.
      expect(markup).toContain("Alice holds nothing that has been recorded here");
      expect(markup).toContain('aria-label="Filter by owner"');
      expect(markup).toContain("Show everyone");
    }),
  );

  it(
    "draws no control at all for a household with one owner",
    withDatabase(async (ctx) => {
      await seedOnePosition(ctx);
      const data = await loader(args(get("/holdings")));

      // One name is not a choice, and a select with one option is furniture.
      expect(data.roster).toHaveLength(1);
      expect(renderRoute(Holdings, "/holdings", data)).not.toContain('aria-label="Filter by owner"');
    }),
  );
});

describe("correcting one row", () => {
  it(
    "refuses a correction whose address names no row, and writes nothing",
    withDatabase(async (ctx) => {
      const { account, instrument } = await seedOnePosition(ctx);

      // A POST with no `?edit=` is a mangled address rather than a bad figure:
      // there is no row to re-render a message beside, and no row to write to.
      // Guessing one here would restate whichever position the form's numbers
      // happened to fit.
      const response = await responseOf(() =>
        action(args(post("/holdings", { quantity: "1", costBasisPerShare: "" }))),
      );

      expect(response.status).toBe(400);
      expect((await currentPosition(account.id, instrument.id, ctx.db))?.quantity).toBe(
        "100.00000000",
      );
    }),
  );

  it(
    "rebuilds the redirect from the parsed query, so a write can only ever land on a Holdings view",
    withDatabase(async (ctx) => {
      const { owner, account, instrument, rowKey } = await seedOnePosition(ctx);

      // The address the editor posts back to is whatever the reader was looking
      // at, and that can carry anything a bookmark or a hand-edit put there.
      // The redirect is built by `toSearch` from the parsed query rather than
      // from the string that arrived, so the only search this can answer with
      // is one this screen already speaks.
      const destination = await redirectTo(() =>
        action(
          args(
            post(
              `/holdings?owner=${owner.id}&sort=bogus&dir=sideways&nonsense=1&edit=${rowKey}`,
              { quantity: "150", costBasisPerShare: "180" },
            ),
          ),
        ),
      );

      expect(destination).toBe(`/holdings?owner=${owner.id}&saved=${rowKey}`);

      // Following it proves both halves at once: the write landed, and the
      // confirmation quotes `currentHoldings` rather than the parameter — so
      // the sentence beside it can only describe what the account now holds.
      const confirmed = await loader(args(get(destination)));
      expect(confirmed.written).toMatchObject({
        key: rowKey,
        instrumentName: "Vanguard Total Stock Market",
        accountName: "Fidelity Taxable",
        quantity: "150.00000000",
      });
      expect(confirmed.editing).toBeNull();

      expect((await currentPosition(account.id, instrument.id, ctx.db))?.quantity).toBe(
        "150.00000000",
      );
    }),
  );
});
