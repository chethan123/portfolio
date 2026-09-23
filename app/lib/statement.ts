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
import { listSentence, recordedDate } from "./input.server.ts";

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
  // Multi-account scope (spec 0023): grouped per account number; sign and as-of left to the
  // router. Absent = single-account, as in every mapping saved before it.
  multiAccount?: boolean;
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
  multiAccount: z.boolean().optional(),
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
  accountNumber?: string | null; // multi-account mode only
  instrument: string;
  rowCount: number;
  quantity: string;
};

// An instrument whose quantity was an absence spelling (sweep line, subtotal) — skipped and
// reported rather than silently dropped.
export type SkippedRow = {
  row: number;
  instrument: string;
  accountNumber?: string; // multi-account mode, when the row states one: its account's own to list
};

// Multi-account mode: a row that would be a position but names no account. Kept out of
// positions; the router refuses the file listing these (spec 0023 decision 13).
export type UnnumberedRow = {
  row: number;
  instrument: string;
};

// Multi-account mode: the as-of cell as written, unvalidated. Left to the router, which knows
// which numbers are skipped and the account a disagreement names (spec 0023 decision 8).
export type AsOfSighting = {
  row: number;
  accountNumber: string;
  value: string;
};

// row is zero-based (null for a mapping fault); message speaks in one-based lines.
export type ParseProblem = {
  row: number | null;
  column: string | null;
  message: string;
  code?: "blank-instrument";
};

type StatementBody = {
  positions: ParsedPosition[];
  combined: CombinedRows[];
  skipped: SkippedRow[];
  asOfMapped: boolean; // false when the mapping names no as-of column
  problems: ParseProblem[]; // empty means usable; anything here refuses the commit
};

// The router's input (statement-routing.server.ts): sign, dates and blank numbers still unsettled.
export type MultiAccountStatement = StatementBody & {
  multiAccount: true;
  asOfDate: null;
  asOfSightings: AsOfSighting[];
  unnumbered: UnnumberedRow[];
};

export type ParsedStatement =
  | (StatementBody & {
      multiAccount?: never;
      asOfDate: string | null;
      asOfSightings?: never;
      unnumbered?: never;
    })
  | MultiAccountStatement;

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

// Zero keeps no sign: "-0.00" would read as a debt of nothing written as though it were something.
// The numerator (basis*quantity) flips with the quantity, or a later fold (uploads.server.ts)
// would report a liability's cost basis inverted.
export function negateOwed<Position extends Pick<FoldableLot, "quantity" | "weightedBasisUnits">>(
  position: Position,
): Position {
  const { quantity, weightedBasisUnits } = position;
  if (isZero(quantity)) return position;
  return {
    ...position,
    quantity: quantity.startsWith("-") ? quantity.slice(1) : `-${quantity}`,
    ...(weightedBasisUnits === undefined || weightedBasisUnits === null
      ? {}
      : { weightedBasisUnits: -weightedBasisUnits }),
  };
}

// ISO kept as written; US shapes (MM/DD/YYYY) rewritten to it. Only the spelling moves —
// "13/40/2026" becomes "2026-13-40" and is refused as not on the calendar downstream.
function isoAsOf(value: string): string {
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (us === null) return value;
  return `${us[3]}-${(us[1] ?? "").padStart(2, "0")}-${(us[2] ?? "").padStart(2, "0")}`;
}

// First sighting speaks; every other must agree once normalised by isoAsOf. Two disagreeing
// dates refuse naming both — a statement is a photograph of one day. `account` names whose rows
// these are in a multi-account file (spec 0023 decision 8).
export function resolveAsOf(
  sightings: ReadonlyArray<{ row: number; value: string }>,
  column: string | null,
  account?: string,
): { asOfDate: string | null; problem: ParseProblem | null } {
  const first = sightings[0];
  if (first === undefined) return { asOfDate: null, problem: null };
  const whose = account === undefined ? "" : ` for ${account}`;

  const differing = sightings.find(
    (sighting) => isoAsOf(sighting.value) !== isoAsOf(first.value),
  );
  if (differing !== undefined) {
    return {
      asOfDate: null,
      problem: {
        row: differing.row,
        column,
        message:
          `The file carries two as-of dates${whose} — "${first.value}" on line ` +
          `${first.row + 1} and "${differing.value}" on line ${differing.row + 1} — ` +
          "and a statement is a photograph of one day.",
      },
    };
  }

  const parsed = recordedDate(`The as-of date${whose}`).safeParse(isoAsOf(first.value));
  if (parsed.success) return { asOfDate: parsed.data, problem: null };
  return {
    asOfDate: null,
    problem: {
      row: first.row,
      column,
      message: parsed.error.issues[0]?.message ?? `The as-of date${whose} could not be read.`,
    },
  };
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
// preamble; blank-instrument rows are ignored only when mapped quantity and cost basis cells
// are absent; an absent-quantity row is skipped and reported; a nonsense or over-precise
// quantity/basis refuses the file naming the row, never rounds; duplicate instrument rows
// combine (summed, quantity-weighted) when the mapping allows it, else refuse — a position
// set holds one row per instrument.
export function parseStatement(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  mapping: StatementMapping,
): ParsedStatement {
  const problems: ParseProblem[] = [];
  const { columns } = mapping;
  const asOfMapped = typeof columns.asOf === "string" && columns.asOf !== "";
  const multiAccount = mapping.multiAccount === true;

  const refused = (): ParsedStatement => {
    const body = { positions: [], combined: [], skipped: [], asOfDate: null, asOfMapped, problems };
    return multiAccount ? { ...body, multiAccount, asOfSightings: [], unnumbered: [] } : body;
  };

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
  if (multiAccount && !columns.accountNumber) {
    problems.push({
      row: null,
      column: null,
      message:
        "The mapping names no account number column, and a file of several accounts " +
        "routes every row by one.",
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
  const accountAsOfSightings: AsOfSighting[] = [];
  const unnumbered: UnnumberedRow[] = [];

  const optionalCell = (cells: ReadonlyArray<string>, index: number | null): string | null => {
    const value = index === null ? "" : (cells[index] ?? "").trim();
    return value === "" ? null : value;
  };

  for (let row = mapping.headerRow + 1; row < rows.length; row++) {
    const cells = rows[row] ?? [];
    const instrument = cells[instrumentIndex] ?? "";
    const line = row + 1;

    if (instrument.trim() === "") {
      // The shared absence grammar keeps spacers and broker footers harmless. Zero and malformed
      // figures still speak: either could be a position that would otherwise become a removal.
      const populated = [
        { index: quantityIndex, name: columns.quantity },
        { index: costBasisIndex, name: columns.costBasis },
      ].flatMap(({ index, name }) =>
        index !== null &&
        typeof name === "string" &&
        normaliseFigure(cells[index] ?? "").kind !== "absent"
          ? [name]
          : [],
      );

      if (populated.length > 0) {
        const named = populated.map((name) => `"${name}"`);
        const cellsNamed = listSentence(named);
        problems.push({
          row,
          column: columns.instrument,
          code: "blank-instrument",
          message:
            `Line ${line} has a blank instrument, but its mapped ${cellsNamed} ` +
            `${named.length === 1 ? "cell has" : "cells have"} content. ` +
            "Choose the correct instrument column. If the instrument is missing from the " +
            "source row, fix the source file and start a new upload.",
        });
      }
      continue;
    }

    const quantityCell = (cells[quantityIndex] ?? "").trim();
    const quantity = normaliseFigure(quantityCell);

    if (quantity.kind === "absent") {
      const accountNumber = multiAccount ? optionalCell(cells, accountNumberIndex) : null;
      skipped.push(
        accountNumber === null ? { row, instrument } : { row, instrument, accountNumber },
      );
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

    // Number trimmed only, never case- or zero-folded (spec 0023 decision 15).
    const accountNumber = optionalCell(cells, accountNumberIndex);
    const asOf = optionalCell(cells, asOfIndex);

    if (multiAccount) {
      if (accountNumber === null) {
        unnumbered.push({ row, instrument });
        continue;
      }
      if (asOf !== null) accountAsOfSightings.push({ row, accountNumber, value: asOf });
    } else if (asOf !== null) {
      asOfSightings.push({ row, value: asOf });
    }

    records.push({
      row,
      instrument,
      name: optionalCell(cells, nameIndex),
      accountNumber,
      quantity: quantity.value,
      costBasisPerShare,
    });
  }

  // Grouped by raw string before alias resolution — combining now would guess what step 04 decides.
  // Multi-account: by (number, string), so one instrument in two accounts stays two positions.
  const groups = new Map<string, RowRecord[]>();
  for (const record of records) {
    const key = multiAccount
      ? JSON.stringify([record.accountNumber, record.instrument])
      : record.instrument;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [record]);
    else group.push(record);
  }

  // Multi-account: sign is the router's, by the kind of the account each row lands in (decision 6).
  const signed = (position: ParsedPosition): ParsedPosition =>
    mapping.owedAsPositive && !multiAccount ? negateOwed(position) : position;

  const positions: ParsedPosition[] = [];
  const combined: CombinedRows[] = [];

  for (const group of groups.values()) {
    const first = group[0];
    if (first === undefined) continue;
    const { instrument } = first;

    if (group.length === 1) {
      positions.push(
        signed({
          row: first.row,
          instrument,
          name: first.name,
          accountNumber: first.accountNumber,
          quantity: first.quantity,
          costBasisPerShare: first.costBasisPerShare,
        }),
      );
      continue;
    }

    if (!mapping.combineDuplicateRows) {
      const where = multiAccount ? ` for account "${first.accountNumber}"` : "";
      problems.push({
        row: group[1]?.row ?? first.row,
        column: columns.instrument,
        message:
          `"${instrument.trim()}" appears on ${group.length} lines${where}, and with combining ` +
          "turned off a statement cannot hold the same instrument twice.",
      });
      continue;
    }

    const fold = foldLots(group);
    const position = signed({
      row: first.row,
      instrument,
      name: first.name,
      accountNumber: first.accountNumber,
      quantity: fold.quantity,
      costBasisPerShare: fold.costBasisPerShare,
      weightedBasisUnits: fold.weightedBasisUnits,
    });

    positions.push(position);
    combined.push({
      ...(multiAccount ? { accountNumber: first.accountNumber } : {}),
      instrument,
      rowCount: group.length,
      quantity: position.quantity,
    });
  }

  if (multiAccount) {
    return {
      positions,
      combined,
      skipped,
      asOfDate: null,
      asOfMapped,
      problems,
      multiAccount,
      asOfSightings: accountAsOfSightings,
      unnumbered,
    };
  }

  const { asOfDate, problem } = resolveAsOf(asOfSightings, columns.asOf ?? null);
  if (problem !== null) problems.push(problem);

  return { positions, combined, skipped, asOfDate, asOfMapped, problems };
}
