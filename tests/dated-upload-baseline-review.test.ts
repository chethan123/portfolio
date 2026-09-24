// Reproduces #181's other two comment shapes: Review's diff reads its baseline from the wrong
// statement (audit finding QA-02), and a liability account's majority-removal tick gets demanded
// for a removal a backdated upload will never actually make. Real Postgres — the risk is what
// `assembleDiff` reads against, not CSV parsing (already covered by commit-upload.test.ts).
// Rewritten to the four-part assertion: a refusal naming both dates, a second submit that lands
// once bound to the refusal's own baseline, the receipt agreeing with what the refusal carried,
// and the statement itself landing as history rather than as nothing.
import { afterAll, describe, expect, it } from "vitest";

import { ALL_OWNERS } from "~/lib/owner-filter";
import { setBalance } from "~/lib/balances.server";
import { sectionKey } from "~/lib/review-form";
import {
  RefusedUpload,
  recordUpload,
  rememberMapping,
  reviewForDraft,
} from "~/lib/uploads.server";
import { accountHoldings, holdingsAt } from "~/lib/valuation.server";

import { loader as accountPage } from "../app/routes/account.tsx";

import { closeTestDatabase, withDatabase } from "./support/database.ts";
import { args, get } from "./support/routes.ts";
import { onlyRecorded, onlySection, posted } from "./support/review.ts";

import type { StatementMapping } from "~/lib/statement";
import type { SeededAccount } from "./support/fixtures.ts";
import type { TestContext } from "./support/database.ts";

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

/** Overrides merged onto {@link BASE_MAPPING}, columns merged one level deep (commit-upload.test.ts's `stage`, copied). */
type MappingOverrides = Omit<Partial<StatementMapping>, "columns"> & {
  columns?: Partial<StatementMapping["columns"]>;
};

async function stage(
  { db, seedUploadDraft }: Pick<TestContext, "db" | "seedUploadDraft">,
  account: SeededAccount,
  csv: string,
  overrides: MappingOverrides = {},
): Promise<string> {
  const draft = await seedUploadDraft({
    account,
    filename: "Statement.csv",
    bytes: encode(csv),
  });

  const outcome = await rememberMapping(
    draft.id,
    {
      ...BASE_MAPPING,
      ...overrides,
      columns: { ...BASE_MAPPING.columns, ...(overrides.columns ?? {}) },
    },
    db,
  );

  if ("problems" in outcome) {
    throw new Error(
      "This fixture's mapping does not parse its own file: " +
        outcome.problems.map((problem) => problem.message).join(" "),
    );
  }

  return draft.id;
}

describe("Review's diff for a statement dated between two existing ones", () => {
  it(
    "refuses committing against the wrong baseline, then records the statement between the two it chronologically belongs between",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias, seedPositionSet } = ctx;
      const account = await seedAccount({ kind: "brokerage" });

      const alpha = await seedInstrument({ symbol: "ALP", name: "Alpha Fund" });
      const beta = await seedInstrument({ symbol: "BET", name: "Beta Fund" });
      await seedInstrumentAlias({ instrument: alpha, rawString: "ALP" });

      // The account's real history: two statements, three months apart. Beta was sold somewhere
      // in between, so the 2026-09-09 statement no longer carries it.
      await seedPositionSet({
        account,
        asOf: "2026-06-30",
        holdings: [
          { instrument: alpha, quantity: "100" },
          { instrument: beta, quantity: "50" },
        ],
      });
      await seedPositionSet({
        account,
        asOf: "2026-09-09",
        holdings: [{ instrument: alpha, quantity: "150" }],
      });

      // A third statement, dated between the two above — its own AsOf column states this, so the
      // date is known before the diff is assembled, not only at commit time.
      const draftId = await stage(
        ctx,
        account,
        "Symbol,Quantity,Basis,AsOf\nALP,120,,2026-07-31\n",
        { columns: { asOf: "AsOf" } },
      );
      const reviewed = await reviewForDraft(draftId, null, db);

      // 1. The first submit is refused, and the message names both dates.
      let refusal: RefusedUpload;
      try {
        await recordUpload(draftId, posted(reviewed), db);
        throw new Error("Expected the first submit to be refused, and it was not.");
      } catch (error) {
        if (!(error instanceof RefusedUpload)) throw error;
        refusal = error;
      }
      expect(refusal.fieldErrors.form).toMatch(/2026-07-31/);
      expect(refusal.fieldErrors.form).toMatch(/2026-09-09/);

      // Chronologically this statement replaces 2026-06-30, which held both funds at 100 and 50 —
      // so ALP's "before" reads 100 and BET reads as a removal, which is what the refused diff
      // must already show: reading against 2026-09-09 instead would have ALP's "before" at 150,
      // and BET, already absent there, never appear at all.
      const refusedSection = onlySection(refusal.diff);
      expect(refusedSection.currentCount).toBe(2);
      expect(
        refusedSection.updated.find((row) => row.instrumentId === alpha.id)?.quantityBefore,
      ).toBe("100.00000000");
      expect(refusedSection.removed.some((row) => row.instrumentId === beta.id)).toBe(true);

      // 2. A second submit, carrying the refusal's own baseline and its confirmation, lands.
      const committed = onlyRecorded(await recordUpload(
        draftId,
        posted(refusal.diff, { [sectionKey("confirmFiledBehind", account.id)]: "true" }),
        db,
      ));

      // 3. receipt.counts equals the counts of the diff the refusal carried.
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

      // 4. accountHoldings is unchanged (2026-09-09 is still current), and holdingsAt this
      // statement's own date shows what it actually recorded, proving it became history.
      const after = await accountHoldings(account.id, db);
      expect(after.map((holding) => holding.quantity)).toEqual(["150.00000000"]);

      const atStatement = await holdingsAt(ALL_OWNERS, "2026-07-31", db);
      expect(atStatement.map((holding) => holding.quantity)).toEqual(["120.00000000"]);
    }),
  );
});

describe("a majority-removal tick for a removal a backdated upload will never make", () => {
  it(
    "asks for no such tick against an empty baseline, refuses on the filed-behind date alone, and records the statement as history",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias } = ctx;
      const account = await seedAccount({ kind: "liability", name: "Chase Auto Loan" });

      // The typed balance is the account's whole statement: one USD holding, negative (owed).
      await setBalance(account.id, { amount: "14,500.00", asOf: "2026-09-15" }, db);

      // An uploaded loan statement names the balance under its own row, not the seeded USD
      // instrument setBalance uses (an upload resolves its own instruments — instrument-resolution.server.ts).
      const principal = await seedInstrument({ symbol: null, name: "Principal Balance" });
      await seedInstrumentAlias({ instrument: principal, rawString: "Principal Balance" });

      // A loan statement lists what's owed as a positive figure; owedAsPositive negates it. Dated
      // before the account's only statement, so nothing was recorded on or before it at all.
      const draftId = await stage(
        ctx,
        account,
        "Symbol,Quantity,Basis\nPrincipal Balance,15000,\n",
        { owedAsPositive: true },
      );
      const reviewed = await reviewForDraft(draftId, "2026-07-31", db);

      // 1. The first submit is refused on the filed-behind date alone — nothing recorded on or
      // before 2026-07-31 means an empty baseline, so there is no majority to ask about.
      let refusal: RefusedUpload;
      try {
        await recordUpload(draftId, posted(reviewed, { asOf: "2026-07-31" }), db);
        throw new Error("Expected the first submit to be refused, and it was not.");
      } catch (error) {
        if (!(error instanceof RefusedUpload)) throw error;
        refusal = error;
      }
      expect(refusal.fieldErrors.form).toMatch(/2026-07-31/);
      expect(refusal.fieldErrors.form).toMatch(/2026-09-15/);
      const refusedSection = onlySection(refusal.diff);
      expect(refusedSection.firstStatement).toBe(true);
      expect(refusedSection.majorityRemoved).toBe(false);

      // 2. A second submit, carrying the refusal's own (empty) baseline and its confirmation,
      // lands with no confirmRemovals — there is nothing at this baseline to confirm removing.
      const committed = onlyRecorded(await recordUpload(
        draftId,
        posted(refusal.diff, {
          asOf: "2026-07-31",
          [sectionKey("confirmFiledBehind", account.id)]: "true",
        }),
        db,
      ));

      // 3. receipt.counts and firstStatement agree with the diff the refusal carried.
      const page = await accountPage(
        args(get(`/accounts/${account.id}?uploaded=${committed.setId}`), { accountId: account.id }),
      );
      expect(page.receipt?.firstStatement).toBe(true);
      expect(page.receipt?.counts).toEqual({
        added: refusedSection.added.length,
        updated: refusedSection.updated.length,
        unchanged: refusedSection.unchangedCount,
        removed: refusedSection.removed.length,
      });
      // Freshly committed and already filed behind — the receipt gate must say so from the start.
      expect(page.receipt?.isCurrent).toBe(false);

      // 4. The typed balance is still what the account reports today — this statement changes
      // nothing current — and holdingsAt its own date shows what it actually recorded.
      const after = await accountHoldings(account.id, db);
      expect(after).toHaveLength(1);
      expect(after[0]?.quantity).toBe("-14500.00000000");

      const atStatement = await holdingsAt(ALL_OWNERS, "2026-07-31", db);
      expect(atStatement).toHaveLength(1);
      expect(atStatement[0]?.instrumentId).toBe(principal.id);
      expect(atStatement[0]?.quantity).toBe("-15000.00000000");
    }),
  );
});
