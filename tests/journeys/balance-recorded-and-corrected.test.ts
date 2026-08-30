/**
 * A balance typed by hand, got wrong, and corrected. `set-balance.test.ts`
 * holds the write to account and `routes/account.test.ts` the receipt;
 * neither can see the seam between them — three parts, no owner: the write
 * decides what was stored, the action what to put in the redirect, the page
 * whether to confirm. Each passes its own test while carrying the wrong
 * thing across (an action redirecting with the date *submitted* rather than
 * *stored*, a loader comparing against a set no longer read), producing a
 * page that confirms nothing after a real write or confirms one that never
 * happened. Nothing but a round trip notices — so nothing is seeded past
 * the household: every balance is posted to the real `action`, every page
 * reached by following the redirect it actually chose.
 */
import { afterAll, describe, expect, it } from "vitest";

import { action as recordBalance, loader as accountPage } from "../../app/routes/account.tsx";

import { closeTestDatabase, withDatabase } from "../support/database.ts";
import { args, get, outcomeOf, post, redirectTo } from "../support/routes.ts";

import type { TestContext } from "../support/database.ts";

afterAll(closeTestDatabase);

/** The day the statement was true on. In the past, because a future one is refused. */
const AUGUST = "2026-08-16";

/** `/accounts/7?recorded=2026-08-16` → both halves, as the account page will read them. */
function receiptFrom(location: string): { accountId: string; asOf: string } {
  const match = /^\/accounts\/(\d+)\?recorded=(\d{4}-\d{2}-\d{2})$/.exec(location);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`Expected a recorded-balance receipt URL, got ${location}`);
  }
  return { accountId: match[1], asOf: match[2] };
}

/** A household with one open savings account and nothing recorded against it. */
async function aHouseholdWithASavingsAccount(
  ctx: Pick<TestContext, "seedPerson" | "seedAccount">,
) {
  const owner = await ctx.seedPerson({ name: "Alice" });
  // `bank`, because `SINGLE_POSITION` admits only this kind and `liability`: a
  // brokerage is refused outright, so a journey through this form cannot use one.
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

      // --- Record: the form as the panel posts it --------------------------
      // Typed the way it is read off a statement, currency mark and all — this
      // is the one journey where what a person types reaches storage directly.
      const landing = await redirectTo(() =>
        recordBalance(
          args(post(`/accounts/${account.id}`, { amount: "$1,100.00", asOf: ` ${AUGUST} ` }), {
            accountId: account.id,
          }),
        ),
      );
      const receipt = receiptFrom(landing);
      expect(receipt.accountId).toBe(account.id);
      // The redirect carries the date as *stored*, not as posted. They differ
      // by the validation in between — `recordedDate` trims — and the URL is
      // then compared against the database on the page below, so a redirect
      // built from the raw field would carry a date that matches nothing and
      // silently confirm nothing after a write that really happened.
      expect(receipt.asOf).toBe(AUGUST);

      // --- The page the reader actually lands on ---------------------------
      const page = await accountPage(
        args(get(landing), { accountId: receipt.accountId }),
      );

      // The confirmation stands only because the date in the URL matches the
      // set this account is now reading — and that set is the one the write
      // just appended, resolved through `latest_position_set` rather than
      // remembered by the action.
      expect(page.justRecorded).toBe(true);
      expect(page.recorded).toMatchObject({ asOf: AUGUST, source: "manual" });

      // --- Read it back ----------------------------------------------------
      // Both scales, because they are different columns: the account's own line
      // at `numeric(20, 4)` and the USD row beneath it at `numeric(20, 8)`.
      // Strings throughout — a float here is the bug the whole schema avoids.
      expect(page.total.amount).toBe("1100.0000");
      expect(page.holdings.map((holding) => [holding.symbol, holding.quantity])).toEqual([
        ["USD", "1100.00000000"],
      ]);

      // --- A hand-typed receipt confirms nothing ---------------------------
      // A real date, a plausible one, and one this account has never carried.
      // The parameter says only *which* day was written and nothing about what
      // is in it, so a page that believed it would announce a balance nobody
      // recorded on the one screen whose job is to confirm.
      const invented = await accountPage(
        args(get(`/accounts/${account.id}?recorded=2026-08-15`), { accountId: account.id }),
      );

      expect(invented.justRecorded).toBe(false);
      // And the figures beneath the absent sentence are still the stored ones,
      // which is what makes the absence honest rather than a blank page.
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

      // The figure as first typed, and the same day's figure typed again after
      // the reader noticed the transposition. Same as-of date deliberately:
      // this is a correction, not a second day.
      await submit("1,100.00");
      const landing = await submit("1,010.00");

      const page = await accountPage(
        args(get(landing), { accountId: receiptFrom(landing).accountId }),
      );

      // `latest_position_set` breaks the tie on `created_at` then `id`, so the
      // later submission is what the account reads. A correction that had to
      // win by editing would read the same here and fail the count below.
      expect(page.total.amount).toBe("1010.0000");
      expect(page.justRecorded).toBe(true);

      // The immutable spine (DESIGN.md §5.2): the correction appended, so both
      // submissions survive and the account simply reads the newer one.
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

      // A correction with a slipped keystroke. The refusal has to come back as
      // data — a thrown redirect would empty the boxes, and a 500 would lose
      // what was typed — because the panel re-renders around it.
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

      // And the balance that was already good is untouched: a refusal is not a
      // half-write, so the account still reads what it read before.
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
