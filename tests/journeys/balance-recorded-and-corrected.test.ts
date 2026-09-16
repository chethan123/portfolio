// A balance typed by hand, got wrong, and corrected — the seam between set-balance.test.ts (the write) and
// routes/account.test.ts (the receipt) that neither can see: each passes its own test while disagreeing across the
// seam (e.g. redirecting without the inserted row's identity). Only a round trip catches that, so nothing
// here is seeded past the household — every page is reached by following its real redirect.
import { afterAll, describe, expect, it } from "vitest";

import Account, {
  action as recordBalance,
  loader as accountPage,
} from "../../app/routes/account.tsx";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { args, get, outcomeOf, post, redirectTo } from "../support/routes.ts";

import type { TestContext } from "../support/database.ts";

afterAll(closeTestDatabase);

/** The day the statement was true on. In the past, because a future one is refused. */
const AUGUST = "2026-08-16";

/** `/accounts/7?recorded=42` → both ids, as the account page will read them. */
function receiptFrom(location: string): { accountId: string; setId: string } {
  const match = /^\/accounts\/(\d+)\?recorded=(\d+)$/.exec(location);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`Expected a recorded-balance receipt URL, got ${location}`);
  }
  return { accountId: match[1], setId: match[2] };
}

/** A household with one open savings account and nothing recorded against it. */
async function aHouseholdWithASavingsAccount(
  ctx: Pick<TestContext, "seedPerson" | "seedAccount">,
) {
  const owner = await ctx.seedPerson({ name: "Alice" });
  // bank: SINGLE_POSITION admits only this kind and liability — a brokerage is refused outright.
  return ctx.seedAccount({
    name: "Ally Online Savings",
    institution: "Ally",
    kind: "bank",
    owner,
  });
}

describe("a balance recorded by hand", () => {
  it(
    "confirms it by quoting the database, never the parameter the redirect carried",
    withDatabase(async (ctx) => {
      const account = await aHouseholdWithASavingsAccount(ctx);

      // Typed as read off a statement, currency mark and all — the one journey where what's typed reaches storage directly.
      const landing = await redirectTo(() =>
        recordBalance(
          args(post(`/accounts/${account.id}`, { amount: "$1,100.00", asOf: ` ${AUGUST} ` }), {
            accountId: account.id,
          }),
        ),
      );
      const receipt = receiptFrom(landing);
      expect(receipt.accountId).toBe(account.id);

      const page = await accountPage(
        args(get(landing), { accountId: receipt.accountId }),
      );

      expect(page.recordedReceipt).toMatchObject({
        setId: receipt.setId,
        asOf: AUGUST,
        filedBehind: false,
      });
      expect(page.recorded).toMatchObject({ asOf: AUGUST, source: "manual" });

      // Two scales, two columns: account's own line at numeric(20,4), USD row beneath at numeric(20,8). Strings throughout.
      expect(page.total.amount).toBe("1100.0000");
      expect(page.holdings.map((holding) => [holding.symbol, holding.quantity])).toEqual([
        ["USD", "1100.00000000"],
      ]);

      const markup = renderRoute(Account, landing, page);
      expect(markup).toContain(
        '<p class="form-note" role="status">Recorded. Ally Online Savings now reads',
      );

      // The parameter names only a row; it cannot invent what was recorded.
      const invented = await accountPage(
        args(get(`/accounts/${account.id}?recorded=999999999`), { accountId: account.id }),
      );

      expect(invented.recordedReceipt).toBeNull();
      // Figures beneath stay the stored ones — the absence is honest, not a blank page.
      expect(invented.total.amount).toBe("1100.0000");
    }),
  );

  it(
    "is superseded by a later submission for the same date, which keeps the first as history",
    withDatabase(async (ctx) => {
      const account = await aHouseholdWithASavingsAccount(ctx);
      const submit = (amount: string) =>
        redirectTo(() =>
          recordBalance(
            args(post(`/accounts/${account.id}`, { amount, asOf: AUGUST }), {
              accountId: account.id,
            }),
          ),
        );

      // Same as-of date deliberately — this is a correction, not a second day.
      const firstLanding = await submit("1,100.00");
      const landing = await submit("1,010.00");

      const page = await accountPage(
        args(get(landing), { accountId: receiptFrom(landing).accountId }),
      );

      // latest_position_set breaks the tie on created_at then id, so the later submission wins.
      expect(page.total.amount).toBe("1010.0000");
      expect(page.recordedReceipt).toMatchObject({
        setId: receiptFrom(landing).setId,
        asOf: AUGUST,
        filedBehind: false,
      });

      const superseded = await accountPage(
        args(get(firstLanding), { accountId: receiptFrom(firstLanding).accountId }),
      );
      expect(superseded.total.amount).toBe("1010.0000");
      expect(superseded.recordedReceipt).toMatchObject({
        setId: receiptFrom(firstLanding).setId,
        asOf: AUGUST,
        filedBehind: true,
        currentAsOf: AUGUST,
      });

      // Immutable spine (DESIGN.md §5.2): the correction appended, both submissions survive.
      expect(await positionSetCount(ctx, account.id)).toBe(2);
    }),
  );

  it(
    "confirms a backdated balance without changing the newer balance on screen",
    withDatabase(async (ctx) => {
      const account = await aHouseholdWithASavingsAccount(ctx);
      const submit = (amount: string, asOf: string) =>
        redirectTo(() =>
          recordBalance(
            args(post(`/accounts/${account.id}`, { amount, asOf }), { accountId: account.id }),
          ),
        );

      await submit("1,100.00", AUGUST);
      const landing = await submit("900.00", "2026-08-15");
      const receipt = receiptFrom(landing);
      const page = await accountPage(args(get(landing), { accountId: receipt.accountId }));

      expect(page.recorded).toMatchObject({ asOf: AUGUST, source: "manual" });
      expect(page.total.amount).toBe("1100.0000");
      expect(page.recordedReceipt).toMatchObject({
        setId: receipt.setId,
        asOf: "2026-08-15",
        filedBehind: true,
        currentAsOf: AUGUST,
      });

      const markup = renderRoute(Account, landing, page);
      expect(markup).toContain('<p class="form-note" role="status">');
      expect(markup).toContain(
        'Recorded a balance for <b class="u-data">2026-08-15</b>',
      );
      expect(markup).toContain(
        "Current figures are unchanged because Ally Online Savings has a newer record for",
      );
      expect(markup).toContain(`<b class="u-data">${AUGUST}</b>.`);
      expect(await positionSetCount(ctx, account.id)).toBe(2);
    }),
  );

  it(
    "answers a bad amount with the fields to fix rather than a redirect, and writes nothing",
    withDatabase(async (ctx) => {
      const account = await aHouseholdWithASavingsAccount(ctx);
      await redirectTo(() =>
        recordBalance(
          args(post(`/accounts/${account.id}`, { amount: "1,100.00", asOf: AUGUST }), {
            accountId: account.id,
          }),
        ),
      );

      // Refusal must come back as data, not a thrown redirect or 500 — the panel re-renders around it, keeping what was typed.
      const refused = await outcomeOf(() =>
        recordBalance(
          args(post(`/accounts/${account.id}`, { amount: "1,O10.00", asOf: AUGUST }), {
            accountId: account.id,
          }),
        ),
      );

      if (refused instanceof Response) {
        throw new Error(`Expected the action to return errors, and it answered ${refused.status}.`);
      }
      expect(Object.keys(refused.errors)).toEqual(["amount"]);
      expect(refused.values).toMatchObject({ amount: "1,O10.00" });

      // A refusal is not a half-write — the account still reads what it read before.
      const page = await accountPage(
        args(get(`/accounts/${account.id}`), { accountId: account.id }),
      );

      expect(page.total.amount).toBe("1100.0000");
      expect(await positionSetCount(ctx, account.id)).toBe(1);
    }),
  );
});

/** How many balances this account carries, history included. */
async function positionSetCount(ctx: TestContext, accountId: string): Promise<number> {
  const rows = await ctx.db
    .selectFrom("position_set")
    .select("id")
    .where("account_id", "=", accountId)
    .execute();

  return rows.length;
}
