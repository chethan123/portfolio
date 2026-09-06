// Upload draft: the staging row behind an in-progress statement upload (DESIGN.md §5.1,
// docs/specs/0004-ingest.md). Four screens, each a real URL with no client state — everything a
// step needs lives on one upload_draft row (bytes, filename, and once columns passes, the
// mapping and whether it raised a first sighting), so reload/back/bookmarked steps all behave.
// Also the app's first multipart read (formFields drops file parts), so size/file handling
// live here too.
//
// Drafts are swept, not scheduled: rows older than 24h die at the next upload's start
// (createDraft) — no cron for a handful of rows. A dead draft is one 404, not four: swept,
// committed, mistyped and closed-account all read the same expired-or-recorded page, since the
// next move (start again) is the same. Size cap is guarded twice: refuseOversizedBody checks
// Content-Length before the body buffers; File.size catches whatever arrives without one.
//
// The flow's last step lives here too: diffForDraft states what the file changes, commitUpload
// is the one write (one transaction), uploadReceipt recomputes the ?uploaded= confirmation from
// the database so a hand-typed parameter can only describe what was recorded.
import { z } from "zod";

import { sql } from "kysely";

import { getConfig } from "../../server/config.ts";
import { numberTail } from "./account-label.ts";
import { getAccount } from "./accounts.server.ts";
import { lastRecorded, type LastRecorded } from "./balances.server.ts";
import { headerFingerprint, upsertMapping } from "./column-mapping.server.ts";
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
import type {
  ParseProblem,
  ParsedPosition,
  ParsedStatement,
  StatementMapping,
} from "./statement.ts";
import type { Kysely } from "kysely";

const BYTES_PER_MB = 1024 * 1024;

// draft.tsx's error boundary renders this under its own page title, whatever killed the draft.
const EXPIRED =
  "This upload has expired or was already recorded. A draft is kept for a day " +
  "and deleted once its statement lands, so a bookmarked or reopened step can " +
  "outlive it.";

export type UploadDraft = {
  id: string;
  accountId: string;
  accountName: string;
  // For the identity strip: least-sufficient info when resuming cold with two same-named accounts.
  ownerName: string;
  // "····" + last four, or null — pre-masked so the raw number never leaves the commit path.
  accountNumberTail: string | null;
  filename: string;
  // Exactly as they arrived — BOM, CRLF and all.
  bytes: Uint8Array;
  // Null until the columns step passes — "how far did this draft get" as a property of the row.
  mapping: unknown;
  // Whether the columns parse raised a first sighting; null until that step decides. Written
  // then because it's unrecoverable after — an alias doesn't say which draft wrote it.
  hadFirstSightings: boolean | null;
  createdAt: Date;
};

export type DraftInput = {
  accountId: string;
  filename: string;
  bytes: Uint8Array;
};

// Content-Length is all that exists before the body buffers. A request without one falls
// through to parseUploadForm's File.size check.
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

// Guards run in spec order: missing field, oversize, empty file, non-UTF-8 — each refusing as
// the thing it is, never a driver error. File read directly since formFields drops file parts.
// Leading BOM is valid UTF-8, not a failure (step 02 strips it).
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

// Sweeps stale drafts (24h+), then stages this file. Sweep runs right before the insert since
// starting an upload is the one moment guaranteed to look at the table — no scheduler.
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

// Two account facts only the commit reads: whether the account closed underneath it, and the
// number the statement's account-number column is guarded against.
type DraftRecord = UploadDraft & {
  accountClosedAt: Date | null;
  accountNumber: string | null;
};

// Closed accounts are not filtered here: requireDraft reads one as expired, commitUpload owes
// it a sentence, and both start from this.
async function findDraft(
  draftId: string,
  db: Kysely<Database>,
): Promise<DraftRecord | undefined> {
  // "abc" would fail as a malformed bigint — a 500 wearing a bookmark.
  if (!/^\d+$/.test(draftId)) return undefined;

  const row = await db
    .selectFrom("upload_draft")
    .innerJoin("account", "account.id", "upload_draft.account_id")
    .innerJoin("person", "person.id", "account.owner_id")
    .select([
      "upload_draft.id",
      "upload_draft.account_id",
      "account.name as account_name",
      "person.name as owner_name",
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
    ownerName: row.owner_name,
    accountNumberTail: numberTail(row.external_account_number),
    filename: row.filename,
    bytes: row.raw_file,
    mapping: row.mapping,
    hadFirstSightings: row.had_first_sightings,
    createdAt: row.created_at,
    accountClosedAt: row.closed_at,
    accountNumber: row.external_account_number,
  };
}

export async function requireDraft(
  draftId: string,
  db: Kysely<Database> = getDb(),
): Promise<UploadDraft> {
  const row = await findDraft(draftId, db);

  // A closed account's draft is expired, not forbidden: its history can't change, so this
  // staged upload can never land.
  if (row === undefined || row.accountClosedAt !== null) throw new NotFoundError(EXPIRED);

  return row;
}

// Columns step passing: mapping lands on the draft, and the next step comes back to the caller.
// had_first_sightings is decided and written here, the one moment the answer exists (once
// instruments writes aliases, "skipped" and "passed" look the same) — nextStep is that same bit
// handed back, never re-asked after the write, so an alias landing in between can't disagree
// with where the reader was sent. Everything derives from the draft's own bytes, re-read here.
// The two writes aren't one transaction: the draft's mapping is the columns step; the
// institution's remembered mapping is a rebuildable cache whose failure mustn't undo a step
// that passed.
export async function rememberMapping(
  draftId: string,
  mapping: StatementMapping,
  db: Kysely<Database> = getDb(),
): Promise<{ problems: ParseProblem[] } | { nextStep: "instruments" | "review" }> {
  const draft = await requireDraft(draftId, db);

  const { rows } = readCsv(draft.bytes, mapping.delimiter);
  const parsed = parseStatement(rows, mapping);

  // Problems mean the columns step didn't genuinely pass, so nothing is written.
  if (parsed.problems.length > 0) return { problems: parsed.problems };

  // No positions and nothing skipped = instrument column empty on every row. (All-skipped is
  // different: the column has content, and review owns what an empty statement means.)
  if (parsed.positions.length === 0 && parsed.skipped.length === 0) {
    throw new ValidationError({
      instrument:
        `No row in this file has anything under "${mapping.columns.instrument}", ` +
        "so it cannot be the instrument column. Check the column choice and the header row.",
    });
  }

  // Asked once: this answer is both the bit the strip reads and the step the reader is sent to.
  const hadFirstSightings =
    (
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

  // So the next file with this header opens prefilled.
  const account = await getAccount(draft.accountId, db);
  await upsertMapping(
    account.institution,
    headerFingerprint(rows[mapping.headerRow] ?? []),
    mapping,
    db,
  );

  return { nextStep: hadFirstSightings ? "instruments" : "review" };
}

// Where a draft's file stands against the flow's steps, decided once here rather than per
// resuming route. step names the earliest step still owed; null = diffable and committable.
// columns variant carries nothing: a mapping that doesn't parse has nothing trustworthy to carry.
export type DraftParse =
  | { step: "columns" }
  | {
      step: "instruments";
      parsed: ParsedStatement;
      mapping: StatementMapping;
      unresolved: string[];
    }
  | { step: null; parsed: ParsedStatement; mapping: StatementMapping };

export async function parseDraft(
  draft: UploadDraft,
  db: Kysely<Database> = getDb(),
): Promise<DraftParse> {
  const saved = statementMapping.safeParse(draft.mapping);
  if (!saved.success) return { step: "columns" };

  // The mapping's own delimiter, never a second sniff.
  const { rows } = readCsv(draft.bytes, saved.data.delimiter);
  const parsed = parseStatement(rows, saved.data);

  // A saved mapping only lands after a clean parse, so problems here mean the row predates a
  // rule or was hand-written — remapping is the fix.
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

// Not a refusal, not a 404 — the reader's next move is an earlier step, and routes redirect there.
export class DraftNotReadyError extends Error {
  override readonly name = "DraftNotReadyError";
  readonly step: "columns" | "instruments";

  constructor(step: "columns" | "instruments") {
    super(`This draft has not passed the ${step} step.`);
    this.step = step;
  }
}

type DiffInstrument = {
  instrumentId: string;
  // Null = no public ticker, no badge drawn.
  symbol: string | null;
  name: string;
  // holdingNote's words plus this row's own ("3 rows combined", …), composed here so two
  // screens can't spell one condition two ways.
  note: string;
};

export type DiffAdded = DiffInstrument & {
  quantity: string;
  costBasisPerShare: string | null;
  // At the current quote — context, not part of the write. Null when never priced.
  value: string | null;
};

export type DiffUpdated = DiffInstrument & {
  // As stored (numeric(20,8) full scale) — formatQuantity trims it.
  quantityBefore: string;
  quantityAfter: string;
  quantityChanged: boolean;
  costBasisBefore: string | null;
  costBasisAfter: string | null;
  basisChanged: boolean;
  // "figure -> —" is quiet exactly where it shouldn't be, so the note says it too.
  basisDisappeared: boolean;
  value: string | null;
};

export type DiffRemoved = DiffInstrument & {
  // What the account holds now, which this file sells.
  quantity: string;
  costBasisPerShare: string | null;
  // Never $0.00 for a holding nothing ever priced.
  value: string | null;
};

export type UploadDiff = {
  draftId: string;
  accountId: string;
  accountName: string;
  ownerName: string;
  accountNumberTail: string | null;
  filename: string;
  added: DiffAdded[];
  updated: DiffUpdated[];
  // Every removed position individually — a count alone is how a filtered export sells 28
  // holdings nobody read about (§5.2).
  removed: DiffRemoved[];
  // Unchanged rows are absent from the table; the count is all one has to say.
  unchangedCount: number;
  // Removal ratio's denominator.
  currentCount: number;
  // No statement yet: reads as "14 added", not a diff against nothing.
  firstStatement: boolean;
  // More than half of current holdings removed — commit demands a tick.
  majorityRemoved: boolean;
  removesEverything: boolean;
  skipped: Array<{ row: number; instrument: string }>;
  asOf: { source: "file"; date: IsoDate } | { source: "asked" };
  // True only when columns recorded no first sightings (dims "· none"). False for both a
  // genuinely visited step and a pre-bit draft — an unknown history doesn't get to claim it.
  instrumentsSkipped: boolean;
};

type FileRow = {
  instrumentId: string;
  name: string;
  quantity: string;
  costBasisPerShare: string | null;
  accountNumber: string | null;
  // For the value column and the product guard.
  price: string | null;
  // For the product guard alone (no dividend column rendered). Null = never refreshed, view reads as zero.
  annualDividendPerShare: string | null;
  // File lines feeding this row — parser combines and spelling folds both.
  lineCount: number;
};

type AssembledDiff = {
  diff: UploadDiff;
  rows: FileRow[];
  // First account number the file carried, or null if none.
  fileAccountNumber: string | null;
};

// Kysely refuses .transaction() on a transaction; the test seam is one (instrument-resolution.server.ts
// carries the same helper).
function inTransaction<T>(
  db: Kysely<Database>,
  body: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.isTransaction ? body(db) : db.transaction().execute(body);
}

// quantity x price at money scale, for a row holding_valued has no SQL row to compute yet.
// Same digits the view produces: 10^-12 units divided back to money's 10^-4, rounded half away
// from zero.
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

function sameBasis(before: string | null, after: string | null): boolean {
  if (before === null || after === null) return before === after;
  return toUnits(before, MONEY_SCALE) === toUnits(after, MONEY_SCALE);
}

function sameQuantity(before: string, after: string): boolean {
  return toUnits(before, QUANTITY_SCALE) === toUnits(after, QUANTITY_SCALE);
}

// Parses the draft through its saved mapping, resolves every string, classifies against what
// the account holds now (via accountHoldings — never a second order-by here, §8.2). Two
// spellings of one fund (both aliased to it) fold exactly as the parser folds a duplicated
// string: quantities summed, basis quantity-weighted, null if any lot's basis is unknown —
// parseStatement defers this fold on purpose, since resolution hasn't happened yet there.
async function assembleDiff(
  draft: UploadDraft,
  db: Kysely<Database>,
): Promise<AssembledDiff> {
  const result = await parseDraft(draft, db);
  if (result.step !== null) throw new DraftNotReadyError(result.step);
  const { parsed } = result;

  // parseDraft already established every string resolves; this read is for the ids.
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

  type FoldedRow = Omit<FileRow, "name" | "price" | "annualDividendPerShare">;
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

    // Signs already applied, so the sum is over final quantities; foldLots is the parser's own
    // rule, called from both places.
    const fold = foldLots(group);

    folded.push({
      instrumentId,
      quantity: fold.quantity,
      costBasisPerShare: fold.costBasisPerShare,
      accountNumber,
      lineCount,
    });
  }

  // Dividend rate is read and nowhere rendered: the view multiplies it by whatever this commit writes.
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
            "quote.annual_dividend_per_share as annualDividendPerShare",
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

    rows.push({
      ...row,
      name: fact.name,
      price: fact.price,
      annualDividendPerShare: fact.annualDividendPerShare,
    });
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

  // Every current holding the file doesn't carry is removed — in full.
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

  // Via lastRecorded, not an empty holdings read: an account sold to nothing still has a
  // statement and gets an honest diff, while a first upload reads as "14 added".
  const firstStatement = (await lastRecorded(draft.accountId, db)) === null;

  return {
    diff: {
      draftId: draft.id,
      accountId: draft.accountId,
      accountName: draft.accountName,
      ownerName: draft.ownerName,
      accountNumberTail: draft.accountNumberTail,
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

export async function diffForDraft(
  draftId: string,
  db: Kysely<Database> = getDb(),
): Promise<UploadDiff> {
  const draft = await requireDraft(draftId, db);
  return (await assembleDiff(draft, db)).diff;
}

export type CommitInput = {
  // Only read when the file didn't date itself.
  asOf?: string;
  // "true" when the majority-removal sentence was ticked.
  confirmRemovals?: string;
  // Hidden field feeds the expired page's link; here it only guards post/draft agreement.
  accountId?: string;
};

export type CommittedUpload = {
  setId: string;
  accountId: string;
  accountName: string;
  filename: string;
  asOf: IsoDate;
  counts: { added: number; updated: number; unchanged: number; removed: number };
};

// The flow's one write: immutable position_set, one holding per parsed row, draft deleted —
// one transaction. Refusals run first, each a sentence: closed account; posted account id
// disagreeing with the draft's (stale/forged form); the account-number guard, naming both
// numbers when a file disagrees with itself or with the recorded number (§5.1's silent-collision
// caught at the moment it'd happen — a guard, never a selector); the as-of date via recordedDate
// only when the file didn't date itself (a self-dated file's posted date is never consulted —
// review renders no control for it, so one only arrives stale/hand-built); the product guard per
// row (all three multiplications holding_valued casts, one failing row refuses the whole
// commit); the majority-removal tick. A second upload for an already-recorded date is allowed
// (latest_position_set's tie-break resolves it); re-posting a committed draft is a NotFoundError.
export async function commitUpload(
  draftId: string,
  raw: CommitInput,
  db: Kysely<Database> = getDb(),
): Promise<CommittedUpload> {
  const draft = await findDraft(draftId, db);
  if (draft === undefined) throw new NotFoundError(EXPIRED);

  // First: a closed account isn't fixable by a ticked box or typed date.
  if (draft.accountClosedAt !== null) {
    throw ValidationError.form(
      `${draft.accountName} is closed, and a closed account's history does not change. ` +
        "Reopen it from Settings if this statement is still real.",
    );
  }

  // Hidden field feeds the expired page's link only — a different account is stale/forged.
  if (raw.accountId !== undefined && raw.accountId !== draft.accountId) {
    throw ValidationError.form(
      "This form was posted for a different account than the one this upload is recording " +
        "a statement against. Reload the review and check what it is about to record.",
    );
  }

  const { diff, rows, fileAccountNumber } = await assembleDiff(draft, db);

  // Intra-file half of the guard: two numbers in one file isn't one account — refuse naming
  // both, never resolve by picking one.
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

  // Account-number guard: never a selector.
  if (draft.accountNumber !== null) {
    const disagreeing = rows.find(
      (row) => row.accountNumber !== null && row.accountNumber !== draft.accountNumber,
    );
    if (disagreeing !== undefined) {
      throw ValidationError.form(
        `This file says it describes account "${disagreeing.accountNumber}", and ` +
          `${draft.accountName} — owned by ${draft.ownerName} — is recorded as account ` +
          `"${draft.accountNumber}". A statement lands in the account it describes — check ` +
          "which account this export belongs to.",
      );
    }
  }

  const asOf: IsoDate =
    diff.asOf.source === "file"
      ? diff.asOf.date
      : parseInput(z.object({ asOf: recordedDate("The statement date") }), { asOf: raw.asOf })
          .asOf;

  // All three multiplications the view performs. Unchecked, an overflow would succeed here then
  // make the view raise on every request. One failing row refuses the whole commit.
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
    if (!fitsTheMoneyColumn(row.quantity, row.annualDividendPerShare)) {
      throw ValidationError.form(
        `${row.name}'s quantity at its current dividend rate projects a larger annual ` +
          "dividend than this application can hold, so nothing was recorded. Check the " +
          "quantity column against the sample rows.",
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
    // Deletion leads and is the transaction's guard: a concurrent commit already took the row,
    // and a second position set must not land behind its back.
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
            // Zero stays zero, null stays null: a defaulted basis reports a fake gain (§5.4, 0001).
            quantity: row.quantity,
            cost_basis_per_share: row.costBasisPerShare,
          })),
        )
        .execute();
    }

    // Only where the column is still empty, so a hand-recorded or concurrent number is never
    // silently overwritten.
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

export type UploadReceipt = {
  setId: string;
  asOf: IsoDate;
  // Null for a set with no filename — receipt says "the statement".
  filename: string | null;
  // True when the set has no predecessor: reads as "14 added".
  firstStatement: boolean;
  counts: { added: number; updated: number; unchanged: number; removed: number };
  // Counted from the set's own rows so a hand-typed parameter can only describe what is stored.
  holdingCount: number;
};

// ?uploaded=<setId> is recomputed from the database, never trusted from the URL — the parameter
// names which set, not what's in it. Diffed against its predecessor under the same
// as_of_date/created_at/id ordering latest_position_set implements. Returns null for a set
// that isn't the account's latest, isn't the account's, or isn't an id — a stale bookmark
// renders no receipt.
export async function uploadReceipt(
  accountId: string,
  setId: string,
  latest: LastRecorded | null,
  db: Kysely<Database> = getDb(),
): Promise<UploadReceipt | null> {
  if (!/^\d+$/.test(accountId) || !/^\d+$/.test(setId)) return null;

  // Through the shared read, so the receipt and every other figure resolve the same set.
  if (latest === null || latest.id !== setId) {
    return null;
  }

  const [set, predecessor] = await Promise.all([
    db
      .selectFrom("position_set")
      .select(["id", "as_of_date", "created_at", "source_filename"])
      .where("id", "=", setId)
      .where("account_id", "=", accountId)
      .executeTakeFirst(),
    sql<{ id: string }>`
      select ps.id
      from position_set ps
      where ps.account_id = ${accountId}::bigint
        and (ps.as_of_date, ps.created_at, ps.id) < (
          select as_of_date, created_at, id from position_set
          where id = ${setId}::bigint and account_id = ${accountId}::bigint
          limit 1
        )
      order by ps.as_of_date desc, ps.created_at desc, ps.id desc
      limit 1
    `.execute(db),
  ]);

  if (set === undefined) return null;
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
