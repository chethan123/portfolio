/**
 * The net worth trend line (DESIGN.md §8.1, §13.6). Not a chart library:
 * the brief is one 3px stroke over a vertical gradient with dashed rules
 * behind it — a polyline, a path and a handful of CSS rules; a charting
 * dependency would mean fighting its defaults to arrive back here.
 *
 * **Every colour resolves from a custom property, via classes rather than
 * SVG presentation attributes.** §12 names this as the piece that gets
 * forgotten: `stroke="#0055ff"` cannot follow a theme, and the symptom is a
 * light chart in a dark page. The gradient's stops are classed too, so the
 * area re-derives from `--chart-line` along with the line it sits under.
 *
 * **Masking arrives as a prop, not a hook** (spec 0007): the figures here
 * are axis ticks, an `aria-label` and per-point readouts — no place a
 * component can go — so this is the one file besides `amount.tsx` allowed
 * to call a money formatter, and `masking-boundary.test.ts` names it. The
 * line, grid and fill are unchanged either way: story 10 wants the shape of
 * the year without the size of it.
 */
import { useId } from "react";

import { MASKED_FIGURE } from "~/components/amount";
import { formatCompact, formatMoney, toPlotValue } from "~/lib/format";
import { marketDateOf, marketTimeOf } from "~/lib/market-hours";

export type ChartPoint = {
  /**
   * A calendar date `YYYY-MM-DD`, or a full ISO instant when drawing a
   * session. Both parse to a moment, which is all {@link buildScale} asks;
   * how it is *labelled* is decided by the `session` prop, never by
   * inspecting the string — a chart that re-reads its axis off punctuation
   * changes it by accident.
   */
  date: string;
  amount: string;
};

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
 * One array feeds both the grid and the axis labels: a rule drawn at a
 * height its label does not name is worse than no rule at all.
 */
const GRID = [1, 0.5, 0];

const DAY_MS = 86_400_000;

/**
 * Under this span an x tick names the day; over it, the month. A month-long
 * window labelled by month reads "Aug 2025" three times; a thirty-year one
 * labelled by day offers a precision nobody reads.
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

export type Scale = {
  x: (date: string) => number;
  y: (amount: string) => number;
  /** The value domain actually drawn, padding included. */
  domain: { floor: number; span: number };
  /** The time domain actually drawn, which is what the x labels name. */
  time: { start: number; end: number };
};

export function buildScale(points: ChartPoint[]): Scale {
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

/**
 * The horizontal rules, and the label naming each. Read off the drawn
 * domain, not the data's min and max — the two differ by the padding, and
 * labelling the box's top with the series' largest value would put every
 * tick 8% out. A quiet inaccuracy on an axis is still an inaccuracy.
 */
export function gridRules(scale: Scale, masked: boolean): { y: number; label: string }[] {
  const { floor, span } = scale.domain;

  return GRID.map((fraction) => ({
    y: HEIGHT * (1 - fraction),
    // A masked axis keeps its rules and loses its numbers — the same dot run
    // every masked figure uses: a second constant is how a reader learns to
    // read one of them as a smaller number. No currency mark, because an
    // unmasked tick has none either (`58.4K`). The ticks are already
    // `aria-hidden`; the svg label carries the chart for anyone unsighted.
    label: masked ? MASKED_FIGURE : formatCompact((floor + span * fraction).toFixed(0)),
  }));
}

const toPolyline = (points: ChartPoint[], scale: Scale) =>
  points.map((point) => `${scale.x(point.date)},${scale.y(point.amount)}`).join(" ");

/**
 * One plotted point's slice of the pointer plane (spec 0010, ADR-0004).
 * `left`/`right` are drawing-box coordinates. `manual` is provenance: a
 * hand-typed pre-app point says so in its readout, because a dashed stroke
 * is a claim identically-worded text would quietly undo (§7).
 */
export type HitTarget = {
  left: number;
  right: number;
  point: ChartPoint;
  manual: boolean;
};

/**
 * Tile the drawing box midpoint to midpoint, one target per point, the
 * first and last extending to the edges — full coverage, no dead regions or
 * overlaps, so a position always selects the nearest point. Sampling is
 * geometric (ADR-0003), so widths vary enormously; a fixed width would
 * leave most of a long range inert.
 */
export function hitTargets(manual: ChartPoint[], computed: ChartPoint[], scale: Scale): HitTarget[] {
  const points = [
    ...manual.map((point) => ({ point, manual: true })),
    ...computed.map((point) => ({ point, manual: false })),
  ];
  const xs = points.map(({ point }) => scale.x(point.date));

  return points.map((entry, index) => ({
    ...entry,
    left: index === 0 ? 0 : ((xs[index - 1] ?? 0) + (xs[index] ?? 0)) / 2,
    right:
      index === points.length - 1 ? WIDTH : ((xs[index] ?? 0) + (xs[index + 1] ?? 0)) / 2,
  }));
}

/**
 * The same run of points, closed down to the box's floor so it can be
 * filled — the floor, not the lowest point: the domain is padded, and a
 * fill stopping at the minimum would leave a strip of canvas under the
 * trough reading as a second, lower baseline.
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

/**
 * What the chart is told about the session it is drawing, or null when
 * drawing days. One prop rather than a flag beside a zone: an intra-session
 * line is always read on the market's clock — neither half means anything
 * without the other.
 */
export type SessionAxis = {
  /** `MARKET_TIMEZONE`. A session is 09:30 to 16:00 in exactly one zone. */
  timeZone: string;
};

function tickLabel(ms: number, withDay: boolean, session: SessionAxis | null): string {
  // Every tick on a session's axis falls inside one trading day, so naming the
  // day three times would spend the whole axis saying nothing. The time of day
  // is the only part that varies, and it is the part being asked about.
  if (session !== null) return marketTimeOf(new Date(ms), session.timeZone);

  const [year = "", month = "", day = ""] = isoDate(ms).split("-");
  const name = MONTHS[Number(month) - 1] ?? month;

  return withDay ? `${Number(day)} ${name}` : `${name} ${year}`;
}

/**
 * A readout's date always carries its year, unlike the x ticks, which drop it
 * on short spans — a tick is read in the context of two others, and a readout
 * is read alone (spec 0010).
 */
function readoutDate(date: string, session: SessionAxis | null): string {
  // Both halves of a session's stamp read on the same clock. Slicing the ISO
  // instant would take its *UTC* day beside the market's time, so a session
  // crossing UTC midnight would date a point a day out from the time printed
  // next to it — the exact thing `market-hours.ts` exists to stop, so the
  // day comes from there too.
  const stamped = session === null ? date.slice(0, 10) : marketDateOf(new Date(date), session.timeZone);
  const [year = "", month = "", day = ""] = stamped.split("-");
  const stamp = `${Number(day)} ${MONTHS[Number(month) - 1] ?? month} ${year}`;

  // The time joins the date rather than the amount, so masking is untouched:
  // an instant is not an amount, and the figure beside it masks exactly as
  // on every other range ("which moment is this" is the whole question a
  // session's line is asked — story 9).
  return session === null ? stamp : `${stamp}, ${marketTimeOf(new Date(date), session.timeZone)}`;
}

/**
 * One point's caption: date, value, and — for a hand-typed point — its
 * provenance in words. The amount is full precision, identical to the
 * headline, so a range ending today agrees digit for digit; masked, the
 * same dollar sign and dot run as every masked money figure — this must not
 * be the one place a figure survives masking.
 */
function Readout({
  target,
  masked,
  session,
}: {
  target: HitTarget;
  masked: boolean;
  session: SessionAxis | null;
}) {
  return (
    <>
      <span className="chart-readout-date">{readoutDate(target.point.date, session)}</span>
      <span className="chart-readout-value">
        {masked ? `$${MASKED_FIGURE}` : formatMoney(target.point.amount)}
      </span>
      {target.manual ? <span className="chart-readout-mark">hand-typed</span> : null}
    </>
  );
}

export function NetWorthChart({
  computed,
  manual,
  label,
  masked,
  session,
  id,
}: {
  /** Points derived from real position sets. Solid line, and the filled one. */
  computed: ChartPoint[];
  /** Hand-typed pre-day-zero points (§7). Dashed, and never blended. */
  manual: ChartPoint[];
  /**
   * What the line is, for anyone who cannot see it — the descriptive half
   * only. The ending figure and date are derived here from the last point
   * actually plotted, so the label is true on every range (a caller once
   * passed current net worth, and a range ending in the past announced
   * today's number — spec 0010). Deriving also keeps money formatting out
   * of the routes, the leak the masking boundary exists to prevent.
   */
  label: string;
  /**
   * Whether this browser is masked (spec 0007). Required, no default:
   * everything else in this feature fails closed (`useMasked` and the root
   * loader answer *masked* when they cannot tell), and a default here could
   * only fail the other way — drawing the figures for a caller who forgot
   * the prop. Required makes forgetting a compile error.
   */
  masked: boolean;
  /**
   * The session this line plots, or null when it plots days. Required, no
   * default, for `masked`'s reason: a caller that forgot it would label a
   * session's instants as three copies of one date, with nothing saying a
   * prop went missing. The chart is *told* what it draws rather than
   * inferring it, so the axis changes only when a caller means it to.
   */
  session: SessionAxis | null;
  /**
   * Distinguishes this instance's gradient from any other on the page: a
   * gradient is referenced by document id, and two charts sharing one both
   * paint from whichever `<defs>` comes first — real the moment a screen
   * draws two series side by side. Optional: `useId` covers the one-chart
   * case, minus its punctuation, legal in an id but needing escapes inside
   * a CSS `url()`.
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

  const rules = gridRules(scale, masked);

  const targets = hitTargets(manual, computed, scale);
  const resting = targets.at(-1);

  // "an amount that is hidden", not a dot run: story 6 asks for a masked
  // figure to be announced as hidden, and an `aria-label` is nothing but the
  // announcement. The date rides along because the visible strip is out of
  // the accessibility tree, and hiding it must not lose information a
  // sighted reader gets (spec 0010, story 20).
  const ending =
    last === undefined
      ? ""
      : ` ending on ${readoutDate(last.date, session)} at ${
          masked ? "an amount that is hidden" : formatMoney(last.amount)
        }.`;

  const { start, end } = scale.time;
  const withDay = end - start < DAY_TICKS_UNDER;
  const ticks = [0, 0.5, 1].map((fraction) =>
    tickLabel(start + (end - start) * fraction, withDay, session),
  );

  return (
    <>
      {/* The readout at rest: the last plotted point, dated, full precision,
          agreeing with the headline digit for digit on a range ending today
          (spec 0010). Hidden from assistive technology with the strip — the
          svg's label carries the same fact as a sentence. */}
      {resting ? (
        <p className="chart-readout" aria-hidden="true">
          <Readout target={resting} masked={masked} session={session} />
        </p>
      ) : null}

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
          aria-label={`${label}${ending}`}
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

          {/* Under the computed run only: the dashed prefix is a provenance
              claim (§7), and a hand-typed figure carrying the same solid
              wash would undo it. `fill` is inline because `.chart-area`
              names a fixed id and this instance's gradient is its own. */}
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

        {/* An HTML element, not an SVG circle: the box is stretched with
            `preserveAspectRatio="none"` (1000×300 → ~358×208 on a phone),
            which draws a circle as a visibly flattened ellipse. Percent
            positioning hits the same point without the distortion. */}
        {last ? (
          <span
            className="chart-marker"
            style={{
              left: `${(scale.x(last.date) / WIDTH) * 100}%`,
              top: `${(scale.y(last.amount) / HEIGHT) * 100}%`,
            }}
          />
        ) : null}

        {/* The pointer plane (spec 0010, ADR-0004): one invisible
            full-height target per plotted point, tiled midpoint to midpoint;
            each carries its own guide and caption, and the stylesheet
            chooses which shows. No client state. HTML in percentages, not
            SVG: the box stretches non-uniformly — survivable for a line,
            fatal for text (the marker's reason). Guide and caption are
            absolute against this plane, so one class positions every
            caption. `tabIndex={-1}`: focusable so a tap can pin a readout,
            without becoming one of up to 180 tab stops. The whole plane is
            `aria-hidden` — the svg's label already carries the chart. */}
        <div className="chart-hits" aria-hidden="true">
          {targets.map((target, index) => (
            <div
              key={index}
              className="chart-hit"
              tabIndex={-1}
              style={{ width: `${((target.right - target.left) / WIDTH) * 100}%` }}
            >
              <span
                className="chart-guide"
                style={{ left: `${(scale.x(target.point.date) / WIDTH) * 100}%` }}
              />
              <span className="chart-point-readout">
                <Readout target={target} masked={masked} session={session} />
              </span>
            </div>
          ))}
        </div>
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
