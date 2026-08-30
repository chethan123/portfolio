/**
 * The drop screen — step one of the upload flow — through its real loader.
 *
 * Two rules are pinned here. The projection: `listAccounts` already returns
 * owner, institution, kind and number, and the loader must not narrow them
 * away — that defect once rendered two same-named accounts as two identical
 * rows (the label rules themselves are `account-label.test.ts`'s to state).
 * And the `?account=` prefill (CONTEXT.md): a link from an account's own page
 * hands the select its starting choice, still changeable, committing nothing.
 * What is at risk there is the quiet half of the rule — a prefill naming
 * anything the select does not offer, a closed account or an id that never
 * existed, must be dropped without a trace: no note, no 404, no selection.
 * The loader matches it against the options rather than trusting it into
 * `defaultValue`, so the select is never defaulted to a value no option
 * carries — which is also what makes this markup deterministic enough to
 * assert on. Every refusal that matters stays where it always was, in
 * `uploads.server.ts`: a prefill only ever saved the picking, never the pick.
 */
import { afterAll, describe, expect, it } from "vitest";

import Upload, { loader } from "../../app/routes/upload.tsx";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { args, get } from "../support/routes.ts";

// The loader reads MAX_UPLOAD_MB, and `getConfig()` memoises its first read —
// set before any loader runs, as `masked-screens.test.tsx` does it.
process.env.DATABASE_URL = TEST_DATABASE_URL;

afterAll(closeTestDatabase);

/** The screen at `path`, drawn from its real loader's answer. */
async function screenAt(path: string): Promise<string> {
  return renderRoute(Upload, path, await loader(args(get(path))));
}

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

      const { accountGroups, hasAccounts } = await loader(args(get("/upload")));

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

describe("the drop screen's ?account= prefill", () => {
  it(
    "arrives with the linked open account already selected and everything else untouched",
    withDatabase(async ({ seedAccount }) => {
      const fidelity = await seedAccount({ name: "Fidelity Taxable" });
      const vanguard = await seedAccount({ name: "Vanguard IRA" });

      const markup = await screenAt(`/upload?account=${vanguard.id}`);

      expect(markup).toContain(
        `<option value="${vanguard.id}" selected="">Vanguard IRA</option>`,
      );
      // One choice made and no more: the other account and the placeholder
      // stay unselected, and the choice is still a choice — a select, not a
      // lock.
      expect(markup).toContain(`<option value="${fidelity.id}">Fidelity Taxable</option>`);
      expect(markup).not.toContain('<option value="" selected="">');
    }),
  );

  it(
    "quietly drops a prefill the select does not offer — a closed account, or an id that never existed",
    withDatabase(async ({ seedAccount }) => {
      const open = await seedAccount({ name: "Fidelity Taxable" });
      const closed = await seedAccount({ name: "Old 401(k)", closedAt: "2025-01-31" });

      for (const requested of [closed.id, "999999", "not-an-id"]) {
        const markup = await screenAt(`/upload?account=${requested}`);

        // Exactly the screen a reader gets with no param at all: placeholder
        // selected, open accounts offered, and nothing saying a prefill was
        // ever attempted.
        expect(markup).toContain('<option value="" selected="">Choose…</option>');
        expect(markup).toContain(`<option value="${open.id}">Fidelity Taxable</option>`);
        expect(markup).not.toContain(`value="${closed.id}"`);
      }
    }),
  );
});
