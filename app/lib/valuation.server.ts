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
 *
 * Every exported query takes an optional `db` handle: it defaults to the
 * process-wide one, and tests pass a transaction they roll back.
 */
import { sql } from "kysely";

import { getDb, type Database } from "./db.server.ts";

import type { AliasedRawBuilder, Kysely, RawBuilder, Selectable, SqlBool } from "kysely";

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
  /**
   * What the price provider calls this — `EQUITY`, `ETF`, `MUTUALFUND`, and the
   * seeded `CURRENCY` on the USD row. Null for an instrument nobody quotes,
   * which is a workplace-plan trust priced by hand rather than a fault.
   */
  quoteType: string | null;
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
  /**
   * What the holding is projected to pay over the coming year — quantity times
   * the instrument's current per-share rate, computed in the view.
   *
   * Never null on the current path and always null on an as-of one, and both
   * halves of that are deliberate. The view coalesces a missing rate to zero,
   * because "pays nothing" and "nobody asked" are the same null in `quote` and
   * a caption could not tell them apart (DESIGN.md §14, limitation 9); the
   * as-of function returns the constant null, because the projection describes
   * the portfolio now and no historical rate is stored to derive one from.
   */
  annualDividend: string | null;
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
    // Not `required`: `instrument.quote_type` is genuinely nullable and
    // `instrument-resolution.server.ts` writes null on purpose for a manually
    // priced instrument. Insisting on it here would 500 the screens over a
    // 401k trust.
    quoteType: row.quote_type,
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
    // Not `required`, even though the view cannot emit a null here: the as-of
    // function reports null on purpose, and this mapper reads both. Narrowing
    // it would turn every historical read into a 500 (ADR-0001).
    annualDividend: row.annual_dividend,
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

const valuedNow = (): ValuedSource =>
  sql.table<HoldingValuedRow>("holding_valued").as("holding_valued");

/** What was held on `date`, priced at that date's carried-forward close. */
const valuedAt = (date: IsoDate): ValuedSource =>
  sql<HoldingValuedRow>`holding_valued_at(${date}::date)`.as("holding_valued");

/**
 * The ordering is for determinism, not for display; a screen sorts as it likes.
 *
 * `where` narrows the same read to a subset — one account's holdings, say.
 * Narrowing here rather than in a second function is the point: a drill-down
 * that wrote its own join to the view would be the fourth hand-rolled query
 * §8.2 warns about, and this one is the same rows filtered.
 */
async function readHoldings(
  db: Kysely<Database>,
  source: ValuedSource,
  where?: RawBuilder<SqlBool>,
): Promise<ValuedHolding[]> {
  const all = db.selectFrom(source).selectAll();

  const rows = await (where === undefined ? all : all.where(where))
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
 */
export async function currentHoldings(db: Kysely<Database> = getDb()): Promise<ValuedHolding[]> {
  return readHoldings(db, valuedNow());
}

/**
 * Net worth right now, and how much of it is known.
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
 */
export async function netWorthAt(
  date: IsoDate,
  db: Kysely<Database> = getDb(),
): Promise<Total> {
  return readTotal(db, valuedAt(date));
}

/**
 * One account's holdings, rolled up.
 *
 * Grouped in SQL for the same reason {@link readTotal} sums in SQL: the
 * alternative is adding decimal strings in JavaScript, which is either wrong
 * (via `Number`) or a decimal library doing what `numeric` already does
 * exactly. It reads the same view as everything else, so an account's total
 * here and the net worth headline above it cannot disagree (DESIGN.md §8.2).
 */
export type AccountTotal = {
  accountId: string;
  accountName: string;
  institution: string;
  accountKind: AccountKind;
  ownerName: string;
  /** Decimal string. Negative for a liability account — the sign lives in it. */
  amount: string;
  coverage: Coverage;
};

/** One point on the computed net worth line. */
export type NetWorthPoint = { date: IsoDate; amount: string; coverage: Coverage };

/** One hand-typed point from the pre-day-zero series (DESIGN.md §7). */
export type ManualPoint = { date: IsoDate; amount: string };

/**
 * The columns an account rollup selects, under the view's names.
 *
 * Two queries below produce this: one grouping the view, one grouping a single
 * account row it may have no rows for. They share the shape so that the list
 * and the drill-down cannot describe the same account differently — the same
 * reason the view exists (DESIGN.md §8.2).
 */
type AccountTotalRow = {
  account_id: string | null;
  account_name: string | null;
  institution: string | null;
  account_kind: string | null;
  owner_name: string | null;
  amount: string;
  known: string;
  total: string;
};

function toAccountTotal(row: AccountTotalRow): AccountTotal {
  return {
    accountId: required(row.account_id, "account_id"),
    accountName: required(row.account_name, "account_name"),
    institution: required(row.institution, "institution"),
    accountKind: required(row.account_kind, "account_kind") as AccountKind,
    ownerName: required(row.owner_name, "owner_name"),
    amount: row.amount,
    // Counts, not money: see {@link readTotal}.
    coverage: { known: Number(row.known), total: Number(row.total) },
  };
}

/**
 * `<column> = <id>`, or a predicate matching nothing when the id cannot be one.
 *
 * Ids cross this boundary as strings (`server/db.ts`) and land against a
 * `bigint` column, so an id taken from a URL path that is not digits would fail
 * inside Postgres — a 500 where the honest answer is "no such account". Saying
 * that in SQL rather than returning early keeps every "this account has
 * nothing" answer coming out of the query that would have answered anyway,
 * rather than out of a JavaScript copy of what it would have said.
 */
function isAccount(column: string, accountId: string): RawBuilder<SqlBool> {
  return /^\d+$/.test(accountId)
    ? sql<SqlBool>`${sql.ref(column)} = ${accountId}`
    : sql<SqlBool>`false`;
}

/**
 * Every open account with its current value, largest first.
 *
 * A liability account sorts to the bottom by construction rather than by a
 * branch, because its positions sum negative (DESIGN.md §2).
 *
 * Row for row the same answer {@link accountTotal} gives for each of those
 * accounts, and that agreement is the rule rather than a coincidence of two
 * queries that happen to match: the overview's row and the drill-down's
 * headline are one figure shown twice, so they are grouped the same way from
 * the same source. Grouping the view directly would be an inner join, which
 * silently drops exactly the accounts the LEFT join below exists to keep —
 * see {@link accountTotal} for why an empty account is `0.0000` over zero rows
 * rather than missing.
 *
 * A zero-total account therefore sorts between the assets and the liabilities,
 * which is where a zero belongs, and ties break on name like any other.
 */
export async function accountTotals(
  db: Kysely<Database> = getDb(),
): Promise<AccountTotal[]> {
  const rows = await db
    .selectFrom("account")
    .innerJoin("person", "person.id", "account.owner_id")
    .leftJoin("holding_valued", "holding_valued.account_id", "account.id")
    .select([
      "account.id as account_id",
      "account.name as account_name",
      "account.institution as institution",
      "account.kind as account_kind",
      "person.name as owner_name",
      sql<string>`cast(coalesce(sum(holding_valued.value), 0) as numeric(20, 4))`.as("amount"),
      // `is_priced` is null on the row the left join manufactures for an
      // account with no holdings, and a null does not pass the filter.
      sql<string>`count(*) filter (where holding_valued.is_priced)`.as("known"),
      // Counts the joined column rather than the row, for the same reason:
      // `count(*)` would score that manufactured row as one holding.
      sql<string>`count(holding_valued.instrument_id)`.as("total"),
    ])
    // The view already drops closed accounts; joining from `account` reaches
    // past that, so the rule has to be restated here to keep a closed account
    // out rather than let it in as one holding nothing.
    .where("account.closed_at", "is", null)
    .groupBy([
      "account.id",
      "account.name",
      "account.institution",
      "account.kind",
      "person.name",
    ])
    // `sum(...)` again rather than the aliased `amount`: an alias is not in
    // scope in ORDER BY across every Postgres version this may meet.
    .orderBy(sql`coalesce(sum(holding_valued.value), 0)`, "desc")
    .orderBy("account.name")
    .execute();

  return rows.map(toAccountTotal);
}

/**
 * One account's identity and current value, or null if there is no such open
 * account.
 *
 * Deliberately the same {@link AccountTotal} the list above returns rather than
 * a second, drill-down-shaped type: the figure at the top of an account page
 * and the figure in its row on the overview are one arithmetic over one view,
 * and giving them separate types is how they would come to disagree. The two
 * must also agree value for value — {@link accountTotals} is this query
 * without the id filter, and an account either appears in both or in neither.
 *
 * Grouped from `account` with the view LEFT joined onto it, which is what makes
 * that possible: an account whose statements are all empty — a brokerage sold
 * down to nothing, an account created before its first upload — has no rows in
 * the view at all, and an inner join would report it as missing rather than as
 * holding nothing. It comes back as `0.0000` over a coverage of
 * zero rows, which says "nothing to value" and not "worth nothing".
 *
 * Null covers both an id that names no account and a closed one. Closed is not
 * an error and not a zero: `holding_valued` excludes closed accounts (§8.2), so
 * a drill-down on one would otherwise render an account page whose every figure
 * is a blank — the caller should 404 instead.
 *
 * @param accountId the account's id as it arrives from a URL, digits or not.
 */
export async function accountTotal(
  accountId: string,
  db: Kysely<Database> = getDb(),
): Promise<AccountTotal | null> {
  const row = await db
    .selectFrom("account")
    .innerJoin("person", "person.id", "account.owner_id")
    .leftJoin("holding_valued", "holding_valued.account_id", "account.id")
    .select([
      "account.id as account_id",
      "account.name as account_name",
      "account.institution as institution",
      "account.kind as account_kind",
      "person.name as owner_name",
      sql<string>`cast(coalesce(sum(holding_valued.value), 0) as numeric(20, 4))`.as("amount"),
      // `is_priced` is null on the manufactured row here too — see
      // {@link accountTotals}, which runs the identical query shape.
      sql<string>`count(*) filter (where holding_valued.is_priced)`.as("known"),
      // Counts the joined column, not the row, for the same reason as above.
      sql<string>`count(holding_valued.instrument_id)`.as("total"),
    ])
    .where(isAccount("account.id", accountId))
    // The view already drops closed accounts, so this is not a second copy of
    // that rule: it is what turns "closed" into null instead of into an
    // account reported as holding nothing.
    .where("account.closed_at", "is", null)
    .groupBy([
      "account.id",
      "account.name",
      "account.institution",
      "account.kind",
      "person.name",
    ])
    .executeTakeFirst();

  return row === undefined ? null : toAccountTotal(row);
}

/**
 * One account's holdings, valued, on the same terms as {@link currentHoldings}.
 *
 * The same rows that account contributes to the overview's total, filtered —
 * not a second definition of what the account holds. An unpriced holding is
 * here too, carrying `isPriced: false`, so the drill-down's table can say which
 * line the account's total is missing.
 *
 * Empty for an account that holds nothing, for one that is closed, and for an
 * id that names no account: all three hold nothing right now, and which of them
 * it is, is {@link accountTotal}'s answer rather than this one's.
 */
export async function accountHoldings(
  accountId: string,
  db: Kysely<Database> = getDb(),
): Promise<ValuedHolding[]> {
  return readHoldings(db, valuedNow(), isAccount("holding_valued.account_id", accountId));
}

/**
 * A value at each of `dates`, over whatever `where` narrows it to, in a single
 * round trip.
 *
 * The obvious implementation is {@link netWorthAt} in a loop, which is one
 * query per point and re-plans `holding_valued_at` every time. A lateral join
 * over the date array evaluates the same function once per date inside one
 * statement, which is the difference between twenty-five round trips and one.
 *
 * @param dates `YYYY-MM-DD`, in any order; the result comes back sorted.
 */
async function readSeries(
  db: Kysely<Database>,
  dates: IsoDate[],
  where?: RawBuilder<SqlBool>,
): Promise<NetWorthPoint[]> {
  if (dates.length === 0) return [];

  const rows = await db
    .selectFrom(sql<{ date: string }>`unnest(cast(${dates} as date[]))`.as("d"))
    // LEFT, not INNER. A date before the first upload has no rows to join, and
    // an inner join drops that date from the result entirely — the chart would
    // then skip it silently rather than report it as uncovered, which is the
    // difference between "nothing was recorded" and "we did not mention it".
    .leftJoinLateral(
      (join) => {
        const held = join.selectFrom(sql`holding_valued_at(d.date)`.as("v")).selectAll();

        // The narrowing goes inside the lateral, never in the outer WHERE. A
        // WHERE out there is evaluated after the join and rejects the all-null
        // row, which would take the uncovered date down with it — the LEFT
        // join above undone by the filter beside it.
        return (where === undefined ? held : held.where(where)).as("v");
      },
      (join) => join.onTrue(),
    )
    .select([
      sql<string>`cast(d.date as text)`.as("date"),
      sql<string>`cast(coalesce(sum(v.value), 0) as numeric(20, 4))`.as("amount"),
      sql<string>`count(*) filter (where v.is_priced)`.as("known"),
      // Counts the joined column, not the row: the left join manufactures one
      // all-null row per uncovered date, and `count(*)` would score it as 1.
      sql<string>`count(v.instrument_id)`.as("total"),
    ])
    .groupBy(sql`d.date`)
    .orderBy(sql`d.date`)
    .execute();

  return rows.map((row) => ({
    date: row.date,
    amount: row.amount,
    coverage: { known: Number(row.known), total: Number(row.total) },
  }));
}

/**
 * Net worth at each of `dates`, in a single round trip.
 *
 * A date before the first upload contributes `0.0000` over a coverage of zero
 * rows — "nothing was recorded yet", which the caller must not draw as a real
 * zero (DESIGN.md §7). {@link netWorthSeries} callers use `coverage.total` to
 * find where the computed line actually starts.
 */
export async function netWorthSeries(
  dates: IsoDate[],
  db: Kysely<Database> = getDb(),
): Promise<NetWorthPoint[]> {
  return readSeries(db, dates);
}

/**
 * One account's value at each of `dates`, on the same terms as
 * {@link netWorthSeries} and in the same single round trip.
 *
 * The same {@link NetWorthPoint} shape, deliberately: an account's line and the
 * household's line are the same measure over different row sets, and a chart
 * that can draw one can draw the other with no second code path.
 *
 * Every date the account did not exist for is reported rather than skipped.
 * Dates before its first statement come back as `0.0000` over a coverage of
 * zero rows, and so do dates after it closed — an account's chart therefore
 * starts where its history starts instead of climbing out of a fictional zero
 * (DESIGN.md §7), as long as the caller reads `coverage.total` rather than the
 * amount to decide where the line begins.
 */
export async function accountSeries(
  accountId: string,
  dates: IsoDate[],
  db: Kysely<Database> = getDb(),
): Promise<NetWorthPoint[]> {
  return readSeries(db, dates, isAccount("v.account_id", accountId));
}

/**
 * The hand-typed series that prefixes the chart (DESIGN.md §7).
 *
 * Returned raw and unmerged. Merging is the caller's, because rule 2 —
 * computed wins on overlapping dates, manual only fills gaps — is a display
 * rule about two lines, not a fact about either one.
 */
export async function manualNetWorth(
  db: Kysely<Database> = getDb(),
): Promise<ManualPoint[]> {
  const rows = await db
    .selectFrom("manual_networth")
    .select([sql<string>`cast(date as text)`.as("date"), "amount"])
    .orderBy("date")
    .execute();

  return rows.map((row) => ({ date: row.date, amount: String(row.amount) }));
}

/**
 * Net worth now, net worth then, and the movement between them.
 *
 * The headline's "+$14,921.00 / +1.2%" pair. Both figures are computed in SQL
 * in `numeric` for the reason §4.1 gives: a difference of two six-figure
 * balances is exactly where float drift becomes visible, and the percentage
 * derived from it inherits the error. Nothing here crosses into JavaScript as
 * anything but a decimal string.
 *
 * The percentage divides by `abs(previous)` rather than `previous`, so a
 * household climbing out of net debt reports a rise as a rise. Dividing by a
 * signed negative reports recovery as `-x%`, which is the wrong sign on the one
 * figure a person reads fastest.
 */
export type NetWorthChange = {
  current: string;
  previous: string;
  difference: string;
  /**
   * Null when `previous` is zero. A percentage change from nothing is
   * undefined, not 0% and not infinite — the screen omits it rather than
   * inventing one.
   */
  percent: string | null;
};

/**
 * @param since `YYYY-MM-DD`, the start of the window being reported.
 */
export async function netWorthChange(
  since: IsoDate,
  db: Kysely<Database> = getDb(),
): Promise<NetWorthChange> {
  const row = await db
    .with("present", (qb) =>
      qb
        .selectFrom(valuedNow())
        .select(sql<string>`coalesce(sum(value), 0)`.as("amount")),
    )
    .with("past", (qb) =>
      qb
        .selectFrom(valuedAt(since))
        .select(sql<string>`coalesce(sum(value), 0)`.as("amount")),
    )
    .selectFrom(["present", "past"])
    .select([
      sql<string>`cast(present.amount as numeric(20, 4))`.as("current"),
      sql<string>`cast(past.amount as numeric(20, 4))`.as("previous"),
      sql<string>`cast(present.amount - past.amount as numeric(20, 4))`.as("difference"),
      sql<string | null>`case
        when past.amount = 0 then null
        else cast((present.amount - past.amount) / abs(past.amount) * 100 as numeric(10, 4))
      end`.as("percent"),
    ])
    .executeTakeFirstOrThrow();

  return {
    current: row.current,
    previous: row.previous,
    difference: row.difference,
    percent: row.percent,
  };
}

/**
 * The earliest date any statement records, or null on an instance with none.
 *
 * Day zero (DESIGN.md §7). The "All" range needs it because a fixed wide window
 * would spend most of its samples on the years before the app existed, where
 * every point comes back uncovered and is discarded — an all-time chart drawn
 * almost entirely from nothing.
 *
 * Read from `position_set` rather than from the view: this is the date history
 * *begins*, which is a fact about what was uploaded, and it stays correct for a
 * range whose accounts have all since been closed.
 */
export async function firstRecordedDate(
  db: Kysely<Database> = getDb(),
): Promise<IsoDate | null> {
  const row = await db
    .selectFrom("position_set")
    .select(sql<string | null>`cast(min(as_of_date) as text)`.as("date"))
    .executeTakeFirst();

  return row?.date ?? null;
}
