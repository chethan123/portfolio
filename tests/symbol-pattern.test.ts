/**
 * The one copy of the symbol pattern, and the check the worker makes before building a URL
 * (spec 0018 §2.1's binding one — the app's own call just saves a round trip). Tested
 * directly rather than through the worker's 400s, since the surrounding z.string() there
 * answers first for anything that isn't a string, leaving the guard below unexercised.
 */
import { describe, expect, it } from "vitest";

import { SYMBOL_PATTERN, isWellFormedSymbol } from "../server/symbol-pattern.ts";

describe("what the worker will build a URL from", () => {
  it.each([
    ["VTI", "a plain ticker"],
    ["BRK-B", "a hyphenated class"],
    ["VWRL.L", "a dotted exchange suffix"],
    ["^GSPC", "an index, which carries a caret"],
    ["EURUSD=X", "a currency pair, which carries an equals sign"],
    ["A", "one character, the shortest allowed"],
    ["123456789012345", "fifteen characters, the longest allowed"],
  ])("accepts %s — %s", (symbol) => {
    expect(isWellFormedSymbol(symbol)).toBe(true);
  });

  it("accepts a bare .., which only climbs one path segment inside the library's own URL, same host (server/symbol-pattern.ts header)", () => {
    // not a hole: dots are in the character class on purpose; a slash (which crosses a host/scheme boundary) is refused above.
    expect(isWellFormedSymbol("..")).toBe(true);
  });

  it.each([
    ["1234567890123456", "sixteen characters, one past the bound"],
    ["", "empty, which has no symbol to fetch"],
    ["BRK/B", "a slash, which would climb the URL's path"],
    ["VT I", "a space"],
    ["VTI\n", "a trailing newline"],
    ["VT%49", "a percent escape"],
    ["VTI?a=b", "a query string"],
    ["VTI&b", "an ampersand, which would add a parameter"],
    ["VTI:1", "a colon"],
    ["VTI_A", "an underscore, which the class does not carry"],
  ])("refuses %s — %s", (symbol) => {
    expect(isWellFormedSymbol(symbol)).toBe(false);
  });

  it.each([[null], [undefined], [42], [{}], [["VTI"]], [true]])(
    "refuses %s, which is not a string at all",
    (value) => {
      // why the guard isn't just the pattern: RegExp.test coerces, and SYMBOL_PATTERN.test(null) matches the string "null"
      expect(isWellFormedSymbol(value)).toBe(false);
    },
  );

  it("would have matched the coerced spelling of null without the string check", () => {
    // states the trap the guard exists for, so a later reader doesn't simplify it away
    expect(SYMBOL_PATTERN.test(null as unknown as string)).toBe(true);
  });
});
