/**
 * Recording who is in the household.
 *
 * Driven through `people.server.ts` against a real Postgres, seeded through the
 * fixture builder — the same seam the valuation tests use. Nothing here asserts
 * on a route, on rendered markup or on generated SQL: what is being protected is
 * that the module every screen writes through keeps its own rules, so a second
 * caller cannot get a different answer than the People screen does.
 */
import { afterAll, describe, expect, it } from "vitest";

import { NotFoundError, ValidationError } from "~/lib/input.server";
import { createPerson, listPeople, removePerson, renamePerson } from "~/lib/people.server";

import { closeTestDatabase, withDatabase } from "./support/database.ts";

afterAll(closeTestDatabase);

/** The field messages from a refusal, or a failure if it was not refused. */
async function refusalOf(action: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await action;
  } catch (error) {
    if (error instanceof ValidationError) return { ...error.fieldErrors };
    throw error;
  }
  throw new Error("expected the input to be refused");
}

describe("recording people", () => {
  it(
    "records a person by name and lists them",
    withDatabase(async ({ db }) => {
      await createPerson({ name: "Alice" }, db);

      expect((await listPeople(db)).map((person) => person.name)).toEqual(["Alice"]);
    }),
  );

  it(
    "lists everyone, in a stable order",
    withDatabase(async ({ db }) => {
      await createPerson({ name: "Bea" }, db);
      await createPerson({ name: "Alice" }, db);
      await createPerson({ name: "Cal" }, db);

      expect((await listPeople(db)).map((person) => person.name)).toEqual([
        "Alice",
        "Bea",
        "Cal",
      ]);
    }),
  );

  it(
    "lets two people share a name, because two people can",
    withDatabase(async ({ db }) => {
      await createPerson({ name: "Alex Kim" }, db);
      await createPerson({ name: "Alex Kim" }, db);

      const people = await listPeople(db);
      expect(people).toHaveLength(2);
      // Distinct rows, so an account can belong to one of them and not the other.
      expect(people[0]?.id).not.toBe(people[1]?.id);
    }),
  );

  it(
    "corrects a typo rather than leaving it permanent",
    withDatabase(async ({ db }) => {
      const person = await createPerson({ name: "Alcie" }, db);

      const renamed = await renamePerson(person.id, { name: "Alice" }, db);

      expect(renamed).toMatchObject({ id: person.id, name: "Alice" });
      expect((await listPeople(db)).map((p) => p.name)).toEqual(["Alice"]);
    }),
  );

  it(
    "trims what was typed, so a stray space is not part of the name",
    withDatabase(async ({ db }) => {
      const person = await createPerson({ name: "  Alice  " }, db);

      expect(person.name).toBe("Alice");
    }),
  );
});

describe("refusing bad input", () => {
  // One table rather than five transactions: these are `requiredText`'s rules,
  // and what `createPerson` adds to them is the same on every row.
  it.each([
    ["an empty name", { name: "" }, /name is required/i],
    ["a name that is only whitespace", { name: "   " }, /required/i],
    // A form that never sent the field at all is the same mistake to a person
    // as one that sent it blank, and must not be a 500.
    ["a field that never arrived", {}, /required/i],
    ["a name too long to be one", { name: "a".repeat(121) }, /120 characters/],
  ])("refuses %s", (_case, input, message) =>
    withDatabase(async ({ db }) => {
      const errors = await refusalOf(createPerson(input, db));

      expect(errors.name).toMatch(message);
      // Under `name`, and under nothing else, so the form can put the message
      // beside the box rather than at the top of the page.
      expect(Object.keys(errors)).toEqual(["name"]);
    })(),
  );

  it(
    "writes nobody when it refuses",
    withDatabase(async ({ db }) => {
      // The half this cannot be a pure test for: a refusal that still inserted
      // would leave a person nobody typed.
      await refusalOf(createPerson({ name: "" }, db));

      expect(await listPeople(db)).toEqual([]);
    }),
  );

  it(
    "refuses to rename somebody who does not exist",
    withDatabase(async ({ db }) => {
      await expect(renamePerson("999999", { name: "Nobody" }, db)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    }),
  );

  it(
    "refuses to remove somebody who does not exist",
    withDatabase(async ({ db }) => {
      await expect(removePerson("999999", db)).rejects.toBeInstanceOf(NotFoundError);
    }),
  );
});

describe("removing a person", () => {
  it(
    "removes someone who owns nothing",
    withDatabase(async ({ db }) => {
      const person = await createPerson({ name: "Alice" }, db);

      await removePerson(person.id, db);

      expect(await listPeople(db)).toEqual([]);
    }),
  );

  it(
    "counts the accounts a person owns, so the list can say so before the click",
    withDatabase(async ({ db, seedPerson, seedAccount }) => {
      const owner = await seedPerson({ name: "Alice" });
      await seedAccount({ owner });
      await seedAccount({ owner });
      await createPerson({ name: "Bea" }, db);

      const [alice, bea] = await listPeople(db);
      expect(alice).toMatchObject({ name: "Alice", accountCount: 2 });
      expect(bea).toMatchObject({ name: "Bea", accountCount: 0 });
    }),
  );
});
