// Both sides of the bundle need the one rule: the instruments step's action and the alias
// screen's rows.

// HTML form serialisation turns a lone LF/CR into CRLF, so a quoted multi-line cell never posts
// back byte-exact.
export function lineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

// Byte-exact except line endings. Comparison only — what is stored is the file's own bytes.
export function sameRawStrings(a: string, b: string): boolean {
  return lineEndings(a) === lineEndings(b);
}
