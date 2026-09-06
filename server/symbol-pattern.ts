// Spec 0018 §2.1: the worker's check binds; the app's copy is a courtesy.
// No imports — worker's closure is `server/`, zod, yahoo-finance2 only.
// A bare `..` passes: normalises one path segment on the same Yahoo host, no boundary crossed.

/** 1-15 characters: letters, digits, and the punctuation Yahoo's own tickers use. */
export const SYMBOL_PATTERN = /^[A-Za-z0-9.^=-]{1,15}$/;

/** `RegExp.test(null)` coerces to the string `"null"`, which matches — hence the typeof. */
export function isWellFormedSymbol(value: unknown): value is string {
  return typeof value === "string" && SYMBOL_PATTERN.test(value);
}
