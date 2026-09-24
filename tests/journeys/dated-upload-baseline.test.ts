// Reproduces #181: an upload dated behind the account's current statement lands without anyone
// noticing. Review's diff, the commit, and the account page each read a different "now" — no
// single unit test sees all three disagree at once, which is why this is a journey. Rewritten:
// the fix refuses the first submit rather than silently no-opping or saying nothing, so the
// four-part assertion below is what "fixed" actually means, not the `landed || told` disjunction
// the original repro settled for.
import { afterAll, describe, expect, it } from "vitest";

import { ALL_OWNERS } from "~/lib/owner-filter";
import { revisePosition } from "~/lib/positions.server";
import { sectionKey } from "~/lib/review-form";
import {
  RefusedUpload,
  recordUpload,
  rememberMapping,
  reviewForDraft,
} from "~/lib/uploads.server";
import { accountHoldings, holdingsAt } from "~/lib/valuation.server";

import { loader as accountPage } from "../../app/routes/account.tsx";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { args, get } from "../support/routes.ts";
import { onlyRecorded, onlySection, posted } from "../support/review.ts";

import type { StatementMapping } from "~/lib/statement";
import type { SeededAccount } from "../support/fixtures.ts";
import type { TestContext } from "../support/database.ts";

afterAll(closeTestDatabase);

const encode = (text: string) => new TextEncoder().encode(text);

const BASE_MAPPING: StatementMapping = {
  headerRow: 0,
  delimiter: ",",
  columns: { instrument: "Symbol", quantity: "Quantity", costBasis: "Basis" },
  costBasisIs: "per_share",
  owedAsPositive: false,
  combineDuplicateRows: true,
};

/** Stages a review-ready draft: bytes + saved mapping (commit-upload.test.ts's `stage`, copied). */
async function stage(
  { db, seedUploadDraft }: Pick<TestContext, "db" | "seedUploadDraft">,
  account: SeededAccount,
  csv: string,
): Promise<string> {
  const draft = await seedUploadDraft({
    account,
    filename: "Statement.csv",
    bytes: encode(csv),
  });

  const outcome = await rememberMapping(draft.id, BASE_MAPPING, db);
  if ("problems" in outcome) {
    throw new Error(
      "This fixture's mapping does not parse its own file: " +
        outcome.problems.map((problem) => problem.message).join(" "),
    );
  }

  return draft.id;
}

describe("an upload dated behind the account's current statement", () => {
  it(
    "refuses the first submit naming both dates, then records the statement as history once confirmed, agreeing with the receipt",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });

      const rpxa = await seedInstrument({ symbol: "RPXA", name: "RPX Fund A" });
      const rpxb = await seedInstrument({ symbol: "RPXB", name: "RPX Fund B" });
      await seedInstrumentAlias({ instrument: rpxa, rawString: "RPXA" });

      // A statement dated 2026-08-31, holding both funds.
      await seedPositionSet({
        account,
        asOf: "2026-08-31",
        holdings: [
          { instrument: rpxa, quantity: "100" },
          { instrument: rpxb, quantity: "200" },
        ],
      });

      // Corrects RPXA to 150 — effectiveDate (positions.server.ts:289-293) dates this today,
      // never behind the statement it corrects, so it now sits ahead of 2026-08-31.
      const corrected = await revisePosition(
        account.id,
        rpxa.id,
        { quantity: "150", costBasisPerShare: "" },
        db,
      );
      expect(corrected.asOf).not.toBe("2026-08-31");

      // A second statement, also dated 2026-08-31 — now behind the correction above. This is the
      // exact shape #181 reports: an upload whose as_of_date lands behind the current set.
      const draftId = await stage(ctx, account, "Symbol,Quantity,Basis\nRPXA,100,\n");

      // 1. The first submit is refused, and the message names both dates — the statement's own
      // and what the account's correction made current.
      const reviewed = await reviewForDraft(draftId, "2026-08-31", db);
      let refusal: RefusedUpload;
      try {
        await recordUpload(draftId, posted(reviewed, { asOf: "2026-08-31" }), db);
        throw new Error("Expected the first submit to be refused, and it was not.");
      } catch (error) {
        if (!(error instanceof RefusedUpload)) throw error;
        refusal = error;
      }
      expect(refusal.fieldErrors.form).toMatch(/2026-08-31/);
      expect(refusal.fieldErrors.form).toMatch(new RegExp(corrected.asOf));
      // Reason 2 (filed behind) subsumes reason 1 (stale baseline) here: this is the ordinary
      // first submit of a backdated, undated file, and nothing was ticked yet to go stale.
      expect(refusal.fieldErrors.form).not.toMatch(/recorded history changed/);

      // 2. A second submit, carrying the refusal's own baselineSetId and its confirmation, lands.
      const refusedSection = onlySection(refusal.diff);
      const committed = onlyRecorded(await recordUpload(
        draftId,
        posted(refusal.diff, {
          asOf: "2026-08-31",
          [sectionKey("confirmFiledBehind", account.id)]: "true",
        }),
        db,
      ));

      // 3. receipt.counts equals the counts of the diff the refusal carried — the three-way
      // agreement between Review, the commit and the receipt this ticket exists to establish.
      const page = await accountPage(
        args(get(`/accounts/${account.id}?uploaded=${committed.setId}`), { accountId: account.id }),
      );
      expect(page.receipt?.counts).toEqual({
        added: refusedSection.added.length,
        updated: refusedSection.updated.length,
        unchanged: refusedSection.unchangedCount,
        removed: refusedSection.removed.length,
      });
      // Freshly committed and already filed behind — the receipt gate must say so from the start.
      expect(page.receipt?.isCurrent).toBe(false);

      // 4. accountHoldings is unchanged — the correction is still what the account reports today,
      // because the backdated statement sits behind it — and holdingsAt the statement's own date
      // shows the statement, proving it became history rather than nothing.
      const after = await accountHoldings(account.id, db);
      expect(after.map((holding) => holding.quantity).sort()).toEqual([
        "150.00000000",
        "200.00000000",
      ]);

      const atStatement = await holdingsAt(ALL_OWNERS, "2026-08-31", db);
      const byInstrument = new Map(
        atStatement.map((holding) => [holding.instrumentId, holding.quantity]),
      );
      expect(byInstrument.get(rpxa.id)).toBe("100.00000000");
      expect(byInstrument.has(rpxb.id)).toBe(false);
    }),
  );
});
