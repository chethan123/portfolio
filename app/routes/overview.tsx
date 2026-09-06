import { Link } from "react-router";

import { AccountNumberTail } from "~/components/account-number-tail";
import { Amount } from "~/components/amount";
import { categoryColor } from "~/components/breakdown";
import { ChartRangeControl } from "~/components/chart-range-control";
import { EmptyState } from "~/components/empty-state";
import {
  AccountBalanceIcon,
  LiabilityIcon,
  RetirementIcon,
  SavingsIcon,
  TrendingDownIcon,
  TrendingUpIcon,
} from "~/components/icons";
import { ChartEmptyNote, NetWorthChart } from "~/components/net-worth-chart";
import {
  NarrowedTo,
  NarrowedToNothing,
  OwnerFilterControl,
} from "~/components/owner-filter-control";
import { ACCOUNT_KINDS, labelOf } from "~/lib/account-options";
import {
  DEFAULT_RANGE,
  chartRangeMiddleware,
  chartWindow,
  isoDate,
  rangeDescription,
  type CustomSpan,
  type RangeKey,
} from "~/lib/chart-range";
import { chartReach, chartSeries, type ChartScope } from "~/lib/chart-series.server";
import { formatPercent, isNegative, toPlotValue } from "~/lib/format";
import { useMasked } from "~/lib/masking";
import { ALL_OWNERS, isFiltered, ownerSearch, type OwnerFilter } from "~/lib/owner-filter";
import { isNarrowedToNothing, ownerReading } from "~/lib/owner-reading.server";
import {
  accountTotals,
  manualNetWorth,
  netWorth,
  netWorthChange,
  type AccountKind,
} from "~/lib/valuation.server";

import { getConfig } from "../../server/config.ts";

import { PriceFreshness } from "../components/price-freshness.tsx";
import { asOfView } from "../lib/prices.server.ts";

import type { Route } from "./+types/overview";

/**
 * Net worth headline, trend line, accounts rollup (DESIGN.md §13). Empty
 * case is load-bearing: a never-uploaded instance renders no figure at
 * all, since zero and empty look identical on screen.
 */

export function meta() {
  return [{ title: "Overview · Portfolio" }];
}

// Accounts the allocation panel draws — categorical sequence is 5 (§13.3).
const BARS = 5;

/** Stamps the range cookie on an explicit choice (spec 0008) — see {@link chartRangeMiddleware}. */
export const middleware: Route.MiddlewareFunction[] = [chartRangeMiddleware()];

export async function loader({ request }: Route.LoaderArgs) {
  // Settled first — `chartRangeMiddleware` declines to stamp on a bounce `ownerReading` may throw.
  const { reading, owner } = await ownerReading(request);
  const { owners } = owner;

  const today = isoDate(Date.now());
  const scope: ChartScope = { surface: "household", reading };

  // One round trip: `earliest.manual` needs `manual`'s first point, so the window can't size sooner (spec 0015).
  const [manual, reach] = await Promise.all([
    // No owner filter — an empty answer couldn't be told from an empty table (spec 0013).
    manualNetWorth(),
    chartReach(scope),
  ]);

  // §7 rule 3: hand-typed series predates accounts and has no owner, so a narrowed chart skips it.
  const reachable = isFiltered(owners) ? [] : manual;

  // `reachable` is empty while narrowed, so the earlier-of-two rule computes the narrowed reach for free.
  const earliest = { positionSet: reach.positionSet, manual: reachable[0]?.date };

  const { resolved, controls } = chartWindow("household", {
    request,
    today,
    earliest,
    session: reach.session,
    timeZone: getConfig().MARKET_TIMEZONE,
  });

  // Run beside the other reads below rather than queued behind them.
  const points = chartSeries(scope, resolved);

  const [change, accounts, computed, freshness, everyone] = await Promise.all([
    netWorthChange(reading, resolved.since),
    accountTotals(reading),
    points,
    asOfView(getConfig().MARKET_TIMEZONE),
    // Whether the instance holds anything vs. these owners — only while narrowed (Analysis' read).
    isFiltered(owners) ? netWorth(ALL_OWNERS) : null,
  ]);

  // §7 rule 2: computed wins on overlap; manual fills the gap ahead, bounded so a 1M chart can't squeeze in a 2022 point.
  const firstComputed = computed[0]?.date;
  const manualPrefix =
    // Never under 1D — a 2022 point on this morning's line would claim a session that never happened.
    resolved.session !== undefined
      ? []
      : reachable.filter(
          (point) =>
            point.date >= resolved.since &&
            (firstComputed === undefined || point.date < firstComputed),
        );

  // Summed from the same rollup the table renders, not counted separately.
  const holdingCount = accounts.reduce((total, account) => total + account.coverage.total, 0);
  const instance = everyone === null ? holdingCount : everyone.coverage.total;

  return {
    freshness,
    ...owner,
    ...controls,
    change,
    accounts,
    computed,
    manual: manualPrefix,
    // Withheld only if the *unfiltered* window would've shown a point there (never under 1D).
    manualWithheld:
      isFiltered(owners) &&
      resolved.session === undefined &&
      manual.some((point) => resolved.range === "all" || point.date >= resolved.since),
    holdingCount,
    narrowedToNothing: isNarrowedToNothing(owners, { held: holdingCount, instance }),
    pricedCount: accounts.reduce((total, account) => total + account.coverage.known, 0),
  };
}

/** Chart params a GET form must re-emit, so applying an owner keeps the chosen span. */
function rangeFields(range: RangeKey, custom?: CustomSpan): Record<string, string> {
  if (range === "custom" && custom !== undefined) {
    return { range, start: custom.start, end: custom.end };
  }

  return range === DEFAULT_RANGE ? {} : { range };
}

/** Header strip: the headline below is the page's real title, so this stays empty unless there's an owner filter to show. */
function Header({
  roster,
  owners,
  range,
  custom,
}: {
  roster: Route.ComponentProps["loaderData"]["roster"];
  owners: OwnerFilter;
  range: RangeKey;
  custom?: CustomSpan;
}) {
  // No strip for one owner and no filter — heading stays for screen-reader navigation, no visible box.
  if (roster.length < 2 && !isFiltered(owners)) {
    return <h1 className="visually-hidden">Overview</h1>;
  }

  const hidden = rangeFields(range, custom);

  return (
    <header className="page-header page-header--bare">
      <h1 className="visually-hidden">Overview</h1>

      <div className="page-actions">
        <OwnerFilterControl owners={roster} selected={owners} hidden={hidden} />
      </div>
    </header>
  );
}

type AccountRow = Route.ComponentProps["loaderData"]["accounts"][number];

// Exhaustive over `AccountKind` — adding a kind fails the typecheck here, not a silent blank row.
const TILES = {
  brokerage: AccountBalanceIcon,
  "401k": AccountBalanceIcon,
  ira: RetirementIcon,
  bank: SavingsIcon,
  liability: LiabilityIcon,
} satisfies Record<AccountKind, typeof AccountBalanceIcon>;

/**
 * Accounts as bars, largest first — the only breakdown this loader already
 * holds (asset-class/per-person need the holdings themselves). Denominator
 * is gross positive total, not net (`allocation.ts`) — liabilities get no
 * bar. The one place this route turns money into a float, and only for a
 * bar width, never shown or summed back.
 */
function allocationBars(accounts: AccountRow[]) {
  const held = accounts.filter((account) => toPlotValue(account.amount) > 0);
  const base = held.reduce((total, account) => total + toPlotValue(account.amount), 0);

  return {
    held: held.length,
    bars: held.slice(0, BARS).map((account, index) => ({
      account,
      // Breakdowns' own assigner, so rank means the same colour everywhere (§13.3).
      colour: categoryColor(index),
      width: `${((toPlotValue(account.amount) / base) * 100).toFixed(1)}%`,
    })),
  };
}

function AccountsPanel({
  accounts,
  owners,
}: {
  accounts: AccountRow[];
  // Carried into the account page (which ignores it) so its breadcrumb can carry it back out (spec 0013).
  owners: OwnerFilter;
}) {
  return (
    <section className="panel">
      <header className="panel-header">
        <h2 className="panel-title">
          <AccountBalanceIcon />
          Accounts
        </h2>
        <span className="panel-count">{accounts.length} active</span>
      </header>

      <div>
        {accounts.map((account) => {
          const Tile = TILES[account.accountKind];

          return (
            <Link
              key={account.accountId}
              className="account-row"
              to={`/accounts/${account.accountId}${ownerSearch(owners)}`}
            >
              <div className="account-identity">
                <div className="account-tile">
                  <Tile />
                </div>
                <div>
                  <p className="account-name">
                    {account.accountName}
                    <AccountNumberTail tail={account.accountNumberTail} />
                  </p>
                  <p className="account-meta">
                    {account.institution} · {labelOf(ACCOUNT_KINDS, account.accountKind)}
                  </p>
                </div>
              </div>

              <div className="account-figures">
                <p className="account-amount u-data">
                  <Amount value={account.amount} />
                </p>
                <span className="account-owner">{account.ownerName}</span>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function AllocationPanel({
  accounts,
  allocation,
}: {
  accounts: AccountRow[];
  allocation: ReturnType<typeof allocationBars>;
}) {
  const { held, bars } = allocation;

  const notes = [
    bars.length < held ? `The ${bars.length} largest of ${held} accounts that hold value.` : null,
    held < accounts.length
      ? "A share is a share of what is owned, so an account holding none of it — a " +
        "liability, or one with no priced position — has no bar."
      : null,
  ].filter((note) => note !== null);

  return (
    <section className="panel">
      <header className="panel-header">
        <h2 className="panel-title">Allocation by account</h2>
        <span className="panel-count">Share of assets</span>
      </header>

      <div className="panel-body">
        <div className="alloc">
          {bars.map(({ account, colour, width }) => (
            <div className="alloc-row" key={account.accountId}>
              <div className="alloc-label">
                <span>
                  {account.accountName}
                  <AccountNumberTail tail={account.accountNumberTail} />
                </span>
                <b className="u-data">
                  <Amount value={account.amount} />
                </b>
              </div>
              <div className="alloc-track">
                <div className="alloc-fill" style={{ width, background: colour }} />
              </div>
            </div>
          ))}

          {notes.length > 0 ? <p className="coverage-note">{notes.join(" ")}</p> : null}
        </div>
      </div>
    </section>
  );
}

export default function Overview({ loaderData }: Route.ComponentProps) {
  const {
    range,
    custom,
    rangeOptions: options,
    customMin,
    customMax,
    change,
    accounts,
    computed,
    manual,
    session,
    holdingCount,
    narrowedToNothing,
    pricedCount,
    freshness,
    manualWithheld,
    showEveryone,
    owners,
    roster,
    narrowedTo,
    unknownOwner,
  } = loaderData;

  // Unconditional: a hook, and this route moves in/out of the empty state client-side.
  const masked = useMasked();

  // Empty for filter-reached-nothing or instance-has-nothing — told apart by `narrowedToNothing`, not the filter being on.
  if (holdingCount === 0) {
    return (
      <section className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Overview</h1>
          </div>
          <div className="page-actions">
            <OwnerFilterControl
              owners={roster}
              selected={owners}
              hidden={rangeFields(range, custom)}
            />
          </div>
        </header>
        {narrowedToNothing ? (
          <NarrowedToNothing
            owners={narrowedTo}
            unknownOwner={unknownOwner}
            showEveryone={showEveryone}
          />
        ) : (
          <EmptyState>
            Net worth, the trend line and the account breakdown appear here once a statement has
            been uploaded. Nothing has been uploaded to this instance yet.
          </EmptyState>
        )}
      </section>
    );
  }

  const down = isNegative(change.difference);
  const Arrow = down ? TrendingDownIcon : TrendingUpIcon;

  // Two points make a line; one is a dot.
  const plottable = computed.length + manual.length >= 2;

  const allocation = allocationBars(accounts);

  return (
    <section className="page">
      <Header roster={roster} owners={owners} range={range} custom={custom} />

      <section className="kpi">
        <div>
          <p className="kpi-eyebrow u-label">Total net worth</p>
          <p className="kpi-figure u-data">
            <Amount value={change.current} />
            {/* Sign, then arrow, then hue — readable with no colour perception at all (§12). */}
            <span className={down ? "delta delta--loss" : "delta delta--gain"}>
              <Arrow />
              {/* Ratio never masked, amount always is — two nodes, never one interpolated string (spec 0007). */}
              {change.percent === null ? null : `${formatPercent(change.percent)} / `}
              <Amount value={change.difference} shape="signed" />
            </span>
          </p>

          <NarrowedTo owners={narrowedTo} />

          <PriceFreshness freshness={freshness} />
        </div>

        <ChartRangeControl
          range={range}
          custom={custom}
          options={options}
          customMin={customMin}
          customMax={customMax}
        />
      </section>

      <section className="panel">
        <header className="panel-header">
          <h2 className="panel-title">Net worth</h2>
          {pricedCount < holdingCount ? (
            <p className="coverage-note">
              The figure and the line are {pricedCount} of {holdingCount} holdings. The rest
              have never been priced.
            </p>
          ) : null}
          {manualWithheld ? (
            <p className="coverage-note">
              The hand-typed history before this instance existed is the household's and has no
              owner, so it is not drawn here. The line begins at these owners' first recorded
              holdings.
            </p>
          ) : null}
        </header>

        <div className="panel-body">
          {plottable ? (
            <NetWorthChart
              id="net-worth"
              computed={computed}
              manual={manual}
              label={`Total value ${rangeDescription(range, custom)},`}
              masked={masked}
              session={session}
            />
          ) : (
            <ChartEmptyNote session={session} moments={computed.length}>
              <p className="empty-note">
                A trend needs two dated points and this instance has one. The line appears once a
                second statement has been uploaded.
              </p>
            </ChartEmptyNote>
          )}
        </div>
      </section>

      <div className={allocation.bars.length > 0 ? "columns columns--wide-narrow" : "columns"}>
        <AccountsPanel accounts={accounts} owners={owners} />
        {allocation.bars.length > 0 ? (
          <AllocationPanel accounts={accounts} allocation={allocation} />
        ) : null}
      </div>
    </section>
  );
}
