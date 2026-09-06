// Applies a column mapping to a file's rows, turning cells into positions (DESIGN.md §5.3,
// spec 0004). Pure. Refusals are data (ParseProblem[] addressed to a row/column), never a
// throw, so the mapping screen can show every fault beside its row. Figures stay strings
// through normaliseFigure and money.ts's digit arithmetic (§4.1).
import { z } from "zod";

import {
  MONEY_SCALE,
  QUANTITY_SCALE,
  divide,
  normaliseFigure,
  render,
  toUnits,
} from "./money.ts";
import { recordedDate } from "./input.server.ts";

import type { Delimiter } from "./csv.ts";

// numeric(20,8)/numeric(20,4) digits before the point — enforced here so an oversized
// figure is a message naming its row, not a driver error at commit.
const QUANTITY_INTEGER_DIGITS = 12;
const PER_SHARE_INTEGER_DIGITS = 16;

// The mapping JSON a draft carries (spec 0004). Columns are named, not indexed — the header
// fingerprint already guarantees the header row matches. Null/absent optional column = unmapped.
export type StatementMapping = {
  headerRow: number;
  delimiter: Delimiter;
  columns: {
    instrument: string;
    quantity: string;
    name?: string | null;
    costBasis?: string | null;
    asOf?: string | null;
    accountNumber?: string | null;
  };
  // "total" divides by quantity to get per-share; brokerages split roughly evenly between the two.
  costBasisIs: "per_share" | "total";
  // A loan statement lists what's owed as positive; this negates rather than guessing from sign.
  owedAsPositive: boolean;
  combineDuplicateRows: boolean;
};

// Shared schema for both jsonb columns storing this shape (upload_draft.mapping,
// column_mapping.mapping). A stored value failing it means no mapping, never a throw.
// Annotated z.ZodType<StatementMapping> so type and schema can't drift silently.
export const statementMapping: z.ZodType<StatementMapping> = z.object({
  headerRow: z.number().int().nonnegative(),
  delimiter: z.enum([",", ";", "\t"]),
  columns: z.object({
    instrument: z.string().min(1),
    quantity: z.string().min(1),
    name: z.string().nullish(),
    costBasis: z.string().nullish(),
    asOf: z.string().nullish(),
    accountNumber: z.string().nullish(),
  }),
  costBasisIs: z.enum(["per_share", "total"]),
  owedAsPositive: z.boolean(),
  combineDuplicateRows: z.boolean(),
});

export type ParsedPosition = {
  row: number; // first row, when combined
  // Exact weighted numerator behind costBasisPerShare when folded from several rows, so a
  // later fold (uploads.server.ts) divides once rather than averaging an average.
  weightedBasisUnits?: bigint | null;
  // Exactly as written, untrimmed and unresolved: alias lookup is byte-exact (collate "C").
  instrument: string;
  name: string | null;
  quantity: string;
  costBasisPerShare: string | null;
  accountNumber: string | null;
};

export type CombinedRows = {
  instrument: string;
  rowCount: number;
  quantity: string;
};

// An instrument whose quantity was an absence spelling (sweep line, subtotal) — skipped and
// reported rather than silently dropped.
export type SkippedRow = {
  row: number;
  instrument: string;
};

// row is zero-based (null for a mapping fault); message speaks in one-based lines.
export type ParseProblem = {
  row: number | null;
  column: string | null;
  message: string;
};

export type ParsedStatement = {
  positions: ParsedPosition[];
  combined: CombinedRows[];
  skipped: SkippedRow[];
  asOfDate: string | null;
  asOfMapped: boolean; // false when the mapping names no as-of column
  problems: ParseProblem[]; // empty means usable; anything here refuses the commit
};

function isZero(value: string): boolean {
  return /^0+(\.0+)?$/.test(value);
}

function fractionDigits(value: string): number {
  return (value.split(".")[1] ?? "").length;
}

function integerDigits(value: string): number {
  return (value.split(".")[0] ?? "").replace(/^-/, "").replace(/^0+/, "").length;
}

export type FoldableLot = {
  quantity: string; // decimal string at the quantity column's scale, sign included
  costBasisPerShare: string | null; // null when unknown
  // Exact weighted numerator (10^-12 units) when this lot is itself an earlier fold's
  // result — re-weighting the rounded costBasisPerShare instead would average an average.
  weightedBasisUnits?: bigint | null;
};

// Folds several lots of one instrument into one: quantities summed, basis quantity-weighted.
// Shared by duplicate-row combining here and the spelling fold in uploads.server.ts so the
// weighted-average rule stays one implementation. Numerator in 10^-12 (money*quantity),
// denominator 10^-8, so the quotient is already money units. Basis is null when lots net to
// zero quantity or any lot's basis is unknown (a blended figure over a gap is fake precision).
export function foldLots(lots: ReadonlyArray<FoldableLot>): {
  quantity: string;
  costBasisPerShare: string | null;
  weightedBasisUnits: bigint | null;
} {
  const quantityUnits = lots.reduce(
    (sum, lot) => sum + toUnits(lot.quantity, QUANTITY_SCALE),
    0n,
  );

  let costBasisPerShare: string | null = null;
  let weighted: bigint | null = null;

  if (quantityUnits !== 0n && lots.every((lot) => lot.costBasisPerShare !== null)) {
    weighted = 0n;
    for (const lot of lots) {
      // Prefer the lot's own exact numerator: re-weight what a prior fold summed, not what it rounded to.
      weighted +=
        lot.weightedBasisUnits ??
        toUnits(lot.costBasisPerShare ?? "0", MONEY_SCALE) *
          toUnits(lot.quantity, QUANTITY_SCALE);
    }
    costBasisPerShare = render(divide(weighted, quantityUnits, 0), MONEY_SCALE);
  }

  return {
    quantity: render(quantityUnits, QUANTITY_SCALE),
    costBasisPerShare,
    weightedBasisUnits: weighted,
  };
}

// ISO kept as written; US shapes (MM/DD/YYYY) rewritten to it. Only the spelling moves —
// "13/40/2026" becomes "2026-13-40" and is refused as not on the calendar downstream.
function isoAsOf(value: string): string {
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (us === null) return value;
  return `${us[3]}-${(us[1] ?? "").padStart(2, "0")}-${(us[2] ?? "").padStart(2, "0")}`;
}

type RowRecord = {
  row: number;
  instrument: string;
  name: string | null;
  accountNumber: string | null;
  quantity: string;
  costBasisPerShare: string | null;
};

// Applies a mapping to a file's rows (spec 0004 step 02): rows above the header are
// preamble; blank-instrument rows are footers, skipped; an absent-quantity row is skipped
// and reported; a nonsense or over-precise quantity/basis refuses the file naming the row,
// never rounds; duplicate instrument rows combine (summed, quantity-weighted) when the
// mapping allows it, else refuse — a position set holds one row per instrument.
export function parseStatement(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  mapping: StatementMapping,
): ParsedStatement {
  const problems: ParseProblem[] = [];
  const { columns } = mapping;
  const asOfMapped = typeof columns.asOf === "string" && columns.asOf !== "";

  const refused = (): ParsedStatement => ({
    positions: [],
    combined: [],
    skipped: [],
    asOfDate: null,
    asOfMapped,
    problems,
  });

  if (!columns.instrument) {
    problems.push({
      row: null,
      column: null,
      message: "The mapping names no instrument column, and a position is nothing without one.",
    });
  }
  if (!columns.quantity) {
    problems.push({
      row: null,
      column: null,
      message: "The mapping names no quantity column, and a position is nothing without one.",
    });
  }

  const header = rows[mapping.headerRow];
  if (header === undefined) {
    problems.push({
      row: null,
      column: null,
      message:
        `The mapping points at header row ${mapping.headerRow + 1}, ` +
        `and the file has only ${rows.length} row${rows.length === 1 ? "" : "s"}.`,
    });
  }

  if (problems.length > 0) return refused();

  const indexOf = (name: string | null | undefined): number | null => {
    if (typeof name !== "string" || name === "") return null;
    const index = (header ?? []).findIndex((cell) => cell.trim() === name.trim());
    if (index === -1) {
      problems.push({
        row: mapping.headerRow,
        column: name,
        message: `The file's header row has no "${name}" column.`,
      });
      return null;
    }
    return index;
  };

  const instrumentIndex = indexOf(columns.instrument);
  const quantityIndex = indexOf(columns.quantity);
  const nameIndex = indexOf(columns.name);
  const costBasisIndex = indexOf(columns.costBasis);
  const asOfIndex = indexOf(columns.asOf);
  const accountNumberIndex = indexOf(columns.accountNumber);

  if (problems.length > 0 || instrumentIndex === null || quantityIndex === null) {
    return refused();
  }

  const records: RowRecord[] = [];
  const skipped: SkippedRow[] = [];
  const asOfSightings: Array<{ row: number; value: string }> = [];

  const optionalCell = (cells: ReadonlyArray<string>, index: number | null): string | null => {
    const value = index === null ? "" : (cells[index] ?? "").trim();
    return value === "" ? null : value;
  };

  for (let row = mapping.headerRow + 1; row < rows.length; row++) {
    const cells = rows[row] ?? [];
    const instrument = cells[instrumentIndex] ?? "";
    if (instrument.trim() === "") continue;

    const line = row + 1;
    const quantityCell = (cells[quantityIndex] ?? "").trim();
    const quantity = normaliseFigure(quantityCell);

    if (quantity.kind === "absent") {
      skipped.push({ row, instrument });
      continue;
    }
    if (quantity.kind === "unparseable") {
      problems.push({
        row,
        column: columns.quantity,
        message:
          `Line ${line} names "${instrument.trim()}" but its quantity ` +
          `reads "${quantityCell}", which is not a number.`,
      });
      continue;
    }
    if (fractionDigits(quantity.value) > QUANTITY_SCALE) {
      problems.push({
        row,
        column: columns.quantity,
        message:
          `Line ${line}'s quantity carries ${fractionDigits(quantity.value)} decimal places, ` +
          `and a quantity is stored to ${QUANTITY_SCALE} — refused rather than rounded.`,
      });
      continue;
    }
    if (integerDigits(quantity.value) > QUANTITY_INTEGER_DIGITS) {
      problems.push({
        row,
        column: columns.quantity,
        message: `Line ${line}'s quantity is larger than this application can store.`,
      });
      continue;
    }

    let costBasisPerShare: string | null = null;
    if (costBasisIndex !== null) {
      const basisCell = (cells[costBasisIndex] ?? "").trim();
      const basis = normaliseFigure(basisCell);

      if (basis.kind === "unparseable") {
        problems.push({
          row,
          column: columns.costBasis ?? null,
          message:
            `Line ${line}'s cost basis reads "${basisCell}", ` +
            "which is neither a number nor blank.",
        });
        continue;
      }
      if (basis.kind === "figure") {
        if (fractionDigits(basis.value) > MONEY_SCALE) {
          problems.push({
            row,
            column: columns.costBasis ?? null,
            message:
              `Line ${line}'s cost basis carries ${fractionDigits(basis.value)} decimal ` +
              `places, and money is stored to ${MONEY_SCALE} — refused rather than rounded.`,
          });
          continue;
        }
        if (integerDigits(basis.value) > PER_SHARE_INTEGER_DIGITS) {
          problems.push({
            row,
            column: columns.costBasis ?? null,
            message: `Line ${line}'s cost basis is larger than this application can store.`,
          });
          continue;
        }

        if (mapping.costBasisIs === "total") {
          // Divides by the file's own signed quantity (§2); zero quantity has no per-share cost.
          costBasisPerShare = isZero(quantity.value)
            ? null
            : render(
                divide(
                  toUnits(basis.value, MONEY_SCALE),
                  toUnits(quantity.value, QUANTITY_SCALE),
                  QUANTITY_SCALE,
                ),
                MONEY_SCALE,
              );
        } else {
          costBasisPerShare = basis.value;
        }
      }
    }

    if (asOfIndex !== null) {
      const asOfCell = (cells[asOfIndex] ?? "").trim();
      if (asOfCell !== "") asOfSightings.push({ row, value: asOfCell });
    }

    records.push({
      row,
      instrument,
      name: optionalCell(cells, nameIndex),
      accountNumber: optionalCell(cells, accountNumberIndex),
      quantity: quantity.value,
      costBasisPerShare,
    });
  }

  // Grouped by raw string before alias resolution — combining now would guess what step 04 decides.
  const groups = new Map<string, RowRecord[]>();
  for (const record of records) {
    const group = groups.get(record.instrument);
    if (group === undefined) groups.set(record.instrument, [record]);
    else group.push(record);
  }

  // Zero keeps no sign: "-0.00" would read as a debt of nothing written as though it were something.
  const signed = (quantity: string): string => {
    if (!mapping.owedAsPositive || isZero(quantity)) return quantity;
    return quantity.startsWith("-") ? quantity.slice(1) : `-${quantity}`;
  };

  const positions: ParsedPosition[] = [];
  const combined: CombinedRows[] = [];

  for (const [instrument, group] of groups) {
    const first = group[0];
    if (first === undefined) continue;

    if (group.length === 1) {
      positions.push({
        row: first.row,
        instrument,
        name: first.name,
        accountNumber: first.accountNumber,
        quantity: signed(first.quantity),
        costBasisPerShare: first.costBasisPerShare,
      });
      continue;
    }

    if (!mapping.combineDuplicateRows) {
      problems.push({
        row: group[1]?.row ?? first.row,
        column: columns.instrument,
        message:
          `"${instrument.trim()}" appears on ${group.length} lines, and with combining ` +
          "turned off a statement cannot hold the same instrument twice.",
      });
      continue;
    }

    const fold = foldLots(group);
    const quantity = signed(fold.quantity);

    // signed may flip the sign after weighting; the numerator (basis*quantity) must flip
    // too, or the spelling fold would report a liability's cost basis inverted.
    const negated = quantity !== fold.quantity;
    const weightedBasisUnits =
      fold.weightedBasisUnits === null
        ? null
        : negated
          ? -fold.weightedBasisUnits
          : fold.weightedBasisUnits;

    positions.push({
      row: first.row,
      instrument,
      name: first.name,
      accountNumber: first.accountNumber,
      quantity,
      costBasisPerShare: fold.costBasisPerShare,
      weightedBasisUnits,
    });
    combined.push({ instrument, rowCount: group.length, quantity });
  }

  // First as-of sighting speaks for the file; every other must agree once normalised by
  // isoAsOf. Two disagreeing dates refuse naming both — a statement is a photograph of one day.
  let asOfDate: string | null = null;
  const firstSighting = asOfSightings[0];
  if (firstSighting !== undefined) {
    const differing = asOfSightings.find(
      (sighting) => isoAsOf(sighting.value) !== isoAsOf(firstSighting.value),
    );
    if (differing !== undefined) {
      problems.push({
        row: differing.row,
        column: columns.asOf ?? null,
        message:
          `The file carries two as-of dates — "${firstSighting.value}" on line ` +
          `${firstSighting.row + 1} and "${differing.value}" on line ${differing.row + 1} — ` +
          "and a statement is a photograph of one day.",
      });
    } else {
      const parsed = recordedDate("The as-of date").safeParse(isoAsOf(firstSighting.value));
      if (parsed.success) {
        asOfDate = parsed.data;
      } else {
        problems.push({
          row: firstSighting.row,
          column: columns.asOf ?? null,
          message: parsed.error.issues[0]?.message ?? "The as-of date could not be read.",
        });
      }
    }
  }

  return { positions, combined, skipped, asOfDate, asOfMapped, problems };
}
