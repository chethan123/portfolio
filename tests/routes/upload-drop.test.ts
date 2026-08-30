/**
 * The drop screen's loader ships the picker its owner-grouped, adaptively
 * labelled options. The original defect was a projection: `listAccounts`
 * already returned owner, institution, kind and number, and the loader
 * narrowed them away — so two same-named accounts rendered as two identical
 * rows. This pins the projection; the label rules themselves are
 * `account-label.test.ts`'s to state.
 */
import { afterAll, describe, expect, it } from "vitest";

import { loader } from "../../app/routes/upload.tsx";

import { closeTestDatabase, withDatabase } from "../support/database.ts";

afterAll(closeTestDatabase);

describe("the drop screen's loader", () => {
  it(
    "groups open accounts by owner and hands each option its distinguishing label",
    withDatabase(async ({ seedPerson, seedAccount }) => {
      const alex = await seedPerson({ name: "Alex Rivera" });
      const jordan = await seedPerson({ name: "Jordan Rivera" });
      await seedAccount({
        name: "Schwab",
        institution: "Charles Schwab",
        owner: alex,
        externalAccountNumber: "8391-2245",
      });
      await seedAccount({
        name: "Schwab",
        institution: "Charles Schwab",
        owner: jordan,
        externalAccountNumber: "4407-9913",
      });
      // Closed accounts are absent, not disabled (ingest brief §3).
      await seedAccount({ name: "Old Brokerage", owner: alex, closedAt: "2025-06-01T00:00:00Z" });

      const { accountGroups, hasAccounts } = await loader();

      expect(hasAccounts).toBe(true);
      expect(
        accountGroups.map((group) => ({
          owner: group.ownerName,
          labels: group.options.map((option) => option.label),
        })),
      ).toEqual([
        { owner: "Alex Rivera", labels: ["Schwab ····2245"] },
        { owner: "Jordan Rivera", labels: ["Schwab ····9913"] },
      ]);
    }),
  );
});
