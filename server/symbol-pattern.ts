/**
 * The symbol pattern, once. Spec 0018 §2.1 decides which check binds: the
 * worker's, checked before any URL is built, because the worker is the
 * component actually talking to Yahoo and the app's own process could be the
 * one compromised. The app's copy (imported from here too, from the
 * cutover in ticket 06) is a courtesy — it saves a round trip and keeps a
 * stored symbol the app's own rule permits (length <= 40, any character,
 * `instrument-resolution.server.ts:314-315`) from costing a whole call — but
 * it is not the guard anything security-sensitive rests on.
 *
 * No imports: this file is the only copy, shared by a worker whose whole
 * closure is `server/`, `zod` and `yahoo-finance2`.
 *
 * A bare `..` passes: dots are in the character class below, and `..` alone
 * is 1-15 of them. `yahoo-finance2` concatenates the symbol straight onto
 * `chart`'s URL path — `modules/chart.js`'s
 * `"https://${YF_QUERY_HOST}/v8/finance/chart/" + symbol` — so this
 * normalises one path segment up: still the same `${YF_QUERY_HOST}` host,
 * never a different one, and no scheme change either. No boundary is crossed.
 * `tests/symbol-pattern.test.ts` states this rather than treating it as a
 * gap for the pattern to close.
 */

/** 1-15 characters: letters, digits, and the punctuation Yahoo's own tickers use. */
export const SYMBOL_PATTERN = /^[A-Za-z0-9.^=-]{1,15}$/;

/**
 * A string check *before* the pattern is applied: `RegExp.test(null)`
 * coerces its argument to the string `"null"`, which matches the pattern —
 * so a bare `.test()` would wave through exactly the value a JSON body gone
 * wrong is likeliest to hand it.
 */
export function isWellFormedSymbol(value: unknown): value is string {
  return typeof value === "string" && SYMBOL_PATTERN.test(value);
}
