/**
 * Bytes to rows of strings — the half of the parser that reads what a
 * brokerage actually exported, before `statement.ts` decides what it means
 * (DESIGN.md §5.3, spec 0004). Hand-rolled: RFC 4180 quoting is the easy
 * sixty lines, and the tolerance a real export needs — preambles, footers,
 * sniffed delimiters, ragged rows — has to live in our code either way; the
 * seam is this one module, so falling back to `csv-parse` is a cheap reversal.
 *
 * Two load-bearing properties. **Never throws on content**: malformed UTF-8
 * becomes replacement characters, an unterminated quote runs to the end of
 * the file, a stray quote is kept as a character — the refusal a reader sees
 * is a sentence about their statement, never a stack trace. **Row indices are
 * stable**: blank rows are kept, because a saved mapping's `headerRow`
 * indexes these rows and dropping one would shift every mapping made after
 * it; only the phantom row a trailing newline implies is suppressed.
 */

/** The three delimiters real exports use, and the only ones sniffed between. */
export type Delimiter = "," | ";" | "\t";

const DELIMITERS: ReadonlyArray<Delimiter> = [",", ";", "\t"];

/** The file as rows of cells, and the delimiter that produced them. */
export type CsvRead = {
  rows: string[][];
  delimiter: Delimiter;
};

/**
 * Tokenise against one known delimiter. RFC 4180 quoting: a field opening with
 * a quote may contain the delimiter, a newline and a doubled quote; a quote
 * anywhere else is an ordinary character, kept rather than refused.
 */
function parseWith(text: string, delimiter: Delimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // Whether the current row has seen any character at all — what separates a
  // final row worth emitting from the phantom a trailing newline implies.
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

/**
 * How consistently one delimiter divides the file: the modal column count and
 * how many rows agree with it. Blank rows say nothing about the delimiter and
 * are left out of the vote.
 */
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

/**
 * The file's rows: leading BOM stripped, CRLF/LF/bare-CR all row breaks, the
 * delimiter sniffed when not forced. The sniff picks whichever delimiter
 * yields the most consistent column count across rows — not occurrences on
 * line one, which a preamble sentence full of commas would win. Never-splits
 * ranks below any that splits; then more agreeing rows, then more columns,
 * then comma over semicolon over tab — deterministic on a file that supports
 * two readings. The forced form exists for a saved mapping: re-reading the
 * same bytes must not depend on the sniff reaching the same verdict twice.
 */
export function readCsv(bytes: Uint8Array, delimiter?: Delimiter): CsvRead {
  // TextDecoder removes a leading BOM and replaces malformed sequences rather
  // than throwing — both halves of "never throws on content" for the decode.
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

  // Unreachable with a non-empty DELIMITERS list; the fallback keeps the
  // signature honest without a non-null assertion.
  return best ?? { rows: [], delimiter: "," };
}

/** Every cell blank, or no cells at all — a spacer line, not data. */
function isBlank(cells: ReadonlyArray<string>): boolean {
  return cells.every((cell) => cell.trim() === "");
}

/**
 * Could this row be a header: at least one cell, none blank, no two alike.
 * A data row often qualifies too — plausibility is a mechanical screen, and
 * choosing among the plausible is `defaultHeaderRow`'s job or the reader's.
 */
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

/**
 * The plausible header rows, as indices in file order. Never empty for a
 * non-empty file: when no row passes the screen, the fallback is every
 * non-blank row, then the first row — a degenerate file still returns
 * something for the reader to pick from; nothing would leave step 03 with no
 * control to draw.
 */
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

/**
 * Every row the header-row select offers: candidates first, then every other
 * non-blank row, then the row currently on screen whatever detection thinks.
 * The widening exists for a real header that fails the candidate screen —
 * plainly one with two same-named columns, which no-two-alike refuses. Such a
 * header is still the header, and a select that cannot offer it strands the
 * file; name-based mapping resolves a duplicate to its first occurrence, and
 * the fingerprint pins the exact header, so the resolution cannot move.
 */
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

/**
 * The header row to preselect: the first candidate whose column count matches
 * the majority of the rows below it — what skips a preamble not shaped like
 * the data under it. When none matches, the first candidate stands in so the
 * screen always opens on something; `null` only for a file with no rows.
 */
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
