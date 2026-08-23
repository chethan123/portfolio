/**
 * The Holdings screen's one table: which rows it shows, in what order, and what
 * the subtotals under them are (DESIGN.md §8.1).
 *
 * §8.1 calls Holdings the workhorse and says a groupable, filterable table
 * "absorbs what would otherwise be four more pages — by person, by account, tax
 * view, unrealized. Those are the same table with the grouping changed, not
 * separate features." This module is that sentence made executable: one row
 * shape, one set of dimensions, and a grouping argument.
 *
 * **No new query, on purpose.** Every dimension below is already a column on
 * the {@link ValuedHolding} rows `currentHoldings()` returns, because
 * `holding_valued` was built to expose exactly them (§8.2). So filtering and
 * grouping are pure functions over an array that already exists rather than
 * seven new predicates pushed into SQL. That is not laziness about `WHERE`
 * clauses — §8.2 names hand-rolled dashboard queries that can quietly disagree
 * as the weakest point in the whole design, and the way not to add a fourth one
 * is not to add a fourth one. The screen's table and its subtotals are computed
 * from a single array, so a row and the total beneath it cannot disagree.
 *
 * **Seven dimensions, not four and not eight.** §8.1 grants Holdings four —
 * person, account, tax treatment, classification. §8.3's deferred view builder
 * types the same idea as eight: `person | account | institution | kind |
 * tax_treatment | classification | asset_class | instrument`. §8.1 predates
 * §8.3, `holding_valued` exposes all eight, and nothing anywhere forbids the
 * extra four, so the wider set is the one taken. `instrument` is the one left
 * out: a filter over the very thing each row *is* is a search box wearing a
 * dropdown, and a search box is a different control with a different argument
 * for its existence.
 *
 * **A filter is only offered when it can discriminate.** §13.7 refused search
 * over accounts — "a household has a dozen accounts; a filter over twelve rows
 * is a control that costs more than it saves." That refusal is honoured here
 * rather than argued with: {@link availableFilters} returns a dimension only if
 * the data actually holds two or more distinct values for it, so a one-person
 * household is never shown an Owner select that can only mean "everyone", and
 * every option it does show is a value some holding really has — so no *single*
 * filter can select an empty table. Two of them still can, and deliberately:
 * the options are read from the whole portfolio rather than from what the other
 * filters have already left, because options that vanished as you narrowed
 * would leave no way to widen again. An empty intersection is a real answer and
 * the screen says so in words.
 *
 * Money is added by `money.ts` and rendered by `format.ts`; nothing here does
 * either job by hand.
 */
import { ACCOUNT_KINDS, TAX_TREATMENTS, type Option } from "./account-options.ts";
import { ASSET_CLASSES, allocateShares } from "./allocation.ts";
import {
  MONEY_SCALE,
  QUANTITY_SCALE,
  SHARE_SCALE,
  compareDecimal,
  render,
  sumMoney,
} from "./money.ts";

import type { AccountKind, Coverage, TaxTreatment, ValuedHolding } from "./valuation.server.ts";

/* -------------------------------------------------------------------------- */
/*  Dimensions                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The seven things a holding can be filtered or grouped by. These double as URL
 * parameter names, so they are short and stable — renaming one silently breaks
 * every bookmark that carried it.
 */
export type DimensionId =
  | "owner"
  | "account"
  | "institution"
  | "kind"
  | "tax"
  | "classification"
  | "assetClass";

/**
 * Two labels, because a dropdown and a table cell have different budgets.
 *
 * `account-options.ts` holds the canonical labels, written so a form's
 * `<select>` explains itself — "Workplace plan (401k, 403b)", "Tax-deferred —
 * tax due on withdrawal (Traditional)". That explanation is exactly right in a
 * filter dropdown, where there is room for it and the reader may be deciding.
 * It is wrong in a group header or a table cell, where it wraps to two lines and
 * pushes the figures out of alignment. So `label` is the short form and
 * `optionLabel` is the canonical one, and the short forms below are the same
 * words with the explanatory tail trimmed — never a different name for the same
 * thing.
 */
const SHORT_KIND: Record<AccountKind, string> = {
  brokerage: "Brokerage",
  "401k": "Workplace plan",
  ira: "IRA",
  bank: "Bank",
  liability: "Liability",
};

const SHORT_TAX: Record<TaxTreatment, string> = {
  taxable: "Taxable",
  tax_deferred: "Tax-deferred",
  tax_free: "Tax-free",
};

/** The label for a stored value, or the value itself if it has none. */
function labelOf<Value extends string>(
  options: ReadonlyArray<Option<Value>>,
  value: Value,
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/** What a holding is filed under for one dimension. */
type Facet = { key: string; label: string; optionLabel: string };

type Dimension = {
  id: DimensionId;
  /** The column heading and the group-by chip. */
  label: string;
  /** The caption above the filter's `<select>`. */
  filterLabel: string;
  /**
   * The chosen value as a fragment of a sentence — "at Chase", "owned by Bob".
   *
   * A control's caption and the same fact in prose are not the same words. The
   * select above the box says "Brokerage" because it is labelling a field;
   * a sentence explaining why the table is empty has to read as English, and
   * "nothing is brokerage Chase and asset class Equity" does not.
   */
  phrase: (label: string) => string;
  of: (holding: ValuedHolding) => Facet;
};

/** A key and one label, for the dimensions whose stored value is its own name. */
function plain(key: string): Facet {
  return { key, label: key, optionLabel: key };
}

/**
 * Ordered as the filter bar and the group-by strip render them: who owns it,
 * where it sits, then what it is. That is the order a person narrows in.
 */
export const DIMENSIONS: ReadonlyArray<Dimension> = [
  {
    id: "owner",
    label: "Owner",
    filterLabel: "Owner",
    phrase: (label) => `owned by ${label}`,
    // Keyed on the owner's id rather than their name, for the reason
    // `allocationByPerson` gives: two people in one household can share a first
    // name, and a filter that merged them would be wrong invisibly.
    of: (holding) => ({
      key: holding.ownerId,
      label: holding.ownerName,
      optionLabel: holding.ownerName,
    }),
  },
  {
    id: "account",
    label: "Account",
    filterLabel: "Account",
    phrase: (label) => `in ${label}`,
    of: (holding) => ({
      key: holding.accountId,
      label: holding.accountName,
      // Two accounts at two institutions can carry the same name — "Roth IRA"
      // is the obvious one — so the dropdown says which is which even though
      // the table cell, which has the institution on its own line, need not.
      optionLabel: `${holding.accountName} · ${holding.institution}`,
    }),
  },
  {
    id: "institution",
    label: "Brokerage",
    filterLabel: "Brokerage",
    phrase: (label) => `at ${label}`,
    of: (holding) => plain(holding.institution),
  },
  {
    id: "kind",
    label: "Account type",
    filterLabel: "Account type",
    phrase: (label) => `in a ${label.toLowerCase()} account`,
    of: (holding) => ({
      key: holding.accountKind,
      label: SHORT_KIND[holding.accountKind],
      optionLabel: labelOf(ACCOUNT_KINDS, holding.accountKind),
    }),
  },
  {
    id: "tax",
    label: "Tax treatment",
    filterLabel: "Tax treatment",
    phrase: (label) => label.toLowerCase(),
    of: (holding) => ({
      key: holding.taxTreatment,
      label: SHORT_TAX[holding.taxTreatment],
      optionLabel: labelOf(TAX_TREATMENTS, holding.taxTreatment),
    }),
  },
  {
    id: "classification",
    label: "Classification",
    filterLabel: "Classification",
    phrase: (label) => `classified ${label}`,
    of: (holding) => plain(holding.classification),
  },
  {
    id: "assetClass",
    label: "Asset class",
    filterLabel: "Asset class",
    phrase: (label) => label.toLowerCase(),
    of: (holding) => ({
      key: holding.assetClass,
      label: labelOf(ASSET_CLASSES, holding.assetClass),
      optionLabel: labelOf(ASSET_CLASSES, holding.assetClass),
    }),
  },
];

const DIMENSION_BY_ID = new Map(DIMENSIONS.map((dimension) => [dimension.id, dimension]));

/* -------------------------------------------------------------------------- */
/*  Sorting                                                                    */
/* -------------------------------------------------------------------------- */

export type SortKey =
  | "asset"
  | "account"
  | "owner"
  | "quantity"
  | "price"
  | "value"
  | "costBasis"
  | "unrealized";

export type SortDirection = "asc" | "desc";

const SORT_KEYS: ReadonlyArray<SortKey> = [
  "asset",
  "account",
  "owner",
  "quantity",
  "price",
  "value",
  "costBasis",
  "unrealized",
];

/**
 * Biggest position first.
 *
 * The default is descending by value because the first question anyone asks a
 * holdings table is "what is the largest thing I own", and because the query
 * layer's own ordering — alphabetical by account, then by instrument — answers
 * a question nobody asks.
 */
export const DEFAULT_SORT: SortKey = "value";
export const DEFAULT_DIRECTION: SortDirection = "desc";

/**
 * The text columns sort by what is printed in them, so that the order on screen
 * is the order of the words on screen. `localeCompare` rather than `<` because
 * these are names a person reads, and `"Ålesund"` belongs with the A's.
 */
function compareText(a: string, b: string): number {
  return a.localeCompare(b);
}

function compareBy(key: SortKey, a: ValuedHolding, b: ValuedHolding): number {
  switch (key) {
    case "asset":
      return compareText(a.instrumentName, b.instrumentName);
    case "account":
      return compareText(a.accountName, b.accountName);
    case "owner":
      return compareText(a.ownerName, b.ownerName);
    case "quantity":
      return compareDecimal(a.quantity, b.quantity, QUANTITY_SCALE);
    case "price":
      return compareDecimal(a.price, b.price, MONEY_SCALE);
    case "value":
      return compareDecimal(a.value, b.value, MONEY_SCALE);
    case "costBasis":
      return compareDecimal(a.costBasis, b.costBasis, MONEY_SCALE);
    case "unrealized":
      return compareDecimal(a.unrealized, b.unrealized, MONEY_SCALE);
  }
}

/**
 * Is the figure this column sorts on absent altogether? Only the four money
 * columns can be, and only because nothing could price the holding or nothing
 * recorded what it cost.
 */
function isMissing(key: SortKey, holding: ValuedHolding): boolean {
  switch (key) {
    case "price":
      return holding.price === null;
    case "value":
      return holding.value === null;
    case "costBasis":
      return holding.costBasis === null;
    case "unrealized":
      return holding.unrealized === null;
    default:
      return false;
  }
}

/**
 * Sort a copy, never the caller's array.
 *
 * Two details that are not incidental. **Absence is settled before the
 * direction is applied**, so the rows with no figure at all stay at the bottom
 * whichever way the column is sorted. Reversing them along with everything else
 * is the plausible version of this function, and it puts every holding nobody
 * can price at the top of the page the moment someone sorts ascending — which
 * reads as "these are the smallest", the one thing a null must never be
 * mistaken for. And the tie-break is explicit: equal figures fall back to
 * instrument then account then instrument id, which is what stops two identical
 * rows swapping places between one render and the next.
 */
export function sortHoldings(
  holdings: ValuedHolding[],
  key: SortKey,
  direction: SortDirection,
): ValuedHolding[] {
  const sign = direction === "desc" ? -1 : 1;

  return [...holdings].sort((a, b) => {
    const aMissing = isMissing(key, a);
    const bMissing = isMissing(key, b);
    if (aMissing !== bMissing) return aMissing ? 1 : -1;

    const primary = compareBy(key, a, b);
    if (primary !== 0) return primary * sign;

    return (
      compareText(a.instrumentName, b.instrumentName) ||
      compareText(a.accountName, b.accountName) ||
      compareText(a.instrumentId, b.instrumentId)
    );
  });
}

/* -------------------------------------------------------------------------- */
/*  Reading the URL                                                            */
/* -------------------------------------------------------------------------- */

/** Everything the screen's state is: which filters, which grouping, which sort. */
export type HoldingsQuery = {
  /** Dimension id → the selected key. A dimension absent from the map is unfiltered. */
  filters: Map<DimensionId, string>;
  group: DimensionId | null;
  sort: SortKey;
  direction: SortDirection;
};

/**
 * Read the screen's state out of the query string (DESIGN.md §8.3).
 *
 * State lives in the URL rather than in React for the same reason Overview's
 * range control does: a chosen view survives a reload, can be bookmarked, and
 * can be sent to the other person in the household. It is also the whole of the
 * reason this screen needs no client-side JavaScript — there is none anywhere
 * in the application, and a filter bar is not the place to introduce it.
 *
 * **Anything unrecognised is ignored, never rejected.** A stale bookmark naming
 * a dimension that has since been renamed, a hand-edited parameter, a crawler
 * appending nonsense — none of them should produce an error page. They produce
 * the unfiltered table, which is the honest reading of "I could not understand
 * that request". A filter key that no holding carries is kept rather than
 * dropped, because dropping it would silently show the whole portfolio to
 * someone who asked for a slice of it; it renders as an empty result that says
 * so.
 */
export function parseQuery(params: URLSearchParams): HoldingsQuery {
  const filters = new Map<DimensionId, string>();

  for (const dimension of DIMENSIONS) {
    const value = params.get(dimension.id);
    // An empty string is what a `<select>` with nothing chosen submits, and it
    // means "all" — not a filter for the empty key.
    if (value !== null && value !== "") filters.set(dimension.id, value);
  }

  const group = params.get("group");
  const sort = params.get("sort");
  const direction = params.get("dir");

  return {
    filters,
    group: group !== null && DIMENSION_BY_ID.has(group as DimensionId) ? (group as DimensionId) : null,
    sort: sort !== null && SORT_KEYS.includes(sort as SortKey) ? (sort as SortKey) : DEFAULT_SORT,
    direction: direction === "asc" || direction === "desc" ? direction : DEFAULT_DIRECTION,
  };
}

/**
 * The query string for a variant of the current view — the form every control
 * on the screen is built from, because every control is a link or a GET form
 * and each one changes exactly one thing.
 *
 * Defaults are omitted rather than written out, so the unfiltered table's URL
 * is `/holdings` and not `/holdings?sort=value&dir=desc&group=`.
 */
export function toSearch(query: HoldingsQuery): string {
  const params = new URLSearchParams();

  for (const dimension of DIMENSIONS) {
    const value = query.filters.get(dimension.id);
    if (value !== undefined) params.set(dimension.id, value);
  }

  if (query.group !== null) params.set("group", query.group);
  if (query.sort !== DEFAULT_SORT) params.set("sort", query.sort);
  if (query.direction !== DEFAULT_DIRECTION) params.set("dir", query.direction);

  const search = params.toString();

  return search === "" ? "" : `?${search}`;
}

/* -------------------------------------------------------------------------- */
/*  Filtering                                                                  */
/* -------------------------------------------------------------------------- */

/** One dimension's filter, with the choices the data actually supports. */
export type FilterControl = {
  id: DimensionId;
  label: string;
  selected: string;
  /** The selection as a sentence fragment, or `null` when nothing is selected. */
  selectedPhrase: string | null;
  /**
   * The selected key names something no holding carries — a bookmark from
   * before an account closed, or a hand-edited URL. A different empty result
   * from "these two filters do not overlap", and worth different words.
   */
  selectedIsAbsent: boolean;
  options: ReadonlyArray<{ value: string; label: string }>;
};

/**
 * The filters worth drawing, each with its options read off the holdings
 * themselves.
 *
 * **A dimension with fewer than two distinct values is not a filter**, it is a
 * fact about the household, and drawing it as a control implies a choice that
 * does not exist. One person, one brokerage, everything taxable — each of those
 * simply loses a select. This is §13.7's objection to searching a dozen
 * accounts, applied as a rule rather than as a one-off refusal.
 *
 * The options come from the unfiltered holdings, not from the enumerations in
 * `account-options.ts`. A household with no Roth account is not offered
 * "Tax-free", because choosing it could only ever produce an empty table.
 *
 * A filter the caller has selected is always drawn even if it fell below the
 * threshold — otherwise narrowing to a single brokerage would make the control
 * you narrowed with disappear, leaving no way back.
 */
export function availableFilters(
  holdings: ValuedHolding[],
  query: HoldingsQuery,
): FilterControl[] {
  const controls: FilterControl[] = [];

  for (const dimension of DIMENSIONS) {
    const options = new Map<string, string>();
    // The short label, for prose — the option label carries a disambiguating
    // tail that reads badly in a sentence.
    const phrases = new Map<string, string>();

    for (const holding of holdings) {
      const facet = dimension.of(holding);
      if (!options.has(facet.key)) options.set(facet.key, facet.optionLabel);
      if (!phrases.has(facet.key)) phrases.set(facet.key, facet.label);
    }

    const selected = query.filters.get(dimension.id) ?? "";
    if (options.size < 2 && selected === "") continue;

    const listed = [...options.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => compareText(a.label, b.label));

    // A key nothing in the portfolio carries — a bookmark from before an
    // account was closed, a hand-edited URL. `parseQuery` keeps it rather than
    // widening the request behind the reader's back, so the select needs
    // somewhere to point: without an option of its own it would fall back to
    // the first, and every filter would read "All" beside an empty table.
    if (selected !== "" && !options.has(selected)) {
      listed.unshift({ value: selected, label: "Not in this portfolio" });
    }

    const chosen = phrases.get(selected);

    controls.push({
      id: dimension.id,
      label: dimension.filterLabel,
      selected,
      selectedPhrase: selected === "" || chosen === undefined ? null : dimension.phrase(chosen),
      selectedIsAbsent: selected !== "" && chosen === undefined,
      options: listed,
    });
  }

  return controls;
}

/** Every filter is an AND: each one narrows what the last one left. */
export function applyFilters(holdings: ValuedHolding[], query: HoldingsQuery): ValuedHolding[] {
  if (query.filters.size === 0) return holdings;

  return holdings.filter((holding) =>
    [...query.filters].every(([id, key]) => DIMENSION_BY_ID.get(id)?.of(holding).key === key),
  );
}

/* -------------------------------------------------------------------------- */
/*  Totals                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What a set of holdings comes to, and how much of it could be computed.
 *
 * **Three coverages, not one.** They are genuinely three different counts, and
 * collapsing them would misreport at least one. A 401k statement routinely
 * carries a price and no cost basis at all, so `basis` is short where `value`
 * is complete; and `unrealized` needs both sides, so it is the shortest of the
 * three rather than the same count as either. §8.2's rule is to sum what is
 * known and label the coverage — this is that rule with the labels kept apart.
 *
 * Each figure is `null`, never `"0.0000"`, when nothing behind it was known. A
 * group of holdings nobody can price is not a group worth nothing.
 */
export type HoldingsTotal = {
  value: string | null;
  costBasis: string | null;
  unrealized: string | null;
  valueCoverage: Coverage;
  basisCoverage: Coverage;
  unrealizedCoverage: Coverage;
};

function totalOf(holdings: ValuedHolding[]): { total: HoldingsTotal; units: bigint } {
  const value = sumMoney(holdings.map((holding) => holding.value));
  const basis = sumMoney(holdings.map((holding) => holding.costBasis));
  const unrealized = sumMoney(holdings.map((holding) => holding.unrealized));

  const figure = (sum: { amount: bigint; known: number }) =>
    sum.known === 0 ? null : render(sum.amount, MONEY_SCALE);

  return {
    units: value.amount,
    total: {
      value: figure(value),
      costBasis: figure(basis),
      unrealized: figure(unrealized),
      valueCoverage: { known: value.known, total: value.total },
      basisCoverage: { known: basis.known, total: basis.total },
      unrealizedCoverage: { known: unrealized.known, total: unrealized.total },
    },
  };
}

/** The figures under the whole table. */
export function summarise(holdings: ValuedHolding[]): HoldingsTotal {
  return totalOf(holdings).total;
}

/* -------------------------------------------------------------------------- */
/*  Grouping                                                                   */
/* -------------------------------------------------------------------------- */

/** One group's rows, its subtotal, and how much of the table it is. */
export type HoldingsGroup = {
  key: string;
  label: string;
  holdings: ValuedHolding[];
  total: HoldingsTotal;
  /**
   * Decimal string, six places, of the **gross positive total** — the same
   * denominator `allocation.ts` argues for at length, so that a liability's
   * share stays finite and keeps its sign as the household's net worth crosses
   * zero, and so the positive groups sum to `1.000000` exactly — `allocateShares`
   * hands the units independent rounding loses back to the largest remainders,
   * rather than leaving the column a millionth short. A screen must read the
   * sign before it draws a width from it, and must say which denominator it
   * used: it is not a share of the total printed at the foot of the table, and
   * with a liability in the set the two differ.
   *
   * `null` in the two cases where there is no fraction to state rather than a
   * fraction that happens to be zero: a group nothing could price, whose value
   * is itself `null`, and a filtered set with nothing positive in it, which
   * offers no base to be a fraction of. Both render as a dash. Coercing either
   * to `0.000000` would be the same null-as-zero this module refuses
   * everywhere else, and it would read as "this group is none of the
   * portfolio".
   */
  share: string | null;
};

/**
 * Split the rows into groups, largest subtotal first.
 *
 * Ordered by subtotal rather than alphabetically because the grouping exists to
 * answer "where is the money", and the answer should be the first row. Ties
 * fall back to the label so the order is stable between renders.
 *
 * A group that is entirely unpriced sums to nothing and sorts among the zeros;
 * its subtotal is `null`, and the screen renders that as a dash rather than as
 * a claim that the group is worth nothing.
 */
export function groupHoldings(
  holdings: ValuedHolding[],
  id: DimensionId,
  sort: SortKey,
  direction: SortDirection,
): HoldingsGroup[] {
  const dimension = DIMENSION_BY_ID.get(id);
  if (dimension === undefined) return [];

  const buckets = new Map<string, { label: string; holdings: ValuedHolding[] }>();

  for (const holding of holdings) {
    const facet = dimension.of(holding);
    const bucket = buckets.get(facet.key) ?? { label: facet.label, holdings: [] };
    bucket.holdings.push(holding);
    buckets.set(facet.key, bucket);
  }

  const summed = [...buckets.entries()].map(([key, bucket]) => ({
    key,
    label: bucket.label,
    holdings: sortHoldings(bucket.holdings, sort, direction),
    ...totalOf(bucket.holdings),
  }));

  // Sorted before the shares are worked out: `allocateShares` breaks its ties
  // on position, and the rendered order is the one they have to be broken in.
  const ordered = summed.sort((a, b) =>
    a.units === b.units ? compareText(a.label, b.label) : a.units > b.units ? -1 : 1,
  );

  // The denominator, out of the positive groups only, is `allocateShares`'s to
  // work out. What it cannot decide is the difference between a share of zero
  // and no share at all, so the one case where there is no base to be a
  // fraction of is still asked here. See `allocation.ts` for why the base is
  // not the net total.
  const anyPositive = ordered.some((group) => group.units > 0n);
  const shares = allocateShares(ordered.map((group) => group.units));

  return ordered.map(({ key, label, holdings: rows, total }, index) => ({
    key,
    label,
    holdings: rows,
    total,
    share:
      !anyPositive || total.value === null ? null : render(shares[index] ?? 0n, SHARE_SCALE),
  }));
}

/* -------------------------------------------------------------------------- */
/*  Row captions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The sub-line under an instrument's name: what it is, and what is wrong with
 * its price if anything is.
 *
 * Lives here rather than in a route because Account detail renders the same
 * caption under the same instrument, and two copies is two chances for one
 * screen to call a holding "never priced" while the other calls it stale. The
 * words are load-bearing — §6.2 distinguishes a price that is merely old, which
 * is still shown and still counted, from one that has never existed, which is
 * shown as a dash and excluded from every total — and a reader can only act on
 * the difference if it is spelled out. Colour never carries it (§12).
 */
/**
 * A share count as text: the stored digits, minus the zeros scale-8 storage pads
 * them with.
 *
 * Not in `format.ts` because nothing there formats a quantity — every function
 * in it renders money, and a quantity takes no currency mark: half a fund is
 * half a share, not fifty cents. Nothing here computes either. The digits are
 * the digits that came out of the view, grouped and trimmed as text, with the
 * same U+2212 minus `format.ts` uses so a negative quantity and a negative
 * figure read alike in the same row.
 *
 * Here rather than in a route for the reason {@link holdingNote} is: Account
 * detail and Holdings print the same holding's quantity, and a second copy of
 * this drifted immediately — losing the thousands separators, the U+2212 and
 * the negative-zero guard, so one screen showed a loan as `-14500` and the
 * other as `−14,500`.
 */
export function formatQuantity(decimal: string): string {
  const trimmed = decimal.trim();
  const negative = trimmed.startsWith("-") || trimmed.startsWith("−");
  const [int = "0", frac = ""] = trimmed.replace(/^[-+−]/, "").split(".");
  const fraction = frac.replace(/0+$/, "");
  const zero = /^0*$/.test(int) && fraction === "";

  return `${negative && !zero ? "−" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${
    fraction ? `.${fraction}` : ""
  }`;
}

export function holdingNote(holding: {
  assetClass: ValuedHolding["assetClass"];
  isPriced: boolean;
  isStale: boolean;
}): string {
  const parts = [labelOf(ASSET_CLASSES, holding.assetClass)];

  if (!holding.isPriced) parts.push("never priced");
  else if (holding.isStale) parts.push("price is stale");

  return parts.join(" · ");
}

/* -------------------------------------------------------------------------- */
/*  Addressing one row                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The name one row answers to in a URL — `12.7`, account then instrument.
 *
 * A holding has no id of its own to use here. `holding_valued` does not select
 * one, on purpose: the view answers "what is held now", and the row it returns
 * is a fact about an account and an instrument rather than about the particular
 * `holding` row that happened to carry it into the latest position set. That id
 * changes every time a statement is uploaded, and a link built on it would rot
 * on the next upload while still pointing at a real row.
 *
 * The pair does not rot, and it is exactly as unique: `holding_valued` returns
 * one position set per account and `holding_one_row_per_instrument` allows one
 * row per instrument inside it. Which is also why the editor needs no schema
 * change to address a row — the server re-resolves the pair through
 * `latest_position_set` at the moment of the write, so it always names whatever
 * the account currently holds rather than whatever it held when the page
 * rendered.
 *
 * A full stop separates them because both halves are `bigint` ids and so
 * contain only digits, which leaves the separator unambiguous and legible in a
 * query string where `%2F` or `-` would not be.
 */
export function rowKey(holding: Pick<ValuedHolding, "accountId" | "instrumentId">): string {
  return `${holding.accountId}.${holding.instrumentId}`;
}

/**
 * The pair a row key names, or null if it names nothing.
 *
 * Strict about shape and silent about failure, the way {@link parseQuery} is
 * about everything else in the query string: an `edit=` a person mangled, or
 * one carried in from a bookmark predating a change, closes the editor rather
 * than raising anything. The ids are only checked for being ids here — whether
 * they name a row the household actually holds is a question for the database,
 * and the answer is the same "no editor" either way.
 *
 * Eighteen digits, not "any run of digits". Both halves reach a `bigint` column,
 * and a nineteen-digit number can be larger than one holds — which Postgres
 * answers with `value out of range`, reaching the reader as a 500 rather than
 * as a closed editor. Ten to the eighteen is comfortably inside the type and
 * unreachably far outside anything this application will ever count to.
 *
 * And no leading zeros, so that the one spelling of a row is the spelling
 * {@link rowKey} produces. `0001.0002` names the same pair as `1.2` and would
 * otherwise pass through the loader's canonical check untouched — leaving a URL
 * that claims an open editor beside a table where no row's key matches it, and
 * a form target that would still have written.
 */
export function parseRowKey(
  value: string | null,
): { accountId: string; instrumentId: string } | null {
  if (value === null) return null;

  const match = /^(0|[1-9]\d{0,17})\.(0|[1-9]\d{0,17})$/.exec(value);
  if (match === null) return null;

  const [, accountId = "", instrumentId = ""] = match;

  return { accountId, instrumentId };
}
