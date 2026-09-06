// Display formatting for decimal strings the valuation layer returns. Every money function
// takes a string, returns a string, and never calls Number()/parseFloat — rounding and grouping
// work on the digits themselves (§4.1, DESIGN.md §8.2). formatDate/formatDateLocal are the
// non-money pair: UTC-pinned first paint vs. a useEffect correction to the browser's real zone.

type Parts = { negative: boolean; int: string; frac: string };

function parse(decimal: string): Parts {
  const trimmed = decimal.trim();
  const negative = trimmed.startsWith("-") || trimmed.startsWith("−");
  const unsigned = negative || trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  const [int = "", frac = ""] = unsigned.split(".");

  return { negative, int: int.replace(/\D/g, "") || "0", frac: frac.replace(/\D/g, "") };
}

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

// Half away from zero, not banker's rounding — matches what a person gets on paper.
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

function group(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Never render negative zero — a rounding artefact, not a fact about money.
function sign(parts: Parts): string {
  const isZero = /^0*$/.test(parts.int) && /^0*$/.test(parts.frac);
  return parts.negative && !isZero ? "−" : "";
}

// e.g. "-8000" -> "−$8,000.00". Minus is U+2212, not a hyphen — reads correctly at 32px headline size.
export function formatMoney(decimal: string, dp = 2): string {
  const parts = round(parse(decimal), dp);
  const fraction = parts.frac ? `.${parts.frac}` : "";

  return `${sign(parts)}$${group(parts.int)}${fraction}`;
}

// For a movement, where the sign is the point — unlike formatMoney, marks positives too.
export function formatSignedMoney(decimal: string, dp = 2): string {
  const parts = round(parse(decimal), dp);
  const isZero = /^0*$/.test(parts.int) && /^0*$/.test(parts.frac);
  const fraction = parts.frac ? `.${parts.frac}` : "";
  const lead = isZero ? "" : parts.negative ? "−" : "+";

  return `${lead}$${group(parts.int)}${fraction}`;
}

const COMPACT_SUFFIXES = ["", "K", "M", "B"];

// Shifts the decimal point left by `scale` groups of three, then rounds to `dp`.
function shift(parts: Parts, scale: number, dp: number): Parts {
  const cut = parts.int.length - scale * 3;

  return round(
    {
      negative: parts.negative,
      int: cut > 0 ? parts.int.slice(0, cut) : "0",
      frac: (cut > 0 ? parts.int.slice(cut) : parts.int) + parts.frac,
    },
    scale === 0 ? 0 : dp,
  );
}

// Suffix by magnitude alone (0=plain, 1=K, 2=M, 3=B), blind to rounding-driven promotion
// (formatCompact's problem) — an axis needs the unrounded scale to size its own ticks.
export function compactScale(decimal: string): number {
  const digits = parse(decimal).int.length;

  return Math.max(0, Math.min(Math.floor((digits - 1) / 3), COMPACT_SUFFIXES.length - 1));
}

// e.g. "1248392.14" -> "1.2M", for chart axis ticks only, never a headline or table cell.
// Suffix stays per-number (a $96,000 tick beside million-scale neighbours isn't rescaled to "0.1M").
export function formatCompact(decimal: string, dp = 1): string {
  const parts = parse(decimal);
  const size = compactScale(decimal);

  // Carry can promote at most one digit (e.g. 999,999 -> "1.0M" not "1000.0K").
  const carries =
    shift(parts, size, dp).int.length > 3 && size < COMPACT_SUFFIXES.length - 1;
  const scale = carries ? size + 1 : size;
  const value = shift(parts, scale, dp);
  const fraction = value.frac ? `.${value.frac}` : "";

  return `${sign(value)}${group(value.int)}${fraction}${COMPACT_SUFFIXES[scale] ?? ""}`;
}

// Sign always explicit (§12: gain/loss never carried by colour alone).
export function formatPercent(decimal: string, dp = 1): string {
  const parts = round(parse(decimal), dp);
  const isZero = /^0*$/.test(parts.int) && /^0*$/.test(parts.frac);
  const lead = isZero ? "" : parts.negative ? "−" : "+";
  const fraction = parts.frac ? `.${parts.frac}` : "";

  return `${lead}${group(parts.int)}${fraction}%`;
}

export function isNegative(decimal: string): boolean {
  const parts = parse(decimal);
  return parts.negative && !(/^0*$/.test(parts.int) && /^0*$/.test(parts.frac));
}

// Digit-based like isNegative, never Number(amount) > 0.
export function isPositive(decimal: string): boolean {
  return !isNegative(decimal) && /[1-9]/.test(decimal);
}

// The one sanctioned float: chart pixel geometry only, never shown, compared, or summed.
export function toPlotValue(decimal: string): number {
  return Number(decimal);
}

// Fixed to UTC so server and post-hydration render print the same string.
export function formatDate(instant: Date): string {
  const parts: Record<string, string> = {};
  for (const { type, value } of new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).formatToParts(instant)) {
    parts[type] = value;
  }

  return `${parts.day} ${parts.month} ${parts.year}`;
}

// formatDate's browser-local twin: no timeZone option, so Intl reads the ambient zone —
// meant to run only client-side, post-hydration, once that zone is the browser's.
export function formatDateLocal(instant: Date): string {
  const parts: Record<string, string> = {};
  for (const { type, value } of new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).formatToParts(instant)) {
    parts[type] = value;
  }

  return `${parts.day} ${parts.month} ${parts.year}`;
}

// e.g. ["a","b","c"] -> "a, b and c". No Oxford comma.
export function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";

  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
