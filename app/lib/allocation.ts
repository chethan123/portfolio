/**
 * The portfolio cut three ways — by person, by account kind, by asset class —
 * for the analysis screen (DESIGN.md §8.1, §8.3), and a fourth cut of the same
 * array beneath them: unrealized gains by asset type, with the tax a taxable
 * one would attract. {@link unrealizedByAssetType} carries its own reasoning.
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
 * at any magnitude, and the scale it is exact at is written down rather than
 * guessed at by a driver. Those digit-level helpers used to be private to this
 * file, so that "money arithmetic in JavaScript" stayed exactly one module
 * wide; they now live in `money.ts` and this module is one of its two callers,
 * which keeps the same invariant by making it structural rather than a promise.
 * `format.ts` still refuses to compute, and that has not changed either.
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
 *   * The positive slices sum to exactly 1, because {@link allocateShares}
 *     hands the units that independent rounding loses back to the largest
 *     remainders. So a pie or a stacked bar drawn from them is complete and
 *     needs no residual wedge.
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
import { ACCOUNT_KINDS, labelOf, type Option } from "./account-options.ts";
import { formatPercent } from "./format.ts";
import { MONEY_SCALE, SHARE_SCALE, divide, render, sumMoney, toUnits } from "./money.ts";

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

/** What a holding is grouped under, and what that group is called. */
export type Grouping = (holding: ValuedHolding) => { key: string; label: string };

/**
 * What a breakdown is a breakdown *of*: the figure to take off each holding,
 * and whether that figure is known for it.
 *
 * The two travel together rather than as two arguments, because they are one
 * decision. `value` is null exactly when `isPriced` is false, so for a value
 * breakdown either one implies the other — but that correspondence is a fact
 * about *value*, not about figures in general. A holding's payout says nothing
 * about whether it was priced, and a pair of arguments is a pair a caller can
 * mismatch: the amount off one column and the coverage off another produces a
 * caption counting the wrong holdings, which reads as correct on every screen
 * it appears on.
 *
 * @property of the figure itself, or null where it could not be computed. A
 *           null is skipped from the sum and still counted in
 *           {@link AllocationSlice.coverage}`.total`, which is what stops the
 *           omission being silent.
 * @property isKnown whether this holding contributed. Not `of(holding) !==
 *                   null`: a figure can be a real zero for a holding nobody
 *                   could compute it from — a payout coalesced to zero is the
 *                   case in front of us — and counting that as known is the
 *                   coercion §8.2 refuses.
 */
export type AllocationAmount = {
  of: (holding: ValuedHolding) => string | null;
  isKnown: (holding: ValuedHolding) => boolean;
};

/**
 * What every breakdown was cut by before there was a second figure to cut by,
 * and what {@link allocationBy} still means when nobody says otherwise.
 */
const VALUE: AllocationAmount = {
  of: (holding) => holding.value,
  isKnown: (holding) => holding.isPriced,
};

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
 * The share of each amount in a column, in the order given, as `BigInt` counts
 * of the last place at {@link SHARE_SCALE}.
 *
 * Rounding each share on its own leaves the positives short of a whole: three
 * equal slices each round to `0.333333` and the pie comes to `0.999999`, which
 * the analysis ring draws as a hairline gap because it adds no residual wedge.
 * So the positive shares are floored and the units that flooring lost are
 * handed back one apiece to the largest remainders — largest-remainder
 * apportionment — which reaches exactly `1.000000` while moving no share by
 * more than one unit of its last place. There are always fewer units to hand
 * back than there are positive amounts, since every remainder is below the
 * base. Ties go to the earlier amount, which is the caller's sort order, so one
 * input always renders one set of shares.
 *
 * A negative amount takes no part in the correction. It is a negative fraction
 * of the gross positive total rather than a piece of the whole being divided
 * up — see the header — so it keeps its own rounding and its sign. With nothing
 * positive there is no base to be a fraction of and every share is zero.
 *
 * Exported for `holdings-view.ts`, which shares out its groups by the same rule
 * and would otherwise need a second implementation of the correction.
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
 * The one grouping this module does; the adapters below only say what to group
 * by, and what to add up. Written once because "sum what is known, count all of
 * them, then divide by the gross" is the rule, and a copy of it is a chance for
 * one breakdown to treat an uncomputable holding differently from another.
 *
 * Exported because a breakdown of something other than value needs it, and the
 * alternative — an adapter here per figure per dimension — is the multiplication
 * this shape exists to avoid. The three adapters below stay adapters: this
 * function is already the parameterised implementation, and folding them into a
 * dispatch on a key would only move their four lines behind a `switch`.
 *
 * @param by what each holding is filed under, and what that file is called.
 * @param amount which figure to add up and when it counts as known. Value by
 *               default, which is what every breakdown meant before there was a
 *               second figure to mean.
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

    // A null is what `sum()` does with one in SQL — it is not in the total —
    // and counting the holding anyway, one line down, is what stops the
    // omission being silent.
    if (figure !== null) bucket.amount += toUnits(figure, MONEY_SCALE);
    if (amount.isKnown(holding)) bucket.coverage.known += 1;
    bucket.coverage.total += 1;

    buckets.set(key, bucket);
  }

  // Sorted before the shares are worked out, because the correction breaks its
  // ties on position and the rendered order is the one it has to break them in.
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
 * Who owns what (DESIGN.md §4.2).
 *
 * Keyed on the owner's id rather than on their name, because two people in one
 * household can share a first name and a breakdown that merged them would be
 * wrong in a way nobody would notice.
 */
export function allocationByPerson(holdings: ValuedHolding[]): AllocationSlice[] {
  return allocationBy(holdings, (holding) => ({
    key: holding.ownerId,
    label: holding.ownerName,
  }));
}

/**
 * What kind of account it sits in.
 *
 * The liability kind is what makes this the breakdown most likely to contain a
 * negative slice, so it is the one to read the header's rule against.
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

/**
 * `"0.197531"` → `"19.8%"`, and a liability's `"-0.120413"` → `"−12.0%"`.
 *
 * `formatPercent` marks a positive because it was written for a *movement*,
 * where an unmarked gain is ambiguous. A share is not a movement and a column
 * of pluses is noise, so the lead it added is dropped — the lead only, never
 * the sign itself, so the minus on a liability's row survives and the rounding
 * and the U+2212 stay in `format.ts` where they are written once.
 *
 * Beside {@link sharePercent} rather than in a route, because two screens now
 * render a share and the second copy of a rule like "drop the plus but keep the
 * minus" is where the two of them start disagreeing.
 */
export function formatShare(share: string): string {
  return withoutLead(formatPercent(sharePercent(share)));
}

/**
 * The plus off the front of a formatted percentage, and nothing else.
 *
 * `formatPercent` marks a positive because it was written for a *movement*; a
 * share and a tax rate are neither, and a column of pluses is noise. Only the
 * lead goes — never the sign itself, so a liability's minus and its U+2212
 * survive, and both stay written down once.
 */
function withoutLead(percent: string): string {
  return percent.replace(/^\+/, "");
}

/**
 * The same portfolio, cut a fourth way: what has been gained but not sold, and
 * what settling for it would cost (DESIGN.md §4.5, §8.1).
 *
 * Here rather than in a module of its own for the reason the header gives for
 * the other three — it groups the same array the screen already holds, under
 * the same coverage discipline, for the same page. A second module would also
 * be a third copy of the twenty-field holding factory the tests build these
 * from, and this codebase has already watched one copied helper drift.
 *
 * Two rules make this cut different from the three above it, and both come from
 * §4.5's three-way tax treatment:
 *
 *   * **Only a taxable account can owe capital gains tax.** A gain inside an
 *     IRA or a 401k is never taxed at this rate — a Roth withdrawal is not
 *     taxed at all and a traditional one is taxed as ordinary income on the way
 *     out — so those holdings keep their gain in the table and contribute
 *     nothing to the tax beside it. Dropping their rows instead would hide the
 *     largest distinction on the balance sheet.
 *   * **The tax is per row, and the total is the sum of the rows.** Real tax
 *     nets a loss in one asset type against a gain in another; this does not,
 *     because a total that is smaller than one of the rows above it reads as an
 *     arithmetic fault rather than as a tax rule. What it produces is therefore
 *     an upper bound, and the screen says so.
 */

/** What the gains table splits on. */
export type AssetTypeKey = "stocks" | "funds" | "other";

/**
 * `quote_type` is the price provider's vocabulary, not this application's
 * (§4.4), so it is matched against an explicit list in exactly one place.
 *
 * Exact matches only, on the trimmed and uppercased string. `INDEX`,
 * `CRYPTOCURRENCY` and the seeded `CURRENCY` of the USD row are absent by
 * decision rather than by oversight: the column carries no check constraint, so
 * a substring rule loose enough to catch `MUTUAL FUND` is loose enough to file
 * an equity-linked note as an equity. Anything unlisted lands in `other`, where
 * it is visible on screen rather than quietly dropped.
 */
const QUOTE_TYPES: ReadonlyMap<string, AssetTypeKey> = new Map([
  ["EQUITY", "stocks"],
  ["ETF", "funds"],
  ["MUTUALFUND", "funds"],
]);

/**
 * The three rows, in the order they are read.
 *
 * `other` is last and is deliberately a row rather than a footnote. It is never
 * empty on a real instance: `0001`'s seed gives every bank balance and every
 * loan the one `USD` instrument, whose `quote_type` is `CURRENCY`, and a
 * workplace-plan trust carries no `quote_type` at all. A footnote about a
 * permanently occupied bucket is a footnote nobody reads, and leaving those
 * holdings out entirely would make this table the one page whose total does not
 * reconcile with the portfolio behind it.
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
 * A percentage becomes a multiplier by moving the point two places, and the
 * point is moved by dividing — so this is the scale of the denominator that
 * does it: `100` written at {@link SHARE_SCALE}, the same scale the rate itself
 * is read at.
 */
const PERCENT_BASE = 100n * 10n ** BigInt(SHARE_SCALE);

/** One row of the gains table. */
export type GainRow = {
  key: AssetTypeKey | "total";
  label: string;
  /**
   * Every account, this asset type. **Null, not zero, when no holding in the
   * row had a gain that could be computed** — the view returns null when either
   * the cost basis or the price is missing, so an unpriced trust counts here
   * exactly as an untracked basis does. A group nobody can compute a gain for
   * is not a group that gained nothing, and $0.00 is a claim (§8.2).
   */
  unrealized: string | null;
  /** The part of `unrealized` sitting in a taxable account, by the same rule. */
  taxable: string | null;
  /**
   * `taxable` at the household's rate — null where there is nothing to tax,
   * which is a row with no taxable holdings and equally a row whose taxable
   * holdings are at a net loss. A negative tax would be a refund this
   * application is in no position to promise.
   */
  tax: string | null;
  /** How many of the row's holdings the gain could actually be computed from. */
  coverage: Coverage;
};

/**
 * The rows of the gains table and the total beneath them.
 *
 * `total` is null exactly when `rows` is empty — there is no total of nothing,
 * and a `$0.00` in that case would be the same fake figure a null amount is
 * kept out of everywhere else.
 */
export type GainGroups = { rows: GainRow[]; total: GainRow | null };

/** A sum of gains, or null where there was nothing to sum. */
function figure(sum: { amount: bigint; known: number }): string | null {
  return sum.known === 0 ? null : render(sum.amount, MONEY_SCALE);
}

/**
 * What settling a gain would cost — or null where there is no gain to tax.
 *
 * Null is about the gain, not the bill: a rate of zero over a real gain returns
 * `0.0000`, because nothing owed on something is a figure, while a loss returns
 * null, because there is no base for a rate to be a rate of.
 *
 * Exact on the digits: the gain's units times the rate's units is a product of
 * two integers, and `divide` takes the point back out of it with the same half
 * away from zero `format.ts` rounds a displayed figure by. No `Number` at any
 * step, because this multiplies money (§4.1).
 *
 * **Rounded to the cent here, not at the point it is printed.** Every other
 * money figure in the application is stored at four places because that is what
 * a statement gave it; this one is *computed* from a percentage, so the third
 * and fourth places are essentially never zero. Carrying them would make the
 * column fail to add up in the ordinary case rather than the rare one: two rows
 * at `5391.2284` and `11459.9761` print as $5,391.23 and $11,459.98 over a
 * total of $16,851.20, and a reader adding the two figures in front of them
 * gets a different answer than the one underneath. Rounding where the figure is
 * made keeps the printed column exact — the same rule `Delta` follows in
 * classifying on the figure that will be printed rather than the one behind it.
 * The result is still rendered at the money scale, because that is the scale
 * every other amount on the row is at; it simply has zeros in the last two
 * places.
 */
function taxOn(gain: bigint, ratePercent: string): string | null {
  if (gain <= 0n) return null;

  const cents = divide(gain * toUnits(ratePercent, SHARE_SCALE), PERCENT_BASE * 100n, 0);

  return render(cents * 100n, MONEY_SCALE);
}

/**
 * Unrealized gains by asset type, with the tax a taxable one would attract.
 *
 * @param holdings the array the screen already holds — no query of its own, so
 *                 the table and the rows behind it cannot disagree.
 * @param ratePercent the household's capital gains rate as a decimal string
 *                    percentage, `"23.800000"` — a percentage, not a fraction,
 *                    all the way from the column to the heading.
 * @returns the rows that have holdings, and the total beneath them. Empty rows
 *          are dropped; the total is present whenever any row is.
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

  // Summed from the rows rather than from the holdings a second time: two
  // passes over one array are two things that can disagree, and the tax in
  // particular must be the sum of what is printed above it (see the header).
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
 * Two figures added, where a null is an absence rather than a zero.
 *
 * Null plus a figure is that figure — a row nobody could compute does not drag
 * the total to unknown, it simply is not in it, which is the same thing
 * `sumMoney` does one level down. Null plus null stays null, so a total under
 * three uncomputable rows is an em dash rather than `$0.00`.
 */
function add(running: string | null, next: string | null): string | null {
  if (next === null) return running;
  if (running === null) return next;

  return render(toUnits(running, MONEY_SCALE) + toUnits(next, MONEY_SCALE), MONEY_SCALE);
}

/**
 * `"23.800000"` → `"23.8"`, `"3.750000"` → `"3.75"`, `"15.000000"` → `"15"`.
 *
 * The stored rate with its padding taken off and **nothing rounded**. The
 * column keeps six places because a rate may genuinely have them, and every
 * other percentage on these screens goes through `formatPercent`, which rounds
 * to one — fine for a share of a portfolio, wrong for a figure a person typed
 * and expects to see again. A rate shown as `3.8` after `3.75` was entered is a
 * screen disagreeing with its own database, and the settings box would write
 * the rounded version back on the next save.
 *
 * Trailing zeros go because they are the column's padding rather than anything
 * anyone typed; the digits themselves are untouched, so this is exact by doing
 * no arithmetic at all — the same reason {@link sharePercent} exists.
 */
export function rateDigits(ratePercent: string): string {
  const [whole = "0", fraction = ""] = ratePercent.trim().split(".");
  const kept = fraction.replace(/0+$/, "");

  return kept === "" ? whole : `${whole}.${kept}`;
}

/**
 * `"23.800000"` → `"23.8%"`, for a heading.
 *
 * {@link rateDigits} plus the sign, rather than `formatPercent`, so the heading
 * and the box under Settings cannot show two different rates — which is what
 * rounding one of them and not the other would do.
 */
export function formatRate(ratePercent: string): string {
  return `${rateDigits(ratePercent)}%`;
}
