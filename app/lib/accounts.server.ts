// Accounts the household holds (DESIGN.md §4.1, §4.2, §4.5, §8.4). One owner per account
// (joint accounts not modelled — split into two); tax treatment is three-way, never boolean
// (§4.5); nothing is deleted — closeAccount sets a date so history still values before it (§7).
// What "closed" means for a figure is the views' rule (SQL, §8.2), not this module's.
// withAccountLock is here because the row it locks is this module's (ARCHITECTURE.md §7.2).
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
import { compareIds } from "./database-id.ts";
import {
  getDb,
  guardedAgainstConstraintViolation,
  inTransaction,
  uniqueViolationConstraint,
  type Database,
} from "./db.server.ts";
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
  // A guard on a single-account upload, the selector on a multi-account one (ADR-0015); at most one
  // open account records each (account_open_number_unique), trimmed on every write.
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

// A position set restates the whole account, so two writers copying the same latest set forward
// each land a complete snapshot missing the other's edit (#283). Every writer that appends one,
// and closeAccount, runs inside this: FOR NO KEY UPDATE on the account row, one transaction from
// the read a writer decides on to its insert, so the later writer's read is the earlier's commit.
// NO KEY, not FOR UPDATE: the stronger mode also blocks the FOR KEY SHARE an insert referencing
// the account takes, stalling createDraft and any out-of-app insert behind a commit in flight.
// Bare row locked, then the account read, not one locked join: a join re-checked on being granted
// keeps the person tuple its first scan pinned, so an owner change mid-wait 404'd the account (#332).
// READ COMMITTED only: the re-read must see the writer ahead. Several accounts: withAccountLocks.
export async function withAccountLock<T>(
  accountId: string,
  db: Kysely<Database>,
  body: (account: Account, trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  if (!/^\d+$/.test(accountId)) throw new NotFoundError(`No account with id ${accountId}.`);

  const locked = async (trx: Kysely<Database>): Promise<T> => {
    const row = await trx
      .selectFrom("account")
      .select("id")
      .where("id", "=", accountId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundError(`No account with id ${accountId}.`);

    return body(await getAccount(accountId, trx), trx);
  };

  return inTransaction(db, locked);
}

// Several accounts in one transaction (spec 0023 "The commit"): each lock nested in the last, ids
// ascending by compareIds, so two writers over overlapping accounts queue rather than deadlock.
export async function withAccountLocks<T>(
  accountIds: ReadonlyArray<string>,
  db: Kysely<Database>,
  body: (accounts: Account[], trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  const ordered = [...new Set(accountIds)].sort(compareIds);

  const nest = (held: Account[], trx: Kysely<Database>): Promise<T> => {
    const next = ordered[held.length];
    if (next === undefined) return body(held, trx);
    return withAccountLock(next, trx, (account, inner) => nest([...held, account], inner));
  };

  return inTransaction(db, (trx) => nest([], trx));
}

// At most one open account per number (ADR-0015). The index decides, not a read first: Settings
// takes no lock and a commit locks only its own account, so two writers could each pass a read.
// Holder read after the violation, only to name it; may be gone again by then.
export async function refusingDuplicateNumber<T>(
  number: string | null,
  db: Kysely<Database>,
  write: () => Promise<T>,
  refuse: (who: string) => Error,
): Promise<T> {
  try {
    return await guardedAgainstConstraintViolation(db, write);
  } catch (cause) {
    if (number === null || uniqueViolationConstraint(cause) !== "account_open_number_unique") {
      throw cause;
    }
    throw refuse((await numberHolder(number, db)) ?? "another open account");
  }
}

// The open account recording `number`, as a refusal names it.
export async function numberHolder(number: string, db: Kysely<Database>): Promise<string | null> {
  const holder = await selectAccounts(db)
    .where("account.external_account_number", "=", number)
    .where("account.closed_at", "is", null)
    .executeTakeFirst();
  return holder === undefined ? null : `${holder.name}, owned by ${holder.owner_name}`;
}

const duplicateNumber = (who: string) =>
  new ValidationError({
    externalAccountNumber:
      `This number is already recorded on ${who}. Only one open account can record a number, ` +
      "since an upload can route rows by it. Clear it there first if it belongs here.",
  });

export async function createAccount(
  raw: unknown,
  db: Kysely<Database> = getDb(),
): Promise<Account> {
  const input = parseInput(accountInput, raw);
  await requireOwner(input.ownerId, db);

  const row = await refusingDuplicateNumber(
    input.externalAccountNumber,
    db,
    () =>
      db
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
        .executeTakeFirstOrThrow(),
    duplicateNumber,
  );

  return getAccount(row.id, db);
}

// What the account-number box was drawn with, echoed back by the edit form: evidence about the
// page the browser was shown, never authorization (#312). optionalText's shape minus the bound —
// it has to normalise identically or a trailing space reads as an edit, and a captured number
// longer than the visible box's 64 has to stay clearable rather than refuse under a key
// AccountFields never draws. Absent stays undefined rather than collapsing to null: a form drawn
// before this field existed said nothing about its box, which is not the same as saying it was
// empty.
const accountUpdateInput = accountInput.extend({
  fromExternalAccountNumber: z
    .string()
    .trim()
    .transform((value) => value.replace(/[\r\n]/g, ""))
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional(),
});

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
  const input = parseInput(accountUpdateInput, raw);
  await requireOwner(input.ownerId, db);

  // Checked against the new kind and the rows, never existing.kind — otherwise a two-hop edit
  // (liability -> brokerage -> bank) reaches what one hop couldn't. Securities kinds unaffected.
  // Read-then-write is not serialized with position writers; a stale kind decision can survive
  // their account lock. Tracked in https://github.com/chethan123/portfolio/issues/311.
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

  const fields = {
    name: input.name,
    institution: input.institution ?? "",
    kind: input.kind,
    owner_id: input.ownerId,
    tax_treatment: input.taxTreatment,
  };

  // No baseline and a blank box: a form drawn before that field existed, saying nothing about
  // what its box held. An untouched stale box and a deliberate clear post exactly the same
  // thing, and keeping the number while answering "Saved." would report a clear that did not
  // happen. Refused instead, so the one submission nothing can read is the one nobody claims.
  if (
    input.fromExternalAccountNumber === undefined &&
    input.externalAccountNumber === null &&
    existing.externalAccountNumber !== null
  ) {
    throw new ValidationError({
      externalAccountNumber:
        `${existing.name}'s account number is recorded as "${existing.externalAccountNumber}", ` +
        "and this page is too old to say whether its box was cleared or drawn empty. Nothing " +
        "was saved. Reload the account, and clear the box again to remove the number.",
    });
  }

  const drawnWith = input.fromExternalAccountNumber ?? null;

  // Box came back holding what was rendered into it: not an instruction. The column stays out of
  // the write, so a number a commit captured while this form sat open (uploads.server.ts)
  // survives the save (#312), and no duplicate can be minted by a write that omits the column.
  // A submission carrying neither field reads as untouched too, which is the safe default — the
  // refusal above has already taken the case where it isn't.
  if (input.externalAccountNumber === drawnWith) {
    await db.updateTable("account").set(fields).where("id", "=", existing.id).execute();
    return getAccount(existing.id, db);
  }

  // An edit: compare-and-set on what the form was drawn with — the alias confirm's shape
  // (ARCHITECTURE.md §7.2), not a second lock. The typed value matches too, so a column another
  // writer already moved to it reads as the edit done rather than as a conflict. Zero rows means
  // the column is neither, which is the refusal.
  const written = await refusingDuplicateNumber(
    input.externalAccountNumber,
    db,
    () =>
      db
        .updateTable("account")
        .set({ ...fields, external_account_number: input.externalAccountNumber })
        .where("id", "=", existing.id)
        .where((eb) =>
          eb.or(
            [drawnWith, input.externalAccountNumber].map((value) =>
              value === null
                ? eb("external_account_number", "is", null)
                : eb("external_account_number", "=", value),
            ),
          ),
        )
        .executeTakeFirst(),
    duplicateNumber,
  );

  if (written.numUpdatedRows === 0n) {
    // Re-read rather than quote `existing`: a 404 if the account went, the number now otherwise.
    const now = await getAccount(existing.id, db);
    throw new ValidationError({
      // Under the box, not the form: the route hands fieldErrors straight to AccountFields.
      externalAccountNumber:
        `${now.name}'s account number changed while this page was open — it is ` +
        (now.externalAccountNumber === null
          ? "not recorded any more"
          : `now recorded as "${now.externalAccountNumber}"`) +
        ". Nothing was saved. Reload the account and make the change against what is recorded now.",
    });
  }

  return getAccount(existing.id, db);
}

export type CloseAccountInput = {
  // "true" when the closing acknowledgement was ticked.
  confirmClose?: string;
};

// Records a date, not a flag: contributes nothing to current net worth but still values every
// date before closed_at. Acknowledgement is checked here (not left to the screen) since a
// replayed POST must not close silently. Already-closed keeps the original date — checked under
// the account lock, before the tick, so a second click can't move a boundary figures are computed
// against. Its update would queue on that row lock by itself; inside withAccountLock the closing
// instant is stamped after any in-flight writer commits, and every writer of the row has one rule.
export async function closeAccount(
  id: string,
  raw: CloseAccountInput,
  db: Kysely<Database> = getDb(),
): Promise<Account> {
  return withAccountLock(id, db, async (existing, trx) => {
    if (existing.isClosed) return existing;

    if (raw.confirmClose !== "true") {
      throw ValidationError.form(
        `${existing.name} stays open — closing is one-way in this version, ` +
          "so it asks for the acknowledgement to be ticked first.",
      );
    }

    await trx
      .updateTable("account")
      .set({ closed_at: new Date() })
      .where("id", "=", existing.id)
      .execute();

    return getAccount(existing.id, trx);
  });
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
