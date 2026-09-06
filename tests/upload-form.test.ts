/**
 * The application's first multipart form, validated down to bytes (docs/specs/ingest/01,
 * DESIGN.md §5.1). Pure — no database. At risk is the guard order and the wording: every refusal
 * names the file or form field it's about, and a leading BOM (which looks like a fault but isn't)
 * must pass untouched. Size cap is guarded twice: Content-Length before buffering, File.size after.
 */
import { describe, expect, it } from "vitest";

import { ValidationError } from "~/lib/input.server";
import { parseUploadForm, refuseOversizedBody } from "~/lib/uploads.server";
import { getConfig } from "../server/config.ts";

// getConfig reads the environment once; the guards only need MAX_UPLOAD_MB, but the parse
// requires a plausible connection string (tests/routes/root.test.ts's precedent)
process.env.DATABASE_URL ??= "postgres://portfolio:portfolio@db:5432/portfolio";

const CAP_BYTES = getConfig().MAX_UPLOAD_MB * 1024 * 1024;

// the refusal a call produced, or a failure if it did not refuse
async function refusalOf(run: () => Promise<unknown>): Promise<ValidationError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("Expected the form to be refused, and it was not.");
}

// a drop-screen submission: an account and, usually, a file
function submission(file?: File): FormData {
  const form = new FormData();
  form.set("accountId", "1");
  if (file !== undefined) form.set("file", file);
  return form;
}

describe("parseUploadForm", () => {
  it("hands back the account and the bytes exactly as uploaded", async () => {
    const csv = new TextEncoder().encode("Symbol,Quantity\nVTI,100\n");
    const input = await parseUploadForm(
      submission(new File([csv], "Positions_2026-06-30.csv")),
    );

    expect(input.accountId).toBe("1");
    expect(input.filename).toBe("Positions_2026-06-30.csv");
    expect(Buffer.from(input.bytes).equals(Buffer.from(csv))).toBe(true);
  });

  it("refuses a missing file at field level, like every other form's field", async () => {
    const refusal = await refusalOf(() => parseUploadForm(submission()));

    expect(refusal.fieldErrors.file).toMatch(/Choose a statement file/);
  });

  it("names an empty file as empty — a fact about the download, not a parse error", async () => {
    const refusal = await refusalOf(() =>
      parseUploadForm(submission(new File([], "empty.csv"))),
    );

    expect(refusal.fieldErrors.file).toMatch(/no content/);
    expect(refusal.fieldErrors.file).toMatch(/Export the statement again/);
  });

  it("refuses bytes that are not UTF-8 text with a sentence, never a decoder error", async () => {
    // 0xC3 opens a two-byte sequence, 0x28 can't close one — malformed however it's read. An XLSX/PDF renamed .csv lands here too.
    const notText = new Uint8Array([0xc3, 0x28, 0x00, 0xff]);
    const refusal = await refusalOf(() =>
      parseUploadForm(submission(new File([notText], "statement.csv"))),
    );

    expect(refusal.fieldErrors.file).toMatch(/does not read as a text file/);
  });

  it("accepts a leading BOM as the valid UTF-8 it is, bytes untouched", async () => {
    // step 02 strips it; the drop screen must not refuse it — Windows exports lead with one routinely
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("Symbol\nVTI\n")]);
    const input = await parseUploadForm(submission(new File([bom], "bom.csv")));

    expect(Buffer.from(input.bytes).equals(Buffer.from(bom))).toBe(true);
  });

  it("refuses a file over the cap, naming the limit", async () => {
    const oversized = new File([new Uint8Array(CAP_BYTES + 1)], "huge.csv");
    const refusal = await refusalOf(() => parseUploadForm(submission(oversized)));

    expect(refusal.fieldErrors.file).toMatch(
      new RegExp(`larger than ${getConfig().MAX_UPLOAD_MB} MB`),
    );
  });
});

describe("refuseOversizedBody", () => {
  it("refuses a declared body over the cap before the body is read", () => {
    const request = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-length": String(CAP_BYTES + 1) },
    });

    expect(() => refuseOversizedBody(request)).toThrow(ValidationError);
    expect(() => refuseOversizedBody(request)).toThrow(
      new RegExp(`larger than ${getConfig().MAX_UPLOAD_MB} MB`),
    );
  });

  it("passes a request with no Content-Length through to the File.size check", () => {
    // absence isn't over the cap — the second guard inside parseUploadForm enforces the same bound once the file exists
    const request = new Request("http://localhost/upload", { method: "POST" });

    expect(() => refuseOversizedBody(request)).not.toThrow();
  });
});
