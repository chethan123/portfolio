/**
 * Exact decimal arithmetic on the money strings the query layer returns — the
 * one place that adds, divides or compares a figure outside SQL (§4.1). The
 * string is the value, not a rendering of it: the default coercion to a JS
 * number silently rounds, and cent-level drift on a six-figure balance
 * surfaces as two dashboards disagreeing. Every function works on `BigInt`
 * counts of the last decimal place — exact at any magnitude, at a scale
 * written down here rather than inferred from a driver.
 *
 * **Why its own module**: these were private to `allocation.ts` so "money
 * arithmetic in JavaScript" stayed exactly one module wide; Holdings needed
 * the same primitives, and a copy is a second implementation of rounding —
 * the failure the invariant exists to prevent. Moving them keeps it
 * structural: literally one module, not a comment asking to be honoured.
 *
 * `format.ts` still refuses to compute, and nothing here formats.
 */

/** `numeric(20, 4)`, the scale every money column is stored at (§4.1). */
export const MONEY_SCALE = 4;

/** `numeric(20, 8)`, the scale `holding.quantity` is stored at (§4.1). */
export const QUANTITY_SCALE = 8;

/**
 * Six places is 0.0001% — finer than any screen renders, so display rounding
 * never made two shares look equal; wide enough that a real portfolio's
 * positive parts still sum to 1.000000 rather than a hair off it.
 */
export const SHARE_SCALE = 6;

const FIVE = "5".charCodeAt(0);

/**
 * `"-8000.5000"` at scale 4 → `-80005000n`: the value in units of its last
 * place, the form it adds in without losing anything. A view value already
 * carries exactly `scale` places; the rounding is for a caller handing over
 * something finer — half away from zero, matching `format.ts`, so a total and
 * its label cannot round in two directions.
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
 * `-80005000n` → `"-8000.5000"` — the inverse, and the only place a total's
 * digits are reassembled. No negative zero to guard: `BigInt` has none, so a
 * group that nets exactly flat renders `"0.0000"`.
 */
export function render(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const point = digits.length - scale;

  return `${negative ? "-" : ""}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * `numerator / denominator` to `scale` places, half away from zero: integer
 * division keeping the remainder, with `remainder * 2 >= denominator` asking
 * "is the dropped part at least half a place" without forming a fraction.
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
 * Total a column of money, skipping nulls and reporting how many rows had a
 * figure at all. Skipping is what SQL's `sum()` does; counting anyway is what
 * stops the omission being silent — an unknown coerced to zero reports a
 * partial answer as complete, and a null cost basis as a fake gain equal to
 * the whole untracked position (§8.2).
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
 * What a statement wrote in a number column: a decimal string, a deliberate
 * absence, or nonsense. Three outcomes because absence and nonsense must not
 * conflate — `n/a`, `--`, an em dash, a lone `-` and the empty string are how
 * real exports write "the statement did not say", each stored as null, never
 * zero (a zero basis is a fake gain, §8.2). Anything else non-numeric is
 * `unparseable`, reported against its row and column rather than swallowed —
 * a disclaimer under a mapped column is a thing to name.
 */
export type NormalisedFigure =
  | { kind: "figure"; value: string }
  | { kind: "absent" }
  | { kind: "unparseable" };

/** The spellings of "the statement did not say", lowercased. U+2014 is the em dash. */
const ABSENT = new Set(["", "-", "--", "—", "n/a"]);

/**
 * Normalise one statement cell — `$1,234.56`, `(1,234.56)`, `12.5%`, `n/a` —
 * to a decimal string, an absence, or a report of nonsense (§5.3, spec 0004).
 * The value never passes through a JS number. `input.server.ts`'s
 * `bareDecimal` is the sibling for what a *person types*; this reads what a
 * *brokerage wrote*, and the two differ where their sources do — a form never
 * contains `(1,234.56)`, and a file's `n/a` is data, not an input error.
 *
 * The shapes (spec 0004 step 02): thousands separators removed only where
 * they genuinely group thousands (leading group of 1–3 digits, later groups
 * exactly 3, none right of the point) — `1.234,56` and `12,34` are European
 * notation or a shredded row, refused rather than misread a thousandfold; a
 * leading `$` removed and a `$` anywhere else refused (`12$34` is never
 * `1234`); `(1,234.56)` is negative (accounting notation); a trailing `%`
 * removed with the value unscaled — what a percent *means* is the caller's
 * question; U+2212 converted to the ASCII hyphen (`signedQuantity`'s
 * conversion); a negative zero loses its sign, as everywhere else.
 */
export function normaliseFigure(cell: string): NormalisedFigure {
  const trimmed = cell.trim().replace(/−/g, "-");

  if (ABSENT.has(trimmed.toLowerCase())) return { kind: "absent" };

  const parenthesised = /^\((.*)\)$/.exec(trimmed);
  let value = (parenthesised?.[1] ?? trimmed).trim();

  let negative = parenthesised !== null;

  // A leading sign, tolerated on either side of the currency mark. Both
  // negative notations at once — `(-1)` — is not a figure anyone meant.
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

  // ".50" and "50." are completed; a bare "." is neither, and the lookarounds
  // keep it from composing into an accidental zero (`input.server.ts`'s guard).
  value = value.replace(/^\.(?=\d)/, "0.").replace(/(?<=\d)\.$/, "");

  if (!/^\d+(\.\d+)?$/.test(value)) return { kind: "unparseable" };

  const zero = /^0+(\.0+)?$/.test(value);

  return { kind: "figure", value: negative && !zero ? `-${value}` : value };
}

/**
 * Order two decimal strings ascending, nulls last in either direction. Pass
 * the column's stored scale so `145.23400000` is not truncated on the way in.
 *
 * Not a string compare (which sorts "9.0000" above "10.0000"), and not
 * `toPlotValue` — the one sanctioned float, for chart geometry, where a pixel
 * may be approximate and a sort key cannot. Nulls sort last, not as zero, for
 * the reason they render as a dash rather than `$0.00`: an unpriced holding
 * is not a worthless one.
 */
export function compareDecimal(a: string | null, b: string | null, scale: number): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;

  const left = toUnits(a, scale);
  const right = toUnits(b, scale);

  return left === right ? 0 : left < right ? -1 : 1;
}
