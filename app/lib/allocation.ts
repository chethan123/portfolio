// Portfolio breakdowns over ValuedHolding rows the query layer already returned (DESIGN.md
// §8.1-§8.3) — pure, no database, so a slice and its rows can't disagree. Money stays a
// decimal string summed as BigInt ten-thousandths (money.ts); format.ts still never computes.
// Unpriced holdings contribute nothing but are still counted in coverage (§8.2's zero rule).
import { formatPercent, isPositive } from "./format.ts";
import { MONEY_SCALE, SHARE_SCALE, divide, render, sumMoney, toUnits } from "./money.ts";

import type { Coverage, ValuedHolding } from "./valuation.server.ts";

export type AllocationSlice = {
  key: string; // an owner's id, an account kind, an asset class
  label: string;
  amount: string; // money scale, summed exactly; negative for net debt
  // Fraction of the gross positive total, not net (net flips every asset's sign on
  // near-cancelling debt). Positive shares sum to exactly 1.000000; a liability's is negative.
  share: string;
  coverage: Coverage;
};

export type Grouping = (holding: ValuedHolding) => { key: string; label: string };

// What a breakdown is of: the figure per holding, and whether it's known — bundled so a
// caller can't mismatch the amount off one column with the coverage off another.
// isKnown is deliberately not `of(holding) !== null`: a figure can be a real zero for a
// holding nobody could compute it from (§8.2), which must not count as known.
export type AllocationAmount = {
  of: (holding: ValuedHolding) => string | null;
  isKnown: (holding: ValuedHolding) => boolean;
};

const VALUE: AllocationAmount = {
  of: (holding) => holding.value,
  isKnown: (holding) => holding.isPriced,
};

// Income screen's cut (DESIGN.md §8.1). isKnown is a constant: holding_valued coalesces a
// missing rate to zero in SQL, so nothing reaches here unknown (§14 limitation 9) — every
// slice is complete, but the total is therefore a lower bound (understates unquoted/interest).
const ANNUAL_DIVIDEND: AllocationAmount = {
  of: (holding) => holding.annualDividend,
  isKnown: () => true,
};

type Bucket = { label: string; amount: bigint; coverage: Coverage };

// localeCompare, not <, since these are names a person reads. Shared with holdings-view.ts
// so a breakdown and the table beside it never order equal groups differently.
export function compareText(a: string, b: string): number {
  return a.localeCompare(b);
}

// Largest first, ties on label. Compares integers, not rendered strings (which sort
// "9.0000" above "10.0000").
function compare(a: Bucket, b: Bucket): number {
  if (a.amount !== b.amount) return a.amount > b.amount ? -1 : 1;

  return compareText(a.label, b.label);
}

// Largest-remainder method: floor each positive share, then hand the units lost to
// flooring back one apiece to the largest remainders, so positive shares sum to exactly
// 1.000000 instead of drifting short (e.g. three equal slices independently round to
// 0.999999). Ties go to the earlier amount, so one input always renders one set of shares.
// Negative amounts sit outside the correction — a fraction of the gross positive total,
// keeping their own rounding and sign. Shared with holdings-view.ts's own grouping.
export function allocateShares(amounts: ReadonlyArray<bigint>): bigint[] {
  const whole = 10n ** BigInt(SHARE_SCALE);
  const base = amounts.reduce((total, amount) => (amount > 0n ? total + amount : total), 0n);

  if (base === 0n) return amounts.map(() => 0n);

  const shares: bigint[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let floored = 0n;

  amounts.forEach((amount, index) => {
    if (amount <= 0n) {
      shares.push(divide(amount, base, SHARE_SCALE));
      return;
    }

    const scaled = amount * whole;
    const floor = scaled / base;

    shares.push(floor);
    remainders.push({ index, remainder: scaled % base });
    floored += floor;
  });

  const short = whole - floored;
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );

  const topped = new Set(
    remainders.filter((_, rank) => BigInt(rank) < short).map((entry) => entry.index),
  );

  return shares.map((share, index) => (topped.has(index) ? share + 1n : share));
}

// The one grouping function every breakdown goes through. `by` comes from
// holdings-view.ts's groupingBy registry rather than a dimension named here, so a
// breakdown's buckets can never label differently from the table beside it.
export function allocationBy(
  holdings: ValuedHolding[],
  by: Grouping,
  amount: AllocationAmount = VALUE,
): AllocationSlice[] {
  const buckets = new Map<string, Bucket>();

  for (const holding of holdings) {
    const { key, label } = by(holding);
    const bucket = buckets.get(key) ?? { label, amount: 0n, coverage: { known: 0, total: 0 } };
    const figure = amount.of(holding);

    if (figure !== null) bucket.amount += toUnits(figure, MONEY_SCALE);
    if (amount.isKnown(holding)) bucket.coverage.known += 1;
    bucket.coverage.total += 1;

    buckets.set(key, bucket);
  }

  // Sorted before shares are computed: the largest-remainder tie-break is on this order.
  const ordered = [...buckets.entries()].sort(([, a], [, b]) => compare(a, b));
  const shares = allocateShares(ordered.map(([, bucket]) => bucket.amount));

  return ordered.map(([key, bucket], index) => ({
    key,
    label: bucket.label,
    amount: render(bucket.amount, MONEY_SCALE),
    share: render(shares[index] ?? 0n, SHARE_SCALE),
    coverage: bucket.coverage,
  }));
}

// Income screen's breakdowns by tax treatment and by account (DESIGN.md §8.1). `by` is
// passed in (never imported) since holdings-view.ts already imports from here — keeping
// the dependency one-way is what makes it structural that this agrees with the Holdings table.
export function annualDividendBy(holdings: ValuedHolding[], by: Grouping): AllocationSlice[] {
  return allocationBy(holdings, by, ANNUAL_DIVIDEND);
}

// Group-level weighted yield (CONTEXT.md), display only. Distinct from holdings-view.ts's
// holdingYield (one row's dividend over its own value). Denominator is gross positive value,
// never net (net debt would report a negative yield; near-cancellation, thousands of percent).
// Null, never "0.000000", when nothing is positive to divide by — divide() would raise on a
// zero denominator otherwise, and a group nobody can price has no yield, not a yield of nothing.
export function weightedYield(holdings: ReadonlyArray<ValuedHolding>): string | null {
  const paid = sumMoney(holdings.map((holding) => holding.annualDividend));
  const owned = sumMoney(
    holdings.map((holding) =>
      holding.value !== null && isPositive(holding.value) ? holding.value : null,
    ),
  );

  if (owned.amount === 0n) return null;

  return render(divide(paid.amount, owned.amount, SHARE_SCALE), SHARE_SCALE);
}

// Two figures, never a fraction — "$9,800 of $14,200" breaks when a liability's negative
// taxable slice makes "$0 of -$522 sheltered" nonsense. Sheltered is a subtotal, never a
// grouping key (CONTEXT.md): it would merge Traditional, taxed later, with Roth, never taxed.
export type ShelteredSubtotal = {
  sheltered: string; // tax-deferred and tax-free together
  taxable: string;
};

export function shelteredSubtotal(holdings: ReadonlyArray<ValuedHolding>): ShelteredSubtotal {
  const paid = (rows: ReadonlyArray<ValuedHolding>) =>
    render(sumMoney(rows.map((holding) => holding.annualDividend)).amount, MONEY_SCALE);

  // Splits off taxable rather than summing the other two, so a fourth treatment lands
  // visibly on the sheltered side rather than falling out of both silently.
  return {
    sheltered: paid(holdings.filter((holding) => holding.taxTreatment !== "taxable")),
    taxable: paid(holdings.filter((holding) => holding.taxTreatment === "taxable")),
  };
}

// e.g. "0.197531" -> "19.7531" for formatPercent, exact (moves the point, no arithmetic) —
// so no screen reaches for Number(share) * 100.
export function sharePercent(share: string): string {
  return render(toUnits(share, SHARE_SCALE), SHARE_SCALE - 2);
}

// Drops the plus formatPercent adds for movements (noise on a share column); keeps the minus.
export function formatShare(share: string): string {
  return withoutLead(formatPercent(sharePercent(share)));
}

function withoutLead(percent: string): string {
  return percent.replace(/^\+/, "");
}

// Unrealized gains by asset type and what settling would cost (DESIGN.md §4.5, §8.1). Only
// a taxable account can owe capital gains tax (IRA/401k gains stay in the table but tax
// nothing); tax is summed per row, never netting losses against gains, so a total can't read
// smaller than a row above it — the result is an upper bound, and the screen says so.

export type AssetTypeKey = "stocks" | "funds" | "other";

// quote_type is the provider's vocabulary (§4.4), matched exactly (trimmed, uppercased) —
// no substring rule, which would file an equity-linked note as equity via "MUTUAL FUND".
// Unlisted types (INDEX, CRYPTOCURRENCY, CURRENCY) land visibly in "other".
const QUOTE_TYPES: ReadonlyMap<string, AssetTypeKey> = new Map([
  ["EQUITY", "stocks"],
  ["ETF", "funds"],
  ["MUTUALFUND", "funds"],
]);

// "other" is a real row, never empty on a real instance (every bank/loan balance and
// workplace trust lands there) — omitting it would make this table not reconcile.
const ASSET_TYPES: ReadonlyArray<{ key: AssetTypeKey; label: string }> = [
  { key: "stocks", label: "Individual stocks" },
  { key: "funds", label: "Funds and ETFs" },
  { key: "other", label: "Cash, loans and everything else" },
];

function assetTypeOf(quoteType: string | null): AssetTypeKey {
  if (quoteType === null) return "other";

  return QUOTE_TYPES.get(quoteType.trim().toUpperCase()) ?? "other";
}

// 100 at SHARE_SCALE: the denominator that turns a percentage into a multiplier.
const PERCENT_BASE = 100n * 10n ** BigInt(SHARE_SCALE);

export type GainRow = {
  key: AssetTypeKey | "total";
  label: string;
  // Null, not zero, when no gain in the row could be computed (§8.2) — uncomputed isn't "gained nothing".
  unrealized: string | null;
  taxable: string | null; // the part of unrealized in a taxable account
  tax: string | null; // at the household's rate; null with nothing to tax or a net loss
  coverage: Coverage;
};

// total is null exactly when rows is empty — no total of nothing.
export type GainGroups = { rows: GainRow[]; total: GainRow | null };

function figure(sum: { amount: bigint; known: number }): string | null {
  return sum.known === 0 ? null : render(sum.amount, MONEY_SCALE);
}

// Null means no gain to tax (a loss), not a zero rate — a real gain at 0% still returns
// "0.0000". Rounded to the cent here, not at print: this is computed from a percentage, so
// its later places are essentially never zero, and rounding downstream would make a printed
// column fail to add up. Still rendered at money scale (zeros in the last two places).
function taxOn(gain: bigint, ratePercent: string): string | null {
  if (gain <= 0n) return null;

  const cents = divide(gain * toUnits(ratePercent, SHARE_SCALE), PERCENT_BASE * 100n, 0);

  return render(cents * 100n, MONEY_SCALE);
}

// ratePercent is the household's capital gains rate as a percentage (e.g. "23.800000"),
// not a fraction. Returns only rows that have holdings; total present whenever any row is.
export function unrealizedByAssetType(
  holdings: ValuedHolding[],
  ratePercent: string,
): GainGroups {
  const rows: GainRow[] = [];

  for (const { key, label } of ASSET_TYPES) {
    const inRow = holdings.filter((holding) => assetTypeOf(holding.quoteType) === key);
    if (inRow.length === 0) continue;

    const all = sumMoney(inRow.map((holding) => holding.unrealized));
    const taxable = sumMoney(
      inRow
        .filter((holding) => holding.taxTreatment === "taxable")
        .map((holding) => holding.unrealized),
    );

    rows.push({
      key,
      label,
      unrealized: figure(all),
      taxable: figure(taxable),
      tax: taxOn(taxable.amount, ratePercent),
      coverage: { known: all.known, total: all.total },
    });
  }

  if (rows.length === 0) return { rows, total: null };

  // Summed from the rows, not the holdings again — a second pass could disagree with what's printed.
  const total = rows.reduce(
    (running, row) => ({
      unrealized: add(running.unrealized, row.unrealized),
      taxable: add(running.taxable, row.taxable),
      tax: add(running.tax, row.tax),
      coverage: {
        known: running.coverage.known + row.coverage.known,
        total: running.coverage.total + row.coverage.total,
      },
    }),
    {
      unrealized: null as string | null,
      taxable: null as string | null,
      tax: null as string | null,
      coverage: { known: 0, total: 0 },
    },
  );

  return { rows, total: { key: "total", label: "Total", ...total } };
}

// null is absence, not zero: null + figure = figure; null + null stays null (renders as a
// dash, never $0.00).
function add(running: string | null, next: string | null): string | null {
  if (next === null) return running;
  if (running === null) return next;

  return render(toUnits(running, MONEY_SCALE) + toUnits(next, MONEY_SCALE), MONEY_SCALE);
}

// e.g. "23.800000" -> "23.8": strips the stored rate's padding, nothing rounded.
// formatPercent rounds to one place, which is wrong for a figure a person typed and
// expects to see again unrounded (a settings box editing the rounded value would corrupt it).
export function rateDigits(ratePercent: string): string {
  const [whole = "0", fraction = ""] = ratePercent.trim().split(".");
  const kept = fraction.replace(/0+$/, "");

  return kept === "" ? whole : `${whole}.${kept}`;
}

// rateDigits plus "%", not formatPercent, so the heading and the Settings box never disagree.
export function formatRate(ratePercent: string): string {
  return `${rateDigits(ratePercent)}%`;
}
