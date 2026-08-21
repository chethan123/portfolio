/**
 * Resolving a statement's instrument strings against the alias table
 * (DESIGN.md §4.3, spec 0004). Step 04 builds the screen that answers a miss
 * and the writes that remember the answer; what lives here already is the
 * question both the columns step and the resume redirect have to ask — which
 * strings has nobody ever resolved?
 *
 * Lookup is **byte-exact**, which is `instrument_alias.raw_string`'s
 * `collate "C"` doing its job: no trimming, no case folding, no heuristics. A
 * respelling is rightly a first sighting even when the instrument is old
 * news, because a heuristic that "helpfully" merged two near-identical
 * strings would attach a holding to the wrong fund silently — a miss prompts
 * once and is remembered permanently instead.
 */
import { getDb, type Database } from "./db.server.ts";

import type { Kysely } from "kysely";

/**
 * The distinct strings with no `instrument_alias` row behind them, in
 * first-appearance order — the order the unresolved screen asks its
 * questions in, which is the order the file raised them.
 */
export async function unresolvedStrings(
  strings: readonly string[],
  db: Kysely<Database> = getDb(),
): Promise<string[]> {
  const distinct: string[] = [];
  const seen = new Set<string>();
  for (const value of strings) {
    if (!seen.has(value)) {
      seen.add(value);
      distinct.push(value);
    }
  }

  if (distinct.length === 0) return [];

  const rows = await db
    .selectFrom("instrument_alias")
    .select("raw_string")
    .where("raw_string", "in", distinct)
    .execute();

  const resolved = new Set(rows.map((row) => row.raw_string));
  return distinct.filter((value) => !resolved.has(value));
}
