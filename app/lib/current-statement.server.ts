// Current statement of an account (not statement.ts's parsed-CSV rows). Own module because
// balances.server.ts and accounts.server.ts both need this before writing, and it stays a leaf
// (imports only db.server.ts) so neither writer risks a cycle.
//
// Reads through latest_position_set (DESIGN.md §8.2), not holding_valued: that view drops closed
// accounts, which would wrongly answer "holds nothing" for a closed brokerage full of securities.
// Zero-quantity rows (sold out, per revisePosition) are invisible here too, same as a real absence.
import { sql } from "kysely";

import { getDb, type Database } from "./db.server.ts";

import type { Kysely } from "kysely";

export type CurrentStatement = {
  // The seeded USD row. Null only if the initial migration hasn't run.
  cashInstrumentId: string | null;
  // Direction of the cash row, or null when there's no non-zero cash row.
  cashIsNegative: boolean | null;
  others: string[];
};

// Cash instrument is a field of the result, not resolved separately, so a caller can't disagree
// with the write about which row "cash" means.
export async function currentStatement(
  accountId: string,
  db: Kysely<Database> = getDb(),
): Promise<CurrentStatement> {
  // symbol is nullable+non-unique, and price_source='fixed' isn't unique to the seed row either
  // (seed-demo.ts also files SPAXX as fixed) — order by id picks the older (seeded) row on ties.
  const cash = await db
    .selectFrom("instrument")
    .select("id")
    .where("symbol", "=", "USD")
    .where("price_source", "=", "fixed")
    .orderBy("id")
    .executeTakeFirst();

  const cashInstrumentId = cash?.id ?? null;

  // Decide the sign here as a boolean; numeric otherwise leaves the driver as a string to parse.
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
