import { Link } from "react-router";

import { Amount } from "~/components/amount";
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
import { NetWorthChart } from "~/components/net-worth-chart";
import { ACCOUNT_KINDS, labelOf } from "~/lib/account-options";
import {
  chartRangeMiddleware,
  customRangeMin,
  rangeDescription,
  rangeOptions,
  readChartRange,
  resolveRange,
} from "~/lib/chart-range";
import { formatPercent, isNegative, toPlotValue } from "~/lib/format";
import { useMasked } from "~/lib/masking";
import {
  accountTotals,
  firstRecordedDate,
  manualNetWorth,
  netWorthChange,
  netWorthSeries,
  type AccountKind,
  type IsoDate,
} from "~/lib/valuation.server";

import type { Route } from "./+types/overview";

/**
 * Overview — the net worth headline, the trend line, and the accounts rollup.
 *
 * The layout is the Stitch "Portfolio Dashboard" screen (DESIGN.md §13). The
 * headline sits directly on the canvas rather than in a panel, which is what
 * keeps the one figure the page exists for from reading as one card among
 * several; everything under it is a panel — the trend, and a bento row of the
 * accounts beside their relative sizes.
 *
 * What is *not* taken from that mock is any of its data. Every figure it showed
 * was fabricated, and one of its four accounts was a crypto account, which §1
 * puts out of scope. The numbers here come from the shared query module, which
 * is what keeps this page and the Holdings page from disagreeing about the same
 * portfolio (§8.2).
 *
 * The empty case is load-bearing and comes first: an instance nothing has been
 * uploaded to renders **no figure at all**, because a net worth of zero and an
 * empty database look identical on screen and only one of them is worth
 * panicking about.
 */

export function meta() {
  return [{ title: "Overview · Portfolio" }];
}

/**
 * How many accounts the allocation panel draws.
 *
 * The categorical sequence is five long and §13.3 refuses to extend it: a sixth
 * flat colour is a legend nobody reads. The tail is named in a note rather than
 * folded into an "Other" bar, because an "Other" bar would have to carry a
 * summed figure and this route does no money arithmetic.
 */
const BARS = 5;

/**
 * UTC throughout, deliberately.
 *
 * §4.1 and `valuation.server.ts` both warn about dates crossing a boundary and
 * landing a day early; `toISOString` is the one conversion that cannot pick up
 * the server's timezone on the way out.
 */
const isoDate = (ms: number): IsoDate => new Date(ms).toISOString().slice(0, 10);

/**
 * Remembers an explicit range choice in the persistence cookie (spec 0008).
 * See {@link chartRangeMiddleware}'s own docstring for why this is a
 * middleware rather than a header on the loader's own return.
 */
export const middleware: Route.MiddlewareFunction[] = [chartRangeMiddleware()];

export async function loader({ request }: Route.LoaderArgs) {
  const requested = readChartRange(request);
  const today = isoDate(Date.now());

  // Read before the window is sized: the household surface's earliest date
  // (§7's "chart range" rule) is measured partly from it, and it is a handful
  // of hand-typed rows either way.
  const manual = await manualNetWorth();
  const earliest = { positionSet: await firstRecordedDate(), manual: manual[0]?.date };

  const resolved = resolveRange(requested.range, {
    today,
    earliest,
    surface: "household",
    custom: requested.custom,
  });

  const [change, accounts, series] = await Promise.all([
    netWorthChange(resolved.since),
    accountTotals(),
    netWorthSeries(resolved.dates),
  ]);

  // A date before the first upload sums to 0.0000 over zero rows. That is
  // "nothing was recorded yet", not "the household had nothing" — drawing it
  // would put a fictional climb from zero at the head of every chart (§7).
  const computed = series
    .filter((point) => point.coverage.total > 0)
    .map((point) => ({ date: point.date, amount: point.amount }));

  // §7 rule 2: computed wins on overlapping dates, manual only fills the gap
  // ahead of it. Bounded by the window at the other end too — a 1M chart
  // carrying a hand-typed point from 2022 would squeeze the month it was asked
  // for into the last few pixels. ISO dates compare correctly as strings.
  const firstComputed = computed[0]?.date;
  const manualPrefix = manual.filter(
    (point) =>
      point.date >= resolved.since && (firstComputed === undefined || point.date < firstComputed),
  );

  return {
    range: resolved.range,
    custom: resolved.custom,
    rangeOptions: rangeOptions({ today, earliest, surface: "household" }),
    customMin: customRangeMin("household", earliest),
    customMax: today,
    change,
    accounts,
    computed,
    manual: manualPrefix,
    // Summed from the same rollup the table renders, rather than counted
    // separately — two counts of one thing are two things that can disagree.
    holdingCount: accounts.reduce((total, account) => total + account.coverage.total, 0),
    pricedCount: accounts.reduce((total, account) => total + account.coverage.known, 0),
  };
}

/** One account as the page reads it back, after the loader's round trip. */
type AccountRow = Route.ComponentProps["loaderData"]["accounts"][number];

/**
 * Which tile an account wears.
 *
 * Exhaustive over `AccountKind` by construction, so adding a kind to the schema
 * fails the typecheck here rather than rendering a row with no mark on it. The
 * icon never stands alone: the kind is written out beside it in the row's meta
 * line, because a drawing of a briefcase is not a label (`icons.tsx`).
 */
const TILES = {
  brokerage: AccountBalanceIcon,
  "401k": AccountBalanceIcon,
  ira: RetirementIcon,
  bank: SavingsIcon,
  liability: LiabilityIcon,
} satisfies Record<AccountKind, typeof AccountBalanceIcon>;

/**
 * The accounts as bars, largest first.
 *
 * **By account, and titled so.** It is the only breakdown this loader already
 * holds: the asset-class and per-person cuts need the holdings themselves, and
 * fetching them here would add another hand-rolled dashboard query — the
 * failure §8.2 names as the weakest point in the whole design.
 *
 * **The denominator is the gross positive total**, exactly as `allocation.ts`
 * argues at length: a share of the *net* total explodes when a mortgage nearly
 * cancels a house, and turns negative for a household in net debt. So the
 * liabilities are not bars here — a debt is not a slice of what is owned — and
 * the note under the list says so rather than leaving them silently missing.
 *
 * **This is the one place the page turns money into a float**, through the one
 * helper licensed to do it. What comes out is a bar width: it is never shown,
 * never compared against a figure, and never summed back into one. The label
 * beside each bar is the account's own value formatted from its decimal string,
 * not a percentage — a percentage would be a *displayed* figure derived from
 * these floats, and an exact share is `allocation.ts`'s arithmetic to do, not a
 * route's.
 */
function allocationBars(accounts: AccountRow[]) {
  const held = accounts.filter((account) => toPlotValue(account.amount) > 0);
  const base = held.reduce((total, account) => total + toPlotValue(account.amount), 0);

  return {
    /** How many accounts have a share at all, which is what the bars are of. */
    held: held.length,
    bars: held.slice(0, BARS).map((account, index) => ({
      account,
      // One-based rank. `--cat-1` is rank one in every breakdown in the app, so
      // the same position means the same colour on every screen (§13.3).
      colour: `var(--cat-${index + 1})`,
      width: `${((toPlotValue(account.amount) / base) * 100).toFixed(1)}%`,
    })),
  };
}

function AccountsPanel({ accounts }: { accounts: AccountRow[] }) {
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
              to={`/accounts/${account.accountId}`}
            >
              <div className="account-identity">
                <div className="account-tile">
                  <Tile />
                </div>
                <div>
                  <p className="account-name">{account.accountName}</p>
                  <p className="account-meta">
                    {account.institution} · {labelOf(ACCOUNT_KINDS, account.accountKind)}
                  </p>
                </div>
              </div>

              {/* No per-account delta to put here: `accountTotals` is a
                  rollup of what is held now, and a change would need the same
                  account valued at a second date. The owner takes the slot the
                  mock gives the delta rather than the row inventing one. */}
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
                {account.accountName}
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
    holdingCount,
    pricedCount,
  } = loaderData;

  if (holdingCount === 0) {
    return (
      <section className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Overview</h1>
          </div>
        </header>
        <EmptyState>
          Net worth, the trend line and the account breakdown appear here once a statement has
          been uploaded. Nothing has been uploaded to this instance yet.
        </EmptyState>
      </section>
    );
  }

  const down = isNegative(change.difference);
  const Arrow = down ? TrendingDownIcon : TrendingUpIcon;

  // The chart takes the state as a prop rather than asking for itself: its axis
  // ticks and its accessible label are strings, not components (spec 0007).
  const masked = useMasked();

  // Two points make a line; one is a dot. The panel still renders, because the
  // coverage note and the reason the line is missing are both worth saying —
  // what it does not render is an axis or a figure.
  const plottable = computed.length + manual.length >= 2;

  const allocation = allocationBars(accounts);

  return (
    <section className="page">
      {/* The headline is the page's title in every way but markup. The heading
          stays for anyone navigating by one. */}
      <h1 className="visually-hidden">Overview</h1>

      <section className="kpi">
        <div>
          <p className="kpi-eyebrow u-label">Total net worth</p>
          <p className="kpi-figure u-data">
            <Amount value={change.current} />
            {/* Sign, then arrow, then hue — readable with no colour
                perception at all (§12). */}
            <span className={down ? "delta delta--loss" : "delta delta--gain"}>
              <Arrow />
              {/* The ratio is never masked and the amount always is, so the
                  two are separate nodes rather than one interpolated string
                  (`CONTEXT.md`, and spec 0007's "ratios are a deliberate
                  hole"). */}
              {change.percent === null ? null : `${formatPercent(change.percent)} / `}
              <Amount value={change.difference} shape="signed" />
            </span>
          </p>
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
        </header>

        <div className="panel-body">
          {plottable ? (
            <NetWorthChart
              id="net-worth"
              computed={computed}
              manual={manual}
              label={`Total value ${rangeDescription(range, custom)},`}
              endingAt={change.current}
              masked={masked}
            />
          ) : (
            <p className="empty-note">
              A trend needs two dated points and this instance has one. The line appears once a
              second statement has been uploaded.
            </p>
          )}
        </div>
      </section>

      {/* The mock's bento row: the accounts wide, their relative sizes narrow,
          stacked below 768px. A household with nothing positive recorded — only
          a loan — has no allocation to put beside them, and the modifier comes
          off so the accounts panel takes the full width rather than two thirds
          of it and a hole. */}
      <div className={allocation.bars.length > 0 ? "columns columns--wide-narrow" : "columns"}>
        <AccountsPanel accounts={accounts} />
        {allocation.bars.length > 0 ? (
          <AllocationPanel accounts={accounts} allocation={allocation} />
        ) : null}
      </div>
    </section>
  );
}
