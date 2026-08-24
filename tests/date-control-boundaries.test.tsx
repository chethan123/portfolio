import { afterAll, describe, expect, it } from "vitest";

import Account, { loader as accountLoader } from "../app/routes/account.tsx";
import Review, { loader as reviewLoader } from "../app/routes/upload/review.tsx";
import { rememberMapping } from "~/lib/uploads.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";
import { renderRoute } from "./support/render.tsx";
import { args, get } from "./support/routes.ts";

/**
 * The two date controls carry the boundaries the validator refuses by.
 *
 * The rule is stated once and read twice — a picker offering a date the write
 * then rejects, or hiding one it would accept, is the drift this exists to
 * catch. Asserting the loader fields is not enough: both `min` and `max` could
 * be deleted from the markup with every loader test still passing, which is
 * exactly what happened before this file existed.
 *
 * Rendered from the real loader's output, not a fixture — see `renderRoute`.
 */
afterAll(closeTestDatabase);

const FLOOR = 'min="1970-01-01"';
const ANY_CEILING = /max="\d{4}-\d{2}-\d{2}"/;

describe("the set-balance date control", () => {
  it(
    "carries the floor and the ceiling",
    withDatabase(async ({ seedAccount }) => {
      // A bank account, because the panel is drawn only for a kind whose whole
      // balance is one typed number.
      const account = await seedAccount({ kind: "bank", name: "Everyday Current" });

      const markup = renderRoute(
        Account,
        "/accounts/:accountId",
        await accountLoader(args(get(`/accounts/${account.id}`), { accountId: account.id })),
      );

      expect(markup).toContain('name="asOf"');
      expect(markup).toContain(FLOOR);
      expect(markup).toMatch(ANY_CEILING);
    }),
  );
});

describe("the review screen's statement-date control", () => {
  it(
    "carries the floor and the ceiling when the file does not date itself",
    withDatabase(async (ctx) => {
      // Only rendered on this branch: a file that dates itself gets a stated
      // date and no editor, because overriding a fact with an opinion is not
      // what the control is for.
      const account = await ctx.seedAccount({ kind: "brokerage" });
      const fund = await ctx.seedInstrument({ symbol: "DCB", name: "Boundary Fund" });
      await ctx.seedInstrumentAlias({ instrument: fund, rawString: "DCB" });

      const draft = await ctx.seedUploadDraft({
        account,
        filename: "Positions.csv",
        bytes: new TextEncoder().encode("Symbol,Quantity\nDCB,4\n"),
      });
      await rememberMapping(
        draft.id,
        {
          headerRow: 0,
          delimiter: ",",
          columns: { instrument: "Symbol", quantity: "Quantity" },
          costBasisIs: "per_share",
          owedAsPositive: false,
          combineDuplicateRows: true,
        },
        ctx.db,
      );

      const data = await reviewLoader(
        args(get(`/upload/${draft.id}/review`), { draftId: draft.id }),
      );
      if (data instanceof Response) throw new Error("expected the review screen, got a redirect");
      const markup = renderRoute(Review, "/upload/:draftId/review", data);

      expect(markup).toContain('type="date"');
      expect(markup).toContain(FLOOR);
      expect(markup).toMatch(ANY_CEILING);
    }),
  );
});
