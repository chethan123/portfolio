/**
 * Applying a mapping to a file's rows (spec 0004, step 02).
 *
 * Two kinds of test share this file. The fixture tests run whole
 * brokerage-shaped exports through `readCsv` and `parseStatement` together,
 * because the point of a pure parser is that a real institution's file is a
 * test rather than a surprise. The inline tests pin each rule of the contract
 * one row at a time — every refusal, every skip, every scale.
 *
 * Every money and quantity assertion is an exact decimal string, for the
 * reason `money.test.ts` gives: the module exists so no figure passes through
 * a float, and a tolerant assertion would not notice if one did.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { readCsv } from "~/lib/csv";
import { parseStatement, type StatementMapping } from "~/lib/statement";

const fixture = (name: string): Uint8Array =>
  readFileSync(fileURLToPath(new URL(`./fixtures/statements/${name}`, import.meta.url)));

/** A mapping with the flags at their commonest values, columns always stated. */
const mapping = (
  over: Partial<StatementMapping> & { columns: StatementMapping["columns"] },
): StatementMapping => ({
  headerRow: 0,
  delimiter: ",",
  costBasisIs: "per_share",
  owedAsPositive: false,
  combineDuplicateRows: true,
  ...over,
});

describe("parseStatement on the fixtures", () => {
  it("reads the Fidelity-shaped export past its preamble and footer", () => {
    const { rows } = readCsv(fixture("fidelity.csv"));
    const parsed = parseStatement(
      rows,
      mapping({
        headerRow: 2,
        columns: {
          instrument: "Symbol",
          name: "Description",
          quantity: "Quantity",
          costBasis: "Average Cost Basis",
          accountNumber: "Account Number",
        },
      }),
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.positions).toHaveLength(4);
    // The footer disclaimers — including the quoted sentence full of commas —
    // never reach the positions, and are not worth reporting either: their
    // rows carry nothing under the symbol column.
    expect(parsed.skipped).toEqual([]);

    const aapl = parsed.positions[0];
    expect(aapl?.instrument).toBe("AAPL");
    expect(aapl?.name).toBe("APPLE INC COM USD0.00001");
    expect(aapl?.quantity).toBe("50.000");
    expect(aapl?.costBasisPerShare).toBe("170.6600");
    expect(aapl?.accountNumber).toBe("Z12-345678");

    // A quoted quantity with a thousands separator, and an `n/a` basis that
    // lands as null — never zero, which would report the cash as free money.
    const spaxx = parsed.positions[3];
    expect(spaxx?.quantity).toBe("2450.10");
    expect(spaxx?.costBasisPerShare).toBeNull();

    expect(parsed.asOfMapped).toBe(false);
    expect(parsed.asOfDate).toBeNull();
  });

  it("reads the Schwab-shaped export, dividing its total cost basis per share", () => {
    const { rows } = readCsv(fixture("schwab.csv"));
    const parsed = parseStatement(
      rows,
      mapping({
        headerRow: 2,
        costBasisIs: "total",
        columns: {
          instrument: "Symbol",
          name: "Description",
          quantity: "Qty (Quantity)",
          costBasis: "Cost Basis",
        },
      }),
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.positions).toHaveLength(3);

    // $8,533.00 over 50 shares.
    expect(parsed.positions[0]?.costBasisPerShare).toBe("170.6600");
    // $9,875.50 over 25.
    expect(parsed.positions[1]?.costBasisPerShare).toBe("395.0200");
    // A short position: the parenthesised total over the negative quantity is
    // the positive per-share fact a price is — the sign stays in the quantity.
    expect(parsed.positions[2]?.quantity).toBe("-10");
    expect(parsed.positions[2]?.costBasisPerShare).toBe("26.5000");

    // The cash and total lines name something but state no quantity: skipped,
    // and reported so the review screen can say so rather than staying silent.
    expect(parsed.skipped).toEqual([
      { row: 6, instrument: "Cash & Cash Investments" },
      { row: 7, instrument: "Account Total" },
    ]);
  });

  it("reads the 401k export with no basis column and a holding with no ticker", () => {
    const { rows } = readCsv(fixture("401k.csv"));
    const parsed = parseStatement(
      rows,
      mapping({
        columns: { instrument: "Investment", quantity: "Units", asOf: "As Of" },
      }),
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.positions).toHaveLength(3);
    // No cost basis column mapped at all: null for every row, which Holdings'
    // three separate coverages already report honestly (§8.2).
    for (const position of parsed.positions) {
      expect(position.costBasisPerShare).toBeNull();
    }
    // The collective trusts have no ticker; the fund name is the instrument
    // string that resolution will see.
    expect(parsed.positions[0]?.instrument).toBe("Vanguard Target Retirement 2045 Trust II");
    expect(parsed.positions[0]?.quantity).toBe("412.51230000");

    expect(parsed.asOfMapped).toBe(true);
    expect(parsed.asOfDate).toBe("2026-07-31");
  });

  it("combines the lot-level export's three rows for one fund, and says so", () => {
    const { rows } = readCsv(fixture("lot-level.csv"));
    const parsed = parseStatement(
      rows,
      mapping({
        columns: {
          instrument: "Symbol",
          name: "Description",
          quantity: "Quantity",
          costBasis: "Cost Basis Per Share",
        },
      }),
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.positions).toHaveLength(2);

    // 100 + 200 + 112.5 lots, basis weighted by quantity at the columns'
    // scales: (100×95.10 + 200×110.25 + 112.5×123.40) / 412.5 = 110.16363…,
    // rounded half away from zero at numeric(20, 4).
    const vtsax = parsed.positions[0];
    expect(vtsax?.quantity).toBe("412.50000000");
    expect(vtsax?.costBasisPerShare).toBe("110.1636");
    expect(vtsax?.row).toBe(1);

    // The single-lot fund passes through untouched, at the file's own scale.
    expect(parsed.positions[1]?.quantity).toBe("50.0000");
    expect(parsed.positions[1]?.costBasisPerShare).toBe("72.8000");

    // Reported for the review screen to print as its own line, not a count.
    expect(parsed.combined).toEqual([
      { instrument: "VTSAX", rowCount: 3, quantity: "412.50000000" },
    ]);
  });

  it("refuses the lot-level export when combining is turned off", () => {
    const { rows } = readCsv(fixture("lot-level.csv"));
    const parsed = parseStatement(
      rows,
      mapping({
        combineDuplicateRows: false,
        columns: { instrument: "Symbol", quantity: "Quantity" },
      }),
    );

    // A position set holds one row per instrument, so the duplicate cannot
    // pass through silently — it is named, with the row it recurs on.
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]?.message).toMatch(/"VTSAX" appears on 3 lines/);
    expect(parsed.problems[0]?.row).toBe(2);
    expect(parsed.problems[0]?.column).toBe("Symbol");
  });

  it("records the liability statement's positive balance as a debt", () => {
    const { rows } = readCsv(fixture("liability.csv"));
    const parsed = parseStatement(
      rows,
      mapping({
        headerRow: 2,
        owedAsPositive: true,
        columns: {
          instrument: "Description",
          quantity: "Principal Balance",
          asOf: "As Of",
          accountNumber: "Account Number",
        },
      }),
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.positions).toHaveLength(1);

    // The file says 14,500.00 owed; §2 puts the sign in the quantity, and the
    // mapping's checkbox is where the direction was decided.
    const loan = parsed.positions[0];
    expect(loan?.instrument).toBe("Auto Loan 60 months");
    expect(loan?.quantity).toBe("-14500.00");
    expect(loan?.accountNumber).toBe("4400-7788-1234");
    expect(parsed.asOfDate).toBe("2026-07-31");
  });

  it("reads the semicolon-delimited CRLF file like any other", () => {
    const { rows, delimiter } = readCsv(fixture("semicolon.csv"));
    expect(delimiter).toBe(";");

    const parsed = parseStatement(
      rows,
      mapping({
        headerRow: 1,
        delimiter,
        columns: { instrument: "ISIN", name: "Naam", quantity: "Aantal" },
      }),
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.positions).toHaveLength(2);
    expect(parsed.positions[0]?.instrument).toBe("IE00B4L5Y983");
    expect(parsed.positions[0]?.quantity).toBe("120.5");
  });
});

describe("the mapping itself", () => {
  const rows = [
    ["Symbol", "Qty", "Basis"],
    ["AAPL", "50", "170.66"],
  ];

  it("refuses a mapping missing the instrument or quantity column", () => {
    const missingInstrument = parseStatement(
      rows,
      mapping({ columns: { instrument: "", quantity: "Qty" } }),
    );
    expect(missingInstrument.positions).toEqual([]);
    expect(missingInstrument.problems[0]?.message).toMatch(/names no instrument column/);

    const missingQuantity = parseStatement(
      rows,
      mapping({ columns: { instrument: "Symbol", quantity: "" } }),
    );
    expect(missingQuantity.problems[0]?.message).toMatch(/names no quantity column/);
  });

  it("refuses a header row the file does not have", () => {
    const parsed = parseStatement(
      rows,
      mapping({ headerRow: 9, columns: { instrument: "Symbol", quantity: "Qty" } }),
    );

    expect(parsed.positions).toEqual([]);
    expect(parsed.problems[0]?.message).toMatch(/header row 10/);
    expect(parsed.problems[0]?.message).toMatch(/only 2 rows/);
  });

  it("refuses a mapped column the header no longer carries, naming it", () => {
    const parsed = parseStatement(
      rows,
      mapping({
        columns: { instrument: "Symbol", quantity: "Qty", costBasis: "Average Cost" },
      }),
    );

    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]?.column).toBe("Average Cost");
    expect(parsed.problems[0]?.message).toMatch(/no "Average Cost" column/);
  });
});

describe("row handling", () => {
  const columns = { instrument: "Symbol", quantity: "Qty" };

  it("skips a row whose instrument cell is empty, as a footer or spacer", () => {
    const parsed = parseStatement(
      [["Symbol", "Qty"], ["AAPL", "50"], ["", "1"], ["   ", "2"], [""]],
      mapping({ columns }),
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.positions).toHaveLength(1);
    // Not reported either: a spacer names nothing worth telling the reader.
    expect(parsed.skipped).toEqual([]);
  });

  it("skips and reports a row that names an instrument but states no quantity", () => {
    const parsed = parseStatement(
      [
        ["Symbol", "Qty"],
        ["AAPL", "50"],
        ["Cash & Cash Investments", "--"],
      ],
      mapping({ columns }),
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.positions).toHaveLength(1);
    expect(parsed.skipped).toEqual([{ row: 2, instrument: "Cash & Cash Investments" }]);
  });

  it("refuses a row with an instrument and an unparseable quantity, naming the row", () => {
    // A disclaimer line that happens to sit under the symbol column must not
    // become a position — and must not vanish either.
    const parsed = parseStatement(
      [
        ["Symbol", "Qty"],
        ["AAPL", "50"],
        ["All investments involve risk", "see disclosures"],
      ],
      mapping({ columns }),
    );

    expect(parsed.positions).toHaveLength(1);
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]).toMatchObject({ row: 2, column: "Qty" });
    expect(parsed.problems[0]?.message).toMatch(/Line 3/);
    expect(parsed.problems[0]?.message).toMatch(/"see disclosures", which is not a number/);
  });

  it("collects every problem rather than stopping at the first", () => {
    const parsed = parseStatement(
      [
        ["Symbol", "Qty"],
        ["AAPL", "fifty"],
        ["MSFT", "twenty"],
      ],
      mapping({ columns }),
    );

    expect(parsed.problems).toHaveLength(2);
    expect(parsed.problems.map((problem) => problem.row)).toEqual([1, 2]);
  });

  it("refuses a quantity finer than eight decimal places rather than rounding it", () => {
    const parsed = parseStatement(
      [
        ["Symbol", "Qty"],
        ["VTSAX", "1.123456789"],
      ],
      mapping({ columns }),
    );

    expect(parsed.positions).toEqual([]);
    expect(parsed.problems[0]?.message).toMatch(/9 decimal places/);
    expect(parsed.problems[0]?.message).toMatch(/refused rather than rounded/);
  });

  it("refuses a quantity larger than the column can store", () => {
    const parsed = parseStatement(
      [
        ["Symbol", "Qty"],
        ["VTSAX", "1234567890123"],
      ],
      mapping({ columns }),
    );

    expect(parsed.problems[0]?.message).toMatch(/larger than this application can store/);
  });
});

describe("cost basis", () => {
  const columns = { instrument: "Symbol", quantity: "Qty", costBasis: "Basis" };

  it("passes a per-share basis through unchanged", () => {
    const parsed = parseStatement(
      [
        ["Symbol", "Qty", "Basis"],
        ["VTI", "120.000", "$205.1200"],
      ],
      mapping({ columns }),
    );

    expect(parsed.positions[0]?.costBasisPerShare).toBe("205.1200");
  });

  it("divides a total basis by the quantity at the money scale", () => {
    const parsed = parseStatement(
      [
        ["Symbol", "Qty", "Basis"],
        ["BND", "3", "100.00"],
      ],
      mapping({ columns, costBasisIs: "total" }),
    );

    // 100 / 3 at numeric(20, 4): rounded half away from zero, never floated.
    expect(parsed.positions[0]?.costBasisPerShare).toBe("33.3333");
  });

  it("yields a null basis for a total over a zero quantity, not a division fault", () => {
    const parsed = parseStatement(
      [
        ["Symbol", "Qty", "Basis"],
        ["GONE", "0", "1234.00"],
      ],
      mapping({ columns, costBasisIs: "total" }),
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.positions[0]?.quantity).toBe("0");
    expect(parsed.positions[0]?.costBasisPerShare).toBeNull();
  });

  it("keeps an absent basis null, never zero", () => {
    const parsed = parseStatement(
      [
        ["Symbol", "Qty", "Basis"],
        ["SPAXX", "2450.10", "n/a"],
      ],
      mapping({ columns }),
    );

    expect(parsed.positions[0]?.costBasisPerShare).toBeNull();
  });

  it("refuses a basis finer than four decimal places rather than rounding it", () => {
    const parsed = parseStatement(
      [
        ["Symbol", "Qty", "Basis"],
        ["VTI", "1", "10.12345"],
      ],
      mapping({ columns }),
    );

    expect(parsed.positions).toEqual([]);
    expect(parsed.problems[0]?.message).toMatch(/5 decimal places/);
    expect(parsed.problems[0]?.message).toMatch(/refused rather than rounded/);
  });

  it("refuses a basis that is neither a number nor blank, naming the row", () => {
    const parsed = parseStatement(
      [
        ["Symbol", "Qty", "Basis"],
        ["VTI", "1", "call us"],
      ],
      mapping({ columns }),
    );

    expect(parsed.problems[0]).toMatchObject({ row: 1, column: "Basis" });
    expect(parsed.problems[0]?.message).toMatch(/"call us"/);
  });
});

describe("owedAsPositive", () => {
  const columns = { instrument: "Description", quantity: "Balance" };
  const rows = [
    ["Description", "Balance"],
    ["Auto loan", "14,500.00"],
    ["Paid-off loan", "0.00"],
    ["Overpayment credit", "-25.00"],
  ];

  it("negates every non-zero quantity when set, and zero keeps no sign", () => {
    const parsed = parseStatement(rows, mapping({ columns, owedAsPositive: true }));

    expect(parsed.positions.map((position) => position.quantity)).toEqual([
      "-14500.00",
      // "−0.00" is a debt of nothing written as though it were something.
      "0.00",
      // Negation, not "make negative": a credit on a loan statement counts
      // for the household.
      "25.00",
    ]);
  });

  it("preserves the file's own sign when unset, an overdraft included", () => {
    const parsed = parseStatement(rows, mapping({ columns, owedAsPositive: false }));

    expect(parsed.positions.map((position) => position.quantity)).toEqual([
      "14500.00",
      "0.00",
      "-25.00",
    ]);
  });
});

describe("duplicate rows", () => {
  const columns = { instrument: "Symbol", quantity: "Qty", costBasis: "Basis" };

  it("combines on the raw string as written, so two spellings stay two entries", () => {
    // Resolution in step 04 is byte-exact against the alias table; combining
    // across spellings here would guess what resolution decides.
    const parsed = parseStatement(
      [
        ["Symbol", "Qty", "Basis"],
        ["VTSAX", "1", ""],
        ["vtsax", "2", ""],
      ],
      mapping({ columns }),
    );

    expect(parsed.positions).toHaveLength(2);
    expect(parsed.combined).toEqual([]);
  });

  it("keeps a null basis for lots that combine to a zero quantity", () => {
    const parsed = parseStatement(
      [
        ["Symbol", "Qty", "Basis"],
        ["XYZ", "10", "5.00"],
        ["XYZ", "-10", "5.00"],
      ],
      mapping({ columns }),
    );

    expect(parsed.problems).toEqual([]);
    // Stored as zero, so the row stays addressable — not dropped.
    expect(parsed.positions[0]?.quantity).toBe("0.00000000");
    expect(parsed.positions[0]?.costBasisPerShare).toBeNull();
    expect(parsed.combined).toEqual([{ instrument: "XYZ", rowCount: 2, quantity: "0.00000000" }]);
  });

  it("keeps a null basis when any combined lot's own basis is unknown", () => {
    // A blended figure over a gap would be fake precision — the same reason
    // `sumMoney` counts its nulls instead of zeroing them.
    const parsed = parseStatement(
      [
        ["Symbol", "Qty", "Basis"],
        ["XYZ", "10", "5.00"],
        ["XYZ", "10", "n/a"],
      ],
      mapping({ columns }),
    );

    expect(parsed.positions[0]?.quantity).toBe("20.00000000");
    expect(parsed.positions[0]?.costBasisPerShare).toBeNull();
  });
});

describe("the as-of date", () => {
  const columns = { instrument: "Symbol", quantity: "Qty", asOf: "As Of" };

  it("reads the date from the first row carrying one", () => {
    const parsed = parseStatement(
      [
        ["Symbol", "Qty", "As Of"],
        ["AAPL", "50", "2026-07-31"],
        ["MSFT", "25", "2026-07-31"],
      ],
      mapping({ columns }),
    );

    expect(parsed.asOfMapped).toBe(true);
    expect(parsed.asOfDate).toBe("2026-07-31");
    expect(parsed.problems).toEqual([]);
  });

  it("refuses two differing as-of dates, naming both — never picking one", () => {
    const parsed = parseStatement(
      [
        ["Symbol", "Qty", "As Of"],
        ["AAPL", "50", "2026-07-31"],
        ["MSFT", "25", "2026-06-30"],
      ],
      mapping({ columns }),
    );

    expect(parsed.asOfDate).toBeNull();
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]?.message).toMatch(/"2026-07-31" on line 2/);
    expect(parsed.problems[0]?.message).toMatch(/"2026-06-30" on line 3/);
  });

  it("validates the date by the same rule a typed one faces", () => {
    // `recordedDate`'s rules, unchanged: the spelling, the calendar, and the
    // future — a statement dated 2126 would pin the account until 2126.
    const spelled = parseStatement(
      [
        ["Symbol", "Qty", "As Of"],
        ["AAPL", "50", "07/31/2026"],
      ],
      mapping({ columns }),
    );
    expect(spelled.asOfDate).toBeNull();
    expect(spelled.problems[0]).toMatchObject({ row: 1, column: "As Of" });
    expect(spelled.problems[0]?.message).toMatch(/YYYY-MM-DD/);

    const future = parseStatement(
      [
        ["Symbol", "Qty", "As Of"],
        ["AAPL", "50", "2126-01-01"],
      ],
      mapping({ columns }),
    );
    expect(future.asOfDate).toBeNull();
    expect(future.problems[0]?.message).toMatch(/future/);
  });

  it("says when no as-of column is mapped, so the review step can ask", () => {
    const parsed = parseStatement(
      [
        ["Symbol", "Qty"],
        ["AAPL", "50"],
      ],
      mapping({ columns: { instrument: "Symbol", quantity: "Qty" } }),
    );

    expect(parsed.asOfMapped).toBe(false);
    expect(parsed.asOfDate).toBeNull();
    expect(parsed.problems).toEqual([]);
  });
});
