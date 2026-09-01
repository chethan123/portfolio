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
 * Income — what the portfolio pays over the coming year, and how much of it
 * is taxed this year (DESIGN.md §8.1): a headline, then the same figure cut
 * by tax treatment ("how much is taxed") and by account ("which statement
 * does it land in").
 *
 * **One read.** Every figure comes off the array `currentHoldings` returned
 * — the array Holdings reads — so the headline, the breakdowns and the
 * Holdings table are structurally unable to disagree (§8.2 names
 * hand-rolled dashboard queries drifting apart as the design's weakest
 * point). The headline is summed **in JavaScript** by `summarise`, the
 * Holdings total row's own helper, where Analysis sums in SQL via
 * `netWorth`: a deliberate departure — `money.ts` sums exactly in `BigInt`,
 * and a separate dividend total query would be the fourth query.
 *
 * **Amount and share, no yield column**: a group's dividend over its value
 * is the *weighted* yield, and §8.1 puts it at the top once — the same
 * ratio in two typefaces on one page is two numbers for one thing.
 *
 * **Three slices, never a taxable/sheltered boolean** (§4.5): taxable is
 * taxed this year, Traditional is ordinary income later, Roth never.
 * "Sheltered" merges a dated liability with the absence of one, so it is a
 * subtotal in words beneath the table and never a slice of the ring.
 *
 * The empty case renders no ring, no zero and no chart frame (§8.4): a
 * portfolio genuinely paying nothing and a never-uploaded instance must not
 * look the same.
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
    // An empty instance and an empty reading are two different sentences
    // (`analysis.tsx`); only the first may say nothing has been uploaded.
    // A count, and only while narrowed.
    isFiltered(owners) ? netWorth(ALL_OWNERS) : null,
  ]);

  const instance = everyone === null ? holdings.length : everyone.coverage.total;

  return {
    freshness,
    ...owner,
    // Counted off the rows already in hand rather than asked for separately —
    // two counts of one thing are two things that can disagree.
    holdingCount: holdings.length,
    /** Whether anything at all has been uploaded, narrowed or not. */
    hasHoldings: instance > 0,
    narrowedToNothing: isNarrowedToNothing(owners, { held: holdings.length, instance }),
    // `summarise`, not a `sumMoney` of its own: the Holdings total row's
    // helper, so this headline and that table's foot are the same arithmetic
    // — and the zero rule ($0, never a dash) is already honoured there.
    total: summarise(holdings).annualDividend,
    // Recomputed over whatever the filter left: a weighted yield is a ratio
    // of the group in view (CONTEXT.md), and one owner's dividend over the
    // household's value would be a figure of nothing.
    weightedYield: weightedYield(holdings),
    sheltered: shelteredSubtotal(holdings),
    // Dimension accessors from `holdings-view.ts`, so the labels here are
    // the labels Holdings shows — one table, not a second copy of it.
    byTaxTreatment: annualDividendBy(holdings, groupingBy("tax")),
    byAccount: annualDividendBy(holdings, groupingBy("account")),
  };
}

/**
 * The binary question the ring refuses to draw, in two amounts — **never a
 * fraction**: "$9,800 of $14,200 is sheltered" fails on real data, where a
 * car loan's rate sums the taxable slice to −$522.20 (a liability still has
 * a tax treatment), and "$0 of −$522 is sheltered" is arithmetic nobody
 * should be shown. Stated separately, neither divided by the other — also
 * why the sentence stays true when the two do not add to the ring's total.
 * The negative case gets its own clause: money going out is not "what is
 * taxed this year".
 */
function ShelteredLine({ sheltered, taxable }: ShelteredSubtotal) {
  // The amounts are elements, not interpolations: a template string cannot
  // hold a component, and formatting an amount in a route is the leak spec
  // 0007 exists to close.
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
  // The payload keeps the name CONTEXT.md gives the figure; the local is
  // renamed only so it does not shadow the function that computed it.
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
        // Below the header, so the control stays on screen and the filter can
        // be cleared from the page it emptied.
        <NarrowedToNothing
          owners={narrowedTo}
          unknownOwner={unknownOwner}
          showEveryone={showEveryone}
        />
      ) : holdingCount === 0 ? (
        // One check for both panels: every holding has an account and a tax
        // treatment, so either both breakdowns have rows or neither does.
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
                {/* The weighted yield beside the figure it is the ratio of.
                    Absent, not `0.0%`, where no positive value divides it:
                    the zero rule applies to the dividend, not the value. */}
                {weighted === null ? null : (
                  <span className="kpi-aside">{formatShare(weighted)} weighted yield</span>
                )}
              </p>

              <NarrowedTo owners={narrowedTo} />

              {/* Said on the page, not only in the guide: a household reading
                  this number should not have to know which holdings are
                  missing from it (§14, limitation 9). */}
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
