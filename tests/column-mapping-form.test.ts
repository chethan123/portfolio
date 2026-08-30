/**
 * The columns screen's form contract (`parseMappingForm`, DESIGN.md §5.3,
 * spec 0004 step 03). Pure — every risk is a decision made out of posted
 * strings, and three are silent when wrong: **the sign of every imported
 * liability** (a checkbox posts its value or nothing; absence read as
 * "ticked" would negate every quantity in a bank export — §14.8's overdraft
 * case), **the scale of every cost basis** (a per_share/total flip does not
 * fail — it rescales the file and prints a plausible wrong number), and
 * **what the mapping is checked against** (the header row rides in a hidden
 * field; a stale or forged one must refuse at form level). Refusals are
 * checked as a set: the single `superRefine` exists so three faults come
 * back as three messages.
 */
import { describe, expect, it } from "vitest";

import { NOT_IN_FILE, parseMappingForm } from "~/lib/column-mapping.server";
import { FORM_ERROR, ValidationError } from "~/lib/input.server";

import type { Delimiter } from "~/lib/csv";

/**
 * A file shaped the way brokerages actually export: two preamble rows above
 * the header, so a header row of 2 is the ordinary case rather than the edge.
 * Quantities and money are decimal strings here for the reason they are
 * everywhere else (§4.1) — nothing in this slice may reach a float.
 */
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

/**
 * The well-formed post with fields changed or removed. `undefined` removes,
 * because "the field never arrived" is a distinct answer from "the field
 * arrived blank" and both are things a real post does.
 */
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
      // Not a control on the screen: combining is what the lot-level story
      // promises, so it is true for every mapping this form can produce.
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
    // The overdraft case (§14.8): a bank export that already writes an
    // overdraft negative must not be negated a second time. Absence is the
    // only thing an unticked checkbox sends, so absence has to read as false.
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
      // "on" is the one that matters: it is what a browser posts for a
      // checkbox with no `value`, so if the markup ever loses `value="true"`
      // this rule is what keeps a ticked box from silently reading as unticked.
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
    // The guess is the whole danger: the two readings differ by the position
    // size, so an assumed `per_share` would rescale every basis in the file
    // and still print a plausible number. The radio must be answered.
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
    // The reason every check lives in one `superRefine`: a reader who missed
    // three controls fixes all three before submitting again.
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
    // An empty string here would be `parseStatement`'s "names a column that is
    // not there"; null is what the schema already means by absent.
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
    // The options are the header cells verbatim, so a value outside them is a
    // forged post rather than a slip a reader could make at the keyboard.
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
    // Only the later field is refused: the first claim on a column stands, so
    // the reader is asked to fix one select rather than both.
    expect(Object.keys(refusal)).toEqual(["quantity"]);
  });

  it("treats two header cells differing only in padding as the same column", () => {
    // Trim-compared, matching how `parseStatement` finds a column. Mapping
    // both would be two fields reading one cell, which is the duplicate this
    // refusal exists for even though the posted strings are not equal.
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
      // No reader typed this field, so there is no control to hang the message
      // under — and a mapping built against an undefined header would pass
      // every column check by accident.
      const refusal = refusalOf(() =>
        parseMappingForm(submission({ headerRow: posted }), ROWS, ","),
      );

      expect(Object.keys(refusal)).toEqual([FORM_ERROR]);
      expect(refusal[FORM_ERROR]).toMatch(/is not in the file/);
      expect(refusal[FORM_ERROR]).toMatch(/Re-read the file and choose the columns again/);
    },
  );
});
