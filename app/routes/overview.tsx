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
 * Overview — the net worth headline, the trend line, and the accounts
 * rollup (Stitch "Portfolio Dashboard", DESIGN.md §13). The headline sits
 * directly on the canvas, not in a panel — what keeps the one figure the
 * page exists for from reading as one card among several; everything under
 * it is a panel. None of the mock's *data* is taken: every figure it showed
 * was fabricated. The numbers come from the shared query module, which is
 * what keeps this page and Holdings from disagreeing (§8.2). The empty case
 * is load-bearing and comes first: a never-uploaded instance renders **no
 * figure at all**, because a net worth of zero and an empty database look
 * identical on screen and only one is worth panicking about.
 */

export function meta() {
  return [{ title: "Overview · Portfolio" }];
}

/**
 * How many accounts the allocation panel draws. The categorical sequence is
 * five and §13.3 refuses to extend it. The tail is named in a note rather
 * than folded into an "Other" bar, which would have to carry a summed
 * figure — and this route does no money arithmetic.
 */
const BARS = 5;

/** Stamps the range cookie on an explicit choice (spec 0008) — see {@link chartRangeMiddleware} for why. */
export const middleware: Route.MiddlewareFunction[] = [chartRangeMiddleware()];

export async function loader({ request }: Route.LoaderArgs) {
  // Settled first — {@link chartRangeMiddleware} declines to stamp its cookie
  // on either bounce `ownerReading` may throw — and ahead of `today` below:
  // it is synchronous and database-free (`chart-range.ts`), so running it
  // after costs nothing, but it is a reorder from this loader's previous
  // shape worth naming as one.
  const { reading, owner } = await ownerReading(request);
  const { owners } = owner;

  const today = isoDate(Date.now());
  const scope: ChartScope = { surface: "household", reading };

  // `manual` and the reach in one round trip, not two: `earliest.manual`
  // below is `manual`'s own first point — not something `chartReach`
  // reads — so the window cannot be sized until the loader holds both, and
  // that is a requirement on the loader rather than a style preference:
  // written as two sequential awaits this would be two waves where it is
  // one (spec 0015).
  const [manual, reach] = await Promise.all([
    // Read either way: "not drawn while narrowed" and "this instance has
    // none" are two different screens, and only the first has anything to
    // explain — spec 0013's reason `manualNetWorth` takes no filter at all
    // (an empty answer could not be told from an empty table).
    manualNetWorth(),
    chartReach(scope),
  ]);

  // DESIGN.md §7 rule 3: the hand-typed series is the household's net worth
  // from before there were accounts to attribute it to — no owner on it, no
  // honest way to invent one — so a narrowed chart neither draws it nor
  // reaches back through it. The decision is here, on one line.
  const reachable = isFiltered(owners) ? [] : manual;

  // The chart's reach, and the whole of how a filter shortens it:
  // `reach.positionSet` is already the selected owners' first recorded date
  // and `reachable` is empty while narrowed, so the household rule — the
  // earlier of the two — computes the narrowed reach without being told
  // about the filter. `chart-range.ts` is untouched: no third `Surface`
  // member, no switch to the account one. On screen, **All** shortens to the
  // owners' own history and the long presets fall out of reach.
  const earliest = { positionSet: reach.positionSet, manual: reachable[0]?.date };

  const { resolved, controls } = chartWindow("household", {
    request,
    today,
    earliest,
    session: reach.session,
    timeZone: getConfig().MARKET_TIMEZONE,
  });

  // Created here and dropped into the `Promise.all` below, so the read runs
  // beside the others rather than queued behind them — `chartSeries` itself
  // is where the coverage rule and the dated/session choice live.
  const points = chartSeries(scope, resolved);

  const [change, accounts, computed, freshness, everyone] = await Promise.all([
    netWorthChange(reading, resolved.since),
    accountTotals(reading),
    points,
    asOfView(getConfig().MARKET_TIMEZONE),
    // Whether the *instance* holds anything — a different question from
    // whether these owners do, and only the first may be answered "nothing
    // has been uploaded". A count, only while narrowed (Analysis' read).
    isFiltered(owners) ? netWorth(ALL_OWNERS) : null,
  ]);

  // §7 rule 2: computed wins on overlapping dates, manual only fills the gap
  // ahead — and is bounded by the window at the other end too, or a 1M chart
  // would squeeze the asked-for month into the last pixels beside a 2022
  // point. ISO dates compare correctly as strings.
  const firstComputed = computed[0]?.date;
  const manualPrefix =
    // Never under 1D: dropping a 2022 point onto a line of this morning's
    // instants would claim a session that never happened (§7).
    resolved.session !== undefined
      ? []
      : reachable.filter(
          (point) =>
            point.date >= resolved.since &&
            (firstComputed === undefined || point.date < firstComputed),
        );

  // Summed from the same rollup the table renders, rather than counted
  // separately — two counts of one thing are two things that can disagree.
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
    /**
     * Whether the pre-app series exists and is being withheld — a different
     * fact from the filter being on: naming a cause the instance does not
     * have is how a note stops being read.
     */
    // Never under 1D, which draws no pre-app history filtered or not — the
    // note would blame the filter for an omission the range imposes. And
    // only for a point the *unfiltered* window would show, the same rule one
    // step further: a preset's or custom span's start is date arithmetic the
    // filter cannot move, so `resolved.since` is that counterfactual;
    // **All**'s start is the narrowed reach itself, and unfiltered it spans
    // every hand-typed point, so there any point at all is being withheld.
    manualWithheld:
      isFiltered(owners) &&
      resolved.session === undefined &&
      manual.some((point) => resolved.range === "all" || point.date >= resolved.since),
    holdingCount,
    narrowedToNothing: isNarrowedToNothing(owners, { held: holdingCount, instance }),
    pricedCount: accounts.reduce((total, account) => total + account.coverage.known, 0),
  };
}

/**
 * The chart parameters a GET form must re-emit, so applying an owner does
 * not throw away the reader's chosen span. Shared by the header's control
 * and the one on an emptied screen — exactly where a reader changes owner,
 * and the version that quietly emitted nothing also reset the range.
 */
function rangeFields(range: RangeKey, custom?: CustomSpan): Record<string, string> {
  if (range === "custom" && custom !== undefined) {
    return { range, start: custom.start, end: custom.end };
  }

  return range === DEFAULT_RANGE ? {} : { range };
}

/**
 * The page's header strip, drawn only for what sits in it: the headline
 * below is the page's title in every way but markup, so the heading stays
 * hidden and there is nothing on the left. The strip holds the owner
 * control, in the same `page-actions` slot the other three screens use —
 * the chart range lives in the hero here, so "beside the range" would name
 * a different place per screen. The range's parameters ride as hidden
 * fields, so applying an owner keeps the chosen span.
 */
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
  // Nothing to put in the strip, so no strip — the row would add its own gap
  // above a headline that is already the page's title. The heading is the
  // page's, though: a screen whose only `h1` disappears because the
  // household has one owner cannot be navigated by heading, and a
  // `visually-hidden` heading has no box. A filtered address keeps the strip
  // whatever the roster holds — the control is then the one way to clear it.
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

/** One account as the page reads it back, after the loader's round trip. */
type AccountRow = Route.ComponentProps["loaderData"]["accounts"][number];

/**
 * Which tile an account wears. Exhaustive over `AccountKind` by
 * construction, so adding a kind fails the typecheck here rather than
 * rendering a row with no mark. The icon never stands alone: the kind is
 * written out beside it in the row's meta line (`icons.tsx`).
 */
const TILES = {
  brokerage: AccountBalanceIcon,
  "401k": AccountBalanceIcon,
  ira: RetirementIcon,
  bank: SavingsIcon,
  liability: LiabilityIcon,
} satisfies Record<AccountKind, typeof AccountBalanceIcon>;

/**
 * The accounts as bars, largest first. **By account, and titled so** — the
 * only breakdown this loader already holds: the asset-class and per-person
 * cuts need the holdings themselves, another hand-rolled dashboard query
 * (§8.2's weakest point). **The denominator is the gross positive total**
 * (`allocation.ts` argues it at length): a share of the *net* total
 * explodes when a mortgage nearly cancels a house — so liabilities are not
 * bars, and the note under the list says so rather than leaving them
 * silently missing. **The one place the page turns money into a float**,
 * through the one licensed helper: what comes out is a bar width, never
 * shown, compared, or summed back into a figure. The label beside each bar
 * is the account's value from its decimal string, not a percentage — an
 * exact share is `allocation.ts`'s arithmetic to do, not a route's.
 */
function allocationBars(accounts: AccountRow[]) {
  const held = accounts.filter((account) => toPlotValue(account.amount) > 0);
  const base = held.reduce((total, account) => total + toPlotValue(account.amount), 0);

  return {
    /** How many accounts have a share at all, which is what the bars are of. */
    held: held.length,
    bars: held.slice(0, BARS).map((account, index) => ({
      account,
      // The breakdowns' own assigner, so the same rank means the same
      // colour on every screen (§13.3) — including whatever the sequence
      // is recoloured to.
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
  /**
   * Carried into the account page — which ignores it — so its breadcrumb
   * can carry it back out. Spec 0013 names this round trip as the price of
   * the account exemption: Overview → a row → back had otherwise landed on
   * the whole household's headline from a screen narrowed two clicks ago.
   */
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

              {/* No per-account delta to put here: `accountTotals` rolls up
                  what is held now, and a change needs a second date. The
                  owner takes the slot the mock gives the delta. */}
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

  // Said only where it is true: the tail beyond the five, and the accounts with
  // no share to draw. Naming a cause the instance does not have is how a note
  // stops being read.
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
                {/* One span, one flex item: the label row is space-between,
                    and an unwrapped tail would be stranded mid-row as a
                    third item. */}
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

          {/* Inside `.alloc` rather than after it, so the list's own gap sets
              the space above it. */}
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

  // Before the empty return, unconditionally: this is a hook, and the empty
  // state is one this mounted route moves in and out of (the owner form
  // navigates client-side) — a conditional call would change the render's
  // hook count, which React refuses. The chart takes it as a prop: its axis
  // ticks and accessible label are strings, not components (spec 0007).
  const masked = useMasked();

  // Empty because the filter reached nothing, or because the instance has
  // nothing — only the second may say nothing has been uploaded, and the
  // first must keep the control on screen or the filter cannot be cleared
  // from the page it emptied. Which it is turns on `narrowedToNothing`, not on
  // the filter being on: a bookmarked `/?owner=1` against a fresh instance is
  // both, and blaming a stale owner would send the reader hunting a roster
  // the database does not have. Analysis and Income split it the same way.
  if (holdingCount === 0) {
    return (
      <section className="page">
        {/* The visible title, which this screen shows only here: with nothing
            below it there is no headline to be the page's name instead. */}
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

  // Two points make a line; one is a dot. The panel still renders, because the
  // coverage note and the reason the line is missing are both worth saying —
  // what it does not render is an axis or a figure.
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
            {/* Sign, then arrow, then hue — readable with no colour
                perception at all (§12). */}
            <span className={down ? "delta delta--loss" : "delta delta--gain"}>
              <Arrow />
              {/* The ratio is never masked and the amount always is, so two
                  separate nodes, never one interpolated string (spec 0007's
                  "ratios are a deliberate hole"). */}
              {change.percent === null ? null : `${formatPercent(change.percent)} / `}
              <Amount value={change.difference} shape="signed" />
            </span>
          </p>

          {/* Beside the figure it narrows, in words, never a chip alone: this
              headline is the number a forgotten filter would silently redefine,
              which is the condition ADR-0008 attaches to the filter surviving
              navigation. */}
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
          {/* Provenance, in the slot the mock gives a legend. It qualifies the
              headline as much as the line — they are one arithmetic over one
              view — so it is said once, here, rather than beside each. */}
          {pricedCount < holdingCount ? (
            <p className="coverage-note">
              The figure and the line are {pricedCount} of {holdingCount} holdings. The rest
              have never been priced.
            </p>
          ) : null}
          {/* Said rather than left to be noticed (§7 rule 3): the hand-typed
              series has no owner, so a narrowed line cannot reach behind the
              selected owners' first statement — and a suspiciously short line
              with nothing explaining it is the failure this codebase avoids
              everywhere else. Only where there is history to withhold: naming
              a cause that does not exist is how a note stops being read. */}
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

      {/* The mock's bento row: accounts wide, relative sizes narrow, stacked
          below 768px. A household with nothing positive recorded — only a
          loan — has no allocation panel, and the modifier comes off so the
          accounts take the full width rather than two thirds and a hole. */}
      <div className={allocation.bars.length > 0 ? "columns columns--wide-narrow" : "columns"}>
        <AccountsPanel accounts={accounts} owners={owners} />
        {allocation.bars.length > 0 ? (
          <AllocationPanel accounts={accounts} allocation={allocation} />
        ) : null}
      </div>
    </section>
  );
}
