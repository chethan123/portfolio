import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Breakdown, ring } from "../app/components/breakdown.tsx";

import type { AllocationSlice } from "../app/lib/allocation.ts";

/**
 * The panel every breakdown on every screen is drawn by (DESIGN.md §8.1,
 * §13.3).
 *
 * `allocation.ts` is where the arithmetic behind a slice is pinned, and
 * `tests/allocation.test.ts` pins it — so what is left here is what a pure test
 * cannot see. Two things qualify.
 *
 * {@link ring} is one of them and it is pure, so it is exercised as the
 * function it is rather than through a render: it decides which slices become
 * arcs and which colour each one takes, and both of those are rules that would
 * still be wrong if the SVG came out well-formed.
 *
 * The other genuinely needs the output, because it is about the *absence* of
 * it: a breakdown with nothing positive in it draws no ring, no zero and no
 * chart frame (§8.4). An instance nobody has uploaded to and a portfolio that
 * is all debt must not render the same empty circle with `$0.00` in the middle
 * of it, and no assertion over a returned array can tell you whether that
 * circle was drawn.
 */

/** One slice, as `allocationBy` would have returned it. */
function slice(label: string, amount: string, share: string): AllocationSlice {
  return { key: label, label, amount, share, coverage: { known: 1, total: 1 } };
}

describe("the arcs", () => {
  it("skips a negative slice and keeps every colour keyed to the rank", () => {
    // The negative row is not an arc — `allocation.ts` is explicit that it is
    // not a part of the whole being cut up — but it still holds its rank, so
    // the slice below it stays `--cat-3` rather than sliding up to `--cat-2`.
    // That is what keeps the table's legend dots and the ring the same colour
    // for the same row.
    const wedges = ring([
      slice("Brokerage", "60000.0000", "0.600000"),
      slice("Loan", "-20000.0000", "-0.200000"),
      slice("IRA", "40000.0000", "0.400000"),
    ]);

    expect(wedges).toEqual([
      { color: "var(--cat-1)", fraction: 0.6, before: 0 },
      { color: "var(--cat-3)", fraction: 0.4, before: 0.6 },
    ]);
  });

  it("folds everything past the fifth colour into one wedge", () => {
    // Six groups, five colours. The sixth and later rows do not extend the
    // sequence — they merge into the last wedge and share the last colour, so
    // the ring has five arcs and the table still has six rows.
    const wedges = ring([
      slice("A", "50.0000", "0.500000"),
      slice("B", "20.0000", "0.200000"),
      slice("C", "10.0000", "0.100000"),
      slice("D", "10.0000", "0.100000"),
      slice("E", "60.0000", "0.060000"),
      slice("F", "40.0000", "0.040000"),
    ]);

    expect(wedges).toHaveLength(5);
    expect(wedges[4]?.color).toBe("var(--cat-5)");
    expect(wedges[4]?.fraction).toBeCloseTo(0.1, 12);
    // Contiguous: the last arc starts exactly where the four before it ended,
    // so the ring closes with no residual wedge and no hairline gap.
    expect(wedges[4]?.before).toBeCloseTo(0.9, 12);
  });
});

describe("<Breakdown>", () => {
  it("draws no ring, no zero and no chart frame when nothing is positive", () => {
    // A household with only a loan recorded. There is no whole for a share to
    // be a part of, so there is nothing to draw — and the total handed in is a
    // zero precisely to check that it never reaches the page: `$0.00` in the
    // hole of a ring is the figure §8.4 refuses, because it is what an instance
    // with nothing uploaded would show too. The amounts are the answer here,
    // and the percentage column says so with a dash rather than with `0.0%`.
    const markup = renderToStaticMarkup(
      <Breakdown
        title="Value by account type"
        count="1 account type"
        heading="Account type"
        amountHeading="Value"
        slices={[slice("Liability", "-8000.0000", "0.000000")]}
        total="0.0000"
        reading="owned"
      />,
    );

    expect(markup).not.toContain("donut");
    expect(markup).not.toContain("<svg");
    expect(markup).not.toContain("breakdown-chart");
    expect(markup).not.toContain("$0.00");

    expect(markup).toContain("−$8,000.00");
    expect(markup).toContain("Nothing in this breakdown is owned outright");
  });
});
