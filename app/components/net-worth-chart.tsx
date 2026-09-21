/**
 * Net worth trend line (DESIGN.md §8.1, §13.6) — a polyline, a path, no charting library. Every
 * colour resolves from a custom property via classes, not SVG presentation attributes (§12).
 * Masking is a prop, not a hook (spec 0007): this is the one file besides `amount.tsx` allowed to
 * call a money formatter (`masking-boundary.test.ts` enforces it) — line/grid/fill stay unchanged either way.
 */
import { useId, type ReactNode } from "react";

import { MASKED_FIGURE } from "~/components/amount";
import { dayOf, isoDate } from "~/lib/chart-range";
import { compactScale, formatCompact, formatMoney, toPlotValue } from "~/lib/format";
import { SESSION_CLOSES, SESSION_OPENS, marketTimeOf, type IsoDate } from "~/lib/market-hours";

import type { ChartPoint, SessionAxis } from "~/lib/chart-range";

// Abstract 1000×300 box, stretched to fit — no measurement pass, identical server render.
// `vector-effect="non-scaling-stroke"` keeps the line 3px (and the grid dash undistorted) after that stretch.
const WIDTH = 1000;
const HEIGHT = 300;

// Drawing coordinates, never money. Two decimals is below a pixel at any width the layout allows,
// and the digits past it are random enough to survive Brotli nearly whole (#207). Not `toFixed`:
// it pads the zeros this exists to drop.
const coordinate = (value: number) => Math.round(value * 100) / 100;

// One quantum for every percentage here. A hit target's width is right edge minus left edge: a
// right edge and the next left edge are the same expression, so they round alike and the widths
// telescope to exactly 100%. Rounding each width alone drifts off it.
const milliPercent = (value: number, extent: number) => Math.round((value / extent) * 100_000);

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
  // Present only on a grained axis: the position range, and the day at any position, answered
  // from the plotted points rather than from the number — an open at 09:30 sits at the same
  // integer as the previous day's close, so arithmetic on the position alone names the wrong day.
  days?: { min: number; max: number; at: (position: number) => IsoDate };
};

// A point's minute of the market day, from marketTimeOf's "HH:MM" — for placing an instant inside its session slot.
function marketMinutesOf(date: string, timeZone: string): number {
  const [hours = "0", minutes = "0"] = marketTimeOf(new Date(date), timeZone).split(":");
  return Number(hours) * 60 + Number(minutes);
}

export function buildScale(points: ChartPoint[], session: SessionAxis | null = null): Scale {
  const times = points.map((point) => Date.parse(point.date));
  const values = points.map((point) => toPlotValue(point.amount));

  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);

  const valueSpan = (maxValue - minValue) * (1 + PADDING * 2);
  const floor = minValue - (maxValue - minValue) * PADDING;
  const time = { start: minTime, end: maxTime };

  // A flat line has no range to scale against — centre it rather than divide by zero.
  const y = (amount: string) =>
    valueSpan === 0 ? HEIGHT / 2 : HEIGHT - ((toPlotValue(amount) - floor) / valueSpan) * HEIGHT;
  const domain = { floor, span: valueSpan };

  if (session !== null && session.grained) {
    // Day index counts calendar days from the window's earliest day; fraction places an instant
    // inside its day's session slot, 1 for a dated (finished-day) point, which is why the first
    // day — dated always — contributes only its slot's right edge.
    const withDays = points.map((point) => ({ point, day: dayOf(point, session) }));
    const earliestDay = withDays.reduce(
      (min, { day }) => (day < min ? day : min),
      withDays[0]?.day ?? "",
    );
    const earliestMs = Date.parse(`${earliestDay}T00:00:00Z`);

    const positions = new Map<string, number>();
    const placed: { position: number; day: IsoDate }[] = [];
    for (const { point, day } of withDays) {
      const dayIndex = (Date.parse(`${day}T00:00:00Z`) - earliestMs) / DAY_MS;
      const fraction = point.dated
        ? 1
        : Math.min(
            1,
            Math.max(
              0,
              (marketMinutesOf(point.date, session.timeZone) - SESSION_OPENS) /
                (SESSION_CLOSES - SESSION_OPENS),
            ),
          );
      positions.set(point.date, dayIndex + fraction);
      placed.push({ position: dayIndex + fraction, day });
    }

    // The nearest plotted point's day; a tie goes to the later point, so an open that shares its
    // position with the previous day's close names its own day.
    const dayAt = (position: number): IsoDate =>
      placed.reduce((nearest, entry) =>
        Math.abs(entry.position - position) <= Math.abs(nearest.position - position) ? entry : nearest,
      ).day;

    const positionValues = [...positions.values()];
    const minPos = Math.min(...positionValues);
    const maxPos = Math.max(...positionValues);
    const posSpan = maxPos - minPos;

    return {
      // A flat position range (one day) has nothing to scale against — centre it, as a flat value range does.
      x: (date) => {
        const pos = positions.get(date) ?? minPos;
        return posSpan === 0 ? WIDTH / 2 : ((pos - minPos) / posSpan) * WIDTH;
      },
      y,
      domain,
      time,
      days: { min: minPos, max: maxPos, at: dayAt },
    };
  }

  // Time, not index — spacing points evenly would compress decades of annual manual dots into the width of a month.
  const timeSpan = maxTime - minTime || 1;

  return {
    x: (date) => ((Date.parse(date) - minTime) / timeSpan) * WIDTH,
    y,
    domain,
    time,
  };
}

// Where the thousands scale reaches $1 — the rounding quantum; a fourth decimal there always renders `0`.
const MAX_TICK_DP = 3;

/** Decimals from the span, not by trying labels until two stop matching: rounding to a unit of at
 * most a quarter of the span guarantees two units between neighbouring rules, so distinctness
 * falls out of the arithmetic rather than being searched for. `scale` is the domain's larger end by magnitude. */
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
 * Horizontal rules, read off the drawn (padded) domain, not the data's min/max — labelling the
 * box's top with the series' max would put every tick 8% out. Precision comes from the span, not
 * fixed at one decimal: `formatCompact` sizes its suffix by magnitude alone, so each rule keeps
 * its own suffix rather than forcing agreement, which would round `96.0K` into a `0.1M`.
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
  points
    .map((point) => `${coordinate(scale.x(point.date))},${coordinate(scale.y(point.amount))}`)
    .join(" ");

export type HitTarget = {
  left: number;
  right: number;
  point: ChartPoint;
  manual: boolean;
};

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

function toArea(points: ChartPoint[], scale: Scale): string {
  const first = points[0];
  const last = points.at(-1);

  if (first === undefined || last === undefined) return "";

  const line = points.map(
    (point) => `L${coordinate(scale.x(point.date))},${coordinate(scale.y(point.amount))}`,
  );

  return `M${coordinate(scale.x(first.date))},${HEIGHT} ${line.join(" ")} L${coordinate(
    scale.x(last.date),
  )},${HEIGHT} Z`;
}

function tickLabel(ms: number, withDay: boolean, session: SessionAxis | null): string {
  // A 1D session's ticks all fall in one trading day — only the time of day varies. A grained axis's
  // ticks name days instead, one trading day apiece, so it falls through to the day/month naming below.
  if (session !== null && !session.grained) return marketTimeOf(new Date(ms), session.timeZone);

  const [year = "", month = "", day = ""] = isoDate(ms).split("-");
  const name = MONTHS[Number(month) - 1] ?? month;

  return withDay ? `${Number(day)} ${name}` : `${name} ${year}`;
}

// A readout's date always carries its year, unlike x ticks — read alone, not in context of two others (spec 0010).
function readoutDate(point: ChartPoint, session: SessionAxis | null): string {
  // dayOf hands back a point's own date verbatim when there's no session to consult — sliced to
  // guard a full instant fed in without one, as the axis (isoDate on a parsed ms value) already does.
  const stamped = dayOf(point, session).slice(0, 10);
  const [year = "", month = "", day = ""] = stamped.split("-");
  const stamp = `${Number(day)} ${MONTHS[Number(month) - 1] ?? month} ${year}`;

  // Time joins the date, not the amount — so masking of the figure beside it is untouched. A dated
  // (finished-day) point on a grained axis names its date alone, the way 1D never does.
  if (session === null || point.dated) return stamp;
  return `${stamp}, ${marketTimeOf(new Date(point.date), session.timeZone)}`;
}

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
      <span className="chart-readout-date">{readoutDate(target.point, session)}</span>
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
  computed: ChartPoint[];
  manual: ChartPoint[];
  label: string;
  // Required, no default — everything else in this feature fails closed to masked; a default could only fail the other way.
  masked: boolean;
  // Required, no default — a forgotten session would label a session's instants as three copies of one date.
  session: SessionAxis | null;
  // Distinguishes this chart's gradient — two sharing a document id both paint from whichever `<defs>` comes first.
  id?: string;
}) {
  const generated = useId().replace(/[^a-zA-Z0-9]/g, "");
  const gradientId = `${id ?? generated}-chart-fill`;

  // A hand-typed point is a calendar date; run through marketDateOf like an instant (via dayOf), it
  // would come back a day early, so the chart marks it dated before it reaches the scale or a readout.
  const datedManual = manual.map((point) => ({ ...point, dated: true as const }));
  const all = [...datedManual, ...computed];

  if (all.length < 2) return null;

  const scale = buildScale(all, session);
  const last = computed.at(-1) ?? datedManual.at(-1);

  // §7 rule 1: dashed run extended to meet the first computed point, so the join reads as interpolation, not a gap.
  const firstComputed = computed[0];
  const manualRun =
    datedManual.length > 0 && firstComputed ? [...datedManual, firstComputed] : datedManual;

  const rules = gridRules(scale, masked);

  const targets = hitTargets(datedManual, computed, scale);
  const resting = targets.at(-1);

  // "an amount that is hidden", not a dot run — the `aria-label` is the announcement itself (story 6, spec 0010).
  const ending =
    last === undefined
      ? ""
      : ` ending on ${readoutDate(last, session)} at ${
          masked ? "an amount that is hidden" : formatMoney(last.amount)
        }.`;

  const { start, end } = scale.time;
  const withDay = end - start < DAY_TICKS_UNDER;
  const { days } = scale;
  // A grained axis names the day at the left edge, the middle and the right edge — the plotted
  // point nearest each — rather than interpolating `scale.time` in milliseconds.
  const ticks = days
    ? [0, 0.5, 1].map((fraction) => {
        const day = days.at(days.min + (days.max - days.min) * fraction);
        return tickLabel(Date.parse(`${day}T00:00:00Z`), true, session);
      })
    : [0, 0.5, 1].map((fraction) => tickLabel(start + (end - start) * fraction, withDay, session));

  return (
    <>
      {/* At rest: last plotted point, agreeing with the headline digit for digit (spec 0010). Hidden from AT — the svg's label carries it. */}
      {resting ? (
        <p className="chart-readout" aria-hidden="true">
          <Readout target={resting} masked={masked} session={session} />
        </p>
      ) : null}

      <div className="chart">
        <div className="chart-axis" aria-hidden="true">
          {/* Keyed by position, not value — a flat portfolio makes all three ticks the same number. */}
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

          {/* Computed run only — a hand-typed figure carrying the same solid wash would undo the dashed-prefix claim (§7). */}
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

        {/* HTML, not an SVG circle — `preserveAspectRatio="none"` stretches an SVG circle into a visible ellipse. */}
        {last ? (
          <span
            className="chart-marker"
            style={{
              left: `${milliPercent(scale.x(last.date), WIDTH) / 1000}%`,
              top: `${milliPercent(scale.y(last.amount), HEIGHT) / 1000}%`,
            }}
          />
        ) : null}

        {/* Pointer plane (spec 0010, ADR-0004) — HTML percentages, not SVG (non-uniform stretch is fatal for text). `tabIndex={-1}`: focusable to pin a readout, without becoming a tab stop. */}
        <div className="chart-hits" aria-hidden="true">
          {targets.map((target, index) => (
            <div
              key={index}
              className="chart-hit"
              tabIndex={-1}
              style={{
                width: `${(milliPercent(target.right, WIDTH) - milliPercent(target.left, WIDTH)) / 1000}%`,
              }}
            >
              <span
                className="chart-guide"
                style={{ left: `${milliPercent(scale.x(target.point.date), WIDTH) / 1000}%` }}
              />
              <span className="chart-point-readout">
                <Readout target={target} masked={masked} session={session} />
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Under the plot — x labels have no padding margin to overlay, unlike the y labels. */}
      <div className="chart-ticks" aria-hidden="true">
        {ticks.map((tick, index) => (
          <span key={index}>{tick}</span>
        ))}
      </div>
    </>
  );
}

/** One shared sentence for an empty chart panel (spec 0015) — a session with one observed moment
 * is real state, nothing to do with how many statements exist; with none, `children` is the true sentence instead. */
export function ChartEmptyNote({
  session,
  moments,
  children,
}: {
  session: SessionAxis | null;
  moments: number;
  children: ReactNode;
}) {
  if (session !== null && !session.grained && moments > 0) {
    return (
      <p className="empty-note">
        A line needs two observed moments and this session has {moments}. It appears once another
        price arrives.
      </p>
    );
  }

  return children;
}
