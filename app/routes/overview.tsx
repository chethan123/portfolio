import { Link } from "react-router";

import { EmptyState } from "~/components/empty-state";
import { AccountBalanceIcon, TrendingDownIcon, TrendingUpIcon } from "~/components/icons";
import { NetWorthChart } from "~/components/net-worth-chart";
import { formatMoney, formatPercent, formatSignedMoney, isNegative } from "~/lib/format";
import {
  accountTotals,
  firstRecordedDate,
  manualNetWorth,
  netWorthChange,
  netWorthSeries,
  type IsoDate,
  type ManualPoint,
} from "~/lib/valuation.server";

import type { Route } from "./+types/overview";

/**
 * Overview — the net worth headline, the trend line, and the accounts rollup.
 *
 * The layout is the Stitch "Portfolio Dashboard" screen (DESIGN.md §13): a
 * headline panel whose figure is the only large thing on the page, and a table
 * below it with no vertical rules and one hairline between rows.
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
  const range: RangeKey =
    requested && requested in RANGES ? (requested as RangeKey) : DEFAULT_RANGE;

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

export default function Overview({ loaderData }: Route.ComponentProps) {
  const { range, change, accounts, computed, manual, holdingCount, pricedCount } = loaderData;

  if (holdingCount === 0) {
    return (
      <section className="page">
        <h1>Overview</h1>
        <EmptyState>
          Net worth, the trend line and the account breakdown appear here once a statement has
          been uploaded. Nothing has been uploaded to this instance yet.
        </EmptyState>
      </section>
    );
  }

  const down = isNegative(change.difference);
  const Arrow = down ? TrendingDownIcon : TrendingUpIcon;

  return (
    <>
      <h1 className="visually-hidden">Overview</h1>

      <section className="panel">
        <header className="kpi">
          <div>
            <span className="u-label">Total net worth</span>
            <p className="kpi-figure">
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
            {pricedCount < holdingCount ? (
              <p className="coverage-note">
                Based on {pricedCount} of {holdingCount} holdings. The rest have never been
                priced and contribute nothing to this figure.
              </p>
            ) : null}
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
        </header>

        <NetWorthChart
          computed={computed}
          manual={manual}
          label={`Total value over the last ${RANGES[range].label}, ending at ${formatMoney(
            change.current,
          )}.`}
        />
      </section>

      <section className="panel">
        <header className="panel-header">
          <h2 className="panel-title">
            <AccountBalanceIcon />
            Accounts
          </h2>
          <span className="panel-count">{accounts.length} active</span>
        </header>

        <div className="data-table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col" className="is-owner">
                  Owner
                </th>
                <th scope="col" className="is-numeric">
                  Current value
                </th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.accountId}>
                  <td>
                    <div className="account-name">{account.accountName}</div>
                    <div className="account-meta">
                      {account.institution} · {account.accountKind}
                    </div>
                    {/* The phone folds the owner under the account rather than
                        scrolling sideways for it (§8.1). */}
                    <div className="account-owner account-owner--inline">
                      {account.ownerName}
                    </div>
                  </td>
                  <td className="is-owner">
                    <div className="account-owner">{account.ownerName}</div>
                  </td>
                  <td
                    className={
                      isNegative(account.amount) ? "is-numeric is-negative" : "is-numeric"
                    }
                  >
                    {formatMoney(account.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
