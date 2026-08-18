/**
 * What a fresh install still needs before it can hold anything.
 *
 * DESIGN.md §8.4: first run shows empty dashboards and a single prompt pointing
 * at Settings → People, then Accounts. The order is not a preference — an
 * account has a `not null` owner, so there is genuinely nothing to do first.
 *
 * This is one question with three answers rather than two booleans on the
 * screen, so the prompt cannot render both steps at once or neither when both
 * apply.
 */
import { getDb, type Database } from "./db.server.ts";

import type { Kysely } from "kysely";

/**
 * The next thing to do, or null once the instance is set up.
 *
 * "Set up" means one person and one account. Not one upload: an instance with
 * accounts and no statements is a correctly configured instance waiting for its
 * first upload, and nagging about it would make the prompt permanent for anyone
 * who set up on a Sunday.
 */
export type FirstRunStep = "people" | "accounts" | null;

/**
 * One round trip, asking only whether a row exists.
 *
 * `exists` rather than `count`: the answer is a boolean, the tables can grow,
 * and this runs on every page render.
 *
 * @param db a handle to read through. Defaults to the process-wide one; tests
 *           pass a transaction they roll back.
 */
export async function firstRunStep(db: Kysely<Database> = getDb()): Promise<FirstRunStep> {
  const row = await db
    .selectNoFrom((eb) => [
      eb.exists(eb.selectFrom("person").select("person.id").limit(1)).as("has_person"),
      eb.exists(eb.selectFrom("account").select("account.id").limit(1)).as("has_account"),
    ])
    .executeTakeFirstOrThrow();

  if (!row.has_person) return "people";
  if (!row.has_account) return "accounts";
  return null;
}
