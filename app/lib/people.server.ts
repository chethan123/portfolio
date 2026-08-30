/**
 * The people in the household (DESIGN.md §4.2, §8.4) — the first thing a
 * fresh install needs, since ownership attaches to a person. Reads and writes
 * both; the routes above only translate. There is no soft delete: a person is
 * recorded or not, made safe by {@link removePerson} refusing while any
 * account still names them — the schema's `on delete restrict` turned into a
 * sentence instead of a constraint violation.
 *
 * Every exported query takes an optional `db`; tests pass a transaction they
 * roll back.
 */
import { z } from "zod";

import { getDb, type Database } from "./db.server.ts";
import type { OwnerFilter } from "./owner-filter.ts";
import {
  NotFoundError,
  ValidationError,
  listSentence,
  parseInput,
  requiredText,
} from "./input.server.ts";

import type { Kysely } from "kysely";

/**
 * One member of the household. `accountCount` is on the read because the
 * Settings list explains itself with it: saying "cannot be removed" beside
 * the name beats a refusal that only appears after the click.
 */
export type Person = {
  id: string;
  name: string;
  /** Accounts owned, open and closed alike. */
  accountCount: number;
  /**
   * Open accounts owned — what decides whether this person can be an *owner*
   * the screens are readable as (spec 0013). A second count, not a narrowing:
   * {@link removePerson} depends on `accountCount` meaning open and closed
   * alike, and a count that quietly stopped seeing closed ones would let the
   * delete through. Both come out of the one query already paid for.
   */
  openAccountCount: number;
};

/**
 * A name and nothing else — no email, login or role: a label for whose money
 * it is, not a user account (DESIGN.md §10). Names are deliberately not
 * unique: two people can genuinely share one, and a uniqueness rule invented
 * here would be a constraint the schema does not have.
 */
export const personInput = z.object({
  name: requiredText("A name", 120),
});

export type PersonInput = z.infer<typeof personInput>;

/** Everyone in the household, in the order a list should show them. */
export async function listPeople(db: Kysely<Database> = getDb()): Promise<Person[]> {
  const rows = await db
    .selectFrom("person")
    .leftJoin("account", "account.owner_id", "person.id")
    .select(({ fn }) => [
      "person.id",
      "person.name",
      fn.count<string>("account.id").as("account_count"),
      fn
        .count<string>("account.id")
        .filterWhere("account.closed_at", "is", null)
        .as("open_account_count"),
    ])
    .groupBy(["person.id", "person.name"])
    // Name for a readable list; id to break the tie between two who share one.
    .orderBy("person.name")
    .orderBy("person.id")
    .execute();

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    // Cardinalities, not money — `Number` is safe here.
    accountCount: Number(row.account_count),
    openAccountCount: Number(row.open_account_count),
  }));
}

/** The roster a screen draws its control from, and what a selection makes of it. */
export type OwnerRoster = {
  /** Everyone the household can be read as, in the order to draw them. */
  people: Person[];
  /** Who the selection actually names — empty when the filter is off. */
  narrowedTo: Person[];
  /**
   * The selection names an id the roster does not: hand-typed, naming somebody
   * removed, or naming an owner whose accounts have all been closed. One
   * sentence and one fix to a reader, so one flag.
   */
  unknownOwner: boolean;
  /**
   * The selection names exactly everybody — the household under another name,
   * whose URL carries no owner parameter (ADR-0008); the screens bounce to
   * it, since a GET form of checkboxes cannot decline to submit the spelling.
   *
   * **Everybody in the household, not everybody the control can draw** —
   * load-bearing where somebody owns only closed accounts: they are absent
   * from {@link OwnerRoster.people}, so ticking every visible box names the
   * roster and *not* the household, and the two read differently on every
   * past date (`holding_valued_at` admits closed accounts). Collapsing that
   * selection would hand back the very history the reader excluded, under an
   * identical headline. Read against the selection, not {@link narrowedTo}
   * (drawn from the roster, so it can never name such an owner) — also why
   * this and {@link unknownOwner} can both be true at once; every screen
   * redirects on this one first.
   */
  coversEveryone: boolean;
};

/**
 * The roster, read once, with the selection resolved against it — every
 * screen asks the same two questions, and a rule each loader spelled itself
 * would drift on a screen nobody was looking at. The roster is owners of at
 * least one **open** account, because `holding_valued` excludes closed ones:
 * selecting a closed-out owner would empty every screen with no explanation,
 * where an id the roster does not name is a state the screens already have a
 * sentence for. The cost — their history unreachable through the filter — is
 * recorded in DESIGN.md §14 rather than hidden.
 */
export async function ownerRoster(
  owners: OwnerFilter,
  db: Kysely<Database> = getDb(),
): Promise<OwnerRoster> {
  // One read, two questions: `household` is who exists at all; `people` is
  // who the control can offer. Both off the query the People screen pays for.
  const household = await listPeople(db);
  const people = household.filter((person) => person.openAccountCount > 0);
  const narrowedTo = people.filter((person) => owners.includes(person.id));

  return {
    people,
    narrowedTo,
    unknownOwner: owners.length > narrowedTo.length,
    // Both halves: without the second, "Alice and somebody removed" is as
    // long as a two-person household and would collapse to it, hiding the one
    // state that says a stale address is stale.
    coversEveryone:
      household.length > 0 &&
      owners.length === household.length &&
      household.every((person) => owners.includes(person.id)),
  };
}

/**
 * Record a person.
 *
 * @param raw the submitted fields, unvalidated.
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

  // A person just created owns nothing, open or closed.
  return { id: row.id, name: row.name, accountCount: 0, openAccountCount: 0 };
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
 * Remove a person, unless anything still points at them. The refusal is the
 * point: `on delete restrict` would refuse anyway — as a constraint violation
 * naming a foreign key, which tells a family member nothing. Reading the
 * accounts first turns it into a sentence, and deliberately counts closed
 * ones too: a closed account still values every date before it closed (§7),
 * and cannot with its owner deleted. The way out is always to change the
 * owner on those accounts.
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

/** Re-read the account counts for a person a write has just returned. */
async function countedPerson(
  person: { id: string; name: string },
  db: Kysely<Database>,
): Promise<Person> {
  const row = await db
    .selectFrom("account")
    .select(({ fn }) => [
      fn.count<string>("id").as("account_count"),
      fn.count<string>("id").filterWhere("closed_at", "is", null).as("open_account_count"),
    ])
    .where("owner_id", "=", person.id)
    .executeTakeFirstOrThrow();

  return {
    id: person.id,
    name: person.name,
    accountCount: Number(row.account_count),
    openAccountCount: Number(row.open_account_count),
  };
}
