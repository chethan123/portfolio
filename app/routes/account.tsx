import { Link } from "react-router";

import { EmptyState } from "~/components/empty-state";
import {
  AccountBalanceIcon,
  EditIcon,
  HoldingsIcon,
  LiabilityIcon,
  RetirementIcon,
  SavingsIcon,
} from "~/components/icons";
import { NetWorthChart } from "~/components/net-worth-chart";
import { ACCOUNT_KINDS, TAX_TREATMENTS, labelOf } from "~/lib/account-options";
import { getAccount } from "~/lib/accounts.server";
import { ASSET_CLASSES } from "~/lib/allocation";
import { formatMoney } from "~/lib/format";
import {
  accountHoldings,
  accountSeries,
  accountTotal,
  firstRecordedDate,
  type AccountKind,
  type IsoDate,
} from "~/lib/valuation.server";

import type { Route } from "./+types/account";

/**
 * Account details — one account's identity, its own line, and what it holds.
 *
 * The Stitch "Account Details" screen (DESIGN.md §13). §8.1 had ruled this page
 * out on the grounds that a filtered Holdings table already is one; §13.1
 * reverses that, because the screen carries the account's own header and its own
 * valuation series, and the queries behind it are the dashboard's with one
 * predicate added rather than new joins (§8.2).
 *
 * Nothing here reads the view directly and nothing here does arithmetic on
 * money. Every figure comes out of `valuation.server.ts` as a decimal string and
 * goes into `format.ts` as one, which is what keeps this page's total identical
 * to the row the overview already shows for the same account — they are one
 * `sum(value)` over one view, not two.
 *
 * Two things the mock shows are deliberately not drawn, each argued where it
 * would have gone: the header's change chip, and the holdings table's "Today's
 * Change" column. Both are figures this app cannot compute honestly today, and
 * §13.7 is explicit that such a figure is left out rather than invented.
 */

export function meta({ data }: Route.MetaArgs) {
  return [{ title: `${data?.total.accountName ?? "Account"} · Portfolio` }];
}

/**
 * The ranges the segmented control offers.
 *
 * Deliberately the same four the overview offers, with the same `?range=` keys
 * and the same default: the control is the same control, and a person who
 * bookmarked `?range=3m` on one page should get three months on the other. That
 * makes this a copy of the overview's sampler rather than an import — a route
 * module cannot be imported for its constants without dragging its loader along
 * — and the pair should move into a shared module the next time either changes.
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

/** As on the overview: one round trip, twenty-five evaluations of the as-of function. */
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

/** The dates the line is drawn from, deduped so two samples cannot land on one day. */
function sampleDates(days: number): IsoDate[] {
  const today = Date.parse(isoDate(Date.now()));
  const step = (days * DAY_MS) / (SAMPLES - 1);

  const dates = Array.from({ length: SAMPLES }, (_, index) =>
    isoDate(today - (SAMPLES - 1 - index) * step),
  );

  return [...new Set(dates)];
}

/**
 * How many days back the chart reaches.
 *
 * "All" is measured from day zero — the earliest date *any* statement records —
 * rather than from this account's own first one, which no query exposes. The
 * difference costs nothing: samples before this account existed come back over
 * zero rows, are dropped below, and the drawn line starts where the account's
 * history starts. The hand-typed pre-history plays no part, here or in the
 * chart: `manual_networth` is the household's net worth (§7), not an account's.
 */
async function windowDays(range: RangeKey): Promise<number> {
  const fixed = RANGES[range].days;
  if (fixed !== null) return fixed;

  const earliest = await firstRecordedDate();
  if (earliest === null) return RANGES[DEFAULT_RANGE].days;

  // A floor of one month keeps the sampler from collapsing to a single point on
  // an instance whose first upload was this week.
  return Math.max(Math.ceil((Date.now() - Date.parse(earliest)) / DAY_MS), 30);
}

export async function loader({ params, request }: Route.LoaderArgs) {
  // First and alone, because it is the gate. `accountTotal` answers null for an
  // id that names no account, for one that is not an id at all, and for a closed
  // one — and all three are a 404 rather than a page of blanks. A closed account
  // is excluded from `holding_valued` (§8.2), so rendering it would produce a
  // header whose every figure is empty and no explanation of why.
  const total = await accountTotal(params.accountId);
  if (total === null) throw new Response("Not found", { status: 404 });

  const requested = new URL(request.url).searchParams.get("range");
  const range: RangeKey =
    requested && requested in RANGES ? (requested as RangeKey) : DEFAULT_RANGE;

  const dates = sampleDates(await windowDays(range));

  const [account, holdings, series] = await Promise.all([
    // Read for one field: the tax treatment. `AccountTotal` carries what a
    // figure is computed from and no more, and a tax treatment is a fact about
    // the account rather than about its value (§4.5). Safe after the gate above
    // — nothing in this application deletes an account, so the row that just
    // answered is still there to answer again.
    getAccount(params.accountId),
    accountHoldings(params.accountId),
    accountSeries(params.accountId, dates),
  ]);

  // A date before this account's first statement sums to 0.0000 over zero rows.
  // That is "nothing was recorded yet", not "the account was worth nothing" —
  // drawing it would put a fictional climb out of zero at the head of the line
  // (§7), which is why the filter is on the coverage count and not the amount.
  const computed = series
    .filter((point) => point.coverage.total > 0)
    .map((point) => ({ date: point.date, amount: point.amount }));

  return { range, total, taxTreatment: account.taxTreatment, holdings, computed };
}

/**
 * Which tile an account wears.
 *
 * The overview's mapping, repeated rather than shared, so that an account wears
 * the same mark in the list and on its own page; the two belong in `icons.tsx`
 * the day a third screen needs them. Exhaustive over `AccountKind` by
 * construction, so adding a kind to the schema fails the typecheck here rather
 * than rendering a page with no mark on it. The icon never stands alone — the
 * kind is written out in the meta line below it.
 */
const TILES = {
  brokerage: AccountBalanceIcon,
  "401k": AccountBalanceIcon,
  ira: RetirementIcon,
  bank: SavingsIcon,
  liability: LiabilityIcon,
} satisfies Record<AccountKind, typeof AccountBalanceIcon>;

/** The label a stored value is read as, or the value itself if it has none. */
/**
 * A form's option label, minus the explanation after its dash.
 *
 * `TAX_TREATMENTS` spells out what each treatment does to a figure, because on
 * a form that distinction is the entire reason the column is not a boolean
 * (§4.5). A header states what the account *is*, and the sentence explaining the
 * choice belongs where the choice is made. Cutting the tail off the shared label
 * keeps one list: a second, shorter list here is a list free to drift.
 */
function shortLabel(label: string): string {
  const [head = label] = label.split("—");
  return head.trim();
}

/**
 * A share count as text: the stored digits, minus the zeros scale-8 storage pads
 * them with.
 *
 * Not in `format.ts` because nothing there formats a quantity — every function
 * in it renders money, and a quantity takes no currency mark: half a fund is
 * half a share, not fifty cents. Nothing here computes either. The digits are
 * the digits that came out of the view, grouped and trimmed as text, with the
 * same U+2212 minus `format.ts` uses so a negative quantity and a negative
 * figure read alike in the same row.
 */
function formatQuantity(decimal: string): string {
  const trimmed = decimal.trim();
  const negative = trimmed.startsWith("-") || trimmed.startsWith("−");
  const [int = "0", frac = ""] = trimmed.replace(/^[-+−]/, "").split(".");
  const fraction = frac.replace(/0+$/, "");
  const zero = /^0*$/.test(int) && fraction === "";

  return `${negative && !zero ? "−" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${
    fraction ? `.${fraction}` : ""
  }`;
}

type Holding = Route.ComponentProps["loaderData"]["holdings"][number];

/**
 * What the row says about the holding under its name: what it is, and anything
 * qualifying the price beside it.
 *
 * An unpriced holding is in the table and out of the total (§8.2), and a stale
 * price is used rather than discarded (§6.2). Both facts are said in words on
 * the row they apply to, because the coverage note above the table says how many
 * and this says which.
 */
function holdingNote(holding: Holding): string {
  const parts = [labelOf(ASSET_CLASSES, holding.assetClass)];

  if (!holding.isPriced) parts.push("never priced");
  else if (holding.isStale) parts.push("price is stale");

  return parts.join(" · ");
}

export default function Account({ loaderData }: Route.ComponentProps) {
  const { range, total, taxTreatment, holdings, computed } = loaderData;

  const Tile = TILES[total.accountKind];
  const { known, total: counted } = total.coverage;

  // §8.4's rule, applied to one account: a zero and an absence must not look
  // alike. `accountTotal` returns 0.0000 both for an account that holds nothing
  // and for one whose every holding is unpriced, and neither is a valuation —
  // so the figure is withheld and the reason is written out instead. A $0.00 on
  // a finance page is a claim, and this is not the page to make it on.
  const valued = known > 0;

  const last = computed.at(-1);

  return (
    <section className="page">
      {/* Overview, not Settings → Accounts: this page is the drill-down from the
          overview's accounts list, which is what links here. The settings page
          for the same account is the form that edits it, and the header's Edit
          action is the way across. */}
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/">Overview</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{total.accountName}</span>
      </nav>

      <section className="panel">
        <div className="detail-header">
          <div className="detail-identity">
            <div className="account-tile">
              <Tile />
            </div>
            <div>
              <h1 className="detail-title">{total.accountName}</h1>

              {/* The colon lives in the `dt`, which is the mock's typesetting
                  and the reason a pair stays readable when the row wraps. */}
              <dl className="detail-meta">
                <div>
                  <dt>Owner:</dt>
                  <dd>{total.ownerName}</dd>
                </div>
                <div>
                  <dt>Institution:</dt>
                  {/* Optional on the form, so a blank is a real state and not a
                      missing read (`accounts.server.ts`). */}
                  <dd>{total.institution || "—"}</dd>
                </div>
                <div>
                  <dt>Kind:</dt>
                  <dd>{labelOf(ACCOUNT_KINDS, total.accountKind)}</dd>
                </div>
                <div>
                  <dt>Tax treatment:</dt>
                  <dd>{shortLabel(labelOf(TAX_TREATMENTS, taxTreatment))}</dd>
                </div>
              </dl>
            </div>
          </div>

          <div className="detail-total">
            <span className="u-label">Total value</span>

            {/* No delta chip beside the figure, though the mock has one. The
                honest version of it is this account now against this account at
                the window's start, and that is a subtraction of two decimal
                strings: `netWorthChange` does exactly that for the household in
                SQL, in `numeric`, and the query layer has no per-account
                equivalent yet. Money arithmetic does not move into a route to
                get a chip (§8.2, §4.1) — the panel below draws the same movement
                as a line, from the same series such a query would sum. */}
            {valued ? (
              <>
                <p className="detail-figure u-data">{formatMoney(total.amount)}</p>
                {known < counted ? (
                  <p className="coverage-note">
                    Based on {known} of {counted} holdings. The rest have never been priced
                    and contribute nothing to this figure, or to the line below it.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="coverage-note">
                {counted === 0
                  ? "Nothing has been recorded for this account yet, so there is nothing to value."
                  : `None of this account's ${counted} holdings has ever been priced, so there is nothing to value yet.`}
              </p>
            )}

            <Link className="button button--quiet" to={`/settings/accounts/${total.accountId}`}>
              <EditIcon />
              Edit details
            </Link>
          </div>
        </div>
      </section>

      <section className="panel">
        <header className="panel-header">
          <h2 className="panel-title">Performance</h2>

          {/* The range is a URL, so the control needs no JavaScript and a chosen
              range survives a reload — the same contract as the overview's, key
              for key, so the two pages behave identically. */}
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

        <div className="panel-body">
          {computed.length >= 2 && last ? (
            <NetWorthChart
              // Its own gradient id: two charts sharing one would both paint
              // from whichever `<defs>` the document holds first.
              id={`account-${total.accountId}`}
              computed={computed}
              // Empty, and not an oversight: the hand-typed prefix is the
              // household's net worth before day zero (§7), and attributing it
              // to one account would be inventing that account's history.
              manual={[]}
              label={`${total.accountName} over the last ${RANGES[range].label}, ending at ${formatMoney(
                last.amount,
              )}.`}
            />
          ) : (
            <p className="empty-note">
              A line needs two dated points and this range holds {computed.length}. It appears
              over a wider range, or once a second statement covering this account has been
              uploaded.
            </p>
          )}
        </div>
      </section>

      {holdings.length === 0 ? (
        <EmptyState>
          The positions this account holds are listed here, with what each is worth. Nothing has
          been recorded for this account yet — upload a statement for it and they appear.
        </EmptyState>
      ) : (
        <section className="panel">
          <header className="panel-header">
            <h2 className="panel-title">
              <HoldingsIcon />
              Holdings
            </h2>
            <span className="panel-count">
              {holdings.length} {holdings.length === 1 ? "holding" : "holdings"}
            </span>
          </header>

          {/* Four columns, not the mock's five. Its "Today's Change" needs each
              instrument's previous close, and the row shape the query layer
              returns carries no such thing: `quote` is the intraday tier and is
              overwritten in place (§6.2), and `holding_valued` exposes today's
              price and nothing to compare it against. Producing it would mean a
              hand-rolled query beside the shared one (§8.2's named weak point)
              or subtracting decimal strings in a route, and a column of dashes
              would be no better. §13.7: a figure the schema cannot produce is
              left out, not invented. */}
          <div className="data-table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Asset</th>
                  <th scope="col" className="is-numeric">
                    Quantity
                  </th>
                  <th scope="col" className="is-numeric">
                    Price
                  </th>
                  <th scope="col" className="is-numeric">
                    Value
                  </th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((holding) => (
                  // Unique by construction: a position set holds one row per
                  // instrument (`holding_one_row_per_instrument`).
                  <tr key={holding.instrumentId}>
                    <td>
                      <div className="cell-stack">
                        {/* No badge for an instrument with no public ticker — a
                            401k trust or a hand-entered fund. A placeholder in a
                            ticker-shaped chip reads as a ticker. */}
                        {holding.symbol ? <span className="badge">{holding.symbol}</span> : null}
                        <div>
                          {holding.instrumentName}
                          <span className="cell-sub">{holdingNote(holding)}</span>
                        </div>
                      </div>
                    </td>
                    <td className="is-numeric">{formatQuantity(holding.quantity)}</td>
                    {/* Null price and null value are the same holding: never
                        quoted. A dash says so; a zero would understate the
                        account by the whole position and look deliberate. */}
                    <td className="is-numeric">
                      {holding.price === null ? "—" : formatMoney(holding.price)}
                    </td>
                    <td className="is-numeric">
                      {holding.value === null ? "—" : formatMoney(holding.value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </section>
  );
}
