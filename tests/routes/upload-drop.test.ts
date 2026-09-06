// Drop screen (step one), through its real loader. Two rules: the loader must not narrow listAccounts' owner/institution/kind/number
// away (once rendered two same-named accounts identically); and a ?account= prefill the select doesn't offer (closed, nonexistent)
// drops silently — matched against the options rather than trusted into defaultValue.
import { afterAll, describe, expect, it } from "vitest";

import Upload, { action, loader } from "../../app/routes/upload.tsx";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { args, get } from "../support/routes.ts";

// getConfig() memoises its first read, so set before any loader runs (as masked-screens.test.tsx does).
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
      // Still a select, not a lock — the other account and the placeholder stay unselected.
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

        // Exactly the no-param screen — nothing says a prefill was ever attempted.
        expect(markup).toContain('<option value="" selected="">Choose…</option>');
        expect(markup).toContain(`<option value="${open.id}">Fidelity Taxable</option>`);
        expect(markup).not.toContain(`value="${closed.id}"`);
      }
    }),
  );

  it(
    "starts the retry blank after a refusal that read no fields, rather than re-applying the link's account",
    withDatabase(async ({ seedAccount }) => {
      const linked = await seedAccount({ name: "Fidelity Taxable" });
      const path = `/upload?account=${linked.id}`;

      // Size cap refuses on Content-Length, before any field is read — nothing is captured. The reader may have
      // changed the account before submitting, so the retry must not silently re-aim at the link's account.
      const oversized = new Request(`http://portfolio.local${path}`, {
        method: "POST",
        headers: { "content-length": String(Number.MAX_SAFE_INTEGER) },
      });
      const refusal = await action(args(oversized));
      expect(refusal.formError).toContain("MB");

      const markup = renderRoute(Upload, path, await loader(args(get(path))), {
        actionData: refusal,
      });
      expect(markup).toContain('<option value="" selected="">Choose…</option>');
      expect(markup).not.toContain(`<option value="${linked.id}" selected=""`);
    }),
  );
});
