/**
 * The only reader of `holding_valued` and `holding_valued_at`, and — since
 * ADR-0006 — the only thing that *values* anything from `price_observation`
 * (the intra-session readers at the foot). DESIGN.md §8.2 names hand-rolled
 * dashboard queries disagreeing as the design's weakest point; the mitigation
 * is one SQL view and this one module over it. A dashboard writing its own
 * join to `holding` has left the mitigation.
 *
 * A translation layer, not a service: no caching, no rules beyond assembling
 * coverage counts — every valuation rule lives in the view, in SQL, where the
 * arithmetic is exact. Every numeric field returned is a decimal string
 * (`server/db.ts`); the only numbers are {@link Coverage} cardinalities.
 * Every exported query takes an optional `db`, defaulting to the process
 * pool; tests pass a transaction they roll back.
 *
 * Every household-scoped reader takes an {@link OwnerFilter} **first**, no
 * default (ADR-0008): a screen cannot read holdings without saying whose, so
 * an omission is a word missing from a diff rather than a behaviour missing
 * from a screen. Account-scoped readers take none — an account is already
 * narrower than an owner, and asking again would invite "this account, if its
 * owner is also selected", which no screen means.
 */
import { sql } from "kysely";

import { getDb, type Database } from "./db.server.ts";
import { isFiltered, type OwnerFilter } from "./owner-filter.ts";

import type { AliasedRawBuilder, Kysely, RawBuilder, Selectable, SqlBool } from "kysely";

/** `account.kind`, constrained by a check constraint in the schema. */
export type AccountKind = "brokerage" | "401k" | "ira" | "bank" | "liability";

/**
 * `account.tax_treatment`. Three-way, not boolean: $500k Traditional is
 * ~$350k of spending power where $500k Roth is $500k — a boolean throws away
 * exactly that (DESIGN.md §4.5).
 */
export type TaxTreatment = "taxable" | "tax_deferred" | "tax_free";

/** `classification.asset_class` — the fixed rollup under the user's labels. */
export type AssetClass = "equity" | "bond" | "cash" | "other";

/**
 * One holding, valued, with everything a dashboard groups by on it. Cash is a
 * `USD` position priced at 1.00 and a liability a negative `USD` quantity, so
 * nothing reading this shape needs a branch for either (DESIGN.md §2).
 */
export type ValuedHolding = {
  accountId: string;
  accountName: string;
  /**
   * `account.external_account_number` — free-form, null when none is
   * recorded. Display identity for the number tail (CONTEXT.md), not a
   * view column: a label does not belong in the valuation contract
   * (ADR-0001), so {@link readHoldings} joins `account` for it instead.
   */
  externalAccountNumber: string | null;
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
   * The provider's word — `EQUITY`, `ETF`, `MUTUALFUND`, the seeded
   * `CURRENCY`. Null for an instrument nobody quotes: a hand-priced
   * workplace-plan trust, not a fault.
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
   * Projected pay over the coming year: quantity × current per-share rate,
   * computed in the view. Never null on the current path — a missing rate
   * coalesces to zero because "pays nothing" and "nobody asked" are the same
   * null in `quote` (DESIGN.md §14, limitation 9) — and always null on an
   * as-of path: the projection describes now, and no historical rate is stored.
   */
  annualDividend: string | null;
};

/**
 * How much of a figure is known: "based on 8 of 12 holdings". The alternative
 * — coercing unknown to zero — reports a total that looks complete and is
 * not, the failure this design refuses everywhere.
 */
export type Coverage = { known: number; total: number };

/** A money figure and how much of the portfolio it was computed from. */
export type Total = { amount: string; coverage: Coverage };

/** One row of the view, as the generated types describe it. */
type HoldingValuedRow = Selectable<Database["holding_valued"]>;

/**
 * Postgres reports every view column as nullable regardless of reality, so
 * the generated type is wider than the view can produce. Narrow loudly: a
 * null here means the view and this module disagree about the schema — a bug
 * to surface, not paper over.
 */
function required<T>(value: T | null, column: string): T {
  if (value === null) {
    throw new Error(`holding_valued.${column} was null, which the view cannot produce.`);
  }
  return value;
}

function toValuedHolding(
  row: HoldingValuedRow & { external_account_number: string | null },
): ValuedHolding {
  return {
    accountId: required(row.account_id, "account_id"),
    accountName: required(row.account_name, "account_name"),
    // Not `required`: genuinely nullable — most accounts never record one.
    externalAccountNumber: row.external_account_number,
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
    // Not `required`: genuinely nullable — `instrument-resolution.server.ts`
    // writes null on purpose for a manually priced instrument, and insisting
    // would 500 the screens over a 401k trust.
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
    // Not `required`: the as-of function reports null on purpose and this
    // mapper reads both — narrowing would 500 every historical read (ADR-0001).
    annualDividend: row.annual_dividend,
  };
}

/**
 * A calendar date, `YYYY-MM-DD`, crossing as a string in both directions:
 * default `pg` parses `date` at *local* midnight, and a round trip west of
 * UTC lands on the previous day — the wrong position set, no error anywhere.
 * `server/db.ts` registers the parser that prevents it.
 */
export type IsoDate = string;

/**
 * Where a read gets its rows: the view for "now", the function for a date.
 * One type covers both because the function `returns setof holding_valued`,
 * so everything below is written once and reads either; aliasing both to
 * `holding_valued` keeps the column names identical.
 */
type ValuedSource = AliasedRawBuilder<HoldingValuedRow, "holding_valued">;

const valuedNow = (): ValuedSource =>
  sql.table<HoldingValuedRow>("holding_valued").as("holding_valued");

/** What was held on `date`, priced at that date's carried-forward close. */
const valuedAt = (date: IsoDate): ValuedSource =>
  sql<HoldingValuedRow>`holding_valued_at(${date}::date)`.as("holding_valued");

/**
 * Ordering is for determinism, not display; a screen sorts as it likes.
 * `where` narrows the same read — a drill-down writing its own join to the
 * view would be the fourth hand-rolled query §8.2 warns about; this is the
 * same rows filtered.
 */
async function readHoldings(
  db: Kysely<Database>,
  source: ValuedSource,
  where?: RawBuilder<SqlBool>,
): Promise<ValuedHolding[]> {
  // The account join carries only the number tail's column: display identity,
  // deliberately not a view column (ADR-0001 makes widening `holding_valued`
  // a paired migration, and a label is not part of the valuation contract).
  const all = db
    .selectFrom(source)
    .innerJoin("account", "account.id", "holding_valued.account_id")
    .selectAll("holding_valued")
    .select("account.external_account_number");

  const rows = await (where === undefined ? all : all.where(where))
    .orderBy("account_name")
    .orderBy("instrument_name")
    .orderBy("instrument_id")
    .execute();

  return rows.map(toValuedHolding);
}

/**
 * One `SUM` over `value`, no branch for cash or debt, in SQL in `numeric` so
 * no float touches it. Unpriced holdings add nothing to `amount` but count in
 * `coverage.total`, so a partial answer is labelled partial — a zero standing
 * in for an unknown price would look like a genuinely empty account.
 */
async function readTotal(
  db: Kysely<Database>,
  source: ValuedSource,
  where?: RawBuilder<SqlBool>,
): Promise<Total> {
  const all = db
    .selectFrom(source)
    .select([
      // `value` is null exactly when unpriced and SUM skips nulls, so no
      // filter needed; coalesce covers the empty portfolio — zero, not null.
      sql<string>`cast(coalesce(sum(value), 0) as numeric(20, 4))`.as("amount"),
      sql<string>`count(*) filter (where is_priced)`.as("known"),
      sql<string>`count(*)`.as("total"),
    ]);

  const row = await (where === undefined ? all : all.where(where)).executeTakeFirstOrThrow();

  return {
    amount: row.amount,
    // Counts, not money — cardinalities cannot reach the precision limit.
    coverage: { known: Number(row.known), total: Number(row.total) },
  };
}

/**
 * Every holding currently held, valued. "Currently" is the view's business:
 * newest position set per account, deterministic tie-break, closed accounts
 * excluded. A never-priced holding is here too (`isPriced: false`) — dropping
 * it would understate every total silently.
 */
export async function currentHoldings(
  filter: OwnerFilter,
  db: Kysely<Database> = getDb(),
): Promise<ValuedHolding[]> {
  return readHoldings(db, valuedNow(), ownedBy("holding_valued.owner_id", filter));
}

/** Net worth right now, and how much of it is known. */
export async function netWorth(
  filter: OwnerFilter,
  db: Kysely<Database> = getDb(),
): Promise<Total> {
  return readTotal(db, valuedNow(), ownedBy("holding_valued.owner_id", filter));
}

/**
 * Every holding held on a past date, valued at that date's carried-forward
 * close — a Saturday equals the preceding Friday, so does a holiday, no
 * calendar anywhere. It does not invent a past: an account whose first upload
 * is after `date` contributes no rows rather than a zero (DESIGN.md §7 — the
 * period before belongs to `manual_networth`); an account closed after `date`
 * is included, because it was open then. `isStale` is always false: staleness
 * belongs to a live quote; a historical close is simply the close.
 *
 * @param date `YYYY-MM-DD`, any date — cash and debt still price at 1.00
 *             through the same carry-forward, no special case.
 */
export async function holdingsAt(
  filter: OwnerFilter,
  date: IsoDate,
  db: Kysely<Database> = getDb(),
): Promise<ValuedHolding[]> {
  return readHoldings(db, valuedAt(date), ownedBy("holding_valued.owner_id", filter));
}

/**
 * Net worth on a past date, on {@link netWorth}'s terms. Before the first
 * upload: `0.0000` over zero coverage — "nothing was recorded yet", not "the
 * household had nothing", and the coverage count lets a chart say so.
 *
 * @param date `YYYY-MM-DD`.
 */
export async function netWorthAt(
  filter: OwnerFilter,
  date: IsoDate,
  db: Kysely<Database> = getDb(),
): Promise<Total> {
  return readTotal(db, valuedAt(date), ownedBy("holding_valued.owner_id", filter));
}

/**
 * One account's holdings, rolled up in SQL — JS addition of decimal strings
 * is either wrong (`Number`) or a decimal library redoing what `numeric` does
 * exactly. Reads the same view as everything else, so an account's total and
 * the net worth headline cannot disagree (DESIGN.md §8.2).
 */
export type AccountTotal = {
  accountId: string;
  accountName: string;
  /** `account.external_account_number` — {@link ValuedHolding}'s field, same terms. */
  externalAccountNumber: string | null;
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
 * The rollup's columns under the view's names, shared by the list and the
 * single-account query below so the two cannot describe one account
 * differently — the reason the view exists (DESIGN.md §8.2).
 */
type AccountTotalRow = {
  account_id: string | null;
  account_name: string | null;
  external_account_number: string | null;
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
    // Not `required`: genuinely nullable — most accounts never record one.
    externalAccountNumber: row.external_account_number,
    institution: required(row.institution, "institution"),
    accountKind: required(row.account_kind, "account_kind") as AccountKind,
    ownerName: required(row.owner_name, "owner_name"),
    amount: row.amount,
    // Counts, not money: see {@link readTotal}.
    coverage: { known: Number(row.known), total: Number(row.total) },
  };
}

/**
 * The largest value a `bigint` column can hold. The bound is on *magnitude*,
 * not character count: `0000000000000000001` is nineteen characters and is
 * account 1 — a digit-count guard would 404 a row that exists. Compared as
 * `BigInt` (§5.6): past 2^53 a float rounds, admitting exactly the values
 * this exists to refuse.
 */
const MAX_BIGINT = 9223372036854775807n;

/** Whether an id could name a row, rather than error inside Postgres. */
function couldBeId(id: string): boolean {
  return /^\d+$/.test(id) && BigInt(id) <= MAX_BIGINT;
}

/**
 * `<column> in (<ids>)`, or a match-nothing predicate when none could be an
 * id. Ids arrive as strings against `bigint` columns, and a non-digit id from
 * a URL would fail inside Postgres; saying "no such row" in SQL keeps every
 * empty answer coming from the query that would have answered anyway.
 * Unusable ids drop from the list, not the predicate — `?owner=1,abc` still
 * narrows to owner 1 — but nothing usable yields `false`, never an empty
 * `in ()` and never silently no filter: widening a view somebody asked to
 * narrow is the failure `holdings-view.ts` names.
 */
function isOneOf(column: string, ids: readonly string[]): RawBuilder<SqlBool> {
  const usable = ids.filter(couldBeId);

  return usable.length === 0
    ? sql<SqlBool>`false`
    : sql<SqlBool>`${sql.ref(column)} in (${sql.join(usable.map((id) => sql`${id}`))})`;
}

/** {@link isOneOf} for the single-id case, which is every account-scoped read. */
function isAccount(column: string, accountId: string): RawBuilder<SqlBool> {
  return isOneOf(column, [accountId]);
}

/**
 * The owner narrowing, or nothing when the filter is off — `undefined` rather
 * than a tautology keeps an unfiltered read the query it has always been.
 */
function ownedBy(column: string, filter: OwnerFilter): RawBuilder<SqlBool> | undefined {
  return isFiltered(filter) ? isOneOf(column, filter) : undefined;
}

/**
 * Every open account with its current value, largest first; a liability sorts
 * to the bottom by construction, not a branch (negative sum, DESIGN.md §2).
 * Row for row the same answer {@link accountTotal} gives, as a rule rather
 * than a coincidence: the overview row and drill-down headline are one figure
 * shown twice, grouped the same way from the same source. LEFT join, because
 * grouping the view directly would silently drop exactly the empty accounts
 * it exists to keep — `0.0000` over zero rows, sorting between assets and
 * liabilities, where a zero belongs.
 */
export async function accountTotals(
  filter: OwnerFilter,
  db: Kysely<Database> = getDb(),
): Promise<AccountTotal[]> {
  const owned = ownedBy("account.owner_id", filter);

  const base = db
    .selectFrom("account")
    .innerJoin("person", "person.id", "account.owner_id")
    .leftJoin("holding_valued", "holding_valued.account_id", "account.id")
    .select([
      "account.id as account_id",
      "account.name as account_name",
      "account.external_account_number as external_account_number",
      "account.institution as institution",
      "account.kind as account_kind",
      "person.name as owner_name",
      sql<string>`cast(coalesce(sum(holding_valued.value), 0) as numeric(20, 4))`.as("amount"),
      // `is_priced` is null on the row the left join manufactures for an
      // empty account, and a null does not pass the filter.
      sql<string>`count(*) filter (where holding_valued.is_priced)`.as("known"),
      // The joined column, not the row: `count(*)` would score that
      // manufactured row as one holding.
      sql<string>`count(holding_valued.instrument_id)`.as("total"),
    ])
    // The view already drops closed accounts; joining from `account` reaches
    // past that, so the rule is restated here.
    .where("account.closed_at", "is", null);

  // Narrowed on `account.owner_id`, not through the view: an account holding
  // nothing still reports 0.0000, and the view's owner column is null on
  // exactly those manufactured rows.
  const rows = await (owned === undefined ? base : base.where(owned))
    .groupBy([
      "account.id",
      "account.name",
      "account.external_account_number",
      "account.institution",
      "account.kind",
      "person.name",
    ])
    // `sum(...)` again, not the alias: an alias is not in scope in ORDER BY
    // on every Postgres version this may meet.
    .orderBy(sql`coalesce(sum(holding_valued.value), 0)`, "desc")
    .orderBy("account.name")
    .execute();

  return rows.map(toAccountTotal);
}

/**
 * One account's identity and current value, or null when there is no such
 * open account. Deliberately the same {@link AccountTotal} as the list — the
 * account page's headline and its overview row are one arithmetic over one
 * view, and separate types is how they would come to disagree
 * ({@link accountTotals} is this query without the id filter). LEFT join from
 * `account`, so an account with no view rows — sold down to nothing, created
 * before its first upload — reports `0.0000` over zero coverage: "nothing to
 * value", not "worth nothing" or missing.
 *
 * Null covers an id naming no account and a closed one alike. Closed is not
 * an error and not a zero: the view excludes closed accounts (§8.2), so a
 * drill-down would render a page of blanks — the caller should 404 instead.
 *
 * @param accountId as it arrives from a URL, digits or not.
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
      "account.external_account_number as external_account_number",
      "account.institution as institution",
      "account.kind as account_kind",
      "person.name as owner_name",
      sql<string>`cast(coalesce(sum(holding_valued.value), 0) as numeric(20, 4))`.as("amount"),
      // `is_priced` is null on the manufactured row here too — see
      // {@link accountTotals}, the identical query shape.
      sql<string>`count(*) filter (where holding_valued.is_priced)`.as("known"),
      sql<string>`count(holding_valued.instrument_id)`.as("total"),
    ])
    .where(isAccount("account.id", accountId))
    // Not a second copy of the view's closed-account rule: this is what turns
    // "closed" into null instead of an account holding nothing.
    .where("account.closed_at", "is", null)
    .groupBy([
      "account.id",
      "account.name",
      "account.external_account_number",
      "account.institution",
      "account.kind",
      "person.name",
    ])
    .executeTakeFirst();

  return row === undefined ? null : toAccountTotal(row);
}

/**
 * One account's holdings on {@link currentHoldings}' terms — the same rows it
 * contributes to the overview total, filtered, unpriced ones included so the
 * table can say which line the total is missing. Empty for holds-nothing,
 * closed, and no-such-id alike; which it is, is {@link accountTotal}'s answer.
 */
export async function accountHoldings(
  accountId: string,
  db: Kysely<Database> = getDb(),
): Promise<ValuedHolding[]> {
  return readHoldings(db, valuedNow(), isAccount("holding_valued.account_id", accountId));
}

/**
 * A value at each of `dates` in a single round trip: a lateral join over the
 * date array evaluates `holding_valued_at` once per date inside one statement
 * — where {@link netWorthAt} in a loop is a round trip and a re-plan per point.
 *
 * @param dates `YYYY-MM-DD`, any order; the result comes back sorted.
 */
async function readSeries(
  db: Kysely<Database>,
  dates: IsoDate[],
  where?: RawBuilder<SqlBool>,
): Promise<NetWorthPoint[]> {
  if (dates.length === 0) return [];

  const rows = await db
    .selectFrom(sql<{ date: string }>`unnest(cast(${dates} as date[]))`.as("d"))
    // LEFT, not INNER: a date before the first upload has no rows, and an
    // inner join would drop it silently rather than report it uncovered —
    // "nothing was recorded" versus "we did not mention it".
    .leftJoinLateral(
      (join) => {
        const held = join.selectFrom(sql`holding_valued_at(d.date)`.as("v")).selectAll();

        // Narrowing goes inside the lateral, never the outer WHERE: out there
        // it runs after the join, rejects the all-null row, and takes the
        // uncovered date down with it.
        return (where === undefined ? held : held.where(where)).as("v");
      },
      (join) => join.onTrue(),
    )
    .select([
      sql<string>`cast(d.date as text)`.as("date"),
      sql<string>`cast(coalesce(sum(v.value), 0) as numeric(20, 4))`.as("amount"),
      sql<string>`count(*) filter (where v.is_priced)`.as("known"),
      // The joined column, not the row: the left join manufactures one
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
 * Net worth at each of `dates`, one round trip. A date before the first
 * upload is `0.0000` over zero coverage, which the caller must not draw as a
 * real zero (DESIGN.md §7) — `coverage.total` says where the line starts.
 */
export async function netWorthSeries(
  filter: OwnerFilter,
  dates: IsoDate[],
  db: Kysely<Database> = getDb(),
): Promise<NetWorthPoint[]> {
  // `v` is the lateral's alias — the narrowing goes inside it (readSeries).
  return readSeries(db, dates, ownedBy("v.owner_id", filter));
}

/**
 * One account's value at each of `dates`, same terms, same round trip, same
 * {@link NetWorthPoint} shape — an account's line and the household's are one
 * measure over different rows, so one chart code path draws both. Dates
 * before its first statement and after it closed come back `0.0000` over zero
 * coverage, reported rather than skipped: the chart starts where history
 * starts, not out of a fictional zero (DESIGN.md §7), provided the caller
 * reads `coverage.total`.
 */
export async function accountSeries(
  accountId: string,
  dates: IsoDate[],
  db: Kysely<Database> = getDb(),
): Promise<NetWorthPoint[]> {
  return readSeries(db, dates, isAccount("v.account_id", accountId));
}

/** One point on an intra-session line: the instant it describes, and the value then. */
export type SessionPoint = {
  /**
   * An ISO instant, not a date — hence `at`. A signpost inside this module,
   * not a guarantee across it: the chart widens its own `date` to hold either
   * and is told which it is drawing rather than inferring it (`ChartPoint`).
   */
  at: string;
  amount: string;
  coverage: Coverage;
};

/**
 * The most recent observed session, or null when nothing was ever observed.
 * Read off the log, not the calendar (ADR-0006): `max(market_date)` is
 * stamped at write time by the same rule that files a daily close, so the
 * UTC-today/market-day seam never decides what 1D shows, a weekend answers
 * with Friday's session, and a half-day ends where its observations end.
 * Matched by `price_observation_market_date_idx` — a backward scan stopping
 * at row one.
 */
export async function latestObservedSession(
  db: Kysely<Database> = getDb(),
): Promise<IsoDate | null> {
  const row = await db
    .selectFrom("price_observation")
    .select(sql<string>`cast(max(market_date) as text)`.as("session"))
    .executeTakeFirst();

  return row?.session ?? null;
}

/**
 * What a surface was worth at each instant a session was observed at — the
 * only thing that values anything from the observation log (§4.2's
 * single-site rule extended to the third tier). Three unobvious decisions:
 *
 * **The instants come from the log as a whole, not the surface.** A cash-only
 * account observes nothing; asking it for its own instants would draw an
 * empty chart where the honest answer is "it did not move". Both surfaces
 * plot the same moments; the surface narrows only whose holdings are valued.
 *
 * **Each point values the positions held now at the price known then**, so an
 * upload during the session leaves the chart consistent with the headline:
 * same positions, only the price moves.
 *
 * **The fallback carries forward the last close *strictly before* the
 * session.** The session's own `price_daily` row is provisional and converges
 * on the day's last observation — including it would price the open at the
 * close. Reaching past it prices cash (a dollar since 1970), hand-priced
 * trusts, failed fetches and the minutes before the first quote correctly.
 *
 * One case the fallback cannot answer, and does not pretend to: an instrument
 * whose first close of any kind is the session's own — bought this morning,
 * or first priced today. Before its first observation there is genuinely no
 * price, so it contributes no value and is out of `known`: a step in the
 * line, reported per-point by `coverage`. And an account closed *during* the
 * session is absent from the whole 1D line ("positions held now"), while
 * `holding_valued_at` still counts it that day — 1D and 1W may disagree about
 * it, the price of valuing today's positions rather than the day's.
 *
 * Arithmetic is `numeric` throughout and never leaves SQL (§5.6).
 *
 * @param session `YYYY-MM-DD`, from {@link latestObservedSession}.
 */
async function readSessionSeries(
  db: Kysely<Database>,
  session: IsoDate,
  where?: RawBuilder<SqlBool>,
): Promise<SessionPoint[]> {
  // Narrowed inside the lateral, never the outer WHERE — `readSeries`'s
  // reason: a filter out there rejects the manufactured all-null row and
  // takes the instant down with it.
  const narrowing = where === undefined ? sql`true` : where;

  const rows = await sql<{ at: Date; amount: string; known: string; total: string }>`
    select
      instants.as_of as at,
      cast(coalesce(sum(valued.value), 0) as numeric(20, 4)) as amount,
      count(*) filter (where valued.price is not null) as known,
      count(valued.instrument_id) as total

    from (
      select distinct as_of
      from price_observation
      where market_date = ${session}::date
    ) instants

    left join lateral (
      select
        held.instrument_id                                   as instrument_id,
        resolved.price                                       as price,
        cast(held.quantity * resolved.price
             as numeric(20, 4))                              as value

      from account a
      join holding held
        on held.position_set_id = latest_position_set(a.id)

      -- The price the feed had told us by this instant, if any.
      left join lateral (
        select o.price
        from price_observation o
        where o.instrument_id = held.instrument_id
          and o.as_of <= instants.as_of
        order by o.as_of desc
        limit 1
      ) observed on true

      -- Otherwise the last close strictly before the session (see docstring).
      left join lateral (
        select pd.close
        from price_daily pd
        where pd.instrument_id = held.instrument_id
          and pd.date < ${session}::date
        order by pd.date desc
        limit 1
      ) carried on true

      cross join lateral (
        select coalesce(observed.price, carried.close) as price
      ) resolved

      where a.closed_at is null
        and ${narrowing}
    ) valued on true

    group by instants.as_of
    order by instants.as_of
  `.execute(db);

  return rows.rows.map((row) => ({
    // UTC, deterministically — the chart labels on the market's clock and
    // must reach the browser saying what the server rendered.
    at: row.at.toISOString(),
    amount: row.amount,
    // Cardinalities of holdings, not money.
    coverage: { known: Number(row.known), total: Number(row.total) },
  }));
}

/**
 * A day-granularity series in the session shape: two readers, one chart
 * contract. Here rather than in each loader because a rule copied into two
 * loaders drifts. The direction is deliberate — widening a date into the
 * instant field is honest (a date names a moment, coarsely), where narrowing
 * an instant would throw away the time of day the session line exists for.
 */
export function asSessionPoints(series: NetWorthPoint[]): SessionPoint[] {
  return series.map((point) => ({ at: point.date, amount: point.amount, coverage: point.coverage }));
}

/**
 * Net worth at each instant of the session — the Overview's 1D line. No
 * observations returns an empty series, not a flat one: "nothing was
 * observed" is not "nothing moved".
 */
export async function netWorthSessionSeries(
  filter: OwnerFilter,
  session: IsoDate,
  db: Kysely<Database> = getDb(),
): Promise<SessionPoint[]> {
  // `a` is the account alias inside the lateral, where this has to go.
  return readSessionSeries(db, session, ownedBy("a.owner_id", filter));
}

/**
 * One account at each instant of the same session, same terms. A cash-only
 * account draws a flat line rather than an empty one: the instants are the
 * log's, so every account answers at the same moments.
 */
export async function accountSessionSeries(
  accountId: string,
  session: IsoDate,
  db: Kysely<Database> = getDb(),
): Promise<SessionPoint[]> {
  return readSessionSeries(db, session, isAccount("a.id", accountId));
}

/**
 * The hand-typed prefix series (DESIGN.md §7), raw and unmerged: rule 2 —
 * computed wins on overlap, manual only fills gaps — is a display rule about
 * two lines, not a fact about either one.
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
 * The headline's "+$14,921.00 / +1.2%" pair, computed in SQL in `numeric`
 * (§4.1): the difference of two six-figure balances is exactly where float
 * drift shows, and the percentage inherits it. Divides by `abs(previous)` so
 * a household climbing out of net debt reports a rise as a rise — a signed
 * negative would report recovery as `-x%`, the wrong sign on the one figure a
 * person reads fastest.
 */
export type NetWorthChange = {
  current: string;
  previous: string;
  difference: string;
  /**
   * Null when `previous` is zero: a change from nothing is undefined, not 0%
   * and not infinite — the screen omits it rather than inventing one.
   */
  percent: string | null;
};

/** @param since `YYYY-MM-DD`, the start of the window being reported. */
export async function netWorthChange(
  filter: OwnerFilter,
  since: IsoDate,
  db: Kysely<Database> = getDb(),
): Promise<NetWorthChange> {
  // Both ends, or the delta compares one owner against the whole household.
  const owned = ownedBy("holding_valued.owner_id", filter);
  const narrow = <T extends { where(w: RawBuilder<SqlBool>): T }>(qb: T): T =>
    owned === undefined ? qb : qb.where(owned);

  const row = await db
    .with("present", (qb) =>
      narrow(qb.selectFrom(valuedNow()))
        .select(sql<string>`coalesce(sum(value), 0)`.as("amount")),
    )
    .with("past", (qb) =>
      narrow(qb.selectFrom(valuedAt(since)))
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
 * The earliest date any statement records — day zero (DESIGN.md §7) — or null
 * on an instance with none. The "All" range needs it: a fixed wide window
 * would spend most samples on uncovered pre-app years. Read from
 * `position_set`, not the view: this is when history *begins*, a fact about
 * uploads, and it stays correct when every account has since closed.
 */
export async function firstRecordedDate(
  filter: OwnerFilter,
  db: Kysely<Database> = getDb(),
): Promise<IsoDate | null> {
  const base = db
    .selectFrom("position_set")
    .select(sql<string | null>`cast(min(as_of_date) as text)`.as("date"));

  // `position_set` carries an account, never an owner (§4.2), so the
  // narrowing reaches the owner through a subquery — one spanning *closed*
  // accounts, deliberately: their statements are still history.
  const owned = isFiltered(filter)
    ? sql<SqlBool>`position_set.account_id in (
        select id from account where ${isOneOf("owner_id", filter)}
      )`
    : undefined;

  const row = await (owned === undefined ? base : base.where(owned)).executeTakeFirst();

  return row?.date ?? null;
}

/**
 * The earliest date *this account's* own statements record, or null (spec
 * 0008) — from `position_set` for {@link firstRecordedDate}'s reason: a fact
 * about uploads, correct even when every statement predates today. Falling
 * back to the household-wide date understated how new an account is.
 */
export async function accountFirstRecordedDate(
  accountId: string,
  db: Kysely<Database> = getDb(),
): Promise<IsoDate | null> {
  const row = await db
    .selectFrom("position_set")
    .select(sql<string | null>`cast(min(as_of_date) as text)`.as("date"))
    .where(isAccount("position_set.account_id", accountId))
    .executeTakeFirst();

  return row?.date ?? null;
}
