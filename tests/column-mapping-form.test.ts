// Columns screen's form contract (parseMappingForm, DESIGN.md §5.3, spec 0004 step 03). Pure.
// Three silent-failure risks pinned: a liability's sign (§14.8 overdraft case), cost-basis
// scale (per_share/total flip), and what the mapping is checked against (hidden header-row
// field must refuse if stale/forged). superRefine keeps refusals as one set of messages.
import { describe, expect, it } from "vitest";

import { NOT_IN_FILE, parseMappingForm } from "~/lib/column-mapping.server";
import { FORM_ERROR, ValidationError } from "~/lib/input.server";

import type { Delimiter } from "~/lib/csv";

/** File shaped like a real export: two preamble rows, header row 2 is the ordinary case.
 * Quantities/money are decimal strings (§4.1) — nothing here may reach a float. */
const ROWS: ReadonlyArray<ReadonlyArray<string>> = [
  ["Positions as of 30 Jun 2026"],
  [],
  ["Symbol", "Description", "Quantity", "Average Cost Basis", "As of", "Account"],
  ["VTI", "Vanguard Total Stock Market ETF", "100.5", "241.1875", "2026-06-30", "Z12-345678"],
];

/** A submission with every select answered and nothing wrong with it. */
const WELL_FORMED: Readonly<Record<string, string>> = {
  headerRow: "2",
  instrument: "Symbol",
  quantity: "Quantity",
  name: "Description",
  costBasis: "Average Cost Basis",
  asOf: "As of",
  accountNumber: "Account",
  costBasisIs: "per_share",
  owedAsPositive: "true",
};

/** Well-formed post with fields changed or removed. undefined removes — "never arrived" is
 * distinct from "arrived blank", both real post shapes. */
function submission(overrides: Readonly<Record<string, string | undefined>> = {}) {
  const fields: Record<string, string> = { ...WELL_FORMED };

  for (const [field, value] of Object.entries(overrides)) {
    if (value === undefined) delete fields[field];
    else fields[field] = value;
  }

  return fields;
}

/** The messages a refusal carried, keyed by field, or a failure if it passed. */
function refusalOf(run: () => unknown): Record<string, string> {
  try {
    run();
  } catch (error) {
    if (error instanceof ValidationError) return { ...error.fieldErrors };
    throw error;
  }
  throw new Error("Expected the mapping form to be refused, and it was not.");
}

describe("a mapping assembled from a well-formed submission", () => {
  it("names all six columns, the header row and the two flags", () => {
    const mapping = parseMappingForm(submission(), ROWS, ",");

    expect(mapping).toEqual({
      headerRow: 2,
      delimiter: ",",
      columns: {
        instrument: "Symbol",
        quantity: "Quantity",
        name: "Description",
        costBasis: "Average Cost Basis",
        asOf: "As of",
        accountNumber: "Account",
      },
      costBasisIs: "per_share",
      owedAsPositive: true,
      // Not a screen control — combining is the lot-level story's promise, true for every mapping.
      combineDuplicateRows: true,
    });
  });

  it.each<Delimiter>([",", ";", "\t"])(
    "records the delimiter the rows were read with (%j), never re-sniffing it later",
    (delimiter) => {
      expect(parseMappingForm(submission(), ROWS, delimiter).delimiter).toBe(delimiter);
    },
  );
});

describe("the owed-as-positive box, where a liability's sign is decided", () => {
  it("keeps the file's own sign when the box is unticked and posts nothing at all", () => {
    // Overdraft case (§14.8): an export already negative must not be negated twice. Absence
    // is all an unticked checkbox sends, so it reads as false.
    const mapping = parseMappingForm(submission({ owedAsPositive: undefined }), ROWS, ",");

    expect(mapping.owedAsPositive).toBe(false);
  });

  it("negates the file when the box is ticked and posts the value the markup gives it", () => {
    const mapping = parseMappingForm(submission({ owedAsPositive: "true" }), ROWS, ",");

    expect(mapping.owedAsPositive).toBe(true);
  });

  it.each(["", "on", "false", "TRUE", "1"])(
    "reads %j as unticked, because only the box's own value counts as ticked",
    (posted) => {
      // "on" matters most: what a browser posts for a checkbox with no value — catches
      // the markup losing value="true".
      const mapping = parseMappingForm(submission({ owedAsPositive: posted }), ROWS, ",");

      expect(mapping.owedAsPositive).toBe(false);
    },
  );
});

describe("what the cost basis column states", () => {
  it.each([
    ["total", "total"],
    ["per_share", "per_share"],
  ])("carries a %j answer through to the mapping unchanged", (posted, recorded) => {
    const mapping = parseMappingForm(submission({ costBasisIs: posted }), ROWS, ",");

    expect(mapping.costBasisIs).toBe(recorded);
  });

  it.each([
    ["absent from the post", undefined],
    ["left blank", ""],
    ["a value no radio can produce", "Total"],
  ])("refuses a cost basis answer that is %s, rather than guessing per-share", (_case, posted) => {
    // Guessing per_share would rescale every basis by position size and still print
    // a plausible number.
    const refusal = refusalOf(() =>
      parseMappingForm(submission({ costBasisIs: posted }), ROWS, ","),
    );

    expect(refusal.costBasisIs).toBe(
      "Choose whether the cost basis column states one share's cost or the position's.",
    );
  });
});

describe("the two columns a statement cannot be read without", () => {
  it.each([
    ["instrument", "instrument", undefined],
    ["instrument", "instrument", ""],
    ["instrument", "instrument", NOT_IN_FILE],
    ["quantity", "quantity", undefined],
    ["quantity", "quantity", ""],
    ["quantity", "quantity", NOT_IN_FILE],
  ])(
    "refuses under the %s select when it is %j, wherever the unchosen answer came from",
    (field, label, posted) => {
      // Absent, placeholder and "not in this file" are three different answers
      // to an optional column and the same answer to a required one.
      const refusal = refusalOf(() => parseMappingForm(submission({ [field]: posted }), ROWS, ","));

      expect(refusal[field]).toBe(
        `Choose the column that holds the ${label} — a statement is nothing without one.`,
      );
    },
  );

  it("returns three messages for a submission with three faults, not one per round trip", () => {
    // One superRefine: a reader who missed three controls fixes all three in one round trip.
    const refusal = refusalOf(() =>
      parseMappingForm(
        submission({ instrument: undefined, quantity: NOT_IN_FILE, costBasisIs: undefined }),
        ROWS,
        ",",
      ),
    );

    expect(Object.keys(refusal).sort()).toEqual(["costBasisIs", "instrument", "quantity"]);
  });
});

describe("the four columns a statement can do without", () => {
  it.each([
    ["absent from the post", undefined],
    ["left on the unchosen placeholder", ""],
    ["marked as deliberately not in this file", NOT_IN_FILE],
  ])("records %s as null, never as an empty string", (_case, posted) => {
    // Empty string would mean "names a column that isn't there" to parseStatement; null means absent.
    const mapping = parseMappingForm(
      submission({ name: posted, costBasis: posted, asOf: posted, accountNumber: posted }),
      ROWS,
      ",",
    );

    expect(mapping.columns).toEqual({
      instrument: "Symbol",
      quantity: "Quantity",
      name: null,
      costBasis: null,
      asOf: null,
      accountNumber: null,
    });
  });
});

describe("a column that the file's header does not have", () => {
  it.each([
    ["instrument", "Ticker"],
    ["asOf", "Trade Date"],
  ])("refuses under the %s select, quoting what was posted", (field, posted) => {
    // Options are header cells verbatim — a value outside them is forged, not a keyboard slip.
    const refusal = refusalOf(() => parseMappingForm(submission({ [field]: posted }), ROWS, ","));

    expect(refusal[field]).toBe(`"${posted}" is not a column of this file's header row.`);
  });
});

describe("one column claimed by two fields", () => {
  it("refuses the later field, naming the field that already holds the column", () => {
    const refusal = refusalOf(() =>
      parseMappingForm(submission({ quantity: "Symbol" }), ROWS, ","),
    );

    expect(refusal.quantity).toBe(
      '"Symbol" is already mapped to Instrument, and one column cannot also be the quantity.',
    );
    // Only the later field is refused — first claim stands, reader fixes one select, not both.
    expect(Object.keys(refusal)).toEqual(["quantity"]);
  });

  it("treats two header cells differing only in padding as the same column", () => {
    // Trim-compared, matching parseStatement — same cell read by two fields, though
    // posted strings differ.
    const padded: ReadonlyArray<ReadonlyArray<string>> = [["Symbol", " Symbol ", "Quantity"]];

    const refusal = refusalOf(() =>
      parseMappingForm(
        { headerRow: "0", instrument: "Symbol", quantity: " Symbol ", costBasisIs: "per_share" },
        padded,
        ",",
      ),
    );

    expect(refusal.quantity).toBe(
      '"Symbol" is already mapped to Instrument, and one column cannot also be the quantity.',
    );
  });
});

describe("the hidden header row", () => {
  it.each([
    ["absent from the post", undefined],
    ["blank", ""],
    ["not a number at all", "two"],
    ["negative", "-1"],
    ["past the last row of the file", "9"],
  ])(
    "refuses a header row that is %s at form level, never against a row that is not there",
    (_case, posted) => {
      // No control to hang a field message under — a mapping built against an undefined
      // header would pass every column check by accident.
      const refusal = refusalOf(() =>
        parseMappingForm(submission({ headerRow: posted }), ROWS, ","),
      );

      expect(Object.keys(refusal)).toEqual([FORM_ERROR]);
      expect(refusal[FORM_ERROR]).toMatch(/is not in the file/);
      expect(refusal[FORM_ERROR]).toMatch(/Re-read the file and choose the columns again/);
    },
  );
});
