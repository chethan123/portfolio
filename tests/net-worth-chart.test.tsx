import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NetWorthChart, buildScale, gridRules } from "../app/components/net-worth-chart.tsx";

import type { ChartPoint } from "../app/components/net-worth-chart.tsx";

/**
 * The arithmetic behind the net worth trend line (DESIGN.md §8.1, §13.6).
 *
 * The risk here is not that the chart fails to draw. It is that it draws
 * something plausible and wrong: an axis whose ticks are 8% out, a trough
 * flattened by a division that should not have happened, twenty years of
 * history squeezed into the width of the last fortnight because the points
 * were spaced by array index. None of those throw, none of them look broken,
 * and all of them are read as fact by someone deciding what their household
 * is worth.
 *
 * So the scale and the axis labels are exercised as the pure functions they
 * are, and only the two rules that are genuinely about output — the refusal to
 * draw a single point, and the axis carrying the labels derived here — pay for
 * a render.
 */

/** Two ends of a doubling, a year apart. Money is a decimal string throughout. */
const rising: ChartPoint[] = [
  { date: "2024-01-01", amount: "100000.00" },
  { date: "2025-01-01", amount: "200000.00" },
];

describe("the drawn value domain", () => {
  it("pads past the data, so the top rule names a number above the series maximum", () => {
    // The series runs 100K–200K. Labelling the top of the box "200.0K" and the
    // bottom "100.0K" would name values the line never reaches at those
    // heights — every tick 8% of the range out. The labels below are the
    // domain actually drawn: 100K − 8%, and 200K + 8%.
    const scale = buildScale(rising);

    expect(scale.domain.floor).toBeLessThan(100000);
    expect(scale.domain.floor + scale.domain.span).toBeGreaterThan(200000);
    expect(gridRules(scale)).toEqual([
      { y: 0, label: "208.0K" },
      { y: 150, label: "150.0K" },
      { y: 300, label: "92.0K" },
    ]);
  });

  it("leaves that same 8% as breathing room above and below the line", () => {
    // The pixel side of the rule above: the extremes land inside the box, not
    // welded to its edges. 8% of the range over a padded span of 116% of it is
    // 6.9% of the height, top and bottom.
    const scale = buildScale(rising);

    expect(scale.y("200000.00")).toBeCloseTo(20.69, 2);
    expect(scale.y("100000.00")).toBeCloseTo(279.31, 2);
  });
});

describe("a portfolio that has not moved", () => {
  const flat: ChartPoint[] = [
    { date: "2025-01-01", amount: "50000.00" },
    { date: "2025-06-01", amount: "50000.00" },
  ];

  it("centres the line rather than dividing by zero", () => {
    // One upload, or a genuinely unchanged balance: there is no range to scale
    // against, and the height of the box is the honest place to put it.
    const scale = buildScale(flat);

    expect(scale.domain.span).toBe(0);
    expect(scale.y("50000.00")).toBe(150);
  });

  it("repeats one label on all three rules, as the axis comment accepts", () => {
    // Documented and intended, not a defect: the rules are keyed by position,
    // so a flat series legitimately names the same number three times. Pinned
    // so that a future change to the keying has to be a deliberate one.
    expect(gridRules(buildScale(flat)).map((rule) => rule.label)).toEqual([
      "50.0K",
      "50.0K",
      "50.0K",
    ]);
  });
});

describe("the time axis", () => {
  it("places a point by its date, not by its position in the array", () => {
    // The manual series is annual and the computed one fortnightly, so this is
    // the difference between a chart and a lie. From 2000-01-01 to 2020-02-01
    // is 7336 days, of which the middle point sits at day 7305 — 99.6% of the
    // way across, against the 50% that even spacing by index would give it.
    const scale = buildScale([
      { date: "2000-01-01", amount: "5000.00" },
      { date: "2020-01-01", amount: "400000.00" },
      { date: "2020-02-01", amount: "410000.00" },
    ]);

    expect(scale.x("2000-01-01")).toBe(0);
    expect(scale.x("2020-02-01")).toBe(1000);
    expect(scale.x("2020-01-01")).toBeCloseTo((7305 / 7336) * 1000, 6);
  });

  it("keeps coordinates finite when every point shares one date", () => {
    // A zero time span is a division waiting to happen: two balances entered
    // for the same day would otherwise plot at NaN and vanish silently.
    const scale = buildScale([
      { date: "2025-03-01", amount: "10000.00" },
      { date: "2025-03-01", amount: "12000.00" },
    ]);

    expect(scale.x("2025-03-01")).toBe(0);
    expect(scale.y("12000.00")).toBeCloseTo(20.69, 2);
  });
});

describe("a household in net debt", () => {
  // Negative net worth is an ordinary state — a mortgage taken out last month
  // outweighs everything behind it — and the axis has to survive it.
  const indebted: ChartPoint[] = [
    { date: "2025-01-01", amount: "-42000.00" },
    { date: "2025-12-01", amount: "-15000.00" },
  ];

  it("plots below zero without leaving the box", () => {
    const scale = buildScale(indebted);

    expect(scale.y("-42000.00")).toBeCloseTo(279.31, 2);
    expect(scale.y("-15000.00")).toBeCloseTo(20.69, 2);
    expect(scale.x("2025-12-01")).toBe(1000);
  });

  it("labels the rules with real minus signs, not hyphens", () => {
    // U+2212, from `formatCompact`. At tick size a hyphen reads as a dash in
    // the label rather than as the sign of the number.
    expect(gridRules(buildScale(indebted)).map((rule) => rule.label)).toEqual([
      "−12.8K",
      "−28.5K",
      "−44.2K",
    ]);
  });
});

describe("<NetWorthChart>", () => {
  const render = (manual: ChartPoint[], computed: ChartPoint[]) =>
    renderToStaticMarkup(
      <NetWorthChart manual={manual} computed={computed} label="Net worth" id="test" />,
    );

  it.each([
    {
      name: "a single hand-typed point",
      manual: [{ date: "2024-01-01", amount: "100000.00" }],
      computed: [],
    },
    {
      name: "a single computed point",
      manual: [],
      computed: [{ date: "2025-01-01", amount: "200000.00" }],
    },
    { name: "no points at all", manual: [], computed: [] },
  ])("draws nothing for $name, because two points make a line", ({ manual, computed }) => {
    expect(render(manual, computed)).toBe("");
  });

  it("labels its axis with the rules it derives, and nothing else", () => {
    // Read against `gridRules` rather than against three literals: what is
    // being protected is that the axis a reader sees is the one the scale
    // computed, so a second, divergent derivation inside the component would
    // fail here.
    const markup = render([], rising);

    for (const rule of gridRules(buildScale(rising))) {
      expect(markup).toContain(`<span>${rule.label}</span>`);
    }
    expect(markup).toContain('aria-label="Net worth"');
  });
});
