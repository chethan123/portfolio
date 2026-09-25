// Upload draft: the staging row behind an in-progress upload (DESIGN.md §5.1,
// docs/specs/0004-ingest.md). Everything a step needs is on the one row, so
// reload/back/bookmark all work. Its first-sighting answers ride with it (upload_draft_answer)
// and become vocabulary only at commit; its answers to account numbers no account records
// (upload_draft_account_answer) likewise land on their accounts only then. Drafts are swept at
// 24h by the next createDraft — no cron. Size capped twice: the body as it streams in, File.size
// after. A commit is bound to its reviewed revision; lock order is account → draft → aliases.
import { createHash } from "node:crypto";

import { z } from "zod";

import { sql } from "kysely";

import { getConfig } from "../../server/config.ts";
import { accountPickerGroups, numberTail, type PickerGroup } from "./account-label.ts";
import { isOwed } from "./account-options.ts";
import {
  accountInput,
  getAccount,
  listAccounts,
  numberHolder,
  refusingDuplicateNumber,
  withAccountLock,
  withAccountLocks,
  type Account,
} from "./accounts.server.ts";
import { lastRecorded, type LastRecorded } from "./balances.server.ts";
import { headerFingerprint, upsertMapping } from "./column-mapping.server.ts";
import { readCsv } from "./csv.ts";
import { couldBeId } from "./database-id.ts";
import {
  getDb,
  guardedAgainstConstraintViolation,
  inTransaction,
  uniqueViolationConstraint,
  type Database,
} from "./db.server.ts";
import { describeInstrument } from "./format.ts";
import { holdingNote } from "./holdings-view.ts";
import {
  FORM_ERROR,
  NotFoundError,
  ValidationError,
  listSentence,
  parseInput,
  recordedDate,
} from "./input.server.ts";
import { aliasesFor, unresolvedStrings } from "./instrument-resolution.server.ts";
import { MONEY_SCALE, QUANTITY_SCALE, divide, render, toUnits } from "./money.ts";
import { fitsTheMoneyColumn } from "./positions.server.ts";
import { sameRawStrings } from "./raw-string.ts";
import { dateToReproduce, sectionKey, verifyBinding, type StaleReason } from "./review-form.ts";
import { foldLots, parseStatement, statementMapping } from "./statement.ts";
import {
  recordedNumber,
  routeStatement,
  type RoutedAccount,
  type RoutedStatement,
  type RoutingProblem,
} from "./statement-routing.server.ts";
import { accountHoldings, accountHoldingsAt } from "./valuation.server.ts";

import type { AssetClass, IsoDate } from "./valuation.server.ts";
import type {
  CombinedRows,
  MultiAccountStatement,
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

export const STALE_REVIEW_MESSAGE =
  "The previous attempt was refused because this statement or its account changed after its " +
  "review. Nothing was recorded — check it and record again.";

export type UploadDraft = {
  id: string;
  // Null: the multi-account draft (spec 0023 "Schema"). accountName/ownerName null with it.
  accountId: string | null;
  accountName: string | null;
  ownerName: string | null;
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
  accountId: string | null; // null: multi-account (spec 0023)
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

// /upload's choice for a file of several accounts (spec 0023 decision 11): a draft with no account.
export const SEVERAL_ACCOUNTS = "several";

const uploadInput = z.object({
  accountId: z
    .string({ message: "Choose the account this statement describes." })
    .refine((value) => value === SEVERAL_ACCOUNTS || /^\d+$/.test(value), {
      message: "Choose the account this statement describes.",
    }),

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

  return {
    accountId: input.accountId === SEVERAL_ACCOUNTS ? null : input.accountId,
    filename: input.file.name,
    bytes,
  };
}

function closedRefusal(account: Account): ValidationError {
  return ValidationError.form(
    `${account.name} is closed, and a closed account's history does not change. ` +
      "If this statement is still real, record it into the open account that continues it.",
  );
}

// Sweeps stale drafts first: starting an upload is the one moment guaranteed to look at the table.
export async function createDraft(
  { accountId, filename, bytes }: DraftInput,
  db: Kysely<Database> = getDb(),
): Promise<{ id: string; accountId: string | null }> {
  const account = accountId === null ? null : await getAccount(accountId, db);

  if (account !== null && account.isClosed) throw closedRefusal(account);

  await db
    .deleteFrom("upload_draft")
    .where("created_at", "<", sql<Date>`now() - interval '24 hours'`)
    .execute();

  const row = await db
    .insertInto("upload_draft")
    .values({ account_id: accountId, filename, raw_file: Buffer.from(bytes) })
    .returning("id")
    .executeTakeFirstOrThrow();

  return { id: row.id, accountId: account?.id ?? null };
}

// One account fact beyond the draft: closed underneath it, which requireDraft reads as expired.
// recordUpload reads the account from the row it locked instead.
type DraftRecord = UploadDraft & {
  accountClosedAt: Date | null;
};

// Closed accounts stay in: requireDraft reads one as expired, recordUpload owes it a sentence.
// Left join, not inner: a multi-account draft's account_id is null (spec 0023), and an inner join
// would drop the row entirely, reading a live draft as expired.
async function findDraft(
  draftId: string,
  db: Kysely<Database>,
): Promise<DraftRecord | undefined> {
  // "abc" would fail as a malformed bigint — a 500 wearing a bookmark.
  if (!/^\d+$/.test(draftId)) return undefined;

  const row = await db
    .selectFrom("upload_draft")
    .leftJoin("account", "account.id", "upload_draft.account_id")
    .leftJoin("person", "person.id", "account.owner_id")
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
// Undefined: no such draft. Null: a multi-account one.
export async function draftAccountId(
  draftId: string,
  db: Kysely<Database> = getDb(),
): Promise<string | null | undefined> {
  if (!/^\d+$/.test(draftId)) return undefined;

  const row = await db
    .selectFrom("upload_draft")
    .select("account_id")
    .where("id", "=", draftId)
    .executeTakeFirst();

  return row === undefined ? undefined : row.account_id;
}

async function lockDraft(draftId: string, db: Kysely<Database>): Promise<void> {
  if (!couldBeId(draftId)) return;
  await db
    .selectFrom("upload_draft")
    .select("id")
    .where("id", "=", draftId)
    .forUpdate()
    .executeTakeFirst();
}

export async function requireDraft(
  draftId: string,
  db: Kysely<Database> = getDb(),
): Promise<UploadDraft> {
  const row = await findDraft(draftId, db);

  // Expired, not forbidden: a closed account's history can't change, so this upload can never land.
  // Single-account only: a multi-account draft joins no account, so this never fires for one.
  if (row === undefined || row.accountClosedAt !== null) throw new NotFoundError(EXPIRED);

  return row;
}

// The columns step's scope: where the draft's mapping is remembered (null: the multi-account
// scope, spec 0023 decision 4), and the owed box's default (decision 6: no one kind across several).
export type MappingScope = {
  multiAccount: boolean;
  institution: string | null;
  owedAsPositive: boolean;
};

export async function mappingScope(
  draft: UploadDraft,
  db: Kysely<Database> = getDb(),
): Promise<MappingScope> {
  if (draft.accountId === null) {
    return { multiAccount: true, institution: null, owedAsPositive: false };
  }
  const account = await getAccount(draft.accountId, db);
  return {
    multiAccount: false,
    institution: account.institution,
    owedAsPositive: isOwed(account.kind),
  };
}

// A columns-step refusal: the parse's, or a multi-account file's router's (kind set).
export type DraftProblem = ParseProblem & { kind?: RoutingProblem["kind"] };

type DraftRouting = { open: Account[]; closed: Account[]; answers: Map<string, string | null> };

// What the router reads for a draft: every account, open and closed, and the draft's own answers.
async function routingInputs(draftId: string, db: Kysely<Database>): Promise<DraftRouting> {
  const accounts = await listAccounts(db);
  const answers = await db
    .selectFrom("upload_draft_account_answer")
    .select(["account_number", "account_id"])
    .where("draft_id", "=", draftId)
    .execute();

  return {
    open: accounts.filter((account) => !account.isClosed),
    closed: accounts.filter((account) => account.isClosed),
    answers: new Map(answers.map((answer) => [answer.account_number, answer.account_id])),
  };
}

async function routeDraft(
  parsed: MultiAccountStatement,
  mapping: StatementMapping,
  draftId: string,
  db: Kysely<Database>,
): Promise<RoutedStatement> {
  return routeStatement(parsed, mapping, await routingInputs(draftId, db));
}

// By the step that owns each: an answer missing or gone stale, or every unknown number skipped,
// is the accounts step's; blank, shared or closed-only numbers and disagreeing dates are the
// file's.
function refusalsByStep(routing: RoutedStatement): {
  columns: RoutingProblem[];
  accounts: RoutingProblem[];
} {
  const asksAgain = (problem: RoutingProblem) =>
    problem.kind === "unanswered" ||
    problem.kind === "stale-answer" ||
    (problem.kind === "nothing-to-record" && routing.unknownNumbers.length > 0);

  return {
    columns: routing.problems.filter((problem) => !asksAgain(problem)),
    accounts: routing.problems.filter(asksAgain),
  };
}

// A multi-account mapping for a draft with no account, a single-account one otherwise: the other
// kind would be routed, or not, against the wrong accounts and remembered in the wrong scope.
function fitsDraft(mapping: StatementMapping, draft: UploadDraft): boolean {
  return (mapping.multiAccount === true) === (draft.accountId === null);
}

// had_first_sightings is written here, where the answer exists: vocabulary misses, plus the
// strings this draft already answered (a walk back to columns must not turn "passed" into
// "skipped"). nextStep sends the reader on only for what is still unanswered. The draft update
// and its rebuildable institution mapping cache share a transaction so a lost draft saves neither.
export async function rememberMapping(
  draftId: string,
  mapping: StatementMapping,
  db: Kysely<Database> = getDb(),
): Promise<{ problems: DraftProblem[] } | { nextStep: "accounts" | "instruments" | "review" }> {
  const draft = await requireDraft(draftId, db);
  if (!fitsDraft(mapping, draft)) {
    throw ValidationError.form(
      "This mapping was made for a different kind of upload than this one. Choose the columns " +
        "again.",
    );
  }

  const { rows } = readCsv(draft.bytes, mapping.delimiter);
  const parsed = parseStatement(rows, mapping);

  // Problems mean the columns step didn't genuinely pass, so nothing is written.
  if (parsed.problems.length > 0) return { problems: parsed.problems };

  // No positions, nothing skipped and nothing unnumbered = empty instrument column on every row
  // (all-skipped differs; so do rows naming no account, the router's refusal below).
  if (
    parsed.positions.length === 0 &&
    parsed.skipped.length === 0 &&
    (parsed.unnumbered ?? []).length === 0
  ) {
    throw new ValidationError({
      instrument:
        `No row in this file has anything under "${mapping.columns.instrument}", ` +
        "so it cannot be the instrument column. Check the column choice and the header row.",
    });
  }

  let asksAccounts = false;
  if (parsed.multiAccount === true) {
    const refused = refusalsByStep(await routeDraft(parsed, mapping, draft.id, db));
    if (refused.columns.length > 0) return { problems: refused.columns };
    asksAccounts = refused.accounts.length > 0;
  }

  // Every string in the file, a multi-account one's across all its accounts, a skipped number's
  // too (spec 0023, "Implied by the above").
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

  const { institution } = await mappingScope(draft, db);
  await inTransaction(db, async (trx) => {
    const updated = await trx
      .updateTable("upload_draft")
      .set({
        mapping: JSON.stringify(mapping),
        had_first_sightings: hadFirstSightings,
      })
      .where("id", "=", draft.id)
      .returning("id")
      .executeTakeFirst();
    if (updated === undefined) throw new NotFoundError(EXPIRED);

    await upsertMapping(
      institution,
      headerFingerprint(rows[mapping.headerRow] ?? []),
      mapping,
      trx,
    );
  });

  return {
    nextStep: asksAccounts ? "accounts" : unresolved.length > 0 ? "instruments" : "review",
  };
}

// step names the earliest step still owed; null = diffable and committable. routed: a
// multi-account draft's groups, ascending account id (spec 0023 "Routing"); null when single.
// accountsSkipped: the strip's accounts step, true when every number matched; null when single.
// skippedNumbers: the router's, empty when single.
export type DraftParse =
  | { step: "columns"; problems: DraftProblem[] }
  // First-line order; empty when every number is answered and all of them skipped.
  | { step: "accounts"; unanswered: string[] }
  | {
      step: "instruments";
      parsed: ParsedStatement;
      mapping: StatementMapping;
      routed: RoutedAccount[] | null;
      accountsSkipped: boolean | null;
      unresolved: string[];
    }
  | {
      step: null;
      parsed: ParsedStatement;
      mapping: StatementMapping;
      routed: RoutedAccount[] | null;
      accountsSkipped: boolean | null;
      skippedNumbers: string[];
    };

// The draft's file under its saved mapping, or the columns step's problems.
function savedParse(
  draft: UploadDraft,
): { mapping: StatementMapping; parsed: ParsedStatement } | { problems: ParseProblem[] } {
  const saved = statementMapping.safeParse(draft.mapping);
  if (!saved.success || !fitsDraft(saved.data, draft)) return { problems: [] };

  const { rows } = readCsv(draft.bytes, saved.data.delimiter);
  const parsed = parseStatement(rows, saved.data);

  // A saved mapping only lands after a clean parse, so problems mean it predates a rule — remap.
  if (parsed.problems.length > 0) return { problems: parsed.problems };
  return { mapping: saved.data, parsed };
}

// The saved parse, and a multi-account draft's routing over the accounts and answers as they are
// now (null when single). Rerun on every read: an account closed or renumbered since the mapping
// was saved moves rows.
type DraftRead = {
  mapping: StatementMapping;
  parsed: ParsedStatement;
  routing: { inputs: DraftRouting; statement: RoutedStatement } | null;
};

async function readDraft(
  draft: UploadDraft,
  db: Kysely<Database>,
): Promise<DraftRead | { problems: ParseProblem[] }> {
  const saved = savedParse(draft);
  if ("problems" in saved) return saved;
  const { mapping, parsed } = saved;
  if (parsed.multiAccount !== true) return { mapping, parsed, routing: null };

  const inputs = await routingInputs(draft.id, db);
  const statement = routeStatement(parsed, mapping, inputs);
  return { mapping, parsed, routing: { inputs, statement } };
}

async function stepOf(
  { mapping, parsed, routing }: DraftRead,
  draft: UploadDraft,
  db: Kysely<Database>,
): Promise<DraftParse> {
  let routed: RoutedAccount[] | null = null;
  let accountsSkipped: boolean | null = null;
  let skippedNumbers: string[] = [];
  if (routing !== null) {
    const { statement } = routing;
    const refused = refusalsByStep(statement);
    if (refused.columns.length > 0) return { step: "columns", problems: refused.columns };
    if (refused.accounts.length > 0) {
      const owed = new Set(refused.accounts.map((problem) => problem.accountNumber));
      return {
        step: "accounts",
        unanswered: statement.unknownNumbers.filter((number) => owed.has(number)),
      };
    }
    routed = statement.accounts;
    accountsSkipped = statement.unknownNumbers.length === 0;
    skippedNumbers = statement.skippedNumbers;
  }

  const unresolved = await unresolvedStrings(
    parsed.positions.map((position) => position.instrument),
    draft.id,
    db,
  );
  if (unresolved.length > 0) {
    return { step: "instruments", parsed, mapping, routed, accountsSkipped, unresolved };
  }

  return { step: null, parsed, mapping, routed, accountsSkipped, skippedNumbers };
}

export async function parseDraft(
  draft: UploadDraft,
  db: Kysely<Database> = getDb(),
): Promise<DraftParse> {
  const read = await readDraft(draft, db);
  if ("problems" in read) return { step: "columns", problems: read.problems };
  return stepOf(read, draft, db);
}

export type BlockedDraft = {
  draftId: string;
  filename: string;
  accountId: string | null;
  accountName: string | null;
  ownerName: string | null;
  accountNumberTail: string | null;
  instrumentsSkipped: boolean;
  accountsSkipped: boolean | null; // false for a multi-account draft: not yet decided
  problems: DraftProblem[];
};

function instrumentsStepSkipped(draft: UploadDraft): boolean {
  return draft.hadFirstSightings === false;
}

// A blank instrument or a routing refusal: remapping may not fix either, so review explains it.
function blockedDraftFor(draft: UploadDraft, problems: DraftProblem[]): BlockedDraft | null {
  const blocking = problems.filter(
    (problem) => problem.code === "blank-instrument" || problem.kind !== undefined,
  );
  if (blocking.length === 0) return null;

  return {
    draftId: draft.id,
    filename: draft.filename,
    accountId: draft.accountId,
    accountName: draft.accountName,
    ownerName: draft.ownerName,
    accountNumberTail: draft.accountNumberTail,
    instrumentsSkipped: instrumentsStepSkipped(draft),
    accountsSkipped: draft.accountId === null ? false : null,
    problems: blocking,
  };
}

// Not a refusal, not a 404. Routes redirect to the owed step unless the domain supplies the
// narrow display payload Review needs to explain why no safe diff exists.
export class DraftNotReadyError extends Error {
  override readonly name = "DraftNotReadyError";
  readonly step: "columns" | "accounts" | "instruments";
  readonly blocked: BlockedDraft | null;

  constructor(step: "columns" | "accounts" | "instruments", blocked: BlockedDraft | null) {
    super(`This draft has not passed the ${step} step.`);
    this.step = step;
    this.blocked = blocked;
  }
}

// /upload/:id/accounts's skip choice (spec 0023 decision 2); any other value names an account.
export const SKIP_NUMBER = "skip";

export type AccountQuestion = {
  number: string;
  lines: number; // rows naming it, quantity-less ones included
  instruments: string[]; // distinct, trimmed, first-line order
  // The draft's answer in the form's terms: an account id, SKIP_NUMBER, or "" for none or stale.
  answer: string;
  stale: string | null; // the router's sentence
};

export type AccountsScreen = {
  // parseDraft's, from the read the questions come from, so the route's redirect agrees with them.
  step: DraftParse["step"];
  questions: AccountQuestion[];
  choices: PickerGroup[]; // grouped as /upload's picker
};

// Decision 12: all an unknown number can be given.
function numberlessOpen(open: ReadonlyArray<Account>): Account[] {
  return open.filter((account) => recordedNumber(account) === null);
}

// Settings' own field rule, so no upload records a number the form refuses: trimmed, a blank
// none, bounded. The refusal names the number; each caller says what follows.
function boundedNumber(number: string): { number: string | null } | { refusal: string } {
  const bounded = accountInput.shape.externalAccountNumber.safeParse(number);
  if (bounded.success) return { number: bounded.data };
  return {
    refusal:
      `${bounded.error.issues.map((issue) => issue.message).join(" ")} Account number ` +
      `"${number}" is longer — check which column is mapped as the account number.`,
  };
}

type NumberQuestions = {
  mapping: StatementMapping;
  parsed: MultiAccountStatement;
  inputs: DraftRouting;
  routing: RoutedStatement;
};

// Null when this step has nothing to ask yet: a single-account draft, or columns still owed.
async function numberQuestions(
  draft: UploadDraft,
  db: Kysely<Database>,
): Promise<NumberQuestions | null> {
  const read = await readDraft(draft, db);
  if ("problems" in read || read.routing === null || read.parsed.multiAccount !== true) {
    return null;
  }
  const { inputs, statement } = read.routing;
  if (refusalsByStep(statement).columns.length > 0) return null;

  return { mapping: read.mapping, parsed: read.parsed, inputs, routing: statement };
}

// Every number no account records, answered or not, so a revisit shows the answers standing.
export async function accountsScreen(
  draft: UploadDraft,
  db: Kysely<Database> = getDb(),
): Promise<AccountsScreen> {
  const read = await readDraft(draft, db);
  if ("problems" in read) return { step: "columns", questions: [], choices: [] };
  const { step } = await stepOf(read, draft, db);
  const { parsed, routing } = read;
  if (routing === null || step === "columns") return { step, questions: [], choices: [] };
  const { inputs, statement } = routing;

  const stale = new Map(
    statement.problems.flatMap((problem) =>
      problem.kind === "stale-answer" && problem.accountNumber !== null
        ? [[problem.accountNumber, problem.message] as const]
        : [],
    ),
  );

  const questions = statement.unknownNumbers.map((number) => {
    const positions = parsed.positions.filter((position) => position.accountNumber === number);
    const combined = parsed.combined.filter((entry) => entry.accountNumber === number);
    const lines =
      positions.reduce(
        (sum, position) =>
          sum + (combined.find((entry) => entry.instrument === position.instrument)?.rowCount ?? 1),
        0,
      ) + parsed.skipped.filter((row) => row.accountNumber === number).length;
    const answer = inputs.answers.get(number);

    return {
      number,
      lines,
      instruments: [...new Set(positions.map((position) => position.instrument.trim()))],
      answer: answer === undefined || stale.has(number) ? "" : (answer ?? SKIP_NUMBER),
      stale: stale.get(number) ?? null,
    };
  });

  return { step, questions, choices: accountPickerGroups(numberlessOpen(inputs.open)) };
}

// The accounts step's one write (spec 0023 decision 2), refused whole unless every answer holds.
// The draft's answers are replaced outright under its lock: an upsert would trip the one-account
// index halfway through a swap, and an answer kept for a number since recorded elsewhere would
// come back unasked were that number cleared.
export async function answerAccountNumbers(
  draftId: string,
  posted: Readonly<Record<string, string>>,
  db: Kysely<Database> = getDb(),
): Promise<{ nextStep: "columns" | "accounts" | "instruments" | "review" }> {
  const draft = await requireDraft(draftId, db);
  const asked = await numberQuestions(draft, db);
  const numbers = asked?.routing.unknownNumbers ?? [];

  if (asked !== null && numbers.length > 0) {
    // Each answer posts its number: a form drawn over other numbers can't land one on another.
    if (numbers.some((number, index) => !sameRawStrings(posted[`number-${index}`] ?? "", number))) {
      throw ValidationError.form(
        "The account numbers this upload asks about changed while this page was open — check " +
          "the answers below and save again.",
      );
    }

    const offered = new Map(
      numberlessOpen(asked.inputs.open).map((account) => [account.id, account]),
    );
    const errors: Record<string, string> = {};
    const answers = new Map<string, string | null>();
    for (const [index, number] of numbers.entries()) {
      const choice = posted[`accountId-${index}`] ?? "";
      if (choice === SKIP_NUMBER) {
        answers.set(number, null);
      } else if (!offered.has(choice)) {
        errors[`accountId-${index}`] =
          choice === ""
            ? `Choose the account "${number}" belongs to, or skip its rows.`
            : `Only an open account recording no number yet can take "${number}". Choose again.`;
      } else {
        // The commit refuses it too, so a longer number can only be skipped.
        const bounded = boundedNumber(number);
        if ("refusal" in bounded) {
          errors[`accountId-${index}`] =
            `${bounded.refusal} Otherwise its rows can only be skipped.`;
        } else {
          answers.set(number, choice);
        }
      }
    }

    for (const [accountId, account] of offered) {
      const given = numbers.flatMap((number, index) =>
        answers.get(number) === accountId ? [{ number, index }] : [],
      );
      if (given.length < 2) continue;
      const named = listSentence(given.map(({ number }) => `"${number}"`));
      for (const { index } of given) {
        errors[`accountId-${index}`] =
          `${account.name} is given account numbers ${named}, and an account records one. ` +
          "Choose one account for each.";
      }
    }

    // Decision 8 on an answered number, refused on its field: at columns, where the router's
    // other date refusals go, it would leave no step to skip it from.
    const routed = routeStatement(asked.parsed, asked.mapping, { ...asked.inputs, answers });
    for (const problem of routed.problems) {
      const index = numbers.indexOf(problem.accountNumber ?? "");
      if (problem.kind === "as-of" && index >= 0) {
        errors[`accountId-${index}`] ??= `${problem.message} Skip its rows instead.`;
      }
    }
    if (Object.keys(errors).length > 0) throw new ValidationError(errors);

    // Decision 2: refused here, where the answers are, rather than at review.
    const nothing = routed.problems.find((problem) => problem.kind === "nothing-to-record");
    if (nothing !== undefined) throw ValidationError.form(nothing.message);

    await inTransaction(db, async (trx) => {
      const locked = await trx
        .selectFrom("upload_draft")
        .select("id")
        .where("id", "=", draft.id)
        .forUpdate()
        .executeTakeFirst();
      if (locked === undefined) throw new NotFoundError(EXPIRED);

      await trx
        .deleteFrom("upload_draft_account_answer")
        .where("draft_id", "=", draft.id)
        .execute();
      try {
        await guardedAgainstConstraintViolation(trx, () =>
          trx
            .insertInto("upload_draft_account_answer")
            .values(
              [...answers].map(([number, accountId]) => ({
                draft_id: draft.id,
                account_number: number,
                account_id: accountId,
              })),
            )
            .execute(),
        );
      } catch (cause) {
        // Decision 12's backstop; the check above refuses it first.
        if (uniqueViolationConstraint(cause) !== "upload_draft_account_answer_account_unique") {
          throw cause;
        }
        throw ValidationError.form(
          "One account was given two account numbers, and an account records one. Choose one " +
            "account for each.",
        );
      }
    });
  }

  return { nextStep: (await parseDraft(draft, db)).step ?? "review" };
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

// One account's statement, measured against its own baseline: one section of a review.
export type DiffSection = {
  accountName: string;
  accountNumberTail: string | null;
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

export type AccountDiff = DiffSection & {
  accountId: string;
  accountName: string;
  ownerName: string;
  // Posted back so a refused commit can name which account's history moved (decision 9).
  appendWatermark: string | null;
};

// The sections are `accounts`, routed order, ascending id (spec 0023 decision 10); a chosen
// account's draft has exactly one.
export type UploadDiff = {
  draftId: string;
  accountId: string | null; // the draft's chosen account; null: several
  filename: string;
  // True only when columns recorded no first sightings; false for a pre-bit draft too.
  instrumentsSkipped: boolean;
  accountsSkipped: boolean | null; // DraftParse's
  skippedNumbers: string[]; // DraftParse's: no section records their rows
  skipped: DiffSection["skipped"]; // rows no section claims
  // "asked" only when some section's rows carry no date.
  asOf: DiffSection["asOf"];
  // Evidence of the exact server-rendered review. Null only when an undated file's requested date
  // is invalid, so the page can show the field error without issuing usable authorization.
  reviewRevision: string | null;
  asOfInput: string;
  asOfError: string | null;
  accounts: AccountDiff[];
};

export class StaleReviewError extends ValidationError {
  readonly diff: UploadDiff;
  readonly asOf: IsoDate | null;

  constructor(
    diff: UploadDiff,
    asOf: IsoDate | null,
    reason: StaleReason = "revision_changed",
    // Accounts with figures recorded since the review, when the form says which; rerouted: those
    // the file's numbers name now, unlocked.
    moved: readonly string[] = [],
  ) {
    super({
      [FORM_ERROR]:
        reason === "date_changed"
          ? `This comparison was drawn for a different statement date. Here it is for ${asOf}. ` +
            "Nothing was recorded — check it and record again."
          : reason === "rerouted"
            ? "An account number changed while this file was being recorded, and its rows now " +
              `go to ${listSentence(moved)}. Nothing was recorded — check ` +
              `${moved.length === 1 ? "it" : "them"} and record again.`
            : moved.length > 0
              ? `Figures were recorded on ${listSentence(moved)} after this review. Nothing was ` +
                `recorded — check ${moved.length === 1 ? "it" : "them"} and record again.`
              : "This statement or its account changed after this review. Nothing was recorded " +
                "— check it and record again.",
    });
    this.diff = diff;
    this.asOf = asOf;
  }
}

// A refusal decided after assembleDiff has already run, carrying the diff it was decided against
// so the review can re-render exactly what it refused rather than the loader's stale one (#181).
// `diff` is assigned in the body, not a parameter property — erasableSyntaxOnly (tsconfig.json)
// forbids those. Precedent for a payload-carrying domain error: DraftNotReadyError.
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

// One account's rows: a chosen account's whole parse, or one of the router's groups, which is
// assignable here unchanged.
type StatementGroup = Pick<
  RoutedAccount,
  "accountId" | "answered" | "positions" | "combined" | "skipped" | "asOfDate"
> & {
  // The router's key; null for a chosen account (chosenAccountNumber reads the file's).
  accountNumber: string | null;
};

type AssembledSection = {
  diff: AccountDiff;
  rows: FileRow[];
  accountNumber: string | null; // StatementGroup's
  answered: boolean;
  // The date the section classified against: its own, or the typed one. Null only for explicit
  // unknown-mode reads or an invalid review input; commit either resolves it or throws.
  asOf: IsoDate | null;
};

type AssembledDiff = {
  diff: UploadDiff;
  sections: AssembledSection[];
  // What each distinct instrument cell the file states resolved to, over every section — the
  // strings the commit promotes the draft's answers for, and the meanings it must still find in
  // vocabulary.
  resolved: Map<string, string>;
  asOf: IsoDate | null; // the typed date; null when no section asks for one
};

type ReviewDate =
  | { mode: "unknown" }
  | { mode: "review"; asOf: string | null }
  | { mode: "commit"; asOf: string | undefined };

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

async function readyParse(
  draft: UploadDraft,
  db: Kysely<Database>,
): Promise<Extract<DraftParse, { step: null }>> {
  const result = await parseDraft(draft, db);
  if (result.step !== null) {
    throw new DraftNotReadyError(
      result.step,
      result.step === "columns" ? blockedDraftFor(draft, result.problems) : null,
    );
  }
  return result;
}

// The file's own date wins. Otherwise the typed one, resolved once, ahead of any baseline and
// guard: review keeps a bad typed value visible and issues no revision; commit refuses it as
// ordinary field data.
function statementDate(
  fileDate: IsoDate | null,
  asked: ReviewDate,
): { asOfInput: string; asOf: IsoDate | null; asOfError: string | null } {
  const defaultAsOf = new Date().toISOString().slice(0, 10);
  const asOfInput =
    fileDate ??
    (asked.mode === "review"
      ? (asked.asOf ?? defaultAsOf)
      : asked.mode === "commit"
        ? (asked.asOf ?? "")
        : "");
  let asOf: IsoDate | null = fileDate;
  let asOfError: string | null = null;
  if (fileDate === null && asked.mode !== "unknown") {
    try {
      asOf = parseInput(z.object({ asOf: recordedDate("The statement date") }), {
        asOf: asOfInput,
      }).asOf;
    } catch (error) {
      if (!(error instanceof ValidationError) || asked.mode === "commit") throw error;
      asOfError = error.fieldErrors.asOf ?? "The statement date is invalid.";
    }
  }
  return { asOfInput, asOf, asOfError };
}

type Comparison = {
  figures: Omit<DiffSection, "accountName" | "accountNumberTail" | "skipped" | "asOf">;
  rows: FileRow[];
  baselineHoldings: Array<Pick<FileRow, "instrumentId" | "quantity" | "costBasisPerShare">>;
  latestSetId: string | null;
};

// One account's rows against its baseline (CONTEXT.md, "Baseline"): the latest set on or before
// `asOf`; a null `asOf` (explicit unknown-mode reads, an invalid review date) retains the
// account's current-set view. Two spellings of one fund fold as the parser folds a duplicate:
// quantities summed, basis quantity-weighted.
async function compareAccount(
  accountId: string,
  positions: ReadonlyArray<ParsedPosition>,
  combined: ReadonlyArray<CombinedRows>,
  asOf: IsoDate | null,
  aliases: ReadonlyMap<string, string>,
  db: Kysely<Database>,
): Promise<Comparison> {
  const groups = new Map<string, ParsedPosition[]>();
  for (const position of positions) {
    const instrumentId = aliases.get(position.instrument);
    if (instrumentId === undefined) continue; // unreachable: parseDraft checked every string
    const group = groups.get(instrumentId);
    if (group === undefined) groups.set(instrumentId, [position]);
    else group.push(position);
  }

  const combinedByRaw = new Map(combined.map((c) => [c.instrument, c.rowCount]));

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

  // `latestRecorded` is always the account's current set (undated), read alongside so filedBehind
  // needs no second query later.
  const [latestRecorded, baselineRecord] =
    asOf === null
      ? await lastRecorded(accountId, db).then((latest) => [latest, latest] as const)
      : await Promise.all([lastRecorded(accountId, db), lastRecorded(accountId, db, asOf)]);

  const current =
    asOf === null
      ? await accountHoldings(accountId, db)
      : await accountHoldingsAt(accountId, asOf, db);
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

  const baselineSetId = baselineRecord?.id ?? null;

  return {
    figures: {
      added,
      updated,
      removed,
      unchangedCount,
      currentCount: current.length,
      // Nothing recorded on or before the date — including the fallback undated read, so a truly
      // empty account and a date before all its history read the same way.
      firstStatement: baselineSetId === null,
      majorityRemoved: removed.length * 2 > current.length,
      removesEverything: current.length > 0 && removed.length === current.length,
      baselineSetId,
      baselineAsOf: baselineRecord?.asOf ?? null,
      // Only meaningful once a date is known: recording ahead of the account's own current set is
      // the ordinary case this compares nothing against.
      filedBehind:
        asOf !== null && latestRecorded !== null && latestRecorded.asOf > asOf
          ? { asOf, currentAsOf: latestRecorded.asOf }
          : null,
    },
    rows,
    baselineHoldings: current
      .map((holding) => ({
        instrumentId: holding.instrumentId,
        quantity: holding.quantity,
        costBasisPerShare: holding.costBasisPerShare,
      }))
      .sort((a, b) =>
        a.instrumentId < b.instrumentId ? -1 : a.instrumentId > b.instrumentId ? 1 : 0,
      ),
    latestSetId: latestRecorded?.id ?? null,
  };
}

// Baseline and latest-set ids cannot see a set appended strictly between their dates. History is
// append-only and bigint ids increase, so this exact driver string changes on every account
// history write without exposing another holding or figure to the client.
async function appendWatermark(accountId: string, db: Kysely<Database>): Promise<string | null> {
  const history = await db
    .selectFrom("position_set")
    .select(({ fn }) => fn.max("id").as("appendWatermark"))
    .where("account_id", "=", accountId)
    .executeTakeFirstOrThrow();
  return history.appendWatermark;
}

function revisionRows(rows: ReadonlyArray<FileRow>) {
  return rows
    .map((row) => ({
      instrumentId: row.instrumentId,
      quantity: row.quantity,
      costBasisPerShare: row.costBasisPerShare,
      accountNumber: row.accountNumber,
    }))
    .sort((a, b) =>
      a.instrumentId < b.instrumentId ? -1 : a.instrumentId > b.instrumentId ? 1 : 0,
    );
}

function revisionResolved(aliases: ReadonlyMap<string, string>) {
  return [...aliases]
    .map(([raw, instrumentId]) => ({ raw, instrumentId }))
    .sort((a, b) => (a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0));
}

// A chosen account is a routing of one: its whole parse, claimed by one group. Its recorded number
// is deliberately not in the group, so not in the revision: a Settings save of it between Review
// and commit is the guard's refusal, not a stale review.
function statementGroups(
  draft: UploadDraft,
  parse: Extract<DraftParse, { step: null }>,
): StatementGroup[] {
  if (draft.accountId !== null) {
    const { positions, combined, skipped, asOfDate } = parse.parsed;
    return [
      {
        accountId: draft.accountId,
        accountNumber: null,
        answered: false,
        positions,
        combined,
        skipped,
        asOfDate,
      },
    ];
  }
  // Unreachable: parseDraft routes every null-account draft whose mapping it accepts.
  if (parse.routed === null) throw new DraftNotReadyError("columns", null);
  return parse.routed;
}

const REVIEW_REVISION = "v5";

// Section order is routed order, the lock and insert order, so it is bound too.
function reviewRevisionOf(
  draft: UploadDraft,
  mapping: StatementMapping,
  resolved: ReadonlyMap<string, string>,
  bound: ReadonlyArray<unknown>,
): string {
  const revision = createHash("sha256");
  revision.update(`portfolio-upload-review-${REVIEW_REVISION}\0`);
  revision.update(Buffer.from(draft.bytes));
  revision.update("\0");
  revision.update(
    JSON.stringify({
      draftId: draft.id,
      filename: draft.filename,
      mapping,
      resolved: revisionResolved(resolved),
      sections: bound,
    }),
  );
  return `${REVIEW_REVISION}.${revision.digest("base64url")}`;
}

// One section per group, each diffed against its own baseline at its own date (spec 0023
// decisions 8, 10), read from the router's groups and never re-matched. One revision binds them
// all, so a change to any account refuses the whole commit.
async function assembleDiff(
  draft: UploadDraft,
  asked: ReviewDate,
  db: Kysely<Database>,
): Promise<AssembledDiff> {
  const parse = await readyParse(draft, db);
  const groups = statementGroups(draft, parse);

  // Decision 8: one typed date, for every account whose rows carry none.
  const asksDate = groups.some((group) => group.asOfDate === null);
  const typed = asksDate
    ? statementDate(null, asked)
    : { asOfInput: "", asOf: null, asOfError: null };

  const strings = [
    ...new Set(groups.flatMap((group) => group.positions.map((position) => position.instrument))),
  ];
  const aliases = await aliasesFor(strings, draft.id, db);

  const sections: AssembledSection[] = [];
  const bound: unknown[] = [];
  for (const group of groups) {
    const account = await getAccount(group.accountId, db);
    const asOf = group.asOfDate ?? typed.asOf;
    const { figures, rows, baselineHoldings, latestSetId } = await compareAccount(
      account.id,
      group.positions,
      group.combined,
      asOf,
      aliases,
      db,
    );
    const watermark = await appendWatermark(account.id, db);

    sections.push({
      diff: {
        accountId: account.id,
        accountName: account.name,
        ownerName: account.ownerName,
        accountNumberTail: numberTail(group.accountNumber ?? account.externalAccountNumber),
        ...figures,
        skipped: group.skipped.map(({ row, instrument }) => ({ row, instrument })),
        asOf:
          group.asOfDate !== null
            ? { source: "file", date: group.asOfDate }
            : { source: "asked", date: typed.asOf },
        appendWatermark: watermark,
      },
      rows,
      accountNumber: group.accountNumber,
      answered: group.answered,
      asOf,
    });
    bound.push({
      accountId: account.id,
      accountNumber: group.accountNumber,
      answered: group.answered,
      rows: revisionRows(rows),
      baseline: { setId: figures.baselineSetId, holdings: baselineHoldings },
      latestSetId,
      accountHistoryAppendWatermark: watermark,
      asOf,
    });
  }

  const reviewRevision =
    typed.asOfError === null && sections.every((section) => section.asOf !== null)
      ? reviewRevisionOf(draft, parse.mapping, aliases, bound)
      : null;

  const claimed = new Set(groups.flatMap((group) => group.skipped));
  const firstDate = groups[0]?.asOfDate ?? null;

  return {
    diff: {
      draftId: draft.id,
      accountId: draft.accountId,
      filename: draft.filename,
      instrumentsSkipped: instrumentsStepSkipped(draft),
      accountsSkipped: parse.accountsSkipped,
      skippedNumbers: parse.skippedNumbers,
      skipped: parse.parsed.skipped
        .filter((row) => !claimed.has(row))
        .map(({ row, instrument }) => ({ row, instrument })),
      asOf:
        asksDate || firstDate === null
          ? { source: "asked", date: typed.asOf }
          : { source: "file", date: firstDate },
      reviewRevision,
      asOfInput: typed.asOfInput,
      asOfError: typed.asOfError,
      accounts: sections.map((section) => section.diff),
    },
    sections,
    resolved: aliases,
    asOf: typed.asOf,
  };
}

async function reviewDiff(
  draft: UploadDraft,
  asked: ReviewDate,
  db: Kysely<Database>,
): Promise<UploadDiff> {
  return (await assembleDiff(draft, asked, db)).diff;
}

export async function diffForDraft(
  draftId: string,
  db: Kysely<Database> = getDb(),
): Promise<UploadDiff> {
  return reviewDiff(await requireDraft(draftId, db), { mode: "unknown" }, db);
}

export async function reviewForDraft(
  draftId: string,
  requestedAsOf: string | null,
  db: Kysely<Database> = getDb(),
): Promise<UploadDiff> {
  return reviewDiff(await requireDraft(draftId, db), { mode: "review", asOf: requestedAsOf }, db);
}

type Confirmation = "baselineSetId" | "confirmRemovals" | "confirmFiledBehind";

export type CommitInput = {
  asOf?: string;
  accountId?: string; // the draft's chosen account, "" for several
  reviewRevision?: string;
  reviewedAsOf?: string;
  // Per section, suffixed with its account id (sectionKey): the three confirmations and its
  // AccountDiff.appendWatermark, "" for null. A first statement's `null` baselineSetId reaches here
  // as "" (#181), which is why the comparison treats the two the same.
  [perSection: `${Confirmation | "appendWatermark"}-${string}`]: string | undefined;
};

// Another build's recipe drew it: that build's page cannot read this build's diff (spec 0024).
export function drawnByEarlierBuild(raw: Pick<CommitInput, "reviewRevision">): boolean {
  return raw.reviewRevision !== undefined && !raw.reviewRevision.startsWith(`${REVIEW_REVISION}.`);
}

export type CommittedUpload = {
  setId: string;
  accountId: string;
  accountName: string;
  filename: string;
  asOf: IsoDate;
  counts: { added: number; updated: number; unchanged: number; removed: number };
};

// The review's one write, for either kind of draft: one set per section, ascending account id. A
// chosen account is locked alone. A draft of several is read unlocked only to learn which accounts
// to lock; withAccountLocks takes them in ascending id, one transaction, and everything is read
// again under them (spec 0023 "The commit").
export async function recordUpload(
  draftId: string,
  raw: CommitInput,
  db: Kysely<Database> = getDb(),
): Promise<CommittedUpload[]> {
  const accountId = await draftAccountId(draftId, db);
  if (accountId === undefined) throw new NotFoundError(EXPIRED);

  if (accountId !== null) {
    return withAccountLock(accountId, db, (account, trx) =>
      commitUnderLocks(draftId, [account], raw, trx),
    );
  }

  const draft = await findDraft(draftId, db);
  if (draft === undefined) throw new NotFoundError(EXPIRED);
  const { routed } = await readyParse(draft, db);

  return withAccountLocks(
    (routed ?? []).map((group) => group.accountId),
    db,
    (accounts, trx) => commitUnderLocks(draftId, accounts, raw, trx),
  );
}

// A chosen account's number guard. Over the folded rows (FileRow.accountNumber), not the raw
// positions, which would refuse more files; after assembleDiff, because the date it resolves
// decides the baseline (#181). The number to capture, with the refusal its write owes, or null.
async function chosenAccountNumber(
  { rows }: AssembledSection,
  account: Account,
  diff: UploadDiff,
  db: Kysely<Database>,
): Promise<{ number: string; refuse: (who: string) => Error } | null> {
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
        "Check which account this export belongs to — nothing was recorded. A file holding " +
        'several accounts uploads as "Several accounts", which routes each row by its number.',
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
          `${account.name} — owned by ${account.ownerName} — is recorded as account ` +
          `"${account.externalAccountNumber}". A statement lands in the account it describes — check ` +
          "which account this export belongs to.",
        diff,
      );
    }
  }

  // Only for an account with none: a recorded number is never overwritten (recordAccountNumber).
  const captured =
    account.externalAccountNumber === null && firstNumber !== undefined
      ? boundedNumber(firstNumber)
      : { number: null };
  if ("refusal" in captured) {
    throw new RefusedUpload(`${captured.refusal} Nothing was recorded.`, diff);
  }

  const capturedNumber = captured.number;
  if (capturedNumber === null) return null;
  const recordedElsewhere = (who: string) =>
    new RefusedUpload(
      `This file says it describes account "${capturedNumber}", which is already recorded ` +
        `on ${who}. A statement lands in the account it describes — check which account ` +
        'this export belongs to. If both accounts genuinely share this number, choose "Not in ' +
        'this file" for the account-number column and upload again.',
      diff,
    );
  // Read ahead of the confirmations, so none is asked for a file that cannot land here. Settings
  // takes no lock, so the index still decides at the write.
  const holder = await numberHolder(capturedNumber, db);
  if (holder !== null) throw recordedElsewhere(holder);

  return { number: capturedNumber, refuse: recordedElsewhere };
}

// All or nothing, one transaction under every section's account lock (§7.2): the draft's answers
// promoted to vocabulary, numbers recorded, draft deleted, one immutable position_set per section.
// Every refusal runs first. Hard refusals stop at the first, in account order, ahead of any
// confirmation; a missing confirmation is collected across every section and refused in one
// sentence per account (decision 9), so the reader is not walked back one account at a time. A
// second upload for an already-recorded date is allowed (latest_position_set's tie-break resolves
// it); re-posting a committed draft is a NotFoundError.
async function commitUnderLocks(
  draftId: string,
  locked: Account[],
  raw: CommitInput,
  db: Kysely<Database>,
): Promise<CommittedUpload[]> {
  // Gone by now: a concurrent commit took it while this one waited, or the 24h sweep did.
  await lockDraft(draftId, db);
  const draft = await findDraft(draftId, db);
  if (draft === undefined) throw new NotFoundError(EXPIRED);
  const several = draft.accountId === null;

  // First: a closed account isn't fixable by a ticked box or typed date.
  const closed = locked.find((account) => account.isClosed);
  if (closed !== undefined) throw closedRefusal(closed);

  // Hidden field feeds the expired page's link only — a different account is stale/forged.
  if (raw.accountId !== undefined && raw.accountId !== (draft.accountId ?? "")) {
    throw ValidationError.form(
      "This form was posted for a different account than the one this upload is recording " +
        "a statement against. Reload the review and check what it is about to record.",
    );
  }

  // Resolves the date and classifies against each baseline in one place (#181); re-routed under
  // the locks, so a number recorded, cleared or closed since, or a stale answer, refuses here as
  // the router's problem. A bad or missing date throws here as a plain ValidationError: no diff
  // exists yet, so it cannot be a RefusedUpload.
  const { diff, sections, resolved, asOf } = await assembleDiff(
    draft,
    { mode: "commit", asOf: raw.asOf },
    db,
  );

  const binding = { diff, locked: locked.map(({ id }) => id) };
  const at = dateToReproduce(raw, binding);
  const verdict = verifyBinding(raw, {
    ...binding,
    reproduced:
      at === null
        ? null
        : (await assembleDiff(draft, { mode: "review", asOf: at }, db)).diff.reviewRevision,
  });
  if (!verdict.ok) throw new StaleReviewError(diff, asOf, verdict.reason, verdict.moved);

  // verifyBinding refused every section outside the locks as rerouted.
  const held: Array<AssembledSection & { account: Account }> = sections.map((section) => {
    const account = locked.find(({ id }) => id === section.diff.accountId);
    if (account === undefined) {
      throw new Error("A verified commit reached an account it holds no lock on.");
    }
    return { ...section, account };
  });

  const numbers: Array<{
    account: Account;
    number: string;
    refuse: (who: string) => Error;
  }> = [];
  const confirmations: string[] = [];
  for (const { account, ...assembled } of held) {
    const { diff: section, rows, accountNumber, answered } = assembled;
    const posted = {
      confirmRemovals: raw[sectionKey("confirmRemovals", section.accountId)],
      confirmFiledBehind: raw[sectionKey("confirmFiledBehind", section.accountId)],
    };
    // A chosen account collects a moved baseline with its confirmations, where a filed-behind
    // reason subsumes it; several refuse it first, per account (spec 0023 decision 9).
    if (!several) {
      const chosen = await chosenAccountNumber(assembled, account, diff, db);
      if (chosen !== null) numbers.push({ account, ...chosen });
    } else {
      if (verdict.voided.has(section.accountId)) {
        throw new RefusedUpload(`${section.accountName}: ${baselineSentence(section)}`, diff);
      }
      if (answered) {
        const bounded = accountNumber === null ? { number: null } : boundedNumber(accountNumber);
        if ("refusal" in bounded) {
          throw new RefusedUpload(
            `${section.accountName}: ${bounded.refusal} Nothing was recorded.`,
            diff,
          );
        }
        // Router keys are trimmed, non-blank cells.
        if (bounded.number === null) throw new Error("Rows were routed by a blank account number.");
        const number = bounded.number;
        numbers.push({
          account,
          number,
          refuse: (who) =>
            new RefusedUpload(
              `${section.accountName}: account number "${number}" is already recorded on ` +
                `${who}, so nothing was recorded. Choose again for it.`,
              diff,
            ),
        });
      }
    }
    const named = {
      section,
      rows,
      accountName: section.accountName,
      named: several,
      moved: verdict.voided.has(section.accountId),
    };
    confirmations.push(...reasonsToRefuse(named, posted, diff));
  }
  if (confirmations.length > 0) throw new RefusedUpload(confirmations.join(" "), diff);

  await promoteAnswers(draft.id, resolved, db);
  for (const { account, number, refuse } of numbers) {
    await recordAccountNumber(account, number, db, refuse);
  }
  await deleteDraft(draft.id, db);
  await verifyVocabulary(resolved, diff, db);

  const recorded: CommittedUpload[] = [];
  for (const { diff: section, rows, asOf: accountAsOf } of held) {
    // Non-null: a null date left the revision null, which verifyBinding refused.
    if (accountAsOf === null) throw new Error("A commit reached a dateless account.");
    recorded.push({
      setId: await insertStatement(section.accountId, accountAsOf, draft, rows, db),
      accountId: section.accountId,
      accountName: section.accountName,
      filename: draft.filename,
      asOf: accountAsOf,
      counts: {
        added: section.added.length,
        updated: section.updated.length,
        unchanged: section.unchangedCount,
        removed: section.removed.length,
      },
    });
  }
  return recorded;
}

// Promotion before the draft delete, which cascades the answers away. Only the strings the
// recorded file states: one answered, then mapped out of the instrument column, was never a fact
// about a recorded statement. A row vocabulary already holds wins, as at resolve time.
async function promoteAnswers(
  draftId: string,
  resolved: ReadonlyMap<string, string>,
  db: Kysely<Database>,
): Promise<void> {
  const rawStrings = [...resolved.keys()];
  if (rawStrings.length === 0) return;

  await db
    .insertInto("instrument_alias")
    .columns(["raw_string", "instrument_id"])
    .expression(
      db
        .selectFrom("upload_draft_answer")
        .select(["raw_string", "instrument_id"])
        .where("draft_id", "=", draftId)
        .where("raw_string", "in", rawStrings)
        // Insert order is lock order: two commits promoting the same strings the other way round would deadlock.
        .orderBy("raw_string"),
    )
    .onConflict((conflict) => conflict.column("raw_string").doNothing())
    .execute();
}

// Deletion leads the history writes. A concurrent commit is refused by the re-read under the lock;
// zero rows here is createDraft's sweep, which runs under no lock, taking a day-old draft in
// between, and the throw takes the promotion back with it — no second set, no vocabulary.
async function deleteDraft(draftId: string, db: Kysely<Database>): Promise<void> {
  const taken = await db.deleteFrom("upload_draft").where("id", "=", draftId).executeTakeFirst();
  if (taken.numDeletedRows === 0n) throw new NotFoundError(EXPIRED);
}

// Vocabulary as the transaction sees it must be what the diff resolved against: a string another
// upload recorded, or Settings repointed or forgot, in the gap would otherwise land a holding
// under an instrument the alias no longer names, for the next re-upload to diff away. Refused,
// promotion and all. Share-locked, so a repoint waits for this commit.
async function verifyVocabulary(
  resolved: ReadonlyMap<string, string>,
  diff: UploadDiff,
  db: Kysely<Database>,
): Promise<void> {
  const rawStrings = [...resolved.keys()];
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
}

// Every set keeps the whole file's bytes, a multi-account one's included (spec 0023 "The commit").
async function insertStatement(
  accountId: string,
  asOf: IsoDate,
  draft: UploadDraft,
  rows: ReadonlyArray<FileRow>,
  db: Kysely<Database>,
): Promise<string> {
  const set = await db
    .insertInto("position_set")
    .values({
      account_id: accountId,
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

  return set.id;
}

// Only where the column is null: never over a recorded number. Settings' update waits on the
// locked row, so zero rows is a stored blank, which the router reads as none. Zero rows written is
// the refusal (§7.2).
async function recordAccountNumber(
  account: Pick<Account, "id" | "name">,
  number: string,
  db: Kysely<Database>,
  refuse: (who: string) => Error,
): Promise<void> {
  const written = await refusingDuplicateNumber(
    number,
    db,
    () =>
      db
        .updateTable("account")
        .set({ external_account_number: number })
        .where("id", "=", account.id)
        .where("external_account_number", "is", null)
        .executeTakeFirst(),
    refuse,
  );
  if (written.numUpdatedRows === 0n) {
    throw ValidationError.form(
      `${account.name} holds a blank account number rather than none, so "${number}" was not ` +
        "written over it and nothing was recorded. Save the account once in Settings, which " +
        "clears it, and record again.",
    );
  }
}

function baselineSentence(section: DiffSection): string {
  const measuredAgainst =
    section.baselineAsOf !== null
      ? `what ${section.accountName} held on ${section.baselineAsOf}`
      : `an account with nothing recorded on or before this statement's date`;
  return (
    "This statement was measured against figures that are no longer current: it is now " +
    `measured against ${measuredAgainst}. Nothing was recorded — check the figures now ` +
    "shown and confirm again."
  );
}

// Per account, once its diff is drawn (spec 0023, "The commit"). The overflow guard throws; the
// missing confirmations come back, for the caller to refuse together with any other account's.
// `named`: each sentence opens with the account, for a file of several.
function reasonsToRefuse(
  {
    section,
    rows,
    accountName,
    named = false,
    moved,
  }: {
    section: DiffSection;
    rows: ReadonlyArray<FileRow>;
    accountName: string;
    named?: boolean;
    moved: boolean;
  },
  posted: Partial<Record<Exclude<Confirmation, "baselineSetId">, string>>,
  refused: UploadDiff,
): string[] {
  const say = (sentence: string) => (named ? `${accountName}: ${sentence}` : sentence);

  // All three multiplications the view performs; unchecked, the view raises on every request after.
  for (const row of rows) {
    if (!fitsTheMoneyColumn(row.quantity, row.costBasisPerShare)) {
      throw new RefusedUpload(
        say(
          `${row.name}'s quantity multiplied by its cost basis is a larger figure than this ` +
            "application can hold, so nothing was recorded. Check both columns against the " +
            "sample rows — a cost basis is what one share cost, not what the whole position did.",
        ),
        refused,
      );
    }
    if (!fitsTheMoneyColumn(row.quantity, row.price)) {
      throw new RefusedUpload(
        say(
          `${row.name}'s quantity valued at its current price is a larger figure than this ` +
            "application can hold, so nothing was recorded. Check the quantity column against " +
            "the sample rows.",
        ),
        refused,
      );
    }
    if (!fitsTheMoneyColumn(row.quantity, row.annualDividendPerShare)) {
      throw new RefusedUpload(
        say(
          `${row.name}'s quantity at its current dividend rate projects a larger annual ` +
            "dividend than this application can hold, so nothing was recorded. Check the " +
            "quantity column against the sample rows.",
        ),
        refused,
      );
    }
  }

  // Every reason to refuse the statement itself, collected once rather than three round trips
  // (#181), and refused together: the household reloading a stale review should not have to walk
  // it back one tick at a time.
  //
  // A confirmation is given against the figures on screen; when the baseline moved, those are not
  // these, so the ticks are void and have to be given again against what is now shown.
  const confirmedFiledBehind = !moved && posted.confirmFiledBehind === "true";
  const confirmedRemovals = !moved && posted.confirmRemovals === "true";
  const unconfirmedFiledBehind = section.filedBehind !== null && !confirmedFiledBehind;
  const unconfirmedRemoval = section.majorityRemoved && !confirmedRemovals;

  if (moved || unconfirmedFiledBehind || unconfirmedRemoval) {
    const reasons: string[] = [];

    // Reason 2 subsumes reason 1 when a moved baseline also reveals an unconfirmed filed-behind
    // statement: the specific acknowledgement is the useful next action, without a second sentence
    // saying that the baseline moved. Reason 1 fires when no filed-behind tick already explains it.
    //
    // This is a structural guarantee, not a heuristic: the outer `if` above fires only when one of
    // moved, unconfirmedFiledBehind, unconfirmedRemoval is true, and each of the three maps to a
    // push below (moved to this one exactly when unconfirmedFiledBehind does not, the other two
    // unconditionally), so `reasons` can never come out empty. The guard past the ifs below is
    // what keeps that true under a future edit rather than merely by inspection today.
    if (moved && !unconfirmedFiledBehind) {
      reasons.push(say(baselineSentence({ ...section, accountName })));
    }

    if (unconfirmedFiledBehind && section.filedBehind !== null) {
      const { asOf: behindAsOf, currentAsOf } = section.filedBehind;
      reasons.push(
        say(
          `This statement is dated ${behindAsOf}, behind the ${currentAsOf} figures ` +
            `${accountName} currently reports. Recording it changes this account's history ` +
            `between ${behindAsOf} and the next statement recorded after it, and with it the net ` +
            "worth chart over those dates, but it does not change what the account holds now. " +
            "Nothing was recorded — confirm to file it behind.",
        ),
      );
    }

    if (unconfirmedRemoval) {
      // "this account holds" is only true of today's holdings — wrong once filed behind means
      // these counts are the baseline's own, not what the account currently reports (#181).
      const held =
        section.filedBehind !== null ? `recorded on ${section.baselineAsOf}` : "this account holds";
      const ratio = section.removesEverything
        ? `This file removes every position ${held} — all ${section.currentCount}.`
        : `This file removes ${section.removed.length} of the ${section.currentCount} positions ${held}.`;
      reasons.push(
        say(`${ratio} Nothing was recorded — confirm the removals to record this statement.`),
      );
    }

    // A refusal with nothing to say is the silent no-op #181 exists to kill, reintroduced inside
    // the machinery meant to fix it — this is what the comment above claims, made unrepresentable.
    if (reasons.length === 0) {
      throw new Error("A refusal must carry a sentence.");
    }

    return reasons;
  }

  return [];
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
  if (!couldBeId(accountId) || !couldBeId(setId) || latest === null) return null;

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

export type RecordedStatement = {
  accountId: string;
  accountName: string;
  ownerName: string;
  accountNumberTail: string | null;
  receipt: UploadReceipt;
};

// Several reads per id, over a list anyone can type; one upload names far fewer accounts.
const MAX_RECORDED_SETS = 50;

// /upload/done?sets= (spec 0023 decision 16), each set read as its own account's receipt reads it,
// in the order named. The address is only claims: an id naming no upload set, or past the first
// MAX_RECORDED_SETS, is left out, never a 404.
export async function recordedStatements(
  sets: string | null,
  db: Kysely<Database> = getDb(),
): Promise<RecordedStatement[]> {
  const ids = [...new Set((sets ?? "").split(",").map((id) => id.trim()))]
    .filter(couldBeId)
    .slice(0, MAX_RECORDED_SETS);
  if (ids.length === 0) return [];

  const rows = await db
    .selectFrom("position_set")
    .innerJoin("account", "account.id", "position_set.account_id")
    .innerJoin("person", "person.id", "account.owner_id")
    .select([
      "position_set.id",
      "position_set.account_id",
      "account.name",
      "person.name as owner_name",
      "account.external_account_number",
    ])
    .where("position_set.id", "in", ids)
    .where("position_set.source", "=", "upload")
    .execute();
  const byId = new Map(rows.map((row) => [row.id, row]));

  const statements: RecordedStatement[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row === undefined) continue;
    const latest = await lastRecorded(row.account_id, db);
    const receipt = await uploadReceipt(row.account_id, id, latest, db);
    if (receipt === null) continue;
    statements.push({
      accountId: row.account_id,
      accountName: row.name,
      ownerName: row.owner_name,
      accountNumberTail: numberTail(row.external_account_number),
      receipt,
    });
  }
  return statements;
}
