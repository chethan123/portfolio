/**
 * What a fresh install still needs before it can hold anything. DESIGN.md
 * §8.4: first run shows empty dashboards and one prompt pointing at
 * Settings → People, then Accounts — not a preference: an account has a
 * `not null` owner, so there is genuinely nothing else to do first. One
 * question with three answers rather than two booleans, so the prompt cannot
 * render both steps at once or neither when both apply. Every exported query
 * takes an optional `db`; tests pass a rolled-back transaction.
 */
import { getDb, type Database } from "./db.server.ts";

import type { Kysely } from "kysely";

/**
 * The next thing to do, or null once set up — meaning one person and one
 * account. Not one upload: an instance with accounts and no statements is
 * correctly configured and waiting, and nagging about it would make the
 * prompt permanent for anyone who set up on a Sunday.
 */
export type FirstRunStep = "people" | "accounts" | null;

/**
 * One round trip. `exists` rather than `count`: the answer is a boolean, the
 * tables can grow, and this runs on every page render.
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
