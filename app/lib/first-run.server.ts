// First-run prompt: people then accounts. DESIGN.md §8.4.
import { getDb, type Database } from "./db.server.ts";

import type { Kysely } from "kysely";

// null once 1 person + 1 account exist; no upload needed to close the prompt.
export type FirstRunStep = "people" | "accounts" | null;

// exists not count: boolean answer, runs every render, tables grow unbounded.
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
