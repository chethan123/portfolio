/**
 * The net worth trend line (DESIGN.md §8.1).
 *
 * Not a chart library. The brief is one 1.5px stroke, no area fill, and grid
 * lines subtle enough to read as paper rather than as data — which is a
 * polyline and two rules of CSS, and adding a charting dependency to get it
 * would mean fighting that library's defaults to arrive back here.
 *
 * **Every colour resolves from a custom property, through CSS classes rather
 * than SVG presentation attributes.** §12 names this as the piece that gets
 * forgotten, and its symptom — a light-themed chart sitting in a dark page —
 * happens precisely because `stroke="#00ff41"` cannot follow a theme. Styling
 * the stroke from a class means a theme change re-colours the line with no
 * JavaScript and nothing to re-resolve on the client.
 */
import { formatCompact, toPlotValue } from "~/lib/format";

export type ChartPoint = { date: string; amount: string };

/**
 * The drawing is done in an abstract 1000×300 box and stretched to fit, so the
 * component needs no measurement pass and renders identically on the server.
 * `vector-effect="non-scaling-stroke"` is what keeps the line 1.5px after that
 * stretch rather than smeared horizontally.
 */
const WIDTH = 1000;
const HEIGHT = 300;

/** Breathing room above and below the extremes, as a share of the range. */
const PADDING = 0.08;

type Scale = {
  x: (date: string) => number;
  y: (amount: string) => number;
  /** The value domain actually drawn, padding included. */
  domain: { floor: number; span: number };
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
  };
}

const toPolyline = (points: ChartPoint[], scale: Scale) =>
  points.map((point) => `${scale.x(point.date)},${scale.y(point.amount)}`).join(" ");

export function NetWorthChart({
  computed,
  manual,
  label,
}: {
  /** Points derived from real position sets. Solid line. */
  computed: ChartPoint[];
  /** Hand-typed pre-day-zero points (§7). Dashed, and never blended. */
  manual: ChartPoint[];
  /** What the line is, for anyone who cannot see it. */
  label: string;
}) {
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
  const ticks = [1, 0.5, 0].map((fraction) => (floor + span * fraction).toFixed(0));

  return (
    <div className="chart">
      <div className="chart-grid" />
      <div className="chart-axis" aria-hidden="true">
        {/* Keyed by position, not by value: a portfolio that has not moved
            makes all three ticks the same number. */}
        {ticks.map((tick, index) => (
          <span key={index}>{formatCompact(tick)}</span>
        ))}
      </div>
      <svg
        className="chart-svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
      >
        <line className="chart-baseline" x1="0" x2={WIDTH} y1={HEIGHT / 2} y2={HEIGHT / 2} />

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

        {last ? (
          <>
            <circle
              className="chart-halo"
              cx={scale.x(last.date)}
              cy={scale.y(last.amount)}
              r="12"
            />
            <circle
              className="chart-point"
              cx={scale.x(last.date)}
              cy={scale.y(last.amount)}
              r="4"
            />
          </>
        ) : null}
      </svg>
    </div>
  );
}
