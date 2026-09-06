// Bytes to rows of strings, before statement.ts decides what they mean (DESIGN.md §5.3,
// spec 0004). Hand-rolled for real-export tolerance (preambles, sniffed delimiters, ragged
// rows) RFC 4180 alone doesn't give. Two invariants: never throws on content (malformed
// UTF-8/unterminated quotes degrade gracefully, never a stack trace), and row indices stay
// stable (blank rows kept — a saved mapping's headerRow indexes these rows by position).

export type Delimiter = "," | ";" | "\t";

const DELIMITERS: ReadonlyArray<Delimiter> = [",", ";", "\t"];

export type CsvRead = {
  rows: string[][];
  delimiter: Delimiter;
};

// RFC 4180 quoting: a quoted field may contain the delimiter, a newline, a doubled quote;
// a quote elsewhere is an ordinary character.
function parseWith(text: string, delimiter: Delimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // Has the current row seen a character? Separates a real final row from a
  // trailing newline's phantom one.
  let started = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === "") {
      inQuotes = true;
      started = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
      started = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      started = false;
    } else {
      field += ch;
      started = true;
    }
  }

  if (started) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

// Modal column count and how many rows agree with it; blank rows don't vote.
function consistency(rows: string[][]): { agreeing: number; width: number } {
  const counts = new Map<number, number>();

  for (const cells of rows) {
    if (cells.length === 1 && (cells[0] ?? "").trim() === "") continue;
    counts.set(cells.length, (counts.get(cells.length) ?? 0) + 1);
  }

  let width = 1;
  let agreeing = 0;
  for (const [candidate, votes] of counts) {
    if (votes > agreeing || (votes === agreeing && candidate > width)) {
      agreeing = votes;
      width = candidate;
    }
  }

  return { agreeing, width };
}

// Sniffs the delimiter by most consistent column count across rows (not occurrence count
// on line one, which a prose preamble full of commas would win) — never-splits loses to
// any that splits, then more agreeing rows, more columns, then comma > semicolon > tab.
// `delimiter` forces the choice, for re-reading a saved mapping deterministically.
export function readCsv(bytes: Uint8Array, delimiter?: Delimiter): CsvRead {
  // TextDecoder strips a leading BOM and replaces malformed sequences instead of throwing.
  const text = new TextDecoder("utf-8").decode(bytes);

  if (delimiter !== undefined) return { rows: parseWith(text, delimiter), delimiter };

  let best: { delimiter: Delimiter; rows: string[][]; agreeing: number; width: number } | null =
    null;

  for (const candidate of DELIMITERS) {
    const rows = parseWith(text, candidate);
    const { agreeing, width } = consistency(rows);
    const splits = width >= 2;

    if (
      best === null ||
      (splits && best.width < 2) ||
      (splits === best.width >= 2 &&
        (agreeing > best.agreeing || (agreeing === best.agreeing && width > best.width)))
    ) {
      best = { delimiter: candidate, rows, agreeing, width };
    }
  }

  // Unreachable with a non-empty DELIMITERS; fallback avoids a non-null assertion.
  return best ?? { rows: [], delimiter: "," };
}

function isBlank(cells: ReadonlyArray<string>): boolean {
  return cells.every((cell) => cell.trim() === "");
}

// At least one cell, none blank, no two alike. A data row often qualifies too;
// choosing among candidates is defaultHeaderRow's job or the reader's.
function isCandidate(cells: ReadonlyArray<string>): boolean {
  if (cells.length === 0 || isBlank(cells)) return false;

  const seen = new Set<string>();
  for (const cell of cells) {
    const label = cell.trim();
    if (label === "" || seen.has(label)) return false;
    seen.add(label);
  }

  return true;
}

// Never empty for a non-empty file: falls back to every non-blank row, then row 0,
// so a degenerate file still leaves the reader something to pick from.
export function candidateHeaderRows(rows: ReadonlyArray<ReadonlyArray<string>>): number[] {
  const candidates: number[] = [];
  const nonBlank: number[] = [];

  for (const [index, cells] of rows.entries()) {
    if (isCandidate(cells)) candidates.push(index);
    if (!isBlank(cells)) nonBlank.push(index);
  }

  if (candidates.length > 0) return candidates;
  if (nonBlank.length > 0) return nonBlank;
  return rows.length > 0 ? [0] : [];
}

// Candidates first, then other non-blank rows, then the current row regardless — so a
// real header with two same-named columns (which isCandidate refuses) is still offered.
export function headerRowChoices(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  current: number,
): number[] {
  const candidates = candidateHeaderRows(rows);
  const offered = new Set(candidates);
  const rest: number[] = [];

  for (const [index, cells] of rows.entries()) {
    if (!offered.has(index) && !isBlank(cells)) rest.push(index);
  }

  const all = [...candidates, ...rest];
  return all.includes(current) ? all : [current, ...all];
}

// First candidate whose column count matches the majority below it, skipping a preamble
// shaped differently from the data. Falls back to the first candidate; null only for no rows.
export function defaultHeaderRow(rows: ReadonlyArray<ReadonlyArray<string>>): number | null {
  const candidates = candidateHeaderRows(rows);

  for (const index of candidates) {
    const counts = new Map<number, number>();
    for (const cells of rows.slice(index + 1)) {
      if (isBlank(cells)) continue;
      counts.set(cells.length, (counts.get(cells.length) ?? 0) + 1);
    }

    let majority = 0;
    let votes = 0;
    for (const [width, count] of counts) {
      if (count > votes) {
        votes = count;
        majority = width;
      }
    }

    if (votes > 0 && (rows[index]?.length ?? 0) === majority) return index;
  }

  return candidates[0] ?? null;
}
