/**
 * The statement an account currently has, at the one grain a typed balance
 * needs — its cash row's direction, and everything else it lists.
 *
 * Not `statement.ts`, which turns an uploaded CSV into rows. This reads what an
 * account holds *now*, and it is its own module because two writers need the
 * same answer and neither can own it: `balances.server.ts` before it replaces a
 * whole statement with one cash row, and `accounts.server.ts` before it
 * relabels an account as one whose entire position is a single balance. Both
 * used to decide from `account.kind` alone, and `kind` is a label — one
 * settings form away from being wrong about the rows it describes (report
 * `SET-1`).
 *
 * A leaf, deliberately: it imports the database handle and nothing else in
 * `app/lib`, so neither writer can reach for it and find a cycle. That is also
 * why the answer is not assembled from the two modules that already read
 * positions — `valuation.server.ts:1-3` defines itself as the only thing that
 * reads `holding_valued`, and this reader must not.
 *
 * Resolved through `latest_position_set`, like every other reader of "current"
 * (DESIGN.md §8.2 — the tie-break exists in one place and every reader goes
 * through it). Deliberately **not** through `holding_valued`: that view drops
 * closed accounts (`0002_holding_valued.sql:140`), so it would answer "holds
 * nothing" for a closed brokerage full of securities — exactly the account a
 * kind edit must not be allowed to relabel.
 *
 * Zero-quantity rows are invisible here, uniformly. `revisePosition` stores a
 * sold-out position as zero rather than dropping the row
 * (`positions.server.ts:31-36`), and a row asserting "none of this" is neither
 * something a typed balance would lose nor a balance with a direction to
 * contradict.
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
 * What an account holds now.
 *
 * One export, and the cash instrument is a field of its result rather than a
 * function beside it: a caller that resolved cash separately would resolve it
 * twice per write, and two resolutions are two chances for the guard and the
 * write to disagree about which row "cash" means.
 *
 * @param accountId an id that has already resolved to an account row.
 */
export async function currentStatement(
  accountId: string,
  db: Kysely<Database> = getDb(),
): Promise<CurrentStatement> {
  // Both columns, because neither identifies the seeded row alone. `symbol` is
  // nullable and not unique (`0001_initial_schema.sql:93,113`), and the upload
  // flow's instruments step will create a second row carrying `USD` with no
  // warning (report `ING-8`). `price_source = 'fixed'` is not the seeded row's
  // alone either, whatever four comments in this repo claim: `seed-demo.ts:209`
  // files SPAXX — a money-market fund with 16,000 shares in it — as `fixed`,
  // and a reader that took `fixed` for "cash" would call that account cash-only
  // and let a typed balance sell it. Not `quote_type = 'CURRENCY'`, which
  // `prices.server.ts:302` overwrites from whatever the provider reports, while
  // these two are never written after the seed.
  //
  // `order by id` is what makes the answer specified rather than lucky: the
  // conjunction is unique in every state tested, and where it stops being
  // unique the seeded row is the older one.
  const cash = await db
    .selectFrom("instrument")
    .select("id")
    .where("symbol", "=", "USD")
    .where("price_source", "=", "fixed")
    .orderBy("id")
    .executeTakeFirst();

  const cashInstrumentId = cash?.id ?? null;

  // The sign is decided here, in `numeric`, and crosses back as a boolean.
  // Money leaves the driver as a string (`server/db.ts`), so the alternative is
  // every caller reading a minus off a decimal string — and `accounts.server.ts`
  // would be the first `.server` module to import the display formatter to do
  // it.
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
