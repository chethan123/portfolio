// Saved column mappings — a brokerage's export format remembered once, applied to later files
// (DESIGN.md §5.3, spec 0004 step 03). Keyed by (institution, header fingerprint): order-sensitive
// (reordered export = re-map) but case/padding-insensitive. Also owns the columns form contract
// (parseMappingForm) so the route stays a thin translator.
import { createHash } from "node:crypto";

import { z } from "zod";

import { getDb, type Database } from "./db.server.ts";
import { ValidationError, parseInput } from "./input.server.ts";
import { statementMapping, type StatementMapping } from "./statement.ts";

import type { Delimiter } from "./csv.ts";
import type { Kysely } from "kysely";

// "Deliberately not in this file", distinct from "" (unchosen placeholder): both map to null via
// chosenColumn, but only this one survives a save and preselects on a saved mapping.
export const NOT_IN_FILE = "__none__";

// SHA-256 over header cells (trimmed, lowercased, whitespace collapsed), concatenated in file
// order. Header row only — data rows never affect it.
export function headerFingerprint(cells: readonly string[]): string {
  const canonical = cells
    .map((cell) => cell.trim().toLowerCase().replace(/\s+/g, " "))
    .join("");

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// Null for a malformed stored row too (via statementMapping) — reads as "map it again", never a 500.
export async function findMapping(
  institution: string,
  fingerprint: string,
  db: Kysely<Database> = getDb(),
): Promise<StatementMapping | null> {
  const row = await db
    .selectFrom("column_mapping")
    .select("mapping")
    .where("institution", "=", institution)
    .where("header_fingerprint", "=", fingerprint)
    .executeTakeFirst();

  if (row === undefined) return null;

  const parsed = statementMapping.safeParse(row.mapping);
  return parsed.success ? parsed.data : null;
}

// Upsert on column_mapping_one_per_fingerprint: a corrected mapping replaces the wrong one.
export async function upsertMapping(
  institution: string,
  fingerprint: string,
  mapping: StatementMapping,
  db: Kysely<Database> = getDb(),
): Promise<void> {
  const value = JSON.stringify(mapping);

  await db
    .insertInto("column_mapping")
    .values({ institution, header_fingerprint: fingerprint, mapping: value })
    .onConflict((conflict) =>
      conflict.constraint("column_mapping_one_per_fingerprint").doUpdateSet({ mapping: value }),
    )
    .execute();
}

// The six selects, in the order the screen draws them, with their captions.
const COLUMN_FIELDS = [
  { field: "instrument", label: "Instrument", required: true },
  { field: "quantity", label: "Quantity", required: true },
  { field: "name", label: "Name", required: false },
  { field: "costBasis", label: "Cost basis", required: false },
  { field: "asOf", label: "As-of date", required: false },
  { field: "accountNumber", label: "Account number", required: false },
] as const;

type ColumnField = (typeof COLUMN_FIELDS)[number]["field"];

// Absent field, placeholder and deliberate absence all read as "no column chosen".
const chosenColumn = (value: string | undefined): string | null =>
  value === undefined || value === "" || value === NOT_IN_FILE ? null : value;

// One superRefine so a submission with three faults reports three messages, not one per round trip.
const mappingForm = (header: ReadonlyArray<string>) =>
  z
    .object({
      instrument: z.string().optional(),
      quantity: z.string().optional(),
      name: z.string().optional(),
      costBasis: z.string().optional(),
      asOf: z.string().optional(),
      accountNumber: z.string().optional(),
      costBasisIs: z.string().optional(),
      owedAsPositive: z.string().optional(),
    })
    .superRefine((form, ctx) => {
      const refuse = (field: string, message: string) =>
        ctx.addIssue({ code: "custom", path: [field], message });

      const chosen: Array<{ label: string; column: string }> = [];

      for (const { field, label, required } of COLUMN_FIELDS) {
        const value = chosenColumn(form[field]);

        if (value === null) {
          if (required) {
            refuse(
              field,
              `Choose the column that holds the ${label.toLowerCase()} — ` +
                "a statement is nothing without one.",
            );
          }
          continue;
        }

        // Options are header cells verbatim: a mismatch is a forged post, not a UI slip.
        if (!header.includes(value)) {
          refuse(field, `"${value.trim()}" is not a column of this file's header row.`);
          continue;
        }

        // Trim-compared like parseStatement: padding-only difference is the same column.
        const twin = chosen.find((earlier) => earlier.column.trim() === value.trim());
        if (twin !== undefined) {
          refuse(
            field,
            `"${value.trim()}" is already mapped to ${twin.label}, and one column ` +
              `cannot also be the ${label.toLowerCase()}.`,
          );
          continue;
        }

        chosen.push({ label, column: value });
      }

      if (form.costBasisIs !== "per_share" && form.costBasisIs !== "total") {
        refuse(
          "costBasisIs",
          "Choose whether the cost basis column states one share's cost or the position's.",
        );
      }
    });

// delimiter is recorded in the mapping so a later re-read never depends on re-sniffing agreeing.
export function parseMappingForm(
  fields: Record<string, string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  delimiter: Delimiter,
): StatementMapping {
  // Hidden field: a bad header row is a forged/stale post, not a control to hang a message under.
  const headerRow = /^\d+$/.test(fields.headerRow ?? "") ? Number(fields.headerRow) : null;
  const header = headerRow === null ? undefined : rows[headerRow];
  if (headerRow === null || header === undefined) {
    throw ValidationError.form(
      "The header row this mapping was made against is not in the file. " +
        "Re-read the file and choose the columns again.",
    );
  }

  const input = parseInput(mappingForm(header), fields);

  const column = (field: ColumnField): string | null => chosenColumn(input[field]);

  return {
    headerRow,
    delimiter,
    columns: {
      // superRefine already refused these if unchosen — fallback is for the type checker only.
      instrument: column("instrument") ?? "",
      quantity: column("quantity") ?? "",
      name: column("name"),
      costBasis: column("costBasis"),
      asOf: column("asOf"),
      accountNumber: column("accountNumber"),
    },
    costBasisIs: input.costBasisIs === "total" ? "total" : "per_share",
    // Unticked (absent) keeps the file's own sign — the overdraft case (DESIGN.md §14.8).
    owedAsPositive: input.owedAsPositive === "true",
    // No screen control — only a hand-authored mapping disables this, and parseStatement
    // still refuses duplicates for that mapping.
    combineDuplicateRows: true,
  };
}
