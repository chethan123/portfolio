import { Amount } from "~/components/amount";
import { Breakdown, plural } from "~/components/breakdown";
import { EmptyState } from "~/components/empty-state";
import {
  NarrowedTo,
  NarrowedToNothing,
  OwnerFilterControl,
} from "~/components/owner-filter-control";
import {
  annualDividendBy,
  formatShare,
  shelteredSubtotal,
  weightedYield,
} from "~/lib/allocation";
import { isNegative } from "~/lib/format";
import { groupingBy, summarise } from "~/lib/holdings-view";
import { ALL_OWNERS, isFiltered } from "~/lib/owner-filter";
import { isNarrowedToNothing, ownerReading } from "~/lib/owner-reading.server";
import { currentHoldings, netWorth } from "~/lib/valuation.server";

import type { ShelteredSubtotal } from "~/lib/allocation";
import { PriceFreshness } from "../components/price-freshness.tsx";
import { asOfView } from "../lib/prices.server.ts";
import { getConfig } from "../../server/config.ts";

import type { Route } from "./+types/income";

/**
 * What the portfolio pays over the coming year, and how much is taxed now
 * (DESIGN.md §8.1). One read (`currentHoldings`) — same array Holdings
 * reads, so headline/breakdowns/table can't disagree (§8.2). Headline
 * summed in JS via `summarise` (Holdings' own helper), not SQL like
 * Analysis. No yield column — that ratio lives once, at the top. Three
 * slices, never a taxable/sheltered boolean (§4.5) — "sheltered" is a
 * subtotal in words, not a ring slice. Empty case renders no ring/zero (§8.4).
 */

export function meta() {
  return [{ title: "Income · Portfolio" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { reading, owner } = await ownerReading(request);
  const { owners } = owner;

  const [holdings, freshness, everyone] = await Promise.all([
    currentHoldings(reading),
    asOfView(getConfig().MARKET_TIMEZONE),
    // Empty instance vs. empty reading are different sentences (`analysis.tsx`) — count only while narrowed.
    isFiltered(owners) ? netWorth(ALL_OWNERS) : null,
  ]);

  const instance = everyone === null ? holdings.length : everyone.coverage.total;

  return {
    freshness,
    ...owner,
    // Counted off the rows already in hand, not separately — two counts of one thing can disagree.
    holdingCount: holdings.length,
    narrowedToNothing: isNarrowedToNothing(owners, { held: holdings.length, instance }),
    // Holdings' own `summarise` helper, not a separate sum — same arithmetic, same zero rule.
    total: summarise(holdings).annualDividend,
    // Recomputed over whatever the filter left — a group's own ratio, not the household's.
    weightedYield: weightedYield(holdings),
    sheltered: shelteredSubtotal(holdings),
    // Dimension accessors from `holdings-view.ts`, so labels here match Holdings.
    byTaxTreatment: annualDividendBy(holdings, groupingBy("tax")),
    byAccount: annualDividendBy(holdings, groupingBy("account")),
  };
}

/**
 * Two amounts, never a fraction — a car loan can sum the taxable slice
 * negative, and "$0 of −$522 is sheltered" is arithmetic nobody should see.
 * Stated separately, so it stays true even when they don't add to the total.
 */
function ShelteredLine({ sheltered, taxable }: ShelteredSubtotal) {
  return (
    <p className="panel-statement">
      Sheltered — tax-deferred and tax-free together — comes to <Amount value={sheltered} /> a
      year. Taxable accounts come to <Amount value={taxable} />
      {isNegative(taxable)
        ? ", a figure going out rather than coming in: interest on a liability there outweighs" +
          " what the holdings beside it pay."
        : ", which is the part taxed this year."}
    </p>
  );
}

export default function Income({ loaderData }: Route.ComponentProps) {
  // Renamed locally to avoid shadowing the `weightedYield` function.
  const {
    owners,
    roster,
    narrowedTo,
    unknownOwner,
    showEveryone,
    narrowedToNothing,
    holdingCount,
    total,
    weightedYield: weighted,
    sheltered,
    byTaxTreatment,
    byAccount,
    freshness,
  } = loaderData;

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Income</h1>
          <p className="page-subtitle">
            What the portfolio pays over the coming year, and how much of it is taxed.
          </p>
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
        // One check for both panels: every holding has an account and a tax treatment.
        <EmptyState>
          What the portfolio is projected to pay over the coming year — split by tax treatment
          and by account — appears here once a statement has been uploaded. Nothing has been
          uploaded to this instance yet.
        </EmptyState>
      ) : (
        <>
          <section className="kpi">
            <div>
              <p className="kpi-eyebrow u-label">Total annual dividend</p>
              <p className="kpi-figure u-data">
                <Amount value={total} />
                {/* Absent, not `0.0%`, when no positive value divides it. */}
                {weighted === null ? null : (
                  <span className="kpi-aside">{formatShare(weighted)} weighted yield</span>
                )}
              </p>

              <NarrowedTo owners={narrowedTo} />

              {/* Said on the page, not only the guide (§14 limitation 9). */}
              <p className="coverage-note">
                The total is a lower bound. A holding with no dividend rate on file counts as
                paying nothing, so this leaves out every unquoted holding, all interest on cash,
                and any interest on a loan.
                {weighted === null
                  ? " There is no weighted yield beside it either: nothing here has a positive" +
                    " value for the total to be a fraction of."
                  : null}
              </p>
            </div>
          </section>

          <Breakdown
            title="Annual dividend by tax treatment"
            count={plural(byTaxTreatment.length, "tax treatment", "tax treatments")}
            heading="Tax treatment"
            amountHeading="Annual dividend"
            slices={byTaxTreatment}
            total={total}
            reading="paid"
          >
            <ShelteredLine {...sheltered} />
          </Breakdown>

          <Breakdown
            title="Annual dividend by account"
            count={plural(byAccount.length, "account", "accounts")}
            heading="Account"
            amountHeading="Annual dividend"
            slices={byAccount}
            total={total}
            reading="paid"
          />
        </>
      )}
    </section>
  );
}
