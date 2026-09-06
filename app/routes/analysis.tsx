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
 * The portfolio cut four ways, each a ring beside its table (DESIGN.md
 * §13). All four group one read of `holding_valued` (`allocation.ts`), not
 * separate `GROUP BY` queries — keeps this page from disagreeing with
 * Overview. Empty case renders no ring/zero/frame (§8.4).
 */

export function meta() {
  return [{ title: "Analysis · Portfolio" }];
}

/**
 * Unrealized gains by asset type. No ring — a signed figure isn't a share
 * of anything (`allocation.ts`). Three columns, not four: taxable base
 * rides `.cell-sub` on the row rather than a fourth money column.
 */
function GainsPanel({ rate, gains }: { rate: string; gains: GainGroups }) {
  const { rows, total } = gains;
  if (total === null) return null;

  const partial = total.coverage.known < total.coverage.total;
  // Netting caveat only where there's a loss to net — a 0%-taxed table has nothing to warn about.
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

// Renders the total row too — a second copy risks rendering a null differently than the rows it totals.
function GainsRow({ row, isTotal = false }: { row: GainRow; isTotal?: boolean }) {
  // `th` on the total (Holdings `tfoot` pattern) — `.row-total th` undoes the uppercase `.data-table th` styles headings with.
  const Label = isTotal ? "th" : "td";

  return (
    <tr className={isTotal ? "row-total" : undefined}>
      <Label scope={isTotal ? "row" : undefined}>
        {row.label}
        {/* Never on the total: its base is netted but its tax sums un-netted row taxes, so the ratio isn't a real rate. */}
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

  // One read, four groupings. Total comes from the query module (§8.2), not summed here — same query as Overview's headline.
  const [holdings, total, capitalGainsRate, freshness, everyone] = await Promise.all([
    currentHoldings(reading),
    netWorth(reading),
    readCapitalGainsRate(),
    asOfView(getConfig().MARKET_TIMEZONE),
    // Whether the instance holds anything vs. these owners — only while narrowed.
    isFiltered(owners) ? netWorth(ALL_OWNERS) : null,
  ]);

  const instance = everyone === null ? holdings.length : everyone.coverage.total;

  return {
    freshness,
    ...owner,
    total: total.amount,
    capitalGainsRate,
    gains: unrealizedByAssetType(holdings, capitalGainsRate),
    // Counted off the rows already in hand, not separately — two counts of one thing can disagree.
    holdingCount: holdings.length,
    narrowedToNothing: isNarrowedToNothing(owners, { held: holdings.length, instance }),
    pricedCount: holdings.filter((holding) => holding.isPriced).length,
    // Reads `holdings-view.ts`'s one dimension registry, so this can't label a bucket differently than Holdings does.
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
        <NarrowedToNothing
          owners={narrowedTo}
          unknownOwner={unknownOwner}
          showEveryone={showEveryone}
        />
      ) : holdingCount === 0 ? (
        // One check for all four panels: every holding has all four dimensions, or none of them do.
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

          {/* "by owner", not "by person" — owner is the role, person the record (CONTEXT.md). */}
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
