import { Link } from "react-router";

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
  formatMoney,
  formatPercent,
  formatSignedMoney,
  isNegative,
  toPlotValue,
} from "~/lib/format";
import {
  accountTotals,
  firstRecordedDate,
  manualNetWorth,
  netWorthChange,
  netWorthSeries,
  type AccountKind,
  type IsoDate,
  type ManualPoint,
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
 * The ranges the segmented control offers.
 *
 * "All" carries no fixed length: it is measured from day zero, the earliest
 * date any statement records (§7). A fixed wide window was the first attempt
 * and is wrong — over thirty years, twenty-four of twenty-five samples land in
 * the era before the app existed, come back uncovered, and are discarded,
 * leaving an all-time chart with no all-time line on it.
 *
 * The mock offers 1D, 1W, YTD and a custom picker as well. None of them are
 * here, because nothing in this loader can answer them honestly: a household
 * uploads a statement a quarter, so a day-long window is a window with one
 * point in it (§14, limitation 7).
 */
const RANGES = {
  "1m": { label: "1M", days: 30 },
  "3m": { label: "3M", days: 90 },
  "1y": { label: "1Y", days: 365 },
  all: { label: "All", days: null },
} as const;

type RangeKey = keyof typeof RANGES;

/** Left as a literal, not widened to `RangeKey`, so its `days` stays non-null. */
const DEFAULT_RANGE = "1y" as const satisfies RangeKey;

/**
 * How many points the line is drawn from.
 *
 * Each one is a separate evaluation of `holding_valued_at` inside a single
 * query, so this trades server work for line smoothness. Twenty-five is enough
 * to show the shape of a year and few enough to stay one cheap round trip.
 */
const SAMPLES = 25;

/**
 * How many accounts the allocation panel draws.
 *
 * The categorical sequence is five long and §13.3 refuses to extend it: a sixth
 * flat colour is a legend nobody reads. The tail is named in a note rather than
 * folded into an "Other" bar, because an "Other" bar would have to carry a
 * summed figure and this route does no money arithmetic.
 */
const BARS = 5;

const DAY_MS = 86_400_000;

/**
 * UTC throughout, deliberately.
 *
 * §4.1 and `valuation.server.ts` both warn about dates crossing a boundary and
 * landing a day early; `toISOString` is the one conversion that cannot pick up
 * the server's timezone on the way out.
 */
const isoDate = (ms: number): IsoDate => new Date(ms).toISOString().slice(0, 10);

/**
 * The window to report on: where it starts, and the dates to draw it from.
 *
 * `since` is returned alongside rather than read back off `dates[0]` — they are
 * the same instant by construction, but one is the boundary the headline's
 * delta is measured against and the other is a drawing detail, and the delta
 * should not silently move if the sampling ever changes.
 */
function sampleWindow(days: number): { since: IsoDate; dates: IsoDate[] } {
  const today = Date.parse(isoDate(Date.now()));
  const step = (days * DAY_MS) / (SAMPLES - 1);

  // A short range can round two samples onto the same calendar day. Deduped
  // here rather than left to `group by` so the count going into the query is
  // the count of points coming back.
  const dates = Array.from({ length: SAMPLES }, (_, index) =>
    isoDate(today - (SAMPLES - 1 - index) * step),
  );

  return { since: isoDate(today - days * DAY_MS), dates: [...new Set(dates)] };
}

/**
 * How many days back the chart reaches.
 *
 * Only "All" has to ask the database, and only ever for one `min()`. An
 * instance with nothing in it falls back to the default window, which is
 * academic — the empty state renders instead of a chart.
 */
async function windowDays(range: RangeKey, manual: ManualPoint[]): Promise<number> {
  const fixed = RANGES[range].days;
  if (fixed !== null) return fixed;

  // Whichever is earlier: day zero, or the oldest hand-typed point. The manual
  // series is the part of the chart that reaches furthest back, so a window
  // measured from day zero alone would cut off the very history "All" is for.
  const earliest = [await firstRecordedDate(), manual[0]?.date]
    .filter((date): date is IsoDate => Boolean(date))
    .sort()[0];

  if (earliest === undefined) return RANGES[DEFAULT_RANGE].days;

  // A floor of one month keeps the sampler from collapsing to a single point
  // on an instance whose first upload was this week.
  return Math.max(Math.ceil((Date.now() - Date.parse(earliest)) / DAY_MS), 30);
}

export async function loader({ request }: Route.LoaderArgs) {
  const requested = new URL(request.url).searchParams.get("range");
  // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so `?range=`
  // naming anything on `Object.prototype` — `toString`, `constructor`,
  // `valueOf` — passed this gate, and `RANGES[requested].days` then read
  // `undefined` all the way to `isoDate(NaN)` and a 500 on the page. A query
  // parameter must not be able to do that.
  const range: RangeKey =
    requested && Object.hasOwn(RANGES, requested) ? (requested as RangeKey) : DEFAULT_RANGE;

  // Read before the window is sized, because the "All" window is measured
  // partly from it. It is a handful of hand-typed rows.
  const manual = await manualNetWorth();

  const { since, dates } = sampleWindow(await windowDays(range, manual));

  const [change, accounts, series] = await Promise.all([
    netWorthChange(since),
    accountTotals(),
    netWorthSeries(dates),
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
    (point) => point.date >= since && (firstComputed === undefined || point.date < firstComputed),
  );

  return {
    range,
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
                <p className="account-amount u-data">{formatMoney(account.amount)}</p>
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
                <b className="u-data">{formatMoney(account.amount)}</b>
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
  const { range, change, accounts, computed, manual, holdingCount, pricedCount } = loaderData;

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
            {formatMoney(change.current)}
            {/* Sign, then arrow, then hue — readable with no colour
                perception at all (§12). */}
            <span className={down ? "delta delta--loss" : "delta delta--gain"}>
              <Arrow />
              {change.percent === null
                ? formatSignedMoney(change.difference)
                : `${formatPercent(change.percent)} / ${formatSignedMoney(change.difference)}`}
            </span>
          </p>
        </div>

        <nav className="segmented" aria-label="Chart range">
          {Object.entries(RANGES).map(([key, { label }]) => (
            <Link
              key={key}
              to={key === DEFAULT_RANGE ? "." : `?range=${key}`}
              aria-current={key === range ? "true" : undefined}
              preventScrollReset
            >
              {label}
            </Link>
          ))}
        </nav>
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
              label={`Total value over the last ${RANGES[range].label}, ending at ${formatMoney(
                change.current,
              )}.`}
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
