/**
 * The only thing in the application that reads `holding_valued` and
 * `holding_valued_at`.
 *
 * DESIGN.md §8.2 names three hand-rolled dashboard queries disagreeing as the
 * weakest point in the whole design. The mitigation is one SQL view and this
 * one module over it: a dashboard that wants "what do I hold and what is it
 * worth" calls in here, and a dashboard that writes its own join to the
 * `holding` table has left the mitigation.
 *
 * It is a translation layer, not a service. No caching, no business rules
 * beyond assembling the coverage counts — every valuation rule lives in the
 * view, in SQL, where the arithmetic is exact.
 *
 * Every numeric field it returns is a decimal string. `numeric` crosses the
 * driver boundary as a string on purpose (see `server/db.ts`), and this module
 * never undoes that with `Number()` or `parseFloat`. The only numbers here are
 * cardinalities in {@link Coverage}, which are counts of rows rather than money.
 */
import { sql } from "kysely";

import { getDb, type Database } from "./db.server.ts";

import type { AliasedRawBuilder, Kysely, Selectable } from "kysely";

/** `account.kind`, constrained by a check constraint in the schema. */
export type AccountKind = "brokerage" | "401k" | "ira" | "bank" | "liability";

/**
 * `account.tax_treatment`. Three-way rather than boolean: $500k in a
 * Traditional IRA is roughly $350k of spending power while $500k in a Roth is
 * $500k, and a boolean throws away exactly that (DESIGN.md §4.5).
 */
export type TaxTreatment = "taxable" | "tax_deferred" | "tax_free";

/** `classification.asset_class` — the fixed rollup under the user's labels. */
export type AssetClass = "equity" | "bond" | "cash" | "other";

/**
 * One holding, valued, with everything a dashboard groups by already on it.
 *
 * Cash is a `USD` position priced at 1.00 and a liability is a negative `USD`
 * quantity against that same positive price, so nothing reading this shape ever
 * needs a branch for either (DESIGN.md §2).
 */
export type ValuedHolding = {
  accountId: string;
  accountName: string;
  institution: string;
  accountKind: AccountKind;
  taxTreatment: TaxTreatment;
  ownerId: string;
  ownerName: string;
  instrumentId: string;
  /** Null for an instrument with no public ticker, such as a 401k trust. */
  symbol: string | null;
  instrumentName: string;
  classification: string;
  assetClass: AssetClass;
  /** Decimal string. Negative for a liability — the sign lives here. */
  quantity: string;
  /** Null only when the instrument has never been quoted. */
  price: string | null;
  /** Null exactly when `price` is null. Never zero standing in for unknown. */
  value: string | null;
  /** Null when the statement omitted it, as 401k statements routinely do. */
  costBasisPerShare: string | null;
  costBasis: string | null;
  /** Null when either side is unknown — never a gain invented from a null. */
  unrealized: string | null;
  isPriced: boolean;
  /** A stale price is still used; this says so rather than hiding it. */
  isStale: boolean;
};

/**
 * How much of a figure is actually known: "based on 8 of 12 holdings".
 *
 * The alternative — coercing the unknown to zero — reports a total that looks
 * complete and is not, which is the failure this design refuses everywhere.
 */
export type Coverage = { known: number; total: number };

/** A money figure and how much of the portfolio it was computed from. */
export type Total = { amount: string; coverage: Coverage };

/** One row of the view, as the generated types describe it. */
type HoldingValuedRow = Selectable<Database["holding_valued"]>;

/**
 * Postgres reports every column of a view as nullable regardless of what can
 * actually appear in it, so the generated type is wider than reality: an
 * account always has a name, a holding always has a quantity. This narrows
 * that, loudly. A null here would mean the view and this module disagree about
 * the schema, which is a bug to surface rather than to paper over.
 */
function required<T>(value: T | null, column: string): T {
  if (value === null) {
    throw new Error(`holding_valued.${column} was null, which the view cannot produce.`);
  }
  return value;
}

function toValuedHolding(row: HoldingValuedRow): ValuedHolding {
  return {
    accountId: required(row.account_id, "account_id"),
    accountName: required(row.account_name, "account_name"),
    institution: required(row.institution, "institution"),
    // The schema's check constraints are what make these casts safe: the
    // database cannot hold a kind, treatment or asset class outside the set.
    accountKind: required(row.account_kind, "account_kind") as AccountKind,
    taxTreatment: required(row.tax_treatment, "tax_treatment") as TaxTreatment,
    ownerId: required(row.owner_id, "owner_id"),
    ownerName: required(row.owner_name, "owner_name"),
    instrumentId: required(row.instrument_id, "instrument_id"),
    symbol: row.symbol,
    instrumentName: required(row.instrument_name, "instrument_name"),
    classification: required(row.classification, "classification"),
    assetClass: required(row.asset_class, "asset_class") as AssetClass,
    quantity: required(row.quantity, "quantity"),
    price: row.price,
    value: row.value,
    costBasisPerShare: row.cost_basis_per_share,
    costBasis: row.cost_basis,
    unrealized: row.unrealized,
    isPriced: required(row.is_priced, "is_priced"),
    isStale: required(row.is_stale, "is_stale"),
  };
}

/**
 * A calendar date, `YYYY-MM-DD`.
 *
 * A date crosses this boundary as a string in both directions: `pg` parses
 * Postgres `date` into a JavaScript `Date` at *local* midnight by default, so a
 * round trip west of UTC lands on the previous day — the same class of silent
 * bug as the numeric coercion, and one that would select the wrong position set
 * with no error anywhere. `server/db.ts` registers the parser that prevents it.
 */
export type IsoDate = string;

/**
 * Where a read gets its rows: the view for "now", the function for a date.
 *
 * One type covers both because the function returns the view's row type —
 * `returns setof holding_valued` in the migration, not a re-listed set of
 * columns — so everything below this line is written once and reads either.
 * Aliasing both to `holding_valued` is what lets the column names below be the
 * same names in both cases.
 */
type ValuedSource = AliasedRawBuilder<HoldingValuedRow, "holding_valued">;

/** What is held right now. */
const valuedNow = (): ValuedSource =>
  sql.table<HoldingValuedRow>("holding_valued").as("holding_valued");

/** What was held on `date`, priced at that date's carried-forward close. */
const valuedAt = (date: IsoDate): ValuedSource =>
  sql<HoldingValuedRow>`holding_valued_at(${date}::date)`.as("holding_valued");

/**
 * The ordering is for determinism, not for display; a screen sorts as it likes.
 */
async function readHoldings(
  db: Kysely<Database>,
  source: ValuedSource,
): Promise<ValuedHolding[]> {
  const rows = await db
    .selectFrom(source)
    .selectAll()
    .orderBy("account_name")
    .orderBy("instrument_name")
    .orderBy("instrument_id")
    .execute();

  return rows.map(toValuedHolding);
}

/**
 * One `SUM` over `value`, with no branch for cash or debt.
 *
 * Summed in SQL, in `numeric`, so no float ever touches it. Unpriced holdings
 * contribute nothing to `amount` and are counted in `coverage.total`, so a
 * partial answer is labelled partial rather than reported as complete — a zero
 * substituted for an unknown price would be indistinguishable from a genuinely
 * empty account.
 */
async function readTotal(db: Kysely<Database>, source: ValuedSource): Promise<Total> {
  const row = await db
    .selectFrom(source)
    .select([
      // `value` is null exactly when the holding is unpriced, and SUM skips
      // nulls — so "sums only priced holdings" needs no filter to say it.
      // The coalesce is for the empty portfolio: zero of nothing, not null.
      sql<string>`cast(coalesce(sum(value), 0) as numeric(20, 4))`.as("amount"),
      sql<string>`count(*) filter (where is_priced)`.as("known"),
      sql<string>`count(*)`.as("total"),
    ])
    .executeTakeFirstOrThrow();

  return {
    amount: row.amount,
    // Counts, not money: these are cardinalities of a household's holdings and
    // could not reach the precision limit if every row were a separate fund.
    coverage: { known: Number(row.known), total: Number(row.total) },
  };
}

/**
 * Every holding currently held, valued.
 *
 * "Currently" is the view's business: the newest position set per account,
 * tie-broken deterministically, with closed accounts excluded. A holding whose
 * instrument has never been priced is here too, carrying `isPriced: false` —
 * dropping it would understate every total silently.
 *
 * @param db a handle to read through. Defaults to the process-wide one; tests
 *           pass a transaction they roll back.
 */
export async function currentHoldings(db: Kysely<Database> = getDb()): Promise<ValuedHolding[]> {
  return readHoldings(db, valuedNow());
}

/**
 * Net worth right now, and how much of it is known.
 *
 * @param db a handle to read through. Defaults to the process-wide one; tests
 *           pass a transaction they roll back.
 */
export async function netWorth(db: Kysely<Database> = getDb()): Promise<Total> {
  return readTotal(db, valuedNow());
}

/**
 * Every holding held on a past date, valued at that date's close.
 *
 * Positions are constant between uploads by construction, so this is that
 * date's position sets priced at that date's close, with the last close carried
 * forward — a Saturday equals the preceding Friday, and so does a market
 * holiday, with no calendar anywhere.
 *
 * What it deliberately does not do is invent a past. An account whose first
 * upload is after `date` contributes no rows rather than a zero, so the earliest
 * date with any value is the first upload (DESIGN.md §7); the period before that
 * belongs to the hand-typed `manual_networth` series, not here. An account
 * closed after `date` is included, because it was open then.
 *
 * `isStale` is always false: staleness is a property of a live quote that failed
 * to refresh, and a historical close is simply the close.
 *
 * @param date `YYYY-MM-DD`. Any date, including one before the app existed —
 *             cash and debt still price at 1.00 there, through the same
 *             carry-forward and with no special case.
 * @param db a handle to read through. Defaults to the process-wide one; tests
 *           pass a transaction they roll back.
 */
export async function holdingsAt(
  date: IsoDate,
  db: Kysely<Database> = getDb(),
): Promise<ValuedHolding[]> {
  return readHoldings(db, valuedAt(date));
}

/**
 * Net worth on a past date, on the same terms as {@link netWorth}.
 *
 * A date before the first upload is `0.0000` over a coverage of zero rows —
 * "nothing was recorded yet", which is a different statement from "the household
 * had nothing", and the coverage count is what lets a chart say so.
 *
 * @param date `YYYY-MM-DD`.
 * @param db a handle to read through. Defaults to the process-wide one; tests
 *           pass a transaction they roll back.
 */
export async function netWorthAt(
  date: IsoDate,
  db: Kysely<Database> = getDb(),
): Promise<Total> {
  return readTotal(db, valuedAt(date));
}
