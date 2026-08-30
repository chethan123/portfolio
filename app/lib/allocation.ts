/**
 * The portfolio cut three ways — by person, account kind, asset class — for
 * the analysis screen (DESIGN.md §8.1, §8.3); a fourth cut beneath them
 * ({@link unrealizedByAssetType}); and the same array cut by what it *pays*
 * ({@link annualDividendBy}, {@link weightedYield}, {@link shelteredSubtotal}).
 *
 * Pure functions over the {@link ValuedHolding} rows the query layer already
 * returned — no database, so a slice and the rows behind it cannot disagree
 * (agreement is structural), and no three more hand-rolled GROUP BY queries
 * (§8.2's weakest point); the grouping key is already on every row.
 *
 * **Money stays a decimal string.** No `Number()`/`parseFloat`; summing is on
 * the digits, as `BigInt` counts of ten-thousandths — exact at any magnitude,
 * the scale written down rather than guessed by a driver. The digit helpers
 * live in `money.ts` (this is one of its two callers); `format.ts` still
 * refuses to compute. The import from `valuation.server.ts` is a type import
 * — erased, so no server code reaches the client bundle, which is why a
 * screen may import these directly.
 *
 * **An unpriced holding contributes nothing and is still counted**, as
 * `readTotal` does: a slice is `{ amount, coverage }` because an unknown
 * coerced to zero reports a partial answer as a complete one.
 *
 * **What a negative slice is a share of.** A liability stays negative — $8k
 * of debt is not $8k of assets. The obvious denominator, the net total, fails
 * twice: near-cancelling debts explode the shares (a $500k house against
 * $490k of mortgage is 5,000% of the portfolio), and net debt flips every
 * asset's sign. So the denominator is the **gross positive total**.
 * Consequences, all intended: the positive slices sum to exactly 1
 * ({@link allocateShares} hands rounding losses to the largest remainders),
 * so a pie needs no residual wedge; a negative slice is a negative fraction
 * of what is owned, finite and signed across zero; `share` runs to 1 but not
 * from 0, so a screen must read the sign before drawing a width; and with
 * nothing positive every share is `0.000000` — not a claim the slice is
 * nothing, the amount beside it says what it is, and the caller should show
 * the amounts alone.
 */
import { ACCOUNT_KINDS, labelOf, type Option } from "./account-options.ts";
import { formatPercent, isPositive } from "./format.ts";
import { MONEY_SCALE, SHARE_SCALE, divide, render, sumMoney, toUnits } from "./money.ts";

import type { AssetClass, Coverage, ValuedHolding } from "./valuation.server.ts";

/** One row of a breakdown: what it is, what it is worth, how much of the whole that is. */
export type AllocationSlice = {
  /** The grouped value itself — an owner's id, an account kind, an asset class. */
  key: string;
  /** What a person reads for that key. */
  label: string;
  /** Decimal string at money scale, summed exactly; negative for net debt. */
  amount: string;
  /**
   * Six places, a fraction of the gross positive total: positive slices sum
   * to `1.000000`, a liability's is negative (see header).
   */
  share: string;
  /** How many of the slice's holdings the amount could actually be computed from. */
  coverage: Coverage;
};

/**
 * Labels for `classification.asset_class`. Not in `account-options.ts`: that
 * module keeps form `<select>`s and check constraints from drifting, and no
 * form offers an asset class. The `Option` shape is borrowed all the same, so
 * this list can move there unchanged the day one does.
 */
export const ASSET_CLASSES: ReadonlyArray<Option<AssetClass>> = [
  { value: "equity", label: "Equity" },
  { value: "bond", label: "Bonds" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
];

/** What a holding is grouped under, and what that group is called. */
export type Grouping = (holding: ValuedHolding) => { key: string; label: string };

/**
 * What a breakdown is *of*: the figure to take off each holding, and whether
 * it is known. One decision, not two arguments — a caller mismatching the
 * amount off one column and the coverage off another produces a caption
 * counting the wrong holdings, reading as correct on every screen.
 *
 * `of`: the figure, or null where uncomputable — skipped from the sum, still
 * counted in `coverage.total`, which stops the omission being silent.
 * `isKnown`: not `of(holding) !== null` — a figure can be a real zero for a
 * holding nobody could compute it from (a dividend coalesced to zero), and
 * counting that as known is the coercion §8.2 refuses.
 */
export type AllocationAmount = {
  of: (holding: ValuedHolding) => string | null;
  isKnown: (holding: ValuedHolding) => boolean;
};

/** {@link allocationBy}'s default — what every breakdown meant before a second figure existed. */
const VALUE: AllocationAmount = {
  of: (holding) => holding.value,
  isKnown: (holding) => holding.isPriced,
};

/**
 * The Income screen's cut (DESIGN.md §8.1). `isKnown` is a constant, and that
 * is the point: `holding_valued` coalesces a missing rate to zero in SQL, so
 * no holding reaches here unknown (§14, limitation 9) — every slice is
 * complete, hence no coverage caption on the Income tables. The price paid —
 * the total understates by every unquoted holding and all interest — is
 * written where the coalesce is, and both printing screens call it a lower
 * bound.
 */
const ANNUAL_DIVIDEND: AllocationAmount = {
  of: (holding) => holding.annualDividend,
  isKnown: () => true,
};

type Bucket = { label: string; amount: bigint; coverage: Coverage };

/**
 * Largest first, ties on label. Integers, not rendered strings (which sort
 * "9.0000" above "10.0000"); the tie-break stops equal slices swapping
 * between renders.
 */
function compare(a: Bucket, b: Bucket): number {
  if (a.amount !== b.amount) return a.amount > b.amount ? -1 : 1;
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;

  return 0;
}

/**
 * Each amount's share of the column, in the order given, as `BigInt` units at
 * {@link SHARE_SCALE}. Independent rounding leaves the positives short of a
 * whole (three equal slices → `0.999999`, a hairline gap in the ring), so
 * positive shares are floored and the lost units handed back one apiece to
 * the largest remainders — exactly `1.000000`, no share moved more than one
 * last-place unit. Ties go to the earlier amount (the caller's sort order),
 * so one input always renders one set of shares. A negative amount takes no
 * part in the correction: it is a fraction of the gross positive total (see
 * header), keeping its own rounding and sign; with nothing positive every
 * share is zero.
 *
 * Exported for `holdings-view.ts`, which shares out its groups by this rule.
 */
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

/**
 * The one grouping; the adapters below only say what to group by and what to
 * add up. Written once because "sum what is known, count all, divide by the
 * gross" is the rule, and a copy is a chance for one breakdown to treat an
 * uncomputable holding differently. Exported because a breakdown of another
 * figure needs it — an adapter per figure per dimension is the multiplication
 * this shape avoids.
 *
 * @param by what each holding is filed under, and what that file is called.
 * @param amount which figure to add up and when it counts as known; value by
 *               default.
 */
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

    // Null is what SQL's sum() does with one — not in the total — and
    // counting the holding anyway is what stops the omission being silent.
    if (figure !== null) bucket.amount += toUnits(figure, MONEY_SCALE);
    if (amount.isKnown(holding)) bucket.coverage.known += 1;
    bucket.coverage.total += 1;

    buckets.set(key, bucket);
  }

  // Sorted before the shares: the correction breaks ties on position, and the
  // rendered order is the one to break them in.
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

/**
 * Who owns what (DESIGN.md §4.2). Keyed on id, not name: two people can share
 * a first name, and a merged breakdown would be wrong invisibly.
 */
export function allocationByPerson(holdings: ValuedHolding[]): AllocationSlice[] {
  return allocationBy(holdings, (holding) => ({
    key: holding.ownerId,
    label: holding.ownerName,
  }));
}

/**
 * What kind of account it sits in — the breakdown most likely to hold a
 * negative slice (liabilities), so the one to read the header's rule against.
 */
export function allocationByAccountKind(holdings: ValuedHolding[]): AllocationSlice[] {
  return allocationBy(holdings, (holding) => ({
    key: holding.accountKind,
    label: labelOf(ACCOUNT_KINDS, holding.accountKind),
  }));
}

/**
 * Equity, bonds, cash, other — the fixed rollup beneath the user's own
 * classification labels (DESIGN.md §4.4).
 */
export function allocationByAssetClass(holdings: ValuedHolding[]): AllocationSlice[] {
  return allocationBy(holdings, (holding) => ({
    key: holding.assetClass,
    label: labelOf(ASSET_CLASSES, holding.assetClass),
  }));
}

/**
 * The same array cut by what it **pays** — the Income screen's breakdowns by
 * tax treatment and by account (DESIGN.md §8.1). Takes a grouping where the
 * three above take none, because of a cycle: the short labels live in
 * `holdings-view.ts`, which already imports from here, so the caller hands
 * the accessor in and the dependency stays one-way. That also makes "Holdings
 * grouped by tax treatment agrees with the Income breakdown" structural: both
 * screens read one accessor, and a third copy of the label table is exactly
 * what `tests/invariants/aggregates-agree.test.ts` exists to catch.
 *
 * @param by `holdings-view.ts`'s `groupingBy`, which reads the one label table.
 */
export function annualDividendBy(holdings: ValuedHolding[], by: Grouping): AllocationSlice[] {
  return allocationBy(holdings, by, ANNUAL_DIVIDEND);
}

/**
 * What a set of holdings pays over the coming year as a fraction of what it
 * is worth — CONTEXT.md's **weighted yield** for a group, `"0.021874"` at
 * {@link SHARE_SCALE}, display only. Distinct from `holdings-view.ts`'s
 * `holdingYield`, which is one row's dividend over that row's value.
 *
 * **The denominator is the gross positive value**, never the net — the
 * header's two reasons: net debt would report a negative yield on a portfolio
 * that pays money, and near-cancellation reports thousands of percent. The
 * numerator keeps every holding, liabilities included: interest going out is
 * part of what the group nets.
 *
 * Null, never `"0.000000"`, when nothing is positive to divide by — a group
 * whose only holding is an unquoted trust, and equally one sold out to
 * `"0.0000"`. `divide` raises on a zero denominator, so the guard stops one
 * such group taking the page down; §14 limitation 9's zero rule applies to
 * the dividend, never to the value under it. A group nobody can price has no
 * yield rather than a yield of nothing.
 */
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

/**
 * The binary question the three-way breakdown refuses: how much of the
 * dividend is sheltered. **Two figures, never a fraction** — "$9,800 of
 * $14,200" breaks on real data: a car loan whose note carries a rate can sum
 * the taxable slice to −522.20 (a liability still has a tax treatment), and
 * "$0 of −$522 is sheltered" is arithmetic nobody should be shown.
 * **Sheltered is a subtotal and nothing else** (CONTEXT.md): never a grouping
 * key, never a chart slice — grouping by it would merge Traditional (taxed
 * later as ordinary income) with Roth (never taxed). Both amounts, not
 * `string | null`: under the zero rule a group where nothing pays is worth
 * `$0` of dividend, not an unknown amount of it.
 */
export type ShelteredSubtotal = {
  /** Tax-deferred and tax-free taken together. */
  sheltered: string;
  /** What sits in taxable accounts, and is therefore taxed this year. */
  taxable: string;
};

export function shelteredSubtotal(holdings: ReadonlyArray<ValuedHolding>): ShelteredSubtotal {
  const paid = (rows: ReadonlyArray<ValuedHolding>) =>
    render(sumMoney(rows.map((holding) => holding.annualDividend)).amount, MONEY_SCALE);

  // Split off `taxable` rather than summing the other two: a fourth treatment
  // would arrive visibly on the sheltered side, not fall out of both silently.
  return {
    sheltered: paid(holdings.filter((holding) => holding.taxTreatment !== "taxable")),
    taxable: paid(holdings.filter((holding) => holding.taxTreatment === "taxable")),
  };
}

/**
 * A share as the percentage `formatPercent` expects: `"0.197531"` →
 * `"19.7531"`. Exists so no screen reaches for `Number(share) * 100` — the
 * point moves two places on the digits, exact by doing no arithmetic at all.
 */
export function sharePercent(share: string): string {
  return render(toUnits(share, SHARE_SCALE), SHARE_SCALE - 2);
}

/**
 * `"0.197531"` → `"19.8%"`, a liability's `"-0.120413"` → `"−12.0%"`. Drops
 * the plus `formatPercent` adds for movements (a column of pluses is noise) —
 * never the minus, so a liability's sign and the U+2212 survive. Beside
 * {@link sharePercent} rather than in a route: two screens render a share,
 * and a second copy of "drop the plus, keep the minus" is where they diverge.
 */
export function formatShare(share: string): string {
  return withoutLead(formatPercent(sharePercent(share)));
}

/** The plus off the front, nothing else — a liability's minus survives. */
function withoutLead(percent: string): string {
  return percent.replace(/^\+/, "");
}

/**
 * The fourth cut: what has been gained but not sold, and what settling would
 * cost (DESIGN.md §4.5, §8.1). Here rather than its own module for the
 * header's reason — same array, same coverage discipline, same page; a second
 * module would also mean a third copy of the tests' holding factory, and this
 * codebase has watched a copied helper drift.
 *
 * Two rules from §4.5's three-way treatment: **only a taxable account can owe
 * capital gains tax** — an IRA/401k gain stays in the table and contributes
 * nothing to the tax beside it (dropping those rows would hide the balance
 * sheet's largest distinction); and **the tax is per row, summed** — real tax
 * nets losses against gains, but a total smaller than a row above it reads as
 * an arithmetic fault. What this produces is an upper bound, and the screen
 * says so.
 */

/** What the gains table splits on. */
export type AssetTypeKey = "stocks" | "funds" | "other";

/**
 * `quote_type` is the provider's vocabulary, not this application's (§4.4),
 * matched against an explicit list in exactly one place. Exact matches on the
 * trimmed uppercase string; `INDEX`, `CRYPTOCURRENCY` and the seeded
 * `CURRENCY` are absent by decision — the column has no check constraint, and
 * a substring rule loose enough for `MUTUAL FUND` files an equity-linked note
 * as equity. Anything unlisted lands visibly in `other`.
 */
const QUOTE_TYPES: ReadonlyMap<string, AssetTypeKey> = new Map([
  ["EQUITY", "stocks"],
  ["ETF", "funds"],
  ["MUTUALFUND", "funds"],
]);

/**
 * The three rows, in reading order. `other` is a row, not a footnote: it is
 * never empty on a real instance (every bank balance and loan is `USD`,
 * `quote_type` `CURRENCY`; a workplace trust has none), and leaving those out
 * would make this the one table that does not reconcile with the portfolio
 * behind it.
 */
const ASSET_TYPES: ReadonlyArray<{ key: AssetTypeKey; label: string }> = [
  { key: "stocks", label: "Individual stocks" },
  { key: "funds", label: "Funds and ETFs" },
  { key: "other", label: "Cash, loans and everything else" },
];

function assetTypeOf(quoteType: string | null): AssetTypeKey {
  if (quoteType === null) return "other";

  return QUOTE_TYPES.get(quoteType.trim().toUpperCase()) ?? "other";
}

/**
 * `100` written at {@link SHARE_SCALE}: the denominator that turns a
 * percentage into a multiplier, at the same scale the rate is read at.
 */
const PERCENT_BASE = 100n * 10n ** BigInt(SHARE_SCALE);

/** One row of the gains table. */
export type GainRow = {
  key: AssetTypeKey | "total";
  label: string;
  /**
   * Every account, this asset type. Null, not zero, when no gain in the row
   * could be computed (missing basis or missing price alike): a group nobody
   * can compute is not a group that gained nothing, and $0.00 is a claim (§8.2).
   */
  unrealized: string | null;
  /** The part of `unrealized` sitting in a taxable account, by the same rule. */
  taxable: string | null;
  /**
   * `taxable` at the household's rate — null with nothing to tax: no taxable
   * holdings, or taxable ones at a net loss (a negative tax would be a refund
   * this application cannot promise).
   */
  tax: string | null;
  /** How many of the row's holdings the gain could actually be computed from. */
  coverage: Coverage;
};

/**
 * The gains table and its total. `total` is null exactly when `rows` is empty
 * — no total of nothing, and a `$0.00` there would be the fake figure a null
 * amount exists to prevent.
 */
export type GainGroups = { rows: GainRow[]; total: GainRow | null };

/** A sum of gains, or null where there was nothing to sum. */
function figure(sum: { amount: bigint; known: number }): string | null {
  return sum.known === 0 ? null : render(sum.amount, MONEY_SCALE);
}

/**
 * What settling a gain would cost — null where there is no gain to tax. Null
 * is about the gain, not the bill: a zero rate over a real gain returns
 * `0.0000`; a loss returns null, there being no base for a rate. Exact on the
 * digits — an integer product, then `divide` with the same half-away-from-zero
 * rounding `format.ts` uses; no `Number`, because this multiplies money (§4.1).
 *
 * **Rounded to the cent here, not at print.** This figure is *computed* from
 * a percentage, so its third and fourth places are essentially never zero,
 * and carrying them makes the printed column fail to add up in the ordinary
 * case (`5391.2284` + `11459.9761` print as .23 + .98 under a total ending
 * .20). Rounding where the figure is made keeps the printed column exact —
 * `Delta`'s rule of classifying on what will be printed. Still rendered at
 * money scale, with zeros in the last two places.
 */
function taxOn(gain: bigint, ratePercent: string): string | null {
  if (gain <= 0n) return null;

  const cents = divide(gain * toUnits(ratePercent, SHARE_SCALE), PERCENT_BASE * 100n, 0);

  return render(cents * 100n, MONEY_SCALE);
}

/**
 * Unrealized gains by asset type, with the tax a taxable one would attract.
 *
 * @param holdings the array the screen already holds — no query of its own.
 * @param ratePercent the household's capital gains rate, `"23.800000"` — a
 *                    percentage, not a fraction, column to heading.
 * @returns rows that have holdings; the total is present whenever any row is.
 */
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

  // Summed from the rows, not the holdings a second time: two passes can
  // disagree, and the tax must be the sum of what is printed above it.
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

/**
 * Addition where null is absence, not zero: null + figure = figure (a row
 * nobody could compute simply is not in the total, as `sumMoney` does one
 * level down); null + null stays null, so a total under three uncomputable
 * rows is an em dash rather than `$0.00`.
 */
function add(running: string | null, next: string | null): string | null {
  if (next === null) return running;
  if (running === null) return next;

  return render(toUnits(running, MONEY_SCALE) + toUnits(next, MONEY_SCALE), MONEY_SCALE);
}

/**
 * `"23.800000"` → `"23.8"`, `"15.000000"` → `"15"` — the stored rate minus
 * its padding, **nothing rounded**. `formatPercent` rounds to one place: fine
 * for a share, wrong for a figure a person typed and expects to see again — a
 * rate shown `3.8` after `3.75` was entered is a screen disagreeing with its
 * own database, and the settings box would write the rounded version back.
 * Trailing zeros are the column's padding, not anything typed; the digits are
 * untouched, exact by doing no arithmetic ({@link sharePercent}'s reason).
 */
export function rateDigits(ratePercent: string): string {
  const [whole = "0", fraction = ""] = ratePercent.trim().split(".");
  const kept = fraction.replace(/0+$/, "");

  return kept === "" ? whole : `${whole}.${kept}`;
}

/**
 * `"23.800000"` → `"23.8%"` for a heading — {@link rateDigits} plus the sign,
 * not `formatPercent`, so the heading and the Settings box cannot show two
 * different rates.
 */
export function formatRate(ratePercent: string): string {
  return `${rateDigits(ratePercent)}%`;
}
