import { afterAll, describe, expect, it } from "vitest";

import Account, { loader as accountLoader } from "../app/routes/account.tsx";
import Review, { loader as reviewLoader } from "../app/routes/upload/review.tsx";
import { commitUpload, rememberMapping } from "~/lib/uploads.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";
import { renderRoute } from "./support/render.tsx";
import { args, get } from "./support/routes.ts";

import type { StatementMapping } from "~/lib/statement";
import type { TestContext } from "./support/database.ts";

/**
 * The two sentences `ING-1` is about, read off the rendered page.
 *
 * These exist because the finding *is* a rendering one: a statement filed
 * behind was written, it silently moved the net-worth chart, and no screen said
 * so. A query answering correctly does not prove a sentence appeared, and every
 * other test of this change is function-level — deleting both sentences from
 * the JSX left the whole suite green.
 *
 * The loader is the real one, run against the real database, and its output is
 * handed straight to the real component. That is deliberate: a hand-built
 * `loaderData` fixture would be a second copy of the loader's shape, free to
 * drift from it, and the drift would look like a passing test.
 *
 * `createRoutesStub` supplies the router context the components need for
 * `Form` and `Link`.
 */
afterAll(closeTestDatabase);

const MAPPING: StatementMapping = {
  headerRow: 0,
  delimiter: ",",
  columns: { instrument: "Symbol", quantity: "Quantity", asOf: "As of" },
  costBasisIs: "per_share",
  owedAsPositive: false,
  combineDuplicateRows: true,
};

/**
 * An account reading a June statement of three positions, plus a staged draft
 * holding only one of them — a majority removal by the ratio, whatever date it
 * eventually carries.
 */
async function anAccountReadingJune(ctx: TestContext, fileDate: string | null) {
  const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet, seedUploadDraft } =
    ctx;
  const account = await seedAccount({ kind: "brokerage", name: "Fidelity Taxable" });
  const kept = await seedInstrument({ symbol: "RN1", name: "Kept Fund" });
  const goneA = await seedInstrument({ symbol: "RN2", name: "Gone Fund A" });
  const goneB = await seedInstrument({ symbol: "RN3", name: "Gone Fund B" });
  for (const [instrument, raw] of [
    [kept, "RN1"],
    [goneA, "RN2"],
    [goneB, "RN3"],
  ] as const) {
    await seedInstrumentAlias({ instrument, rawString: raw });
  }

  await seedPositionSet({
    account,
    asOf: "2026-06-30",
    holdings: [
      { instrument: kept, quantity: "10" },
      { instrument: goneA, quantity: "5" },
      { instrument: goneB, quantity: "2" },
    ],
  });

  const csv =
    fileDate === null
      ? "Symbol,Quantity\nRN1,7\n"
      : `Symbol,Quantity,As of\nRN1,7,${fileDate}\n`;
  const columns =
    fileDate === null ? { instrument: "Symbol", quantity: "Quantity" } : MAPPING.columns;

  const draft = await seedUploadDraft({
    account,
    filename: "Positions.csv",
    bytes: new TextEncoder().encode(csv),
  });
  await rememberMapping(draft.id, { ...MAPPING, columns }, db);

  return { account, draft };
}

const reviewMarkup = async (draftId: string): Promise<string> => {
  const data = await reviewLoader(args(get(`/upload/${draftId}/review`), { draftId }));
  if (data instanceof Response) throw new Error("expected the review screen, got a redirect");
  return renderRoute(Review, "/upload/:draftId/review", data);
};

describe("the review screen, for a statement filed behind", () => {
  it(
    "says so, and does not ask for a tick that confirms nothing",
    withDatabase(async (ctx) => {
      const { draft } = await anAccountReadingJune(ctx, "2026-03-31");

      const markup = await reviewMarkup(draft.id);

      expect(markup).toContain("earlier than the statement");
      expect(markup).toContain("nothing listed as removed will be removed");
      // The tick is what the finding is about at this end: it was demanded for
      // a removal that cannot happen.
      expect(markup).not.toContain('name="confirmRemovals"');
    }),
  );

  it(
    "still asks for the tick on an ordinary forward-dated majority removal",
    withDatabase(async (ctx) => {
      // The other half. Without this, suppressing the tick unconditionally
      // would pass the test above.
      const { draft } = await anAccountReadingJune(ctx, "2026-07-31");

      const markup = await reviewMarkup(draft.id);

      expect(markup).toContain('name="confirmRemovals"');
      expect(markup).toContain("removes");
      expect(markup).not.toContain("earlier than the statement");
    }),
  );

  it(
    "confirms a filed-behind write without claiming the account now holds it",
    withDatabase(async (ctx) => {
      const { account, draft } = await anAccountReadingJune(ctx, "2026-03-31");
      const written = await commitUpload(draft.id, { accountId: account.id }, ctx.db);

      const data = await accountLoader(
        args(get(`/accounts/${account.id}?uploaded=${written.setId}`), {
          accountId: account.id,
        }),
      );
      const markup = renderRoute(Account, "/accounts/:accountId", data);

      // The sentence the finding says never appeared at all.
      expect(markup).toContain("Recorded");
      expect(markup).toContain("earlier than the statement");
      expect(markup).toContain("into its history");
      // And not the closing clause, which would be a true count under a false
      // claim: the account is reading June, not this.
      expect(markup).not.toContain("now holds");
    }),
  );

  it(
    "keeps the ordinary closing clause for a statement the account does read",
    withDatabase(async (ctx) => {
      const { account, draft } = await anAccountReadingJune(ctx, "2026-07-31");
      const written = await commitUpload(
        draft.id,
        { accountId: account.id, confirmRemovals: "true" },
        ctx.db,
      );

      const data = await accountLoader(
        args(get(`/accounts/${account.id}?uploaded=${written.setId}`), {
          accountId: account.id,
        }),
      );
      const markup = renderRoute(Account, "/accounts/:accountId", data);

      expect(markup).toContain("now holds");
      expect(markup).not.toContain("into its history");
    }),
  );
});
