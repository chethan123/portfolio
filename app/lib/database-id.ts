// Magnitude, not digit count: leading zeroes are valid, values past bigint are not.
const MAX_BIGINT = 9223372036854775807n;

export function couldBeId(id: string): boolean {
  return /^\d+$/.test(id) && BigInt(id) <= MAX_BIGINT;
}
