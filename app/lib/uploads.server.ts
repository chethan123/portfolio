/**
 * The upload draft — the staging row behind an in-progress statement upload
 * (DESIGN.md §5.1, docs/specs/0004-ingest.md).
 *
 * The upload flow is four screens and every one of them is a real URL with no
 * client state, so everything a step needs has to live where a URL can reach
 * it. This module owns that place: one `upload_draft` row holding the bytes,
 * the filename and, once the columns step passes, the mapping and whether the
 * file raised any first sighting. Each step reads the draft, writes its own
 * part back and redirects — which is what makes a reload, the back button and
 * a bookmarked half-finished upload all behave.
 *
 * It is also where the application's first multipart form is read. Every other
 * action goes through `formFields`, which drops file parts by design, so the
 * size bound and the file handling live here rather than at each caller.
 *
 * Three decisions worth stating:
 *
 * **Drafts are swept, not scheduled.** Anything older than 24 hours is deleted
 * at the start of the next upload, inside {@link createDraft}. A cron for a
 * table that holds at most a handful of rows in a single-household application
 * is machinery without a payer.
 *
 * **A dead draft is one 404, not four.** Swept, already committed, mistyped
 * and belonging-to-a-closed-account all read the same expired-or-recorded
 * page, because the reader's next move — start again from /upload — is the
 * same in every case, and the differences are not actionable.
 *
 * **The size cap is guarded twice, and the early one is the header.**
 * `request.formData()` buffers the whole body, so by the time a `File` exists
 * the memory is already spent. {@link refuseOversizedBody} reads
 * `Content-Length` before the body; the `File.size` check inside
 * {@link parseUploadForm} catches whatever arrives without one.
 *
 * The module also owns the flow's last step: {@link diffForDraft} states what
 * the staged file changes against what the account holds now, and
 * {@link commitUpload} is the flow's one write — the immutable `position_set`,
 * its holdings, the draft deleted, one transaction. {@link uploadReceipt} is
 * the read the account page's `?uploaded=` confirmation comes from, recomputed
 * from the database so a hand-typed parameter can only ever describe what was
 * actually recorded.
 */
import { z } from "zod";

import { sql } from "kysely";

import { getConfig } from "../../server/config.ts";
import { getAccount } from "./accounts.server.ts";
import { lastRecorded } from "./balances.server.ts";
import { readCsv } from "./csv.ts";
import { getDb, type Database } from "./db.server.ts";
import { holdingNote } from "./holdings-view.ts";
import { NotFoundError, ValidationError, parseInput, recordedDate } from "./input.server.ts";
import { unresolvedStrings } from "./instrument-resolution.server.ts";
import { MONEY_SCALE, QUANTITY_SCALE, divide, render, toUnits } from "./money.ts";
import { fitsTheMoneyColumn } from "./positions.server.ts";
import { foldLots, parseStatement, statementMapping } from "./statement.ts";
import { accountHoldings } from "./valuation.server.ts";

import type { AssetClass, IsoDate } from "./valuation.server.ts";
import type { ParsedPosition, ParsedStatement, StatementMapping } from "./statement.ts";
import type { Kysely } from "kysely";

const BYTES_PER_MB = 1024 * 1024;

/**
 * The one sentence a dead draft URL answers with, whatever killed it.
 * `draft.tsx`'s error boundary renders it under its own page title.
 */
const EXPIRED =
  "This upload has expired or was already recorded. A draft is kept for a day " +
  "and deleted once its statement lands, so a bookmarked or reopened step can " +
  "outlive it.";

/** A draft joined with the account it was opened against. */
export type UploadDraft = {
  id: string;
  accountId: string;
  accountName: string;
  filename: string;
  /** The uploaded bytes, exactly as they arrived — BOM, CRLF and all. */
  bytes: Uint8Array;
  /**
   * Null until the columns step is passed — which is how "how far did this
   * draft get" stays a property of the row. Its shape is that step's contract.
   */
  mapping: unknown;
  /**
   * Whether the columns step's parse raised any first sighting — the step
   * strip's dimmed "· none" memory, null until that step decides. Written at
   * that moment because it is unrecoverable afterwards: an alias, once
   * written, does not say which draft wrote it.
   */
  hadFirstSightings: boolean | null;
  createdAt: Date;
};

/** What the drop screen hands over once {@link parseUploadForm} has run. */
export type DraftInput = {
  accountId: string;
  filename: string;
  bytes: Uint8Array;
};

/**
 * Refuse a request whose declared body is over the cap, before reading it.
 *
 * The `Content-Length` header is the only thing available before the body is
 * buffered. A request that does not carry one falls through to the
 * `File.size` check in {@link parseUploadForm}, which enforces the same cap
 * after the fact.
 *
 * @throws {ValidationError} form-level, naming the limit.
 */
export function refuseOversizedBody(request: Request): void {
  const limit = getConfig().MAX_UPLOAD_MB;
  const declared = Number(request.headers.get("content-length"));

  if (Number.isFinite(declared) && declared > limit * BYTES_PER_MB) {
    throw ValidationError.form(
      `This upload is larger than ${limit} MB, which is the most a statement file can be.`,
    );
  }
}

const uploadInput = z.object({
  accountId: z
    .string({ message: "Choose the account this statement describes." })
    .regex(/^\d+$/, { message: "Choose the account this statement describes." }),

  // A file input left empty submits a File with an empty name, so presence is
  // the name, not the instance.
  file: z.custom<File>((value) => value instanceof File && value.name !== "", {
    message: "Choose a statement file to upload.",
  }),
});

/**
 * The drop screen's submission, validated down to bytes.
 *
 * The guards run in the order the spec fixes, each refusing as the thing it
 * is: a missing field is a field-level message like every other form's, an
 * oversized file names the limit, an empty file is a fact about the download
 * rather than a parse error, and bytes that are not UTF-8 text get a sentence
 * about the file, never a driver error. A leading BOM is valid UTF-8 and is
 * not a failure — step 02 strips it.
 *
 * @param form the submitted `multipart/form-data`. The file is read from it
 *             directly, because `formFields` drops file parts by design.
 * @throws {ValidationError} with a message per bad field.
 */
export async function parseUploadForm(form: FormData): Promise<DraftInput> {
  const input = parseInput(uploadInput, {
    accountId: form.get("accountId") ?? undefined,
    file: form.get("file") ?? undefined,
  });

  const limit = getConfig().MAX_UPLOAD_MB;
  if (input.file.size > limit * BYTES_PER_MB) {
    throw new ValidationError({
      file: `This file is larger than ${limit} MB, which is the most a statement file can be.`,
    });
  }

  if (input.file.size === 0) {
    throw new ValidationError({
      file: "This file has no content. Export the statement again and choose the fresh download.",
    });
  }

  const bytes = new Uint8Array(await input.file.arrayBuffer());
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ValidationError({
      file:
        "This does not read as a text file. Export the CSV version of the statement " +
        "and upload that instead.",
    });
  }

  return { accountId: input.accountId, filename: input.file.name, bytes };
}

/**
 * Open a draft: sweep the stale ones, then stage this file.
 *
 * The sweep runs here, immediately before the insert, because the start of an
 * upload is the one moment the table is guaranteed to be looked at — no
 * scheduler, no background job.
 *
 * @param input already through {@link parseUploadForm}; validating the account
 *        still happens here, so a second caller cannot stage a file against a
 *        closed one.
 * @throws {NotFoundError} when no such account exists.
 * @throws {ValidationError} form-level, for a closed account — the same
 *         refusal `setBalance` makes, because it is the same rule.
 */
export async function createDraft(
  { accountId, filename, bytes }: DraftInput,
  db: Kysely<Database> = getDb(),
): Promise<{ id: string; accountId: string }> {
  const account = await getAccount(accountId, db);

  if (account.isClosed) {
    throw ValidationError.form(
      `${account.name} is closed, and a closed account's history does not change. ` +
        "Reopen it from Settings if this statement is still real.",
    );
  }

  await db
    .deleteFrom("upload_draft")
    .where("created_at", "<", sql<Date>`now() - interval '24 hours'`)
    .execute();

  const row = await db
    .insertInto("upload_draft")
    .values({ account_id: accountId, filename, raw_file: Buffer.from(bytes) })
    .returning("id")
    .executeTakeFirstOrThrow();

  return { id: row.id, accountId: account.id };
}

/**
 * A draft with the two account facts only the commit reads: whether the
 * account has closed underneath it, and the number a statement's
 * account-number column is guarded against.
 */
type DraftRecord = UploadDraft & {
  accountClosedAt: Date | null;
  /** `account.external_account_number` — the commit's guard, and its capture. */
  accountNumber: string | null;
};

/**
 * The draft a step URL names, joined with its account — or undefined when the
 * row is gone. Closed accounts are *not* filtered here: {@link requireDraft}
 * reads a closed account's draft as expired, while {@link commitUpload} owes
 * it a sentence in `setBalance`'s words, and both start from this read.
 */
async function findDraft(
  draftId: string,
  db: Kysely<Database>,
): Promise<DraftRecord | undefined> {
  // Anything a URL carries reaches here; "abc" would fail as a malformed
  // bigint in the driver, which is a 500 wearing a bookmark.
  if (!/^\d+$/.test(draftId)) return undefined;

  const row = await db
    .selectFrom("upload_draft")
    .innerJoin("account", "account.id", "upload_draft.account_id")
    .select([
      "upload_draft.id",
      "upload_draft.account_id",
      "account.name as account_name",
      "account.closed_at",
      "account.external_account_number",
      "upload_draft.filename",
      "upload_draft.raw_file",
      "upload_draft.mapping",
      "upload_draft.had_first_sightings",
      "upload_draft.created_at",
    ])
    .where("upload_draft.id", "=", draftId)
    .executeTakeFirst();

  if (row === undefined) return undefined;

  return {
    id: row.id,
    accountId: row.account_id,
    accountName: row.account_name,
    filename: row.filename,
    bytes: row.raw_file,
    mapping: row.mapping,
    hadFirstSightings: row.had_first_sightings,
    createdAt: row.created_at,
    accountClosedAt: row.closed_at,
    accountNumber: row.external_account_number,
  };
}

/**
 * The draft a step URL names, with its account resolved.
 *
 * @throws {NotFoundError} for an id that is not one, a draft that is gone —
 *         swept or committed — and a draft whose account has since closed,
 *         all with the same expired-or-recorded sentence. The step routes turn
 *         it into a 404, never a 500.
 */
export async function requireDraft(
  draftId: string,
  db: Kysely<Database> = getDb(),
): Promise<UploadDraft> {
  const row = await findDraft(draftId, db);

  // A closed account's draft is expired, not forbidden: its history does not
  // change, so the upload this row was staging can never land.
  if (row === undefined || row.accountClosedAt !== null) throw new NotFoundError(EXPIRED);

  return row;
}

/**
 * The columns step passing: the mapping lands on the draft, which is what
 * makes "how far did this draft get" a property of the row and lets a later
 * step — or a return to this one — read the answer back.
 *
 * `had_first_sightings` is decided and written here too, because this is the
 * one moment the answer exists: whether *this* mapping's parse raised any
 * string no alias resolves. The instruments step then writes the aliases, and
 * afterwards nothing can tell "the step was skipped" from "the step was
 * passed" — an alias does not say which draft wrote it. The review screen's
 * step strip dims its entry off this bit (brief §2.1, §7.5). Null when the
 * mapping does not parse clean, since no columns step has genuinely passed.
 *
 * @throws {NotFoundError} through {@link requireDraft}, with the same
 *         expired-or-recorded sentence — a mapping posted against a draft the
 *         sweep or a commit has taken is a dead bookmark, not a fault.
 */
export async function saveMapping(
  draftId: string,
  mapping: StatementMapping,
  db: Kysely<Database> = getDb(),
): Promise<void> {
  const draft = await requireDraft(draftId, db);

  const { rows } = readCsv(draft.bytes, mapping.delimiter);
  const parsed = parseStatement(rows, mapping);
  const hadFirstSightings =
    parsed.problems.length > 0
      ? null
      : (
          await unresolvedStrings(
            parsed.positions.map((position) => position.instrument),
            db,
          )
        ).length > 0;

  await db
    .updateTable("upload_draft")
    .set({
      mapping: JSON.stringify(mapping),
      had_first_sightings: hadFirstSightings,
    })
    .where("id", "=", draft.id)
    .execute();
}

/**
 * Where a draft's file stands against the flow's steps, in one read. The rule
 * — parse the draft through its saved mapping; a malformed mapping or parse
 * problems mean the columns step, an unresolved string means the instruments
 * step, and otherwise the file is ready — exists once, here, rather than once
 * per route that resumes a draft.
 *
 * `step` names the earliest step still owed; `null` means none is, and the
 * draft can be diffed and committed. The instruments variant carries the
 * parse and the unresolved strings, because that screen's whole job is to ask
 * about them; the columns variant carries nothing, because a mapping that
 * does not parse has nothing trustworthy to carry.
 */
export type DraftParse =
  | { step: "columns" }
  | {
      step: "instruments";
      parsed: ParsedStatement;
      mapping: StatementMapping;
      /** The first sightings, in the order the file raised them. */
      unresolved: string[];
    }
  | { step: null; parsed: ParsedStatement; mapping: StatementMapping };

/**
 * Parse a draft's file through its saved mapping and say which step, if any,
 * the draft still owes. The index route redirects to `step`, the instruments
 * route renders or bounces on it, and {@link diffForDraft} turns a non-null
 * `step` into a {@link DraftNotReadyError}.
 */
export async function parseDraft(
  draft: UploadDraft,
  db: Kysely<Database> = getDb(),
): Promise<DraftParse> {
  const saved = statementMapping.safeParse(draft.mapping);
  if (!saved.success) return { step: "columns" };

  // The mapping's own delimiter, never a second sniff: re-reading the same
  // bytes must not depend on the sniff reaching the same verdict twice.
  const { rows } = readCsv(draft.bytes, saved.data.delimiter);
  const parsed = parseStatement(rows, saved.data);

  // A saved mapping only lands after a clean parse, so problems here mean the
  // stored row predates a rule or was written by hand — either way, remapping
  // is the fix, and columns is where remapping lives.
  if (parsed.problems.length > 0) return { step: "columns" };

  const unresolved = await unresolvedStrings(
    parsed.positions.map((position) => position.instrument),
    db,
  );
  if (unresolved.length > 0) {
    return { step: "instruments", parsed, mapping: saved.data, unresolved };
  }

  return { step: null, parsed, mapping: saved.data };
}

/* -------------------------------------------------------------------------- */
/*  The diff                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A review-step read over a draft that has not genuinely reached review: the
 * mapping is absent or no longer reads back through its schema, or the file
 * still carries a string no alias resolves. Not a refusal and not a 404 — the
 * reader's next move is an earlier step, and the routes translate this into a
 * redirect to the one named here.
 */
export class DraftNotReadyError extends Error {
  override readonly name = "DraftNotReadyError";
  readonly step: "columns" | "instruments";

  constructor(step: "columns" | "instruments") {
    super(`This draft has not passed the ${step} step.`);
    this.step = step;
  }
}

/** What every diff row's instrument cell shows. */
type DiffInstrument = {
  instrumentId: string;
  /** Null for an instrument with no public ticker — no badge is drawn. */
  symbol: string | null;
  name: string;
  /**
   * The `.cell-sub` under the name: `holdingNote`'s words — asset class,
   * "never priced", "price is stale" — plus this row's own notes, "3 rows
   * combined" and "cost basis no longer reported" among them. Composed here so
   * two screens cannot spell one condition two ways.
   */
  note: string;
};

export type DiffAdded = DiffInstrument & {
  quantity: string;
  costBasisPerShare: string | null;
  /** At the current quote — context, not part of the write. Null when never priced. */
  value: string | null;
};

export type DiffUpdated = DiffInstrument & {
  /** As stored, `numeric(20, 8)`'s full scale — `formatQuantity` trims it. */
  quantityBefore: string;
  quantityAfter: string;
  quantityChanged: boolean;
  costBasisBefore: string | null;
  costBasisAfter: string | null;
  basisChanged: boolean;
  /** `figure → —`: quiet in exactly the place it should not be, so the note says it too. */
  basisDisappeared: boolean;
  /** The after-state at the current quote. Null when never priced. */
  value: string | null;
};

export type DiffRemoved = DiffInstrument & {
  /** The quantity the account holds now, which this file sells. */
  quantity: string;
  costBasisPerShare: string | null;
  /** The last known value — never `$0.00` for a holding nothing ever priced. */
  value: string | null;
};

/**
 * What the review screen states: the staged file classified against what the
 * account holds now, removals in full, and the two flags the confirmation
 * grammar hangs off.
 */
export type UploadDiff = {
  draftId: string;
  accountId: string;
  accountName: string;
  filename: string;
  added: DiffAdded[];
  updated: DiffUpdated[];
  /** Every removed position individually — a count alone is how a filtered
   *  export sells 28 holdings nobody read about (§5.2). */
  removed: DiffRemoved[];
  /** Unchanged rows are deliberately absent from the table; the count is all
   *  an unchanged row has to say. */
  unchangedCount: number;
  /** How many positions the account holds now — the removal ratio's denominator. */
  currentCount: number;
  /** No statement yet: the file reads as "14 added", not a diff against nothing. */
  firstStatement: boolean;
  /** More than half of what the account holds is removed — the commit demands a tick. */
  majorityRemoved: boolean;
  removesEverything: boolean;
  /** Lines the parser left out for stating no quantity, for the intro to name. */
  skipped: Array<{ row: number; instrument: string }>;
  /** Which of §6.3's two cases this statement is — the screen says it plainly. */
  asOf: { source: "file"; date: IsoDate } | { source: "asked" };
  /**
   * True when the columns step recorded that this draft's file raised no
   * first sightings, so the step strip dims its instruments entry with
   * "· none" (brief §2.1, §7.5). False both for a draft that genuinely
   * visited the step and for one saved before the bit existed — dimming is a
   * claim, and an unknown history does not get to make it.
   */
  instrumentsSkipped: boolean;
};

/** One row as the commit will write it, with the facts its guards read. */
type FileRow = {
  instrumentId: string;
  name: string;
  quantity: string;
  costBasisPerShare: string | null;
  accountNumber: string | null;
  /** The instrument's current quote, for the value column and the product guard. */
  price: string | null;
  /** How many file lines fed this row — parser combines and spelling folds both. */
  lineCount: number;
};

/** The diff plus what the commit needs and the screen does not. */
type AssembledDiff = {
  diff: UploadDiff;
  rows: FileRow[];
  /** The first account number the file carried, or null when it carried none. */
  fileAccountNumber: string | null;
};

/**
 * Run `body` in a transaction, unless one is already open — the same helper
 * `instrument-resolution.server.ts` carries, for the same reason: Kysely
 * refuses `.transaction()` on a handle that is already one, and the test seam
 * *is* a transaction.
 */
function inTransaction<T>(
  db: Kysely<Database>,
  body: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.isTransaction ? body(db) : db.transaction().execute(body);
}

/**
 * `quantity × price` at the money scale — the diff's Value column for a row
 * the account does not hold yet, where `holding_valued` has no row to compute
 * it in SQL. The same digits the view produces: units of 10^-12 divided back
 * to money's 10^-4, rounded half away from zero.
 */
function valueAt(quantity: string, price: string | null): string | null {
  if (price === null) return null;

  return render(
    divide(
      toUnits(quantity, QUANTITY_SCALE) * toUnits(price, MONEY_SCALE),
      10n ** BigInt(QUANTITY_SCALE),
      0,
    ),
    MONEY_SCALE,
  );
}

/** Do two stored-or-parsed basis figures state the same fact, nulls included? */
function sameBasis(before: string | null, after: string | null): boolean {
  if (before === null || after === null) return before === after;
  return toUnits(before, MONEY_SCALE) === toUnits(after, MONEY_SCALE);
}

/** Do a stored and a parsed quantity state the same count? */
function sameQuantity(before: string, after: string): boolean {
  return toUnits(before, QUANTITY_SCALE) === toUnits(after, QUANTITY_SCALE);
}

/**
 * Parse the draft's file through its saved mapping, resolve every string, and
 * classify the result against what the account holds now.
 *
 * Current holdings come through {@link accountHoldings} — the shared module
 * over `holding_valued`, which resolves "current" through
 * `latest_position_set` — never a second `order by as_of_date desc` written
 * here: §8.2's drift is a tie-break copied into a new caller.
 *
 * Two spellings of one fund — `FCASH` and `CASH & CASH INVESTMENTS`, both
 * aliased to the same instrument — fold here exactly as the parser folds a
 * duplicated string: quantities summed, basis quantity-weighted, null when any
 * lot's basis is unknown or the lots net to nothing. `parseStatement` groups
 * by the raw string and defers this on purpose ("combining them now would
 * guess what resolution decides"); this is where resolution has decided.
 *
 * @throws {DraftNotReadyError} when the columns or instruments step has not
 *         genuinely been passed — the routes redirect there.
 */
async function assembleDiff(
  draft: UploadDraft,
  db: Kysely<Database>,
): Promise<AssembledDiff> {
  // The shared draft-parse rule: an owed step here is a bookmarked review over
  // a draft whose mapping broke or whose file still carries a first sighting.
  const result = await parseDraft(draft, db);
  if (result.step !== null) throw new DraftNotReadyError(result.step);
  const { parsed } = result;

  // Byte-exact alias lookup, all strings in one read — `parseDraft` has
  // already established that every string resolves; this read is for the ids.
  const strings = parsed.positions.map((position) => position.instrument);
  const aliasRows =
    strings.length === 0
      ? []
      : await db
          .selectFrom("instrument_alias")
          .select(["raw_string", "instrument_id"])
          .where("raw_string", "in", strings)
          .execute();
  const aliases = new Map(aliasRows.map((row) => [row.raw_string, row.instrument_id]));

  // Group by the *resolved* instrument, in first-appearance order.
  const groups = new Map<string, ParsedPosition[]>();
  for (const position of parsed.positions) {
    const instrumentId = aliases.get(position.instrument);
    if (instrumentId === undefined) continue; // unreachable: checked above
    const group = groups.get(instrumentId);
    if (group === undefined) groups.set(instrumentId, [position]);
    else group.push(position);
  }

  const combinedByRaw = new Map(parsed.combined.map((c) => [c.instrument, c.rowCount]));

  type FoldedRow = Omit<FileRow, "name" | "price">;
  const folded: FoldedRow[] = [];

  for (const [instrumentId, group] of groups) {
    const first = group[0];
    if (first === undefined) continue;

    const lineCount = group.reduce(
      (sum, position) => sum + (combinedByRaw.get(position.instrument) ?? 1),
      0,
    );
    const accountNumber =
      group.find((position) => position.accountNumber !== null)?.accountNumber ?? null;

    if (group.length === 1) {
      folded.push({
        instrumentId,
        quantity: first.quantity,
        costBasisPerShare: first.costBasisPerShare,
        accountNumber,
        lineCount,
      });
      continue;
    }

    // The spelling fold. Signs were already applied by the parser, so the sum
    // is over the final quantities; `foldLots` is the parser's own
    // duplicate-row rule, stated once in `statement.ts` and called from both.
    const fold = foldLots(group);

    folded.push({
      instrumentId,
      quantity: fold.quantity,
      costBasisPerShare: fold.costBasisPerShare,
      accountNumber,
      lineCount,
    });
  }

  // What each named instrument is, and what it currently quotes at — the
  // Value column's other operand, and the second half of the product guard.
  const ids = folded.map((row) => row.instrumentId);
  const factRows =
    ids.length === 0
      ? []
      : await db
          .selectFrom("instrument")
          .innerJoin("classification", "classification.id", "instrument.classification_id")
          .leftJoin("quote", "quote.instrument_id", "instrument.id")
          .select([
            "instrument.id as id",
            "instrument.symbol as symbol",
            "instrument.name as name",
            "classification.asset_class as assetClass",
            "quote.price as price",
            "quote.is_stale as isStale",
          ])
          .where("instrument.id", "in", ids)
          .execute();
  const facts = new Map(factRows.map((row) => [row.id, row]));

  const current = await accountHoldings(draft.accountId, db);
  const currentById = new Map(current.map((holding) => [holding.instrumentId, holding]));

  const rows: FileRow[] = [];
  const added: DiffAdded[] = [];
  const updated: DiffUpdated[] = [];
  let unchangedCount = 0;
  const inFile = new Set<string>();

  for (const row of folded) {
    const fact = facts.get(row.instrumentId);
    if (fact === undefined) continue; // unreachable: the alias's foreign key guarantees it

    rows.push({ ...row, name: fact.name, price: fact.price });
    inFile.add(row.instrumentId);

    const isPriced = fact.price !== null;
    const noteParts = [
      holdingNote({
        assetClass: fact.assetClass as AssetClass,
        isPriced,
        isStale: isPriced && (fact.isStale ?? false),
      }),
    ];
    if (row.lineCount > 1) noteParts.push(`${row.lineCount} rows combined`);

    const before = currentById.get(row.instrumentId);

    if (before === undefined) {
      added.push({
        instrumentId: row.instrumentId,
        symbol: fact.symbol,
        name: fact.name,
        note: noteParts.join(" · "),
        quantity: row.quantity,
        costBasisPerShare: row.costBasisPerShare,
        value: valueAt(row.quantity, fact.price),
      });
      continue;
    }

    const quantityChanged = !sameQuantity(before.quantity, row.quantity);
    const basisChanged = !sameBasis(before.costBasisPerShare, row.costBasisPerShare);

    if (!quantityChanged && !basisChanged) {
      unchangedCount += 1;
      continue;
    }

    const basisDisappeared = before.costBasisPerShare !== null && row.costBasisPerShare === null;
    // A dash on the right of an arrow is quiet in exactly the place it should
    // not be, so the disappearance is said in words as well.
    if (basisDisappeared) noteParts.push("cost basis no longer reported");

    updated.push({
      instrumentId: row.instrumentId,
      symbol: fact.symbol,
      name: fact.name,
      note: noteParts.join(" · "),
      quantityBefore: before.quantity,
      quantityAfter: row.quantity,
      quantityChanged,
      costBasisBefore: before.costBasisPerShare,
      costBasisAfter: row.costBasisPerShare,
      basisChanged,
      basisDisappeared,
      value: valueAt(row.quantity, fact.price),
    });
  }

  // Every current holding the file does not carry is removed — in full, each
  // with its last known value, or `holdingNote`'s "never priced" where nothing
  // ever quoted it.
  const removed: DiffRemoved[] = current
    .filter((holding) => !inFile.has(holding.instrumentId))
    .map((holding) => ({
      instrumentId: holding.instrumentId,
      symbol: holding.symbol,
      name: holding.instrumentName,
      note: holdingNote(holding),
      quantity: holding.quantity,
      costBasisPerShare: holding.costBasisPerShare,
      value: holding.value,
    }));

  // "No statement yet" through `lastRecorded`, not through an empty holdings
  // read: an account sold down to nothing has a statement and gets an honest
  // three-count diff, while a first upload reads as "14 added".
  const firstStatement = (await lastRecorded(draft.accountId, db)) === null;

  return {
    diff: {
      draftId: draft.id,
      accountId: draft.accountId,
      accountName: draft.accountName,
      filename: draft.filename,
      added,
      updated,
      removed,
      unchangedCount,
      currentCount: current.length,
      firstStatement,
      majorityRemoved: removed.length * 2 > current.length,
      removesEverything: current.length > 0 && removed.length === current.length,
      skipped: parsed.skipped.map(({ row, instrument }) => ({ row, instrument })),
      asOf:
        parsed.asOfDate !== null
          ? { source: "file", date: parsed.asOfDate }
          : { source: "asked" },
      instrumentsSkipped: draft.hadFirstSightings === false,
    },
    rows,
    fileAccountNumber: rows.find((row) => row.accountNumber !== null)?.accountNumber ?? null,
  };
}

/**
 * The review screen's read: what this draft's file changes.
 *
 * @throws {NotFoundError} through {@link requireDraft} for a dead draft.
 * @throws {DraftNotReadyError} when an earlier step has not been passed.
 */
export async function diffForDraft(
  draftId: string,
  db: Kysely<Database> = getDb(),
): Promise<UploadDiff> {
  const draft = await requireDraft(draftId, db);
  return (await assembleDiff(draft, db)).diff;
}

/* -------------------------------------------------------------------------- */
/*  The commit                                                                 */
/* -------------------------------------------------------------------------- */

/** The review form's fields, unvalidated — validating them is the commit's job. */
export type CommitInput = {
  /** The statement date, only read when the file did not date itself. */
  asOf?: string;
  /** "true" when the majority-removal sentence was ticked. */
  confirmRemovals?: string;
  /** The hidden account-id field. It feeds the expired page's link, and here
   *  only guards that the post and the draft agree about the account. */
  accountId?: string;
};

/** What the redirect and its receipt need to know about the write. */
export type CommittedUpload = {
  setId: string;
  accountId: string;
  accountName: string;
  filename: string;
  asOf: IsoDate;
  counts: { added: number; updated: number; unchanged: number; removed: number };
};

/**
 * The flow's one write: the immutable `position_set`, one holding per parsed
 * row, the draft deleted — one transaction, so nothing partially applied can
 * exist.
 *
 * The refusals run before it, state-level first and every one a sentence:
 *
 * - a closed account, in `setBalance`'s words — closed while the draft sat open
 * - a posted account id disagreeing with the draft's — a stale or forged form
 * - the account-number guard, both halves naming both numbers: a file whose
 *   own rows disagree about the number is not a statement of one account, and
 *   a mapped account-number column disagreeing with the number recorded on
 *   the account is the silent-collision failure §5.1 made accounts
 *   first-class to avoid, caught at the moment it would happen; the number is
 *   a guard, never a selector
 * - the as-of date, validated by `recordedDate` when the file did not date
 *   itself. When it did, the file's date is used and a posted one is not
 *   consulted — the review renders no control in that case, so a date can only
 *   arrive from a stale or hand-built post, and a statement's own date must
 *   not be overridable by one
 * - the product guard, per row: `quantity × cost_basis_per_share` and the same
 *   product against the instrument's current price where one exists, since
 *   `holding_valued` casts both. One failing row refuses the whole commit and
 *   names the instrument
 * - the majority-removal tick, unticked: refused in the ratio's words, nothing
 *   written
 *
 * A second upload for a date that already has one is allowed —
 * `latest_position_set`'s `created_at`-then-`id` tie-break already resolves
 * it. Posting a committed draft again is a {@link NotFoundError}, which the
 * route renders as the expired-or-recorded page.
 *
 * @throws {ValidationError} for every refusal above.
 * @throws {NotFoundError} for a dead draft, including a re-POST after commit.
 * @throws {DraftNotReadyError} when an earlier step has not been passed.
 */
export async function commitUpload(
  draftId: string,
  raw: CommitInput,
  db: Kysely<Database> = getDb(),
): Promise<CommittedUpload> {
  const draft = await findDraft(draftId, db);
  if (draft === undefined) throw new NotFoundError(EXPIRED);

  // Before everything else, deliberately, and in `setBalance`'s words: a
  // person whose account closed while the draft sat open has a problem no
  // ticked box or typed date will fix.
  if (draft.accountClosedAt !== null) {
    throw ValidationError.form(
      `${draft.accountName} is closed, and a closed account's history does not change. ` +
        "Reopen it from Settings if this statement is still real.",
    );
  }

  // The hidden field feeds the expired page's link, never a write — but a post
  // naming a different account than the draft's is a stale or forged form, and
  // it is refused rather than wondered about.
  if (raw.accountId !== undefined && raw.accountId !== draft.accountId) {
    throw ValidationError.form(
      "This form was posted for a different account than the one this upload is recording " +
        "a statement against. Reload the review and check what it is about to record.",
    );
  }

  const { diff, rows, fileAccountNumber } = await assembleDiff(draft, db);

  // The intra-file half of the account-number guard: a file carrying two
  // different numbers is not a statement of one account, whatever number the
  // account has recorded — refused naming both, never resolved by picking
  // one, the same shape as the parser's as-of disagreement.
  const numbers = rows.flatMap((row) =>
    row.accountNumber !== null ? [row.accountNumber] : [],
  );
  const firstNumber = numbers[0];
  const differingNumber = numbers.find((number) => number !== firstNumber);
  if (firstNumber !== undefined && differingNumber !== undefined) {
    throw ValidationError.form(
      `This file says it describes account "${firstNumber}" on one row and ` +
        `"${differingNumber}" on another, and a statement describes one account. ` +
        "Check which account this export belongs to — nothing was recorded.",
    );
  }

  // The account-number guard (§9.12 of the brief: a guard, never a selector).
  if (draft.accountNumber !== null) {
    const disagreeing = rows.find(
      (row) => row.accountNumber !== null && row.accountNumber !== draft.accountNumber,
    );
    if (disagreeing !== undefined) {
      throw ValidationError.form(
        `This file says it describes account "${disagreeing.accountNumber}", and ` +
          `${draft.accountName} is recorded as account "${draft.accountNumber}". A statement ` +
          "lands in the account it describes — check which account this export belongs to.",
      );
    }
  }

  const asOf: IsoDate =
    diff.asOf.source === "file"
      ? diff.asOf.date
      : parseInput(z.object({ asOf: recordedDate("The statement date") }), { asOf: raw.asOf })
          .asOf;

  // The product guard, both multiplications `holding_valued` will perform. A
  // product past `numeric(20, 4)` does not fail the write — it succeeds, and
  // then the view raises on every request, taking Holdings and Analysis down
  // together. One failing row refuses the whole commit; nothing partially
  // applied.
  for (const row of rows) {
    if (!fitsTheMoneyColumn(row.quantity, row.costBasisPerShare)) {
      throw ValidationError.form(
        `${row.name}'s quantity multiplied by its cost basis is a larger figure than this ` +
          "application can hold, so nothing was recorded. Check both columns against the " +
          "sample rows — a cost basis is what one share cost, not what the whole position did.",
      );
    }
    if (!fitsTheMoneyColumn(row.quantity, row.price)) {
      throw ValidationError.form(
        `${row.name}'s quantity valued at its current price is a larger figure than this ` +
          "application can hold, so nothing was recorded. Check the quantity column against " +
          "the sample rows.",
      );
    }
  }

  if (diff.majorityRemoved && raw.confirmRemovals !== "true") {
    const ratio = diff.removesEverything
      ? `This file removes every position this account holds — all ${diff.currentCount}.`
      : `This file removes ${diff.removed.length} of the ${diff.currentCount} positions ` +
        "this account holds.";
    throw ValidationError.form(
      `${ratio} Nothing was recorded — confirm the removals to record this statement.`,
    );
  }

  return inTransaction(db, async (trx) => {
    // The draft's deletion leads, and is the transaction's guard: a concurrent
    // commit that got here first has already taken the row, and a second
    // position set must not land behind its back. Nothing before this point
    // wrote anything, so aborting here aborts everything.
    const taken = await trx
      .deleteFrom("upload_draft")
      .where("id", "=", draft.id)
      .executeTakeFirst();
    if (taken.numDeletedRows === 0n) throw new NotFoundError(EXPIRED);

    const set = await trx
      .insertInto("position_set")
      .values({
        account_id: draft.accountId,
        as_of_date: asOf,
        source: "upload",
        source_filename: draft.filename,
        raw_file: Buffer.from(draft.bytes),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    if (rows.length > 0) {
      await trx
        .insertInto("holding")
        .values(
          rows.map((row) => ({
            position_set_id: set.id,
            instrument_id: row.instrumentId,
            // Zero stays zero and null stays null: a dropped row is
            // unreachable from the table that no longer prints it, and a
            // defaulted basis reports a fake gain (§5.4, 0001).
            quantity: row.quantity,
            cost_basis_per_share: row.costBasisPerShare,
          })),
        )
        .execute();
    }

    // Captured only where the column is still empty, so a number recorded by
    // hand — or by a concurrent upload — is never silently overwritten.
    if (fileAccountNumber !== null && draft.accountNumber === null) {
      await trx
        .updateTable("account")
        .set({ external_account_number: fileAccountNumber })
        .where("id", "=", draft.accountId)
        .where("external_account_number", "is", null)
        .execute();
    }

    return {
      setId: set.id,
      accountId: draft.accountId,
      accountName: draft.accountName,
      filename: draft.filename,
      asOf,
      counts: {
        added: diff.added.length,
        updated: diff.updated.length,
        unchanged: diff.unchangedCount,
        removed: diff.removed.length,
      },
    };
  });
}

/* -------------------------------------------------------------------------- */
/*  The receipt                                                                */
/* -------------------------------------------------------------------------- */

/** What the account page's `?uploaded=` confirmation sentence states. */
export type UploadReceipt = {
  setId: string;
  asOf: IsoDate;
  /** Null for a set with no filename — the receipt says "the statement". */
  filename: string | null;
  /** True when the set has no predecessor: the sentence reads "14 added". */
  firstStatement: boolean;
  counts: { added: number; updated: number; unchanged: number; removed: number };
  /**
   * How many positions the recorded set holds — the receipt's closing
   * "now holds N positions" (brief §6.5), counted from the set's own rows so
   * a hand-typed parameter can only ever describe what is stored.
   */
  holdingCount: number;
};

/**
 * The receipt for `?uploaded=<setId>` — recomputed from the database, never
 * trusted from the URL. The parameter names *which* set was written and says
 * nothing about what is in it, so a hand-typed value can only ever produce a
 * sentence describing what the account actually holds (the same guarantee the
 * `?recorded=` receipt already has).
 *
 * The counts are the named set diffed against its predecessor under the same
 * `as_of_date desc, created_at desc, id desc` ordering `latest_position_set`
 * implements — the function itself cannot answer "what was latest before this
 * one", so its ordering is cited here rather than re-derived as a new rule.
 *
 * @returns null for a set that is not the account's latest, not the account's
 *          at all, or not an id — a stale bookmark renders no receipt.
 */
export async function uploadReceipt(
  accountId: string,
  setId: string,
  db: Kysely<Database> = getDb(),
): Promise<UploadReceipt | null> {
  if (!/^\d+$/.test(accountId) || !/^\d+$/.test(setId)) return null;

  // "Latest" through the shared read, so the receipt and every figure on the
  // page resolve the same set. A set the account is no longer reading gets no
  // sentence — the receipt describes the holdings on screen or nothing.
  const latest = await lastRecorded(accountId, db);
  if (latest === null || latest.id !== setId) return null;

  const set = await db
    .selectFrom("position_set")
    .select(["id", "as_of_date", "created_at", "source_filename"])
    .where("id", "=", setId)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  if (set === undefined) return null;

  const predecessor = await sql<{ id: string }>`
    select ps.id
    from position_set ps
    where ps.account_id = ${accountId}::bigint
      and (ps.as_of_date, ps.created_at, ps.id)
        < (${set.as_of_date}::date, ${set.created_at}::timestamptz, ${setId}::bigint)
    order by ps.as_of_date desc, ps.created_at desc, ps.id desc
    limit 1
  `.execute(db);
  const predecessorId = predecessor.rows[0]?.id ?? null;

  const holdingRows = await db
    .selectFrom("holding")
    .select(["position_set_id", "instrument_id", "quantity", "cost_basis_per_share"])
    .where(
      "position_set_id",
      "in",
      predecessorId === null ? [set.id] : [set.id, predecessorId],
    )
    .execute();

  const before = new Map(
    holdingRows
      .filter((row) => row.position_set_id === predecessorId)
      .map((row) => [row.instrument_id, row]),
  );

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let holdingCount = 0;

  for (const row of holdingRows) {
    if (row.position_set_id !== set.id) continue;
    holdingCount += 1;
    const prior = before.get(row.instrument_id);
    if (prior === undefined) {
      added += 1;
      continue;
    }
    if (
      sameQuantity(prior.quantity, row.quantity) &&
      sameBasis(prior.cost_basis_per_share, row.cost_basis_per_share)
    ) {
      unchanged += 1;
    } else {
      updated += 1;
    }
    before.delete(row.instrument_id);
  }

  return {
    setId: set.id,
    asOf: set.as_of_date,
    filename: set.source_filename,
    firstStatement: predecessorId === null,
    counts: { added, updated, unchanged, removed: before.size },
    holdingCount,
  };
}
