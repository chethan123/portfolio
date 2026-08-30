import { Amount } from "~/components/amount";
import { Breakdown, plural } from "~/components/breakdown";
import { EmptyState } from "~/components/empty-state";
import {
  annualDividendBy,
  formatShare,
  shelteredSubtotal,
  weightedYield,
} from "~/lib/allocation";
import { isNegative } from "~/lib/format";
import { groupingBy, summarise } from "~/lib/holdings-view";
import { currentHoldings } from "~/lib/valuation.server";

import type { ShelteredSubtotal } from "~/lib/allocation";
import { PriceFreshness } from "../components/price-freshness.tsx";
import { asOfView } from "../lib/prices.server.ts";
import { getConfig } from "../../server/config.ts";

import type { Route } from "./+types/income";
import { ALL_OWNERS } from "~/lib/owner-filter.ts";

/**
 * Income — what the portfolio pays over the coming year, and how much of it is
 * taxed this year (DESIGN.md §8.1).
 *
 * A headline, then the same figure cut two ways: by tax treatment, then by
 * account. The first answers "how much of this is taxed"; the second answers
 * "which statement does it land in".
 *
 * **One read.** Every figure on the page comes off the array `currentHoldings(ALL_OWNERS)`
 * returned, which is the array Holdings reads. That is what makes the headline,
 * the two breakdowns and the Holdings table structurally unable to disagree
 * about the same portfolio — §8.2 names hand-rolled dashboard queries drifting
 * apart as the weakest point in the whole design, and the way not to add a
 * fourth one is not to add a fourth one.
 *
 * The headline is therefore summed **in JavaScript**, by `summarise` — the same
 * helper that computes the Holdings table's own total row — where the Analysis
 * headline calls `netWorth(ALL_OWNERS)` and sums in SQL. A deliberate departure: `money.ts`
 * sums exactly, in `BigInt` counts of ten-thousandths, and there is no separate
 * dividend total query to be had without adding the fourth query.
 *
 * **The tables carry amount and share, and no yield column.** A group's dividend
 * over that group's value is the *weighted* yield, and §8.1 puts it at the top
 * as one figure rather than in every row: the same ratio printed in two
 * typefaces on one page is two numbers for one thing.
 *
 * **Three slices, never a taxable/sheltered boolean** (§4.5, CONTEXT.md). A
 * dividend in a taxable account is taxed this year; in a Traditional account it
 * is untaxed now and the whole withdrawal is ordinary income later; in a Roth it
 * is never taxed. "Sheltered" merges a dated liability with the absence of one,
 * so it is a subtotal stated in words beneath the table and never a slice of the
 * ring. A binary panel would also have forked the vocabulary, since Holdings
 * already groups and filters three ways.
 *
 * The empty case comes first and renders no ring, no zero and no chart frame
 * (§8.4): a portfolio that genuinely pays nothing and an instance nothing has
 * been uploaded to must not look the same.
 */

export function meta() {
  return [{ title: "Income · Portfolio" }];
}

export async function loader() {
  const [holdings, freshness] = await Promise.all([
    currentHoldings(ALL_OWNERS),
    asOfView(getConfig().MARKET_TIMEZONE),
  ]);

  return {
    freshness,
    // Counted off the rows already in hand rather than asked for separately —
    // two counts of one thing are two things that can disagree.
    holdingCount: holdings.length,
    // `summarise` rather than a `sumMoney` of its own: it is the helper the
    // Holdings total row goes through, so this headline and the foot of that
    // table are the same arithmetic rather than two that agree today. It is
    // also where the zero rule is already honoured — a group where nothing pays
    // is `$0` and never a dash.
    total: summarise(holdings).annualDividend,
    weightedYield: weightedYield(holdings),
    sheltered: shelteredSubtotal(holdings),
    // The dimension accessors come from `holdings-view.ts` so that the labels
    // here are the labels Holdings shows — Taxable, Tax-deferred, Tax-free —
    // from one table rather than a second copy of it. See `groupingBy`.
    byTaxTreatment: annualDividendBy(holdings, groupingBy("tax")),
    byAccount: annualDividendBy(holdings, groupingBy("account")),
  };
}

/**
 * The binary question the ring above it refuses to draw, in two amounts.
 *
 * **Never as a fraction.** "$9,800 of $14,200 is sheltered" is the sentence
 * everyone writes first, and it fails on real data: a taxable brokerage beside a
 * car loan whose note carries a rate sums the taxable slice to −$522.20, because
 * a liability account still has a tax treatment. "$0 of −$522 is sheltered" is
 * arithmetic nobody should be shown. So the two figures are stated separately
 * and neither is divided by the other — which also means the sentence stays true
 * when the two do not add up to the total in the centre of the ring.
 *
 * The negative case gets its own second clause rather than the same one with a
 * minus in it: money going out is not "what is taxed this year", and saying so
 * over a negative figure would be the kind of thing that reads as correct
 * because nobody reads it.
 */
function ShelteredLine({ sheltered, taxable }: ShelteredSubtotal) {
  // A sentence with two amounts in it, so the amounts are elements rather than
  // interpolations: a template string cannot hold a component, and building
  // one here would mean formatting an amount in a route — the leak spec 0007
  // exists to close. The prose either side is unchanged.
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
          <PriceFreshness freshness={freshness} />
        </div>

      </header>

      {holdingCount === 0 ? (
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
                {/* The weighted yield, and nothing else, beside the figure it is
                    the ratio of. Absent rather than `0.0%` where there is no
                    positive value to divide by: the zero rule applies to the
                    dividend, never to the value underneath it. */}
                {weighted === null ? null : (
                  <span className="kpi-aside">{formatShare(weighted)} weighted yield</span>
                )}
              </p>

              {/* Said on the page, not only in the guide, and for the reason the
                  unrealized panel says its own figure is an upper bound: a
                  household reading this number should not have to know which
                  holdings are missing from it (§14, limitation 9). */}
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
