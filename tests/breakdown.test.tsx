import { describe, expect, it } from "vitest";

import { Breakdown, ring } from "../app/components/breakdown.tsx";

import { renderRoute } from "./support/render.tsx";

import type { AllocationSlice } from "../app/lib/allocation.ts";

// Breakdown panel (DESIGN.md §8.1, §13.3). allocation.ts's arithmetic is pinned by
// allocation.test.ts; here: ring()'s pure arc/color rules, and the rendered absence of a
// ring/zero/frame when nothing is positive (§8.4) — neither is visible to a pure array assertion.

/** One slice, as `allocationBy` would have returned it. */
function slice(label: string, amount: string, share: string): AllocationSlice {
  return { key: label, label, amount, share, coverage: { known: 1, total: 1 } };
}

describe("the arcs", () => {
  it("skips a negative slice and keeps every colour keyed to the rank", () => {
    // Negative row isn't an arc (allocation.ts: not part of the whole) but keeps its
    // rank — next slice stays --cat-3, not --cat-2, so legend dots and ring agree on color.
    const wedges = ring([
      slice("Brokerage", "60000.0000", "0.600000"),
      slice("Loan", "-20000.0000", "-0.200000"),
      slice("IRA", "40000.0000", "0.400000"),
    ]);

    expect(wedges).toEqual([
      { color: "var(--cat-1)", fraction: 0.6, before: 0, title: "Brokerage — 60.0%" },
      { color: "var(--cat-3)", fraction: 0.4, before: 0.6, title: "IRA — 40.0%" },
    ]);
  });

  it("folds everything past the fifth row into one neutral wedge", () => {
    // Seven groups, five colours: rank six and up merge into one --cat-other wedge, never
    // a sixth hue or a repeat of --cat-5 (a tail dressed in a real color reads as one more group).
    // Amounts descend with shares so the fixture can't fake the fold keying on share, not rank.
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
    // Contiguous: last arc starts exactly where the five before it ended — no gap, no residual wedge.
    expect(wedges[5]?.before).toBeCloseTo(0.9, 12);
    // Names members under the pointer, no figure — its share would be a float sum;
    // the table holds the exact ones.
    expect(wedges[5]?.title).toBe("Other: F, G");
  });

  it("gives a lone sixth slice the neutral as its own wedge", () => {
    // One rank past the sequence: nothing merges, but rank six still wears
    // --cat-other regardless of count.
    const wedges = ring([
      slice("A", "40.0000", "0.400000"),
      slice("B", "20.0000", "0.200000"),
      slice("C", "15.0000", "0.150000"),
      slice("D", "10.0000", "0.100000"),
      slice("E", "9.0000", "0.090000"),
      slice("F", "6.0000", "0.060000"),
    ]);

    expect(wedges).toHaveLength(6);
    expect(wedges[5]?.color).toBe("var(--cat-other)");
    expect(wedges[5]?.fraction).toBeCloseTo(0.06, 12);
    expect(wedges[5]?.before).toBeCloseTo(0.94, 12);
    expect(wedges[5]?.title).toBe("Other: F");
  });
});

describe("<Breakdown>", () => {
  it("puts each wedge's name under the pointer, so identity never rides on colour alone", () => {
    // Render half of the titles pinned above — a Donut that drops wedge.title would fail nothing else.
    const markup = renderRoute(
      () => (
        <Breakdown
          title="Net worth by owner"
          count="2 people"
          heading="Owner"
          amountHeading="Value"
          slices={[
            slice("Alex", "60000.0000", "0.600000"),
            slice("Jordan", "40000.0000", "0.400000"),
          ]}
          total="100000.0000"
          reading="owned"
        />
      ),
      "/",
      null,
    );

    expect(markup).toContain("<title>Alex — 60.0%</title>");
    expect(markup).toContain("<title>Jordan — 40.0%</title>");
  });

  it("draws no ring, no zero and no chart frame when nothing is positive", () => {
    // Loan-only household: nothing positive to draw, and total=0 checks §8.4's rule that an
    // empty ring never shows $0.00. renderRoute (not bare) because amounts check mask state
    // (spec 0007); rendered unmasked since the figures are what's under test.
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
