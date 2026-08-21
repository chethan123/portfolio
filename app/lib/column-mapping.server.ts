/**
 * The saved column mapping — how a brokerage's export format is remembered
 * once and applied to every later file (DESIGN.md §5.3, spec 0004 step 03).
 *
 * The key is `(account.institution, headerFingerprint)`: the institution
 * scopes it, and the fingerprint pins it to the exact header the mapping was
 * built against. The fingerprint is deliberately order-sensitive — a
 * reordered export is a different fingerprint and costs one re-map, which is
 * cheaper than a mapping that silently follows a column that moved — and
 * deliberately case- and padding-insensitive, because a brokerage retitling
 * `SYMBOL` as `Symbol` has not changed what any column means.
 *
 * This module also owns the columns screen's form contract,
 * {@link parseMappingForm}: the mapping's shape is this domain's, so the rules
 * for assembling one out of posted fields live beside the rules for storing
 * one, and the route stays the thin translation every other route is.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import { getDb, type Database } from "./db.server.ts";
import { ValidationError, parseInput } from "./input.server.ts";
import { statementMapping, type StatementMapping } from "./statement.ts";

import type { Delimiter } from "./csv.ts";
import type { Kysely } from "kysely";

/**
 * What an optional column's `<select>` posts when the reader says the column
 * is deliberately absent. Distinct from the empty string, which is the
 * unchosen placeholder: "unset" and "not in this file" are different answers,
 * and only the deliberate one survives a save (both land as `null` in the
 * mapping; a saved mapping preselects this option, never the placeholder).
 * The columns route reads it out of its loader data rather than importing it,
 * because this is a `.server` module and the option is rendered client-side.
 */
export const NOT_IN_FILE = "__none__";

/**
 * SHA-256 hex over the header row's cells: each trimmed, lowercased, internal
 * whitespace collapsed to one space, joined with a unit separator (U+001F), in
 * file order. The header row only — data rows never affect it, so the same
 * export next quarter fingerprints the same however the positions moved.
 */
export function headerFingerprint(cells: readonly string[]): string {
  const canonical = cells
    .map((cell) => cell.trim().toLowerCase().replace(/\s+/g, " "))
    .join("");

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * The mapping saved for this institution and header, or null.
 *
 * Null covers a malformed stored row too — validated through
 * {@link statementMapping} on the way out, because a mapping that no longer
 * matches the shape must read as "map it again", never as a 500 on a screen
 * whose whole job is to let the reader map it again.
 */
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

/**
 * Remember a mapping for this institution and header.
 *
 * An upsert on `column_mapping_one_per_fingerprint`, so a corrected mapping
 * replaces the one that was wrong rather than accumulating a second row the
 * constraint would refuse.
 */
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

/** The six selects, in the order the screen draws them, with their captions. */
const COLUMN_FIELDS = [
  { field: "instrument", label: "Instrument", required: true },
  { field: "quantity", label: "Quantity", required: true },
  { field: "name", label: "Name", required: false },
  { field: "costBasis", label: "Cost basis", required: false },
  { field: "asOf", label: "As-of date", required: false },
  { field: "accountNumber", label: "Account number", required: false },
] as const;

type ColumnField = (typeof COLUMN_FIELDS)[number]["field"];

/**
 * The chosen column, or null: the absent field, the placeholder and the
 * deliberate absence all mean "no column chosen" once the form is read.
 */
const chosenColumn = (value: string | undefined): string | null =>
  value === undefined || value === "" || value === NOT_IN_FILE ? null : value;

/**
 * The columns form, validated field by field against the file's own header.
 * Every check lives in one `superRefine` so a submission with three faults
 * comes back with three messages rather than one per round trip.
 */
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

        // The options are the header cells verbatim, so anything else is a
        // forged post, not a slip a reader could make.
        if (!header.includes(value)) {
          refuse(field, `"${value.trim()}" is not a column of this file's header row.`);
          continue;
        }

        // Trim-compared, matching how `parseStatement` finds a column: two
        // header cells differing only in padding are the same column.
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

/**
 * The columns screen's submission, assembled into the mapping JSON.
 *
 * @param fields the posted string fields — the six selects, the `costBasisIs`
 *        radio, the `owedAsPositive` checkbox and the hidden `headerRow`.
 * @param rows the draft file's rows, so every chosen column is checked
 *        against the header it claims to name.
 * @param delimiter the delimiter those rows were read with, recorded in the
 *        mapping so a later re-read never depends on the sniff agreeing twice.
 * @throws {ValidationError} a message per bad field; form-level only for the
 *         hidden header row, which no reader typed.
 */
export function parseMappingForm(
  fields: Record<string, string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  delimiter: Delimiter,
): StatementMapping {
  // The header row rides in a hidden field, so a bad one is a forged or stale
  // post rather than a control to hang a message under.
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
      // The refinement already refused these unchosen, so the fallbacks are
      // for the compiler; an empty string here would be `parseStatement`'s
      // "names no instrument column" problem, never a silent pass.
      instrument: column("instrument") ?? "",
      quantity: column("quantity") ?? "",
      name: column("name"),
      costBasis: column("costBasis"),
      asOf: column("asOf"),
      accountNumber: column("accountNumber"),
    },
    costBasisIs: input.costBasisIs === "total" ? "total" : "per_share",
    // A checkbox posts its value or nothing at all; nothing means unticked,
    // which keeps the file's own sign (the overdraft case, DESIGN.md §14.8).
    owedAsPositive: input.owedAsPositive === "true",
    // Not a control on the screen: combining is the behaviour the spec's
    // lot-level story promises, and a mapping that turned it off could only
    // be authored by hand. The refusal path for a duplicated instrument still
    // exists in `parseStatement` for exactly that mapping.
    combineDuplicateRows: true,
  };
}
