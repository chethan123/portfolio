// Exact decimal arithmetic on the money strings the query layer returns (§4.1) — the one
// place outside SQL that adds, divides or compares a figure. Everything works in BigInt
// counts of the last decimal place; a JS number would round silently past 2^53.
// format.ts renders and never computes.

// numeric(20, 4), the scale every money column is stored at (§4.1).
export const MONEY_SCALE = 4;

// numeric(20, 8), the scale holding.quantity is stored at (§4.1).
export const QUANTITY_SCALE = 8;

// 0.0001% — finer than any screen renders, and wide enough that positive shares sum to 1.000000.
export const SHARE_SCALE = 6;

const FIVE = "5".charCodeAt(0);

// Rounds half away from zero (matches format.ts) when the input is finer than scale.
export function toUnits(decimal: string, scale: number): bigint {
  const trimmed = decimal.trim();
  const negative = trimmed.startsWith("-");
  const unsigned = negative || trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  const [int = "", frac = ""] = unsigned.split(".");
  const digits = `${int || "0"}${frac.slice(0, scale).padEnd(scale, "0")}`;
  const units = BigInt(digits) + (frac.charCodeAt(scale) >= FIVE ? 1n : 0n);

  return negative ? -units : units;
}

// Inverse of toUnits. No negative-zero guard needed: BigInt has none.
export function render(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const point = digits.length - scale;

  return `${negative ? "-" : ""}${digits.slice(0, point)}.${digits.slice(point)}`;
}

// Rounds half away from zero without forming a fraction: remainder*2 >= denominator
// asks whether the dropped part is at least half a place.
export function divide(numerator: bigint, denominator: bigint, scale: number): bigint {
  const scaled = numerator * 10n ** BigInt(scale);
  const negative = (scaled < 0n) !== (denominator < 0n);
  const top = scaled < 0n ? -scaled : scaled;
  const bottom = denominator < 0n ? -denominator : denominator;
  const quotient = top / bottom + ((top % bottom) * 2n >= bottom ? 1n : 0n);

  return negative ? -quotient : quotient;
}

// Skips nulls like SQL's sum(), but counts `known` so the caller can flag a partial
// total instead of silently reporting a null cost basis as zero (fake gain, §8.2).
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

// Three outcomes, not two: absence (stored null, never zero — §8.2) must not
// conflate with unparseable nonsense, which is reported rather than swallowed.
export type NormalisedFigure =
  | { kind: "figure"; value: string }
  | { kind: "absent" }
  | { kind: "unparseable" };

/** The spellings of "the statement did not say", lowercased. U+2014 is the em dash. */
const ABSENT = new Set(["", "-", "--", "—", "n/a"]);

// Normalises one statement cell ($1,234.56 / (1,234.56) / 12.5% / n/a) to a decimal
// string, absence, or unparseable (§5.3, spec 0004) — never through a JS number.
// Thousands separators accepted only where they genuinely group by 3; ambiguous
// forms like "1.234,56" (European) are refused rather than misread. Parens = negative,
// a trailing % is stripped and the value left unscaled, U+2212 read as hyphen.
export function normaliseFigure(cell: string): NormalisedFigure {
  const trimmed = cell.trim().replace(/−/g, "-");

  if (ABSENT.has(trimmed.toLowerCase())) return { kind: "absent" };

  const parenthesised = /^\((.*)\)$/.exec(trimmed);
  let value = (parenthesised?.[1] ?? trimmed).trim();

  let negative = parenthesised !== null;

  // Sign tolerated on either side of "$"; refuses "(-1)" (both negative notations at once).
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

  // "$" only as leading dressing: "12$34" refused, never read as "1234".
  if (value.includes("$")) return { kind: "unparseable" };

  value = value.replace(/%$/, "");

  // \s covers U+00A0 and the thin space some brokerages group with.
  if (/[\s,]/.test(value)) {
    const point = value.indexOf(".");
    const integer = point === -1 ? value : value.slice(0, point);
    const fraction = point === -1 ? null : value.slice(point + 1);

    // A separator right of the point isn't grouping thousands (European decimal, or misread).
    if (fraction !== null && /[\s,]/.test(fraction)) return { kind: "unparseable" };

    const groups = integer.split(/[\s,]/);
    const wellGrouped =
      /^\d{1,3}$/.test(groups[0] ?? "") &&
      groups.slice(1).every((group) => /^\d{3}$/.test(group));
    if (!wellGrouped) return { kind: "unparseable" };

    value = fraction === null ? groups.join("") : `${groups.join("")}.${fraction}`;
  }

  // ".50"/"50." completed; bare "." matches neither lookaround, so it stays refused below.
  value = value.replace(/^\.(?=\d)/, "0.").replace(/(?<=\d)\.$/, "");

  if (!/^\d+(\.\d+)?$/.test(value)) return { kind: "unparseable" };

  const zero = /^0+(\.0+)?$/.test(value);

  return { kind: "figure", value: negative && !zero ? `-${value}` : value };
}

// Ascending, nulls last (not as zero — an unpriced holding isn't worthless). Not a string
// compare, which would sort "9.0000" above "10.0000".
export function compareDecimal(a: string | null, b: string | null, scale: number): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;

  const left = toUnits(a, scale);
  const right = toUnits(b, scale);

  return left === right ? 0 : left < right ? -1 : 1;
}
