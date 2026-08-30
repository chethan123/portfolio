/**
 * The statement an account currently has, at the one grain a typed balance
 * needs: its cash row's direction, and everything else it lists. Not
 * `statement.ts` (uploaded CSV → rows) — this reads what an account holds
 * *now*, its own module because two writers need the same answer and neither
 * can own it: `balances.server.ts` before replacing a whole statement with
 * one cash row, `accounts.server.ts` before relabelling an account as
 * single-balance. Both used to decide from `account.kind` alone — a label
 * one settings form away from being wrong about the rows it describes
 * (report SET-1).
 *
 * A leaf, deliberately: it imports the database handle and nothing else in
 * `app/lib`, so neither writer can reach for it and find a cycle — also why
 * the answer is not assembled from the modules that already read positions
 * (`valuation.server.ts`'s header claims the only `holding_valued` reader).
 *
 * Resolved through `latest_position_set`, like every reader of "current"
 * (DESIGN.md §8.2: the tie-break exists in one place). Deliberately **not**
 * through `holding_valued`: that view drops closed accounts
 * (`0002_holding_valued.sql`), so it would answer "holds nothing" for a
 * closed brokerage full of securities — exactly the account a kind edit must
 * not relabel. Zero-quantity rows are invisible here, uniformly:
 * `revisePosition` stores a sold-out position as zero rather than dropping
 * the row, and a row asserting "none of this" is neither something a typed
 * balance would lose nor a balance with a direction to contradict.
 */
import { sql } from "kysely";

import { getDb, type Database } from "./db.server.ts";

import type { Kysely } from "kysely";

/** What an account's current statement holds, as a writer needs to see it. */
export type CurrentStatement = {
  /**
   * The seeded `USD` row — the instrument a typed balance writes. Null only on
   * an install whose initial migration has not run.
   */
  cashInstrumentId: string | null;
  /** The cash row's direction, or null when the statement has no non-zero cash row. */
  cashIsNegative: boolean | null;
  /** Everything else the statement lists, by instrument name, ordered by name. */
  others: string[];
};

/**
 * What an account holds now. One export, with the cash instrument a field of
 * its result rather than a function beside it: a caller resolving cash
 * separately would resolve it twice per write — two chances for the guard
 * and the write to disagree about which row "cash" means.
 *
 * @param accountId an id that has already resolved to an account row.
 */
export async function currentStatement(
  accountId: string,
  db: Kysely<Database> = getDb(),
): Promise<CurrentStatement> {
  // Both columns, because neither identifies the seeded row alone. `symbol`
  // is nullable and not unique (`instrument` in `0001_initial_schema.sql`),
  // and the upload flow's instruments step will create a second row carrying
  // `USD` with no warning (report ING-8). `price_source = 'fixed'` is not the
  // seeded row's alone either, whatever four comments in this repo claim:
  // `seed-demo.ts` files SPAXX — a money-market fund with 16,000 shares in it
  // — as `fixed`, and a reader taking `fixed` for "cash" would let a typed
  // balance sell it. Not `quote_type = 'CURRENCY'`, which `prices.server.ts`
  // overwrites from whatever the provider reports, while these two are never
  // written after the seed. `order by id` makes the answer specified rather
  // than lucky: where the conjunction stops being unique, the seeded row is
  // the older one.
  const cash = await db
    .selectFrom("instrument")
    .select("id")
    .where("symbol", "=", "USD")
    .where("price_source", "=", "fixed")
    .orderBy("id")
    .executeTakeFirst();

  const cashInstrumentId = cash?.id ?? null;

  // The sign is decided here, in `numeric`, and crosses back as a boolean:
  // money leaves the driver as a string (`server/db.ts`), so the alternative
  // is every caller reading a minus off a decimal string — and the first
  // `.server` module importing the display formatter to do it.
  const result = await sql<{ name: string; is_cash: boolean; is_negative: boolean }>`
    select
      i.name,
      coalesce(i.id = ${cashInstrumentId}::bigint, false) as is_cash,
      h.quantity < 0 as is_negative
    from holding h
    join instrument i on i.id = h.instrument_id
    where h.position_set_id = latest_position_set(${accountId}::bigint)
      and h.quantity <> 0
    order by i.name, i.id
  `.execute(db);

  const cashRow = result.rows.find((row) => row.is_cash);

  return {
    cashInstrumentId,
    cashIsNegative: cashRow === undefined ? null : cashRow.is_negative,
    others: result.rows.filter((row) => !row.is_cash).map((row) => row.name),
  };
}
