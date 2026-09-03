/**
 * The Holdings URL, which is the whole of that screen's state (§8.1). What
 * the table *contains* is `holdings-view.test.ts`'s; what lives only here
 * is the route's use of it: the canonical bounce, the two row parameters
 * kept outside `HoldingsQuery`, and the one write. The bounce is why this
 * file exists — a GET form submits the six selects nobody touched, so the
 * arriving address is `?owner=1&account=&institution=&…` and the loader
 * redirects it before drawing anything; a target not itself canonical is
 * the app's busiest table answering every request with another redirect
 * until the browser gives up, so the target is fed straight back into the
 * loader rather than merely read. The write's guard is the same idea: which
 * row a correction applies to comes from `?edit=` and nowhere else, so a
 * POST naming no row must refuse rather than choose one.
 */
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
      // As above: a second owner, so `?owner=` survives the loader's collapse
      // of a selection that names everybody.
      const other = await ctx.seedPerson({ name: "Bob" });
      await ctx.seedAccount({ name: "Bob Roth", owner: other, kind: "ira" });

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
 * Three owners, one priced position each, and an instrument only Bob holds —
 * so a dimension value can be present in the household and absent from the
 * narrowed set, which is what the facet rule is about.
 *
 * Three rather than two, so that a selection naming two people is a real
 * narrowing. With two, "both owners" *is* the household: every assertion about
 * a multi-owner filter would pass against a screen that ignored the filter
 * entirely, and the all-roster collapse would redirect it away besides.
 */
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

      // Two of three, so this is a narrowing and not the household spelled a
      // second way — and the two figures below have to differ, or the
      // assertion would pass against a screen ignoring the filter.
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

      // The reproducing case. `filtered` used to count `query.filters`, which
      // is now zero for an owner-only narrowing — and without the notice a
      // filtered table looks like the whole portfolio to anyone who did not
      // set the filter, including you a day later following your own bookmark.
      const data = await loader(args(get(`/holdings?owner=${alice.id}`)));

      expect(data.active).toEqual([]);
      // N is the household's, not the narrowed set's: the same number has to
      // mean one thing whichever control you touched.
      expect(data.totalHoldings).toBe(3);

      const markup = renderRoute(Holdings, "/holdings", data);
      expect(markup).toContain("filtered from 3");
      expect(markup).toContain("Showing <b>Alice</b> only.");
    }),
  );

  it(
    "builds the filter selects from every holding, not from the owner's",
    withDatabase(async (ctx) => {
      const { alice, hers, his, theirs } = await seedTwoOwners(ctx);

      // Bob's and Carol's accounts have to stay on offer while the table is
      // narrowed to Alice: options that vanished as you narrowed would leave
      // no way to widen again.
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
      const both = ownerParam(alice.id, bob.id);
      const data = await loader(args(get(`/holdings?${both}&group=owner`)));

      // Two groups, not three: Carol is in the household and out of this view.
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

  it(
    "collapses a selection naming everybody back to the household's own URL",
    withDatabase(async (ctx) => {
      const { alice, bob, carol } = await seedTwoOwners(ctx);

      // ADR-0008: selecting every owner is spelled the same as selecting none.
      // A `<Form method="get">` of checkboxes cannot decline to submit, so
      // ticking all three arrives here and is bounced — one view, one URL.
      expect(
        await redirectTo(() =>
          loader(args(get(`/holdings?${ownerParam(alice.id, bob.id, carol.id)}&group=kind`))),
        ),
      ).toBe("/holdings?group=kind");

      // Two of three is a real narrowing and stays.
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

      // Ticking every owner box after correcting a row used to spell a
      // different bounce than the one the row's own edit already keeps
      // `saved` through — one speller for both closes that gap.
      const destination = await redirectTo(() =>
        loader(args(get(`/holdings?${ownerParam(alice.id, bob.id, carol.id)}&saved=${key}`))),
      );
      expect(destination).toBe(`/holdings?saved=${key}`);

      // And the receipt still renders: `written` is looked up in the whole
      // household, so it survives the collapse to the unfiltered view.
      const settled = await loader(args(get(destination)));
      expect(settled.written?.key).toBe(key);
    }),
  );

  it(
    "names whose portfolio is empty when a dimension filter is on as well",
    withDatabase(async (ctx) => {
      const { alice, his } = await seedTwoOwners(ctx);

      // The selects are built from every holding, so Bob's account is on offer
      // while the table is narrowed to Alice. Choosing it must not produce
      // "nothing in the portfolio is in Bob Roth" — the portfolio holds
      // something there; this reading does not.
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

      // Two accounts, or the account filter is not offered at all; free-form
      // number, as the column is — the tail is its last four *characters*.
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

      // The cell: the dots are decoration a screen reader skips, and the same
      // fact is said as words instead.
      expect(markup).toContain('<span class="number-tail" aria-hidden="true">····3910</span>');
      expect(markup).toContain('<span class="visually-hidden">ending in 3910</span>');

      // An <option> holds no markup, so the tail rides in the label itself.
      expect(markup).toContain("Fidelity Taxable ····3910 · Fidelity");

      // An account with no recorded number keeps its bare name — no dots
      // standing in for a number nobody recorded, in cell or option alike.
      expect(markup).toContain("Checking · Chase");
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

      // The control is a disclosure: what the header spends is one summary
      // whatever the household's size, and the summary has to say enough that a
      // filter set two screens ago is legible without opening it.
      const everyone = renderRoute(
        Holdings,
        "/holdings",
        await loader(args(get("/holdings"))),
      );
      expect(everyone).toContain("<details");
      expect(everyone).toContain("Everyone");
      // Nothing applied, so the summary itself is not marked as set — the page
      // has other `aria-current` of its own, so this asserts on the tag.
      expect(everyone).toContain("<summary>");

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

      // Past two it is a count, because four names spelled out would put the
      // header back where the row of checkboxes left it. A fourth owner, so the
      // selection of three is not the whole household and does not collapse.
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
      expect(markup).toContain(">3</span> holdings are recorded in all");
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

      expect(data.narrowedToNothing).toBe(true);
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

describe("the canonical bounce, through a real URL", () => {
  /**
   * The invariant the loader depends on, asserted the way the loader meets
   * it: through `new Request`, so every re-encoding of URL parsing is in
   * the picture. `holdings-view.test.ts` checks `toSearch` is a fixed point
   * of *itself* — weaker, and blind to exactly this: the URL parser and the
   * form-urlencoded serialiser each respell characters the other leaves
   * bare, and a request reaches a loader through both, so an address could
   * differ from its canonical spelling forever and the busiest table would
   * redirect until the browser gave up.
   */
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

      // Not only settling: the percent-encoded separator must actually bounce
      // to this application's real canonical spelling — the repeated key,
      // never the comma this test once expected back (`owner-filter.ts`'s
      // `toOwnerParam` doc says why that spelling stopped being canonical). A
      // comparison blind to encoding settles this pair perfectly while
      // quietly keeping two URLs for one view.
      expect(
        await redirectTo(() => loader(args(get(`/holdings?owner=${both.replace(",", "%2C")}`)))),
      ).toBe(`/holdings?${ownerParam(alice.id, bob.id)}`);

      // The owner-only spellings — reversed ids, the encoded separator, the
      // apostrophe, a space either way, a repeated parameter, the bare
      // filter — are the default grammar `ownerReading` speaks on every
      // screen, and `tests/owner-reading.test.ts` follows that chain once for
      // all four rather than here per screen. What stays here is what proves
      // *this* screen's own grammar: a GET form's untouched selects, grouping
      // before the owner parameter, and the row parameters this screen alone
      // carries.
      for (const search of [
        `?owner=${alice.id}&account=&institution=&kind=&tax=&classification=&assetClass=`,
        `?group=kind&owner=${alice.id}`,
        `?owner=${alice.id}&sort=quantity&dir=asc&edit=1.2`,
        // Two owners, not one: every other case above stops at a single id,
        // so this screen's own grammar — grouping and the row parameters
        // alongside `owner` — had never actually had a multi-owner chain
        // followed past its first hop. Comma-spelled on purpose: that is the
        // legacy input `readOwnerFilter` still reads, and it is `get`'s own
        // rebuild through the server runtime (`tests/support/routes.ts`),
        // not a client, that respells it before this loader ever sees it.
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
      // A second person owning a second account, so that naming one owner is a
      // narrowing rather than the household under another name — which the
      // loader would collapse back to `/holdings` before this could assert on
      // it. Nothing of theirs is held, which is enough.
      const other = await ctx.seedPerson({ name: "Bob" });
      await ctx.seedAccount({ name: "Bob Roth", owner: other, kind: "ira" });

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
      // confirmation quotes `currentHoldings(ALL_OWNERS)` rather than the parameter — so
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
