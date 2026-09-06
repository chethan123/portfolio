// Holdings URL is the whole of that screen's state (§8.1). Table contents are holdings-view.test.ts's; this covers the
// route's use of it: the canonical bounce (a GET form submits all six selects, so ?owner=1&account=&institution=&… must
// redirect to something itself canonical, verified by feeding the target back into the loader, not just reading it),
// and the write's guard (which row a correction applies to comes from ?edit= alone — a POST naming none must refuse).
import { afterAll, describe, expect, it } from "vitest";

import Holdings, { action, loader } from "../../app/routes/holdings.tsx";
import { ALL_OWNERS } from "~/lib/owner-filter";
import { currentPosition } from "~/lib/positions.server";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { args, get, outcomeOf, ownerParam, post, redirectTo, responseOf } from "../support/routes.ts";

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
      // Second owner so ?owner= survives the loader's all-roster collapse.
      const other = await ctx.seedPerson({ name: "Bob" });
      await ctx.seedAccount({ name: "Bob Roth", owner: other, kind: "ira" });

      // What pressing Apply with one select touched puts in the address bar: seven params, six meaning "all".
      const submitted =
        `/holdings?owner=${owner.id}` +
        "&account=&institution=&kind=&tax=&classification=&assetClass=";

      const destination = await redirectTo(() => loader(args(get(submitted))));
      expect(destination).toBe(`/holdings?owner=${owner.id}`);

      // The real point: a bounce target disagreeing with toSearch is a redirect loop invisible to a test that only checks the first hop.
      const settled = await loader(args(get(destination)));
      expect(settled.view).toBe(`?owner=${owner.id}`);
    }),
  );

  it(
    "drops a sort by the column the grouping has already taken off the screen",
    withDatabase(async (ctx) => {
      await seedOnePosition(ctx);

      // sort=owner with the column removed by grouping would order by a heading with no caret, no aria-sort, no way to undo it.
      expect(await redirectTo(() => loader(args(get("/holdings?group=owner&sort=owner&dir=asc"))))).toBe(
        "/holdings?group=owner",
      );

      const fallen = await loader(args(get("/holdings?group=owner")));
      expect([fallen.sort, fallen.direction]).toEqual(["value", "desc"]);

      // Left exactly as asked when grouping doesn't hide the sort — a repair of one case, not a blanket reset.
      const kept = await loader(args(get("/holdings?group=owner&sort=quantity")));
      expect([kept.sort, kept.direction]).toEqual(["quantity", "desc"]);
    }),
  );

  it(
    "re-serialises the row parameters, and lets a receipt supersede an open editor",
    withDatabase(async (ctx) => {
      const { rowKey } = await seedOnePosition(ctx);

      // edit/saved are re-serialised from the parsed pair, not echoed — 0001.0002 names the same row as 1.2 and a spelling rowKey never produces can't survive.
      expect(await redirectTo(() => loader(args(get("/holdings?edit=0001.0002"))))).toBe("/holdings");

      // A receipt's row has just been closed, so edit and saved never share an address.
      expect(await redirectTo(() => loader(args(get(`/holdings?edit=${rowKey}&saved=${rowKey}`))))).toBe(
        `/holdings?saved=${rowKey}`,
      );

      const open = await loader(args(get(`/holdings?edit=${rowKey}`)));
      expect(open.editing).toBe(rowKey);
    }),
  );
});

// Three owners (not two) so a two-person selection is a real narrowing — with two, "both owners" is the household and
// the all-roster collapse would redirect it away. Each has one priced position; only Bob holds BND, so a dimension
// value can be present in the household and absent from a narrowed set (the facet rule).
async function seedTwoOwners(
  ctx: Pick<
    TestContext,
    "seedPerson" | "seedAccount" | "seedInstrument" | "seedPositionSet" | "seedQuote"
  >,
) {
  const alice = await ctx.seedPerson({ name: "Alice" });
  const bob = await ctx.seedPerson({ name: "Bob" });
  const carol = await ctx.seedPerson({ name: "Carol" });

  const vti = await ctx.seedInstrument({ symbol: "VTI", name: "Vanguard Total Stock Market" });
  const bnd = await ctx.seedInstrument({ symbol: "BND", name: "Vanguard Total Bond" });
  const vxus = await ctx.seedInstrument({ symbol: "VXUS", name: "Vanguard Total International" });
  await ctx.seedQuote({ instrument: vti, price: "250.0000" });
  await ctx.seedQuote({ instrument: bnd, price: "70.0000" });
  await ctx.seedQuote({ instrument: vxus, price: "60.0000" });

  const hers = await ctx.seedAccount({ name: "Alice Brokerage", owner: alice, kind: "brokerage" });
  const his = await ctx.seedAccount({ name: "Bob Roth", owner: bob, kind: "ira" });
  const theirs = await ctx.seedAccount({ name: "Carol Bank", owner: carol, kind: "bank" });

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
  await ctx.seedPositionSet({
    account: theirs,
    asOf: "2026-01-31",
    holdings: [{ instrument: vxus, quantity: "10.00000000" }],
  });

  return { alice, bob, carol, hers, his, theirs };
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

      // Two of three, a real narrowing — the figures below must differ or this'd pass against a screen ignoring the filter.
      const two = await at(`?${ownerParam(alice.id, bob.id)}`);
      expect(two.rows).toHaveLength(2);
      expect(two.total.value).toBe("27800.0000");

      expect((await at("")).total.value).toBe("28400.0000");
    }),
  );

  it(
    "says it is filtered when nothing but the owner filter is on",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx);

      // Reproducing case: filtered used to count query.filters, zero for an owner-only narrowing — an unmarked filtered table looks like the whole portfolio.
      const data = await loader(args(get(`/holdings?owner=${alice.id}`)));

      expect(data.active).toEqual([]);
      expect(data.totalHoldings).toBe(3); // the household's N, not the narrowed set's

      const markup = renderRoute(Holdings, "/holdings", data);
      expect(markup).toContain("filtered from 3");
      expect(markup).toContain("Showing <b>Alice</b> only.");
    }),
  );

  it(
    "builds the filter selects from every holding, not from the owner's",
    withDatabase(async (ctx) => {
      const { alice, hers, his, theirs } = await seedTwoOwners(ctx);

      // Bob's/Carol's accounts must stay on offer while narrowed to Alice, or there's no way to widen again.
      const data = await loader(args(get(`/holdings?owner=${alice.id}`)));
      const accounts = data.filters.find((filter) => filter.id === "account");

      expect(accounts?.options.map((option) => option.value)).toEqual([
        String(hers.id),
        String(his.id),
        String(theirs.id),
      ]);
    }),
  );

  it(
    "keeps the owner filter on every link and control this screen draws",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx);
      const filtered = `?owner=${alice.id}`;
      const data = await loader(args(get(`/holdings${filtered}&group=kind&sort=quantity`)));

      expect(data.view).toBe(`${filtered}&group=kind&sort=quantity`); // canonical view every control builds from

      const markup = renderRoute(Holdings, "/holdings", data);
      expect(markup).toContain(
        `href="/holdings?owner=${alice.id}&amp;group=kind&amp;sort=asset&amp;dir=asc"`,
      );
      expect(markup).toContain(`href="/holdings?owner=${alice.id}&amp;sort=quantity"`);
      expect(markup).toContain(`type="hidden" name="owner" value="${alice.id}"`);
      expect(markup).toContain('href="/holdings?group=kind&amp;sort=quantity"'); // Show everyone: the one link that should drop it
    }),
  );

  it(
    "leaves the owner filter alone when this screen's own filters are cleared",
    withDatabase(async (ctx) => {
      const { alice, hers } = await seedTwoOwners(ctx);
      const search = `?owner=${alice.id}&account=${hers.id}`;
      const data = await loader(args(get(`/holdings${search}`)));

      // Clear filters is screen-local; owner is household-wide — clearing from here would change what Overview shows next.
      const markup = renderRoute(Holdings, "/holdings", data);
      expect(markup).toContain(`href="/holdings?owner=${alice.id}"`);
      expect(markup).not.toContain('href="/holdings"');
    }),
  );

  it(
    "still groups by owner, still drops the column, and does it under a filter naming two",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx);
      const both = ownerParam(alice.id, bob.id);
      const data = await loader(args(get(`/holdings?${both}&group=owner`)));

      expect(data.groups?.map((group) => group.label)).toEqual(["Alice", "Bob"]); // two, not three — Carol is out of this view

      const markup = renderRoute(Holdings, "/holdings", data);
      // Asserted on the sort link, not the word "owner" — the legend also carries that word.
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

      // No hidden field carries it — the form posts back to the address that opened it.
      expect(destination).toBe(`/holdings?owner=${alice.id}&saved=${key}`);
    }),
  );

  it(
    "collapses a selection naming everybody back to the household's own URL",
    withDatabase(async (ctx) => {
      const { alice, bob, carol } = await seedTwoOwners(ctx);

      // ADR-0008: every owner selected = none selected — a checkbox <Form> can't decline to submit, so this bounces.
      expect(
        await redirectTo(() =>
          loader(args(get(`/holdings?${ownerParam(alice.id, bob.id, carol.id)}&group=kind`))),
        ),
      ).toBe("/holdings?group=kind");

      const two = await loader(args(get(`/holdings?${ownerParam(alice.id, bob.id)}`)));
      expect(two.owners).toHaveLength(2);
    }),
  );

  it(
    "keeps a receipt across the everyone collapse, where its own canonical bounce already does",
    withDatabase(async (ctx) => {
      const { alice, bob, carol, hers } = await seedTwoOwners(ctx);
      const narrowed = await loader(args(get(`/holdings?owner=${alice.id}`)));
      const row = narrowed.rows?.[0];
      const key = `${hers.id}.${row?.instrumentId ?? ""}`;

      // Ticking every owner box used to spell a different bounce than the one saved= already keeps — one speller now closes that gap.
      const destination = await redirectTo(() =>
        loader(args(get(`/holdings?${ownerParam(alice.id, bob.id, carol.id)}&saved=${key}`))),
      );
      expect(destination).toBe(`/holdings?saved=${key}`);

      // written is looked up household-wide, so the receipt survives the collapse to the unfiltered view.
      const settled = await loader(args(get(destination)));
      expect(settled.written?.key).toBe(key);
    }),
  );

  it(
    "names whose portfolio is empty when a dimension filter is on as well",
    withDatabase(async (ctx) => {
      const { alice, his } = await seedTwoOwners(ctx);

      // Bob's account is offered while narrowed to Alice — choosing it must say Alice holds nothing there, not that the portfolio does.
      const data = await loader(args(get(`/holdings?owner=${alice.id}&account=${his.id}`)));
      const markup = renderRoute(Holdings, "/holdings", data);

      expect(markup).toContain("Alice holds nothing in Bob Roth");
      expect(markup).not.toContain("Nothing in the portfolio is in Bob Roth");
    }),
  );
});

describe("the number tail beside an account", () => {
  it(
    "rides in the account cell hidden from a reader, and rides the filter's option as plain text",
    withDatabase(async (ctx) => {
      const owner = await ctx.seedPerson({ name: "Alice" });
      const usd = await ctx.usdInstrument();

      // Two accounts, or the account filter isn't offered; free-form number — tail is the last four characters.
      const numbered = await ctx.seedAccount({
        name: "Fidelity Taxable",
        institution: "Fidelity",
        owner,
        externalAccountNumber: "X47-283910",
      });
      const bare = await ctx.seedAccount({
        name: "Checking",
        institution: "Chase",
        owner,
        kind: "bank",
      });

      await ctx.seedPositionSet({
        account: numbered,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "3000.00000000" }],
      });
      await ctx.seedPositionSet({
        account: bare,
        asOf: "2026-01-31",
        holdings: [{ instrument: usd, quantity: "1000.00000000" }],
      });

      const data = await loader(args(get("/holdings")));
      const markup = renderRoute(Holdings, "/holdings", data);

      expect(markup).toContain('<span class="number-tail" aria-hidden="true">····3910</span>');
      expect(markup).toContain('<span class="visually-hidden">ending in 3910</span>');

      expect(markup).toContain("Fidelity Taxable ····3910 · Fidelity"); // <option> holds no markup, tail rides in the label

      expect(markup).toContain("Checking · Chase"); // no recorded number, no dots standing in for one
      expect(markup).not.toContain("Checking ····");
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
    "says who it is showing on the closed control, without growing with the household",
    withDatabase(async (ctx) => {
      const { alice, bob, carol } = await seedTwoOwners(ctx);

      // A disclosure control: the summary must say enough that a filter set two screens ago is legible unopened.
      const everyone = renderRoute(
        Holdings,
        "/holdings",
        await loader(args(get("/holdings"))),
      );
      expect(everyone).toContain("<details");
      expect(everyone).toContain("Everyone");
      expect(everyone).toContain("<summary>"); // nothing applied, so unmarked — asserted on the tag since aria-current appears elsewhere too

      const one = renderRoute(
        Holdings,
        "/holdings",
        await loader(args(get(`/holdings?owner=${alice.id}`))),
      );
      expect(one).toContain("Alice");
      expect(one).toContain('<summary aria-current="true">');

      const two = renderRoute(
        Holdings,
        "/holdings",
        await loader(args(get(`/holdings?${ownerParam(alice.id, bob.id)}`))),
      );
      expect(two).toContain("Alice and Bob");

      // Past two, a count — spelling out names again is what the checkboxes already show. Fourth owner so three doesn't collapse to "everyone".
      const dana = await ctx.seedPerson({ name: "Dana" });
      await ctx.seedAccount({ name: "Dana Bank", owner: dana, kind: "bank" });

      const three = renderRoute(
        Holdings,
        "/holdings",
        await loader(args(get(`/holdings?${ownerParam(alice.id, bob.id, carol.id)}`))),
      );
      expect(three).toContain("3 of 4");
      expect(three).not.toContain("Alice and Bob and Carol");
    }),
  );

  it(
    "says the filter names an owner it cannot read as, and keeps the control on screen",
    withDatabase(async (ctx) => {
      await seedTwoOwners(ctx);

      const data = await loader(args(get("/holdings?owner=999999999")));

      expect(data.unknownOwner).toBe(true);
      const markup = renderRoute(Holdings, "/holdings", data);
      // "There is no data yet" is false here — goes through the panel's own empty note, not EmptyState, for a question with no answer.
      expect(markup).not.toContain("There is no data yet");
      expect(markup).toContain("no longer be read as");
      expect(markup).toContain(">3</span> holdings are recorded in all");
      expect(markup).toContain('aria-label="Filter by owner"');
      expect(markup).toContain("Show everyone");
    }),
  );

  it(
    "says an owner holds nothing without sounding like an error, and keeps the control",
    withDatabase(async (ctx) => {
      const { alice } = await seedTwoOwners(ctx);
      // Alice's first account is closed and her new one is empty — still in the roster, holds nothing.
      const empty = await ctx.seedAccount({ name: "Alice Cash", owner: alice, kind: "bank" });
      await ctx.seedPositionSet({ account: empty, asOf: "2026-02-28", holdings: [] });
      await ctx.db
        .updateTable("account")
        .set({ closed_at: new Date() })
        .where("name", "=", "Alice Brokerage")
        .execute();

      const data = await loader(args(get(`/holdings?owner=${alice.id}`)));

      expect(data.narrowedToNothing).toBe(true);
      expect(data.unknownOwner).toBe(false);
      const markup = renderRoute(Holdings, "/holdings", data);
      expect(markup).not.toContain("There is no data yet");
      expect(markup).toContain("Alice holds nothing that has been recorded here"); // named, not read as an error
      expect(markup).toContain('aria-label="Filter by owner"');
      expect(markup).toContain("Show everyone");
    }),
  );

  it(
    "draws no control at all for a household with one owner",
    withDatabase(async (ctx) => {
      await seedOnePosition(ctx);
      const data = await loader(args(get("/holdings")));

      expect(data.roster).toHaveLength(1); // one name is not a choice
      expect(renderRoute(Holdings, "/holdings", data)).not.toContain('aria-label="Filter by owner"');
    }),
  );
});

describe("the canonical bounce, through a real URL", () => {
  // Asserted through new Request (every URL re-encoding in the picture), unlike holdings-view.test.ts's toSearch-is-a-fixed-point-
  // of-itself check — weaker, blind to the URL parser and form-urlencoded serialiser each respelling what the other leaves bare.
  const settles = async (search: string): Promise<void> => {
    const first = await outcomeOf(() => loader(args(get(`/holdings${search}`))));
    if (!(first instanceof Response)) return;

    const target = first.headers.get("Location") ?? "";
    const second = await outcomeOf(() => loader(args(get(target))));

    expect({ search, redirectedAgain: second instanceof Response }).toEqual({
      search,
      redirectedAgain: false,
    });
  };

  it(
    "settles in at most one hop, whatever spelled the address",
    withDatabase(async (ctx) => {
      const { alice, bob } = await seedTwoOwners(ctx);
      const both = [alice.id, bob.id].sort((a, b) => Number(a) - Number(b)).join(",");

      // Must bounce to the real canonical spelling — the repeated key, never the comma (owner-filter.ts's toOwnerParam says why).
      expect(
        await redirectTo(() => loader(args(get(`/holdings?owner=${both.replace(",", "%2C")}`)))),
      ).toBe(`/holdings?${ownerParam(alice.id, bob.id)}`);

      // Owner-only spellings (ownerReading's default grammar) are owner-reading.test.ts's to cover once for all screens;
      // what stays here proves this screen's own grammar: untouched selects, grouping before owner, this screen's row params.
      for (const search of [
        `?owner=${alice.id}&account=&institution=&kind=&tax=&classification=&assetClass=`,
        `?group=kind&owner=${alice.id}`,
        `?owner=${alice.id}&sort=quantity&dir=asc&edit=1.2`,
        // Two owners, not one — this screen's grammar (grouping/row params alongside owner) never had a multi-owner chain
        // followed past its first hop. Comma-spelled: the legacy input readOwnerFilter reads, respelled by get()'s server-runtime rebuild before the loader sees it.
        `?owner=${both}`,
        `?group=kind&owner=${both}`,
      ]) {
        await settles(search);
      }
    }),
  );
});

describe("correcting one row", () => {
  it(
    "refuses a correction whose address names no row, and writes nothing",
    withDatabase(async (ctx) => {
      const { account, instrument } = await seedOnePosition(ctx);

      // A POST with no ?edit= is a mangled address, not a bad figure — no row to re-render beside or write to; guessing one would restate whatever the numbers fit.
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
      // Second owner so naming one is a real narrowing, not the household under another name (which the loader would collapse).
      const other = await ctx.seedPerson({ name: "Bob" });
      await ctx.seedAccount({ name: "Bob Roth", owner: other, kind: "ira" });

      // Redirect is built by toSearch from the parsed query, not the arriving string — the only search it can answer with is one this screen already speaks.
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

      // Following it proves both halves: the write landed, and the confirmation quotes currentHoldings(ALL_OWNERS), not the posted parameter.
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
