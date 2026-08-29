import { Link, redirect } from "react-router";

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
import {
  NarrowedTo,
  NarrowedToNothing,
  OwnerFilterControl,
} from "~/components/owner-filter-control";
import { ACCOUNT_KINDS, labelOf } from "~/lib/account-options";
import {
  DEFAULT_RANGE,
  chartRangeMiddleware,
  customRangeMin,
  rangeDescription,
  rangeOptions,
  readChartRange,
  resolveRange,
  type CustomSpan,
  type RangeKey,
} from "~/lib/chart-range";
import { formatPercent, isNegative, toPlotValue } from "~/lib/format";
import { useMasked } from "~/lib/masking";
import {
  ALL_OWNERS,
  canonicalOwnerSearch,
  isFiltered,
  ownerSearch,
  readOwnerFilter,
  sameView,
  type OwnerFilter,
} from "~/lib/owner-filter";
import { ownerRoster } from "~/lib/people.server";
import {
  accountTotals,
  asSessionPoints,
  firstRecordedDate,
  latestObservedSession,
  manualNetWorth,
  netWorthChange,
  netWorthSeries,
  netWorthSessionSeries,
  type AccountKind,
  type IsoDate,
} from "~/lib/valuation.server";

import { getConfig } from "../../server/config.ts";

import { PriceFreshness } from "../components/price-freshness.tsx";
import { asOfView } from "../lib/prices.server.ts";

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
  const url = new URL(request.url);

  // First, and before any database work: the canonical spelling of an owner
  // parameter is a fact about the address, and the redirect is decided without
  // asking who exists (ADR-0008). {@link chartRangeMiddleware} declines to
  // stamp its cookie on the bounce.
  const canonical = canonicalOwnerSearch(url.searchParams);
  // `sameView` rather than `!==`: two serialisers spell `'` and `,` differently
  // — `encodeURIComponent` leaves both alone where `URLSearchParams` writes
  // `%27` and `%2C` — and a comparison blind to that would bounce forever on an
  // address it had just produced. Every multi-owner URL reaches it on some
  // transports.
  if (!sameView(url.search, canonical)) throw redirect(`${url.pathname}${canonical}`);

  const owners = readOwnerFilter(url.searchParams);
  const requested = readChartRange(request);
  const today = isoDate(Date.now());

  // Read before the window is sized: the household surface's earliest date
  // (§7's "chart range" rule) is measured partly from it, and it is a handful
  // of hand-typed rows either way.
  // Reads that need nothing from each other. Three of them have to land before
  // the window can be sized: the surface's earliest date (§7's "chart range"
  // rule) is measured from the first two, and the third is which session 1D
  // would plot — or, by its absence, whether the chip may be offered at all
  // (ADR-0006, story 13). Every page load pays for that one whether or not 1D
  // is selected, which is why it joins the others rather than queueing behind
  // them. The roster is here for the same reason and needs nothing either.
  const [manual, positionSet, session, roster] = await Promise.all([
    // Read either way, because "not drawn while narrowed" and "this instance
    // has none" are two different screens and only the first has anything to
    // explain. Spec 0013 gives that as the reason `manualNetWorth` does not
    // take the filter at all: an empty answer could not be told from an empty
    // table. It is a handful of hand-typed rows.
    manualNetWorth(),
    firstRecordedDate(owners),
    latestObservedSession(),
    ownerRoster(owners),
  ]);

  // DESIGN.md §7 rule 3: the hand-typed series is the household's net worth
  // from before there were accounts to attribute it to. There is no owner on it
  // and no honest way to invent one, so a narrowed chart neither draws it nor
  // reaches back through it — the decision is here, on one line, rather than in
  // a reader that would have to lie about what it read.
  const reachable = isFiltered(owners) ? [] : manual;

  // The chart's reach, and the whole of how a filter shortens it: `positionSet`
  // is already the selected owners' own first recorded date, and `reachable` is
  // empty while narrowed — so the household rule, which is the earlier of the
  // two, computes the narrowed reach without being told about the filter at
  // all. `chart-range.ts` is untouched here: no third `Surface` member, and not
  // even a switch to the account one, which would compute the same date twice.
  //
  // What follows from it is on screen: **All** shortens to the owners' own
  // history and the long presets fall out of reach, exactly as they do on an
  // account page.
  const earliest = { positionSet, manual: reachable[0]?.date };

  // Everybody ticked is the household, whose URL carries no owner parameter at
  // all (ADR-0008) — and here that is not merely a second URL for one view: a
  // narrowed chart drops the pre-app history, so the two would differ by every
  // year before the first upload while the headline stayed identical.
  if (roster.coversEveryone) {
    throw redirect(`${url.pathname}${canonicalOwnerSearch(url.searchParams, ALL_OWNERS)}`);
  }

  const resolved = resolveRange(requested.range, {
    today,
    earliest,
    surface: "household",
    custom: requested.custom,
    session,
  });

  // The two series answer the same question at different granularities, so they
  // are normalised to one shape here and there is one code path below. `at` is
  // a date for every preset but 1D, where it is an instant; `resolved.session`
  // is what says which, and the chart is told the same thing.
  const points =
    resolved.session === undefined
      ? netWorthSeries(owners, resolved.dates).then(asSessionPoints)
      : netWorthSessionSeries(owners, resolved.session);

  const [change, accounts, series, freshness] = await Promise.all([
    netWorthChange(owners, resolved.since),
    accountTotals(owners),
    points,
    asOfView(getConfig().MARKET_TIMEZONE),
  ]);

  // A date before the first upload sums to 0.0000 over zero rows. That is
  // "nothing was recorded yet", not "the household had nothing" — drawing it
  // would put a fictional climb from zero at the head of every chart (§7).
  const computed = series
    .filter((point) => point.coverage.total > 0)
    .map((point) => ({ date: point.at, amount: point.amount }));

  // §7 rule 2: computed wins on overlapping dates, manual only fills the gap
  // ahead of it. Bounded by the window at the other end too — a 1M chart
  // carrying a hand-typed point from 2022 would squeeze the month it was asked
  // for into the last few pixels. ISO dates compare correctly as strings.
  const firstComputed = computed[0]?.date;
  const manualPrefix =
    // Never under 1D. The hand-typed series is the household's net worth before
    // day zero (§7); dropping a point from 2022 onto a line of this morning's
    // instants would claim a session that never happened.
    resolved.session !== undefined
      ? []
      : reachable.filter(
          (point) =>
            point.date >= resolved.since &&
            (firstComputed === undefined || point.date < firstComputed),
        );

  return {
    freshness,
    owners,
    roster: roster.people.map((person) => ({ id: person.id, name: person.name })),
    narrowedTo: roster.narrowedTo.map((person) => ({ id: person.id, name: person.name })),
    unknownOwner: roster.unknownOwner,
    range: resolved.range,
    custom: resolved.custom,
    // Null on every range but 1D, which is how the chart is told which axis it
    // is drawing. The zone is the market's, never the reader's — see
    // `marketTimeOf`.
    session: resolved.session === undefined ? null : { timeZone: getConfig().MARKET_TIMEZONE },
    rangeOptions: rangeOptions({ today, earliest, surface: "household", session }),
    customMin: customRangeMin("household", earliest),
    customMax: today,
    change,
    accounts,
    computed,
    manual: manualPrefix,
    /**
     * Whether the pre-app series exists and is being withheld — a different
     * fact from the filter being on. Naming a cause the instance does not have
     * is how a note stops being read, which is the rule the allocation panel's
     * own notes keep two panels down.
     */
    // Never under 1D, which draws no pre-app history whether or not a filter is
    // on: the note would name the filter as the cause of an omission the range
    // imposes, and it says the line begins at the owners' first recorded
    // holdings where a session begins at its first observed instant. Both
    // sentences would be wrong at once.
    manualWithheld: isFiltered(owners) && manual.length > 0 && resolved.session === undefined,
    /**
     * Where "Show everyone" goes: this address, its own parameters kept, no
     * owner — so clearing the filter from an emptied screen does not also throw
     * away the range the reader had chosen.
     */
    showEveryone: canonicalOwnerSearch(url.searchParams, ALL_OWNERS) || ".",
    // Summed from the same rollup the table renders, rather than counted
    // separately — two counts of one thing are two things that can disagree.
    holdingCount: accounts.reduce((total, account) => total + account.coverage.total, 0),
    pricedCount: accounts.reduce((total, account) => total + account.coverage.known, 0),
  };
}

/**
 * The chart parameters a GET form has to re-emit, so that applying an owner does
 * not throw away the reader's chosen span.
 *
 * Shared by the header's control and the one on an emptied screen, because an
 * emptied screen is exactly where a reader changes owner — and the version that
 * quietly emitted nothing sent them back to the default range as well.
 */
function rangeFields(range: RangeKey, custom?: CustomSpan): Record<string, string> {
  if (range === "custom" && custom !== undefined) {
    return { range, start: custom.start, end: custom.end };
  }

  return range === DEFAULT_RANGE ? {} : { range };
}

/**
 * The page's header strip — which this screen draws only for what sits in it.
 *
 * The headline below is the page's title in every way but markup, so the
 * heading stays hidden and there is nothing on the left. What the strip is for
 * is the owner control, in the same `page-actions` slot Holdings, Analysis and
 * Income put it in: the chart range lives in the hero section here, so "beside
 * the range" would name a different place on every screen and the header is the
 * one the four share.
 *
 * The range's own parameters are the hidden fields, so applying an owner does
 * not throw away a chosen span.
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
  // Nothing to put in the strip, so no strip — the row would otherwise add its
  // own gap above a headline that is already the page's title. The heading is
  // not the strip's, though: it is the page's, and a screen whose only `h1`
  // disappears because the household has one owner is one a screen reader
  // cannot navigate by heading. A `visually-hidden` heading has no box, so on
  // its own it costs the gap nothing.
  if (roster.length < 2) return <h1 className="visually-hidden">Overview</h1>;

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

function AccountsPanel({
  accounts,
  owners,
}: {
  accounts: AccountRow[];
  /**
   * Carried into the account page — which ignores it — so that its breadcrumb
   * can carry it back out. Spec 0013 names this round trip as the price of the
   * account exemption: Overview → a row → back had otherwise landed on the
   * whole household's headline, silently, from a screen a reader had narrowed
   * two clicks earlier.
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
    session,
    holdingCount,
    pricedCount,
    freshness,
    manualWithheld,
    showEveryone,
    owners,
    roster,
    narrowedTo,
    unknownOwner,
  } = loaderData;

  // Empty because the filter reached nothing, rather than because the instance
  // has nothing. Only the second may say nothing has been uploaded, and the
  // first has to keep the control on screen or the filter cannot be cleared
  // from the page it emptied.
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
        {isFiltered(owners) ? (
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
              {/* The ratio is never masked and the amount always is, so the
                  two are separate nodes rather than one interpolated string
                  (`CONTEXT.md`, and spec 0007's "ratios are a deliberate
                  hole"). */}
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
          {/* Said rather than left to be noticed. DESIGN.md §7 rule 3: the
              hand-typed series is the household's net worth from before there
              were accounts to attribute it to, so a narrowed line cannot reach
              behind the selected owners' first statement — and a suspiciously
              short line with nothing explaining it is the failure this codebase
              avoids everywhere else. */}
          {/* Only where there is such a history to withhold: on an instance
              with no hand-typed rows the sentence would name a cause that does
              not exist, which is how a note stops being read. */}
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
          ) : session !== null && computed.length > 0 ? (
            // A session with one observed moment in it, which is a real state
            // between the poller's first attempt and its second — and not the
            // state the sentence below describes, since it has nothing to do
            // with how many statements have been uploaded. Guarded on there
            // being a moment at all: with none, nothing has been uploaded and
            // no amount of waiting for prices will change that, so the sentence
            // below is the true one.
            <p className="empty-note">
              A line needs two observed moments and this session has {computed.length}. It
              appears once another price arrives.
            </p>
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
        <AccountsPanel accounts={accounts} owners={owners} />
        {allocation.bars.length > 0 ? (
          <AllocationPanel accounts={accounts} allocation={allocation} />
        ) : null}
      </div>
    </section>
  );
}
