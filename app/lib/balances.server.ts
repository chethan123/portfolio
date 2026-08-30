/**
 * Setting the balance of a single-position account (DESIGN.md §5.2, §11). A
 * checking account and a loan are each one number — no statement to map, no
 * securities to reconcile — so §5.2 gives them a "set balance" form writing
 * one `USD` row: the same append-a-position-set mechanism, no separate code
 * path. This module writes exactly what an upload writes, differing only in
 * `source = 'manual'` and no filename; nothing downstream learns a new shape.
 *
 * Three load-bearing decisions. **The sign is derived, never typed**: §2 puts
 * the sign in quantity, the family types what they owe and this negates it —
 * a form accepting a signed number accepts `14500` for a debt, which silently
 * moves net worth by twice the loan. **Only `bank`/`liability`, and only
 * while the statement lists nothing else**: a position set is a photograph,
 * so one `USD` row against a brokerage records every security as sold. The
 * kind refusal states that but cannot enforce it — `kind` is a label, and an
 * account can hold securities under a `bank` one (report SET-1); what stands
 * between a mis-click and a wiped portfolio is the second refusal, which asks
 * what the account holds now and asks again inside the write itself. **Both
 * inserts are one statement**: a `position_set` landing without its holding
 * is a *successful* write meaning "holds nothing" that would outrank every
 * earlier statement; the data-modifying CTE makes that state unreachable.
 */
import { sql } from "kysely";
import { z } from "zod";

import { acceptsSetBalance, isOwed } from "./account-options.ts";
import { getDb, type Database } from "./db.server.ts";
import {
  NotFoundError,
  ValidationError,
  listSentence,
  moneyMagnitude,
  parseInput,
  recordedDate,
} from "./input.server.ts";
import { getAccount } from "./accounts.server.ts";
import { currentStatement } from "./current-statement.server.ts";

import type { IsoDate } from "./valuation.server.ts";
import type { Kysely } from "kysely";

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
   * The position set's id — the one value that changes on every write,
   * including a second balance for an already-recorded date, which lets the
   * form tell "refused" from "landed" without being told.
   */
  id: string;
  asOf: IsoDate;
  source: "upload" | "manual";
};

/**
 * When the balance an account currently shows was recorded, and how —
 * resolved through `latest_position_set`, never a second `order by` here
 * (§8.2: drift is a tie-break copied into a new caller).
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

  // Safe: `position_set_source_valid` bounds what the database can store.
  return { id: row.id, asOf: row.as_of_date, source: row.source as LastRecorded["source"] };
}

/**
 * Record what a single-position account holds, as of a date. Appends, never
 * edits: submitting twice for one date resolves like a re-uploaded statement
 * — `latest_position_set` breaks the tie on `created_at` then `id`, so the
 * last one wins and the earlier stays as history.
 *
 * @param raw the submitted fields, unvalidated.
 * @throws {NotFoundError} when no such account exists.
 * @throws {ValidationError} per bad field, plus form-level where the kind,
 *         state or current statement refuses the write outright.
 */
export async function setBalance(
  accountId: string,
  raw: unknown,
  db: Kysely<Database> = getDb(),
): Promise<RecordedBalance> {
  const account = await getAccount(accountId, db);

  // Before field validation, deliberately: a person who reached this form for
  // a brokerage has a problem no correcting of boxes will fix.
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

  // Still before field validation, same reason. The refusal the kind check
  // cannot make: it reads the rows, not the label, so it holds however the
  // rows got there — an upload never reads `kind`, and a Settings edit used
  // to relabel a brokerage freely (SET-1). The writer that can lose them is
  // the one that has to check.
  const statement = await currentStatement(accountId, db);

  if (statement.cashInstrumentId === null) {
    // Seeded by 0001, so absence is a broken install, not anything a family
    // member did — no field to put it under, no edit that fixes it. Ahead of
    // the refusal below, load-bearing: with no USD row to compare against,
    // every holding reads as something a typed balance would drop.
    throw new Error("The USD instrument is missing — the initial migration has not been applied.");
  }

  if (statement.others.length > 0) {
    throw ValidationError.form(
      `${account.name}'s current statement also lists ${listSentence(statement.others)}. A typed ` +
        "balance replaces the whole statement, so recording one here would record " +
        `${statement.others.length === 1 ? "it" : "them"} as sold. Upload a statement for this ` +
        "account, or correct the position on Holdings.",
    );
  }

  const input = parseInput(balanceInput, raw);

  // The whole of the sign logic, in one place. `0` keeps no sign: "−0.00" is a
  // debt of nothing written as though it were something.
  const zero = /^0+(\.0+)?$/.test(input.amount);
  const quantity = isOwed(account.kind) && !zero ? `-${input.amount}` : input.amount;

  // The check above, again, inside the write (`revisePosition`'s pattern):
  // the pre-check is a read, and a statement committed between it and this
  // insert would be sold off by a write that never saw it. `guard` yields no
  // row then, both inserts select from it, and the account gets *nothing at
  // all*. An account with no statement still writes: `latest_position_set` is
  // NULL, matching no holding, so `not exists` holds. No test covers the
  // race, deliberately: reaching it means committing a statement between the
  // two reads, and rollback isolation puts that insert where the pre-check
  // sees it and refuses first (`revisePosition` likewise).
  const written = await sql<{ position_set_id: string }>`
    with guard as (
      select 1
      where not exists (
        select 1 from holding h
        where h.position_set_id = latest_position_set(${accountId}::bigint)
          and h.instrument_id <> ${statement.cashInstrumentId}::bigint
          and h.quantity <> 0
      )
    ),
    new_set as (
      insert into position_set (account_id, as_of_date, source)
      select ${accountId}::bigint, ${input.asOf}::date, 'manual' from guard
      returning id
    )
    insert into holding (position_set_id, instrument_id, quantity)
    select new_set.id, ${statement.cashInstrumentId}::bigint, ${quantity}::numeric
    from new_set
    returning holding.position_set_id
  `.execute(db);

  if (written.rows[0] === undefined) {
    throw ValidationError.form(
      `${account.name} changed while this form was open, so nothing was recorded. ` +
        "Reload the page and record the balance against what it holds now.",
    );
  }

  return {
    accountId: account.id,
    accountName: account.name,
    asOf: input.asOf,
    amount: quantity,
  };
}
