/**
 * Applying a column mapping to a file's rows: the second half of the parser,
 * where cells become positions (DESIGN.md §5.3, spec 0004). Pure — no
 * database, no request — so every awkward file is a fixture and a test, not a
 * bug found on the review screen with a household's real statement in hand.
 *
 * **Refusals are data, not throws**: structured problems addressed to a row
 * and column, because the mapping screen renders each beside the row that
 * caused it and a throw could name only the first fault. Problems present
 * means no commit; the positions that did parse are still returned so the
 * screen has something to show beside the complaint.
 *
 * **Numbers stay strings**: every figure goes through `normaliseFigure` and
 * `money.ts`'s digit arithmetic — §4.1 keeps money out of floats end to end.
 */
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

/**
 * What `numeric(20, 8)`/`numeric(20, 4)` hold before the point — the bounds
 * the forms enforce, applied here so an oversized figure is a sentence naming
 * its row rather than a driver error at commit.
 */
const QUANTITY_INTEGER_DIGITS = 12;
const PER_SHARE_INTEGER_DIGITS = 16;

/**
 * The mapping JSON a draft carries (spec 0004). Columns are named, not
 * indexed: the header fingerprint already guarantees the header row is the
 * one the mapping was built against. A null or absent optional column is
 * unmapped.
 */
export type StatementMapping = {
  /** Zero-based index into the file's rows. */
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
  /**
   * Whether the basis column states one share's cost or the whole position's
   * — brokerages split about evenly, and assuming either is wrong by a factor
   * of the position size on the other half. `total` divides by the quantity.
   */
  costBasisIs: "per_share" | "total";
  /**
   * A loan statement lists what is owed as positive, and §2 puts the sign in
   * the quantity — so this flag negates, never a heuristic. Unticked keeps
   * the file's own sign, which is how a genuine overdraft records.
   */
  owedAsPositive: boolean;
  combineDuplicateRows: boolean;
};

/**
 * The schema for both `jsonb` columns that store this shape
 * (`upload_draft.mapping`, `column_mapping.mapping`), so both writers read
 * back through one gate. A stored value that fails it is treated as no
 * mapping, not a throw: a malformed row is a fact about old data. Annotated
 * `z.ZodType<StatementMapping>` so the type and schema cannot drift silently.
 */
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

/** One position the file states, with every figure a decimal string. */
export type ParsedPosition = {
  /** Zero-based file row the position came from — the first, when combined. */
  row: number;
  /**
   * The exact weighted numerator behind `costBasisPerShare` when this
   * position is several rows folded, so the spelling fold in
   * `uploads.server.ts` divides once rather than averaging an average — see
   * {@link FoldableLot}.
   */
  weightedBasisUnits?: bigint | null;
  /**
   * The cell exactly as written, untrimmed and unresolved: alias lookup is
   * byte-exact (`collate "C"`), so the parser must not normalise it.
   */
  instrument: string;
  name: string | null;
  quantity: string;
  costBasisPerShare: string | null;
  accountNumber: string | null;
};

/** One instrument the file listed on several rows, folded into one position. */
export type CombinedRows = {
  instrument: string;
  rowCount: number;
  /** The summed quantity, as the resulting position holds it. */
  quantity: string;
};

/**
 * A row naming an instrument whose quantity was an absence spelling — a sweep
 * line, a subtotal. Skipped and reported, because a row vanishing silently is
 * how "a missing row means sold" becomes an accident.
 */
export type SkippedRow = {
  row: number;
  instrument: string;
};

/**
 * One reason the file cannot be committed, addressed to where it happened:
 * `row` zero-based (`null` for a mapping fault), `column` the mapped name at
 * fault. Messages speak in one-based lines, the way a reader counts.
 */
export type ParseProblem = {
  row: number | null;
  column: string | null;
  message: string;
};

export type ParsedStatement = {
  positions: ParsedPosition[];
  /** The duplicate-row combinations, for the review screen to print as lines. */
  combined: CombinedRows[];
  skipped: SkippedRow[];
  /** The statement's own date, when the file carried a valid one. */
  asOfDate: string | null;
  /** False when the mapping names no as-of column, so a screen must ask. */
  asOfMapped: boolean;
  /** Empty means the file is usable; anything here refuses the commit. */
  problems: ParseProblem[];
};

/** A normalised figure with no nonzero digit. The sign is already stripped. */
function isZero(value: string): boolean {
  return /^0+(\.0+)?$/.test(value);
}

function fractionDigits(value: string): number {
  return (value.split(".")[1] ?? "").length;
}

/** Digits before the point that matter, on a normalised figure. */
function integerDigits(value: string): number {
  return (value.split(".")[0] ?? "").replace(/^-/, "").replace(/^0+/, "").length;
}

/** One lot a fold sums: how much of something, and what one unit cost. */
export type FoldableLot = {
  /** Decimal string at the quantity column's scale, sign included. */
  quantity: string;
  /** Null when the lot's own basis is unknown. */
  costBasisPerShare: string | null;
  /**
   * The exact quantity-weighted numerator (units of 10^-12) when the lot is
   * itself an earlier fold's result — what makes the flow's two folds add up
   * to one: `costBasisPerShare` is rounded to money scale, and a second fold
   * re-weighting *it* would average an average. Absent on a lot straight off
   * a file.
   */
  weightedBasisUnits?: bigint | null;
};

/**
 * Fold several lots of one instrument into one position: quantities summed,
 * basis quantity-weighted, at the columns' scales — the one weighted-average
 * rule for both folds (the parser's duplicate combining and the spelling fold
 * in `uploads.server.ts`), extracted so the arithmetic stays one
 * implementation wide. Numerator in 10^-12 units (money × quantity),
 * denominator 10^-8, so the plain quotient is already in money units. Basis
 * is null when the lots net to nothing (no quantity to weight by) or any
 * lot's basis is unknown — a blended figure over a gap is fake precision.
 */
export function foldLots(lots: ReadonlyArray<FoldableLot>): {
  /** The summed quantity rendered at `numeric(20, 8)`'s scale. */
  quantity: string;
  costBasisPerShare: string | null;
  /** The exact numerator behind that figure — see {@link FoldableLot}. */
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
      // The lot's own exact numerator when it has one: a previously folded
      // lot is re-weighted from what it summed, never from what it rounded to.
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

/**
 * A statement's as-of cell as `recordedDate` reads it: ISO kept as written,
 * the US shapes real exports carry (`MM/DD/YYYY`) rewritten. Only the
 * spelling moves — `13/40/2026` becomes `2026-13-40` and is refused as not on
 * the calendar. Row disagreement compares these normalised spellings, so
 * `06/30/2026` and `2026-06-30` in one file are one date, not two.
 */
function isoAsOf(value: string): string {
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (us === null) return value;
  return `${us[3]}-${(us[1] ?? "").padStart(2, "0")}-${(us[2] ?? "").padStart(2, "0")}`;
}

/** One data row, parsed but not yet combined, with the file's own sign. */
type RowRecord = {
  row: number;
  instrument: string;
  name: string | null;
  accountNumber: string | null;
  quantity: string;
  costBasisPerShare: string | null;
};

/**
 * Apply a mapping to a file's rows, yielding the positions the statement
 * states — or the problems standing between it and the commit. The row rules
 * (spec 0004 step 02): rows above the header are preamble; a blank instrument
 * cell is a footer, skipped; an instrument whose quantity is an absence
 * marker is skipped and reported ({@link SkippedRow}); a nonsense quantity
 * refuses the file naming the row — a disclaimer under the symbol column must
 * not become a position; quantities finer than eight places and money finer
 * than four are refused, never rounded; a file dated before the first
 * priceable day refuses by {@link recordedDate}'s rule; duplicate instrument
 * strings combine when the mapping says so (summed, quantity-weighted) and
 * are reported — with combining off, a duplicate refuses, since a position
 * set holds one row per instrument.
 */
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

  // A mapping missing a required column, or pointing past the file, is the
  // mapping's fault — no row can be named, and nothing below can run.
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
          // Total over the file's own signed quantity, so a short lot's
          // negative total still yields the positive per-share fact a price
          // is (§2). A zero quantity has no per-share cost — null, not a
          // division fault.
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

  // Grouped by the raw string before alias resolution: two spellings of one
  // fund become one row in step 04 — combining now would guess what
  // resolution decides.
  const groups = new Map<string, RowRecord[]>();
  for (const record of records) {
    const group = groups.get(record.instrument);
    if (group === undefined) groups.set(record.instrument, [record]);
    else group.push(record);
  }

  // `owedAsPositive`'s negation, applied to final quantities. Zero keeps no
  // sign: "−0.00" is a debt of nothing written as though it were something.
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

    // Quantities summed, basis quantity-weighted — `foldLots` states the rule
    // once for this fold and the spelling fold both. The sum is over the
    // file's own signs; the mapping's negation applies to the result.
    const fold = foldLots(group);
    const quantity = signed(fold.quantity);

    // `signed` may flip the sign after the weighting, and the numerator is
    // basis × quantity — it must flip too, or the spelling fold would report
    // a liability's cost basis inverted.
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

  // The first row carrying an as-of speaks for the file; every other row must
  // agree once both are spelled `isoAsOf`'s way; the value is validated as a
  // typed date is (a statement dated 2126 would pin the account until 2126).
  // Two dates refuse the file naming both, never picking one: a statement is
  // a photograph of one day.
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
