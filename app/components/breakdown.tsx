/**
 * One breakdown panel: a ring, and the rows the ring is drawn from
 * (DESIGN.md §8.1, §13.3). One component rather than three near-copies for
 * §13.3's reason: the same rank is the same colour in every panel, and no
 * breakdown gets a chart palette of its own — nothing enforces that but
 * there being one implementation. The table is the screen and the ring a
 * picture of the table: the table carries every figure, the ring none.
 */
import { Amount } from "~/components/amount";
import { formatShare, type AllocationSlice } from "~/lib/allocation";
import { isNegative, isPositive } from "~/lib/format";

/** The ring's geometry, in the 100×100 user space of the `viewBox`. */
const RADIUS = 44;
const STROKE = 12;

/**
 * Computed, never written down as 276.46: every segment length and offset is
 * a fraction of this number, and a rounded constant would leave the ring
 * short with the whole error in the last segment — where a gap shows.
 */
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * How many hues the categorical sequence has (§13.3). More groups than this
 * fold their tail into one "Other" wedge rather than extending the sequence:
 * many flat colours in a donut is a legend nobody reads — and a palette
 * stretched past what colour vision separates repaints two groups the same.
 */
export const SEQUENCE = 5;

/**
 * `--cat-1` … `--cat-5`, by rank, in every panel on every screen. Keyed on
 * rank, not on what is ranked — the whole of §13.3: the largest slice is the
 * same colour whether it is a person, an account kind or an asset class.
 * Every rank past the sequence wears `--cat-other`, the fold's neutral —
 * grey on purpose, so the merged remainder reads as "the rest" and never
 * impersonates one of the five real series colours.
 */
export function categoryColor(rank: number): string {
  return rank < SEQUENCE ? `var(--cat-${rank + 1})` : "var(--cat-other)";
}

/**
 * A share on its way to becoming a dash length — the one float here, under
 * the licence `toPlotValue` documents: multiplied by a circumference and
 * rounded to a screen coordinate. Every figure a person *reads* comes from
 * `formatShare` and `Amount`, which never leave the digits.
 */
function fraction(share: string): number {
  return Number(share);
}

/** One drawn arc: how much of the ring it is, and where it starts. */
export type Wedge = { color: string; fraction: number; before: number };

/**
 * The arcs to draw, in rank order, folded at the end of the sequence.
 * **Only positive slices become arcs**: `allocation.ts` defines a negative
 * share as a negative fraction of the gross positive total — a slice that
 * subtracts from the whole is not a part of it — so a liability, or a group
 * whose interest outweighs what it pays, has no wedge rather than one
 * clamped to zero or drawn from its magnitude. Structural, which also
 * guarantees no `stroke-dasharray` below is computed from a negative. The
 * positive slices sum to `1.000000` by construction: a complete ring, no
 * residual wedge.
 */
export function ring(slices: AllocationSlice[]): Wedge[] {
  const wedges: Wedge[] = [];
  let before = 0;
  let tail = 0;

  slices.forEach((slice, rank) => {
    if (!isPositive(slice.share)) return;

    // The fold is by rank, so the ranks wearing the neutral are exactly the
    // ranks merging into the "Other" wedge — the table's dots and the ring
    // cannot come apart.
    if (rank >= SEQUENCE) {
      tail += fraction(slice.share);
      return;
    }

    wedges.push({ color: categoryColor(rank), fraction: fraction(slice.share), before });
    before += fraction(slice.share);
  });

  if (tail > 0) wedges.push({ color: categoryColor(SEQUENCE), fraction: tail, before });

  return wedges;
}

/**
 * The ring, and the total in the hole of it. **The SVG is `aria-hidden`; the
 * table beside it is the accessible representation** — same rows, same
 * order, exact figures: a `role="img"` name would either repeat the table or
 * announce "Donut chart" and nothing about the portfolio. The centre text
 * stays *outside* the hidden subtree: the total is the one figure the table
 * does not carry. `Total` is hard-coded, unlike the amount heading — it is
 * the word for the sum of whatever the rows are.
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
        <span className="donut-total u-data">
          <Amount value={total} />
        </span>
      </div>
    </div>
  );
}

/**
 * What the amounts in a panel *are*, for the two sentences that must say so.
 * A **flag rather than the prose itself** because the panel, not its caller,
 * knows which sentence applies — whether there is a ring at all, and whether
 * any row is negative, are read off {@link ring} inside the component;
 * handing prose in would mean every caller computing the wedges a second
 * time, or handing in both sentences — this flag with two long strings
 * stapled to it.
 *
 *   * `owned` — a share of what the household holds. A negative row is a
 *     debt, and a debt is not part of what is owned.
 *   * `paid` — a share of what the household is paid. A negative row is
 *     interest going out — a different sentence about the same arithmetic.
 *
 * No default: both readings are ordinary, and a panel quietly inheriting the
 * wrong one says something false in small grey type — the least likely thing
 * on the page to be noticed.
 */
export type BreakdownReading = "owned" | "paid";

/** The two sentences each reading needs, chosen from the slices below. */
const NOTES: Record<BreakdownReading, { negative: string; empty: string }> = {
  owned: {
    negative:
      "The ring draws what is owned. A debt is not a share of it, so a negative row is left" +
      " unfilled and its percentage is of gross assets rather than of the total in the centre.",
    empty:
      "Nothing in this breakdown is owned outright, so there is no whole for a share to be part" +
      " of and no ring to draw. The amounts are the answer here.",
  },
  paid: {
    negative:
      "The ring draws what the portfolio is paid. Interest going the other way is not a share" +
      " of it, so a negative row is left unfilled and its percentage is of the gross annual" +
      " dividend rather than of the total in the centre.",
    empty:
      "Nothing in this breakdown pays anything, so there is no whole for a share to be part of" +
      " and no ring to draw. The amounts are the answer here.",
  },
};

/**
 * `1 person` / `4 people`, without an "(s)" anywhere on a finance page.
 * Here because it exists to build {@link Breakdown}'s `count`, and both
 * screens drawing these panels were about to hold their own copy.
 */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * One panel: a breakdown, its ring, and the rows the ring is drawn from —
 * written once for every breakdown on every screen, because the only thing
 * differing between them is what was grouped and what the amounts are, and
 * a second copy is how one panel comes to treat a liability differently.
 *
 * @param heading the first column: what the rows are.
 * @param amountHeading the second column: what the amounts are — a prop
 *                      because a column headed Value over dividends is wrong.
 * @param reading which sentence the notes are written in
 *                ({@link BreakdownReading}).
 * @param children an optional slot beneath the table, for a line restating
 *                 the rows in a sentence — with the notes, not the `tfoot`:
 *                 a subtotal that is not the column's sum is prose about the
 *                 table, not a row of it.
 */
export function Breakdown({
  title,
  count,
  heading,
  amountHeading,
  slices,
  total,
  reading,
  children,
}: {
  title: string;
  count: string;
  heading: string;
  amountHeading: string;
  slices: AllocationSlice[];
  total: string;
  reading: BreakdownReading;
  children?: React.ReactNode;
}) {
  const wedges = ring(slices);

  // No wedges means nothing positive — `allocation.ts`'s only-a-loan case:
  // no whole for a share to be part of, every `share` is `0.000000`, show
  // the amounts alone. Reporting those zeroes as percentages would claim
  // each slice is nothing.
  const hasRing = wedges.length > 0;
  const owed = slices.some((slice) => isNegative(slice.amount));
  // The fold note describes rows *sharing* one wedge, so it is said only
  // where the sharing is visible: two or more drawn slices past the
  // sequence. A tail of one merges nothing, a tail of all zeros folds
  // nothing, and either way the note would explain an absence in small grey
  // type.
  const folded =
    slices.filter((slice, rank) => rank >= SEQUENCE && isPositive(slice.share)).length > 1;

  const notes = [
    hasRing ? (owed ? NOTES[reading].negative : null) : NOTES[reading].empty,
    folded
      ? "Everything past the fifth row shares one grey wedge: a donut with a colour per group is" +
        " a legend nobody reads. Each row keeps its own value."
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
                    {amountHeading}
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
                        {/* A hollow dot is a row with no wedge — a liability
                            or a flat group: the fill keys to the ring, and a
                            row not in it gets none. */}
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
                    <td className="is-numeric">
                      <Amount value={slice.amount} />
                    </td>
                    <td className="is-numeric">{hasRing ? formatShare(slice.share) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {children !== undefined || notes.length > 0 ? (
            <div className="panel-body">
              {children}
              {notes.length > 0 ? <p className="coverage-note">{notes.join(" ")}</p> : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
