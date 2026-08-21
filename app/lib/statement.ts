/**
 * Applying a column mapping to a file's rows: the second half of the parser,
 * where cells become positions (DESIGN.md §5.3, spec 0004).
 *
 * Pure — no database, no request — so every awkward file in existence is a
 * fixture and a test rather than a bug found on the review screen with a
 * household's real statement in hand.
 *
 * **Refusals are data, not throws.** The result carries structured problems,
 * each addressed to a row and column, because the mapping screen renders a
 * refusal beside the row that caused it and remapping is the fix — a thrown
 * error could name only the first fault, and a screen cannot point at a stack
 * trace. Problems present means the file must not be committed; the positions
 * that did parse are still returned so the screen has something to show beside
 * the complaint.
 *
 * **Numbers stay strings.** Every figure goes through `normaliseFigure` and
 * the digit-level arithmetic in `money.ts`; nothing here touches a JavaScript
 * number, because §4.1 keeps money out of floats end to end and 0003 made that
 * one module wide by construction.
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
 * What `numeric(20, 8)` and `numeric(20, 4)` hold before the point — the same
 * bounds `signedQuantity` and `perShareAmount` enforce on the forms, applied
 * here so an oversized figure is a sentence naming its row rather than a
 * driver error at commit.
 */
const QUANTITY_INTEGER_DIGITS = 12;
const PER_SHARE_INTEGER_DIGITS = 16;

/**
 * The mapping JSON a draft carries (spec 0004, "The mapping JSON"). Columns are
 * named, not indexed: the header fingerprint already guarantees the header row
 * is the one the mapping was built against, so a name is the readable half of
 * an equivalent key. An optional column that is null or absent is unmapped.
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
   * Whether the basis column states one share's cost or the whole position's.
   * Brokerages split about evenly, and assuming either is wrong by a factor of
   * the position size on the other half — `total` is divided by the row's
   * quantity here, at `numeric(20, 4)`'s scale.
   */
  costBasisIs: "per_share" | "total";
  /**
   * A loan statement lists what is owed as a positive number, and §2 puts the
   * sign in the quantity — so something has to negate it, and it is this flag,
   * not a heuristic. Unticked, the file's own sign is kept, which is how a
   * bank export carrying a genuine overdraft records one.
   */
  owedAsPositive: boolean;
  combineDuplicateRows: boolean;
};

/**
 * The same shape as a schema, for the two `jsonb` columns that store it —
 * `upload_draft.mapping` and `column_mapping.mapping` share this one
 * definition, so a row written by either writer reads back through the same
 * gate. A stored value that fails it is treated as no mapping at all rather
 * than a throw: a malformed row is a fact about old data, not a fault in the
 * request that happened to read it.
 *
 * Annotated as `z.ZodType<StatementMapping>` so the type above and the schema
 * cannot drift apart without the compiler saying so.
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
   * The instrument cell exactly as written, untrimmed and unresolved. Alias
   * lookup is byte-exact (`collate "C"`), so the parser must not normalise
   * what resolution will look up.
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
 * A row named an instrument but its quantity cell was one of the absence
 * spellings — a `Cash & Cash Investments` line, a subtotal. Skipped rather
 * than refused, and reported so the review screen can say so: a row that
 * vanishes silently is how "a missing row means sold" becomes an accident.
 */
export type SkippedRow = {
  row: number;
  instrument: string;
};

/**
 * One reason the file cannot be committed, addressed to where it happened.
 * `row` is a zero-based index into the file's rows (`null` when the fault is
 * the mapping's, not a row's); `column` is the mapped column name at fault,
 * when one is. Messages speak in one-based lines, the way a reader counts.
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

/** Digits after the point, on a normalised figure. */
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
};

/**
 * Fold several lots of one instrument into one position: quantities summed,
 * basis quantity-weighted, both at the columns' scales.
 *
 * The one weighted-average rule for the two folds the flow performs — the
 * parser's duplicate-row combining here, and the post-resolution spelling fold
 * in `uploads.server.ts` — extracted so the money arithmetic stays exactly one
 * implementation wide (`money.ts` gives the reason). The weighted numerator is
 * in units of 10^-12 (money × quantity), the denominator 10^-8, so the plain
 * quotient is already in money units.
 *
 * The basis is null when the lots net to nothing — no quantity to weight by —
 * or when any lot's own basis is unknown, since a blended figure over a gap
 * would be a fake precision.
 */
export function foldLots(lots: ReadonlyArray<FoldableLot>): {
  /** The summed quantity rendered at `numeric(20, 8)`'s scale. */
  quantity: string;
  costBasisPerShare: string | null;
} {
  const quantityUnits = lots.reduce(
    (sum, lot) => sum + toUnits(lot.quantity, QUANTITY_SCALE),
    0n,
  );

  let costBasisPerShare: string | null = null;
  if (quantityUnits !== 0n && lots.every((lot) => lot.costBasisPerShare !== null)) {
    let weighted = 0n;
    for (const lot of lots) {
      weighted +=
        toUnits(lot.costBasisPerShare ?? "0", MONEY_SCALE) *
        toUnits(lot.quantity, QUANTITY_SCALE);
    }
    costBasisPerShare = render(divide(weighted, quantityUnits, 0), MONEY_SCALE);
  }

  return { quantity: render(quantityUnits, QUANTITY_SCALE), costBasisPerShare };
}

/**
 * A statement's as-of cell as `recordedDate` reads it: ISO kept as written,
 * and the US shapes real exports carry — `MM/DD/YYYY`, `M/D/YYYY` — rewritten
 * to `YYYY-MM-DD`. Only the spelling moves; whether the result is a real,
 * recordable date is still `recordedDate`'s question, so `13/40/2026` becomes
 * `2026-13-40` and is refused as not on the calendar. Disagreement between
 * rows compares these normalised spellings, so `06/30/2026` and `2026-06-30`
 * in one file are one date, not two.
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
 * states — or the problems standing between it and the commit.
 *
 * The row rules, each a checklist item in spec 0004 step 02:
 *
 * - rows above the header are preamble and never read
 * - a row whose instrument cell is blank is a footer or spacer, skipped
 * - a row naming an instrument whose quantity is an absence marker is skipped
 *   and reported (see {@link SkippedRow})
 * - a row naming an instrument whose quantity is nonsense refuses the file,
 *   naming the row — a disclaimer that happens to sit under the symbol column
 *   must not become a position
 * - quantities finer than eight decimal places, and money finer than four, are
 *   refused rather than rounded: the columns hold what the file said or the
 *   file is wrong, never a silently adjusted figure
 * - rows sharing an instrument string are combined when the mapping says so —
 *   quantities summed, basis quantity-weighted — and reported; with combining
 *   off, a duplicated instrument is a refusal, because a position set holds
 *   one row per instrument
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

  // A mapping missing a required column, or pointing at rows the file does not
  // have, is the mapping's fault — no row can be named, and nothing below can
  // run without the indices these checks establish.
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
          // Total over quantity, at `numeric(20, 4)`'s scale. The division uses
          // the file's own signed quantity, so a short lot's negative total
          // still yields the positive per-share fact a price is (§2). A zero
          // quantity has no per-share cost — null, not a division fault.
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

  // Grouped by the raw string as written, before alias resolution: two
  // spellings of one fund are two entries here, and become one row in step
  // 04's resolution — combining them now would guess what resolution decides.
  const groups = new Map<string, RowRecord[]>();
  for (const record of records) {
    const group = groups.get(record.instrument);
    if (group === undefined) groups.set(record.instrument, [record]);
    else group.push(record);
  }

  // The negation `owedAsPositive` promises, applied to the final quantities:
  // zero keeps no sign, because "−0.00" is a debt of nothing written as though
  // it were something (`setBalance` says the same).
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

    positions.push({
      row: first.row,
      instrument,
      name: first.name,
      accountNumber: first.accountNumber,
      quantity,
      costBasisPerShare: fold.costBasisPerShare,
    });
    combined.push({ instrument, rowCount: group.length, quantity });
  }

  // The as-of date: the first row carrying one speaks for the file, every
  // other row must agree with it once both are spelled the one way `isoAsOf`
  // spells them, and the one value is validated by the same rule a typed date
  // is — a statement dated 2126 would pin the account until 2126
  // (`recordedDate` documents why). Two dates refuse the file naming both,
  // never picking one: a statement is a photograph of one day.
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
