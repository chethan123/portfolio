import { EmptyState } from "~/components/empty-state";
import {
  allocationByAccountKind,
  allocationByAssetClass,
  allocationByPerson,
  sharePercent,
  type AllocationSlice,
} from "~/lib/allocation";
import { formatMoney, formatPercent, isNegative } from "~/lib/format";
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

/** The ring's geometry, in the 100×100 user space of the `viewBox`. */
const RADIUS = 44;
const STROKE = 12;

/**
 * Computed, never written down as 276.46.
 *
 * Every segment's length and every offset is a fraction of this one number, so
 * a rounded constant would leave the ring a fraction of a degree short and put
 * the whole error in the last segment — the one place a gap is visible.
 */
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * How many colours the categorical sequence has (§13.3).
 *
 * A breakdown with more groups than this folds its tail into one "Other" wedge
 * rather than extending the sequence: six flat colours in a donut is a legend
 * nobody reads.
 */
const SEQUENCE = 5;

/**
 * `--cat-1` … `--cat-5`, by rank, in all three panels.
 *
 * Keyed on rank rather than on what is being ranked, which is the whole of
 * §13.3: the largest slice is the same colour whether it is a person, an
 * account kind or an asset class, so no breakdown gets a chart palette of its
 * own. The clamp is the fold — every rank at or past the last position shares
 * the last colour, because they share the one "Other" wedge.
 */
function categoryColor(rank: number): string {
  return `var(--cat-${Math.min(rank, SEQUENCE - 1) + 1})`;
}

/**
 * Whether a decimal string is strictly greater than zero.
 *
 * The counterpart to `format.ts`'s `isNegative`, and read off the digits the
 * same way: a sign and one non-zero digit is the whole test. `Number(amount) >
 * 0` would answer the same question by way of a float, which §4.1 keeps money
 * out of end to end.
 */
function isPositive(decimal: string): boolean {
  return !isNegative(decimal) && /[1-9]/.test(decimal);
}

/**
 * A share on its way to becoming a dash length.
 *
 * The one float on this page, under the licence `toPlotValue` documents: the
 * result is multiplied by a circumference and rounded to a screen coordinate,
 * so an error in the fifteenth significant digit cannot survive to be seen.
 * Every figure a person *reads* comes from `sharePercent` and `formatMoney`,
 * which never leave the digits.
 */
function fraction(share: string): number {
  return Number(share);
}

/**
 * `"0.197531"` → `"19.8%"`, and a liability's `"-0.120413"` → `"−12.0%"`.
 *
 * `formatPercent` marks a positive because it was written for a *movement*,
 * where an unmarked gain is ambiguous. A share is not a movement and a column
 * of pluses is noise, so the lead it added is dropped — the lead only, never
 * the sign itself, so the minus on a liability's row survives and the rounding
 * and the U+2212 stay in `format.ts` where they are written once.
 */
function formatShare(share: string): string {
  return formatPercent(sharePercent(share)).replace(/^\+/, "");
}

/** One drawn arc: how much of the ring it is, and where it starts. */
type Wedge = { color: string; fraction: number; before: number };

/**
 * The arcs to draw, in rank order, folded at the end of the sequence.
 *
 * **Only positive slices become arcs.** `allocation.ts` is explicit that a
 * negative share is a negative fraction of what is *owned* — a debt is not a
 * part of the thing the ring is a whole of — so a liability has no wedge here
 * rather than a wedge clamped to zero or, worse, one drawn from its magnitude
 * as if it were an asset. That exclusion is structural, which is also what
 * guarantees no `stroke-dasharray` below is ever computed from a negative
 * number. The positive slices sum to `1.000000` by construction, so what is
 * left is a complete ring needing no residual wedge.
 */
function ring(slices: AllocationSlice[]): Wedge[] {
  const folds = slices.length > SEQUENCE;
  const wedges: Wedge[] = [];
  let before = 0;
  let tail = 0;

  slices.forEach((slice, rank) => {
    if (!isPositive(slice.share)) return;

    // The fold is by rank, so the ranks that share the last colour are exactly
    // the ranks that merge into the last wedge — the table's dots and the ring
    // cannot come apart.
    if (folds && rank >= SEQUENCE - 1) {
      tail += fraction(slice.share);
      return;
    }

    wedges.push({ color: categoryColor(rank), fraction: fraction(slice.share), before });
    before += fraction(slice.share);
  });

  if (tail > 0) wedges.push({ color: categoryColor(SEQUENCE - 1), fraction: tail, before });

  return wedges;
}

/**
 * The ring, and the total in the hole of it.
 *
 * **The SVG is `aria-hidden` and the table beside it is the accessible
 * representation.** It is the same rows, in the same order, with the exact
 * figures rather than arcs — so a `role="img"` name here would either be a
 * summary that repeats the table or a name so vague ("Donut chart") that it
 * announces the existence of a picture and nothing about the portfolio. The
 * centre text is deliberately left *outside* the hidden subtree: the total is
 * the one figure on the panel that the table does not carry.
 */
function Donut({ wedges, total }: { wedges: Wedge[]; total: string }) {
  return (
    <div className="donut">
      <svg className="donut-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <circle className="donut-track" cx="50" cy="50" r={RADIUS} strokeWidth={STROKE} />
        {wedges.map((wedge, index) => (
          <circle
            key={index}
            className="donut-segment"
            cx="50"
            cy="50"
            r={RADIUS}
            strokeWidth={STROKE}
            stroke={wedge.color}
            strokeDasharray={`${wedge.fraction * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            strokeDashoffset={-(wedge.before * CIRCUMFERENCE)}
          />
        ))}
      </svg>

      <div className="donut-center">
        <span className="u-label">Total</span>
        <span className="donut-total u-data">{formatMoney(total)}</span>
      </div>
    </div>
  );
}

/**
 * One panel: a breakdown, its ring, and the rows the ring is drawn from.
 *
 * Written once for all three because the only thing that differs between them
 * is what was grouped — and a second copy is how one breakdown would come to
 * treat a liability or a sixth group differently from another.
 */
function Breakdown({
  title,
  count,
  heading,
  slices,
  total,
}: {
  title: string;
  count: string;
  heading: string;
  slices: AllocationSlice[];
  total: string;
}) {
  const wedges = ring(slices);

  // No wedges means nothing in this breakdown is positive, which is the case
  // `allocation.ts` describes for a household with only a loan recorded: there
  // is no whole for a share to be part of, every `share` is `0.000000`, and the
  // caller is told to show the amounts alone. Reporting those zeroes as
  // percentages would be claiming each slice is nothing.
  const hasRing = wedges.length > 0;
  const owed = slices.some((slice) => isNegative(slice.amount));
  const folded = slices.length > SEQUENCE;

  const notes = [
    hasRing
      ? owed
        ? "The ring draws what is owned. A debt is not a share of it, so a negative row is left" +
          " unfilled and its percentage is of gross assets rather than of the total in the centre."
        : null
      : "Nothing in this breakdown is owned outright, so there is no whole for a share to be part" +
        " of and no ring to draw. The amounts are the answer here.",
    folded
      ? "Everything past the fourth row shares one colour and one wedge: a donut with a colour per" +
        " group is a legend nobody reads. Each row keeps its own value."
      : null,
  ].filter((note): note is string => note !== null);

  return (
    <section className="panel">
      <header className="panel-header">
        <h2 className="panel-title">{title}</h2>
        <p className="panel-count">{count}</p>
      </header>

      <div className="breakdown">
        {hasRing ? (
          <div className="breakdown-chart">
            <Donut wedges={wedges} total={total} />
          </div>
        ) : null}

        <div className="breakdown-table">
          <div className="data-table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{heading}</th>
                  <th scope="col" className="is-numeric">
                    Value
                  </th>
                  <th scope="col" className="is-numeric">
                    % of total
                  </th>
                </tr>
              </thead>
              <tbody>
                {slices.map((slice, rank) => (
                  <tr key={slice.key}>
                    <td>
                      <span className="cell-stack">
                        {/* A hollow dot is a row with no wedge — a liability, or
                            a group that nets flat. The ring is what the fill
                            keys to, so a row that is not in it does not get
                            one. */}
                        <span
                          className="legend-dot"
                          style={{
                            background: isPositive(slice.share)
                              ? categoryColor(rank)
                              : "transparent",
                          }}
                        />
                        {slice.label}
                      </span>
                    </td>
                    <td className="is-numeric">{formatMoney(slice.amount)}</td>
                    <td className="is-numeric">{hasRing ? formatShare(slice.share) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {notes.length > 0 ? (
            <div className="panel-body">
              <p className="coverage-note">{notes.join(" ")}</p>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export async function loader() {
  // One read, three groupings of the array it returned. The total comes from
  // the query module rather than from adding those groups up here: money is
  // summed in SQL, in `numeric` (§8.2), and this is the same figure the
  // Overview headline shows because it is the same query.
  const [holdings, total] = await Promise.all([currentHoldings(), netWorth()]);

  return {
    total: total.amount,
    // Counted off the rows already in hand rather than asked for separately —
    // two counts of one thing are two things that can disagree.
    holdingCount: holdings.length,
    pricedCount: holdings.filter((holding) => holding.isPriced).length,
    byPerson: allocationByPerson(holdings),
    byAccountKind: allocationByAccountKind(holdings),
    byAssetClass: allocationByAssetClass(holdings),
  };
}

/** `1 person` / `4 people`, without an "(s)" anywhere on a finance page. */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export default function Analysis({ loaderData }: Route.ComponentProps) {
  const { total, holdingCount, pricedCount, byPerson, byAccountKind, byAssetClass } = loaderData;

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
          The portfolio broken down by person, by account type and by asset class appears here
          once a statement has been uploaded. Nothing has been uploaded to this instance yet.
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
            slices={byPerson}
            total={total}
          />

          <Breakdown
            title="Value by account type"
            count={plural(byAccountKind.length, "account type", "account types")}
            heading="Account type"
            slices={byAccountKind}
            total={total}
          />

          <Breakdown
            title="Value by asset class"
            count={plural(byAssetClass.length, "asset class", "asset classes")}
            heading="Asset class"
            slices={byAssetClass}
            total={total}
          />
        </>
      )}
    </section>
  );
}
