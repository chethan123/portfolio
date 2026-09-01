import { Link } from "react-router";

import { Amount, Delta } from "~/components/amount";
import { Breakdown, plural } from "~/components/breakdown";
import { EmptyState } from "~/components/empty-state";
import {
  NarrowedTo,
  NarrowedToNothing,
  OwnerFilterControl,
} from "~/components/owner-filter-control";
import {
  allocationBy,
  formatRate,
  unrealizedByAssetType,
  type GainRow,
  type GainGroups,
} from "~/lib/allocation";
import { isNegative } from "~/lib/format";
import { groupingBy } from "~/lib/holdings-view";
import { ALL_OWNERS, isFiltered } from "~/lib/owner-filter";
import { isNarrowedToNothing, ownerReading } from "~/lib/owner-reading.server";
import { readCapitalGainsRate } from "~/lib/settings.server";
import { currentHoldings, netWorth } from "~/lib/valuation.server";

import { PriceFreshness } from "../components/price-freshness.tsx";
import { asOfView } from "../lib/prices.server.ts";
import { getConfig } from "../../server/config.ts";

import type { Route } from "./+types/analysis";

/**
 * Analysis — the portfolio cut four ways, each a ring beside its table
 * (Stitch "Views Analysis", DESIGN.md §13): the table is the screen, the
 * ring a picture of it, so the table carries every figure and the ring
 * none. The panel is `components/breakdown.tsx`, not this route's own:
 * §13.3's same-rank-same-colour rule holds across screens only while there
 * is one implementation. All four breakdowns group **one** read of
 * `holding_valued` (`allocation.ts` has why): three `GROUP BY` queries
 * would be three more hand-rolled dashboard queries — §8.2's weakest point
 * — and one read is what stops this page disagreeing with the Overview.
 * The empty case renders no ring, no zero and no chart frame (§8.4): a net
 * worth of zero and a never-uploaded instance must not look the same.
 */

export function meta() {
  return [{ title: "Analysis · Portfolio" }];
}

/**
 * Unrealized gains by asset type, and what settling them would cost. No
 * ring: a gain is signed, and a signed figure is not a share of anything
 * (`allocation.ts`'s liability argument) — a chart would drop the losses or
 * draw them as gains. **Three columns, not four**: the taxable base belongs
 * on the row, where it makes the tax beside it checkable, not in a fourth
 * money column — the horizontal scroll §8.1 says nobody uses; `.cell-sub`
 * exists for exactly this.
 */
function GainsPanel({ rate, gains }: { rate: string; gains: GainGroups }) {
  const { rows, total } = gains;
  if (total === null) return null;

  const partial = total.coverage.known < total.coverage.total;
  // The netting caveat is about a loss in one row going untouched against a
  // gain in another, so it is said only where there is a loss to net — over
  // a table taxed at 0% it would be a warning about nothing.
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
 * One row of the gains table — the total too, which differs only in where
 * it sits: a second copy is how the total would come to render a null
 * differently from the rows it totals.
 */
function GainsRow({ row, isTotal = false }: { row: GainRow; isTotal?: boolean }) {
  // A `td` on an ordinary row, a `th` on the total (the Holdings `tfoot`
  // pattern). `.data-table th` uppercases — it styles column headings — and
  // only `.row-total th` undoes it, so an asset type in caps would read as a
  // heading for rows beneath it, of which there are none.
  const Label = isTotal ? "th" : "td";

  return (
    <tr className={isTotal ? "row-total" : undefined}>
      <Label scope={isTotal ? "row" : undefined}>
        {row.label}
        {/* The base the tax was taken on — beside the label, only where it
            says something the tax cell does not imply. Never on the total,
            where it would invite a check that fails: the total's base is
            netted across rows while its tax sums the un-netted row taxes,
            so dividing one by the other gives a rate nobody set. The
            netting is explained in words under the table. */}
        {!isTotal && row.taxable !== null && row.taxable !== row.unrealized ? (
          <span className="cell-sub">
            <Amount value={row.taxable} /> of it in taxable accounts
          </span>
        ) : null}
      </Label>
      <td className="is-numeric">
        {row.unrealized === null ? "—" : <Delta amount={row.unrealized} />}
      </td>
      <td className="is-numeric">
        <Amount value={row.tax} />
      </td>
    </tr>
  );
}

export async function loader({ request }: Route.LoaderArgs) {
  const { reading, owner } = await ownerReading(request);
  const { owners } = owner;

  // One read, four groupings of the array it returned. The total comes from
  // the query module, not from adding those groups here: money sums in SQL
  // (§8.2), and it is the same figure as the Overview headline because it is
  // the same query — one arithmetic over one read, filtered or not.
  const [holdings, total, capitalGainsRate, freshness, everyone] = await Promise.all([
    currentHoldings(reading),
    netWorth(reading),
    readCapitalGainsRate(),
    asOfView(getConfig().MARKET_TIMEZONE),
    // Whether the *instance* holds anything — a different question from
    // whether these owners do, and only the first may be answered "nothing
    // has been uploaded". A count, and only while narrowed.
    isFiltered(owners) ? netWorth(ALL_OWNERS) : null,
  ]);

  const instance = everyone === null ? holdings.length : everyone.coverage.total;

  return {
    freshness,
    ...owner,
    total: total.amount,
    capitalGainsRate,
    gains: unrealizedByAssetType(holdings, capitalGainsRate),
    // Counted off the rows already in hand — two counts of one thing are two
    // things that can disagree. Narrowed, so the coverage note matches.
    holdingCount: holdings.length,
    /** Whether anything at all has been uploaded, narrowed or not. */
    hasHoldings: instance > 0,
    narrowedToNothing: isNarrowedToNothing(owners, { held: holdings.length, instance }),
    pricedCount: holdings.filter((holding) => holding.isPriced).length,
    // Every cut reads `holdings-view.ts`'s one dimension registry, so a
    // panel here and the Holdings table grouped the same way cannot label a
    // bucket differently (`tests/invariants/aggregates-agree.test.ts`).
    byPerson: allocationBy(holdings, groupingBy("owner")),
    byAccountKind: allocationBy(holdings, groupingBy("kind")),
    byAssetClass: allocationBy(holdings, groupingBy("assetClass")),
    byClassification: allocationBy(holdings, groupingBy("classification")),
  };
}

export default function Analysis({ loaderData }: Route.ComponentProps) {
  const {
    owners,
    roster,
    narrowedTo,
    unknownOwner,
    showEveryone,
    narrowedToNothing,
    total,
    capitalGainsRate,
    gains,
    holdingCount,
    pricedCount,
    byPerson,
    byAccountKind,
    byAssetClass,
    byClassification,
    freshness,
  } = loaderData;

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Analysis</h1>
          <p className="page-subtitle">Portfolio breakdown and allocation views.</p>
        </div>
        <div className="page-actions">
          <OwnerFilterControl owners={roster} selected={owners} hidden={{}} />
          <PriceFreshness freshness={freshness} />
        </div>

      </header>

      {narrowedToNothing ? (
        // Below the header, so the control stays on screen and the filter can
        // be cleared from the page it emptied.
        <NarrowedToNothing
          owners={narrowedTo}
          unknownOwner={unknownOwner}
          showEveryone={showEveryone}
        />
      ) : holdingCount === 0 ? (
        // One check for all four panels: every holding has an owner, an
        // account kind, an asset class and a classification, so either all
        // four breakdowns have rows or none of them do.
        <EmptyState>
          The portfolio broken down by owner, by account type, by asset class and by
          classification — and what it has gained but not yet sold — appears here once a
          statement has been uploaded. Nothing has been uploaded to this instance yet.
        </EmptyState>
      ) : (
        <>
          <NarrowedTo owners={narrowedTo} />

          {pricedCount < holdingCount ? (
            <p className="coverage-note">
              Based on {pricedCount} of {holdingCount} holdings. The rest have never been priced
              and contribute nothing to any figure on this page.
            </p>
          ) : null}

          {/* "by owner", not "by person": an owner is the role, a person the
              record (CONTEXT.md) — the one place the pre-glossary wording
              survived in the UI. */}
          <Breakdown
            title="Net worth by owner"
            count={plural(byPerson.length, "owner", "owners")}
            heading="Owner"
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

          <Breakdown
            title="Value by classification"
            count={plural(byClassification.length, "classification", "classifications")}
            heading="Classification"
            amountHeading="Value"
            slices={byClassification}
            total={total}
            reading="owned"
          />

          <GainsPanel rate={capitalGainsRate} gains={gains} />
        </>
      )}
    </section>
  );
}
