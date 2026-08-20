/**
 * The net worth trend line (DESIGN.md §8.1, §13.6).
 *
 * Not a chart library. The brief is one 3px stroke over a vertical gradient,
 * with dashed horizontal rules behind it — which is a polyline, a path and a
 * handful of CSS rules, and adding a charting dependency to get it would mean
 * fighting that library's defaults to arrive back here.
 *
 * **Every colour resolves from a custom property, through CSS classes rather
 * than SVG presentation attributes.** §12 names this as the piece that gets
 * forgotten, and its symptom — a light-themed chart sitting in a dark page —
 * happens precisely because `stroke="#0055ff"` cannot follow a theme. Styling
 * the stroke from a class means a theme change re-colours the line with no
 * JavaScript and nothing to re-resolve on the client. The gradient obeys the
 * same rule: its stops are classed, not filled, so the area re-derives from
 * `--chart-line` along with the line it sits under.
 */
import { useId } from "react";

import { formatCompact, toPlotValue } from "~/lib/format";

export type ChartPoint = { date: string; amount: string };

/**
 * The drawing is done in an abstract 1000×300 box and stretched to fit, so the
 * component needs no measurement pass and renders identically on the server.
 * `vector-effect="non-scaling-stroke"` is what keeps the line 3px after that
 * stretch rather than smeared horizontally — and, on the grid rules, keeps a
 * `4 4` dash from being stretched into a `40 40` one.
 */
const WIDTH = 1000;
const HEIGHT = 300;

/** Breathing room above and below the extremes, as a share of the range. */
const PADDING = 0.08;

/**
 * Where the horizontal rules sit, as fractions of the drawn value domain.
 *
 * One array feeds both the grid and the axis labels, because a rule drawn at a
 * height the label beside it does not name is worse than no rule at all.
 */
const GRID = [1, 0.5, 0];

const DAY_MS = 86_400_000;

/**
 * Under this span an x tick names the day; over it, the month.
 *
 * A month-long window labelled by month reads "Aug 2025" three times, and a
 * thirty-year window labelled by day offers a precision nobody reads.
 */
const DAY_TICKS_UNDER = 180 * DAY_MS;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

type Scale = {
  x: (date: string) => number;
  y: (amount: string) => number;
  /** The value domain actually drawn, padding included. */
  domain: { floor: number; span: number };
  /** The time domain actually drawn, which is what the x labels name. */
  time: { start: number; end: number };
};

function buildScale(points: ChartPoint[]): Scale {
  const times = points.map((point) => Date.parse(point.date));
  const values = points.map((point) => toPlotValue(point.amount));

  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);

  // Time, not index: the manual series is annual dots and the computed series
  // is fortnightly, so spacing points evenly would compress two decades of
  // history into the same width as the last month of it.
  const timeSpan = maxTime - minTime || 1;
  const valueSpan = (maxValue - minValue) * (1 + PADDING * 2);
  const floor = minValue - (maxValue - minValue) * PADDING;

  return {
    x: (date) => ((Date.parse(date) - minTime) / timeSpan) * WIDTH,
    // A perfectly flat line — one upload, or a portfolio that has not moved —
    // has no range to scale against; centre it rather than divide by zero.
    y: (amount) =>
      valueSpan === 0
        ? HEIGHT / 2
        : HEIGHT - ((toPlotValue(amount) - floor) / valueSpan) * HEIGHT,
    domain: { floor, span: valueSpan },
    time: { start: minTime, end: maxTime },
  };
}

const toPolyline = (points: ChartPoint[], scale: Scale) =>
  points.map((point) => `${scale.x(point.date)},${scale.y(point.amount)}`).join(" ");

/**
 * The same run of points, closed down to the floor of the box so it can be
 * filled.
 *
 * The floor rather than the lowest point: the domain is padded, so a fill that
 * stopped at the minimum would leave a strip of canvas under the trough and
 * read as a second, lower baseline.
 */
function toArea(points: ChartPoint[], scale: Scale): string {
  const first = points[0];
  const last = points.at(-1);

  if (first === undefined || last === undefined) return "";

  const line = points.map((point) => `L${scale.x(point.date)},${scale.y(point.amount)}`);

  return `M${scale.x(first.date)},${HEIGHT} ${line.join(" ")} L${scale.x(
    last.date,
  )},${HEIGHT} Z`;
}

/** UTC in, UTC out — the one conversion that cannot pick up a server's zone. */
const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function tickLabel(ms: number, withDay: boolean): string {
  const [year = "", month = "", day = ""] = isoDate(ms).split("-");
  const name = MONTHS[Number(month) - 1] ?? month;

  return withDay ? `${Number(day)} ${name}` : `${name} ${year}`;
}

export function NetWorthChart({
  computed,
  manual,
  label,
  id,
}: {
  /** Points derived from real position sets. Solid line, and the filled one. */
  computed: ChartPoint[];
  /** Hand-typed pre-day-zero points (§7). Dashed, and never blended. */
  manual: ChartPoint[];
  /** What the line is, for anyone who cannot see it. */
  label: string;
  /**
   * Distinguishes this instance's gradient from any other on the page.
   *
   * A gradient is referenced by document id, so two charts sharing one would
   * both paint from whichever `<defs>` the document happens to hold first —
   * which is a real bug the moment a screen draws a total and a per-account
   * series side by side. Optional because a caller with only one chart has
   * nothing to name: `useId` covers that case, minus its punctuation, which is
   * legal in an id but needs escaping inside a CSS `url()`.
   */
  id?: string;
}) {
  const generated = useId().replace(/[^a-zA-Z0-9]/g, "");
  const gradientId = `${id ?? generated}-chart-fill`;

  const all = [...manual, ...computed];

  // Two points make a line. One makes a dot with no trend to report, and the
  // honest thing to show for it is nothing.
  if (all.length < 2) return null;

  const scale = buildScale(all);
  const last = computed.at(-1) ?? manual.at(-1);

  // Rule 1 of §7: the two series stay visually distinct. The dashed run is
  // extended to meet the first computed point, so the join reads as the
  // interpolation it is rather than as a gap in the data.
  const firstComputed = computed[0];
  const manualRun = manual.length > 0 && firstComputed ? [...manual, firstComputed] : manual;

  // Read off the drawn domain, not off the data's own min and max. The two
  // differ by the padding above, and labelling the top of the box with the
  // largest value in the series would put every tick 8% of the range out —
  // a quiet inaccuracy on an axis is still an inaccuracy.
  const { floor, span } = scale.domain;
  const rules = GRID.map((fraction) => ({
    y: HEIGHT * (1 - fraction),
    label: formatCompact((floor + span * fraction).toFixed(0)),
  }));

  const { start, end } = scale.time;
  const withDay = end - start < DAY_TICKS_UNDER;
  const ticks = [0, 0.5, 1].map((fraction) =>
    tickLabel(start + (end - start) * fraction, withDay),
  );

  return (
    <>
      <div className="chart">
        <div className="chart-axis" aria-hidden="true">
          {/* Keyed by position, not by value: a portfolio that has not moved
              makes all three ticks the same number. */}
          {rules.map((rule, index) => (
            <span key={index}>{rule.label}</span>
          ))}
        </div>
        <svg
          className="chart-svg"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop className="chart-fill-from" offset="0%" />
              <stop className="chart-fill-to" offset="100%" />
            </linearGradient>
          </defs>

          {rules.map((rule, index) => (
            <line
              key={index}
              className="chart-grid"
              x1="0"
              x2={WIDTH}
              y1={rule.y}
              y2={rule.y}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/* Under the computed run only. The dashed prefix is a claim about
              provenance (§7), and a hand-typed figure carrying the same solid
              wash as a computed one would undo the distinction the dash is
              there to make. The `fill` is inline because `.chart-area` names a
              fixed id and this instance's gradient is its own. */}
          {computed.length >= 2 ? (
            <path
              className="chart-area"
              style={{ fill: `url(#${gradientId})` }}
              d={toArea(computed, scale)}
            />
          ) : null}

          {manualRun.length >= 2 ? (
            <polyline
              className="chart-line chart-line--manual"
              points={toPolyline(manualRun, scale)}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}

          {computed.length >= 2 ? (
            <polyline
              className="chart-line"
              points={toPolyline(computed, scale)}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}

        </svg>

        {/* The marker is an HTML element rather than an SVG circle, because the
            box is stretched with `preserveAspectRatio="none"`: on a phone the
            1000×300 drawing is squeezed to roughly 358×208, and a circle in
            that space is drawn as a visibly flattened ellipse. Positioning it
            in percentages puts it on the same point without inheriting the
            distortion the line is happy to take. */}
        {last ? (
          <span
            className="chart-marker"
            style={{
              left: `${(scale.x(last.date) / WIDTH) * 100}%`,
              top: `${(scale.y(last.amount) / HEIGHT) * 100}%`,
            }}
          />
        ) : null}
      </div>

      {/* Under the plot, not over it: the y labels can overlay their own rules
          because they sit in the margin the padding leaves, and the x labels
          have no such margin to sit in. */}
      <div className="chart-ticks" aria-hidden="true">
        {ticks.map((tick, index) => (
          <span key={index}>{tick}</span>
        ))}
      </div>
    </>
  );
}
