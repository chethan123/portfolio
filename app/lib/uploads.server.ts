/**
 * The upload draft — the staging row behind an in-progress statement upload
 * (DESIGN.md §5.1, docs/specs/0004-ingest.md).
 *
 * The upload flow is four screens and every one of them is a real URL with no
 * client state, so everything a step needs has to live where a URL can reach
 * it. This module owns that place: one `upload_draft` row holding the bytes,
 * the filename and, as the steps pass, the mapping and the as-of date. Each
 * step reads the draft, writes its own part back and redirects — which is what
 * makes a reload, the back button and a bookmarked half-finished upload all
 * behave.
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
 */
import { z } from "zod";

import { sql } from "kysely";

import { getConfig } from "../../server/config.ts";
import { getAccount } from "./accounts.server.ts";
import { getDb, type Database } from "./db.server.ts";
import { NotFoundError, ValidationError, parseInput } from "./input.server.ts";

import type { IsoDate } from "./valuation.server.ts";
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
  /** Null until the review step records the date. */
  asOfDate: IsoDate | null;
  /**
   * Null until the columns step is passed — which is how "how far did this
   * draft get" stays a property of the row. Its shape is that step's contract.
   */
  mapping: unknown;
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
  // Anything a URL carries reaches here; "abc" would fail as a malformed
  // bigint in the driver, which is a 500 wearing a bookmark.
  if (!/^\d+$/.test(draftId)) throw new NotFoundError(EXPIRED);

  const row = await db
    .selectFrom("upload_draft")
    .innerJoin("account", "account.id", "upload_draft.account_id")
    .select([
      "upload_draft.id",
      "upload_draft.account_id",
      "account.name as account_name",
      "account.closed_at",
      "upload_draft.filename",
      "upload_draft.raw_file",
      "upload_draft.as_of_date",
      "upload_draft.mapping",
      "upload_draft.created_at",
    ])
    .where("upload_draft.id", "=", draftId)
    .executeTakeFirst();

  // A closed account's draft is expired, not forbidden: its history does not
  // change, so the upload this row was staging can never land.
  if (row === undefined || row.closed_at !== null) throw new NotFoundError(EXPIRED);

  return {
    id: row.id,
    accountId: row.account_id,
    accountName: row.account_name,
    filename: row.filename,
    bytes: row.raw_file,
    asOfDate: row.as_of_date,
    mapping: row.mapping,
    createdAt: row.created_at,
  };
}
