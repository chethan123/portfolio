// Sets the balance of a single-position account (DESIGN.md §5.2, §11) via the same
// append-a-position-set mechanism as an upload (source='manual', no filename).
// Sign is derived from kind, never typed in. Refusals read actual current holdings, not just
// `kind` (a label that can lie, SET-1). Both inserts are one statement: a data-modifying CTE
// so a position_set can never land without its holding row.
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

export const balanceInput = z.object({
  amount: moneyMagnitude("A balance"),
  asOf: recordedDate("The date"),
});

export type BalanceInput = z.infer<typeof balanceInput>;

export type RecordedBalance = {
  accountId: string;
  accountName: string;
  asOf: IsoDate;
  // Signed, as stored: negative for a liability.
  amount: string;
};

export type LastRecorded = {
  // Changes on every write, including a same-date resubmit, so the form can tell
  // refused from landed without being told.
  id: string;
  asOf: IsoDate;
  source: "upload" | "manual";
};

// Resolved via latest_position_set (§8.2) — never a second order-by here.
// Returns null when the account has no statement of any kind yet.
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

  // Safe: position_set_source_valid bounds what the database can store.
  return { id: row.id, asOf: row.as_of_date, source: row.source as LastRecorded["source"] };
}

// Appends, never edits — resubmitting for one date resolves like a re-upload
// (latest_position_set ties on created_at then id); the earlier stays as history.
export async function setBalance(
  accountId: string,
  raw: unknown,
  db: Kysely<Database> = getDb(),
): Promise<RecordedBalance> {
  const account = await getAccount(accountId, db);

  // Before field validation: wrong account kind isn't fixable by correcting the form.
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

  // Reads actual rows, not the label — kind alone can lie about what's held (SET-1).
  const statement = await currentStatement(accountId, db);

  if (statement.cashInstrumentId === null) {
    // Seeded by migration 0001; absence is a broken install, not a form error. Must throw
    // here, ahead of the refusal below, or every holding reads as droppable.
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

  // Sign derived here, once. Skip negation at zero: "-0.00" would read as a debt that isn't.
  const zero = /^0+(\.0+)?$/.test(input.amount);
  const quantity = isOwed(account.kind) && !zero ? `-${input.amount}` : input.amount;

  // Guard re-checks inside the write (revisePosition's pattern): a statement committed between
  // the pre-check and this insert would otherwise get sold off. No guard row => no insert at all,
  // even with no prior statement (latest_position_set is NULL, so `not exists` still holds).
  // Race untested deliberately: rollback isolation means it can't be reproduced in a test.
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
