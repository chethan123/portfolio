/**
 * Display formatting for the decimal strings the valuation layer returns.
 *
 * Every function here takes a string and returns a string. None of them calls
 * `Number()`, `parseFloat`, or `Intl.NumberFormat` on a money value — all three
 * require a float, and §4.1 keeps money out of floats end to end. The rounding
 * and the digit grouping below are done on the digits themselves, which is
 * less code than it looks and is exact by construction.
 *
 * This module formats. It does not compute: there is deliberately no add,
 * subtract or divide here. Arithmetic on money happens in SQL, in `numeric`
 * (DESIGN.md §8.2), and a helper here would be an invitation to do it twice.
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
 * Round to `dp` decimal places, half away from zero.
 *
 * Half-up on the magnitude rather than banker's rounding: this is a figure a
 * person reads, and matching what they would get on paper matters more here
 * than the statistical bias that banker's rounding exists to avoid.
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
 * A negative zero is a rounding artefact, never a fact about money: −$0.00 on
 * a screen reads as a bug even when the arithmetic behind it was right.
 */
function sign(parts: Parts): string {
  const isZero = /^0*$/.test(parts.int) && /^0*$/.test(parts.frac);
  return parts.negative && !isZero ? "−" : "";
}

/**
 * `"1248392.1400"` → `"$1,248,392.14"`, `"-8000"` → `"−$8,000.00"`.
 *
 * The minus is U+2212, not a hyphen: at the 32px display size of the net worth
 * headline a hyphen is visibly too short to read as a minus sign, and this is
 * the one place in the app where misreading the sign matters most.
 */
export function formatMoney(decimal: string, dp = 2): string {
  const parts = round(parse(decimal), dp);
  const fraction = parts.frac ? `.${parts.frac}` : "";

  return `${sign(parts)}$${group(parts.int)}${fraction}`;
}

/**
 * `"14921"` → `"+$14,921.00"`. For a movement, where the sign is the point.
 *
 * {@link formatMoney} marks only negatives, because a balance is not a
 * movement and `+$12,500.00` for a checking account is noise. A delta is the
 * opposite case: an unmarked positive there is ambiguous at a glance.
 */
export function formatSignedMoney(decimal: string, dp = 2): string {
  const parts = round(parse(decimal), dp);
  const isZero = /^0*$/.test(parts.int) && /^0*$/.test(parts.frac);
  const fraction = parts.frac ? `.${parts.frac}` : "";
  const lead = isZero ? "" : parts.negative ? "−" : "+";

  return `${lead}$${group(parts.int)}${fraction}`;
}

/**
 * `"1248392.14"` → `"1.2M"`. For chart axis ticks, where the full figure would
 * not fit and its precision would not be read.
 *
 * Never used for a headline or a table cell. An abbreviated balance is a
 * rounded balance, and this app does not round the numbers a person is trying
 * to reconcile against a statement.
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
 * `"1.2043"` → `"+1.2%"`. The sign is always explicit, including the plus.
 *
 * §12: gain and loss are never carried by colour alone. This is half of that
 * guarantee — the sign is in the text — and the direction arrow beside it is
 * the other half.
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
 * The number a chart needs to position a point.
 *
 * This is the one place a money value becomes a float, and it is safe here for
 * a reason that does not generalise: the result is multiplied by a pixel
 * height and rounded to a screen coordinate, so an error in the fifteenth
 * significant digit cannot survive to be displayed. Never use it for a figure
 * that will be shown, compared, or summed.
 */
export function toPlotValue(decimal: string): number {
  return Number(decimal);
}
