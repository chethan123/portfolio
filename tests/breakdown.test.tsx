import { describe, expect, it } from "vitest";

import { Breakdown, ring } from "../app/components/breakdown.tsx";

import { renderRoute } from "./support/render.tsx";

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

  it("folds everything past the fifth row into one neutral wedge", () => {
    // Seven groups, five colours. The fold is by rank and starts at
    // `SEQUENCE`, so it is the SIXTH row and later that stop extending the
    // sequence — they merge into one wedge wearing `--cat-other`, the
    // neutral, never a sixth hue and never a repeat of `--cat-5`: a tail
    // dressed in a real series colour is two different rows reading as one
    // group. The ring ends up with six arcs while the table still has seven
    // rows, which is what the panel's own note means by "everything past the
    // fifth row".
    //
    // The amounts descend with the shares rather than contradicting them: the
    // fold keys on rank, the caller sorts by amount, and a fixture whose two
    // columns disagreed would read as though the fold keyed on the share.
    const wedges = ring([
      slice("A", "40.0000", "0.400000"),
      slice("B", "20.0000", "0.200000"),
      slice("C", "12.0000", "0.120000"),
      slice("D", "10.0000", "0.100000"),
      slice("E", "8.0000", "0.080000"),
      slice("F", "6.0000", "0.060000"),
      slice("G", "4.0000", "0.040000"),
    ]);

    expect(wedges).toHaveLength(6);
    expect(wedges[4]?.color).toBe("var(--cat-5)");
    expect(wedges[5]?.color).toBe("var(--cat-other)");
    expect(wedges[5]?.fraction).toBeCloseTo(0.1, 12);
    // Contiguous: the last arc starts exactly where the five before it ended,
    // so the ring closes with no residual wedge and no hairline gap.
    expect(wedges[5]?.before).toBeCloseTo(0.9, 12);
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
    // Through the route helper rather than bare, because the panel's amounts
    // now ask the router whether this browser is masked (spec 0007). Rendered
    // unmasked: the figures are what this test is about.
    const markup = renderRoute(
      () => (
        <Breakdown
          title="Value by account type"
          count="1 account type"
          heading="Account type"
          amountHeading="Value"
          slices={[slice("Liability", "-8000.0000", "0.000000")]}
          total="0.0000"
          reading="owned"
        />
      ),
      "/",
      null,
    );

    expect(markup).not.toContain("donut");
    expect(markup).not.toContain("<svg");
    expect(markup).not.toContain("breakdown-chart");
    expect(markup).not.toContain("$0.00");

    expect(markup).toContain("−$8,000.00");
    expect(markup).toContain("Nothing in this breakdown is owned outright");
  });
});
