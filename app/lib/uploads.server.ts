// Upload draft: the staging row behind an in-progress upload (DESIGN.md §5.1,
// docs/specs/0004-ingest.md). Everything a step needs is on the one row, so
// reload/back/bookmark all work. Its first-sighting answers ride with it (upload_draft_answer)
// and become vocabulary only at commit. Drafts are swept at 24h by the next createDraft — no
// cron. Size capped twice: the body as it streams in, File.size after.
import { z } from "zod";

import { sql } from "kysely";

import { getConfig } from "../../server/config.ts";
import { numberTail } from "./account-label.ts";
import { getAccount, withAccountLock, type Account } from "./accounts.server.ts";
import { lastRecorded, type LastRecorded } from "./balances.server.ts";
import { headerFingerprint, upsertMapping } from "./column-mapping.server.ts";
import { readCsv } from "./csv.ts";
import { getDb, type Database } from "./db.server.ts";
import { describeInstrument } from "./format.ts";
import { holdingNote } from "./holdings-view.ts";
import { FORM_ERROR, NotFoundError, ValidationError, parseInput, recordedDate } from "./input.server.ts";
import { aliasesFor, unresolvedStrings } from "./instrument-resolution.server.ts";
import { MONEY_SCALE, QUANTITY_SCALE, divide, render, toUnits } from "./money.ts";
import { fitsTheMoneyColumn } from "./positions.server.ts";
import { foldLots, parseStatement, statementMapping } from "./statement.ts";
import { accountHoldings, accountHoldingsAt } from "./valuation.server.ts";

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
  ownerName: string;
  accountNumberTail: string | null;
  filename: string;
  bytes: Uint8Array;
  mapping: unknown;
  // Whether the columns parse raised a first sighting; null until that step decides. Written
  // then because it's unrecoverable after — a promoted alias doesn't say which draft wrote it.
  hadFirstSightings: boolean | null;
  createdAt: Date;
};

export type DraftInput = {
  accountId: string;
  filename: string;
  bytes: Uint8Array;
};

// Counted while streaming: chunked bodies carry no Content-Length; `request.formData()` buffers unbounded (#313).
export async function readUploadForm(request: Request): Promise<FormData> {
  const limit = getConfig().MAX_UPLOAD_MB;
  const tooLarge = () =>
    ValidationError.form(
      `This upload is larger than ${limit} MB, which is the most a statement file can be.`,
    );

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit * BYTES_PER_MB) throw tooLarge();

  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      received += chunk.value.byteLength;
      if (received > limit * BYTES_PER_MB) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(chunk.value);
    }
  }

  const contentType = request.headers.get("content-type") ?? "";
  return new Response(new Blob(chunks), { headers: { "content-type": contentType } }).formData();
}

const uploadInput = z.object({
  accountId: z
    .string({ message: "Choose the account this statement describes." })
    .regex(/^\d+$/, { message: "Choose the account this statement describes." }),

  // An empty file input submits a File with an empty name, so presence is the name.
  file: z.custom<File>((value) => value instanceof File && value.name !== "", {
    message: "Choose a statement file to upload.",
  }),
});

// Spec order: missing field, oversize, empty file, non-UTF-8. A leading BOM is valid (step 02 strips it).
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

// Sweeps stale drafts first: starting an upload is the one moment guaranteed to look at the table.
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

// One account fact beyond the draft: closed underneath it, which requireDraft reads as expired.
// commitUpload reads the account from the row it locked instead.
type DraftRecord = UploadDraft & {
  accountClosedAt: Date | null;
};

// Closed accounts stay in: requireDraft reads one as expired, commitUpload owes it a sentence.
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
  };
}

// Ahead of the lock, deciding only which account to take it on; the draft is read again under it.
async function draftAccountId(
  draftId: string,
  db: Kysely<Database>,
): Promise<string | undefined> {
  if (!/^\d+$/.test(draftId)) return undefined;

  const row = await db
    .selectFrom("upload_draft")
    .select("account_id")
    .where("id", "=", draftId)
    .executeTakeFirst();

  return row?.account_id;
}

export async function requireDraft(
  draftId: string,
  db: Kysely<Database> = getDb(),
): Promise<UploadDraft> {
  const row = await findDraft(draftId, db);

  // Expired, not forbidden: a closed account's history can't change, so this upload can never land.
  if (row === undefined || row.accountClosedAt !== null) throw new NotFoundError(EXPIRED);

  return row;
}

// had_first_sightings is written here, where the answer exists: vocabulary misses, plus the
// strings this draft already answered (a walk back to columns must not turn "passed" into
// "skipped"). nextStep sends the reader on only for what is still unanswered. Not one
// transaction: the institution's remembered mapping is a rebuildable cache.
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

  // No positions and nothing skipped = empty instrument column on every row (all-skipped differs).
  if (parsed.positions.length === 0 && parsed.skipped.length === 0) {
    throw new ValidationError({
      instrument:
        `No row in this file has anything under "${mapping.columns.instrument}", ` +
        "so it cannot be the instrument column. Check the column choice and the header row.",
    });
  }

  const strings = parsed.positions.map((position) => position.instrument);
  const unresolved = await unresolvedStrings(strings, draft.id, db);
  const answered =
    strings.length === 0
      ? undefined
      : await db
          .selectFrom("upload_draft_answer")
          .select("raw_string")
          .where("draft_id", "=", draft.id)
          .where("raw_string", "in", strings)
          .executeTakeFirst();
  const hadFirstSightings = unresolved.length > 0 || answered !== undefined;

  await db
    .updateTable("upload_draft")
    .set({
      mapping: JSON.stringify(mapping),
      had_first_sightings: hadFirstSightings,
    })
    .where("id", "=", draft.id)
    .execute();

  const account = await getAccount(draft.accountId, db);
  await upsertMapping(
    account.institution,
    headerFingerprint(rows[mapping.headerRow] ?? []),
    mapping,
    db,
  );

  return { nextStep: unresolved.length > 0 ? "instruments" : "review" };
}

// step names the earliest step still owed; null = diffable and committable.
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

  const { rows } = readCsv(draft.bytes, saved.data.delimiter);
  const parsed = parseStatement(rows, saved.data);

  // A saved mapping only lands after a clean parse, so problems mean it predates a rule — remap.
  if (parsed.problems.length > 0) return { step: "columns" };

  const unresolved = await unresolvedStrings(
    parsed.positions.map((position) => position.instrument),
    draft.id,
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
  symbol: string | null;
  name: string;
  // holdingNote's words plus this row's own, so two screens can't spell one condition two ways.
  note: string;
};

export type DiffAdded = DiffInstrument & {
  quantity: string;
  costBasisPerShare: string | null;
  value: string | null;
};

export type DiffUpdated = DiffInstrument & {
  quantityBefore: string;
  quantityAfter: string;
  quantityChanged: boolean;
  costBasisBefore: string | null;
  costBasisAfter: string | null;
  basisChanged: boolean;
  basisDisappeared: boolean;
  value: string | null;
};

export type DiffRemoved = DiffInstrument & {
  quantity: string;
  costBasisPerShare: string | null;
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
  removed: DiffRemoved[];
  unchangedCount: number;
  currentCount: number;
  firstStatement: boolean;
  majorityRemoved: boolean;
  removesEverything: boolean;
  skipped: Array<{ row: number; instrument: string }>;
  asOf: { source: "file"; date: IsoDate } | { source: "asked"; date: IsoDate | null };
  // True only when columns recorded no first sightings; false for a pre-bit draft too.
  instrumentsSkipped: boolean;
  // The set this diff was computed against — null for "nothing recorded on or before this date"
  // (CONTEXT.md, "Baseline"). The commit's binding confirmation: a form posting a different value
  // was drawn against figures a later read has moved past. "" is null's wire form (#181) — every
  // reader and every poster of this value must treat the two the same way.
  baselineSetId: string | null;
  // The baseline's own recorded date — null exactly when baselineSetId is null. Distinct from
  // asOf.date (the statement's own date) and filedBehind.currentAsOf (what the account reports
  // today): `added`/`updated`/`removed` above are all counted against this baseline, not today's
  // holdings, whenever it differs from the current set.
  baselineAsOf: IsoDate | null;
  // Non-null when the account's current statement is dated after this one: recording it still
  // rewrites history between its date and the next statement, even though it changes nothing the
  // account reports today.
  filedBehind: { asOf: IsoDate; currentAsOf: IsoDate } | null;
};

// A refusal decided after assembleDiff has already run, carrying the diff it was decided against
// so the review can re-render exactly what it refused rather than the loader's stale one (#181).
// `diff` is a field assigned in the body, not a parameter property — erasableSyntaxOnly
// (tsconfig.json) forbids those. Precedent for a payload-carrying domain error: DraftNotReadyError.
export class RefusedUpload extends ValidationError {
  readonly diff: UploadDiff;

  constructor(message: string, diff: UploadDiff) {
    super({ [FORM_ERROR]: message });
    this.diff = diff;
  }
}

type FileRow = {
  instrumentId: string;
  name: string;
  quantity: string;
  costBasisPerShare: string | null;
  accountNumber: string | null;
  price: string | null;
  annualDividendPerShare: string | null;
  lineCount: number;
};

type AssembledDiff = {
  diff: UploadDiff;
  rows: FileRow[];
  // What each distinct instrument cell the file states resolved to — the strings the commit
  // promotes the draft's answers for, and the meanings it must still find in vocabulary.
  resolved: Map<string, string>;
  fileAccountNumber: string | null;
  // The date the diff classified against, resolved once here. Null only when the loader asked
  // (asked === null) and neither the file nor a typed value named one yet; non-null by
  // construction whenever `asked` was given, since a bad or missing date throws before this
  // returns. Carried flat so the commit narrows it once, rather than re-narrowing diff.asOf.date.
  asOf: IsoDate | null;
};

// quantity x price for a row holding_valued cannot compute yet; same digits the view produces.
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

// Classified against the statement's own baseline (CONTEXT.md, "Baseline"): the latest set on or
// before its date, or — while the loader has no date yet to see — the account's current one. Two
// spellings of one fund fold as the parser folds a duplicate: quantities summed, basis
// quantity-weighted.
async function assembleDiff(
  draft: UploadDraft,
  // null: the loader, which reads no request body and so can never name a date. An object: the
  // commit, whose `asOf` may still be undefined (the field wasn't posted) — that must refuse the
  // same as an invalid one, so it is not conflated with "no date yet" (commit-upload.test.ts:1066).
  asked: null | { asOf: string | undefined },
  db: Kysely<Database>,
): Promise<AssembledDiff> {
  const result = await parseDraft(draft, db);
  if (result.step !== null) throw new DraftNotReadyError(result.step);
  const { parsed } = result;

  // Resolved once, ahead of everything else that depends on it (the baseline, filedBehind, the
  // write itself). Not a RefusedUpload: no diff exists yet for a bad date to attach to, and this
  // is the field error `commit-upload.test.ts:1057-1074` and review.tsx's `errors.asOf` read.
  const asOfResolved: IsoDate | null =
    parsed.asOfDate !== null
      ? parsed.asOfDate
      : asked !== null
        ? parseInput(z.object({ asOf: recordedDate("The statement date") }), { asOf: asked.asOf })
            .asOf
        : null;

  const strings = [...new Set(parsed.positions.map((position) => position.instrument))];
  const aliases = await aliasesFor(strings, draft.id, db);

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

    // Signs already applied, so the sum is over final quantities; foldLots is the parser's rule.
    const fold = foldLots(group);

    folded.push({
      instrumentId,
      quantity: fold.quantity,
      costBasisPerShare: fold.costBasisPerShare,
      accountNumber,
      lineCount,
    });
  }

  // The baseline (CONTEXT.md, "Baseline"): the latest set at or before the resolved date, or —
  // while the date is still unknown to the loader — the account's own current one, exactly as before.
  // `latestRecorded` is always the account's current set (undated), read alongside so filedBehind
  // needs no second query later.
  const [latestRecorded, baselineRecord] =
    asOfResolved === null
      ? await lastRecorded(draft.accountId, db).then((latest) => [latest, latest] as const)
      : await Promise.all([
          lastRecorded(draft.accountId, db),
          lastRecorded(draft.accountId, db, asOfResolved),
        ]);

  const current =
    asOfResolved === null
      ? await accountHoldings(draft.accountId, db)
      : await accountHoldingsAt(draft.accountId, asOfResolved, db);
  const currentById = new Map(current.map((holding) => [holding.instrumentId, holding]));

  // `ids` must cover the baseline's own instruments too, or a removed row (below) has no fact row
  // to price from `quote`. Deduped — an instrument both filed and held needs one row, not two
  // identical ones.
  const ids = [
    ...new Set([
      ...folded.map((row) => row.instrumentId),
      ...current.map((holding) => holding.instrumentId),
    ]),
  ];
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

  // Priced from `quote`, never the dated read's own price: a removed row sits in a column headed
  // "Value (at the current quote)" (review.tsx), and the dated read's price is a historical close
  // (#181). `fact` is unreachable-undefined here the same way it is above — `ids` now covers
  // every baseline instrument too.
  const removed: DiffRemoved[] = [];
  for (const holding of current) {
    if (inFile.has(holding.instrumentId)) continue;
    const fact = facts.get(holding.instrumentId);
    if (fact === undefined) continue; // unreachable: the baseline's own instruments are in `ids`

    const isPriced = fact.price !== null;
    removed.push({
      instrumentId: holding.instrumentId,
      symbol: fact.symbol,
      name: fact.name,
      note: holdingNote({
        assetClass: fact.assetClass as AssetClass,
        isPriced,
        isStale: isPriced && (fact.isStale ?? false),
      }),
      quantity: holding.quantity,
      costBasisPerShare: holding.costBasisPerShare,
      value: valueAt(holding.quantity, fact.price),
    });
  }

  // "" is null's wire form (#181) — every reader of this value must agree, starting here.
  const baselineSetId = baselineRecord?.id ?? null;
  const baselineAsOf = baselineRecord?.asOf ?? null;
  // Nothing recorded on or before the date — including the fallback undated read, so a truly
  // empty account and a date before all its history read the same way.
  const firstStatement = baselineSetId === null;

  // Only meaningful once a date is known: recording ahead of the account's own current set is
  // the ordinary case this compares nothing against.
  const filedBehind: UploadDiff["filedBehind"] =
    asOfResolved !== null && latestRecorded !== null && latestRecorded.asOf > asOfResolved
      ? { asOf: asOfResolved, currentAsOf: latestRecorded.asOf }
      : null;

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
          : { source: "asked", date: asOfResolved },
      instrumentsSkipped: draft.hadFirstSightings === false,
      baselineSetId,
      baselineAsOf,
      filedBehind,
    },
    rows,
    resolved: aliases,
    fileAccountNumber: rows.find((row) => row.accountNumber !== null)?.accountNumber ?? null,
    asOf: asOfResolved,
  };
}

export async function diffForDraft(
  draftId: string,
  db: Kysely<Database> = getDb(),
): Promise<UploadDiff> {
  const draft = await requireDraft(draftId, db);
  return (await assembleDiff(draft, null, db)).diff;
}

export type CommitInput = {
  asOf?: string;
  confirmRemovals?: string;
  accountId?: string;
  // The diff's own baselineSetId, echoed back (#181). "" is null's wire form — posting nothing
  // reads the same as posting "", which is what makes a first statement commit without a loop.
  baselineSetId?: string;
  confirmFiledBehind?: string;
};

export type CommittedUpload = {
  setId: string;
  accountId: string;
  accountName: string;
  filename: string;
  asOf: IsoDate;
  counts: { added: number; updated: number; unchanged: number; removed: number };
};

// The flow's one write: the draft's answers promoted to vocabulary, immutable position_set, one
// holding per parsed row, draft deleted — one transaction under withAccountLock (§7.2), so the
// diff and every guard read the statement this one lands on. Every refusal runs first, each
// commented below — reordered by #181: assembleDiff, and the date it resolves, now run ahead of
// the intra-file and account-number guards, because the date decides the baseline every guard
// after it reads. A second upload for an already-recorded date is allowed (latest_position_set's
// tie-break resolves it); re-posting a committed draft is a NotFoundError.
export async function commitUpload(
  draftId: string,
  raw: CommitInput,
  db: Kysely<Database> = getDb(),
): Promise<CommittedUpload> {
  const accountId = await draftAccountId(draftId, db);
  if (accountId === undefined) throw new NotFoundError(EXPIRED);

  return withAccountLock(accountId, db, (account, trx) =>
    commitUploadUnderLock(draftId, account, raw, trx),
  );
}

async function commitUploadUnderLock(
  draftId: string,
  account: Account,
  raw: CommitInput,
  db: Kysely<Database>,
): Promise<CommittedUpload> {
  // Gone by now: a concurrent commit took it while this one waited, or the 24h sweep did.
  const draft = await findDraft(draftId, db);
  if (draft === undefined) throw new NotFoundError(EXPIRED);

  // First: a closed account isn't fixable by a ticked box or typed date.
  if (account.isClosed) {
    throw ValidationError.form(
      `${account.name} is closed, and a closed account's history does not change. ` +
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

  // Resolves the date and classifies against its baseline in one place (#181) — every guard from
  // here on reads the dated diff. A bad or missing date throws here as a plain ValidationError:
  // no diff exists yet, so it cannot be a RefusedUpload.
  const { diff, rows, resolved, fileAccountNumber, asOf } = await assembleDiff(
    draft,
    { asOf: raw.asOf },
    db,
  );
  // Non-null by construction: `asked` was given above, so assembleDiff either resolved a date or
  // had already thrown over a bad one.
  if (asOf === null) {
    throw new Error("assembleDiff resolved no date on the commit path, which always asks for one.");
  }
  const rawStrings = [...resolved.keys()];

  // Intra-file half of the guard: refuse naming both numbers, never resolve by picking one.
  const numbers = rows.flatMap((row) =>
    row.accountNumber !== null ? [row.accountNumber] : [],
  );
  const firstNumber = numbers[0];
  const differingNumber = numbers.find((number) => number !== firstNumber);
  if (firstNumber !== undefined && differingNumber !== undefined) {
    throw new RefusedUpload(
      `This file says it describes account "${firstNumber}" on one row and ` +
        `"${differingNumber}" on another, and a statement describes one account. ` +
        "Check which account this export belongs to — nothing was recorded.",
      diff,
    );
  }

  // Account-number guard: never a selector.
  if (account.externalAccountNumber !== null) {
    const disagreeing = rows.find(
      (row) => row.accountNumber !== null && row.accountNumber !== account.externalAccountNumber,
    );
    if (disagreeing !== undefined) {
      throw new RefusedUpload(
        `This file says it describes account "${disagreeing.accountNumber}", and ` +
          `${draft.accountName} — owned by ${draft.ownerName} — is recorded as account ` +
          `"${account.externalAccountNumber}". A statement lands in the account it describes — check ` +
          "which account this export belongs to.",
        diff,
      );
    }
  }

  // All three multiplications the view performs; unchecked, the view raises on every request after.
  for (const row of rows) {
    if (!fitsTheMoneyColumn(row.quantity, row.costBasisPerShare)) {
      throw new RefusedUpload(
        `${row.name}'s quantity multiplied by its cost basis is a larger figure than this ` +
          "application can hold, so nothing was recorded. Check both columns against the " +
          "sample rows — a cost basis is what one share cost, not what the whole position did.",
        diff,
      );
    }
    if (!fitsTheMoneyColumn(row.quantity, row.price)) {
      throw new RefusedUpload(
        `${row.name}'s quantity valued at its current price is a larger figure than this ` +
          "application can hold, so nothing was recorded. Check the quantity column against " +
          "the sample rows.",
        diff,
      );
    }
    if (!fitsTheMoneyColumn(row.quantity, row.annualDividendPerShare)) {
      throw new RefusedUpload(
        `${row.name}'s quantity at its current dividend rate projects a larger annual ` +
          "dividend than this application can hold, so nothing was recorded. Check the " +
          "quantity column against the sample rows.",
        diff,
      );
    }
  }

  // Every reason to refuse the statement itself, collected once rather than three round trips
  // (#181), and thrown together: the household reloading a stale review should not have to walk
  // it back one tick at a time.
  const baselineMoved = (raw.baselineSetId ?? "") !== (diff.baselineSetId ?? "");
  // A confirmation is given against the figures on screen; when the baseline moved, those are not
  // these, so the ticks are void and have to be given again against what is now shown.
  const confirmedFiledBehind = !baselineMoved && raw.confirmFiledBehind === "true";
  const confirmedRemovals = !baselineMoved && raw.confirmRemovals === "true";
  const unconfirmedFiledBehind = diff.filedBehind !== null && !confirmedFiledBehind;
  const unconfirmedRemoval = diff.majorityRemoved && !confirmedRemovals;

  if (baselineMoved || unconfirmedFiledBehind || unconfirmedRemoval) {
    const reasons: string[] = [];

    // Reason 1's sentence is for a review that went stale under the household, not for the first
    // POST of an undated file — there the baseline "moves" only because the loader could not know
    // the date. What separates them is whether the household had already confirmed anything.
    const carriedConfirmation = raw.confirmFiledBehind === "true" || raw.confirmRemovals === "true";
    if (baselineMoved && carriedConfirmation) {
      reasons.push(
        `${draft.accountName}'s recorded history changed after this review was drawn — another ` +
          "upload or correction landed while it was open. Nothing was recorded here. Reload the " +
          "review to see this statement measured against what it now holds.",
      );
    }

    if (unconfirmedFiledBehind && diff.filedBehind !== null) {
      const { asOf: behindAsOf, currentAsOf } = diff.filedBehind;
      reasons.push(
        `This statement is dated ${behindAsOf}, behind the ${currentAsOf} figures ` +
          `${draft.accountName} currently reports. Recording it changes this account's history ` +
          `between ${behindAsOf} and the next statement recorded after it, and with it the net ` +
          "worth chart over those dates, but it does not change what the account holds now. " +
          "Nothing was recorded — confirm to file it behind.",
      );
    }

    if (unconfirmedRemoval) {
      // "this account holds" is only true of today's holdings — wrong once filed behind means
      // these counts are the baseline's own, not what the account currently reports (#181).
      const held =
        diff.filedBehind !== null ? `recorded on ${diff.baselineAsOf}` : "this account holds";
      const ratio = diff.removesEverything
        ? `This file removes every position ${held} — all ${diff.currentCount}.`
        : `This file removes ${diff.removed.length} of the ${diff.currentCount} positions ${held}.`;
      reasons.push(`${ratio} Nothing was recorded — confirm the removals to record this statement.`);
    }

    throw new RefusedUpload(reasons.join(" "), diff);
  }

  // Promotion first, since the draft delete below cascades the answers away. Only the strings
  // this file states: one answered, then mapped out of the instrument column, was never a
  // fact about a recorded statement. A row vocabulary already holds wins, as at resolve time.
  if (rawStrings.length > 0) {
    await db
      .insertInto("instrument_alias")
      .columns(["raw_string", "instrument_id"])
      .expression(
        db
          .selectFrom("upload_draft_answer")
          .select(["raw_string", "instrument_id"])
          .where("draft_id", "=", draft.id)
          .where("raw_string", "in", rawStrings)
          // Insert order is lock order: two commits promoting the same strings the other way round would deadlock.
          .orderBy("raw_string"),
      )
      .onConflict((conflict) => conflict.column("raw_string").doNothing())
      .execute();
  }

  // Deletion leads the rest of the writes. A concurrent commit is refused by the re-read above;
  // zero rows here is createDraft's sweep, which runs under no lock, taking a day-old draft in
  // between, and the throw takes the promotion back with it — no second set, no vocabulary.
  const taken = await db
    .deleteFrom("upload_draft")
    .where("id", "=", draft.id)
    .executeTakeFirst();
  if (taken.numDeletedRows === 0n) throw new NotFoundError(EXPIRED);

  // Vocabulary as the transaction sees it must be what the diff resolved against: a string
  // another upload recorded, or Settings repointed or forgot, in the gap would otherwise land
  // this holding under an instrument the alias no longer names, for the next re-upload to diff
  // away. Refused, promotion and all. Share-locked, so a repoint waits for this commit.
  const meanings =
    rawStrings.length === 0
      ? []
      : await db
          .selectFrom("instrument_alias")
          .innerJoin("instrument", "instrument.id", "instrument_alias.instrument_id")
          .select([
            "instrument_alias.raw_string",
            "instrument.id",
            "instrument.symbol",
            "instrument.name",
          ])
          .where("instrument_alias.raw_string", "in", rawStrings)
          .forShare("instrument_alias")
          .execute();
  const moved = meanings.find((meaning) => resolved.get(meaning.raw_string) !== meaning.id);
  if (moved !== undefined) {
    throw new RefusedUpload(
      `"${moved.raw_string}" now means ${describeInstrument(moved)} — recorded by another ` +
        "upload or repointed under Settings while this review was open, so nothing was " +
        "recorded. Reload the review and check what it is about to record.",
      diff,
    );
  }
  // Every string had a meaning at diff time, and the promotion restored the draft's own; one
  // still missing was forgotten under Settings, and the next upload is meant to ask about it.
  if (meanings.length !== rawStrings.length) {
    const named = new Set(meanings.map((meaning) => meaning.raw_string));
    const forgotten = rawStrings.find((raw) => !named.has(raw)) ?? "";
    throw new RefusedUpload(
      `"${forgotten}" was forgotten under Settings while this review was open, so nothing ` +
        "was recorded. Reload the review — it will ask what the name means.",
      diff,
    );
  }

  const set = await db
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
    await db
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

  // Only where the column is still empty: never overwrite a hand-recorded number. The lock makes
  // a concurrent one impossible; the predicate stays as the write's own statement of the rule.
  if (fileAccountNumber !== null && account.externalAccountNumber === null) {
    await db
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
}

export type UploadReceipt = {
  setId: string;
  asOf: IsoDate;
  filename: string | null;
  firstStatement: boolean;
  counts: { added: number; updated: number; unchanged: number; removed: number };
  holdingCount: number;
  // Whether this is the set the account is actually reading. False for a statement filed behind
  // a later one — still a real receipt (docs/specs/0005-report-remediation.md §5), because the
  // household still needs to be told.
  isCurrent: boolean;
  // What the account reports today regardless of isCurrent — the figures a filed-behind
  // statement's own holdingCount would otherwise be mistaken for.
  currentAsOf: IsoDate;
};

// Recomputed from the database, never trusted from the URL: ?uploaded= names which set, not what
// is in it. Null only when the account has no statement at all — a stale bookmark to a set the
// account never owned, or one it owns but no longer reads, gets a receipt of its own
// (docs/specs/0005-report-remediation.md §5): the household filed something, and silence is how
// #181 went unnoticed.
export async function uploadReceipt(
  accountId: string,
  setId: string,
  latest: LastRecorded | null,
  db: Kysely<Database> = getDb(),
): Promise<UploadReceipt | null> {
  if (!/^\d+$/.test(accountId) || !/^\d+$/.test(setId)) return null;
  if (latest === null) return null;

  const [set, predecessor] = await Promise.all([
    db
      .selectFrom("position_set")
      .select(["id", "as_of_date", "created_at", "source_filename"])
      .where("id", "=", setId)
      .where("account_id", "=", accountId)
      // A manually-typed set reached by a hand-edited `?uploaded=` is not a statement to report on.
      .where("source", "=", "upload")
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
    isCurrent: latest.id === set.id,
    currentAsOf: latest.asOf,
  };
}
