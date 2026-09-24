// applying a mapping to a file's rows (spec 0004, step 02) — fixtures run whole exports, inline tests pin one rule per row
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { readCsv } from "~/lib/csv";
import { parseStatement, statementMapping, type StatementMapping } from "~/lib/statement";

const fixture = (name: string): Uint8Array =>
  readFileSync(fileURLToPath(new URL(`./fixtures/statements/${name}`, import.meta.url)));

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
    expect(parsed.skipped).toEqual([]);

    const aapl = parsed.positions[0];
    expect(aapl?.instrument).toBe("AAPL");
    expect(aapl?.name).toBe("APPLE INC COM USD0.00001");
    expect(aapl?.quantity).toBe("50.000");
    expect(aapl?.costBasisPerShare).toBe("170.6600");
    expect(aapl?.accountNumber).toBe("Z12-345678");

    // n/a basis lands as null, never zero — zero would report free money
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

    // $8,533/50=170.66; $9,875.50/25=395.02
    expect(parsed.positions[0]?.costBasisPerShare).toBe("170.6600");
    expect(parsed.positions[1]?.costBasisPerShare).toBe("395.0200");
    // parenthesised total means negative — sign stays in the quantity, price stays positive
    expect(parsed.positions[2]?.quantity).toBe("-10");
    expect(parsed.positions[2]?.costBasisPerShare).toBe("26.5000");

    // named but no quantity — skipped and reported, not a problem
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
    // no basis column mapped — null for every row (§8.2)
    for (const position of parsed.positions) {
      expect(position.costBasisPerShare).toBeNull();
    }
    // no ticker on a collective trust — fund name is the instrument string
    expect(parsed.positions[0]?.instrument).toBe("Vanguard Target Retirement 2045 Trust II");
    expect(parsed.positions[0]?.quantity).toBe("412.51230000");

    expect(parsed.asOfMapped).toBe(true);
    expect(parsed.asOfDate).toBe("2026-07-31");
  });

  it("refuses the two blank ticker rows worth $58,692.68 in the 401k export", () => {
    const { rows } = readCsv(fixture("401k.csv"));
    const parsed = parseStatement(
      rows,
      mapping({
        columns: {
          instrument: "Ticker",
          name: "Investment",
          quantity: "Units",
          asOf: "As Of",
        },
      }),
    );

    expect(parsed.problems).toHaveLength(2);
    expect(parsed.problems).toEqual([
      expect.objectContaining({ row: 1, column: "Ticker", code: "blank-instrument" }),
      expect.objectContaining({ row: 2, column: "Ticker", code: "blank-instrument" }),
    ]);
    expect(parsed.positions).toHaveLength(1);
    expect(parsed.positions[0]?.instrument).toBe("VBTIX");
    expect(parsed.skipped).toEqual([]);
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

    // (100×95.10 + 200×110.25 + 112.5×123.40)/412.5 = 110.16363…, rounded half away from zero
    const vtsax = parsed.positions[0];
    expect(vtsax?.quantity).toBe("412.50000000");
    expect(vtsax?.costBasisPerShare).toBe("110.1636");
    expect(vtsax?.row).toBe(1);

    // single-lot fund passes through at the file's own scale, uncombined
    expect(parsed.positions[1]?.quantity).toBe("50.0000");
    expect(parsed.positions[1]?.costBasisPerShare).toBe("72.8000");

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

    // file says 14,500.00 owed; §2 puts the sign in the quantity, decided by the mapping's checkbox
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

  it.each([
    {
      label: "quantity",
      columns: { instrument: "Symbol", quantity: "Qty" },
      header: ["Symbol", "Qty"],
      row: ["", "139.153103"],
      populated: "Qty",
    },
    {
      label: "cost basis",
      columns: { instrument: "Symbol", quantity: "Qty", costBasis: "Basis" },
      header: ["Symbol", "Qty", "Basis"],
      row: [" ", "", "108.2561"],
      populated: "Basis",
    },
  ])("refuses a blank instrument with a populated mapped $label cell", ({
    columns: mapped,
    header,
    row,
    populated,
  }) => {
    const parsed = parseStatement(
      [header, ["VTI", "282.144455"], row],
      mapping({ columns: mapped }),
    );

    expect(parsed.problems).toHaveLength(1);
    expect(parsed.positions).toHaveLength(1);
    expect(parsed.problems[0]).toMatchObject({
      row: 2,
      column: "Symbol",
      code: "blank-instrument",
    });
    expect(parsed.problems[0]?.message).toContain("Line 3");
    expect(parsed.problems[0]?.message).toContain(`"${populated}"`);
    expect(parsed.problems[0]?.message).toContain("fix the source file and start a new upload");
    expect(parsed.problems[0]?.message).not.toContain(
      row.find((cell) => cell.trim() !== "") ?? "",
    );
  });

  it.each(["0", "not a number"])(
    "treats a quantity spelling of %j as populated after numeric normalisation",
    (quantity) => {
      const parsed = parseStatement(
        [
          ["Symbol", "Qty"],
          ["", quantity],
        ],
        mapping({ columns }),
      );

      expect(parsed.problems[0]).toMatchObject({ row: 1, column: "Symbol" });
      expect(parsed.problems[0]?.message).toContain('"Qty"');
    },
  );

  it.each(["", "-", "--", "—", "n/a", "N/A"])(
    "ignores a blank instrument row whose financial cells contain the absence spelling %j",
    (absence) => {
      const parsed = parseStatement(
        [
          ["Symbol", "Qty", "Basis"],
          ["", absence, absence],
        ],
        mapping({
          columns: { instrument: "Symbol", quantity: "Qty", costBasis: "Basis" },
        }),
      );

      expect(parsed.problems).toEqual([]);
      expect(parsed.positions).toEqual([]);
    },
  );

  it("names two populated financial columns without an Oxford comma", () => {
    const parsed = parseStatement(
      [
        ["Symbol", "Qty", "Basis"],
        ["", "0", "not a number"],
      ],
      mapping({ columns: { instrument: "Symbol", quantity: "Qty", costBasis: "Basis" } }),
    );

    expect(parsed.problems[0]?.message).toContain('mapped "Qty" and "Basis" cells have content');
    expect(parsed.problems[0]?.message).not.toContain('"Qty", and "Basis"');
  });

  it("refuses a ragged row whose missing instrument cell accompanies mapped data", () => {
    const parsed = parseStatement(
      [
        ["Qty", "Symbol"],
        ["0"],
      ],
      mapping({ columns: { instrument: "Symbol", quantity: "Qty" } }),
    );

    expect(parsed.problems[0]).toMatchObject({ row: 1, column: "Symbol" });
    expect(parsed.problems[0]?.message).toMatch(/Line 2.*"Qty"/);
  });

  it.each([
    { label: "as-of date", header: "As Of", value: "2026-09-13", column: "asOf" as const },
    {
      label: "account number",
      header: "Account",
      value: "Z12-345678",
      column: "accountNumber" as const,
    },
  ])("ignores a blank instrument row populated only by its mapped $label", ({
    header,
    value,
    column,
  }) => {
    const parsed = parseStatement(
      [
        [header, "Symbol", "Qty"],
        [value],
      ],
      mapping({
        columns: {
          instrument: "Symbol",
          quantity: "Qty",
          [column]: header,
        },
      }),
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.positions).toEqual([]);
  });

  it("ignores empty spacers and footer text outside mapped financial and account columns", () => {
    const parsed = parseStatement(
      [
        ["Symbol", "Qty", "Basis", "As Of", "Account", "Name", "Other"],
        ["VTI", "1", "", "", "", "Vanguard", ""],
        [],
        ["   ", "  ", "", "\t", "", "Footer heading", "disclosure text"],
      ],
      mapping({
        columns: {
          instrument: "Symbol",
          quantity: "Qty",
          costBasis: "Basis",
          asOf: "As Of",
          accountNumber: "Account",
          name: "Name",
        },
      }),
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.positions).toHaveLength(1);
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

  it("strips the line breaks a quoted account-number cell carries, which a form's box would drop anyway", () => {
    // RFC 4180 lets a quoted field hold a newline, and the reader keeps it. A text input does
    // not: what settings draws into its box comes back without it, so a number recorded with
    // one could never be saved back unchanged (#312).
    const { rows } = readCsv(
      new TextEncoder().encode('Symbol,Qty,Account\nVTI,1,"Z12-345678\r\n(joint)"\n'),
    );
    const parsed = parseStatement(
      rows,
      mapping({ columns: { instrument: "Symbol", quantity: "Qty", accountNumber: "Account" } }),
    );

    expect(rows[1]?.[2]).toBe("Z12-345678\r\n(joint)");
    expect(parsed.problems).toEqual([]);
    expect(parsed.positions[0]?.accountNumber).toBe("Z12-345678(joint)");
  });

  it("refuses an as-of date a quoted cell split over two lines, rather than closing the gap", () => {
    // The account number is the one cell canonicalised, because a form has to post it back
    // (#312). Joining these halves would file the statement on a date the file never states.
    const { rows } = readCsv(new TextEncoder().encode('Symbol,Qty,AsOf\nVTI,1,"2026-09-\r\n24"\n'));
    const parsed = parseStatement(
      rows,
      mapping({ columns: { instrument: "Symbol", quantity: "Qty", asOf: "AsOf" } }),
    );

    expect(parsed.asOfDate).toBeNull();
    expect(parsed.problems[0]?.message).toMatch(/must be written as YYYY-MM-DD/);
  });

  it("keeps the line break a quoted name cell carries, rather than running its words together", () => {
    const { rows } = readCsv(
      new TextEncoder().encode('Symbol,Qty,Name\nVTI,1,"VANGUARD TOTAL\r\nSTOCK MARKET ETF"\n'),
    );
    const parsed = parseStatement(
      rows,
      mapping({ columns: { instrument: "Symbol", quantity: "Qty", name: "Name" } }),
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.positions[0]?.name).toBe("VANGUARD TOTAL\r\nSTOCK MARKET ETF");
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

    // 100/3 at numeric(20,4): rounded half away from zero, never floated
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
      // "-0.00" is a debt of nothing written as though it were something
      "0.00",
      // negation, not "make negative" — a credit on a loan statement counts for the household
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
    // resolution in step 04 is byte-exact against the alias table — combining across spellings here would guess what resolution decides
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
    // stored as zero, so the row stays addressable — not dropped
    expect(parsed.positions[0]?.quantity).toBe("0.00000000");
    expect(parsed.positions[0]?.costBasisPerShare).toBeNull();
    expect(parsed.combined).toEqual([{ instrument: "XYZ", rowCount: 2, quantity: "0.00000000" }]);
  });

  it("keeps a null basis when any combined lot's own basis is unknown", () => {
    // a blended figure over a gap would be fake precision — same reason sumMoney counts its nulls instead of zeroing them
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

  it("reads the US date shapes real exports carry as the ISO date", () => {
    // spelling is normalised; the rules (real calendar date, no later than tomorrow) are still recordedDate's
    const padded = parseStatement(
      [
        ["Symbol", "Qty", "As Of"],
        ["AAPL", "50", "06/30/2026"],
      ],
      mapping({ columns }),
    );
    expect(padded.asOfDate).toBe("2026-06-30");
    expect(padded.problems).toEqual([]);

    const bare = parseStatement(
      [
        ["Symbol", "Qty", "As Of"],
        ["AAPL", "50", "6/3/2026"],
      ],
      mapping({ columns }),
    );
    expect(bare.asOfDate).toBe("2026-06-03");
    expect(bare.problems).toEqual([]);
  });

  it("refuses a US-shaped date that is not on the calendar", () => {
    const parsed = parseStatement(
      [
        ["Symbol", "Qty", "As Of"],
        ["AAPL", "50", "13/40/2026"],
      ],
      mapping({ columns }),
    );

    expect(parsed.asOfDate).toBeNull();
    expect(parsed.problems[0]).toMatchObject({ row: 1, column: "As Of" });
    expect(parsed.problems[0]?.message).toMatch(/not a date on the calendar/);
  });

  it("reads two spellings of one date as agreement, not as two dates", () => {
    const parsed = parseStatement(
      [
        ["Symbol", "Qty", "As Of"],
        ["AAPL", "50", "06/30/2026"],
        ["MSFT", "25", "2026-06-30"],
      ],
      mapping({ columns }),
    );

    expect(parsed.asOfDate).toBe("2026-06-30");
    expect(parsed.problems).toEqual([]);
  });

  it("refuses a file that dates itself before the first day anything can be priced", () => {
    // floor reaches the parser through the shared validator — 1969 refuses here rather than committing a set the chart can never price
    const parsed = parseStatement(
      [
        ["Symbol", "Qty", "As of"],
        ["AAPL", "50", "1969-12-31"],
      ],
      mapping({ columns: { instrument: "Symbol", quantity: "Qty", asOf: "As of" } }),
    );

    expect(parsed.asOfDate).toBeNull();
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]?.message).toMatch(/first day this application can price/);
  });

  it("validates the date by the same rule a typed one faces", () => {
    // recordedDate's rules, unchanged: spelling, calendar, future — dated 2126 would pin the account until 2126
    const spelled = parseStatement(
      [
        ["Symbol", "Qty", "As Of"],
        ["AAPL", "50", "July 31, 2026"],
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

// spec 0023: grouped per account number; sign, as-of agreement and blank numbers are the router's
describe("multi-account mode", () => {
  const spreadsheet = {
    instrument: "Holding",
    name: "Description",
    quantity: "Quantity",
    costBasis: "Cost Basis",
    asOf: "As Of",
    accountNumber: "Account Number",
  };
  const columns = { instrument: "Symbol", quantity: "Qty", accountNumber: "Account" };

  it("keeps one instrument held in two accounts as two positions, each with its own number", () => {
    const { rows } = readCsv(fixture("multi-account.csv"));
    const parsed = parseStatement(rows, mapping({ multiAccount: true, columns: spreadsheet }));

    expect(parsed.problems).toEqual([]);
    expect(parsed.combined).toEqual([]);
    expect(parsed.unnumbered).toEqual([]);
    expect(
      parsed.positions.map((position) => [
        position.row,
        position.accountNumber,
        position.instrument,
        position.quantity,
        position.costBasisPerShare,
      ]),
    ).toEqual([
      [1, "Z12-345678", "VTI", "120.000", "205.12"],
      [2, "Z12-345678", "AAPL", "50.000", "170.66"],
      [3, "Z98-765432", "VTI", "40.500", "231.40"],
      [4, "Z98-765432", "FXAIX", "84.512", "151.33"],
      [5, "0045501234", "Home mortgage", "312450.00", null],
    ]);
  });

  it("applies no sign even with owedAsPositive set, since the router knows which account is owed", () => {
    const { rows } = readCsv(fixture("multi-account.csv"));
    const parsed = parseStatement(
      rows,
      mapping({ multiAccount: true, owedAsPositive: true, columns: spreadsheet }),
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.positions.map((position) => position.quantity)).toEqual([
      "120.000",
      "50.000",
      "40.500",
      "84.512",
      // negated by the router, and only because this row lands in a liability (decision 6)
      "312450.00",
    ]);
  });

  it("returns as-of sightings per account unresolved, where differing dates refuse nothing", () => {
    const { rows } = readCsv(fixture("multi-account.csv"));
    const parsed = parseStatement(rows, mapping({ multiAccount: true, columns: spreadsheet }));

    expect(parsed.problems).toEqual([]);
    expect(parsed.asOfMapped).toBe(true);
    expect(parsed.asOfDate).toBeNull();
    expect(parsed.asOfSightings).toEqual([
      { row: 1, accountNumber: "Z12-345678", value: "2026-07-31" },
      { row: 2, accountNumber: "Z12-345678", value: "2026-07-31" },
      { row: 3, accountNumber: "Z98-765432", value: "2026-06-30" },
      { row: 4, accountNumber: "Z98-765432", value: "2026-06-30" },
      { row: 5, accountNumber: "0045501234", value: "2026-07-15" },
    ]);
  });

  it("leaves an as-of cell's spelling, validity and agreement within one account to the router", () => {
    // single-account mode refuses this file; which numbers are one account is not known here
    const parsed = parseStatement(
      [
        ["Account", "Symbol", "Qty", "As Of"],
        ["A1", "AAPL", "50", "06/30/2026"],
        ["A1", "MSFT", "25", "July 31, 2026"],
      ],
      mapping({ multiAccount: true, columns: { ...columns, asOf: "As Of" } }),
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.asOfDate).toBeNull();
    expect(parsed.asOfSightings).toEqual([
      { row: 1, accountNumber: "A1", value: "06/30/2026" },
      { row: 2, accountNumber: "A1", value: "July 31, 2026" },
    ]);
  });

  it("lists a blank-numbered row by row and instrument, and keeps it out of the positions", () => {
    const { rows } = readCsv(fixture("multi-account-blank-number.csv"));
    const parsed = parseStatement(rows, mapping({ multiAccount: true, columns: spreadsheet }));

    // the router refuses the file on these (decision 13): a dropped row would record a sale
    expect(parsed.unnumbered).toEqual([{ row: 3, instrument: "FXAIX" }]);
    expect(parsed.problems).toEqual([]);
    expect(parsed.positions.map((position) => position.instrument)).toEqual([
      "VTI",
      "AAPL",
      "Home mortgage",
    ]);
    expect(parsed.asOfSightings?.map((sighting) => sighting.row)).toEqual([1, 2, 4]);
  });

  it("keeps a skipped row's account number, when it states one, for that account's own review", () => {
    const parsed = parseStatement(
      [
        ["Account", "Symbol", "Qty"],
        ["A1", "VTI", "10"],
        [" A1 ", "CASH", "--"],
        ["", "Total", "--"],
      ],
      mapping({ multiAccount: true, columns }),
    );

    expect(parsed.skipped).toEqual([
      { row: 2, instrument: "CASH", accountNumber: "A1" },
      { row: 3, instrument: "Total" },
    ]);
  });

  it("strips a line break from a skipped row's account number too, so one account is one spelling", () => {
    // The skipped row reads the number by its own call. A break left there would file the row's
    // review under a name the positions above it no longer carry (#312).
    const { rows } = readCsv(
      new TextEncoder().encode('Account,Symbol,Qty\n"A1-\r\n2245",VTI,10\n"A1-\r\n2245",CASH,--\n'),
    );
    const parsed = parseStatement(rows, mapping({ multiAccount: true, columns }));

    expect(parsed.positions[0]?.accountNumber).toBe("A1-2245");
    expect(parsed.skipped).toEqual([{ row: 2, instrument: "CASH", accountNumber: "A1-2245" }]);
  });

  it("counts a whitespace-only number as blank, but not on a row skipped for stating no quantity", () => {
    const parsed = parseStatement(
      [
        ["Account", "Symbol", "Qty"],
        ["A1", "VTI", "10"],
        ["  ", "BND", "5"],
        ["", "Total", "--"],
      ],
      mapping({ multiAccount: true, columns }),
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.unnumbered).toEqual([{ row: 2, instrument: "BND" }]);
    expect(parsed.skipped).toEqual([{ row: 3, instrument: "Total" }]);
    expect(parsed.positions).toHaveLength(1);
  });

  it("groups account numbers exactly as written once trimmed, never folding case or leading zeros", () => {
    const parsed = parseStatement(
      [
        ["Account", "Symbol", "Qty"],
        [" 00123456 ", "VTI", "1"],
        ["00123456", "VTI", "2"],
        ["123456", "VTI", "4"],
        ["z12-345678", "BND", "1"],
        ["Z12-345678", "BND", "1"],
      ],
      mapping({ multiAccount: true, columns }),
    );

    expect(parsed.problems).toEqual([]);
    expect(
      parsed.positions.map((position) => [
        position.accountNumber,
        position.instrument,
        position.quantity,
      ]),
    ).toEqual([
      ["00123456", "VTI", "3.00000000"],
      ["123456", "VTI", "4"],
      ["z12-345678", "BND", "1"],
      ["Z12-345678", "BND", "1"],
    ]);
  });

  it("combines duplicate rows within one account, never across accounts, naming the account", () => {
    const parsed = parseStatement(
      [
        ["Account", "Symbol", "Qty", "Basis"],
        ["A1", "VTI", "10", "100.00"],
        ["B2", "VTI", "5", "150.00"],
        ["A1", "VTI", "30", "200.00"],
      ],
      mapping({ multiAccount: true, columns: { ...columns, costBasis: "Basis" } }),
    );

    expect(parsed.problems).toEqual([]);
    // (10×100 + 30×200)/40 = 175
    expect(parsed.positions).toEqual([
      expect.objectContaining({
        row: 1,
        accountNumber: "A1",
        instrument: "VTI",
        quantity: "40.00000000",
        costBasisPerShare: "175.0000",
      }),
      expect.objectContaining({
        row: 2,
        accountNumber: "B2",
        instrument: "VTI",
        quantity: "5",
        costBasisPerShare: "150.00",
      }),
    ]);
    expect(parsed.combined).toEqual([
      { accountNumber: "A1", instrument: "VTI", rowCount: 2, quantity: "40.00000000" },
    ]);
  });

  it("refuses one instrument twice in one account when combining is off, naming its number", () => {
    const parsed = parseStatement(
      [
        ["Account", "Symbol", "Qty"],
        ["A1", "VTI", "10"],
        ["B2", "VTI", "5"],
        ["A1", "VTI", "30"],
      ],
      mapping({ multiAccount: true, combineDuplicateRows: false, columns }),
    );

    // "2 lines", not 3: B2's VTI is its own position, not a duplicate
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]).toMatchObject({ row: 3, column: "Symbol" });
    expect(parsed.problems[0]?.message).toMatch(
      /"VTI" appears on 2 lines for account number "A1"/,
    );
    expect(parsed.positions).toEqual([
      expect.objectContaining({ accountNumber: "B2", instrument: "VTI", quantity: "5" }),
    ]);
  });

  it("refuses a multi-account mapping that names no account number column", () => {
    const parsed = parseStatement(
      [
        ["Symbol", "Qty"],
        ["VTI", "1"],
      ],
      mapping({ multiAccount: true, columns: { instrument: "Symbol", quantity: "Qty" } }),
    );

    expect(parsed.positions).toEqual([]);
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]).toMatchObject({ row: null, column: null });
    expect(parsed.problems[0]?.message).toMatch(/names no account number column/);
  });

  it("adds nothing to the parse of a mapping without the flag, as every mapping saved before it", () => {
    const parsed = parseStatement(
      [
        ["Account", "Symbol", "Qty", "As Of"],
        ["A1", "VTI", "1", "2026-07-31"],
      ],
      mapping({ columns: { ...columns, asOf: "As Of" } }),
    );

    expect(parsed).toStrictEqual({
      positions: [
        {
          row: 1,
          instrument: "VTI",
          name: null,
          quantity: "1",
          costBasisPerShare: null,
          accountNumber: "A1",
        },
      ],
      combined: [],
      skipped: [],
      asOfDate: "2026-07-31",
      asOfMapped: true,
      problems: [],
    });
  });

  it("keeps the flag through the stored mapping's schema, which strips a key it does not name", () => {
    // a stored multi-account mapping read back without it would parse as single-account
    const stored = mapping({ multiAccount: true, columns });

    expect(statementMapping.parse(stored).multiAccount).toBe(true);
  });
});
