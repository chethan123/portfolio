// Reproduces #181's other two comment shapes: Review's diff reads its baseline from the wrong
// statement (audit finding QA-02), and a liability account's majority-removal tick gets demanded
// for a removal a backdated upload will never actually make. Real Postgres — the risk is what
// `assembleDiff` reads against, not CSV parsing (already covered by commit-upload.test.ts).
import { afterAll, describe, expect, it } from "vitest";

import { setBalance } from "~/lib/balances.server";
import { commitUpload, diffForDraft, rememberMapping } from "~/lib/uploads.server";
import { accountHoldings } from "~/lib/valuation.server";

import { loader as accountPage } from "../app/routes/account.tsx";

import { closeTestDatabase, withDatabase } from "./support/database.ts";
import { args, get } from "./support/routes.ts";

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
    "reads its baseline from the statement immediately before the upload's own date, not the account's current one",
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
      const diff = await diffForDraft(draftId, db);

      // Chronologically this statement replaces 2026-06-30, which held both funds at 100 and 50 —
      // so ALP's "before" should read 100 and BET should read as a removal. Today the diff reads
      // against 2026-09-09 instead: ALP's "before" is already 150, and BET, already absent there,
      // never appears in the diff at all.
      expect(diff.currentCount).toBe(2);
      expect(diff.updated.find((row) => row.instrumentId === alpha.id)?.quantityBefore).toBe(
        "100.00000000",
      );
      expect(diff.removed.some((row) => row.instrumentId === beta.id)).toBe(true);
    }),
  );
});

describe("a majority-removal tick for a removal a backdated upload will never make", () => {
  it(
    "is not asked for nothing: committing must actually remove what Review said it would, or say why not",
    withDatabase(async (ctx) => {
      const { db, seedAccount, seedInstrument, seedInstrumentAlias } = ctx;
      const account = await seedAccount({ kind: "liability", name: "Chase Auto Loan" });

      // The typed balance is the account's whole statement: one USD holding, negative (owed).
      await setBalance(account.id, { amount: "14,500.00", asOf: "2026-09-15" }, db);
      const [typed] = await accountHoldings(account.id, db);
      if (typed === undefined) throw new Error("setBalance did not write a holding to read back.");

      // An uploaded loan statement names the balance under its own row, not the seeded USD
      // instrument setBalance uses (DESIGN.md §14.8: an upload resolves instruments on its own).
      const principal = await seedInstrument({ symbol: null, name: "Principal Balance" });
      await seedInstrumentAlias({ instrument: principal, rawString: "Principal Balance" });

      // A loan statement lists what's owed as a positive figure; owedAsPositive negates it.
      const draftId = await stage(
        ctx,
        account,
        "Symbol,Quantity,Basis\nPrincipal Balance,15000,\n",
        { owedAsPositive: true },
      );

      const committed = await commitUpload(
        draftId,
        { accountId: account.id, asOf: "2026-07-31", confirmRemovals: "true" },
        db,
      );

      const after = await accountHoldings(account.id, db);
      const removalActuallyHappened = !after.some(
        (holding) => holding.instrumentId === typed.instrumentId,
      );

      const page = await accountPage(
        args(get(`/accounts/${account.id}?uploaded=${committed.setId}`), { accountId: account.id }),
      );
      const householdWasTold = page.receipt !== null;

      // Review demanded confirming the loss of the typed balance — the file replaces the
      // account's only holding. Because the statement is dated behind that balance, the removal
      // never happens. Either it should happen, or the household should have been told it would
      // not. Today neither is true.
      expect(removalActuallyHappened || householdWasTold).toBe(true);
    }),
  );
});
