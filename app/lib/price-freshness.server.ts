/**
 * The as-of line every screen shows: read from `holding_valued`, never written
 * (ARCHITECTURE.md §4.2's valuation exceptions).
 */
import { sql } from "kysely";

import { getDb, type Database } from "./db.server.ts";
import { marketStampOf } from "./market-hours.ts";

import type { Kysely } from "kysely";

/** Oldest `as_of` among priced holdings (§11): the newest hides one failing for a week. */
export async function priceFreshness(
  db: Kysely<Database> = getDb(),
): Promise<{ oldest: Date | null; stale: number; priced: number }> {
  const row = await db
    .selectFrom("holding_valued")
    .innerJoin("quote", "quote.instrument_id", "holding_valued.instrument_id")
    // `fixed` would pin `oldest` to the install timestamp forever.
    .where("holding_valued.price_source", "=", "feed")
    .select([
      sql<Date | null>`min(quote.as_of)`.as("oldest"),
      sql<string>`count(distinct holding_valued.instrument_id) filter (where holding_valued.is_stale)`.as(
        "stale",
      ),
      sql<string>`count(distinct holding_valued.instrument_id)`.as("priced"),
    ])
    .executeTakeFirst();

  return {
    oldest: row?.oldest ?? null,
    // Cardinalities, not money — `Number` is safe here.
    stale: Number(row?.stale ?? 0),
    priced: Number(row?.priced ?? 0),
  };
}

/** The as-of caption in one place — every screen must answer it the same way. */
export async function asOfView(
  marketTimeZone: string,
  db: Kysely<Database> = getDb(),
): Promise<{ stamp: string | null; stale: number }> {
  const { oldest, stale } = await priceFreshness(db);

  return { stamp: oldest === null ? null : marketStampOf(oldest, marketTimeZone), stale };
}
