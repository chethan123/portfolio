/**
 * Exact decimal arithmetic on the money strings the query layer returns — the
 * one place in the application that adds, divides or compares a figure outside
 * SQL (DESIGN.md §4.1).
 *
 * Money crosses the driver boundary as a decimal *string* on purpose: the
 * default coercion to a JS number silently rounds, and cent-level drift on a
 * six-figure balance surfaces as two dashboards disagreeing about net worth.
 * That makes the string the value, not a rendering of it, and it means anything
 * that wants to total a column has to read the digits.
 *
 * These functions read them. Every one works on `BigInt` counts of the last
 * decimal place — exact at any magnitude, unlike the float §4.1 keeps money out
 * of, and exact at a scale that is written down here rather than inferred from
 * whatever a driver happened to hand back.
 *
 * **Why this is its own module.** It was private to `allocation.ts`, whose
 * header gave the reason: so that "money arithmetic in JavaScript" stays
 * exactly one module wide. Holdings needs the same primitives for its subtotals
 * and for sorting a money column, and the choice was to copy them or to move
 * them. A copy is a second implementation of rounding, which is the failure
 * that invariant exists to prevent. Moving them keeps it to one implementation
 * and makes it structural — there is now literally one module, rather than a
 * comment asking the next author to honour one.
 *
 * `format.ts` still refuses to compute, and nothing here formats. The division
 * of labour is unchanged: this module does the arithmetic, `format.ts` renders
 * the result, and neither does the other's job.
 */

/** `numeric(20, 4)`, the scale every money column is stored at (§4.1). */
export const MONEY_SCALE = 4;

/** `numeric(20, 8)`, the scale `holding.quantity` is stored at (§4.1). */
export const QUANTITY_SCALE = 8;

/**
 * Six places on a fraction is 0.0001% as a percentage — far finer than any
 * screen renders, so rounding for display is never what made two shares look
 * equal. Wide enough, too, that the positive parts of a real portfolio still
 * sum to 1.000000 rather than to something a hair off it.
 */
export const SHARE_SCALE = 6;

const FIVE = "5".charCodeAt(0);

/**
 * `"-8000.5000"` at scale 4 → `-80005000n`: the value counted in units of its
 * last place, which is the form it can be added in without losing anything.
 *
 * The digits are read as digits; `BigInt` then adds them exactly however many
 * there are. A value out of the view already carries exactly `scale` places, so
 * the rounding below is for a caller that hands over something finer — half
 * away from zero, matching what `format.ts` rounds a displayed figure by, so a
 * total and its label cannot round in two directions.
 */
export function toUnits(decimal: string, scale: number): bigint {
  const trimmed = decimal.trim();
  const negative = trimmed.startsWith("-");
  const unsigned = negative || trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  const [int = "", frac = ""] = unsigned.split(".");
  const digits = `${int || "0"}${frac.slice(0, scale).padEnd(scale, "0")}`;
  const units = BigInt(digits) + (frac.charCodeAt(scale) >= FIVE ? 1n : 0n);

  return negative ? -units : units;
}

/**
 * `-80005000n` → `"-8000.5000"`. The inverse, and the only place a total's
 * digits are reassembled.
 *
 * There is no negative zero to guard against here the way `format.ts` has to:
 * `BigInt` has none, so a group that nets exactly flat renders `"0.0000"`.
 */
export function render(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const point = digits.length - scale;

  return `${negative ? "-" : ""}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * `numerator / denominator`, to `scale` places, rounded half away from zero.
 *
 * Integer division that keeps the remainder rather than discarding it: the
 * comparison is `remainder * 2 >= denominator`, which is "is the part we are
 * dropping at least half a place", asked without ever forming a fraction.
 */
export function divide(numerator: bigint, denominator: bigint, scale: number): bigint {
  const scaled = numerator * 10n ** BigInt(scale);
  const negative = (scaled < 0n) !== (denominator < 0n);
  const top = scaled < 0n ? -scaled : scaled;
  const bottom = denominator < 0n ? -denominator : denominator;
  const quotient = top / bottom + ((top % bottom) * 2n >= bottom ? 1n : 0n);

  return negative ? -quotient : quotient;
}

/**
 * Total a column of money, skipping the nulls and reporting how many there
 * were — `{ amount, known, total }` where `known` counted the rows that had a
 * figure at all.
 *
 * Skipping nulls is what `sum(value)` does in SQL. Counting them anyway is what
 * stops the omission being silent: an unknown coerced to zero reports a partial
 * answer as a complete one, and on a null cost basis it reports a fake gain
 * equal to the entire untracked position (§8.2).
 */
export function sumMoney(values: ReadonlyArray<string | null>): {
  amount: bigint;
  known: number;
  total: number;
} {
  let amount = 0n;
  let known = 0;

  for (const value of values) {
    if (value === null) continue;
    amount += toUnits(value, MONEY_SCALE);
    known += 1;
  }

  return { amount, known, total: values.length };
}

/**
 * Order two decimal strings, ascending, with the nulls last in either
 * direction. Pass the scale the column is stored at — {@link MONEY_SCALE} for a
 * value, {@link QUANTITY_SCALE} for a quantity — so that a share count of
 * `145.23400000` is not truncated on its way into the comparison.
 *
 * Two things this is not. It is not a string compare, which sorts `"9.0000"`
 * above `"10.0000"` and would put the ninth-largest position at the top of a
 * column sorted by value. And it is not `toPlotValue`, which `format.ts`
 * reserves for chart geometry and calls the one sanctioned float — a pixel
 * coordinate can afford to be approximate and a sort key cannot, because two
 * positions a hundredth of a cent apart would swap places between renders.
 *
 * Nulls sort last rather than as zero for the same reason they render as an em
 * dash rather than as `$0.00`: an unpriced holding is not a worthless one, and
 * sorting it among the near-zero rows would say that it is.
 */
export function compareDecimal(a: string | null, b: string | null, scale: number): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;

  const left = toUnits(a, scale);
  const right = toUnits(b, scale);

  return left === right ? 0 : left < right ? -1 : 1;
}
