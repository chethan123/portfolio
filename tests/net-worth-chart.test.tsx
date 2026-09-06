import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MASKED_FIGURE } from "../app/components/amount.tsx";
import {
  ChartEmptyNote,
  NetWorthChart,
  buildScale,
  gridRules,
  hitTargets,
} from "../app/components/net-worth-chart.tsx";

import type { ChartPoint } from "../app/lib/chart-range.ts";

/**
 * Arithmetic behind the net worth trend line (DESIGN.md §8.1, §13.6). Risk isn't a crash —
 * it's a plausible wrong axis or squeezed scale that reads as fact. Scale/labels tested as
 * pure functions; only the empty-render refusal and axis-label wiring pay for a render.
 */

// doubling over a year; money as decimal string throughout
const rising: ChartPoint[] = [
  { date: "2024-01-01", amount: "100000.00" },
  { date: "2025-01-01", amount: "200000.00" },
];

describe("the drawn value domain", () => {
  it("pads past the data, so the top rule names a number above the series maximum", () => {
    // labelling the box exactly 100.0K/200.0K would put every tick 8% off the real drawn domain
    const scale = buildScale(rising);

    expect(scale.domain.floor).toBeLessThan(100000);
    expect(scale.domain.floor + scale.domain.span).toBeGreaterThan(200000);
    expect(gridRules(scale, false)).toEqual([
      { y: 0, label: "208.0K" },
      { y: 150, label: "150.0K" },
      { y: 300, label: "92.0K" },
    ]);
  });

  it("leaves that same 8% as breathing room above and below the line", () => {
    // pixel side of the padding rule: 8% of range over a 116% padded span = 6.9% of height
    const scale = buildScale(rising);

    expect(scale.y("200000.00")).toBeCloseTo(20.69, 2);
    expect(scale.y("100000.00")).toBeCloseTo(279.31, 2);
  });
});

describe("a session on a large portfolio", () => {
  // reported defect: one decimal at millions scale can't see under $100K — a $5.9M household reads "5.9M" everywhere
  const session = (open: string, high: string): ChartPoint[] => [
    { date: "2026-09-01T13:30:00.000Z", amount: open },
    { date: "2026-09-01T15:10:00.000Z", amount: high },
  ];

  it("names three different figures where a day's trading separates them", () => {
    // $30K span is half a 0.1M bucket — naive one-decimal rounding would print "5.9M" three times
    expect(gridRules(buildScale(session("5900000.00", "5930000.00")), false).map((r) => r.label))
      .toEqual(["5.932M", "5.915M", "5.898M"]);
  });

  it("spends no decimal on a span too small for the digit to mean anything", () => {
    // $150 span: "labels differ" isn't "worth printing" — collapses to one number three times
    expect(gridRules(buildScale(session("5900000.00", "5900150.00")), false).map((r) => r.label))
      .toEqual(["5.9M", "5.9M", "5.9M"]);
  });

  it("sizes its precision on the domain, not on an endpoint a rounding from the next suffix", () => {
    // $999,968 rounds to "1.0M"; reading that promotion back as scale made a $5,336 span look 3-decimal-worthy
    expect(
      gridRules(buildScale(session("995000.00", "999600.00")), false).map((r) => r.label),
    ).toEqual(["1.0M", "997.3K", "994.6K"]);
  });

  it("stops short of a resolution finer than the dollar the rules are rounded to", () => {
    // rules round to whole dollars (up to $1 error); under ~$4 span it stops rather than fake precision. $694,514 exact.
    const labels = (span: string) =>
      gridRules(buildScale(session("694514.00", span)), false).map((r) => r.label);

    expect(labels("694515.00")).toEqual(["694.5K", "694.5K", "694.5K"]);
    expect(labels("694518.00")).toEqual(["694.518K", "694.516K", "694.514K"]);
  });
});

describe("a range wide enough to cross a scale", () => {
  // guards a bug the suite missed once: forcing one suffix from the top rendered $96,000 as "0.1M"
  it("states a rule far below the top of the domain at its own scale", () => {
    expect(
      gridRules(
        buildScale([
          { date: "2024-01-01", amount: "200000.00" },
          { date: "2026-01-01", amount: "1500000.00" },
        ]),
        false,
      ).map((rule) => rule.label),
    ).toEqual(["1.6M", "850.0K", "96.0K"]);
  });
});

describe("a portfolio that has not moved", () => {
  const flat: ChartPoint[] = [
    { date: "2025-01-01", amount: "50000.00" },
    { date: "2025-06-01", amount: "50000.00" },
  ];

  it("centres the line rather than dividing by zero", () => {
    // zero range (one upload, or an unchanged balance) — box height is the honest place to center it
    const scale = buildScale(flat);

    expect(scale.domain.span).toBe(0);
    expect(scale.y("50000.00")).toBe(150);
  });

  it("repeats one label on all three rules, as the axis comment accepts", () => {
    // rules are keyed by position — a flat series legitimately repeats one label three times
    expect(gridRules(buildScale(flat), false).map((rule) => rule.label)).toEqual([
      "50.0K",
      "50.0K",
      "50.0K",
    ]);
  });
});

describe("the time axis", () => {
  it("places a point by its date, not by its position in the array", () => {
    // 2000-01-01..2020-02-01 spans 7336 days; middle point sits at day 7305 (99.6%), not 50% by-index
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
    // zero time span is a division waiting to happen — same-day balances would plot NaN and vanish silently
    const scale = buildScale([
      { date: "2025-03-01", amount: "10000.00" },
      { date: "2025-03-01", amount: "12000.00" },
    ]);

    expect(scale.x("2025-03-01")).toBe(0);
    expect(scale.y("12000.00")).toBeCloseTo(20.69, 2);
  });
});

describe("a household in net debt", () => {
  // negative net worth is ordinary (a new mortgage outweighing everything else); axis must survive it
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
    // U+2212 minus from formatCompact — a hyphen reads as a dash, not a sign, at this size
    expect(gridRules(buildScale(indebted), false).map((rule) => rule.label)).toEqual([
      "−12.8K",
      "−28.5K",
      "−44.2K",
    ]);
  });
});

describe("<NetWorthChart>", () => {
  // unmasked here — masking only changes the figures beside the drawing (spec 0007)
  const render = (manual: ChartPoint[], computed: ChartPoint[]) =>
    renderToStaticMarkup(
      <NetWorthChart
        manual={manual}
        computed={computed}
        label="Net worth"
        masked={false}
        session={null}
        id="test"
      />,
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
    // asserted against gridRules, not literals — catches a second, divergent derivation in the component
    const markup = render([], rising);

    for (const rule of gridRules(buildScale(rising), false)) {
      expect(markup).toContain(`<span>${rule.label}</span>`);
    }
    expect(markup).toContain(
      'aria-label="Net worth ending on 1 Jan 2025 at $200,000.00."',
    );
  });
});

describe("the point readout (spec 0010)", () => {
  const render = (manual: ChartPoint[], computed: ChartPoint[], masked = false) =>
    renderToStaticMarkup(
      <NetWorthChart
        manual={manual}
        computed={computed}
        label="Net worth"
        masked={masked}
        session={null}
        id="test"
      />,
    );

  it("tiles the hit targets across the full box, split at the midpoints", () => {
    // uneven spacing (3/12/15 days over 30) so even tiling would be visibly wrong; no gap/overlap = "nearest point"
    const series: ChartPoint[] = [
      { date: "2024-01-01", amount: "100000.00" },
      { date: "2024-01-04", amount: "104000.00" },
      { date: "2024-01-16", amount: "112000.00" },
      { date: "2024-01-31", amount: "120000.00" },
    ];

    // points plot at x 0/100/500/1000; target boundaries sit halfway between each pair
    expect(hitTargets([], series, buildScale(series))).toEqual([
      { left: 0, right: 50, point: series[0], manual: false },
      { left: 50, right: 300, point: series[1], manual: false },
      { left: 300, right: 750, point: series[2], manual: false },
      { left: 750, right: 1000, point: series[3], manual: false },
    ]);
  });

  it("marks a hand-typed point's readout, and only a hand-typed point's", () => {
    // §7: a dashed line claims provenance; identical readouts for both would undo that claim
    const markup = render(
      [
        { date: "2010-06-01", amount: "50000.00" },
        { date: "2018-06-01", amount: "90000.00" },
      ],
      rising,
    );

    // both hand-typed points carry the mark; neither computed point nor the resting strip does
    expect(markup.match(/hand-typed/g)).toHaveLength(2);
    expect(markup).toContain(
      '<span class="chart-readout-date">1 Jun 2010</span>' +
        '<span class="chart-readout-value">$50,000.00</span>' +
        '<span class="chart-readout-mark">hand-typed</span>',
    );
    expect(markup).toContain(
      '<span class="chart-readout-date">1 Jan 2025</span>' +
        '<span class="chart-readout-value">$200,000.00</span></span>',
    );
  });

  it("masks every readout to the shared constant, and keeps the dates", () => {
    // complements masking-boundary.test.ts (polices callers, not render output); date isn't an amount, $ mark stays like <Amount>
    const markup = render([{ date: "2010-06-01", amount: "50000.00" }], rising, true);

    expect(markup).not.toMatch(/\$\d/);
    // one masked figure per point, plus the resting strip's
    expect(markup.match(/\$••••••/g)).toHaveLength(4);
    expect(markup).toContain('<span class="chart-readout-date">1 Jun 2010</span>');
  });

  it("describes the line as ending at the last plotted point, dated", () => {
    // reproduces the bug this spec fixes: Overview used to label with today's net worth, wrong once the range ends earlier
    const markup = render([], [
      { date: "2024-03-01", amount: "120000.00" },
      { date: "2024-06-01", amount: "150000.00" },
    ]);

    expect(markup).toContain(
      'aria-label="Net worth ending on 1 Jun 2024 at $150,000.00."',
    );
  });
});

describe("an intra-session line (ADR-0006)", () => {
  // instants, not dates — buildScale positions by Date.parse; only how a moment is named changes, always told, never guessed
  const session: ChartPoint[] = [
    { date: "2026-06-05T13:30:00.000Z", amount: "100000.0000" },
    { date: "2026-06-05T16:45:00.000Z", amount: "101500.0000" },
    { date: "2026-06-05T20:00:00.000Z", amount: "102000.0000" },
  ];

  const render = (points: ChartPoint[], masked = false) =>
    renderToStaticMarkup(
      <NetWorthChart
        manual={[]}
        computed={points}
        label="Net worth over the latest trading session,"
        masked={masked}
        session={{ timeZone: "America/New_York" }}
        id="test"
      />,
    );

  it("names its axis by the time of day, on the market's clock", () => {
    // 13:30-20:00 UTC = 09:30-16:00 NY — market's own clock, same regardless of server/browser zone
    const markup = render(session);

    expect(markup).toContain("<span>09:30</span>");
    expect(markup).toContain("<span>12:45</span>");
    expect(markup).toContain("<span>16:00</span>");
  });

  it("puts the time of day beside the date in every readout", () => {
    const markup = render(session);

    // story 9: readout needs both date and time since it's read alone
    expect(markup).toContain(
      '<span class="chart-readout-date">5 Jun 2026, 09:30</span>' +
        '<span class="chart-readout-value">$100,000.00</span>',
    );
    expect(markup).toContain(
      'aria-label="Net worth over the latest trading session, ending on 5 Jun 2026, 16:00 at $102,000.00."',
    );
  });

  it("masks a session's amounts exactly as it masks every other range's", () => {
    // story 12: time lives with the date, not the amount — masking has nothing new to reach
    const markup = render(session, true);

    expect(markup).not.toMatch(/\$\d/);
    expect(markup).toContain('<span class="chart-readout-date">5 Jun 2026, 09:30</span>');
  });

  it("dates a readout on the same clock it times it on", () => {
    // 00:30 UTC on the 6th = 20:30 on the 5th NY — reading the day off the ISO string would mismatch by a day
    const markup = render([
      { date: "2026-06-05T19:45:00.000Z", amount: "100000.0000" },
      { date: "2026-06-06T00:30:00.000Z", amount: "101000.0000" },
    ]);

    expect(markup).toContain('<span class="chart-readout-date">5 Jun 2026, 20:30</span>');
    expect(markup).not.toContain("6 Jun 2026");
  });

  it("still names days when it is not drawing a session", () => {
    // other half of "the chart is told": same instants drawn as day-granularity, labelled by day
    const markup = renderToStaticMarkup(
      <NetWorthChart
        manual={[]}
        computed={session}
        label="Net worth"
        masked={false}
        session={null}
        id="test"
      />,
    );

    expect(markup).toContain("<span>5 Jun</span>");
    expect(markup).toContain('<span class="chart-readout-date">5 Jun 2026</span>');
  });
});

describe("<ChartEmptyNote> (spec 0015)", () => {
  // nothing else asserts this sentence — the missing case, not a regression
  it("renders the waiting sentence for a session with one moment, and the caller's own fallback with none observed", () => {
    const fallback = <p className="empty-note">The caller's own wording.</p>;
    const render = (moments: number) =>
      renderToStaticMarkup(
        <ChartEmptyNote session={{ timeZone: "America/New_York" }} moments={moments}>
          {fallback}
        </ChartEmptyNote>,
      );

    // toContain, not a full match — a harmless attribute change shouldn't fail this (docs/developing.md)
    expect(render(1)).toContain(
      "A line needs two observed moments and this session has 1. It appears once another price arrives.",
    );
    expect(render(0)).toContain("The caller&#x27;s own wording.");
  });
});
