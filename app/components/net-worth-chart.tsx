/**
 * Net worth trend line (DESIGN.md §8.1, §13.6) — a polyline, a path, no
 * charting library. Every colour resolves from a custom property via
 * classes, not SVG presentation attributes (§12) — a hardcoded `stroke`
 * can't follow a theme. Masking is a prop, not a hook (spec 0007): this is
 * the one file besides `amount.tsx` allowed to call a money formatter
 * (`masking-boundary.test.ts` enforces it) — line/grid/fill stay unchanged either way.
 */
import { useId, type ReactNode } from "react";

import { MASKED_FIGURE } from "~/components/amount";
import { isoDate } from "~/lib/chart-range";
import { compactScale, formatCompact, formatMoney, toPlotValue } from "~/lib/format";
import { marketDateOf, marketTimeOf } from "~/lib/market-hours";

import type { ChartPoint, SessionAxis } from "~/lib/chart-range";

// Abstract 1000×300 box, stretched to fit — no measurement pass, identical
// server render. `vector-effect="non-scaling-stroke"` keeps the line 3px
// (and the grid dash undistorted) after that stretch.
const WIDTH = 1000;
const HEIGHT = 300;

// Breathing room above/below the extremes, as a share of the range.
const PADDING = 0.08;

// Fractions of the drawn value domain — feeds both grid and axis labels, so a rule always has a label.
const GRID = [1, 0.5, 0];

const DAY_MS = 86_400_000;

// Under this span an x tick names the day, over it the month.
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
  domain: { floor: number; span: number };
  time: { start: number; end: number };
};

export function buildScale(points: ChartPoint[]): Scale {
  const times = points.map((point) => Date.parse(point.date));
  const values = points.map((point) => toPlotValue(point.amount));

  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);

  // Time, not index — spacing points evenly would compress decades of annual manual dots into the width of a month.
  const timeSpan = maxTime - minTime || 1;
  const valueSpan = (maxValue - minValue) * (1 + PADDING * 2);
  const floor = minValue - (maxValue - minValue) * PADDING;

  return {
    x: (date) => ((Date.parse(date) - minTime) / timeSpan) * WIDTH,
    // A flat line has no range to scale against — centre it rather than divide by zero.
    y: (amount) =>
      valueSpan === 0
        ? HEIGHT / 2
        : HEIGHT - ((toPlotValue(amount) - floor) / valueSpan) * HEIGHT,
    domain: { floor, span: valueSpan },
    time: { start: minTime, end: maxTime },
  };
}

// Where the thousands scale reaches $1 — the rounding quantum; a fourth decimal there always renders `0`.
const MAX_TICK_DP = 3;

/**
 * Decimals from the span, not by trying labels until two stop matching:
 * rounding to a unit of at most a quarter of the span guarantees at least
 * two units between neighbouring rules, so distinctness falls out of the
 * arithmetic rather than being searched for (a search let a $150 move buy
 * four decimals, non-monotonically gaining/losing digits between refreshes).
 * `scale` is the larger end of the domain by magnitude — the rule whose unit
 * does the separating.
 */
function tickPrecision(span: number, scale: number): number {
  const unit = 10 ** (scale * 3);
  // Never past the rounding quantum — below it, two rules a tenth of a dollar apart on the axis land on one label.
  const finest = Math.min(MAX_TICK_DP, scale * 3);

  for (let dp = 1; dp <= finest; dp += 1) {
    if (unit / 10 ** dp <= span / 4) return dp;
  }

  return 1;
}

/**
 * Horizontal rules, read off the drawn (padded) domain, not the data's
 * min/max — labelling the box's top with the series' max would put every
 * tick 8% out. Precision comes from the span, not fixed at one decimal:
 * `formatCompact` sizes its suffix by magnitude alone, so past a million a
 * $30K session move can vanish into one shared `5.9M` label — each rule
 * keeps its own suffix rather than forcing agreement, which is exact but
 * would round `96.0K` into a `0.1M` with a $50K error bar on a wide range.
 */
export function gridRules(scale: Scale, masked: boolean): { y: number; label: string }[] {
  const { floor, span } = scale.domain;
  const rules = GRID.map((fraction) => ({
    y: HEIGHT * (1 - fraction),
    amount: (floor + span * fraction).toFixed(0),
  }));
  // Magnitude, not value — a household in net debt carries its biggest figure at the domain's floor.
  const dp = tickPrecision(
    span,
    Math.max(compactScale(floor.toFixed(0)), compactScale((floor + span).toFixed(0))),
  );

  return rules.map(({ y, amount }) => ({
    y,
    // Same dot run every masked figure uses, no currency mark (unmasked ticks have none either).
    label: masked ? MASKED_FIGURE : formatCompact(amount, dp),
  }));
}

const toPolyline = (points: ChartPoint[], scale: Scale) =>
  points.map((point) => `${scale.x(point.date)},${scale.y(point.amount)}`).join(" ");

// One plotted point's slice of the pointer plane (spec 0010, ADR-0004). `manual` is provenance for the readout (§7).
export type HitTarget = {
  left: number;
  right: number;
  point: ChartPoint;
  manual: boolean;
};

// Tiles the box midpoint to midpoint, first/last extending to the edges — full coverage, nearest point always wins.
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

// Closed down to the box's floor, not the lowest point — else a strip of canvas under the trough reads as a second baseline.
function toArea(points: ChartPoint[], scale: Scale): string {
  const first = points[0];
  const last = points.at(-1);

  if (first === undefined || last === undefined) return "";

  const line = points.map((point) => `L${scale.x(point.date)},${scale.y(point.amount)}`);

  return `M${scale.x(first.date)},${HEIGHT} ${line.join(" ")} L${scale.x(
    last.date,
  )},${HEIGHT} Z`;
}

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

/**
 * The one sentence about an empty chart panel that used to be spelled twice,
 * word for word, under two separately-worded comments (spec 0015): a
 * session with one observed moment is real state between the poller's first
 * attempt and its second, nothing to do with how many statements a screen
 * has, on either surface — 1D draws the same instants whichever chart is
 * asking. Guarded on there being a moment at all: with none, nothing has
 * been uploaded and no waiting for prices changes that, so `children` — the
 * caller's own fallback — is the true sentence instead. `moments` and
 * `children` do **not** converge the same way: a caller passes its own
 * `computed.length` and its own wording, because the fallback genuinely
 * differs between an instance with no chart at all and a range that is
 * merely thin, and only the account page's is reachable with none.
 */
export function ChartEmptyNote({
  session,
  moments,
  children,
}: {
  /** The session this chart would draw, or null when it draws days. */
  session: SessionAxis | null;
  /** The caller's own `computed.length` — how many moments this session holds so far. */
  moments: number;
  /** The caller's own fallback, shown everywhere the session sentence does not apply. */
  children: ReactNode;
}) {
  if (session !== null && moments > 0) {
    return (
      <p className="empty-note">
        A line needs two observed moments and this session has {moments}. It appears once another
        price arrives.
      </p>
    );
  }

  return children;
}
