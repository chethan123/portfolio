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
    expect(gridRules(scale, false)).toEqual([
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

describe("a session on a large portfolio", () => {
  // The reported defect. A session moves a fraction of a percent, and one
  // decimal at the millions scale cannot see under $100,000, so every rule on
  // a $5.9M household labelled `5.9M`: an axis that has stopped saying
  // anything while still looking like it is, on the screen a household checks
  // most often.
  const session = (open: string, high: string): ChartPoint[] => [
    { date: "2026-09-01T13:30:00.000Z", amount: open },
    { date: "2026-09-01T15:10:00.000Z", amount: high },
  ];

  it("names three different figures where a day's trading separates them", () => {
    // $30K on $5.9M is half of one 0.1M bucket, so all three rules read
    // "5.9M" before the span had a say in the precision.
    expect(gridRules(buildScale(session("5900000.00", "5930000.00")), false).map((r) => r.label))
      .toEqual(["5.932M", "5.915M", "5.898M"]);
  });

  it("spends no decimal on a span too small for the digit to mean anything", () => {
    // $150 across the same household. Escalating until the labels differed
    // bought four decimals here — `5.9002M` — and took them away again as the
    // day's range grew, because "they differ" is not "the difference is worth
    // printing". One number three times is the honest reading of $150.
    expect(gridRules(buildScale(session("5900000.00", "5900150.00")), false).map((r) => r.label))
      .toEqual(["5.9M", "5.9M", "5.9M"]);
  });

  it("sizes its precision on the domain, not on an endpoint a rounding from the next suffix", () => {
    // $999,968 prints `1.0M` at one decimal, and reading that promotion back
    // as the axis's scale made a $5,336 span look like it needed three
    // decimals at the millions scale. Every rule then rendered in thousands
    // anyway, eight characters wide, where one decimal already separated them.
    expect(
      gridRules(buildScale(session("995000.00", "999600.00")), false).map((r) => r.label),
    ).toEqual(["1.0M", "997.3K", "994.6K"]);
  });

  it("stops short of a resolution finer than the dollar the rules are rounded to", () => {
    // The separation above is argued on exact values, and the rules reach the
    // formatter rounded to whole dollars, which costs each of them up to $1.
    // Under about $4 of span there is no honest precision left to spend, so
    // the axis stops rather than printing two rules the same at three
    // decimals. $694,514 is the demo household, to the dollar.
    const labels = (span: string) =>
      gridRules(buildScale(session("694514.00", span)), false).map((r) => r.label);

    expect(labels("694515.00")).toEqual(["694.5K", "694.5K", "694.5K"]);
    expect(labels("694518.00")).toEqual(["694.518K", "694.516K", "694.514K"]);
  });
});

describe("a range wide enough to cross a scale", () => {
  // Not a regression test — the baseline gets this right too. It is here
  // because the first fix for the session bug held every rule to one suffix
  // taken from the top of the domain, which reads more tidily and renders a
  // $96,000 rule as `0.1M`: a fifty-thousand-dollar error bar, and an axis
  // whose bottom rule reads larger than its middle one. The whole suite was
  // green for it. Each rule keeps its own suffix, and this says so.
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
    expect(gridRules(buildScale(flat), false).map((rule) => rule.label)).toEqual([
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
    expect(gridRules(buildScale(indebted), false).map((rule) => rule.label)).toEqual([
      "−12.8K",
      "−28.5K",
      "−44.2K",
    ]);
  });
});

describe("<NetWorthChart>", () => {
  // Unmasked: these tests are about what the chart draws from its points, and
  // masking changes only the figures beside the drawing (spec 0007).
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
    // Read against `gridRules` rather than against three literals: what is
    // being protected is that the axis a reader sees is the one the scale
    // computed, so a second, divergent derivation inside the component would
    // fail here.
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
    // Deliberately uneven spacing — 3, 12 and 15 days over a 30-day span — so
    // that even tiling would be visibly wrong. Full coverage with no gap and
    // no overlap is what makes a position mean "the nearest point": a fixed
    // target width would leave most of a long range inert, and the sparse old
    // side of an "All" range has to resolve somewhere.
    const series: ChartPoint[] = [
      { date: "2024-01-01", amount: "100000.00" },
      { date: "2024-01-04", amount: "104000.00" },
      { date: "2024-01-16", amount: "112000.00" },
      { date: "2024-01-31", amount: "120000.00" },
    ];

    // The points plot at x 0, 100, 500 and 1000; the boundaries between the
    // targets sit halfway between each pair.
    expect(hitTargets([], series, buildScale(series))).toEqual([
      { left: 0, right: 50, point: series[0], manual: false },
      { left: 50, right: 300, point: series[1], manual: false },
      { left: 300, right: 750, point: series[2], manual: false },
      { left: 750, right: 1000, point: series[3], manual: false },
    ]);
  });

  it("marks a hand-typed point's readout, and only a hand-typed point's", () => {
    // §7's rule about output rather than about strokes: a dashed line is a
    // claim about provenance, and two identically-worded readouts would undo
    // it in the medium a reader is actually looking at.
    const markup = render(
      [
        { date: "2010-06-01", amount: "50000.00" },
        { date: "2018-06-01", amount: "90000.00" },
      ],
      rising,
    );

    // Both hand-typed points carry the mark; neither computed point does, and
    // nor does the resting strip, which captions the computed end of the line.
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
    // The complement of the import-boundary test, which polices which files
    // may call a money formatter but not what they render when masked. The
    // date survives — a date is not an amount — and the currency mark stays so
    // the dots still read as money, exactly as `<Amount>` masks a cell.
    const markup = render([{ date: "2010-06-01", amount: "50000.00" }], rising, true);

    expect(markup).not.toMatch(/\$\d/);
    // One masked figure per point, plus the resting strip's.
    expect(markup.match(/\$••••••/g)).toHaveLength(4);
    expect(markup).toContain('<span class="chart-readout-date">1 Jun 2010</span>');
  });

  it("describes the line as ending at the last plotted point, dated", () => {
    // The reproducing case for the bug this spec fixes: the Overview used to
    // pass the household's *current* net worth into this label, which is wrong
    // whenever the range ends before today. The figure is derived from the
    // last point actually plotted, so a range ending in June is announced with
    // June's value — and with its date, which is what keeps hiding the visible
    // strip from assistive technology from losing information.
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
  // Instants, not dates. `buildScale` already positions by `Date.parse`, so
  // what changes is only how a moment is *named* — and the chart is told, never
  // left to guess from the shape of the string.
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
    // 13:30 to 20:00 UTC is 09:30 to 16:00 in New York — the session as the
    // market reckons it, and the same labels whichever zone the server or the
    // browser happens to be in.
    const markup = render(session);

    expect(markup).toContain("<span>09:30</span>");
    expect(markup).toContain("<span>12:45</span>");
    expect(markup).toContain("<span>16:00</span>");
  });

  it("puts the time of day beside the date in every readout", () => {
    const markup = render(session);

    // Story 9: a readout has to say which moment it describes. The date stays,
    // because a readout is read alone.
    expect(markup).toContain(
      '<span class="chart-readout-date">5 Jun 2026, 09:30</span>' +
        '<span class="chart-readout-value">$100,000.00</span>',
    );
    expect(markup).toContain(
      'aria-label="Net worth over the latest trading session, ending on 5 Jun 2026, 16:00 at $102,000.00."',
    );
  });

  it("masks a session's amounts exactly as it masks every other range's", () => {
    // Story 12. The time lives with the date and not with the amount, so
    // masking has nothing new to reach: the figures go, the moments stay.
    const markup = render(session, true);

    expect(markup).not.toMatch(/\$\d/);
    expect(markup).toContain('<span class="chart-readout-date">5 Jun 2026, 09:30</span>');
  });

  it("dates a readout on the same clock it times it on", () => {
    // 00:30 UTC on the 6th is 20:30 on the 5th in New York. Reading the day off
    // the ISO string would print "6 Jun 2026, 20:30" — a date and a time from
    // two different clocks, one of them a day out. The reproducing case for
    // that, and the reason the day comes from `market-hours.ts` rather than
    // from a slice.
    const markup = render([
      { date: "2026-06-05T19:45:00.000Z", amount: "100000.0000" },
      { date: "2026-06-06T00:30:00.000Z", amount: "101000.0000" },
    ]);

    expect(markup).toContain('<span class="chart-readout-date">5 Jun 2026, 20:30</span>');
    expect(markup).not.toContain("6 Jun 2026");
  });

  it("still names days when it is not drawing a session", () => {
    // The other half of "the chart is told": the same instants, drawn as a
    // day-granularity series, are labelled by day. Nothing is inferred from the
    // strings themselves.
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
  // Nothing today asserts this sentence at all — it is spelled once now, in
  // the component under test, so this is the case that was missing, not a
  // regression test.
  it("renders the waiting sentence for a session with one moment, and the caller's own fallback with none observed", () => {
    const fallback = <p className="empty-note">The caller's own wording.</p>;
    const render = (moments: number) =>
      renderToStaticMarkup(
        <ChartEmptyNote session={{ timeZone: "America/New_York" }} moments={moments}>
          {fallback}
        </ChartEmptyNote>,
      );

    // toContain, not a whole-string match: the surrounding markup is not
    // what this test is protecting, and a harmless attribute change must not
    // fail it (docs/developing.md).
    expect(render(1)).toContain(
      "A line needs two observed moments and this session has 1. It appears once another price arrives.",
    );
    expect(render(0)).toContain("The caller&#x27;s own wording.");
  });
});
