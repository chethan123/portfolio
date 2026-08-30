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
 *
 * Every exported query takes an optional `db` handle: it defaults to the
 * process-wide one, and tests pass a transaction they roll back.
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
  /**
   * Accounts owned that are still open — which is what decides whether this
   * person can be an *owner* the screens are readable as (spec 0013).
   *
   * A second count rather than a narrowing of the first, because
   * {@link removePerson} depends on `accountCount` meaning open and closed
   * alike: a person whose accounts have all been closed still cannot be
   * removed, and a count that had quietly stopped seeing them would let the
   * delete through. Both come out of the one query the People screen already
   * pays for.
   */
  openAccountCount: number;
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
 */
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
   * The selection names exactly everybody, which is the household under another
   * name — and the household's URL carries no owner parameter at all (ADR-0008).
   * The screens bounce to it, because a `<Form method="get">` of checkboxes has
   * no way to decline to submit the spelling in the first place.
   *
   * **Everybody in the household, not everybody the control can draw.** The
   * distinction is load-bearing where somebody owns only closed accounts: they
   * are not in {@link OwnerRoster.people}, so ticking every box a reader can
   * see names the whole roster and *not* the whole household — and the two read
   * differently on every past date, because `holding_valued_at` admits an
   * account closed after that date and `firstRecordedDate` spans closed
   * accounts outright. Collapsing that selection would hand back a chart
   * carrying the history the reader had just excluded, under an identical
   * headline, with nothing on screen to tell the two apart.
   *
   * Read against the selection rather than against {@link narrowedTo}, which is
   * drawn from the roster and so can never name such an owner — a selection
   * that *does* name them is the household and must still collapse. That is
   * also why this and {@link unknownOwner} can both be true at once, of a
   * selection naming a closed-out owner and everybody else: every screen
   * redirects on this one first, so the pair is resolved before either is read.
   */
  coversEveryone: boolean;
};

/**
 * The roster, read once, with the selection resolved against it.
 *
 * Every screen that draws the control asks the same two questions of the same
 * roster — which ids name nobody it can filter by, and whether the selection is
 * simply everybody — and a rule each loader spelled for itself would be one
 * free to drift on a screen nobody was looking at.
 *
 * The roster is owners of at least one **open** account, because
 * `holding_valued` excludes closed ones: selecting somebody whose accounts have
 * all been closed would empty every screen with no explanation. Leaving them
 * out instead makes their id one the roster does not name, which is the state
 * the screens already have a sentence for. The cost is stated rather than
 * hidden — their history is not reachable through the filter at all, even
 * though `firstRecordedDate` can still see it — and DESIGN.md §14 records it.
 */
export async function ownerRoster(
  owners: OwnerFilter,
  db: Kysely<Database> = getDb(),
): Promise<OwnerRoster> {
  // One read, two questions. `household` is who exists at all; `people` is who
  // the control can offer, which is the subset owning an open account. Both
  // come off the query the People screen already pays for, rather than a second
  // one free to disagree with the first.
  const household = await listPeople(db);
  const people = household.filter((person) => person.openAccountCount > 0);
  const narrowedTo = people.filter((person) => owners.includes(person.id));

  return {
    people,
    narrowedTo,
    unknownOwner: owners.length > narrowedTo.length,
    // Every person recorded is named, and nothing else is. Both halves: without
    // the second, "Alice and somebody who no longer exists" is as long as a
    // two-person household and would collapse to it, hiding the one state that
    // exists to say a stale address is stale.
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
