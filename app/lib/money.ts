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
 * What a statement wrote in a number column, read as one of three things: a
 * decimal string, a deliberate absence, or nonsense.
 *
 * Three outcomes rather than two because absence and nonsense must not be
 * conflated. `n/a`, `--`, an em dash, a lone `-` and the empty string are how
 * real exports write "the statement did not say" — each becomes `absent`, and
 * the caller stores a null, never a zero: a zero cost basis reports a fake gain
 * equal to the whole untracked position (§8.2, and 0001's "no default at any
 * layer"). Anything else non-numeric is `unparseable`, which the caller reports
 * against the row and column it came from rather than silently dropping — a
 * disclaimer line under a mapped column is a thing to name, not to swallow.
 */
export type NormalisedFigure =
  | { kind: "figure"; value: string }
  | { kind: "absent" }
  | { kind: "unparseable" };

/** The spellings of "the statement did not say", lowercased. U+2014 is the em dash. */
const ABSENT = new Set(["", "-", "--", "—", "n/a"]);

/**
 * Normalise one cell of a statement's number column — `$1,234.56`,
 * `(1,234.56)`, `12.5%`, `n/a` — to a decimal string, an absence, or a report
 * of nonsense (§5.3, spec 0004).
 *
 * Lives here beside the digit-level primitives because the value never passes
 * through a JavaScript number: the digits the file wrote are the digits
 * returned, with only the dressing removed. `input.server.ts` has a sibling in
 * `bareDecimal` for what a *person types into a box*; this one reads what a
 * *brokerage wrote into a file*, and the two differ where their sources do —
 * a form never contains `(1,234.56)` or a trailing `%`, and a file's `n/a` is
 * data rather than an input error.
 *
 * The shapes handled, each a checklist item in spec 0004 step 02:
 *
 * - thousands separators (comma, space, U+00A0, U+2009) removed — but only
 *   where they genuinely group thousands: a leading group of one to three
 *   digits, every later group exactly three, none right of the decimal point.
 *   Anything else — `1.234,56`, `1 234,56`, `12,34`, `1,23,456` — is European
 *   decimal notation or a shredded row, and stripping the separators would
 *   misread it a thousandfold. Refused instead: a refusal is safe because it
 *   is named to a row; a misread is not
 * - a leading `$` — after an optional sign, whitespace or the opening
 *   parenthesis — removed; a `$` anywhere else is not a way anyone writes
 *   money, so `12$34` is refused rather than read as `1234`
 * - `(1,234.56)` is negative — accounting notation, common on Schwab exports
 * - a trailing `%` removed with the value returned unscaled; what a percent
 *   *means* is the caller's question, and answering it here would be arithmetic
 * - U+2212, the true minus `format.ts` prints, converted to the ASCII hyphen —
 *   the same conversion `signedQuantity` makes for the same reason
 * - a negative zero loses its sign, as everywhere else: a debt of nothing is
 *   not a thing to write as though it were something
 */
export function normaliseFigure(cell: string): NormalisedFigure {
  const trimmed = cell.trim().replace(/−/g, "-");

  if (ABSENT.has(trimmed.toLowerCase())) return { kind: "absent" };

  const parenthesised = /^\((.*)\)$/.exec(trimmed);
  let value = (parenthesised?.[1] ?? trimmed).trim();

  let negative = parenthesised !== null;

  // A leading sign, tolerated on either side of the currency mark. Both
  // negative notations at once — `(-1)` — is not a figure anyone wrote on
  // purpose.
  const leadingSign = (): "unparseable" | undefined => {
    if (value.startsWith("+") || value.startsWith("-")) {
      if (value.startsWith("-")) {
        if (negative) return "unparseable";
        negative = true;
      }
      value = value.slice(1).trimStart();
    }
    return undefined;
  };

  if (leadingSign() === "unparseable") return { kind: "unparseable" };
  if (value.startsWith("$")) value = value.slice(1).trimStart();
  if (leadingSign() === "unparseable") return { kind: "unparseable" };

  // The currency mark is leading dressing or it is nothing: `12$34` refused,
  // never read as `1234`.
  if (value.includes("$")) return { kind: "unparseable" };

  value = value.replace(/%$/, "");

  // Separators are removed only once they are proven to group thousands.
  // `\s` covers U+00A0 and the thin space some brokerages group with.
  if (/[\s,]/.test(value)) {
    const point = value.indexOf(".");
    const integer = point === -1 ? value : value.slice(0, point);
    const fraction = point === -1 ? null : value.slice(point + 1);

    // A separator right of the decimal point cannot be grouping thousands —
    // `1.234,56` is a European decimal, and 1.23456 is a thousandfold misread.
    if (fraction !== null && /[\s,]/.test(fraction)) return { kind: "unparseable" };

    const groups = integer.split(/[\s,]/);
    const wellGrouped =
      /^\d{1,3}$/.test(groups[0] ?? "") &&
      groups.slice(1).every((group) => /^\d{3}$/.test(group));
    if (!wellGrouped) return { kind: "unparseable" };

    value = fraction === null ? groups.join("") : `${groups.join("")}.${fraction}`;
  }

  // ".50" and "50." are unambiguous and completed; a bare "." is neither, and
  // the lookarounds keep it from composing into an accidental zero — the same
  // guard `input.server.ts` documents at length.
  value = value.replace(/^\.(?=\d)/, "0.").replace(/(?<=\d)\.$/, "");

  if (!/^\d+(\.\d+)?$/.test(value)) return { kind: "unparseable" };

  const zero = /^0+(\.0+)?$/.test(value);

  return { kind: "figure", value: negative && !zero ? `-${value}` : value };
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
