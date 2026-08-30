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

import { action, loader } from "../../app/routes/holdings.tsx";
import { currentPosition } from "~/lib/positions.server";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
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
