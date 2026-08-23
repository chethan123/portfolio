/**
 * The accounts the household holds — DESIGN.md §4.1, §4.2, §4.5, §8.4.
 *
 * This is what gives a statement somewhere to land: an account is the thing an
 * upload attaches a position set to, and the thing every valuation groups by.
 * Like `people.server.ts`, it both reads and writes, and the routes above it
 * only translate.
 *
 * Three decisions from the design show up directly in this module:
 *
 *   * **An account has exactly one owner** (§4.2). Joint accounts are not
 *     modelled, and a workplace plan holding both Traditional and Roth money is
 *     two accounts at the same institution with different tax treatments — which
 *     needs no support here beyond not forbidding it.
 *   * **Tax treatment is three-way, never a boolean** (§4.5). $500k in a
 *     Traditional IRA is roughly $350k of spending power while $500k in a Roth
 *     is $500k.
 *   * **Nothing is ever deleted.** {@link closeAccount} is the only retirement
 *     there is, and it sets a date rather than removing rows, because the
 *     account's history has to keep valuing correctly on every date before it
 *     closed (§7). There is no delete function here and no delete affordance
 *     anywhere above it.
 *
 * What "closed" then means for a figure is not this module's rule to state:
 * `holding_valued` excludes closed accounts and `holding_valued_at` includes
 * them for dates before `closed_at`, and both live in SQL where every consumer
 * gets the same answer (DESIGN.md §8.2).
 *
 * Every exported query takes an optional `db` handle: it defaults to the
 * process-wide one, and tests pass a transaction they roll back.
 */
import { z } from "zod";

import { accountKindValues, taxTreatmentValues } from "./account-options.ts";
import { getDb, type Database } from "./db.server.ts";
import {
  NotFoundError,
  ValidationError,
  optionalText,
  parseInput,
  requiredText,
} from "./input.server.ts";

import type { AccountKind, TaxTreatment } from "./valuation.server.ts";
import type { Kysely } from "kysely";

/** One account, with its owner's name already resolved for display. */
export type Account = {
  id: string;
  name: string;
  institution: string;
  kind: AccountKind;
  ownerId: string;
  ownerName: string;
  taxTreatment: TaxTreatment;
  /** Recorded from a statement so an upload can pre-select this account. */
  externalAccountNumber: string | null;
  /**
   * When this account stopped being used, or null while it is open. A genuine
   * instant, left as the driver returns it — `timestamptz` is not a calendar
   * date and is not subject to the date-as-string rule (see `server/db.ts`).
   */
  closedAt: Date | null;
  isClosed: boolean;
};

/**
 * What a form must supply to create or edit an account.
 *
 * Kind, tax treatment and owner are required — they are the three things a
 * later figure cannot be computed without, and guessing any of them would put a
 * wrong number on a screen rather than an obvious gap. Institution and the
 * external account number are free text: an institution the app has never heard
 * of is a normal thing to own an account at.
 */
export const accountInput = z.object({
  name: requiredText("An account name", 120),

  // Optional, unlike the schema column, which is `not null`. A family member
  // recording "Mortgage" before they remember which servicer holds it should
  // not be blocked; the column stores the empty string and the screen shows a
  // dash. What must never be blank is what a figure depends on, below.
  institution: optionalText("An institution", 120),

  kind: z.enum(accountKindValues, { message: "Choose what kind of account this is." }),

  ownerId: z
    .string({ message: "Choose an owner." })
    // Ids cross the boundary as strings (`server/db.ts`); anything that is not
    // digits would reach Postgres as a malformed bigint and fail as a 500
    // rather than as a message on the form.
    .regex(/^\d+$/, { message: "Choose an owner." }),

  taxTreatment: z.enum(taxTreatmentValues, { message: "Choose a tax treatment." }),

  externalAccountNumber: optionalText("An account number", 64),
});

export type AccountInput = z.infer<typeof accountInput>;

type AccountRow = {
  id: string;
  name: string;
  institution: string;
  kind: string;
  owner_id: string;
  owner_name: string;
  tax_treatment: string;
  external_account_number: string | null;
  closed_at: Date | null;
};

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    institution: row.institution,
    // Safe because the schema's check constraints are what the database will
    // and will not store; the same reasoning as `valuation.server.ts`.
    kind: row.kind as AccountKind,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    taxTreatment: row.tax_treatment as TaxTreatment,
    externalAccountNumber: row.external_account_number,
    closedAt: row.closed_at,
    isClosed: row.closed_at !== null,
  };
}

const selectAccounts = (db: Kysely<Database>) =>
  db
    .selectFrom("account")
    .innerJoin("person", "person.id", "account.owner_id")
    .select([
      "account.id",
      "account.name",
      "account.institution",
      "account.kind",
      "account.owner_id",
      "person.name as owner_name",
      "account.tax_treatment",
      "account.external_account_number",
      "account.closed_at",
    ]);

/**
 * Every account, open ones first.
 *
 * Closed accounts stay in the list rather than disappearing: they are what the
 * historical figures are computed from, and a family member looking for one
 * they closed last year should find it rather than conclude it was lost.
 */
export async function listAccounts(db: Kysely<Database> = getDb()): Promise<Account[]> {
  const rows = await selectAccounts(db)
    .orderBy((eb) => eb.case().when("account.closed_at", "is", null).then(0).else(1).end())
    .orderBy("account.name")
    .orderBy("account.id")
    .execute();

  return rows.map(toAccount);
}

/**
 * One account, for the screen that edits it.
 *
 * @throws {NotFoundError} when no such account exists.
 */
export async function getAccount(
  id: string,
  db: Kysely<Database> = getDb(),
): Promise<Account> {
  if (!/^\d+$/.test(id)) throw new NotFoundError(`No account with id ${id}.`);

  const row = await selectAccounts(db).where("account.id", "=", id).executeTakeFirst();
  if (row === undefined) throw new NotFoundError(`No account with id ${id}.`);

  return toAccount(row);
}

/**
 * Record an account.
 *
 * @param raw the submitted fields, unvalidated.
 * @throws {ValidationError} with a message per bad field, including an owner
 *         who does not exist.
 */
export async function createAccount(
  raw: unknown,
  db: Kysely<Database> = getDb(),
): Promise<Account> {
  const input = parseInput(accountInput, raw);
  await requireOwner(input.ownerId, db);

  const row = await db
    .insertInto("account")
    .values({
      name: input.name,
      institution: input.institution ?? "",
      kind: input.kind,
      owner_id: input.ownerId,
      tax_treatment: input.taxTreatment,
      external_account_number: input.externalAccountNumber,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  return getAccount(row.id, db);
}

/**
 * Correct an account, including a wrong tax treatment.
 *
 * Editing is deliberately unrestricted: a tax treatment recorded wrongly is a
 * figure reported wrongly for as long as it stands, and there is nothing to be
 * gained by making it hard to fix. Changing the owner is the way a person who
 * owns accounts becomes removable (`people.server.ts`).
 *
 * Closing is not done here — {@link closeAccount} is its own operation, so an
 * ordinary edit can never retire an account by accident.
 *
 * @throws {ValidationError} with a message per bad field.
 * @throws {NotFoundError} when no such account exists.
 */
export async function updateAccount(
  id: string,
  raw: unknown,
  db: Kysely<Database> = getDb(),
): Promise<Account> {
  const existing = await getAccount(id, db);
  const input = parseInput(accountInput, raw);
  await requireOwner(input.ownerId, db);

  await db
    .updateTable("account")
    .set({
      name: input.name,
      institution: input.institution ?? "",
      kind: input.kind,
      owner_id: input.ownerId,
      tax_treatment: input.taxTreatment,
      external_account_number: input.externalAccountNumber,
    })
    .where("id", "=", existing.id)
    .execute();

  return getAccount(existing.id, db);
}

/**
 * Retire an account without erasing the dates it was open.
 *
 * This is the whole of "deleting" an account. Afterwards it contributes nothing
 * to current net worth and still contributes to every date before `closed_at`,
 * which is why the date is recorded rather than a flag.
 *
 * Closing an already-closed account keeps the original date: the account
 * stopped being used when it stopped being used, and a second click must not
 * quietly move a boundary that historical figures are computed against.
 *
 * @throws {NotFoundError} when no such account exists.
 */
export async function closeAccount(
  id: string,
  db: Kysely<Database> = getDb(),
): Promise<Account> {
  const existing = await getAccount(id, db);
  if (existing.isClosed) return existing;

  await db
    .updateTable("account")
    .set({ closed_at: new Date() })
    .where("id", "=", existing.id)
    .execute();

  return getAccount(existing.id, db);
}

/**
 * An owner id that names nobody is a message on the form, not a foreign-key
 * violation — the same reasoning as the removal refusal in `people.server.ts`.
 */
async function requireOwner(ownerId: string, db: Kysely<Database>): Promise<void> {
  const owner = await db
    .selectFrom("person")
    .select("id")
    .where("id", "=", ownerId)
    .executeTakeFirst();

  if (owner === undefined) {
    throw new ValidationError({ ownerId: "Choose an owner from the people on this instance." });
  }
}
