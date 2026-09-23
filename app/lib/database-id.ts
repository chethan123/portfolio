// Magnitude, not digit count: leading zeroes are valid, values past bigint are not.
const MAX_BIGINT = 9223372036854775807n;

const DIGITS = /^\d+$/;

export function couldBeId(id: string): boolean {
  return DIGITS.test(id) && BigInt(id) <= MAX_BIGINT;
}

// Never Number() (NaN breaks sort's total order; past 2^53 it rounds). Digit ids first, by length
// then code-unit compare — not localeCompare, whose ICU collation varies by deployment. Numeric
// order only without leading zeros: the driver never sends them, owner-filter.ts strips them.
export function compareIds(a: string, b: string): number {
  const aNumeric = DIGITS.test(a);
  const bNumeric = DIGITS.test(b);

  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  if (aNumeric && a.length !== b.length) return a.length - b.length;

  return a < b ? -1 : a > b ? 1 : 0;
}
