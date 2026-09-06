/**
 * One breakdown panel: a ring, and the rows it's drawn from (DESIGN.md
 * §8.1, §13.3). One component, not per-screen copies — same rank means same
 * colour everywhere. Table carries every figure, ring carries none.
 */
import { Amount } from "~/components/amount";
import { formatShare, type AllocationSlice } from "~/lib/allocation";
import { isNegative, isPositive } from "~/lib/format";

// Ring's geometry, in the 100×100 user space of the `viewBox`.
const RADIUS = 44;
const STROKE = 12;

// Computed, never a rounded literal — a fixed constant would leave the ring short, the whole error dumped in the last segment.
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// Hues in the categorical sequence (§13.3) — more groups fold into one "Other" wedge instead of extending it.
export const SEQUENCE = 5;

// `--cat-1`…`--cat-5` by rank, not by what's ranked (§13.3) — same rank, same colour everywhere. Past the sequence: `--cat-other`, grey on purpose.
export function categoryColor(rank: number): string {
  return rank < SEQUENCE ? `var(--cat-${rank + 1})` : "var(--cat-other)";
}

// The one float here (`toPlotValue`'s licence) — becomes a dash length. Every figure a person reads comes from `formatShare`/`Amount` instead.
function fraction(share: string): number {
  return Number(share);
}

// One drawn arc. `title` exists because colour alone can't identify a wedge under the pointer.
export type Wedge = { color: string; fraction: number; before: number; title: string };

// Only positive slices become arcs (`allocation.ts`) — a liability has no wedge, never one clamped to zero. Positive slices sum to 1.000000 by construction.
export function ring(slices: AllocationSlice[]): Wedge[] {
  const wedges: Wedge[] = [];
  const folded: string[] = [];
  let before = 0;
  let tail = 0;

  slices.forEach((slice, rank) => {
    if (!isPositive(slice.share)) return;

    // Fold by rank — the table's dots and the ring can't come apart.
    if (rank >= SEQUENCE) {
      tail += fraction(slice.share);
      folded.push(slice.label);
      return;
    }

    wedges.push({
      color: categoryColor(rank),
      fraction: fraction(slice.share),
      before,
      title: `${slice.label} — ${formatShare(slice.share)}`,
    });
    before += fraction(slice.share);
  });

  if (tail > 0) {
    wedges.push({
      color: categoryColor(SEQUENCE),
      fraction: tail,
      before,
      title: `Other: ${folded.join(", ")}`,
    });
  }

  return wedges;
}

/**
 * SVG is `aria-hidden` — the table beside it is the accessible
 * representation, same rows and figures. Centre text stays outside the
 * hidden subtree: the total is the one figure the table doesn't carry.
 * Each arc's `<title>` is the pointer's identity channel, for a sighted
 * reader who can't match colour to row alone.
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
          >
            <title>{wedge.title}</title>
          </circle>
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

// A flag, not prose — the panel (not its caller) knows whether there's a
// ring and whether any row is negative. `owned`: debt isn't part of what's
// owned. `paid`: interest out is a different sentence. No default — either is ordinary.
export type BreakdownReading = "owned" | "paid";

// The two sentences each reading needs, chosen from the slices below.
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

// `1 person` / `4 people`, no "(s)" on a finance page.
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// One panel, written once for every breakdown — the only difference between them is what's grouped and what the amounts are.
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

  // No wedges means nothing positive (`allocation.ts`'s only-a-loan case) — show amounts alone, not zeroes reported as percentages.
  const hasRing = wedges.length > 0;
  const owed = slices.some((slice) => isNegative(slice.amount));
  // Fold note only where the sharing is visible — two or more drawn slices past the sequence.
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
                        {/* Hollow dot: no wedge — a liability or a flat group. */}
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
