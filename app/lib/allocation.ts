/**
 * The portfolio cut three ways — by person, by account kind, by asset class —
 * for the analysis screen (DESIGN.md §8.1, §8.3).
 *
 * Pure functions over the {@link ValuedHolding} rows the query layer already
 * returned. No database, deliberately, for two reasons. The screen renders its
 * holdings table from the same array it groups here, so a slice and the rows
 * behind it cannot disagree — agreement is structural rather than something to
 * keep true. And three `GROUP BY` queries would be three more hand-rolled
 * dashboard queries, which is the failure §8.2 names as the weakest point in
 * the whole design; the grouping key is already on every row precisely so that
 * no new join is needed to group by it.
 *
 * **Money stays a decimal string.** Nothing here calls `Number()` or
 * `parseFloat` on a value. Summing happens on the digits, as `BigInt` counts of
 * ten-thousandths — which is not the float §4.1 keeps money out of: it is exact
 * at any magnitude, and the scale it is exact at is written down below rather
 * than guessed at by a driver. `format.ts` still refuses to compute and this
 * module does not change that; the helpers are private here so that "money
 * arithmetic in JavaScript" stays exactly one module wide.
 *
 * The import from `valuation.server.ts` below is a type import and nothing
 * else. A type import is erased, so this module pulls no server code into the
 * client bundle — the same arrangement `account-options.ts` relies on, and the
 * reason a screen may import these functions directly.
 *
 * **An unpriced holding contributes nothing and is still counted**, exactly as
 * `readTotal` does in the query layer. A slice is `{ amount, coverage }` for
 * the same reason a total is: an unknown coerced to zero reports a partial
 * answer as a complete one.
 *
 * **What a negative slice is a share of.** A liability sums negative and stays
 * negative — nothing here takes an absolute value, because $8,000 of debt and
 * $8,000 of assets are not the same slice of anything. That leaves only the
 * denominator to decide, and the obvious choice, the net total, is the wrong
 * one. It fails twice: where debts nearly cancel assets the shares explode (a
 * $500k house against $490k of mortgage makes the house 5,000% of the
 * portfolio), and for a household in net debt the denominator itself goes
 * negative and every asset reports a negative share — the sign error
 * `netWorthChange` already refuses to make by dividing by `abs(previous)`.
 *
 * So the denominator is the **gross positive total**: the sum of the slices
 * that are positive. Consequences, all intended:
 *
 *   * The positive slices sum to 1, so a pie or a stacked bar drawn from them
 *     is complete and needs no residual wedge.
 *   * A negative slice is a negative fraction of what is owned — "this loan is
 *     20% of the assets" — a figure that stays finite and keeps its sign as the
 *     household's net worth crosses zero.
 *   * `share` therefore runs to 1 but not from 0: a liability's is below it. A
 *     screen must read the sign before it draws a width from it.
 *   * When nothing is positive — a household with only a loan recorded — there
 *     is no base to be a fraction of and every share is `0.000000`. That zero
 *     is not a claim that the slice is nothing; the amount beside it says what
 *     it is, and the caller should show the amounts alone.
 */
import { ACCOUNT_KINDS, type Option } from "./account-options.ts";

import type { AssetClass, Coverage, ValuedHolding } from "./valuation.server.ts";

/**
 * One row of a breakdown: what it is, what it is worth, and how much of the
 * whole that is.
 */
export type AllocationSlice = {
  /** The grouped value itself — an owner's id, an account kind, an asset class. */
  key: string;
  /** What a person reads for that key. */
  label: string;
  /**
   * Decimal string at the money scale, summed exactly. Negative for a group
   * that is net debt.
   */
  amount: string;
  /**
   * Decimal string, six places. A fraction of the gross positive total, so the
   * positive slices sum to `1.000000` and a liability's is negative. See the
   * header for why the denominator is not the net total.
   */
  share: string;
  /** How many of the slice's holdings the amount could actually be computed from. */
  coverage: Coverage;
};

/**
 * The labels for `classification.asset_class`.
 *
 * Not in `account-options.ts`, because that module exists so that a form's
 * `<select>` and the schema's check constraints cannot drift, and no form
 * offers an asset class — it arrives on an instrument's classification. The
 * `Option` shape is borrowed from it all the same, so this list can move there
 * unchanged the day a screen does offer one.
 */
export const ASSET_CLASSES: ReadonlyArray<Option<AssetClass>> = [
  { value: "equity", label: "Equity" },
  { value: "bond", label: "Bonds" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
];

/** `numeric(20, 4)`, the scale every money column is stored at (§4.1). */
const MONEY_SCALE = 4;

/**
 * Six places on a fraction is 0.0001% as a percentage — far finer than any
 * screen renders, so rounding for display is never what made two slices look
 * equal. Wide enough, too, that the positive slices of a real portfolio still
 * sum to 1.000000 rather than to something a hair off it.
 */
const SHARE_SCALE = 6;

const FIVE = "5".charCodeAt(0);

/**
 * `"-8000.5000"` at scale 4 → `-80005000n`: the value counted in units of its
 * last place, which is the form it can be added in without losing anything.
 *
 * The digits are read as digits; `BigInt` then adds them exactly however many
 * there are. A value out of the view already carries exactly `scale` places, so
 * the rounding below is for a caller that hands over something finer — half
 * away from zero, matching what `format.ts` rounds a displayed figure by, so a
 * slice and its label cannot round in two directions.
 */
function toUnits(decimal: string, scale: number): bigint {
  const trimmed = decimal.trim();
  const negative = trimmed.startsWith("-");
  const unsigned = negative || trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  const [int = "", frac = ""] = unsigned.split(".");
  const digits = `${int || "0"}${frac.slice(0, scale).padEnd(scale, "0")}`;
  const units = BigInt(digits) + (frac.charCodeAt(scale) >= FIVE ? 1n : 0n);

  return negative ? -units : units;
}

/**
 * `-80005000n` → `"-8000.5000"`. The inverse, and the only place a slice's
 * digits are reassembled.
 *
 * There is no negative zero to guard against here the way `format.ts` has to:
 * `BigInt` has none, so a group that nets exactly flat renders `"0.0000"`.
 */
function render(units: bigint, scale: number): string {
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
function divide(numerator: bigint, denominator: bigint, scale: number): bigint {
  const scaled = numerator * 10n ** BigInt(scale);
  const negative = (scaled < 0n) !== (denominator < 0n);
  const top = scaled < 0n ? -scaled : scaled;
  const bottom = denominator < 0n ? -denominator : denominator;
  const quotient = top / bottom + ((top % bottom) * 2n >= bottom ? 1n : 0n);

  return negative ? -quotient : quotient;
}

/** What a holding is grouped under, and what that group is called. */
type Grouping = (holding: ValuedHolding) => { key: string; label: string };

type Bucket = { label: string; amount: bigint; coverage: Coverage };

/**
 * Largest first, ties broken on the label.
 *
 * Compared as integers rather than as the rendered strings, which would sort
 * "9.0000" above "10.0000". The tie-break is what stops two equal slices
 * swapping places between one render and the next.
 */
function compare(a: Bucket, b: Bucket): number {
  if (a.amount !== b.amount) return a.amount > b.amount ? -1 : 1;
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;

  return 0;
}

/**
 * The one grouping this module does; the three exports below only say what to
 * group by. Written once because "sum the priced ones, count all of them, then
 * divide by the gross" is the rule, and three copies of it is three chances for
 * one breakdown to treat an unpriced holding differently from another.
 */
function group(holdings: ValuedHolding[], by: Grouping): AllocationSlice[] {
  const buckets = new Map<string, Bucket>();

  for (const holding of holdings) {
    const { key, label } = by(holding);
    const bucket = buckets.get(key) ?? { label, amount: 0n, coverage: { known: 0, total: 0 } };

    // `value` is null exactly when the holding is unpriced, so skipping the
    // nulls is what `sum(value)` does in SQL — and counting it anyway, one line
    // down, is what stops the omission being silent.
    if (holding.value !== null) bucket.amount += toUnits(holding.value, MONEY_SCALE);
    if (holding.isPriced) bucket.coverage.known += 1;
    bucket.coverage.total += 1;

    buckets.set(key, bucket);
  }

  // The denominator: the positive slices only. See the header for why this is
  // not the net total.
  const base = [...buckets.values()].reduce(
    (total, bucket) => (bucket.amount > 0n ? total + bucket.amount : total),
    0n,
  );

  return [...buckets.entries()]
    .sort(([, a], [, b]) => compare(a, b))
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      amount: render(bucket.amount, MONEY_SCALE),
      share: render(base === 0n ? 0n : divide(bucket.amount, base, SHARE_SCALE), SHARE_SCALE),
      coverage: bucket.coverage,
    }));
}

/** The label for a stored value, or the value itself if it has none. */
function labelOf<Value extends string>(
  options: ReadonlyArray<Option<Value>>,
  value: Value,
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/**
 * Who owns what (DESIGN.md §4.2).
 *
 * Keyed on the owner's id rather than on their name, because two people in one
 * household can share a first name and a breakdown that merged them would be
 * wrong in a way nobody would notice.
 */
export function allocationByPerson(holdings: ValuedHolding[]): AllocationSlice[] {
  return group(holdings, (holding) => ({ key: holding.ownerId, label: holding.ownerName }));
}

/**
 * What kind of account it sits in.
 *
 * The liability kind is what makes this the breakdown most likely to contain a
 * negative slice, so it is the one to read the header's rule against.
 */
export function allocationByAccountKind(holdings: ValuedHolding[]): AllocationSlice[] {
  return group(holdings, (holding) => ({
    key: holding.accountKind,
    label: labelOf(ACCOUNT_KINDS, holding.accountKind),
  }));
}

/**
 * Equity, bonds, cash, other — the fixed rollup beneath the user's own
 * classification labels (DESIGN.md §4.4).
 */
export function allocationByAssetClass(holdings: ValuedHolding[]): AllocationSlice[] {
  return group(holdings, (holding) => ({
    key: holding.assetClass,
    label: labelOf(ASSET_CLASSES, holding.assetClass),
  }));
}

/**
 * A {@link AllocationSlice.share} as the percentage `formatPercent` expects:
 * `"0.197531"` → `"19.7531"`.
 *
 * Exists so that no screen reaches for `Number(share) * 100`. Multiplying by a
 * hundred is moving the point two places, and the digits are already the
 * digits, so this is exact by not doing any arithmetic at all.
 */
export function sharePercent(share: string): string {
  return render(toUnits(share, SHARE_SCALE), SHARE_SCALE - 2);
}
