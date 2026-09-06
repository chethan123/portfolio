// Only reader of holding_valued/holding_valued_at, and (ADR-0006) the only thing that values
// anything from price_observation. Mitigates DESIGN.md §8.2's weakest point (hand-rolled
// dashboard queries disagreeing) with one view and this one module over it — a screen writing
// its own join to holding has left the mitigation. Translation layer, not a service: every
// valuation rule lives in the view's SQL; the only numbers here are Coverage cardinalities,
// everything else crosses as a decimal string. Every household-scoped reader takes OwnerFilter
// first, no default — ADR-0008.
import { sql } from "kysely";

import { numberTail } from "./account-label.ts";
import { getDb, type Database } from "./db.server.ts";
import { isFiltered, type OwnerFilter } from "./owner-filter.ts";

import type { AliasedRawBuilder, Kysely, RawBuilder, Selectable, SqlBool } from "kysely";

export type AccountKind = "brokerage" | "401k" | "ira" | "bank" | "liability";

// Three-way, not boolean: $500k Traditional is ~$350k of spending power where $500k Roth is
// $500k — a boolean throws that away (DESIGN.md §4.5).
export type TaxTreatment = "taxable" | "tax_deferred" | "tax_free";

export type AssetClass = "equity" | "bond" | "cash" | "other";

// Cash is a USD position priced at 1.00 and a liability a negative USD quantity, so nothing
// reading this needs a branch for either (DESIGN.md §2).
export type ValuedHolding = {
  accountId: string;
  accountName: string;
  // Pre-masked (raw number never leaves the server). Not a view column: a label isn't part of
  // the valuation contract (ADR-0001) — readHoldings joins account for it instead.
  accountNumberTail: string | null;
  institution: string;
  accountKind: AccountKind;
  taxTreatment: TaxTreatment;
  ownerId: string;
  ownerName: string;
  instrumentId: string;
  // Null for an instrument with no public ticker, such as a 401k trust.
  symbol: string | null;
  instrumentName: string;
  // Provider's word (EQUITY, ETF, MUTUALFUND, seeded CURRENCY). Null = nobody quotes it, not a fault.
  quoteType: string | null;
  classification: string;
  assetClass: AssetClass;
  // Negative for a liability — the sign lives here.
  quantity: string;
  // Null only when never quoted.
  price: string | null;
  // Null exactly when price is null. Never zero standing in for unknown.
  value: string | null;
  // Null when the statement omitted it, as 401k statements routinely do.
  costBasisPerShare: string | null;
  costBasis: string | null;
  // Null when either side is unknown — never a gain invented from a null.
  unrealized: string | null;
  isPriced: boolean;
  // A stale price is still used; this says so rather than hiding it.
  isStale: boolean;
  // quantity x current per-share rate. Never null on the current path (missing rate coalesces
  // to zero, DESIGN.md §14 #9); always null on an as-of path (no historical rate stored).
  annualDividend: string | null;
};

// "based on 8 of 12 holdings" — the alternative, coercing unknown to zero, reports a total that
// looks complete and isn't.
export type Coverage = { known: number; total: number };

export type Total = { amount: string; coverage: Coverage };

type HoldingValuedRow = Selectable<Database["holding_valued"]>;

// Postgres reports every view column nullable regardless of reality. Narrow loudly: a null
// here means the view and this module disagree about the schema — a bug to surface, not paper over.
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
    accountNumberTail: numberTail(row.external_account_number),
    institution: required(row.institution, "institution"),
    // Check constraints make these casts safe.
    accountKind: required(row.account_kind, "account_kind") as AccountKind,
    taxTreatment: required(row.tax_treatment, "tax_treatment") as TaxTreatment,
    ownerId: required(row.owner_id, "owner_id"),
    ownerName: required(row.owner_name, "owner_name"),
    instrumentId: required(row.instrument_id, "instrument_id"),
    symbol: row.symbol,
    instrumentName: required(row.instrument_name, "instrument_name"),
    // Not required: genuinely nullable for a manually priced instrument (a 401k trust).
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
    // Not required: the as-of function reports null on purpose (ADR-0001).
    annualDividend: row.annual_dividend,
  };
}

// Crosses as a string in both directions: default pg parses date at local midnight, and a
// round trip west of UTC lands on the previous day — the wrong position set, silently.
// server/db.ts registers the parser that prevents it.
export type IsoDate = string;

// One type for both sources (view for "now", function for a date) since the function returns
// setof holding_valued — everything below is written once and reads either.
type ValuedSource = AliasedRawBuilder<HoldingValuedRow, "holding_valued">;

const valuedNow = (): ValuedSource =>
  sql.table<HoldingValuedRow>("holding_valued").as("holding_valued");

// What was held on date, priced at that date's carried-forward close.
const valuedAt = (date: IsoDate): ValuedSource =>
  sql<HoldingValuedRow>`holding_valued_at(${date}::date)`.as("holding_valued");

// Ordering is for determinism, not display. `where` narrows the same read, so a drill-down
// never needs its own join to the view (§8.2).
async function readHoldings(
  db: Kysely<Database>,
  source: ValuedSource,
  where?: RawBuilder<SqlBool>,
): Promise<ValuedHolding[]> {
  // Joins account only for the number tail — a label, not part of the valuation contract (ADR-0001).
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

// SUM over value, no branch for cash or debt. Unpriced holdings add nothing to amount but
// still count in coverage.total, so a partial answer is labelled partial.
async function readTotal(
  db: Kysely<Database>,
  source: ValuedSource,
  where?: RawBuilder<SqlBool>,
): Promise<Total> {
  const all = db
    .selectFrom(source)
    .select([
      // value is null exactly when unpriced and SUM skips nulls; coalesce covers an empty portfolio.
      sql<string>`cast(coalesce(sum(value), 0) as numeric(20, 4))`.as("amount"),
      sql<string>`count(*) filter (where is_priced)`.as("known"),
      sql<string>`count(*)`.as("total"),
    ]);

  const row = await (where === undefined ? all : all.where(where)).executeTakeFirstOrThrow();

  return {
    amount: row.amount,
    // Counts, not money.
    coverage: { known: Number(row.known), total: Number(row.total) },
  };
}

// "Currently" is the view's business: newest position set per account, deterministic
// tie-break, closed accounts excluded. Never-priced holdings included (isPriced: false),
// never dropped.
export async function currentHoldings(
  filter: OwnerFilter,
  db: Kysely<Database> = getDb(),
): Promise<ValuedHolding[]> {
  return readHoldings(db, valuedNow(), ownedBy("holding_valued.owner_id", filter));
}

export async function netWorth(
  filter: OwnerFilter,
  db: Kysely<Database> = getDb(),
): Promise<Total> {
  return readTotal(db, valuedNow(), ownedBy("holding_valued.owner_id", filter));
}

// Carried-forward close (a Saturday equals the preceding Friday, no calendar anywhere). Doesn't
// invent a past: an account with no upload before date contributes no rows, not a zero
// (DESIGN.md §7 — that period belongs to manual_networth); an account closed after date is
// included, since it was open then. isStale is always false: a historical close is simply the close.
export async function holdingsAt(
  filter: OwnerFilter,
  date: IsoDate,
  db: Kysely<Database> = getDb(),
): Promise<ValuedHolding[]> {
  return readHoldings(db, valuedAt(date), ownedBy("holding_valued.owner_id", filter));
}

// Before the first upload: 0.0000 over zero coverage — "nothing recorded yet", not "had
// nothing" — the coverage count lets a chart say so.
export async function netWorthAt(
  filter: OwnerFilter,
  date: IsoDate,
  db: Kysely<Database> = getDb(),
): Promise<Total> {
  return readTotal(db, valuedAt(date), ownedBy("holding_valued.owner_id", filter));
}

// Rolled up in SQL, not JS (which would need Number or a decimal lib redoing what numeric
// already does). Same view as everything else, so an account's total can't disagree with the
// net worth headline (§8.2).
export type AccountTotal = {
  accountId: string;
  accountName: string;
  accountNumberTail: string | null;
  institution: string;
  accountKind: AccountKind;
  ownerName: string;
  // Negative for a liability account.
  amount: string;
  coverage: Coverage;
};

export type NetWorthPoint = { date: IsoDate; amount: string; coverage: Coverage };

// The pre-day-zero series (DESIGN.md §7).
export type ManualPoint = { date: IsoDate; amount: string };

// Shared by the list and single-account query below so the two can't describe one account differently.
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
    accountNumberTail: numberTail(row.external_account_number),
    institution: required(row.institution, "institution"),
    accountKind: required(row.account_kind, "account_kind") as AccountKind,
    ownerName: required(row.owner_name, "owner_name"),
    amount: row.amount,
    coverage: { known: Number(row.known), total: Number(row.total) },
  };
}

// Bound is on magnitude, not character count: a digit-count guard would 404 a row that exists
// (leading zeros). Compared as BigInt (§5.6): past 2^53 a float rounds.
const MAX_BIGINT = 9223372036854775807n;

// Whether an id could name a row, rather than error inside Postgres.
function couldBeId(id: string): boolean {
  return /^\d+$/.test(id) && BigInt(id) <= MAX_BIGINT;
}

// <column> in (<ids>), or a match-nothing predicate when none could be an id — a non-digit id
// would otherwise fail inside Postgres. Unusable ids drop from the list (?owner=1,abc still
// narrows to 1), but nothing usable yields false, never an empty in () and never silently no
// filter — widening a view somebody asked to narrow is the failure holdings-view.ts names.
function isOneOf(column: string, ids: readonly string[]): RawBuilder<SqlBool> {
  const usable = ids.filter(couldBeId);

  return usable.length === 0
    ? sql<SqlBool>`false`
    : sql<SqlBool>`${sql.ref(column)} in (${sql.join(usable.map((id) => sql`${id}`))})`;
}

function isAccount(column: string, accountId: string): RawBuilder<SqlBool> {
  return isOneOf(column, [accountId]);
}

// undefined, not a tautology, so an unfiltered read stays the query it's always been.
function ownedBy(column: string, filter: OwnerFilter): RawBuilder<SqlBool> | undefined {
  return isFiltered(filter) ? isOneOf(column, filter) : undefined;
}

// Largest value first; a liability sorts to the bottom by construction (negative sum, §2).
// Row for row the same answer accountTotal gives, by rule not coincidence. LEFT join: grouping
// the view directly would silently drop the empty accounts it exists to keep (0.0000 over zero rows).
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
      // is_priced is null on the manufactured row for an empty account; null fails the filter.
      sql<string>`count(*) filter (where holding_valued.is_priced)`.as("known"),
      // Joined column, not the row: count(*) would score the manufactured row as one holding.
      sql<string>`count(holding_valued.instrument_id)`.as("total"),
    ])
    // View already drops closed accounts; joining from account reaches past that.
    .where("account.closed_at", "is", null);

  // Narrowed on account.owner_id, not through the view: an empty account still reports
  // 0.0000, and the view's owner column is null on exactly those manufactured rows.
  const rows = await (owned === undefined ? base : base.where(owned))
    .groupBy([
      "account.id",
      "account.name",
      "account.external_account_number",
      "account.institution",
      "account.kind",
      "person.name",
    ])
    // sum(...) again, not the alias: not every Postgres version this may meet scopes it in ORDER BY.
    .orderBy(sql`coalesce(sum(holding_valued.value), 0)`, "desc")
    .orderBy("account.name")
    .execute();

  return rows.map(toAccountTotal);
}

// Same AccountTotal shape as the list (accountTotals is this query without the id filter) — a
// separate type is how the two would come to disagree. LEFT join from account: no view rows
// (sold to nothing, or pre-first-upload) reports 0.0000 over zero coverage, not missing.
// Null covers a nonexistent id and a closed one alike (the view excludes closed accounts, §8.2)
// — the caller should 404, not render a page of blanks.
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
      // Same is_priced null-on-manufactured-row shape as accountTotals.
      sql<string>`count(*) filter (where holding_valued.is_priced)`.as("known"),
      sql<string>`count(holding_valued.instrument_id)`.as("total"),
    ])
    .where(isAccount("account.id", accountId))
    // Turns "closed" into null, distinct from an account holding nothing.
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

// Same rows as currentHoldings' overview total, filtered to one account, unpriced included so
// the table can say which line is missing. Empty for holds-nothing, closed, and no-such-id
// alike — accountTotal answers which.
export async function accountHoldings(
  accountId: string,
  db: Kysely<Database> = getDb(),
): Promise<ValuedHolding[]> {
  return readHoldings(db, valuedNow(), isAccount("holding_valued.account_id", accountId));
}

// A value at each date in one round trip: a lateral join evaluates holding_valued_at once per
// date inside one statement, where netWorthAt in a loop would be a round trip and a re-plan
// per point. dates may be any order; the result comes back sorted.
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
 * The line is a **running total**, not a valuation repeated per instant: a
 * holding's price is a step function that moves only when its instrument is
 * observed, so the value at an instant is the opening value plus, over every
 * observation at or before it, that holding's new rounded value less its
 * previous rounded value. The differences telescope exactly in `numeric` and
 * the rounding stays per holding, which is what makes this the same sum to
 * the character rather than merely close to it.
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
  // The narrowing sits in the holdings CTE, never the outer WHERE: the
  // instants are the log's and are unioned onto the same timeline as the
  // price changes, so an instant at which this surface holds nothing — or
  // holds nothing that was observed — is still a point on the line.
  const narrowing = where === undefined ? sql`true` : where;

  const rows = await sql<{ at: Date; amount: string; known: string; total: string }>`
    with instants as (
      select distinct as_of
      from price_observation
      where market_date = ${session}::date
    ),

    -- The positions held now, one row per holding. The grain is the point:
    -- deltas and opening_total below round per holding, as every other reader
    -- does, which is what keeps this total equal to the ones they report.
    held as (
      select h.id, h.instrument_id, h.quantity
      from account a
      join holding h on h.position_set_id = latest_position_set(a.id)
      where a.closed_at is null
        and ${narrowing}
    ),

    -- The price in force as the session opens — the same three-way rule every
    -- point applies: the latest observation before the first instant, from
    -- any date; else the last close strictly before the session (see the
    -- docstring for why strictly); else null, and the holding is unpriced.
    opening as (
      select
        h.id, h.instrument_id, h.quantity,
        coalesce(
          (select o.price from price_observation o
            where o.instrument_id = h.instrument_id
              and o.as_of < (select min(as_of) from instants)
            order by o.as_of desc limit 1),
          (select pd.close from price_daily pd
            where pd.instrument_id = h.instrument_id and pd.date < ${session}::date
            order by pd.date desc limit 1)
        ) as price
      from held h
    ),

    -- Every observation of a held instrument inside the session's span, with
    -- the price it replaces: that holding's previous observation in the span,
    -- else its opening price. previous is null only for a holding priced for
    -- the first time ever, which is the one case known moves.
    --
    -- Bounded by the span and not by market_date, so "same answer" holds on
    -- any rows the table can hold rather than only on those stamped under
    -- today's MARKET_TIMEZONE. The bounds are scalar subqueries and not a
    -- joined one-row CTE: through a join the span reaches this scan as a
    -- join condition, which the planner does not turn into an index
    -- condition, and it seq-scans the whole log — materialised or not. As
    -- scalar subqueries they are init-plan parameters, which do go into the
    -- index condition on price_observation_pkey: one scan per holding, and
    -- the log's growth stops mattering.
    changes as (
      select
        o.as_of,
        op.quantity,
        o.price,
        coalesce(lag(o.price) over (partition by op.id order by o.as_of), op.price) as previous
      from opening op
      join price_observation o
        on o.instrument_id = op.instrument_id
       and o.as_of >= (select min(as_of) from instants)
       and o.as_of <= (select max(as_of) from instants)
    ),

    -- What the observations at one instant add to the total and to the priced
    -- count, rounded per holding exactly as the total is.
    deltas as (
      select
        as_of,
        sum(cast(quantity * price as numeric(20, 4))
            - coalesce(cast(quantity * previous as numeric(20, 4)), 0)) as value_delta,
        count(*) filter (where previous is null) as known_delta
      from changes
      group by as_of
    ),

    opening_total as (
      select
        coalesce(sum(cast(quantity * price as numeric(20, 4))), 0) as amount,
        count(price) as known,
        count(*) as total
      from opening
    ),

    -- Instants and deltas on one timeline. A plotted instant has to take
    -- every delta at or before it, ties included, and the default RANGE frame
    -- of sum(...) over (order by as_of) includes the current row's peers —
    -- which is o.as_of <= instants.as_of restated, with no ordering needed
    -- between the two kinds of row.
    timeline as (
      select
        as_of, true as plotted,
        cast(0 as numeric) as value_delta, cast(0 as bigint) as known_delta
      from instants
      union all
      select as_of, false, value_delta, known_delta
      from deltas
    ),

    running as (
      select
        as_of, plotted,
        sum(value_delta) over (order by as_of) as value_delta,
        sum(known_delta) over (order by as_of) as known_delta
      from timeline
    )

    -- The plotted filter sits out here, one step after the window rather than
    -- inside running: a WHERE is evaluated before window functions and would
    -- drop the delta rows before they were summed. known is cast back to
    -- bigint because bigint + sum(bigint) is numeric in Postgres, and a
    -- coverage count that changed type between two readers of one row shape
    -- is the drift the row contract exists to refuse.
    select
      r.as_of                                              as at,
      cast(ot.amount + r.value_delta as numeric(20, 4))    as amount,
      cast(ot.known + r.known_delta as bigint)             as known,
      ot.total                                             as total
    from running r
    cross join opening_total ot
    where r.plotted
    order by r.as_of
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
 * Net worth at each instant of the session — the Overview's 1D line. No
 * observations returns an empty series, not a flat one: "nothing was
 * observed" is not "nothing moved".
 */
export async function netWorthSessionSeries(
  filter: OwnerFilter,
  session: IsoDate,
  db: Kysely<Database> = getDb(),
): Promise<SessionPoint[]> {
  // `a` is the account alias in the `held` CTE, where the narrowing goes.
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
