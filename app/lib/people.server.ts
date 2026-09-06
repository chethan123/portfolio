// People in the household (DESIGN.md §4.2, §8.4). No soft delete: removePerson (below) refuses
// while any account still names them, turning `on delete restrict` into a readable message.
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

// accountCount is on the read so Settings can say "cannot be removed" beside the name, not after
// the click.
export type Person = {
  id: string;
  name: string;
  // Open and closed accounts alike.
  accountCount: number;
  // Open accounts only — decides whether this person can be an owner (spec 0013). A second count,
  // not a narrowing of accountCount: removePerson needs the closed-inclusive one too.
  openAccountCount: number;
};

// No email/login/role — a label for whose money it is, not a user account (DESIGN.md §10).
// Names aren't unique: two people can genuinely share one.
export const personInput = z.object({
  name: requiredText("A name", 120),
});

export type PersonInput = z.infer<typeof personInput>;

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

export type OwnerRoster = {
  people: Person[];
  // Who the selection actually names — empty when the filter is off.
  narrowedTo: Person[];
  // Selection names an id the roster doesn't: hand-typed, removed, or all-closed owner.
  unknownOwner: boolean;
  // True selection = the whole household (ADR-0008's no-owner-param URL), not just `people`:
  // a closed-out owner is absent from `people`, so ticking every visible box names the roster,
  // not the household, and the two disagree on past dates (holding_valued_at admits closed
  // accounts). Checked against the raw selection, not narrowedTo (which can never name such an
  // owner) — so this and unknownOwner can both be true; screens redirect on this one first.
  coversEveryone: boolean;
};

// Roster = owners of >=1 open account (holding_valued excludes closed ones); selecting a
// closed-out owner would otherwise empty every screen with no explanation. Cost — their history
// unreachable through the filter — is accepted in DESIGN.md §14.
export async function ownerRoster(
  owners: OwnerFilter,
  db: Kysely<Database> = getDb(),
): Promise<OwnerRoster> {
  const household = await listPeople(db);
  const people = household.filter((person) => person.openAccountCount > 0);
  const narrowedTo = people.filter((person) => owners.includes(person.id));

  return {
    people,
    narrowedTo,
    unknownOwner: owners.length > narrowedTo.length,
    coversEveryone:
      household.length > 0 &&
      owners.length === household.length &&
      household.every((person) => owners.includes(person.id)),
  };
}

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

// Counts closed accounts too, not just open: a closed account still values every date before
// it closed (§7) and can't with its owner deleted. Way out is reassigning the owner.
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
