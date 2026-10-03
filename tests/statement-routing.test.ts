// routing a multi-account file's rows to accounts (spec 0023, ADR-0015) — every later step trusts these groups without re-matching, so a wrong route records one account's holdings as another's
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { readCsv } from "~/lib/csv";
import { foldLots, parseStatement, type StatementMapping } from "~/lib/statement";
import {
  recordedNumber,
  routeStatement,
  type OpenAccount,
  type RoutableAccount,
  type RoutedAccount,
  type RoutedStatement,
} from "~/lib/statement-routing.server";

const fixture = (name: string): Uint8Array =>
  readFileSync(fileURLToPath(new URL(`./fixtures/statements/${name}`, import.meta.url)));

const spreadsheet: StatementMapping = {
  headerRow: 0,
  delimiter: ",",
  columns: {
    instrument: "Holding",
    name: "Description",
    quantity: "Quantity",
    costBasis: "Cost Basis",
    asOf: "As Of",
    accountNumber: "Account Number",
  },
  costBasisIs: "per_share",
  owedAsPositive: false,
  combineDuplicateRows: true,
  multiAccount: true,
};

const inline: StatementMapping = {
  ...spreadsheet,
  columns: { instrument: "Symbol", quantity: "Qty", accountNumber: "Account" },
};

const route = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  mapping: StatementMapping,
  accounts: {
    open: OpenAccount[];
    closed?: RoutableAccount[];
    answers?: Array<[string, string | null]>;
  },
): RoutedStatement => {
  const parsed = parseStatement(rows, mapping);
  if (parsed.multiAccount !== true) throw new Error("a multi-account mapping parsed as single");
  expect(parsed.problems).toEqual([]);
  return routeStatement(parsed, mapping, {
    open: accounts.open,
    closed: accounts.closed ?? [],
    answers: new Map(accounts.answers ?? []),
  });
};

const spreadsheetRows = readCsv(fixture("multi-account.csv")).rows;

// ids of differing lengths, so text order, file order and id order all differ
const individual: OpenAccount = {
  id: "10",
  name: "Individual brokerage",
  externalAccountNumber: "Z12-345678",
  kind: "brokerage",
};
const roth: OpenAccount = {
  id: "100",
  name: "Roth IRA",
  externalAccountNumber: "Z98-765432",
  kind: "ira",
};
const mortgage: OpenAccount = {
  id: "9",
  name: "Home mortgage",
  externalAccountNumber: "0045501234",
  kind: "liability",
};
const unnumbered = (account: OpenAccount): OpenAccount => ({
  ...account,
  externalAccountNumber: null,
});

// Narrows to one arm, failing the test on any other.
const arm = <Step extends RoutedStatement["step"]>(
  routed: RoutedStatement,
  step: Step,
): Extract<RoutedStatement, { step: Step }> => {
  expect(routed.step).toBe(step);
  return routed as Extract<RoutedStatement, { step: Step }>;
};

const holdings = ({ accounts }: { accounts: RoutedAccount[] }) =>
  accounts.map((account) => [
    account.accountId,
    account.accountNumber,
    account.positions.map((position) => [position.instrument, position.quantity]),
  ]);

describe("an unknown number (decision 2)", () => {
  it("routes by the draft's answer, and a skip answer drops the number's rows", () => {
    const routed = arm(
      route(spreadsheetRows, spreadsheet, {
        open: [individual, unnumbered(roth), unnumbered(mortgage)],
        answers: [
          ["Z98-765432", "100"],
          ["0045501234", null],
        ],
      }),
      "routed",
    );

    expect(holdings(routed)).toEqual([
      ["10", "Z12-345678", [["VTI", "120.000"], ["AAPL", "50.000"]]],
      ["100", "Z98-765432", [["VTI", "40.500"], ["FXAIX", "84.512"]]],
    ]);
    // the commit re-checks this route under the lock and records the number on it
    expect(routed.accounts.map((account) => account.answered)).toEqual([false, true]);
  });

  it("names a number answered skip as skipped, until an open account records it", () => {
    const answers: Array<[string, string | null]> = [["0045501234", null]];

    expect(
      arm(
        route(spreadsheetRows, spreadsheet, {
          open: [individual, roth, unnumbered(mortgage)],
          answers,
        }),
        "routed",
      ).skippedNumbers,
    ).toEqual(["0045501234"]);
    // Recorded number outranks the answer: its rows route, so nothing is skipped.
    expect(
      arm(
        route(spreadsheetRows, spreadsheet, { open: [individual, roth, mortgage], answers }),
        "routed",
      ).skippedNumbers,
    ).toEqual([]);
  });

  it("routes by a recorded number and ignores an answer for it", () => {
    const joint: OpenAccount = { ...unnumbered(individual), id: "20", name: "Joint brokerage" };
    const routed = arm(
      route(spreadsheetRows, spreadsheet, {
        open: [individual, roth, mortgage, joint],
        answers: [["Z98-765432", "20"]],
      }),
      "routed",
    );

    expect(routed.accounts.map((account) => [account.accountId, account.answered])).toEqual([
      ["9", false],
      ["10", false],
      ["100", false],
    ]);
  });

  it("reports an answer as stale once its account records a number or is closed", () => {
    const routed = arm(
      route(spreadsheetRows, spreadsheet, {
        open: [individual, { ...roth, externalAccountNumber: "Z77-000000" }],
        closed: [{ id: "30", name: "Old mortgage", externalAccountNumber: null }],
        answers: [
          ["Z98-765432", "100"],
          ["0045501234", "30"],
        ],
      }),
      "accounts",
    );

    expect(routed.problems).toEqual([
      {
        kind: "stale-answer",
        accountNumber: "Z98-765432",
        row: 3,
        column: "Account Number",
        message:
          'This upload gave account number "Z98-765432" to Roth IRA, which has since recorded ' +
          'account number "Z77-000000". Choose again for it.',
      },
      {
        kind: "stale-answer",
        accountNumber: "0045501234",
        row: 5,
        column: "Account Number",
        message:
          'This upload gave account number "0045501234" to Old mortgage, which is closed. ' +
          "Choose again for it.",
      },
    ]);
  });

  it("reports each number neither recorded nor answered, at its first line", () => {
    const routed = arm(
      route(spreadsheetRows, spreadsheet, {
        open: [individual, unnumbered(roth), unnumbered(mortgage)],
      }),
      "accounts",
    );

    expect(
      routed.problems.map((problem) => [problem.kind, problem.accountNumber, problem.row]),
    ).toEqual([
      ["unanswered", "Z98-765432", 3],
      ["unanswered", "0045501234", 5],
    ]);
  });

  it("lists every number no account records as a question, answered or not, leaving out a recorded one", () => {
    const routed = arm(
      route(spreadsheetRows, spreadsheet, {
        open: [unnumbered(individual), unnumbered(roth), mortgage],
        answers: [["Z98-765432", "100"]],
      }),
      "accounts",
    );

    expect(routed.questions.map(({ number }) => number)).toEqual(["Z12-345678", "Z98-765432"]);
  });

  it("reports nothing to record when every number is skipped", () => {
    const routed = arm(
      route(spreadsheetRows, spreadsheet, {
        open: [unnumbered(individual)],
        answers: [
          ["Z12-345678", null],
          ["Z98-765432", null],
          ["0045501234", null],
        ],
      }),
      "accounts",
    );

    expect(routed.problems).toEqual([
      {
        kind: "nothing-to-record",
        accountNumber: null,
        row: null,
        column: null,
        message:
          "Every account number in the file is skipped, so this upload would record nothing.",
      },
    ]);
  });

  it("refuses one account given to two numbers (decision 12)", () => {
    const routed = arm(
      route(spreadsheetRows, spreadsheet, {
        open: [individual, unnumbered(roth)],
        answers: [
          ["Z98-765432", "100"],
          ["0045501234", "100"],
        ],
      }),
      "accounts",
    );

    expect(routed.problems.map((problem) => [problem.kind, problem.accountNumber])).toEqual([
      ["stale-answer", "Z98-765432"],
      ["stale-answer", "0045501234"],
    ]);
  });
});

describe("owedAsPositive (decision 6)", () => {
  const rows = [
    ["Account", "Symbol", "Qty", "Basis"],
    ["L1", "Loan", "10", "100.00"],
    ["B1", "VTI", "5", "150.00"],
    ["L1", "Loan", "30", "200.00"],
    ["B1", "BND", "-2", ""],
  ];
  const loan: OpenAccount = {
    id: "3",
    name: "Car loan",
    externalAccountNumber: "L1",
    kind: "liability",
  };
  const brokerage: OpenAccount = {
    id: "4",
    name: "Brokerage",
    externalAccountNumber: "B1",
    kind: "brokerage",
  };

  it("negates only rows routed to an owed account, its combined entries and weighted basis included", () => {
    const routed = arm(
      route(
        rows,
        { ...inline, owedAsPositive: true, columns: { ...inline.columns, costBasis: "Basis" } },
        { open: [loan, brokerage] },
      ),
      "routed",
    );

    const [owed, held] = routed.accounts;

    // (10×100 + 30×200) = 7000, in 10^-12 units, flipped with the quantity
    expect(owed?.positions).toEqual([
      expect.objectContaining({
        instrument: "Loan",
        quantity: "-40.00000000",
        costBasisPerShare: "175.0000",
        weightedBasisUnits: -7000000000000000n,
      }),
    ]);
    expect(owed?.combined).toEqual([
      { accountNumber: "L1", instrument: "Loan", rowCount: 2, quantity: "-40.00000000" },
    ]);
    // the review's spelling fold re-weights the numerator; a flipped quantity alone would read -175
    expect(foldLots(owed?.positions ?? []).costBasisPerShare).toBe("175.0000");

    expect(held?.positions.map((position) => position.quantity)).toEqual(["5", "-2"]);
  });

  it("negates nothing when the box is unticked, a liability's rows included", () => {
    const routed = arm(
      route(spreadsheetRows, spreadsheet, { open: [individual, roth, mortgage] }),
      "routed",
    );

    expect(routed.accounts[0]?.positions.map((position) => position.quantity)).toEqual([
      "312450.00",
    ]);
  });
});

describe("the as-of date (decision 8)", () => {
  const dated = { ...inline, columns: { ...inline.columns, asOf: "As Of" } };
  const joint: OpenAccount = {
    id: "5",
    name: "Joint brokerage",
    externalAccountNumber: "A1",
    kind: "brokerage",
  };
  const ira: OpenAccount = { id: "6", name: "IRA", externalAccountNumber: "B2", kind: "ira" };

  it("resolves each account's date from its own rows", () => {
    const routed = arm(
      route(spreadsheetRows, spreadsheet, { open: [individual, roth, mortgage] }),
      "routed",
    );

    expect(routed.accounts.map((account) => [account.accountId, account.asOfDate])).toEqual([
      ["9", "2026-07-15"],
      ["10", "2026-07-31"],
      ["100", "2026-06-30"],
    ]);
  });

  it("refuses rows of one account disagreeing on the date, naming the account, and a skipped number's dates refuse nothing", () => {
    const routed = arm(
      route(
        [
          ["Account", "Symbol", "Qty", "As Of"],
          ["A1", "VTI", "1", "2026-07-31"],
          ["B2", "VTI", "1", "06/30/2026"],
          ["A1", "BND", "1", "2026-06-30"],
          ["B2", "BND", "1", "2026-06-30"],
          ["C3", "VTI", "1", "2026-05-31"],
          ["C3", "BND", "1", "not a date"],
        ],
        dated,
        { open: [joint, ira], answers: [["C3", null]] },
      ),
      "columns",
    );

    expect(routed.problems).toEqual([
      {
        kind: "as-of",
        accountNumber: "A1",
        row: 3,
        column: "As Of",
        message:
          'The file carries two as-of dates for Joint brokerage — "2026-07-31" on line 2 and ' +
          '"2026-06-30" on line 4 — and a statement is a photograph of one day.',
      },
    ]);
  });

  it("refuses an as-of cell that is not a date, naming the account", () => {
    const routed = arm(
      route(
        [
          ["Account", "Symbol", "Qty", "As Of"],
          ["A1", "VTI", "1", "July 31, 2026"],
        ],
        dated,
        { open: [joint] },
      ),
      "columns",
    );

    expect(routed.problems).toEqual([
      expect.objectContaining({ kind: "as-of", accountNumber: "A1", row: 1, column: "As Of" }),
    ]);
    expect(routed.problems[0]?.message).toBe(
      "The as-of date for Joint brokerage must be written as YYYY-MM-DD.",
    );
  });

  it("leaves every account's date null when the column is unmapped, so one typed date applies", () => {
    const routed = arm(
      route(
        spreadsheetRows,
        { ...spreadsheet, columns: { ...spreadsheet.columns, asOf: null } },
        { open: [individual, roth, mortgage] },
      ),
      "routed",
    );

    expect(routed.accounts.map((account) => account.asOfDate)).toEqual([null, null, null]);
  });
});

describe("a blank account number (decision 13)", () => {
  it("refuses the file, listing each blank line with its instrument", () => {
    const { rows } = readCsv(fixture("multi-account-blank-number.csv"));
    const routed = arm(route(rows, spreadsheet, { open: [individual, mortgage] }), "columns");

    expect(routed.problems).toEqual([
      {
        kind: "blank-number",
        accountNumber: null,
        row: 3,
        column: "Account Number",
        message:
          'Line 4 ("FXAIX") has no account number, and a file of several accounts routes ' +
          "every row by one.",
      },
    ]);

    const twice = arm(
      route(
        [
          ["Account", "Symbol", "Qty"],
          ["", "VTI", "1"],
          ["B1", "BND", "1"],
          [" ", "VXUS", "2"],
        ],
        inline,
        { open: [{ ...individual, externalAccountNumber: "B1" }] },
      ),
      "columns",
    );
    expect(twice.problems[0]?.message).toBe(
      'Lines 2 ("VTI") and 4 ("VXUS") have no account number, and a file of several accounts ' +
        "routes every row by one.",
    );
  });
});

describe("a number recorded on a closed account (decision 14)", () => {
  it("refuses a number recorded only on a closed account, naming the account", () => {
    const routed = arm(
      route(spreadsheetRows, spreadsheet, {
        open: [individual, roth],
        closed: [{ id: "3", name: "Old mortgage", externalAccountNumber: "0045501234" }],
        answers: [["0045501234", null]],
      }),
      "columns",
    );

    expect(routed.problems).toEqual([
      {
        kind: "closed-number",
        accountNumber: "0045501234",
        row: 5,
        column: "Account Number",
        message:
          'Account number "0045501234" is recorded on Old mortgage, which is closed, and a ' +
          "closed account's history does not change. The number can be cleared on it in Settings.",
      },
    ]);
  });

  it("routes a number recorded on both a closed and an open account to the open one", () => {
    const routed = arm(
      route(spreadsheetRows, spreadsheet, {
        open: [individual, roth, mortgage],
        closed: [{ id: "2", name: "Old Roth IRA", externalAccountNumber: "Z98-765432" }],
      }),
      "routed",
    );

    expect(holdings(routed).map(([id, number]) => [id, number])).toEqual([
      ["9", "0045501234"],
      ["10", "Z12-345678"],
      ["100", "Z98-765432"],
    ]);
  });
});

describe("matching (decision 15)", () => {
  it("matches exactly once trimmed, never folding case or leading zeros", () => {
    const routed = arm(
      route(
        [
          ["Account", "Symbol", "Qty"],
          ["Z12-345678", "VTI", "1"],
          ["z98-765432", "BND", "1"],
          ["123456", "VXUS", "1"],
        ],
        inline,
        {
          open: [
            { ...individual, externalAccountNumber: "  Z12-345678 " },
            roth,
            { ...mortgage, id: "15", externalAccountNumber: "00123456" },
          ],
        },
      ),
      "accounts",
    );

    expect(routed.problems.map((problem) => [problem.kind, problem.accountNumber])).toEqual([
      ["unanswered", "z98-765432"],
      ["unanswered", "123456"],
    ]);
  });

  it("reads a blank or whitespace number as none recorded", () => {
    for (const externalAccountNumber of [null, "", "   ", "\t"]) {
      expect(recordedNumber({ ...roth, externalAccountNumber })).toBeNull();
    }
    expect(recordedNumber({ ...roth, externalAccountNumber: " A-1 " })).toBe("A-1");
  });

  it("refuses a number two open accounts record once trimmed, naming both and routing its rows to neither", () => {
    const routed = arm(
      route(
        [
          ["Account", "Symbol", "Qty"],
          ["A-1", "VTI", "1"],
        ],
        inline,
        {
          open: [
            { ...roth, externalAccountNumber: " A-1" },
            { ...mortgage, externalAccountNumber: "A-1" },
          ],
        },
      ),
      "columns",
    );

    expect(routed.problems).toEqual([
      {
        kind: "shared-number",
        accountNumber: "A-1",
        row: 1,
        column: "Account",
        message:
          'Account number "A-1" is recorded on Roth IRA and Home mortgage, and a file\'s rows ' +
          "go to one account per number. Clear it from all but one of them in Settings.",
      },
    ]);
  });
});

describe("the groups", () => {
  it("gives an open account the file does not name no group (decision 7)", () => {
    const savings: OpenAccount = {
      id: "1",
      name: "Savings",
      externalAccountNumber: "S-0001",
      kind: "bank",
    };
    const routed = arm(
      route(spreadsheetRows, spreadsheet, {
        open: [savings, individual, roth, mortgage, unnumbered({ ...roth, id: "2" })],
      }),
      "routed",
    );

    expect(routed.accounts.map((account) => account.accountId)).not.toContain("1");
    expect(routed.accounts.map((account) => account.accountId)).not.toContain("2");
  });

  it("gives each account the skipped lines its number states, leaving the rest to the file", () => {
    const routed = arm(
      route(
        [
          ["Account", "Symbol", "Qty"],
          ["Z12-345678", "VTI", "10"],
          ["Z12-345678", "CASH", "--"],
          ["Z98-765432", "FXAIX", "1"],
          ["", "Total", "--"],
        ],
        inline,
        { open: [individual, roth] },
      ),
      "routed",
    );

    expect(routed.accounts.map((account) => [account.accountId, account.skipped])).toEqual([
      ["10", [{ row: 2, instrument: "CASH", accountNumber: "Z12-345678" }]],
      ["100", []],
    ]);
  });

  it("comes out in ascending account id order, so 9 precedes 10 and 100", () => {
    // file order and text order both give 10, 100, 9; the commit locks in this order
    const routed = arm(
      route(spreadsheetRows, spreadsheet, { open: [roth, individual, mortgage] }),
      "routed",
    );

    expect(routed.accounts.map((account) => account.accountId)).toEqual(["9", "10", "100"]);
  });
});

describe("the step each problem belongs to (spec 0030)", () => {
  const dated = { ...inline, columns: { ...inline.columns, asOf: "As Of" } };
  const a1: OpenAccount = { ...individual, externalAccountNumber: "A1" };
  const oldMortgage = { id: "30", name: "Old mortgage", externalAccountNumber: "0045501234" };

  it.each([
    [
      "blank-number",
      "columns",
      "",
      () =>
        route(
          [
            ["Account", "Symbol", "Qty"],
            ["", "VTI", "1"],
            ["A1", "BND", "1"],
          ],
          inline,
          { open: [a1] },
        ),
    ],
    [
      "shared-number",
      "columns",
      "",
      () =>
        route(
          [
            ["Account", "Symbol", "Qty"],
            ["A1", "VTI", "1"],
          ],
          inline,
          { open: [a1, { ...roth, externalAccountNumber: "A1" }] },
        ),
    ],
    [
      "closed-number",
      "columns",
      "",
      () =>
        route(spreadsheetRows, spreadsheet, { open: [individual, roth], closed: [oldMortgage] }),
    ],
    [
      "unanswered",
      "accounts",
      "",
      () =>
        route(spreadsheetRows, spreadsheet, { open: [individual, roth, unnumbered(mortgage)] }),
    ],
    [
      "stale-answer",
      "accounts",
      "",
      () =>
        route(spreadsheetRows, spreadsheet, {
          open: [individual, roth],
          closed: [{ ...oldMortgage, externalAccountNumber: null }],
          answers: [["0045501234", "30"]],
        }),
    ],
    [
      "as-of",
      "columns",
      "",
      () =>
        route(
          [
            ["Account", "Symbol", "Qty", "As Of"],
            ["A1", "VTI", "1", "2026-07-31"],
            ["A1", "BND", "1", "2026-06-30"],
          ],
          dated,
          { open: [a1] },
        ),
    ],
    [
      "nothing-to-record",
      "accounts",
      " when every number is skipped",
      () =>
        route(spreadsheetRows, spreadsheet, {
          open: [unnumbered(individual)],
          answers: [
            ["Z12-345678", null],
            ["Z98-765432", null],
            ["0045501234", null],
          ],
        }),
    ],
    [
      "nothing-to-record",
      "columns",
      " when no row states a position",
      () =>
        route(
          [
            ["Account", "Symbol", "Qty"],
            ["A1", "CASH", "--"],
          ],
          inline,
          { open: [a1] },
        ),
    ],
  ] as const)("puts %s on the %s step%s", (kind, step, _when, routed) => {
    expect(arm(routed(), step).problems.map((problem) => problem.kind)).toEqual([kind]);
  });

  it("puts a file with both a columns and an accounts problem on the columns step, with only the columns one", () => {
    const routed = arm(
      route(spreadsheetRows, spreadsheet, {
        open: [individual, unnumbered(roth)],
        closed: [oldMortgage],
      }),
      "columns",
    );

    expect(routed.problems.map((problem) => [problem.kind, problem.accountNumber])).toEqual([
      ["closed-number", "0045501234"],
    ]);
  });

  it("owes answers in first-line order, a stale number on an earlier line before an unanswered one", () => {
    const routed = arm(
      route(spreadsheetRows, spreadsheet, {
        open: [individual, { ...roth, externalAccountNumber: "Z77-000000" }],
        answers: [["Z98-765432", "100"]],
      }),
      "accounts",
    );

    expect(routed.unanswered).toEqual(["Z98-765432", "0045501234"]);
  });

  it("asks each unknown number with its lines, trimmed instruments, standing answer and stale sentence", () => {
    const routed = arm(
      route(
        [
          ["Account", "Symbol", "Qty"],
          ["A1", "VTI", "10"],
          ["B2", "BND", "5"],
          ["A1", "VTI", "5"],
          ["A1", "CASH", "--"],
          ["C3", "VXUS", "1"],
          ["D4", "VTI", "1"],
          ["A1", " BND ", "2"],
          ["D4", "VTI", "3"],
        ],
        inline,
        {
          open: [unnumbered(individual), roth],
          closed: [{ ...oldMortgage, externalAccountNumber: null }],
          answers: [
            ["A1", "10"],
            ["B2", null],
            ["D4", "30"],
          ],
        },
      ),
      "accounts",
    );

    expect(routed.questions).toEqual([
      // two VTI rows combined, one BND, one skipped CASH
      { number: "A1", lines: 4, instruments: ["VTI", "BND"], answer: "10", stale: null },
      { number: "B2", lines: 1, instruments: ["BND"], answer: null, stale: null },
      { number: "C3", lines: 1, instruments: ["VXUS"], answer: undefined, stale: null },
      {
        number: "D4",
        lines: 2,
        instruments: ["VTI"],
        answer: "30",
        stale:
          'This upload gave account number "D4" to Old mortgage, which is closed. Choose again ' +
          "for it.",
      },
    ]);
  });
});
