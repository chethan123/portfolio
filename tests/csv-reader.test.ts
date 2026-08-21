/**
 * The reader that survives a real brokerage export (spec 0004, step 02).
 *
 * Everything here is about the two properties the ingest flow leans on: the
 * reader never throws on content, and row indices are stable — a saved
 * mapping's `headerRow` points into these rows, so a dropped blank line would
 * silently shift every mapping made after it.
 *
 * The fixtures are shaped like the real thing — preambles, footers, quoted
 * descriptions — because the value of a pure parser is that every awkward file
 * in existence becomes a test rather than a bug found with a household's real
 * statement in hand.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { candidateHeaderRows, defaultHeaderRow, headerRowChoices, readCsv } from "~/lib/csv";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const fixture = (name: string): Uint8Array =>
  readFileSync(fileURLToPath(new URL(`./fixtures/statements/${name}`, import.meta.url)));

describe("readCsv", () => {
  it("strips a leading UTF-8 BOM so it never reaches a cell", () => {
    const { rows } = readCsv(bytes("\uFEFFSymbol,Quantity\nAAPL,50"));

    expect(rows[0]).toEqual(["Symbol", "Quantity"]);
  });

  it("parses CRLF, LF and bare CR line endings alike", () => {
    const { rows } = readCsv(bytes("a,b\r\nc,d\re,f\ng,h"));

    expect(rows).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
      ["g", "h"],
    ]);
  });

  it("keeps a quoted field's delimiter, newline and doubled quote", () => {
    const { rows } = readCsv(
      bytes('"FIDELITY 500 INDEX FUND, PREMIUM CLASS",84.512\n"say ""hi""","line one\nline two"'),
    );

    expect(rows).toEqual([
      ["FIDELITY 500 INDEX FUND, PREMIUM CLASS", "84.512"],
      ['say "hi"', "line one\nline two"],
    ]);
  });

  it("sniffs the delimiter by column-count consistency, not by counting line one", () => {
    // The preamble sentence holds two commas and no semicolon, so counting
    // occurrences on line one picks comma — and shreds every data row.
    const { rows, delimiter } = readCsv(
      bytes("Report, generated, 2026\nSymbol;Qty\nAAPL;50\nMSFT;25"),
    );

    expect(delimiter).toBe(";");
    expect(rows[1]).toEqual(["Symbol", "Qty"]);
    expect(rows[2]).toEqual(["AAPL", "50"]);
  });

  it("sniffs a tab-delimited file", () => {
    const { rows, delimiter } = readCsv(bytes("Symbol\tQuantity\nAAPL\t50"));

    expect(delimiter).toBe("\t");
    expect(rows).toEqual([
      ["Symbol", "Quantity"],
      ["AAPL", "50"],
    ]);
  });

  it("keeps ragged rows as they are, short or long", () => {
    // The mapping step decides whether a row is usable; padding would invent
    // cells and refusing would throw away a parseable file over its footer.
    const { rows } = readCsv(bytes("a,b,c\nonly one\nx,y\np,q,r,s"));

    expect(rows).toEqual([["a", "b", "c"], ["only one"], ["x", "y"], ["p", "q", "r", "s"]]);
  });

  it("preserves blank rows so headerRow stays a stable index", () => {
    const { rows } = readCsv(bytes("Account Summary\n\nSymbol,Qty\nAAPL,50"));

    expect(rows).toHaveLength(4);
    expect(rows[1]).toEqual([""]);
    expect(rows[2]).toEqual(["Symbol", "Qty"]);
  });

  it("does not produce a phantom final row from a trailing newline", () => {
    expect(readCsv(bytes("a,b\nc,d\n")).rows).toHaveLength(2);
    expect(readCsv(bytes("a,b\r\n")).rows).toHaveLength(1);
    // A genuinely blank last line — two newlines — is a row, and kept.
    expect(readCsv(bytes("a,b\n\n")).rows).toEqual([["a", "b"], [""]]);
  });

  it("never throws on content, whatever the bytes are", () => {
    const garbage = new Uint8Array([0xff, 0xfe, 0x00, 0x81, 0xc0, 0x2c, 0x41]);

    expect(() => readCsv(garbage)).not.toThrow();
    expect(readCsv(garbage).rows.length).toBeGreaterThan(0);

    // An unterminated quote runs to the end of the file rather than raising.
    expect(readCsv(bytes('"unterminated, quote\nx,y')).rows).toEqual([
      ["unterminated, quote\nx,y"],
    ]);

    // A stray quote mid-field is an ordinary character.
    expect(readCsv(bytes('5" pipe,10')).rows).toEqual([['5" pipe', "10"]]);
  });

  it("returns no rows for an empty file", () => {
    expect(readCsv(new Uint8Array(0)).rows).toEqual([]);
  });

  it("honours a forced delimiter instead of sniffing", () => {
    // A saved mapping records the delimiter it was built against; re-reading
    // the bytes must not depend on the sniff reaching the same verdict twice.
    const { rows, delimiter } = readCsv(bytes("a;b\nc;d"), ",");

    expect(delimiter).toBe(",");
    expect(rows).toEqual([["a;b"], ["c;d"]]);
  });

  it("reads the semicolon-delimited, CRLF, BOM-prefixed fixture", () => {
    const { rows, delimiter } = readCsv(fixture("semicolon.csv"));

    expect(delimiter).toBe(";");
    // The BOM never reaches the first cell.
    expect(rows[0]?.[0]).toBe("Portefeuille");
    expect(rows[1]).toEqual(["ISIN", "Naam", "Aantal", "Koers", "Waarde"]);
    expect(rows).toHaveLength(4);
  });
});

describe("candidateHeaderRows and defaultHeaderRow", () => {
  it("skips a preamble and a blank line to default to the real header", () => {
    const { rows } = readCsv(fixture("fidelity.csv"));

    // In file order, so the mapping screen can offer them as written; the
    // blank line at index 1 is never a candidate.
    const candidates = candidateHeaderRows(rows);
    expect(candidates[0]).toBe(0);
    expect(candidates).toContain(2);
    expect(candidates).not.toContain(1);

    // The preamble is one cell wide and the data below is nine, which is what
    // rules it out; the header matches the rows under it.
    expect(defaultHeaderRow(rows)).toBe(2);
  });

  it("defaults past a quoted one-cell preamble on the Schwab-shaped fixture", () => {
    expect(defaultHeaderRow(readCsv(fixture("schwab.csv")).rows)).toBe(2);
  });

  it("defaults to the first row when the file starts with its header", () => {
    expect(defaultHeaderRow(readCsv(fixture("401k.csv")).rows)).toBe(0);
    expect(defaultHeaderRow(readCsv(fixture("semicolon.csv")).rows)).toBe(1);
  });

  it("rules out a row with a blank or repeated cell", () => {
    const rows = [
      ["x", "x"],
      ["a", ""],
      ["Symbol", "Qty"],
      ["AAPL", "50"],
    ];

    expect(candidateHeaderRows(rows)).toEqual([2, 3]);
    expect(defaultHeaderRow(rows)).toBe(2);
  });

  it("still returns something for a file that is all preamble", () => {
    const { rows } = readCsv(bytes("Account Summary\nPrepared for the household\n2026-07-31"));

    // Every row is a plausible candidate; the screen lets the reader pick.
    expect(candidateHeaderRows(rows)).toEqual([0, 1, 2]);
    expect(defaultHeaderRow(rows)).toBe(0);
  });

  it("still returns something for a file of blank lines", () => {
    const { rows } = readCsv(bytes("\n\n"));

    expect(candidateHeaderRows(rows)).toEqual([0]);
    expect(defaultHeaderRow(rows)).toBe(0);
  });

  it("returns nothing only for a file with no rows at all", () => {
    expect(candidateHeaderRows([])).toEqual([]);
    expect(defaultHeaderRow([])).toBeNull();
  });
});

describe("headerRowChoices", () => {
  it("offers a real header that fails candidate detection, after the candidates", () => {
    // Two same-named columns rule row 0 out as a candidate, and a data row
    // often qualifies instead — but the duplicated header is still the
    // header, and a select that cannot offer it strands the file. Name-based
    // mapping resolves the duplicated name to its first occurrence.
    const rows = [
      ["Symbol", "Value", "Value"],
      ["AAPL", "50", "8533.00"],
      ["MSFT", "25", "9875.50"],
    ];

    expect(candidateHeaderRows(rows)).toEqual([1, 2]);
    expect(headerRowChoices(rows, 1)).toEqual([1, 2, 0]);
  });

  it("keeps blank rows out and the row on screen in, whatever detection thinks", () => {
    const rows = [
      ["Symbol", "Qty"],
      ["", ""],
      ["AAPL", "50"],
    ];

    // The blank spacer is never offered; the candidates already cover the
    // rest, so nothing is appended.
    expect(headerRowChoices(rows, 0)).toEqual([0, 2]);
    // A requested row outside the list — a stale ?header= — still renders as
    // chosen rather than vanishing from its own control.
    expect(headerRowChoices(rows, 1)).toEqual([1, 0, 2]);
  });
});
