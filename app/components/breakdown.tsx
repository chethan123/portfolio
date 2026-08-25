/**
 * One breakdown panel: a ring, and the rows the ring is drawn from
 * (DESIGN.md §8.1, §13.3).
 *
 * Module-private to the Analysis route until a second screen needed the same
 * panel. It is a component rather than three near-copies for one reason, and
 * the reason is §13.3: the same rank is the same colour in every panel, and no
 * breakdown gets a chart palette of its own. Nothing enforces that but there
 * being one implementation — a second copy is how one breakdown comes to treat
 * a liability, or a sixth group, differently from another.
 *
 * The table is the screen and the ring is a picture of the table, which is why
 * it is the table that carries every figure and the ring that carries none.
 */
import { formatShare, type AllocationSlice } from "~/lib/allocation";
import { formatMoney, isNegative, isPositive } from "~/lib/format";

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
export const SEQUENCE = 5;

/**
 * `--cat-1` … `--cat-5`, by rank, in every panel on every screen.
 *
 * Keyed on rank rather than on what is being ranked, which is the whole of
 * §13.3: the largest slice is the same colour whether it is a person, an
 * account kind or an asset class, so no breakdown gets a chart palette of its
 * own. The clamp is the fold — every rank at or past the last position shares
 * the last colour, because they share the one "Other" wedge.
 */
export function categoryColor(rank: number): string {
  return `var(--cat-${Math.min(rank, SEQUENCE - 1) + 1})`;
}

/**
 * A share on its way to becoming a dash length.
 *
 * The one float in this component, under the licence `toPlotValue` documents:
 * the result is multiplied by a circumference and rounded to a screen
 * coordinate, so an error in the fifteenth significant digit cannot survive to
 * be seen. Every figure a person *reads* comes from `formatShare` and
 * `formatMoney`, which never leave the digits.
 */
function fraction(share: string): number {
  return Number(share);
}

/** One drawn arc: how much of the ring it is, and where it starts. */
export type Wedge = { color: string; fraction: number; before: number };

/**
 * The arcs to draw, in rank order, folded at the end of the sequence.
 *
 * **Only positive slices become arcs.** `allocation.ts` is explicit that a
 * negative share is a negative fraction of the gross positive total — the thing
 * being cut up is what the slices add up to, and a slice that subtracts from it
 * is not a part of it — so a liability, or a group whose interest outweighs
 * what it pays, has no wedge here rather than a wedge clamped to zero or,
 * worse, one drawn from its magnitude as if it had the other sign. That
 * exclusion is structural, which is also what guarantees no `stroke-dasharray`
 * below is ever computed from a negative number. The positive slices sum to
 * `1.000000` by construction, so what is left is a complete ring needing no
 * residual wedge.
 */
export function ring(slices: AllocationSlice[]): Wedge[] {
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
 *
 * `Total` is hard-coded, unlike the column heading above the amounts. It is the
 * word for the sum of whatever the rows are — a total value and a total annual dividend
 * are both totals — so there is nothing here for a caller to choose.
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
 * What the amounts in a panel *are*, for the two sentences that have to say so.
 *
 * A **flag rather than the prose itself**, which was the other candidate and is
 * the more flexible one. The flag wins on the call site because the panel — not
 * its caller — is what knows which of the two sentences applies: whether there
 * is a ring at all, and whether any row is negative, are both read off
 * {@link ring} and the slices *inside* the component. Handing the prose in
 * would mean every caller computing the wedges a second time to work out which
 * sentence to hand in, or handing in both and letting the panel choose — which
 * is this flag with two long strings stapled to it.
 *
 * So the panel keeps its sentences and the caller says which reading it is
 * cutting up:
 *
 *   * `owned` — a share of what the household holds. A negative row is a debt,
 *     and a debt is not a part of what is owned.
 *   * `paid` — a share of what the household is paid. A negative row is
 *     interest going out rather than a debt held, which is a different sentence
 *     about the same arithmetic.
 *
 * No default. The two readings are equally ordinary, and a panel that quietly
 * inherited the wrong one would say something false in small grey type, which
 * is the least likely thing on the page to be noticed.
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
 *
 * Here rather than in either route because it exists to build one prop —
 * {@link Breakdown}'s `count` — and both screens that draw these panels were
 * about to hold their own copy of it. The plural is part of how a panel names
 * itself, so it travels with the panel.
 */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * One panel: a breakdown, its ring, and the rows the ring is drawn from.
 *
 * Written once for every breakdown on every screen because the only thing that
 * differs between them is what was grouped and what the amounts are — and a
 * second copy is how one breakdown would come to treat a liability or a sixth
 * group differently from another. Two screens draw these now, which makes that
 * argument stronger rather than weaker: the rank-keyed colour rule is a rule
 * about the *application*, not about a page.
 *
 * @param heading the first column: what the rows are.
 * @param amountHeading the second column: what the amounts are. A prop and not
 *                      the string `Value`, because a panel of annual dividends is a
 *                      breakdown of the same shape with a different figure in
 *                      it, and a column headed Value over a column of dividends
 *                      is simply wrong.
 * @param reading which sentence the notes are written in — see
 *                {@link BreakdownReading}.
 * @param children an optional slot beneath the table, for a line that restates
 *                 the rows in a sentence. It sits with the notes rather than in
 *                 the table's `tfoot`: a subtotal that is not the sum of the
 *                 column above it is prose about the table, not a row of it.
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

  // No wedges means nothing in this breakdown is positive, which is the case
  // `allocation.ts` describes for a household with only a loan recorded: there
  // is no whole for a share to be part of, every `share` is `0.000000`, and the
  // caller is told to show the amounts alone. Reporting those zeroes as
  // percentages would be claiming each slice is nothing.
  const hasRing = wedges.length > 0;
  const owed = slices.some((slice) => isNegative(slice.amount));
  // The fold note describes rows *sharing* one colour and one wedge, so it is
  // said only where that sharing is something a reader can see. More slices
  // than colours is when the fold is armed; what makes it visible is two or
  // more slices past the sequence that are actually drawn. A breakdown whose
  // tail is all zeros — six accounts of which the last two pay nothing — folds
  // nothing, draws no merged wedge, and the note would be explaining an absence
  // in small grey type.
  const folded =
    slices.length > SEQUENCE &&
    slices.filter((slice, rank) => rank >= SEQUENCE - 1 && isPositive(slice.share)).length > 1;

  const notes = [
    hasRing ? (owed ? NOTES[reading].negative : null) : NOTES[reading].empty,
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
