/**
 * Display formatting for the decimal strings the valuation layer returns.
 * Every money function takes a string, returns a string; none calls
 * `Number()`, `parseFloat` or `Intl.NumberFormat` on money — all three need a
 * float, and §4.1 keeps money out of floats end to end. Rounding and
 * grouping work on the digits themselves, exact by construction.
 *
 * Formats, never computes: no add, subtract or divide here. Arithmetic on
 * money happens in SQL, in `numeric` (DESIGN.md §8.2) — a helper here would
 * be an invitation to do it twice.
 *
 * `formatDate` and `formatDateLocal` are the two functions below that are not
 * about money: a `timestamptz` instant (Settings → Passkeys' enrolled/
 * last-used columns, docs/adr/0012), rendered as a calendar date rather than
 * computed. Both still render and never compute — no arithmetic on the
 * instant, just `Intl.DateTimeFormat` — and both are the one place in this
 * file whose *output* depends on the environment it runs in, since money's
 * own digits carry no timezone to disagree about in the first place. They
 * exist as a pair rather than one function because that dependence cuts two
 * ways: `formatDate` is pinned to UTC for the same reason
 * `settings/accounts.tsx`'s `closedOn` reads a closed date through
 * `toISOString` rather than the ambient locale — a date formatted in
 * whichever zone happens to be running would print one string on the server
 * and a different one after hydration — while a passkey's enrolled or
 * last-used instant is not a market instant and DESIGN.md's Timezone row
 * wants it browser-local ("Browser-local for everything else"). Reconciling
 * that needs both: `formatDate` renders the first, hydration-safe paint, and
 * `formatDateLocal` — deliberately *not* pinned, reading whatever zone is
 * actually running — is what a `useEffect` calls afterwards to correct it,
 * once there is an actual browser zone to correct to.
 * `app/routes/settings/passkeys.tsx`'s `LocalDate` is the one caller, and its
 * own header says why a passkey's date can afford that brief flash where a
 * figure could not.
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

const COMPACT_SUFFIXES = ["", "K", "M", "B"];

/** Shift the decimal point left by `scale` groups of three and round to `dp`. */
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

/**
 * The suffix a value's *size* puts it at — `0` plain, `1` K, `2` M, `3` B —
 * before any rounding can carry it up to the next one. Exported for one
 * caller, which does not render with it: a chart axis needs to know what a
 * decimal place is worth, `10 ** (3 * scale - dp)` dollars, before it can
 * decide how many to spend.
 *
 * Deliberately blind to the promotion below. That promotion is a fact about
 * one rendered label, and reading it here would let a single endpoint sitting
 * a rounding away from the next suffix — $999,968, which prints `1.0M` at one
 * decimal — inflate the unit a thousandfold and buy the whole axis three
 * decimals it has no use for.
 */
export function compactScale(decimal: string): number {
  const digits = parse(decimal).int.length;

  return Math.max(0, Math.min(Math.floor((digits - 1) / 3), COMPACT_SUFFIXES.length - 1));
}

/**
 * `"1248392.14"` → `"1.2M"`, for chart axis ticks only — never a headline or
 * table cell: an abbreviated balance is a rounded balance, and this app does
 * not round the numbers a person reconciles against a statement.
 *
 * `dp` is how many decimals the scaled figure keeps, because one is not
 * always enough to tell two rules apart: a suffix is chosen by the
 * *magnitude* of a number, while an axis has to resolve the *span* it draws,
 * and on a session those are orders of magnitude apart. The suffix stays per
 * number — an axis holding a $96,000 rule to a neighbour's millions would
 * render it `0.1M`, trading a real figure for a tidy one. Below `1000` there
 * is no scaling and so nothing to resolve; `dp` is ignored there and `"500"`
 * stays `"500"`.
 */
export function formatCompact(decimal: string, dp = 1): string {
  const parts = parse(decimal);
  const size = compactScale(decimal);

  // Rounding can carry a value across the boundary it was scaled against:
  // 999,999 renders at the thousands scale as "1000.0K" where "1.0M" is meant.
  // The carry can only ever add one digit, so one promotion always settles it.
  const carries =
    shift(parts, size, dp).int.length > 3 && size < COMPACT_SUFFIXES.length - 1;
  const scale = carries ? size + 1 : size;
  const value = shift(parts, scale, dp);
  const fraction = value.frac ? `.${value.frac}` : "";

  return `${sign(value)}${group(value.int)}${fraction}${COMPACT_SUFFIXES[scale] ?? ""}`;
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
 * `2026-09-05T04:00:00Z` → `"5 Sep 2026"` — a `timestamptz` instant read as a
 * calendar date. Fixed to UTC rather than the ambient locale (this file's own
 * header says why); never for a figure, only for a date beside one.
 */
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

/**
 * {@link formatDate}'s browser-local twin — the correction, not the first
 * paint. No `timeZone` option: that omission is the entire function, since
 * `Intl.DateTimeFormat` reads the ambient zone whenever none is given, and
 * the ambient zone is the household's own only once this is actually running
 * in their browser. Called from nowhere during a server render — there the
 * "ambient" zone is the container's, not any browser's, which is exactly the
 * mismatch `formatDate`'s own pin exists to avoid.
 */
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
