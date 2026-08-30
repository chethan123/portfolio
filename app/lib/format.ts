/**
 * Display formatting for the decimal strings the valuation layer returns.
 * Every function takes a string, returns a string; none calls `Number()`,
 * `parseFloat` or `Intl.NumberFormat` on money — all three need a float, and
 * §4.1 keeps money out of floats end to end. Rounding and grouping work on
 * the digits themselves, exact by construction.
 *
 * Formats, never computes: no add, subtract or divide here. Arithmetic on
 * money happens in SQL, in `numeric` (DESIGN.md §8.2) — a helper here would
 * be an invitation to do it twice.
 */

/** A decimal string taken apart. `int` and `frac` are digits only. */
type Parts = { negative: boolean; int: string; frac: string };

function parse(decimal: string): Parts {
  const trimmed = decimal.trim();
  const negative = trimmed.startsWith("-") || trimmed.startsWith("−");
  const unsigned = negative || trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  const [int = "", frac = ""] = unsigned.split(".");

  return { negative, int: int.replace(/\D/g, "") || "0", frac: frac.replace(/\D/g, "") };
}

/** Add one to a digit string, growing it if the carry runs off the front. */
function increment(digits: string): string {
  const out = digits.split("");

  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i] !== "9") {
      out[i] = String(Number(out[i]) + 1);
      return out.join("");
    }
    out[i] = "0";
  }

  return `1${out.join("")}`;
}

/**
 * Round to `dp` decimal places, half away from zero — not banker's rounding:
 * this is a figure a person reads, and matching what they would get on paper
 * matters more than the statistical bias banker's rounding avoids.
 */
function round(parts: Parts, dp: number): Parts {
  const { negative, int, frac } = parts;

  if (frac.length <= dp) {
    return { negative, int, frac: frac.padEnd(dp, "0") };
  }

  const kept = `${int}${frac.slice(0, dp)}`;
  const rounded = frac.charCodeAt(dp) >= "5".charCodeAt(0) ? increment(kept) : kept;
  const split = rounded.length - dp;

  return {
    negative,
    int: rounded.slice(0, split) || "0",
    frac: rounded.slice(split),
  };
}

/** Thousands separators, inserted from the right. */
function group(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * A negative zero is a rounding artefact, never a fact about money — −$0.00
 * reads as a bug even when the arithmetic behind it was right.
 */
function sign(parts: Parts): string {
  const isZero = /^0*$/.test(parts.int) && /^0*$/.test(parts.frac);
  return parts.negative && !isZero ? "−" : "";
}

/**
 * `"1248392.1400"` → `"$1,248,392.14"`, `"-8000"` → `"−$8,000.00"`. The minus
 * is U+2212, not a hyphen: at the net worth headline's 32px a hyphen is
 * visibly too short to read as a minus, and that is the one place misreading
 * the sign matters most.
 */
export function formatMoney(decimal: string, dp = 2): string {
  const parts = round(parse(decimal), dp);
  const fraction = parts.frac ? `.${parts.frac}` : "";

  return `${sign(parts)}$${group(parts.int)}${fraction}`;
}

/**
 * `"14921"` → `"+$14,921.00"`, for a movement, where the sign is the point.
 * {@link formatMoney} marks only negatives — `+$12,500.00` on a balance is
 * noise; a delta is the opposite case, where an unmarked positive is
 * ambiguous at a glance.
 */
export function formatSignedMoney(decimal: string, dp = 2): string {
  const parts = round(parse(decimal), dp);
  const isZero = /^0*$/.test(parts.int) && /^0*$/.test(parts.frac);
  const fraction = parts.frac ? `.${parts.frac}` : "";
  const lead = isZero ? "" : parts.negative ? "−" : "+";

  return `${lead}$${group(parts.int)}${fraction}`;
}

/**
 * `"1248392.14"` → `"1.2M"`, for chart axis ticks only — never a headline or
 * table cell: an abbreviated balance is a rounded balance, and this app does
 * not round the numbers a person reconciles against a statement.
 */
export function formatCompact(decimal: string): string {
  const parts = parse(decimal);
  const suffixes = ["", "K", "M", "B"];

  /** Shift the decimal point left by `step` groups of three and round. */
  const render = (step: number): Parts => {
    const cut = parts.int.length - step * 3;

    return round(
      {
        negative: parts.negative,
        int: cut > 0 ? parts.int.slice(0, cut) : "0",
        frac: (cut > 0 ? parts.int.slice(cut) : parts.int) + parts.frac,
      },
      step === 0 ? 0 : 1,
    );
  };

  let step = Math.max(
    0,
    Math.min(Math.floor((parts.int.length - 1) / 3), suffixes.length - 1),
  );
  let value = render(step);

  // Rounding can carry a value across the boundary it was scaled against:
  // 999,999 renders at the thousands scale as "1000.0K" where "1.0M" is meant.
  // The carry can only ever add one digit, so one promotion always settles it.
  if (value.int.length > 3 && step < suffixes.length - 1) {
    step += 1;
    value = render(step);
  }

  const fraction = value.frac ? `.${value.frac}` : "";

  return `${sign(value)}${group(value.int)}${fraction}${suffixes[step] ?? ""}`;
}

/**
 * `"1.2043"` → `"+1.2%"`, sign always explicit. §12: gain and loss are never
 * carried by colour alone — the sign in the text is half of that guarantee,
 * the direction arrow beside it the other half.
 */
export function formatPercent(decimal: string, dp = 1): string {
  const parts = round(parse(decimal), dp);
  const isZero = /^0*$/.test(parts.int) && /^0*$/.test(parts.frac);
  const lead = isZero ? "" : parts.negative ? "−" : "+";
  const fraction = parts.frac ? `.${parts.frac}` : "";

  return `${lead}${group(parts.int)}${fraction}%`;
}

/** Whether a decimal string is strictly less than zero. */
export function isNegative(decimal: string): boolean {
  const parts = parse(decimal);
  return parts.negative && !(/^0*$/.test(parts.int) && /^0*$/.test(parts.frac));
}

/**
 * Whether a decimal string is strictly greater than zero — read off the
 * digits like {@link isNegative}, never via `Number(amount) > 0` and a float.
 * Here rather than beside the one component that draws a ring from it: the
 * two halves of "which way does this figure point" are a pair, and a copy in
 * a route is how the pair comes apart.
 */
export function isPositive(decimal: string): boolean {
  return !isNegative(decimal) && /[1-9]/.test(decimal);
}

/**
 * The number a chart needs to position a point — the one place money becomes
 * a float, safe for a reason that does not generalise: the result is
 * multiplied by a pixel height and rounded to a screen coordinate, so an
 * error in the fifteenth digit cannot survive to be displayed. Never for a
 * figure that will be shown, compared, or summed.
 */
export function toPlotValue(decimal: string): number {
  return Number(decimal);
}

/**
 * `["a", "b", "c"]` → `"a, b and c"` — a list a sentence can hold. Here
 * rather than in the two screens that had it: "Alex, Jordan and Sam" beside
 * "Alex, Jordan, Sam" is one household described two ways on adjacent pages.
 * No Oxford comma, matching what the empty note already said.
 */
export function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";

  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
