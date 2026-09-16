// Reproduces #181: an upload dated behind the account's current statement lands without anyone
// noticing. Review's diff, the commit, and the account page each read a different "now" — no
// single unit test sees all three disagree at once, which is why this is a journey.
import { afterAll, describe, expect, it } from "vitest";

import { revisePosition } from "~/lib/positions.server";
import { QUANTITY_SCALE, toUnits } from "~/lib/money";
import { commitUpload, diffForDraft, rememberMapping } from "~/lib/uploads.server";
import { accountHoldings } from "~/lib/valuation.server";

import { loader as accountPage } from "../../app/routes/account.tsx";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { args, get } from "../support/routes.ts";

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
    "does not silently no-op what Review promised, nor say nothing changed",
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
      const diff = await diffForDraft(draftId, db);

      // Whatever Review is about to promise the household, in its own words.
      const promisedRemoved = diff.removed.map((row) => row.instrumentId);
      const promisedUpdates = new Map(
        diff.updated.map((row) => [row.instrumentId, row.quantityAfter]),
      );

      // 1 of 2 never crosses the majority-removal gate, so this commits with no confirmation.
      const committed = await commitUpload(
        draftId,
        { accountId: account.id, asOf: "2026-08-31" },
        db,
      );

      const after = await accountHoldings(account.id, db);
      const afterByInstrument = new Map(after.map((holding) => [holding.instrumentId, holding.quantity]));

      const removalsLanded = promisedRemoved.every((id) => !afterByInstrument.has(id));
      const updatesLanded = [...promisedUpdates].every(([id, quantity]) => {
        const actual = afterByInstrument.get(id);
        return (
          actual !== undefined && toUnits(actual, QUANTITY_SCALE) === toUnits(quantity, QUANTITY_SCALE)
        );
      });

      const page = await accountPage(
        args(get(`/accounts/${account.id}?uploaded=${committed.setId}`), { accountId: account.id }),
      );
      const householdWasTold = page.receipt !== null;

      // Either what Review promised actually happened, or the household was told this statement
      // landed behind what the account already reports. Today neither is true: the account still
      // holds RPXA at 150 and RPXB at 200 — the correction, untouched — and the page renders nothing.
      expect(removalsLanded || householdWasTold).toBe(true);
      expect(updatesLanded || householdWasTold).toBe(true);
    }),
  );
});
