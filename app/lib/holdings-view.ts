// The Holdings screen's one table: rows, order, subtotals (DESIGN.md §8.1) — one row shape,
// one set of dimensions, a grouping argument, rather than separate features. No new query:
// every dimension is already a column on the ValuedHolding rows currentHoldings(ALL_OWNERS)
// returns (§8.2), so filtering/grouping are pure functions over one array, never a second
// hand-rolled SQL query that could disagree. Seven dimensions, not eight (§8.3): `instrument`
// is left out on purpose — that's a search box, not a filter dropdown. A filter is only
// offered when the data holds two or more distinct values (§13.7); options come from the
// whole portfolio, not the narrowed table, so narrowing never removes the way back out.
import { ACCOUNT_KINDS, ASSET_CLASSES, TAX_TREATMENTS, labelOf } from "./account-options.ts";
import { allocateShares, compareText, type Grouping } from "./allocation.ts";
import {
  MONEY_SCALE,
  QUANTITY_SCALE,
  SHARE_SCALE,
  compareDecimal,
  divide,
  render,
  sumMoney,
  toUnits,
} from "./money.ts";

import { toOwnerParam, type OwnerFilter } from "./owner-filter.ts";

import type { AccountKind, Coverage, TaxTreatment, ValuedHolding } from "./valuation.server.ts";

// The seven groupables; all but "owner" also filter. Double as URL parameter names — short
// and stable, since renaming one silently breaks every bookmark.
export type DimensionId =
  | "owner"
  | "account"
  | "institution"
  | "kind"
  | "tax"
  | "classification"
  | "assetClass";

// A dropdown and a table cell have different budgets: account-options.ts's self-explaining
// form ("Tax-deferred — tax due on withdrawal") wraps and misaligns a cell. Same words, tail dropped.
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

type Facet = { key: string; label: string; optionLabel: string };

type Dimension = {
  id: DimensionId;
  label: string; // column heading and group-by chip
  filterLabel: string; // caption above the filter's <select>
  // The chosen value as a sentence fragment for the empty-table sentence — "at Chase",
  // "owned by Bob" — since a caption doesn't read as English ("nothing is brokerage Chase").
  phrase: (label: string) => string;
  of: (holding: ValuedHolding) => Facet;
};

function plain(key: string): Facet {
  return { key, label: key, optionLabel: key };
}

// Grouping only, no longer a filter (spec 0013) — narrowing to an owner is household-wide
// now. Keyed on id, not name: two people can share a first name.
const OWNER: Dimension = {
  id: "owner",
  label: "Owner",
  filterLabel: "Owner",
  phrase: (label) => `owned by ${label}`,
  of: (holding) => ({
    key: holding.ownerId,
    label: holding.ownerName,
    optionLabel: holding.ownerName,
  }),
};

export const DIMENSIONS: ReadonlyArray<Dimension> = [
  {
    id: "account",
    label: "Account",
    filterLabel: "Account",
    phrase: (label) => `in ${label}`,
    of: (holding) => {
      // Tail rides in the option (CONTEXT.md), not in label — prose doesn't wear mask glyphs.
      const tail = holding.accountNumberTail;

      return {
        key: holding.accountId,
        label: holding.accountName,
        // Institution disambiguates same-named accounts at different brokerages.
        optionLabel: `${holding.accountName}${tail === null ? "" : ` ${tail}`} · ${holding.institution}`,
      };
    },
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
  // Keyed on the label itself: classification.name is unique, no label table to read.
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

// Two lists, not a flag: filter bar/toSearch read DIMENSIONS; group-by strip reads this.
export const GROUPINGS: ReadonlyArray<Dimension> = [OWNER, ...DIMENSIONS];

const DIMENSION_BY_ID = new Map(GROUPINGS.map((dimension) => [dimension.id, dimension]));

// One dimension's accessor, for a breakdown built outside this module (allocation.ts, which
// this module imports, so the label table stays here and the accessor travels instead).
// Throws on an id no dimension carries — unreachable from a closed union, unlike
// groupHoldings's empty-table answer to the same impossible lookup, since a one-bucket
// grouping here would render as a plausible breakdown of a portfolio nobody owns.
export function groupingBy(id: DimensionId): Grouping {
  const dimension = DIMENSION_BY_ID.get(id);
  if (dimension === undefined) throw new Error(`No such holdings dimension: ${id}`);

  return dimension.of;
}

export type SortKey =
  | "asset"
  | "account"
  | "owner"
  | "quantity"
  | "price"
  | "value"
  | "costBasis"
  | "unrealized"
  | "annualDividend";

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
  "annualDividend",
];

// Descending by value: "what is the largest thing I own" is the first question a holdings
// table gets asked, not the query layer's alphabetical order.
export const DEFAULT_SORT: SortKey = "value";
export const DEFAULT_DIRECTION: SortDirection = "desc";

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
    // Money scale, not SHARE_SCALE: sorts on the amount printed, not the ratio under it.
    case "annualDividend":
      return compareDecimal(a.annualDividend, b.annualDividend, MONEY_SCALE);
  }
}

// Annual dividend deliberately absent: the view coalesces a missing rate to zero, so it's
// never unknown, and sinking pays-nothing rows to the bottom would violate the zero rule (§14.9).
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

// Sorts a copy. Absence settles before direction: no-figure rows always stay at the bottom,
// so an ascending sort never puts unpriced holdings on top reading as "smallest".
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

export type HoldingsQuery = {
  filters: Map<DimensionId, string>; // absent from the map = unfiltered
  group: DimensionId | null;
  sort: SortKey;
  direction: SortDirection;
};

// Screen state read out of the query string (DESIGN.md §8.3), so a view survives reload and
// bookmarking. Anything unrecognised is ignored, never rejected. A filter key no holding
// carries is kept rather than dropped — dropping it would silently widen to the whole
// portfolio instead of rendering the empty result that says so.
export function parseQuery(params: URLSearchParams): HoldingsQuery {
  const filters = new Map<DimensionId, string>();

  for (const dimension of DIMENSIONS) {
    const value = params.get(dimension.id);
    // Empty string is a <select> with nothing chosen ("all"), not a filter for the empty key.
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

// Query string for a variant of the current view, each control changing exactly one thing.
// Defaults omitted, so the unfiltered URL is "/holdings". owners is its own argument, not in
// HoldingsQuery (household-wide, ADR-0008) — but emitted first, or a column click would
// clear it; toOwnerParam keeps that spelling stable through react-router's request rebuild.
export function toSearch(query: HoldingsQuery, owners: OwnerFilter): string {
  const params = new URLSearchParams();

  for (const dimension of DIMENSIONS) {
    const value = query.filters.get(dimension.id);
    if (value !== undefined) params.set(dimension.id, value);
  }

  if (query.group !== null) params.set("group", query.group);
  if (query.sort !== DEFAULT_SORT) params.set("sort", query.sort);
  if (query.direction !== DEFAULT_DIRECTION) params.set("dir", query.direction);

  const search = [toOwnerParam(owners), params.toString()].filter((part) => part !== "").join("&");

  return search === "" ? "" : `?${search}`;
}

export type FilterControl = {
  id: DimensionId;
  label: string;
  selected: string;
  selectedPhrase: string | null; // null when nothing is selected
  // The selected key names something no holding carries (stale bookmark, closed account) —
  // a different empty result from "these two filters don't overlap", worth different words.
  selectedIsAbsent: boolean;
  options: ReadonlyArray<{ value: string; label: string }>;
};

// A dimension with fewer than two distinct values isn't drawn (§13.7) — it's a fact about
// the household, not a choice. Options come from the unfiltered holdings, not enumerations,
// so a household with no Roth isn't offered "Tax-free". A selected filter is always drawn
// even below the threshold, or narrowing to one brokerage would remove the way back out.
export function availableFilters(
  holdings: ValuedHolding[],
  query: HoldingsQuery,
): FilterControl[] {
  const controls: FilterControl[] = [];

  for (const dimension of DIMENSIONS) {
    const options = new Map<string, string>();
    // Short label for prose — the option label's disambiguating tail reads badly in a sentence.
    const phrases = new Map<string, string>();

    for (const holding of holdings) {
      const facet = dimension.of(holding);
      if (!options.has(facet.key)) options.set(facet.key, facet.optionLabel);
      if (!phrases.has(facet.key)) phrases.set(facet.key, facet.label);
    }

    const selected = query.filters.get(dimension.id) ?? "";
    if (options.size < 2 && selected === "") continue;

    // Ordered by the words shown, tail included, since that's what the reader scans first.
    const listed = [...options.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => compareText(a.label, b.label));

    // A key nothing carries needs an option to point at, or the select falls back to the
    // first and reads "All" beside an empty table.
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

// Every filter is an AND: each narrows what the last one left.
export function applyFilters(holdings: ValuedHolding[], query: HoldingsQuery): ValuedHolding[] {
  if (query.filters.size === 0) return holdings;

  return holdings.filter((holding) =>
    [...query.filters].every(([id, key]) => DIMENSION_BY_ID.get(id)?.of(holding).key === key),
  );
}

// Three coverages, not one: a 401k statement routinely has a price and no basis, so basis
// runs short where value is complete, and unrealized (needing both) is shortest of the three.
// Each figure is null, never "0.0000", when nothing behind it was known.
export type HoldingsTotal = {
  value: string | null;
  costBasis: string | null;
  unrealized: string | null;
  // Never null: the view coalesces a missing rate to zero in SQL (§14.9), so a group where
  // nothing pays is worth $0, not unknown — also why there's no dividend coverage.
  annualDividend: string;
  valueCoverage: Coverage;
  basisCoverage: Coverage;
  unrealizedCoverage: Coverage;
};

function totalOf(holdings: ValuedHolding[]): { total: HoldingsTotal; units: bigint } {
  const value = sumMoney(holdings.map((holding) => holding.value));
  const basis = sumMoney(holdings.map((holding) => holding.costBasis));
  const unrealized = sumMoney(holdings.map((holding) => holding.unrealized));
  const dividend = sumMoney(holdings.map((holding) => holding.annualDividend));

  const figure = (sum: { amount: bigint; known: number }) =>
    sum.known === 0 ? null : render(sum.amount, MONEY_SCALE);

  return {
    units: value.amount,
    total: {
      value: figure(value),
      costBasis: figure(basis),
      unrealized: figure(unrealized),
      // Straight, not through figure(): that helper dashes a zero known count, wrong here —
      // an empty group truthfully sums to $0.
      annualDividend: render(dividend.amount, MONEY_SCALE),
      valueCoverage: { known: value.known, total: value.total },
      basisCoverage: { known: basis.known, total: basis.total },
      unrealizedCoverage: { known: unrealized.known, total: unrealized.total },
    },
  };
}

export function summarise(holdings: ValuedHolding[]): HoldingsTotal {
  return totalOf(holdings).total;
}

/** One group's rows, its subtotal, and how much of the table it is. */
export type HoldingsGroup = {
  key: string;
  label: string;
  holdings: ValuedHolding[];
  total: HoldingsTotal;
  /**
   * Six places, of the **gross positive total** (`allocation.ts`'s
   * denominator): a liability's share stays finite and signed, and the
   * positive groups sum to `1.000000` exactly via `allocateShares`. A screen
   * must read the sign before drawing a width, and must say the denominator —
   * with a liability in the set this is not a share of the footer total.
   *
   * `null` where there is no fraction to state, not a zero fraction: a group
   * nothing could price (value itself null), and a set with nothing positive
   * (no base). Both render as a dash; coercing either to `0.000000` would
   * read as "this group is none of the portfolio".
   */
  share: string | null;
};

/**
 * Split the rows into groups, largest subtotal first — grouping exists to
 * answer "where is the money", so the answer is the first row; ties fall to
 * the label for stable renders. An entirely-unpriced group sorts among the
 * zeros with a `null` subtotal, rendered as a dash rather than a claim of
 * nothing.
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

  // Sorted before the shares: `allocateShares` breaks ties on position, in
  // the rendered order.
  const ordered = summed.sort((a, b) =>
    a.units === b.units ? compareText(a.label, b.label) : a.units > b.units ? -1 : 1,
  );

  // `allocateShares` owns the denominator; what it cannot decide is a share
  // of zero versus no share at all, so the no-positive-base case is asked here.
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

/**
 * A share count as text: the stored digits minus scale-8 padding. Not in
 * `format.ts` — everything there renders money, and a quantity takes no
 * currency mark: half a fund is half a share, not fifty cents. No computing;
 * the digits are grouped and trimmed as text, with the same U+2212 as
 * `format.ts` so a negative quantity and figure read alike. Here rather than
 * in a route because Account detail prints the same cell, and a second copy
 * drifted immediately — one screen showed a loan as `-14500`, the other as
 * `−14,500`.
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

/**
 * The sub-line under an instrument's name: what it is, and what is wrong with
 * its price if anything. Here because Account detail renders the same caption
 * — two copies is one screen calling a holding "never priced" while the other
 * calls it stale. The words are load-bearing (§6.2: merely-old is shown and
 * counted; never-existed is a dash and excluded) and colour never carries
 * them (§12).
 */
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

/**
 * What one holding pays as a fraction of what it is worth — `$340` a year on
 * `$27,000` is `"0.012593"`, at `SHARE_SCALE`, display only. One holding's,
 * never a group's (CONTEXT.md reserves *weighted yield* for that — a
 * different denominator). Not `quote.yield_pct` either: the stored yield was
 * struck against the provider's own snapshot, and reading it here would put
 * two numbers for one thing in a row — §8.2's named weak point. The dividend
 * is the one stored figure and this is a view of it.
 *
 * A percentage because the amount alone cannot be compared: `$340` says
 * nothing until you know the position size — so the fraction goes under the
 * amount rather than replacing it.
 *
 * Null in exactly two cases, both "no percentage here", never "zero percent":
 * **no value** — an unquoted trust has a dividend and nothing to state it
 * against, and `0.0%` would be a claim about a holding nobody can price; and
 * **a value of zero** — `divide` raises `RangeError` on a zero denominator,
 * and a sold-out position reaches here as `"0.0000"`; unguarded, one such row
 * would take the whole table down.
 *
 * **A liability's two negatives cancel, and that is the right answer**:
 * `−$522.00` at `3.6%` is what the note costs and the rate it costs it at;
 * the amount, not the percentage, says which way the money moves.
 *
 * Here for {@link formatQuantity}'s reason — Account detail renders the same
 * cells. Rendering is `formatShare`'s job in `allocation.ts`.
 */
export function holdingYield(
  holding: Pick<ValuedHolding, "annualDividend" | "value">,
): string | null {
  if (holding.annualDividend === null || holding.value === null) return null;

  const value = toUnits(holding.value, MONEY_SCALE);
  if (value === 0n) return null;

  const dividend = toUnits(holding.annualDividend, MONEY_SCALE);

  return render(divide(dividend, value, SHARE_SCALE), SHARE_SCALE);
}

/**
 * The name one row answers to in a URL — `12.7`, account then instrument. A
 * holding has no id of its own here on purpose: the view answers "what is
 * held now", and the underlying `holding` row's id changes on every upload —
 * a link built on it would rot while still pointing at a real row. The pair
 * does not rot and is exactly as unique (one position set per account, one
 * row per instrument within it), and it is why the editor needs no schema
 * change: the server re-resolves the pair through `latest_position_set` at
 * write time. A full stop separates two digit-only ids legibly where `%2F` or
 * `-` would not.
 */
export function rowKey(holding: Pick<ValuedHolding, "accountId" | "instrumentId">): string {
  return `${holding.accountId}.${holding.instrumentId}`;
}

/**
 * The pair a row key names, or null. Strict about shape, silent about failure
 * ({@link parseQuery}'s way): a mangled or stale `edit=` closes the editor
 * rather than raising; whether the ids name a real row is the database's
 * question. Eighteen digits, not any run: a nineteen-digit number can exceed
 * `bigint`, which Postgres answers `value out of range` — a 500 instead of a
 * closed editor. No leading zeros, so the one spelling is the one
 * {@link rowKey} produces: `0001.0002` would pass the loader's canonical
 * check while matching no row's key — a URL claiming an open editor beside a
 * table that shows none, over a form target that would still have written.
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
