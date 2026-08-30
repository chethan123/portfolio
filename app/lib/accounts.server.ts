/**
 * The accounts the household holds (DESIGN.md §4.1, §4.2, §4.5, §8.4) — what
 * gives a statement somewhere to land and every valuation something to group
 * by. Reads and writes both; the routes above only translate.
 *
 * Three design decisions show up directly: **an account has exactly one
 * owner** (§4.2 — joint accounts are not modelled; a plan holding Traditional
 * and Roth money is two accounts); **tax treatment is three-way, never a
 * boolean** (§4.5); and **nothing is ever deleted** — {@link closeAccount}
 * sets a date rather than removing rows, because the history must keep
 * valuing correctly on every date before the close (§7).
 *
 * What "closed" means for a figure is not this module's rule: the two views
 * own it, in SQL, where every consumer gets the same answer (§8.2).
 *
 * Every exported query takes an optional `db`; tests pass a transaction they
 * roll back.
 */
import { z } from "zod";

import {
  ACCOUNT_KINDS,
  acceptsSetBalance,
  accountKindValues,
  isOwed,
  labelOf,
  taxTreatmentValues,
} from "./account-options.ts";
import { currentStatement } from "./current-statement.server.ts";
import { getDb, type Database } from "./db.server.ts";
import {
  NotFoundError,
  ValidationError,
  listSentence,
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
  /** Recorded from a statement; the commit's guard against the wrong account — a check, never a selector. */
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
 * What a form must supply. Kind, tax treatment and owner are required — the
 * three things a later figure cannot be computed without, where a guess puts
 * a wrong number on a screen rather than an obvious gap. Institution and
 * account number are free text: an institution the app has never heard of is
 * a normal thing to own an account at.
 */
export const accountInput = z.object({
  name: requiredText("An account name", 120),

  // Optional, unlike the `not null` column: recording "Mortgage" before
  // remembering the servicer should not block; the column stores "" and the
  // screen shows a dash.
  institution: optionalText("An institution", 120),

  kind: z.enum(accountKindValues, { message: "Choose what kind of account this is." }),

  ownerId: z
    .string({ message: "Choose an owner." })
    // Ids cross as strings (`server/db.ts`); non-digits would reach Postgres
    // as a malformed bigint — a 500 instead of a message on the form.
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
    // Safe: the check constraints bound what the database can store
    // (`valuation.server.ts`'s reasoning).
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
 * Every account, open ones first. Closed accounts stay in the list: they are
 * what historical figures are computed from, and one closed last year should
 * be findable rather than concluded lost.
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
 * Correct an account, including a wrong tax treatment — unrestricted but for
 * the kind: a wrong treatment is a figure reported wrongly for as long as it
 * stands, and changing the owner is how a person becomes removable
 * (`people.server.ts`).
 *
 * The kind is the exception because both views apply it retroactively to
 * every date: it is a claim about what the account's rows *mean*, and the
 * writers downstream believe it. Relabelling a brokerage as `bank` used to
 * hand `setBalance` an account it would sell out in one submission; `bank` to
 * `liability` used to file $42,000 of assets as debt on every historical
 * date, with no write at all (report SET-1). The two refusals below close
 * both — and only those two: an account with no statement, moves between
 * securities kinds, and `bank`/`liability` onto a securities kind all still
 * go through.
 *
 * Closing is not done here — {@link closeAccount} is its own operation, so an
 * ordinary edit can never retire an account by accident.
 *
 * @throws {ValidationError} per bad field, plus one under `kind` for a kind
 *         the account's current statement contradicts.
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

  // Asked of the new kind and the rows, never the old kind: a condition with
  // an `existing.kind` term would refuse one hop and permit the same
  // destination in two (`liability → brokerage → bank`); this way no sequence
  // of edits arrives anywhere a single edit could not. Securities kinds are
  // unaffected — a statement says what they hold. Read-then-write, no lock,
  // no transaction, deliberately: a statement committed in the gap leaves the
  // label briefly wrong — a mislabel, not a loss; `setBalance` repeats its
  // own guard inside its write.
  if (input.kind !== existing.kind && acceptsSetBalance(input.kind)) {
    const { cashIsNegative, others } = await currentStatement(existing.id, db);

    // A one-balance kind cannot hold positions, so relabelling would strand
    // them: Holdings would still list them and the account's own page would
    // offer the form that sells them. The remedy is the sibling refusal's
    // (`balances.server.ts`): the positions must stop being recorded first —
    // zero them, or upload a statement without them. Neither door is open on
    // a closed account (§5.3 accepts the mislabel is then permanent), so the
    // message says so rather than send the reader to a door that is not there.
    if (others.length > 0) {
      const them = others.length === 1 ? "it" : "them";
      const those = others.length === 1 ? "That position has" : "Those positions have";
      throw new ValidationError({
        kind:
          `${existing.name}'s current statement lists ${listSentence(others)}, and a ` +
          `${labelOf(ACCOUNT_KINDS, input.kind)} account holds one balance rather than ` +
          `positions. ${those} to stop being recorded against it first` +
          (existing.isClosed
            ? ", and a closed account's history does not change — so while it is closed, this " +
              "is not a kind it can take."
            : `: zero ${them} on Holdings, or upload a statement that no longer lists ${them}.`),
      });
    }

    // §2 puts the sign in the quantity, so a kind whose direction disagrees
    // with the stored balance inverts what it means with no write at all —
    // `revisePosition`'s refused sign flip by another door. The remedy names
    // Holdings as well as this account's page because the account may sit on
    // a securities kind, which mounts no Set-balance panel. On a closed
    // account it has neither door — the mislabel is permanent (§5.3), and the
    // message says so.
    if (cashIsNegative !== null && isOwed(input.kind) !== cashIsNegative) {
      throw new ValidationError({
        kind:
          `${existing.name}'s balance is currently recorded as money ` +
          `${cashIsNegative ? "owed" : "held"}, and a ${labelOf(ACCOUNT_KINDS, input.kind)} ` +
          "account records the other. " +
          (existing.isClosed
            ? "It would have to be recorded as zero first, and a closed account's history does " +
              "not change — so while it is closed, this is not a kind it can take."
            : "Record it as zero first if it really did turn around — from this account's page " +
              "if it still takes a typed balance, or on Holdings if it does not."),
      });
    }
  }

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

/** The close form's fields, unvalidated — validating them is the close's job. */
export type CloseAccountInput = {
  /** "true" when the closing acknowledgement was ticked. */
  confirmClose?: string;
};

/**
 * Retire an account without erasing the dates it was open — the whole of
 * "deleting". Afterwards it contributes nothing to current net worth and
 * still contributes to every date before `closed_at`, which is why a date is
 * recorded rather than a flag.
 *
 * The acknowledgement is required here, not left to the screen
 * (`commitUpload`'s decision for its own tick): closing is one-way, and a
 * one-way write a replayed POST can reach silently was never acknowledged at
 * all. Closing an already-closed account keeps the original date — a second
 * click must not move a boundary historical figures are computed against;
 * that short-circuit runs before the tick is consulted.
 *
 * @throws {ValidationError} when the acknowledgement was not ticked.
 * @throws {NotFoundError} when no such account exists.
 */
export async function closeAccount(
  id: string,
  raw: CloseAccountInput,
  db: Kysely<Database> = getDb(),
): Promise<Account> {
  const existing = await getAccount(id, db);
  if (existing.isClosed) return existing;

  if (raw.confirmClose !== "true") {
    throw ValidationError.form(
      `${existing.name} stays open — closing is one-way in this version, ` +
        "so it asks for the acknowledgement to be ticked first.",
    );
  }

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
