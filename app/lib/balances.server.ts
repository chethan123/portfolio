/**
 * Setting the balance of a single-position account — DESIGN.md §5.2, §11.
 *
 * A checking account and a loan are each one number. There is no statement to
 * map columns from and no securities to reconcile, so §5.2 gives them their own
 * way in: "Checking and loan balances use a 'set balance' form writing one `USD`
 * row — the same append-a-position-set mechanism, no separate code path."
 *
 * That last clause is the whole design. This module writes exactly what an
 * upload writes — a `position_set` with holdings under it — and differs only in
 * carrying `source = 'manual'` and no filename. Nothing downstream learns a new
 * shape: `latest_position_set` picks it up by the same tie-break, the view
 * values it by the same rule, and every figure in the application moves because
 * one row landed in the table they all already read.
 *
 * Three decisions worth stating, because each is load-bearing:
 *
 * **The sign is derived, never typed.** §2 puts the sign in quantity and keeps
 * price a positive market fact, so a loan is a negative `USD` quantity. The
 * family types what they owe and this module negates it, because a form that
 * accepts a signed number accepts `14500` for a debt — which does not fail, it
 * silently moves the household's net worth by twice the loan.
 *
 * **Only `bank` and `liability`.** A position set is a photograph of everything
 * an account holds, so recording one `USD` row against a brokerage would record
 * every security in it as sold (§5.2's "a missing row means sold"). The refusal
 * below is what stands between a mis-clicked form and a wiped portfolio.
 *
 * **Both inserts are one statement.** A `position_set` that lands without its
 * holding is not a failed write — it is a *successful* write meaning "this
 * account now holds nothing", and it would outrank every earlier statement. The
 * data-modifying CTE makes that state unreachable without asking the caller to
 * own a transaction.
 */
import { sql } from "kysely";
import { z } from "zod";

import { getDb, type Database } from "./db.server.ts";
import {
  NotFoundError,
  ValidationError,
  moneyMagnitude,
  parseInput,
  recordedDate,
} from "./input.server.ts";
import { getAccount } from "./accounts.server.ts";

import type { AccountKind, IsoDate } from "./valuation.server.ts";
import type { Kysely } from "kysely";

/**
 * Which kinds hold their whole position in one number.
 *
 * An exhaustive record rather than a list or a predicate: adding a kind to the
 * schema becomes a compile error here, at the exact place someone has to decide
 * whether a single `USD` row is the truth about it. A list would just quietly
 * not contain the new kind, and quietly not containing it is the answer that
 * loses a portfolio.
 */
const SINGLE_POSITION: Record<AccountKind, boolean> = {
  brokerage: false,
  "401k": false,
  ira: false,
  bank: true,
  liability: true,
};

/**
 * Which direction a kind's balance runs.
 *
 * Only consulted for the kinds {@link SINGLE_POSITION} admits; the securities
 * accounts are absent from this question because they never reach it.
 */
const OWES: Record<AccountKind, boolean> = {
  brokerage: false,
  "401k": false,
  ira: false,
  bank: false,
  liability: true,
};

/** Can this kind of account have its balance set by hand? */
export function acceptsSetBalance(kind: AccountKind): boolean {
  return SINGLE_POSITION[kind];
}

/**
 * Does a balance on this kind count against the household?
 *
 * Exported so the form can caption its box with the direction it is going to
 * apply — "Amount owed" over a box whose contents become a negative quantity.
 * The alternative is a screen that says "Balance" and stores the opposite of
 * what a reader would expect, which is a lie told by omission.
 */
export function isOwed(kind: AccountKind): boolean {
  return OWES[kind];
}

/** What was submitted: an unsigned amount, and the date it was true on. */
export const balanceInput = z.object({
  amount: moneyMagnitude("A balance"),
  asOf: recordedDate("The date"),
});

export type BalanceInput = z.infer<typeof balanceInput>;

/** A balance that has just been recorded, as it was stored. */
export type RecordedBalance = {
  accountId: string;
  accountName: string;
  asOf: IsoDate;
  /** Signed, exactly as the quantity was written: negative for a liability. */
  amount: string;
};

/** The statement, manual or uploaded, currently speaking for an account. */
export type LastRecorded = {
  /**
   * The position set's id.
   *
   * Exposed because it is the one value that changes on every write, including
   * a second balance recorded for a date that already had one — which is what
   * lets the form tell "my submission was refused" from "my submission landed"
   * without either being told to it.
   */
  id: string;
  asOf: IsoDate;
  source: "upload" | "manual";
};

/**
 * When the balance an account currently shows was recorded, and how.
 *
 * Resolved through `latest_position_set` rather than by a second
 * `order by as_of_date desc` written here — §8.2's drift is a tie-break copied
 * into a new caller, and the function exists so there is one of them.
 *
 * @returns null when the account has no statement of any kind yet.
 */
export async function lastRecorded(
  accountId: string,
  db: Kysely<Database> = getDb(),
): Promise<LastRecorded | null> {
  if (!/^\d+$/.test(accountId)) return null;

  const result = await sql<{ id: string; as_of_date: string; source: string }>`
    select id, as_of_date, source
    from position_set
    where id = latest_position_set(${accountId}::bigint)
  `.execute(db);

  const row = result.rows[0];
  if (row === undefined) return null;

  // Safe by the same reasoning the rest of the codebase uses for enum columns:
  // `position_set_source_valid` is what the database will and will not store.
  return { id: row.id, asOf: row.as_of_date, source: row.source as LastRecorded["source"] };
}

/**
 * Record what a single-position account holds, as of a date.
 *
 * Appends; never edits. Submitting twice for one date is a correction and
 * resolves the way a re-uploaded statement does — `latest_position_set` breaks
 * the tie on `created_at` then `id`, so the last one submitted wins and the
 * earlier one stays as history.
 *
 * @param raw the submitted fields, unvalidated. Validating here rather than in
 *            the route is what keeps a second caller from skipping the rules.
 * @throws {NotFoundError} when no such account exists.
 * @throws {ValidationError} with a message per bad field, and a form-level one
 *         for an account whose kind or state refuses the write outright.
 */
export async function setBalance(
  accountId: string,
  raw: unknown,
  db: Kysely<Database> = getDb(),
): Promise<RecordedBalance> {
  const account = await getAccount(accountId, db);

  // Before the field validation, deliberately. A person who reached this form
  // for a brokerage account has a problem no amount of correcting the boxes
  // will fix, and leading with "that is not a number" would bury it.
  if (!acceptsSetBalance(account.kind)) {
    throw ValidationError.form(
      `${account.name} holds securities, so its balance comes from a statement rather than ` +
        "from a typed figure. Recording one cash figure here would record everything else " +
        "it holds as sold.",
    );
  }

  if (account.isClosed) {
    throw ValidationError.form(
      `${account.name} is closed, and a closed account's history does not change. ` +
        "Reopen it from Settings if this balance is still real.",
    );
  }

  const input = parseInput(balanceInput, raw);

  const usd = await db
    .selectFrom("instrument")
    .select("id")
    .where("symbol", "=", "USD")
    .executeTakeFirst();

  if (usd === undefined) {
    // Seeded by `0001_initial_schema.sql`, so its absence is a broken install
    // rather than anything a family member did. Not a ValidationError: there is
    // no field to put it under and no edit that would fix it.
    throw new Error("The USD instrument is missing — the initial migration has not been applied.");
  }

  // The whole of the sign logic, in one place. `0` keeps no sign: "−0.00" is a
  // debt of nothing written as though it were something.
  const zero = /^0+(\.0+)?$/.test(input.amount);
  const quantity = isOwed(account.kind) && !zero ? `-${input.amount}` : input.amount;

  await sql`
    with new_set as (
      insert into position_set (account_id, as_of_date, source)
      values (${accountId}::bigint, ${input.asOf}::date, 'manual')
      returning id
    )
    insert into holding (position_set_id, instrument_id, quantity)
    select new_set.id, ${usd.id}::bigint, ${quantity}::numeric
    from new_set
  `.execute(db);

  return {
    accountId: account.id,
    accountName: account.name,
    asOf: input.asOf,
    amount: quantity,
  };
}
