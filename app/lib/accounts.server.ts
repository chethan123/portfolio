// Accounts the household holds (DESIGN.md §4.1, §4.2, §4.5, §8.4). One owner per account
// (joint accounts not modelled — split into two); tax treatment is three-way, never boolean
// (§4.5); nothing is deleted — closeAccount sets a date so history still values before it (§7).
// What "closed" means for a figure is the views' rule (SQL, §8.2), not this module's.
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

export type Account = {
  id: string;
  name: string;
  institution: string;
  kind: AccountKind;
  ownerId: string;
  ownerName: string;
  taxTreatment: TaxTreatment;
  // Recorded from a statement; used by commit as a check against the wrong account, never a selector.
  externalAccountNumber: string | null;
  // timestamptz, not a calendar date — left as the driver returns it, not the date-as-string rule.
  closedAt: Date | null;
  isClosed: boolean;
};

// Kind/taxTreatment/owner required: a later figure can't be computed without them and a guess
// would be worse than an obvious gap. Institution/account number are free text.
export const accountInput = z.object({
  name: requiredText("An account name", 120),

  // Optional unlike the not-null column: "Mortgage" before knowing the servicer shouldn't block.
  institution: optionalText("An institution", 120),

  kind: z.enum(accountKindValues, { message: "Choose what kind of account this is." }),

  ownerId: z
    .string({ message: "Choose an owner." })
    // Ids cross as strings; non-digits would reach Postgres as a malformed bigint (500, not a message).
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
    // Safe: check constraints bound what the database can store.
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

// Open accounts first; closed ones stay in the list (historical figures compute from them).
export async function listAccounts(db: Kysely<Database> = getDb()): Promise<Account[]> {
  const rows = await selectAccounts(db)
    .orderBy((eb) => eb.case().when("account.closed_at", "is", null).then(0).else(1).end())
    .orderBy("account.name")
    .orderBy("account.id")
    .execute();

  return rows.map(toAccount);
}

export async function getAccount(
  id: string,
  db: Kysely<Database> = getDb(),
): Promise<Account> {
  if (!/^\d+$/.test(id)) throw new NotFoundError(`No account with id ${id}.`);

  const row = await selectAccounts(db).where("account.id", "=", id).executeTakeFirst();
  if (row === undefined) throw new NotFoundError(`No account with id ${id}.`);

  return toAccount(row);
}

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

// Kind is the one field guarded beyond field validation: both views apply it retroactively to
// every date, so relabelling used to let setBalance sell out a brokerage, or file assets as debt
// with no write at all (SET-1). The two refusals below close exactly those two holes — an account
// with no statement, or a move between securities kinds, still goes through untouched.
// Closing is a separate operation (closeAccount) so an ordinary edit can't retire an account by accident.
export async function updateAccount(
  id: string,
  raw: unknown,
  db: Kysely<Database> = getDb(),
): Promise<Account> {
  const existing = await getAccount(id, db);
  const input = parseInput(accountInput, raw);
  await requireOwner(input.ownerId, db);

  // Checked against the new kind and the rows, never existing.kind — otherwise a two-hop edit
  // (liability -> brokerage -> bank) reaches what one hop couldn't. Securities kinds unaffected.
  // Read-then-write, no lock/transaction: a statement racing into the gap leaves a brief
  // mislabel, not a loss — setBalance repeats this guard inside its own write.
  if (input.kind !== existing.kind && acceptsSetBalance(input.kind)) {
    const { cashIsNegative, others } = await currentStatement(existing.id, db);

    // A one-balance kind can't hold positions; remedy is balances.server.ts's refusal (zero
    // them or upload a statement without them) — neither door exists on a closed account (§5.3
    // makes the mislabel permanent there), so the message says so instead.
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

    // Sign is in the quantity (§2); a kind whose direction disagrees with the stored balance
    // would invert its meaning with no write at all — the same sign flip revisePosition refuses,
    // by another door. Closed account: neither remedy door exists, mislabel is permanent (§5.3).
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

export type CloseAccountInput = {
  // "true" when the closing acknowledgement was ticked.
  confirmClose?: string;
};

// Records a date, not a flag: contributes nothing to current net worth but still values every
// date before closed_at. Acknowledgement is checked here (not left to the screen) since a
// replayed POST must not close silently. Already-closed keeps the original date — checked
// before the tick, so a second click can't move a boundary figures are computed against.
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

// A nonexistent owner id is a form message, not a foreign-key violation.
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
