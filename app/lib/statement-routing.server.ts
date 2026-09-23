// Routes each row of a multi-account file to the open account its number names (spec 0023,
// ADR-0015). Pure. The only matcher: every step after columns reads these groups and nothing
// re-matches, so a wrong route here records one account's holdings as another's. Takes a clean
// parse only: a parse with problems never reaches it, so every problem here is a routing one.
import { isOwed } from "./account-options.ts";
import { compareIds } from "./database-id.ts";
import { listSentence } from "./input.server.ts";
import {
  negateOwed,
  resolveAsOf,
  type CombinedRows,
  type MultiAccountStatement,
  type ParsedPosition,
  type SkippedRow,
  type StatementMapping,
} from "./statement.ts";

import type { Account } from "./accounts.server.ts";

export type RoutableAccount = Pick<Account, "id" | "name" | "externalAccountNumber">;

export type OpenAccount = Pick<Account, "id" | "name" | "externalAccountNumber" | "kind">;

export type RoutingAccounts = {
  open: ReadonlyArray<OpenAccount>;
  // Every closed account, numbered or not: a stale answer may name one.
  closed: ReadonlyArray<RoutableAccount>;
  // The draft's answers, number -> account id; null skips the number's rows (decision 2).
  answers: ReadonlyMap<string, string | null>;
};

export type RoutedAccount = {
  accountId: string;
  accountName: string;
  accountNumber: string;
  // By the draft's answer, not a recorded number: the commit re-checks it and records the number.
  answered: boolean;
  positions: ParsedPosition[];
  combined: CombinedRows[];
  skipped: SkippedRow[]; // this account's own; the rest are the file's
  asOfDate: string | null; // null: unmapped (one typed date for all, decision 8), blank or refused
};

// row/column/message as ParseProblem, so a step can show both side by side.
export type RoutingProblem = {
  kind:
    | "blank-number"
    | "closed-number"
    | "unanswered"
    | "stale-answer"
    | "as-of"
    | "nothing-to-record";
  accountNumber: string | null;
  row: number | null;
  column: string | null;
  message: string;
};

export type RoutedStatement = {
  accounts: RoutedAccount[]; // ascending id: the commit's lock order
  problems: RoutingProblem[];
  // Numbers no account records, first-line order: the accounts step's questions, answered or not.
  unknownNumbers: string[];
  // Those answered skip, first-line order: rows no account receives.
  skippedNumbers: string[];
};

// Decision 15: exact once trimmed. Settings trims on write; not relied on. Null alone records none,
// as the commit's number write reads it; every writer stores a blank as null.
export function recordedNumber(account: RoutableAccount): string | null {
  return account.externalAccountNumber?.trim() ?? null;
}

export function routeStatement(
  parsed: MultiAccountStatement,
  mapping: StatementMapping,
  { open, closed, answers }: RoutingAccounts,
): RoutedStatement {
  const problems: RoutingProblem[] = [];
  const column = mapping.columns.accountNumber ?? null;

  if (parsed.unnumbered.length > 0) {
    const lines = parsed.unnumbered.map(
      ({ row, instrument }) => `${row + 1} ("${instrument.trim()}")`,
    );
    const one = lines.length === 1;
    problems.push({
      kind: "blank-number",
      accountNumber: null,
      row: parsed.unnumbered[0]?.row ?? null,
      column,
      message:
        `${one ? "Line" : "Lines"} ${listSentence(lines)} ${one ? "has" : "have"} no account ` +
        "number, and a file of several accounts routes every row by one.",
    });
  }

  const firstRow = new Map<string, number>();
  for (const { accountNumber, row } of parsed.positions) {
    if (accountNumber !== null && !firstRow.has(accountNumber)) firstRow.set(accountNumber, row);
  }

  const openByNumber = new Map(
    open.flatMap((account) => {
      const number = recordedNumber(account);
      return number === null ? [] : [[number, account] as const];
    }),
  );

  // Recorded number first, then answer (decision 2).
  const routes: Array<{ number: string; account: OpenAccount; answered: boolean }> = [];
  const answeredNumbers: Array<{ number: string; row: number; accountId: string }> = [];
  const unknownNumbers: string[] = [];
  const skippedNumbers: string[] = [];

  for (const [number, row] of firstRow) {
    const holder = openByNumber.get(number);
    if (holder !== undefined) {
      routes.push({ number, account: holder, answered: false });
      continue;
    }

    const closedHolders = closed.filter((account) => recordedNumber(account) === number);
    for (const account of closedHolders) {
      problems.push({
        kind: "closed-number",
        accountNumber: number,
        row,
        column,
        message:
          `Account number "${number}" is recorded on ${account.name}, which is closed, and a ` +
          "closed account's history does not change. The number can be cleared on it in Settings.",
      });
    }
    if (closedHolders.length > 0) continue;

    unknownNumbers.push(number);
    const answer = answers.get(number);
    if (answer === undefined) {
      problems.push({
        kind: "unanswered",
        accountNumber: number,
        row,
        column,
        message: `No account records account number "${number}". Choose one, or skip its rows.`,
      });
    } else if (answer === null) {
      skippedNumbers.push(number);
    } else {
      answeredNumbers.push({ number, row, accountId: answer });
    }
  }

  for (const { number, row, accountId } of answeredNumbers) {
    const account = open.find((candidate) => candidate.id === accountId);
    const holds = account === undefined ? null : recordedNumber(account);
    let stale: string;

    if (account === undefined) {
      const name = closed.find((candidate) => candidate.id === accountId)?.name;
      stale = name === undefined ? "an account that is closed" : `${name}, which is closed`;
    } else if (holds !== null) {
      stale = `${account.name}, which has since recorded account number "${holds}"`;
    } else if (
      answeredNumbers.some((other) => other.accountId === accountId && other.number !== number)
    ) {
      // Decision 12; the answer table's unique index refuses it first.
      stale = `${account.name}, and gave it another account number too`;
    } else {
      routes.push({ number, account, answered: true });
      continue;
    }

    problems.push({
      kind: "stale-answer",
      accountNumber: number,
      row,
      column,
      message: `This upload gave account number "${number}" to ${stale}. Choose again for it.`,
    });
  }

  routes.sort((a, b) => compareIds(a.account.id, b.account.id));

  const accounts: RoutedAccount[] = [];
  for (const { number, account, answered } of routes) {
    // Decision 6: sign by the kind of the account the rows land in.
    const flips = mapping.owedAsPositive && isOwed(account.kind);

    // Decision 8: resolved per account, so a skipped number's dates refuse nothing. Unmapped: no
    // sightings, so null.
    const { asOfDate, problem } = resolveAsOf(
      parsed.asOfSightings.filter((sighting) => sighting.accountNumber === number),
      mapping.columns.asOf ?? null,
      account.name,
    );
    if (problem !== null) {
      const { row, message } = problem;
      problems.push({ kind: "as-of", accountNumber: number, row, column: problem.column, message });
    }

    accounts.push({
      accountId: account.id,
      accountName: account.name,
      accountNumber: number,
      answered,
      positions: parsed.positions
        .filter((position) => position.accountNumber === number)
        .map((position) => (flips ? negateOwed(position) : position)),
      combined: parsed.combined
        .filter((entry) => entry.accountNumber === number)
        .map((entry) => (flips ? negateOwed(entry) : entry)),
      skipped: parsed.skipped.filter((row) => row.accountNumber === number),
      asOfDate,
    });
  }

  if (accounts.length === 0 && problems.length === 0) {
    problems.push({
      kind: "nothing-to-record",
      accountNumber: null,
      row: null,
      column: null,
      message:
        skippedNumbers.length > 0
          ? "Every account number in the file is skipped, so this upload would record nothing."
          : "No row of the file states a position, so this upload would record nothing.",
    });
  }

  return { accounts, problems, unknownNumbers, skippedNumbers };
}
