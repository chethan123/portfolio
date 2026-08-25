import { Link } from "react-router";

import { Breakdown, plural } from "~/components/breakdown";
import { Delta, Money } from "~/components/money-cell";
import { EmptyState } from "~/components/empty-state";
import {
  allocationByAccountKind,
  allocationByAssetClass,
  allocationByPerson,
  formatRate,
  unrealizedByAssetType,
  type GainRow,
  type GainGroups,
} from "~/lib/allocation";
import { formatMoney, isNegative } from "~/lib/format";
import { readCapitalGainsRate } from "~/lib/settings.server";
import { currentHoldings, netWorth } from "~/lib/valuation.server";

import type { Route } from "./+types/analysis";

/**
 * Analysis — the portfolio cut three ways, each as a ring beside its table.
 *
 * The layout is the Stitch "Views Analysis" screen (DESIGN.md §13): a panel per
 * breakdown, the donut on the left, the same rows as a table on the right. The
 * table is the screen; the ring is a picture of the table, which is why it is
 * the table that carries every figure and the ring that carries none.
 *
 * The panel itself is `components/breakdown.tsx` rather than something this
 * route owns. §13.3's rule — the same rank is the same colour in every panel —
 * holds across screens only for as long as there is one implementation of it,
 * and this route was where the second copy would have been made from.
 *
 * All three breakdowns are grouped from **one** read of `holding_valued`.
 * `allocation.ts` explains why that matters — three `GROUP BY` queries would be
 * three more hand-rolled dashboard queries, which §8.2 names as the weakest
 * point in the design — and it is also what stops this page from disagreeing
 * with the Overview about the same portfolio.
 *
 * The empty case comes first and renders no ring, no zero and no chart frame
 * (§8.4): a net worth of zero and an instance nothing has been uploaded to are
 * indistinguishable on screen, and only one of them is worth panicking about.
 */

export function meta() {
  return [{ title: "Analysis · Portfolio" }];
}

/**
 * Unrealized gains by asset type, and what settling them would cost.
 *
 * A table with no ring beside it, unlike the three `Breakdown` panels above it.
 * A gain is signed, and a signed figure is not a share of anything — the same
 * reason `allocation.ts` gives for leaving a liability out of the donut — so a
 * chart here would either drop the losses or draw them as if they were gains.
 *
 * **Three columns, not four.** The taxable base belongs on the row, because it
 * is what makes the tax beside it checkable; it does not belong in a fourth
 * column, because three money columns on a 390px screen is the horizontal
 * scroll §8.1 says nobody uses. `.cell-sub` already exists for exactly this.
 */
function GainsPanel({ rate, gains }: { rate: string; gains: GainGroups }) {
  const { rows, total } = gains;
  if (total === null) return null;

  const partial = total.coverage.known < total.coverage.total;
  // The netting caveat is about a loss in one row going untouched against a
  // gain in another, so it is said only where there is a loss to net — above a
  // table of gains it explains a subtraction nobody could have expected, and
  // above a table taxed at 0% it would be a warning about nothing.
  const netted =
    rows.some((row) => row.tax !== null) &&
    rows.some((row) => row.taxable !== null && isNegative(row.taxable));

  return (
    <section className="panel">
      <header className="panel-header">
        <h2 className="panel-title">Unrealized gains</h2>
        <p className="panel-count">
          Taxed at {formatRate(rate)} · <Link to="/settings/tax">change rate</Link>
        </p>
      </header>

      <div className="data-table-scroll">
        <table className="data-table data-table--gains">
          <thead>
            <tr>
              <th scope="col">Asset type</th>
              <th scope="col" className="is-numeric">
                Unrealized
              </th>
              <th scope="col" className="is-numeric">
                Potential tax
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <GainsRow key={row.key} row={row} />
            ))}
          </tbody>
          <tfoot>
            <GainsRow row={total} isTotal />
          </tfoot>
        </table>
      </div>

      <div className="panel-body">
        <p className="coverage-note">
          {/* Said once, on the panel, rather than as a dash in a fourth column
              on every row: the rule is about the table, not about a cell. */}
          Only a taxable account can owe capital gains tax, so a gain inside an
          IRA or a 401k is under Unrealized and not under Potential tax.
          {netted
            ? " A loss in one asset type is not netted against a gain in another here, which a" +
              " real return would do — so the tax column is an upper bound."
            : null}
          {partial
            ? ` Based on ${total.coverage.known} of ${total.coverage.total} holdings: the rest` +
              " have no cost basis or no price recorded, and a gain needs both."
            : null}
        </p>
      </div>
    </section>
  );
}

/**
 * One row of the gains table, and the total, which is the same row with a
 * heavier rule above it.
 *
 * Written once for both because the total differs only in where it sits: a
 * second copy is how the total would come to render a null differently from the
 * rows it is a total of.
 */
function GainsRow({ row, isTotal = false }: { row: GainRow; isTotal?: boolean }) {
  // The label is a `td` on an ordinary row and a `th` on the total, which is
  // what the Holdings table's `tfoot` does (`holdings.tsx`) — the breakdown
  // tables above have no total row to have taken it from. `.data-table th` sets
  // a cell in uppercase because it is styling a column heading, and only
  // `.row-total th` undoes that, so an asset type set in caps would read as a
  // heading for the rows beneath it, of which there are none.
  const Label = isTotal ? "th" : "td";

  return (
    <tr className={isTotal ? "row-total" : undefined}>
      <Label scope={isTotal ? "row" : undefined}>
        {row.label}
        {/* The base the tax was taken on. Beside the label rather than in a
            column of its own, and only where it says something the tax cell
            does not already imply.

            Never on the total, where it would invite a check that fails: the
            total's base is netted across the rows and the total's tax is the
            sum of the un-netted row taxes, so a reader dividing one by the
            other gets a rate nobody set. The netting is explained in words
            under the table instead, which is where a rule belongs. */}
        {!isTotal && row.taxable !== null && row.taxable !== row.unrealized ? (
          <span className="cell-sub">{formatMoney(row.taxable)} of it in taxable accounts</span>
        ) : null}
      </Label>
      <td className="is-numeric">
        {row.unrealized === null ? "—" : <Delta amount={row.unrealized} />}
      </td>
      <td className="is-numeric">
        <Money amount={row.tax} />
      </td>
    </tr>
  );
}

export async function loader() {
  // One read, three groupings of the array it returned. The total comes from
  // the query module rather than from adding those groups up here: money is
  // summed in SQL, in `numeric` (§8.2), and this is the same figure the
  // Overview headline shows because it is the same query.
  const [holdings, total, capitalGainsRate] = await Promise.all([
    currentHoldings(),
    netWorth(),
    readCapitalGainsRate(),
  ]);

  return {
    total: total.amount,
    capitalGainsRate,
    gains: unrealizedByAssetType(holdings, capitalGainsRate),
    // Counted off the rows already in hand rather than asked for separately —
    // two counts of one thing are two things that can disagree.
    holdingCount: holdings.length,
    pricedCount: holdings.filter((holding) => holding.isPriced).length,
    byPerson: allocationByPerson(holdings),
    byAccountKind: allocationByAccountKind(holdings),
    byAssetClass: allocationByAssetClass(holdings),
  };
}

export default function Analysis({ loaderData }: Route.ComponentProps) {
  const {
    total,
    capitalGainsRate,
    gains,
    holdingCount,
    pricedCount,
    byPerson,
    byAccountKind,
    byAssetClass,
  } = loaderData;

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Analysis</h1>
          <p className="page-subtitle">Portfolio breakdown and allocation views.</p>
        </div>
      </header>

      {holdingCount === 0 ? (
        // One check for all three panels: every holding has an owner, an
        // account kind and an asset class, so either all three breakdowns have
        // rows or none of them do.
        <EmptyState>
          The portfolio broken down by person, by account type and by asset class — and what it
          has gained but not yet sold — appears here once a statement has been uploaded. Nothing
          has been uploaded to this instance yet.
        </EmptyState>
      ) : (
        <>
          {pricedCount < holdingCount ? (
            <p className="coverage-note">
              Based on {pricedCount} of {holdingCount} holdings. The rest have never been priced
              and contribute nothing to any figure on this page.
            </p>
          ) : null}

          <Breakdown
            title="Net worth by person"
            count={plural(byPerson.length, "person", "people")}
            heading="Person"
            amountHeading="Value"
            slices={byPerson}
            total={total}
            reading="owned"
          />

          <Breakdown
            title="Value by account type"
            count={plural(byAccountKind.length, "account type", "account types")}
            heading="Account type"
            amountHeading="Value"
            slices={byAccountKind}
            total={total}
            reading="owned"
          />

          <Breakdown
            title="Value by asset class"
            count={plural(byAssetClass.length, "asset class", "asset classes")}
            heading="Asset class"
            amountHeading="Value"
            slices={byAssetClass}
            total={total}
            reading="owned"
          />

          <GainsPanel rate={capitalGainsRate} gains={gains} />
        </>
      )}
    </section>
  );
}
