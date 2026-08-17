/**
 * The people in the household — DESIGN.md §4.2, §8.4.
 *
 * The first thing a fresh install needs, because ownership attaches to a person
 * and an account cannot exist without an owner. This module both reads and
 * writes: the Settings screens call in here, and the routes above it only
 * translate a form into arguments and an error into a message.
 *
 * There is no soft delete. A person is either recorded or not, and the one rule
 * that makes that safe is {@link removePerson} refusing while any account still
 * names them — the schema's `on delete restrict` says the same thing, and this
 * module is what turns it into a sentence instead of a constraint violation.
 */
import { z } from "zod";

import { getDb, type Database } from "./db.server.ts";
import { NotFoundError, ValidationError, parseInput, requiredText } from "./input.server.ts";

import type { Kysely } from "kysely";

/**
 * One member of the household.
 *
 * `accountCount` is on the read because the Settings list uses it to explain
 * itself: a person who owns accounts cannot be removed, and saying so beside
 * the name beats a refusal that only appears after the click.
 */
export type Person = {
  id: string;
  name: string;
  /** Accounts owned, open and closed alike. */
  accountCount: number;
};

/**
 * A name and nothing else. There is no email, no login and no role: this is a
 * label for whose money it is, not a user account (DESIGN.md §10).
 *
 * Names are deliberately not unique. Two households in one instance could
 * genuinely hold two people with the same name, and a uniqueness rule invented
 * here would be a constraint the schema does not have.
 */
export const personInput = z.object({
  name: requiredText("A name", 120),
});

export type PersonInput = z.infer<typeof personInput>;

/**
 * Everyone in the household, in the order a list should show them.
 *
 * @param db a handle to read through. Defaults to the process-wide one; tests
 *           pass a transaction they roll back.
 */
export async function listPeople(db: Kysely<Database> = getDb()): Promise<Person[]> {
  const rows = await db
    .selectFrom("person")
    .leftJoin("account", "account.owner_id", "person.id")
    .select(({ fn }) => [
      "person.id",
      "person.name",
      fn.count<string>("account.id").as("account_count"),
    ])
    .groupBy(["person.id", "person.name"])
    // By name for a stable, readable list; by id to break the tie between two
    // people who genuinely share one.
    .orderBy("person.name")
    .orderBy("person.id")
    .execute();

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    // A cardinality of a household's accounts, not money — `Number` is safe
    // here in a way it never is on a `numeric` column.
    accountCount: Number(row.account_count),
  }));
}

/**
 * Record a person.
 *
 * @param raw the submitted fields, unvalidated. Validating here rather than in
 *            the route is what keeps a second caller from skipping the rules.
 * @throws {ValidationError} with a message per bad field.
 */
export async function createPerson(
  raw: unknown,
  db: Kysely<Database> = getDb(),
): Promise<Person> {
  const input = parseInput(personInput, raw);

  const row = await db
    .insertInto("person")
    .values({ name: input.name })
    .returning(["id", "name"])
    .executeTakeFirstOrThrow();

  return { id: row.id, name: row.name, accountCount: 0 };
}

/**
 * Correct a name, so a typo is not permanent.
 *
 * @throws {ValidationError} with a message per bad field.
 * @throws {NotFoundError} when no such person exists.
 */
export async function renamePerson(
  id: string,
  raw: unknown,
  db: Kysely<Database> = getDb(),
): Promise<Person> {
  const input = parseInput(personInput, raw);

  const row = await db
    .updateTable("person")
    .set({ name: input.name })
    .where("id", "=", id)
    .returning(["id", "name"])
    .executeTakeFirst();

  if (row === undefined) throw new NotFoundError(`No person with id ${id}.`);

  return { ...(await countedPerson(row, db)) };
}

/**
 * Remove a person, unless anything still points at them.
 *
 * The refusal is the point. `account.owner_id` is `on delete restrict`, so the
 * database would refuse this anyway — as a constraint violation naming a
 * foreign key, which tells a family member nothing. Reading the accounts first
 * turns that into a sentence naming them, and it deliberately counts closed
 * accounts too: a closed account still values correctly on every date before it
 * closed (DESIGN.md §7), and it cannot do that with its owner deleted.
 *
 * Since accounts are never deleted — closing is the only retirement there is —
 * the way out is always to change the owner on those accounts.
 *
 * @throws {ValidationError} naming the accounts that block the removal.
 * @throws {NotFoundError} when no such person exists.
 */
export async function removePerson(
  id: string,
  db: Kysely<Database> = getDb(),
): Promise<void> {
  const person = await db
    .selectFrom("person")
    .select(["id", "name"])
    .where("id", "=", id)
    .executeTakeFirst();

  if (person === undefined) throw new NotFoundError(`No person with id ${id}.`);

  const owned = await db
    .selectFrom("account")
    .select(["name", "closed_at"])
    .where("owner_id", "=", id)
    .orderBy("name")
    .execute();

  if (owned.length > 0) {
    const names = owned.map((account) =>
      account.closed_at === null ? account.name : `${account.name} (closed)`,
    );

    throw ValidationError.form(
      `${person.name} still owns ${listSentence(names)}. ` +
        "Change the owner on those accounts first — accounts are never deleted, only closed.",
    );
  }

  await db.deleteFrom("person").where("id", "=", id).execute();
}

/** "A", "A and B", "A, B and C" — a refusal reads as a sentence, not a dump. */
function listSentence(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Re-read the account count for a person a write has just returned. */
async function countedPerson(
  person: { id: string; name: string },
  db: Kysely<Database>,
): Promise<Person> {
  const row = await db
    .selectFrom("account")
    .select(({ fn }) => fn.count<string>("id").as("account_count"))
    .where("owner_id", "=", person.id)
    .executeTakeFirstOrThrow();

  return { id: person.id, name: person.name, accountCount: Number(row.account_count) };
}
