// Only reader of holding_valued/holding_valued_at and (ADR-0006) the only thing that values from
// price_observation — a screen writing its own join to holding has left the design. Valuation
// rules live in the view's SQL; every household-scoped reader takes OwnerFilter first (ADR-0008).
import { sql } from "kysely";

import { numberTail } from "./account-label.ts";
import { couldBeId } from "./database-id.ts";
import { getDb, inOneSnapshot, type Database } from "./db.server.ts";
import { isFiltered, type OwnerFilter } from "./owner-filter.ts";

import type { AliasedRawBuilder, Kysely, RawBuilder, Selectable, SqlBool } from "kysely";

export type AccountKind = "brokerage" | "401k" | "ira" | "bank" | "liability";

// Three-way, not boolean: $500k Traditional is ~$350k of spending power (DESIGN.md §4.5).
export type TaxTreatment = "taxable" | "tax_deferred" | "tax_free";

export type AssetClass = "equity" | "bond" | "cash" | "other";

// Cash is USD priced at 1.00, a liability a negative USD quantity — no branch for either (§2).
export type ValuedHolding = {
  accountId: string;
  accountName: string;
  // Pre-masked; not a view column — a label isn't part of the valuation contract (ADR-0001).
  accountNumberTail: string | null;
  institution: string;
  accountKind: AccountKind;
  taxTreatment: TaxTreatment;
  ownerId: string;
  ownerName: string;
  instrumentId: string;
  symbol: string | null;
  instrumentName: string;
  // Provider's word (EQUITY, ETF, MUTUALFUND, seeded CURRENCY). Null = nobody quotes it, not a fault.
  quoteType: string | null;
  classification: string;
  assetClass: AssetClass;
  // Negative for a liability — the sign lives here.
  quantity: string;
  price: string | null;
  value: string | null;
  costBasisPerShare: string | null;
  costBasis: string | null;
  unrealized: string | null;
  isPriced: boolean;
  isStale: boolean;
  // quantity x current per-share rate. Always null on an as-of path — no historical rate stored.
  annualDividend: string | null;
};

// "based on 8 of 12 holdings" — unknown coerced to zero reports a total that isn't complete.
export type Coverage = { known: number; total: number };

export type Total = { amount: string; coverage: Coverage };

type HoldingValuedRow = Selectable<Database["holding_valued"]>;

// Postgres calls every view column nullable. A null here means view and module disagree — a bug.
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

// String both ways: pg parses date at local midnight — west of UTC a round trip loses a day.
export type IsoDate = string;

// One type for both sources: holding_valued_at returns setof holding_valued.
type ValuedSource = AliasedRawBuilder<HoldingValuedRow, "holding_valued">;

const valuedNow = (): ValuedSource =>
  sql.table<HoldingValuedRow>("holding_valued").as("holding_valued");

const valuedAt = (date: IsoDate): ValuedSource =>
  sql<HoldingValuedRow>`holding_valued_at(${date}::date)`.as("holding_valued");

// Ordering is for determinism, not display; `where` narrows the same read (§8.2).
async function readHoldings(
  db: Kysely<Database>,
  source: ValuedSource,
  where?: RawBuilder<SqlBool>,
): Promise<ValuedHolding[]> {
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

// SUM over value, no branch for cash or debt. Unpriced adds nothing but still counts in coverage.
async function readTotal(
  db: Kysely<Database>,
  source: ValuedSource,
  where?: RawBuilder<SqlBool>,
): Promise<Total> {
  const all = db
    .selectFrom(source)
    .select([
      sql<string>`cast(coalesce(sum(value), 0) as numeric(20, 4))`.as("amount"),
      sql<string>`count(*) filter (where is_priced)`.as("known"),
      sql<string>`count(*)`.as("total"),
    ]);

  const row = await (where === undefined ? all : all.where(where)).executeTakeFirstOrThrow();

  return {
    amount: row.amount,
    coverage: { known: Number(row.known), total: Number(row.total) },
  };
}

// "Currently" is the view's business: newest position set per account, closed accounts excluded.
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

// Carried-forward close (a Saturday equals the preceding Friday). No upload before date means no
// rows, not a zero (§7); an account closed after date is included. isStale is always false.
export async function holdingsAt(
  filter: OwnerFilter,
  date: IsoDate,
  db: Kysely<Database> = getDb(),
): Promise<ValuedHolding[]> {
  return readHoldings(db, valuedAt(date), ownedBy("holding_valued.owner_id", filter));
}

// Before the first upload: 0.0000 over zero coverage — "nothing recorded yet", not "had nothing".
export async function netWorthAt(
  filter: OwnerFilter,
  date: IsoDate,
  db: Kysely<Database> = getDb(),
): Promise<Total> {
  return readTotal(db, valuedAt(date), ownedBy("holding_valued.owner_id", filter));
}

// Rolled up in SQL so an account's total can't disagree with the net worth headline (§8.2).
export type AccountTotal = {
  accountId: string;
  accountName: string;
  accountNumberTail: string | null;
  institution: string;
  accountKind: AccountKind;
  ownerName: string;
  amount: string;
  coverage: Coverage;
};

export type NetWorthPoint = { date: IsoDate; amount: string; coverage: Coverage };

export type ManualPoint = { date: IsoDate; amount: string };

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

// Unusable ids drop out; nothing usable yields false, never an empty `in ()` and never no filter.
function isOneOf(column: string, ids: readonly string[]): RawBuilder<SqlBool> {
  const usable = ids.filter(couldBeId);

  return usable.length === 0
    ? sql<SqlBool>`false`
    : sql<SqlBool>`${sql.ref(column)} in (${sql.join(usable.map((id) => sql`${id}`))})`;
}

function isAccount(column: string, accountId: string): RawBuilder<SqlBool> {
  return isOneOf(column, [accountId]);
}

function ownedBy(column: string, filter: OwnerFilter): RawBuilder<SqlBool> | undefined {
  return isFiltered(filter) ? isOneOf(column, filter) : undefined;
}

// LEFT join: grouping the view directly would drop the empty accounts it exists to keep.
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
      sql<string>`count(*) filter (where holding_valued.is_priced)`.as("known"),
      sql<string>`count(holding_valued.instrument_id)`.as("total"),
    ])
    .where("account.closed_at", "is", null);

  // Narrowed on account.owner_id, not the view: the view's owner column is null on empty accounts.
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

// Same AccountTotal shape as the list — a separate type is how the two would come to disagree.
// Null covers a nonexistent id and a closed one alike (§8.2); the caller should 404.
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
      sql<string>`count(*) filter (where holding_valued.is_priced)`.as("known"),
      sql<string>`count(holding_valued.instrument_id)`.as("total"),
    ])
    .where(isAccount("account.id", accountId))
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

// currentHoldings filtered to one account. Empty for holds-nothing, closed and no-such-id alike.
export async function accountHoldings(
  accountId: string,
  db: Kysely<Database> = getDb(),
): Promise<ValuedHolding[]> {
  return readHoldings(db, valuedNow(), isAccount("holding_valued.account_id", accountId));
}

// accountHoldings, for a past date — the dated half of the pair (#181's baseline). Quantity, cost
// basis and instrument identity are what a caller should read off this; price and staleness are
// the historical close, not today's quote, so a diff pricing a removed row must use `quote` instead.
export async function accountHoldingsAt(
  accountId: string,
  date: IsoDate,
  db: Kysely<Database> = getDb(),
): Promise<ValuedHolding[]> {
  return readHoldings(db, valuedAt(date), isAccount("holding_valued.account_id", accountId));
}

// One round trip: a lateral evaluates holding_valued_at once per date, not netWorthAt in a loop.
async function readSeries(
  db: Kysely<Database>,
  dates: IsoDate[],
  where?: RawBuilder<SqlBool>,
): Promise<NetWorthPoint[]> {
  if (dates.length === 0) return [];

  const rows = await db
    .selectFrom(sql<{ date: string }>`unnest(cast(${dates} as date[]))`.as("d"))
    // LEFT, not INNER: a date before the first upload has no rows and INNER would drop it silently.
    .leftJoinLateral(
      (join) => {
        const held = join.selectFrom(sql`holding_valued_at(d.date)`.as("v")).selectAll();

        // Inside the lateral, never the outer WHERE — out there it drops the uncovered date's row.
        return (where === undefined ? held : held.where(where)).as("v");
      },
      (join) => join.onTrue(),
    )
    .select([
      sql<string>`cast(d.date as text)`.as("date"),
      sql<string>`cast(coalesce(sum(v.value), 0) as numeric(20, 4))`.as("amount"),
      sql<string>`count(*) filter (where v.is_priced)`.as("known"),
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

// A date before the first upload is 0.0000 over zero coverage, not a real zero (§7).
export async function netWorthSeries(
  filter: OwnerFilter,
  dates: IsoDate[],
  db: Kysely<Database> = getDb(),
): Promise<NetWorthPoint[]> {
  return readSeries(db, dates, ownedBy("v.owner_id", filter));
}

// Same terms as netWorthSeries: dates outside the account's life come back 0.0000, not skipped.
export async function accountSeries(
  accountId: string,
  dates: IsoDate[],
  db: Kysely<Database> = getDb(),
): Promise<NetWorthPoint[]> {
  return readSeries(db, dates, isAccount("v.account_id", accountId));
}

export type SessionPoint = {
  // ISO instant, not a date — hence "at" — unless dated, when it is the calendar date instead.
  at: string;
  amount: string;
  coverage: Coverage;
  // Set on a finished-day point among instants (spec 0022); absent, never false, on an instant.
  dated?: true;
};

// Off the log, not the calendar (ADR-0006) — market_date is stamped when a close is filed.
export async function latestObservedSession(
  db: Kysely<Database> = getDb(),
): Promise<IsoDate | null> {
  const row = await db
    .selectFrom("price_observation")
    .select(sql<string>`cast(max(market_date) as text)`.as("session"))
    .executeTakeFirst();

  return row?.session ?? null;
}

// Values each observed instant of the session off the log (§4.2 extended to the third tier).
// Instants come from the whole log, not the surface, so both surfaces plot the same moments.
// Fallback is the last close *strictly before* the session — today's price_daily row is
// provisional and would price the open at the close. Running total of per-holding rounded
// deltas, telescoping exactly in numeric. Known gaps: DESIGN.md §14.
async function readSessionSeries(
  db: Kysely<Database>,
  session: IsoDate,
  where?: RawBuilder<SqlBool>,
): Promise<SessionPoint[]> {
  // Narrowing sits in the holdings CTE — an instant holding nothing observed is still a point.
  const narrowing = where === undefined ? sql`true` : where;

  const rows = await sql<{ at: Date; amount: string; known: string; total: string }>`
    with instants as (
      select distinct as_of
      from price_observation
      where market_date = ${session}::date
    ),

    -- Positions held now, one row per holding; deltas round per holding, like every other reader.
    held as (
      select h.id, h.instrument_id, h.quantity
      from account a
      join holding h on h.position_set_id = latest_position_set(a.id)
      where a.closed_at is null
        and ${narrowing}
    ),

    -- Price as the session opens: last observation before the first instant, else the last close.
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

    -- Every observation of a held instrument in the span, with the price it replaces (null
    -- previous = first ever priced). Bounds as scalar subqueries: a joined CTE seq-scans the log.
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

    -- What one instant's observations add to the total and the priced count, rounded per holding.
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

    -- One timeline; the default RANGE frame takes every delta at or before it, ties included.
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

    -- plotted filter after the window, not inside running: a WHERE would drop delta rows before
    -- they're summed. known cast back to bigint — bigint + sum(bigint) is numeric in Postgres.
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
    at: row.at.toISOString(),
    amount: row.amount,
    coverage: { known: Number(row.known), total: Number(row.total) },
  }));
}

// No observations returns an empty series, not a flat one: "nothing observed" isn't "nothing moved".
export async function netWorthSessionSeries(
  filter: OwnerFilter,
  session: IsoDate,
  db: Kysely<Database> = getDb(),
): Promise<SessionPoint[]> {
  return readSessionSeries(db, session, ownedBy("a.owner_id", filter));
}

// A cash-only account draws a flat line, not an empty one: instants are the log's.
export async function accountSessionSeries(
  accountId: string,
  session: IsoDate,
  db: Kysely<Database> = getDb(),
): Promise<SessionPoint[]> {
  return readSessionSeries(db, session, isAccount("a.id", accountId));
}

export type GrainedWindow = { dates: IsoDate[]; grainMinutes: number; timeZone: string };

// Two narrowings, not one: the dated branch reads holding_valued_at, narrowed the way readSeries
// narrows it (v.*); the instant branch reads holding directly, narrowed the way readSessionSeries
// narrows it (a.*). "Off" is `true` on both, never undefined — substituted in the callers below,
// so this function never sees a missing narrowing to guard against.
type GrainedNarrowing = { instant: RawBuilder<SqlBool>; dated: RawBuilder<SqlBool> };

// The instants x holdings shape spec 0016 retired for 1D (ADR-0014), bounded here by the grain
// rather than the refresh cadence: at most 27 steps a session at 15 minutes, 8 at an hour, 3 at
// three hours, one more for an evening NAV. A day no step found an observation on — the window's
// first day always — falls back to holding_valued_at(d), the same close the daily line draws, as
// a dated point. The 1D running total (readSessionSeries) is the fallback shape if this ever
// measures slow: it reads every observation of a held instrument in the window, a cost the grain
// does not pay because the grain, not the cadence, bounds the instants. Steps are absolute
// arithmetic from local midnight, so a zone whose clock change fell on a weekday would leave a
// day's last hour uncovered; no New York session reaches it.
async function readGrainedSeries(
  db: Kysely<Database>,
  window: GrainedWindow,
  narrowing: GrainedNarrowing,
): Promise<SessionPoint[]> {
  const { dates, grainMinutes, timeZone } = window;
  if (dates.length === 0) return [];

  const rows = await sql<{
    day: string;
    at: Date | null;
    dated: boolean;
    amount: string;
    known: string;
    total: string;
  }>`
    with days as (
      select d, ord from unnest(${dates}::date[]) with ordinality as t(d, ord)
    ),

    steps as (
      -- The day cut into steps of the grain from its midnight on the market clock; never the
      -- window's first day, which is dated below, not stepped.
      select dy.d,
             ((dy.d::timestamp) at time zone ${timeZone}) + make_interval(mins => ${grainMinutes}::int * k) as starts
      from days dy
      cross join generate_series(0, 1440 / ${grainMinutes}::int - 1) as k
      where dy.ord > 1
    ),

    instants as (
      -- A step's point is its last observation of that day; a step with none is no point. One
      -- backward index step on price_observation_market_date_idx per (day, step).
      select s.d, m.at
      from steps s
      cross join lateral (
        select max(o.as_of) as at
        from price_observation o
        where o.market_date = s.d
          and o.as_of >= s.starts
          and o.as_of < s.starts + make_interval(mins => ${grainMinutes}::int)
      ) m
      where m.at is not null
    ),

    dated as (
      -- The window's first day, and any day no step found an observation on: the spine's close for
      -- that date. Read off instants, never the log again — a per-day probe of price_observation
      -- plans as a sequential scan, and one definition of "observed" is enough.
      select dy.d
      from days dy
      where dy.ord = 1
         or not exists (select 1 from instants i where i.d = dy.d)
    ),

    held as (
      -- Positions in force on each plotted day, one row per (day, holding); narrowed here, never
      -- in an outer WHERE, so a day with nothing held is still a point.
      select p.d, h.id, h.instrument_id, h.quantity
      from (select distinct d from instants) p
      join account a on a.closed_at is null or a.closed_at > p.d
      join holding h on h.position_set_id = latest_position_set(a.id, p.d)
      where ${narrowing.instant}
    ),

    instant_points as (
      select i.d, i.at, false as dated,
        cast(coalesce(sum(cast(h.quantity * px.price as numeric(20, 4))), 0) as numeric(20, 4)) as amount,
        count(px.price) as known,
        count(h.id) as total
      from instants i
      left join held h on h.d = i.d
      left join lateral (
        select coalesce(
          (select o.price from price_observation o
            where o.instrument_id = h.instrument_id and o.as_of <= i.at
            order by o.as_of desc limit 1),
          (select pd.close from price_daily pd
            where pd.instrument_id = h.instrument_id and pd.date < i.d
            order by pd.date desc limit 1)
        ) as price
      ) px on true
      group by i.d, i.at
    ),

    dated_points as (
      select dt.d, null::timestamptz as at, true as dated,
        cast(coalesce(sum(v.value), 0) as numeric(20, 4)) as amount,
        count(*) filter (where v.is_priced) as known,
        count(v.instrument_id) as total
      from dated dt
      left join lateral (
        select * from holding_valued_at(dt.d) v where ${narrowing.dated}
      ) v on true
      group by dt.d
    )

    select cast(d as text) as day, at, dated, amount, known, total from instant_points
    union all
    select cast(d as text) as day, at, dated, amount, known, total from dated_points
    order by day, at
  `.execute(db);

  return rows.rows.map((row) => {
    const coverage = { known: Number(row.known), total: Number(row.total) };

    return row.dated
      ? { at: row.day, amount: row.amount, coverage, dated: true as const }
      : { at: row.at!.toISOString(), amount: row.amount, coverage };
  });
}

// Same terms as netWorthSessionSeries, over a window rather than one session (spec 0022).
export async function netWorthGrainedSeries(
  filter: OwnerFilter,
  window: GrainedWindow,
  db: Kysely<Database> = getDb(),
): Promise<SessionPoint[]> {
  return readGrainedSeries(db, window, {
    instant: ownedBy("a.owner_id", filter) ?? sql`true`,
    dated: ownedBy("v.owner_id", filter) ?? sql`true`,
  });
}

// Same terms as accountSessionSeries, over a window rather than one session (spec 0022).
export async function accountGrainedSeries(
  accountId: string,
  window: GrainedWindow,
  db: Kysely<Database> = getDb(),
): Promise<SessionPoint[]> {
  return readGrainedSeries(db, window, {
    instant: isAccount("a.id", accountId),
    dated: isAccount("v.account_id", accountId),
  });
}

// The hand-typed prefix series (§7), raw — the overlap rule is a display rule, not a fact here.
// No owner filter: manual_networth has no owner column, so a narrowed read of it could only be
// declined, never narrowed (ADR-0008). Its callers decline it.
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

// The hand-typed value in force on a date — carried forward like a price, so the point need not be
// one the line draws. Unfiltered for manualNetWorth's reason above; the gate is netWorthChange's.
export async function manualNetWorthAt(
  at: IsoDate,
  db: Kysely<Database> = getDb(),
): Promise<ManualPoint | null> {
  const row = await db
    .selectFrom("manual_networth")
    .select([sql<string>`cast(date as text)`.as("date"), "amount"])
    .where("date", "<=", at)
    .orderBy("date", "desc")
    .limit(1)
    .executeTakeFirst();

  return row === undefined ? null : { date: row.date, amount: String(row.amount) };
}

// Which series `previous` came from. "clamped" is measured later than asked — the caller says so.
export type ChangeBasis = "computed" | "manual" | "clamped" | "none";

// In SQL numeric (§4.1); divides by abs(previous) so climbing out of net debt reads as a rise.
export type NetWorthChange = {
  current: string;
  previous: string;
  difference: string;
  // Null when previous is zero: undefined, not 0% or infinite.
  percent: string | null;
  basis: ChangeBasis;
  // What `previous` is measured at, which is `since` only when basis is "computed".
  basisDate: IsoDate | null;
};

type Baseline =
  | { basis: ChangeBasis; date: IsoDate; amount?: undefined }
  | { basis: ChangeBasis; date: IsoDate | null; amount: string };

// §7 rules 2 and 3, narrowed to one date: positions win wherever they reach, the hand-typed history
// covers only what precedes them, and a range reaching past both is measured from where it can be.
export async function netWorthChange(
  filter: OwnerFilter,
  since: IsoDate,
  db: Kysely<Database> = getDb(),
): Promise<NetWorthChange> {
  // Several statements, one snapshot. A first upload committing between the discovery of the
  // baseline and the sum of the totals would otherwise leave "nothing was recorded" answering for
  // a portfolio that is no longer empty — #347 again, arrived at from the other side.
  return inOneSnapshot(db, async (trx) => {
    const firstSet = await firstRecordedDate(filter, trx);

    // min(as_of_date) <= since is exactly "some set at or before since" — no second exists query.
    if (firstSet !== null && firstSet <= since) {
      return readChange(trx, filter, { basis: "computed", date: since });
    }

    // Narrowed asks nothing of manual_networth at all: the hand-typed history is the household's
    // and has no owner (ADR-0008).
    const inForce = isFiltered(filter) ? null : await manualNetWorthAt(since, trx);

    if (inForce !== null) {
      return readChange(trx, filter, {
        basis: "manual",
        date: inForce.date,
        amount: inForce.amount,
      });
    }

    // Cold path only, so the whole tiny series rather than a third near-identical reader.
    const firstManual = isFiltered(filter) ? undefined : (await manualNetWorth(trx))[0];

    if (firstManual !== undefined && (firstSet === null || firstManual.date < firstSet)) {
      return readChange(trx, filter, {
        basis: "clamped",
        date: firstManual.date,
        amount: firstManual.amount,
      });
    }

    if (firstSet !== null) {
      return readChange(trx, filter, { basis: "clamped", date: firstSet });
    }

    return readChange(trx, filter, { basis: "none", date: null, amount: "0" });
  });
}

async function readChange(
  db: Kysely<Database>,
  filter: OwnerFilter,
  past: Baseline,
): Promise<NetWorthChange> {
  // Both ends narrowed, or the delta compares one owner against the whole household.
  const owned = ownedBy("holding_valued.owner_id", filter);
  const narrow = <T extends { where(w: RawBuilder<SqlBool>): T }>(qb: T): T =>
    owned === undefined ? qb : qb.where(owned);

  const row = await db
    .with("present", (qb) =>
      narrow(qb.selectFrom(valuedNow()))
        .select(sql<string>`coalesce(sum(value), 0)`.as("amount")),
    )
    .with("past", (qb) =>
      past.amount === undefined
        ? narrow(qb.selectFrom(valuedAt(past.date)))
            .select(sql<string>`coalesce(sum(value), 0)`.as("amount"))
        : qb.selectNoFrom(sql<string>`round(cast(${past.amount} as numeric), 4)`.as("amount")),
    )
    .selectFrom(["present", "past"])
    .select([
      // round, not cast(… as numeric(20, 4)): scale fixed, width not. Any width here is a cliff the
      // schema does not have — a hand-loaded baseline of a ten-thousandth against a balance the app
      // accepts (12 integer digits) puts the ratio past 16 of them, and holding_valued guards each
      // holding below the money column but never their sum. Overflowing is a 500 on the Overview.
      sql<string>`round(present.amount, 4)`.as("current"),
      sql<string>`round(past.amount, 4)`.as("previous"),
      sql<string>`round(present.amount - past.amount, 4)`.as("difference"),
      sql<string | null>`case
        when past.amount = 0 then null
        else round((present.amount - past.amount) / abs(past.amount) * 100, 4)
      end`.as("percent"),
    ])
    .executeTakeFirstOrThrow();

  return {
    current: row.current,
    previous: row.previous,
    difference: row.difference,
    percent: row.percent,
    basis: past.basis,
    basisDate: past.date,
  };
}

// Day zero (§7) or null — from position_set: a fact about uploads, not about open accounts.
export async function firstRecordedDate(
  filter: OwnerFilter,
  db: Kysely<Database> = getDb(),
): Promise<IsoDate | null> {
  const base = db
    .selectFrom("position_set")
    .select(sql<string | null>`cast(min(as_of_date) as text)`.as("date"));

  // position_set carries an account, never an owner (§4.2); the subquery spans closed accounts too.
  const owned = isFiltered(filter)
    ? sql<SqlBool>`position_set.account_id in (
        select id from account where ${isOneOf("owner_id", filter)}
      )`
    : undefined;

  const row = await (owned === undefined ? base : base.where(owned)).executeTakeFirst();

  return row?.date ?? null;
}

// This account's own earliest date (spec 0008) — the household-wide date would understate it.
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
